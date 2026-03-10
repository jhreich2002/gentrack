/**
 * GenTrack — news-ingest Edge Function (Tavily Search + Gemini Classification)
 *
 * Fetches news for curtailed power plants using Tavily search, then runs
 * a single batched Gemini Flash call per group of articles to classify
 * sentiment, event type, importance, impact tags, and entity names.
 *
 * Plant selection:
 *   - is_likely_curtailed = true (underperforming vs regional peers by >20%)
 *   - trailing_zero_months = 0   (generated every month of last year)
 *   - is_maintenance_offline = false (not an explained outage)
 *
 * Tiered refresh:
 *   - Tier 1: Top 100 curtailed plants by score + size (>100 MW) — daily
 *   - Tier 2: Next 200 curtailed plants (≤100 MW) — Mon/Thu
 *
 * Cost estimate: ~$3.65/month (Tavily $1/1K + Gemini Flash sentiment ~free)
 *
 * Required secrets:
 *   TAVILY_API_KEY            — tavily.com API key
 *   GEMINI_API_KEY            — Google AI Studio key
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

const TIER_1_SIZE       = 100;   // top curtailed plants >100 MW, daily
const TIER_2_SIZE       = 200;   // smaller curtailed plants ≤100 MW, Mon/Thu
const ARTICLES_PER_PLANT = 5;
const CLASSIFY_BATCH    = 20;    // articles per Gemini classification call
const UPSERT_BATCH      = 50;
const RATE_LIMIT_MS     = 500;   // Tavily is cheaper, can run faster

const TAVILY_URL  = 'https://api.tavily.com/search';
const GEMINI_URL  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlantInfo {
  eia_plant_code:       string;
  name:                 string;
  owner:                string;
  state:                string;
  fuel_source:          string;
  curtailment_score:    number;
  nameplate_capacity_mw: number;
  is_maintenance_offline: boolean;
}

interface TavilyArticle {
  title:          string;
  url:            string;
  content:        string;   // snippet returned by Tavily
  published_date: string | null;
  score:          number;
}

interface StagedArticle extends TavilyArticle {
  plant_code: string;
  owner:      string;
  state:      string;
  fuel_type:  string;
  url_hash:   string;
}

interface ClassifiedArticle extends StagedArticle {
  sentiment_label:      string;
  sentiment_score:      number;
  event_type:           string;
  importance:           string;
  impact_tags:          string[];
  entity_company_names: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Tavily Search ─────────────────────────────────────────────────────────────

async function searchTavily(
  plant: PlantInfo,
  tavilyKey: string,
): Promise<TavilyArticle[]> {
  // Use two complementary queries: general news + financing/lender focus
  const queries = [
    `"${plant.name}" ${plant.state} power plant curtailment regulatory financial`,
    `"${plant.name}" ${plant.state} power plant financing lender loan`,
  ];

  const seen = new Set<string>();
  const results: TavilyArticle[] = [];

  for (const query of queries) {
    if (results.length >= ARTICLES_PER_PLANT) break;

    try {
      const res = await fetch(TAVILY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key:      tavilyKey,
          query,
          search_depth: 'basic',
          max_results:  ARTICLES_PER_PLANT,
          include_answer: false,
        }),
      });

      if (!res.ok) {
        console.error(`Tavily error for ${plant.name}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const r of (data.results ?? [])) {
        if (!r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        results.push({
          title:          String(r.title ?? '').trim(),
          url:            String(r.url).trim(),
          content:        String(r.content ?? '').trim(),
          published_date: r.published_date ?? null,
          score:          r.score ?? 0,
        });
      }
    } catch (e) {
      console.error(`Tavily fetch error for ${plant.name}:`, e);
    }
  }

  return results;
}

// ── Gemini Batch Classification ───────────────────────────────────────────────

async function classifyAndExtractBatch(
  articles: StagedArticle[],
  geminiKey: string,
): Promise<ClassifiedArticle[]> {
  if (articles.length === 0) return [];

  const articleList = articles
    .map((a, i) =>
      `[${i}] Title: ${a.title}\nContent: ${a.content.slice(0, 400)}`
    )
    .join('\n\n');

  const prompt = `You are helping a power plant consulting firm assess business intelligence from news articles about curtailed power plants. Consulting opportunities include: operational improvement, regulatory advisory, financial restructuring, and lender engagement.

Classify each article and extract key entities. For each article return:
- sentiment: "positive" | "negative" | "neutral" (from the plant owner/lender perspective)
- sentiment_score: 0.0–1.0 confidence
- event_type: one of "curtailment" | "regulatory" | "financial" | "operational" | "construction" | "weather" | "grid" | "other"
- importance: "high" | "medium" | "low" (to a consulting firm prospecting this plant)
- impact_tags: array of relevant tags from ["curtailment", "grid-congestion", "ppa-issue", "debt-covenant", "refinancing", "lender-mention", "regulatory-action", "permit-issue", "outage", "capacity-reduction", "financial-distress", "ownership-change"]
- entity_company_names: array of company names mentioned (owners, operators, lenders, financiers, regulators)

Return ONLY a JSON array, no other text:
[{"index":0,"sentiment":"negative","sentiment_score":0.8,"event_type":"regulatory","importance":"high","impact_tags":["regulatory-action"],"entity_company_names":["NextEra Energy"]}, ...]

Articles to classify:
${articleList}`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.0, maxOutputTokens: 2048 },
      }),
    });

    if (!res.ok) {
      console.error(`Gemini classification HTTP ${res.status}`);
      return articles.map(a => ({ ...a, ...defaultClassification() }));
    }

    const data = await res.json();

    // Gemini 2.5 Flash may include thinking parts — skip those
    let raw = '';
    for (const part of (data?.candidates?.[0]?.content?.parts ?? [])) {
      if (part.text && !part.thought) raw = part.text;
    }

    const start = raw.indexOf('[');
    const end   = raw.lastIndexOf(']');
    if (start === -1 || end === -1) {
      console.error('Gemini returned no JSON array for classification');
      return articles.map(a => ({ ...a, ...defaultClassification() }));
    }

    const parsed: Array<{
      index: number;
      sentiment: string;
      sentiment_score: number;
      event_type: string;
      importance: string;
      impact_tags: string[];
      entity_company_names: string[];
    }> = JSON.parse(raw.slice(start, end + 1));

    return articles.map((a, i) => {
      const c = parsed.find(p => p.index === i);
      if (!c) return { ...a, ...defaultClassification() };
      return {
        ...a,
        sentiment_label:      ['positive', 'negative', 'neutral'].includes(c.sentiment) ? c.sentiment : 'neutral',
        sentiment_score:      typeof c.sentiment_score === 'number' ? c.sentiment_score : 0.5,
        event_type:           c.event_type ?? 'other',
        importance:           ['high', 'medium', 'low'].includes(c.importance) ? c.importance : 'medium',
        impact_tags:          Array.isArray(c.impact_tags) ? c.impact_tags : [],
        entity_company_names: Array.isArray(c.entity_company_names) ? c.entity_company_names : [],
      };
    });
  } catch (e) {
    console.error('Gemini classification error:', e);
    return articles.map(a => ({ ...a, ...defaultClassification() }));
  }
}

function defaultClassification() {
  return {
    sentiment_label:      'neutral',
    sentiment_score:      0.5,
    event_type:           'other',
    importance:           'medium',
    impact_tags:          [] as string[],
    entity_company_names: [] as string[],
  };
}

// ── Main Handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  try {
    const tavilyKey = Deno.env.get('TAVILY_API_KEY');
    const geminiKey = Deno.env.get('GEMINI_API_KEY');

    if (!tavilyKey) return new Response(JSON.stringify({ error: 'TAVILY_API_KEY not set' }), { status: 500 });
    if (!geminiKey) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not set' }), { status: 500 });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Determine tier from query param or time of day
    const url      = new URL(req.url);
    const tierParam = url.searchParams.get('tier');
    const hour     = new Date().getUTCHours();
    const dow      = new Date().getUTCDay();

    let tier: 1 | 2;
    if (tierParam) {
      tier = parseInt(tierParam) as 1 | 2;
    } else {
      tier = (hour < 10 || (dow !== 1 && dow !== 4)) ? 1 : 2;
    }

    console.log(`news-ingest starting: tier=${tier}`);

    // ── Load curtailed plants ──────────────────────────────────────────────────
    // Tier 1: >100 MW curtailed plants (daily)
    // Tier 2: ≤100 MW curtailed plants (Mon/Thu)
    const baseQuery = supabase
      .from('plants')
      .select('eia_plant_code, name, owner, state, fuel_source, curtailment_score, nameplate_capacity_mw, is_maintenance_offline')
      .eq('is_likely_curtailed', true)
      .eq('is_maintenance_offline', false)
      .eq('trailing_zero_months', 0)
      .neq('eia_plant_code', '99999')
      .order('curtailment_score', { ascending: false })
      .order('nameplate_capacity_mw', { ascending: false });

    const { data: plantsData, error: plantsErr } = await (
      tier === 1
        ? baseQuery.gt('nameplate_capacity_mw', 100).limit(TIER_1_SIZE)
        : baseQuery.lte('nameplate_capacity_mw', 100).limit(TIER_2_SIZE)
    );

    if (plantsErr || !plantsData) {
      throw new Error(`Failed to load plants: ${plantsErr?.message}`);
    }

    const plants = plantsData as PlantInfo[];

    console.log(`Processing ${plants.length} tier-${tier} curtailed plants`);

    // ── Load existing URLs to skip duplicates (last 90 days) ──────────────────
    const { data: existingData } = await supabase
      .from('news_articles')
      .select('url')
      .gte('created_at', new Date(Date.now() - 90 * 86400_000).toISOString());

    const existingUrls = new Set((existingData ?? []).map((r: { url: string }) => r.url));

    // ── Fetch articles via Tavily ─────────────────────────────────────────────
    const staged: StagedArticle[] = [];
    let tavilyCalls = 0;

    for (const plant of plants) {
      const articles = await searchTavily(plant, tavilyKey);
      tavilyCalls += 2; // two queries per plant

      for (const a of articles) {
        if (existingUrls.has(a.url)) continue;
        existingUrls.add(a.url);
        staged.push({
          ...a,
          plant_code: plant.eia_plant_code,
          owner:      plant.owner ?? '',
          state:      plant.state ?? '',
          fuel_type:  plant.fuel_source ?? '',
          url_hash:   '',  // filled below
        });
      }

      await sleep(RATE_LIMIT_MS);
    }

    // Compute url hashes
    for (const a of staged) {
      a.url_hash = await sha256(a.url);
    }

    console.log(`Found ${staged.length} new articles from ${tavilyCalls} Tavily calls`);

    // ── Classify in batches ───────────────────────────────────────────────────
    const classified: ClassifiedArticle[] = [];

    for (let i = 0; i < staged.length; i += CLASSIFY_BATCH) {
      const batch = staged.slice(i, i + CLASSIFY_BATCH);
      const results = await classifyAndExtractBatch(batch, geminiKey);
      classified.push(...results);
      if (i + CLASSIFY_BATCH < staged.length) await sleep(500);
    }

    // ── Upsert to news_articles ───────────────────────────────────────────────
    const rows = classified.map(a => ({
      external_id:          a.url_hash,
      title:                a.title,
      description:          a.content || null,
      content:              null,
      source_name:          new URL(a.url).hostname.replace('www.', ''),
      url:                  a.url,
      published_at:         a.published_date ?? null,
      query_tag:            `curtailed:${a.plant_code}`,
      plant_codes:          [a.plant_code],
      owner_names:          a.owner ? [a.owner] : [],
      states:               a.state ? [a.state] : [],
      fuel_types:           a.fuel_type ? [a.fuel_type] : [],
      topics:               [],
      sentiment_label:      a.sentiment_label,
      sentiment_score:      a.sentiment_score,
      event_type:           a.event_type,
      importance:           a.importance,
      impact_tags:          a.impact_tags,
      fti_relevance_tags:   [],
      entity_company_names: a.entity_company_names,
      llm_classified_at:    new Date().toISOString(),
    }));

    let inserted = 0;
    let errors   = 0;

    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const { error } = await supabase
        .from('news_articles')
        .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: 'external_id', ignoreDuplicates: true });

      if (error) {
        console.error(`Upsert error at ${i}:`, error.message);
        errors++;
      } else {
        inserted += Math.min(UPSERT_BATCH, rows.length - i);
      }
    }

    const result = {
      ok:               true,
      tier,
      plantsProcessed:  plants.length,
      tavilyCalls,
      articlesFound:    staged.length,
      articlesInserted: inserted,
      errors,
    };

    console.log('news-ingest complete:', result);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('news-ingest fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
