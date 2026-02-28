/**
 * GenTrack — news-ingest Edge Function
 *
 * Runs nightly (06:00 UTC via pg_cron). Calls ~40 coarse NewsAPI.org queries,
 * deduplicates articles by URL hash, matches each article to specific EIA plant
 * codes via owner/state/fuel text scanning, classifies topics + sentiment with
 * keyword lists, then bulk-upserts into news_articles.
 *
 * Required secrets (set via: npx supabase secrets set KEY=value):
 *   NEWSAPI_KEY           — NewsAPI.org API key (free tier: 100 req/day)
 *   SUPABASE_URL          — auto-injected by Supabase runtime
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected by Supabase runtime
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

const NEWSAPI_BASE = 'https://newsapi.org/v2/everything';
const PAGE_SIZE    = 30;   // max per NewsAPI free-tier request
const BATCH_SIZE   = 50;   // rows per Supabase upsert batch
const LOOKBACK_DAYS = 7;   // fetch articles from the past N days per run

// Keyword lists for topic classification (energy domain—no LLM needed)
const TOPIC_KEYWORDS: Record<string, string[]> = {
  outage:       ['outage', 'shutdown', 'offline', 'tripped', 'forced outage', 'unplanned', 'emergency shutdown', 'fire', 'explosion', 'flood damage', 'ice storm', 'blackout', 'curtailment'],
  regulatory:   ['ferc', 'epa', 'permit', 'violation', 'fine', 'penalty', 'compliance', 'regulation', 'puc', 'cpuc', 'nrc', 'ercot', 'iso-ne', 'pjm ruling', 'order', 'investigation'],
  financial:    ['acquisition', 'merger', 'deal', 'investment', 'financing', 'refinancing', 'ppa', 'power purchase', 'offtake', 'revenue', 'earnings', 'ipo', 'bankruptcy', 'default', 'debt'],
  weather:      ['hurricane', 'tornado', 'wildfire', 'drought', 'extreme heat', 'winter storm', 'freeze', 'flooding', 'hail', 'lightning strike'],
  construction: ['construction', 'commissioning', 'commercial operation', 'groundbreaking', 'capacity expansion', 'repowering', 'upgrade', 'retrofit', 'interconnection'],
};

// Keyword lists for sentiment classification
const NEGATIVE_WORDS = [
  'outage', 'shutdown', 'fire', 'explosion', 'flood', 'damage', 'curtailment',
  'fine', 'penalty', 'violation', 'lawsuit', 'protest', 'opposition', 'rejection',
  'bankruptcy', 'default', 'delay', 'cancellation', 'cancelled', 'denied',
  'downgrade', 'loss', 'losses', 'underperform', 'failure', 'failed',
];
const POSITIVE_WORDS = [
  'record', 'milestone', 'approved', 'approval', 'award', 'contract signed',
  'expansion', 'upgrade', 'commissioning', 'online', 'operational',
  'investment', 'financing closed', 'deal closed', 'acquisition completed',
  'profit', 'earnings beat', 'upgrade',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** SHA-256 hex of a string (used as dedup key on article URL). */
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase+trim a string for fuzzy matching. */
const norm = (s: string) => s.toLowerCase().trim();

/** Match text against a list of terms; returns true if any term appears. */
function containsAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some(n => h.includes(n.toLowerCase()));
}

/** Classify topic tags from article text via keyword matching. */
function classifyTopics(text: string): string[] {
  const topics: string[] = [];
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (containsAny(text, keywords)) topics.push(topic);
  }
  return topics.length > 0 ? topics : ['other'];
}

/** Classify sentiment from article text via keyword matching. */
function classifySentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const negCount = NEGATIVE_WORDS.filter(w => text.toLowerCase().includes(w)).length;
  const posCount = POSITIVE_WORDS.filter(w => text.toLowerCase().includes(w)).length;
  if (negCount > posCount) return 'negative';
  if (posCount > negCount) return 'positive';
  return 'neutral';
}

// ── NewsAPI fetch ─────────────────────────────────────────────────────────────

interface NewsApiArticle {
  title: string | null;
  description: string | null;
  content: string | null;
  url: string;
  publishedAt: string;
  source: { name: string | null };
}

async function fetchNewsApiArticles(query: string, apiKey: string, fromDate: string): Promise<NewsApiArticle[]> {
  const url = new URL(NEWSAPI_BASE);
  url.searchParams.set('q', query);
  url.searchParams.set('language', 'en');
  url.searchParams.set('sortBy', 'publishedAt');
  url.searchParams.set('from', fromDate);
  url.searchParams.set('pageSize', String(PAGE_SIZE));
  url.searchParams.set('apiKey', apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    console.warn(`NewsAPI error for query "${query}": ${res.status} ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return (data.articles ?? []).filter((a: NewsApiArticle) =>
    a.url && a.title && a.title !== '[Removed]'
  );
}

// ── Query strategy: build ~40 coarse queries from plant metadata ──────────────

interface PlantMeta {
  eiaPlantCode: string;
  name: string;
  owner: string;
  fuelSource: string;
  state: string;
  nameplateCapacityMw: number;
}

interface OwnerMeta {
  owner: string | null;
  ult_parent: string | null;
}

function buildQueries(plants: PlantMeta[], ownerMeta: OwnerMeta[]): Array<{ query: string; tag: string; plantCode?: string }> {
  const plantNameQueries: Array<{ query: string; tag: string; plantCode?: string }> = [];
  const genericQueries:   Array<{ query: string; tag: string; plantCode?: string }> = [];

  // 1. Unique ultimate parent companies (top 25 by plant count)
  const parentCount: Record<string, number> = {};
  for (const o of ownerMeta) {
    const parent = o.ult_parent || o.owner;
    if (parent) parentCount[parent] = (parentCount[parent] ?? 0) + 1;
  }
  const topParents = Object.entries(parentCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([name]) => name);

  for (const parent of topParents) {
    genericQueries.push({ query: `"${parent}" power plant`, tag: parent });
  }

  // 2. Fuel-type + state combos for the 6 highest-capacity states
  const stateFuelCombos = new Map<string, Set<string>>();
  for (const p of plants) {
    if (!stateFuelCombos.has(p.state)) stateFuelCombos.set(p.state, new Set());
    stateFuelCombos.get(p.state)!.add(p.fuelSource);
  }
  // Sort states by plant count, take top 6
  const topStates = [...stateFuelCombos.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 6);

  for (const [state, fuels] of topStates) {
    for (const fuel of fuels) {
      const fuelWord = fuel === 'Solar' ? 'solar farm' : fuel === 'Wind' ? 'wind farm' : 'nuclear plant';
      genericQueries.push({ query: `${fuelWord} ${state}`, tag: `${fuel}:${state}` });
    }
  }

  // 3. Generic high-signal topic queries
  const generic = [
    'US power plant outage 2025',
    'wind farm fire damage United States',
    'solar farm FERC interconnection',
    'nuclear power plant shutdown NRC',
    'power plant acquisition merger United States',
  ];
  for (const q of generic) {
    genericQueries.push({ query: q, tag: 'generic' });
  }

  // 4. Plant-name specific queries for top plants by capacity (up to 20 queries)
  // Run FIRST so their plant_codes are recorded before generic queries dedup the same URLs.
  const SKIP_GENERIC_NAMES = new Set(['energy', 'power', 'solar', 'wind', 'unit', 'plant', 'station', 'farm', 'gen']);
  const SKIP_NAME_FRAGMENTS = ['increment', 'state-fuel', 'level', 'aggregate'];
  const topPlants = [...plants]
    .filter(p =>
      p.name.length >= 6 &&
      !SKIP_GENERIC_NAMES.has(p.name.toLowerCase()) &&
      !SKIP_NAME_FRAGMENTS.some(f => p.name.toLowerCase().includes(f)) &&
      p.eiaPlantCode !== '99999'
    )
    .sort((a, b) => b.nameplateCapacityMw - a.nameplateCapacityMw)
    .slice(0, 20);

  for (const p of topPlants) {
    const fuelWord = p.fuelSource === 'Nuclear' ? 'nuclear' : p.fuelSource === 'Wind' ? 'wind' : p.fuelSource === 'Solar' ? 'solar' : 'power';
    plantNameQueries.push({ query: `"${p.name}" ${fuelWord} plant`, tag: `plant:${p.eiaPlantCode}`, plantCode: p.eiaPlantCode });
  }

  // Plant-name queries run first to ensure they get plant_codes before generic queries dedup them
  return [...plantNameQueries, ...genericQueries];
}

// ── Article → plant code matching ────────────────────────────────────────────

interface PlantIndex {
  byOwner: Map<string, string[]>;       // owner name → [eia_plant_codes]
  byState: Map<string, string[]>;       // state abbr → [eia_plant_codes]
  byFuel:  Map<string, string[]>;       // fuel → [eia_plant_codes]
  byName:  Map<string, string>;         // plant name → eia_plant_code
}

function buildPlantIndex(plants: PlantMeta[]): PlantIndex {
  const byOwner = new Map<string, string[]>();
  const byState = new Map<string, string[]>();
  const byFuel  = new Map<string, string[]>();
  const byName  = new Map<string, string>();

  for (const p of plants) {
    const ownerKey = norm(p.owner);
    byOwner.set(ownerKey, [...(byOwner.get(ownerKey) ?? []), p.eiaPlantCode]);

    const stateKey = norm(p.state);
    byState.set(stateKey, [...(byState.get(stateKey) ?? []), p.eiaPlantCode]);

    const fuelKey = norm(p.fuelSource);
    byFuel.set(fuelKey, [...(byFuel.get(fuelKey) ?? []), p.eiaPlantCode]);

    byName.set(norm(p.name), p.eiaPlantCode);
  }

  return { byOwner, byState, byFuel, byName };
}

function matchPlants(
  articleText: string,
  idx: PlantIndex,
  plants: PlantMeta[]
): { plant_codes: string[]; owner_names: string[]; states: string[]; fuel_types: string[] } {
  const text = articleText.toLowerCase();
  const plant_codes = new Set<string>();
  const owner_names = new Set<string>();
  const states      = new Set<string>();
  const fuel_types  = new Set<string>();

  // Match by owner name
  for (const [ownerKey, codes] of idx.byOwner) {
    if (ownerKey.length >= 5 && text.includes(ownerKey)) {
      codes.forEach(c => plant_codes.add(c));
      owner_names.add(ownerKey);
    }
  }

  // Match by plant name (exact substring match — only if article mentions it)
  for (const [nameKey, code] of idx.byName) {
    if (nameKey.length >= 8 && text.includes(nameKey)) {
      plant_codes.add(code);
    }
  }

  // US state abbreviations as two-letter uppercase tokens
  const usStates = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC',
    'ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
  for (const st of usStates) {
    // Match " TX " or ", TX" or " Texas " patterns
    const stLong = stateAbbrevToName(st);
    if (text.includes(` ${st.toLowerCase()} `) || text.includes(`(${st.toLowerCase()})`) || (stLong && text.includes(stLong.toLowerCase()))) {
      states.add(st);
      const stCodes = idx.byState.get(st.toLowerCase()) ?? [];
      if (owner_names.size > 0) {
        // Only tag state-matched plants if an owner was also matched (avoids false positives)
        stCodes.forEach(c => plant_codes.add(c));
      }
    }
  }

  // Fuel type keywords
  if (text.includes('wind')) { idx.byFuel.get('wind')?.forEach(c => {}); fuel_types.add('Wind'); }
  if (text.includes('solar')) { fuel_types.add('Solar'); }
  if (text.includes('nuclear')) { fuel_types.add('Nuclear'); }

  return {
    plant_codes: [...plant_codes],
    owner_names: [...owner_names],
    states:      [...states],
    fuel_types:  [...fuel_types],
  };
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
  WI:'Wisconsin',WY:'Wyoming'
};
function stateAbbrevToName(abbrev: string): string | null {
  return STATE_NAMES[abbrev] ?? null;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (_req) => {
  try {
    const supabaseUrl     = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const newsApiKey      = Deno.env.get('NEWSAPI_KEY');

    if (!newsApiKey) {
      return new Response(JSON.stringify({ error: 'NEWSAPI_KEY secret not set' }), { status: 500 });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── Load plant metadata for query building + matching ──────────────────
    const { data: plantsData, error: plantsErr } = await supabase
      .from('plants')
      .select('eia_plant_code, name, owner, fuel_source, state, nameplate_capacity_mw');

    if (plantsErr || !plantsData) {
      console.error('Failed to load plants:', plantsErr?.message);
      return new Response(JSON.stringify({ error: 'Failed to load plants' }), { status: 500 });
    }

    const plants: PlantMeta[] = plantsData.map((p: Record<string, string>) => ({
      eiaPlantCode:       p.eia_plant_code,
      name:               p.name,
      owner:              p.owner ?? '',
      fuelSource:         p.fuel_source ?? '',
      state:              p.state ?? '',
      nameplateCapacityMw: Number(p.nameplate_capacity_mw ?? 0),
    }));

    // ── Load owner metadata from plant_ownership for query enrichment ──────
    const { data: ownerData } = await supabase
      .from('plant_ownership')
      .select('owner, ult_parent');
    const ownerMeta: OwnerMeta[] = ownerData ?? [];

    // ── Build plant lookup index ───────────────────────────────────────────
    const plantIdx = buildPlantIndex(plants);

    // ── Build ~40 coarse query strings ─────────────────────────────────────
    const queries = buildQueries(plants, ownerMeta);
    console.log(`Built ${queries.length} news queries`);

    // ── Load known external IDs to skip re-fetching old articles ──────────
    const fromDate = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000)
      .toISOString().split('T')[0];

    const { data: existingRows } = await supabase
      .from('news_articles')
      .select('external_id')
      .gte('published_at', fromDate);
    const knownIds = new Set<string>((existingRows ?? []).map((r: { external_id: string }) => r.external_id));

    // ── Fetch articles for all queries ─────────────────────────────────────
    let totalNew = 0;
    const toInsert: Record<string, unknown>[] = [];

    for (const { query, tag, plantCode } of queries) {
      const articles = await fetchNewsApiArticles(query, newsApiKey, fromDate);

      for (const article of articles) {
        const externalId = await sha256(article.url);
        if (knownIds.has(externalId)) continue;
        knownIds.add(externalId); // prevent duplicates within this run

        const searchText = `${article.title ?? ''} ${article.description ?? ''} ${article.content ?? ''}`;
        const { plant_codes, owner_names, states, fuel_types } = matchPlants(searchText, plantIdx, plants);
        // If this query was plant-specific, always attribute the article to that plant
        if (plantCode && !plant_codes.includes(plantCode)) plant_codes.push(plantCode);
        const topics    = classifyTopics(searchText);
        const sentiment = classifySentiment(searchText);

        toInsert.push({
          external_id:     externalId,
          title:           article.title ?? '',
          description:     article.description ?? null,
          content:         article.content ?? null,
          source_name:     article.source?.name ?? null,
          url:             article.url,
          published_at:    article.publishedAt,
          query_tag:       tag,
          plant_codes,
          owner_names,
          states,
          fuel_types,
          topics,
          sentiment_label: sentiment,
        });

        totalNew++;

        // Flush batch
        if (toInsert.length >= BATCH_SIZE) {
          const batch = toInsert.splice(0, BATCH_SIZE);
          const { error } = await supabase.from('news_articles').upsert(batch, { onConflict: 'external_id', ignoreDuplicates: true });
          if (error) console.error('Upsert batch error:', error.message);
        }
      }

      // Small delay between queries to be polite to NewsAPI rate limits
      await new Promise(r => setTimeout(r, 300));
    }

    // Flush remainder
    if (toInsert.length > 0) {
      const { error } = await supabase.from('news_articles').upsert(toInsert, { onConflict: 'external_id', ignoreDuplicates: true });
      if (error) console.error('Final upsert error:', error.message);
    }

    const result = { ok: true, queriesRun: queries.length, newArticles: totalNew };
    console.log('news-ingest complete:', result);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('news-ingest fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
