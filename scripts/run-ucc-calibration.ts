/**
 * run-ucc-calibration.ts
 *
 * Manual batch driver for the UCC lender research pipeline.
 * Invokes ucc-supervisor in batch mode (prioritize_curtailed=true) in loops
 * of --per-batch plants until the cohort target is reached or the global
 * spend ceiling is hit.
 *
 * Usage (calibration):
 *   npx tsx scripts/run-ucc-calibration.ts
 *   npx tsx scripts/run-ucc-calibration.ts --cohort-size 10 --max-spend 3.00 --per-batch 5
 *
 * Usage (production top-50):
 *   npx tsx scripts/run-ucc-calibration.ts --cohort-size 50 --max-spend 15.00 --per-batch 5
 *
 * Cost guardrail:
 *   After every supervisor invocation, a ledger.json is fsynced to the
 *   session directory. If the process crashes or is interrupted (SIGINT),
 *   ledger is already on disk. Re-running the script with --resume <session-dir>
 *   picks up where it left off.
 *
 * Environment:
 *   SUPABASE_URL or VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import fs   from 'fs';
import path from 'path';

// ── Env loading ───────────────────────────────────────────────────────────────

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key   = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string, def: string): string => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
};

const COHORT_SIZE  = parseInt(getArg('--cohort-size', '10'), 10);
const MAX_SPEND    = parseFloat(getArg('--max-spend', '3.00'));
const PER_BATCH    = parseInt(getArg('--per-batch', '5'), 10);
const SLEEP_MS     = parseInt(getArg('--sleep-ms', '30000'), 10);
const RESUME_DIR   = getArg('--resume', '');

if (isNaN(COHORT_SIZE) || isNaN(MAX_SPEND) || isNaN(PER_BATCH)) {
  console.error('ERROR: --cohort-size, --max-spend, --per-batch must be numbers');
  process.exit(1);
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlantResult {
  plant_code: string;
  outcome:    string;
  cost:       number;
  debug?:     string;
}

interface InvocationRecord {
  invoked_at:       string;
  plants_requested: number;
  plants_processed: number;
  cost_usd:         number;
  budget_remaining: number;
  results:          PlantResult[];
}

interface Ledger {
  session_id:           string;
  started_at:           string;
  resumed_at?:          string;
  max_spend_usd:        number;
  cohort_size:          number;
  per_batch:            number;
  cumulative_spend_usd: number;
  total_plants:         number;
  invocations:          InvocationRecord[];
}

// ── Session directory & ledger ────────────────────────────────────────────────

function isoSafe(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

let sessionDir: string;
let ledger: Ledger;
let ledgerPath: string;

if (RESUME_DIR) {
  sessionDir  = path.resolve(RESUME_DIR);
  ledgerPath  = path.join(sessionDir, 'ledger.json');
  if (!fs.existsSync(ledgerPath)) {
    console.error(`ERROR: Cannot resume — ledger.json not found in ${sessionDir}`);
    process.exit(1);
  }
  ledger            = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Ledger;
  ledger.resumed_at = new Date().toISOString();
  console.log(`Resuming session ${ledger.session_id}. Already spent $${ledger.cumulative_spend_usd.toFixed(4)}, processed ${ledger.total_plants} plants.`);
} else {
  const sessionId = `ucc-session-${isoSafe()}`;
  sessionDir  = path.join(process.cwd(), 'logs', sessionId);
  ledgerPath  = path.join(sessionDir, 'ledger.json');
  fs.mkdirSync(sessionDir, { recursive: true });
  ledger = {
    session_id:           sessionId,
    started_at:           new Date().toISOString(),
    max_spend_usd:        MAX_SPEND,
    cohort_size:          COHORT_SIZE,
    per_batch:            PER_BATCH,
    cumulative_spend_usd: 0,
    total_plants:         0,
    invocations:          [],
  };
  saveLedger(); // create on disk immediately
  console.log(`Session: ${sessionId}`);
  console.log(`Target: ${COHORT_SIZE} plants, per-batch: ${PER_BATCH}, ceiling: $${MAX_SPEND.toFixed(2)}`);
  console.log(`Logs: ${sessionDir}`);
}

// ── Ledger persistence ────────────────────────────────────────────────────────

function saveLedger(): void {
  const tmp = ledgerPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
  fs.renameSync(tmp, ledgerPath); // atomic on same filesystem
}

// ── SIGINT / crash safety ─────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\nSIGINT received — ledger already on disk, safe to resume later.');
  writeSummary();
  process.exit(0);
});

// ── Supervisor invocation ─────────────────────────────────────────────────────

const supervisorUrl = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/ucc-supervisor`;

interface SupervisorResponse {
  status:           string;
  plants_processed: number;
  total_cost_usd:   number;
  budget_remaining: number;
  results:          PlantResult[];
  [key: string]:    unknown;
}

async function invokeSupervisor(maxPlants: number, budgetPerBatch: number): Promise<SupervisorResponse> {
  const resp = await fetch(supervisorUrl, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      mode: 'batch',
      filters: {
        prioritize_curtailed: true,
        max_plants: maxPlants,
      },
      budget_usd: budgetPerBatch,
    }),
    signal: AbortSignal.timeout(180_000), // 3 min — edge timeout is ~150s, buffer for latency
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '(no body)');
    throw new Error(`Supervisor ${resp.status}: ${body.slice(0, 300)}`);
  }

  return resp.json() as Promise<SupervisorResponse>;
}

// ── Summary report ────────────────────────────────────────────────────────────

function writeSummary(): void {
  const allResults = ledger.invocations.flatMap(inv => inv.results);

  const counts: Record<string, number> = {};
  for (const r of allResults) {
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  }

  const avgCost = allResults.length
    ? (ledger.cumulative_spend_usd / allResults.length).toFixed(4)
    : 'N/A';

  const summary = {
    session_id:           ledger.session_id,
    completed_at:         new Date().toISOString(),
    total_plants:         ledger.total_plants,
    total_invocations:    ledger.invocations.length,
    cumulative_spend_usd: ledger.cumulative_spend_usd,
    max_spend_usd:        ledger.max_spend_usd,
    avg_cost_per_plant:   avgCost,
    outcome_breakdown:    counts,
    plants:               allResults,
  };

  const summaryPath = path.join(sessionDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n════════════════════════════════════════════════════════');
  console.log(`Session complete: ${ledger.session_id}`);
  console.log(`Plants processed: ${ledger.total_plants}`);
  console.log(`Total spend:      $${ledger.cumulative_spend_usd.toFixed(4)} / $${ledger.max_spend_usd.toFixed(2)} ceiling`);
  console.log(`Avg cost/plant:   $${avgCost}`);
  console.log(`Outcome breakdown:`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }
  console.log(`Summary written:  ${summaryPath}`);
  console.log('════════════════════════════════════════════════════════\n');
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const startPlants = ledger.total_plants;
  const targetPlants = COHORT_SIZE;

  console.log(`\nStarting at ${ledger.total_plants}/${targetPlants} plants processed, $${ledger.cumulative_spend_usd.toFixed(4)} spent.\n`);

  while (ledger.total_plants < targetPlants) {
    // Guard: enforce global spend ceiling BEFORE the next invocation
    if (ledger.cumulative_spend_usd >= ledger.max_spend_usd) {
      console.log(`\n⚠  Global spend ceiling reached: $${ledger.cumulative_spend_usd.toFixed(4)} ≥ $${ledger.max_spend_usd.toFixed(2)}. Stopping.`);
      break;
    }

    // How many plants left in this cohort?
    const remaining   = targetPlants - ledger.total_plants;
    const batchSize   = Math.min(PER_BATCH, remaining);

    // How much budget headroom remains?
    const headroom    = ledger.max_spend_usd - ledger.cumulative_spend_usd;
    // Allocate at most the headroom for this batch (cap at a sensible per-plant upper bound)
    const batchBudget = Math.min(headroom, batchSize * 0.50);

    console.log(`[${new Date().toISOString()}] Invoking supervisor: ${batchSize} plants, budget $${batchBudget.toFixed(2)}`);

    let response: SupervisorResponse;
    try {
      response = await invokeSupervisor(batchSize, batchBudget);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Supervisor error: ${msg}`);
      // Record the failed invocation and stop — don't retry automatically
      const failedRecord: InvocationRecord = {
        invoked_at:       new Date().toISOString(),
        plants_requested: batchSize,
        plants_processed: 0,
        cost_usd:         0,
        budget_remaining: 0,
        results:          [{ plant_code: 'N/A', outcome: 'supervisor_error', cost: 0, debug: msg }],
      };
      ledger.invocations.push(failedRecord);
      saveLedger();
      console.error('  Stopping after supervisor error. Ledger saved. Fix and resume with:');
      console.error(`  npx tsx scripts/run-ucc-calibration.ts --resume ${sessionDir}`);
      break;
    }

    const invRecord: InvocationRecord = {
      invoked_at:       new Date().toISOString(),
      plants_requested: batchSize,
      plants_processed: response.plants_processed ?? 0,
      cost_usd:         response.total_cost_usd   ?? 0,
      budget_remaining: response.budget_remaining ?? 0,
      results:          response.results          ?? [],
    };

    ledger.invocations.push(invRecord);
    ledger.cumulative_spend_usd += invRecord.cost_usd;
    ledger.total_plants         += invRecord.plants_processed;

    // ── CRITICAL: fsync ledger before sleeping or iterating ──────────────
    saveLedger();

    console.log(`  processed=${invRecord.plants_processed}, cost=$${invRecord.cost_usd.toFixed(4)}, cumulative=$${ledger.cumulative_spend_usd.toFixed(4)}/${ledger.max_spend_usd.toFixed(2)}`);

    // Log per-plant outcomes
    for (const r of invRecord.results) {
      const flag = r.outcome === 'complete' ? '✓' : r.outcome === 'needs_review' ? '~' : '✗';
      console.log(`    ${flag} ${r.plant_code.padEnd(10)} ${r.outcome}  $${r.cost.toFixed(4)}`);
    }

    // If the supervisor returned no_plants or processed fewer than requested,
    // the queue is likely empty.
    if (response.status === 'no_plants' || invRecord.plants_processed === 0) {
      console.log('\n  Queue appears empty — no more eligible curtailed plants to process.');
      break;
    }

    // Sleep between invocations to avoid hammering the edge runtime
    if (ledger.total_plants < targetPlants && ledger.cumulative_spend_usd < ledger.max_spend_usd) {
      console.log(`  Sleeping ${SLEEP_MS / 1000}s before next batch...`);
      await new Promise(r => setTimeout(r, SLEEP_MS));
    }
  }

  const netProcessed = ledger.total_plants - startPlants;
  console.log(`\nLoop complete. Processed ${netProcessed} new plants this run.`);
  writeSummary();
}

run().catch(err => {
  console.error('Fatal error:', err);
  saveLedger(); // ensure ledger is always on disk
  process.exit(1);
});
