/**
 * GenTrack — lender-research-orchestrator (v4) Edge Function (Deno)
 *
 * The entry point for all lender research. Admin-triggered only — no cron.
 *
 * Workflow:
 *   1. Open a lender_research_sessions row.
 *   2. Fan out 3 source workers in parallel (edgar, records, web).
 *      Each receives a proportional share of the budget.
 *   3. Await all source workers (Promise.allSettled).
 *   4. Run lender-synthesis-agent (Gemini reasoning pass).
 *   5. Run lender-reviewer (citation QA + lender_links creation).
 *   6. Close the session, update plant_research_state.
 *   7. If budget was exceeded by any worker, mark accordingly so admin
 *      can re-trigger with a larger budget.
 *
 * POST body:
 *   { plant_id: string, budget_usd?: number, trigger?: 'initial'|'refresh'|'manual',
 *     edgar_only?: boolean }
 *   edgar_only: skip lender-source-records and lender-source-web (Perplexity cost ≈ $0), give EDGAR 98% of budget.
 *
 * Response:
 *   { ok, session_id, status, links_created, cost_usd, budget_exceeded }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalOrAdminAuth, internalAuthHeaders } from '../_shared/auth.ts';

const TIMEOUT_MS       = 130_000;  // Supabase Edge Function hard cap ~150s
const DEFAULT_BUDGET   = 0.25;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// Worker budget splits (must sum to < 1.0 — leave ~10% for synthesis + reviewer)
const BUDGET_SPLIT = {
  edgar:    0.40,  // EDGAR is free (wall-clock cost only)
  records:  0.30,  // 3 Perplexity queries ~ $0.024
  web:      0.28,  // 2 Perplexity + 1 Gemini embed ~ $0.018
  synthesis: 0.02, // Gemini 2.5 Flash ~ $0.001
};

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [ORCH:${tag}] ${msg}`);
}

const BASE_URL = Deno.env.get('SUPABASE_URL')!;

async function callWorker(
  name:    string,
  payload: Record<string, unknown>,
  authHdrs: Record<string, string>,
): Promise<Record<string, unknown> & { ok: boolean; cost_usd: number; budget_exceeded: boolean; error?: string }> {
  try {
    const resp = await fetch(`${BASE_URL}/functions/v1/${name}`, {
      method:  'POST',
      headers: { ...authHdrs, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      const err = await resp.text();
      log(name, `HTTP ${resp.status}: ${err.slice(0, 200)}`);
      return { ok: false, cost_usd: 0, budget_exceeded: false, error: err.slice(0, 200) };
    }

    const data = await resp.json() as Record<string, unknown>;
    return {
      ...data,
      ok:              data.ok            ?? true,
      cost_usd:        data.cost_usd      ?? 0,
      budget_exceeded: data.budget_exceeded ?? false,
      error:           data.error,
    };
  } catch (e) {
    log(name, `Error: ${String(e)}`);
    return { ok: false, cost_usd: 0, budget_exceeded: false, error: String(e) };
  }
}

Deno.serve(async (req: Request) => {
  const denied = await checkInternalOrAdminAuth(req);
  if (denied) return denied;

  let body: { plant_id: string; budget_usd?: number; trigger?: string; edgar_only?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: CORS });
  }

  const { plant_id, budget_usd = DEFAULT_BUDGET, trigger = 'initial', edgar_only = false } = body;
  if (!plant_id || typeof plant_id !== 'string') {
    return new Response(JSON.stringify({ error: 'plant_id (string) required' }), { status: 400, headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const authHdrs = internalAuthHeaders();

  // ── Fetch plant context ────────────────────────────────────────────────────
  const { data: plant, error: plantErr } = await supabase
    .from('plants')
    .select('id, name, state, county, nameplate_capacity_mw, cod, owner, eia_plant_code')
    .eq('id', plant_id)
    .single();

  if (plantErr || !plant) {
    return new Response(
      JSON.stringify({ error: `Plant ${plant_id} not found` }),
      { status: 404, headers: CORS },
    );
  }

  log('START', `plant="${plant.name}" state=${plant.state} budget=$${budget_usd} trigger=${trigger} edgar_only=${edgar_only}`);

  // ── Open session ───────────────────────────────────────────────────────────
  const { data: session, error: sessionErr } = await supabase
    .from('lender_research_sessions')
    .insert({
      plant_id,
      status:       'running',
      trigger_type: trigger,
      budget_usd,
    })
    .select('id')
    .single();

  if (sessionErr || !session) {
    return new Response(
      JSON.stringify({ error: `Failed to create session: ${sessionErr?.message}` }),
      { status: 500, headers: CORS },
    );
  }

  const session_id = session.id;

  // Mark plant as in_progress
  await supabase
    .from('plant_research_state')
    .upsert({
      plant_id,
      last_session_id:    session_id,
      last_researched_at: new Date().toISOString(),
      status:             'in_progress',
    }, { onConflict: 'plant_id' });

  // ── Fan out source workers ─────────────────────────────────────────────────
  const commonPayload = {
    session_id,
    plant_id,
    plant_name:   plant.name,
    state:        plant.state,
    sponsor_name: plant.owner ?? null,
  };

  let workerCost = 0;
  let anyWorkerBudgetExceeded = false;

  if (edgar_only) {
    // Skip Perplexity workers — give EDGAR 98% of budget (it's free, but budget controls wall-clock)
    log('MODE', 'edgar_only=true — skipping lender-source-records and lender-source-web');
    const edgarValue = await callWorker('lender-source-edgar', {
      ...commonPayload,
      budget_usd: budget_usd * 0.98,
    }, authHdrs);
    workerCost += edgarValue.cost_usd;
    if (edgarValue.budget_exceeded) anyWorkerBudgetExceeded = true;

  } else if (trigger === 'initial') {
    // EDGAR-first: run EDGAR alone (free, ~30s). Only escalate to paid workers
    // if EDGAR returns zero claims — saves ~$0.07 for plants with public SEC filings.
    log('MODE', 'initial trigger → EDGAR-first strategy');
    const edgarValue = await callWorker('lender-source-edgar', {
      ...commonPayload,
      budget_usd: budget_usd * BUDGET_SPLIT.edgar,
    }, authHdrs);
    workerCost += edgarValue.cost_usd;
    if (edgarValue.budget_exceeded) anyWorkerBudgetExceeded = true;

    const edgarClaims = Number((edgarValue as any).claims_count ?? 0);
    log('EDGAR_FIRST', `claims=${edgarClaims} → ${edgarClaims > 0 ? 'EDGAR sufficient, skipping paid workers' : 'escalating to records+web'}`);

    if (edgarClaims === 0) {
      // EDGAR found nothing — escalate to paid workers in parallel
      const [recordsResult, webResult] = await Promise.allSettled([
        callWorker('lender-source-records', {
          ...commonPayload,
          county:     plant.county ?? null,
          budget_usd: budget_usd * BUDGET_SPLIT.records,
        }, authHdrs),
        callWorker('lender-source-web', {
          ...commonPayload,
          budget_usd: budget_usd * BUDGET_SPLIT.web,
        }, authHdrs),
      ]);
      for (const r of [recordsResult, webResult]) {
        if (r.status === 'fulfilled') {
          workerCost += r.value.cost_usd;
          if (r.value.budget_exceeded) anyWorkerBudgetExceeded = true;
        }
      }
    }

  } else {
    // Refresh or manual: run all three workers in parallel (original behavior)
    log('MODE', `${trigger} trigger → full parallel pipeline`);
    const [edgarResult, recordsResult, webResult] = await Promise.allSettled([
      callWorker('lender-source-edgar', {
        ...commonPayload,
        budget_usd: budget_usd * BUDGET_SPLIT.edgar,
      }, authHdrs),
      callWorker('lender-source-records', {
        ...commonPayload,
        county:     plant.county ?? null,
        budget_usd: budget_usd * BUDGET_SPLIT.records,
      }, authHdrs),
      callWorker('lender-source-web', {
        ...commonPayload,
        budget_usd: budget_usd * BUDGET_SPLIT.web,
      }, authHdrs),
    ]);
    for (const r of [edgarResult, recordsResult, webResult]) {
      if (r.status === 'fulfilled') {
        workerCost += r.value.cost_usd;
        if (r.value.budget_exceeded) anyWorkerBudgetExceeded = true;
      }
    }
  }

  log('WORKERS', `worker_cost=$${workerCost.toFixed(4)} budget_exceeded=${anyWorkerBudgetExceeded}`);

  // ── Synthesis ──────────────────────────────────────────────────────────────
  const synthResult = await callWorker('lender-synthesis-agent', {
    session_id,
    plant_id,
    plant_name:  plant.name,
    cod_year:    plant.cod ? Number(String(plant.cod).slice(0, 4)) || null : null,
    state:       plant.state,
    budget_usd:  budget_usd * BUDGET_SPLIT.synthesis,
  }, authHdrs);

  const synthCost = synthResult.cost_usd ?? 0;
  log('SYNTHESIS', `ok=${synthResult.ok} cost=$${synthCost.toFixed(4)}`);

  // ── Reviewer ───────────────────────────────────────────────────────────────
  const reviewResult = await callWorker('lender-reviewer', {
    session_id,
    plant_id,
  }, authHdrs);

  const linksCreated = Number(reviewResult.links_created ?? 0);
  const linksUpdated = Number(reviewResult.links_updated ?? 0);
  log('REVIEWER', `ok=${reviewResult.ok} links_created=${linksCreated} links_updated=${linksUpdated}`);

  const { count: pendingCount } = await supabase
    .from('lender_links')
    .select('id', { count: 'exact', head: true })
    .eq('plant_id', plant_id)
    .eq('validation_status', 'pending');

  const { count: validatedCount } = await supabase
    .from('lender_links')
    .select('id', { count: 'exact', head: true })
    .eq('plant_id', plant_id)
    .in('validation_status', ['validated', 'manual']);

  const pending = pendingCount ?? 0;
  const validated = validatedCount ?? 0;
  const hasAnyLinks = (pending + validated) > 0;

  // ── Finalize session ───────────────────────────────────────────────────────
  const totalCost     = workerCost + synthCost + Number(reviewResult.cost_usd ?? 0);
  const budgetExceeded = anyWorkerBudgetExceeded || totalCost > budget_usd;
  const sessionStatus  = budgetExceeded ? 'budget_exceeded'
                       : hasAnyLinks ? 'complete'
                       : 'no_lender_identifiable';

  await supabase
    .from('lender_research_sessions')
    .update({
      status:       sessionStatus,
      cost_usd:     totalCost,
      budget_exceeded: budgetExceeded,
      completed_at: new Date().toISOString(),
    })
    .eq('id', session_id);

  // Update plant_research_state
  await supabase
    .from('plant_research_state')
    .upsert({
      plant_id,
      last_session_id:    session_id,
      last_researched_at: new Date().toISOString(),
      status:             sessionStatus,
      pending_count:      pending,
      validated_count:    validated,
    }, { onConflict: 'plant_id' });

  log('DONE', `session=${session_id} status=${sessionStatus} cost=$${totalCost.toFixed(4)} links_created=${linksCreated}`);

  return new Response(
    JSON.stringify({
      ok:              true,
      session_id,
      status:          sessionStatus,
      links_created:   linksCreated,
      links_updated:   linksUpdated,
      pending_count:   pending,
      validated_count: validated,
      cost_usd:        totalCost,
      budget_exceeded: budgetExceeded,
    }),
    { status: 200, headers: CORS },
  );
});
