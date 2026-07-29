/**
 * scripts/fix-subregions.ts
 *
 * Audit + optional backfill of the `plants.sub_region` column in Supabase.
 *
 * Rationale:
 *   The old getSubRegion() helper in fetch-eia-data.ts used a flat
 *   STATE_TO_SUBREGION record and applied CA/TX/NY cutlines by state (not
 *   region). That could produce (region, sub_region) pairs that are not valid
 *   for the ISO — e.g., an SPP plant sitting in TX would get 'West'
 *   (an ERCOT sub-region) instead of an SPP sub-region.
 *
 *   This script recomputes each plant's expected sub_region using the
 *   region-aware `resolveSubRegion` in constants/subregionGeometry.ts, prints
 *   a diff, and (with --apply) updates the mismatched rows via supabase-js.
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."; npx tsx scripts/fix-subregions.ts
 *   $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."; npx tsx scripts/fix-subregions.ts --apply
 *
 * Read-only by default. Pass --apply to write changes.
 */

import { createClient } from '@supabase/supabase-js';
import { resolveSubRegion, isValidSubRegionPair, SUBREGION_LABELS } from '../constants/subregionGeometry';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

interface PlantRow {
  id: string;
  state: string | null;
  region: string;
  sub_region: string | null;
  lat: number | null;
  lng: number | null;
}

async function fetchAllPlants(): Promise<PlantRow[]> {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY);
  const PAGE = 1000;
  const all: PlantRow[] = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE - 1;
    const { data, error } = await client
      .from('plants')
      .select('id, state, region, sub_region, lat, lng')
      .range(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as PlantRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function applyUpdate(updates: Array<{ id: string; sub_region: string }>): Promise<void> {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY);
  const BATCH = 500;
  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH);
    // supabase-js has no bulk conditional update; issue per-row updates.
    // 500 rows × ~50ms → ~25s; acceptable for a one-shot backfill.
    for (const u of chunk) {
      const { error } = await client.from('plants').update({ sub_region: u.sub_region }).eq('id', u.id);
      if (error) {
        console.error(`  ⚠ Failed to update ${u.id}:`, error.message);
      }
    }
    console.log(`  … applied ${Math.min(i + BATCH, updates.length)}/${updates.length}`);
  }
}

function bucketize<T>(rows: T[], keyFn: (r: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = keyFn(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' Sub-region audit / backfill');
  console.log(` Mode: ${APPLY ? 'APPLY (writes to Supabase)' : 'DRY RUN (read-only)'}`);
  console.log('═══════════════════════════════════════════════════════');

  const plants = await fetchAllPlants();
  console.log(`Loaded ${plants.length} plants.`);

  // ─── Before: pair distribution + invalid pair list ────────────────────
  const beforeDist = bucketize(plants, (p) => `${p.region} / ${p.sub_region ?? '(null)'}`);
  const invalidBefore = plants.filter(
    (p) => p.sub_region == null || !isValidSubRegionPair(p.region, p.sub_region),
  );
  console.log('\n[Before] (region / sub_region) distribution:');
  for (const [k, v] of [...beforeDist.entries()].sort()) console.log(`  ${k.padEnd(40)} ${v}`);
  console.log(`\n[Before] Invalid (region, sub_region) pairs: ${invalidBefore.length}`);

  // ─── Compute proposed changes ─────────────────────────────────────────
  const changes: Array<{ id: string; region: string; oldSub: string | null; newSub: string }> = [];
  for (const p of plants) {
    const expected = resolveSubRegion(
      p.state ?? '',
      p.region,
      p.lat ?? undefined,
      p.lng ?? undefined,
    );
    if (expected !== p.sub_region) {
      changes.push({ id: p.id, region: p.region, oldSub: p.sub_region, newSub: expected });
    }
  }

  console.log(`\nProposed changes: ${changes.length}`);
  const byPair = bucketize(changes, (c) => `${c.region}: '${c.oldSub ?? '(null)'}' → '${c.newSub}'`);
  for (const [k, v] of [...byPair.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`  ${k.padEnd(60)} ${v}`);
  }

  // Sanity: every proposed newSub must be valid for its region.
  const badProposals = changes.filter((c) => !isValidSubRegionPair(c.region, c.newSub));
  if (badProposals.length > 0) {
    console.error(`\n❌ ${badProposals.length} proposed sub-regions are NOT in SUBREGION_LABELS. Aborting.`);
    for (const b of badProposals.slice(0, 10)) console.error('  ', b);
    process.exit(1);
  }

  if (changes.length === 0) {
    console.log('\n✓ No mismatches found. Sub-regions are already consistent.');
    return;
  }

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to write changes.');
    return;
  }

  console.log('\nApplying updates…');
  await applyUpdate(changes.map((c) => ({ id: c.id, sub_region: c.newSub })));

  // ─── After: re-fetch and re-audit ─────────────────────────────────────
  const afterPlants = await fetchAllPlants();
  const invalidAfter = afterPlants.filter(
    (p) => p.sub_region == null || !isValidSubRegionPair(p.region, p.sub_region),
  );
  console.log(`\n[After] Invalid (region, sub_region) pairs: ${invalidAfter.length}`);
  if (invalidAfter.length > 0) {
    console.warn('  Remaining invalid pairs — investigate:');
    for (const p of invalidAfter.slice(0, 20)) {
      console.warn(`    ${p.id}  ${p.region} / ${p.sub_region}  state=${p.state}`);
    }
  }
  console.log('\n✓ Backfill complete.');
}

// Sanity-check labels once at startup so we fail fast on config drift.
for (const [region, labels] of Object.entries(SUBREGION_LABELS)) {
  if (!Array.isArray(labels) || labels.length === 0) {
    console.error(`❌ SUBREGION_LABELS['${region}'] is empty; aborting.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
