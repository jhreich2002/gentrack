/**
 * GenTrack — ucc-ferc-worker Edge Function (Deno)
 *
 * Searches FERC eLibrary for dockets, orders, and interconnection agreements
 * related to a plant.  FERC filings often name the project company, the
 * interconnecting utility, and — in transmission service agreements and
 * project finance orders — the lender/collateral agent.
 *
 * Publicly free via FERC eLibrary full-text search:
 *   https://elibrary.ferc.gov/eLibrary/search
 *
 * POST body:
 *   { plant_code, run_id, plant_name, sponsor_name, state, capacity_mw?, cod_year? }
 *
 * Returns standard worker output schema.
 *
 * Required secrets:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

// FERC eLibrary search endpoint (publicly accessible, no auth required)
const FERC_SEARCH_URL = 'https://elibrary.ferc.gov/eLibrary/search?fullText=';
const FERC_API_URL    = 'https://elibrary.ferc.gov/eLibrary/SearchAPI/search';
const TIMEOUT_MS      = 15_000;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

// FERC document categories most likely to reveal lenders
const TARGET_CATEGORIES = [
  'Security Agreement',
  'Collateral Assignment',
  'Interconnection Agreement',
  'Power Purchase Agreement',
  'Credit Agreement',
  'Financing Order',
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkerOutput {
  task_status:           'success' | 'partial' | 'failed';
  completion_score:      number;
  evidence_found:        boolean;
  structured_results:    FercMatch[];
  source_urls:           string[];
  raw_evidence_snippets: string[];
  open_questions:        string[];
  retry_recommendation:  string | null;
  cost_usd:              0;
  llm_fallback_used:     false;
  duration_ms:           number;
  queries_attempted:     Array<{ source: string; query: string; hit_count: number; url: string | null }>;
}

interface FercMatch {
  docket_number: string;
  document_type: string;
  filed_date:    string;
  filer_name:    string;
  description:   string;
  source_url:    string;
  lenders_found: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [FERC:${tag}] ${msg}`);
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|lp|inc|corp|co|ltd|na|n\.a\.|as agent|as collateral agent)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Search FERC eLibrary via the public search API.
 * FERC's eLibrary exposes an Elasticsearch-compatible search endpoint.
 */
async function searchFercElibrary(
  query:    string,
  maxHits:  number = 10,
): Promise<FercMatch[]> {
  // Try the JSON API first
  try {
    const resp = await fetch(FERC_API_URL, {
      method: 'POST',
      headers: {
        'User-Agent':    'GenTrack-LenderResearch/1.0 compliance@example.com',
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify({
        fullText: query,
        pageSize: maxHits,
        pageNumber: 1,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (resp.ok) {
      const data = await resp.json();
      const docs = (data?.results ?? data?.hits?.hits ?? data?.documents ?? []) as Array<Record<string, unknown>>;

      return docs.slice(0, maxHits).map((doc) => {
        const src     = (doc._source ?? doc) as Record<string, unknown>;
        const docket  = String(src.docket_number ?? src.DocketNumber ?? '');
        const docType = String(src.document_type ?? src.DocumentType ?? src.category ?? '');
        const filed   = String(src.filed_date ?? src.FiledDate ?? src.date ?? '');
        const filer   = String(src.filer_name ?? src.FilerName ?? src.entity_name ?? '');
        const desc    = String(src.description ?? src.Description ?? src.title ?? '');
        const url     = String(src.source_url ?? src.url ?? src.document_url ?? '');

        // Extract lender names from description/title using role patterns
        const lenders: string[] = [];
        const lenderRe = /([A-Z][A-Za-z\s,\.&]{2,60}(?:Bank|Capital|Financial|Partners|Trust|Credit))\s+(?:as\s+)?(?:administrative\s+agent|collateral\s+agent|lender|arranger)/gi;
        let m;
        while ((m = lenderRe.exec(desc)) !== null) {
          lenders.push(m[1].trim());
        }

        return { docket_number: docket, document_type: docType, filed_date: filed, filer_name: filer, description: desc.slice(0, 500), source_url: url, lenders_found: lenders };
      });
    }
  } catch { /* fall through to HTML search */ }

  // Fallback: HTML search (parse minimal metadata from result snippets)
  try {
    const searchUrl = `${FERC_SEARCH_URL}${encodeURIComponent(query)}&pageSize=${maxHits}`;
    const resp = await fetch(searchUrl, {
      headers: { 'User-Agent': 'GenTrack-LenderResearch/1.0 compliance@example.com' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!resp.ok) return [];

    const html   = await resp.text();
    const text   = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const matches: FercMatch[] = [];

    // Extract docket numbers (format: CP##-###, ER##-###, EL##-###, etc.)
    const docketRe = /\b([A-Z]{2}\d{2}-\d{3,6}-\d{3})\b/g;
    const dockets  = new Set<string>();
    let dm;
    while ((dm = docketRe.exec(text)) !== null) dockets.add(dm[1]);

    for (const docket of Array.from(dockets).slice(0, maxHits)) {
      matches.push({
        docket_number: docket,
        document_type: 'ferc_docket',
        filed_date:    '',
        filer_name:    '',
        description:   `FERC docket ${docket} found in search results for: ${query}`,
        source_url:    `https://elibrary.ferc.gov/eLibrary/search?docketNumber=${docket}`,
        lenders_found: [],
      });
    }

    return matches;
  } catch (err) {
    log('SEARCH', `HTML fallback error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 });

  const startMs = Date.now();

  try {
    const { plant_code, run_id, plant_name, sponsor_name, state }:
      { plant_code: string; run_id: string; plant_name: string; sponsor_name: string | null; state: string } =
      await req.json();

    if (!plant_code || !plant_name) {
      return new Response(JSON.stringify({ error: 'plant_code and plant_name required' }), { status: 400, headers: CORS });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const queriesAttempted: Array<{ source: string; query: string; hit_count: number; url: string | null }> = [];
    const allMatches: FercMatch[] = [];
    const sourceUrls: string[]    = [];
    const snippets:   string[]    = [];
    const seen = new Set<string>();

    const queries = [
      `"${plant_name}"`,
      `"${plant_name}" "credit agreement"`,
      `"${plant_name}" "security agreement"`,
    ];
    if (sponsor_name) {
      queries.push(`"${sponsor_name}" "${plant_name}"`);
    }

    for (const query of queries) {
      await sleep(500); // be polite — FERC is a public service
      const results = await searchFercElibrary(query, 5);
      queriesAttempted.push({ source: 'ferc_elibrary', query, hit_count: results.length, url: `${FERC_SEARCH_URL}${encodeURIComponent(query)}` });
      log(plant_code, `FERC query "${query.slice(0, 60)}": ${results.length} results`);

      for (const r of results) {
        const key = r.docket_number || r.source_url || r.description.slice(0, 50);
        if (!seen.has(key)) {
          seen.add(key);
          allMatches.push(r);
          if (r.source_url) sourceUrls.push(r.source_url);
          snippets.push(r.description);
        }
      }
    }

    // Persist evidence for matches that have lenders
    const matchesWithLenders = allMatches.filter(m => m.lenders_found.length > 0);

    for (const match of matchesWithLenders) {
      for (const lenderName of match.lenders_found) {
        const { data: lenderEntity } = await supabase
          .from('ucc_entities')
          .upsert({
            entity_name:     lenderName,
            entity_type:     'lender',
            normalized_name: normalizeName(lenderName),
            jurisdiction:    state,
            source:          'ferc',
            source_url:      match.source_url,
          }, { onConflict: 'normalized_name,entity_type,jurisdiction', ignoreDuplicates: false })
          .select('id')
          .single();

        await supabase.from('ucc_evidence_records').insert({
          plant_code,
          run_id:           run_id || null,
          lender_entity_id: lenderEntity?.id ?? null,
          source_type:      'ferc',
          source_url:       match.source_url || null,
          excerpt:          `FERC ${match.document_type} (docket ${match.docket_number}) — ${lenderName}`,
          raw_text:         match.description,
          extracted_fields: {
            docket_number: match.docket_number,
            document_type: match.document_type,
            filed_date:    match.filed_date,
            filer_name:    match.filer_name,
          },
          worker_name:              'ucc_ferc_worker',
          confidence_contribution:  'highly_likely',
        });
      }
    }

    // Scoring:
    // 80 = found FERC filings with extracted lender names
    // 60 = found dockets but no lender names extracted
    // 40 = no FERC hits (expected — many plants do not have FERC filings)
    let completionScore = 40;
    if (matchesWithLenders.length > 0) completionScore = 80;
    else if (allMatches.length > 0)    completionScore = 60;

    const output: WorkerOutput = {
      task_status:           'success',
      completion_score:      completionScore,
      evidence_found:        matchesWithLenders.length > 0,
      structured_results:    allMatches,
      source_urls:           sourceUrls,
      raw_evidence_snippets: snippets.slice(0, 5),
      open_questions:        allMatches.length === 0 ? ['No FERC filings found — state-regulated projects may not have FERC dockets'] : [],
      retry_recommendation:  null,
      cost_usd:              0,
      llm_fallback_used:     false,
      duration_ms:           Date.now() - startMs,
      queries_attempted:     queriesAttempted,
    };

    log(plant_code, `Done — ${allMatches.length} dockets, ${matchesWithLenders.length} with lenders, score=${completionScore}, ${output.duration_ms}ms`);
    return new Response(JSON.stringify(output), { headers: CORS });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', msg);
    return new Response(JSON.stringify({
      task_status: 'failed', completion_score: 0, evidence_found: false,
      structured_results: [], source_urls: [], raw_evidence_snippets: [],
      open_questions: [msg], retry_recommendation: 'Unexpected error — check logs',
      cost_usd: 0, llm_fallback_used: false, duration_ms: 0, queries_attempted: [],
    }), { status: 500, headers: CORS });
  }
});
