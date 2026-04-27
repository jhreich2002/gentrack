/**
 * GenTrack — ucc-county-worker Edge Function (Deno)
 *
 * Searches county recorder / land records for mortgages, deeds of trust,
 * fixture filings, and assignments that name a solar/wind SPV as grantor.
 *
 * County recorder systems are highly fragmented (thousands of jurisdictions).
 * Strategy:
 *   1. Direct HTTP scrape for high-coverage counties in key solar states
 *      (major CA counties, major TX counties, Maricopa AZ)
 *   2. Perplexity sonar-pro fallback for all other counties — primary here,
 *      not a last resort, because fragmentation makes broad scraping impractical
 *
 * POST body:
 *   { plant_code, run_id, state, county, spv_aliases, plant_name,
 *     adjacent_counties?, allow_llm_fallback? }
 *
 * Returns standard worker output schema.
 *
 * Required secrets:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 *   PERPLEXITY_API_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 15_000;
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

interface CountyRecord {
  doc_type:              string;  // deed_of_trust | mortgage | fixture_filing | assignment | release
  recording_date:        string | null;
  grantor:               string;  // borrower / debtor
  grantee:               string;  // lender / beneficiary / trustee
  is_representative:     boolean;
  representative_role:   string | null;  // collateral_agent | trustee | administrative_agent
  instrument_number:     string;
  book_page:             string | null;
  parcel_id:             string | null;
  source_url:            string;
  raw_text:              string;
  county:                string;
  state:                 string;
}

interface WorkerOutput {
  task_status:           'success' | 'partial' | 'failed';
  completion_score:      number;
  evidence_found:        boolean;
  structured_results:    CountyRecord[];
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
  console.log(`[${ts}] [COUNTY:${tag}] ${msg}`);
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|lp|inc|corp|co|ltd|na|n\.a\.|plc|as agent|as collateral agent|holdings|project|wind|solar|energy|power|renewable|resources)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectRole(name: string): { is_rep: boolean; role: string | null } {
  const lower = name.toLowerCase();
  if (lower.includes('collateral agent'))     return { is_rep: true, role: 'collateral_agent' };
  if (lower.includes('administrative agent')) return { is_rep: true, role: 'administrative_agent' };
  if (lower.includes('indenture trustee'))    return { is_rep: true, role: 'trustee' };
  if (lower.includes('trustee'))              return { is_rep: true, role: 'trustee' };
  if (lower.includes(', as agent'))           return { is_rep: true, role: 'administrative_agent' };
  if (lower.includes(' as collateral'))       return { is_rep: true, role: 'collateral_agent' };
  return { is_rep: false, role: null };
}

function classifyDocType(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('deed of trust') || lower.includes('dot'))       return 'deed_of_trust';
  if (lower.includes('mortgage'))                                      return 'mortgage';
  if (lower.includes('fixture'))                                       return 'fixture_filing';
  if (lower.includes('assign'))                                        return 'assignment';
  if (lower.includes('release') || lower.includes('reconveyance'))    return 'release';
  if (lower.includes('easement'))                                      return 'easement';
  return 'other';
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  // sonar-pro: ~$3/M input, $15/M output (approximate)
  return (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
}

// ── County-specific scrapers ──────────────────────────────────────────────────
// Built for high-volume solar/wind counties. All return [] on failure —
// Perplexity fallback handles what these miss.

// California: courts.ca.gov recording search (by county code)
// Real CA county search endpoints vary by county — this models the most common pattern
async function searchCASanBernardinoCounty(debtorName: string): Promise<CountyRecord[]> {
  // San Bernardino hosts many Mojave Desert solar projects
  const url = `https://assessor.sbcounty.gov/cass/Main/Search?SearchText=${encodeURIComponent(debtorName)}&SearchType=OwnerName`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseCACountyHTML(html, debtorName, 'San Bernardino', 'CA', url);
  } catch { return []; }
}

async function searchCARiversideCounty(debtorName: string): Promise<CountyRecord[]> {
  const url = `https://riverside.courts.ca.gov/recorder/search?name=${encodeURIComponent(debtorName)}`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseCACountyHTML(html, debtorName, 'Riverside', 'CA', url);
  } catch { return []; }
}

async function searchCAKernCounty(debtorName: string): Promise<CountyRecord[]> {
  // Kern County hosts Central Valley solar — has online recorder portal
  const url = `https://www.kernrecorder.com/cgi-bin/search.cgi?name=${encodeURIComponent(debtorName)}&type=grantor`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseCACountyHTML(html, debtorName, 'Kern', 'CA', url);
  } catch { return []; }
}

function parseCACountyHTML(html: string, debtorName: string, county: string, state: string, sourceUrl: string): CountyRecord[] {
  const results: CountyRecord[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  let rowCount = 0;

  while ((match = rowRegex.exec(html)) !== null) {
    rowCount++;
    if (rowCount < 2) continue;
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim());

    if (cells.length < 3) continue;

    const grantee = cells.find(c => c.length > 3 && /bank|capital|financial|trust|lender/i.test(c));
    if (!grantee) continue;

    const { is_rep, role } = detectRole(grantee);
    results.push({
      doc_type:            classifyDocType(cells[0] ?? ''),
      recording_date:      cells[1] ?? null,
      grantor:             debtorName,
      grantee,
      is_representative:   is_rep,
      representative_role: role,
      instrument_number:   cells[2] ?? '',
      book_page:           cells[3] ?? null,
      parcel_id:           null,
      source_url:          sourceUrl,
      raw_text:            cells.join(' | '),
      county,
      state,
    });
  }
  return results;
}

// Texas: major county clerk portals
async function searchTXHarrisCounty(debtorName: string): Promise<CountyRecord[]> {
  // Harris County (Houston) — hosts many Gulf Coast wind financing
  const url = `https://www.cclerk.hctx.net/applications/websearch/RE.aspx?sGrantorName=${encodeURIComponent(debtorName)}`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseTXCountyHTML(html, debtorName, 'Harris', 'TX', url);
  } catch { return []; }
}

async function searchTXBexarCounty(debtorName: string): Promise<CountyRecord[]> {
  const url = `https://apps3.bexar.org/recorderSearch/search?grantor=${encodeURIComponent(debtorName)}`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseTXCountyHTML(html, debtorName, 'Bexar', 'TX', url);
  } catch { return []; }
}

function parseTXCountyHTML(html: string, debtorName: string, county: string, state: string, sourceUrl: string): CountyRecord[] {
  const results: CountyRecord[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  let rowCount = 0;

  while ((match = rowRegex.exec(html)) !== null) {
    rowCount++;
    if (rowCount < 2) continue;
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim());

    if (cells.length < 4) continue;
    const grantee = cells[3];
    if (!grantee || grantee.length < 3) continue;

    const { is_rep, role } = detectRole(grantee);
    results.push({
      doc_type:            classifyDocType(cells[1] ?? ''),
      recording_date:      cells[2] ?? null,
      grantor:             cells[0] ?? debtorName,
      grantee,
      is_representative:   is_rep,
      representative_role: role,
      instrument_number:   cells[4] ?? '',
      book_page:           null,
      parcel_id:           cells[5] ?? null,
      source_url:          sourceUrl,
      raw_text:            cells.join(' | '),
      county,
      state,
    });
  }
  return results;
}

// Arizona: Maricopa County Recorder
async function searchAZMaricopaCounty(debtorName: string): Promise<CountyRecord[]> {
  const url = `https://recorder.maricopa.gov/recdocdata/GetDocData.aspx?searchType=grantor&name=${encodeURIComponent(debtorName)}`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseAZCountyHTML(html, debtorName, 'Maricopa', 'AZ', url);
  } catch { return []; }
}

function parseAZCountyHTML(html: string, debtorName: string, county: string, state: string, sourceUrl: string): CountyRecord[] {
  const results: CountyRecord[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  let rowCount = 0;

  while ((match = rowRegex.exec(html)) !== null) {
    rowCount++;
    if (rowCount < 2) continue;
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').trim());

    if (cells.length < 3) continue;
    const grantee = cells[2];
    if (!grantee || grantee.length < 3) continue;

    const { is_rep, role } = detectRole(grantee);
    results.push({
      doc_type:            classifyDocType(cells[1] ?? ''),
      recording_date:      cells[0] ?? null,
      grantor:             debtorName,
      grantee,
      is_representative:   is_rep,
      representative_role: role,
      instrument_number:   cells[3] ?? '',
      book_page:           null,
      parcel_id:           null,
      source_url:          sourceUrl,
      raw_text:            cells.join(' | '),
      county,
      state,
    });
  }
  return results;
}

// ── County scraper router ─────────────────────────────────────────────────────

interface CountyScraper {
  search: (debtorName: string) => Promise<CountyRecord[]>;
}

// Keys: "STATE:COUNTY" lowercase
const COUNTY_SCRAPERS: Record<string, CountyScraper> = {
  'ca:san bernardino': { search: searchCASanBernardinoCounty },
  'ca:riverside':      { search: searchCARiversideCounty     },
  'ca:kern':           { search: searchCAKernCounty           },
  'tx:harris':         { search: searchTXHarrisCounty         },
  'tx:bexar':          { search: searchTXBexarCounty          },
  'az:maricopa':       { search: searchAZMaricopaCounty       },
};

function getCountyScraper(state: string, county: string): CountyScraper | null {
  const key = `${state.toLowerCase()}:${county.toLowerCase()}`;
  return COUNTY_SCRAPERS[key] ?? null;
}

// ── Perplexity county search ──────────────────────────────────────────────────

async function perplexityCountySearch(
  spvName:    string,
  county:     string,
  state:      string,
  plantName:  string,
): Promise<{ records: CountyRecord[]; cost: number }> {
  const apiKey = Deno.env.get('PERPLEXITY_API_KEY');
  if (!apiKey) return { records: [], cost: 0 };

  const prompt = `Search ${county} County, ${state} recorder/land records for financing documents related to the solar or wind energy project "${plantName}".

Look for deeds of trust, mortgages, fixture filings, or assignments of rents recorded against any of these entities as grantor:
- "${spvName}"
- "${plantName} LLC"
- "${plantName} Holdings LLC"

For each document found, provide a JSON array with objects containing:
{
  "doc_type": "deed_of_trust" | "mortgage" | "fixture_filing" | "assignment" | "release",
  "recording_date": "YYYY-MM-DD or null",
  "grantor": "exact name from record",
  "grantee": "exact lender/beneficiary/trustee name",
  "representative_role": "collateral_agent" | "trustee" | "administrative_agent" | null,
  "instrument_number": "document number",
  "source_url": "direct URL to document or recorder portal"
}

Return only a JSON array. If nothing found, return [].`;

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

    if (!resp.ok) return { records: [], cost: 0 };
    const data = await resp.json();

    const content      = data.choices?.[0]?.message?.content ?? '';
    const inputTokens  = data.usage?.prompt_tokens     ?? 400;
    const outputTokens = data.usage?.completion_tokens ?? 200;
    const cost         = estimateCost(inputTokens, outputTokens);

    // Extract JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return { records: [], cost };

    const parsed: Array<Record<string, unknown>> = JSON.parse(jsonMatch[0]);
    const records: CountyRecord[] = parsed
      .filter(r => r.grantee && String(r.grantee).length > 3)
      .map(r => {
        const grantee = String(r.grantee ?? '');
        const { is_rep, role } = detectRole(grantee);
        return {
          doc_type:            String(r.doc_type ?? 'other'),
          recording_date:      r.recording_date ? String(r.recording_date) : null,
          grantor:             String(r.grantor ?? spvName),
          grantee,
          is_representative:   r.representative_role ? true : is_rep,
          representative_role: r.representative_role ? String(r.representative_role) : role,
          instrument_number:   String(r.instrument_number ?? ''),
          book_page:           null,
          parcel_id:           null,
          source_url:          String(r.source_url ?? ''),
          raw_text:            JSON.stringify(r),
          county,
          state,
        };
      });

    return { records, cost };
  } catch {
    return { records: [], cost: 0 };
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
      state,
      county,
      spv_aliases = [],
      plant_name,
      adjacent_counties = [],
      allow_llm_fallback = true,
    }: {
      plant_code:          string;
      run_id:              string;
      state:               string;
      county:              string;
      spv_aliases:         SpvAlias[];
      plant_name:          string;
      adjacent_counties?:  string[];
      allow_llm_fallback?: boolean;
    } = await req.json();

    if (!plant_code || !plant_name || !state || !county) {
      return new Response(
        JSON.stringify({ error: 'plant_code, plant_name, state, and county required' }),
        { status: 400, headers: CORS },
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Top aliases to search — sorted by confidence
    const topAliases = [...spv_aliases]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 6);

    const allRecords:  CountyRecord[] = [];
    const sourceUrls:  string[] = [];
    const snippets:    string[] = [];
    let   totalCost    = 0;
    let   llmUsed      = false;

    const countiesToSearch = [county, ...adjacent_counties].slice(0, 3);

    for (const searchCounty of countiesToSearch) {
      const scraper = getCountyScraper(state, searchCounty);

      if (scraper) {
        // Try direct scraper first
        log(plant_code, `Direct scrape: ${state}:${searchCounty}`);
        for (const alias of topAliases) {
          try {
            const records = await scraper.search(alias.name);
            log(plant_code, `  ${alias.name} → ${records.length} records`);
            for (const rec of records) {
              const key = normalizeName(rec.grantor) + '|' + normalizeName(rec.grantee) + '|' + rec.instrument_number;
              if (!sourceUrls.includes(rec.source_url)) sourceUrls.push(rec.source_url);
              allRecords.push(rec);
              snippets.push(`${rec.doc_type} | ${rec.grantee} | ${rec.recording_date} | ${searchCounty} County`);
            }
          } catch { /* continue */ }
        }
      }

      // Perplexity fallback if no scraper or scraper found nothing for this county
      const countyHasResults = allRecords.some(r => r.county.toLowerCase() === searchCounty.toLowerCase());

      if (!countyHasResults && allow_llm_fallback) {
        log(plant_code, `Perplexity fallback: ${state}:${searchCounty}`);
        llmUsed = true;

        const topAlias = topAliases[0]?.name ?? plant_name;
        const { records, cost } = await perplexityCountySearch(topAlias, searchCounty, state, plant_name);
        totalCost += cost;

        log(plant_code, `  Perplexity → ${records.length} records, cost=$${cost.toFixed(4)}`);

        for (const rec of records) {
          if (rec.source_url && !sourceUrls.includes(rec.source_url)) sourceUrls.push(rec.source_url);
          allRecords.push(rec);
          snippets.push(`${rec.doc_type} | ${rec.grantee} | ${rec.recording_date} | ${searchCounty} County (Perplexity)`);
        }
      }
    }

    // Deduplicate by normalized grantor + grantee + instrument
    const seen = new Set<string>();
    const deduped = allRecords.filter(r => {
      const key = normalizeName(r.grantor) + '|' + normalizeName(r.grantee) + '|' + r.instrument_number;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    log(plant_code, `Total: ${deduped.length} unique records`);

    // Persist to DB
    for (const rec of deduped) {
      // Upsert lender entity
      const { data: entityRow } = await supabase
        .from('ucc_entities')
        .upsert({
          entity_name:     rec.grantee,
          entity_type:     rec.is_representative ? 'agent' : 'lender',
          normalized_name: normalizeName(rec.grantee),
          jurisdiction:    state,
          source:          llmUsed ? 'perplexity' : 'county_scrape',
          source_url:      rec.source_url,
        }, { onConflict: 'normalized_name,entity_type,jurisdiction', ignoreDuplicates: false })
        .select('id')
        .single();

      await supabase.from('ucc_filings').insert({
        plant_code,
        filing_type:              rec.doc_type,
        state,
        county:                   rec.county,
        filing_date:              rec.recording_date || null,
        debtor_name:              rec.grantor,
        debtor_normalized:        normalizeName(rec.grantor),
        secured_party_name:       rec.grantee,
        secured_party_normalized: normalizeName(rec.grantee),
        is_representative_party:  rec.is_representative,
        representative_role:      rec.representative_role,
        collateral_text:          null,
        source_url:               rec.source_url,
        raw_text:                 rec.raw_text,
        filing_number:            rec.instrument_number || null,
        worker_name:              'ucc_county_worker',
        run_id:                   run_id ?? null,
      });

      await supabase.from('ucc_evidence_records').insert({
        plant_code,
        run_id:                   run_id ?? null,
        lender_entity_id:         entityRow?.id ?? null,
        source_type:              llmUsed ? 'perplexity' : 'county_scrape',
        source_url:               rec.source_url,
        excerpt:                  `${rec.doc_type} recorded ${rec.recording_date} — ${rec.grantee}${rec.representative_role ? ` as ${rec.representative_role}` : ''}`,
        raw_text:                 rec.raw_text,
        extracted_fields: {
          grantee:             rec.grantee,
          doc_type:            rec.doc_type,
          recording_date:      rec.recording_date,
          instrument_number:   rec.instrument_number,
          representative_role: rec.representative_role,
          county:              rec.county,
          state,
        },
        worker_name:              'ucc_county_worker',
        confidence_contribution:  rec.is_representative ? 'highly_likely' : 'confirmed',
      });
    }

    // Scoring:
    // 85 = scraper hit with lender records
    // 70 = Perplexity found records
    // 50 = searched but nothing found (valid — many counties have no online access)
    // 0  = nothing ran

    const completionScore =
      deduped.length > 0 && !llmUsed ? 85
      : deduped.length > 0           ? 70
      : allow_llm_fallback           ? 50
      : 0;

    const openQuestions: string[] = [];
    if (deduped.length === 0) {
      openQuestions.push(`No county recorder documents found for ${county} County, ${state} — may require manual recorder search or county has no online portal`);
    }

    const output: WorkerOutput = {
      task_status:           'success',
      completion_score:      completionScore,
      evidence_found:        deduped.length > 0,
      structured_results:    deduped,
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
        agent_type:        'county_worker',
        attempt_number:    1,
        task_status:       'success',
        completion_score:  completionScore,
        evidence_found:    deduped.length > 0,
        llm_fallback_used: llmUsed,
        cost_usd:          totalCost,
        duration_ms:       output.duration_ms,
        output_json:       output,
      });
    }

    log(plant_code, `Done — ${deduped.length} records, score=${completionScore}, cost=$${totalCost.toFixed(4)}, ${output.duration_ms}ms`);
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
