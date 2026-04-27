/**
 * reset-plants.ts
 *
 * Resets plants in ucc_research_plants to pending so they can be reprocessed.
 * Optional --purge-evidence also removes prior evidence/link rows for those plants.
 *
 * Usage:
 *   npx tsx scripts/reset-plants.ts 56812 57275
 *   npx tsx scripts/reset-plants.ts --purge-evidence 56812 57275 57439 56857 58080
 */

import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

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

const args = process.argv.slice(2);
const purgeEvidence = args.includes('--purge-evidence');
const plantCodes = args.filter(a => a !== '--purge-evidence');

if (!plantCodes.length) {
  console.error('Usage: npx tsx scripts/reset-plants.ts [--purge-evidence] <plant_code> [<plant_code> ...]');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function run(): Promise<void> {
  console.log(`Resetting ${plantCodes.length} plant(s): ${plantCodes.join(', ')}`);

  const { error: resetErr, data: resetRows } = await supabase
    .from('ucc_research_plants')
    .update({
      workflow_status: 'pending',
      top_confidence: null,
      lender_count: 0,
      total_cost_usd: 0,
      last_run_at: null,
    })
    .in('plant_code', plantCodes)
    .select('plant_code');

  if (resetErr) {
    console.error(`ERROR resetting ucc_research_plants: ${resetErr.message}`);
    process.exit(1);
  }

  console.log(`  reset rows: ${(resetRows ?? []).length}`);

  if (!purgeEvidence) {
    console.log('Done. (Evidence retained; run with --purge-evidence to wipe prior evidence rows.)');
    return;
  }

  const deletes: Array<{ table: string; col: string }> = [
    { table: 'ucc_evidence_records', col: 'plant_code' },
    { table: 'ucc_lender_links', col: 'plant_code' },
    { table: 'ucc_lender_leads_unverified', col: 'plant_code' },
    { table: 'ucc_agent_tasks', col: 'plant_code' },
    { table: 'ucc_agent_runs', col: 'plant_code' },
  ];

  for (const d of deletes) {
    const { error, count } = await supabase
      .from(d.table)
      .delete({ count: 'exact' })
      .in(d.col, plantCodes);

    if (error) {
      console.error(`ERROR deleting from ${d.table}: ${error.message}`);
      process.exit(1);
    }

    console.log(`  deleted ${count ?? 0} row(s) from ${d.table}`);
  }

  console.log('Done. Plants reset and evidence purged.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
