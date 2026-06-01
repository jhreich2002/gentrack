import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

type CohortRow = {
  plant_id: string;
  category?: string;
};

type SnapshotLender = {
  canonical_name: string;
  role: string | null;
  role_summary: string | null;
  source_url: string;
  evidence_quote: string | null;
  sibling_fanout_flagged: boolean;
  inferred_from_sibling_plant_id: string | null;
};

type PlantSnapshot = {
  plant_id: string;
  plant_name: string | null;
  owner: string | null;
  category: string | null;
  invoke_status: string;
  research_id: string | null;
  cost_usd: number;
  lenders: SnapshotLender[];
  error: string | null;
};

const EXPECTED_PROMPT_VERSION = 'sonar-v5.3';

function requireAnyEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Missing required env vars: ${names.join(', ')}`);
}

function readArg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return null;
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
    throw new Error('golden-cohort.json is empty; add cohort rows before running this snapshot.');
  }

  const snapshots: PlantSnapshot[] = [];

  for (const row of rows) {
    const plantId = row.plant_id;
    const plantRes = await supabase
      .from('plants')
      .select('id, name, owner')
      .eq('id', plantId)
      .maybeSingle();

    if (plantRes.error) {
      snapshots.push({
        plant_id: plantId,
        plant_name: null,
        owner: null,
        category: row.category ?? null,
        invoke_status: 'error',
        research_id: null,
        cost_usd: 0,
        lenders: [],
        error: `plant lookup failed: ${plantRes.error.message}`,
      });
      continue;
    }

    const invoke = await supabase.functions.invoke('lender-research-sonar', {
      body: { plant_id: plantId, force: true },
      headers: { Authorization: `Bearer ${internalAuthToken}` },
    });

    if (invoke.error) {
      snapshots.push({
        plant_id: plantId,
        plant_name: (plantRes.data as any)?.name ?? null,
        owner: (plantRes.data as any)?.owner ?? null,
        category: row.category ?? null,
        invoke_status: 'error',
        research_id: null,
        cost_usd: 0,
        lenders: [],
        error: `invoke failed: ${invoke.error.message}`,
      });
      continue;
    }

    const payload = (invoke.data ?? {}) as Record<string, unknown>;
    const researchId = String(payload.research_id ?? '').trim() || null;
    const invokeStatus = String(payload.status ?? 'unknown').trim() || 'unknown';
    const invokeCost = Number(payload.cost_usd ?? 0);

    let lenders: SnapshotLender[] = [];
    if (researchId) {
      const links = await supabase
        .from('plant_lender_links')
        .select('role, role_summary, source_url, evidence_quote, sibling_fanout_flagged, inferred_from_sibling_plant_id, lenders_canonical!inner(canonical_name)')
        .eq('research_id', researchId)
        .eq('plant_id', plantId)
        .order('created_at', { ascending: true });

      if (links.error) {
        snapshots.push({
          plant_id: plantId,
          plant_name: (plantRes.data as any)?.name ?? null,
          owner: (plantRes.data as any)?.owner ?? null,
          category: row.category ?? null,
          invoke_status: invokeStatus,
          research_id: researchId,
          cost_usd: Number.isFinite(invokeCost) ? invokeCost : 0,
          lenders: [],
          error: `links query failed: ${links.error.message}`,
        });
        continue;
      }

      lenders = (links.data ?? []).map((link: any) => {
        const lenderNode = link?.lenders_canonical;
        const lenderName = Array.isArray(lenderNode)
          ? String(lenderNode[0]?.canonical_name ?? '')
          : String(lenderNode?.canonical_name ?? '');

        return {
          canonical_name: lenderName,
          role: link?.role ?? null,
          role_summary: link?.role_summary ?? null,
          source_url: String(link?.source_url ?? ''),
          evidence_quote: link?.evidence_quote ?? null,
          sibling_fanout_flagged: Boolean(link?.sibling_fanout_flagged),
          inferred_from_sibling_plant_id: link?.inferred_from_sibling_plant_id ?? null,
        };
      });
    }

    snapshots.push({
      plant_id: plantId,
      plant_name: (plantRes.data as any)?.name ?? null,
      owner: (plantRes.data as any)?.owner ?? null,
      category: row.category ?? null,
      invoke_status: invokeStatus,
      research_id: researchId,
      cost_usd: Number.isFinite(invokeCost) ? invokeCost : 0,
      lenders,
      error: null,
    });

    console.log(`${plantId}: status=${invokeStatus} lenders=${lenders.length}`);
  }

  const out = {
    generated_at: new Date().toISOString(),
    prompt_version_expected: readArg('prompt-version') ?? EXPECTED_PROMPT_VERSION,
    plants: snapshots,
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const outputPathArg = readArg('out');
  const outPath = outputPathArg && outputPathArg.trim().length > 0
    ? outputPathArg
    : path.join('logs', `cohort-v5.3-snapshot-${stamp}.json`);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');

  const success = snapshots.filter((s) => s.error === null).length;
  const failures = snapshots.length - success;
  console.log(`Wrote ${outPath}; success=${success}; failures=${failures}`);
}

main().catch((err) => {
  console.error('snapshot-lender-pipeline-v5 failed:', err);
  process.exit(1);
});
