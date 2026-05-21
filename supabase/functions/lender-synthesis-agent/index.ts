/**
 * GenTrack — lender-synthesis-agent (v4) Edge Function (Deno)
 *
 * Reasoning agent that takes all raw claims from a research session and
 * produces enriched, de-duplicated, time-aware lender claims.
 *
 * Responsibilities:
 *   1. Drop non-debt-lender entities (utilities, offtakers, tax equity, gov).
 *   2. Assign loan_status (active|matured|refinanced|unknown) using evidence dates.
 *   3. Boost confidence when ≥2 sources independently name the same lender.
 *   4. Clean up sentence-fragment names from EDGAR snippet extraction.
 *   5. Assign role_tag: debt_lender|admin_agent|collateral_agent|syndicate_member.
 *
 * Uses Gemini 2.5 Flash (reasoning model) for a single structured analysis call.
 * Input claims are pre-filtered to top-N by raw confidence to control cost.
 *
 * POST body:
 *   { session_id, plant_id (string), plant_name, cod_year?, state?, budget_usd? }
 *
 * Response:
 *   { ok, claims_enriched, claims_dropped, cost_usd }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const TIMEOUT_MS = 45_000;

// Cost: Gemini 2.5 Flash ~$0.075/1M input tokens, ~$0.30/1M output tokens
// Typical synthesis call: ~4K input + ~1K output → ~$0.0006/call
const COST_PER_SYNTHESIS_CALL = 0.001;

// Cap claims sent to Gemini to control prompt size
const MAX_CLAIMS_TO_SYNTHESIZE = 40;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [SYNTHESIS:${tag}] ${msg}`);
}

// ── Gemini call ───────────────────────────────────────────────────────────────

interface ClaimInput {
  id:              number;
  source_agent:    string;
  raw_lender_name: string;
  quote:           string | null;
  source_url:      string | null;
  source_type:     string;
  evidence_date:   string | null;
  confidence:      number;
}

interface SynthesisResult {
  claim_id:       number;
  action:         'keep' | 'drop';
  role_tag:       'debt_lender' | 'admin_agent' | 'collateral_agent' | 'syndicate_member' | 'unknown';
  loan_status:    'active' | 'matured' | 'refinanced' | 'unknown';
  confidence:     number;   // 0.0 – 1.0
  dropped_reason: string | null;
  clean_name:     string;   // cleaned/normalised form of raw_lender_name
}

async function runSynthesis(
  claims:    ClaimInput[],
  plantName: string,
  codYear:   number | null,
  state:     string | null,
  apiKey:    string,
): Promise<SynthesisResult[]> {
  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = `You are an expert financial analyst specialising in renewable energy project finance. Today's date is ${today}.

Your task: analyse the following raw lender candidates extracted from public sources for the plant "${plantName}" (${state ?? 'US'}${codYear ? `, COD ~${codYear}` : ''}).

For EACH claim, decide:

1. **action**: "keep" if this entity is a DEBT lender (bank, credit institution, or agent acting on behalf of lenders). "drop" otherwise.
   DROP if: the entity is a utility (e.g. Xcel Energy, SDG&E, NRG), an offtaker (e.g. Google, Apple), a tax equity investor (e.g. Raymond James, Monarch Private Capital, US Bancorp Community Development), a government agency that is NOT the DOE LPO acting as direct lender, a solar panel manufacturer, or any non-financial entity.

2. **role_tag**: one of: debt_lender | admin_agent | collateral_agent | syndicate_member | unknown

3. **loan_status**: 
   - "active": evidence suggests loan is currently outstanding
   - "matured": evidence indicates loan has been paid off / the tenor has expired (standard project finance loans run 15-25 years from COD)
   - "refinanced": later evidence explicitly says the original lender was replaced
   - "unknown": insufficient information to determine

   Use evidence_date and today's date to reason about whether a loan is likely still active. A construction loan from 2008 is almost certainly matured by now. A term loan from 2018 on a 20-year project is likely still active.

4. **confidence**: 0.0-1.0. Boost if ≥2 different source_agents name the same lender. Penalise if the quote does not clearly name the entity as a lender for this specific plant.
   **IMPORTANT**: Claims with source_type "edgar_filing" come from SEC regulatory filings (10-K/8-K credit agreement exhibits) — these are primary documentary evidence. If the quote contains credit-agreement language (e.g. "credit agreement", "construction loan", "term loan", "project lender", "as agent", "as arranger") assign confidence >= 0.75. If the plant name is also clearly associated with the financing context in the quote, assign >= 0.85.

5. **clean_name**: fix sentence-fragment names (e.g. "ocumentation Agents and Syndication Agents" → drop; "with Fortis Capital Corp" → "Fortis Capital Corp"). If the raw name looks like a truncated mid-sentence fragment, clean it or mark for drop.

6. **dropped_reason**: brief explanation when action is "drop".

Return ONLY a valid JSON array — no markdown, no prose:
[{"claim_id":N,"action":"keep|drop","role_tag":"...","loan_status":"...","confidence":0.0,"dropped_reason":null,"clean_name":"..."},...]`;

  const claimsJson = JSON.stringify(
    claims.map(c => ({
      claim_id:       c.id,
      source_agent:   c.source_agent,
      raw_lender_name: c.raw_lender_name,
      quote:          (c.quote ?? '').slice(0, 200),
      source_type:    c.source_type,
      evidence_date:  c.evidence_date,
      raw_confidence: c.confidence,
    })),
    null, 2,
  );

  const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents:           [{ role: 'user', parts: [{ text: claimsJson }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature:      0.1,   // low temperature for structured factual task
        maxOutputTokens:  4096,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';

  try {
    return JSON.parse(text) as SynthesisResult[];
  } catch {
    // Try to extract JSON array from response if it has prose wrapper
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]) as SynthesisResult[];
    throw new Error('Gemini response was not valid JSON');
  }
}

// ── Quote sanitization ────────────────────────────────────────────────────────
// EDGAR snippets often start mid-sentence and contain HTML entities (&#160; etc.)
// This finds the first sentence that contains a lender-evidence keyword and
// returns a clean, readable string (max 350 chars). Falls back to the whole
// strip-entity string if no sentence qualifies.
function sanitizeQuote(raw: string): string {
  // Strip HTML entities: &#160; → space, &amp; → &, &nbsp; → space, etc.
  const stripped = raw
    .replace(/&#\d+;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Split into sentences and find first with a lender keyword
  const LENDER_KEYWORDS = /\b(agent|arranger|lender|loan|facility|underwriter|financing|financed|credit|debt|equity|tranche|revolver|commitment|borrower|collateral|guaranty)\b/i;
  const sentences = stripped.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const best = sentences.find(s => LENDER_KEYWORDS.test(s)) ?? stripped;

  return best.slice(0, 350);
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const denied = checkInternalAuth(req);
  if (denied) return denied;

  let body: {
    session_id:   string;
    plant_id:     string;
    plant_name:   string;
    cod_year?:    number;
    state?:       string;
    budget_usd?:  number;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: CORS });
  }

  const { session_id, plant_id, plant_name, cod_year = null, state = null, budget_usd = 0.05 } = body;
  if (!session_id || !plant_id || !plant_name) {
    return new Response(JSON.stringify({ error: 'session_id, plant_id and plant_name required' }), { status: 400, headers: CORS });
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), { status: 500, headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Fetch all raw claims for this session
  const { data: rawClaims, error: fetchErr } = await supabase
    .from('lender_research_claims')
    .select('id, source_agent, raw_lender_name, quote, source_url, source_type, evidence_date, confidence')
    .eq('session_id', session_id)
    .is('dropped_reason', null)       // not yet processed
    .order('confidence', { ascending: false })
    .limit(MAX_CLAIMS_TO_SYNTHESIZE);

  if (fetchErr) {
    return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500, headers: CORS });
  }

  if (!rawClaims || rawClaims.length === 0) {
    log('INFO', `No claims to synthesise for session ${session_id}`);
    return new Response(
      JSON.stringify({ ok: true, claims_enriched: 0, claims_dropped: 0, cost_usd: 0 }),
      { status: 200, headers: CORS },
    );
  }

  log('INFO', `Synthesising ${rawClaims.length} claims for "${plant_name}"`);

  let synthResults: SynthesisResult[] = [];
  let costUsd = 0;

  try {
    synthResults = await runSynthesis(rawClaims as ClaimInput[], plant_name, cod_year, state, geminiKey);
    costUsd += COST_PER_SYNTHESIS_CALL;
  } catch (e) {
    log('GEMINI_ERR', String(e));
    return new Response(
      JSON.stringify({ error: `Synthesis failed: ${String(e)}`, cost_usd: costUsd }),
      { status: 500, headers: CORS },
    );
  }

  log('INFO', `Synthesis returned ${synthResults.length} results`);

  // ── Apply results to DB ────────────────────────────────────────────────────

  let enriched = 0;
  let dropped  = 0;

  for (const result of synthResults) {
    // ── Quote sanitization ────────────────────────────────────────────────
    // The raw quote is an EDGAR snippet that often starts mid-sentence and
    // contains HTML entities. Clean it before storing so the reviewer UI
    // and confidence gate both see legible text.
    const rawClaim   = (rawClaims as ClaimInput[]).find(c => c.id === result.claim_id);
    const cleanQuote = rawClaim?.quote
      ? sanitizeQuote(rawClaim.quote)
      : rawClaim?.quote ?? null;

    const update: Record<string, unknown> = {
      role_tag:        result.role_tag,
      loan_status:     result.loan_status,
      confidence:      result.confidence,
      raw_lender_name: result.clean_name,  // overwrite with cleaned name
      quote:           cleanQuote,
    };

    if (result.action === 'drop') {
      update.dropped_reason = result.dropped_reason ?? 'dropped_by_synthesis';
      dropped++;
    } else {
      enriched++;
    }

    await supabase
      .from('lender_research_claims')
      .update(update)
      .eq('id', result.claim_id);
  }

  // ── Cross-source corroboration boost ──────────────────────────────────────
  // After synthesis, find lenders named by ≥2 different source_agents and
  // boost confidence by 0.15 (capped at 0.95).
  const { data: surviving } = await supabase
    .from('lender_research_claims')
    .select('id, raw_lender_name, source_agent, confidence')
    .eq('session_id', session_id)
    .is('dropped_reason', null);

  if (surviving && surviving.length > 0) {
    const nameAgentMap = new Map<string, Set<string>>();
    for (const c of surviving as Array<{ id: number; raw_lender_name: string; source_agent: string; confidence: number }>) {
      const key = c.raw_lender_name.toLowerCase();
      if (!nameAgentMap.has(key)) nameAgentMap.set(key, new Set());
      nameAgentMap.get(key)!.add(c.source_agent);
    }

    for (const c of surviving as Array<{ id: number; raw_lender_name: string; source_agent: string; confidence: number }>) {
      const key        = c.raw_lender_name.toLowerCase();
      const agentCount = nameAgentMap.get(key)?.size ?? 1;
      if (agentCount >= 2) {
        const boosted = Math.min(0.95, c.confidence + 0.15);
        await supabase
          .from('lender_research_claims')
          .update({ confidence: boosted })
          .eq('id', c.id);
      }
    }
  }

  log('DONE', `enriched=${enriched} dropped=${dropped} cost=$${costUsd.toFixed(4)}`);

  return new Response(
    JSON.stringify({ ok: true, claims_enriched: enriched, claims_dropped: dropped, cost_usd: costUsd }),
    { status: 200, headers: CORS },
  );
});
