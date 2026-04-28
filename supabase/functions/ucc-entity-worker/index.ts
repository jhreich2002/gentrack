/**
 * GenTrack — ucc-entity-worker Edge Function (Deno)
 *
 * Keystone step in the UCC lender research pipeline.
 * Resolves the legal entity (SPV/LLC) that holds a given plant asset,
 * then returns a ranked list of alias candidates for downstream UCC
 * and county record searches.
 *
 * Source priority (scraper-first, LLM only on miss):
 *   1. EIA data already in DB  — owner/operator/state/county (free)
 *   2. OpenCorporates API      — LLC registrations by name (free tier)
 *   3. Algorithmic aliases     — deterministic naming patterns (free)
 *   4. Perplexity sonar-pro    — FALLBACK ONLY if steps 1-3 yield zero candidates
 *
 * POST body:
 *   { plant_code, run_id, allow_llm_fallback?: boolean }
 *
 * Returns worker output schema:
 *   { task_status, completion_score, evidence_found, structured_results,
 *     source_urls, raw_evidence_snippets, open_questions, retry_recommendation,
 *     cost_usd, llm_fallback_used, duration_ms }
 *
 * Required secrets:
 *   SUPABASE_URL              (auto-injected)
 *   SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 *   PERPLEXITY_API_KEY        (only used on fallback)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const PERPLEXITY_URL    = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL  = 'sonar-pro';
const OPENCORP_BASE     = 'https://api.opencorporates.com/v0.4';
const PERPLEXITY_TIMEOUT_MS = 25_000;
const OPENCORP_TIMEOUT_MS   = 10_000;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

// State code → jurisdiction_code for OpenCorporates
const STATE_JURISDICTION: Record<string, string> = {
  AL: 'us_al', AK: 'us_ak', AZ: 'us_az', AR: 'us_ar', CA: 'us_ca',
  CO: 'us_co', CT: 'us_ct', DE: 'us_de', FL: 'us_fl', GA: 'us_ga',
  HI: 'us_hi', ID: 'us_id', IL: 'us_il', IN: 'us_in', IA: 'us_ia',
  KS: 'us_ks', KY: 'us_ky', LA: 'us_la', ME: 'us_me', MD: 'us_md',
  MA: 'us_ma', MI: 'us_mi', MN: 'us_mn', MS: 'us_ms', MO: 'us_mo',
  MT: 'us_mt', NE: 'us_ne', NV: 'us_nv', NH: 'us_nh', NJ: 'us_nj',
  NM: 'us_nm', NY: 'us_ny', NC: 'us_nc', ND: 'us_nd', OH: 'us_oh',
  OK: 'us_ok', OR: 'us_or', PA: 'us_pa', RI: 'us_ri', SC: 'us_sc',
  SD: 'us_sd', TN: 'us_tn', TX: 'us_tx', UT: 'us_ut', VT: 'us_vt',
  VA: 'us_va', WA: 'us_wa', WV: 'us_wv', WI: 'us_wi', WY: 'us_wy',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlantRow {
  eia_plant_code:        string;
  name:                  string;
  state:                 string;
  county:                string | null;
  nameplate_capacity_mw: number | null;
  owner:                 string | null;
  operator:              string | null;
  fuel_source:           string | null;
  cod:                   string | null;
}

interface SpvCandidate {
  name:            string;
  normalized:      string;
  confidence:      number;
  source:          'opencorporates' | 'sos_scrape' | 'algorithmic' | 'perplexity';
  source_url?:     string;
  jurisdiction?:   string;
  formation_date?: string;
  evidence?:       string;
}

interface WorkerOutput {
  task_status:           'success' | 'partial' | 'failed';
  completion_score:      number;
  evidence_found:        boolean;
  structured_results:    EntityResult[];
  source_urls:           string[];
  raw_evidence_snippets: string[];
  open_questions:        string[];
  retry_recommendation:  string | null;
  cost_usd:              number;
  llm_fallback_used:     boolean;
  duration_ms:           number;
  queries_attempted:     Array<{ source: string; query: string; hit_count: number; url: string | null }>;
}

interface EntityResult {
  sponsor_name:    string;
  owner_name:      string | null;
  operator_name:   string | null;
  spv_candidates:  SpvCandidate[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [ENTITY:${tag}] ${msg}`);
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  const requestFee = 0.005;
  return (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0 + requestFee;
}

/** Strip legal suffixes, punctuation, extra whitespace, lowercase */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|lp|inc|corp|co|ltd|na|n\.a\.|plc|holdings|project|wind|solar|energy|power|renewable|resources)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate deterministic SPV alias candidates from plant name + sponsor name.
 * These are tried first against UCC portals — no API cost.
 */
function generateAliases(
  plantName:   string,
  sponsorName: string | null,
  state:       string,
): SpvCandidate[] {
  const candidates: SpvCandidate[] = [];

  // Clean the plant name for use in LLC names
  const clean = plantName
    .replace(/\s+(wind farm|solar farm|solar project|wind project|solar|wind|farm|project|plant|energy center|power plant)\s*$/i, '')
    .trim();

  const words  = clean.split(/\s+/);
  const abbrev = words.map(w => w[0]).join('').toUpperCase();

  const suffixes = [
    'LLC',
    'Holdings LLC',
    'Project LLC',
    'Wind LLC',
    'Solar LLC',
    'Energy LLC',
    'Power LLC',
    'Renewable Energy LLC',
    'I LLC',
    'II LLC',
  ];

  for (const suffix of suffixes) {
    const name = `${clean} ${suffix}`;
    candidates.push({
      name,
      normalized: normalizeName(name),
      confidence: 40,
      source: 'algorithmic',
      jurisdiction: state,
    });
  }

  // Abbreviated variants
  if (abbrev.length >= 2) {
    candidates.push({
      name: `${abbrev} LLC`,
      normalized: normalizeName(`${abbrev} LLC`),
      confidence: 25,
      source: 'algorithmic',
      jurisdiction: state,
    });
  }

  // Two-word shortened version
  if (words.length > 2) {
    const short = words.slice(0, 2).join(' ');
    candidates.push({
      name: `${short} LLC`,
      normalized: normalizeName(`${short} LLC`),
      confidence: 30,
      source: 'algorithmic',
      jurisdiction: state,
    });
  }

  // Sponsor-prefixed variant
  if (sponsorName) {
    const sponsorClean = sponsorName
      .replace(/\b(inc|corp|llc|lp|resources|energy|renewables|power)\b/gi, '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(' ');
    const sponsorVariant = `${sponsorClean} ${clean} LLC`;
    candidates.push({
      name: sponsorVariant,
      normalized: normalizeName(sponsorVariant),
      confidence: 35,
      source: 'algorithmic',
      jurisdiction: state,
    });
  }

  return candidates;
}

// ── OpenCorporates search ─────────────────────────────────────────────────────

interface OcCompany {
  name:              string;
  company_number:    string;
  jurisdiction_code: string;
  incorporation_date?: string;
  opencorporates_url:  string;
}

async function searchOpenCorporates(
  query:            string,
  jurisdictionCode: string,
): Promise<SpvCandidate[]> {
  const url = new URL(`${OPENCORP_BASE}/companies/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('jurisdiction_code', jurisdictionCode);
  url.searchParams.set('per_page', '10');

  try {
    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(OPENCORP_TIMEOUT_MS),
      headers: { 'User-Agent': 'GenTrack-LenderResearch/1.0' },
    });

    if (!resp.ok) {
      log('OC', `HTTP ${resp.status} for query="${query}"`);
      return [];
    }

    const data = await resp.json();
    const companies: OcCompany[] = (data?.results?.companies ?? [])
      .map((item: { company: OcCompany }) => item.company);

    return companies
      .filter(c => c.name && c.jurisdiction_code?.startsWith('us_'))
      .map(c => ({
        name:           c.name,
        normalized:     normalizeName(c.name),
        confidence:     70,
        source:         'opencorporates' as const,
        source_url:     c.opencorporates_url,
        jurisdiction:   c.jurisdiction_code,
        formation_date: c.incorporation_date,
        evidence:       `OpenCorporates: ${c.name} (${c.jurisdiction_code}, #${c.company_number})`,
      }));
  } catch (err) {
    log('OC', `Error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Perplexity alias expansion (retry path) ───────────────────────────────────

/**
 * Targeted alias expansion: given known candidate names and a retry context,
 * ask Perplexity to identify alternate LLC spellings, numbering variants,
 * and historical names used in UCC/county filings.
 */
async function perplexityAliasExpansion(
  plantName:       string,
  sponsorName:     string | null,
  state:           string,
  existingNames:   string[],
  perplexityKey:   string,
): Promise<{ candidates: SpvCandidate[]; costUsd: number }> {
  const knownList = existingNames.slice(0, 5).map(n => `- ${n}`).join('\n');
  const sponsorHint = sponsorName ? ` The project is developed or owned by ${sponsorName}.` : '';

  const prompt = `I am searching for UCC financing statement filings related to the ${plantName} renewable energy project in ${state}.${sponsorHint}

Known entity name candidates found so far:
${knownList || '(none)'}

I need alternate LLC name variants that might appear in state UCC filings or county deed-of-trust records — things like Roman numeral suffixes (I, II, III), different abbreviations, parent-company prefixes, or alternate suffixes (Holdings, Owner, Finance, Tax Equity).

Return ONLY a compact JSON array of alternate names NOT in the known list above:
[{"name": "Exact LLC Name", "confidence": 70}]

Return [] if no reasonable alternates exist. Focus on names likely to appear in actual public filings.`;

  const body = {
    model: PERPLEXITY_MODEL,
    messages: [
      { role: 'system', content: 'You are a US renewable energy finance specialist. Return only valid JSON — no markdown, no explanation.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 500,
    temperature: 0,
  };

  try {
    const resp = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${perplexityKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PERPLEXITY_TIMEOUT_MS),
    });

    if (!resp.ok) throw new Error(`Perplexity HTTP ${resp.status}`);

    const data  = await resp.json();
    const usage = data.usage ?? {};
    const cost  = estimateCost(usage.prompt_tokens ?? 400, usage.completion_tokens ?? 250);
    const raw   = data.choices?.[0]?.message?.content ?? '[]';

    let parsed: Array<{ name: string; confidence?: number }> = [];
    try { parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim()); } catch { /* ignore */ }

    const candidates: SpvCandidate[] = parsed
      .filter(p => p.name && typeof p.name === 'string')
      .map(p => ({
        name:       p.name.trim(),
        normalized: normalizeName(p.name),
        confidence: Math.min(Math.max(p.confidence ?? 55, 0), 100),
        source:     'perplexity' as const,
        jurisdiction: state,
      }));

    return { candidates, costUsd: cost };
  } catch (err) {
    log('PERP_EXPAND', `Error: ${err instanceof Error ? err.message : String(err)}`);
    return { candidates: [], costUsd: 0 };
  }
}

// ── Perplexity fallback ───────────────────────────────────────────────────────

async function perplexityEntitySearch(
  plantName:   string,
  sponsorName: string | null,
  state:       string,
  county:      string | null,
  perplexityKey: string,
): Promise<{ candidates: SpvCandidate[]; costUsd: number; rawText: string }> {
  const location = [county, state].filter(Boolean).join(', ');
  const sponsorHint = sponsorName ? ` (developed or owned by ${sponsorName})` : '';

  const prompt = `What is the legal project company LLC or special-purpose entity (SPV) formed to hold the ${plantName} solar or wind plant in ${location}${sponsorHint}?

Search interconnection queue filings, state permit applications, county land records, and project websites. Look for LLC or LP entity names registered in ${state} that correspond to this specific plant.

Return ONLY a JSON array of entity name candidates, ranked by confidence:
[
  {
    "name": "Exact LLC Name Here",
    "confidence": 85,
    "evidence": "brief explanation of where this name was found",
    "source_url": "URL if available or null"
  }
]

Return an empty array [] if nothing is found. Do not include the parent developer/sponsor company itself — only project-level SPV/LLC entities.`;

  const body = {
    model: PERPLEXITY_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are a project finance research assistant specializing in US renewable energy asset ownership structures. Return only valid JSON arrays — no markdown, no explanation.',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens: 800,
    temperature: 0,
  };

  try {
    const resp = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${perplexityKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PERPLEXITY_TIMEOUT_MS),
    });

    if (!resp.ok) throw new Error(`Perplexity HTTP ${resp.status}`);

    const data  = await resp.json();
    const usage = data.usage ?? {};
    const cost  = estimateCost(usage.prompt_tokens ?? 600, usage.completion_tokens ?? 400);
    const raw   = data.choices?.[0]?.message?.content ?? '[]';

    let parsed: Array<{ name: string; confidence: number; evidence?: string; source_url?: string }> = [];
    try {
      const jsonStr = raw.replace(/```json\n?|\n?```/g, '').trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      log('PERP', 'JSON parse failed — no candidates extracted');
    }

    const candidates: SpvCandidate[] = parsed
      .filter(p => p.name && typeof p.name === 'string')
      .map(p => ({
        name:        p.name.trim(),
        normalized:  normalizeName(p.name),
        confidence:  Math.min(Math.max(p.confidence ?? 60, 0), 100),
        source:      'perplexity' as const,
        source_url:  p.source_url ?? undefined,
        evidence:    p.evidence,
      }));

    return { candidates, costUsd: cost, rawText: raw };
  } catch (err) {
    log('PERP', `Error: ${err instanceof Error ? err.message : String(err)}`);
    return { candidates: [], costUsd: 0, rawText: '' };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const __authDenied = checkInternalAuth(req);
  if (__authDenied) return __authDenied;
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 });

  const startMs = Date.now();

  try {
    const { plant_code, run_id, allow_llm_fallback = true, broader_sos_search = false } = await req.json();

    if (!plant_code) {
      return new Response(JSON.stringify({ error: 'plant_code required' }), { status: 400, headers: CORS });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const perplexityKey = Deno.env.get('PERPLEXITY_API_KEY') ?? '';

    // ── Step 1: Pull plant data from DB ──────────────────────────────────────
    log(plant_code, 'Step 1 — fetching plant data from DB');

    const { data: plant, error: plantErr } = await supabase
      .from('plants')
      .select('eia_plant_code, name, state, county, nameplate_capacity_mw, owner, operator, fuel_source, cod')
      .eq('eia_plant_code', plant_code)
      .single<PlantRow>();

    if (plantErr || !plant) {
      log(plant_code, `Plant not found: ${plantErr?.message}`);
      const output: WorkerOutput = {
        task_status: 'failed',
        completion_score: 0,
        evidence_found: false,
        structured_results: [],
        source_urls: [],
        raw_evidence_snippets: [],
        open_questions: [`Plant ${plant_code} not found in plants table: ${plantErr?.message ?? 'no data returned'}`],
        retry_recommendation: 'Check plant_code is valid and plant exists in plants',
        cost_usd: 0,
        llm_fallback_used: false,
        duration_ms: Date.now() - startMs,
        queries_attempted: [],
      };
      return new Response(JSON.stringify(output), { headers: CORS });
    }

    const sponsorName  = plant.owner ?? null;
    const operatorName = plant.operator ?? null;
    const state        = plant.state?.toUpperCase() ?? '';
    const county       = plant.county ?? null;
    const plantName    = plant.name;
    const jurisdCode   = STATE_JURISDICTION[state] ?? `us_${state.toLowerCase()}`;

    log(plant_code, `Plant: "${plantName}" | Owner: "${sponsorName}" | Operator: "${operatorName}" | ${county}, ${state}`);

    // Queries log for Trace tab
    const queriesAttempted: Array<{ source: string; query: string; hit_count: number; url: string | null }> = [];

    // ── Step 2: OpenCorporates search ─────────────────────────────────────────
    log(plant_code, 'Step 2 — OpenCorporates search');

    const ocQueries = [
      plantName,
      `${plantName} LLC`,
    ];
    if (sponsorName) {
      const sponsorShort = sponsorName.split(/\s+/).slice(0, 2).join(' ');
      ocQueries.push(`${sponsorShort} ${plantName}`);
    }
    // Also search by operator if distinct from owner
    if (operatorName && operatorName !== sponsorName) {
      ocQueries.push(operatorName);
    }

    const ocResultsRaw = await Promise.all(
      ocQueries.map(q => searchOpenCorporates(q, jurisdCode))
    );
    for (let i = 0; i < ocQueries.length; i++) {
      queriesAttempted.push({ source: 'opencorporates', query: ocQueries[i], hit_count: ocResultsRaw[i].length, url: `https://opencorporates.com/companies?q=${encodeURIComponent(ocQueries[i])}` });
    }
    const ocResults = ocResultsRaw.flat();
    log(plant_code, `OpenCorporates: ${ocResults.length} candidates`);

    // ── Step 3: Algorithmic alias generation (always runs) ────────────────────
    log(plant_code, 'Step 3 — generating algorithmic aliases');
    const algorithmic = generateAliases(plantName, sponsorName ?? operatorName, state);

    // ── Merge and deduplicate ─────────────────────────────────────────────────
    const seen    = new Set<string>();
    const allCandidates: SpvCandidate[] = [];

    // Prioritize OpenCorporates hits (higher confidence, real registrations)
    for (const c of [...ocResults, ...algorithmic]) {
      if (!seen.has(c.normalized)) {
        seen.add(c.normalized);
        allCandidates.push(c);
      }
    }

    const sourceUrls    = ocResults.filter(c => c.source_url).map(c => c.source_url!);
    const snippets      = ocResults.filter(c => c.evidence).map(c => c.evidence!);
    let   costUsd       = 0;
    let   llmFallback   = false;
    let   perplexityRaw = '';

    // ── Step 4: Perplexity fallback (only if no structured candidates found) ──
    const structuredHits = allCandidates.filter(c => c.source !== 'algorithmic');

    if (structuredHits.length === 0 && allow_llm_fallback && perplexityKey) {
      log(plant_code, 'Step 4 — no structured hits; triggering Perplexity fallback');
      llmFallback = true;

      const { candidates: perpCandidates, costUsd: perpCost, rawText } =
        await perplexityEntitySearch(plantName, sponsorName ?? operatorName, state, county, perplexityKey);

      queriesAttempted.push({ source: 'perplexity', query: `${plantName} SPV LLC ${state}`, hit_count: perpCandidates.length, url: null });

      perplexityRaw = rawText;
      costUsd       = perpCost;

      for (const c of perpCandidates) {
        if (!seen.has(c.normalized)) {
          seen.add(c.normalized);
          allCandidates.unshift(c); // prepend — higher confidence than algorithmic
          if (c.source_url) sourceUrls.push(c.source_url);
          if (c.evidence)   snippets.push(c.evidence);
        }
      }

      log(plant_code, `Perplexity fallback: ${perpCandidates.length} candidates, cost $${perpCost.toFixed(4)}`);
    } else if (structuredHits.length === 0 && !allow_llm_fallback) {
      log(plant_code, 'Step 4 — no structured hits, LLM fallback disabled');
    }

    // ── Step 4b: Alias expansion (retry path, or when few candidates) ─────────
    if (broader_sos_search && allow_llm_fallback && perplexityKey && allCandidates.length < 8) {
      log(plant_code, 'Step 4b — alias expansion (retry path)');
      const existingNames = allCandidates.map(c => c.name);
      const { candidates: expCandidates, costUsd: expCost } =
        await perplexityAliasExpansion(plantName, sponsorName ?? operatorName, state, existingNames, perplexityKey);

      queriesAttempted.push({ source: 'perplexity_expand', query: `${plantName} alias variants ${state}`, hit_count: expCandidates.length, url: null });
      costUsd += expCost;

      for (const c of expCandidates) {
        if (!seen.has(c.normalized)) {
          seen.add(c.normalized);
          allCandidates.push(c);
        }
      }
      if (!llmFallback && expCandidates.length > 0) llmFallback = true;
      log(plant_code, `Alias expansion: ${expCandidates.length} new variants, cost $${expCost.toFixed(4)}`);
    }

    // ── Upsert entity records and plant_entities ──────────────────────────────
    // Persist top-confidence candidates to ucc_entities for downstream workers
    const topCandidates = allCandidates
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);

    for (const cand of topCandidates) {
      const { data: entity } = await supabase
        .from('ucc_entities')
        .upsert({
          entity_name:     cand.name,
          entity_type:     'spv',
          normalized_name: cand.normalized,
          jurisdiction:    cand.jurisdiction ?? state,
          source:          cand.source,
          source_url:      cand.source_url ?? null,
        }, { onConflict: 'normalized_name,entity_type,jurisdiction', ignoreDuplicates: false })
        .select('id')
        .single();

      if (entity?.id) {
        await supabase.from('ucc_plant_entities').upsert({
          plant_code:        plant_code,
          entity_id:         entity.id,
          relationship_type: 'spv',
          confidence_score:  cand.confidence,
          source:            cand.source,
        }, { onConflict: 'plant_code,entity_id,relationship_type', ignoreDuplicates: false });
      }
    }

    // Upsert sponsor entity
    if (sponsorName) {
      const sponsorNorm = normalizeName(sponsorName);
      const { data: sponsorEntity } = await supabase
        .from('ucc_entities')
        .upsert({
          entity_name:     sponsorName,
          entity_type:     'sponsor',
          normalized_name: sponsorNorm,
          jurisdiction:    state,
          source:          'opencorporates',
        }, { onConflict: 'normalized_name,entity_type,jurisdiction', ignoreDuplicates: false })
        .select('id')
        .single();

      if (sponsorEntity?.id) {
        await supabase.from('ucc_plant_entities').upsert({
          plant_code:        plant_code,
          entity_id:         sponsorEntity.id,
          relationship_type: 'sponsor',
          confidence_score:  90,
          source:            'eia_db',
        }, { onConflict: 'plant_code,entity_id,relationship_type', ignoreDuplicates: false });
      }
    }

    // ── Build worker output ───────────────────────────────────────────────────
    const hasStructured = allCandidates.some(c => c.source !== 'algorithmic');
    const topConfidence = allCandidates[0]?.confidence ?? 0;

    // Completion score:
    // 90+ = real structured match (OpenCorporates or Perplexity hit)
    // 60  = algorithmic aliases only (enough to attempt UCC search)
    // 0   = nothing at all
    let completionScore = 0;
    if (allCandidates.length > 0 && hasStructured) completionScore = 90;
    else if (allCandidates.length > 0)              completionScore = 60;

    const openQuestions: string[] = [];
    if (!hasStructured) openQuestions.push('No confirmed SPV registration found — UCC search will use algorithmic aliases only');
    if (!sponsorName)   openQuestions.push('Sponsor/owner name unknown — alias generation may be incomplete');

    let retryRec: string | null = null;
    if (allCandidates.length < 3) {
      retryRec = 'Too few aliases — retry with broader search terms or manual sponsor name override';
    }

    const result: EntityResult = {
      sponsor_name:  sponsorName ?? operatorName ?? 'Unknown',
      owner_name:    plant.owner ?? null,
      operator_name: operatorName,
      spv_candidates: topCandidates,
    };

    if (perplexityRaw) snippets.push(`Perplexity raw response: ${perplexityRaw.slice(0, 500)}`);

    const output: WorkerOutput = {
      task_status:           completionScore >= 60 ? 'success' : 'failed',
      completion_score:      completionScore,
      evidence_found:        allCandidates.length > 0,
      structured_results:    [result],
      source_urls:           [...new Set(sourceUrls)],
      raw_evidence_snippets: snippets.slice(0, 10),
      open_questions:        openQuestions,
      retry_recommendation:  retryRec,
      cost_usd:              costUsd,
      llm_fallback_used:     llmFallback,
      duration_ms:           Date.now() - startMs,
      queries_attempted:     queriesAttempted,
    };

    // ── Write task record (non-fatal) ─────────────────────────────────────────
    // Note: supervisor calls recordTask() after invokeWorker returns — no insert needed here.

    log(plant_code, `Done — score=${completionScore}, candidates=${allCandidates.length}, llm=${llmFallback}, cost=$${costUsd.toFixed(4)}, ${output.duration_ms}ms`);

    return new Response(JSON.stringify(output), { headers: CORS });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', msg);
    const output: WorkerOutput = {
      task_status: 'failed',
      completion_score: 0,
      evidence_found: false,
      structured_results: [],
      source_urls: [],
      raw_evidence_snippets: [],
      open_questions: [msg],
      retry_recommendation: 'Unexpected error — check edge function logs',
      cost_usd: 0,
      llm_fallback_used: false,
      duration_ms: 0,
      queries_attempted: [],
    };
    return new Response(JSON.stringify(output), { status: 500, headers: CORS });
  }
});
