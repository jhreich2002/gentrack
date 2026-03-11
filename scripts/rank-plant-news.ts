/**
 * rank-plant-news.ts — Local ranking script for plant news articles
 *
 * Mirrors the plant-news-rank edge function but runs locally via npx tsx.
 * Calls Gemini 2.5 Flash to rank, categorize, and summarize articles.
 *
 * Prerequisites:
 *   - Migration 20260311_plant_news_ranking.sql must be applied
 *   - Articles already ingested via ingest-plant-news.ts
 *
 * Usage:
 *   npx tsx scripts/rank-plant-news.ts --plants 65678,59448,57275
 *   npx tsx scripts/rank-plant-news.ts --top 10 --min-month 2025-11
 *   npx tsx scripts/rank-plant-news.ts --plants 65678 --mode rescoring
 *   npx tsx scripts/rank-plant-news.ts --plants 65678 --dry-run
 *
 * Environment:
 *   SUPABASE_URL / VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GEMINI_API_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// ── Env loader ─────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}

loadEnv();

// ── Environment ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Constants ──────────────────────────────────────────────────────────────────

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const MAX_ARTICLES_PER_CALL = 15;
const RESCORING_MONTHS = 18;
const GEMINI_DELAY_MS = 2000; // rate limit between Gemini calls

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

// ── Prompt Builder ─────────────────────────────────────────────────────────────

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

  const today = new Date().toISOString().split('T')[0];

  const inputPayload = JSON.stringify({
    current_date: today,
    asset,
    articles: articleList,
    time_window_months: RESCORING_MONTHS,
    mode,
  });

  return `You are an AI assistant that ranks news articles for a US power plant prospecting application used by lenders and tax equity investors.

TODAY'S DATE: ${today}

PURPOSE
The app tracks US power plants that show signs of curtailment or underperformance. Users are lenders, tax equity investors, and asset managers who need to understand:
- The operational status of a specific plant (outages, curtailment, capacity issues, maintenance)
- Who the lenders, tax equity providers, or financing parties are
- Ownership changes, M&A activity, or project sales involving this plant
- Regulatory, permitting, or legal actions affecting this plant
- Construction, commissioning, or development milestones for this plant
- Offtake or PPA contract activity for this plant

IMPORTANT: UPSTREAM SEARCH IS NOISY
Articles were fetched via RSS keyword search using the plant name and owner name. Many results are NOT actually about this plant. Common false matches include:
- Articles where a photo of the plant is used as a stock image but the text is about something else
- Articles about a DIFFERENT project being built in the same town or county
- Articles about the owner/operator's OTHER plants or corporate-level news
- Listicles, photo galleries, tourism, or real estate content that mention the town or region
- Articles about the same fuel type (e.g., "solar") in the same state but a completely different facility
- General industry trend pieces that do not discuss this specific plant

You MUST independently verify that each article is genuinely about THIS specific plant before scoring it as relevant.

TASKS
For the given asset and article list:

1) DETERMINE ASSET LINKAGE
HIGH — Article is clearly and specifically about THIS plant:
- Explicitly names this plant (or an obvious variant) and discusses its status, operations, financing, or development
- Describes a project whose location, technology, capacity, and ownership unambiguously match this plant
- Covers a grid event, outage, curtailment, or congestion where this plant is explicitly identified
- Names a lender, tax equity investor, or financing arrangement for THIS plant

MEDIUM — Article likely relates to this plant but the link is indirect:
- Mentions the owner/operator with matching geography and technology, but the plant name is ambiguous or only implied
- Covers regulatory, transmission, or market events in this plant's region that would directly affect it, and mentions the plant in passing

NONE — Article is NOT about this plant:
- Only discusses the owner/operator generically with no clear tie to this facility
- Covers a DIFFERENT plant or project, even if in the same town, county, or state
- Uses a photo or image of this plant but the article text is about a different topic
- Is a listicle, photo gallery, slideshow, or tourism/real estate content
- Discusses general industry trends without specifically mentioning this plant
- Mentions the same fuel type and region but is about a different facility with a different name, developer, or capacity

WHEN IN DOUBT: If you cannot find the plant name or a clear unique identifier for this facility in the article title or description, default to asset_linkage_tier = "none" unless the text unambiguously describes this specific plant.

2) CURTAILMENT RELEVANCE
Is the article specifically about curtailment, congestion, or forced output reduction for THIS plant?
OVERRIDE: If curtailment_relevant = true AND asset_linkage_tier ≠ "none" → include_for_embedding = true, relevance_score >= 0.70.

3) RELEVANCE SCORING (0.0–1.0)
- 0.80–1.00: Directly about this plant's operations, financing, or curtailment. Embed and show prominently.
- 0.60–0.79: Solidly relevant to this plant. Embed if asset_linkage_tier is high.
- 0.30–0.59: Weak or tangential relevance. Usually exclude from embedding.
- 0.00–0.29: Not about this plant. Exclude entirely.
Rules:
- asset_linkage_tier = "none" → relevance_score < 0.3, include_for_embedding = false.
- curtailment_relevant = true AND asset_linkage_tier ≠ "none" → relevance_score >= 0.70.

4) INCLUDE/EXCLUDE FOR EMBEDDING
- include_for_embedding = true if:
  - asset_linkage_tier = "high" AND relevance_score >= 0.60, OR
  - asset_linkage_tier = "medium" AND relevance_score >= 0.75.
- EXCEPTION: curtailment_relevant = true AND asset_linkage_tier ≠ "none" → always include.
- Exclude very short, low-information items unless they contain curtailment or financing details.

5) CATEGORIZE AND TAG
Categories (1–3): "operations_outages", "curtailment_congestion", "financing_capital", "ownership_MA", "contracts_offtake", "regulation_policy_permitting", "development_construction", "technology_assets", "macro_market", "other"
Tags: free-text strings — key concepts, counterparties, lender names, locations.

6) ARTICLE SUMMARIES
For each article where include_for_embedding = true, produce article_summary (1–3 sentences): what happened, how it relates to THIS plant, why it matters for lenders or investors. Concise, neutral, information-dense.

7) PLANT SUMMARY
Using ONLY articles where include_for_embedding = true, generate plant_summary (3–6 sentences):
- Lead with operational status and curtailment issues
- Highlight any identified lenders, tax equity investors, or financing events
- Note ownership changes or M&A activity
- Group related events; remain neutral and factual

${mode === 'rescoring' ? `8) RESCORING CONTEXT
This is a RESCORING run. The plant's curtailment status or rank may have changed. You may raise relevance_score and flip include_for_embedding from false → true if an article becomes more important. Surface historic curtailment, congestion, or financing articles that now meet the rules.` : ''}

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
- Do NOT invent details not in the article text or provided metadata.
- Be STRICT: if the article is not clearly about THIS specific plant, mark it as tier "none".
- Prioritize plant-specific operational, financing, and curtailment articles.
- ALWAYS embed curtailment or congestion articles clearly linked to this plant.
- Keep rationales and summaries short, specific, and information-dense.
- article_summary is required if include_for_embedding = true, null otherwise.`;
}

// ── Call Gemini ─────────────────────────────────────────────────────────────────

async function callGeminiRanking(prompt: string): Promise<RankingResult> {
  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
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

  // Check for truncation
  const finishReason = body?.candidates?.[0]?.finishReason;
  if (finishReason === 'MAX_TOKENS') {
    console.warn('  ⚠ Gemini output was truncated (MAX_TOKENS). Attempting partial parse...');
  }

  // Gemini 2.5 Flash may include thinking parts — pick the text part
  let raw = '';
  for (const part of (body?.candidates?.[0]?.content?.parts ?? [])) {
    if (part.text && !part.thought) raw = part.text;
  }

  // Strip optional markdown fences
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Attempt JSON parse; if truncated, try to repair
  try {
    return JSON.parse(raw) as RankingResult;
  } catch {
    console.warn('  ⚠ JSON parse failed, attempting repair...');
    const repaired = repairTruncatedJson(raw);
    return JSON.parse(repaired) as RankingResult;
  }
}

/** Attempt to repair truncated JSON by closing open structures */
function repairTruncatedJson(raw: string): string {
  // Find the articles array start
  const articlesIdx = raw.indexOf('"articles"');
  if (articlesIdx === -1) throw new Error('No articles array found in response');

  // Try to close the JSON at the last complete article object
  // Find the last complete "}" that closes an article
  let lastCompleteArticle = -1;
  let braceDepth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braceDepth++;
    if (ch === '}') {
      braceDepth--;
      if (braceDepth === 1) {
        // This closes an article-level object (depth 2 → 1)
        lastCompleteArticle = i;
      }
    }
  }

  if (lastCompleteArticle > 0) {
    // Truncate after the last complete article and close arrays/objects
    let repaired = raw.slice(0, lastCompleteArticle + 1);
    repaired += '], "plant_summary": "Ranking was truncated. Re-run with smaller batch." }';
    return repaired;
  }

  throw new Error('Could not repair truncated JSON');
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
      if (!VALID_TIERS.has(a.asset_linkage_tier)) a.asset_linkage_tier = 'none';
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
      if (!a.include_for_embedding) a.article_summary = null;

      return a;
    });

  return result;
}

// ── Load plant metadata ────────────────────────────────────────────────────────

async function loadPlantMeta(eiaPlantCode: string): Promise<PlantMeta | null> {
  const { data, error } = await supabase
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
    const { count } = await supabase
      .from('plants')
      .select('eia_plant_code', { count: 'exact', head: true })
      .eq('is_likely_curtailed', true)
      .gt('curtailment_score', data.curtailment_score);
    curtailment_rank = (count ?? 0) + 1;
  }

  return {
    ...data,
    curtailment_rank,
    operator: data.owner ?? '',
    iso_rto: '',
  } as PlantMeta;
}

// ── Load articles ──────────────────────────────────────────────────────────────

async function loadArticlesForPlant(
  eiaPlantCode: string,
  mode: string,
): Promise<ArticleRow[]> {
  let query = supabase
    .from('news_articles')
    .select('id, title, description, content, url, published_at, source_name')
    .contains('plant_codes', [eiaPlantCode])
    .order('published_at', { ascending: false });

  if (mode === 'rescoring') {
    const cutoff = new Date(Date.now() - RESCORING_MONTHS * 30 * 86400_000).toISOString();
    query = query.gte('published_at', cutoff);
  } else {
    // Only unranked articles — try ranked_at IS NULL, fall back to all if column missing
    query = query.is('ranked_at', null);
  }

  query = query.limit(MAX_ARTICLES_PER_CALL);

  const { data, error } = await query;
  if (error) {
    // If ranked_at column doesn't exist yet, load all articles
    if (error.message?.includes('ranked_at')) {
      console.warn(`  ranked_at column not found — loading all articles`);
      const { data: all } = await supabase
        .from('news_articles')
        .select('id, title, description, content, url, published_at, source_name')
        .contains('plant_codes', [eiaPlantCode])
        .order('published_at', { ascending: false })
        .limit(MAX_ARTICLES_PER_CALL);
      return (all ?? []) as ArticleRow[];
    }
    console.error(`Failed to load articles for ${eiaPlantCode}:`, error.message);
    return [];
  }
  return (data ?? []) as ArticleRow[];
}

// ── Persist rankings ──────────────────────────────────────────────────────────

async function persistRankings(
  result: RankingResult,
  eiaPlantCode: string,
): Promise<{ updated: number; errors: number }> {
  let updated = 0;
  let errors = 0;
  const now = new Date().toISOString();

  for (const a of result.articles) {
    const { error } = await supabase
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
      console.error(`  Update failed for article ${a.id}: ${error.message}`);
      errors++;
    } else {
      updated++;
    }
  }

  // Upsert plant_news_state
  if (result.plant_summary) {
    const { error: stateErr } = await supabase
      .from('plant_news_state')
      .upsert({
        eia_plant_code:      eiaPlantCode,
        plant_summary:       result.plant_summary,
        ranking_last_run_at: now,
        updated_at:          now,
      }, { onConflict: 'eia_plant_code' });

    if (stateErr) {
      console.error(`  plant_news_state upsert error: ${stateErr.message}`);
    }
  }

  return { updated, errors };
}

// ── Rank a single plant ────────────────────────────────────────────────────────

async function rankPlant(
  eiaPlantCode: string,
  mode: string,
  dryRun: boolean,
): Promise<{
  plant: string;
  articlesProcessed: number;
  articlesIncluded: number;
  updated: number;
  errors: number;
}> {
  const plant = await loadPlantMeta(eiaPlantCode);
  if (!plant) throw new Error(`Plant ${eiaPlantCode} not found`);

  const articles = await loadArticlesForPlant(eiaPlantCode, mode);
  if (articles.length === 0) {
    return { plant: plant.name, articlesProcessed: 0, articlesIncluded: 0, updated: 0, errors: 0 };
  }

  console.log(`  Sending ${articles.length} articles to Gemini for ranking...`);

  // Handle multiple batches if more than MAX_ARTICLES_PER_CALL
  const allRanked: RankedArticle[] = [];
  let plantSummary = '';

  for (let i = 0; i < articles.length; i += MAX_ARTICLES_PER_CALL) {
    const batch = articles.slice(i, i + MAX_ARTICLES_PER_CALL);
    const prompt = buildRankingPrompt(plant, batch, mode);
    const rawResult = await callGeminiRanking(prompt);

    const validIds = new Set(batch.map(a => a.id));
    const result = sanitizeResult(rawResult, validIds);

    allRanked.push(...result.articles);
    if (result.plant_summary) plantSummary = result.plant_summary;

    if (i + MAX_ARTICLES_PER_CALL < articles.length) {
      await new Promise(r => setTimeout(r, GEMINI_DELAY_MS));
    }
  }

  const fullResult: RankingResult = {
    asset_id: eiaPlantCode,
    plant_name: plant.name,
    articles: allRanked,
    plant_summary: plantSummary,
  };

  const articlesIncluded = allRanked.filter(a => a.include_for_embedding).length;

  if (dryRun) {
    // Print ranking details for dry run
    for (const a of allRanked) {
      const article = articles.find(x => x.id === a.id);
      const indicator = a.include_for_embedding ? '✓' : '✗';
      console.log(`  ${indicator} [${a.asset_linkage_tier}] ${a.relevance_score.toFixed(2)}  ${(article?.title ?? '').slice(0, 60)}`);
      if (a.curtailment_relevant) console.log(`    ↳ CURTAILMENT: ${a.curtailment_rationale?.slice(0, 80)}`);
    }
    if (plantSummary) {
      console.log(`  Plant summary: ${plantSummary.slice(0, 200)}...`);
    }
    return { plant: plant.name, articlesProcessed: articles.length, articlesIncluded, updated: 0, errors: 0 };
  }

  const { updated, errors } = await persistRankings(fullResult, eiaPlantCode);
  return { plant: plant.name, articlesProcessed: articles.length, articlesIncluded, updated, errors };
}

// ── Plant Selection (reuse from ingest script) ─────────────────────────────────

async function getPlantCodes(opts: {
  plantCodes?: string[];
  top?: number;
  minMonth?: string;
}): Promise<string[]> {
  if (opts.plantCodes && opts.plantCodes.length > 0) return opts.plantCodes;

  const minMonth = opts.minMonth ?? '2025-11';
  const top = opts.top ?? 10;

  const { data: genData } = await supabase
    .from('monthly_generation')
    .select('plant_id')
    .gte('month', minMonth)
    .not('mwh', 'is', null);

  const eligibleIds = new Set((genData ?? []).map((r: { plant_id: string }) => r.plant_id));

  const { data: plantsData } = await supabase
    .from('plants')
    .select('id, eia_plant_code')
    .eq('is_likely_curtailed', true)
    .eq('is_maintenance_offline', false)
    .eq('trailing_zero_months', 0)
    .neq('eia_plant_code', '99999')
    .not('owner', 'is', null)
    .order('curtailment_score', { ascending: false })
    .order('nameplate_capacity_mw', { ascending: false })
    .limit(10000);

  return (plantsData ?? [])
    .filter((p: { id: string }) => eligibleIds.has(p.id))
    .slice(0, top)
    .map((p: { eia_plant_code: string }) => p.eia_plant_code);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  const hasFlag = (name: string) => args.includes(`--${name}`);

  const plantCodesArg = getArg('plants');
  const topN = parseInt(getArg('top') ?? '0') || 0;
  const minMonth = getArg('min-month') ?? '2025-11';
  const mode = getArg('mode') ?? 'incremental';
  const dryRun = hasFlag('dry-run');

  if (!plantCodesArg && !topN) {
    console.error('Usage: npx tsx scripts/rank-plant-news.ts --plants CODE1,CODE2 | --top N');
    console.error('Options: --mode rescoring  --min-month 2025-11  --dry-run');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GenTrack — Plant News Ranking');
  console.log(`  Model: Gemini 2.5 Flash`);
  console.log(`  Mode: ${mode}${dryRun ? ' (DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const plantCodes = plantCodesArg ? plantCodesArg.split(',').map(s => s.trim()) : undefined;
  const codes = await getPlantCodes({ plantCodes, top: topN, minMonth });

  if (codes.length === 0) {
    console.log('No plants found matching criteria.');
    return;
  }

  console.log(`Ranking articles for ${codes.length} plants: ${codes.join(', ')}\n`);

  // ── Check if migration is applied ─────────────────────────────────────────
  if (!dryRun) {
    const { error: colCheck } = await supabase
      .from('news_articles')
      .select('ranked_at')
      .limit(1);
    if (colCheck?.message?.includes('ranked_at')) {
      console.error('ERROR: Migration 20260311_plant_news_ranking.sql has not been applied.');
      console.error('Please run it in the Supabase Dashboard SQL Editor first.');
      console.error('File: supabase/migrations/20260311_plant_news_ranking.sql');
      process.exit(1);
    }
  }

  // ── Rank each plant ───────────────────────────────────────────────────────
  const summary: { plant: string; code: string; processed: number; included: number; updated: number; errors: number }[] = [];

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    console.log(`[${i + 1}/${codes.length}] Ranking plant ${code}...`);

    try {
      const result = await rankPlant(code, mode, dryRun);
      console.log(`  ${result.plant}: ${result.articlesProcessed} articles → ${result.articlesIncluded} included, ${result.updated} updated`);
      summary.push({
        plant: result.plant, code,
        processed: result.articlesProcessed, included: result.articlesIncluded,
        updated: result.updated, errors: result.errors,
      });
    } catch (err) {
      console.error(`  Error ranking plant ${code}:`, err);
      summary.push({ plant: code, code, processed: 0, included: 0, updated: 0, errors: 1 });
    }

    // Rate limit between plants
    if (i < codes.length - 1) {
      await new Promise(r => setTimeout(r, GEMINI_DELAY_MS));
    }

    console.log();
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RANKING SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  ${'Plant'.padEnd(35)} Code     Proc  Incl  Upd   Err`);
  console.log('─'.repeat(75));

  let totals = { processed: 0, included: 0, updated: 0, errors: 0 };
  for (const s of summary) {
    console.log(
      `  ${s.plant.slice(0, 34).padEnd(35)} ${s.code.padEnd(8)} ` +
      `${String(s.processed).padStart(4)} ${String(s.included).padStart(5)} ${String(s.updated).padStart(4)} ${String(s.errors).padStart(5)}`
    );
    totals.processed += s.processed;
    totals.included += s.included;
    totals.updated += s.updated;
    totals.errors += s.errors;
  }

  console.log('─'.repeat(75));
  console.log(
    `  ${'TOTAL'.padEnd(35)} ${''.padEnd(8)} ` +
    `${String(totals.processed).padStart(4)} ${String(totals.included).padStart(5)} ${String(totals.updated).padStart(4)} ${String(totals.errors).padStart(5)}`
  );
  console.log();

  if (dryRun) {
    console.log('  DRY RUN — no rankings were written to the database.');
  } else {
    console.log(`  Done! ${totals.updated} articles ranked. ${totals.included} will be embedded.`);
    console.log();
    console.log('  Next: run embedding with:');
    console.log('    npx tsx scripts/bulk-embed-articles.ts');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
