/**
 * GenTrack — sector-news-ingest Edge Function
 *
 * Fires ~15 fixed, broad sector-level NewsAPI queries — no plant names.
 * Articles are stored in news_articles without plant_codes and are
 * LLM-classified with Gemini Flash. entity_company_names[] links each
 * article to known ult_parent sponsors, fueling the company_stats layer.
 *
 * Runs twice daily (12:00 + 18:00 UTC) via pg_cron so intra-day M&A,
 * restructuring, or regulatory events surface quickly without burning
 * the full NewsAPI quota on plant-level queries.
 *
 * Budget: 15 queries × 2 runs = 30 NewsAPI req/day
 *         Gemini Flash classification: ~2–3 calls/run (batch size 10)
 *
 * Required secrets:
 *   NEWSAPI_KEY               — NewsAPI.org key (shared with news-ingest)
 *   GEMINI_API_KEY            — Gemini Flash key
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ──────────────────────────────────────────────────────────────────

const NEWSAPI_BASE   = 'https://newsapi.org/v2/everything';
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';
const PAGE_SIZE      = 20;   // articles per query (lower than news-ingest to save budget)
const BATCH_SIZE     = 50;   // rows per Supabase upsert batch
const LLM_BATCH_SIZE = 10;   // articles per Gemini call
const LOOKBACK_HOURS = 12;   // only fetch articles published in the last N hours

// ── 15 fixed high-signal sector queries ───────────────────────────────────────
// Ordered by FTI service line priority (restructuring / M&A / disputes first).
// No plant names — these are purely sector / company-level signals.

const SECTOR_QUERIES: Array<{ query: string; service_line: string }> = [
  // Restructuring / Distress
  { query: '"power plant" OR "solar farm" OR "wind farm" bankruptcy restructuring', service_line: 'restructuring' },
  { query: '"renewable energy" OR "independent power producer" "debt restructuring" OR "financial distress" OR "chapter 11"', service_line: 'restructuring' },
  { query: '"IPP" OR "power developer" restructuring OR distress OR "strategic alternatives" United States', service_line: 'restructuring' },
  { query: 'utility OR "power company" "strategic alternatives" OR "exploring sale" OR "debt default" 2025 2026', service_line: 'restructuring' },

  // M&A / Transactions
  { query: '"solar farm" OR "wind farm" OR "power plant" acquisition OR merger OR divestiture United States', service_line: 'transactions' },
  { query: '"clean energy" OR "renewable energy" acquisition OR "asset sale" OR "portfolio sale" United States', service_line: 'transactions' },
  { query: '"offshore wind" OR "onshore wind" acquisition OR divestiture OR "change of control"', service_line: 'transactions' },
  { query: 'utility merger OR "utility acquisition" OR "utility divestiture" FERC OR "state PUC" approval', service_line: 'transactions' },

  // Disputes / Litigation
  { query: 'FERC OR "NERC violation" OR "PUC fine" "power plant" OR "wind farm" OR "solar farm"', service_line: 'disputes' },
  { query: '"power purchase agreement" dispute OR terminate OR renegotiate OR "contract breach"', service_line: 'disputes' },
  { query: '"grid interconnection" dispute OR delay OR "queue withdrawal" OR "FERC complaint"', service_line: 'disputes' },
  { query: '"renewable energy" litigation OR arbitration OR "force majeure" OR "curtailment dispute"', service_line: 'disputes' },

  // Market Strategy / Operational
  { query: '"solar farm" OR "wind farm" OR "battery storage" curtailment "negative pricing" OR "basis risk" United States', service_line: 'market_strategy' },
  { query: '"energy storage" OR "battery storage" acquisition OR bankruptcy OR "project cancellation" United States', service_line: 'market_strategy' },
  { query: '"clean energy" policy IRA OR "investment tax credit" OR "production tax credit" risk OR threat OR change 2025 2026', service_line: 'market_strategy' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const norm = (s: string) => s.toLowerCase().trim();

function containsAny(haystack: string, needles: string[]): boolean {
  const h = norm(haystack);
  return needles.some(n => h.includes(norm(n)));
}

// ── Keyword-based topic / sentiment classification ─────────────────────────────

const TOPIC_KEYWORDS: Record<string, string[]> = {
  outage:       ['outage', 'shutdown', 'offline', 'tripped', 'forced outage', 'unplanned', 'fire', 'explosion', 'blackout', 'curtailment'],
  regulatory:   ['ferc', 'epa', 'permit', 'violation', 'fine', 'penalty', 'compliance', 'regulation', 'puc', 'nrc', 'order', 'investigation'],
  financial:    ['acquisition', 'merger', 'deal', 'investment', 'financing', 'refinancing', 'ppa', 'power purchase', 'bankruptcy', 'default', 'debt', 'restructuring'],
  weather:      ['hurricane', 'tornado', 'wildfire', 'drought', 'extreme heat', 'winter storm', 'freeze', 'flooding'],
  construction: ['construction', 'commissioning', 'commercial operation', 'groundbreaking', 'capacity expansion', 'repowering', 'upgrade'],
};

const NEGATIVE_WORDS = [
  'outage', 'shutdown', 'fire', 'explosion', 'curtailment', 'fine', 'penalty',
  'violation', 'lawsuit', 'bankruptcy', 'default', 'delay', 'cancellation',
  'distress', 'restructuring', 'downgrade', 'loss', 'failure', 'failed',
];
const POSITIVE_WORDS = [
  'record', 'milestone', 'approved', 'award', 'expansion', 'commissioning',
  'investment', 'deal closed', 'acquisition completed', 'profit', 'upgrade',
];

function classifyTopics(text: string): string[] {
  const topics: string[] = [];
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (containsAny(text, keywords)) topics.push(topic);
  }
  return topics.length > 0 ? topics : ['other'];
}

function classifySentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const negCount = NEGATIVE_WORDS.filter(w => text.toLowerCase().includes(w)).length;
  const posCount = POSITIVE_WORDS.filter(w => text.toLowerCase().includes(w)).length;
  if (negCount > posCount) return 'negative';
  if (posCount > negCount) return 'positive';
  return 'neutral';
}

// ── NewsAPI fetch ──────────────────────────────────────────────────────────────

interface NewsApiArticle {
  title:       string | null;
  description: string | null;
  content:     string | null;
  url:         string;
  publishedAt: string;
  source:      { name: string | null };
}

async function fetchNewsApiArticles(
  query: string,
  apiKey: string,
  fromDate: string,
): Promise<NewsApiArticle[]> {
  const url = new URL(NEWSAPI_BASE);
  url.searchParams.set('q',          query);
  url.searchParams.set('language',   'en');
  url.searchParams.set('sortBy',     'publishedAt');
  url.searchParams.set('searchIn',   'title,description');
  url.searchParams.set('from',       fromDate);
  url.searchParams.set('pageSize',   String(PAGE_SIZE));
  url.searchParams.set('apiKey',     apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    console.warn(`NewsAPI error for query "${query.slice(0, 40)}…": ${res.status} ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return (data.articles ?? []).filter(
    (a: NewsApiArticle) => a.url && a.title && a.title !== '[Removed]'
  );
}

// ── LLM classification (Gemini Flash Lite) ─────────────────────────────────────

interface LLMClassification {
  event_type:           string;
  impact_tags:          string[];
  fti_relevance_tags:   string[];
  importance:           string;
  entity_company_names: string[];
}

function defaultClassification(): LLMClassification {
  return {
    event_type:           'none',
    impact_tags:          [],
    fti_relevance_tags:   [],
    importance:           'low',
    entity_company_names: [],
  };
}

async function classifyArticlesWithGemini(
  articles:      Array<{ title: string; description: string | null }>,
  geminiKey:     string,
  knownCompanies: string[],
  serviceLine:   string,
): Promise<LLMClassification[]> {
  const companyList  = knownCompanies.slice(0, 80).join(', ');
  const articlesText = articles
    .map((a, i) => `${i + 1}. Title: ${a.title}\n   Desc: ${a.description ?? 'N/A'}`)
    .join('\n');

  const prompt = `You are classifying energy sector news articles for a power generation analytics platform.
These articles were fetched via a "${serviceLine}" sector query.

For each article return a JSON object with these exact fields:
- event_type: one of outage|regulatory|financial|m_and_a|dispute|construction|policy|restructuring|none
- impact_tags: array from: distress|asset_sale|capacity_addition|curtailment|ppa_dispute|litigation|rate_case|community_opposition|environmental|market_entry
- fti_relevance_tags: array from: restructuring|transactions|disputes|market_strategy
- importance: low|medium|high  (use "high" for named company distress/M&A, "medium" for notable sector trends)
- entity_company_names: company/sponsor names found in article text, ONLY from: ${companyList}

Articles:
${articlesText}

Return ONLY a valid JSON array of exactly ${articles.length} objects. No markdown, no explanation.`;

  try {
    const res = await fetch(`${GEMINI_BASE}?key=${geminiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1500 },
      }),
    });

    if (!res.ok) {
      console.warn(`Gemini classify HTTP ${res.status}`);
      return articles.map(() => defaultClassification());
    }

    const data    = await res.json();
    const rawText: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed  = JSON.parse(cleaned);

    if (Array.isArray(parsed) && parsed.length === articles.length) {
      return parsed.map((r: Record<string, unknown>) => ({
        event_type:           typeof r.event_type === 'string' ? r.event_type : 'none',
        impact_tags:          Array.isArray(r.impact_tags)          ? (r.impact_tags as string[])          : [],
        fti_relevance_tags:   Array.isArray(r.fti_relevance_tags)   ? (r.fti_relevance_tags as string[])   : [],
        importance:           typeof r.importance === 'string'       ? r.importance                         : 'low',
        entity_company_names: Array.isArray(r.entity_company_names) ? (r.entity_company_names as string[]) : [],
      }));
    }

    console.warn(`Gemini unexpected array length: ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
  } catch (e) {
    console.warn('Gemini error:', e);
  }

  return articles.map(() => defaultClassification());
}

// ── Main handler ───────────────────────────────────────────────────────────────

Deno.serve(async (_req) => {
  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const newsApiKey     = Deno.env.get('NEWSAPI_KEY');
    const geminiApiKey   = Deno.env.get('GEMINI_API_KEY') ?? null;

    if (!newsApiKey) {
      return new Response(JSON.stringify({ error: 'NEWSAPI_KEY secret not set' }), { status: 500 });
    }
    if (!geminiApiKey) {
      console.warn('GEMINI_API_KEY not set — LLM classification skipped');
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    // ── Load known ult_parent names for Gemini entity linking ─────────────
    const { data: ownerData } = await supabase
      .from('plant_ownership')
      .select('ult_parent, owner');

    const knownUltParents: string[] = [...new Set(
      (ownerData ?? [])
        .map((o: { ult_parent: string | null; owner: string | null }) => o.ult_parent ?? o.owner)
        .filter((n): n is string => !!n && n.length >= 5)
    )].sort();

    // ── Load existing article IDs to skip re-fetching ─────────────────────
    const fromDate = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000)
      .toISOString().split('T')[0];

    const { data: existingRows } = await supabase
      .from('news_articles')
      .select('external_id')
      .gte('published_at', fromDate);
    const knownIds = new Set<string>(
      (existingRows ?? []).map((r: { external_id: string }) => r.external_id)
    );

    // ── Fetch articles for all sector queries ─────────────────────────────
    const toInsert: Array<Record<string, unknown> & { _service_line: string }> = [];

    for (const { query, service_line } of SECTOR_QUERIES) {
      const articles = await fetchNewsApiArticles(query, newsApiKey, fromDate);

      for (const article of articles) {
        const externalId = await sha256(article.url);
        if (knownIds.has(externalId)) continue;
        knownIds.add(externalId);

        const searchText = `${article.title ?? ''} ${article.description ?? ''} ${article.content ?? ''}`;
        const topics     = classifyTopics(searchText);
        const sentiment  = classifySentiment(searchText);

        toInsert.push({
          external_id:          externalId,
          title:                article.title ?? '',
          description:          article.description ?? null,
          content:              article.content ?? null,
          source_name:          article.source?.name ?? null,
          url:                  article.url,
          published_at:         article.publishedAt,
          query_tag:            `sector:${service_line}`,
          plant_codes:          [],   // sector articles are not attributed to specific plants
          owner_names:          [],
          states:               [],
          fuel_types:           [],
          topics,
          sentiment_label:      sentiment,
          // LLM fields — populated after collection loop
          event_type:           null  as string | null,
          impact_tags:          []    as string[],
          fti_relevance_tags:   []    as string[],
          importance:           'low',
          entity_company_names: []    as string[],
          llm_classified_at:    null  as string | null,
          // internal — stripped before upsert
          _service_line:        service_line,
        });
      }

      await new Promise(r => setTimeout(r, 350)); // polite delay between NewsAPI calls
    }

    console.log(`Sector queries complete: ${toInsert.length} new articles to classify`);

    // ── LLM batch classification grouped by service_line ──────────────────
    // Passing the service_line into the prompt so Gemini stays context-aware
    // (e.g. articles from a restructuring query should lean toward fti_relevance_tags: [restructuring])
    let llmCallCount = 0;

    if (geminiApiKey && toInsert.length > 0) {
      const now = new Date().toISOString();

      for (let i = 0; i < toInsert.length; i += LLM_BATCH_SIZE) {
        const batch       = toInsert.slice(i, i + LLM_BATCH_SIZE);
        // Use the service_line of the first article in the batch as context hint
        const batchLine   = batch[0]._service_line;
        const classified  = await classifyArticlesWithGemini(
          batch.map(r => ({ title: String(r.title), description: r.description as string | null })),
          geminiApiKey,
          knownUltParents,
          batchLine,
        );

        for (let j = 0; j < batch.length; j++) {
          const c = classified[j];
          batch[j].event_type           = c.event_type;
          batch[j].impact_tags          = c.impact_tags;
          batch[j].fti_relevance_tags   = c.fti_relevance_tags;
          batch[j].importance           = c.importance;
          batch[j].entity_company_names = c.entity_company_names;
          batch[j].llm_classified_at    = now;
        }
        llmCallCount++;

        if (i + LLM_BATCH_SIZE < toInsert.length) {
          await new Promise(r => setTimeout(r, 200));
        }
      }
    }

    // ── Strip internal helper field before upsert ─────────────────────────
    const rowsToUpsert = toInsert.map(({ _service_line: _sl, ...rest }) => rest);

    // ── Flush to news_articles ─────────────────────────────────────────────
    for (let i = 0; i < rowsToUpsert.length; i += BATCH_SIZE) {
      const batch = rowsToUpsert.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from('news_articles')
        .upsert(batch, { onConflict: 'external_id', ignoreDuplicates: true });
      if (error) console.error(`Sector upsert batch ${i} error:`, error.message);
    }

    // ── Update company_stats aggregate counts ─────────────────────────────
    // For each ult_parent mentioned this run, increment their article counts.
    // A lightweight version — the full stats refresh happens in Day 4.
    // We do a simple upsert to keep event_counts up to date in near-real-time.
    const mentionCounts = new Map<string, { total: number; byEventType: Record<string, number>; byFtiTag: Record<string, number> }>();

    for (const row of rowsToUpsert) {
      for (const company of (row.entity_company_names as string[])) {
        if (!company) continue;
        if (!mentionCounts.has(company)) {
          mentionCounts.set(company, { total: 0, byEventType: {}, byFtiTag: {} });
        }
        const m = mentionCounts.get(company)!;
        m.total++;
        const et = (row.event_type as string) ?? 'none';
        m.byEventType[et] = (m.byEventType[et] ?? 0) + 1;
        for (const tag of (row.fti_relevance_tags as string[])) {
          m.byFtiTag[tag] = (m.byFtiTag[tag] ?? 0) + 1;
        }
      }
    }

    // Upsert lightweight company_stats rows (only news-derived columns for now)
    // Full company_stats (MW, CF, plant_count) come from Day 4's company-stats-refresh function.
    const statsRows = [...mentionCounts.entries()].map(([name, counts]) => ({
      ult_parent_name:  name,
      event_counts:     counts.byEventType,
      relevance_scores: Object.fromEntries(
        Object.entries(counts.byFtiTag).map(([tag, n]) => [tag, n * 10]) // simple heuristic score
      ),
      computed_at:      new Date().toISOString(),
    }));

    if (statsRows.length > 0) {
      const { error: statsErr } = await supabase
        .from('company_stats')
        .upsert(statsRows, { onConflict: 'ult_parent_name', ignoreDuplicates: false });
      if (statsErr) console.warn('company_stats upsert error:', statsErr.message);
    }

    const result = {
      ok:                  true,
      queriesRun:          SECTOR_QUERIES.length,
      newArticles:         rowsToUpsert.length,
      llmCallsMade:        llmCallCount,
      companiesLinked:     mentionCounts.size,
      companyStatsUpdated: statsRows.length,
    };
    console.log('sector-news-ingest complete:', result);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('sector-news-ingest fatal:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
