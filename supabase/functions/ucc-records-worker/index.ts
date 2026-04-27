/**
 * GenTrack — ucc-records-worker Edge Function (Deno)
 *
 * Searches state UCC filing databases for financing statements naming
 * the resolved SPV aliases as debtor. Secured party = lender candidate.
 *
 * Source priority (scraper-first):
 *   1. Direct HTTP scrape of state UCC portal  (free, if state adapter enabled)
 *   2. Perplexity sonar-pro fallback           (only if scraper misses/unavailable)
 *
 * POST body:
 *   {
 *     plant_code:  string,
 *     run_id:      string,
 *     state:       string,
 *     spv_aliases: Array<{ name: string, normalized: string, confidence: number }>,
 *     allow_llm_fallback?: boolean,
 *   }
 *
 * Returns standard worker output schema.
 *
 * Required secrets:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 *   PERPLEXITY_API_KEY (fallback only)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAdapter, type UccFilingRecord } from './states/index.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const PERPLEXITY_URL     = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL   = 'sonar-pro';
const PERPLEXITY_TIMEOUT = 25_000;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

// ── Types ─────────────────────────────────────────────────────────────────────

interface SpvAlias {
  name:       string;
  normalized: string;
  confidence: number;
}

interface WorkerOutput {
  task_status:           'success' | 'partial' | 'failed';
  completion_score:      number;
  evidence_found:        boolean;
  structured_results:    FilingResult[];
  source_urls:           string[];
  raw_evidence_snippets: string[];
  open_questions:        string[];
  retry_recommendation:  string | null;
  cost_usd:              number;
  llm_fallback_used:     boolean;
  duration_ms:           number;
}

interface FilingResult {
  alias_searched:   string;
  filing_type:      string;
  filing_date:      string | null;
  debtor_name:      string;
  secured_party:    string;
  is_rep_party:     boolean;
  rep_role:         string | null;
  collateral_text:  string | null;
  source_url:       string;
  is_current:       boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [UCC:${tag}] ${msg}`);
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0 + 0.005;
}

/** A filing with a termination date in the past is historical, not current */
function isCurrentFiling(rec: UccFilingRecord): boolean {
  if (!rec.termination_date) return true;
  try {
    return new Date(rec.termination_date) > new Date();
  } catch {
    return true;
  }
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|lp|inc|corp|co|ltd|na|n\.a\.|plc|as agent|as collateral agent|as administrative agent)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Perplexity UCC search fallback ────────────────────────────────────────────

interface PerplexityFilingResult {
  debtor_name:    string;
  secured_party:  string;
  filing_type:    string;
  filing_date:    string | null;
  collateral:     string | null;
  source_url:     string | null;
  is_current:     boolean;
}

async function perplexityUCCSearch(
  plantCode:     string,
  state:         string,
  spvAliases:    SpvAlias[],
  perplexityKey: string,
): Promise<{ results: PerplexityFilingResult[]; costUsd: number; rawText: string }> {
  const aliasListStr = spvAliases
    .slice(0, 6)
    .map(a => `"${a.name}"`)
    .join(', ');

  const prompt = `Search the ${state} UCC filing database (Secretary of State) for UCC-1 financing statements where the debtor name is one of: ${aliasListStr}.

For each filing found, return:
- debtor_name: exact debtor name as filed
- secured_party: exact secured party name as filed (this is the LENDER or their agent)
- filing_type: ucc1, ucc3_amendment, or ucc3_termination
- filing_date: YYYY-MM-DD format
- collateral: brief collateral description if available
- source_url: URL to the filing record if available
- is_current: true if no termination filed

Return a JSON array. Return [] if nothing found. Do not invent or hallucinate filings.

[{ "debtor_name": "", "secured_party": "", "filing_type": "ucc1", "filing_date": null, "collateral": null, "source_url": null, "is_current": true }]`;

  const body = {
    model:    PERPLEXITY_MODEL,
    messages: [
      {
        role:    'system',
        content: 'You are a legal records research assistant. Return only valid JSON arrays with no markdown or explanation.',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens:  1000,
    temperature: 0,
  };

  try {
    const resp = await fetch(PERPLEXITY_URL, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${perplexityKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(PERPLEXITY_TIMEOUT),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data  = await resp.json();
    const usage = data.usage ?? {};
    const cost  = estimateCost(usage.prompt_tokens ?? 700, usage.completion_tokens ?? 500);
    const raw   = data.choices?.[0]?.message?.content ?? '[]';

    let parsed: PerplexityFilingResult[] = [];
    try {
      parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
    } catch {
      log(plantCode, 'Perplexity JSON parse failed');
    }

    return { results: parsed.filter(r => r.secured_party?.length > 2), costUsd: cost, rawText: raw };
  } catch (err) {
    log(plantCode, `Perplexity error: ${err instanceof Error ? err.message : String(err)}`);
    return { results: [], costUsd: 0, rawText: '' };
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
      spv_aliases,
      allow_llm_fallback = true,
    }: {
      plant_code:           string;
      run_id:               string;
      state:                string;
      spv_aliases:          SpvAlias[];
      allow_llm_fallback?:  boolean;
    } = await req.json();

    if (!plant_code || !state || !spv_aliases?.length) {
      return new Response(
        JSON.stringify({ error: 'plant_code, state, and spv_aliases required' }),
        { status: 400, headers: CORS },
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const perplexityKey = Deno.env.get('PERPLEXITY_API_KEY') ?? '';

    // Prioritize high-confidence aliases and cap at 8 to limit portal load
    const aliasesToSearch = spv_aliases
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8);

    const allFilings:  UccFilingRecord[]         = [];
    const sourceUrls:  string[]                  = [];
    const snippets:    string[]                  = [];
    let   llmFallback  = false;
    let   costUsd      = 0;
    let   scraperUsed  = false;

    const adapter = getAdapter(state);

    // ── Direct scraper path ───────────────────────────────────────────────────
    if (adapter?.enabled) {
      log(plant_code, `Scraping ${state} UCC portal for ${aliasesToSearch.length} aliases`);
      scraperUsed = true;

      for (const alias of aliasesToSearch) {
        try {
          const hits = await adapter.search(alias.name);
          log(plant_code, `  "${alias.name}" → ${hits.length} hits`);
          allFilings.push(...hits);
          hits.forEach(h => {
            if (h.source_url && !sourceUrls.includes(h.source_url)) sourceUrls.push(h.source_url);
            snippets.push(`${h.filing_type} | Debtor: ${h.debtor_name} | Secured: ${h.secured_party_name} | Date: ${h.filing_date ?? 'unknown'}`);
          });
        } catch (err) {
          log(plant_code, `  Scraper error for "${alias.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      log(plant_code, `No enabled adapter for ${state}`);
    }

    // ── Perplexity fallback (if scraper unavailable OR returned nothing) ──────
    if (allFilings.length === 0 && allow_llm_fallback && perplexityKey) {
      log(plant_code, `Triggering Perplexity fallback for ${state}`);
      llmFallback = true;

      const { results: perpResults, costUsd: perpCost, rawText } =
        await perplexityUCCSearch(plant_code, state, aliasesToSearch, perplexityKey);

      costUsd = perpCost;
      if (rawText) snippets.push(`Perplexity raw: ${rawText.slice(0, 500)}`);

      // Convert Perplexity results to UccFilingRecord shape for unified processing
      for (const r of perpResults) {
        allFilings.push({
          filing_number:           '',
          filing_type:             r.filing_type,
          filing_date:             r.filing_date,
          amendment_date:          null,
          termination_date:        null,
          debtor_name:             r.debtor_name,
          secured_party_name:      r.secured_party,
          is_representative_party: r.secured_party.toLowerCase().includes('agent') ||
                                   r.secured_party.toLowerCase().includes('trustee'),
          representative_role:     r.secured_party.toLowerCase().includes('collateral') ? 'collateral_agent'
                                 : r.secured_party.toLowerCase().includes('admin') ? 'administrative_agent'
                                 : r.secured_party.toLowerCase().includes('trustee') ? 'trustee'
                                 : null,
          collateral_text:         r.collateral,
          source_url:              r.source_url ?? `https://www.sos.state.${state.toLowerCase()}.us/ucc`,
          raw_text:                JSON.stringify(r),
        });
        if (r.source_url) sourceUrls.push(r.source_url);
      }
    }

    // ── Deduplicate by (debtor_normalized, secured_party_normalized) ──────────
    const seen      = new Set<string>();
    const deduped:  UccFilingRecord[] = [];
    for (const f of allFilings) {
      const key = `${normalizeName(f.debtor_name)}|${normalizeName(f.secured_party_name)}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(f);
      }
    }

    // ── Persist to ucc_filings ────────────────────────────────────────────────
    const filingResults: FilingResult[] = [];

    for (const filing of deduped) {
      const isCurrent = isCurrentFiling(filing);

      // Insert filing record
      const { data: filingRow } = await supabase.from('ucc_filings').insert({
        plant_code,
        filing_type:              filing.filing_type,
        state,
        filing_date:              filing.filing_date,
        amendment_date:           filing.amendment_date,
        termination_date:         filing.termination_date,
        debtor_name:              filing.debtor_name,
        debtor_normalized:        normalizeName(filing.debtor_name),
        secured_party_name:       filing.secured_party_name,
        secured_party_normalized: normalizeName(filing.secured_party_name),
        is_representative_party:  filing.is_representative_party,
        representative_role:      filing.representative_role,
        collateral_text:          filing.collateral_text,
        source_url:               filing.source_url,
        raw_text:                 filing.raw_text,
        filing_number:            filing.filing_number || null,
        worker_name:              'ucc_records_worker',
        run_id:                   run_id ?? null,
      }).select('id').single();

      // Upsert lender entity
      if (filing.secured_party_name) {
        const lenderNorm = normalizeName(filing.secured_party_name);
        const { data: lenderEntity } = await supabase
          .from('ucc_entities')
          .upsert({
            entity_name:     filing.secured_party_name,
            entity_type:     filing.is_representative_party ? 'agent' : 'lender',
            normalized_name: lenderNorm,
            jurisdiction:    state,
            source:          llmFallback ? 'perplexity' : 'ucc_filing',
            source_url:      filing.source_url,
          }, { onConflict: 'normalized_name,entity_type,jurisdiction', ignoreDuplicates: false })
          .select('id')
          .single();

        // Write evidence record
        await supabase.from('ucc_evidence_records').insert({
          plant_code,
          run_id:              run_id ?? null,
          lender_entity_id:    lenderEntity?.id ?? null,
          source_type:         llmFallback ? 'perplexity' : 'ucc_scrape',
          source_url:          filing.source_url,
          excerpt:             `${filing.filing_type} | ${filing.debtor_name} → ${filing.secured_party_name} | ${filing.filing_date ?? 'date unknown'}`,
          raw_text:            filing.raw_text,
          extracted_fields:    {
            debtor_name:             filing.debtor_name,
            secured_party_name:      filing.secured_party_name,
            filing_type:             filing.filing_type,
            filing_date:             filing.filing_date,
            collateral_text:         filing.collateral_text,
            is_representative_party: filing.is_representative_party,
            representative_role:     filing.representative_role,
          },
          worker_name:              'ucc_records_worker',
          confidence_contribution:  isCurrent ? 'confirmed' : 'highly_likely',
        });
      }

      filingResults.push({
        alias_searched:  filing.debtor_name,
        filing_type:     filing.filing_type,
        filing_date:     filing.filing_date,
        debtor_name:     filing.debtor_name,
        secured_party:   filing.secured_party_name,
        is_rep_party:    filing.is_representative_party,
        rep_role:        filing.representative_role,
        collateral_text: filing.collateral_text,
        source_url:      filing.source_url,
        is_current:      isCurrent,
      });
    }

    // ── Determine completion score ────────────────────────────────────────────
    // 90 = direct scraper hit with filing(s)
    // 70 = Perplexity fallback with filing(s)
    // 50 = searched all aliases, no hits (valid negative result)
    // 0  = no search ran at all

    let completionScore = 0;
    if (deduped.length > 0 && !llmFallback) completionScore = 90;
    else if (deduped.length > 0)            completionScore = 70;
    else if (scraperUsed || llmFallback)    completionScore = 50;

    const openQuestions: string[] = [];
    if (!adapter?.enabled && !llmFallback) {
      openQuestions.push(`No adapter or LLM fallback for state ${state} — UCC search was skipped`);
    }
    if (deduped.length === 0) {
      openQuestions.push(`No UCC filings found for any of ${aliasesToSearch.length} alias variants in ${state}`);
    }

    let retryRec: string | null = null;
    if (deduped.length === 0 && !llmFallback && allow_llm_fallback) {
      retryRec = 'Scraper returned zero results — retry with Perplexity fallback enabled';
    } else if (deduped.length === 0) {
      retryRec = 'No filings found — entity worker may need to retry with more alias variants';
    }

    const output: WorkerOutput = {
      task_status:           completionScore >= 50 ? 'success' : 'failed',
      completion_score:      completionScore,
      evidence_found:        deduped.length > 0,
      structured_results:    filingResults,
      source_urls:           [...new Set(sourceUrls)],
      raw_evidence_snippets: snippets.slice(0, 10),
      open_questions:        openQuestions,
      retry_recommendation:  retryRec,
      cost_usd:              costUsd,
      llm_fallback_used:     llmFallback,
      duration_ms:           Date.now() - startMs,
    };

    // Write task record
    if (run_id) {
      await supabase.from('ucc_agent_tasks').insert({
        run_id,
        plant_code,
        agent_type:        'ucc_records_worker',
        attempt_number:    1,
        task_status:       output.task_status,
        completion_score:  output.completion_score,
        evidence_found:    output.evidence_found,
        llm_fallback_used: llmFallback,
        cost_usd:          costUsd,
        duration_ms:       output.duration_ms,
        output_json:       output,
      });
    }

    log(plant_code, `Done — ${deduped.length} filings, score=${completionScore}, llm=${llmFallback}, cost=$${costUsd.toFixed(4)}, ${output.duration_ms}ms`);
    return new Response(JSON.stringify(output), { headers: CORS });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', msg);
    const output: WorkerOutput = {
      task_status: 'failed', completion_score: 0, evidence_found: false,
      structured_results: [], source_urls: [], raw_evidence_snippets: [],
      open_questions: [msg], retry_recommendation: 'Unexpected error — check logs',
      cost_usd: 0, llm_fallback_used: false, duration_ms: 0,
    };
    return new Response(JSON.stringify(output), { status: 500, headers: CORS });
  }
});
