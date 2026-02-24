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

// ─── Capacity-factor helper ──────────────────────────────────────────
const TYPICAL: Record<string, number> = { Solar: 0.22, Wind: 0.35, Nuclear: 0.92 };

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
}

function computeStats(plant: PlantLike) {
  const history = plant.generationHistory;
  const monthlyFactors = history.map(h => {
    if (h.mwh === null) return null;
    const [yr, mo] = h.month.split('-').map(Number);
    const days = new Date(yr, mo, 0).getDate();
    const max = plant.nameplateCapacityMW * days * 24;
    return max > 0 ? Math.min(1, Math.max(0, h.mwh / max)) : 0;
  });
  const ttmData = monthlyFactors.slice(-12).filter((f): f is number => f !== null);
  const ttmAvg = ttmData.length > 0 ? ttmData.reduce((a, b) => a + b, 0) / ttmData.length : 0;
  const typical = TYPICAL[plant.fuelSource] ?? 0.3;
  const score   = Math.round(Math.min(100, Math.max(0, ((typical - ttmAvg) / typical) * 100)));
  return { ttmAvgFactor: ttmAvg, curtailmentScore: score, isLikelyCurtailed: ttmAvg < typical * 0.7 };
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
  const plantRows = plants.map(p => {
    const s = computeStats(p);
    return {
      id:                    p.id,
      eia_plant_code:        p.eiaPlantCode ?? null,
      operator_id:           p.operatorId   ?? null,
      name:                  p.name,
      owner:                 p.owner,
      region:                p.region,
      sub_region:            p.subRegion    ?? '',
      fuel_source:           p.fuelSource,
      nameplate_capacity_mw: p.nameplateCapacityMW,
      cod:                   p.cod          ?? null,
      county:                p.county       ?? null,
      state:                 p.location.state,
      lat:                   p.location.lat,
      lng:                   p.location.lng,
      ttm_avg_factor:        s.ttmAvgFactor,
      curtailment_score:     s.curtailmentScore,
      is_likely_curtailed:   s.isLikelyCurtailed,
      last_updated:          now,
    };
  });

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
