/**
 * GenTrack — lender-source-records (v4) Edge Function (Deno)
 *
 * Queries UCC state filings, DOE LPO loan database, and FERC Form 1
 * for debt-financing records linked to a specific plant.
 * All sources are free / public. Perplexity is used for UCC searches where
 * direct scraping is impractical (county fragmentation).
 *
 * POST body:
 *   { session_id, plant_id, plant_name, state, county?,
 *     spv_aliases?: string[], budget_usd?: number }
 *
 * Response:
 *   { ok, claims_count, cost_usd, budget_exceeded }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const TIMEOUT_MS     = 20_000;

// Perplexity sonar pricing: ~$0.005/1K tokens input, ~$0.015/1K output (sonar)
// Each query is typically ~500 input + ~300 output → ~$0.0075
const COST_PER_PERPLEXITY_QUERY = 0.008;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// DOE LPO query removed — near-zero hit rate on private-market renewables;
// replaced by financing tombstone search below.

interface RawClaim {
  raw_lender_name: string;
  quote:           string;
  source_url:      string;
  source_type:     'ucc_filing' | 'county_record' | 'edgar_filing' | 'web_page';
  evidence_date:   string | null;
}

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [RECORDS:${tag}] ${msg}`);
}

// ── Perplexity query helper ───────────────────────────────────────────────────

async function perplexitySearch(
  prompt:  string,
  apiKey:  string,
): Promise<{ content: string; citations: string[] }> {
  const resp = await fetch(PERPLEXITY_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:    'sonar',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      return_citations: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Perplexity ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content   = data?.choices?.[0]?.message?.content ?? '';
  const citations = (data?.citations as string[] | undefined) ?? [];
  return { content, citations };
}

// ── Extract lender names from Perplexity narrative response ──────────────────

function extractLendersFromText(text: string): string[] {
  const lenders: string[] = [];
  // Pattern: common bank / financial institution names followed by "provided", "financed", etc.
  const patterns = [
    /([A-Z][A-Za-z\s,\.&]{3,60}(?:Bank|Capital|Financial|Partners|Trust|Credit))\s+(?:provided|financed|arranged|funded|acted as)/g,
    /(?:lender|lenders|financed by|debt provided by|loan from|financing from)[:\s]+([A-Z][A-Za-z\s,\.&]{3,60}(?:Bank|Capital|Financial|Partners|Trust|Credit|Chase|Barclays|Deutsche|HSBC|MUFG|Natixis|BNP|Santander)[A-Za-z\s,\.&]{0,20})/gi,
    /([A-Z][A-Za-z\s,\.&]{3,60}(?:Bank|Capital|Financial|Partners|Trust))[,\s]+as\s+(?:administrative agent|collateral agent|lead arranger|lender)/gi,
  ];

  const seen = new Set<string>();
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1].trim().replace(/[,;.\s]+$/, '');
      if (name.length >= 4 && name.length <= 80 && !seen.has(name)) {
        seen.add(name);
        lenders.push(name);
      }
    }
  }
  return lenders;
}

// ── UCC search via Perplexity ─────────────────────────────────────────────────

async function searchUccFilings(
  plantName: string,
  state:     string,
  county:    string | null,
  spvAliases: string[],
  apiKey:    string,
): Promise<RawClaim[]> {
  const locationStr = county ? `${county} County, ${state}` : state;
  const aliasClause = spvAliases.length > 0
    ? ` Also try variations: ${spvAliases.slice(0, 3).join(', ')}.`
    : '';

  const prompt = `Search for UCC financing statements (UCC-1 filings) and deed of trust / mortgage records in ${locationStr} that name "${plantName}" as debtor or grantor.${aliasClause}

I need to identify the LENDER (secured party / beneficiary / grantee) — not the borrower. This is a renewable energy project seeking project finance lenders.

Please cite specific source URLs and provide the recording date if available. Return only factual information you have found in public records.`;

  const { content, citations } = await perplexitySearch(prompt, apiKey);
  log('UCC', `UCC search for "${plantName}": ${content.slice(0, 100)}`);

  const lenders = extractLendersFromText(content);
  return lenders.map(name => ({
    raw_lender_name: name,
    quote:           content.slice(0, 280).trim(),
    source_url:      citations[0] ?? `https://www.perplexity.ai/search?q=${encodeURIComponent(plantName + ' UCC filing lender')}`,
    source_type:     'ucc_filing' as const,
    evidence_date:   null,
  }));
}

// ── Financing close / tombstone search via Perplexity ───────────────────────
// Searches for project finance closing announcements, tombstones, and lender
// press releases that name the specific debt providers for this plant.

async function searchFinancingTombstone(
  plantName:   string,
  state:       string,
  spvAliases:  string[],
  apiKey:      string,
): Promise<RawClaim[]> {
  const aliasClause = spvAliases.length > 0
    ? ` (also known as ${spvAliases.slice(0, 2).join(' or ')})`
    : '';

  const prompt = `Find the project finance closing announcement, tombstone, or loan agreement for the renewable energy project "${plantName}"${aliasClause} in ${state}, USA.

I need to identify the DEBT LENDERS — the banks or financial institutions that provided the construction loan, term loan, or back-leverage loan. Do NOT include tax equity investors or equity sponsors.

Look for: press releases announcing financial close, tombstone ads, news articles about the project's financing, Bloomberg or Reuters deal coverage.

Return: the institution name, loan type (construction/term/back-leverage), approximate loan amount, and financial close date. Cite all source URLs.`;

  const { content, citations } = await perplexitySearch(prompt, apiKey);
  log('TOMBSTONE', `financing search: ${content.slice(0, 120)}`);

  // Only produce claims when a specific named institution is found with
  // positive financing language — not when the response is a negative result.
  const negativeSignals = /no (loan|financing|announcement|deal|result|information) (found|identified|located|available)/i;
  if (negativeSignals.test(content)) {
    log('TOMBSTONE', 'negative result — no claim created');
    return [];
  }

  const lenders = extractLendersFromText(content);
  if (lenders.length === 0) return [];

  return lenders.map(name => ({
    raw_lender_name: name,
    quote:           content.slice(0, 280).trim(),
    source_url:      citations[0] ?? `https://www.perplexity.ai/search?q=${encodeURIComponent(plantName + ' project finance lender construction loan')}`,
    source_type:     'web_page' as const,
    evidence_date:   null,
  }));
}

// ── FERC Form 1 / market filings via Perplexity ───────────────────────────────

async function searchFerc(
  plantName:  string,
  state:      string,
  apiKey:     string,
): Promise<RawClaim[]> {
  const prompt = `Search FERC (Federal Energy Regulatory Commission) filings or orders for the renewable energy project "${plantName}" in ${state}. 

I am looking for any FERC-regulated financing, interconnection agreements, or power purchase agreements that identify lenders providing project debt financing.

Cite the FERC docket number and source URL if available.`;

  const { content, citations } = await perplexitySearch(prompt, apiKey);
  log('FERC', `FERC search: ${content.slice(0, 100)}`);

  const lenders = extractLendersFromText(content);
  return lenders.map(name => ({
    raw_lender_name: name,
    quote:           content.slice(0, 280).trim(),
    source_url:      citations[0] ?? 'https://www.ferc.gov/industries-data/electric/general-information/eqr',
    source_type:     'web_page' as const,
    evidence_date:   null,
  }));
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const denied = checkInternalAuth(req);
  if (denied) return denied;

  let body: {
    session_id:   string;
    plant_id:     string;
    plant_name:   string;
    state:        string;
    county?:      string;
    spv_aliases?: string[];
    budget_usd?:  number;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: CORS });
  }

  const { session_id, plant_id, plant_name, state, county = null, spv_aliases = [], budget_usd = 0.08 } = body;
  if (!session_id || !plant_id || !plant_name) {
    return new Response(JSON.stringify({ error: 'session_id, plant_id and plant_name required' }), { status: 400, headers: CORS });
  }

  const perplexityKey = Deno.env.get('PERPLEXITY_API_KEY');
  if (!perplexityKey) {
    return new Response(JSON.stringify({ error: 'PERPLEXITY_API_KEY not configured' }), { status: 500, headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let costUsd        = 0;
  let budgetExceeded = false;
  const allClaims: RawClaim[] = [];
  const seen = new Set<string>();

  const addClaims = (claims: RawClaim[]) => {
    for (const c of claims) {
      if (!seen.has(c.raw_lender_name)) {
        seen.add(c.raw_lender_name);
        allClaims.push(c);
      }
    }
  };

  // 1. UCC / county records
  if (costUsd < budget_usd) {
    try {
      const uccClaims = await searchUccFilings(plant_name, state, county, spv_aliases, perplexityKey);
      addClaims(uccClaims);
      costUsd += COST_PER_PERPLEXITY_QUERY;
    } catch (e) { log('UCC_ERR', String(e)); }
  }

  // 2. Financing tombstone / closing announcement
  if (costUsd < budget_usd) {
    try {
      const tombstoneClaims = await searchFinancingTombstone(plant_name, state, spv_aliases, perplexityKey);
      addClaims(tombstoneClaims);
      costUsd += COST_PER_PERPLEXITY_QUERY;
    } catch (e) { log('TOMBSTONE_ERR', String(e)); }
  }

  // 3. FERC
  if (costUsd < budget_usd) {
    try {
      const fercClaims = await searchFerc(plant_name, state, perplexityKey);
      addClaims(fercClaims);
      costUsd += COST_PER_PERPLEXITY_QUERY;
    } catch (e) { log('FERC_ERR', String(e)); }
  } else {
    budgetExceeded = true;
  }

  // Persist claims
  let insertedCount = 0;
  if (allClaims.length > 0) {
    const rows = allClaims.map(c => ({
      session_id,
      source_agent:    'records',
      raw_lender_name: c.raw_lender_name,
      quote:           c.quote,
      source_url:      c.source_url,
      source_type:     c.source_type,
      evidence_date:   c.evidence_date,
      loan_status:     'unknown',
      role_tag:        'unknown',
      confidence:      0.4,
    }));

    const { error } = await supabase.from('lender_research_claims').insert(rows);
    if (!error) insertedCount = rows.length;
    else log('INSERT_ERR', error.message);
  }

  log('DONE', `claims=${insertedCount} cost=$${costUsd.toFixed(4)} budget_exceeded=${budgetExceeded}`);

  return new Response(
    JSON.stringify({
      ok:              true,
      claims_count:    insertedCount,
      cost_usd:        costUsd,
      budget_exceeded: budgetExceeded,
    }),
    { status: 200, headers: CORS },
  );
});
