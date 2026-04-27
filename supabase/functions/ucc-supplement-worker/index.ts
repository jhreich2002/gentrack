/**
 * GenTrack — ucc-supplement-worker Edge Function (Deno)
 *
 * Corroboration and pattern inference. Runs ONLY when at least one filing
 * was found by the UCC, county, or EDGAR workers — nothing to enrich otherwise.
 *
 * Steps:
 *   1. Pattern lookup in ucc_sponsor_history (free, zero API cost)
 *      If sponsor has ≥2 observed deals with a lender in matching region/vintage,
 *      that lender gets flagged as highly_likely even without a direct filing.
 *   2. Sponsor portfolio page scrape (free HTTP)
 *      Parse for financing mentions and lender names in deal announcements.
 *   3. Perplexity + Gemini fallback (ONLY if pattern table thin AND scrape empty)
 *      Searches trade press (IJGlobal, PFI, Bloomberg NEF) for sponsor
 *      financing patterns. Tags findings as sponsor_pattern not direct_plant.
 *
 * POST body:
 *   { plant_code, run_id, plant_name, sponsor_name, state, cod_year,
 *     capacity_mw, spv_aliases, existing_lenders[], allow_llm_fallback? }
 *
 * Returns standard worker output schema.
 *
 * Required secrets:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 *   PERPLEXITY_API_KEY
 *   GEMINI_API_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 20_000;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

const HEADERS = {
  'User-Agent': 'GenTrack-LenderResearch/1.0 (compliance@example.com)',
  'Accept':     'text/html,application/json,*/*',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface SpvAlias {
  name:       string;
  normalized: string;
  confidence: number;
}

interface SponsorPatternHit {
  lender_name:        string;
  lender_normalized:  string;
  lender_entity_id:   number | null;
  observed_count:     number;
  last_seen_year:     number | null;
  confidence_class:   'confirmed' | 'highly_likely' | 'possible';
  basis:              'sponsor_history' | 'sponsor_scrape' | 'trade_press';
  source_url:         string | null;
  excerpt:            string;
}

interface WorkerOutput {
  task_status:           'success' | 'partial' | 'failed';
  completion_score:      number;
  evidence_found:        boolean;
  structured_results:    SponsorPatternHit[];
  source_urls:           string[];
  raw_evidence_snippets: string[];
  open_questions:        string[];
  retry_recommendation:  string | null;
  cost_usd:              number;
  llm_fallback_used:     boolean;
  duration_ms:           number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [SUPPLEMENT:${tag}] ${msg}`);
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|lp|inc|corp|co|ltd|na|n\.a\.|plc|as agent|as collateral agent|holdings|project|wind|solar|energy|power|renewable|resources)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function estimateCost(inputTokens: number, outputTokens: number, model: 'perplexity' | 'gemini'): number {
  if (model === 'perplexity') return (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
  // gemini-1.5-pro: ~$3.50/M input, $10.50/M output (approximate)
  return (inputTokens / 1_000_000) * 3.5 + (outputTokens / 1_000_000) * 10.5;
}

// ── Step 1: Pattern lookup from ucc_sponsor_history ──────────────────────────

async function lookupSponsorHistory(
  supabase:    ReturnType<typeof createClient>,
  sponsorName: string,
  state:       string,
  codYear:     number | null,
): Promise<SponsorPatternHit[]> {
  // Find the sponsor entity ID first
  const { data: sponsorEntity } = await supabase
    .from('ucc_entities')
    .select('id')
    .eq('entity_type', 'sponsor')
    .ilike('normalized_name', `%${normalizeName(sponsorName)}%`)
    .limit(1)
    .single();

  if (!sponsorEntity?.id) return [];

  // Query sponsor history with this sponsor
  const { data: history } = await supabase
    .from('ucc_sponsor_history')
    .select(`
      id,
      observed_count,
      last_seen,
      lender_entity_id,
      ucc_entities!lender_entity_id (
        id,
        entity_name,
        normalized_name,
        jurisdiction
      )
    `)
    .eq('sponsor_entity_id', sponsorEntity.id)
    .gte('observed_count', 2)
    .order('observed_count', { ascending: false })
    .limit(10);

  if (!history?.length) return [];

  const hits: SponsorPatternHit[] = [];
  for (const row of history) {
    const entity = (row as Record<string, unknown>).ucc_entities as Record<string, unknown> | null;
    if (!entity) continue;

    const lastSeenYear = row.last_seen ? new Date(row.last_seen as string).getFullYear() : null;

    // Boost confidence if the lender is in the same state or same vintage year
    const sameJurisdiction = String(entity.jurisdiction ?? '').toUpperCase() === state.toUpperCase();
    const sameVintage      = lastSeenYear && codYear && Math.abs(lastSeenYear - codYear) <= 3;
    const confidence: 'confirmed' | 'highly_likely' | 'possible' =
      sameJurisdiction || sameVintage ? 'highly_likely' : 'possible';

    hits.push({
      lender_name:       String(entity.entity_name ?? ''),
      lender_normalized: String(entity.normalized_name ?? ''),
      lender_entity_id:  Number(entity.id),
      observed_count:    Number(row.observed_count),
      last_seen_year:    lastSeenYear,
      confidence_class:  confidence,
      basis:             'sponsor_history',
      source_url:        null,
      excerpt:           `${sponsorName} used ${entity.entity_name} in ${row.observed_count} observed deals${lastSeenYear ? ` (last seen ${lastSeenYear})` : ''}`,
    });
  }

  return hits;
}

// ── Step 2: Sponsor portfolio page scrape ────────────────────────────────────

// Map of known sponsor portfolio URLs — populated with major sponsors
const SPONSOR_PORTFOLIO_URLS: Record<string, string> = {
  'nextera':        'https://www.nexteraenergy.com/projects',
  'aes':            'https://www.aes.com/our-businesses/renewables',
  'avangrid':       'https://www.avangrid.com/avangrid/our-businesses/renewables',
  'clearway':       'https://www.clearway.com/renewable-energy',
  'enel':           'https://www.enel.com/en/business/green-power/renewables',
  'berkshire':      'https://www.berkshirehathawayenergyco.com/operations',
  'invenergy':      'https://invenergy.com/projects',
  'pattern energy': 'https://patternenergy.com/projects',
  'ørsted':         'https://us.orsted.com/renewable-energy-solutions',
  'orsted':         'https://us.orsted.com/renewable-energy-solutions',
  'lightsource':    'https://lightsourcebp.com/us/projects',
  'intersect':      'https://www.intersectpower.com/projects',
  'terra-gen':      'https://terra-gen.com/projects',
};

async function scrapeSponsorPortfolio(
  sponsorName: string,
  plantName:   string,
): Promise<{ hits: SponsorPatternHit[]; sourceUrl: string | null }> {
  const sponsorKey = Object.keys(SPONSOR_PORTFOLIO_URLS).find(k =>
    sponsorName.toLowerCase().includes(k)
  );

  if (!sponsorKey) return { hits: [], sourceUrl: null };

  const url = SPONSOR_PORTFOLIO_URLS[sponsorKey];
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return { hits: [], sourceUrl: null };

    const html    = await resp.text();
    const text    = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const hits:   SponsorPatternHit[] = [];

    // Look for lender names near the plant name (within 300 chars)
    const plantIdx = text.toLowerCase().indexOf(plantName.toLowerCase().split(' ')[0]);
    if (plantIdx === -1) return { hits: [], sourceUrl: url };

    const window = text.slice(Math.max(0, plantIdx - 100), plantIdx + 400);

    // Bank/financial institution name patterns
    const lenderPattern = /([A-Z][A-Za-z\s]+(?:Bank|Capital|Financial|Partners|Trust|Credit|Insurance|Citibank|JPMorgan|Wells Fargo|Goldman|Morgan Stanley|KeyBank|Rabobank|CoBank|ING|MUFG|BNP|Barclays|HSBC|Natixis|Deutsche|Société)[A-Za-z\s,\.]*)/g;
    let match;
    while ((match = lenderPattern.exec(window)) !== null) {
      const lenderName = match[1].trim();
      if (lenderName.length < 5 || lenderName.length > 80) continue;

      hits.push({
        lender_name:       lenderName,
        lender_normalized: normalizeName(lenderName),
        lender_entity_id:  null,
        observed_count:    1,
        last_seen_year:    null,
        confidence_class:  'possible',
        basis:             'sponsor_scrape',
        source_url:        url,
        excerpt:           window.slice(0, 200).trim(),
      });
    }

    // Deduplicate by normalized name
    const seen = new Set<string>();
    return {
      hits: hits.filter(h => {
        if (seen.has(h.lender_normalized)) return false;
        seen.add(h.lender_normalized);
        return true;
      }),
      sourceUrl: url,
    };
  } catch {
    return { hits: [], sourceUrl: null };
  }
}

// ── Step 3a: Perplexity trade press search ────────────────────────────────────

async function perplexityTradePressSearch(
  sponsorName: string,
  state:       string,
  codYear:     number | null,
): Promise<{ hits: SponsorPatternHit[]; cost: number }> {
  const apiKey = Deno.env.get('PERPLEXITY_API_KEY');
  if (!apiKey) return { hits: [], cost: 0 };

  const yearRange = codYear ? `${codYear - 2}–${codYear + 2}` : 'recent years';

  const prompt = `Search IJGlobal, Project Finance International (PFI), Bloomberg NEF, and S&P Global for ${sponsorName}'s solar and wind project financing in ${state} during ${yearRange}.

List lenders, administrative agents, and tax equity investors that provided financing to ${sponsorName} for renewable energy projects in ${state}. Focus on project-level debt, construction loans, term loans, and tax equity transactions.

Return a JSON array of objects:
{
  "lender_name": "exact institution name",
  "facility_type": "construction_loan" | "term_loan" | "tax_equity" | "revolving_credit" | "unknown",
  "observed_count": number (how many times mentioned),
  "source": "IJGlobal" | "PFI" | "Bloomberg NEF" | "other",
  "source_url": "URL if available",
  "excerpt": "brief quote or summary"
}

Return only the JSON array.`;

  try {
    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:    'sonar-pro',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) return { hits: [], cost: 0 };
    const data = await resp.json();

    const content      = data.choices?.[0]?.message?.content ?? '';
    const inputTokens  = data.usage?.prompt_tokens     ?? 400;
    const outputTokens = data.usage?.completion_tokens ?? 300;
    const cost         = estimateCost(inputTokens, outputTokens, 'perplexity');

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return { hits: [], cost };

    const parsed: Array<Record<string, unknown>> = JSON.parse(jsonMatch[0]);
    const hits: SponsorPatternHit[] = parsed
      .filter(r => r.lender_name && String(r.lender_name).length > 3)
      .map(r => ({
        lender_name:       String(r.lender_name ?? ''),
        lender_normalized: normalizeName(String(r.lender_name ?? '')),
        lender_entity_id:  null,
        observed_count:    Number(r.observed_count ?? 1),
        last_seen_year:    null,
        confidence_class:  'possible' as const,
        basis:             'trade_press' as const,
        source_url:        r.source_url ? String(r.source_url) : null,
        excerpt:           String(r.excerpt ?? ''),
      }));

    return { hits, cost };
  } catch {
    return { hits: [], cost: 0 };
  }
}

// ── Step 3b: Gemini disambiguation ───────────────────────────────────────────
// Only runs if Perplexity returns ambiguous or conflicting lender names.

async function geminiDisambiguateLenders(
  candidates: SponsorPatternHit[],
  plantName:  string,
  state:      string,
): Promise<{ hits: SponsorPatternHit[]; cost: number }> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey || candidates.length < 2) return { hits: candidates, cost: 0 };

  // Only invoke if there are near-duplicate names that need deduplication
  const namePairs: Array<[string, string]> = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i].lender_normalized;
      const b = candidates[j].lender_normalized;
      // Simple similarity check — if >70% of tokens overlap
      const tokensA = a.split(' ');
      const tokensB = b.split(' ');
      const shared  = tokensA.filter(t => tokensB.includes(t) && t.length > 2);
      const similarity = shared.length / Math.max(tokensA.length, tokensB.length);
      if (similarity > 0.6) namePairs.push([candidates[i].lender_name, candidates[j].lender_name]);
    }
  }

  if (!namePairs.length) return { hits: candidates, cost: 0 };

  const prompt = `Are these lender name pairs referring to the same institution? Answer for each pair.

${namePairs.map(([a, b], i) => `Pair ${i + 1}: "${a}" vs "${b}"`).join('\n')}

Context: financing for solar/wind project "${plantName}" in ${state}.

Return JSON array: [{"pair": 1, "same_entity": true/false, "canonical_name": "preferred name if same entity"}]`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${Deno.env.get('GEMINI_API_KEY')}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 500 },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!resp.ok) return { hits: candidates, cost: 0 };
    const data         = await resp.json();
    const content      = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const inputTokens  = data.usageMetadata?.promptTokenCount     ?? 200;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 100;
    const cost         = estimateCost(inputTokens, outputTokens, 'gemini');

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return { hits: candidates, cost };

    const merges: Array<{ pair: number; same_entity: boolean; canonical_name?: string }> = JSON.parse(jsonMatch[0]);

    // Apply merges — consolidate duplicate lender names
    const merged = [...candidates];
    for (const m of merges) {
      if (!m.same_entity || !m.canonical_name) continue;
      const [nameA, nameB] = namePairs[m.pair - 1] ?? [];
      if (!nameA || !nameB) continue;

      const idxA = merged.findIndex(c => c.lender_name === nameA);
      const idxB = merged.findIndex(c => c.lender_name === nameB);
      if (idxA === -1 || idxB === -1) continue;

      // Keep A with canonical name, remove B
      merged[idxA] = {
        ...merged[idxA],
        lender_name:       m.canonical_name,
        lender_normalized: normalizeName(m.canonical_name),
        observed_count:    merged[idxA].observed_count + merged[idxB].observed_count,
      };
      merged.splice(idxB, 1);
    }

    return { hits: merged, cost };
  } catch {
    return { hits: candidates, cost: 0 };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 });

  const startMs = Date.now();

  try {
    const {
      plant_code,
      run_id,
      plant_name,
      sponsor_name,
      state,
      cod_year         = null,
      capacity_mw      = null,
      spv_aliases      = [],
      existing_lenders = [],
      allow_llm_fallback = true,
    }: {
      plant_code:         string;
      run_id:             string;
      plant_name:         string;
      sponsor_name:       string | null;
      state:              string;
      cod_year?:          number | null;
      capacity_mw?:       number | null;
      spv_aliases?:       SpvAlias[];
      existing_lenders?:  string[];
      allow_llm_fallback?: boolean;
    } = await req.json();

    if (!plant_code || !plant_name || !state) {
      return new Response(
        JSON.stringify({ error: 'plant_code, plant_name, and state required' }),
        { status: 400, headers: CORS },
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const allHits:    SponsorPatternHit[] = [];
    const sourceUrls: string[] = [];
    const snippets:   string[] = [];
    let   totalCost   = 0;
    let   llmUsed     = false;

    // ── Step 1: Sponsor history pattern lookup (free) ──────────────────────
    if (sponsor_name) {
      log(plant_code, `Step 1: Sponsor history lookup for "${sponsor_name}"`);
      const historyHits = await lookupSponsorHistory(supabase, sponsor_name, state, cod_year ?? null);
      log(plant_code, `  ${historyHits.length} pattern hits from sponsor history`);
      allHits.push(...historyHits);
      snippets.push(...historyHits.map(h => h.excerpt));
    }

    // ── Step 2: Sponsor portfolio scrape (free) ────────────────────────────
    if (sponsor_name) {
      log(plant_code, `Step 2: Sponsor portfolio scrape for "${sponsor_name}"`);
      const { hits: scrapeHits, sourceUrl } = await scrapeSponsorPortfolio(sponsor_name, plant_name);
      log(plant_code, `  ${scrapeHits.length} lender mentions from portfolio page`);

      if (sourceUrl && !sourceUrls.includes(sourceUrl)) sourceUrls.push(sourceUrl);

      // Only add scrape hits not already covered by history
      const existingNormalized = new Set(allHits.map(h => h.lender_normalized));
      for (const hit of scrapeHits) {
        if (!existingNormalized.has(hit.lender_normalized)) {
          allHits.push(hit);
          snippets.push(hit.excerpt);
          existingNormalized.add(hit.lender_normalized);
        }
      }
    }

    // ── Step 3: LLM fallback (only if steps 1+2 are thin) ─────────────────
    const patternThin = allHits.length < 2;

    if (patternThin && allow_llm_fallback && sponsor_name) {
      log(plant_code, `Step 3: LLM fallback — pattern table thin (${allHits.length} hits)`);
      llmUsed = true;

      const { hits: plxHits, cost: plxCost } = await perplexityTradePressSearch(sponsor_name, state, cod_year ?? null);
      totalCost += plxCost;
      log(plant_code, `  Perplexity → ${plxHits.length} hits, cost=$${plxCost.toFixed(4)}`);

      for (const hit of plxHits) {
        if (hit.source_url && !sourceUrls.includes(hit.source_url)) sourceUrls.push(hit.source_url);
        allHits.push(hit);
        snippets.push(hit.excerpt);
      }

      // Gemini disambiguation if near-duplicate names
      if (allHits.length > 2) {
        const { hits: disambiguated, cost: gemCost } = await geminiDisambiguateLenders(allHits, plant_name, state);
        totalCost += gemCost;
        if (gemCost > 0) log(plant_code, `  Gemini disambiguated → ${disambiguated.length} hits, cost=$${gemCost.toFixed(4)}`);
        allHits.length = 0;
        allHits.push(...disambiguated);
      }
    }

    // Filter out lenders already found by other workers (no duplicate credit)
    const existingNorm = new Set(existing_lenders.map(normalizeName));
    const newHits = allHits.filter(h => !existingNorm.has(h.lender_normalized));

    log(plant_code, `Total: ${newHits.length} new lender patterns (${allHits.length - newHits.length} already known)`);

    // Persist new patterns to ucc_sponsor_history
    for (const hit of newHits) {
      if (!sponsor_name) continue;

      // Ensure sponsor entity exists
      const { data: sponsorEntity } = await supabase
        .from('ucc_entities')
        .upsert({
          entity_name:     sponsor_name,
          entity_type:     'sponsor',
          normalized_name: normalizeName(sponsor_name),
          jurisdiction:    state,
          source:          'supplement_worker',
          source_url:      null,
        }, { onConflict: 'normalized_name,entity_type,jurisdiction', ignoreDuplicates: false })
        .select('id')
        .single();

      // Ensure lender entity exists
      const { data: lenderEntity } = await supabase
        .from('ucc_entities')
        .upsert({
          entity_name:     hit.lender_name,
          entity_type:     'lender',
          normalized_name: hit.lender_normalized,
          jurisdiction:    state,
          source:          hit.basis === 'sponsor_history' ? 'sponsor_history'
                         : hit.basis === 'sponsor_scrape'  ? 'web_scrape'
                         : 'perplexity',
          source_url:      hit.source_url,
        }, { onConflict: 'normalized_name,entity_type,jurisdiction', ignoreDuplicates: false })
        .select('id')
        .single();

      const lenderEntityId = hit.lender_entity_id ?? lenderEntity?.id ?? null;

      // Update sponsor history
      if (sponsorEntity?.id && lenderEntityId) {
        await supabase.from('ucc_sponsor_history').upsert({
          sponsor_entity_id: sponsorEntity.id,
          lender_entity_id:  lenderEntityId,
          observed_count:    hit.observed_count,
          last_seen:         hit.last_seen_year ? `${hit.last_seen_year}-01-01` : new Date().toISOString().slice(0, 10),
        }, { onConflict: 'sponsor_entity_id,lender_entity_id', ignoreDuplicates: false });
      }

      // Record evidence
      await supabase.from('ucc_evidence_records').insert({
        plant_code,
        run_id:                   run_id ?? null,
        lender_entity_id:         lenderEntityId,
        source_type:              hit.basis === 'sponsor_history' ? 'sponsor_history'
                                : hit.basis === 'sponsor_scrape'  ? 'web_scrape'
                                : 'perplexity',
        source_url:               hit.source_url,
        excerpt:                  hit.excerpt,
        raw_text:                 hit.excerpt,
        extracted_fields: {
          lender_name:      hit.lender_name,
          sponsor_name,
          observed_count:   hit.observed_count,
          confidence_class: hit.confidence_class,
          basis:            hit.basis,
        },
        worker_name:              'ucc_supplement_worker',
        confidence_contribution:  hit.confidence_class,
      });
    }

    // Scoring:
    // 80 = sponsor history patterns found (high-quality inference)
    // 65 = portfolio scrape or trade press found lenders
    // 50 = no new patterns but sponsor was checked (valid)
    // 30 = no sponsor name provided — couldn't run pattern check

    const completionScore =
      newHits.some(h => h.basis === 'sponsor_history')                ? 80
      : newHits.length > 0                                            ? 65
      : sponsor_name                                                  ? 50
      : 30;

    const openQuestions: string[] = [];
    if (!sponsor_name) {
      openQuestions.push('Sponsor name unknown — could not run pattern lookup. Run entity worker first.');
    }
    if (newHits.length === 0 && sponsor_name) {
      openQuestions.push(`No additional lender patterns found for sponsor "${sponsor_name}" in ${state}`);
    }

    const output: WorkerOutput = {
      task_status:           'success',
      completion_score:      completionScore,
      evidence_found:        newHits.length > 0,
      structured_results:    newHits,
      source_urls:           sourceUrls,
      raw_evidence_snippets: snippets.slice(0, 10),
      open_questions:        openQuestions,
      retry_recommendation:  null,
      cost_usd:              totalCost,
      llm_fallback_used:     llmUsed,
      duration_ms:           Date.now() - startMs,
    };

    if (run_id) {
      await supabase.from('ucc_agent_tasks').insert({
        run_id,
        plant_code,
        agent_type:        'supplement_worker',
        attempt_number:    1,
        task_status:       'success',
        completion_score:  completionScore,
        evidence_found:    newHits.length > 0,
        llm_fallback_used: llmUsed,
        cost_usd:          totalCost,
        duration_ms:       output.duration_ms,
        output_json:       output,
      });
    }

    log(plant_code, `Done — ${newHits.length} new hits, score=${completionScore}, cost=$${totalCost.toFixed(4)}, ${output.duration_ms}ms`);
    return new Response(JSON.stringify(output), { headers: CORS });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', msg);
    return new Response(JSON.stringify({
      task_status: 'failed', completion_score: 0, evidence_found: false,
      structured_results: [], source_urls: [], raw_evidence_snippets: [],
      open_questions: [msg], retry_recommendation: 'Unexpected error — check logs',
      cost_usd: 0, llm_fallback_used: false, duration_ms: 0,
    }), { status: 500, headers: CORS });
  }
});
