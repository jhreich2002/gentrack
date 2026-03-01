/**
 * GenTrack â€” news-ingest Edge Function  (Gemini-generation mode)
 *
 * Runs nightly (06:00 UTC via pg_cron).  Instead of scraping a news API
 * (which blocks server-side on free tiers), this function uses Gemini Flash
 * to synthesise realistic energy-sector news articles for a curated set of
 * plants, then upserts them into news_articles with full LLM classification.
 *
 * Plant selection per run (~50 total, cost-aware):
 *   1. Watchlisted plants   â€” always covered first  (up to WATCHLIST_CAP)
 *   2. Daily rotation batch â€” top plants by MW, rotating offset so the full
 *      catalogue cycles continuously over time                (fills to TARGET)
 *
 * Cost estimate at default settings:
 *   ~50 plants Ã— 3 articles Ã— ~1,100 tokens â‰ˆ 165k tokens/run
 *   â‰ˆ $0.02/run with Gemini 2.0 Flash Lite  â†’ ~$0.60/month running nightly
 *
 * Required secrets:
 *   GEMINI_API_KEY            â€” Google AI Studio key
 *   SUPABASE_URL              â€” auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY â€” auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// â”€â”€ Tuneable constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TARGET        = 100;  // plants per nightly run (~$0.044/run → ~$1.30/month)
const WATCHLIST_CAP = 15;   // max watchlist plants (always covered first)
const ARTICLES_PER_PLANT = 3;  // articles Gemini generates per plant
const UPSERT_BATCH  = 50;   // rows per Supabase upsert call
const GEMINI_URL    = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
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

// â”€â”€ Gemini article generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface GeneratedArticle {
  title:                string;
  description:          string;
  source_name:          string;
  published_at:         string;   // ISO date string, within last 14 days
  topics:               string[];
  sentiment_label:      string;
  event_type:           string;
  impact_tags:          string[];
  fti_relevance_tags:   string[];
  importance:           string;
  entity_company_names: string[];
}

async function generatePlantNews(
  plant: { code: string; name: string; owner: string; fuel: string; state: string; mw: number; isCurtailed: boolean },
  geminiKey: string,
  today: string,   // YYYY-MM-DD
): Promise<GeneratedArticle[]> {

  const stateName    = STATE_NAMES[plant.state] ?? plant.state;
  const fuelLabel    = plant.fuel === 'Solar' ? 'solar farm'
    : plant.fuel === 'Wind'  ? 'wind farm'
    : plant.fuel === 'Nuclear' ? 'nuclear generating station'
    : `${plant.fuel.toLowerCase()} power plant`;
  const articleCount = plant.isCurtailed ? 6 : ARTICLES_PER_PLANT;
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
and capacity expansion. Make dates realistic: within the last 14 days before ${today}.${curtailmentBlock}

Return ONLY a valid JSON array of exactly ${articleCount} objects. No markdown, no explanation.
Each object must have these exact keys:
  title                 string   â€” headline (max 120 chars)
  description           string   â€” 2-sentence summary (max 300 chars)
  source_name           string   â€” one of: S&P Global | Reuters | Bloomberg NEF | Utility Dive | Platts | E&E News | Wood Mackenzie | SNL Energy
  published_at          string   â€” ISO 8601 datetime within last 14 days, e.g. "${today}T08:00:00Z"
  topics                string[] â€” subset of: outage | regulatory | financial | weather | construction
  sentiment_label       string   â€” one of: positive | negative | neutral
  event_type            string   â€” one of: unplanned_outage | planned_outage | regulatory_action | rate_case | m_and_a | financing | ppa_signed | construction | commissioning | litigation | community_event | corporate_strategy | none
  impact_tags           string[] â€” subset of: distress | asset_sale | capacity_addition | curtailment | ppa_dispute | litigation | rate_case | community_opposition | environmental | market_entry
  fti_relevance_tags    string[] â€” subset of: restructuring | transactions | disputes | market_strategy
  importance            string   â€” one of: low | medium | high
  entity_company_names  string[] â€” company/org names mentioned (owner, regulators, counterparties)`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.85, maxOutputTokens: plant.isCurtailed ? 3600 : 1800 },
      }),
    });

    if (!res.ok) {
      console.warn(`Gemini HTTP ${res.status} for plant ${plant.code}`);
      return [];
    }

    const data = await res.json();
    const raw: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!raw) { console.warn(`Empty Gemini response for plant ${plant.code}`); return []; }
    const stripped = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    // Extract array even if Gemini adds prose before/after the JSON
    const arrStart = stripped.indexOf('[');
    const arrEnd   = stripped.lastIndexOf(']');
    if (arrStart === -1 || arrEnd === -1) { console.warn(`No JSON array found for plant ${plant.code}:`, stripped.slice(0, 120)); return []; }
    const parsed = JSON.parse(stripped.slice(arrStart, arrEnd + 1));

    if (!Array.isArray(parsed)) {
      console.warn(`Non-array response for plant ${plant.code}`);
      return [];
    }

    return parsed.filter((a: Record<string, unknown>) =>
      typeof a.title === 'string' && typeof a.description === 'string'
    ) as GeneratedArticle[];

  } catch (e) {
    console.warn(`Gemini error for plant ${plant.code}:`, e);
    return [];
  }
}

// â”€â”€ Main handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

Deno.serve(async (_req) => {
  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const geminiKey      = Deno.env.get('GEMINI_API_KEY');

    if (!geminiKey) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY secret not set' }), { status: 500 });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const today    = new Date().toISOString().split('T')[0];

    // â”€â”€ Load all plants (sorted by MW desc for rotation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const { data: plantsData, error: plantsErr } = await supabase
      .from('plants')
      .select('eia_plant_code, name, owner, fuel_source, state, nameplate_capacity_mw, is_likely_curtailed')
      .neq('eia_plant_code', '99999')
      .order('nameplate_capacity_mw', { ascending: false });

    if (plantsErr || !plantsData?.length) {
      return new Response(JSON.stringify({ error: 'Failed to load plants' }), { status: 500 });
    }

    const allPlants = plantsData.map((p: Record<string, unknown>) => ({
      code:        p.eia_plant_code as string,
      name:        p.name as string,
      owner:       (p.owner as string) ?? '',
      fuel:        (p.fuel_source as string) ?? '',
      state:       (p.state as string) ?? '',
      mw:          Number(p.nameplate_capacity_mw) || 0,
      isCurtailed: !!(p.is_likely_curtailed as boolean),
    }));

    // â”€â”€ Load watchlisted plant codes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const { data: watchData } = await supabase
      .from('watchlist')
      .select('plant_id');
    const watchlistCodes = new Set<string>(
      (watchData ?? []).map((w: { plant_id: string }) => w.plant_id)
    );

    // â”€â”€ Build target plant list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Priority 1: watchlisted plants (up to WATCHLIST_CAP)
    const watchlistPlants = allPlants
      .filter(p => watchlistCodes.has(p.code))
      .slice(0, WATCHLIST_CAP);

    const watchlistSet = new Set(watchlistPlants.map(p => p.code));

    // Priority 2: daily rotation through remaining plants sorted by MW
    const nonWatchlistPlants = allPlants.filter(p => !watchlistSet.has(p.code));
    const rotationSize = TARGET - watchlistPlants.length;
    const dayIndex     = Math.floor(Date.now() / 86_400_000);
    const totalBatches = Math.ceil(nonWatchlistPlants.length / rotationSize);
    const batchIndex   = dayIndex % totalBatches;
    const offset       = batchIndex * rotationSize;
    const rotationBatch = nonWatchlistPlants.slice(offset, offset + rotationSize);

    const targetPlants = [...watchlistPlants, ...rotationBatch];
    console.log(`Targeting ${targetPlants.length} plants (${watchlistPlants.length} watchlist + ${rotationBatch.length} rotation batch ${batchIndex}/${totalBatches})`);

    // â”€â”€ Generate + store articles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const toUpsert: Record<string, unknown>[] = [];
    let geminiCalls = 0;

    for (const plant of targetPlants) {
      const articles = await generatePlantNews(plant, geminiKey, today);
      geminiCalls++;

      for (const a of articles) {
        const externalId = await sha256(`${plant.code}:${a.title}`);
        toUpsert.push({
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
      }

      // Polite inter-call delay to avoid Gemini rate limits
      await new Promise(r => setTimeout(r, 150)); // 150ms → ~6 RPS, well under paid tier 4,000 RPM
    }

    // â”€â”€ Upsert in batches â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let upsertErrors = 0;
    for (let i = 0; i < toUpsert.length; i += UPSERT_BATCH) {
      const batch = toUpsert.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from('news_articles')
        .upsert(batch, { onConflict: 'external_id', ignoreDuplicates: true });
      if (error) {
        console.error(`Upsert error batch ${i}:`, error.message);
        upsertErrors++;
      }
    }

    const result = {
      ok: true,
      plantsProcessed: targetPlants.length,
      articlesGenerated: toUpsert.length,
      geminiCalls,
      upsertErrors,
      rotationBatch: batchIndex,
      totalBatches,
    };
    console.log('news-ingest complete:', result);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('news-ingest fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});


