import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

function requireAnyEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Missing required env vars: ${names.join(', ')}`);
}

function parseArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const LOGS_DIR = path.join(process.cwd(), 'logs');

async function main() {
  const supabaseUrl = requireAnyEnv(['SUPABASE_URL', 'VITE_SUPABASE_URL']);
  const serviceRole = requireAnyEnv([
    'SUPABASE_SECRET_KEY',
    'VITE_SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'VITE_SUPABASE_SERVICE_ROLE_KEY',
  ]);
  const internalAuthToken = requireAnyEnv(['INTERNAL_AUTH_TOKEN', 'VITE_INTERNAL_AUTH_TOKEN']);

  const cohort = parseArg('cohort', 'curtailed');       // 'curtailed' | 'fleet' | 'zone'
  const concurrency = Number(parseArg('concurrency', '3'));
  const maxCost = Number(parseArg('max-cost', '50'));
  const force = hasFlag('force');
  const dryRun = hasFlag('dry-run');
  // zone cohort args
  const zoneRegion = parseArg('region', '');       // e.g. ERCOT
  const zoneSubRegion = parseArg('sub-region', ''); // e.g. West

  const dateStr = new Date().toISOString().slice(0, 10);
  const logPath = path.join(LOGS_DIR, `fleet-run-${dateStr}.jsonl`);
  const skippedPath = path.join(LOGS_DIR, `fleet-run-${dateStr}-skipped.txt`);

  if (!['curtailed', 'fleet', 'zone'].includes(cohort)) {
    console.error(`Unknown --cohort value "${cohort}". Use "curtailed", "fleet", or "zone".`);
    process.exit(1);
  }

  if (cohort === 'zone' && (!zoneRegion || !zoneSubRegion)) {
    console.error('--cohort zone requires --region <ISO> and --sub-region <zone> (e.g. --region ERCOT --sub-region West).');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  // ── Build plant cohort ────────────────────────────────────────────────────

  let plants: { id: string; eia_plant_code: string; name: string }[] = [];

  if (cohort === 'curtailed') {
    // Original behavior: only likely-curtailed plants with current generation data.
    // Paginate in case count exceeds 1,000.
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const res = await supabase
        .from('plants')
        .select('id, eia_plant_code, name')
        .eq('is_likely_curtailed', true)
        .eq('has_current_generation_data', true)
        .order('nameplate_capacity_mw', { ascending: false })
        .range(from, from + PAGE - 1);
      if (res.error) throw res.error;
      const rows = (res.data ?? []) as typeof plants;
      plants.push(...rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  } else {
    // fleet mode: every plant NOT already successfully researched.
    // Supabase's default page limit is 1,000 rows; paginate both queries to
    // fetch the full table (6,000+ plants, 2,000+ research rows).

    async function fetchAllPlants() {
      const PAGE = 1000;
      const acc: { id: string; eia_plant_code: string; name: string }[] = [];
      let from = 0;
      while (true) {
        const res = await supabase
          .from('plants')
          .select('id, eia_plant_code, name, nameplate_capacity_mw')
          .order('nameplate_capacity_mw', { ascending: false })
          .range(from, from + PAGE - 1);
        if (res.error) throw res.error;
        const rows = (res.data ?? []) as any[];
        acc.push(...rows);
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      return acc;
    }

    async function fetchResearchedIds() {
      const PAGE = 1000;
      const ids = new Set<string>();
      let from = 0;
      while (true) {
        const res = await supabase
          .from('plant_lender_research')
          .select('plant_id')
          .neq('status', 'error')
          .not('completed_at', 'is', null)
          .range(from, from + PAGE - 1);
        if (res.error) throw res.error;
        const rows = (res.data ?? []) as { plant_id: string }[];
        rows.forEach((r) => ids.add(r.plant_id));
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      return ids;
    }

    const [allPlants, researchedIds] = await Promise.all([
      fetchAllPlants(),
      fetchResearchedIds(),
    ]);

    plants = allPlants.filter((p) => !researchedIds.has(p.id));
    console.log(
      `Fleet cohort: ${allPlants.length} total plants, ${researchedIds.size} already researched, ` +
      `${plants.length} to run.`,
    );
  } else {
    // zone mode: Wind + Solar plants in the specified (region, sub_region) lacking validated lenders.
    // Skips plants already successfully researched unless --force is set.
    const PAGE = 1000;
    const acc: { id: string; eia_plant_code: string; name: string }[] = [];
    let from = 0;
    while (true) {
      const res = await supabase
        .from('plants')
        .select('id, eia_plant_code, name, nameplate_capacity_mw')
        .eq('region', zoneRegion)
        .eq('sub_region', zoneSubRegion)
        .in('fuel_source', ['Wind', 'Solar'])
        .order('nameplate_capacity_mw', { ascending: false })
        .range(from, from + PAGE - 1);
      if (res.error) throw res.error;
      const rows = (res.data ?? []) as any[];
      acc.push(...rows);
      if (rows.length < PAGE) break;
      from += PAGE;
    }

    if (!force) {
      // Skip already-researched (non-error) plants
      const resIds = new Set<string>();
      let rFrom = 0;
      while (true) {
        const res = await supabase
          .from('plant_lender_research')
          .select('plant_id')
          .neq('status', 'error')
          .not('completed_at', 'is', null)
          .range(rFrom, rFrom + PAGE - 1);
        if (res.error) break;
        const rows = (res.data ?? []) as { plant_id: string }[];
        rows.forEach(r => resIds.add(r.plant_id));
        if (rows.length < PAGE) break;
        rFrom += PAGE;
      }
      plants = acc.filter(p => !resIds.has(p.id));
    } else {
      plants = acc;
    }

    console.log(
      `Zone cohort: ${acc.length} Wind/Solar plants in ${zoneRegion} / ${zoneSubRegion}, ` +
      `${plants.length} to run (use --force to re-research already-covered plants).`,
    );
  }

  // ── Dry-run cost projection ───────────────────────────────────────────────

  const n = plants.length;
  if (dryRun) {
    const minCost = (n * 0.0028).toFixed(2);
    const expectedCost = (n * 0.01).toFixed(2);
    const maxCostEst = (n * 0.04).toFixed(2);
    console.log(`\nDRY RUN — ${n} plants in cohort (--cohort=${cohort})`);
    console.log(`  Projected cost:  min=$${minCost}  expected=$${expectedCost}  max=$${maxCostEst}`);
    console.log(`  Hard cap:        --max-cost ${maxCost}`);
    console.log(`  Concurrency:     ${concurrency}`);
    console.log(`  JSONL log:       ${logPath}`);
    console.log(`  Skipped list:    ${skippedPath}`);
    console.log(`\nRun without --dry-run to execute.`);
    return;
  }

  if (n === 0) {
    console.log('No plants to process. All plants already researched (or universe is empty).');
    return;
  }

  console.log(`Starting ${cohort} run: ${n} plants, max-cost=$${maxCost}, concurrency=${concurrency}`);
  console.log(`JSONL log → ${logPath}`);

  // ── Ensure logs dir exists ────────────────────────────────────────────────

  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  function appendLog(entry: Record<string, unknown>) {
    logStream.write(JSON.stringify(entry) + '\n');
  }

  // ── Concurrent worker loop ────────────────────────────────────────────────

  let totalCost = 0;
  let cursor = 0;
  const skipped: string[] = [];

  const worker = async () => {
    while (cursor < plants.length) {
      const idx = cursor++;
      const plant = plants[idx];

      if (totalCost >= maxCost) {
        skipped.push(plant.id);
        continue;
      }

      const ts = new Date().toISOString();
      const invoked = await supabase.functions.invoke('lender-research-sonar', {
        body: { plant_id: plant.id, force },
        headers: { Authorization: `Bearer ${internalAuthToken}` },
      });

      if (invoked.error) {
        console.error(`[${idx + 1}/${plants.length}] ${plant.id}: ERROR ${invoked.error.message}`);
        appendLog({
          plantId: plant.id, eiaCode: plant.eia_plant_code, plantName: plant.name,
          status: 'error', cost_usd: 0, lendersInserted: 0, cumulativeCost: totalCost, error: invoked.error.message, ts,
        });
        continue;
      }

      const data = invoked.data as Record<string, unknown> ?? {};
      const cost = Number(data.cost_usd ?? 0);
      totalCost += cost;

      const status = String(data.status ?? 'unknown');
      const lendersInserted = Number(data.lenders_inserted ?? 0);
      const siblingsFannedOut = Number(data.siblings_fanned_out_to ?? 0);

      console.log(
        `[${idx + 1}/${plants.length}] ${plant.id}: status=${status} ` +
        `lenders=${lendersInserted} siblings=${siblingsFannedOut} ` +
        `cost=$${cost.toFixed(4)} cumulative=$${totalCost.toFixed(2)}`,
      );

      appendLog({
        plantId: plant.id, eiaCode: plant.eia_plant_code, plantName: plant.name,
        status, cost_usd: cost, lendersInserted, siblingsFannedOut, cumulativeCost: totalCost, ts,
      });

      if (totalCost >= maxCost) {
        console.warn(`Reached max-cost budget ($${maxCost.toFixed(2)}). Remaining plants will be skipped.`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  logStream.end();

  // ── Write skipped list ────────────────────────────────────────────────────

  if (skipped.length > 0) {
    fs.writeFileSync(skippedPath, skipped.join('\n') + '\n', 'utf8');
    console.warn(`\n${skipped.length} plants not attempted (budget cap). IDs written to:\n  ${skippedPath}`);
    console.warn(`Re-run with --cohort fleet to pick up the remainder once credits are topped up.`);
  }

  console.log(`\nDone. cohort=${cohort} attempted=${n - skipped.length} skipped=${skipped.length} totalCost=$${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error('run-lender-pipeline-v5 failed:', err);
  process.exit(1);
});
