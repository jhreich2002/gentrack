/**
 * seed-supabase.ts
 * One-shot script: reads the already-generated plants.json and upserts
 * all plants + monthly_generation rows to Supabase.
 * Run:
 *   $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."; npx tsx scripts/seed-supabase.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH  = path.resolve(__dirname, '..', 'public', 'data', 'plants.json');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

interface PlantLike {
  id: string;
  eiaPlantCode?: number;
  operatorId?: string | null;
  name: string;
  owner: string;
  region: string;
  subRegion: string | null;
  fuelSource: string;
  nameplateCapacityMW: number;
  cod?: string | null;
  county?: string | null;
  location: { state: string; lat: number; lng: number };
  generationHistory: Array<{ month: string; mwh: number | null }>;
  // Pre-computed by fetch-eia-data.ts using regional/sub-regional benchmarks
  ttmAvgFactor?: number;
  curtailmentScore?: number;
  isLikelyCurtailed?: boolean;
  isMaintenanceOffline?: boolean;
  trailingZeroMonths?: number;
  dataMonthsCount?: number;
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' Supabase Seed — reading plants.json');
  console.log('═══════════════════════════════════════════════════════');

  if (!fs.existsSync(JSON_PATH)) {
    console.error(`❌ ${JSON_PATH} not found — run fetch-eia-data.ts first`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  const plants: PlantLike[] = raw.plants ?? [];
  console.log(`  → Loaded ${plants.length} plants from JSON`);

  const db  = createClient(SUPABASE_URL, SUPABASE_KEY);
  const now = new Date().toISOString();
  const BATCH = 500;

  // ── Upsert plants ────────────────────────────────────────────────
  console.log('\n▶ Upserting plants...');
  // Use pre-computed stats from fetch-eia-data.ts (regional/sub-regional benchmarks)
  const plantRows = plants.map(p => ({
    id:                    p.id,
    eia_plant_code:        p.eiaPlantCode        ?? null,
    operator_id:           p.operatorId          ?? null,
    name:                  p.name,
    owner:                 p.owner,
    region:                p.region,
    sub_region:            p.subRegion            ?? '',
    fuel_source:           p.fuelSource,
    nameplate_capacity_mw: p.nameplateCapacityMW,
    cod:                   p.cod                  ?? null,
    county:                p.county               ?? null,
    state:                 p.location.state,
    lat:                   p.location.lat,
    lng:                   p.location.lng,
    ttm_avg_factor:        p.ttmAvgFactor          ?? 0,
    curtailment_score:     p.curtailmentScore      ?? 0,
    is_likely_curtailed:   p.isLikelyCurtailed     ?? false,
    is_maintenance_offline: p.isMaintenanceOffline ?? false,
    trailing_zero_months:  p.trailingZeroMonths    ?? 0,
    data_months_count:     p.dataMonthsCount       ?? 0,
    last_updated:          now,
  }));

  for (let i = 0; i < plantRows.length; i += BATCH) {
    const { error } = await db.from('plants').upsert(plantRows.slice(i, i + BATCH), { onConflict: 'id' });
    if (error) throw new Error(`Plants upsert failed at offset ${i}: ${error.message}`);
    console.log(`  ✓ Plants: ${Math.min(i + BATCH, plantRows.length)}/${plantRows.length}`);
  }

  // ── Upsert monthly_generation ────────────────────────────────────
  console.log('\n▶ Upserting monthly_generation...');
  const genRows: { plant_id: string; month: string; mwh: number | null }[] = [];
  for (const p of plants) {
    for (const h of p.generationHistory) {
      genRows.push({ plant_id: p.id, month: h.month, mwh: h.mwh });
    }
  }
  console.log(`  → ${genRows.length} generation rows total`);

  for (let i = 0; i < genRows.length; i += 1000) {
    const { error } = await db.from('monthly_generation').upsert(genRows.slice(i, i + 1000), { onConflict: 'plant_id,month' });
    if (error) throw new Error(`Generation upsert failed at offset ${i}: ${error.message}`);
    if (i % 20000 === 0 || i + 1000 >= genRows.length) {
      console.log(`  ✓ Generation: ${Math.min(i + 1000, genRows.length)}/${genRows.length}`);
    }
  }

  console.log(`\n✅ Done — ${plantRows.length} plants, ${genRows.length} generation rows synced to Supabase`);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message ?? err);
  process.exit(1);
});
