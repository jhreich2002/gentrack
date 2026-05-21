import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

type ArgValue = string | boolean;

interface PlantCandidate {
  plant_id: string;
  plant_name: string;
  nameplate_capacity_mw: number | null;
  is_likely_curtailed: boolean;
  research_status: string;
  owner?: string | null;
}

interface PlantOwnerRow {
  id: string;
  owner: string | null;
  nameplate_capacity_mw: number | null;
}

interface SessionRow {
  id: string;
  status: string;
  cost_usd: number | null;
  budget_exceeded: boolean | null;
  started_at: string | null;
  completed_at: string | null;
  error_detail: string | null;
}

const YIELDCO_OWNER_HINTS = [
  'nextera',
  'clearway',
  'aes',
  'invenergy',
  'edf',
  'duke',
  'terraform',
  'pattern',
  'avangrid',
  'edp',
  'brookfield',
  'enel',
  'orsted',
];

function isYieldcoOwner(owner: string | null | undefined): boolean {
  if (!owner) return false;
  const normalized = owner.toLowerCase();
  return YIELDCO_OWNER_HINTS.some(hint => normalized.includes(hint));
}

// Public companies that file with the SEC and have EDGAR credit-agreement exhibits
const PUBLIC_SEC_FILER_HINTS = [
  'avangrid', 'iberdrola',
  'aes ',  'aes corp',
  'duke energy', 'duke renewable',
  'nextera', 'fpl group',
  'clearway', 'nrg yield',
  'pattern energy',
  'terraform', 'sunedison',
  'enel',
  'edf renew',
  'brookfield',
  'calpine',
  'orion energy', 'orion renewables',
  'entergy',
  'southern company', 'southern power',
  'dominion',
  'ameren',
  'xcel energy',
  'national grid',
  'algonquin',
  'boralex',
];

function isPublicSECFiler(owner: string | null | undefined): boolean {
  if (!owner) return false;
  const normalized = owner.toLowerCase();
  return PUBLIC_SEC_FILER_HINTS.some(hint => normalized.includes(hint));
}

function parseArgs(argv: string[]): Map<string, ArgValue> {
  const out = new Map<string, ArgValue>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out.set(key, next);
      i++;
    } else {
      out.set(key, true);
    }
  }
  return out;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, 'utf8');
  const map: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

function envValue(key: string, localEnv: Record<string, string>): string {
  return process.env[key] ?? localEnv[key] ?? '';
}

function asNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollSession(
  sb: ReturnType<typeof createClient>,
  plantId: string,
  sessionId: string | undefined,
  attempts: number,
  intervalMs: number,
): Promise<SessionRow | null> {
  for (let i = 0; i < attempts; i++) {
    let row: SessionRow | null = null;

    if (sessionId) {
      const { data, error } = await sb
        .from('lender_research_sessions')
        .select('id, status, cost_usd, budget_exceeded, started_at, completed_at, error_detail')
        .eq('id', sessionId)
        .maybeSingle();
      if (error) throw new Error(`poll by session_id failed: ${error.message}`);
      row = (data as SessionRow | null) ?? null;
    } else {
      const { data, error } = await sb
        .from('lender_research_sessions')
        .select('id, status, cost_usd, budget_exceeded, started_at, completed_at, error_detail')
        .eq('plant_id', plantId)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`poll latest session failed: ${error.message}`);
      row = (data as SessionRow | null) ?? null;
    }

    if (!row) {
      await sleep(intervalMs);
      continue;
    }

    const status = String(row.status || '').toLowerCase();
    const active = status === 'running' || status === 'in_progress';
    if (!active) return row;

    await sleep(intervalMs);
  }

  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.get('help')) {
    console.log([
      'Usage: npx tsx scripts/run-v4-curtailed-ingestion.ts [options]',
      '',
      'Options:',
      '  --size 5                    Number of plants in cohort (default: 5)',
      '  --cohort curtailed           Cohort mode: curtailed | yieldco (default: curtailed)',
      '  --min-mw 50                 Minimum nameplate MW filter (default: 50)',
      '  --min-cod-year 2018         Minimum commercial-operation year (default: none)',
      '  --status never,in_progress  Comma list of research statuses to include (default: never)',
      '  --budget 0.5                Budget per plant in USD (default: 0.5)',
      '  --poll-attempts 30          Poll attempts for session completion (default: 30)',
      '  --poll-seconds 8            Poll interval seconds (default: 8)',
      '  --plant-ids EIA-1,EIA-2     Explicit plant IDs (skip auto-cohort query)',
      '  --concurrency 4             Number of plants to process in parallel (default: 1)',
      '  --trigger manual            Orchestrator trigger mode: initial | manual | refresh (default: manual)',
      '  --edgar-only                Skip Perplexity workers; use EDGAR SEC filings only (free, no API cost)',
      '  --public-owners             Only include plants whose owner has SEC EDGAR filings (Duke, AES, NextEra, etc.)',
      '  --dry-run                   Show selected cohort only, do not trigger orchestrator',
      '  --internal-token <token>    Override INTERNAL_AUTH_TOKEN env value',
      '',
      'Environment:',
      '  SUPABASE_URL or VITE_SUPABASE_URL',
      '  SUPABASE_SERVICE_ROLE_KEY or VITE_SUPABASE_SERVICE_ROLE_KEY',
      '  INTERNAL_AUTH_TOKEN or VITE_INTERNAL_AUTH_TOKEN',
    ].join('\n'));
    return;
  }

  const cwd = process.cwd();
  const mergedEnv = {
    ...parseEnvFile(path.join(cwd, '.env')),
    ...parseEnvFile(path.join(cwd, '.env.local')),
  };

  const supabaseUrl = envValue('SUPABASE_URL', mergedEnv) || envValue('VITE_SUPABASE_URL', mergedEnv);
  const serviceRoleKey = envValue('SUPABASE_SERVICE_ROLE_KEY', mergedEnv) || envValue('VITE_SUPABASE_SERVICE_ROLE_KEY', mergedEnv);
  const internalTokenArg = args.get('internal-token');
  const internalToken = (typeof internalTokenArg === 'string' ? internalTokenArg : '')
    || envValue('INTERNAL_AUTH_TOKEN', mergedEnv)
    || envValue('VITE_INTERNAL_AUTH_TOKEN', mergedEnv);

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase URL or service role key in env.');
  }

  const size = asNumber(typeof args.get('size') === 'string' ? String(args.get('size')) : undefined, 5);
  const minMw = asNumber(typeof args.get('min-mw') === 'string' ? String(args.get('min-mw')) : undefined, 50);
  const minCodYear = asNumber(typeof args.get('min-cod-year') === 'string' ? String(args.get('min-cod-year')) : undefined, 0);
  const budget = asNumber(typeof args.get('budget') === 'string' ? String(args.get('budget')) : undefined, 0.5);
  const pollAttempts = asNumber(typeof args.get('poll-attempts') === 'string' ? String(args.get('poll-attempts')) : undefined, 30);
  const pollSeconds = asNumber(typeof args.get('poll-seconds') === 'string' ? String(args.get('poll-seconds')) : undefined, 8);
  const cohort = (typeof args.get('cohort') === 'string' ? String(args.get('cohort')) : 'curtailed').trim().toLowerCase();
  const statuses = asCsv(typeof args.get('status') === 'string' ? String(args.get('status')) : 'never');
  const plantIds = asCsv(typeof args.get('plant-ids') === 'string' ? String(args.get('plant-ids')) : undefined);
  const concurrency = Math.max(1, asNumber(typeof args.get('concurrency') === 'string' ? String(args.get('concurrency')) : undefined, 1));
  const dryRun = Boolean(args.get('dry-run'));
  const edgarOnly = Boolean(args.get('edgar-only'));
  const publicOwnersOnly = Boolean(args.get('public-owners'));
  const triggerMode = (typeof args.get('trigger') === 'string' ? String(args.get('trigger')) : 'manual').trim();

  if (!['curtailed', 'yieldco'].includes(cohort)) {
    throw new Error(`Invalid --cohort value: ${cohort}. Use curtailed or yieldco.`);
  }

  const sb = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  let candidates: PlantCandidate[] = [];

  if (plantIds.length > 0) {
    const { data, error } = await sb
      .from('v_plant_research_state')
      .select('plant_id, plant_name, nameplate_capacity_mw, is_likely_curtailed, research_status')
      .in('plant_id', plantIds);
    if (error) throw new Error(`Failed to fetch explicit plant IDs: ${error.message}`);
    candidates = (data as PlantCandidate[] | null) ?? [];
  } else if (cohort === 'yieldco') {
    const ownerScanLimit = Math.max(size * 20, 200);
    const { data: ownerRows, error: ownerErr } = await sb
      .from('plants')
      .select('id, owner, nameplate_capacity_mw')
      .eq('is_likely_curtailed', true)
      .gte('nameplate_capacity_mw', minMw)
      .order('nameplate_capacity_mw', { ascending: false })
      .limit(ownerScanLimit);

    if (ownerErr) throw new Error(`Failed to fetch yieldco owner candidates: ${ownerErr.message}`);

    const filteredOwners = ((ownerRows as PlantOwnerRow[] | null) ?? []).filter(r => isYieldcoOwner(r.owner));
    const scanIds = filteredOwners.slice(0, Math.max(size * 8, size)).map(r => String(r.id));
    const ownerByPlantId = new Map(filteredOwners.map(r => [String(r.id), r.owner ?? null]));

    if (scanIds.length === 0) {
      throw new Error('Yieldco cohort found no owner matches. Try lowering --min-mw or use --cohort curtailed.');
    }

    let q = sb
      .from('v_plant_research_state')
      .select('plant_id, plant_name, nameplate_capacity_mw, is_likely_curtailed, research_status')
      .in('plant_id', scanIds)
      .order('nameplate_capacity_mw', { ascending: false });

    if (statuses.length > 0) q = q.in('research_status', statuses);

    const { data, error } = await q;
    if (error) throw new Error(`Failed to fetch yieldco cohort from research view: ${error.message}`);

    candidates = (((data as PlantCandidate[] | null) ?? [])
      .map(r => ({ ...r, owner: ownerByPlantId.get(String(r.plant_id)) ?? null }))
      .slice(0, size));
  } else {
    // Default curtailed cohort. If --min-cod-year is set, pre-filter the
    // plants table by COD year (text column 'cod' starts with YYYY), then
    // intersect with the research-state view.
    let preFilteredIds: string[] | null = null;
    if (minCodYear > 0) {
      const { data: codRows, error: codErr } = await sb
        .from('plants')
        .select('id, cod')
        .eq('is_likely_curtailed', true)
        .gte('nameplate_capacity_mw', minMw)
        .not('cod', 'is', null);
      if (codErr) throw new Error(`Failed to fetch COD-filtered plants: ${codErr.message}`);
      preFilteredIds = ((codRows as Array<{ id: string; cod: string | null }> | null) ?? [])
        .filter(r => {
          const y = parseInt(String(r.cod ?? '').slice(0, 4), 10);
          return Number.isFinite(y) && y >= minCodYear;
        })
        .map(r => String(r.id));
      console.log(`COD>=${minCodYear} pre-filter matched ${preFilteredIds.length} plants`);
      if (preFilteredIds.length === 0) {
        throw new Error(`No plants with cod >= ${minCodYear} matched.`);
      }
    }

    let q = sb
      .from('v_plant_research_state')
      .select('plant_id, plant_name, nameplate_capacity_mw, is_likely_curtailed, research_status')
      .eq('is_likely_curtailed', true)
      .gte('nameplate_capacity_mw', minMw)
      .order('nameplate_capacity_mw', { ascending: false })
      .limit(Math.max(size * 3, size));

    if (preFilteredIds) q = q.in('plant_id', preFilteredIds);
    if (statuses.length > 0) q = q.in('research_status', statuses);

    const { data, error } = await q;
    if (error) throw new Error(`Failed to fetch curtailed cohort: ${error.message}`);
    let rawCandidates = (data as PlantCandidate[] | null) ?? [];

    if (publicOwnersOnly) {
      // --public-owners: fetch owner column and restrict to SEC filers
      const rawIds = rawCandidates.map(r => r.plant_id);
      if (rawIds.length > 0) {
        const { data: ownerRows, error: ownerErr } = await sb
          .from('plants')
          .select('id, owner')
          .in('id', rawIds);
        if (ownerErr) throw new Error(`Failed to fetch owners for public-owners filter: ${ownerErr.message}`);
        const ownerMap = new Map(((ownerRows as Array<{ id: string; owner: string | null }> | null) ?? []).map(r => [String(r.id), r.owner ?? null]));
        rawCandidates = rawCandidates
          .map(r => ({ ...r, owner: ownerMap.get(r.plant_id) ?? null }))
          .filter(r => isPublicSECFiler(r.owner));
        console.log(`--public-owners filter: ${rawCandidates.length} plants with known SEC-filing owners`);
      }
    }

    candidates = rawCandidates.slice(0, size);
  }

  if (candidates.length === 0) {
    throw new Error('No plants matched filters. Try adjusting --status/--min-mw or switching --cohort mode.');
  }

  console.log('\nSelected cohort:');
  const includeOwner = candidates.some(c => !!c.owner);
  console.table(candidates.map(c => ({
    plant_id: c.plant_id,
    eia_plant_code: c.plant_id.replace(/^EIA-/, ''),
    plant_name: c.plant_name,
    ...(includeOwner ? { owner: c.owner ?? '' } : {}),
    mw: c.nameplate_capacity_mw,
    status: c.research_status,
  })));

  if (dryRun) {
    console.log('\nDry run only. No orchestrator calls were made.');
    return;
  }

  if (!internalToken) {
    throw new Error('Missing INTERNAL_AUTH_TOKEN (or --internal-token) for orchestrator auth.');
  }

  if (edgarOnly) console.log('\nMode: EDGAR-only (lender-source-records and lender-source-web skipped, Perplexity cost = $0)');

  const orchestratorUrl = `${supabaseUrl}/functions/v1/lender-research-orchestrator`;

  const results: Array<Record<string, unknown>> = [];
  let succeeded = 0;
  let failed = 0;
  let totalCost = 0;

  // ── Per-plant processing (runs concurrently inside each batch) ─────────────
  const processPlant = async (plant: PlantCandidate, globalIdx: number): Promise<Record<string, unknown>> => {
    const prefix = `[${globalIdx + 1}/${candidates.length}] ${plant.plant_id} ${plant.plant_name}`;
    console.log(`\n${prefix} -> trigger research`);

    try {
      const response = await fetch(orchestratorUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${internalToken}`,
        },
        body: JSON.stringify({
          plant_id: plant.plant_id,
          budget_usd: budget,
          trigger: triggerMode,
          ...(edgarOnly ? { edgar_only: true } : {}),
        }),
      });

      if (!response.ok) {
        const detail = await response.text();
        console.log(`${prefix} -> trigger failed (${response.status})`);
        return { plant_id: plant.plant_id, plant_name: plant.plant_name, ok: false, error: detail.slice(0, 250) };
      }

      const payload = await response.json() as { session_id?: string };
      const session = await pollSession(sb, plant.plant_id, payload.session_id, pollAttempts, pollSeconds * 1000);

      if (!session) {
        console.log(`${prefix} -> timed out polling session`);
        return { plant_id: plant.plant_id, plant_name: plant.plant_name, ok: false, error: 'Timed out waiting for session completion' };
      }

      const { data: claims, error: claimsErr } = await sb
        .from('lender_research_claims')
        .select('id, dropped_reason')
        .eq('session_id', session.id);
      if (claimsErr) throw new Error(`Claim read failed: ${claimsErr.message}`);

      const claimRows = (claims as Array<{ id: number; dropped_reason: string | null }> | null) ?? [];
      const claimIds = claimRows.map(c => c.id);
      const dropped = claimRows.filter(c => !!c.dropped_reason).length;
      const survived = claimRows.length - dropped;

      let linksCreated = 0;
      if (claimIds.length > 0) {
        const { count, error: linksErr } = await sb
          .from('lender_links')
          .select('id', { count: 'exact', head: true })
          .eq('plant_id', plant.plant_id)
          .in('primary_claim_id', claimIds);
        if (linksErr) throw new Error(`Link count failed: ${linksErr.message}`);
        linksCreated = count ?? 0;
      }

      const status = String(session.status ?? 'unknown');
      const cost = Number(session.cost_usd ?? 0);
      console.log(`${prefix} -> ${status}, cost=$${cost.toFixed(5)}, claims=${claimRows.length}, links=${linksCreated}`);

      return {
        plant_id: plant.plant_id,
        plant_name: plant.plant_name,
        ok: status === 'complete' || status === 'no_lender_identifiable' || status === 'budget_exceeded',
        session_id: session.id,
        status,
        budget_exceeded: Boolean(session.budget_exceeded),
        cost_usd: Number(cost.toFixed(5)),
        claims_total: claimRows.length,
        claims_dropped: dropped,
        claims_survived: survived,
        links_created: linksCreated,
        completed_at: session.completed_at,
        error_detail: session.error_detail,
      };
    } catch (err) {
      console.log(`${prefix} -> failed (${String(err)})`);
      return { plant_id: plant.plant_id, plant_name: plant.plant_name, ok: false, error: String(err) };
    }
  };

  if (concurrency > 1) {
    console.log(`\nRunning with concurrency=${concurrency}`);
  }

  // Process candidates in batches of `concurrency`
  for (let batchStart = 0; batchStart < candidates.length; batchStart += concurrency) {
    const batch = candidates.slice(batchStart, batchStart + concurrency);
    const batchResults = await Promise.all(
      batch.map((plant, bi) => processPlant(plant, batchStart + bi))
    );
    for (const r of batchResults) {
      results.push(r);
      if (r.ok) {
        succeeded++;
        totalCost += Number(r.cost_usd ?? 0);
      } else {
        failed++;
      }
    }
  }

  console.log('\nRun summary:');
  console.table(results);
  console.log(JSON.stringify({
    succeeded,
    failed,
    total: candidates.length,
    total_cost_usd: Number(totalCost.toFixed(5)),
  }, null, 2));

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
