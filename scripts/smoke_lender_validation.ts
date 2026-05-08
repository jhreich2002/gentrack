// scripts/smoke_lender_validation.ts
// Smoke test for the unified lender validation pipeline.
// Reads from the new views and tables to confirm the migration is wired up.
//
// Usage: npx tsx scripts/smoke_lender_validation.ts
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

function loadEnv(): void {
  for (const f of ['.env', '.env.local']) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      const k = t.slice(0, idx).trim();
      const v = t.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k && !process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

const url  = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or VITE_* fallbacks)');
  process.exit(1);
}
const sb = createClient(url, key);

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';

let failed = 0;

async function check<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn();
    console.log(`${PASS} ${label}`);
    return r;
  } catch (e: any) {
    console.log(`${FAIL} ${label} — ${e?.message ?? e}`);
    failed++;
    return null;
  }
}

(async () => {
  console.log('\n── Schema objects ──');

  await check('normalize_lender_name() returns expected token', async () => {
    const { data, error } = await sb.rpc('normalize_lender_name', { p_name: 'Wells Fargo Bank, N.A. as Agent' });
    if (error) throw error;
    if (typeof data !== 'string' || !data.includes('wells fargo')) {
      throw new Error(`unexpected result: ${JSON.stringify(data)}`);
    }
    console.log(`    → "${data}"`);
  });

  await check('ucc_lender_leads_unverified.lead_status column exists', async () => {
    const { data, error } = await sb
      .from('ucc_lender_leads_unverified')
      .select('id, lead_status, legacy_plant_lender_id')
      .limit(1);
    if (error) throw error;
    console.log(`    → sample row count: ${data?.length ?? 0}`);
  });

  await check('ucc_research_plants.lender_resolution column exists', async () => {
    const { data, error } = await sb
      .from('ucc_research_plants')
      .select('plant_code, lender_resolution')
      .limit(1);
    if (error) throw error;
    console.log(`    → sample row count: ${data?.length ?? 0}`);
  });

  await check('ucc_lender_pursuits table exists', async () => {
    const { count, error } = await sb
      .from('ucc_lender_pursuits')
      .select('lender_normalized', { count: 'exact', head: true });
    if (error) throw error;
    console.log(`    → row count: ${count}`);
  });

  console.log('\n── Views ──');

  const queue = await check('v_lender_validation_queue readable', async () => {
    const { data, error } = await sb
      .from('v_lender_validation_queue')
      .select('lender_normalized, lender_name, pending_count, pending_plant_count, curtailed_plant_count, curtailed_mw')
      .order('curtailed_mw', { ascending: false })
      .limit(10);
    if (error) throw error;
    return data ?? [];
  });

  if (queue && queue.length > 0) {
    console.log('    Top 10 lenders in validation queue (by curtailed MW):');
    for (const r of queue) {
      console.log(`      • ${r.lender_name?.padEnd(45)} pending=${r.pending_count}  plants=${r.pending_plant_count}  curtailed=${r.curtailed_plant_count}  mw=${Number(r.curtailed_mw).toFixed(0)}`);
    }
    const multiPlant = queue.filter((r: any) => r.pending_plant_count >= 2).length;
    console.log(`    → ${multiPlant}/${queue.length} of top 10 have ≥2 candidate plants`);
  } else {
    console.log(`    ${WARN} queue is empty — backfill found no high/medium plant_lenders rows or all already linked`);
  }

  await check('v_validated_lender_portfolio readable', async () => {
    const { data, error } = await sb
      .from('v_validated_lender_portfolio')
      .select('lender_normalized, lender_name, validated_plant_count, curtailed_mw')
      .order('curtailed_mw', { ascending: false })
      .limit(5);
    if (error) throw error;
    console.log(`    → ${data?.length ?? 0} validated lender(s)`);
    for (const r of (data ?? []) as any[]) {
      console.log(`      • ${r.lender_name?.padEnd(45)} plants=${r.validated_plant_count}  mw=${Number(r.curtailed_mw).toFixed(0)}`);
    }
  });

  console.log('\n── Backfill volume ──');

  await check('Backfilled rows in ucc_lender_leads_unverified', async () => {
    const { count, error } = await sb
      .from('ucc_lender_leads_unverified')
      .select('id', { count: 'exact', head: true })
      .not('legacy_plant_lender_id', 'is', null);
    if (error) throw error;
    console.log(`    → ${count} legacy plant_lenders rows mirrored`);
  });

  await check('Total pending leads', async () => {
    const { count, error } = await sb
      .from('ucc_lender_leads_unverified')
      .select('id', { count: 'exact', head: true })
      .eq('lead_status', 'pending');
    if (error) throw error;
    console.log(`    → ${count} pending leads`);
  });

  await check('plant_lenders source pool (high/medium confidence)', async () => {
    const { count, error } = await sb
      .from('plant_lenders')
      .select('id', { count: 'exact', head: true })
      .in('confidence', ['high', 'medium']);
    if (error) throw error;
    console.log(`    → ${count} eligible legacy rows total`);
  });

  console.log('\n── RPC presence ──');
  // PostgREST resolves overloads by argument names — call with the correct
  // parameter shape (anon-key auth fails the auth.uid() guard, which proves
  // the function exists and is reachable).
  const probes: Array<[string, Record<string, unknown>]> = [
    ['validate_lender_lead',         { p_lead_id: -1, p_note: null }],
    ['reject_lender_lead',           { p_lead_id: -1, p_reason: null }],
    ['add_manual_lender_link',       { p_plant_code: '__smoke__', p_lender_name: '__smoke__', p_source_url: 'https://x', p_note: '__too_short__', p_facility_type: null }],
    ['mark_no_lender_identifiable',  { p_plant_code: '__smoke__', p_note: null }],
    ['set_lender_pursuit_tier',      { p_lender_normalized: '__smoke__', p_tier: 'hot', p_notes: null }],
  ];
  for (const [fn, args] of probes) {
    const { error } = await sb.rpc(fn, args);
    if (!error) {
      console.log(`${WARN} ${fn} returned no error — unexpected`);
    } else if (/Could not find the function|schema cache/i.test(error.message)) {
      console.log(`${FAIL} ${fn} not found: ${error.message}`);
      failed++;
    } else {
      console.log(`${PASS} ${fn} present (${error.message.slice(0, 80)})`);
    }
  }

  console.log('');
  if (failed > 0) {
    console.log(`\x1b[31m${failed} check(s) failed\x1b[0m`);
    process.exit(1);
  }
  console.log('\x1b[32mAll smoke checks passed.\x1b[0m');
})();
