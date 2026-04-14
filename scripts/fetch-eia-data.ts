/**
 * GenTrack EIA Data Ingestion Script
 * 
 * Dual-source ingestion:
 *   EIA-923 (facility-fuel)         → Monthly net generation history
 *   EIA-860 (operating-generator-capacity) → Nameplate capacity, COD, county, lat/lng, owner
 * 
 * Fetches Wind, Solar, and Nuclear plants for the trailing 2 years.
 * Merges EIA-860 characteristics into each plant record so the frontend
 * has accurate capacity values (instead of estimates from peak MWh).
 * 
 * Writes processed data to public/data/plants.json for the frontend.
 * 
 * Run: npx tsx scripts/fetch-eia-data.ts
 * Triggered manually via GitHub Actions workflow_dispatch.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

// -------------------------------------------------------------------
// Config
// -------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EIA_API_KEY = process.env.VITE_EIA_API_KEY || '';
const EIA_BASE_URL = 'https://api.eia.gov/v2/';
const OUTPUT_DIR = path.resolve(__dirname, '..', 'public', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'plants.json');
const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;
const PAGE_SIZE = 5000; // EIA max per request
const RATE_LIMIT_DELAY_MS = 1_500; // delay between paginated requests

// Supabase credentials (set in .env / GitHub Actions secrets)
const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL  || '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Dynamic data window configuration
const EIA923_TRAILING_MONTHS = 24;
const FALLBACK_EIA923_END_MONTH = '2025-12';
const FALLBACK_EIA860_SURVEY_MONTH = '2024-12';
const MIN_EXPECTED_EIA923_MONTH = '2025-12';

// -------------------------------------------------------------------
// Types (mirrored from ../types.ts for standalone execution)
// -------------------------------------------------------------------
interface MonthlyGeneration {
  month: string;
  mwh: number | null; // null = EIA did not report generation for this month
}

interface PlantOwner {
  name: string;
  percent: number;
}

interface PowerPlant {
  id: string;
  eiaPlantCode: string;
  operatorId?: string;
  name: string;
  owner: string;
  owners?: PlantOwner[];
  region: string;
  subRegion: string;
  fuelSource: string;
  nameplateCapacityMW: number;
  cod?: string;       // Commercial Operation Date (YYYY-MM) from EIA-860
  county?: string;    // County from EIA-860
  generationHistory: MonthlyGeneration[];
  location: { state: string; county?: string; lat: number; lng: number };
  // Pre-computed stats (populated after regional averages are built)
  ttmAvgFactor?: number;
  curtailmentScore?: number;
  isLikelyCurtailed?: boolean;
  isMaintenanceOffline?: boolean;
  trailingZeroMonths?: number;
  dataMonthsCount?: number;
}

interface DataManifest {
  fetchedAt: string;
  plantCount: number;
  fuelBreakdown: Record<string, number>;
  plants: PowerPlant[];
}

// -------------------------------------------------------------------
// EIA fuel code → display name mapping (Wind, Solar, Nuclear only)
// -------------------------------------------------------------------
const FUEL_TYPES: { code: string; name: string; eia860Code: string }[] = [
  { code: 'SUN', name: 'Solar',   eia860Code: 'SUN' },
  { code: 'WND', name: 'Wind',    eia860Code: 'WND' },
  { code: 'NUC', name: 'Nuclear', eia860Code: 'NUC' },
];

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
  HI: 'Hawaii', AK: 'Alaska',
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
  Southwest: ['Arizona/Nevada', 'New Mexico', 'Colorado'],
  Southeast: ['Florida', 'Carolinas', 'Deep South'],
  Hawaii: ['Oahu', 'Maui', 'Big Island'],
  Alaska: ['Railbelt', 'Remote'],
};

// State-to-sub-region mapping for multi-state ISOs.
// Single-state ISOs (CA/CAISO, TX/ERCOT, NY/NYISO) use lat/lng in getSubRegion.
const STATE_TO_SUBREGION: Record<string, string> = {
  // PJM
  PA: 'Mid-Atlantic', NJ: 'Mid-Atlantic', MD: 'Mid-Atlantic', DE: 'Mid-Atlantic', DC: 'Mid-Atlantic',
  OH: 'Western', WV: 'Western',
  VA: 'Southern',
  // MISO
  MN: 'North', WI: 'North', ND: 'North', SD: 'North', MI: 'North',
  IL: 'Central', IN: 'Central', IA: 'Central',
  MO: 'South',
  // SPP
  KS: 'North', NE: 'North',
  OK: 'Central',
  AR: 'South',
  // ISO-NE
  ME: 'Maine/NH', NH: 'Maine/NH',
  VT: 'VT/CT/RI', CT: 'VT/CT/RI', RI: 'VT/CT/RI',
  MA: 'Massachusetts',
  // Northwest
  WA: 'WA/OR Coast', OR: 'WA/OR Coast',
  ID: 'Inland PNW',
  MT: 'Mountain', WY: 'Mountain',
  // Southwest
  AZ: 'Arizona/Nevada', NV: 'Arizona/Nevada',
  NM: 'New Mexico',
  CO: 'Colorado', UT: 'Colorado',
  // Southeast
  FL: 'Florida',
  SC: 'Carolinas', NC: 'Carolinas',
  GA: 'Deep South', AL: 'Deep South', MS: 'Deep South',
  TN: 'Deep South', KY: 'Deep South', LA: 'Deep South',
  // Single-island defaults for Hawaii and Alaska
  HI: 'Oahu',
  AK: 'Railbelt',
};

function getSubRegion(state: string, region: string, lat?: number, lng?: number): string {
  // Coordinate-based assignment for single-state ISOs
  if (state === 'CA' && lat != null) {
    if (lat > 36.0) return 'NP15';
    if (lat > 34.5) return 'ZP26';
    return 'SP15';
  }
  if (state === 'TX' && lat != null && lng != null) {
    if (lng < -100) return 'West';
    if (lat > 32.5) return 'North';
    if (lat < 29.5) return 'Coast';
    return 'South';
  }
  if (state === 'NY' && lat != null) {
    if (lat > 42.5) return 'Upstate';
    if (lat > 41.0) return 'Hudson Valley';
    return 'NYC/Long Island';
  }
  // State-based lookup for all other ISOs
  return STATE_TO_SUBREGION[state] ?? (SUBREGIONS[region]?.[0] ?? 'Unknown');
}

function isMonthString(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

function monthMinus(month: string, count: number): string {
  const [yearStr, monthStr] = month.split('-');
  const year = parseInt(yearStr, 10);
  const monthNum = parseInt(monthStr, 10);
  const date = new Date(Date.UTC(year, monthNum - 1, 1));
  date.setUTCMonth(date.getUTCMonth() - count);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
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
      console.log(`  [Attempt ${i}/${attempts}] GET ${url.substring(0, 140)}...`);
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

async function fetchLatestEIA923MonthForFuel(fuel2002: string): Promise<string | null> {
  const url = new URL(`${EIA_BASE_URL}electricity/facility-fuel/data/`);
  url.searchParams.set('api_key', EIA_API_KEY);
  url.searchParams.set('frequency', 'monthly');
  url.searchParams.set('data[0]', 'generation');
  url.searchParams.set('facets[fuel2002][]', fuel2002);
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('length', '1');
  url.searchParams.set('offset', '0');

  const json = await fetchWithRetry(url.toString());
  const latest = json?.response?.data?.[0]?.period;
  if (!latest || !isMonthString(String(latest))) return null;
  return String(latest);
}

async function fetchLatestEIA860Month(fuelCodes: string[]): Promise<string | null> {
  let latest: string | null = null;

  for (const code of fuelCodes) {
    const url = new URL(`${EIA_BASE_URL}electricity/operating-generator-capacity/data/`);
    url.searchParams.set('api_key', EIA_API_KEY);
    url.searchParams.set('frequency', 'monthly');
    url.searchParams.append('data[]', 'nameplate-capacity-mw');
    url.searchParams.append('facets[status][]', 'OP');
    url.searchParams.append('facets[energy_source_code][]', code);
    url.searchParams.set('sort[0][column]', 'period');
    url.searchParams.set('sort[0][direction]', 'desc');
    url.searchParams.set('length', '1');
    url.searchParams.set('offset', '0');

    const json = await fetchWithRetry(url.toString());
    const period = json?.response?.data?.[0]?.period;
    if (!period || !isMonthString(String(period))) continue;
    const month = String(period);
    if (!latest || month > latest) latest = month;
  }

  return latest;
}

/**
 * Fetch ALL records for a fuel type using offset-based pagination.
 * EIA API limits each request to 5000 records, so we page through.
 */
async function fetchAllFuelData(fuel2002: string, startMonth: string, endMonth: string): Promise<any[]> {
  const allRecords: any[] = [];
  let offset = 0;
  let totalRecords = Infinity;

  while (offset < totalRecords) {
    const url = new URL(`${EIA_BASE_URL}electricity/facility-fuel/data/`);
    url.searchParams.set('api_key', EIA_API_KEY);
    url.searchParams.set('frequency', 'monthly');
    url.searchParams.set('data[0]', 'generation');
    url.searchParams.set('facets[fuel2002][]', fuel2002);
    url.searchParams.set('sort[0][column]', 'plantCode');
    url.searchParams.set('sort[0][direction]', 'asc');
    url.searchParams.set('length', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    // Use dynamic EIA-923 window based on latest available published month.
    url.searchParams.set('start', startMonth);
    url.searchParams.set('end',   endMonth);

    const json = await fetchWithRetry(url.toString());
    const data = json?.response?.data || [];
    totalRecords = json?.response?.total || 0;

    allRecords.push(...data);
    console.log(`    Page ${Math.floor(offset / PAGE_SIZE) + 1}: ${data.length} records (${allRecords.length}/${totalRecords} total)`);

    offset += PAGE_SIZE;

    // Rate-limit between pages
    if (offset < totalRecords) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  console.log(`  ✓ Total records fetched from API: ${allRecords.length}`);
  return allRecords;
}

// -------------------------------------------------------------------
// EIA-860 plant characteristics
// -------------------------------------------------------------------
interface PlantCharacteristics {
  nameplateCapacityMW: number; // Sum of all generators at plant
  cod: string | undefined;     // Earliest operating-year/month across generators (YYYY-MM)
  county: string | undefined;
  lat: number;
  lng: number;
  owner: string | undefined;   // entity-name from EIA-860
  operatorId: string | undefined; // entityid from EIA-860
}

/**
 * Fetch EIA-860 operating generator capacity for Wind, Solar, and Nuclear.
 * Returns a Map keyed by plantCode, aggregated to plant level.
 */
async function fetchEIA860Characteristics(
  fuelCodes: string[],
  surveyMonth: string
): Promise<Map<string, PlantCharacteristics>> {
  const allRecords: any[] = [];
  let offset = 0;
  let totalRecords = Infinity;

  while (offset < totalRecords) {
    const url = new URL(`${EIA_BASE_URL}electricity/operating-generator-capacity/data/`);
    // Core params
    url.searchParams.set('api_key', EIA_API_KEY);
    url.searchParams.set('frequency', 'monthly');
    // Data fields — use append with [] notation (same pattern EIA API expects)
    url.searchParams.append('data[]', 'nameplate-capacity-mw');
    url.searchParams.append('data[]', 'net-summer-capacity-mw');
    url.searchParams.append('data[]', 'operating-year-month');
    url.searchParams.append('data[]', 'county');
    url.searchParams.append('data[]', 'latitude');
    url.searchParams.append('data[]', 'longitude');
    // entityid is a dimension field returned automatically — do not add to data[]
    // Facets — use append with [] notation for multi-value arrays
    url.searchParams.append('facets[status][]', 'OP');
    fuelCodes.forEach(code => {
      url.searchParams.append('facets[energy_source_code][]', code);
    });
    // Pin to latest published EIA-860 monthly survey snapshot.
    url.searchParams.set('start', surveyMonth);
    url.searchParams.set('end',   surveyMonth);
    url.searchParams.set('sort[0][column]', 'plantid');
    url.searchParams.set('sort[0][direction]', 'asc');
    url.searchParams.set('length', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));

    const json = await fetchWithRetry(url.toString());
    const data = json?.response?.data || [];
    totalRecords = json?.response?.total || 0;
    allRecords.push(...data);
    console.log(`    EIA-860 page ${Math.floor(offset / PAGE_SIZE) + 1}: ${data.length} records (${allRecords.length}/${totalRecords} total)`);
    offset += PAGE_SIZE;
    if (offset < totalRecords) await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log(`  ✓ EIA-860 total records fetched: ${allRecords.length}`);

  // Step A: deduplicate by (plantid, generatorid) — keep most recent period only
  // (We fetch 3 months so each generator appears up to 3 times; we only want it once)
  const latestByGenerator = new Map<string, any>();
  for (const r of allRecords) {
    const key = `${r.plantid}_${r.generatorid}`;
    const existing = latestByGenerator.get(key);
    if (!existing || (r.period || '') > (existing.period || '')) {
      latestByGenerator.set(key, r);
    }
  }
  console.log(`  ✓ EIA-860 unique generators after dedup: ${latestByGenerator.size}`);

  // Step B: aggregate unique generators to plant level
  const plantMap = new Map<string, PlantCharacteristics>();

  for (const r of latestByGenerator.values()) {
    const code = String(r.plantid || '');
    if (!code) continue;

    const cap = parseFloat(r['nameplate-capacity-mw'] || '0');
    const cod = r['operating-year-month'] ? String(r['operating-year-month']) : undefined;
    const county = r.county || undefined;
    const lat = parseFloat(r.latitude || '0');
    const lng = parseFloat(r.longitude || '0');
    const owner = r.entityName || r['entity-name'] || undefined;
    const operatorId = r.entityid ? String(r.entityid) : undefined;

    const existing = plantMap.get(code);
    if (!existing) {
      plantMap.set(code, { nameplateCapacityMW: cap, cod, county, lat, lng, owner, operatorId });
    } else {
      // Sum generator capacities; keep earliest COD; keep first non-empty county/owner
      existing.nameplateCapacityMW += cap;
      if (cod && (!existing.cod || cod < existing.cod)) existing.cod = cod;
      if (!existing.county && county) existing.county = county;
      if (!existing.lat && lat) { existing.lat = lat; existing.lng = lng; }
      if (!existing.owner && owner) existing.owner = owner;
      if (!existing.operatorId && operatorId) existing.operatorId = operatorId;
    }
  }

  console.log(`  ✓ EIA-860 aggregated to ${plantMap.size} unique plants`);
  return plantMap;
}

// -------------------------------------------------------------------
// Processing
// -------------------------------------------------------------------
function processRecords(records: any[], fuelSource: string): PowerPlant[] {
  // The facility-fuel endpoint returns both "ALL" (aggregate) and individual prime-mover
  // rows for the same plant/month. Keep only "ALL" to avoid double-counting.
  const filtered = records.filter(r => !r.primeMover || r.primeMover === 'ALL');

  // Group by plantCode
  const grouped: Record<string, any[]> = {};
  for (const r of filtered) {
    const code = r.plantCode;
    if (!code) continue;
    if (!grouped[code]) grouped[code] = [];
    grouped[code].push(r);
  }

  console.log(`  ✓ Grouped into ${Object.keys(grouped).length} unique plant codes`);

  const plants: PowerPlant[] = [];
  let filteredCount = 0;

  for (const [plantCode, recs] of Object.entries(grouped)) {
    const first = recs[0];
    const stateId = first?.state || '';
    const region = STATE_TO_REGION[stateId] || 'Southeast';
    const subRegion = getSubRegion(stateId, region);

    // Aggregate generation by month.
    // null = EIA sent a row but no valid generation value (unreported/withheld).
    const monthlyMap: Record<string, number | null> = {};
    for (const r of recs) {
      const month = r.period as string;
      const genStr = r.generation;
      if (genStr === null || genStr === undefined || genStr === '' || genStr === 'null') {
        // Only mark null if we haven't already accumulated a real value for this month
        if (!(month in monthlyMap)) monthlyMap[month] = null;
      } else {
        const gen = parseFloat(genStr);
        if (!isNaN(gen)) {
          monthlyMap[month] = (monthlyMap[month] ?? 0) + gen;
        } else if (!(month in monthlyMap)) {
          monthlyMap[month] = null;
        }
      }
    }

    const generationHistory: MonthlyGeneration[] = Object.entries(monthlyMap)
      .map(([month, mwh]) => ({ month, mwh }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Estimate capacity from peak generation month (MWh / hours-in-month)
    const maxGen = Math.max(...generationHistory.map(h => h.mwh ?? 0), 0);
    const capacityMW = maxGen > 0 ? Math.round(maxGen / 730) : 0;

    // Skip plants with very low capacity (keep plants >0.5 MW)
    if (capacityMW < 0.5) {
      filteredCount++;
      continue;
    }

    plants.push({
      id: `EIA-${plantCode}`,
      eiaPlantCode: plantCode,
      operatorId: first?.operatorId ? String(first.operatorId) : undefined,
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

  if (filteredCount > 0) {
    console.log(`  ℹ Filtered out ${filteredCount} plants with capacity <0.5 MW`);
  }

  return plants;
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' GenTrack — EIA-923 + EIA-860 Data Ingestion');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Date:    ${new Date().toISOString()}`);
  console.log(`API Key: ${EIA_API_KEY ? '****' + EIA_API_KEY.slice(-4) : '⚠ MISSING'}`);
  console.log(`Fuels:   ${FUEL_TYPES.map(f => f.name).join(', ')}`);
  console.log(`Window:  Detecting latest published EIA periods...`);
  console.log('');

  if (!EIA_API_KEY) {
    console.error('❌ VITE_EIA_API_KEY environment variable is not set.');
    console.error('   Set it in .env or pass via environment.');
    process.exit(1);
  }

  const latest923ByFuel = new Map<string, string | null>();
  for (const fuel of FUEL_TYPES) {
    try {
      const latest = await fetchLatestEIA923MonthForFuel(fuel.code);
      latest923ByFuel.set(fuel.code, latest);
      console.log(`  ✓ Latest EIA-923 month for ${fuel.name}: ${latest ?? 'unavailable'}`);
    } catch (err: any) {
      console.warn(`  ⚠ Could not detect latest EIA-923 month for ${fuel.name}: ${err.message}`);
      latest923ByFuel.set(fuel.code, null);
    }
  }

  let latestEia923Month = FALLBACK_EIA923_END_MONTH;
  for (const month of latest923ByFuel.values()) {
    if (month && month > latestEia923Month) latestEia923Month = month;
  }

  if (latestEia923Month < MIN_EXPECTED_EIA923_MONTH) {
    throw new Error(
      `Latest EIA-923 month (${latestEia923Month}) is older than expected minimum (${MIN_EXPECTED_EIA923_MONTH}).`
    );
  }

  const eia923StartMonth = monthMinus(latestEia923Month, EIA923_TRAILING_MONTHS - 1);

  let eia860SurveyMonth = FALLBACK_EIA860_SURVEY_MONTH;
  try {
    const detected860 = await fetchLatestEIA860Month(FUEL_TYPES.map(f => f.eia860Code));
    if (detected860) eia860SurveyMonth = detected860;
  } catch (err: any) {
    console.warn(`  ⚠ Could not detect latest EIA-860 survey month: ${err.message}`);
  }

  console.log(`  ✓ EIA-923 fetch window: ${eia923StartMonth} → ${latestEia923Month}`);
  console.log(`  ✓ EIA-860 survey month: ${eia860SurveyMonth}`);

  const allPlants: PowerPlant[] = [];
  const fuelBreakdown: Record<string, number> = {};
  const startTime = Date.now();

  // ─── Step 1: EIA-923 — Monthly generation history ───────────────
  console.log('\n── Step 1 of 3: EIA-923 Monthly Generation ──────────────');
  for (const fuel of FUEL_TYPES) {
    console.log(`\n▶ Fetching ${fuel.name} (${fuel.code}) — all pages...`);
    const fuelStart = Date.now();
    try {
      const records = await fetchAllFuelData(fuel.code, eia923StartMonth, latestEia923Month);
      console.log(`  ✓ Received ${records.length} total records in ${((Date.now() - fuelStart) / 1000).toFixed(1)}s`);

      const plants = processRecords(records, fuel.name);
      console.log(`  ✓ Processed ${plants.length} unique plants`);

      allPlants.push(...plants);
      fuelBreakdown[fuel.name] = plants.length;
    } catch (err: any) {
      console.error(`  ✗ Failed to fetch ${fuel.name}: ${err.message}`);
      fuelBreakdown[fuel.name] = 0;
    }

    await sleep(2000);
  }

  // ─── Step 2: Deduplicate EIA-923 plants ─────────────────────────
  console.log('\n── Step 2 of 3: Deduplication ───────────────────────────');
  const deduped = new Map<string, PowerPlant>();
  for (const plant of allPlants) {
    const existing = deduped.get(plant.eiaPlantCode);
    if (!existing || plant.nameplateCapacityMW > existing.nameplateCapacityMW) {
      deduped.set(plant.eiaPlantCode, plant);
    }
  }
  const dedupedPlants = Array.from(deduped.values());
  console.log(`  ✓ ${dedupedPlants.length} unique plants after dedup (was ${allPlants.length})`);

  // ─── Step 3: EIA-860 — Enrich with plant characteristics ────────
  console.log('\n── Step 3 of 3: EIA-860 Plant Characteristics ───────────');
  let eia860Hits = 0;
  let eia860Misses = 0;

  try {
    const eia860Codes = FUEL_TYPES.map(f => f.eia860Code);
    const characteristics = await fetchEIA860Characteristics(eia860Codes, eia860SurveyMonth);

    for (const plant of dedupedPlants) {
      const ch = characteristics.get(plant.eiaPlantCode);
      if (ch) {
        // Replace estimated capacity with actual EIA-860 nameplate
        plant.nameplateCapacityMW = Math.round(ch.nameplateCapacityMW * 10) / 10;
        // Add EIA-860 fields
        if (ch.cod) plant.cod = ch.cod;
        if (ch.county) plant.county = ch.county;
        if (ch.owner) plant.owner = ch.owner;
        if (ch.operatorId) plant.operatorId = ch.operatorId;
        if (ch.lat) { plant.location.lat = ch.lat; plant.location.lng = ch.lng; }
        if (ch.county) plant.location.county = ch.county;
        eia860Hits++;
      } else {
        console.warn(`  ⚠ No EIA-860 match for plant ${plant.eiaPlantCode} (${plant.name}) — keeping estimated capacity`);
        eia860Misses++;
      }
    }
    console.log(`  ✓ EIA-860 enrichment: ${eia860Hits} matched, ${eia860Misses} unmatched (estimated capacity retained)`);
  } catch (err: any) {
    console.error(`  ✗ EIA-860 fetch failed: ${err.message}`);
    console.warn('  ⚠ Proceeding with estimated capacities from EIA-923 only');
  }

  // Re-assign subRegion now that lat/lng are populated from EIA-860.
  // The initial assignment in processRecords lacked coordinates; this corrects
  // single-state ISO zones (CAISO NP15/SP15/ZP26, ERCOT West/North/South/Coast,
  // NYISO Upstate/Hudson Valley/NYC) using actual plant coordinates.
  for (const plant of dedupedPlants) {
    plant.subRegion = getSubRegion(
      plant.location.state,
      plant.region,
      plant.location.lat || undefined,
      plant.location.lng || undefined,
    );
  }

  // NOTE: EIA API v2 does not expose EIA-860 Schedule 2 ownership percentage
  // data via any endpoint. The owners[] field is reserved for a future
  // integration (e.g. bulk Excel download parser). Owner name is sourced
  // from EIA-860 entityName above.

  // Filter out any plants that ended up with 0 capacity after enrichment
  const finalPlants = dedupedPlants.filter(p => p.nameplateCapacityMW >= 0.5);

  // ─── Compute pre-aggregated stats for each plant ─────────────────
  const TYPICAL: Record<string, number> = { Solar: 0.22, Wind: 0.35, Nuclear: 0.92 };

  // First pass: build regional and sub-regional monthly average CF from all plants
  // (only active months, CF > 2%).
  // regionMaps key:    "region-fuelSource"              → Map<"YYYY-MM", avgCF>
  // subRegionMaps key: "region|subRegion|fuelSource"    → Map<"YYYY-MM", avgCF>
  // subRegionPlantCount: same sub-region key            → number of distinct plants
  function buildRegionalAvgMaps(plants: PowerPlant[]): {
    regionMaps: Map<string, Map<string, number>>;
    subRegionMaps: Map<string, Map<string, number>>;
    subRegionPlantCount: Map<string, number>;
  } {
    const regionAccum    = new Map<string, Map<string, { sum: number; count: number }>>();
    const subRegionAccum = new Map<string, Map<string, { sum: number; count: number }>>();
    const subRegionPlants = new Map<string, Set<string>>();

    for (const plant of plants) {
      const regionKey    = `${plant.region}-${plant.fuelSource}`;
      const subRegionKey = `${plant.region}|${plant.subRegion}|${plant.fuelSource}`;

      if (!regionAccum.has(regionKey))    regionAccum.set(regionKey, new Map());
      if (!subRegionAccum.has(subRegionKey)) subRegionAccum.set(subRegionKey, new Map());
      if (!subRegionPlants.has(subRegionKey)) subRegionPlants.set(subRegionKey, new Set());
      subRegionPlants.get(subRegionKey)!.add(plant.eiaPlantCode);

      const regionMonthMap    = regionAccum.get(regionKey)!;
      const subRegionMonthMap = subRegionAccum.get(subRegionKey)!;

      for (const h of plant.generationHistory) {
        if (h.mwh === null || h.mwh === 0) continue;
        const [yr, mo] = h.month.split('-').map(Number);
        const days = new Date(yr, mo, 0).getDate();
        const max = plant.nameplateCapacityMW * days * 24;
        if (max <= 0) continue;
        const cf = Math.min(1, Math.max(0, h.mwh / max));
        if (cf < 0.02) continue;

        const prevR = regionMonthMap.get(h.month) ?? { sum: 0, count: 0 };
        regionMonthMap.set(h.month, { sum: prevR.sum + cf, count: prevR.count + 1 });

        const prevS = subRegionMonthMap.get(h.month) ?? { sum: 0, count: 0 };
        subRegionMonthMap.set(h.month, { sum: prevS.sum + cf, count: prevS.count + 1 });
      }
    }

    function toAvgMap(accum: Map<string, Map<string, { sum: number; count: number }>>) {
      const result = new Map<string, Map<string, number>>();
      for (const [key, monthMap] of accum) {
        const avgMap = new Map<string, number>();
        for (const [month, { sum, count }] of monthMap) avgMap.set(month, sum / count);
        result.set(key, avgMap);
      }
      return result;
    }

    const subRegionPlantCount = new Map<string, number>();
    for (const [key, plantSet] of subRegionPlants) subRegionPlantCount.set(key, plantSet.size);

    return {
      regionMaps:       toAvgMap(regionAccum),
      subRegionMaps:    toAvgMap(subRegionAccum),
      subRegionPlantCount,
    };
  }

  // Second pass: score each plant against its regional peers.
  // Prefers sub-region benchmark when ≥ 3 distinct plants contribute and months overlap;
  // falls back to ISO/RTO-level average otherwise.
  function computeStats(
    plant: PowerPlant,
    regionalAvgByMonth?: Map<string, number>,
    subRegionalAvgByMonth?: Map<string, number>,
    subRegionPlantCount?: number,
  ) {
    const history = plant.generationHistory;
    const monthlyFactors = history.map(h => {
      if (h.mwh === null) return null;
      const [yr, mo] = h.month.split('-').map(Number);
      const days = new Date(yr, mo, 0).getDate();
      const max = plant.nameplateCapacityMW * days * 24;
      return max > 0 ? Math.min(1, Math.max(0, h.mwh / max)) : 0;
    });
    const ttmRaw = history.slice(-12);
    const ttmFactors = monthlyFactors.slice(-12);
    const ttmData = ttmFactors.filter((f): f is number => f !== null);
    const ttmAvg = ttmData.length > 0 ? ttmData.reduce((a, b) => a + b, 0) / ttmData.length : 0;

    // Trailing consecutive zero/null months → planned maintenance / known offline
    let trailingZeroCount = 0;
    for (let i = ttmRaw.length - 1; i >= 0; i--) {
      const h = ttmRaw[i];
      if (h.mwh === null || h.mwh === 0) trailingZeroCount++;
      else break;
    }
    const isMaintenanceOffline = trailingZeroCount >= 3;

    // Active months in TTM (plant was generating, CF > 2%)
    const activeTtmMonths = ttmRaw
      .map((h, i) => ({ month: h.month, factor: ttmFactors[i] }))
      .filter((m): m is { month: string; factor: number } => m.factor !== null && m.factor > 0.02);
    const hasEnoughData = activeTtmMonths.length >= 6;

    // Benchmark: prefer sub-region avg when ≥ 3 plants contribute and months overlap;
    // otherwise fall back to ISO/RTO-level average, then to typical CF.
    const typical = TYPICAL[plant.fuelSource] ?? 0.3;
    let regionalRef = typical;

    const useSubRegion =
      subRegionalAvgByMonth != null &&
      (subRegionPlantCount ?? 0) >= 3 &&
      activeTtmMonths.some(m => subRegionalAvgByMonth.has(m.month));

    const benchmarkMap = useSubRegion ? subRegionalAvgByMonth! : regionalAvgByMonth;

    if (benchmarkMap && activeTtmMonths.length > 0) {
      const benchmarkVals = activeTtmMonths
        .map(m => benchmarkMap.get(m.month))
        .filter((v): v is number => v !== undefined);
      if (benchmarkVals.length > 0) {
        regionalRef = benchmarkVals.reduce((a, b) => a + b, 0) / benchmarkVals.length;
      }
    }

    const activeAvgCF = hasEnoughData
      ? activeTtmMonths.reduce((a, b) => a + b.factor, 0) / activeTtmMonths.length
      : ttmAvg;

    const isLikelyCurtailed = !isMaintenanceOffline && hasEnoughData && activeAvgCF < regionalRef * 0.80;
    const score = isMaintenanceOffline || !hasEnoughData
      ? 0
      : Math.round(Math.min(100, Math.max(0, ((regionalRef - activeAvgCF) / regionalRef) * 100)));

    const dataMonthsCount = history.filter(h => h.mwh !== null).length;
    return { ttmAvgFactor: ttmAvg, curtailmentScore: score, isLikelyCurtailed, isMaintenanceOffline, trailingZeroMonths: trailingZeroCount, dataMonthsCount };
  }

  // ─── Compute stats for all plants (regional + sub-regional benchmarks) ──
  console.log('\n▶ Computing regional benchmarks and curtailment scores...');
  const { regionMaps, subRegionMaps, subRegionPlantCount } = buildRegionalAvgMaps(finalPlants);
  for (const p of finalPlants) {
    const regionKey    = `${p.region}-${p.fuelSource}`;
    const subRegionKey = `${p.region}|${p.subRegion}|${p.fuelSource}`;
    const s = computeStats(
      p,
      regionMaps.get(regionKey),
      subRegionMaps.get(subRegionKey),
      subRegionPlantCount.get(subRegionKey),
    );
    p.ttmAvgFactor        = s.ttmAvgFactor;
    p.curtailmentScore    = s.curtailmentScore;
    p.isLikelyCurtailed   = s.isLikelyCurtailed;
    p.isMaintenanceOffline = s.isMaintenanceOffline;
    p.trailingZeroMonths  = s.trailingZeroMonths;
    p.dataMonthsCount     = s.dataMonthsCount;
  }
  console.log(`  ✓ Scored ${finalPlants.length} plants`);

  // ─── Write output ────────────────────────────────────────────────
  console.log('\n▶ Writing output...');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const manifest: DataManifest = {
    fetchedAt: new Date().toISOString(),
    plantCount: finalPlants.length,
    fuelBreakdown,
    plants: finalPlants,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2), 'utf-8');
  const sizeMB = (fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2);
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  console.log(`  ✓ Wrote ${OUTPUT_FILE}`);
  console.log(`  ✓ ${finalPlants.length} plants, ${sizeMB} MB`);
  console.log(`  ✓ EIA-860 enrichment rate: ${eia860Hits}/${finalPlants.length} (${Math.round(eia860Hits / Math.max(finalPlants.length, 1) * 100)}%)`);
  console.log(`  ✓ Breakdown: ${JSON.stringify(fuelBreakdown)}`);

  // ─── Upsert to Supabase (if credentials available) ───────────────
  if (SUPABASE_URL && SUPABASE_KEY) {
    console.log('\n▶ Upserting to Supabase...');
    const db = createClient(SUPABASE_URL, SUPABASE_KEY);
    const now = new Date().toISOString();
    const { data: beforeMaxMonthRows, error: beforeMaxMonthError } = await db
      .from('monthly_generation')
      .select('month')
      .order('month', { ascending: false })
      .limit(1);

    if (beforeMaxMonthError) {
      throw new Error(`Supabase pre-check error: ${beforeMaxMonthError.message}`);
    }

    const beforeMaxMonth = beforeMaxMonthRows?.[0]?.month ?? null;
    if (beforeMaxMonth && beforeMaxMonth >= latestEia923Month) {
      console.log(`\nℹ No new EIA month to ingest. Supabase already has ${beforeMaxMonth} (latest available ${latestEia923Month}). Skipping upsert.`);
      process.exit(0);
    }

    // Build plant rows — use pre-computed stats embedded during the scoring pass above
    const plantRows = finalPlants.map(p => ({
      id: p.id,
      eia_plant_code: p.eiaPlantCode,
      operator_id: p.operatorId ?? null,
      name: p.name,
      owner: p.owner,
      region: p.region,
      sub_region: p.subRegion ?? '',
      fuel_source: p.fuelSource,
      nameplate_capacity_mw: p.nameplateCapacityMW,
      cod: p.cod ?? null,
      county: p.county ?? null,
      state: p.location.state,
      lat: p.location.lat,
      lng: p.location.lng,
      ttm_avg_factor:        p.ttmAvgFactor        ?? 0,
      curtailment_score:     p.curtailmentScore     ?? 0,
      is_likely_curtailed:   p.isLikelyCurtailed    ?? false,
      is_maintenance_offline: p.isMaintenanceOffline ?? false,
      trailing_zero_months:  p.trailingZeroMonths   ?? 0,
      data_months_count:     p.dataMonthsCount      ?? 0,
      last_updated: now,
    }));

    // Upsert plants in batches of 500
    const BATCH = 500;
    for (let i = 0; i < plantRows.length; i += BATCH) {
      const batch = plantRows.slice(i, i + BATCH);
      const { error } = await db.from('plants').upsert(batch, { onConflict: 'id' });
      if (error) throw new Error(`Supabase plants upsert error: ${error.message}`);
      console.log(`  ✓ Plants upserted: ${Math.min(i + BATCH, plantRows.length)}/${plantRows.length}`);
    }

    // Build generation rows
    const genRows: { plant_id: string; month: string; mwh: number | null }[] = [];
    for (const p of finalPlants) {
      for (const h of p.generationHistory) {
        genRows.push({ plant_id: p.id, month: h.month, mwh: h.mwh });
      }
    }

    // Upsert generation in batches of 1000
    for (let i = 0; i < genRows.length; i += 1000) {
      const batch = genRows.slice(i, i + 1000);
      const { error } = await db.from('monthly_generation').upsert(batch, { onConflict: 'plant_id,month' });
      if (error) throw new Error(`Supabase generation upsert error: ${error.message}`);
      if (i % 20000 === 0 || i + 1000 >= genRows.length) {
        console.log(`  ✓ Generation rows upserted: ${Math.min(i + 1000, genRows.length)}/${genRows.length}`);
      }
    }

    const { data: afterMaxMonthRows, error: afterMaxMonthError } = await db
      .from('monthly_generation')
      .select('month')
      .order('month', { ascending: false })
      .limit(1);

    if (afterMaxMonthError) {
      throw new Error(`Supabase post-check error: ${afterMaxMonthError.message}`);
    }

    const afterMaxMonth = afterMaxMonthRows?.[0]?.month ?? null;
    if (!afterMaxMonth) {
      throw new Error('Supabase post-check failed: monthly_generation has no rows after ingestion.');
    }
    if (afterMaxMonth < latestEia923Month) {
      throw new Error(
        `Supabase post-check failed: latest month is ${afterMaxMonth}, expected at least ${latestEia923Month}.`
      );
    }
    if (beforeMaxMonth && afterMaxMonth <= beforeMaxMonth) {
      throw new Error(
        `Supabase post-check failed: latest month did not advance (before=${beforeMaxMonth}, after=${afterMaxMonth}).`
      );
    }

    console.log(`  ✓ Supabase sync complete`);
    console.log(`  ✓ Supabase max month advanced: ${beforeMaxMonth ?? 'none'} → ${afterMaxMonth}`);

    // ── Trigger lender currency check (fire-and-forget) ──────────────────
    // Runs after each successful EIA ingest to re-verify lender currency
    // for any newly scored or changed plants. Non-fatal if it fails.
    if (SUPABASE_URL && SUPABASE_KEY) {
      const edgeUrl = `${SUPABASE_URL}/functions/v1/lender-currency-agent`;
      try {
        await fetch(edgeUrl, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${SUPABASE_KEY}`,
          },
          body: JSON.stringify({
            mode:          'eia_trigger',
            offset:        0,
            limit:         10,
            budget_limit:  12.00,
            force_recheck: false,
          }),
        });
        console.log('  ✓ Triggered lender-currency-agent (EIA trigger)');
      } catch (err) {
        console.warn('  ⚠ lender-currency-agent trigger failed (non-fatal):', String(err));
      }
    }
  } else {
    console.log('  ℹ Supabase credentials not set — skipping DB upsert (JSON only)');
  }

  console.log(`  ✓ Elapsed: ${elapsed} minutes`);
  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
