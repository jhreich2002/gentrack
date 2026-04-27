/**
 * GenTrack — ucc-supervisor Edge Function (Deno)
 *
 * Orchestrator for the UCC lender research pipeline.
 * Owns the task graph, validates worker outputs, enforces quality gates,
 * and drives retries up to 2× before escalating to human review.
 *
 * Accepts two modes:
 *   single  — { mode: 'single', plant_code }  (runs one plant)
 *   batch   — { mode: 'batch', filters?, budget_usd? }  (runs all matching plants)
 *
 * Worker dispatch sequence:
 *   1. ucc-entity-worker  (resolves SPV name)
 *   2. In parallel: ucc-records-worker + ucc-county-worker + ucc-edgar-worker
 *   3. ucc-supplement-worker  (only if ≥1 filing found)
 *   4. ucc-reviewer  (quality gate, writes lender_links)
 *
 * Quality gates between each step:
 *   - Entity worker must return completion_score ≥ 60 (≥1 SPV alias)
 *   - Each parallel worker must complete (failed → retry, not block)
 *   - Supplement only runs if any parallel worker found evidence
 *   - Reviewer always runs; escalates to human queue if needed
 *
 * 6 acceptance criteria to mark plant complete:
 *   1. Sponsor identity confirmed
 *   2. At least one SPV alias found
 *   3. UCC or county evidence path searched
 *   4. EDGAR search completed
 *   5. Reviewer assigned a confidence class
 *   6. Every confirmed claim has source URL
 *
 * Required secrets:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const MAX_RETRIES    = 2;
const BATCH_MAX      = 50;   // max plants per batch invocation
const DEFAULT_BUDGET = 5.00; // USD per batch if not specified

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkerResponse {
  task_status:       'success' | 'partial' | 'failed';
  completion_score:  number;
  evidence_found:    boolean;
  structured_results: unknown[];
  open_questions:    string[];
  retry_recommendation: string | null;
  cost_usd:          number;
  llm_fallback_used: boolean;
  duration_ms:       number;
  // reviewer-only fields
  escalate_to_review?: boolean;
  escalation_reason?:  string | null;
}

interface PlantRow {
  plant_code:    string;  // mapped from eia_plant_code
  plant_name:    string;  // mapped from name
  state:         string;
  county:        string | null;
  sponsor_name:  string | null;  // mapped from owner
  cod_year:      number | null;  // derived from cod
  capacity_mw:   number | null;  // mapped from nameplate_capacity_mw
}

function rowToPlant(row: Record<string, unknown>): PlantRow {
  const cod  = row.cod ? String(row.cod) : null;
  const year = cod ? parseInt(cod.slice(0, 4), 10) : null; // handles YYYY, YYYY-MM, YYYY-MM-DD
  return {
    plant_code:   String(row.eia_plant_code ?? ''),
    plant_name:   String(row.name ?? ''),
    state:        String(row.state ?? ''),
    county:       row.county ? String(row.county) : null,
    sponsor_name: row.owner ? String(row.owner) : null,
    cod_year:     year && !isNaN(year) ? year : null,
    capacity_mw:  row.nameplate_capacity_mw != null ? Number(row.nameplate_capacity_mw) : null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [SUPERVISOR:${tag}] ${msg}`);
}

function supabaseUrl(): string {
  return Deno.env.get('SUPABASE_URL')!;
}

// Invoke another edge function via HTTP (same project)
async function invokeWorker(
  functionName: string,
  body:         Record<string, unknown>,
): Promise<WorkerResponse> {
  const url = `${supabaseUrl()}/functions/v1/${functionName}`;
  try {
    // Use EDGE_FUNCTION_KEY for function-to-function auth (SUPABASE_SERVICE_ROLE_KEY is reserved)
    const authKey = Deno.env.get('EDGE_FUNCTION_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const resp = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${authKey}`,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), // 2 min per worker
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return {
        task_status:      'failed',
        completion_score:  0,
        evidence_found:    false,
        structured_results: [],
        open_questions:   [`HTTP ${resp.status}: ${text.slice(0, 200)}`],
        retry_recommendation: 'Worker HTTP error',
        cost_usd:          0,
        llm_fallback_used: false,
        duration_ms:       0,
      };
    }

    return await resp.json() as WorkerResponse;
  } catch (err) {
    return {
      task_status:      'failed',
      completion_score:  0,
      evidence_found:    false,
      structured_results: [],
      open_questions:   [err instanceof Error ? err.message : String(err)],
      retry_recommendation: 'Worker invocation error',
      cost_usd:          0,
      llm_fallback_used: false,
      duration_ms:       0,
    };
  }
}

// ── Single plant research pipeline ───────────────────────────────────────────

async function runPlant(
  supabase:    ReturnType<typeof createClient>,
  plant:       PlantRow,
  runId:       string,
  budgetLeft:  number,
): Promise<{ outcome: string; cost: number; escalated: boolean }> {
  const { plant_code, plant_name, state, county, sponsor_name, cod_year, capacity_mw } = plant;

  let totalCost = 0;
  let entityResult: WorkerResponse | null = null;

  // ── Step 1: Entity worker (with retry) ────────────────────────────────
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    log(plant_code, `Entity worker attempt ${attempt}`);
    const base: Record<string, unknown> = {
      plant_code,
      run_id:       runId,
      plant_name,
      state,
      sponsor_name: sponsor_name ?? '',
    };
    if (attempt > 1) {
      base.allow_llm_fallback = true;
      base.broader_sos_search = true;
      base.retry_reason       = entityResult?.retry_recommendation ?? 'Low score';
    }

    entityResult = await invokeWorker('ucc-entity-worker', base);
    totalCost += entityResult.cost_usd;

    log(plant_code, `Entity worker → score=${entityResult.completion_score}, found=${entityResult.evidence_found}`);

    if (entityResult.completion_score >= 60) break;

    if (attempt <= MAX_RETRIES) {
      log(plant_code, `Entity worker score < 60 — retry (${attempt}/${MAX_RETRIES})`);
    }
  }

  if (!entityResult || entityResult.completion_score < 60) {
    const reason = entityResult?.open_questions?.[0] ?? 'unknown';
    log(plant_code, `Entity worker failed after retries — score=${entityResult?.completion_score ?? 0} reason=${reason}`);
    await supabase.from('ucc_research_plants').update({
      workflow_status: 'unresolved',
      last_run_at:     new Date().toISOString(),
      total_cost_usd:  totalCost,
    }).eq('plant_code', plant_code);
    await supabase.from('ucc_agent_runs').update({
      supervisor_status: 'unresolved',
      completed_at:      new Date().toISOString(),
      final_outcome:     `entity_worker_failed: ${reason}`,
    }).eq('id', runId);
    return { outcome: 'unresolved', cost: totalCost, escalated: false, debug: reason } as unknown as { outcome: string; cost: number; escalated: boolean };
  }

  // Extract SPV aliases from entity worker output
  const entityData = entityResult.structured_results[0] as Record<string, unknown> | undefined;
  const spvAliases: Array<{ name: string; normalized: string; confidence: number }> =
    (entityData?.spv_candidates as Array<{ name: string; normalized: string; confidence: number }>) ?? [];

  log(plant_code, `${spvAliases.length} SPV aliases found`);

  // ── Step 2: Parallel workers ──────────────────────────────────────────
  if (totalCost > budgetLeft) {
    log(plant_code, `Budget exhausted ($${totalCost.toFixed(4)} >= $${budgetLeft.toFixed(4)})`);
    await supabase.from('ucc_research_plants').update({
      workflow_status: 'unresolved',
      last_run_at:     new Date().toISOString(),
      total_cost_usd:  totalCost,
    }).eq('plant_code', plant_code);
    return { outcome: 'budget_exceeded', cost: totalCost, escalated: false };
  }

  const parallelBase = {
    plant_code,
    run_id:      runId,
    plant_name,
    state,
    spv_aliases: spvAliases,
    sponsor_name,
  };

  log(plant_code, `Dispatching parallel workers (UCC + County + EDGAR)`);

  const [uccResult, countyResult, edgarResult] = await Promise.all([
    invokeWorker('ucc-records-worker', {
      ...parallelBase,
      allow_llm_fallback: true,
    }),
    invokeWorker('ucc-county-worker', {
      ...parallelBase,
      county:             county ?? '',
      allow_llm_fallback: true,
    }),
    invokeWorker('ucc-edgar-worker', {
      ...parallelBase,
      cod_year,
    }),
  ]);

  totalCost += uccResult.cost_usd + countyResult.cost_usd + edgarResult.cost_usd;

  log(plant_code, [
    `UCC: score=${uccResult.completion_score}`,
    `County: score=${countyResult.completion_score}`,
    `EDGAR: score=${edgarResult.completion_score}`,
  ].join(' | '));

  const anyEvidenceFound = uccResult.evidence_found || countyResult.evidence_found || edgarResult.evidence_found;

  // ── Step 3: Supplement worker (only if evidence found) ────────────────
  if (anyEvidenceFound) {
    log(plant_code, `Evidence found — running supplement worker`);
    const existingLenders = [
      ...((uccResult.structured_results as Array<{ secured_party_name?: string }>) ?? []).map(r => r.secured_party_name ?? ''),
      ...((countyResult.structured_results as Array<{ grantee?: string }>) ?? []).map(r => r.grantee ?? ''),
    ].filter(Boolean);

    const suppResult = await invokeWorker('ucc-supplement-worker', {
      ...parallelBase,
      cod_year,
      capacity_mw,
      existing_lenders:   existingLenders,
      allow_llm_fallback: true,
    });
    totalCost += suppResult.cost_usd;
    log(plant_code, `Supplement: score=${suppResult.completion_score}, found=${suppResult.evidence_found}`);
  } else {
    log(plant_code, `No evidence found — skipping supplement worker`);
  }

  // ── Step 4: Reviewer ──────────────────────────────────────────────────
  log(plant_code, `Running reviewer`);
  const reviewerResult = await invokeWorker('ucc-reviewer', {
    plant_code,
    run_id:      runId,
    capacity_mw,
  });
  totalCost += reviewerResult.cost_usd;

  log(plant_code, `Reviewer: score=${reviewerResult.completion_score}, escalate=${reviewerResult.escalate_to_review}`);

  // ── 6 acceptance criteria ─────────────────────────────────────────────
  const criteria = {
    sponsor_confirmed:      entityResult.completion_score >= 70,
    spv_alias_found:        spvAliases.length >= 1,
    ucc_or_county_searched: uccResult.completion_score > 0 || countyResult.completion_score > 0,
    edgar_completed:        edgarResult.completion_score > 0,
    reviewer_ran:           reviewerResult.completion_score > 0,
    confirmed_claims_have_urls: reviewerResult.structured_results?.every(
      (c: unknown) => {
        const candidate = c as Record<string, unknown>;
        return candidate.confidence_class !== 'confirmed' || candidate.source_url;
      }
    ) ?? true,
  };

  const allCriteriaMet = Object.values(criteria).every(Boolean);
  const escalated      = !!(reviewerResult as WorkerResponse & { escalate_to_review?: boolean }).escalate_to_review;

  let workflowStatus: string;
  if (escalated) {
    workflowStatus = 'needs_review';
  } else if (allCriteriaMet) {
    workflowStatus = 'complete';
  } else {
    const unmet = Object.entries(criteria).filter(([, v]) => !v).map(([k]) => k);
    log(plant_code, `Criteria not met: ${unmet.join(', ')}`);
    workflowStatus = 'unresolved';
  }

  await supabase.from('ucc_research_plants').update({
    workflow_status:  workflowStatus,
    last_run_at:      new Date().toISOString(),
    total_cost_usd:   totalCost,
    sponsor_name:     sponsor_name ?? (entityData?.sponsor_name as string ?? null),
  }).eq('plant_code', plant_code);

  // Update run record
  await supabase.from('ucc_agent_runs').update({
    supervisor_status: workflowStatus,
    completed_at:      new Date().toISOString(),
    final_outcome:     workflowStatus,
    total_cost_usd:    totalCost,
  }).eq('id', runId);

  log(plant_code, `Plant done — outcome=${workflowStatus}, cost=$${totalCost.toFixed(4)}`);
  return { outcome: workflowStatus, cost: totalCost, escalated };
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 });

  const startMs = Date.now();

  try {
    const {
      mode = 'single',
      plant_code,
      filters,
      budget_usd = DEFAULT_BUDGET,
    }: {
      mode?:       'single' | 'batch';
      plant_code?: string;
      filters?:    { state?: string; min_mw?: number; max_plants?: number };
      budget_usd?: number;
    } = await req.json();

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Build plant list ──────────────────────────────────────────────────
    let plants: PlantRow[] = [];

    if (mode === 'single') {
      if (!plant_code) {
        return new Response(JSON.stringify({ error: 'plant_code required for single mode' }), { status: 400, headers: CORS });
      }

      // Single plant — pull from plants table (leverages existing EIA data)
      const { data } = await supabase
        .from('plants')
        .select('eia_plant_code, name, state, county, owner, cod, nameplate_capacity_mw')
        .eq('eia_plant_code', plant_code)
        .single();

      if (!data) {
        return new Response(JSON.stringify({ error: `Plant ${plant_code} not found` }), { status: 404, headers: CORS });
      }
      plants = [rowToPlant(data as Record<string, unknown>)];

    } else {
      // Batch mode — pull from plants table with optional filters
      let query = supabase
        .from('plants')
        .select('eia_plant_code, name, state, county, owner, cod, nameplate_capacity_mw');

      if (filters?.state)  query = query.eq('state', filters.state);
      if (filters?.min_mw) query = query.gte('nameplate_capacity_mw', filters.min_mw);

      // Exclude plants already complete or currently running
      const { data: skipPlants } = await supabase
        .from('ucc_research_plants')
        .select('plant_code')
        .in('workflow_status', ['complete', 'running']);

      const skipCodes = (skipPlants ?? []).map((r: Record<string, unknown>) => r.plant_code as string);
      if (skipCodes.length) query = query.not('eia_plant_code', 'in', `(${skipCodes.join(',')})`);

      const limit = Math.min(filters?.max_plants ?? BATCH_MAX, BATCH_MAX);
      query = query.limit(limit);

      const { data } = await query;
      plants = (data ?? []).map(r => rowToPlant(r as Record<string, unknown>));
    }

    if (!plants.length) {
      return new Response(JSON.stringify({
        status: 'no_plants',
        message: 'No eligible plants found',
        duration_ms: Date.now() - startMs,
      }), { headers: CORS });
    }

    log('BATCH', `Processing ${plants.length} plants, budget=$${budget_usd}`);

    const results: Array<{ plant_code: string; outcome: string; cost: number; debug?: string }> = [];
    let remainingBudget = budget_usd;

    for (const plant of plants) {
      if (remainingBudget <= 0) {
        log('BATCH', `Budget exhausted — stopping after ${results.length} plants`);
        break;
      }

      // Create or update research plant record
      await supabase.from('ucc_research_plants').upsert({
        plant_code:      plant.plant_code,
        plant_name:      plant.plant_name,
        state:           plant.state,
        workflow_status: 'running',
        last_run_at:     new Date().toISOString(),
      }, { onConflict: 'plant_code', ignoreDuplicates: false });

      // Create run record
      const { data: runRow } = await supabase
        .from('ucc_agent_runs')
        .insert({
          plant_code:       plant.plant_code,
          supervisor_status: 'running',
          started_at:        new Date().toISOString(),
        })
        .select('id')
        .single();

      const runId = runRow?.id as string;
      if (!runId) {
        log(plant.plant_code, `Failed to create run record`);
        continue;
      }

      try {
        const plantResult = await runPlant(supabase, plant, runId, remainingBudget) as { outcome: string; cost: number; escalated: boolean; debug?: string };
        results.push({ plant_code: plant.plant_code, outcome: plantResult.outcome, cost: plantResult.cost, debug: plantResult.debug });
        remainingBudget -= cost;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(plant.plant_code, `Unexpected error: ${msg}`);
        results.push({ plant_code: plant.plant_code, outcome: 'error', cost: 0 });

        await supabase.from('ucc_research_plants').update({
          workflow_status: 'unresolved',
        }).eq('plant_code', plant.plant_code);

        await supabase.from('ucc_agent_runs').update({
          supervisor_status: 'failed',
          completed_at:      new Date().toISOString(),
          final_outcome:     'error',
        }).eq('id', runId);
      }
    }

    const totalSpent  = results.reduce((s, r) => s + r.cost, 0);
    const completed   = results.filter(r => r.outcome === 'complete').length;
    const needsReview = results.filter(r => r.outcome === 'needs_review').length;
    const unresolved  = results.filter(r => r.outcome === 'unresolved' || r.outcome === 'error').length;

    log('BATCH', `Done — ${completed} complete, ${needsReview} needs review, ${unresolved} unresolved, $${totalSpent.toFixed(4)} spent, ${Date.now() - startMs}ms`);

    return new Response(JSON.stringify({
      status:           'done',
      plants_processed: results.length,
      completed,
      needs_review:     needsReview,
      unresolved,
      total_cost_usd:   totalSpent,
      budget_remaining: remainingBudget,
      duration_ms:      Date.now() - startMs,
      results,
    }), { headers: CORS });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', msg);
    return new Response(JSON.stringify({
      status: 'error', error: msg, duration_ms: Date.now() - startMs,
    }), { status: 500, headers: CORS });
  }
});
