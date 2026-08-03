/**
 * enrich-eia860.ts
 *
 * Standalone EIA-860 enrichment pass.
 * Reads existing plants from Supabase, fetches EIA-860 operating-generator-capacity,
 * and updates: nameplate_capacity_mw, cod, county, lat, lng, owner, operator_id,
 * fuel_source (Solar → Solar Thermal for CSP plants).
 *
 * Run after fetch-eia-data.ts whenever EIA-860 enrichment fails or needs to be re-run.
 *   npx tsx scripts/enrich-eia860.ts
 */

import { createClient } from '@supabase/supabase-js';

// ─── Config ─────────────────────────────────────────────────────────────────

const EIA_API_KEY   = process.env.VITE_EIA_API_KEY || process.env.EIA_API_KEY || '';
const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL  || '';
const SUPABASE_KEY  =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY    ||
  process.env.SUPABASE_ANON_KEY         || '';

const EIA_BASE_URL = 'https://api.eia.gov/v2/';
const PAGE_SIZE    = 5000;
const RATE_LIMIT_DELAY_MS = 1500;
const MAX_RETRIES  = 3;
const RETRY_DELAY_MS = 10_000;
const BATCH_SIZE   = 500;

// EIA-860 energy source codes for Solar, Wind, Nuclear
const EIA860_FUEL_CODES = ['SUN', 'WND', 'NUC'];

// Detect latest EIA-860 survey month — fallback if probe fails
const FALLBACK_EIA860_SURVEY_MONTH = '2026-03';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url: string): Promise<any> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`  [Attempt ${attempt}/${MAX_RETRIES}] GET ${url.substring(0, 120)}...`);
    const resp = await fetch(url);
    if (!resp.ok) {
      const msg = `HTTP ${resp.status}: ${resp.statusText}`;
      if (attempt < MAX_RETRIES) {
        console.warn(`  ⚠ Attempt ${attempt} failed: ${msg}\n  Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new Error(msg);
    }
    return resp.json();
  }
}

function isMonthString(s: string) { return /^\d{4}-\d{2}$/.test(s); }

async function fetchLatestEIA860Month(): Promise<string | null> {
  for (const code of EIA860_FUEL_CODES) {
    try {
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
      if (period && isMonthString(String(period))) return String(period);
    } catch { /* try next fuel */ }
  }
  return null;
}

// ─── EIA-860 Fetch ───────────────────────────────────────────────────────────

interface PlantCharacteristics {
  nameplateCapacityMW: number;
  _pvCapacityMW: number;
  isCsp: boolean;
  cod?: string;
  county?: string;
  lat?: number;
  lng?: number;
  owner?: string;
  operatorId?: string;
}

async function fetchEIA860Characteristics(surveyMonth: string): Promise<Map<string, PlantCharacteristics>> {
  const allRecords: any[] = [];
  let offset = 0;
  let totalRecords = Infinity;

  while (offset < totalRecords) {
    const url = new URL(`${EIA_BASE_URL}electricity/operating-generator-capacity/data/`);
    url.searchParams.set('api_key', EIA_API_KEY);
    url.searchParams.set('frequency', 'monthly');
    // Numeric data fields
    url.searchParams.append('data[]', 'nameplate-capacity-mw');
    url.searchParams.append('data[]', 'net-summer-capacity-mw');
    // These are column/dimension fields that EIA API also accepts in data[]
    url.searchParams.append('data[]', 'operating-year-month');
    url.searchParams.append('data[]', 'county');
    url.searchParams.append('data[]', 'latitude');
    url.searchParams.append('data[]', 'longitude');
    // Note: technology and prime-mover-code are dimension fields returned automatically
    url.searchParams.append('facets[status][]', 'OP');
    EIA860_FUEL_CODES.forEach(code => {
      url.searchParams.append('facets[energy_source_code][]', code);
    });
    url.searchParams.set('start', surveyMonth);
    url.searchParams.set('end',   surveyMonth);
    url.searchParams.set('sort[0][column]', 'plantid');
    url.searchParams.set('sort[0][direction]', 'asc');
    url.searchParams.set('length', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));

    const json = await fetchWithRetry(url.toString());
    const data: any[] = json?.response?.data || [];
    totalRecords = json?.response?.total || 0;
    allRecords.push(...data);
    console.log(`    EIA-860 page ${Math.floor(offset / PAGE_SIZE) + 1}: ${data.length} records (${allRecords.length}/${totalRecords} total)`);
    offset += PAGE_SIZE;
    if (offset < totalRecords) await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log(`  ✓ EIA-860 total records fetched: ${allRecords.length}`);

  // Log first record's keys so we can see what field names EIA returns
  if (allRecords.length > 0) {
    console.log(`  ℹ First record keys: ${Object.keys(allRecords[0]).join(', ')}`);
    console.log(`  ℹ Sample record: ${JSON.stringify(allRecords[0]).substring(0, 300)}`);
  }

  // Deduplicate by (plantid, generatorid) — keep most recent period
  const latestByGenerator = new Map<string, any>();
  for (const r of allRecords) {
    const key = `${r.plantid}_${r.generatorid}`;
    const existing = latestByGenerator.get(key);
    if (!existing || (r.period || '') > (existing.period || '')) {
      latestByGenerator.set(key, r);
    }
  }
  console.log(`  ✓ EIA-860 unique generators after dedup: ${latestByGenerator.size}`);

  // Aggregate to plant level
  const plantMap = new Map<string, PlantCharacteristics>();

  for (const r of latestByGenerator.values()) {
    const code = String(r.plantid || '');
    if (!code) continue;

    const cap = parseFloat(r['nameplate-capacity-mw'] || '0') || 0;
    const cod = r['operating-year-month'] ? String(r['operating-year-month']) : undefined;
    const county = r.county || undefined;
    const lat  = parseFloat(r.latitude  || '0') || 0;
    const lng  = parseFloat(r.longitude || '0') || 0;
    const owner = r.entityName || r['entity-name'] || undefined;
    const operatorId = r.entityid ? String(r.entityid) : undefined;

    // CSP detection: 'technology' dimension field contains "Solar Thermal"
    // prime-mover-code: 'CP' (concentrating solar) or 'ST' (steam turbine = CSP thermal)
    // 'PV' = photovoltaic (standard solar)
    const technology = String(r.technology || '');
    const primeMoverCode = String(r['prime-mover-code'] || r.primeMoverCode || r.prime_mover_code || '');
    const isSolarThermalTech = technology.toLowerCase().includes('thermal');
    const isCspPrimeMover = primeMoverCode === 'CP' || (primeMoverCode === 'ST' && /* SUN energy source */ false);
    const isPvGenerator = !isSolarThermalTech && primeMoverCode !== 'CP';
    const pvCap = isPvGenerator ? cap : 0;

    const existing = plantMap.get(code);
    if (!existing) {
      plantMap.set(code, { nameplateCapacityMW: cap, _pvCapacityMW: pvCap, isCsp: false, cod, county, lat, lng, owner, operatorId });
    } else {
      existing.nameplateCapacityMW += cap;
      existing._pvCapacityMW += pvCap;
      if (cod && (!existing.cod || cod < existing.cod)) existing.cod = cod;
      if (!existing.county && county) existing.county = county;
      if (!existing.lat && lat)  { existing.lat = lat; existing.lng = lng; }
      if (!existing.owner && owner) existing.owner = owner;
      if (!existing.operatorId && operatorId) existing.operatorId = operatorId;
    }
  }

  // Finalize isCsp: SUN plant is CSP when it has no PV capacity
  let cspCount = 0;
  for (const ch of plantMap.values()) {
    ch.isCsp = ch._pvCapacityMW === 0 && ch.nameplateCapacityMW > 0;
    if (ch.isCsp) cspCount++;
  }
  console.log(`  ✓ EIA-860 aggregated to ${plantMap.size} unique plants (${cspCount} flagged as CSP)`);

  return plantMap;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' GenTrack — EIA-860 Enrichment Pass');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Date:    ${new Date().toISOString()}`);

  if (!EIA_API_KEY) {
    console.error('❌ VITE_EIA_API_KEY not set'); process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Supabase credentials not set'); process.exit(1);
  }

  const db = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Load all plants from Supabase (paginate past 1000-row default limit)
  console.log('\n▶ Loading plants from Supabase...');
  const PAGE = 1000;
  const existingPlants: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('plants')
      .select('*')
      .order('eia_plant_code', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error(`❌ ${error.message}`); process.exit(1); }
    if (!data || data.length === 0) break;
    existingPlants.push(...data);
    if (data.length < PAGE) break;
  }
  console.log(`  ✓ Loaded ${existingPlants.length} plants`);

  // 2. Detect latest EIA-860 survey month
  console.log('\n▶ Detecting latest EIA-860 survey month...');
  let surveyMonth = FALLBACK_EIA860_SURVEY_MONTH;
  try {
    const detected = await fetchLatestEIA860Month();
    if (detected) { surveyMonth = detected; }
  } catch (err: any) {
    console.warn(`  ⚠ Could not detect: ${err.message}. Using fallback ${surveyMonth}.`);
  }
  console.log(`  ✓ Survey month: ${surveyMonth}`);

  // 3. Fetch EIA-860 data
  console.log('\n▶ Fetching EIA-860 operating generator capacity...');
  let characteristics: Map<string, PlantCharacteristics>;
  try {
    characteristics = await fetchEIA860Characteristics(surveyMonth);
  } catch (err: any) {
    console.error(`❌ EIA-860 fetch failed: ${err.message}`);
    process.exit(1);
  }

  // 4. Build update rows
  console.log('\n▶ Building update rows...');
  const now = new Date().toISOString();
  const updateRows: any[] = [];
  let matched = 0, cspReclassified = 0, unmatched = 0;

  for (const plant of existingPlants!) {
    const plantCode = plant.eia_plant_code;
    if (!plantCode) continue;

    const ch = characteristics.get(String(plantCode));
    if (!ch) { unmatched++; continue; }

    const row: any = {
      ...plant,                         // preserve all existing NOT NULL columns
      last_updated: now,
    };

    if (ch.nameplateCapacityMW >= 0.5) {
      row.nameplate_capacity_mw = Math.round(ch.nameplateCapacityMW * 10) / 10;
    }
    if (ch.cod)   row.cod    = ch.cod;
    if (ch.county) row.county = ch.county;
    if (ch.owner)  row.owner  = ch.owner;
    if (ch.operatorId) row.operator_id = ch.operatorId;
    if (ch.lat && ch.lng) { row.lat = ch.lat; row.lng = ch.lng; }

    // CSP reclassification — only for Solar plants
    if (plant.fuel_source === 'Solar' && ch.isCsp) {
      row.fuel_source = 'Solar Thermal';
      cspReclassified++;
      console.log(`    CSP: ${plant.name} (${plantCode})`);
    }

    updateRows.push(row);
    matched++;
  }

  console.log(`  ✓ ${matched} matched, ${unmatched} unmatched, ${cspReclassified} reclassified as CSP`);

  // 5. Upsert to Supabase in batches
  console.log('\n▶ Upserting to Supabase...');
  for (let i = 0; i < updateRows.length; i += BATCH_SIZE) {
    const batch = updateRows.slice(i, i + BATCH_SIZE);
    const { error } = await db.from('plants').upsert(batch, { onConflict: 'id' });
    if (error) { console.error(`❌ Upsert error at batch ${i}: ${error.message}`); process.exit(1); }
    console.log(`  ✓ Upserted: ${Math.min(i + BATCH_SIZE, updateRows.length)}/${updateRows.length}`);
  }

  console.log('\n✅ EIA-860 enrichment complete.');
  console.log(`   Plants updated: ${matched}`);
  console.log(`   CSP reclassified: ${cspReclassified}`);
  console.log(`   Unmatched (no EIA-860 record): ${unmatched}`);
}

main().catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
