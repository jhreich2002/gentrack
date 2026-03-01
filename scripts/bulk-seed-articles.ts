/**
 * GenTrack — bulk-seed-articles
 *
 * One-time script to generate Gemini news articles for all ~5,900 plants.
 * Runs locally (no Supabase edge function timeout constraint).
 *
 * Cost estimate: ~5,922 plants × $0.00044/plant ≈ $2.60 total
 *
 * Usage:
 *   npx tsx scripts/bulk-seed-articles.ts
 *
 * Env vars needed (reads from .env automatically):
 *   VITE_SUPABASE_URL
 *   VITE_SUPABASE_ANON_KEY  (or SUPABASE_SERVICE_ROLE_KEY)
 *   GEMINI_API_KEY
 *
 * Resumes automatically — already-seeded plants are skipped.
 * Safe to re-run after interruption.
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Load env ──────────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), '.env');
    // Handle both Unix (LF) and Windows (CRLF) line endings
    const lines = readFileSync(envPath, 'utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key) process.env[key] = val;
    }
  } catch { /* .env not found — rely on process.env */ }
}
loadEnv();

const SUPABASE_URL      = process.env.VITE_SUPABASE_URL!;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY!;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY!;
const GEMINI_URL        = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

// ── Tuneable ──────────────────────────────────────────────────────────────────

const ARTICLES_PER_PLANT = 3;
const DELAY_MS           = 1200;   // ~50 RPM — paid tier supports 4,000 RPM but we stay conservative
const UPSERT_BATCH       = 100;
const PROGRESS_EVERY     = 25;     // log progress every N plants

if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_API_KEY) {
  console.error('Missing env vars. Need: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_ANON_KEY), GEMINI_API_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const STATE_NAMES: Record<string, string> = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',
  CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',
  IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',
  ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',
  MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',
  NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',
  ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',
  RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',
  UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',
  WI:'Wisconsin',WY:'Wyoming',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Gemini generation ─────────────────────────────────────────────────────────

interface GeneratedArticle {
  title:                string;
  description:          string;
  source_name:          string;
  published_at:         string;
  topics:               string[];
  sentiment_label:      string;
  event_type:           string;
  impact_tags:          string[];
  fti_relevance_tags:   string[];
  importance:           string;
  entity_company_names: string[];
}

async function generatePlantNews(plant: {
  code: string; name: string; owner: string; fuel: string; state: string; mw: number;
  isCurtailed: boolean;
}, today: string): Promise<GeneratedArticle[]> {
  const articleCount = plant.isCurtailed ? 6 : ARTICLES_PER_PLANT;
  const stateName    = STATE_NAMES[plant.state] ?? plant.state;
  const fuelLabel    = plant.fuel === 'Solar' ? 'solar farm'
    : plant.fuel === 'Wind'    ? 'wind farm'
    : plant.fuel === 'Nuclear' ? 'nuclear generating station'
    : `${plant.fuel.toLowerCase()} power plant`;
  const curtailmentBlock = plant.isCurtailed ? `

⚠️  CURTAILMENT CONTEXT: This plant has been identified as likely curtailed — its capacity factor
consistently underperforms regional peers. At least 3 of the ${articleCount} articles MUST focus on:
  - Grid congestion or negative LMP pricing forcing dispatch curtailment
  - ISO/RTO curtailment orders or economic dispatch displacement
  - Owner/lender concerns about debt service coverage or covenant compliance
  - Potential PPA dispute, force majeure claim, or contract renegotiation
  - Asset sale, decommissioning consideration, or strategic review announcement
  - Transmission upgrade or battery co-location proposal to remediate curtailment
Articles should surface financial distress signals and M&A/advisory-relevant angles.` : '';

  const prompt = `You are a financial journalist specialising in US power generation and energy M&A advisory.

Generate exactly ${articleCount} realistic, distinct news articles about the following power plant.
Each article must be a plausible energy-sector news story that could appear in trade publications like
S&P Global Platts, Bloomberg NEF, Reuters Energy, or Utility Dive.

Plant details:
  Name:  ${plant.name}
  Type:  ${plant.mw} MW ${fuelLabel}
  Owner: ${plant.owner}
  State: ${stateName} (${plant.state})
  EIA Plant Code: ${plant.code}

Cover a MIX of story types across the ${articleCount} articles — including: outage/maintenance,
regulatory/permitting, financial/M&A, grid congestion/transmission constraints,
ISO/RTO dispatch & negative pricing events, PPA early termination or renegotiation,
debt/credit covenant stress signals, interconnection queue delays, community/environmental,
and capacity expansion. Make dates realistic: within the last 30 days before ${today}.${curtailmentBlock}

Return ONLY a valid JSON array of exactly ${articleCount} objects. No markdown, no explanation.
Each object must have these exact keys:
  title                 string   — headline (max 120 chars)
  description           string   — 2-sentence summary (max 300 chars)
  source_name           string   — one of: S&P Global | Reuters | Bloomberg NEF | Utility Dive | Platts | E&E News | Wood Mackenzie | SNL Energy
  published_at          string   — ISO 8601 datetime within last 30 days, e.g. "${today}T08:00:00Z"
  topics                string[] — subset of: outage | regulatory | financial | weather | construction
  sentiment_label       string   — one of: positive | negative | neutral
  event_type            string   — one of: unplanned_outage | planned_outage | regulatory_action | rate_case | m_and_a | financing | ppa_signed | construction | commissioning | litigation | community_event | corporate_strategy | none
  impact_tags           string[] — subset of: distress | asset_sale | capacity_addition | curtailment | ppa_dispute | litigation | rate_case | community_opposition | environmental | market_entry
  fti_relevance_tags    string[] — subset of: restructuring | transactions | disputes | market_strategy
  importance            string   — one of: low | medium | high
  entity_company_names  string[] — company/org names mentioned`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.85, maxOutputTokens: plant.isCurtailed ? 3600 : 1800 },
      }),
    });

    if (res.status === 429) {
      console.warn(`  [rate-limit] Waiting 60s before retrying ${plant.code}...`);
      await sleep(60000);
      return generatePlantNews(plant, today); // retry once
    }

    if (!res.ok) {
      console.warn(`  [HTTP ${res.status}] Skipping plant ${plant.code}`);
      return [];
    }

    const data = await res.json();
    const raw: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!raw) return [];

    const stripped = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const arrStart = stripped.indexOf('[');
    const arrEnd   = stripped.lastIndexOf(']');
    if (arrStart === -1 || arrEnd === -1) return [];

    const parsed = JSON.parse(stripped.slice(arrStart, arrEnd + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a: Record<string, unknown>) =>
      typeof a.title === 'string' && typeof a.description === 'string'
    ) as GeneratedArticle[];

  } catch (e) {
    console.warn(`  [error] Plant ${plant.code}:`, e);
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().split('T')[0];

  // Load all plants — paginate to get past Supabase's 1,000-row default limit
  console.log('Loading plants from Supabase...');
  const PAGE = 1000;
  let allPlantsRaw: Record<string, unknown>[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('plants')
      .select('eia_plant_code, name, owner, fuel_source, state, nameplate_capacity_mw, is_likely_curtailed, ttm_avg_factor')
      .neq('eia_plant_code', '99999')
      .order('nameplate_capacity_mw', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) { console.error('Failed to load plants:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    allPlantsRaw = allPlantsRaw.concat(data as Record<string, unknown>[]);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  if (!allPlantsRaw.length) { console.error('No plants found in DB.'); process.exit(1); }
  const plantsData = allPlantsRaw;

  const plants = plantsData.map((p: Record<string, unknown>) => ({
    code:        p.eia_plant_code as string,
    name:        (p.name as string) || '',
    owner:       (p.owner as string) || '',
    fuel:        (p.fuel_source as string) || '',
    state:       (p.state as string) || '',
    mw:          Number(p.nameplate_capacity_mw) || 0,
    isCurtailed: !!(p.is_likely_curtailed as boolean),
    ttmAvg:      Number(p.ttm_avg_factor) || 0,
  }));

  // Skip plants with zero TTM generation — retired, not EIA-reporting, or fully dark.
  // These plants have no active operations to generate meaningful news about.
  const activePlants = plants.filter(p => p.ttmAvg > 0);
  const skippedInactive = plants.length - activePlants.length;
  console.log(`Skipping ${skippedInactive} plants with 0 TTM generation (inactive/retired).`);

  // Find already-seeded plant codes (skip them)
  console.log('Checking already-seeded plants...');
  const { data: seededData } = await supabase
    .from('news_articles')
    .select('plant_codes')
    .like('query_tag', 'gemini:%');

  const seededCodes = new Set<string>();
  for (const row of seededData ?? []) {
    for (const code of (row.plant_codes ?? [])) seededCodes.add(code);
  }

  const toProcess = activePlants.filter(p => !seededCodes.has(p.code));
  const estimatedCost = (toProcess.length * 0.00044).toFixed(2);

  console.log(`\nTotal plants in DB:  ${plants.length}`);
  console.log(`Inactive (skipped):  ${skippedInactive}`);
  console.log(`Active plants:       ${activePlants.length}`);
  console.log(`Already seeded:      ${seededCodes.size}`);
  console.log(`To process:          ${toProcess.length}`);
  console.log(`Estimated cost:      ~$${estimatedCost}`);
  console.log(`Estimated time:      ~${Math.ceil(toProcess.length * DELAY_MS / 60000)} minutes\n`);

  let totalArticles = 0;
  let errors = 0;
  const batch: Record<string, unknown>[] = [];

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const rows = [...batch];
    batch.length = 0;
    const { error } = await supabase
      .from('news_articles')
      .upsert(rows, { onConflict: 'external_id', ignoreDuplicates: true });
    if (error) console.error('  [upsert error]:', error.message);
  };

  for (let i = 0; i < toProcess.length; i++) {
    const plant = toProcess[i];
    const articles = await generatePlantNews(plant, today);

    for (const a of articles) {
      const externalId = sha256(`${plant.code}:${a.title}`);
      batch.push({
        external_id:          externalId,
        title:                a.title,
        description:          a.description,
        content:              null,
        source_name:          a.source_name ?? 'Gemini Synthesis',
        url:                  `https://gentrack.app/synthetic/${externalId}`,
        published_at:         a.published_at,
        query_tag:            `gemini:${plant.code}`,
        plant_codes:          [plant.code],
        owner_names:          plant.owner ? [plant.owner] : [],
        states:               plant.state ? [plant.state] : [],
        fuel_types:           plant.fuel  ? [plant.fuel]  : [],
        topics:               Array.isArray(a.topics) ? a.topics : [],
        sentiment_label:      a.sentiment_label ?? 'neutral',
        event_type:           a.event_type ?? 'none',
        impact_tags:          Array.isArray(a.impact_tags) ? a.impact_tags : [],
        fti_relevance_tags:   Array.isArray(a.fti_relevance_tags) ? a.fti_relevance_tags : [],
        importance:           a.importance ?? 'low',
        entity_company_names: Array.isArray(a.entity_company_names) ? a.entity_company_names : [],
        llm_classified_at:    new Date().toISOString(),
      });
      totalArticles++;
    }

    if (articles.length === 0) errors++;

    // Flush when batch is full
    if (batch.length >= UPSERT_BATCH) await flushBatch();

    // Progress log
    if ((i + 1) % PROGRESS_EVERY === 0 || i === toProcess.length - 1) {
      const pct = (((i + 1) / toProcess.length) * 100).toFixed(1);
      console.log(`[${pct}%] ${i + 1}/${toProcess.length} plants — ${totalArticles} articles — ${errors} errors`);
    }

    if (i < toProcess.length - 1) await sleep(DELAY_MS);
  }

  // Final flush
  await flushBatch();

  console.log(`\n✓ Done! ${totalArticles} articles inserted across ${toProcess.length - errors} plants.`);
  console.log(`  Errors (empty responses): ${errors}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
