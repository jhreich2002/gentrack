/**
 * GenTrack — plant-news-rank Edge Function
 *
 * Ranks, categorizes, and summarizes news articles for a specific plant.
 * Sits between news-ingest (upstream) and embed-articles (downstream).
 *
 * POST body:
 *   { eia_plant_code: string }          — rank unranked articles for this plant
 *   { eia_plant_code: string, mode: "rescoring" }  — rescore all articles (12–18 mo)
 *   { batch: true, limit?: number }     — rank unranked articles across all plants
 *
 * Pipeline position:
 *   news-ingest → plant-news-rank → embed-articles → compute-ratings
 *
 * What it does:
 *   1. Loads plant metadata (name, owner, operator, fuel, state, ISO/RTO, curtailment info)
 *   2. Loads articles for that plant (unranked, or all for rescoring)
 *   3. Sends them to Gemini with a structured ranking prompt
 *   4. Parses the response and updates news_articles rows + plant_news_state
 *
 * Required secrets:
 *   GEMINI_API_KEY            — Gemini API key
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ──────────────────────────────────────────────────────────────────

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const MAX_ARTICLES_PER_CALL = 25;   // stay well within context window + output limits
const RESCORING_MONTHS = 18;        // lookback for rescoring mode
const BATCH_PLANT_LIMIT = 10;       // max plants per batch run

// ── Supabase client ────────────────────────────────────────────────────────────

function makeSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface PlantMeta {
  eia_plant_code: string;
  name: string;
  owner: string;
  operator: string;
  fuel_source: string;
  state: string;
  iso_rto: string;
  is_likely_curtailed: boolean;
  curtailment_score: number | null;
  curtailment_rank: number | null;
  nameplate_capacity_mw: number;
}

interface ArticleRow {
  id: string;
  title: string;
  description: string | null;
  content: string | null;
  url: string;
  published_at: string;
  source_name: string | null;
}

interface RankedArticle {
  id: string;
  asset_linkage_tier: 'high' | 'medium' | 'none';
  asset_linkage_rationale: string;
  curtailment_relevant: boolean;
  curtailment_rationale: string;
  relevance_score: number;
  include_for_embedding: boolean;
  categories: string[];
  tags: string[];
  article_summary: string | null;
}

interface RankingResult {
  asset_id: string;
  plant_name: string;
  articles: RankedArticle[];
  plant_summary: string;
}

// ── Build ranking prompt ───────────────────────────────────────────────────────

function buildRankingPrompt(plant: PlantMeta, articles: ArticleRow[], mode: string): string {
  const asset = {
    plant_name: plant.name,
    eia_plant_id: plant.eia_plant_code,
    owner: plant.owner ?? '',
    operator: plant.operator ?? plant.owner ?? '',
    fuel_type: plant.fuel_source ?? '',
    state: plant.state ?? '',
    iso_rto: plant.iso_rto ?? '',
    curtailment_status: plant.is_likely_curtailed ? 'curtailed' : 'not_curtailed',
    curtailment_rank: plant.curtailment_rank,
    has_full_generation_window: true,
  };

  const articleList = articles.map(a => ({
    id: a.id,
    title: a.title,
    description: a.description ?? '',
    full_text: (a.content ?? a.description ?? '').slice(0, 1500),
    url: a.url,
    published_at: a.published_at,
    source: a.source_name ?? 'Other',
  }));

  const inputPayload = JSON.stringify({
    asset,
    articles: articleList,
    time_window_months: RESCORING_MONTHS,
    mode,
  });

  return `You are an AI assistant that ranks and structures news articles for a US power plant analytics application.

CONTEXT
- The app ingests generation data for US power plants, identifies curtailed assets, and displays plant-level analytics.
- Your job is to process already-fetched, already-deduplicated news articles for a specific plant, decide which are relevant, categorize them, and produce summaries suitable for UI display and embeddings.
- All RSS search logic, source selection, and deduplication are handled upstream. DO NOT reason about RSS queries or deduplication; assume your inputs are already deduplicated search results for the target plant.

PRE-FILTER ASSUMPTIONS
- Upstream logic only sends you articles where the PLANT NAME appears somewhere in the title, description, or body. You do NOT need to check for plant name presence.
- The article may also mention the owner or operator; you should only treat that as linking to this plant if the text clearly indicates it refers to this specific facility (matching location, technology, capacity, or other unique details).
- Generic corporate news about the owner/operator that does NOT clearly tie to this plant should be treated as low or no relevance.

TASKS
For the given asset and article list, you must:

1) DETERMINE ASSET LINKAGE FOR EACH ARTICLE
An article is HIGHLY related if:
- It explicitly mentions the plant name or a unique variant of it in a way that clearly matches this facility, OR
- It describes a project whose location, technology, and ownership obviously match this plant, OR
- It covers a grid event, outage, curtailment, or congestion where the plant is explicitly named.

MODERATELY related if:
- It mentions the owner or operator together with clearly matching project geography and technology, but the plant name is ambiguous, OR
- It covers regulatory, transmission, congestion, or market events that directly affect this plant's ISO/RTO or region and mention this plant in passing.

NOT related if:
- It only discusses the owner/operator in a generic corporate context with no clear link to this plant, OR
- It covers other plants or projects with different names, locations, or technologies and does not clearly implicate this one.

2) DETERMINE CURTAILMENT RELEVANCE
Detect whether an article is specifically about curtailment, congestion, or forced reduction of output for THIS plant.
OVERRIDE RULE: If curtailment_relevant = true AND asset_linkage_tier ≠ "none", the article MUST be included_for_embedding = true with relevance_score >= 0.70.

3) RELEVANCE SCORING (0.0–1.0)
Score bands:
- 0.80–1.00: high importance, should be embedded and shown prominently.
- 0.60–0.79: solidly relevant; show and embed if linked to the plant.
- 0.30–0.59: weak relevance or mostly background; usually exclude from embedding.
- 0.00–0.29: low or no relevance; exclude entirely.
Rules:
- If asset_linkage_tier = "none" → relevance_score < 0.3, include_for_embedding = false.
- If curtailment_relevant = true AND asset_linkage_tier ≠ "none" → relevance_score >= 0.70.

4) INCLUDE/EXCLUDE FOR EMBEDDING AND UI
- include_for_embedding = true if:
  - asset_linkage_tier = "high" AND relevance_score >= 0.60, OR
  - asset_linkage_tier = "medium" AND relevance_score >= 0.75.
- EXCEPTION: curtailment_relevant = true AND asset_linkage_tier ≠ "none" → always include.
- De-prioritize very short, low-information items unless curtailment-related.

5) CATEGORIZE AND TAG
Categories (1–3 per article): "operations_outages", "curtailment_congestion", "financing_capital", "ownership_MA", "contracts_offtake", "regulation_policy_permitting", "development_construction", "technology_assets", "macro_market", "other"
Tags: free-text strings summarizing key concepts, locations, counterparties, or issues.

6) ARTICLE-LEVEL SUMMARIES
For each article where include_for_embedding = true, produce article_summary (1–3 sentences): what happened, how it relates to THIS plant, why it matters. Concise, neutral, information-dense.

7) PLANT-LEVEL SUMMARY
Using ONLY articles where include_for_embedding = true, generate plant_summary (3–6 sentences):
- Highlight most important developments in last ~12–18 months
- Emphasize operational and curtailment issues first
- Group related events
- Remain neutral and factual

${mode === 'rescoring' ? `8) RESCORING CONTEXT
This is a RESCORING run. The plant's curtailment status or rank may have changed. You may raise relevance_score and change include_for_embedding from false → true if an article becomes more important under the new context. Surface historic curtailment/congestion articles that now meet the rules.` : ''}

INPUT DATA:
${inputPayload}

OUTPUT FORMAT
Return ONLY valid JSON (no markdown fences, no commentary) with this shape:
{
  "asset_id": "${plant.eia_plant_code}",
  "plant_name": "${plant.name}",
  "articles": [
    {
      "id": "article-uuid",
      "asset_linkage_tier": "high|medium|none",
      "asset_linkage_rationale": "...",
      "curtailment_relevant": true_or_false,
      "curtailment_rationale": "...",
      "relevance_score": 0.0_to_1.0,
      "include_for_embedding": true_or_false,
      "categories": ["...", "..."],
      "tags": ["...", "..."],
      "article_summary": "..." 
    }
  ],
  "plant_summary": "..."
}

REQUIREMENTS:
- Do NOT invent details not grounded in the article text and provided metadata.
- Be conservative linking generic owner/operator news to a specific plant.
- Prioritize recall over extreme precision, but exclude clearly irrelevant noise.
- ALWAYS embed and show clearly plant-linked curtailment or congestion articles.
- Keep rationales and summaries short, specific, and information-dense.
- article_summary is required if include_for_embedding = true, null otherwise.`;
}

// ── Call Gemini ─────────────────────────────────────────────────────────────────

async function callGeminiRanking(
  geminiKey: string,
  prompt: string,
): Promise<RankingResult> {
  const resp = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 65536,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini HTTP ${resp.status}: ${errText}`);
  }

  const body = await resp.json();

  // Gemini 2.5 Flash may include thinking parts — pick the text part
  let raw = '';
  for (const part of (body?.candidates?.[0]?.content?.parts ?? [])) {
    if (part.text && !part.thought) raw = part.text;
  }

  // Strip optional markdown fences
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  return JSON.parse(raw) as RankingResult;
}

// ── Validate and sanitize LLM output ───────────────────────────────────────────

const VALID_CATEGORIES = new Set([
  'operations_outages', 'curtailment_congestion', 'financing_capital',
  'ownership_MA', 'contracts_offtake', 'regulation_policy_permitting',
  'development_construction', 'technology_assets', 'macro_market', 'other',
]);

const VALID_TIERS = new Set(['high', 'medium', 'none']);

function sanitizeResult(result: RankingResult, validIds: Set<string>): RankingResult {
  result.articles = result.articles
    .filter(a => validIds.has(a.id))
    .map(a => {
      // Clamp tier
      if (!VALID_TIERS.has(a.asset_linkage_tier)) {
        a.asset_linkage_tier = 'none';
      }

      // Clamp relevance_score
      a.relevance_score = Math.max(0, Math.min(1, Number(a.relevance_score) || 0));

      // Enforce rules: none → low score, no embedding
      if (a.asset_linkage_tier === 'none') {
        a.relevance_score = Math.min(a.relevance_score, 0.29);
        a.include_for_embedding = false;
      }

      // Enforce curtailment override
      if (a.curtailment_relevant && a.asset_linkage_tier !== 'none') {
        a.relevance_score = Math.max(a.relevance_score, 0.70);
        a.include_for_embedding = true;
      }

      // Enforce embedding rules
      if (a.asset_linkage_tier === 'high' && a.relevance_score >= 0.60) {
        a.include_for_embedding = true;
      }
      if (a.asset_linkage_tier === 'medium' && a.relevance_score >= 0.75) {
        a.include_for_embedding = true;
      }

      // Sanitize categories
      a.categories = (a.categories ?? []).filter(c => VALID_CATEGORIES.has(c));
      if (a.categories.length === 0) a.categories = ['other'];

      // Sanitize tags
      a.tags = (a.tags ?? []).map(t => String(t).slice(0, 100));

      // Ensure summary for embedded articles
      if (a.include_for_embedding && !a.article_summary) {
        a.article_summary = a.asset_linkage_rationale ?? '';
      }
      if (!a.include_for_embedding) {
        a.article_summary = null;
      }

      return a;
    });

  return result;
}

// ── Load plant metadata ────────────────────────────────────────────────────────

async function loadPlantMeta(
  sb: ReturnType<typeof createClient>,
  eiaPlantCode: string,
): Promise<PlantMeta | null> {
  const { data, error } = await sb
    .from('plants')
    .select(`
      eia_plant_code, name, owner, fuel_source, state,
      is_likely_curtailed, curtailment_score,
      nameplate_capacity_mw
    `)
    .eq('eia_plant_code', eiaPlantCode)
    .single();

  if (error || !data) return null;

  // Compute a rough curtailment rank from curtailment_score
  // (actual rank is computed across the fleet, but for the prompt we approximate)
  let curtailment_rank: number | null = null;
  if (data.is_likely_curtailed && data.curtailment_score) {
    const { count } = await sb
      .from('plants')
      .select('eia_plant_code', { count: 'exact', head: true })
      .eq('is_likely_curtailed', true)
      .gt('curtailment_score', data.curtailment_score);
    curtailment_rank = (count ?? 0) + 1;
  }

  return { ...data, curtailment_rank, operator: data.owner ?? '', iso_rto: '' } as PlantMeta;
}

// ── Load articles for ranking ──────────────────────────────────────────────────

async function loadArticlesForPlant(
  sb: ReturnType<typeof createClient>,
  eiaPlantCode: string,
  mode: string,
): Promise<ArticleRow[]> {
  let query = sb
    .from('news_articles')
    .select('id, title, description, content, url, published_at, source_name')
    .contains('plant_codes', [eiaPlantCode])
    .order('published_at', { ascending: false });

  if (mode === 'rescoring') {
    // Rescore all articles within the time window
    const cutoff = new Date(Date.now() - RESCORING_MONTHS * 30 * 86400_000).toISOString();
    query = query.gte('published_at', cutoff);
  } else {
    // Only unranked articles
    query = query.is('ranked_at', null);
  }

  query = query.limit(MAX_ARTICLES_PER_CALL);

  const { data, error } = await query;
  if (error) {
    console.error(`Failed to load articles for ${eiaPlantCode}:`, error.message);
    return [];
  }
  return (data ?? []) as ArticleRow[];
}

// ── Persist ranking results ────────────────────────────────────────────────────

async function persistRankings(
  sb: ReturnType<typeof createClient>,
  result: RankingResult,
  eiaPlantCode: string,
): Promise<{ updated: number; errors: number }> {
  let updated = 0;
  let errors = 0;
  const now = new Date().toISOString();

  for (const a of result.articles) {
    const { error } = await sb
      .from('news_articles')
      .update({
        asset_linkage_tier:      a.asset_linkage_tier,
        asset_linkage_rationale: a.asset_linkage_rationale,
        curtailment_relevant:    a.curtailment_relevant,
        curtailment_rationale:   a.curtailment_rationale,
        relevance_score:         a.relevance_score,
        include_for_embedding:   a.include_for_embedding,
        categories:              a.categories,
        tags:                    a.tags,
        article_summary:         a.article_summary,
        ranked_at:               now,
      })
      .eq('id', a.id);

    if (error) {
      console.error(`Update failed for article ${a.id}:`, error.message);
      errors++;
    } else {
      updated++;
    }
  }

  // Upsert plant_news_state with the new plant_summary
  if (result.plant_summary) {
    const { error: stateErr } = await sb
      .from('plant_news_state')
      .upsert({
        eia_plant_code:     eiaPlantCode,
        plant_summary:      result.plant_summary,
        ranking_last_run_at: now,
        updated_at:         now,
      }, { onConflict: 'eia_plant_code' });

    if (stateErr) {
      console.error(`plant_news_state upsert error:`, stateErr.message);
    }
  }

  return { updated, errors };
}

// ── Rank a single plant ────────────────────────────────────────────────────────

async function rankPlant(
  sb: ReturnType<typeof createClient>,
  geminiKey: string,
  eiaPlantCode: string,
  mode: string,
): Promise<{
  plant: string;
  articlesProcessed: number;
  articlesIncluded: number;
  updated: number;
  errors: number;
}> {
  const plant = await loadPlantMeta(sb, eiaPlantCode);
  if (!plant) throw new Error(`Plant ${eiaPlantCode} not found`);

  const articles = await loadArticlesForPlant(sb, eiaPlantCode, mode);
  if (articles.length === 0) {
    return { plant: plant.name, articlesProcessed: 0, articlesIncluded: 0, updated: 0, errors: 0 };
  }

  const prompt = buildRankingPrompt(plant, articles, mode);
  const rawResult = await callGeminiRanking(geminiKey, prompt);

  const validIds = new Set(articles.map(a => a.id));
  const result = sanitizeResult(rawResult, validIds);

  const { updated, errors } = await persistRankings(sb, result, eiaPlantCode);
  const articlesIncluded = result.articles.filter(a => a.include_for_embedding).length;

  return {
    plant: plant.name,
    articlesProcessed: articles.length,
    articlesIncluded,
    updated,
    errors,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not set' }), { status: 500, headers: CORS });
  }

  let body: { eia_plant_code?: string; mode?: string; batch?: boolean; limit?: number };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS });
  }

  const sb = makeSupabase();

  // ── Batch mode: rank unranked articles across multiple plants ────────────
  if (body.batch) {
    try {
      // Find plants that have unranked articles
      const { data: plantCodes } = await sb
        .from('news_articles')
        .select('plant_codes')
        .is('ranked_at', null)
        .limit(200);

      // Extract unique plant codes
      const uniqueCodes = new Set<string>();
      for (const row of (plantCodes ?? [])) {
        for (const code of (row.plant_codes ?? [])) {
          uniqueCodes.add(code);
        }
      }

      const codes = [...uniqueCodes].slice(0, body.limit ?? BATCH_PLANT_LIMIT);
      console.log(`Batch ranking ${codes.length} plants with unranked articles`);

      const results = [];
      for (const code of codes) {
        try {
          const r = await rankPlant(sb, geminiKey, code, 'initial_backfill');
          results.push(r);
          console.log(`Ranked ${r.plant}: ${r.articlesProcessed} articles, ${r.articlesIncluded} included`);
        } catch (err) {
          console.error(`Failed to rank plant ${code}:`, err);
          results.push({ plant: code, error: String(err) });
        }
        // Rate limit between Gemini calls
        await new Promise(r => setTimeout(r, 1000));
      }

      return new Response(JSON.stringify({ ok: true, results }), { headers: CORS });
    } catch (err) {
      console.error('Batch ranking error:', err);
      return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
    }
  }

  // ── Single-plant mode ───────────────────────────────────────────────────
  const { eia_plant_code, mode = 'incremental' } = body;
  if (!eia_plant_code) {
    return new Response(JSON.stringify({ error: 'eia_plant_code is required (or set batch=true)' }), {
      status: 400, headers: CORS,
    });
  }

  try {
    const result = await rankPlant(sb, geminiKey, eia_plant_code, mode);
    return new Response(JSON.stringify({ ok: true, ...result }), { headers: CORS });
  } catch (err) {
    console.error(`plant-news-rank error for ${eia_plant_code}:`, err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
