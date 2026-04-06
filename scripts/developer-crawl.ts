/**
 * GenTrack — Developer-First Asset Registry Crawl Script
 *
 * Full Pipeline: Discovery → Extraction → Fill → DB Write → EIA Match →
 *   Ownership → Verification → Quality Gate → Graduation
 *
 * Usage:
 *   $env:PERPLEXITY_API_KEY="..."
 *   $env:GEMINI_API_KEY="..."
 *   npx tsx scripts/developer-crawl.ts
 *
 * Optional env:
 *   DEVELOPER_NAME  — override developer to crawl (default: Cypress Creek Renewables)
 *   BUDGET_LIMIT    — override $5 ceiling
 *   MAX_FILL_ROUNDS — override 4 fill rounds
 *   DRY_RUN         — "true" to skip API calls, use mock data
 *   SKIP_DB         — "true" to skip Supabase writes (console-only like Phase 2)
 *   SKIP_DISCOVERY  — "true" to skip discovery/extraction (load from latest crawl log)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Config ───────────────────────────────────────────────────────────────────

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY || '';

const DEVELOPER_NAME  = process.env.DEVELOPER_NAME || 'Cypress Creek Renewables';
const BUDGET_LIMIT    = parseFloat(process.env.BUDGET_LIMIT || '5.00');
const MAX_FILL_ROUNDS = parseInt(process.env.MAX_FILL_ROUNDS || '4', 10);
const DRY_RUN         = process.env.DRY_RUN === 'true';

// EIA benchmark: how many plants does EIA attribute to this developer?
// Used by orchestrator to gauge discovery completeness.
const EIA_BENCHMARK_COUNT = parseInt(process.env.EIA_BENCHMARK_COUNT || '174', 10);
const EIA_BENCHMARK_MW    = parseInt(process.env.EIA_BENCHMARK_MW || '1585', 10);

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const GEMINI_FLASH_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_PRO_URL   = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent';

const DELAY_MS = 1500; // rate limit delay between Perplexity calls

const SKIP_DB        = process.env.SKIP_DB === 'true';
const SKIP_DISCOVERY = process.env.SKIP_DISCOVERY === 'true';

// ── Supabase Client ──────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let db: SupabaseClient | null = null;

function getDb(): SupabaseClient {
  if (!db) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    db = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return db;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface DiscoveredAsset {
  name: string;
  technology: string | null;          // solar, wind, storage, hybrid, nuclear
  capacity_mw: number | null;
  state: string | null;
  county: string | null;
  lat: number | null;
  lng: number | null;
  status: string | null;              // operating, construction, development, planned
  developer_ownership_pct: number | null;
  co_owners: { name: string; pct: number | null }[];
  source_urls: string[];
  confidence: 'high' | 'medium' | 'low';
}

type AssetCompleteness = 'complete' | 'partial' | 'stub';

interface ClassifiedAsset extends DiscoveredAsset {
  completeness: AssetCompleteness;
  missing_fields: string[];
}

interface DiscoveryResult {
  raw_text: string;
  citations: string[];
  strategy: string;
  model: string;
}

interface CostTracker {
  perplexity_sonar: number;
  perplexity_sonar_pro: number;
  perplexity_deep_research: number;
  gemini_flash: number;
  gemini_pro: number;
  total_usd: number;
  call_count: number;
}

interface CrawlState {
  developer: string;
  assets: Map<string, ClassifiedAsset>;  // keyed by dedup key
  discoveries: DiscoveryResult[];
  cost: CostTracker;
  round: number;
  strategies_used: string[];
  states_searched: Set<string>;          // track which states already searched
  developer_id?: string;                 // UUID from developers table
  crawl_run_id?: string;                 // UUID from developer_crawl_log table
}

/** EIA plant from the plants table (subset of fields we need for matching) */
interface EIAPlant {
  id: string;              // "EIA-58605"
  eia_plant_code: string;
  name: string;
  owner: string;
  state: string;
  county: string | null;
  fuel_source: string;
  nameplate_capacity_mw: number;
  lat: number | null;
  lng: number | null;
}

/** Result of EIA matching for a single asset */
interface EIAMatchResult {
  asset_key: string;
  eia_plant_code: string | null;
  match_confidence: 'high' | 'medium' | 'low' | 'none';
  match_reason: string;
  eia_name?: string;
  eia_capacity_mw?: number;
}

/** Ownership detail discovered for an asset */
interface OwnershipDetail {
  entity_name: string;
  role: 'developer' | 'sponsor' | 'tax_equity' | 'offtaker' | 'O&M' | 'co-developer';
  ownership_pct: number | null;
}

/** Verification result for an asset */
interface VerificationResult {
  asset_key: string;
  verified: boolean;
  confidence_score: number;  // 0-100
  confidence_breakdown: {
    name_confirmed: boolean;
    capacity_confirmed: boolean;
    state_confirmed: boolean;
    status_confirmed: boolean;
    sources_found: number;
  };
  notes: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Normalize asset name for dedup: strip suffixes, parenthetical phases, common words */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s*(solar|storage|energy|renewable|project|facility|farm|plant)\s*/g, ' ')
    .replace(/\s*(phase|ph)\.?\s*\d+/g, '')          // "Phase 1" → ""
    .replace(/\(phase\s*\d+\)/gi, '')                  // "(Phase 1)" → ""
    .replace(/\s*(\+|and|&)\s*/g, ' ')                 // "solar + storage" → "solar storage"
    .replace(/\([^)]*\)/g, '')                         // strip parenthetical codes like "(PV1)", "(FLS1)"
    .replace(/,\s*llc$/i, '')                          // strip ", LLC"
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize state to 2-letter abbreviation */
const STATE_MAP: Record<string, string> = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS',
  'kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD','massachusetts':'MA',
  'michigan':'MI','minnesota':'MN','mississippi':'MS','missouri':'MO','montana':'MT',
  'nebraska':'NE','nevada':'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM',
  'new york':'NY','north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK',
  'oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT',
  'virginia':'VA','washington':'WA','west virginia':'WV','wisconsin':'WI','wyoming':'WY',
};

function normalizeState(state: string | null): string | null {
  if (!state) return null;
  const s = state.trim();
  // Already a 2-letter code
  if (s.length === 2) return s.toUpperCase();
  // Full name lookup
  return STATE_MAP[s.toLowerCase()] || s.toUpperCase();
}

function dedupKey(asset: { name: string; state: string | null; technology: string | null }): string {
  const norm = normalizeName(asset.name || '');
  const state = (normalizeState(asset.state) || '').toLowerCase().trim();
  // Don't include technology in dedup key — same project can be listed as solar vs hybrid
  return `${norm}|${state}`;
}

function newCostTracker(): CostTracker {
  return {
    perplexity_sonar: 0,
    perplexity_sonar_pro: 0,
    perplexity_deep_research: 0,
    gemini_flash: 0,
    gemini_pro: 0,
    total_usd: 0,
    call_count: 0,
  };
}

/** Rough cost estimation per API call (conservative upper bounds) */
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates: Record<string, [number, number]> = {
    'sonar':              [1.0, 1.0],     // per 1M tokens
    'sonar-pro':          [3.0, 15.0],
    'sonar-deep-research':[2.0, 8.0],
    'gemini-2.5-flash':   [0.30, 2.50],
    'gemini-2.5-pro':     [1.25, 10.00],
  };
  const [inRate, outRate] = rates[model] || [1.0, 5.0];
  const requestFee = model.startsWith('sonar') ? 0.005 : 0;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate + requestFee;
}

function trackCost(cost: CostTracker, model: string, amount: number): void {
  if (model === 'sonar') cost.perplexity_sonar += amount;
  else if (model === 'sonar-pro') cost.perplexity_sonar_pro += amount;
  else if (model === 'sonar-deep-research') cost.perplexity_deep_research += amount;
  else if (model.includes('flash')) cost.gemini_flash += amount;
  else if (model.includes('pro')) cost.gemini_pro += amount;
  cost.total_usd += amount;
  cost.call_count++;
}

function budgetRemaining(cost: CostTracker): number {
  return BUDGET_LIMIT - cost.total_usd;
}

function log(label: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${label}] ${msg}`);
}

// ── Perplexity API ───────────────────────────────────────────────────────────

async function callPerplexity(
  model: 'sonar' | 'sonar-pro' | 'sonar-deep-research',
  systemPrompt: string,
  userPrompt: string,
  cost: CostTracker,
): Promise<{ text: string; citations: string[]; error?: number }> {
  log('PERPLEXITY', `Calling ${model} (${userPrompt.slice(0, 80)}...)`);

  if (DRY_RUN) {
    return { text: '[DRY RUN] No API call made.', citations: [] };
  }

  if (!PERPLEXITY_API_KEY) throw new Error('PERPLEXITY_API_KEY not set');

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.1,
    return_citations: true,
  };

  const res = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    // Return a retriable error object instead of throwing for quota/rate errors
    if (res.status === 401 || res.status === 429) {
      log('PERPLEXITY', `${model} failed (${res.status}) — quota/rate limit: ${errBody.slice(0, 200)}`);
      return { text: '', citations: [], error: res.status };
    }
    throw new Error(`Perplexity ${model} error ${res.status}: ${errBody}`);
  }

  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content || '';
  const citations: string[] = data.citations?.map((c: any) => typeof c === 'string' ? c : c.url || '') || [];
  const usage = data.usage || {};
  const inputTokens = usage.prompt_tokens || 500;
  const outputTokens = usage.completion_tokens || 1000;
  const callCost = estimateCost(model, inputTokens, outputTokens);
  trackCost(cost, model, callCost);

  log('PERPLEXITY', `${model} done — ${inputTokens}in/${outputTokens}out — $${callCost.toFixed(4)} — total $${cost.total_usd.toFixed(4)}`);

  return { text, citations };
}

// ── Gemini API ───────────────────────────────────────────────────────────────

async function callGemini(
  model: 'gemini-2.5-flash' | 'gemini-2.5-pro',
  prompt: string,
  cost: CostTracker,
  jsonMode: boolean = false,
): Promise<string> {
  log('GEMINI', `Calling ${model} (${prompt.slice(0, 80)}...)`);

  if (DRY_RUN) {
    return '[DRY RUN] No API call made.';
  }

  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const url = model === 'gemini-2.5-flash'
    ? `${GEMINI_FLASH_URL}?key=${GEMINI_API_KEY}`
    : `${GEMINI_PRO_URL}?key=${GEMINI_API_KEY}`;

  const generationConfig: Record<string, any> = {
    temperature: 0.1,
    maxOutputTokens: 16384,
  };
  if (jsonMode) {
    generationConfig.responseMimeType = 'application/json';
  }

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini ${model} error ${res.status}: ${errBody}`);
  }

  const data = await res.json() as any;
  let resultText = '';
  for (const part of data.candidates?.[0]?.content?.parts || []) {
    if (part.thought) continue; // skip thinking tokens
    if (part.text) resultText += part.text;
  }

  const usage = data.usageMetadata || {};
  const inputTokens = usage.promptTokenCount || 500;
  const outputTokens = usage.candidatesTokenCount || 1000;
  const callCost = estimateCost(model, inputTokens, outputTokens);
  trackCost(cost, model, callCost);

  log('GEMINI', `${model} done — ${inputTokens}in/${outputTokens}out — $${callCost.toFixed(4)} — total $${cost.total_usd.toFixed(4)}`);

  return resultText;
}

// ── Discovery Agent ──────────────────────────────────────────────────────────

const DISCOVERY_SYSTEM_PROMPT = `You are a renewable energy industry researcher. Return comprehensive, factual information about developer portfolios. Always cite sources. Never fabricate project names or capacities.`;

function buildPortfolioPrompt(developer: string): string {
  return `List ALL renewable energy assets (solar, wind, storage, nuclear) owned, developed, or operated by ${developer} in the United States. Include: project name, state, technology type, capacity (MW), current status (operating/construction/development/planned). Include projects that are under construction or in development, not just operating. If a project has multiple phases, list each phase separately with its capacity. If capacity is given as AC and DC, prefer AC nameplate.`;
}

function buildStatePrompt(developer: string, state: string): string {
  return `List all ${developer} renewable energy projects in ${state}, including small community solar farms (1-20 MW). Include each project's individual name, technology, capacity MW, status, and county if known. List each project separately — do NOT aggregate them as "X projects totaling Y MW".`;
}

function buildFillPrompt(developer: string, assets: { name: string; state: string | null }[]): string {
  const list = assets.map(a => `${a.name} (${a.state || 'unknown state'})`).join(', ');
  return `For the following ${developer} projects, provide the nameplate capacity (MW) and current construction status: ${list}`;
}

function buildExistencePrompt(developer: string, assetName: string, state: string | null): string {
  return `Does ${developer} own or operate a renewable energy project called "${assetName}"${state ? ` in ${state}` : ''}? If yes, provide its technology type, capacity MW, and current status.`;
}

type DiscoveryStrategy = 'portfolio_overview' | 'by_state' | 'by_technology' | 'acquisitions' | 'deep_research';

async function runDiscovery(
  developer: string,
  strategy: DiscoveryStrategy,
  cost: CostTracker,
  context?: { state?: string; technology?: string; assets?: { name: string; state: string | null }[] },
): Promise<DiscoveryResult> {
  let model: 'sonar' | 'sonar-pro' | 'sonar-deep-research';
  let userPrompt: string;

  switch (strategy) {
    case 'deep_research':
      model = 'sonar-deep-research';
      userPrompt = buildPortfolioPrompt(developer);
      break;
    case 'portfolio_overview':
      model = 'sonar-pro';
      userPrompt = buildPortfolioPrompt(developer);
      break;
    case 'by_state':
      model = 'sonar';
      userPrompt = buildStatePrompt(developer, context?.state || '');
      break;
    case 'by_technology':
      model = 'sonar';
      userPrompt = `List all ${developer} ${context?.technology || 'renewable energy'} projects in the United States. Include project name, state, capacity MW, and status.`;
      break;
    case 'acquisitions':
      model = 'sonar-pro';
      userPrompt = `What renewable energy projects has ${developer} acquired, sold, or announced in the past 24 months? Include project name, technology, capacity, state, and transaction details.`;
      break;
    default:
      throw new Error(`Unknown strategy: ${strategy}`);
  }

  const result = await callPerplexity(model, DISCOVERY_SYSTEM_PROMPT, userPrompt, cost);
  await sleep(DELAY_MS);

  return {
    raw_text: result.text,
    citations: result.citations,
    strategy,
    model: result.error ? `${model}(failed:${result.error})` : model,
  };
}

// ── Extraction Agent ─────────────────────────────────────────────────────────

function buildExtractionPrompt(developer: string, rawTexts: string[]): string {
  const combined = rawTexts.map((t, i) => `--- SOURCE ${i + 1} ---\n${t}`).join('\n\n');

  return `Extract structured asset data from the provided text about ${developer}'s renewable energy portfolio.

RULES:
- Only extract assets explicitly named in the source text. Do NOT invent or guess.
- If the same project appears multiple times with slightly different names, merge into one entry using the most complete data.
- "a 500 MW project in Texas" without a name → REJECT (do not include).
- "several solar farms" → REJECT (not specific enough).
- If capacity is given as AC and DC, prefer AC nameplate.
- If a project has multiple phases, list each phase separately.
- For status: use "operating", "construction", "development", or "planned". If unclear, use null.
- For technology: use "solar", "wind", "storage", "hybrid", "nuclear", "hydro", "geothermal", or "biomass".
- confidence: "high" = explicitly named with details, "medium" = mentioned but some details inferred, "low" = vague or uncertain.
- co_owners: list any co-developers, partners, tax equity investors mentioned. pct = ownership percentage if stated, null if not.
- DEDUP: If the same project appears multiple times (e.g., "Steel River" and "Steel River Phase 1"), list ONLY the most specific named entries. Do NOT create an aggregate entry AND separate phase entries for the same project.
- REJECT generic/aggregate descriptions: "13 solar projects", "portfolio of farms", "first portfolio of projects", "unnamed project". Only extract individually named assets.
- REJECT if the name is just a number + technology: "12 solar and storage projects" → REJECT.

Return a JSON object with this exact schema:
{
  "assets": [
    {
      "name": "Project Name",
      "technology": "solar",
      "capacity_mw": 150,
      "state": "TX",
      "county": null,
      "lat": null,
      "lng": null,
      "status": "operating",
      "developer_ownership_pct": null,
      "co_owners": [],
      "source_urls": [],
      "confidence": "high"
    }
  ]
}

SOURCE TEXT:
${combined}`;
}

async function runExtraction(
  developer: string,
  discoveries: DiscoveryResult[],
  cost: CostTracker,
): Promise<DiscoveredAsset[]> {
  const rawTexts = discoveries.map(d => d.raw_text).filter(t => t.length > 10);
  const allCitations = discoveries.flatMap(d => d.citations);

  if (rawTexts.length === 0) return [];

  // Chunk large inputs to avoid response truncation (Gemini struggles with very long JSON output)
  const MAX_CHARS = 12000;
  const chunks: string[][] = [[]];
  let currentLen = 0;
  for (const text of rawTexts) {
    if (currentLen + text.length > MAX_CHARS && chunks[chunks.length - 1].length > 0) {
      chunks.push([]);
      currentLen = 0;
    }
    chunks[chunks.length - 1].push(text);
    currentLen += text.length;
  }

  const allAssets: DiscoveredAsset[] = [];

  for (const chunk of chunks) {
    const prompt = buildExtractionPrompt(developer, chunk);
    const resultText = await callGemini('gemini-2.5-flash', prompt, cost, true);

    // Parse JSON — strip markdown fences if present
    let cleaned = resultText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let parsed: { assets: DiscoveredAsset[] };
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      log('EXTRACTION', `JSON parse failed: ${(e as Error).message}`);
      log('EXTRACTION', `Raw output (first 500 chars): ${cleaned.slice(0, 500)}`);
      continue;
    }

    if (!parsed.assets || !Array.isArray(parsed.assets)) {
      log('EXTRACTION', `No assets array in output`);
      continue;
    }

    allAssets.push(...parsed.assets);
  }

  // Normalize states and attach citations; filter out generic/aggregate entries
  const REJECT_PATTERNS = [
    /^\d+\s+(solar|wind|storage)/i,
    /^(first|second|third)\s+portfolio/i,
    /^unnamed/i,
    /portfolio\s+(of|totaling)/i,
    /^\d+\s+projects?$/i,
    /\d+\s+(solar|wind).*projects/i,
  ];

  const assets = allAssets
    .filter(a => a.name && a.name.trim().length > 0)
    .filter(a => !REJECT_PATTERNS.some(p => p.test(a.name.trim())))
    .map(a => ({
      ...a,
      name: a.name.trim(),
      state: normalizeState(a.state),
      source_urls: [...new Set([...(a.source_urls || []), ...allCitations])],
    }));

  log('EXTRACTION', `Extracted ${assets.length} named assets (${allAssets.length - assets.length} rejected as generic)`);
  return assets;
}

// ── Completeness Classifier ──────────────────────────────────────────────────

function classifyAsset(asset: DiscoveredAsset): ClassifiedAsset {
  const missing: string[] = [];

  if (!asset.name || !asset.name.trim()) missing.push('name');
  if (!asset.state) missing.push('state');
  if (!asset.technology) missing.push('technology');
  if (asset.capacity_mw == null) missing.push('capacity_mw');
  if (!asset.status) missing.push('status');

  let completeness: AssetCompleteness;
  if (missing.length === 0) {
    completeness = 'complete';
  } else if (asset.name && asset.name.trim() && missing.length <= 3) {
    completeness = 'partial';
  } else {
    completeness = 'stub';
  }

  return { ...asset, completeness, missing_fields: missing };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

const ORCHESTRATOR_SYSTEM = `You are evaluating the completeness of a developer portfolio discovery. Analyze what's been found and identify gaps. Return JSON only.`;

async function orchestratorEvaluate(
  state: CrawlState,
): Promise<{ done: boolean; next_strategies: { strategy: DiscoveryStrategy; context?: any }[] }> {
  const assets = [...state.assets.values()];
  const complete = assets.filter(a => a.completeness === 'complete').length;
  const partial = assets.filter(a => a.completeness === 'partial').length;
  const stubs = assets.filter(a => a.completeness === 'stub').length;
  const totalMW = assets.reduce((sum, a) => sum + (a.capacity_mw || 0), 0);
  const states = [...new Set(assets.map(a => a.state).filter(Boolean))];
  const techs = [...new Set(assets.map(a => a.technology).filter(Boolean))];

  const prompt = `${ORCHESTRATOR_SYSTEM}

Given ${state.developer} with discovered portfolio:
- Total assets discovered: ${assets.length} (${complete} complete, ${partial} partial, ${stubs} stubs)
- Total MW discovered: ${totalMW.toFixed(0)}
- EIA BENCHMARK: ${EIA_BENCHMARK_COUNT} known operating plants totaling ${EIA_BENCHMARK_MW} MW (all solar, avg ~9 MW each — mostly small distributed solar farms)
- Discovery gap: found ${assets.length} vs ${EIA_BENCHMARK_COUNT} EIA plants = ${((assets.length / EIA_BENCHMARK_COUNT) * 100).toFixed(0)}% recall
- States covered so far: ${states.join(', ') || 'none'}
- States ALREADY SEARCHED (do NOT repeat): ${[...state.states_searched].join(', ') || 'none'}
- Technologies found: ${techs.join(', ') || 'none'}
- Strategies already used: ${state.strategies_used.join(', ')}
- Budget remaining: $${budgetRemaining(state.cost).toFixed(2)}
- Round: ${state.round}

IMPORTANT: Many small community solar farms (1-20 MW) have minimal web presence. Once you have exhausted state-by-state web searches, set done=true — the remaining small plants will be discovered via EIA data overlay, not web search.

Do NOT suggest searching states that are listed in "States ALREADY SEARCHED". Only suggest NEW states.

Known CCR regions from EIA: Carolinas (NC/SC), Florida, Colorado, Massachusetts, Central (TX/OK/AR), Mountain, South, West (CA/WA/OR), Georgia, Michigan, Oregon, Pennsylvania, Virginia.

Assess:
1. What percentage of the ${EIA_BENCHMARK_COUNT} known EIA plants have we found?
2. Which states are NOT yet covered that likely have CCR plants?
3. Plan the MOST EFFICIENT next searches to close the gap.

Return JSON:
{
  "assessment": "brief assessment text",
  "coverage_pct": <number 0-100>,
  "done": true/false,
  "next_strategies": [
    { "strategy": "by_state", "context": { "state": "NC" } }
  ]
}

Valid strategies: portfolio_overview, by_state, by_technology, acquisitions
IMPORTANT: Set done=true ONLY if coverage_pct > 80 OR budget remaining < $0.50. Otherwise set done=false and provide next_strategies.`;

  const resultText = await callGemini('gemini-2.5-pro', prompt, state.cost, true);

  let cleaned = resultText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const result = JSON.parse(cleaned);
    const coveragePct = result.coverage_pct || 0;
    log('ORCHESTRATOR', `Assessment: ${result.assessment}`);
    log('ORCHESTRATOR', `Coverage: ${coveragePct}% | Done: ${result.done}`);
    // Override: don't let orchestrator quit below 50% coverage unless budget is critically low
    const forceContinue = coveragePct < 50 && budgetRemaining(state.cost) > 0.50;
    if (forceContinue && result.done) {
      log('ORCHESTRATOR', `Overriding done=true — coverage too low (${coveragePct}%), forcing more discovery`);
    }
    return {
      done: forceContinue ? false : (result.done || false),
      next_strategies: result.next_strategies || [],
    };
  } catch (e) {
    log('ORCHESTRATOR', `JSON parse failed, ending discovery: ${(e as Error).message}`);
    return { done: true, next_strategies: [] };
  }
}

// ── Fill Logic (Completeness Loop) ───────────────────────────────────────────

async function runFillRound(
  state: CrawlState,
): Promise<number> {
  const partials = [...state.assets.values()].filter(a => a.completeness === 'partial');
  const stubs = [...state.assets.values()].filter(a => a.completeness === 'stub');

  if (partials.length === 0 && stubs.length === 0) return 0;

  log('FILL', `Round ${state.round + 1}: ${partials.length} partials, ${stubs.length} stubs`);

  let filled = 0;

  // Batch fill partials — group by missing field
  if (partials.length > 0) {
    const missingCapacity = partials.filter(a => a.missing_fields.includes('capacity_mw'));
    const missingStatus = partials.filter(a => a.missing_fields.includes('status'));
    const missingTech = partials.filter(a => a.missing_fields.includes('technology'));
    const missingState = partials.filter(a => a.missing_fields.includes('state'));

    // Batch capacity + status fill (most common)
    const toFill = [...new Set([...missingCapacity, ...missingStatus])];
    if (toFill.length > 0 && budgetRemaining(state.cost) > 0.05) {
      const fillPrompt = buildFillPrompt(state.developer, toFill);
      const result = await callPerplexity('sonar', DISCOVERY_SYSTEM_PROMPT, fillPrompt, state.cost);
      await sleep(DELAY_MS);

      // Re-extract with fill results merged
      const fillDiscovery: DiscoveryResult = {
        raw_text: result.text,
        citations: result.citations,
        strategy: 'fill_round',
        model: 'sonar',
      };

      const extracted = await runExtraction(state.developer, [fillDiscovery], state.cost);
      filled += mergeAssets(state, extracted);
    }

    // Technology fill
    if (missingTech.length > 0 && budgetRemaining(state.cost) > 0.05) {
      for (const asset of missingTech.slice(0, 5)) { // limit to 5 to save budget
        const result = await callPerplexity('sonar', DISCOVERY_SYSTEM_PROMPT,
          buildExistencePrompt(state.developer, asset.name, asset.state), state.cost);
        await sleep(DELAY_MS);
        const extracted = await runExtraction(state.developer, [{
          raw_text: result.text, citations: result.citations, strategy: 'existence_check', model: 'sonar',
        }], state.cost);
        filled += mergeAssets(state, extracted);
      }
    }
  }

  // Individual existence queries for stubs
  if (stubs.length > 0 && budgetRemaining(state.cost) > 0.05) {
    for (const stub of stubs.slice(0, 5)) { // limit
      const result = await callPerplexity('sonar', DISCOVERY_SYSTEM_PROMPT,
        buildExistencePrompt(state.developer, stub.name, stub.state), state.cost);
      await sleep(DELAY_MS);
      const extracted = await runExtraction(state.developer, [{
        raw_text: result.text, citations: result.citations, strategy: 'existence_check', model: 'sonar',
      }], state.cost);
      filled += mergeAssets(state, extracted);
    }
  }

  return filled;
}

/** Merge newly extracted assets into state, preferring more complete data */
function mergeAssets(state: CrawlState, newAssets: DiscoveredAsset[]): number {
  let upgraded = 0;

  for (const newAsset of newAssets) {
    const key = dedupKey(newAsset);
    const existing = state.assets.get(key);

    if (!existing) {
      state.assets.set(key, classifyAsset(newAsset));
      continue;
    }

    // Merge: fill nulls from new data
    let changed = false;
    if (!existing.capacity_mw && newAsset.capacity_mw) { existing.capacity_mw = newAsset.capacity_mw; changed = true; }
    if (!existing.status && newAsset.status) { existing.status = newAsset.status; changed = true; }
    if (!existing.technology && newAsset.technology) { existing.technology = newAsset.technology; changed = true; }
    if (!existing.state && newAsset.state) { existing.state = newAsset.state; changed = true; }
    if (!existing.county && newAsset.county) { existing.county = newAsset.county; changed = true; }
    if (newAsset.source_urls?.length) {
      existing.source_urls = [...new Set([...existing.source_urls, ...newAsset.source_urls])];
    }
    if (newAsset.co_owners?.length && !existing.co_owners?.length) {
      existing.co_owners = newAsset.co_owners;
      changed = true;
    }

    if (changed) {
      const reclassified = classifyAsset(existing);
      const wasPartial = existing.completeness !== 'complete';
      const nowComplete = reclassified.completeness === 'complete';
      Object.assign(existing, reclassified);
      if (wasPartial && nowComplete) upgraded++;
    }
  }

  return upgraded;
}

// ── DB Write Functions ───────────────────────────────────────────────────────

/** Ensure developer row exists, return its UUID */
async function ensureDeveloper(name: string): Promise<string> {
  const supabase = getDb();

  // Check if developer already exists
  const { data: existing } = await supabase
    .from('developers')
    .select('id')
    .eq('name', name)
    .maybeSingle();

  if (existing) {
    log('DB', `Developer "${name}" exists: ${existing.id}`);
    return existing.id;
  }

  const { data, error } = await supabase
    .from('developers')
    .insert({
      name,
      entity_type: 'developer',
      crawl_status: 'running',
      eia_benchmark_count: EIA_BENCHMARK_COUNT,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create developer: ${error.message}`);
  log('DB', `Created developer "${name}": ${data.id}`);
  return data.id;
}

/** Create a crawl log entry, return its UUID */
async function createCrawlLog(
  developerId: string,
  budgetLimit: number,
): Promise<string> {
  const supabase = getDb();

  const { data, error } = await supabase
    .from('developer_crawl_log')
    .insert({
      developer_id: developerId,
      run_type: 'initial',
      status: 'running',
      phase: 'discovery',
      budget_limit_usd: budgetLimit,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create crawl log: ${error.message}`);
  log('DB', `Created crawl log: ${data.id}`);
  return data.id;
}

/** Update crawl log phase and checkpoint */
async function updateCrawlPhase(
  crawlRunId: string,
  phase: string,
  state: CrawlState,
): Promise<void> {
  const supabase = getDb();
  const assets = [...state.assets.values()];

  const { error } = await supabase
    .from('developer_crawl_log')
    .update({
      phase,
      total_cost_usd: state.cost.total_usd,
      api_calls: state.cost,
      strategies_used: state.strategies_used,
      rounds: state.round,
      assets_discovered: assets.length,
      assets_graduated: assets.filter(a => (a as any).graduated).length,
    })
    .eq('id', crawlRunId);

  if (error) log('DB', `Warning: failed to update crawl phase: ${error.message}`);
}

/** Upsert assets to asset_registry, return map of dedupKey → asset UUID */
async function upsertAssets(
  state: CrawlState,
): Promise<Map<string, string>> {
  const supabase = getDb();
  const assetIds = new Map<string, string>();

  for (const [key, asset] of state.assets) {
    // Build the row — use COALESCE-safe values
    const row: Record<string, any> = {
      name: asset.name,
      technology: asset.technology || null,
      status: asset.status || null,
      capacity_mw: asset.capacity_mw,
      state: asset.state || null,
      county: asset.county || null,
      lat: asset.lat || null,
      lng: asset.lng || null,
      source_urls: asset.source_urls || [],
      confidence_score: asset.confidence === 'high' ? 80 : asset.confidence === 'medium' ? 50 : 20,
      crawl_run_id: state.crawl_run_id || null,
      graduated: false,
    };

    // Try upsert — first check if exists
    const { data: existing } = await supabase
      .from('asset_registry')
      .select('id')
      .ilike('name', asset.name)
      .eq('state', asset.state || '')
      .maybeSingle();

    if (existing) {
      // Update existing
      const { error } = await supabase
        .from('asset_registry')
        .update({
          ...row,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);

      if (error) {
        log('DB', `Warning: failed to update asset "${asset.name}": ${error.message}`);
      } else {
        assetIds.set(key, existing.id);
      }
    } else {
      // Insert new
      const { data, error } = await supabase
        .from('asset_registry')
        .insert(row)
        .select('id')
        .single();

      if (error) {
        log('DB', `Warning: failed to insert asset "${asset.name}": ${error.message}`);
      } else {
        assetIds.set(key, data.id);
      }
    }
  }

  log('DB', `Upserted ${assetIds.size}/${state.assets.size} assets to asset_registry`);
  return assetIds;
}

/** Create developer_assets links */
async function linkDeveloperAssets(
  developerId: string,
  assetIds: Map<string, string>,
  state: CrawlState,
): Promise<void> {
  const supabase = getDb();
  let linked = 0;

  for (const [key, assetId] of assetIds) {
    const asset = state.assets.get(key);
    const ownershipPct = asset?.developer_ownership_pct || null;

    const { error } = await supabase
      .from('developer_assets')
      .upsert(
        {
          developer_id: developerId,
          asset_id: assetId,
          ownership_pct: ownershipPct,
          role: 'developer',
        },
        { onConflict: 'developer_id,asset_id' },
      );

    if (!error) linked++;
  }

  log('DB', `Linked ${linked} assets to developer`);
}

/** Complete the crawl log */
async function completeCrawlLog(
  crawlRunId: string,
  state: CrawlState,
  status: 'completed' | 'failed' | 'budget_paused' = 'completed',
): Promise<void> {
  const supabase = getDb();
  const assets = [...state.assets.values()];

  const { error } = await supabase
    .from('developer_crawl_log')
    .update({
      status,
      phase: 'verification',
      total_cost_usd: state.cost.total_usd,
      api_calls: state.cost,
      strategies_used: state.strategies_used,
      rounds: state.round,
      assets_discovered: assets.length,
      assets_graduated: assets.filter(a => (a as any).graduated).length,
      assets_staged: assets.filter(a => !(a as any).graduated).length,
      completed_at: new Date().toISOString(),
      completion_report: {
        total_assets: assets.length,
        complete: assets.filter(a => a.completeness === 'complete').length,
        partial: assets.filter(a => a.completeness === 'partial').length,
        stubs: assets.filter(a => a.completeness === 'stub').length,
        total_mw: assets.reduce((s, a) => s + (a.capacity_mw || 0), 0),
        states: [...new Set(assets.map(a => a.state).filter(Boolean))],
      },
    })
    .eq('id', crawlRunId);

  if (error) log('DB', `Warning: failed to complete crawl log: ${error.message}`);
  else log('DB', `Crawl log completed: ${status}`);

  // Update developer row
  await supabase
    .from('developers')
    .update({
      crawl_status: status === 'completed' ? 'completed' : status,
      asset_count_discovered: assets.length,
      total_spend_usd: state.cost.total_usd,
      last_full_crawl_at: new Date().toISOString(),
    })
    .eq('id', state.developer_id!);
}

// ── EIA Match Agent ──────────────────────────────────────────────────────────

/** Load EIA plants for the given developer from Supabase */
async function loadEIAPlants(developerName: string): Promise<EIAPlant[]> {
  const supabase = getDb();

  // Query plants table for this developer's plants (case-insensitive)
  const { data, error } = await supabase
    .from('plants')
    .select('id, eia_plant_code, name, owner, state, county, fuel_source, nameplate_capacity_mw, lat, lng')
    .ilike('owner', `%${developerName}%`);

  if (error) {
    log('EIA_MATCH', `Failed to load EIA plants: ${error.message}`);
    return [];
  }

  log('EIA_MATCH', `Loaded ${data.length} EIA plants for "${developerName}"`);
  return data as EIAPlant[];
}

/** Normalize fuel source to match our technology field */
function normalizeFuelSource(fs: string): string {
  const map: Record<string, string> = {
    'solar': 'solar', 'wind': 'wind', 'nuclear': 'nuclear',
    'storage': 'storage', 'batteries': 'storage', 'battery': 'storage',
    'hydro': 'hydro', 'hydroelectric': 'hydro',
    'geothermal': 'geothermal', 'biomass': 'biomass',
  };
  return map[fs.toLowerCase()] || fs.toLowerCase();
}

/** Simple Levenshtein distance for fuzzy matching */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Run EIA matching for all assets in state */
async function runEIAMatch(state: CrawlState): Promise<EIAMatchResult[]> {
  log('EIA_MATCH', '▶ Starting EIA Match Agent');

  const eiaPlants = await loadEIAPlants(state.developer);
  if (eiaPlants.length === 0) {
    log('EIA_MATCH', 'No EIA plants found — skipping match');
    return [];
  }

  const results: EIAMatchResult[] = [];
  let highMatches = 0, mediumMatches = 0, lowMatches = 0;

  for (const [key, asset] of state.assets) {
    const match = findBestEIAMatch(asset, eiaPlants);
    results.push({ asset_key: key, ...match });

    if (match.match_confidence === 'high') highMatches++;
    else if (match.match_confidence === 'medium') mediumMatches++;
    else if (match.match_confidence === 'low') lowMatches++;
  }

  log('EIA_MATCH', `Results: ${highMatches} high, ${mediumMatches} medium, ${lowMatches} low, ${results.filter(r => r.match_confidence === 'none').length} unmatched`);
  return results;
}

/** Find the best EIA match for a single asset */
function findBestEIAMatch(
  asset: ClassifiedAsset,
  eiaPlants: EIAPlant[],
): Omit<EIAMatchResult, 'asset_key'> {
  const assetName = (asset.name || '').toLowerCase().trim();
  const assetState = (asset.state || '').toUpperCase();
  const assetTech = normalizeFuelSource(asset.technology || '');
  const assetMW = asset.capacity_mw || 0;

  let bestMatch: Omit<EIAMatchResult, 'asset_key'> = {
    eia_plant_code: null,
    match_confidence: 'none',
    match_reason: 'no match found',
  };
  let bestScore = 0;

  for (const plant of eiaPlants) {
    const plantName = (plant.name || '').toLowerCase().trim();
    const plantState = (plant.state || '').toUpperCase();
    const plantTech = normalizeFuelSource(plant.fuel_source || '');
    const plantMW = plant.nameplate_capacity_mw || 0;

    let score = 0;
    const reasons: string[] = [];

    // 1. Exact name match (strongest signal)
    if (assetName === plantName) {
      score += 50;
      reasons.push('exact name');
    } else {
      // Fuzzy name match
      const normA = normalizeName(asset.name);
      const normP = normalizeName(plant.name);
      if (normA === normP) {
        score += 45;
        reasons.push('normalized name match');
      } else if (normA.includes(normP) || normP.includes(normA)) {
        score += 30;
        reasons.push('name substring');
      } else {
        const dist = levenshtein(normA, normP);
        const maxLen = Math.max(normA.length, normP.length);
        if (maxLen > 0 && dist / maxLen < 0.3) {
          score += 20;
          reasons.push(`fuzzy name (dist=${dist})`);
        }
      }
    }

    // 2. State match
    if (assetState && plantState && assetState === plantState) {
      score += 20;
      reasons.push('state match');
    }

    // 3. Technology match
    if (assetTech && plantTech && assetTech === plantTech) {
      score += 10;
      reasons.push('tech match');
    }

    // 4. Capacity match (within ±20%)
    if (assetMW > 0 && plantMW > 0) {
      const ratio = Math.min(assetMW, plantMW) / Math.max(assetMW, plantMW);
      if (ratio > 0.8) {
        score += 15;
        reasons.push(`capacity match (${ratio.toFixed(2)})`);
      } else if (ratio > 0.5) {
        score += 5;
        reasons.push(`capacity close (${ratio.toFixed(2)})`);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      let confidence: 'high' | 'medium' | 'low' | 'none';
      if (score >= 65) confidence = 'high';     // name+state+capacity
      else if (score >= 45) confidence = 'medium'; // normalized name + state
      else if (score >= 30) confidence = 'low';
      else confidence = 'none';

      bestMatch = {
        eia_plant_code: plant.eia_plant_code,
        match_confidence: confidence,
        match_reason: reasons.join(', '),
        eia_name: plant.name,
        eia_capacity_mw: plant.nameplate_capacity_mw,
      };
    }
  }

  return bestMatch;
}

/** Write EIA match results to the asset_registry */
async function writeEIAMatches(
  results: EIAMatchResult[],
  assetIds: Map<string, string>,
): Promise<void> {
  const supabase = getDb();
  let written = 0;

  for (const match of results) {
    const assetId = assetIds.get(match.asset_key);
    if (!assetId) continue;
    if (match.match_confidence === 'none') continue;

    const { error } = await supabase
      .from('asset_registry')
      .update({
        eia_plant_code: match.eia_plant_code,
        match_confidence: match.match_confidence,
      })
      .eq('id', assetId);

    if (!error) written++;
  }

  log('EIA_MATCH', `Wrote ${written} EIA matches to DB`);
}

// ── Ownership Agent ──────────────────────────────────────────────────────────

/** Query Perplexity for ownership details of a single asset */
async function discoverOwnership(
  developer: string,
  asset: ClassifiedAsset,
  cost: CostTracker,
): Promise<OwnershipDetail[]> {
  const prompt = `Who are all the parties involved with the "${asset.name}" ${asset.technology || 'renewable energy'} project (${asset.capacity_mw || '?'} MW) in ${asset.state || 'the US'}?

List each entity and their role:
- Developer/sponsor
- Tax equity investor (if any)
- PPA offtaker/buyer (if any)
- O&M operator (if any)
- Co-developers or partners (if any)
- Debt lender (if any)

For each entity, state their ownership percentage if publicly available.
Return ONLY factual, cited information. If unknown, say "unknown".`;

  const result = await callPerplexity('sonar', DISCOVERY_SYSTEM_PROMPT, prompt, cost);
  await sleep(DELAY_MS);

  if (!result.text || result.text.length < 20) return [];

  // Use Gemini to extract structured ownership from the Perplexity result
  const extractPrompt = `Extract ownership/stakeholder details from this text about the "${asset.name}" project.

TEXT:
${result.text.slice(0, 6000)}

Return JSON array (only entities explicitly mentioned):
[
  { "entity_name": "Company Name", "role": "developer|sponsor|tax_equity|offtaker|O&M|co-developer", "ownership_pct": null }
]

Valid roles: developer, sponsor, tax_equity, offtaker, O&M, co-developer
Set ownership_pct to a number 0-100 if stated, null if not mentioned.
Exclude the project name itself — only real company/entity names.`;

  const extracted = await callGemini('gemini-2.5-flash', extractPrompt, cost, true);

  try {
    let cleaned = extracted.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(cleaned);
    const details = (Array.isArray(parsed) ? parsed : parsed.ownership || parsed.entities || []) as OwnershipDetail[];
    return details.filter(d => d.entity_name && d.role);
  } catch {
    log('OWNERSHIP', `Failed to parse ownership for "${asset.name}"`);
    return [];
  }
}

/** Run ownership discovery for top assets (budget-conscious) */
async function runOwnershipAgent(
  state: CrawlState,
  assetIds: Map<string, string>,
): Promise<void> {
  log('OWNERSHIP', '▶ Starting Ownership Agent');

  const supabase = getDb();
  const assets = [...state.assets.entries()]
    .filter(([, a]) => a.completeness === 'complete')
    .sort((a, b) => (b[1].capacity_mw || 0) - (a[1].capacity_mw || 0));

  // Budget check: ~$0.01 per asset (sonar + flash)
  const maxAssets = Math.min(
    assets.length,
    Math.floor(budgetRemaining(state.cost) / 0.015),
  );

  if (maxAssets === 0) {
    log('OWNERSHIP', 'Insufficient budget for ownership discovery');
    return;
  }

  log('OWNERSHIP', `Discovering ownership for ${maxAssets} of ${assets.length} complete assets`);
  let totalLinks = 0;

  for (const [key, asset] of assets.slice(0, maxAssets)) {
    if (budgetRemaining(state.cost) < 0.02) {
      log('OWNERSHIP', 'Budget circuit breaker — stopping ownership discovery');
      break;
    }

    const ownership = await discoverOwnership(state.developer, asset, state.cost);

    // Write co-owner links to developer_assets
    const assetId = assetIds.get(key);
    if (assetId && ownership.length > 0) {
      for (const detail of ownership) {
        // Skip the primary developer — already linked
        if (detail.entity_name.toLowerCase().includes(state.developer.toLowerCase())) continue;

        // Find or create the co-owner as a developer
        const { data: coOwner } = await supabase
          .from('developers')
          .select('id')
          .ilike('name', detail.entity_name)
          .maybeSingle();

        let coOwnerId: string;
        if (coOwner) {
          coOwnerId = coOwner.id;
        } else {
          const { data: newOwner, error } = await supabase
            .from('developers')
            .insert({
              name: detail.entity_name,
              entity_type: detail.role === 'tax_equity' ? 'sponsor' : 'developer',
            })
            .select('id')
            .single();
          if (error || !newOwner) continue;
          coOwnerId = newOwner.id;
        }

        await supabase
          .from('developer_assets')
          .upsert(
            {
              developer_id: coOwnerId,
              asset_id: assetId,
              ownership_pct: detail.ownership_pct,
              role: detail.role,
            },
            { onConflict: 'developer_id,asset_id' },
          );

        totalLinks++;
      }
    }
  }

  log('OWNERSHIP', `Created ${totalLinks} ownership links`);
}

// ── Verification Agent ───────────────────────────────────────────────────────

/** Verify a single asset via independent Perplexity search */
async function verifyAsset(
  asset: ClassifiedAsset,
  cost: CostTracker,
): Promise<VerificationResult & { asset_key: string }> {
  const prompt = `Verify the following renewable energy project exists:
- Name: "${asset.name}"
- Location: ${asset.state || 'unknown state'}${asset.county ? ', ' + asset.county : ''}
- Technology: ${asset.technology || 'unknown'}
- Capacity: ${asset.capacity_mw || 'unknown'} MW
- Status: ${asset.status || 'unknown'}

Confirm or deny: (1) Does this project exist? (2) Is the capacity correct? (3) Is it in the stated location? (4) Is the current status correct?
Be specific — cite sources.`;

  const result = await callPerplexity('sonar', DISCOVERY_SYSTEM_PROMPT, prompt, cost);
  await sleep(DELAY_MS);

  if (!result.text || result.text.length < 20) {
    return {
      asset_key: '',
      verified: false,
      confidence_score: 0,
      confidence_breakdown: {
        name_confirmed: false,
        capacity_confirmed: false,
        state_confirmed: false,
        status_confirmed: false,
        sources_found: 0,
      },
      notes: 'No verification data returned',
    };
  }

  // Use Gemini to score the verification
  const scorePrompt = `Analyze this verification result for the "${asset.name}" project (${asset.capacity_mw || '?'} MW, ${asset.state || '?'}, ${asset.technology || '?'}):

VERIFICATION TEXT:
${result.text.slice(0, 6000)}

Score each dimension as true/false:
- name_confirmed: Is the project name confirmed to exist?
- capacity_confirmed: Is the stated capacity approximately correct (±20%)?
- state_confirmed: Is the location (state) confirmed?
- status_confirmed: Is the operational status confirmed?

Also count how many distinct sources confirm the project.

Return JSON:
{
  "verified": true/false,
  "confidence_score": 0-100,
  "name_confirmed": true/false,
  "capacity_confirmed": true/false,
  "state_confirmed": true/false,
  "status_confirmed": true/false,
  "sources_found": <number>,
  "notes": "brief summary of findings"
}

Set verified=true if name_confirmed AND state_confirmed. confidence_score = (25 per confirmed dimension).`;

  const scored = await callGemini('gemini-2.5-flash', scorePrompt, cost, true);

  try {
    let cleaned = scored.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(cleaned);
    return {
      asset_key: '',
      verified: parsed.verified || false,
      confidence_score: parsed.confidence_score || 0,
      confidence_breakdown: {
        name_confirmed: parsed.name_confirmed || false,
        capacity_confirmed: parsed.capacity_confirmed || false,
        state_confirmed: parsed.state_confirmed || false,
        status_confirmed: parsed.status_confirmed || false,
        sources_found: parsed.sources_found || 0,
      },
      notes: parsed.notes || '',
    };
  } catch {
    return {
      asset_key: '',
      verified: false,
      confidence_score: 0,
      confidence_breakdown: {
        name_confirmed: false,
        capacity_confirmed: false,
        state_confirmed: false,
        status_confirmed: false,
        sources_found: 0,
      },
      notes: 'Failed to parse verification response',
    };
  }
}

/** Run verification for high-value assets */
async function runVerificationAgent(
  state: CrawlState,
  assetIds: Map<string, string>,
): Promise<VerificationResult[]> {
  log('VERIFICATION', '▶ Starting Verification Agent');

  const assets = [...state.assets.entries()]
    .filter(([, a]) => a.completeness === 'complete' || a.completeness === 'partial')
    .sort((a, b) => (b[1].capacity_mw || 0) - (a[1].capacity_mw || 0));

  // Budget: ~$0.01 per asset (sonar + flash)
  const maxAssets = Math.min(
    assets.length,
    Math.floor(budgetRemaining(state.cost) / 0.015),
  );

  if (maxAssets === 0) {
    log('VERIFICATION', 'Insufficient budget for verification');
    return [];
  }

  log('VERIFICATION', `Verifying ${maxAssets} of ${assets.length} assets`);
  const results: VerificationResult[] = [];

  for (const [key, asset] of assets.slice(0, maxAssets)) {
    if (budgetRemaining(state.cost) < 0.02) {
      log('VERIFICATION', 'Budget circuit breaker — stopping verification');
      break;
    }

    const result = await verifyAsset(asset, state.cost);
    result.asset_key = key;
    results.push(result);

    // Write to DB
    const assetId = assetIds.get(key);
    if (assetId) {
      const supabase = getDb();
      await supabase
        .from('asset_registry')
        .update({
          verified: result.verified,
          confidence_score: result.confidence_score,
          confidence_breakdown: result.confidence_breakdown,
          verified_at: result.verified ? new Date().toISOString() : null,
        })
        .eq('id', assetId);
    }
  }

  const verified = results.filter(r => r.verified).length;
  log('VERIFICATION', `Results: ${verified}/${results.length} verified`);
  return results;
}

// ── Quality Gate & Graduation ────────────────────────────────────────────────

/** Evaluate each asset for graduation: graduated=true requires all signals */
async function runQualityGate(
  state: CrawlState,
  assetIds: Map<string, string>,
  eiaMatches: EIAMatchResult[],
  verifications: VerificationResult[],
): Promise<{ graduated: number; staged: number }> {
  log('QUALITY', '▶ Running Quality Gate');

  const supabase = getDb();
  const eiaMap = new Map(eiaMatches.map(m => [m.asset_key, m]));
  const verifyMap = new Map(verifications.map(v => [v.asset_key, v]));

  let graduated = 0;
  let staged = 0;

  for (const [key, asset] of state.assets) {
    const assetId = assetIds.get(key);
    if (!assetId) continue;

    const eia = eiaMap.get(key);
    const verify = verifyMap.get(key);

    const reasons: string[] = [];

    // Check completeness
    if (asset.completeness !== 'complete') {
      reasons.push(`incomplete: missing ${asset.missing_fields.join(', ')}`);
    }

    // Check verification
    if (!verify?.verified) {
      reasons.push('not verified');
    }

    // Check EIA match (attempted, not required to match)
    // An asset can graduate without an EIA match (new development not yet in EIA)

    // Check confidence
    if (verify && verify.confidence_score < 50) {
      reasons.push(`low confidence (${verify.confidence_score})`);
    }

    const shouldGraduate = reasons.length === 0;

    const { error } = await supabase
      .from('asset_registry')
      .update({
        graduated: shouldGraduate,
        blocking_reason: shouldGraduate ? null : reasons.join('; '),
        eia_plant_code: eia?.eia_plant_code || null,
        match_confidence: eia?.match_confidence || 'none',
      })
      .eq('id', assetId);

    if (!error) {
      if (shouldGraduate) graduated++;
      else staged++;
    }

    // Tag in-memory too for reporting
    (asset as any).graduated = shouldGraduate;
    (asset as any).blocking_reason = shouldGraduate ? null : reasons.join('; ');
    (asset as any).eia_match = eia?.match_confidence || 'none';
    (asset as any).eia_plant_code = eia?.eia_plant_code || null;
    (asset as any).verified = verify?.verified || false;
    (asset as any).confidence_score = verify?.confidence_score || 0;
  }

  log('QUALITY', `Graduated: ${graduated} | Staged: ${staged}`);
  return { graduated, staged };
}

// ── Main Pipeline ────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(70));
  console.log(`  GenTrack Developer Crawl — ${DEVELOPER_NAME}`);
  console.log(`  Budget: $${BUDGET_LIMIT.toFixed(2)} | Max Fill Rounds: ${MAX_FILL_ROUNDS} | Dry Run: ${DRY_RUN}`);
  console.log(`  DB Writes: ${SKIP_DB ? 'OFF' : 'ON'} | Skip Discovery: ${SKIP_DISCOVERY}`);
  console.log('═'.repeat(70));

  if (!DRY_RUN && (!PERPLEXITY_API_KEY || !GEMINI_API_KEY)) {
    console.error('ERROR: Set PERPLEXITY_API_KEY and GEMINI_API_KEY environment variables.');
    process.exit(1);
  }

  // ── DB Initialization ──
  let developerId: string | undefined;
  let crawlRunId: string | undefined;

  if (!SKIP_DB) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or use SKIP_DB=true).');
      process.exit(1);
    }
    developerId = await ensureDeveloper(DEVELOPER_NAME);
    crawlRunId = await createCrawlLog(developerId, BUDGET_LIMIT);
  }

  const state: CrawlState = {
    developer: DEVELOPER_NAME,
    assets: new Map(),
    discoveries: [],
    cost: newCostTracker(),
    round: 0,
    strategies_used: [],
    states_searched: new Set(),
    developer_id: developerId,
    crawl_run_id: crawlRunId,
  };

  // ── Discovery + Extraction (Phases 1-4) ──
  if (SKIP_DISCOVERY) {
    // Load assets from latest crawl log file
    log('PIPELINE', '▶ Skipping discovery — loading from latest crawl log');
    const logsDir = path.join(__dirname, '..', 'logs');
    const logFiles = fs.readdirSync(logsDir)
      .filter(f => f.startsWith(`crawl-${DEVELOPER_NAME.toLowerCase().replace(/\s+/g, '-')}`) && f.endsWith('.json'))
      .sort()
      .reverse();

    if (logFiles.length === 0) {
      console.error('ERROR: No previous crawl log found. Run without SKIP_DISCOVERY first.');
      process.exit(1);
    }

    // Find the latest log with actual assets
    let latestLog: any = null;
    let usedFile = '';
    for (const f of logFiles) {
      const parsed = JSON.parse(fs.readFileSync(path.join(logsDir, f), 'utf-8'));
      if (parsed.assets && parsed.assets.length > 0) {
        latestLog = parsed;
        usedFile = f;
        break;
      }
    }

    if (!latestLog) {
      console.error('ERROR: No crawl log with assets found. Run without SKIP_DISCOVERY first.');
      process.exit(1);
    }

    log('PIPELINE', `Loaded ${latestLog.assets.length} assets from ${usedFile}`);

    for (const a of latestLog.assets) {
      const asset: DiscoveredAsset = {
        name: a.name,
        technology: a.technology,
        capacity_mw: a.capacity_mw,
        state: a.state,
        county: a.county,
        lat: a.lat || null,
        lng: a.lng || null,
        status: a.status,
        developer_ownership_pct: a.developer_ownership_pct || null,
        co_owners: a.co_owners || [],
        source_urls: a.source_urls || [],
        confidence: a.confidence || 'medium',
      };
      const key = dedupKey(asset);
      state.assets.set(key, classifyAsset(asset));
    }
    printStats(state, 'Loaded from crawl log');
  } else {
    // ── Phase 1: Initial Discovery ──
    log('PIPELINE', '▶ Phase 1: Initial Discovery (trying Deep Research, fallback to sonar-pro)');
  let deepResult = await runDiscovery(DEVELOPER_NAME, 'deep_research', state.cost);

  // Fallback to sonar-pro if Deep Research quota is exceeded
  if (deepResult.raw_text === '' || deepResult.raw_text.length < 50) {
    log('PIPELINE', '⚠ Deep Research unavailable — falling back to sonar-pro portfolio overview');
    deepResult = await runDiscovery(DEVELOPER_NAME, 'portfolio_overview', state.cost);
  }

  state.discoveries.push(deepResult);
  state.strategies_used.push(deepResult.strategy);

  // ── Phase 2: Initial Extraction ──
  log('PIPELINE', '▶ Phase 2: Initial Extraction');
  const initialAssets = await runExtraction(DEVELOPER_NAME, [deepResult], state.cost);
  for (const asset of initialAssets) {
    const key = dedupKey(asset);
    if (!state.assets.has(key)) {
      state.assets.set(key, classifyAsset(asset));
    }
  }
  printStats(state, 'After initial extraction');

  // ── Phase 3: Orchestrator-driven follow-up discovery ──
  log('PIPELINE', '▶ Phase 3: Orchestrator evaluation');
  let maxDiscoveryRounds = 10;
  while (maxDiscoveryRounds > 0 && budgetRemaining(state.cost) > 0.50) {
    const evaluation = await orchestratorEvaluate(state);
    if (evaluation.done || evaluation.next_strategies.length === 0) {
      log('ORCHESTRATOR', 'Discovery phase complete.');
      break;
    }

    for (const { strategy, context } of evaluation.next_strategies) {
      if (budgetRemaining(state.cost) < 0.20) break;

      // Skip states already searched
      if (strategy === 'by_state' && context?.state) {
        const st = context.state.toUpperCase();
        if (state.states_searched.has(st)) {
          log('PIPELINE', `Skipping ${st} — already searched`);
          continue;
        }
        state.states_searched.add(st);
      }

      log('PIPELINE', `▶ Follow-up discovery: ${strategy} ${context ? JSON.stringify(context) : ''}`);
      const result = await runDiscovery(DEVELOPER_NAME, strategy, state.cost, context);
      state.discoveries.push(result);
      state.strategies_used.push(`${strategy}(${context?.state || context?.technology || ''})`);

      const newAssets = await runExtraction(DEVELOPER_NAME, [result], state.cost);
      mergeAssets(state, newAssets);
    }

    printStats(state, `After follow-up round`);
    maxDiscoveryRounds--;
  }

  // ── Phase 4: Completeness Fill Loop ──
  log('PIPELINE', '▶ Phase 4: Completeness Fill Loop');
  for (let round = 0; round < MAX_FILL_ROUNDS; round++) {
    state.round = round + 1;
    const partials = [...state.assets.values()].filter(a => a.completeness !== 'complete').length;
    if (partials === 0) {
      log('FILL', 'All assets complete!');
      break;
    }
    if (budgetRemaining(state.cost) < 0.10) {
      log('FILL', `Budget too low ($${budgetRemaining(state.cost).toFixed(2)}), stopping fill.`);
      break;
    }

    const filled = await runFillRound(state);
    printStats(state, `After fill round ${round + 1}`);

    if (filled === 0) {
      log('FILL', 'No progress in fill round, stopping.');
      break;
    }
  }
  } // end of !SKIP_DISCOVERY

  // ── Phase 5: DB Write ──
  let assetIds = new Map<string, string>();
  if (!SKIP_DB) {
    log('PIPELINE', '▶ Phase 5: Writing assets to DB');
    await updateCrawlPhase(crawlRunId!, 'asset_triage', state);
    assetIds = await upsertAssets(state);
    await linkDeveloperAssets(developerId!, assetIds, state);
    printStats(state, 'After DB write');
  }

  // ── Phase 6: EIA Match ──
  let eiaMatches: EIAMatchResult[] = [];
  if (!SKIP_DB) {
    log('PIPELINE', '▶ Phase 6: EIA Match Agent');
    await updateCrawlPhase(crawlRunId!, 'eia_match', state);
    eiaMatches = await runEIAMatch(state);
    if (eiaMatches.length > 0) {
      await writeEIAMatches(eiaMatches, assetIds);
    }
    printStats(state, 'After EIA match');
  }

  // ── Phase 7: Ownership Agent ──
  if (!SKIP_DB && budgetRemaining(state.cost) > 0.20) {
    log('PIPELINE', '▶ Phase 7: Ownership Agent');
    await updateCrawlPhase(crawlRunId!, 'ownership', state);
    await runOwnershipAgent(state, assetIds);
    printStats(state, 'After ownership discovery');
  } else if (!SKIP_DB) {
    log('PIPELINE', `⚠ Skipping Ownership Agent — budget too low ($${budgetRemaining(state.cost).toFixed(2)})`);
  }

  // ── Phase 8: Verification Agent ──
  let verifications: VerificationResult[] = [];
  if (!SKIP_DB && budgetRemaining(state.cost) > 0.20) {
    log('PIPELINE', '▶ Phase 8: Verification Agent');
    await updateCrawlPhase(crawlRunId!, 'verification', state);
    verifications = await runVerificationAgent(state, assetIds);
    printStats(state, 'After verification');
  } else if (!SKIP_DB) {
    log('PIPELINE', `⚠ Skipping Verification Agent — budget too low ($${budgetRemaining(state.cost).toFixed(2)})`);
  }

  // ── Phase 9: Quality Gate ──
  let gateResult = { graduated: 0, staged: 0 };
  if (!SKIP_DB) {
    log('PIPELINE', '▶ Phase 9: Quality Gate & Graduation');
    gateResult = await runQualityGate(state, assetIds, eiaMatches, verifications);

    // Complete crawl log
    const finalStatus = budgetRemaining(state.cost) < 0.10 ? 'budget_paused' : 'completed';
    await completeCrawlLog(crawlRunId!, state, finalStatus);
  }

  // ── Final Report ──
  printFinalReport(state, eiaMatches, verifications, gateResult);

  // Write results to file for review
  const outputPath = path.join(__dirname, '..', 'logs', `crawl-${DEVELOPER_NAME.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.json`);
  const outputData = {
    developer: DEVELOPER_NAME,
    timestamp: new Date().toISOString(),
    cost: state.cost,
    strategies_used: state.strategies_used,
    db_enabled: !SKIP_DB,
    developer_id: state.developer_id || null,
    crawl_run_id: state.crawl_run_id || null,
    graduation: gateResult,
    assets: [...state.assets.values()].map(a => ({
      name: a.name,
      technology: a.technology,
      capacity_mw: a.capacity_mw,
      state: a.state,
      county: a.county,
      status: a.status,
      completeness: a.completeness,
      missing_fields: a.missing_fields,
      confidence: a.confidence,
      co_owners: a.co_owners,
      source_urls: a.source_urls,
      developer_ownership_pct: a.developer_ownership_pct,
      graduated: (a as any).graduated || false,
      blocking_reason: (a as any).blocking_reason || null,
      eia_match: (a as any).eia_match || 'none',
      eia_plant_code: (a as any).eia_plant_code || null,
      verified: (a as any).verified || false,
      confidence_score: (a as any).confidence_score || 0,
    })),
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  log('PIPELINE', `Results written to ${outputPath}`);
}

// ── Reporting ────────────────────────────────────────────────────────────────

function printStats(state: CrawlState, label: string): void {
  const assets = [...state.assets.values()];
  const complete = assets.filter(a => a.completeness === 'complete').length;
  const partial = assets.filter(a => a.completeness === 'partial').length;
  const stubs = assets.filter(a => a.completeness === 'stub').length;
  const totalMW = assets.reduce((sum, a) => sum + (a.capacity_mw || 0), 0);

  console.log(`\n  ── ${label} ──`);
  console.log(`  Assets: ${assets.length} total | ${complete} complete | ${partial} partial | ${stubs} stubs`);
  console.log(`  Total MW: ${totalMW.toFixed(0)} | Cost: $${state.cost.total_usd.toFixed(4)} | Budget left: $${budgetRemaining(state.cost).toFixed(2)}`);
  console.log();
}

function printFinalReport(
  state: CrawlState,
  eiaMatches: EIAMatchResult[] = [],
  verifications: VerificationResult[] = [],
  gateResult: { graduated: number; staged: number } = { graduated: 0, staged: 0 },
): void {
  const assets = [...state.assets.values()];
  const complete = assets.filter(a => a.completeness === 'complete');
  const partial = assets.filter(a => a.completeness === 'partial');
  const stubs = assets.filter(a => a.completeness === 'stub');
  const totalMW = assets.reduce((sum, a) => sum + (a.capacity_mw || 0), 0);
  const states = [...new Set(assets.map(a => a.state).filter(Boolean))];
  const techs = [...new Set(assets.map(a => a.technology).filter(Boolean))];

  console.log('\n' + '═'.repeat(70));
  console.log(`  CRAWL REPORT: ${state.developer}`);
  console.log(`  Budget: $${state.cost.total_usd.toFixed(4)} spent of $${BUDGET_LIMIT.toFixed(2)}`);
  console.log('═'.repeat(70));
  console.log(`\n  READY FOR PIPELINE (complete): ${complete.length} assets`);
  console.log(`    Total MW: ${complete.reduce((s, a) => s + (a.capacity_mw || 0), 0).toFixed(0)}`);
  console.log(`    States: ${[...new Set(complete.map(a => a.state))].filter(Boolean).join(', ')}`);
  console.log(`    Technologies: ${[...new Set(complete.map(a => a.technology))].filter(Boolean).join(', ')}`);

  if (partial.length > 0) {
    console.log(`\n  STAGING (partial): ${partial.length} assets`);
    const missingBreakdown: Record<string, number> = {};
    for (const a of partial) {
      for (const f of a.missing_fields) {
        missingBreakdown[f] = (missingBreakdown[f] || 0) + 1;
      }
    }
    for (const [field, count] of Object.entries(missingBreakdown).sort((a, b) => b[1] - a[1])) {
      console.log(`    - ${count} × missing ${field}`);
    }
  }

  if (stubs.length > 0) {
    console.log(`\n  STUBS (unconfirmed): ${stubs.length} assets`);
    for (const s of stubs.slice(0, 10)) {
      console.log(`    - ${s.name} (${s.state || '??'}) — missing: ${s.missing_fields.join(', ')}`);
    }
    if (stubs.length > 10) console.log(`    ... and ${stubs.length - 10} more`);
  }

  console.log(`\n  COST BREAKDOWN:`);
  console.log(`    Perplexity Sonar:          $${state.cost.perplexity_sonar.toFixed(4)}`);
  console.log(`    Perplexity Sonar Pro:      $${state.cost.perplexity_sonar_pro.toFixed(4)}`);
  console.log(`    Perplexity Deep Research:  $${state.cost.perplexity_deep_research.toFixed(4)}`);
  console.log(`    Gemini Flash:              $${state.cost.gemini_flash.toFixed(4)}`);
  console.log(`    Gemini Pro:                $${state.cost.gemini_pro.toFixed(4)}`);
  console.log(`    TOTAL:                     $${state.cost.total_usd.toFixed(4)}`);
  console.log(`    API calls:                 ${state.cost.call_count}`);

  // Phase 3 additions: EIA match, verification, graduation
  if (eiaMatches.length > 0) {
    const highEIA = eiaMatches.filter(m => m.match_confidence === 'high').length;
    const medEIA = eiaMatches.filter(m => m.match_confidence === 'medium').length;
    const lowEIA = eiaMatches.filter(m => m.match_confidence === 'low').length;
    const noEIA = eiaMatches.filter(m => m.match_confidence === 'none').length;
    console.log(`\n  EIA MATCH RESULTS:`);
    console.log(`    High: ${highEIA} | Medium: ${medEIA} | Low: ${lowEIA} | No match: ${noEIA}`);
    console.log(`    Match rate: ${((eiaMatches.length - noEIA) / eiaMatches.length * 100).toFixed(0)}%`);
  }

  if (verifications.length > 0) {
    const verified = verifications.filter(v => v.verified).length;
    const avgScore = verifications.reduce((s, v) => s + v.confidence_score, 0) / verifications.length;
    console.log(`\n  VERIFICATION RESULTS:`);
    console.log(`    Verified: ${verified}/${verifications.length} (${(verified / verifications.length * 100).toFixed(0)}%)`);
    console.log(`    Avg confidence: ${avgScore.toFixed(0)}/100`);
  }

  if (gateResult.graduated > 0 || gateResult.staged > 0) {
    console.log(`\n  QUALITY GATE:`);
    console.log(`    Graduated: ${gateResult.graduated} | Staged: ${gateResult.staged}`);
    console.log(`    Graduation rate: ${(gateResult.graduated / (gateResult.graduated + gateResult.staged) * 100).toFixed(0)}%`);
  }

  console.log(`\n  ALL DISCOVERED ASSETS:`);
  const sorted = assets.sort((a, b) => (a.state || 'ZZ').localeCompare(b.state || 'ZZ'));
  for (const a of sorted) {
    const grad = (a as any).graduated ? '★' : a.completeness === 'complete' ? '✓' : a.completeness === 'partial' ? '◐' : '○';
    const mw = a.capacity_mw ? `${a.capacity_mw} MW` : '?? MW';
    const eiaTag = (a as any).eia_match && (a as any).eia_match !== 'none' ? ` [EIA:${(a as any).eia_match}]` : '';
    const verTag = (a as any).verified ? ' [V]' : '';
    console.log(`    ${grad} ${a.name} | ${a.technology || '??'} | ${mw} | ${a.state || '??'} | ${a.status || '??'}${eiaTag}${verTag}`);
  }

  console.log('\n' + '═'.repeat(70));
}

// ── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
