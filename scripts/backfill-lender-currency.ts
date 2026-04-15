/**
 * GenTrack — Backfill Lender Currency Script
 *
 * Classifies all existing plant_lenders rows by loan currency (active/matured/refinanced/unknown).
 *
 * Phase 1 (local): Run deterministic heuristics on all rows — zero API cost.
 *                  ~50% of rows are classified immediately from COD age and maturity_text.
 * Phase 2 (async): Fire the lender-currency-agent edge function for ambiguous rows.
 *                  The edge function self-batches and handles all API calls.
 *
 * Usage:
 *   npx tsx scripts/backfill-lender-currency.ts
 *
 * Optional env:
 *   BUDGET_LIMIT     — USD cap for Phase 2 API calls (default: 20.00)
 *   BATCH_SIZE       — lender rows per edge function call (default: 8)
 *   DRY_RUN          — "true" to run heuristics only, skip Phase 2 API calls
 *   FORCE_RECHECK    — "true" to reprocess rows even if recently checked
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { scoreHeuristic } from '../supabase/functions/lender-currency-agent/heuristics.ts';

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL  = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUDGET_LIMIT  = parseFloat(process.env.BUDGET_LIMIT || '20.00');
const BATCH_SIZE    = parseInt(process.env.BATCH_SIZE || '8', 10);
const DRY_RUN       = process.env.DRY_RUN === 'true';
const FORCE_RECHECK = process.env.FORCE_RECHECK === 'true';

const UPSERT_BATCH_SIZE = 200;

// ── Supabase client ───────────────────────────────────────────────────────────

let db: SupabaseClient | null = null;
function getDb(): SupabaseClient {
  if (!db) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    }
    db = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return db;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// ── Data loading ──────────────────────────────────────────────────────────────

interface RawLenderRow {
  id:                   number;
  eia_plant_code:       string;
  lender_name:          string;
  facility_type:        string;
  maturity_text:        string | null;
  loan_amount_usd:      number | null;
  article_published_at: string | null;
  source:               string;
  currency_checked_at:  string | null;
  loan_status:          string | null;
  cod:                  string | null;  // from joined plants table
}

async function loadAllLenderRows(): Promise<RawLenderRow[]> {
  const supabase = getDb();
  const pageSize = 1000;
  const rows: RawLenderRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('plant_lenders')
      .select(`
        id, eia_plant_code, lender_name, facility_type,
        maturity_text, loan_amount_usd, article_published_at, source,
        currency_checked_at, loan_status,
        plants!inner(cod)
      `)
      .in('confidence', ['high', 'medium'])
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`loadAllLenderRows: ${error.message}`);
    const batch = (data ?? []) as any[];
    for (const r of batch) {
      rows.push({
        id:                   r.id,
        eia_plant_code:       r.eia_plant_code,
        lender_name:          r.lender_name,
        facility_type:        r.facility_type,
        maturity_text:        r.maturity_text,
        loan_amount_usd:      r.loan_amount_usd,
        article_published_at: r.article_published_at,
        source:               r.source,
        currency_checked_at:  r.currency_checked_at,
        loan_status:          r.loan_status,
        cod:                  r.plants?.cod ?? null,
      });
    }

    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

// ── Heuristic pass ────────────────────────────────────────────────────────────

interface HeuristicUpdate {
  id:                  number;
  loan_status:         string;
  currency_confidence: number;
  currency_reasoning:  string;
  currency_source:     string;
  currency_checked_at: string;
}

function runHeuristicPass(
  rows:     RawLenderRow[],
  now:      string,
  force:    boolean,
): { updates: HeuristicUpdate[]; ambiguousCount: number } {
  const updates: HeuristicUpdate[] = [];
  let ambiguousCount = 0;

  for (const row of rows) {
    // Skip already-checked rows unless forcing
    if (!force && row.currency_checked_at) continue;
    // Only reprocess rows that haven't been definitively classified
    if (!force && row.loan_status && row.loan_status !== 'unknown') continue;

    const result = scoreHeuristic({
      cod:                 row.cod,
      facility_type:       row.facility_type,
      maturity_text:       row.maturity_text,
      loan_amount_usd:     row.loan_amount_usd,
      article_published_at: row.article_published_at,
      source:              row.source,
    });

    if (!result.is_ambiguous) {
      updates.push({
        id:                  row.id,
        loan_status:         result.loan_status,
        currency_confidence: result.confidence,
        currency_reasoning:  result.reasoning,
        currency_source:     'heuristic',
        currency_checked_at: now,
      });
    } else {
      ambiguousCount++;
    }
  }

  return { updates, ambiguousCount };
}

// ── Bulk upsert ───────────────────────────────────────────────────────────────

async function bulkUpsertHeuristics(updates: HeuristicUpdate[]): Promise<void> {
  const supabase = getDb();
  for (let i = 0; i < updates.length; i += UPSERT_BATCH_SIZE) {
    const batch = updates.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .from('plant_lenders')
      .upsert(batch, { onConflict: 'id' });
    if (error) throw new Error(`bulkUpsertHeuristics batch ${i}: ${error.message}`);
    log('UPSERT', `Heuristic batch ${i}–${i + batch.length} written`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  log('START', `budget=$${BUDGET_LIMIT} batch=${BATCH_SIZE} dry_run=${DRY_RUN} force=${FORCE_RECHECK}`);

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    log('ERROR', 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    process.exit(1);
  }

  const now = new Date().toISOString();

  // ── Create agent_run_log entry ───────────────────────────────────────────
  const supabase = getDb();
  const { data: runLog, error: runLogErr } = await supabase
    .from('agent_run_log')
    .insert({
      agent_type:      'lender_currency_backfill',
      status:          'running',
      budget_limit_usd: BUDGET_LIMIT,
      trigger_source:  DRY_RUN ? 'backfill_script_dry_run' : 'backfill_script',
      batch_size:      BATCH_SIZE,
    })
    .select('id')
    .single();

  if (runLogErr) log('WARN', `Could not create run_log: ${runLogErr.message}`);
  const runLogId: string | null = runLog?.id ?? null;
  log('RUN_LOG', `id=${runLogId ?? '(none)'}`);

  // ── Phase 1: Load all lender rows ────────────────────────────────────────
  log('LOAD', 'Loading all plant_lenders rows...');
  const allRows = await loadAllLenderRows();
  log('LOAD', `Loaded ${allRows.length} high/medium confidence lender rows`);

  // ── Phase 2: Heuristic pass (zero API cost) ──────────────────────────────
  log('HEURISTIC', 'Running deterministic heuristic pass...');
  const { updates, ambiguousCount } = runHeuristicPass(allRows, now, FORCE_RECHECK);

  log('HEURISTIC', `Results: ${updates.length} classified, ${ambiguousCount} ambiguous (need API)`);

  // Distribution breakdown
  const byStatus: Record<string, number> = {};
  for (const u of updates) {
    byStatus[u.loan_status] = (byStatus[u.loan_status] ?? 0) + 1;
  }
  for (const [status, count] of Object.entries(byStatus)) {
    log('HEURISTIC', `  ${status}: ${count}`);
  }

  if (!DRY_RUN && updates.length > 0) {
    log('UPSERT', `Writing ${updates.length} heuristic results in batches of ${UPSERT_BATCH_SIZE}...`);
    await bulkUpsertHeuristics(updates);
    log('UPSERT', 'Heuristic results written.');
  } else if (DRY_RUN) {
    log('DRY_RUN', `Would write ${updates.length} heuristic results (skipped).`);
  }

  // Update run_log with heuristic progress
  if (runLogId) {
    await supabase.from('agent_run_log').update({
      plants_attempted: allRows.length,
      plants_heuristic: updates.length,
    }).eq('id', runLogId);
  }

  // ── Phase 3: Fire edge function for ambiguous rows ───────────────────────
  if (DRY_RUN) {
    log('DRY_RUN', `Would fire lender-currency-agent for ${ambiguousCount} ambiguous rows (budget=$${BUDGET_LIMIT}).`);
    log('DRY_RUN', 'Backfill complete (dry run).');
    return;
  }

  if (ambiguousCount === 0) {
    log('DONE', 'All rows classified by heuristics — no API calls needed.');
    if (runLogId) {
      await supabase.from('agent_run_log').update({
        status:       'completed',
        completed_at: now,
        completion_report: { message: 'All rows classified by heuristics', heuristic_count: updates.length },
      }).eq('id', runLogId);
    }
    return;
  }

  log('AGENT', `Firing lender-currency-agent for ${ambiguousCount} ambiguous rows (budget=$${BUDGET_LIMIT})...`);

  const edgeUrl = `${SUPABASE_URL}/functions/v1/lender-currency-agent`;
  try {
    const agentRes = await fetch(edgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        mode:          'backfill',
        offset:        0,
        limit:         BATCH_SIZE,
        budget_limit:  BUDGET_LIMIT,
        run_log_id:    runLogId,
        force_recheck: FORCE_RECHECK,
      }),
    });

    if (!agentRes.ok) {
      const errBody = await agentRes.text();
      log('ERROR', `lender-currency-agent returned HTTP ${agentRes.status}: ${errBody.slice(0, 200)}`);
    } else {
      const agentData = await agentRes.json() as any;
      log('AGENT', `First batch complete: ${agentData.lenders_updated ?? 0} updated, $${agentData.cost_usd?.toFixed(4) ?? '0'} spent`);
      log('AGENT', `has_more=${agentData.has_more} — edge function will self-batch the remainder`);
    }
  } catch (err) {
    log('ERROR', `Failed to fire edge function: ${String(err)}`);
  }

  log('DONE', 'Backfill script complete. Edge function continuing async for remaining rows.');
  log('DONE', `Monitor progress: SELECT status, lenders_updated, total_cost_usd FROM agent_run_log WHERE id = '${runLogId}';`);
}

run().catch(err => {
  console.error('Backfill fatal error:', err);
  process.exit(1);
});
