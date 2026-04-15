/**
 * GenTrack — lender-currency-agent Edge Function (Deno)
 *
 * Identifies whether existing plant_lenders rows represent currently active loans
 * or have matured/been refinanced. Three-stage pipeline:
 *   Stage 1: Perplexity sonar-pro  — web search for current loan status
 *   Stage 2: SEC EDGAR (optional)  — for public company owners with a known CIK
 *   Stage 3: Gemini 2.5 Flash      — synthesize all evidence → structured JSON
 *
 * Writes to:
 *   - plant_lenders (loan_status, currency_confidence, currency_reasoning,
 *                    currency_checked_at, currency_source, maturity_date,
 *                    financial_close_date, refinanced_at)
 *   - plant_news_state.lender_currency_checked_at
 *   - agent_run_log (cost + progress tracking)
 *
 * POST body:
 *   { mode, offset?, limit?, budget_limit?, run_log_id?, force_recheck? }
 *
 * Self-batching: processes `limit` ambiguous lender rows per call.
 * Budget gating: stops and marks run_log as 'budget_paused' if cost exceeds limit.
 * After last batch, chains to refresh-entity-stats.
 *
 * Required secrets:
 *   PERPLEXITY_API_KEY        — from perplexity.ai/settings/api
 *   GEMINI_API_KEY            — from Google AI Studio
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { scoreHeuristic } from './heuristics.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_BATCH_LIMIT     = 8;
const DEFAULT_BUDGET_USD      = 15.0;
const DELAY_BETWEEN_ROWS_MS   = 1500;
const RECHECK_INTERVAL_DAYS   = 90;

const PERPLEXITY_URL  = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar-pro';
const GEMINI_FLASH_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const EDGAR_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';

// ── Supabase client ───────────────────────────────────────────────────────────

function makeSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type LoanStatus = 'active' | 'matured' | 'refinanced' | 'unknown';

interface RequestBody {
  mode:          'eia_trigger' | 'backfill' | 'quarterly' | 'manual';
  offset?:       number;
  limit?:        number;
  budget_limit?: number;
  run_log_id?:   string;
  force_recheck?: boolean;
}

interface LenderRow {
  id:                   number;
  eia_plant_code:       string;
  lender_name:          string;
  facility_type:        string;
  maturity_text:        string | null;
  loan_amount_usd:      number | null;
  article_published_at: string | null;
  source:               string;
  currency_checked_at:  string | null;
  loan_status:          string | null;
  // joined from plants
  plant_name:           string;
  plant_owner:          string | null;
  plant_state:          string;
  plant_fuel:           string;
  plant_mw:             number;
  plant_cod:            string | null;
  // joined from owner_cik_map
  owner_cik:            string | null;
}

interface CostTracker {
  total_usd:             number;
  perplexity_usd:        number;
  gemini_usd:            number;
  call_count:            number;
  api_calls_jsonb:       Record<string, number>;
}

interface PerplexityStatusResult {
  current_status:       LoanStatus;
  evidence:             string;
  source_url:           string | null;
  maturity_date_found:  string | null;
  refinanced_by:        string | null;
  confidence:           number;
}

interface EdgarResult {
  found:     boolean;
  evidence:  string;
  filing_url?: string;
}

interface GeminiSynthesisResult {
  loan_status:          LoanStatus;
  currency_confidence:  number;
  currency_reasoning:   string;
  maturity_date:        string | null;
  financial_close_date: string | null;
  refinanced_at:        string | null;
  currency_source:      string;
}

// ── Cost estimation ───────────────────────────────────────────────────────────

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates: Record<string, [number, number]> = {
    'sonar-pro':       [3.0, 15.0],
    'gemini-2.5-flash': [0.30, 2.50],
  };
  const [inRate, outRate] = rates[model] ?? [1.0, 5.0];
  const requestFee = model.startsWith('sonar') ? 0.005 : 0;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate + requestFee;
}

// ── Fire-and-forget helper ────────────────────────────────────────────────────

function fireAndForget(url: string, body: Record<string, unknown>): void {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const p = fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body:    JSON.stringify(body),
  }).catch(err => console.error('Chain call failed:', err));
  EdgeRuntime.waitUntil(p);
}

// ── Load ambiguous lender rows ────────────────────────────────────────────────

async function loadAmbiguousLenders(
  sb:           ReturnType<typeof makeSupabase>,
  limit:        number,
  forceRecheck: boolean,
): Promise<{ rows: LenderRow[]; totalRemaining: number }> {
  const recheckCutoff = new Date(
    Date.now() - RECHECK_INTERVAL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  // Build the filter: unchecked OR old OR forced
  let query = sb
    .from('plant_lenders')
    .select(`
      id, eia_plant_code, lender_name, facility_type,
      maturity_text, loan_amount_usd, article_published_at, source,
      currency_checked_at, loan_status,
      plants!inner(name, owner, state, fuel_source, nameplate_capacity_mw, cod),
      owner_cik_map!left(cik)
    `)
    .in('confidence', ['high', 'medium']);

  if (!forceRecheck) {
    query = query.or(`currency_checked_at.is.null,currency_checked_at.lt.${recheckCutoff}`);
  }

  // Only process rows that heuristics classified as ambiguous (unknown) or new rows
  query = query.eq('loan_status', 'unknown');

  const countQuery = await query.select('id', { count: 'exact', head: true });
  const totalRemaining = countQuery.count ?? 0;

  const { data, error } = await query
    .order('currency_checked_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) throw new Error(`loadAmbiguousLenders: ${error.message}`);

  const rows: LenderRow[] = (data ?? []).map((r: any) => ({
    id:                   r.id,
    eia_plant_code:       r.eia_plant_code,
    lender_name:          r.lender_name,
    facility_type:        r.facility_type,
    maturity_text:        r.maturity_text,
    loan_amount_usd:      r.loan_amount_usd,
    article_published_at: r.article_published_at,
    source:               r.source,
    currency_checked_at:  r.currency_checked_at,
    loan_status:          r.loan_status,
    plant_name:           r.plants?.name ?? '',
    plant_owner:          r.plants?.owner ?? null,
    plant_state:          r.plants?.state ?? '',
    plant_fuel:           r.plants?.fuel_source ?? '',
    plant_mw:             r.plants?.nameplate_capacity_mw ?? 0,
    plant_cod:            r.plants?.cod ?? null,
    owner_cik:            r.owner_cik_map?.cik ?? null,
  }));

  return { rows, totalRemaining };
}

// ── Stage 1: Perplexity status search ────────────────────────────────────────

async function searchLoanStatus(
  row:  LenderRow,
  cost: CostTracker,
): Promise<PerplexityStatusResult> {
  const apiKey = Deno.env.get('PERPLEXITY_API_KEY');
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  const currentYear = new Date().getFullYear();
  const codYear = row.plant_cod ? row.plant_cod.slice(0, 4) : 'unknown';
  const capacity = Math.round(row.plant_mw);
  const ownerClause = row.plant_owner ? `, owned by ${row.plant_owner}` : '';
  const maturityClause = row.maturity_text ? ` (stated maturity: "${row.maturity_text}")` : '';

  const systemPrompt = `You are a project finance analyst specializing in US renewable energy debt markets. Search for current information about the active status of specific financing arrangements. Return ONLY valid JSON with no markdown fences.`;

  const userPrompt = `Is the ${row.facility_type.replace(/_/g, ' ')} provided by ${row.lender_name} for "${row.plant_name}" (${capacity} MW ${row.plant_fuel} in ${row.plant_state}${ownerClause}, COD approximately ${codYear})${maturityClause} still active as of ${currentYear}?

Search for:
- Refinancing announcements or new credit agreements replacing this facility
- Loan payoff or maturity press releases
- SEC filings or annual reports mentioning this debt as paid off or outstanding
- Any news about a change in lenders at this plant
- New project finance announcements at this plant that would indicate a refi

Return JSON only:
{
  "current_status": "active|matured|refinanced|unknown",
  "evidence": "brief description of what you found (1-2 sentences)",
  "source_url": "most relevant URL or null",
  "maturity_date_found": "YYYY-MM-DD or null",
  "refinanced_by": "name of new lender or facility if refinanced, or null",
  "confidence": 0-100
}`;

  const res = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:            PERPLEXITY_MODEL,
      messages:         [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      temperature:      0.1,
      return_citations: true,
      return_images:    false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Perplexity HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const content: string = data.choices?.[0]?.message?.content ?? '';
  const usage = data.usage ?? {};
  const callCost = estimateCost(PERPLEXITY_MODEL, usage.prompt_tokens ?? 400, usage.completion_tokens ?? 300);
  cost.total_usd += callCost;
  cost.perplexity_usd += callCost;
  cost.api_calls_jsonb['perplexity_sonar_pro'] = (cost.api_calls_jsonb['perplexity_sonar_pro'] ?? 0) + callCost;
  cost.call_count++;

  log('PERPLEXITY', `${row.lender_name} @ ${row.plant_name} — $${callCost.toFixed(4)}`);

  // Strip markdown fences
  const jsonStr = content
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    const parsed = JSON.parse(jsonStr);
    const validStatuses = ['active', 'matured', 'refinanced', 'unknown'];
    return {
      current_status:      validStatuses.includes(parsed.current_status) ? parsed.current_status : 'unknown',
      evidence:            parsed.evidence ?? '',
      source_url:          parsed.source_url ?? null,
      maturity_date_found: parsed.maturity_date_found ?? null,
      refinanced_by:       parsed.refinanced_by ?? null,
      confidence:          typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, parsed.confidence)) : 40,
    };
  } catch {
    log('PERPLEXITY', `JSON parse failed for ${row.lender_name} — treating as unknown`);
    return {
      current_status: 'unknown',
      evidence:       content.slice(0, 200),
      source_url:     null,
      maturity_date_found: null,
      refinanced_by:  null,
      confidence:     20,
    };
  }
}

// ── Stage 2: SEC EDGAR search (free, conditional on known CIK) ───────────────

async function checkEdgar(row: LenderRow): Promise<EdgarResult> {
  if (!row.owner_cik) return { found: false, evidence: 'Owner CIK not in owner_cik_map — EDGAR skipped.' };

  const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const params = new URLSearchParams({
    q:         `"${row.lender_name}" "${row.plant_name}"`,
    dateRange: 'custom',
    startdt:   threeYearsAgo,
    enddt:     today,
    forms:     '10-K,8-K,10-Q',
    entity:    row.owner_cik,
  });

  try {
    const res = await fetch(`${EDGAR_SEARCH_URL}?${params}`, {
      headers: { 'User-Agent': 'GenTrack/1.0 contact@gentrack.io' },
    });
    if (!res.ok) {
      return { found: false, evidence: `EDGAR HTTP ${res.status} — search skipped.` };
    }

    const data = await res.json() as any;
    const hits = data.hits?.hits ?? [];
    if (hits.length === 0) {
      return { found: false, evidence: `No EDGAR filings mention "${row.lender_name}" and "${row.plant_name}" in past 3 years.` };
    }

    // Summarize the first hit
    const hit = hits[0];
    const filingUrl = hit._source?.file_date
      ? `https://www.sec.gov/Archives/edgar/data/${row.owner_cik}/`
      : null;
    const snippet = hit._source?.period_of_report
      ? `EDGAR: ${hit._source.form_type} filing (${hit._source.period_of_report}) mentions lender and plant.`
      : `EDGAR: ${hits.length} filing(s) mention both lender and plant name in recent filings.`;

    return { found: true, evidence: snippet, filing_url: filingUrl ?? undefined };
  } catch (err) {
    return { found: false, evidence: `EDGAR search error: ${String(err).slice(0, 100)}` };
  }
}

// ── Stage 3: Gemini synthesis ─────────────────────────────────────────────────

async function synthesizeWithGemini(
  row:           LenderRow,
  heuristic:     { reasoning: string; confidence: number },
  perplexity:    PerplexityStatusResult,
  edgar:         EdgarResult,
  cost:          CostTracker,
): Promise<GeminiSynthesisResult> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const currentYear = new Date().getFullYear();
  const codYear = row.plant_cod ? row.plant_cod.slice(0, 4) : 'unknown';
  const capacity = Math.round(row.plant_mw);
  const ownerClause = row.plant_owner ? `Owner: ${row.plant_owner}` : 'Owner: unknown';

  const prompt = `You are a project finance analyst synthesizing evidence about whether a loan is currently active or has matured/been refinanced.

LOAN DETAILS:
  Lender: ${row.lender_name}
  Facility type: ${row.facility_type.replace(/_/g, ' ')}
  Plant: ${row.plant_name} (${capacity} MW ${row.plant_fuel}, ${row.plant_state})
  ${ownerClause}
  COD: ${codYear}
  Maturity text from news: "${row.maturity_text ?? 'none'}"
  Current year: ${currentYear}

EVIDENCE:
  Heuristic signal (confidence ${heuristic.confidence}): ${heuristic.reasoning}

  Perplexity web search (confidence ${perplexity.confidence}):
    Status found: ${perplexity.current_status}
    Evidence: ${perplexity.evidence}
    Maturity date found: ${perplexity.maturity_date_found ?? 'none'}
    Refinanced by: ${perplexity.refinanced_by ?? 'none'}

  SEC EDGAR: ${edgar.found ? edgar.evidence : edgar.evidence}

Based on all evidence above, determine the current loan status. Weight evidence as follows:
- Perplexity evidence with specific dates/amounts: highest weight
- EDGAR filing mentions: high weight
- Heuristic age-based estimates: medium weight
- Absence of evidence: low weight (do not assume matured just because nothing found)

Return ONLY valid JSON:
{
  "loan_status": "active|matured|refinanced|unknown",
  "currency_confidence": 0-100,
  "currency_reasoning": "2-3 sentences explaining the determination and evidence used",
  "maturity_date": "YYYY-MM-DD or null",
  "financial_close_date": "YYYY-MM-DD or null",
  "refinanced_at": "YYYY-MM-DD or null",
  "currency_source": "perplexity|edgar|gemini_synthesis|heuristic"
}`;

  const res = await fetch(`${GEMINI_FLASH_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents:         [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024, responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);

  const data = await res.json() as any;
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const usage = data.usageMetadata ?? {};
  const callCost = estimateCost('gemini-2.5-flash', usage.promptTokenCount ?? 600, usage.candidatesTokenCount ?? 200);
  cost.total_usd += callCost;
  cost.gemini_usd += callCost;
  cost.api_calls_jsonb['gemini_flash'] = (cost.api_calls_jsonb['gemini_flash'] ?? 0) + callCost;
  cost.call_count++;

  log('GEMINI', `${row.lender_name} @ ${row.plant_name} — $${callCost.toFixed(4)}`);

  const validStatuses = ['active', 'matured', 'refinanced', 'unknown'];
  const validSources  = ['perplexity', 'edgar', 'gemini_synthesis', 'heuristic'];

  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim());
    return {
      loan_status:          validStatuses.includes(parsed.loan_status) ? parsed.loan_status : 'unknown',
      currency_confidence:  typeof parsed.currency_confidence === 'number'
                              ? Math.max(0, Math.min(100, parsed.currency_confidence)) : 30,
      currency_reasoning:   parsed.currency_reasoning ?? 'Gemini synthesis — see individual evidence fields.',
      maturity_date:        parsed.maturity_date ?? null,
      financial_close_date: parsed.financial_close_date ?? null,
      refinanced_at:        parsed.refinanced_at ?? null,
      currency_source:      validSources.includes(parsed.currency_source) ? parsed.currency_source : 'gemini_synthesis',
    };
  } catch {
    log('GEMINI', `JSON parse failed for ${row.lender_name} — defaulting to Perplexity result`);
    return {
      loan_status:          perplexity.current_status,
      currency_confidence:  Math.round(perplexity.confidence * 0.8),
      currency_reasoning:   `Gemini synthesis parse failed. Perplexity evidence: ${perplexity.evidence}`,
      maturity_date:        perplexity.maturity_date_found,
      financial_close_date: null,
      refinanced_at:        null,
      currency_source:      'perplexity',
    };
  }
}

// ── Write result back to plant_lenders ───────────────────────────────────────

async function writeCurrencyResult(
  sb:     ReturnType<typeof makeSupabase>,
  row:    LenderRow,
  result: GeminiSynthesisResult,
): Promise<void> {
  const now = new Date().toISOString();

  const { error } = await sb
    .from('plant_lenders')
    .update({
      loan_status:          result.loan_status,
      currency_confidence:  result.currency_confidence,
      currency_reasoning:   result.currency_reasoning,
      currency_checked_at:  now,
      currency_source:      result.currency_source,
      maturity_date:        result.maturity_date ?? null,
      financial_close_date: result.financial_close_date ?? null,
      refinanced_at:        result.refinanced_at ?? null,
    })
    .eq('id', row.id);

  if (error) throw new Error(`writeCurrencyResult id=${row.id}: ${error.message}`);

  // Update per-plant state timestamp
  await sb.from('plant_news_state').upsert({
    eia_plant_code:              row.eia_plant_code,
    lender_currency_checked_at:  now,
    updated_at:                  now,
  }, { onConflict: 'eia_plant_code' });
}

// ── Update agent_run_log ──────────────────────────────────────────────────────

async function updateRunLog(
  sb:     ReturnType<typeof makeSupabase>,
  runLogId: string,
  patch:  Record<string, unknown>,
): Promise<void> {
  const { error } = await sb.from('agent_run_log').update(patch).eq('id', runLogId);
  if (error) console.error(`run_log update failed: ${error.message}`);
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  let body: RequestBody;
  try { body = await req.json(); } catch { body = { mode: 'manual' }; }

  const mode         = body.mode ?? 'manual';
  const limit        = body.limit ?? DEFAULT_BATCH_LIMIT;
  const budgetLimit  = body.budget_limit ?? DEFAULT_BUDGET_USD;
  const forceRecheck = body.force_recheck ?? false;

  const sb          = makeSupabase();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const now         = new Date().toISOString();

  log('START', `mode=${mode} limit=${limit} budget=$${budgetLimit} force=${forceRecheck}`);

  // Create or load the agent_run_log entry
  let runLogId = body.run_log_id ?? null;
  if (!runLogId) {
    const { data: logData, error: logErr } = await sb
      .from('agent_run_log')
      .insert({
        agent_type:    `lender_currency_${mode}` as const,
        status:        'running',
        budget_limit_usd: budgetLimit,
        trigger_source:   mode,
        batch_size:    limit,
      })
      .select('id')
      .single();
    if (logErr) log('WARN', `Could not create run_log: ${logErr.message}`);
    runLogId = logData?.id ?? null;
  }

  const cost: CostTracker = {
    total_usd:      0,
    perplexity_usd: 0,
    gemini_usd:     0,
    call_count:     0,
    api_calls_jsonb: {
      perplexity_sonar_pro: 0,
      gemini_flash: 0,
    },
  };

  try {
    const { rows, totalRemaining } = await loadAmbiguousLenders(sb, limit, forceRecheck);

    log('LOAD', `${rows.length} ambiguous rows loaded (${totalRemaining} total remaining)`);

    if (rows.length === 0) {
      log('DONE', 'No ambiguous lender rows to process — all classified or within recheck window.');
      if (runLogId) {
        await updateRunLog(sb, runLogId, {
          status:       'completed',
          completed_at: now,
          completion_report: { message: 'No rows to process' },
        });
      }
      return new Response(JSON.stringify({ ok: true, message: 'No rows to process' }), { headers: CORS });
    }

    let lendersUpdated = 0;
    let budgetPaused   = false;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Budget gate before each row
      if (cost.total_usd >= budgetLimit) {
        log('BUDGET', `Budget $${budgetLimit} reached at $${cost.total_usd.toFixed(4)} — pausing`);
        budgetPaused = true;
        if (runLogId) {
          await updateRunLog(sb, runLogId, {
            status:          'budget_paused',
            lenders_updated: lendersUpdated,
            plants_api:      i,
            total_cost_usd:  cost.total_usd,
            api_calls:       cost.api_calls_jsonb,
            completed_at:    now,
          });
        }
        break;
      }

      log('ROW', `[${i + 1}/${rows.length}] ${row.lender_name} @ ${row.plant_name}`);

      try {
        // Run heuristic on current row data to get context for Gemini prompt
        const heuristicResult = scoreHeuristic({
          cod:                 row.plant_cod,
          facility_type:       row.facility_type,
          maturity_text:       row.maturity_text,
          loan_amount_usd:     row.loan_amount_usd,
          article_published_at: row.article_published_at,
          source:              row.source,
        });

        // Stage 1: Perplexity web search
        const perplexityResult = await searchLoanStatus(row, cost);

        // Stage 2: EDGAR (free, only for public owners with known CIK)
        const edgarResult = await checkEdgar(row);
        if (edgarResult.found) log('EDGAR', `Evidence found for ${row.lender_name}`);

        // Stage 3: Gemini synthesis
        const synthesisResult = await synthesizeWithGemini(
          row, heuristicResult, perplexityResult, edgarResult, cost
        );

        log('RESULT', `${row.lender_name}: ${synthesisResult.loan_status} (confidence=${synthesisResult.currency_confidence})`);

        // Write result
        await writeCurrencyResult(sb, row, synthesisResult);
        lendersUpdated++;

      } catch (err) {
        log('ERROR', `${row.lender_name} @ ${row.plant_name}: ${String(err)}`);
        // Mark row as checked with unknown status so it doesn't block future runs
        await sb.from('plant_lenders').update({
          currency_checked_at: now,
          loan_status:         'unknown',
          currency_reasoning:  `Processing error: ${String(err).slice(0, 200)}`,
          currency_source:     'gemini_synthesis',
        }).eq('id', row.id);
      }

      if (i < rows.length - 1) {
        await sleep(DELAY_BETWEEN_ROWS_MS);
      }
    }

    // Self-batch: if more rows remain and not budget-paused, fire next call
    const hasMore = totalRemaining > rows.length;
    if (hasMore && !budgetPaused) {
      const remainingBudget = budgetLimit - cost.total_usd;
      log('SELF-BATCH', `More rows remain (${totalRemaining - rows.length}). Firing next batch.`);
      fireAndForget(`${supabaseUrl}/functions/v1/lender-currency-agent`, {
        mode,
        offset:        0,
        limit,
        budget_limit:  remainingBudget,
        run_log_id:    runLogId,
        force_recheck: forceRecheck,
      });
    } else if (!budgetPaused) {
      // Last batch — chain to refresh-entity-stats
      log('CHAIN', 'Last batch complete — triggering refresh-entity-stats');
      fireAndForget(`${supabaseUrl}/functions/v1/refresh-entity-stats`, {});
    }

    // Final run log update
    if (runLogId && !budgetPaused) {
      await updateRunLog(sb, runLogId, {
        status:          hasMore ? 'running' : 'completed',
        lenders_updated: lendersUpdated,
        plants_api:      rows.length,
        total_cost_usd:  cost.total_usd,
        api_calls:       cost.api_calls_jsonb,
        ...(hasMore ? {} : { completed_at: now }),
        completion_report: {
          rows_processed:   rows.length,
          lenders_updated:  lendersUpdated,
          total_cost_usd:   cost.total_usd,
          more_remaining:   hasMore,
        },
      });
    }

    log('COMPLETE', `Batch done: ${lendersUpdated} updated, $${cost.total_usd.toFixed(4)} spent`);

    return new Response(JSON.stringify({
      ok:             true,
      rows_processed: rows.length,
      lenders_updated: lendersUpdated,
      total_remaining: totalRemaining,
      has_more:        hasMore,
      budget_paused:   budgetPaused,
      cost_usd:        cost.total_usd,
    }), { headers: CORS });

  } catch (err) {
    const errMsg = String(err);
    log('FATAL', errMsg);
    if (runLogId) {
      await updateRunLog(sb, runLogId, {
        status:       'failed',
        completed_at: now,
        error_log:    errMsg,
        total_cost_usd: cost.total_usd,
        api_calls:    cost.api_calls_jsonb,
      });
    }
    return new Response(JSON.stringify({ error: errMsg }), { status: 500, headers: CORS });
  }
});
