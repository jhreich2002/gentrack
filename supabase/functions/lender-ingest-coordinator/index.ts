/**
 * GenTrack — lender-ingest-coordinator Edge Function (Deno)
 *
 * Orchestrates the agentic lender ingestion pipeline. Processes curtailed
 * plants in priority order (distress_score DESC) and dispatches each plant
 * sequentially through: identification agent → verification agent.
 *
 * POST body:
 *   {
 *     mode?:        'full' | 'incremental'  (default 'full')
 *     budgetLimit?: number                  (default 30.0)
 *     maxPlants?:   number | null           (null = all eligible)
 *     batchOffset?: number                  (default 0)
 *     runLogId?:    string                  (pass for self-chained calls)
 *     recheck?:     boolean                 (default false — skip plants checked <90 days ago)
 *   }
 *
 * Self-batching: processes BATCH_SIZE plants per call (default 2),
 * then fires itself again via fireAndForget for the next batch.
 * On completion, chains to refresh-entity-stats.
 *
 * Required secrets:
 *   SUPABASE_URL              (auto-injected)
 *   SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 *   PERPLEXITY_API_KEY        (passed through to identification agent)
 *   ANTHROPIC_API_KEY         (passed through to identification agent)
 *   GEMINI_API_KEY            (passed through to verification agent)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import type { PlantInfo, CandidateLender } from '../lender-identification-agent/index.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE            = 1;    // 1 plant per coordinator call — keeps total well under 150s timeout
const DEFAULT_BUDGET_USD    = 30.0;
const RECHECK_INTERVAL_DAYS = 90;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

// ── Types ─────────────────────────────────────────────────────────────────────

interface CoordinatorRequest {
  mode?:        'full' | 'incremental';
  budgetLimit?: number;
  maxPlants?:   number | null;
  batchOffset?: number;
  runLogId?:    string;
  recheck?:     boolean;
}

interface PlantRow extends PlantInfo {
  id: string;
}

// ── Supabase client ───────────────────────────────────────────────────────────

function makeSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [COORD:${tag}] ${msg}`);
}

// ── fireAndForget helper ──────────────────────────────────────────────────────

function fireAndForget(url: string, body: Record<string, unknown>): void {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const p = fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'apikey': key },
    body:    JSON.stringify(body),
  }).catch(err => console.error('fireAndForget failed:', err));
  EdgeRuntime.waitUntil(p);
}

// ── Load eligible curtailed plants ────────────────────────────────────────────

async function loadPlantBatch(
  sb:          ReturnType<typeof makeSupabase>,
  batchOffset: number,
  maxPlants:   number | null,
  recheck:     boolean,
): Promise<{ plants: PlantRow[]; totalEligible: number }> {
  const recheckCutoff = new Date(
    Date.now() - RECHECK_INTERVAL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // 1. Load all eligible curtailed plants, ordered by distress_score DESC
  //    (distress_score already incorporates sub-regional benchmarks)
  const { data: plantsData, error: plantsErr } = await sb
    .from('plants')
    .select('id, eia_plant_code, name, owner, state, fuel_source, nameplate_capacity_mw, cod, distress_score')
    .eq('is_likely_curtailed', true)
    .eq('is_maintenance_offline', false)
    .neq('eia_plant_code', '99999')
    .gte('nameplate_capacity_mw', 20)
    .in('fuel_source', ['Solar', 'Wind', 'Geothermal', 'Solar Thermal', 'Biomass', 'Hydro', 'Storage'])
    .order('distress_score', { ascending: false, nullsFirst: false })
    .order('nameplate_capacity_mw', { ascending: false })
    .limit(maxPlants ?? 10000);

  if (plantsErr) throw new Error(`loadPlantBatch plants: ${plantsErr.message}`);

  const allPlants = (plantsData ?? []) as PlantRow[];

  // 2. Load lender_ingest_checked_at for all plant codes
  const plantCodes = allPlants.map(p => p.eia_plant_code);

  const { data: stateData } = await sb
    .from('plant_news_state')
    .select('eia_plant_code, lender_ingest_checked_at')
    .in('eia_plant_code', plantCodes);

  const checkedAtMap = new Map<string, string | null>(
    (stateData ?? []).map((r: { eia_plant_code: string; lender_ingest_checked_at: string | null }) =>
      [r.eia_plant_code, r.lender_ingest_checked_at]
    )
  );

  // 3. Filter: always process unsearched plants; re-process others if recheck or >90 days
  const eligible = allPlants.filter(p => {
    const checkedAt = checkedAtMap.get(p.eia_plant_code) ?? null;
    if (checkedAt === null) return true;                   // never searched
    if (recheck) return true;                              // force recheck all
    return checkedAt < recheckCutoff;                      // re-process if >90 days ago
  });

  const totalEligible = eligible.length;

  // 4. Apply batchOffset and BATCH_SIZE
  const batch = eligible.slice(batchOffset, batchOffset + BATCH_SIZE);

  log('LOAD', `${totalEligible} eligible plants (offset=${batchOffset}), batch=${batch.length}, maxPlants=${maxPlants ?? 'all'}`);

  return { plants: batch, totalEligible };
}

// ── Check for already-running instance ───────────────────────────────────────

async function checkAlreadyRunning(
  sb:       ReturnType<typeof makeSupabase>,
  runLogId: string | null,
): Promise<boolean> {
  if (runLogId) return false; // self-chained call — allow
  const { data } = await sb
    .from('agent_run_log')
    .select('id')
    .in('agent_type', ['lender_ingest_full', 'lender_ingest_incremental'])
    .eq('status', 'running')
    .limit(1)
    .single();
  return !!data;
}

// ── Create agent_run_log entry ────────────────────────────────────────────────

async function createRunLog(
  sb:          ReturnType<typeof makeSupabase>,
  mode:        string,
  budgetLimit: number,
  maxPlants:   number | null,
): Promise<string | null> {
  const agentType = mode === 'incremental' ? 'lender_ingest_incremental' : 'lender_ingest_full';
  const { data, error } = await sb
    .from('agent_run_log')
    .insert({
      agent_type:       agentType,
      status:           'running',
      budget_limit_usd: budgetLimit,
      trigger_source:   'manual',
      batch_size:       BATCH_SIZE,
      completion_report: { max_plants: maxPlants ?? 'all' },
    })
    .select('id')
    .single();

  if (error) {
    log('WARN', `Could not create run_log: ${error.message}`);
    return null;
  }
  return data?.id ?? null;
}

// ── Update agent_run_log ──────────────────────────────────────────────────────

async function updateRunLog(
  sb:       ReturnType<typeof makeSupabase>,
  runLogId: string,
  patch:    Record<string, unknown>,
): Promise<void> {
  const { error } = await sb.from('agent_run_log').update(patch).eq('id', runLogId);
  if (error) log('WARN', `run_log update failed: ${error.message}`);
}

// ── Call sub-agents (synchronous within this call) ────────────────────────────

async function callIdentificationAgent(
  supabaseUrl: string,
  plant:       PlantRow,
  runLogId:    string | null,
): Promise<{ candidates: CandidateLender[]; costUsd: number }> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const res = await fetch(`${supabaseUrl}/functions/v1/lender-identification-agent`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'apikey': key },
    body: JSON.stringify({
      eia_plant_code: plant.eia_plant_code,
      plantInfo:      plant,
      runLogId:       runLogId ?? undefined,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`identification-agent HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as { ok: boolean; candidates?: CandidateLender[]; costUsd?: number; error?: string };
  if (!data.ok) throw new Error(`identification-agent error: ${data.error ?? 'unknown'}`);

  return {
    candidates: data.candidates ?? [],
    costUsd:    data.costUsd ?? 0,
  };
}

async function callVerificationAgent(
  supabaseUrl: string,
  plant:       PlantRow,
  candidates:  CandidateLender[],
  runLogId:    string | null,
): Promise<{ upserted: number; costUsd: number }> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const res = await fetch(`${supabaseUrl}/functions/v1/lender-verification-agent`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'apikey': key },
    body: JSON.stringify({
      eia_plant_code: plant.eia_plant_code,
      plantInfo:      plant,
      candidates,
      runLogId:       runLogId ?? undefined,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`verification-agent HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as { ok: boolean; upserted?: number; costUsd?: number; error?: string };
  if (!data.ok) throw new Error(`verification-agent error: ${data.error ?? 'unknown'}`);

  return {
    upserted: data.upserted ?? 0,
    costUsd:  data.costUsd ?? 0,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }

  const CORS_HEADERS = { ...CORS };

  let body: CoordinatorRequest;
  try { body = await req.json(); } catch { body = {}; }

  const mode        = body.mode        ?? 'full';
  const budgetLimit = body.budgetLimit ?? DEFAULT_BUDGET_USD;
  const maxPlants   = body.maxPlants   ?? null;
  const batchOffset = body.batchOffset ?? 0;
  const recheck     = body.recheck     ?? false;
  let   runLogId    = body.runLogId    ?? null;

  const sb          = makeSupabase();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const now         = new Date().toISOString();

  log('START', `mode=${mode} budget=$${budgetLimit} maxPlants=${maxPlants ?? 'all'} offset=${batchOffset} recheck=${recheck}`);

  // ── Prevent duplicate runs ──────────────────────────────────────────────────
  if (!runLogId) {
    const alreadyRunning = await checkAlreadyRunning(sb, runLogId);
    if (alreadyRunning) {
      log('SKIP', 'Another lender_ingest run is already active — returning early');
      return new Response(JSON.stringify({
        ok:     false,
        reason: 'already_running',
        message: 'A lender ingestion run is already in progress. Wait for it to complete or check agent_run_log.',
      }), { headers: CORS_HEADERS });
    }
  }

  // ── Create or resume run_log ────────────────────────────────────────────────
  if (!runLogId) {
    runLogId = await createRunLog(sb, mode, budgetLimit, maxPlants);
    log('RUN_LOG', `Created run_log ${runLogId}`);
  }

  // ── Check budget ────────────────────────────────────────────────────────────
  if (runLogId) {
    const { data: logRow } = await sb
      .from('agent_run_log')
      .select('total_cost_usd')
      .eq('id', runLogId)
      .single();
    const spentSoFar = (logRow?.total_cost_usd as number) ?? 0;

    if (spentSoFar >= budgetLimit) {
      log('BUDGET', `Budget $${budgetLimit} already reached ($${spentSoFar.toFixed(4)} spent) — pausing`);
      if (runLogId) await updateRunLog(sb, runLogId, { status: 'budget_paused', completed_at: now });
      return new Response(JSON.stringify({ ok: true, reason: 'budget_paused', spentUsd: spentSoFar }), { headers: CORS_HEADERS });
    }
  }

  try {
    // ── Load next batch of plants ──────────────────────────────────────────────
    const { plants, totalEligible } = await loadPlantBatch(sb, batchOffset, maxPlants, recheck);

    if (plants.length === 0) {
      log('DONE', 'No eligible plants in this batch — pipeline complete');
      if (runLogId) {
        await updateRunLog(sb, runLogId, { status: 'completed', completed_at: now });
      }
      fireAndForget(`${supabaseUrl}/functions/v1/refresh-entity-stats`, {});
      return new Response(JSON.stringify({ ok: true, done: true, totalEligible }), { headers: CORS_HEADERS });
    }

    let batchCostUsd      = 0;
    let totalUpserted     = 0;
    const plantResults: { code: string; name: string; candidates: number; upserted: number; costUsd: number; error?: string }[] = [];

    // ── Process each plant synchronously ──────────────────────────────────────
    for (const plant of plants) {
      log('PLANT', `[${batchOffset + plantResults.length + 1}/${totalEligible}] ${plant.name} (${plant.eia_plant_code}, distress=${plant.distress_score ?? '?'})`);

      try {
        // Identification
        const { candidates, costUsd: identCost } = await callIdentificationAgent(supabaseUrl, plant, runLogId);
        log('IDENT', `${plant.name}: ${candidates.length} candidates — $${identCost.toFixed(4)}`);

        // Verification
        const { upserted, costUsd: verifCost } = await callVerificationAgent(supabaseUrl, plant, candidates, runLogId);
        log('VERIF', `${plant.name}: ${upserted} upserted — $${verifCost.toFixed(4)}`);

        const plantCost = identCost + verifCost;
        batchCostUsd  += plantCost;
        totalUpserted += upserted;

        plantResults.push({
          code:       plant.eia_plant_code,
          name:       plant.name,
          candidates: candidates.length,
          upserted,
          costUsd:    plantCost,
        });

        // Incremental budget update
        if (runLogId) {
          await updateRunLog(sb, runLogId, {
            total_cost_usd:  batchCostUsd,
            plants_attempted: plantResults.length,
            lenders_updated: totalUpserted,
          });
        }

        // Real-time budget check after each plant
        if (batchCostUsd >= budgetLimit) {
          log('BUDGET', `Budget $${budgetLimit} reached mid-batch ($${batchCostUsd.toFixed(4)}) — stopping`);
          if (runLogId) await updateRunLog(sb, runLogId, { status: 'budget_paused', completed_at: now });
          return new Response(JSON.stringify({
            ok:            true,
            reason:        'budget_paused',
            plantsInBatch: plantResults.length,
            upserted:      totalUpserted,
            costUsd:       batchCostUsd,
          }), { headers: CORS_HEADERS });
        }

      } catch (err) {
        const errMsg = String(err);
        log('PLANT-ERR', `${plant.name}: ${errMsg.slice(0, 200)}`);
        plantResults.push({ code: plant.eia_plant_code, name: plant.name, candidates: 0, upserted: 0, costUsd: 0, error: errMsg });
      }
    }

    // ── Self-chain or finish ───────────────────────────────────────────────────
    // IMPORTANT: always pass batchOffset=0 on the next call.
    // The eligible plant list is recomputed fresh each call, and plants we just
    // processed are now excluded by the staleness filter — so offset=0 naturally
    // points to the next unprocessed plant. Passing a non-zero offset would skip
    // plants because the list has shrunk by the number we just processed.
    //
    // For maxPlants: decrement by the number processed this batch so the cap
    // is honoured across calls without relying on a shifting offset.
    const plantsProcessed  = plants.length;
    const remainingEligible = totalEligible - plantsProcessed;
    const remainingMaxPlants = maxPlants !== null ? maxPlants - plantsProcessed : null;
    const isLastBatch = remainingEligible <= 0 ||
                        (remainingMaxPlants !== null && remainingMaxPlants <= 0);

    // For logging and run_log tracking use cumulative offset (batchOffset + processed)
    const cumulativeProcessed = batchOffset + plantsProcessed;

    if (!isLastBatch) {
      log('CHAIN', `${remainingEligible} eligible plants remain. Firing next batch (maxPlants=${remainingMaxPlants ?? 'all'}).`);
      fireAndForget(`${supabaseUrl}/functions/v1/lender-ingest-coordinator`, {
        mode,
        budgetLimit: budgetLimit - batchCostUsd,
        maxPlants:   remainingMaxPlants,
        batchOffset: 0,                    // always 0 — staleness filter handles skipping
        runLogId:    runLogId ?? undefined,
        recheck,
      });

      if (runLogId) {
        await updateRunLog(sb, runLogId, {
          status:           'running',
          total_cost_usd:   batchCostUsd,
          plants_attempted: cumulativeProcessed,
          lenders_updated:  totalUpserted,
        });
      }
    } else {
      log('DONE', `All eligible plants processed — triggering refresh-entity-stats`);
      fireAndForget(`${supabaseUrl}/functions/v1/refresh-entity-stats`, {});

      if (runLogId) {
        await updateRunLog(sb, runLogId, {
          status:           'completed',
          completed_at:     now,
          total_cost_usd:   batchCostUsd,
          plants_attempted: cumulativeProcessed,
          lenders_updated:  totalUpserted,
          completion_report: {
            total_plants_processed: cumulativeProcessed,
            total_cost_usd:         batchCostUsd,
            total_lenders_upserted: totalUpserted,
          },
        });
      }
    }

    return new Response(JSON.stringify({
      ok:               true,
      plantsInBatch:    plants.length,
      totalEligible,
      remainingEligible,
      cumulativeProcessed,
      isLastBatch,
      upserted:         totalUpserted,
      costUsd:          batchCostUsd,
      plants:           plantResults,
    }), { headers: CORS_HEADERS });

  } catch (err) {
    const errMsg = String(err);
    log('FATAL', errMsg);
    if (runLogId) {
      await updateRunLog(sb, runLogId, {
        status:       'failed',
        completed_at: now,
        error_log:    errMsg,
      });
    }
    return new Response(JSON.stringify({ error: errMsg }), { status: 500, headers: CORS_HEADERS });
  }
});
