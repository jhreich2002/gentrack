/**
 * run-ucc-verification.ts
 *
 * Runs single-plant supervisor invocations for a known-lender verification cohort.
 * Writes JSON artifacts to logs/ucc-verify-<ts>/ for quick inspection.
 *
 * Usage:
 *   npx tsx scripts/run-ucc-verification.ts
 *   npx tsx scripts/run-ucc-verification.ts 56812 57275 57439 56857 58080
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
const plantCodes = process.argv.slice(2).length ? process.argv.slice(2) : defaultCodes;

const supervisorUrl = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/ucc-supervisor`;
const sessionId = `ucc-verify-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const sessionDir = path.join(process.cwd(), 'logs', sessionId);
fs.mkdirSync(sessionDir, { recursive: true });

interface PlantResult {
  plant_code: string;
  status: string;
  duration_ms: number;
  raw: unknown;
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
      budget_usd: 0.75,
    }),
    signal: AbortSignal.timeout(240_000),
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
    raw: parsed,
  };
}

async function run(): Promise<void> {
  console.log(`Session: ${sessionId}`);
  console.log(`Output: ${sessionDir}`);
  console.log(`Plants: ${plantCodes.join(', ')}`);

  const results: PlantResult[] = [];

  for (const plantCode of plantCodes) {
    console.log(`\n[${new Date().toISOString()}] Running plant ${plantCode}...`);
    try {
      const result = await runOne(plantCode);
      results.push(result);
      console.log(`  status=${result.status} duration=${result.duration_ms}ms`);
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
    plants: results,
  };

  fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  console.log('\nSummary:');
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`Summary written: ${path.join(sessionDir, 'summary.json')}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
