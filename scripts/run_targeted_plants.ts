/**
 * run_targeted_plants.ts
 *
 * Runs the ucc-supervisor in single mode for a specific list of plant codes.
 * Use this to research plants that were never picked up by batch runs
 * (e.g. the 36 plants with no ucc_agent_runs record from the cohort).
 *
 * Usage:
 *   npx tsx scripts/run_targeted_plants.ts --plant-file scripts/cohort_500_unresearched.txt
 *   npx tsx scripts/run_targeted_plants.ts --plant-file scripts/cohort_500_unresearched.txt --concurrency 3 --budget 0.50
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

const PLANT_FILE   = getArg('--plant-file', 'scripts/cohort_500_unresearched.txt');
const CONCURRENCY  = parseInt(getArg('--concurrency', '3'), 10);
const BUDGET_USD   = parseFloat(getArg('--budget', '0.50'));
const SUPERVISOR_URL = `${SUPABASE_URL}/functions/v1/ucc-supervisor`;

if (!fs.existsSync(PLANT_FILE)) {
  console.error(`Plant file not found: ${PLANT_FILE}`);
  process.exit(1);
}

const plantCodes: string[] = fs
  .readFileSync(PLANT_FILE, 'utf8')
  .split(/[\s,]+/)
  .map(s => s.trim())
  .filter(Boolean);

console.log(`Running supervisor on ${plantCodes.length} plants (concurrency=${CONCURRENCY}, budget=$${BUDGET_USD.toFixed(2)}/plant)`);
console.log(`Total ceiling: ~$${(plantCodes.length * BUDGET_USD).toFixed(2)}\n`);

// ── Ensure ucc_research_plants row exists ─────────────────────────────────────
// The supervisor's single mode reads from the `plants` table so ucc_research_plants
// gets seeded on first write by the reviewer. No pre-seeding needed here.

// ── Supervisor single-plant call ──────────────────────────────────────────────

interface PlantResult {
  outcome:       string;
  cost:          number;
  lenders_found?: number;
  debug?:        string;
}

async function runPlant(plantCode: string): Promise<PlantResult> {
  const resp = await fetch(SUPERVISOR_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      mode:       'single',
      plant_code: plantCode,
      budget_usd: BUDGET_USD,
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '(no body)');
    throw new Error(`Supervisor ${resp.status}: ${body.slice(0, 200)}`);
  }

  const json = (await resp.json()) as Record<string, unknown>;
  const results = (json.results as Array<Record<string, unknown>> | undefined) ?? [];
  const first   = results[0] ?? {};

  return {
    outcome:       String(first.outcome ?? json.status ?? 'unknown'),
    cost:          Number(first.cost ?? json.total_cost_usd ?? 0),
    lenders_found: first.lenders_found != null ? Number(first.lenders_found) : undefined,
  };
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

interface RunRecord {
  plant_code: string;
  outcome:    string;
  cost:       number;
  error?:     string;
}

async function runAll(): Promise<void> {
  const results: RunRecord[] = [];
  let done = 0;
  let totalCost = 0;

  const queue = [...plantCodes];
  const active = new Set<Promise<void>>();

  async function processNext(): Promise<void> {
    if (queue.length === 0) return;
    const code = queue.shift()!;

    let rec: RunRecord;
    try {
      const r = await runPlant(code);
      rec = { plant_code: code, outcome: r.outcome, cost: r.cost };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rec = { plant_code: code, outcome: 'error', cost: 0, error: msg };
    }

    results.push(rec);
    totalCost += rec.cost;
    done++;

    const pct = Math.round((done / plantCodes.length) * 100);
    const status = rec.error ? `✗ ERROR: ${rec.error.slice(0, 80)}` : `✓ ${rec.outcome}  $${rec.cost.toFixed(4)}`;
    console.log(`[${pct}%] ${code} — ${status}`);
  }

  // Fill initial pool
  while (active.size < CONCURRENCY && queue.length > 0) {
    const p = processNext().then(() => { active.delete(p); });
    active.add(p);
  }

  // Drain
  while (active.size > 0 || queue.length > 0) {
    await Promise.race(active);
    while (active.size < CONCURRENCY && queue.length > 0) {
      const p = processNext().then(() => { active.delete(p); });
      active.add(p);
    }
  }

  // Summary
  const succeeded = results.filter(r => !r.error).length;
  const failed    = results.filter(r =>  r.error).length;
  const byOutcome: Record<string, number> = {};
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`Done: ${succeeded} ok, ${failed} failed out of ${plantCodes.length} plants.`);
  console.log(`Total spend: $${totalCost.toFixed(4)}`);
  console.log('Outcome breakdown:');
  for (const [k, v] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(22)} ${v}`);
  }
  if (failed > 0) {
    console.log('\nFailed plants:');
    for (const r of results.filter(r => r.error)) {
      console.log(`  ${r.plant_code}: ${r.error}`);
    }
  }
  console.log('════════════════════════════════════════════════════════');
}

runAll().catch(err => {
  console.error(err);
  process.exit(1);
});
