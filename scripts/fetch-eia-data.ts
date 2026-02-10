/**
 * GenTrack EIA Data Ingestion Script
 * 
 * Fetches plant-level generation data from EIA-923 (facility-fuel endpoint)
 * for Solar, Wind, and Nuclear fuel types, then writes the processed data
 * to public/data/plants.json for the frontend to consume as a static asset.
 * 
 * Run: npx tsx scripts/fetch-eia-data.ts
 * Scheduled: GitHub Actions cron on the 15th of each month
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// -------------------------------------------------------------------
// Config
// -------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EIA_API_KEY = process.env.VITE_EIA_API_KEY || '';
const EIA_BASE_URL = 'https://api.eia.gov/v2/';
const OUTPUT_DIR = path.resolve(__dirname, '..', 'public', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'plants.json');
const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes — EIA can be slow
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;

// -------------------------------------------------------------------
// Types (mirrored from ../types.ts for standalone execution)
// -------------------------------------------------------------------
interface MonthlyGeneration {
  month: string;
  mwh: number;
}

interface PowerPlant {
  id: string;
  eiaPlantCode: string;
  name: string;
  owner: string;
  region: string;
  subRegion: string;
  fuelSource: string;
  nameplateCapacityMW: number;
  generationHistory: MonthlyGeneration[];
  location: { state: string; lat: number; lng: number };
}

interface DataManifest {
  fetchedAt: string;
  plantCount: number;
  fuelBreakdown: Record<string, number>;
  plants: PowerPlant[];
}

// -------------------------------------------------------------------
// Region / SubRegion mappings
// -------------------------------------------------------------------
const STATE_TO_REGION: Record<string, string> = {
  CA: 'CAISO', TX: 'ERCOT', NY: 'NYISO',
  ME: 'ISO-NE', NH: 'ISO-NE', VT: 'ISO-NE', MA: 'ISO-NE', CT: 'ISO-NE', RI: 'ISO-NE',
  PA: 'PJM', NJ: 'PJM', MD: 'PJM', DE: 'PJM', VA: 'PJM', WV: 'PJM', OH: 'PJM', DC: 'PJM',
  IL: 'MISO', IN: 'MISO', MI: 'MISO', MN: 'MISO', WI: 'MISO', IA: 'MISO', MO: 'MISO', ND: 'MISO', SD: 'MISO',
  KS: 'SPP', OK: 'SPP', NE: 'SPP', AR: 'SPP',
  WA: 'Northwest', OR: 'Northwest', ID: 'Northwest', MT: 'Northwest', WY: 'Northwest',
  AZ: 'Southwest', NM: 'Southwest', NV: 'Southwest', UT: 'Southwest', CO: 'Southwest',
  FL: 'Southeast', GA: 'Southeast', AL: 'Southeast', MS: 'Southeast', SC: 'Southeast',
  NC: 'Southeast', TN: 'Southeast', KY: 'Southeast', LA: 'Southeast',
};

const SUBREGIONS: Record<string, string[]> = {
  CAISO: ['NP15', 'SP15', 'ZP26'],
  ERCOT: ['West', 'North', 'South', 'Coast'],
  PJM: ['Mid-Atlantic', 'Western', 'Southern'],
  MISO: ['North', 'Central', 'South'],
  NYISO: ['Upstate', 'Hudson Valley', 'NYC/Long Island'],
  'ISO-NE': ['Maine/NH', 'VT/CT/RI', 'Massachusetts'],
  SPP: ['North', 'Central', 'South'],
  Northwest: ['WA/OR Coast', 'Inland PNW', 'Mountain'],
  Southwest: ['Arizona/Nevada', 'New Mexico'],
  Southeast: ['Florida', 'Carolinas', 'Deep South'],
};

function getSubRegion(state: string, region: string): string {
  const subs = SUBREGIONS[region];
  if (!subs || subs.length === 0) return 'Unknown';
  const hash = state.charCodeAt(0) + (state.charCodeAt(1) || 0);
  return subs[hash % subs.length];
}

// -------------------------------------------------------------------
// EIA fetch helpers
// -------------------------------------------------------------------
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, attempts = RETRY_ATTEMPTS): Promise<any> {
  for (let i = 1; i <= attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      console.log(`  [Attempt ${i}/${attempts}] GET ${url.substring(0, 120)}...`);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      if (json.error) throw new Error(`EIA error: ${json.error}`);
      return json;
    } catch (err: any) {
      clearTimeout(timer);
      const isLast = i === attempts;
      const reason = err.name === 'AbortError' ? 'Timeout' : err.message;
      console.warn(`  ⚠ Attempt ${i} failed: ${reason}`);
      if (isLast) throw err;
      console.log(`  Retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function fetchFuelData(fuel2002: string, length = 500): Promise<any[]> {
  const url = new URL(`${EIA_BASE_URL}electricity/facility-fuel/data/`);
  url.searchParams.set('api_key', EIA_API_KEY);
  url.searchParams.set('frequency', 'monthly');
  url.searchParams.set('data[0]', 'generation');
  url.searchParams.set('facets[fuel2002][]', fuel2002);
  url.searchParams.set('sort[0][column]', 'generation');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('length', String(length));

  const json = await fetchWithRetry(url.toString());
  return json?.response?.data || [];
}

// -------------------------------------------------------------------
// Processing
// -------------------------------------------------------------------
function processRecords(records: any[], fuelSource: string): PowerPlant[] {
  // Group by plantCode
  const grouped: Record<string, any[]> = {};
  for (const r of records) {
    const code = r.plantCode;
    if (!code) continue;
    if (!grouped[code]) grouped[code] = [];
    grouped[code].push(r);
  }

  const plants: PowerPlant[] = [];

  for (const [plantCode, recs] of Object.entries(grouped)) {
    const first = recs[0];
    const stateId = first?.state || '';
    const region = STATE_TO_REGION[stateId] || 'Southeast';
    const subRegion = getSubRegion(stateId, region);

    const generationHistory: MonthlyGeneration[] = recs
      .map(r => ({ month: r.period as string, mwh: parseFloat(r.generation || '0') }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const maxGen = Math.max(...recs.map(r => parseFloat(r.generation || '0')));
    const capacityMW = maxGen > 0 ? Math.round(maxGen / 730) : 100;

    if (capacityMW <= 0) continue;

    plants.push({
      id: `EIA-${plantCode}`,
      eiaPlantCode: plantCode,
      name: first?.plantName || `Plant ${plantCode}`,
      owner: first?.operator || 'Unknown',
      region,
      subRegion,
      fuelSource,
      nameplateCapacityMW: capacityMW,
      generationHistory,
      location: { state: stateId, lat: 0, lng: 0 },
    });
  }

  return plants;
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log(' GenTrack — EIA Data Ingestion');
  console.log(`═══════════════════════════════════════════`);
  console.log(`Date:    ${new Date().toISOString()}`);
  console.log(`API Key: ${EIA_API_KEY ? '****' + EIA_API_KEY.slice(-4) : '⚠ MISSING'}`);
  console.log('');

  if (!EIA_API_KEY) {
    console.error('❌ VITE_EIA_API_KEY environment variable is not set.');
    console.error('   Set it in .env or pass via environment.');
    process.exit(1);
  }

  const fuelTypes = [
    { code: 'SUN', name: 'Solar' },
    { code: 'WND', name: 'Wind' },
    { code: 'NUC', name: 'Nuclear' },
  ];

  const allPlants: PowerPlant[] = [];
  const fuelBreakdown: Record<string, number> = {};

  for (const fuel of fuelTypes) {
    console.log(`\n▶ Fetching ${fuel.name} (${fuel.code}) plants...`);
    try {
      const records = await fetchFuelData(fuel.code, 500);
      console.log(`  ✓ Received ${records.length} records`);

      const plants = processRecords(records, fuel.name);
      console.log(`  ✓ Processed ${plants.length} unique plants`);

      allPlants.push(...plants);
      fuelBreakdown[fuel.name] = plants.length;
    } catch (err: any) {
      console.error(`  ✗ Failed to fetch ${fuel.name}: ${err.message}`);
      fuelBreakdown[fuel.name] = 0;
    }
  }

  // Write output
  console.log('\n▶ Writing output...');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const manifest: DataManifest = {
    fetchedAt: new Date().toISOString(),
    plantCount: allPlants.length,
    fuelBreakdown,
    plants: allPlants,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
  const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2);

  console.log(`  ✓ Wrote ${OUTPUT_FILE}`);
  console.log(`  ✓ ${allPlants.length} plants, ${sizeMB} MB`);
  console.log(`  ✓ Breakdown: ${JSON.stringify(fuelBreakdown)}`);
  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
