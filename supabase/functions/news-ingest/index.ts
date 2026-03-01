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

const NEWSAPI_BASE   = 'https://newsapi.org/v2/everything';
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';
const PAGE_SIZE      = 30;   // max per NewsAPI free-tier request
const BATCH_SIZE     = 50;   // rows per Supabase upsert batch
const LLM_BATCH_SIZE = 10;   // articles per Gemini classification call
const LOOKBACK_DAYS  = 7;    // fetch articles from the past N days per run

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
  url.searchParams.set('searchIn', 'title,description'); // restrict to headline+lede only — eliminates body-text false positives
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
  curtailmentScore: number;
}

interface OwnerMeta {
  eia_plant_code: string | null;
  owner: string | null;
  ult_parent: string | null;
  plant_operator: string | null;
  operator_ult_parent: string | null;
}

function buildQueries(plants: PlantMeta[], ownerMeta: OwnerMeta[]): Array<{ query: string; tag: string; plantCode?: string }> {
  const plantNameQueries: Array<{ query: string; tag: string; plantCode?: string }> = [];
  const genericQueries:   Array<{ query: string; tag: string; plantCode?: string }> = [];

  // Build a per-plant map of owner/operator from plant_ownership records
  const ownerByPlant = new Map<string, { ultParent: string | null; operator: string | null; operatorUltParent: string | null }>();
  for (const o of ownerMeta) {
    if (!o.eia_plant_code) continue;
    if (!ownerByPlant.has(o.eia_plant_code)) {
      ownerByPlant.set(o.eia_plant_code, {
        ultParent:        o.ult_parent ?? o.owner ?? null,
        operator:         o.plant_operator ?? null,
        operatorUltParent: o.operator_ult_parent ?? null,
      });
    }
  }

  const JUNK_OWNER_TERMS   = new Set(['inc.', 'llc', 'llc.', 'lp', 'l.p.', 'corp.', 'corp', 'ltd', 'ltd.', 'n/a', 'na', '']);
  const SKIP_GENERIC_NAMES = new Set(['energy', 'power', 'solar', 'wind', 'unit', 'plant', 'station', 'farm', 'gen']);
  const SKIP_NAME_FRAGMENTS = ['increment', 'state-fuel', 'level', 'aggregate'];

  // ── 1. Plant-name queries sorted by curtailment score DESC ─────────────────
  // Most impaired plants consume quota first. Quoted name forces exact phrase match
  // in title+description (searchIn=title,description set on the API call).
  const eligiblePlants = [...plants]
    .filter(p =>
      p.name.length >= 6 &&
      !SKIP_GENERIC_NAMES.has(p.name.toLowerCase()) &&
      !SKIP_NAME_FRAGMENTS.some(f => p.name.toLowerCase().includes(f)) &&
      p.eiaPlantCode !== '99999'
    )
    .sort((a, b) => b.curtailmentScore - a.curtailmentScore)
    .slice(0, 20);

  for (const p of eligiblePlants) {
    const fuelSuffix = p.fuelSource === 'Nuclear' ? 'nuclear plant'
      : p.fuelSource === 'Wind' ? 'wind farm'
      : 'solar plant';
    plantNameQueries.push({
      query:     `"${p.name}" ${fuelSuffix}`,
      tag:       `plant:${p.eiaPlantCode}`,
      plantCode: p.eiaPlantCode,
    });
  }

  // ── 2. Owner / operator queries for top 10 most curtailed plants ────────────
  // Each query is keyed to the plant so articles get attributed even when the
  // plant name doesn't appear (e.g. a corporate earnings piece about curtailment).
  const top10 = eligiblePlants.slice(0, 10);
  const seenOwnerQueries = new Set<string>();
  for (const p of top10) {
    const ownerInfo = ownerByPlant.get(p.eiaPlantCode);
    const fuelSuffix = p.fuelSource === 'Nuclear' ? 'nuclear plant'
      : p.fuelSource === 'Wind' ? 'wind farm'
      : 'solar plant';

    const candidates = [
      ownerInfo?.ultParent ?? null,
      ownerInfo?.operator ?? null,
      ownerInfo?.operatorUltParent ?? null,
    ];

    for (const ownerName of candidates) {
      if (!ownerName) continue;
      const ownerKey = ownerName.toLowerCase().trim();
      if (ownerKey.length < 5 || JUNK_OWNER_TERMS.has(ownerKey)) continue;
      const queryStr = `"${ownerName}" ${fuelSuffix} ${p.state}`;
      if (seenOwnerQueries.has(queryStr)) continue;
      seenOwnerQueries.add(queryStr);
      plantNameQueries.push({ query: queryStr, tag: `owner:${p.eiaPlantCode}`, plantCode: p.eiaPlantCode });
    }
  }

  // ── 3. Fuel-type + state combos for the 6 highest-diversity states ──────────
  const stateFuelCombos = new Map<string, Set<string>>();
  for (const p of plants) {
    if (!stateFuelCombos.has(p.state)) stateFuelCombos.set(p.state, new Set());
    stateFuelCombos.get(p.state)!.add(p.fuelSource);
  }
  const topStates = [...stateFuelCombos.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 6);

  for (const [state, fuels] of topStates) {
    for (const fuel of fuels) {
      const fuelWord = fuel === 'Solar' ? 'solar farm' : fuel === 'Wind' ? 'wind farm' : 'nuclear plant';
      genericQueries.push({ query: `${fuelWord} ${state}`, tag: `${fuel}:${state}` });
    }
  }

  // ── 4. Generic high-signal topic queries ────────────────────────────────────
  const generic = [
    'US solar farm curtailment 2025',
    'wind farm fire damage United States',
    'solar farm FERC interconnection curtailment',
    'nuclear power plant shutdown NRC',
    'power plant acquisition merger United States',
  ];
  for (const q of generic) {
    genericQueries.push({ query: q, tag: 'generic' });
  }

  // Plant-name + owner queries run first to claim attribution before state/generic dedup them
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

// ── LLM classification (Gemini Flash) ───────────────────────────────────────

interface LLMClassification {
  event_type:           string;
  impact_tags:          string[];
  fti_relevance_tags:   string[];
  importance:           string;
  entity_company_names: string[];
}

function defaultClassification(): LLMClassification {
  return { event_type: 'none', impact_tags: [], fti_relevance_tags: [], importance: 'low', entity_company_names: [] };
}

async function classifyArticlesWithGemini(
  articles: Array<{ title: string; description: string | null }>,
  geminiKey: string,
  knownCompanies: string[],
): Promise<LLMClassification[]> {
  const companyList = knownCompanies.slice(0, 80).join(', ');
  const articlesText = articles
    .map((a, i) => `${i + 1}. Title: ${a.title}\n   Desc: ${a.description ?? 'N/A'}`)
    .join('\n');

  const prompt = `You are classifying energy sector news articles for a power generation analytics platform.
For each article return a JSON object with these exact fields:
- event_type: one of outage|regulatory|financial|m_and_a|dispute|construction|policy|restructuring|none
- impact_tags: array (can be empty), each item from: distress|asset_sale|capacity_addition|curtailment|ppa_dispute|litigation|rate_case|community_opposition|environmental|market_entry
- fti_relevance_tags: array (can be empty), each item from: restructuring|transactions|disputes|market_strategy
- importance: low|medium|high
- entity_company_names: array of company/sponsor names found in this article, only from this list: ${companyList}

Articles:
${articlesText}

Return ONLY a valid JSON array with exactly ${articles.length} objects in order. No markdown, no explanation.`;

  try {
    const res = await fetch(`${GEMINI_BASE}?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1500 },
      }),
    });
    if (!res.ok) {
      console.warn(`Gemini classify HTTP error: ${res.status}`);
      return articles.map(() => defaultClassification());
    }
    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length === articles.length) {
      return parsed.map((r: Record<string, unknown>) => ({
        event_type:           typeof r.event_type === 'string' ? r.event_type : 'none',
        impact_tags:          Array.isArray(r.impact_tags) ? r.impact_tags : [],
        fti_relevance_tags:   Array.isArray(r.fti_relevance_tags) ? r.fti_relevance_tags : [],
        importance:           typeof r.importance === 'string' ? r.importance : 'low',
        entity_company_names: Array.isArray(r.entity_company_names) ? r.entity_company_names : [],
      }));
    }
    console.warn(`Gemini returned unexpected array length: ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
  } catch (e) {
    console.warn('Gemini JSON parse / network error:', e);
  }
  return articles.map(() => defaultClassification());
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
    const geminiApiKey    = Deno.env.get('GEMINI_API_KEY') ?? null;

    if (!newsApiKey) {
      return new Response(JSON.stringify({ error: 'NEWSAPI_KEY secret not set' }), { status: 500 });
    }
    if (!geminiApiKey) {
      console.warn('GEMINI_API_KEY not set — LLM classification will be skipped');
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── Load plant metadata for query building + matching ──────────────────
    const { data: plantsData, error: plantsErr } = await supabase
      .from('plants')
      .select('eia_plant_code, name, owner, fuel_source, state, nameplate_capacity_mw, curtailment_score');

    if (plantsErr || !plantsData) {
      console.error('Failed to load plants:', plantsErr?.message);
      return new Response(JSON.stringify({ error: 'Failed to load plants' }), { status: 500 });
    }

    const plants: PlantMeta[] = plantsData.map((p: Record<string, string>) => ({
      eiaPlantCode:        p.eia_plant_code,
      name:                p.name,
      owner:               p.owner ?? '',
      fuelSource:          p.fuel_source ?? '',
      state:               p.state ?? '',
      nameplateCapacityMw: Number(p.nameplate_capacity_mw ?? 0),
      curtailmentScore:    Number(p.curtailment_score ?? 0),
    }));

    // ── Load owner metadata from plant_ownership for query enrichment ──────
    const { data: ownerData } = await supabase
      .from('plant_ownership')
      .select('eia_plant_code, owner, ult_parent, plant_operator, operator_ult_parent');
    const ownerMeta: OwnerMeta[] = ownerData ?? [];

    // ── Extract known ult_parent names for Gemini entity linking ───────────
    const knownUltParents = [...new Set(
      ownerMeta
        .map(o => o.ult_parent ?? o.owner)
        .filter((n): n is string => !!n && n.length >= 5)
    )].sort();

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
        // Auto-attribute to the queried plant if not already matched:
        // - For plant-name queries (tag=plant:XXX): verify the plant name appears in title+description
        //   (with searchIn=title,description + quoted name this should always pass for real matches)
        // - For owner/operator queries (tag=owner:XXX): trust attribution unconditionally since
        //   the article may not name the plant but is clearly about its owner
        if (plantCode && !plant_codes.includes(plantCode)) {
          const isOwnerQuery = tag.startsWith('owner:');
          if (isOwnerQuery) {
            plant_codes.push(plantCode);
          } else {
            const titleDesc = `${article.title ?? ''} ${article.description ?? ''}`.toLowerCase();
            const plantName = plants.find(p => p.eiaPlantCode === plantCode)?.name ?? '';
            if (plantName.length >= 6 && titleDesc.includes(plantName.toLowerCase())) {
              plant_codes.push(plantCode);
            }
          }
        }
        const topics    = classifyTopics(searchText);
        const sentiment = classifySentiment(searchText);

        toInsert.push({
          external_id:          externalId,
          title:                article.title ?? '',
          description:          article.description ?? null,
          content:              article.content ?? null,
          source_name:          article.source?.name ?? null,
          url:                  article.url,
          published_at:         article.publishedAt,
          query_tag:            tag,
          plant_codes,
          owner_names,
          states,
          fuel_types,
          topics,
          sentiment_label:      sentiment,
          // LLM fields — populated after the collection loop
          event_type:           null as string | null,
          impact_tags:          [] as string[],
          fti_relevance_tags:   [] as string[],
          importance:           'low',
          entity_company_names: [] as string[],
          llm_classified_at:    null as string | null,
        });

        totalNew++;
      }

      // Small delay between queries to be polite to NewsAPI rate limits
      await new Promise(r => setTimeout(r, 300));
    }

    // ── LLM batch classification ───────────────────────────────────────────
    // Classify collected articles with Gemini Flash before persisting.
    // Only runs if GEMINI_API_KEY is set; gracefully degrades otherwise.
    let llmCallCount = 0;
    if (geminiApiKey && toInsert.length > 0) {
      console.log(`Classifying ${toInsert.length} articles with Gemini Flash (batches of ${LLM_BATCH_SIZE})...`);
      const now = new Date().toISOString();
      for (let i = 0; i < toInsert.length; i += LLM_BATCH_SIZE) {
        const batch = toInsert.slice(i, i + LLM_BATCH_SIZE);
        const classifications = await classifyArticlesWithGemini(
          batch.map(r => ({ title: String(r.title), description: r.description as string | null })),
          geminiApiKey,
          knownUltParents,
        );
        for (let j = 0; j < batch.length; j++) {
          const c = classifications[j];
          batch[j].event_type           = c.event_type;
          batch[j].impact_tags          = c.impact_tags;
          batch[j].fti_relevance_tags   = c.fti_relevance_tags;
          batch[j].importance           = c.importance;
          batch[j].entity_company_names = c.entity_company_names;
          batch[j].llm_classified_at    = now;
        }
        llmCallCount++;
        // Polite delay between Gemini calls
        if (i + LLM_BATCH_SIZE < toInsert.length) {
          await new Promise(r => setTimeout(r, 200));
        }
      }
      console.log(`Gemini classification complete: ${llmCallCount} calls for ${toInsert.length} articles`);
    }

    // ── Flush all collected + classified articles ─────────────────────────
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from('news_articles').upsert(batch, { onConflict: 'external_id', ignoreDuplicates: true });
      if (error) console.error(`Upsert batch ${i}–${i + batch.length} error:`, error.message);
    }

    const result = { ok: true, queriesRun: queries.length, newArticles: totalNew, llmCallsMade: llmCallCount };
    console.log('news-ingest complete:', result);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('news-ingest fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
