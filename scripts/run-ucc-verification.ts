/**
 * run-ucc-verification.ts
 *
 * Runs single-plant supervisor invocations for a known-lender verification cohort.
 * Writes JSON artifacts to logs/ucc-verify-<ts>/ for quick inspection.
 *
 * Flags:
 *   --budget-per-plant <usd>   per-plant LLM budget (default 0.75)
 *   --max-spend <usd>          abort cohort once cumulative cost exceeds (default 5.00)
 *   --timeout-ms <ms>          per-plant supervisor timeout (default 240000)
 *
 * Usage:
 *   npx tsx scripts/run-ucc-verification.ts
 *   npx tsx scripts/run-ucc-verification.ts 56812 57275 57439 56857 58080
 *   npx tsx scripts/run-ucc-verification.ts --max-spend 3.50 56812 57275
 *
 * Smoke-gate verification:
 *   npx tsx scripts/cohort_summary.ts --smoke-gate <plant codes>
 */

import fs from 'fs';
import path from 'path';

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL/VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const defaultCodes = ['56812', '57275', '57439', '56857', '58080'];

// CLI parsing — flag values are extracted, the remaining tokens are plant codes.
const rawArgs = process.argv.slice(2);
function takeFlag(name: string, fallback: number): number {
  const idx = rawArgs.indexOf(name);
  if (idx === -1 || idx === rawArgs.length - 1) return fallback;
  const val = Number(rawArgs[idx + 1]);
  rawArgs.splice(idx, 2);
  return Number.isFinite(val) ? val : fallback;
}
const budgetPerPlant = takeFlag('--budget-per-plant', 0.75);
const maxSpend       = takeFlag('--max-spend', 5.00);
const timeoutMs      = takeFlag('--timeout-ms', 240_000);
const plantCodes     = rawArgs.length ? rawArgs : defaultCodes;

const supervisorUrl = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/ucc-supervisor`;
const sessionId = `ucc-verify-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const sessionDir = path.join(process.cwd(), 'logs', sessionId);
fs.mkdirSync(sessionDir, { recursive: true });

interface PlantResult {
  plant_code: string;
  status: string;
  duration_ms: number;
  cost_usd: number;
  raw: unknown;
}

function extractCost(raw: unknown): number {
  // Supervisor response may include cumulative cost on the run record. Be
  // tolerant of shape changes — search a few known paths.
  if (!raw || typeof raw !== 'object') return 0;
  const r = raw as Record<string, unknown>;
  const candidates: Array<unknown> = [
    r.total_cost_usd,
    r.cost_usd,
    (r.run as Record<string, unknown> | undefined)?.total_cost_usd,
    (r.summary as Record<string, unknown> | undefined)?.total_cost_usd,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return 0;
}

async function runOne(plantCode: string): Promise<PlantResult> {
  const started = Date.now();

  const resp = await fetch(supervisorUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      mode: 'single',
      plant_code: plantCode,
      budget_usd: budgetPerPlant,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await resp.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text as-is
  }

  if (!resp.ok) {
    throw new Error(`Supervisor ${resp.status} for plant ${plantCode}: ${text.slice(0, 300)}`);
  }

  const status = (parsed as Record<string, unknown>).status ? String((parsed as Record<string, unknown>).status) : 'done';
  return {
    plant_code: plantCode,
    status,
    duration_ms: Date.now() - started,
    cost_usd: extractCost(parsed),
    raw: parsed,
  };
}

async function run(): Promise<void> {
  console.log(`Session: ${sessionId}`);
  console.log(`Output: ${sessionDir}`);
  console.log(`Plants: ${plantCodes.join(', ')}`);
  console.log(`Budget: $${budgetPerPlant.toFixed(2)}/plant, max-spend $${maxSpend.toFixed(2)} cohort, timeout ${timeoutMs}ms/plant`);

  const results: PlantResult[] = [];
  let cumulativeCost = 0;
  let aborted = false;

  for (const plantCode of plantCodes) {
    if (cumulativeCost >= maxSpend) {
      console.error(`\nMAX-SPEND REACHED ($${cumulativeCost.toFixed(4)} >= $${maxSpend.toFixed(2)}). Aborting before plant ${plantCode}.`);
      aborted = true;
      break;
    }

    console.log(`\n[${new Date().toISOString()}] Running plant ${plantCode}... (spent so far: $${cumulativeCost.toFixed(4)})`);
    try {
      const result = await runOne(plantCode);
      results.push(result);
      cumulativeCost += result.cost_usd;
      console.log(`  status=${result.status} duration=${result.duration_ms}ms cost=$${result.cost_usd.toFixed(4)}`);
      fs.writeFileSync(
        path.join(sessionDir, `${plantCode}.json`),
        JSON.stringify(result.raw, null, 2),
        'utf8',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR: ${msg}`);
      results.push({
        plant_code: plantCode,
        status: 'error',
        duration_ms: 0,
        cost_usd: 0,
        raw: { error: msg },
      });
      fs.writeFileSync(
        path.join(sessionDir, `${plantCode}.json`),
        JSON.stringify({ error: msg }, null, 2),
        'utf8',
      );
    }
  }

  const summary = {
    session_id: sessionId,
    completed_at: new Date().toISOString(),
    aborted,
    cumulative_cost_usd: cumulativeCost,
    max_spend_usd: maxSpend,
    budget_per_plant_usd: budgetPerPlant,
    plants: results,
  };

  fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  console.log('\nSummary:');
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`  cumulative_cost: $${cumulativeCost.toFixed(4)}`);
  console.log(`Summary written: ${path.join(sessionDir, 'summary.json')}`);
  console.log(`\nNext: npx tsx scripts/cohort_summary.ts --smoke-gate ${plantCodes.join(' ')}`);

  if (aborted) process.exit(2);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
