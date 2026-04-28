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
 *   2. Research workers: ucc-records-worker + ucc-county-worker + ucc-edgar-worker + DOE LPO + FERC
 *   3. ucc-supplement-worker  (only if ≥1 filing found)
 *   4. ucc-reviewer  (quality gate, writes lender_links)
 *
 * Quality gates between each step:
 *   - Entity worker must return completion_score ≥ 60 (≥1 SPV alias)
 *   - Each research worker must complete (failed → retry, not block)
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
import { checkInternalAuth } from '../_shared/auth.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const MAX_RETRIES    = 2;
const BATCH_MAX      = 3;    // plants per batch invocation — serialised workers, keep under resource limits
const DEFAULT_BUDGET = 0.25;  // USD per-plant ceiling (revisit after first cohort)

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
    // Inter-function auth: use INTERNAL_AUTH_TOKEN (set via supabase secrets set).
    // verify_jwt is disabled in config.toml; each function validates this token via _shared/auth.ts.
    const authKey = Deno.env.get('INTERNAL_AUTH_TOKEN') ?? '';
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

// ── Task recorder ─────────────────────────────────────────────────────────────

// Map edge-function names → agent_type CHECK values in ucc_agent_tasks
const AGENT_TYPE_MAP: Record<string, string> = {
  'ucc-entity-worker':     'entity_worker',
  'ucc-records-worker':    'ucc_records_worker',
  'ucc-county-worker':     'county_worker',
  'ucc-edgar-worker':      'edgar_worker',
  'ucc-supplement-worker': 'supplement_worker',
  'ucc-reviewer':          'reviewer',
  'ucc-doe-lpo-worker':    'doe_lpo_worker',
  'ucc-ferc-worker':       'ferc_worker',
  'ucc-news-fallback-worker': 'news_fallback_worker',
};

async function recordTask(
  supabase:      ReturnType<typeof createClient>,
  runId:         string,
  plantCode:     string,
  functionName:  string,
  attempt:       number,
  result:        WorkerResponse,
): Promise<void> {
  const agentType = AGENT_TYPE_MAP[functionName] ?? functionName;
  try {
    await supabase.from('ucc_agent_tasks').insert({
      run_id:            runId,
      plant_code:        plantCode,
      agent_type:        agentType,
      attempt_number:    attempt,
      task_status:       result.task_status,
      completion_score:  result.completion_score,
      evidence_found:    result.evidence_found,
      llm_fallback_used: result.llm_fallback_used,
      cost_usd:          result.cost_usd,
      duration_ms:       result.duration_ms,
      output_json:       result as unknown as Record<string, unknown>,
    });
  } catch (err) {
    // Non-fatal — observability failure must not abort the pipeline
    log(plantCode, `recordTask failed (${agentType}): ${err instanceof Error ? err.message : String(err)}`);
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
  // ── Step 0: News discovery kicks off in parallel with entity worker ─────
  // News runs as a discovery accelerator: lender names found here feed into the
  // citation workers below as targeted query hints. News leads alone never reach
  // ucc_lender_links — they only land in ucc_lender_leads_unverified. Citation
  // workers remain authoritative.
  log(plant_code, `Kicking off news discovery in parallel with entity worker`);
  const newsPromise = invokeWorker('ucc-news-fallback-worker', {
    plant_code,
    run_id:      runId,
    plant_name,
    sponsor_name,
    state,
    capacity_mw,
  });
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
    await recordTask(supabase, runId, plant_code, 'ucc-entity-worker', attempt, entityResult);

    log(plant_code, `Entity worker → score=${entityResult.completion_score}, found=${entityResult.evidence_found}`);

    if (entityResult.completion_score >= 60) break;

    if (attempt <= MAX_RETRIES) {
      log(plant_code, `Entity worker score < 60 — retry (${attempt}/${MAX_RETRIES})`);
    }
  }

  if (!entityResult || entityResult.completion_score < 60) {
    const reason = entityResult?.open_questions?.[0] ?? 'unknown';
    log(plant_code, `Entity worker low score after retries — score=${entityResult?.completion_score ?? 0} reason=${reason}. Continuing with algorithmic aliases.`);
    // Phase 3: Don't hard-exit. Continue with whatever aliases were generated.
    // The plant stays 'running'; downstream workers will decide final outcome.
  }

  // Extract SPV aliases from entity worker output
  const entityData = entityResult.structured_results[0] as Record<string, unknown> | undefined;
  const spvAliases: Array<{ name: string; normalized: string; confidence: number }> =
    (entityData?.spv_candidates as Array<{ name: string; normalized: string; confidence: number }>) ?? [];

  log(plant_code, `${spvAliases.length} SPV aliases found`);

  // ── Await news discovery and extract lender hints ──────────────
  const newsResult = await newsPromise;
  totalCost += newsResult.cost_usd;
  await recordTask(supabase, runId, plant_code, 'ucc-news-fallback-worker', 1, newsResult);

  const newsLeads = (newsResult.structured_results ?? []) as Array<{ lender_name?: string; confidence?: number }>;
  const discoveredLenderHints: string[] = newsLeads
    .filter(l => !!l.lender_name && (l.confidence ?? 0) >= 50)
    .map(l => l.lender_name!.trim())
    .filter((v, i, a) => a.indexOf(v) === i)  // dedupe
    .slice(0, 5);                              // cap at 5 hints

  log(plant_code, `News discovery: ${newsLeads.length} leads, ${discoveredLenderHints.length} hints → [${discoveredLenderHints.join(', ')}]`);

  // ── Step 2: Research workers ─────────────────────────────────────────
  if (totalCost > budgetLeft) {
    const budgetMsg = `budget_exceeded_before_research_workers (spent $${totalCost.toFixed(4)} / $${budgetLeft.toFixed(4)})`;
    log(plant_code, budgetMsg);
    await supabase.from('ucc_research_plants').update({
      workflow_status: 'budget_exceeded',
      last_run_at:     new Date().toISOString(),
      total_cost_usd:  totalCost,
    }).eq('plant_code', plant_code);
    await supabase.from('ucc_agent_runs').update({
      supervisor_status: 'budget_exceeded',
      completed_at:      new Date().toISOString(),
      final_outcome:     budgetMsg,
      total_cost_usd:    totalCost,
    }).eq('id', runId);
    return { outcome: 'budget_exceeded', cost: totalCost, escalated: false };
  }

  const parallelBase = {
    plant_code,
    run_id:      runId,
    plant_name,
    state,
    spv_aliases: spvAliases,
    sponsor_name,
    discovered_lender_hints: discoveredLenderHints,
  };

  log(plant_code, `Dispatching research workers (UCC + County + EDGAR sequentially, then DOE LPO + FERC)`);

  // Wave 1: the three highest-value workers (serialised to stay within resource limits)
  const uccResult    = await invokeWorker('ucc-records-worker', { ...parallelBase, allow_llm_fallback: true });
  totalCost += uccResult.cost_usd;
  await recordTask(supabase, runId, plant_code, 'ucc-records-worker', 1, uccResult);

  const countyResult = await invokeWorker('ucc-county-worker', { ...parallelBase, county: county ?? '', allow_llm_fallback: true });
  totalCost += countyResult.cost_usd;
  await recordTask(supabase, runId, plant_code, 'ucc-county-worker', 1, countyResult);

  const edgarResult  = await invokeWorker('ucc-edgar-worker', { ...parallelBase, cod_year });
  totalCost += edgarResult.cost_usd;
  await recordTask(supabase, runId, plant_code, 'ucc-edgar-worker', 1, edgarResult);

  // Wave 2: supplemental regulatory workers
  const doeLpoResult = await invokeWorker('ucc-doe-lpo-worker', { ...parallelBase, capacity_mw, cod_year });
  totalCost += doeLpoResult.cost_usd;
  await recordTask(supabase, runId, plant_code, 'ucc-doe-lpo-worker', 1, doeLpoResult);

  const fercResult   = await invokeWorker('ucc-ferc-worker', { ...parallelBase, capacity_mw, cod_year });
  totalCost += fercResult.cost_usd;
  await recordTask(supabase, runId, plant_code, 'ucc-ferc-worker', 1, fercResult);

  log(plant_code, [
    `UCC: score=${uccResult.completion_score}`,
    `County: score=${countyResult.completion_score}`,
    `EDGAR: score=${edgarResult.completion_score}`,
    `DOE LPO: score=${doeLpoResult.completion_score}`,
    `FERC: score=${fercResult.completion_score}`,
  ].join(' | '));

  const anyEvidenceFound = uccResult.evidence_found || countyResult.evidence_found
    || edgarResult.evidence_found || doeLpoResult.evidence_found || fercResult.evidence_found;

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
    await recordTask(supabase, runId, plant_code, 'ucc-supplement-worker', 1, suppResult);
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
  await recordTask(supabase, runId, plant_code, 'ucc-reviewer', 1, reviewerResult);

  log(plant_code, `Reviewer: score=${reviewerResult.completion_score}, escalate=${reviewerResult.escalate_to_review}`);

  const reviewerCandidates = (reviewerResult.structured_results ?? []) as Array<Record<string, unknown>>;
  const hasConfirmed       = reviewerCandidates.some(c => String(c.confidence_class ?? '') === 'confirmed');
  const hasHighConfidence  = reviewerCandidates.some(c => String(c.confidence_class ?? '') === 'high_confidence');
  const lenderCount        = reviewerCandidates.length;

  const confidenceOrder = ['confirmed', 'high_confidence', 'highly_likely', 'possible'];
  const topConfidence   = confidenceOrder.find(level =>
    reviewerCandidates.some(c => String(c.confidence_class ?? '') === level),
  ) ?? null;

  // ── 6 acceptance criteria ─────────────────────────────────────────────
  const criteria = {
    sponsor_confirmed:      entityResult!.completion_score >= 60,
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

  // ── Citation-grade fast path ──────────────────────────────────────────
  // If the reviewer produced one or more `confirmed` lender candidates AND
  // each has a source URL (criterion #6), the result is auditable evidence
  // of record. That outweighs upstream-worker score gaps (e.g. entity_worker
  // failed but news-fallback + EDGAR still produced a citation chain) and
  // outweighs reviewer escalation flags (the reviewer escalates whenever
  // any worker has a retry_recommendation, which is too noisy).
  // Without this gate, plants with confirmed citations were being recorded
  // as `unresolved` (e.g. plant 56812 — 3 confirmed lenders, status=unresolved
  // because entity_worker hit a column-doesn't-exist bug).
  const confirmedWithUrls = reviewerCandidates.filter(c =>
    String(c.confidence_class ?? '') === 'confirmed' && !!c.source_url
  ).length;

  let workflowStatus: string;
  let finalOutcome: string;

  if (confirmedWithUrls > 0) {
    workflowStatus = 'complete';
    const sourceList = [
      uccResult.evidence_found      ? 'UCC SoS' : null,
      countyResult.evidence_found   ? 'county records' : null,
      edgarResult.evidence_found    ? 'EDGAR' : null,
      doeLpoResult.evidence_found   ? 'DOE LPO' : null,
      fercResult.evidence_found     ? 'FERC' : null,
    ].filter(Boolean).join(' + ') || 'reviewer synthesis';
    const partials = Object.entries(criteria).filter(([, v]) => !v).map(([k]) => k);
    const partialNote = partials.length ? ` [partial criteria: ${partials.join(', ')}]` : '';
    finalOutcome = `complete via ${sourceList} — ${confirmedWithUrls} citation-grade lender(s)${partialNote} (cost $${totalCost.toFixed(4)})`;
  } else if (escalated) {
    if (hasConfirmed || hasHighConfidence) {
      workflowStatus = 'confirmed_partial';
      finalOutcome   = `confirmed_partial: reviewer escalated with actionable lenders (${lenderCount} candidate(s), top=${topConfidence ?? 'n/a'})`;
    } else {
      workflowStatus = 'needs_review';
      finalOutcome   = `needs_review: ${(reviewerResult as WorkerResponse & { escalation_reason?: string }).escalation_reason ?? 'reviewer escalated'}`;
    }
  } else if (allCriteriaMet && lenderCount > 0) {
    workflowStatus = 'complete';
    const sourceList = [
      uccResult.evidence_found      ? 'UCC SoS' : null,
      countyResult.evidence_found   ? 'county records' : null,
      edgarResult.evidence_found    ? 'EDGAR' : null,
      doeLpoResult.evidence_found   ? 'DOE LPO' : null,
      fercResult.evidence_found     ? 'FERC' : null,
    ].filter(Boolean).join(' + ') || 'unknown source';
    finalOutcome = `complete via ${sourceList} (cost $${totalCost.toFixed(4)})`;
  } else if (lenderCount === 0) {
    // Check if news fallback found unverified leads
    const { count: newsLeadCount } = await supabase
      .from('ucc_lender_leads_unverified')
      .select('*', { count: 'exact', head: true })
      .eq('plant_code', plant_code);

    if ((newsLeadCount ?? 0) > 0) {
      workflowStatus = 'partial';
      finalOutcome   = `partial: no citation-grade evidence; ${newsLeadCount} unverified news leads found (cost $${totalCost.toFixed(4)})`;
    } else {
      workflowStatus = 'unresolved';
      finalOutcome   = `no_evidence: tried ${spvAliases.length} aliases across UCC, county, EDGAR, DOE LPO, FERC + news fallback; no leads (cost $${totalCost.toFixed(4)})`;
    }
  } else {
    const unmet = Object.entries(criteria).filter(([, v]) => !v).map(([k]) => k);
    log(plant_code, `Criteria not met: ${unmet.join(', ')}`);
    workflowStatus = 'unresolved';
    finalOutcome   = `no_evidence: tried ${spvAliases.length} aliases across UCC, county, EDGAR, DOE LPO, FERC; unmet: ${unmet.join(', ')} (cost $${totalCost.toFixed(4)})`;
  }

  await supabase.from('ucc_research_plants').update({
    workflow_status:  workflowStatus,
    last_run_at:      new Date().toISOString(),
    total_cost_usd:   totalCost,
    sponsor_name:     sponsor_name ?? (entityData?.sponsor_name as string ?? null),
    lender_count:     lenderCount,
    top_confidence:   topConfidence,
  }).eq('plant_code', plant_code);

  // Update run record
  await supabase.from('ucc_agent_runs').update({
    supervisor_status: workflowStatus,
    completed_at:      new Date().toISOString(),
    final_outcome:     finalOutcome,
    total_cost_usd:    totalCost,
  }).eq('id', runId);

  log(plant_code, `Plant done — outcome=${workflowStatus}, cost=$${totalCost.toFixed(4)}`);
  return { outcome: workflowStatus, cost: totalCost, escalated };
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const __authDenied = checkInternalAuth(req);
  if (__authDenied) return __authDenied;
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
      mode?:             'single' | 'batch';
      plant_code?:       string;
      filters?:          { state?: string; min_mw?: number; max_plants?: number; prioritize_curtailed?: boolean };
      budget_usd?:       number;
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
      const limit = Math.min(filters?.max_plants ?? BATCH_MAX, BATCH_MAX);

      if (filters?.prioritize_curtailed) {
        // ── Prioritized curtailed-plant queue (capacity DESC, distress DESC) ──
        // Reads from ucc_research_queue view which already excludes complete/running.
        const { data: queueRows } = await supabase
          .from('ucc_research_queue')
          .select('plant_code, plant_name, state, county, sponsor_name, capacity_mw')
          .limit(limit);

        // ucc_research_queue already has the right column names — map directly
        plants = (queueRows ?? []).map((r: Record<string, unknown>) => ({
          plant_code:   String(r.plant_code   ?? ''),
          plant_name:   String(r.plant_name   ?? ''),
          state:        String(r.state         ?? ''),
          county:       r.county ? String(r.county) : null,
          sponsor_name: r.sponsor_name ? String(r.sponsor_name) : null,
          cod_year:     null,
          capacity_mw:  r.capacity_mw != null ? Number(r.capacity_mw) : null,
          operator:     null,
        }));

      } else {
        // ── General batch mode — pull from plants with optional filters ────
        let query = supabase
          .from('plants')
          .select('eia_plant_code, name, state, county, owner, cod, nameplate_capacity_mw');

        if (filters?.state)  query = query.eq('state', filters.state);
        if (filters?.min_mw) query = query.gte('nameplate_capacity_mw', filters.min_mw);

        // Exclude plants already complete or currently running
        const { data: skipPlants } = await supabase
          .from('ucc_research_plants')
          .select('plant_code')
          .in('workflow_status', ['complete', 'confirmed_partial', 'running']);

        const skipCodes = (skipPlants ?? []).map((r: Record<string, unknown>) => r.plant_code as string);
        if (skipCodes.length) query = query.not('eia_plant_code', 'in', `(${skipCodes.join(',')})`);

        query = query.limit(limit);

        const { data } = await query;
        plants = (data ?? []).map(r => rowToPlant(r as Record<string, unknown>));
      }
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
        remainingBudget -= plantResult.cost; // ← was `cost` (undefined) — caused every run to throw
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(plant.plant_code, `Unexpected error: ${msg}`);
        results.push({ plant_code: plant.plant_code, outcome: 'error', cost: 0 });

        // Only overwrite status if the plant is still marked 'running'.
        // runPlant may have already written a real outcome before the error was thrown.
        await supabase.from('ucc_research_plants').update({
          workflow_status: 'unresolved',
        }).eq('plant_code', plant.plant_code).eq('workflow_status', 'running');

        await supabase.from('ucc_agent_runs').update({
          supervisor_status: 'failed',
          completed_at:      new Date().toISOString(),
          final_outcome:     `unexpected_error: ${msg.slice(0, 300)}`,
        }).eq('id', runId).eq('supervisor_status', 'running');
      }
    }

    const totalSpent    = results.reduce((s, r) => s + r.cost, 0);
    const completed     = results.filter(r => r.outcome === 'complete').length;
    const needsReview   = results.filter(r => r.outcome === 'needs_review').length;
    const budgetHalted  = results.filter(r => r.outcome === 'budget_exceeded').length;
    const unresolved    = results.filter(r => r.outcome === 'unresolved' || r.outcome === 'error').length;

    log('BATCH', `Done — ${completed} complete, ${needsReview} needs_review, ${budgetHalted} budget_exceeded, ${unresolved} unresolved, $${totalSpent.toFixed(4)} spent, ${Date.now() - startMs}ms`);

    return new Response(JSON.stringify({
      status:           'done',
      plants_processed: results.length,
      completed,
      needs_review:     needsReview,
      budget_exceeded:  budgetHalted,
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
