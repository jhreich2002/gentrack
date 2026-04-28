/**
 * GenTrack — ucc-smoke-runner Edge Function (Deno)
 *
 * Smoke-tests the UCC pipeline on a curated set of plants with known lender
 * relationships. Invokes the supervisor in single-plant mode for each test
 * case and reports pass/fail against expected outcomes.
 *
 * Test corpus:
 *   1. Solana Solar (known DOE LPO loan)       → expect ≥1 confirmed lender
 *   2. NextEra TX plant                        → expect EDGAR lenders
 *   3. Clearway CA plant (SoS searchable)      → expect UCC lenders
 *   4. AES NY plant                            → expect FERC dockets
 *   5. Crescent Dunes                          → expect DOE LPO + EDGAR (adversarial)
 *
 * POST body: {} (no params required)
 *
 * Returns: { pass: number, fail: number, results: TestResult[] }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

interface TestCase {
  label:               string;
  plant_code:          string;
  min_confirmed:       number;   // minimum confirmed lender links expected
  min_highly_likely:   number;   // minimum highly_likely lender links expected
  expect_doe_lpo:      boolean;
  expect_edgar:        boolean;
  notes:               string;
}

interface TestResult {
  label:       string;
  plant_code:  string;
  passed:      boolean;
  workflow_status: string;
  confirmed_count: number;
  highly_likely_count: number;
  unverified_count: number;
  notes:       string;
  failure_reason?: string;
}

// ── Test corpus — all plant_codes validated against the `plants` table ────────
// Validation query run 2026-04-27; codes confirmed present. Substitutions noted.
const TEST_CORPUS: TestCase[] = [
  {
    label:             'Solana Solar (DOE LPO)',
    plant_code:        '56812',   // Solana Solar Generating Station, Maricopa County AZ (Abengoa; $1.45B DOE LPO)
    min_confirmed:     1,
    min_highly_likely: 0,
    expect_doe_lpo:    true,
    expect_edgar:      false,
    notes:             '$1.45B DOE LPO loan guarantee to Abengoa Solar; classic confirmed case',
  },
  {
    label:             'Wolf Ridge Wind — NextEra TX (EDGAR)',
    plant_code:        '58080',   // Wolf Ridge Wind, TX — NextEra Energy Resources
    min_confirmed:     0,
    min_highly_likely: 1,
    expect_doe_lpo:    false,
    expect_edgar:      true,
    notes:             'NextEra 10-K/8-K disclosures typically name project finance lenders',
  },
  {
    label:             'California Valley Solar Ranch — Clearway CA (UCC)',
    plant_code:        '57439',   // California Valley Solar Ranch, San Luis Obispo Co CA (SunPower→Clearway)
    min_confirmed:     0,
    min_highly_likely: 1,
    expect_doe_lpo:    false,
    expect_edgar:      false,
    notes:             'CA SoS UCC filings should be searchable; SunPower legacy financing',
  },
  {
    label:             'Marble River Wind — NY (FERC)',
    plant_code:        '56857',   // Marble River Wind Farm, Clinton County NY
    min_confirmed:     0,
    min_highly_likely: 0,
    expect_doe_lpo:    false,
    expect_edgar:      false,
    notes:             'FERC interconnection dockets may name construction lenders; low-confidence target',
  },
  {
    label:             'Crescent Dunes (DOE + EDGAR adversarial)',
    plant_code:        '57275',   // Crescent Dunes Solar Energy Project, Nye County NV (SolarReserve)
    min_confirmed:     1,
    min_highly_likely: 0,
    expect_doe_lpo:    true,
    expect_edgar:      true,
    notes:             'Adversarial: SolarReserve bankruptcy; $737M DOE LPO + EDGAR disclosures still public',
  },
];

function log(plant_code: string, msg: string): void {
  console.log(`[smoke-runner][${plant_code}] ${msg}`);
}

async function runOnePlant(
  supabaseUrl: string,
  supabaseKey: string,
  plantCode:   string,
): Promise<{ workflow_status: string; confirmed: number; highly_likely: number; unverified: number }> {
  const supervisorUrl = `${supabaseUrl}/functions/v1/ucc-supervisor`;
  const resp = await fetch(supervisorUrl, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${Deno.env.get('INTERNAL_AUTH_TOKEN') ?? supabaseKey}`,
    },
    body: JSON.stringify({ mode: 'single', plant_code: plantCode }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    throw new Error(`Supervisor returned ${resp.status} for plant ${plantCode}`);
  }

  // Give DB a moment to settle after supervisor writes
  await new Promise(r => setTimeout(r, 1500));

  // Fetch results from DB
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data: plant } = await supabase
    .from('ucc_research_plants')
    .select('workflow_status')
    .eq('plant_code', plantCode)   // column renamed from eia_plant_code in migration 20260424_ucc_lender_research_fixes
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  const { count: confirmedCount } = await supabase
    .from('ucc_lender_links')
    .select('id', { count: 'exact', head: true })
    .eq('plant_code', plantCode)
    .eq('confidence_class', 'confirmed');

  const { count: highlyLikelyCount } = await supabase
    .from('ucc_lender_links')
    .select('id', { count: 'exact', head: true })
    .eq('plant_code', plantCode)
    .eq('confidence_class', 'highly_likely');

  const { count: unverifiedCount } = await supabase
    .from('ucc_lender_leads_unverified')
    .select('id', { count: 'exact', head: true })
    .eq('plant_code', plantCode);

  return {
    workflow_status: plant?.workflow_status ?? 'unknown',
    confirmed:       confirmedCount ?? 0,
    highly_likely:   highlyLikelyCount ?? 0,
    unverified:      unverifiedCount ?? 0,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const __authDenied = checkInternalAuth(req);
  if (__authDenied) return __authDenied;
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // ── Startup self-check: every test case must exist in `plants` ───────────
  const testCodes = TEST_CORPUS.map(tc => tc.plant_code);
  const { data: foundPlants, error: checkErr } = await supabase
    .from('plants')
    .select('eia_plant_code')
    .in('eia_plant_code', testCodes);

  if (checkErr) {
    return new Response(
      JSON.stringify({ error: 'Self-check DB query failed', detail: checkErr.message }),
      { status: 500, headers: CORS },
    );
  }

  const foundCodes = new Set((foundPlants ?? []).map((r: Record<string, unknown>) => String(r.eia_plant_code)));
  const missingCodes = testCodes.filter(c => !foundCodes.has(c));
  if (missingCodes.length > 0) {
    return new Response(
      JSON.stringify({
        error: 'Startup self-check failed — plant codes not found in `plants` table',
        missing: missingCodes,
        hint: 'Update TEST_CORPUS with valid EIA plant codes before running smoke tests',
      }),
      { status: 422, headers: CORS },
    );
  }

  log('self-check', `All ${testCodes.length} test case plant codes verified in DB ✓`);

  const results: TestResult[] = [];
  let passCount = 0;
  let failCount = 0;

  for (const tc of TEST_CORPUS) {
    log(tc.plant_code, `Starting — ${tc.label}`);
    try {
      const outcome = await runOnePlant(supabaseUrl, supabaseKey, tc.plant_code);

      // Evaluate against expectations
      const failReasons: string[] = [];

      if (outcome.confirmed < tc.min_confirmed) {
        failReasons.push(
          `Expected ≥${tc.min_confirmed} confirmed links, got ${outcome.confirmed}`
        );
      }
      if (outcome.highly_likely < tc.min_highly_likely) {
        failReasons.push(
          `Expected ≥${tc.min_highly_likely} highly_likely links, got ${outcome.highly_likely}`
        );
      }
      if (outcome.workflow_status === 'unresolved' && (tc.min_confirmed + tc.min_highly_likely) > 0) {
        failReasons.push(`Workflow status is unresolved — expected evidence`);
      }

      const passed = failReasons.length === 0;
      if (passed) passCount++; else failCount++;

      log(tc.plant_code, `${passed ? 'PASS' : 'FAIL'} — status=${outcome.workflow_status}, confirmed=${outcome.confirmed}, highly_likely=${outcome.highly_likely}`);

      results.push({
        label:               tc.label,
        plant_code:          tc.plant_code,
        passed,
        workflow_status:     outcome.workflow_status,
        confirmed_count:     outcome.confirmed,
        highly_likely_count: outcome.highly_likely,
        unverified_count:    outcome.unverified,
        notes:               tc.notes,
        failure_reason:      failReasons.length ? failReasons.join('; ') : undefined,
      });
    } catch (err) {
      failCount++;
      const msg = err instanceof Error ? err.message : String(err);
      log(tc.plant_code, `ERROR — ${msg}`);
      results.push({
        label:               tc.label,
        plant_code:          tc.plant_code,
        passed:              false,
        workflow_status:     'error',
        confirmed_count:     0,
        highly_likely_count: 0,
        unverified_count:    0,
        notes:               tc.notes,
        failure_reason:      msg,
      });
    }
  }

  return new Response(
    JSON.stringify({
      pass:    passCount,
      fail:    failCount,
      total:   TEST_CORPUS.length,
      results,
    }, null, 2),
    { headers: CORS },
  );
});
