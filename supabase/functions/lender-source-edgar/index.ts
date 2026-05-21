/**
 * GenTrack — lender-source-edgar (v4) Edge Function (Deno)
 *
 * Searches SEC EDGAR for federal financing disclosures tied to a plant.
 * This worker ONLY emits raw claims into lender_research_claims. All
 * role classification, time-awareness, and entity resolution happens
 * downstream in the synthesis agent and resolver.
 *
 * POST body:
 *   { session_id, plant_id, plant_name, sponsor_name, state,
 *     spv_aliases?: string[], budget_usd?: number }
 *
 * Response:
 *   { ok, claims_count, cost_usd, budget_exceeded, queries_attempted }
 *
 * Required secrets:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const EDGAR_SEARCH      = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_BASE        = 'https://www.sec.gov';
const EDGAR_SUBMIT_API  = 'https://data.sec.gov/submissions';
const TIMEOUT_MS        = 15_000;

// Budget / limits
const WALL_CLOCK_BUDGET_MS   = 90_000;  // leave headroom for orchestrator
const MAX_FILINGS_PROCESSED  = 25;  // compound queries are targeted so fewer filings needed
const MAX_DOC_TEXT_BYTES     = 1_200_000;
const MAX_EXHIBITS_PER_FILING = 5;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Lender name cleaning (ported from v3 ucc-edgar-worker) ────────────────────

const _REJECT_NAME_RE  = /nothing contained|by and among|\bamong\b|lenders party thereto|the lenders listed|party hereto|hereby agree|pursuant to this|\bentered into\b|Credit Agreement|Loan Agreement|Note Purchase|Security Agreement|Indenture|Amendment No\./i;
const _ROLE_SUFFIX_RE  = /[,\s]+as\s+(?:(?:joint|lead|administrative|collateral|book(?:running)?|co-?)\s+)*(?:agent|arranger|lender|manager|trustee|bookrunner|borrower|obligor|guarantor)\b.*/i;
const _LEADING_PREP_RE = /^(?:with|by|from|and|the|each|any|a)\s+/i;
const _PURE_SUFFIX_RE  = /^(?:INC\.?|PLC\.?|Corp\.?|Corporation|LLC\.?|L\.L\.C\.?|N\.A\.?|Ltd\.?|Limited|LP|LLP)\s*[,;.]?\s*$/i;
const _FIN_ENTITY_RE   = /\b(?:Bank(?:\s+(?:N\.?A\.?|PLC|AG|SA|Corp\.?|Limited))?|N\.A\.|PLC|AG|LLC|L\.L\.C\.|LP|LLP|Inc\.?|Corp\.?|Ltd\.?|Limited|Capital(?:\s+(?:Group|Markets|Partners))?|Financial(?:\s+(?:Group|Corp))?|Securities(?:\s+LLC)?|Trust(?:\s+Company)?|Bancorp|Banque)\b/gi;
const _MULTI_ENTITY_RE = /(?:Inc\.?|LLC|Ltd\.?|Limited|International|Corporation|Corp\.?|Company|Co\.?|Electric|Energy|Solar|Holdings|Group|Services|Power|N\.A\.?|PLC|AG|Agents|Arrangers|Lenders)\s*(?:,\s+and\s+|\s+and\s+)[A-Z][A-Za-z\s\.&,]+/i;

function cleanLenderName(raw: string): string | null {
  let name = raw.trim();
  if (/^[a-z]/.test(name)) {
    const sp = name.indexOf(' ');
    if (sp === -1) return null;
    name = name.slice(sp + 1).trim();
  }
  name = name.replace(_LEADING_PREP_RE, '').trim();
  if (/^[a-z]/.test(name)) return null;
  if (_REJECT_NAME_RE.test(name)) return null;
  name = name.replace(_ROLE_SUFFIX_RE, '').trim();
  name = name.replace(/[,;.\s]+$/, '').trim();
  if (_PURE_SUFFIX_RE.test(name)) return null;
  if (_MULTI_ENTITY_RE.test(name)) return null;
  if (name.length >= 3 && name.length <= 65 && /^[A-Z]/.test(name)) return name;

  const suffixHits = [...name.matchAll(new RegExp(_FIN_ENTITY_RE.source, 'gi'))];
  if (suffixHits.length === 0) return null;
  const last     = suffixHits[suffixHits.length - 1];
  const endPos   = (last.index ?? 0) + last[0].length;
  const before   = name.slice(0, last.index ?? 0);
  const parts    = before.split(/,\s*|\s+and\s+|\s*;\s*/).filter(p => /[A-Z]/.test(p));
  const seg      = (parts[parts.length - 1] ?? '').trim();
  const candidate = (seg ? seg + ' ' : '') + name.slice(last.index ?? 0, endPos);
  const clean    = candidate.replace(/\s+/g, ' ').replace(/[,;.\s]+$/, '').trim();
  if (clean.length < 3 || clean.length > 80) return null;
  if (/^[^A-Z]/.test(clean)) return null;
  if (_REJECT_NAME_RE.test(clean)) return null;
  return clean;
}

function normaliseEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,()'"]/g, ' ')
    .replace(/\b(llc|inc|incorporated|corp|corporation|company|co|ltd|limited|lp|llp|holdings?|trust|partners?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [EDGAR:${tag}] ${msg}`);
}

// ── CIK lookup (hardened) ─────────────────────────────────────────────────────

async function lookupCik(companyName: string): Promise<string | null> {
  try {
    const url = new URL(EDGAR_SEARCH);
    url.searchParams.set('entity', companyName);
    url.searchParams.set('forms', '10-K');

    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': 'GenTrack-LenderResearch/1.0 compliance@example.com', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const hits = (data?.hits?.hits ?? []) as Array<Record<string, unknown>>;
    if (hits.length === 0) return null;

    const queryNorm   = normaliseEntityName(companyName);
    const queryTokens = queryNorm.split(' ').filter(t => t.length >= 3);
    if (queryTokens.length === 0) return null;
    const primaryToken = queryTokens[0];

    for (const hit of hits.slice(0, 5)) {
      const src        = (hit._source ?? {}) as Record<string, unknown>;
      const ciks       = (src.ciks as string[] | undefined) ?? [];
      const displayRaw = Array.isArray(src.display_names)
        ? (src.display_names as string[]).join(' | ')
        : String(src.display_names ?? '');
      if (!normaliseEntityName(displayRaw).includes(primaryToken)) continue;
      const rawCik = ciks[0] ?? '';
      if (rawCik) return String(parseInt(rawCik, 10));
    }
    return null;
  } catch { return null; }
}

async function fetchFilingsByCik(cik: string): Promise<Array<{ filing_type: string; filed_at: string; entity_name: string; cik: string; adsh: string; adsh_nodash: string; file_url: string }>> {
  const paddedCik = cik.padStart(10, '0');
  try {
    const resp = await fetch(`${EDGAR_SUBMIT_API}/CIK${paddedCik}.json`, {
      headers: { 'User-Agent': 'GenTrack-LenderResearch/1.0 compliance@example.com' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    const entityName: string = data.name ?? '';
    const recent = data.filings?.recent;
    if (!recent) return [];

    const forms: string[]      = recent.form           ?? [];
    const fileDates: string[]  = recent.filingDate      ?? [];
    const accessions: string[] = recent.accessionNumber ?? [];

    const results = [];
    const wantForms = new Set(['8-K', '10-K']);
    const countsByForm: Record<string, number> = {};
    const maxPerType = 10;

    for (let i = 0; i < forms.length && results.length < MAX_FILINGS_PROCESSED; i++) {
      const baseForm = forms[i].split('/')[0];
      if (!wantForms.has(baseForm) && !baseForm.startsWith('EX-10')) continue;
      countsByForm[baseForm] = (countsByForm[baseForm] ?? 0) + 1;
      if (countsByForm[baseForm] > maxPerType) continue;

      const adsh       = accessions[i] ?? '';
      const adshNodash = adsh.replace(/-/g, '');
      results.push({
        filing_type:  forms[i],
        filed_at:     fileDates[i] ?? '',
        entity_name:  entityName,
        cik,
        adsh,
        adsh_nodash:  adshNodash,
        file_url:    `${EDGAR_BASE}/Archives/edgar/data/${cik}/${adshNodash}/${adsh}-index.htm`,
      });
    }
    return results;
  } catch { return []; }
}

// ── Full-text EDGAR search ────────────────────────────────────────────────────

async function edgarSearch(query: string): Promise<Array<{ filing_type: string; filed_at: string; entity_name: string; cik: string; adsh: string; adsh_nodash: string; file_url: string }>> {
  // Build URL manually to avoid URLSearchParams encoding commas in 'forms' as %2C,
  // which the EDGAR EFTS API does not decode (it treats it as no form filter → empty results).
  const qEncoded = encodeURIComponent(query);
  const url = `${EDGAR_SEARCH}?q=${qEncoded}&dateRange=custom&startdt=2005-01-01&forms=8-K,10-K,EX-10`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'GenTrack-LenderResearch/1.0 compliance@example.com', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      log('FTS_ERR', `HTTP ${resp.status} for query=${query.slice(0, 60)} body=${errBody.slice(0, 120)}`);
      return [];
    }

    const data  = await resp.json();
    const hits  = (data?.hits?.hits ?? []) as Array<Record<string, unknown>>;
    log('FTS_OK', `query=${query.slice(0, 80)} hits=${hits.length}`);
    return hits.map(h => {
      const src        = (h._source ?? {}) as Record<string, unknown>;
      const ciks       = (src.ciks as string[] | undefined) ?? [];
      const rawCik     = ciks[0] ?? '';
      const cik        = String(parseInt(rawCik, 10) || rawCik);
      const adsh       = String(src.adsh ?? '');
      const adshNodash = adsh.replace(/-/g, '');
      const names      = (src.display_names as string[] | undefined) ?? [];
      return {
        filing_type: String(src.form ?? ''),
        filed_at:    String(src.file_date ?? ''),
        entity_name: names[0] ?? '',
        cik,
        adsh,
        adsh_nodash:  adshNodash,
        file_url:    `${EDGAR_BASE}/Archives/edgar/data/${cik}/${adshNodash}/${adsh}-index.htm`,
      };
    }).filter(r => r.cik && r.adsh_nodash);
  } catch { return []; }
}

// ── Extract raw lender names from filing text ─────────────────────────────────

interface RawClaim {
  raw_lender_name: string;
  quote:           string;
  source_url:      string;
  source_type:     'edgar_filing';
  evidence_date:   string | null;  // ISO date string or null
}

const ROLE_EXTRACT_RE = /([A-Z][A-Za-z\s,\.&-]{2,60}(?:Bank|Capital|Financial|Partners|Trust|Credit|Citibank|JPMorgan|Wells Fargo|Goldman|Morgan Stanley|KeyBank|Rabobank|CoBank|ING|MUFG|BNP|Natixis|Deutsche|Barclays|HSBC|Santander|BBVA|Crédit)[A-Za-z\s,\.&-]*),?\s+as\s+([\w\s]{3,40}(?:agent|arranger|lender|trustee|manager))/gi;
const PROVIDED_RE     = /([A-Z][A-Za-z\s,\.&-]{2,60}(?:Bank|Capital|Financial|JPMorgan|Wells Fargo|Goldman|Morgan Stanley|KeyBank|Santander|BBVA|Deutsche|Barclays|HSBC|BNP)[A-Za-z\s,\.&-]*)\s+(?:provided|arranged|committed|funded|closed|acted as)\s+(?:a\s+)?(?:[\w\s]{0,30}?)(?:construction|term|project|senior|secured)?\s*(?:loan|financing|debt|facility|credit)/gi;
// Catches "Financing Agreement with the Federal Financing Bank" (DOE LPO / FFB style)
// NOTE: no \s* before lookahead — the lookahead \s+ needs the space that \s* would consume
const WITH_LENDER_RE  = /\bwith\s+(?:the\s+)?([A-Z][A-Za-z\s,\.&-]{2,70}?(?:Bank|Capital|Financial|Partners|Trust|Credit|Citibank|JPMorgan|Wells Fargo|Goldman|Morgan Stanley|KeyBank|Rabobank|CoBank|ING|MUFG|BNP|Natixis|Deutsche|Barclays|HSBC|Santander|BBVA)[A-Za-z\s,\.&-]{0,40}?)(?=[,.]|\s+(?:or|to|for|in|and)\b)/gi;
const BANK_KEYWORDS   = /bank|capital|financial|trust|credit|morgan|chase|goldman|wells fargo|citibank|hsbc|deutsche|barclays|bnp|mufg|keybank|rabobank|cobank|santander|bbva|natixis|ing\b/i;

async function extractClaimsFromFiling(
  fileUrl: string,
  filedAt: string,
  plantName: string,
  entityName: string,
  adsh_nodash: string,
  cik: string,
): Promise<RawClaim[]> {
  const claims: RawClaim[] = [];
  const seen = new Set<string>();
  const evidenceDate = filedAt || null;

  // ── Fetch index + identify exhibit URLs ─────────────────────────────────
  let indexHtml = '';
  const exhibitUrls: string[] = [];
  try {
    const indexResp = await fetch(fileUrl, {
      headers: { 'User-Agent': 'GenTrack-LenderResearch/1.0 compliance@example.com' },
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!indexResp.ok) return [];

    indexHtml = await indexResp.text();
    const baseUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${adsh_nodash}`;

    // Prefer EX-10 credit agreement exhibits; fall back to any htm/txt
    const creditAgreementUrls: string[] = [];
    const otherUrls: string[] = [];
    const hrefRe = /href="([^"]+\.(?:htm|txt)[^"]*)"/gi;
    let m;
    while ((m = hrefRe.exec(indexHtml)) !== null) {
      const href = m[1];
      const fullUrl = href.startsWith('/') ? `${EDGAR_BASE}${href}` : (!href.startsWith('http') ? `${baseUrl}/${href}` : href);
      const lcHref = href.toLowerCase();
      if (/ex[-_]?10|credit|loan|financ/i.test(lcHref) || /ex10/i.test(lcHref)) {
        creditAgreementUrls.push(fullUrl);
      } else {
        otherUrls.push(fullUrl);
      }
    }
    exhibitUrls.push(...creditAgreementUrls, ...otherUrls);
  } catch { return []; }

  // ── Build per-document segments, each carrying its own source URL ────────
  // This ensures claims get the URL of the specific exhibit document, not the
  // filing index page — so reviewers can click through to the exact text.
  const segments: Array<{ text: string; url: string }> = [];

  // Segment 0: stripped index HTML (captures 8-K event text and filing summaries)
  const indexText = indexHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  segments.push({ text: indexText.slice(0, MAX_DOC_TEXT_BYTES), url: fileUrl });

  // Segments 1..N: each exhibit document
  for (const exhibitUrl of exhibitUrls.slice(0, MAX_EXHIBITS_PER_FILING)) {
    try {
      const r = await fetch(exhibitUrl, {
        headers: { 'User-Agent': 'GenTrack-LenderResearch/1.0 compliance@example.com' },
        signal:  AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const text = (await r.text())
          .replace(/<[^>]+>/g, ' ')
          .replace(/&#160;|&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&#8220;|&#8221;|&#147;|&#148;/g, '"')
          .replace(/\s+/g, ' ');
        segments.push({ text: text.slice(0, MAX_DOC_TEXT_BYTES), url: exhibitUrl });
      }
    } catch { /* skip */ }
  }

  // ── Scan each segment independently ─────────────────────────────────────
  const triggerPhrases = [
    'credit agreement', 'loan agreement', 'financing agreement',
    'construction loan', 'term loan agreement', 'project finance',
    'financed by', 'provided financing', 'project lender',
    'federal financing bank', 'doe loan guarantee', 'department of energy',
  ];

  log('EXTRACT', `url=${fileUrl} segments=${segments.length}`);

  for (const { text: docText, url: sourceUrl } of segments) {
    const windows: Array<{ text: string }> = [];
    for (const phrase of triggerPhrases) {
      let idx = 0;
      while (windows.length < 25) {
        const pos = docText.toLowerCase().indexOf(phrase, idx);
        if (pos === -1) break;
        windows.push({ text: docText.slice(Math.max(0, pos - 300), pos + 600) });
        idx = pos + 1;
      }
    }

    for (const { text: win } of windows) {
      for (const pattern of [ROLE_EXTRACT_RE, PROVIDED_RE, WITH_LENDER_RE]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(win)) !== null) {
          const rawName  = match[1].trim().replace(/^[,\s]+|[,\s]+$/g, '');
          const cleaned  = cleanLenderName(rawName);
          log('REGEX_MATCH', `pattern=${pattern.source.slice(0,40)} raw="${rawName}" cleaned="${cleaned}"`);
          if (!cleaned || seen.has(cleaned)) continue;
          seen.add(cleaned);
          // Use match position context for the quote so reviewer sees the relevant sentence
          const matchStart = match.index ?? 0;
          const quoteStart = Math.max(0, matchStart - 120);
          const quote = win.slice(quoteStart, quoteStart + 280).trim();
          claims.push({
            raw_lender_name: cleaned,
            quote,
            source_url:      sourceUrl,   // ← specific exhibit URL, not filing index
            source_type:     'edgar_filing',
            evidence_date:   evidenceDate,
          });
        }
      }
    }
  }

  // ── Filing-entity-as-lender heuristic ───────────────────────────────────
  if (BANK_KEYWORDS.test(entityName)) {
    for (const { text: docText, url: sourceUrl } of segments) {
      const plantRe = new RegExp(plantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const plantIdx = docText.search(plantRe);
      if (plantIdx !== -1) {
        const win = docText.slice(Math.max(0, plantIdx - 400), plantIdx + 400);
        if (/(?:financing|lender|arranger|construction|term loan)/i.test(win)) {
          const cleanEntity = cleanLenderName(entityName.replace(/\s*\(CIK[^)]+\)/i, '').trim()) ?? entityName;
          if (!seen.has(cleanEntity)) {
            seen.add(cleanEntity);
            claims.push({
              raw_lender_name: cleanEntity,
              quote:           win.slice(0, 280).trim(),
              source_url:      sourceUrl,
              source_type:     'edgar_filing',
              evidence_date:   evidenceDate,
            });
          }
          break; // found plant context, stop searching other segments
        }
      }
    }
  }

  return claims;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const denied = checkInternalAuth(req);
  if (denied) return denied;

  let body: {
    session_id:    string;
    plant_id:      string;
    plant_name:    string;
    sponsor_name:  string | null;
    state:         string;
    spv_aliases?:  string[];
    budget_usd?:   number;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: CORS });
  }

  const { session_id, plant_id, plant_name, sponsor_name, state, spv_aliases = [], budget_usd = 0.10 } = body;
  if (!session_id || !plant_id || !plant_name) {
    return new Response(JSON.stringify({ error: 'session_id, plant_id and plant_name required' }), { status: 400, headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startMs = Date.now();
  let filingCount = 0;
  let budgetExceeded = false;
  const queriesAttempted: Array<{ source: string; query: string; hits: number }> = [];
  const allClaims: RawClaim[] = [];
  const seenLenders = new Set<string>();

  const elapsed = () => Date.now() - startMs;

  // ── Build search queries ────────────────────────────────────────────────────

  const searchTerms: Array<{ label: string; query: string }> = [];

  // 1. Compound queries: plant name + financing keyword (highest precision — finds 8-K/EX-10 credit agreement exhibits)
  for (const kw of ['credit agreement', 'term loan']) {
    searchTerms.push({ label: `plant_name+${kw.replace(/ /g, '_')}`, query: `"${plant_name}" "${kw}"` });
  }

  // 2. Plant name alone (broader, catches portfolio mentions and tombstones)
  searchTerms.push({ label: 'plant_name', query: `"${plant_name}"` });

  // 3. SPV aliases (compound first, then bare)
  for (const alias of spv_aliases.slice(0, 3)) {
    searchTerms.push({ label: `spv_alias+credit:${alias}`, query: `"${alias}" "credit agreement"` });
    searchTerms.push({ label: `spv_alias:${alias}`, query: `"${alias}"` });
  }

  // 3. Sponsor CIK path (most reliable for large public developers)
  let sponsorCik: string | null = null;
  // Try sponsor name first, then plant name (catches SPVs that file directly with SEC)
  if (sponsor_name) {
    sponsorCik = await lookupCik(sponsor_name);
    log('CIK', `${sponsor_name} → CIK ${sponsorCik ?? 'not found'}`);
  }
  if (!sponsorCik && plant_name) {
    sponsorCik = await lookupCik(plant_name);
    log('CIK', `plant_name "${plant_name}" → CIK ${sponsorCik ?? 'not found'}`);
  }

  // ── CIK-based filings ───────────────────────────────────────────────────────

  if (sponsorCik && elapsed() < WALL_CLOCK_BUDGET_MS) {
    const filings = await fetchFilingsByCik(sponsorCik);
    queriesAttempted.push({ source: 'edgar_cik', query: `CIK:${sponsorCik}`, hits: filings.length });
    log('CIK_FILINGS', `CIK ${sponsorCik} → ${filings.length} filings`);

    for (const filing of filings) {
      if (elapsed() > WALL_CLOCK_BUDGET_MS || filingCount >= MAX_FILINGS_PROCESSED) {
        budgetExceeded = true; break;
      }
      filingCount++;
      const claims = await extractClaimsFromFiling(
        filing.file_url, filing.filed_at, plant_name,
        filing.entity_name, filing.adsh_nodash, filing.cik,
      );
      for (const c of claims) {
        if (!seenLenders.has(c.raw_lender_name)) {
          seenLenders.add(c.raw_lender_name);
          allClaims.push(c);
        }
      }
    }
  }

  // ── Full-text search queries ────────────────────────────────────────────────

  for (const { label, query } of searchTerms) {
    if (elapsed() > WALL_CLOCK_BUDGET_MS || filingCount >= MAX_FILINGS_PROCESSED) {
      budgetExceeded = true; break;
    }

    const hits = await edgarSearch(query);
    queriesAttempted.push({ source: 'edgar_fts', query: label, hits: hits.length });
    log('FTS', `"${label}" → ${hits.length} hits`);

    for (const filing of hits.slice(0, 6)) {
      if (elapsed() > WALL_CLOCK_BUDGET_MS || filingCount >= MAX_FILINGS_PROCESSED) {
        budgetExceeded = true; break;
      }
      filingCount++;
      const claims = await extractClaimsFromFiling(
        filing.file_url, filing.filed_at, plant_name,
        filing.entity_name, filing.adsh_nodash, filing.cik,
      );
      for (const c of claims) {
        if (!seenLenders.has(c.raw_lender_name)) {
          seenLenders.add(c.raw_lender_name);
          allClaims.push(c);
        }
      }
    }
  }

  // ── Persist claims ──────────────────────────────────────────────────────────

  let insertedCount = 0;
  if (allClaims.length > 0) {
    const rows = allClaims.map(c => ({
      session_id,
      source_agent:    'edgar',
      raw_lender_name: c.raw_lender_name,
      quote:           c.quote,
      source_url:      c.source_url,
      source_type:     c.source_type,
      evidence_date:   c.evidence_date,
      loan_status:     'unknown',
      role_tag:        'unknown',
      confidence:      0.65,  // EDGAR = regulatory filing; synthesis raises further if strong match
    }));

    const { error } = await supabase.from('lender_research_claims').insert(rows);
    if (!error) insertedCount = rows.length;
    else log('INSERT_ERR', error.message);
  }

  const durationMs = elapsed();
  log('DONE', `claims=${insertedCount} filings_scanned=${filingCount} elapsed=${durationMs}ms budget_exceeded=${budgetExceeded}`);

  // EDGAR is free — no per-call cost. Budget tracking is wall-clock only.
  return new Response(
    JSON.stringify({
      ok:                true,
      claims_count:      insertedCount,
      cost_usd:          0,
      budget_exceeded:   budgetExceeded,
      filings_scanned:   filingCount,
      queries_attempted: queriesAttempted,
      duration_ms:       durationMs,
    }),
    { status: 200, headers: CORS },
  );
});
