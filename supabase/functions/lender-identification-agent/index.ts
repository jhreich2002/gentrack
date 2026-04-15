/**
 * GenTrack — lender-identification-agent Edge Function (Deno)
 *
 * Per-plant multi-source lender discovery. Runs 4 research passes in parallel
 * and merges all results into a deduplicated candidate list with per-source
 * evidence for downstream cross-source verification.
 *
 * Sources:
 *   P1 — Perplexity sonar-pro: general financing discovery + syndicate role
 *   P2 — Perplexity sonar-pro: loan status / covenant / payoff news
 *   P3 — Perplexity sonar-pro: past-12-month financing news
 *   P4 — Gemini 2.5 Flash + Google Search grounding: independent web research pass
 *
 * POST body:
 *   { eia_plant_code, plantInfo: PlantInfo, runLogId?: string }
 *
 * Returns:
 *   { candidates: CandidateLender[], costUsd: number }
 *
 * Required secrets:
 *   PERPLEXITY_API_KEY
 *   GEMINI_API_KEY
 *   SUPABASE_URL              (auto-injected)
 *   SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const PERPLEXITY_URL   = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL = 'sonar-pro';
const GEMINI_FLASH_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_MODEL     = 'gemini-2.5-flash';

const PERPLEXITY_TIMEOUT_MS = 25_000;
const GEMINI_TIMEOUT_MS     = 30_000;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlantInfo {
  eia_plant_code:        string;
  name:                  string;
  owner:                 string | null;
  state:                 string;
  fuel_source:           string;
  nameplate_capacity_mw: number;
  cod:                   string | null;
  distress_score:        number | null;
}

export type LoanStatus     = 'active' | 'matured' | 'refinanced' | 'unknown';
export type SyndicateRole  = 'lead_arranger' | 'agent_bank' | 'participant' | 'unknown';
export type LenderRole     = 'lender' | 'tax_equity' | 'sponsor' | 'co-investor' | 'other';
export type FacilityType   = 'term_loan' | 'revolving_credit' | 'construction_loan' | 'tax_equity' |
                             'bridge_loan' | 'letter_of_credit' | 'mezzanine' | 'preferred_equity' | 'other';

export interface SourceEvidence {
  found:            boolean;
  evidence:         string;
  source_url?:      string;
  statusVote?:      LoanStatus;
  statusConfidence?: number;
}

export interface CandidateLender {
  lender_name:      string;
  role:             LenderRole;
  facility_type:    FacilityType;
  syndicate_role:   SyndicateRole;
  loan_amount_usd:  number | null;
  maturity_text:    string | null;
  notes:            string;
  sources: {
    perplexity?: SourceEvidence & { passes?: string[] };
    gemini?:     SourceEvidence;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [IDENT:${tag}] ${msg}`);
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates: Record<string, [number, number]> = {
    'sonar-pro':        [3.0,  15.0],
    'gemini-2.5-flash': [0.30,  2.50],
  };
  const [inRate, outRate] = rates[model] ?? [1.0, 5.0];
  const requestFee = model.startsWith('sonar') ? 0.005 : 0;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate + requestFee;
}

/** Normalize lender name for deduplication: lowercase, strip legal suffixes, collapse whitespace */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(n\.a\.|n\.a|inc\.|inc|llc|corp\.|corp|ltd\.|ltd|lp|l\.p\.|plc|bank|bancorp)\b/gi, '')
    .replace(/[,\.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Well-known alias map — maps normalized variants to canonical names */
const LENDER_ALIASES: Record<string, string> = {
  'jpmorgan':           'JPMorgan Chase',
  'jp morgan':          'JPMorgan Chase',
  'jpmorgan chase':     'JPMorgan Chase',
  'wells fargo':        'Wells Fargo',
  'bank of america':    'Bank of America',
  'bofa':               'Bank of America',
  'citibank':           'Citigroup',
  'citi':               'Citigroup',
  'citigroup':          'Citigroup',
  'goldman sachs':      'Goldman Sachs',
  'morgan stanley':     'Morgan Stanley',
  'us bancorp':         'US Bancorp',
  'us bank':            'US Bancorp',
  'pnc':                'PNC Financial',
  'pnc financial':      'PNC Financial',
  'truist':             'Truist Financial',
  'suntrust':           'Truist Financial',
  'td bank':            'TD Bank',
  'toronto dominion':   'TD Bank',
  'keybank':            'KeyBank',
  'regions':            'Regions Financial',
};

function canonicalizeName(raw: string): string {
  const key = normalizeName(raw);
  return LENDER_ALIASES[key] ?? raw.trim();
}

/** Fetch with timeout */
async function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Extract and parse JSON from LLM response — handles preamble text and markdown fences */
function parseJson<T>(content: string, fallback: T): T {
  // 1. Try the whole string first (ideal case)
  try { return JSON.parse(content.trim()); } catch { /* continue */ }

  // 2. Strip markdown code fences and retry
  const stripped = content
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();
  try { return JSON.parse(stripped); } catch { /* continue */ }

  // 3. Extract the first { ... } or [ ... ] block from anywhere in the string
  const objMatch = content.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch { /* continue */ } }
  const arrMatch = content.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch { /* continue */ } }

  return fallback;
}

// ── P1: Perplexity — General financing discovery + syndicate role ─────────────

async function runPerplexityP1(
  plant: PlantInfo,
  apiKey: string,
  debug = false,
): Promise<{ lenders: CandidateLender[]; costUsd: number; rawContent?: string }> {
  const capacity = Math.round(plant.nameplate_capacity_mw);
  const ownerClause = plant.owner ? `, owned by ${plant.owner}` : '';

  const systemPrompt = `You are a project finance research assistant specializing in US renewable energy and power plant financing. Your task is to identify the specific banks, lenders, and tax equity investors that financed a given power plant. Search press wire services (BusinessWire, PRNewswire, GlobeNewswire), energy trade press (PV Tech, Recharge, Wind Power Monthly, S&P Global Commodity Insights, Bloomberg NEF, Project Finance International, IJGlobal), and SEC filings. Only return confirmed named institutions explicitly linked to THIS specific plant. Never hallucinate. Return JSON only.

NAMING RULES:
- Use the full, commonly recognized institutional name (e.g. "JPMorgan Chase" not "JPMC").
- Do NOT include generic descriptions like "consortium of banks" or "multiple lenders".
- If the specific institution cannot be identified by name, omit the entry entirely.
- Do NOT include legal suffixes like "N.A.", "LLC", "Inc." unless they disambiguate.`;

  const userPrompt = `Who provided construction loans, term loans, revolving credit, and tax equity investment for "${plant.name}", a ${capacity} MW ${plant.fuel_source} power plant in ${plant.state}${ownerClause}?

Search for press releases, news articles, project finance announcements, and public filings about this plant's debt financing and equity investment. Look for financial close announcements, refinancing news, and ownership transfer deals. Note that the EIA plant name may differ from the project finance name — if you find financing for a project with the same capacity, state, and owner, include it.

Also identify: who was the LEAD ARRANGER or AGENT BANK for any syndicated credit facility?

Return valid JSON only (no markdown):
{
  "found": true,
  "lenders": [
    {
      "name": "JPMorgan Chase",
      "role": "lender",
      "facility_type": "construction_loan",
      "syndicate_role": "lead_arranger",
      "confidence": "high",
      "loan_amount_usd": 150000000,
      "maturity_text": "2031",
      "notes": "$150M construction loan, financial close April 2019. Lead arranger."
    }
  ]
}

Valid roles: lender, tax_equity, sponsor, co-investor, other
Valid facility_types: term_loan, revolving_credit, construction_loan, tax_equity, bridge_loan, letter_of_credit, mezzanine, preferred_equity, other
Valid syndicate_roles: lead_arranger, agent_bank, participant, unknown
Valid confidence: "high" = press release or article explicitly names them for this plant; "medium" = indirect mention or portfolio-level; "low" = mentioned in context but role unclear

If no financing information found: {"found": false, "lenders": []}`;

  try {
    const res = await fetchWithTimeout(PERPLEXITY_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0.1,
        return_citations: true,
        return_images: false,
      }),
    }, PERPLEXITY_TIMEOUT_MS);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const content: string = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage ?? {};
    const costUsd = estimateCost(PERPLEXITY_MODEL, usage.prompt_tokens ?? 500, usage.completion_tokens ?? 400);

    const parsed = parseJson<{ found: boolean; lenders: any[] }>(content, { found: false, lenders: [] });
    const validRoles     = ['lender', 'tax_equity', 'sponsor', 'co-investor', 'other'];
    const validTypes     = ['term_loan', 'revolving_credit', 'construction_loan', 'tax_equity', 'bridge_loan', 'letter_of_credit', 'mezzanine', 'preferred_equity', 'other'];
    const validSyndRoles = ['lead_arranger', 'agent_bank', 'participant', 'unknown'];

    const lenders: CandidateLender[] = (parsed.lenders ?? [])
      .filter((l: any) => l.name?.trim())
      .map((l: any): CandidateLender => ({
        lender_name:     canonicalizeName(l.name),
        role:            validRoles.includes(l.role) ? l.role : 'other',
        facility_type:   validTypes.includes(l.facility_type) ? l.facility_type : 'other',
        syndicate_role:  validSyndRoles.includes(l.syndicate_role) ? l.syndicate_role : 'unknown',
        loan_amount_usd: typeof l.loan_amount_usd === 'number' ? l.loan_amount_usd : null,
        maturity_text:   l.maturity_text?.trim() || null,
        notes:           l.notes?.trim().slice(0, 500) ?? '',
        sources: {
          perplexity: {
            found:    true,
            evidence: l.notes?.trim() ?? content.slice(0, 300),
            passes:   ['p1'],
          },
        },
      }));

    log('P1', `${plant.name}: ${lenders.length} candidates — $${costUsd.toFixed(4)}`);
    return { lenders, costUsd, rawContent: debug ? content : undefined };
  } catch (err) {
    log('P1-ERR', `${plant.name}: ${String(err).slice(0, 100)}`);
    return { lenders: [], costUsd: 0 };
  }
}

// ── P2: Perplexity — Loan status / covenant / payoff news ────────────────────

async function runPerplexityP2(
  plant: PlantInfo,
  apiKey: string,
): Promise<{ statusMap: Map<string, { vote: LoanStatus; confidence: number; evidence: string }>; costUsd: number }> {
  const capacity   = Math.round(plant.nameplate_capacity_mw);
  const ownerClause = plant.owner ? `, owned by ${plant.owner}` : '';
  const codYear    = plant.cod ? plant.cod.slice(0, 4) : 'unknown';

  const userPrompt = `For "${plant.name}" (${capacity} MW ${plant.fuel_source} in ${plant.state}${ownerClause}, COD ~${codYear}):

Search for:
- Refinancing announcements or new credit agreements
- Loan payoff, maturity, or debt retirement press releases
- SEC 8-K filings mentioning covenant waivers or amendments
- Any change in lenders at this plant
- Current outstanding debt status from annual reports

Return JSON only:
{
  "lenders_status": [
    {
      "lender_name": "JPMorgan Chase",
      "loan_status": "active|matured|refinanced|unknown",
      "evidence": "brief description (1-2 sentences)",
      "source_url": "URL or null",
      "confidence": 0-100
    }
  ],
  "general_notes": "any relevant financing news not tied to a specific lender"
}

If no status information found: {"lenders_status": [], "general_notes": ""}`;

  try {
    const res = await fetchWithTimeout(PERPLEXITY_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          { role: 'system', content: 'You are a project finance analyst specializing in US renewable energy debt markets. Return ONLY valid JSON with no markdown fences.' },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0.1,
        return_citations: true,
        return_images: false,
      }),
    }, PERPLEXITY_TIMEOUT_MS);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const content: string = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage ?? {};
    const costUsd = estimateCost(PERPLEXITY_MODEL, usage.prompt_tokens ?? 400, usage.completion_tokens ?? 300);

    const parsed = parseJson<{ lenders_status: any[] }>(content, { lenders_status: [] });
    const validStatuses = ['active', 'matured', 'refinanced', 'unknown'];

    const statusMap = new Map<string, { vote: LoanStatus; confidence: number; evidence: string }>();
    for (const ls of (parsed.lenders_status ?? [])) {
      if (!ls.lender_name) continue;
      const key = normalizeName(ls.lender_name);
      statusMap.set(key, {
        vote:       validStatuses.includes(ls.loan_status) ? ls.loan_status : 'unknown',
        confidence: typeof ls.confidence === 'number' ? Math.max(0, Math.min(100, ls.confidence)) : 30,
        evidence:   ls.evidence?.trim() ?? '',
      });
    }

    log('P2', `${plant.name}: ${statusMap.size} status signals — $${costUsd.toFixed(4)}`);
    return { statusMap, costUsd };
  } catch (err) {
    log('P2-ERR', `${plant.name}: ${String(err).slice(0, 100)}`);
    return { statusMap: new Map(), costUsd: 0 };
  }
}

// ── P3: Perplexity — Past-12-month financing news ────────────────────────────

async function runPerplexityP3(
  plant: PlantInfo,
  apiKey: string,
): Promise<{ lenders: CandidateLender[]; costUsd: number }> {
  const capacity   = Math.round(plant.nameplate_capacity_mw);
  const ownerClause = plant.owner ? `, owned by ${plant.owner}` : '';
  const since      = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today      = new Date().toISOString().slice(0, 10);

  const userPrompt = `Search for any financing, refinancing, or lender-related news for "${plant.name}" (${capacity} MW ${plant.fuel_source} in ${plant.state}${ownerClause}) published between ${since} and ${today}.

Focus on:
- New credit agreements or loan closings
- Refinancing deals
- Lender changes
- Covenant amendments or waivers
- Ownership changes that trigger debt renegotiation

Return JSON only:
{
  "recent_events": [
    {
      "lender_name": "name or null if not identified",
      "event_type": "new_financing|refinancing|covenant_amendment|ownership_change|other",
      "event_date": "YYYY-MM-DD or null",
      "description": "brief description",
      "source_url": "URL or null"
    }
  ]
}

If nothing found in past 12 months: {"recent_events": []}`;

  try {
    const res = await fetchWithTimeout(PERPLEXITY_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: PERPLEXITY_MODEL,
        messages: [
          { role: 'system', content: 'You are a project finance news analyst. Return ONLY valid JSON.' },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0.1,
        return_citations: true,
        return_images: false,
      }),
    }, PERPLEXITY_TIMEOUT_MS);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const content: string = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage ?? {};
    const costUsd = estimateCost(PERPLEXITY_MODEL, usage.prompt_tokens ?? 350, usage.completion_tokens ?? 250);

    const parsed = parseJson<{ recent_events: any[] }>(content, { recent_events: [] });

    const lenders: CandidateLender[] = (parsed.recent_events ?? [])
      .filter((e: any) => e.lender_name && e.lender_name !== 'null')
      .map((e: any): CandidateLender => ({
        lender_name:     canonicalizeName(e.lender_name),
        role:            'lender',
        facility_type:   e.event_type === 'new_financing' ? 'term_loan' : 'other',
        syndicate_role:  'unknown',
        loan_amount_usd: null,
        maturity_text:   null,
        notes:           e.description?.trim().slice(0, 500) ?? '',
        sources: {
          perplexity: {
            found:      true,
            evidence:   e.description?.trim() ?? '',
            source_url: e.source_url ?? undefined,
            passes:     ['p3'],
          },
        },
      }));

    log('P3', `${plant.name}: ${lenders.length} recent candidates — $${costUsd.toFixed(4)}`);
    return { lenders, costUsd };
  } catch (err) {
    log('P3-ERR', `${plant.name}: ${String(err).slice(0, 100)}`);
    return { lenders: [], costUsd: 0 };
  }
}

// ── P4: Gemini 2.5 Flash + Google Search grounding ───────────────────────────
//
// Independent second source: uses Google's full web index via grounding,
// distinct from Perplexity's index. Grounded responses cite URLs.

async function runGeminiSearch(
  plant: PlantInfo,
  apiKey: string,
): Promise<{ lenders: CandidateLender[]; costUsd: number }> {
  const capacity    = Math.round(plant.nameplate_capacity_mw);
  const ownerClause = plant.owner ? `, owned by ${plant.owner}` : '';
  const codYear     = plant.cod ? plant.cod.slice(0, 4) : 'unknown';

  const prompt = `Search for project financing details for "${plant.name}", a ${capacity} MW ${plant.fuel_source} power plant in ${plant.state}${ownerClause}${codYear !== 'unknown' ? ` (commercial operation since ${codYear})` : ''}.

Find: banks, lenders, tax equity investors, lead arrangers, and any refinancing or debt payoff news. Focus on press releases, trade press (IJGlobal, PFI, Bloomberg NEF, Recharge), and financial announcements.

Return ONLY a JSON object — no explanation, no markdown:
{
  "lenders": [
    {
      "name": "institution name",
      "role": "lender|tax_equity|sponsor|co-investor|other",
      "facility_type": "term_loan|revolving_credit|construction_loan|tax_equity|bridge_loan|letter_of_credit|other",
      "syndicate_role": "lead_arranger|agent_bank|participant|unknown",
      "loan_status": "active|matured|refinanced|unknown",
      "loan_status_confidence": 0,
      "evidence": "brief description with source",
      "source_url": "URL or null"
    }
  ]
}

Only include specifically named institutions confirmed for this plant. Return {"lenders": []} if nothing found.`;

  try {
    const res = await fetchWithTimeout(
      `${GEMINI_FLASH_URL}?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }], role: 'user' }],
          tools: [{ googleSearch: {} }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
        }),
      },
      GEMINI_TIMEOUT_MS,
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await res.json() as any;
    const usage = data.usageMetadata ?? {};
    const costUsd = estimateCost(GEMINI_MODEL, usage.promptTokenCount ?? 500, usage.candidatesTokenCount ?? 400);

    const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    // Extract a grounding URL from the first search result if available
    const groundingChunks: any[] = data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const groundingUrl: string | undefined = groundingChunks[0]?.web?.uri ?? undefined;

    const parsed = parseJson<{ lenders: any[] }>(text, { lenders: [] });
    const validRoles     = ['lender', 'tax_equity', 'sponsor', 'co-investor', 'other'];
    const validTypes     = ['term_loan', 'revolving_credit', 'construction_loan', 'tax_equity', 'bridge_loan', 'letter_of_credit', 'mezzanine', 'preferred_equity', 'other'];
    const validSyndRoles = ['lead_arranger', 'agent_bank', 'participant', 'unknown'];
    const validStatuses  = ['active', 'matured', 'refinanced', 'unknown'];

    const lenders: CandidateLender[] = (parsed.lenders ?? [])
      .filter((l: any) => l.name?.trim())
      .map((l: any): CandidateLender => ({
        lender_name:     canonicalizeName(l.name),
        role:            validRoles.includes(l.role) ? l.role : 'other',
        facility_type:   validTypes.includes(l.facility_type) ? l.facility_type : 'other',
        syndicate_role:  validSyndRoles.includes(l.syndicate_role) ? l.syndicate_role : 'unknown',
        loan_amount_usd: null,
        maturity_text:   null,
        notes:           l.evidence?.trim().slice(0, 500) ?? '',
        sources: {
          gemini: {
            found:            true,
            evidence:         l.evidence?.trim() ?? '',
            source_url:       l.source_url ?? groundingUrl,
            statusVote:       validStatuses.includes(l.loan_status) ? l.loan_status as LoanStatus : undefined,
            statusConfidence: typeof l.loan_status_confidence === 'number' ? l.loan_status_confidence : undefined,
          },
        },
      }));

    log('P4-GEMINI', `${plant.name}: ${lenders.length} candidates — $${costUsd.toFixed(4)}`);
    return { lenders, costUsd };
  } catch (err) {
    log('P4-ERR', `${plant.name}: ${String(err).slice(0, 100)}`);
    return { lenders: [], costUsd: 0 };
  }
}

// ── Candidate merging ─────────────────────────────────────────────────────────

function mergeCandidates(
  p1Lenders:   CandidateLender[],
  p2StatusMap: Map<string, { vote: LoanStatus; confidence: number; evidence: string }>,
  p3Lenders:   CandidateLender[],
  geminiLenders: CandidateLender[],
): CandidateLender[] {
  // Map keyed by normalized name + facility_type
  const merged = new Map<string, CandidateLender>();

  function dedupeKey(name: string, facilityType: string): string {
    return `${normalizeName(name)}::${facilityType}`;
  }

  function addOrMerge(candidate: CandidateLender): void {
    const key = dedupeKey(candidate.lender_name, candidate.facility_type);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, { ...candidate });
      return;
    }

    // Merge sources
    const src    = existing.sources;
    const newSrc = candidate.sources;

    if (newSrc.perplexity?.found) {
      if (src.perplexity) {
        // Accumulate evidence and passes
        src.perplexity.evidence = [src.perplexity.evidence, newSrc.perplexity.evidence]
          .filter(Boolean).join(' | ');
        src.perplexity.passes = [...new Set([...(src.perplexity.passes ?? []), ...(newSrc.perplexity.passes ?? [])])];
        // Take highest status confidence
        if ((newSrc.perplexity.statusConfidence ?? 0) > (src.perplexity.statusConfidence ?? 0)) {
          src.perplexity.statusVote       = newSrc.perplexity.statusVote;
          src.perplexity.statusConfidence = newSrc.perplexity.statusConfidence;
        }
      } else {
        src.perplexity = newSrc.perplexity;
      }
    }

    if (newSrc.gemini?.found && !src.gemini) {
      src.gemini = newSrc.gemini;
    }

    // Upgrade syndicate role if better info found
    const roleOrder = { lead_arranger: 4, agent_bank: 3, participant: 2, unknown: 1 };
    if ((roleOrder[candidate.syndicate_role] ?? 0) > (roleOrder[existing.syndicate_role] ?? 0)) {
      existing.syndicate_role = candidate.syndicate_role;
    }

    // Keep non-null loan_amount_usd and maturity_text
    if (candidate.loan_amount_usd && !existing.loan_amount_usd) {
      existing.loan_amount_usd = candidate.loan_amount_usd;
    }
    if (candidate.maturity_text && !existing.maturity_text) {
      existing.maturity_text = candidate.maturity_text;
    }

    // Accumulate notes
    if (candidate.notes && !existing.notes.includes(candidate.notes.slice(0, 50))) {
      existing.notes = [existing.notes, candidate.notes].filter(Boolean).join(' | ').slice(0, 500);
    }
  }

  // Add all sources
  for (const l of [...p1Lenders, ...p3Lenders]) addOrMerge(l);
  for (const l of geminiLenders) addOrMerge(l);

  // Inject P2 status votes into merged candidates where name matches.
  // If P2 has a lender not yet in the map, create a stub candidate from it.
  for (const [normalizedName, statusInfo] of p2StatusMap) {
    // Find any existing candidate whose key starts with this normalized name
    const existingKey = [...merged.keys()].find(k => k.startsWith(`${normalizedName}::`));

    if (existingKey) {
      const candidate = merged.get(existingKey)!;
      if (candidate.sources.perplexity) {
        candidate.sources.perplexity.statusVote       = statusInfo.vote;
        candidate.sources.perplexity.statusConfidence = statusInfo.confidence;
      } else {
        candidate.sources.perplexity = {
          found:            true,
          evidence:         statusInfo.evidence,
          statusVote:       statusInfo.vote,
          statusConfidence: statusInfo.confidence,
          passes:           ['p2'],
        };
      }
    } else {
      // P2 found a lender name not in any other source — create a stub candidate.
      // Skip if the normalized name looks like a sentence fragment rather than an institution.
      const NON_INSTITUTION_PREFIXES = /^(provided|secured|obtained|received|used|the |a |an |this |that |it |they |we )/i;
      if (NON_INSTITUTION_PREFIXES.test(normalizedName)) continue;

      const stubCandidate: CandidateLender = {
        lender_name:  canonicalizeName(normalizedName),
        role:         'lender',
        facility_type:   'other',
        syndicate_role:  'unknown',
        loan_amount_usd: null,
        maturity_text:   null,
        notes:           statusInfo.evidence.slice(0, 500),
        sources: {
          perplexity: {
            found:            true,
            evidence:         statusInfo.evidence,
            statusVote:       statusInfo.vote,
            statusConfidence: statusInfo.confidence,
            passes:           ['p2'],
          },
        },
      };
      merged.set(`${normalizedName}::other`, stubCandidate);
    }
  }

  return Array.from(merged.values());
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

  let body: { eia_plant_code: string; plantInfo: PlantInfo; runLogId?: string; debug?: boolean };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS }); }

  const { plantInfo, debug } = body;
  if (!plantInfo?.eia_plant_code) {
    return new Response(JSON.stringify({ error: 'plantInfo.eia_plant_code required' }), { status: 400, headers: CORS });
  }

  const perplexityKey = Deno.env.get('PERPLEXITY_API_KEY');
  const geminiKey     = Deno.env.get('GEMINI_API_KEY');

  if (!perplexityKey) {
    return new Response(JSON.stringify({ error: 'PERPLEXITY_API_KEY not configured' }), { status: 500, headers: CORS });
  }
  if (!geminiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), { status: 500, headers: CORS });
  }

  log('START', `${plantInfo.name} (${plantInfo.eia_plant_code})`);

  try {
    // Run P1, P2, P3 (Perplexity) and P4 (Gemini) concurrently
    const [
      [p1Result, p2Result, p3Result],
      geminiResult,
    ] = await Promise.all([
      Promise.all([
        runPerplexityP1(plantInfo, perplexityKey, debug),
        runPerplexityP2(plantInfo, perplexityKey),
        runPerplexityP3(plantInfo, perplexityKey),
      ]),
      runGeminiSearch(plantInfo, geminiKey),
    ]);

    const totalCost = p1Result.costUsd + p2Result.costUsd + p3Result.costUsd + geminiResult.costUsd;

    // Merge all candidates
    const candidates = mergeCandidates(
      p1Result.lenders,
      p2Result.statusMap,
      p3Result.lenders,
      geminiResult.lenders,
    );

    log('DONE', `${plantInfo.name}: ${candidates.length} merged candidates, $${totalCost.toFixed(4)} total`);

    return new Response(JSON.stringify({
      ok: true,
      candidates,
      costUsd: totalCost,
      sourceStats: {
        p1:       p1Result.lenders.length,
        p2Status: p2Result.statusMap.size,
        p3:       p3Result.lenders.length,
        gemini:   geminiResult.lenders.length,
      },
      ...(debug ? { _rawP1: p1Result.rawContent } : {}),
    }), { headers: CORS });

  } catch (err) {
    const msg = String(err);
    log('FATAL', `${plantInfo.name}: ${msg}`);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: CORS });
  }
});
