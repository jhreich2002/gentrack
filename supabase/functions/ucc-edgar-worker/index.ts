/**
 * GenTrack — ucc-edgar-worker Edge Function (Deno)
 *
 * Searches SEC EDGAR for federal financing disclosures tied to a plant.
 * Publicly traded sponsors must disclose material credit agreements in 8-K
 * filings; project-level debt often appears as exhibits to 10-K reports.
 *
 * Fully free — uses the EDGAR full-text search REST API with no LLM.
 * Parses returned document text directly for lender names and facility terms.
 *
 * POST body:
 *   { plant_code, run_id, plant_name, sponsor_name, state, spv_aliases }
 *
 * Returns standard worker output schema.
 *
 * Required secrets:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index';
const EDGAR_BASE   = 'https://www.sec.gov';
const TIMEOUT_MS   = 15_000;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

// Lender indicator keywords found near entity names in credit agreements
const LENDER_ROLE_PATTERNS = [
  /administrative agent/i,
  /collateral agent/i,
  /lead arranger/i,
  /book(?:running)? manager/i,
  /term loan lender/i,
  /revolving credit lender/i,
  /construction lender/i,
  /tax equity/i,
  /project lender/i,
  /senior secured/i,
];

const FACILITY_PATTERNS: Array<{ regex: RegExp; type: string }> = [
  { regex: /construction loan/i,      type: 'construction_loan' },
  { regex: /term loan/i,              type: 'term_loan'         },
  { regex: /revolving credit/i,       type: 'revolving_credit'  },
  { regex: /tax equity/i,             type: 'tax_equity'        },
  { regex: /bridge loan/i,            type: 'bridge_loan'       },
  { regex: /letter of credit/i,       type: 'letter_of_credit'  },
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface SpvAlias {
  name:       string;
  normalized: string;
  confidence: number;
}

interface EdgarHit {
  query:        string;
  filing_type:  string;
  filed_at:     string;
  entity_name:  string;
  cik:          string;
  adsh:         string;
  adsh_nodash:  string;
  file_url:     string;
  doc_url:      string;
  lenders:      ExtractedLender[];
}

interface ExtractedLender {
  name:          string;
  normalized:    string;
  role:          string;
  facility_type: string | null;
  context:       string;
}

interface WorkerOutput {
  task_status:           'success' | 'partial' | 'failed';
  completion_score:      number;
  evidence_found:        boolean;
  structured_results:    EdgarHit[];
  source_urls:           string[];
  raw_evidence_snippets: string[];
  open_questions:        string[];
  retry_recommendation:  string | null;
  cost_usd:              0;
  llm_fallback_used:     false;
  duration_ms:           number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [EDGAR:${tag}] ${msg}`);
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|lp|inc|corp|co|ltd|na|n\.a\.|plc|as agent|as collateral agent)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── EDGAR full-text search ────────────────────────────────────────────────────

interface EdgarSearchResult {
  query:        string;
  filing_type:  string;
  filed_at:     string;
  entity_name:  string;
  cik:          string;   // CIK without leading zeros (used in URL paths)
  adsh:         string;   // accession number with dashes, e.g. "0001193125-08-046497"
  adsh_nodash:  string;   // accession number without dashes for URL construction
  file_url:     string;   // canonical index URL
}

async function edgarSearch(query: string, forms: string[] = ['8-K', '10-K', 'EX-10']): Promise<EdgarSearchResult[]> {
  const url = new URL(EDGAR_SEARCH);
  url.searchParams.set('q', query);           // no extra quotes — the query already has them
  url.searchParams.set('dateRange', 'custom');
  url.searchParams.set('startdt', '2005-01-01');
  url.searchParams.set('forms', forms.join(','));

  try {
    const resp = await fetch(url.toString(), {
      headers: {
        'User-Agent':  'GenTrack-LenderResearch/1.0 compliance@example.com',
        'Accept':      'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) {
      log('SEARCH', `HTTP ${resp.status} for query="${query}"`);
      return [];
    }

    const data = await resp.json();
    const hits = (data?.hits?.hits ?? []) as Array<Record<string, unknown>>;

    return hits.map(h => {
      const src        = (h._source ?? {}) as Record<string, unknown>;
      const ciks       = (src.ciks as string[] | undefined) ?? [];
      const rawCik     = ciks[0] ?? '';
      const cik        = String(parseInt(rawCik, 10) || rawCik); // strip leading zeros
      const adsh       = String(src.adsh ?? '');
      const adshNodash = adsh.replace(/-/g, '');
      const names      = (src.display_names as string[] | undefined) ?? [];
      const formType   = String(src.form ?? (src.root_forms as string[] | undefined)?.[0] ?? '');

      return {
        query,
        filing_type:  formType,
        filed_at:     String(src.file_date ?? ''),
        entity_name:  names[0] ?? '',
        cik,
        adsh,
        adsh_nodash:  adshNodash,
        file_url:     `${EDGAR_BASE}/Archives/edgar/data/${cik}/${adshNodash}/${adsh}-index.htm`,
      };
    }).filter(r => r.cik && r.adsh_nodash);
  } catch (err) {
    log('SEARCH', `Error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Extract lenders from EDGAR document text ──────────────────────────────────
// Fetches the filing index and scans exhibit text for lender names near
// credit agreement language. No LLM — pure regex extraction.

async function fetchAndExtractLenders(
  indexUrl:    string,   // pre-computed index URL (cik + adsh_nodash)
  adshNodash:  string,
  cik:         string,
  entityName:  string,   // filing entity (for entity-as-lender check)
  plantName:   string,   // plant name (for context-window search)
): Promise<ExtractedLender[]> {
  const lenders: ExtractedLender[] = [];
  let docText = ''; // declared here so maybeExtractFilingEntityAsLender can see it

  try {
    // Fetch the filing index to discover exhibit file URLs
    const indexResp = await fetch(indexUrl, {
      headers: { 'User-Agent': 'GenTrack-LenderResearch/1.0 compliance@example.com' },
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!indexResp.ok) return lenders;

    const indexHtml = await indexResp.text();

    // Try to find a relevant exhibit to scan (EX-10, EX-99, or the main document)
    const exhibitLinkRe = /href="([^"]+\.(?:htm|txt)[^"]*)"/gi;
    const baseUrl = `${EDGAR_BASE}/Archives/edgar/data/${cik}/${adshNodash}`;
    const exhibitUrls: string[] = [indexUrl]; // always scan the index itself
    let m;
    while ((m = exhibitLinkRe.exec(indexHtml)) !== null) {
      const href = m[1];
      if (href.startsWith('/')) exhibitUrls.push(`${EDGAR_BASE}${href}`);
      else if (!href.startsWith('http')) exhibitUrls.push(`${baseUrl}/${href}`);
    }

    // Scan index + up to 3 exhibit files for credit-agreement language
    const urlsToScan = exhibitUrls.slice(0, 4);
    docText = indexHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    for (const url of urlsToScan.slice(1)) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'GenTrack-LenderResearch/1.0 compliance@example.com' },
          signal:  AbortSignal.timeout(10_000),
        });
        if (r.ok) {
          const text = await r.text();
          docText += ' ' + text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        }
      } catch { /* skip unreadable exhibits */ }
    }

    // Extract lenders from two types of context windows:
    // 1. Around credit-agreement trigger phrases (classic credit agreement format)
    // 2. Around plant/SPV name mentions (investor day slides, press releases, etc.)

    const triggerPhrases = [
      'credit agreement', 'loan agreement', 'financing agreement',
      'construction loan', 'term loan agreement', 'project finance',
      'financed by', 'provided financing', 'project lender',
    ];

    // Collect context windows from trigger phrases
    const windowsToScan: Array<{ text: string; source: string }> = [];

    for (const phrase of triggerPhrases) {
      let searchFrom = 0;
      while (true) {
        const idx = docText.toLowerCase().indexOf(phrase, searchFrom);
        if (idx === -1) break;
        windowsToScan.push({
          text:   docText.slice(Math.max(0, idx - 300), idx + 600),
          source: phrase,
        });
        searchFrom = idx + 1;
        if (windowsToScan.length > 20) break; // cap
      }
    }

    // Primary: "Bank Name, as [role]" or "Bank Name as [role]"
    const rolePattern = /([A-Z][A-Za-z\s,\.&]{2,60}(?:Bank|Capital|Financial|Partners|Trust|Credit|Citibank|JPMorgan|Wells Fargo|Goldman|Morgan Stanley|KeyBank|Rabobank|CoBank|ING|MUFG|BNP|Natixis|Deutsche|Barclays|HSBC|Santander|BBVA|CAIXA|Banco|CaixaBank|BofA|Scotiabank|SunTrust|Regions|Compass|Huntington|PNC|USBank|U\.S\. Bank|SunPower|Crédit)[A-Za-z\s,\.&]*),?\s+as\s+([\w\s]{3,40}(?:agent|arranger|lender|trustee|manager))/gi;

    // Secondary: "[Bank keyword] provided/arranged/committed [loan type] [for/to plant]"
    const providedPattern = /([A-Z][A-Za-z\s,\.&]{2,60}(?:Bank|Capital|Financial|JPMorgan|Wells Fargo|Goldman|Morgan Stanley|KeyBank|Santander|BBVA|CAIXA|Banco|Deutsche|Barclays|HSBC|BNP)[A-Za-z\s,\.&]*)\s+(?:provided|arranged|committed|funded|closed|acted as)\s+(?:a\s+)?(?:[\w\s]{0,30}?)(?:construction|term|project|senior|secured)?\s*(?:loan|financing|debt|facility|credit)/gi;

    for (const { text: window, source } of windowsToScan) {
      for (const pattern of [rolePattern, providedPattern]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(window)) !== null) {
          const lenderName = match[1].trim().replace(/^[,\s]+|[,\s]+$/g, '');
          const role       = match[2]?.trim() ?? 'lender';
          if (lenderName.length < 3 || lenderName.length > 100) continue;

          const facilityType = FACILITY_PATTERNS.find(p => p.regex.test(window))?.type ?? null;
          lenders.push({
            name:          lenderName,
            normalized:    normalizeName(lenderName),
            role,
            facility_type: facilityType,
            context:       window.slice(0, 300).trim(),
          });
        }
      }
    }
  } catch {
    // Silently skip — document fetch failures are common for older filings
  }

  // Check if the filing entity itself is a lender/investor in this plant
  try {
    const entityLender = maybeExtractFilingEntityAsLender(entityName, docText, plantName);
    if (entityLender) lenders.push(entityLender);
  } catch { /* safe to ignore */ }

  // Deduplicate by normalized name
  const seen = new Set<string>();
  return lenders.filter(l => {
    if (seen.has(l.normalized)) return false;
    seen.add(l.normalized);
    return true;
  });
}

// If the FILING ENTITY itself is a financial institution and the doc mentions
// the plant with investment/financing language, the filing entity IS the lender.
function maybeExtractFilingEntityAsLender(
  entityName:  string,
  docText:     string,
  plantName:   string,
): ExtractedLender | null {
  const BANK_KEYWORDS = /bank|capital|financial|trust|credit|morgan|chase|goldman|wells fargo|citibank|hsbc|deutsche|barclays|bnp|mufg|keybank|rabobank|cobank|santander|bbva|caixa|natixis|ing\b/i;
  if (!BANK_KEYWORDS.test(entityName)) return null;

  // docText is already tag-stripped by the caller
  const plantRe = new RegExp(plantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (!plantRe.test(docText)) return null;

  const investmentRe = /(?:equity|debt|tax equity|investment|financing|invested|financed|lender|arranger|provided|construction|term loan)/i;
  const idx = docText.search(plantRe);
  if (idx === -1) return null;

  const window = docText.slice(Math.max(0, idx - 400), idx + 400);
  if (!investmentRe.test(window)) return null;

  // Determine role from context
  const role = /equity|tax equity/i.test(window) ? 'equity_investor'
             : /arranger|lead/i.test(window)      ? 'lead_arranger'
             : /administrative agent/i.test(window) ? 'administrative_agent'
             : 'lender';

  // Clean the entity name — strip stock tickers and CIK annotation
  const cleanName = entityName.replace(/\s*\(CIK[^)]+\)/i, '').replace(/\s*\([A-Z,\s]+\)\s*$/, '').trim();

  return {
    name:          cleanName,
    normalized:    normalizeName(cleanName),
    role,
    facility_type: /equity/i.test(role) ? 'tax_equity' : FACILITY_PATTERNS.find(p => p.regex.test(window))?.type ?? null,
    context:       window.slice(0, 300).trim(),
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 });

  const startMs = Date.now();

  try {
    const { plant_code, run_id, plant_name, sponsor_name, state, spv_aliases = [] }:
      { plant_code: string; run_id: string; plant_name: string; sponsor_name: string | null; state: string; spv_aliases: SpvAlias[] } =
      await req.json();

    if (!plant_code || !plant_name) {
      return new Response(JSON.stringify({ error: 'plant_code and plant_name required' }), { status: 400, headers: CORS });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Build search queries — EDGAR EFTS uses Elasticsearch match_phrase syntax.
    // Start with a bare plant-name query (catches investor presentations, press releases,
    // and credit agreement exhibits even when those keywords aren't in the same filing).
    const queries: string[] = [
      `"${plant_name}"`,                                // bare — broadest, catches all filing types
      `"${plant_name}" "credit agreement"`,
      `"${plant_name}" "term loan"`,
      `"${plant_name}" "construction loan"`,
    ];

    // Add top-confidence SPV aliases
    const topAliases = spv_aliases.filter(a => a.confidence >= 40).slice(0, 3);
    for (const alias of topAliases) {
      queries.push(`"${alias.name}"`);
    }

    if (sponsor_name) {
      queries.push(`"${sponsor_name}" "${plant_name}"`);
    }

    const allHits: EdgarHit[] = [];
    const sourceUrls: string[] = [];
    const snippets:   string[] = [];

    log(plant_code, `Running ${queries.length} EDGAR queries`);

    for (const query of queries) {
      await sleep(300); // be polite to EDGAR — rate limit ~10 req/s
      const results = await edgarSearch(query);
      log(plant_code, `  Query "${query.slice(0, 50)}" → ${results.length} hits`);

      for (const result of results) {
        if (sourceUrls.includes(result.file_url)) continue; // deduplicate

        // Fetch and extract lender names from document text
        const lenders = await fetchAndExtractLenders(
          result.file_url,
          result.adsh_nodash,
          result.cik,
          result.entity_name,
          plant_name,
        );

        allHits.push({ ...result, lenders, doc_url: result.file_url });
        sourceUrls.push(result.file_url);
        snippets.push(`${result.filing_type} | ${result.entity_name} | ${result.filed_at} | Lenders: ${lenders.map(l => l.name).join(', ') || 'none extracted'}`);

        // Persist each extracted lender to evidence and entities tables
        for (const lender of lenders) {
          const { data: lenderEntity } = await supabase
            .from('ucc_entities')
            .upsert({
              entity_name:     lender.name,
              entity_type:     lender.role.includes('agent') ? 'agent' : 'lender',
              normalized_name: lender.normalized,
              jurisdiction:    state,
              source:          'edgar',
              source_url:      result.file_url,
            }, { onConflict: 'normalized_name,entity_type,jurisdiction', ignoreDuplicates: false })
            .select('id')
            .single();

          await supabase.from('ucc_filings').insert({
            plant_code,
            filing_type:              result.filing_type === '8-K' ? 'edgar_8k' : 'edgar_10k',
            state,
            filing_date:              result.filed_at || null,
            debtor_name:              plant_name,
            debtor_normalized:        normalizeName(plant_name),
            secured_party_name:       lender.name,
            secured_party_normalized: lender.normalized,
            is_representative_party:  lender.role.toLowerCase().includes('agent'),
            representative_role:      lender.role.toLowerCase().includes('collateral') ? 'collateral_agent'
                                    : lender.role.toLowerCase().includes('admin') ? 'administrative_agent'
                                    : null,
            collateral_text:          lender.facility_type,
            source_url:               result.file_url,
            raw_text:                 lender.context,
            filing_number:            result.adsh || null,
            worker_name:              'ucc_edgar_worker',
            run_id:                   run_id ?? null,
          });

          await supabase.from('ucc_evidence_records').insert({
            plant_code,
            run_id:                   run_id ?? null,
            lender_entity_id:         lenderEntity?.id ?? null,
            source_type:              'edgar',
            source_url:               result.file_url,
            excerpt:                  `${result.filing_type} filed ${result.filed_at} — ${lender.name} as ${lender.role}`,
            raw_text:                 lender.context,
            extracted_fields: {
              lender_name:   lender.name,
              role:          lender.role,
              facility_type: lender.facility_type,
              filing_type:   result.filing_type,
              filed_date:    result.filed_at,
            },
            worker_name:              'ucc_edgar_worker',
            confidence_contribution:  'highly_likely',
          });
        }
      }
    }

    // Completion scoring
    // 80 = found filings with extracted lender names
    // 60 = found filings but no lenders extracted from text
    // 40 = no EDGAR hits at all (valid — not all plants have EDGAR disclosures)

    const totalLenders = allHits.reduce((sum, h) => sum + h.lenders.length, 0);
    let completionScore = 40; // base — searched but found nothing
    if (allHits.length > 0 && totalLenders > 0) completionScore = 80;
    else if (allHits.length > 0)                completionScore = 60;

    const openQuestions: string[] = [];
    if (allHits.length === 0) {
      openQuestions.push('No EDGAR filings found — sponsor may be private or plant not material enough for 8-K disclosure');
    }

    const output: WorkerOutput = {
      task_status:           'success', // EDGAR search always completes — no data is valid
      completion_score:      completionScore,
      evidence_found:        totalLenders > 0,
      structured_results:    allHits,
      source_urls:           sourceUrls,
      raw_evidence_snippets: snippets.slice(0, 10),
      open_questions:        openQuestions,
      retry_recommendation:  null,
      cost_usd:              0,
      llm_fallback_used:     false,
      duration_ms:           Date.now() - startMs,
    };

    if (run_id) {
      await supabase.from('ucc_agent_tasks').insert({
        run_id,
        plant_code,
        agent_type:        'edgar_worker',
        attempt_number:    1,
        task_status:       'success',
        completion_score:  completionScore,
        evidence_found:    totalLenders > 0,
        llm_fallback_used: false,
        cost_usd:          0,
        duration_ms:       output.duration_ms,
        output_json:       output,
      });
    }

    log(plant_code, `Done — ${allHits.length} filings, ${totalLenders} lenders, score=${completionScore}, ${output.duration_ms}ms`);
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
