/**
 * GenTrack — lender-source-web (v4) Edge Function (Deno)
 *
 * Searches the public web and the internal news_articles corpus for
 * lender evidence. Uses Perplexity Sonar for live web search and the
 * Supabase semantic search RPC for internal articles.
 *
 * POST body:
 *   { session_id, plant_id, plant_name, sponsor_name?, state,
 *     budget_usd?: number }
 *
 * Response:
 *   { ok, claims_count, cost_usd, budget_exceeded }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const GEMINI_EMBED   = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const TIMEOUT_MS     = 20_000;

// sonar-pro pricing: ~$5/1K requests vs sonar $1/1K — ~5× more accurate on
// niche project-finance content; worth the cost given it's the primary lender
// discovery channel.
const COST_PER_SONAR_PRO_QUERY  = 0.016;
const COST_PER_GEMINI_EMBED     = 0.00002;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

interface RawClaim {
  raw_lender_name: string;
  quote:           string;
  source_url:      string;
  source_type:     'news_article' | 'press_release' | 'web_page';
  evidence_date:   string | null;
}

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [WEB:${tag}] ${msg}`);
}

// ── Perplexity ────────────────────────────────────────────────────────────────

async function perplexitySearch(prompt: string, apiKey: string, maxTokens = 1000): Promise<{ content: string; citations: string[] }> {
  const resp = await fetch(PERPLEXITY_API, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:            'sonar-pro',
      messages:         [{ role: 'user', content: prompt }],
      max_tokens:       maxTokens,
      return_citations: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Perplexity ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return {
    content:   data?.choices?.[0]?.message?.content ?? '',
    citations: (data?.citations as string[] | undefined) ?? [],
  };
}

// ── Gemini embedding ──────────────────────────────────────────────────────────

async function embedText(text: string, apiKey: string): Promise<number[]> {
  const resp = await fetch(`${GEMINI_EMBED}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:                'models/gemini-embedding-001',
      content:              { parts: [{ text }] },
      outputDimensionality: 768,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Gemini embed ${resp.status}`);
  const data = await resp.json();
  return data.embedding.values;
}

// ── Extract lender names from narrative text ──────────────────────────────────

function extractLendersFromText(text: string): Array<{ name: string; quote: string }> {
  const results: Array<{ name: string; quote: string }> = [];
  const patterns = [
    /([A-Z][A-Za-z\s,\.&]{3,60}(?:Bank|Capital|Financial|Partners|Trust|Credit))\s+(?:provided|arranged|financed|funded|committed|acted as)/g,
    /(?:lender|lenders|financed by|debt from|loan from|financing from)[:\s]+([A-Z][A-Za-z\s,\.&]{3,60}(?:Bank|Capital|Financial|Chase|Barclays|Deutsche|HSBC|MUFG|Natixis|BNP|Santander|Goldman|Morgan)[A-Za-z\s,\.&]{0,20})/gi,
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
        // Grab the surrounding sentence as the quote
        const start = Math.max(0, m.index - 100);
        const end   = Math.min(text.length, m.index + 200);
        results.push({ name, quote: text.slice(start, end).trim() });
      }
    }
  }
  return results;
}

// ── Determine source type from URL ────────────────────────────────────────────

function classifyUrl(url: string): 'press_release' | 'news_article' | 'web_page' {
  if (/businesswire|prnewswire|globenewswire|accesswire|newswire/i.test(url)) return 'press_release';
  if (/reuters|bloomberg|ft\.com|wsj\.com|spglobal|platts|reutersevents/i.test(url))  return 'news_article';
  return 'web_page';
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const denied = checkInternalAuth(req);
  if (denied) return denied;

  let body: {
    session_id:    string;
    plant_id:      string;
    plant_name:    string;
    sponsor_name?: string;
    state:         string;
    budget_usd?:   number;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: CORS });
  }

  // 5 sonar-pro queries × $0.016 + embed ≈ $0.08; default budget covers all.
  const { session_id, plant_id, plant_name, sponsor_name, state, budget_usd = 0.12 } = body;
  if (!session_id || !plant_id || !plant_name) {
    return new Response(JSON.stringify({ error: 'session_id, plant_id and plant_name required' }), { status: 400, headers: CORS });
  }

  const perplexityKey = Deno.env.get('PERPLEXITY_API_KEY');
  const geminiKey     = Deno.env.get('GEMINI_API_KEY');
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
  const seenLenders = new Set<string>();

  // ── 1. Perplexity web search ───────────────────────────────────────────────

  const webPrompt = `Find news articles, press releases, or financial reports that identify the PROJECT FINANCE LENDERS (debt providers) for the renewable energy power plant "${plant_name}" located in ${state}, USA.

${sponsor_name ? `The plant developer/sponsor is ${sponsor_name}.` : ''}

I need: lender bank/institution names, loan amounts if available, loan type (construction loan, term loan), and the date the financing closed.

Important: I only want DEBT lenders — not equity investors, tax equity investors, or offtakers. Cite all sources.`;

  if (costUsd < budget_usd) {
    try {
      const { content, citations } = await perplexitySearch(webPrompt, perplexityKey);
      costUsd += COST_PER_SONAR_PRO_QUERY;
      log('WEB', `web search got ${citations.length} citations`);

      const extracted = extractLendersFromText(content);
      for (const { name, quote } of extracted) {
        if (seenLenders.has(name)) continue;
        seenLenders.add(name);
        // Pick the most relevant citation or fall back to search URL
        const url = citations[0] ?? `https://www.perplexity.ai/search?q=${encodeURIComponent(plant_name + ' lender financing')}`;
        allClaims.push({
          raw_lender_name: name,
          quote,
          source_url:      url,
          source_type:     classifyUrl(url),
          evidence_date:   null,
        });
      }
    } catch (e) { log('WEB_ERR', String(e)); }
  }

  // ── 2. Sponsor-specific financing news (if sponsor known) ─────────────────

  if (sponsor_name && costUsd < budget_usd) {
    const sponsorPrompt = `Find financing announcements or loan agreements for solar/wind projects in ${state} by ${sponsor_name}. I need the names of the debt lenders (banks/financial institutions) involved in project finance. Do not include tax equity investors. Cite sources.`;

    try {
      const { content, citations } = await perplexitySearch(sponsorPrompt, perplexityKey);
      costUsd += COST_PER_SONAR_PRO_QUERY;
      log('SPONSOR', `sponsor search got ${citations.length} citations`);

      const extracted = extractLendersFromText(content);
      for (const { name, quote } of extracted) {
        if (seenLenders.has(name)) continue;
        seenLenders.add(name);
        const url = citations[0] ?? `https://www.perplexity.ai/search?q=${encodeURIComponent(sponsor_name + ' project finance lender')}`;
        allClaims.push({
          raw_lender_name: name,
          quote,
          source_url:      url,
          source_type:     classifyUrl(url),
          evidence_date:   null,
        });
      }
    } catch (e) { log('SPONSOR_ERR', String(e)); }
  }

  // ── 3. Financing close / tombstone search ────────────────────────────────
  // Searches specifically for "financial close" announcements and loan tombstones.
  // Complementary to the general web search: looks for structured deal coverage.

  if (costUsd < budget_usd) {
    const closePrompt = `Find the project finance financial close announcement or loan tombstone for the renewable energy plant "${plant_name}" in ${state}, USA. I need the names of the construction loan or term loan lenders (banks / financial institutions only — not tax equity). Include the loan amount, lead arranger, and financial close date. Cite Bloomberg NEF, Reuters, Business Wire, or other deal coverage.`;
    try {
      const { content, citations } = await perplexitySearch(closePrompt, perplexityKey, 800);
      costUsd += COST_PER_SONAR_PRO_QUERY;
      log('CLOSE', `financing-close got ${citations.length} citations`);

      const negativeSignals = /no (loan|financing|announcement|deal|result|information) (found|identified|located|available)/i;
      if (!negativeSignals.test(content)) {
        const extracted = extractLendersFromText(content);
        for (const { name, quote } of extracted) {
          if (seenLenders.has(name)) continue;
          seenLenders.add(name);
          const url = citations[0] ?? `https://www.perplexity.ai/search?q=${encodeURIComponent(plant_name + ' financial close construction loan')}`;
          allClaims.push({ raw_lender_name: name, quote, source_url: url, source_type: classifyUrl(url), evidence_date: null });
        }
      }
    } catch (e) { log('CLOSE_ERR', String(e)); }
  }

  // ── 4. UCC secured-party targeted search ─────────────────────────────────
  // Looks for UCC-1 secured-party press coverage and state-records summaries.

  if (costUsd < budget_usd) {
    const uccPrompt = `Find news articles, regulatory filings, or public records that identify the SECURED PARTY (lender) on any UCC-1 financing statement filed for "${plant_name}" in ${state}. The secured party is the bank or financial institution that holds the security interest. Include the institution name and any reference to the filing date or amount.`;
    try {
      const { content, citations } = await perplexitySearch(uccPrompt, perplexityKey, 600);
      costUsd += COST_PER_SONAR_PRO_QUERY;
      log('UCC_NEWS', `UCC news got ${citations.length} citations`);

      const extracted = extractLendersFromText(content);
      for (const { name, quote } of extracted) {
        if (seenLenders.has(name)) continue;
        seenLenders.add(name);
        const url = citations[0] ?? `https://www.perplexity.ai/search?q=${encodeURIComponent(plant_name + ' UCC secured party lender')}`;
        allClaims.push({ raw_lender_name: name, quote, source_url: url, source_type: classifyUrl(url), evidence_date: null });
      }
    } catch (e) { log('UCC_NEWS_ERR', String(e)); }
  }

  // ── 5. Back-leverage / bridge loan search ────────────────────────────────
  // Many renewable projects use back-leverage or bridge-to-equity facilities.

  if (costUsd < budget_usd) {
    const bridgeParty = sponsor_name ? `${sponsor_name} (developer of ${plant_name})` : `"${plant_name}"`;
    const bridgePrompt = `Find any back-leverage loan, bridge loan, or construction-to-term facility provided to ${bridgeParty} in ${state}. I need the lending institution name, loan type, and approximate size. Exclude tax equity. Cite news articles or deal announcements.`;
    try {
      const { content, citations } = await perplexitySearch(bridgePrompt, perplexityKey, 600);
      costUsd += COST_PER_SONAR_PRO_QUERY;
      log('BRIDGE', `bridge/back-leverage got ${citations.length} citations`);

      const extracted = extractLendersFromText(content);
      for (const { name, quote } of extracted) {
        if (seenLenders.has(name)) continue;
        seenLenders.add(name);
        const url = citations[0] ?? `https://www.perplexity.ai/search?q=${encodeURIComponent(plant_name + ' back leverage bridge loan lender')}`;
        allClaims.push({ raw_lender_name: name, quote, source_url: url, source_type: classifyUrl(url), evidence_date: null });
      }
    } catch (e) { log('BRIDGE_ERR', String(e)); }
  }

  // ── 6. Internal news_articles semantic search ─────────────────────────────

  if (geminiKey && costUsd < budget_usd) {
    try {
      const queryText = `${plant_name} project finance lender debt financing`;
      const embedding = await embedText(queryText, geminiKey);
      costUsd += COST_PER_GEMINI_EMBED;

      const { data: chunks, error: searchErr } = await supabase.rpc('match_news_articles', {
        query_embedding:  embedding,
        match_threshold:  0.72,
        match_count:      8,
      });

      if (!searchErr && chunks && chunks.length > 0) {
        log('NEWS', `semantic search returned ${chunks.length} articles`);

        for (const chunk of chunks as Array<{ id: number; content: string; url: string; published_at: string }>) {
          const extracted = extractLendersFromText(chunk.content ?? '');
          for (const { name, quote } of extracted) {
            if (seenLenders.has(name)) continue;
            seenLenders.add(name);
            allClaims.push({
              raw_lender_name: name,
              quote,
              source_url:      chunk.url ?? '',
              source_type:     classifyUrl(chunk.url ?? ''),
              evidence_date:   chunk.published_at ? chunk.published_at.slice(0, 10) : null,
            });
          }
        }
      }
    } catch (e) { log('NEWS_ERR', String(e)); }
  }

  // Filter out claims with no usable source URL
  const validClaims = allClaims.filter(c => c.source_url && c.source_url.startsWith('http'));

  // Persist
  let insertedCount = 0;
  if (validClaims.length > 0) {
    const rows = validClaims.map(c => ({
      session_id,
      source_agent:    'web',
      raw_lender_name: c.raw_lender_name,
      quote:           c.quote,
      source_url:      c.source_url,
      source_type:     c.source_type,
      evidence_date:   c.evidence_date,
      loan_status:     'unknown',
      role_tag:        'unknown',
      confidence:      0.45,
    }));

    const { error } = await supabase.from('lender_research_claims').insert(rows);
    if (!error) insertedCount = rows.length;
    else log('INSERT_ERR', error.message);
  }

  log('DONE', `claims=${insertedCount} cost=$${costUsd.toFixed(4)}`);

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
