/**
 * GenTrack — lender-news-rank Edge Function
 *
 * Ranks, categorizes, and summarizes financing/lender articles for
 * power plants. Focuses on lender, sponsor, and tax equity relevance.
 *
 * POST body:
 *   { eia_plant_code: string }          — rank unranked financing articles for this plant
 *   { eia_plant_code: string, mode: "rescoring" }  — rescore all financing articles (18 mo)
 *   { batch: true, limit?: number }     — rank unranked financing articles across all plants
 *
 * Pipeline position:
 *   lender-ingest → lender-news-rank → embed-articles → compute-ratings
 *
 * Required secrets:
 *   GEMINI_API_KEY            — Gemini API key
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ──────────────────────────────────────────────────────────────────

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const MAX_ARTICLES_PER_CALL = 25;
const RESCORING_MONTHS = 18;
const BATCH_PLANT_LIMIT = 10;

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
  fuel_source: string;
  state: string;
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
  financing_relevant: boolean;
  financing_rationale: string;
  relevance_score: number;
  include_for_embedding: boolean;
  categories: string[];
  tags: string[];
  article_summary: string | null;
  lender_entity_names?: string[];  // named financing counterparties for entity_company_names
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
    fuel_type: plant.fuel_source ?? '',
    state: plant.state ?? '',
    nameplate_mw: plant.nameplate_capacity_mw,
    curtailment_status: plant.is_likely_curtailed ? 'curtailed' : 'not_curtailed',
    curtailment_rank: plant.curtailment_rank,
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

  const today = new Date().toISOString().split('T')[0];

  const inputPayload = JSON.stringify({
    current_date: today,
    asset,
    articles: articleList,
    time_window_months: RESCORING_MONTHS,
    mode,
  });

  return `You are an AI assistant that ranks financing and lender news articles for a US power plant prospecting application used by lenders, sponsors, and tax equity investors.

TODAY'S DATE: ${today}

PURPOSE
The app tracks US power plants that show signs of curtailment or underperformance. Users are lenders, tax equity investors, project sponsors, and asset managers who need to understand:
- Who are the lenders, tax equity providers, sponsors, or financing parties for this plant
- Refinancing events, credit facility changes, covenant amendments, or debt restructuring
- Tax equity structuring (ITC, PTC), transfer elections, or tax credit monetization
- Sponsor or ownership changes, project sales, M&A, portfolio transactions
- Construction financing, cost overruns, COD delays, budget changes
- Default risk, credit rating changes, guarantee modifications
- PPA or offtake contract activity, pricing changes, counterparty creditworthiness
- Regulatory or policy changes that affect project economics or financing viability

IMPORTANT: UPSTREAM SEARCH IS NOISY
Articles were fetched via RSS keyword search using financing terms + plant name/owner. Many results are NOT actually about this plant's financing. Common false matches include:
- Articles about the owner's OTHER plants or corporate-level treasury operations
- Generic renewables industry financing trend pieces not about this specific project
- Articles about a DIFFERENT project in the same region with similar naming
- Press releases about unrelated financial products from a similarly-named entity
- ESG/sustainability press that mentions financing buzzwords but has no deal specifics

You MUST independently verify that each article discusses financing, lending, or capital markets activity for THIS specific plant.

TASKS
For the given asset and article list:

1) DETERMINE ASSET LINKAGE
HIGH — Article is clearly about THIS plant's financing:
- Names this plant (or obvious variant) and discusses its financing, lending, or capital structure
- Describes a financing transaction whose project location, technology, capacity, and ownership match this plant
- Names a lender, tax equity investor, sponsor, or financing party for THIS specific plant
- Covers a refinancing, default, credit event, or covenant change for THIS plant

MEDIUM — Article likely relates to this plant's financing but the link is indirect:
- Mentions the owner/operator with matching geography and technology in a financing context, but plant name is ambiguous
- Covers a portfolio-level financing that includes this plant among others
- Discusses regulatory/tax policy changes that specifically affect this plant's financing structure (e.g., ITC/PTC changes for this type of plant in this state)

NONE — Article is NOT about this plant's financing:
- Discusses the owner/developer's corporate financing generically
- Covers a DIFFERENT plant or project, even if in the same region
- Is a general industry trend piece about renewable energy financing without project-specific detail
- Discusses financing terms or markets broadly without naming this facility

WHEN IN DOUBT: Default to "none" unless the article clearly names this plant or a uniquely identifying combination of owner + location + capacity + technology in a financing context.

2) FINANCING RELEVANCE
Is the article specifically about a financing event, lender relationship, tax equity structure, or capital markets transaction for THIS plant?
OVERRIDE: If financing_relevant = true AND asset_linkage_tier ≠ "none" → include_for_embedding = true, relevance_score >= 0.70.

3) RELEVANCE SCORING (0.0–1.0)
- 0.80–1.00: Directly about this plant's financing, names specific lenders or deal terms. Embed and show prominently.
- 0.60–0.79: Relevant financing context for this plant. Embed if asset_linkage_tier is high.
- 0.30–0.59: Tangential financing mention. Usually exclude.
- 0.00–0.29: Not about this plant's financing. Exclude entirely.
Rules:
- asset_linkage_tier = "none" → relevance_score < 0.3, include_for_embedding = false.
- financing_relevant = true AND asset_linkage_tier ≠ "none" → relevance_score >= 0.70.

4) INCLUDE/EXCLUDE FOR EMBEDDING
- include_for_embedding = true if:
  - asset_linkage_tier = "high" AND relevance_score >= 0.60, OR
  - asset_linkage_tier = "medium" AND relevance_score >= 0.75.
- EXCEPTION: financing_relevant = true AND asset_linkage_tier ≠ "none" → always include.

5) CATEGORIZE AND TAG
Categories (1–3): "refinancing", "credit_facility", "tax_equity", "sponsor_change", "project_sale", "credit_rating", "construction_financing", "ppa_offtake", "regulatory_impact", "default_risk"
Tags: free-text strings — lender names, bank names, fund names, law firm names, deal amounts, instrument types, key counterparties.

5b) NAMED FINANCING ENTITIES
For articles where asset_linkage_tier is "high" or "medium", extract lender_entity_names: a flat array of all NAMED financial institutions or investors mentioned as financing counterparties (lenders, tax equity investors, sponsors, co-investors). Only include real named entities — no generic terms like "a bank" or "the lender". These will be used to index the article for entity search.

6) ARTICLE SUMMARIES
For each article where include_for_embedding = true, produce article_summary (1–3 sentences): what financing event occurred, which parties are involved, how it affects THIS plant's capital structure or credit profile. Concise, neutral, information-dense.

7) PLANT SUMMARY
Using ONLY articles where include_for_embedding = true, generate plant_summary (3–6 sentences):
- Lead with identified lenders, sponsors, or tax equity investors
- Highlight financing structure (debt facilities, tax equity, PPAs)
- Note any refinancing events, credit changes, or ownership transactions
- Flag any default risk, covenant issues, or construction financing concerns
- Remain neutral and factual; cite specific entities and amounts where available

${mode === 'rescoring' ? `8) RESCORING CONTEXT
This is a RESCORING run. Re-evaluate all articles with current context. You may raise relevance_score and flip include_for_embedding from false → true if an article is now more relevant.` : ''}

INPUT DATA:
${inputPayload}

OUTPUT FORMAT
Return ONLY valid JSON (no markdown fences, no commentary):
{
  "asset_id": "${plant.eia_plant_code}",
  "plant_name": "${plant.name}",
  "articles": [
    {
      "id": "article-uuid",
      "asset_linkage_tier": "high|medium|none",
      "asset_linkage_rationale": "...",
      "financing_relevant": true_or_false,
      "financing_rationale": "...",
      "relevance_score": 0.0_to_1.0,
      "include_for_embedding": true_or_false,
      "categories": ["...", "..."],
      "tags": ["...", "..."],
      "lender_entity_names": ["JPMorgan Chase", "US Bancorp"],
      "article_summary": "..."
    }
  ],
  "plant_summary": "..."
}

REQUIREMENTS:
- Do NOT invent details not in the article text or provided metadata.
- Be STRICT: if the article is not clearly about THIS specific plant's financing, mark it as tier "none".
- Prioritize articles that name specific lenders, deal amounts, or financing structures.
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

  let raw = '';
  for (const part of (body?.candidates?.[0]?.content?.parts ?? [])) {
    if (part.text && !part.thought) raw = part.text;
  }

  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(raw) as RankingResult;
}

// ── Validate and sanitize LLM output ───────────────────────────────────────────

const VALID_CATEGORIES = new Set([
  'refinancing', 'credit_facility', 'tax_equity',
  'sponsor_change', 'project_sale', 'credit_rating',
  'construction_financing', 'ppa_offtake', 'regulatory_impact', 'default_risk',
]);

const VALID_TIERS = new Set(['high', 'medium', 'none']);

function sanitizeResult(result: RankingResult, validIds: Set<string>): RankingResult {
  result.articles = result.articles
    .filter(a => validIds.has(a.id))
    .map(a => {
      if (!VALID_TIERS.has(a.asset_linkage_tier)) {
        a.asset_linkage_tier = 'none';
      }

      a.relevance_score = Math.max(0, Math.min(1, Number(a.relevance_score) || 0));

      // Enforce rules: none → low score, no embedding
      if (a.asset_linkage_tier === 'none') {
        a.relevance_score = Math.min(a.relevance_score, 0.29);
        a.include_for_embedding = false;
      }

      // Enforce financing override
      if (a.financing_relevant && a.asset_linkage_tier !== 'none') {
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
      if (a.categories.length === 0) a.categories = ['credit_facility'];

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

  let curtailment_rank: number | null = null;
  if (data.is_likely_curtailed && data.curtailment_score) {
    const { count } = await sb
      .from('plants')
      .select('eia_plant_code', { count: 'exact', head: true })
      .eq('is_likely_curtailed', true)
      .gt('curtailment_score', data.curtailment_score);
    curtailment_rank = (count ?? 0) + 1;
  }

  return { ...data, curtailment_rank } as PlantMeta;
}

// ── Load financing articles for ranking ────────────────────────────────────────

async function loadFinancingArticlesForPlant(
  sb: ReturnType<typeof createClient>,
  eiaPlantCode: string,
  mode: string,
): Promise<ArticleRow[]> {
  let query = sb
    .from('news_articles')
    .select('id, title, description, content, url, published_at, source_name')
    .contains('plant_codes', [eiaPlantCode])
    .eq('pipeline', 'financing')
    .order('published_at', { ascending: false });

  if (mode === 'rescoring') {
    const cutoff = new Date(Date.now() - RESCORING_MONTHS * 30 * 86400_000).toISOString();
    query = query.gte('published_at', cutoff);
  } else {
    query = query.is('ranked_at', null);
  }

  query = query.limit(MAX_ARTICLES_PER_CALL);

  const { data, error } = await query;
  if (error) {
    console.error(`Failed to load financing articles for ${eiaPlantCode}:`, error.message);
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
        curtailment_relevant:    a.financing_relevant,  // reuse column for financing relevance
        curtailment_rationale:   a.financing_rationale,
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

    // Populate entity_company_names for high/medium articles so they feed into entity scoring
    if (a.asset_linkage_tier !== 'none' && a.lender_entity_names && a.lender_entity_names.length > 0) {
      // Fetch existing names and merge
      const { data: existing } = await sb
        .from('news_articles')
        .select('entity_company_names')
        .eq('id', a.id)
        .single();

      const existingNames: string[] = (existing?.entity_company_names as string[]) ?? [];
      const merged = [...new Set([...existingNames, ...a.lender_entity_names.map((n: string) => n.trim()).filter((n: string) => n.length >= 3)])];

      await sb
        .from('news_articles')
        .update({ entity_company_names: merged })
        .eq('id', a.id);
    }
  }

  // Upsert plant_news_state with financing summary
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

  const articles = await loadFinancingArticlesForPlant(sb, eiaPlantCode, mode);
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

  // ── Batch mode: rank unranked financing articles across multiple plants ──
  if (body.batch) {
    try {
      const { data: plantCodes } = await sb
        .from('news_articles')
        .select('plant_codes')
        .is('ranked_at', null)
        .eq('pipeline', 'financing')
        .limit(200);

      const uniqueCodes = new Set<string>();
      for (const row of (plantCodes ?? [])) {
        for (const code of (row.plant_codes ?? [])) {
          uniqueCodes.add(code);
        }
      }

      const codes = [...uniqueCodes].slice(0, body.limit ?? BATCH_PLANT_LIMIT);
      console.log(`Batch ranking ${codes.length} plants with unranked financing articles`);

      const results = [];
      let totalIncluded = 0;
      for (const code of codes) {
        try {
          const r = await rankPlant(sb, geminiKey, code, 'initial_backfill');
          results.push(r);
          totalIncluded += r.articlesIncluded;
          console.log(`Ranked ${r.plant}: ${r.articlesProcessed} articles, ${r.articlesIncluded} included`);
        } catch (err) {
          console.error(`Failed to rank plant ${code}:`, err);
          results.push({ plant: code, error: String(err) });
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

      // Chain to embed-articles if any articles were included for embedding
      if (totalIncluded > 0) {
        console.log(`Chaining to embed-articles (${totalIncluded} financing articles included for embedding)`);
        fetch(`${supabaseUrl}/functions/v1/embed-articles`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify({}),
        }).catch(err => console.error('Chain to embed-articles failed:', err));
      }

      // Always chain to lender-extract to process high/medium articles into plant_lenders
      console.log('Chaining to lender-extract');
      fetch(`${supabaseUrl}/functions/v1/lender-extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({}),
      }).catch(err => console.error('Chain to lender-extract failed:', err));

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
    console.error(`lender-news-rank error for ${eia_plant_code}:`, err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
