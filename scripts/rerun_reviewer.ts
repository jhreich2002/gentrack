/**
 * rerun_reviewer.ts
 *
 * Re-runs the ucc-reviewer on a list of plant codes using their most-recent
 * completed run_id. Does NOT re-invoke any workers — only re-evaluates existing
 * evidence with the updated reviewer logic (P1 changes: cleanLenderName,
 * canonical entity resolution, estimated_loan_status).
 *
 * Usage:
 *   npx tsx scripts/rerun_reviewer.ts --plant-file scripts/cohort_500_plant_codes.txt
 *   npx tsx scripts/rerun_reviewer.ts --plant-file scripts/cohort_500_plant_codes.txt --concurrency 4
 */

import fs   from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

// ── Env ───────────────────────────────────────────────────────────────────────

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1).trim();
    if (k && !process.env[k]) process.env[k] = v;
  }
}

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string, def: string): string => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};

const PLANT_FILE   = getArg('--plant-file', 'scripts/cohort_500_plant_codes.txt');
const CONCURRENCY  = parseInt(getArg('--concurrency', '3'), 10);
const REVIEWER_URL = `${SUPABASE_URL}/functions/v1/ucc-reviewer`;

if (!fs.existsSync(PLANT_FILE)) {
  console.error(`Plant file not found: ${PLANT_FILE}`);
  process.exit(1);
}

const plantCodes: string[] = fs
  .readFileSync(PLANT_FILE, 'utf8')
  .split(/[\s,]+/)
  .map(s => s.trim())
  .filter(Boolean);

console.log(`Re-running reviewer on ${plantCodes.length} plants (concurrency=${CONCURRENCY})`);

// ── Fetch most-recent run_id per plant ────────────────────────────────────────

interface RunRow {
  plant_code:   string;
  id:           string;
  sponsor_name: string | null;
  capacity_mw:  number | null;
}

async function fetchLatestRuns(codes: string[]): Promise<Map<string, RunRow>> {
  // ucc_agent_runs: most recent run per plant_code
  const { data: runData, error: runErr } = await supabase
    .from('ucc_agent_runs')
    .select('id, plant_code, started_at')
    .in('plant_code', codes)
    .order('started_at', { ascending: false });

  if (runErr) throw new Error(`fetchLatestRuns (runs): ${runErr.message}`);

  // Deduplicate: keep only the most-recent run per plant
  const latestRuns = new Map<string, { id: string }>();
  for (const row of (runData ?? [])) {
    const pc = String(row.plant_code);
    if (!latestRuns.has(pc)) latestRuns.set(pc, { id: String(row.id) });
  }

  // Fetch sponsor_name + capacity_mw from ucc_research_plants
  const { data: plantData, error: plantErr } = await supabase
    .from('ucc_research_plants')
    .select('plant_code, sponsor_name, capacity_mw')
    .in('plant_code', codes);

  if (plantErr) throw new Error(`fetchLatestRuns (plants): ${plantErr.message}`);

  const plantMeta = new Map<string, { sponsor_name: string | null; capacity_mw: number | null }>(
    (plantData ?? []).map(r => [
      String(r.plant_code),
      { sponsor_name: r.sponsor_name as string | null, capacity_mw: r.capacity_mw as number | null },
    ])
  );

  const map = new Map<string, RunRow>();
  for (const [pc, run] of latestRuns) {
    const meta = plantMeta.get(pc) ?? { sponsor_name: null, capacity_mw: null };
    map.set(pc, { plant_code: pc, id: run.id, ...meta });
  }
  return map;
}

// ── Call reviewer ─────────────────────────────────────────────────────────────

async function callReviewer(run: RunRow): Promise<{ ok: boolean; msg: string }> {
  try {
    const resp = await fetch(REVIEWER_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey':        SUPABASE_KEY,
        'x-internal-secret': SUPABASE_KEY,
      },
      body: JSON.stringify({
        plant_code:   run.plant_code,
        run_id:       run.id,
        capacity_mw:  run.capacity_mw ?? null,
        sponsor_name: run.sponsor_name ?? null,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const text = await resp.text();
    if (!resp.ok) return { ok: false, msg: `HTTP ${resp.status}: ${text.slice(0, 200)}` };

    let out: Record<string, unknown> = {};
    try { out = JSON.parse(text); } catch { return { ok: false, msg: `Non-JSON response: ${text.slice(0, 100)}` }; }

    const status    = out.task_status as string;
    const score     = out.completion_score as number;
    const nCandidates = (out.structured_results as unknown[])?.length ?? 0;
    return { ok: true, msg: `${status} score=${score} candidates=${nCandidates}` };
  } catch (e) {
    return { ok: false, msg: String(e) };
  }
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  items: T[],
  fn: (item: T, idx: number) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx  = cursor++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('Fetching latest run IDs…');
  const runMap = await fetchLatestRuns(plantCodes);

  const missing = plantCodes.filter(pc => !runMap.has(pc));
  if (missing.length > 0) {
    console.warn(`\nWARN: ${missing.length} plants have no run record (never researched):`);
    console.warn(missing.join(', '));
  }

  const runs = [...runMap.values()];
  console.log(`Found ${runs.length} runs to re-review\n`);

  let done = 0; let ok = 0; let fail = 0;

  await runWithConcurrency(runs, async (run, idx) => {
    const result = await callReviewer(run);
    done++;
    if (result.ok) ok++;
    else           fail++;
    const pct = ((done / runs.length) * 100).toFixed(0);
    const icon = result.ok ? '✓' : '✗';
    console.log(`[${pct}%] ${icon} ${run.plant_code} — ${result.msg}`);
  }, CONCURRENCY);

  console.log(`\nDone: ${ok} succeeded, ${fail} failed out of ${runs.length} plants.`);
})();
