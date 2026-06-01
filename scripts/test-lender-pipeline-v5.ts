import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

type CohortRow = {
  plant_id: string;
  category?: string;
};

const EXPECTED_PROMPT_VERSION = 'sonar-v5.3';
const TAX_EQUITY_BLOCKLIST = new Set([
  'Raymond James',
  'Monarch Private Capital',
  'US Bancorp Community Development',
  'Wells Fargo Affordable Housing',
  'JPMorgan Tax Credit Capital',
]);

function requireAnyEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Missing required env vars: ${names.join(', ')}`);
}

async function headOk(url: string): Promise<boolean> {
  return /^https?:\/\//i.test(url);
}

async function main() {
  const supabaseUrl = requireAnyEnv(['SUPABASE_URL', 'VITE_SUPABASE_URL']);
  const serviceRole = requireAnyEnv([
    'SUPABASE_SECRET_KEY',
    'VITE_SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'VITE_SUPABASE_SERVICE_ROLE_KEY',
  ]);
  const internalAuthToken = requireAnyEnv(['INTERNAL_AUTH_TOKEN', 'VITE_INTERNAL_AUTH_TOKEN']);
  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const cohortPath = path.join(process.cwd(), 'tests', 'lender-pipeline-v5', 'golden-cohort.json');
  const rows: CohortRow[] = JSON.parse(await fs.readFile(cohortPath, 'utf8'));

  if (rows.length === 0) {
    throw new Error('golden-cohort.json is empty; add cohort rows before running this test.');
  }

  let failures = 0;
  for (const row of rows) {
    const invoke = await supabase.functions.invoke('lender-research-sonar', {
      body: { plant_id: row.plant_id, force: true },
      headers: { Authorization: `Bearer ${internalAuthToken}` },
    });
    if (invoke.error) {
      failures++;
      console.error(`${row.plant_id}: invoke error ${invoke.error.message}`);
      continue;
    }

    const invokeStatus = String((invoke.data as any)?.status ?? '').trim();
    if (!['complete', 'no_lender_identifiable', 'error'].includes(invokeStatus)) {
      failures++;
      console.error(`${row.plant_id}: invalid invoke status ${invokeStatus || '<empty>'}`);
    }

    const invokeCost = Number((invoke.data as any)?.cost_usd ?? NaN);
    if (!Number.isFinite(invokeCost) || invokeCost > 0.1) {
      failures++;
      console.error(`${row.plant_id}: cost_usd invalid or exceeds cap (got ${String((invoke.data as any)?.cost_usd ?? 'null')})`);
    }

    const researchId = String((invoke.data as any)?.research_id ?? '').trim();
    if (!researchId) {
      failures++;
      console.error(`${row.plant_id}: invoke succeeded but returned no research_id`);
      continue;
    }

    const researchRes = await supabase
      .from('plant_lender_research')
      .select('id, prompt_version, status')
      .eq('id', researchId)
      .eq('plant_id', row.plant_id)
      .maybeSingle();

    if (researchRes.error || !researchRes.data) {
      failures++;
      console.error(`${row.plant_id}: missing research row for ${researchId} (${researchRes.error?.message ?? 'not found'})`);
      continue;
    }

    if (researchRes.data.prompt_version !== EXPECTED_PROMPT_VERSION) {
      failures++;
      console.error(`${row.plant_id}: expected prompt_version ${EXPECTED_PROMPT_VERSION}, got ${researchRes.data.prompt_version}`);
    }

    const linksRes = await supabase
      .from('plant_lender_links')
      .select('source_url, lender_id, lenders_canonical!inner(id, canonical_name, is_tax_equity)')
      .eq('plant_id', row.plant_id)
      .eq('research_id', researchId);

    if (linksRes.error) {
      failures++;
      console.error(`${row.plant_id}: query error ${linksRes.error.message}`);
      continue;
    }

    const links = (linksRes.data ?? []).map((link: any) => {
      const lenderNode = link?.lenders_canonical;
      const lenderMeta = Array.isArray(lenderNode) ? lenderNode[0] : lenderNode;

      const canonicalName = String(lenderMeta?.canonical_name ?? '');
      const joinedId = String(lenderMeta?.id ?? '');
      const lenderId = String(link?.lender_id ?? '');

      return {
        lender_name: canonicalName,
        lender_id: lenderId,
        canonical_id: joinedId,
        is_tax_equity: Boolean(lenderMeta?.is_tax_equity),
        source_url: String(link?.source_url ?? ''),
      };
    });

    if (invokeStatus === 'complete') {
      for (const link of links) {
        const ok = await headOk(String((link as any).source_url ?? ''));
        if (!ok) {
          failures++;
          console.error(`${row.plant_id}: invalid source URL ${(link as any).source_url}`);
        }

        if ((link as any).is_tax_equity) {
          failures++;
          console.error(`${row.plant_id}: tax-equity lender leaked ${(link as any).lender_name}`);
        }

        if (!(link as any).lender_id || !(link as any).canonical_id || (link as any).lender_id !== (link as any).canonical_id) {
          failures++;
          console.error(`${row.plant_id}: canonical lender join mismatch lender_id=${(link as any).lender_id} canonical_id=${(link as any).canonical_id}`);
        }

        if (TAX_EQUITY_BLOCKLIST.has(String((link as any).lender_name))) {
          failures++;
          console.error(`${row.plant_id}: blocked tax-equity canonical leaked ${(link as any).lender_name}`);
        }
      }
    } else if (links.length > 0 && invokeStatus === 'no_lender_identifiable') {
      failures++;
      console.error(`${row.plant_id}: status=no_lender_identifiable but found ${links.length} lender row(s)`);
    }

    if (invokeStatus === 'error' && links.length > 0) {
      // An error status should not insert lender rows for the same research id.
      failures++;
      console.error(`${row.plant_id}: status=error but found ${links.length} lender row(s)`);
    }

    if (researchRes.data.status !== invokeStatus) {
      failures++;
      console.error(`${row.plant_id}: invoke status ${invokeStatus} differs from DB status ${researchRes.data.status}`);
    }

    console.log(`${row.plant_id}: status=${invokeStatus} lenders=${links.length} cost=$${invokeCost.toFixed(4)}`);
  }

  // Global invariant: no blocked tax-equity canonical should exist in links table at all.
  const blockedCanonicals = await supabase
    .from('lenders_canonical')
    .select('id, canonical_name')
    .in('canonical_name', Array.from(TAX_EQUITY_BLOCKLIST));

  if (blockedCanonicals.error) {
    failures++;
    console.error(`tax-equity canonical lookup failed: ${blockedCanonicals.error.message}`);
  } else {
    const blockedIds = (blockedCanonicals.data ?? [])
      .map((row: any) => String(row.id ?? '').trim())
      .filter(Boolean);

    if (blockedIds.length > 0) {
      const leakedTaxEquity = await supabase
        .from('plant_lender_links')
        .select('plant_id, lender_id')
        .in('lender_id', blockedIds);

      if (leakedTaxEquity.error) {
        failures++;
        console.error(`global tax-equity leakage query failed: ${leakedTaxEquity.error.message}`);
      } else if ((leakedTaxEquity.data ?? []).length > 0) {
        failures += (leakedTaxEquity.data ?? []).length;
        for (const rowLeak of leakedTaxEquity.data ?? []) {
          console.error(
            `blocked tax-equity canonical present in links: plant=${(rowLeak as any).plant_id} lender_id=${(rowLeak as any).lender_id}`,
          );
        }
      }
    }
  }

  if (failures > 0) {
    console.error(`test-lender-pipeline-v5 failed with ${failures} failure(s)`);
    process.exit(1);
  }

  console.log('test-lender-pipeline-v5 passed');
}

main().catch((err) => {
  console.error('test-lender-pipeline-v5 errored:', err);
  process.exit(1);
});
