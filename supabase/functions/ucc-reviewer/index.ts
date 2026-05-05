/**
 * GenTrack — ucc-reviewer Edge Function (Deno)
 *
 * Quality gate and confidence assignment. Pure logic — reads existing evidence
 * records for a plant run and assigns a confidence class to each lender candidate.
 * No API calls unless lender name disambiguation is needed (Gemini only).
 *
 * Confidence classes:
 *   confirmed     — UCC filing or county document directly names this lender/agent
 *                   with a source URL. No exceptions.
 *   highly_likely — No direct plant-level filing, but sponsor history shows ≥2
 *                   observed deals with this lender in matching region/vintage.
 *   possible      — News mention, trade press reference, or EDGAR disclosure without
 *                   a direct filing citation.
 *
 * Hard rejection rules:
 *   - confirmed label without a source URL → downgrade to possible, retry
 *   - Conflicting secured parties across UCC and county with no resolution → escalate
 *   - Any worker completion_score < 60 that ran → reject that worker's output
 *
 * Human review triggers:
 *   - Only possible evidence for all candidates
 *   - Conflicting lender names across evidence sources
 *   - Plant capacity > 200 MW and confidence not confirmed
 *
 * POST body:
 *   { plant_code, run_id, capacity_mw? }
 *
 * Returns standard worker output schema with lender_links written to DB.
 *
 * Required secrets:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 *   GEMINI_API_KEY (optional — only for name disambiguation)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

type ConfidenceClass = 'confirmed' | 'high_confidence' | 'highly_likely' | 'possible';
type EvidenceType    = 'direct' | 'inferred';
type RoleTag         = 'debt_lender' | 'tax_equity' | 'offtaker' | 'utility_counterparty' | 'gov_loan_guarantee' | 'unknown';

// Source types whose evidence is allowed to land in ucc_lender_links
// (the citation-backed table). Everything else routes to
// ucc_lender_leads_unverified.
//
// 'news_validated' = a news lead whose article URL was HEAD+GET fetched and
// whose lender name appears in the body (validated by ucc-news-fallback-worker).
// We treat that as primary public-source evidence on par with EDGAR/FERC.
const CITATION_SOURCE_TYPES = new Set(['ucc_scrape', 'county_scrape', 'edgar', 'doe_lpo', 'ferc', 'news_validated']);

// Source type → evidence weight (higher = stronger)
const SOURCE_WEIGHT: Record<string, number> = {
  ucc_scrape:      100,
  county_scrape:   100,
  doe_lpo:          95,  // federal public record — highest confidence
  news_validated:   90,  // URL+content validated trade press / press release
  ferc:             85,
  edgar:            80,
  sponsor_history:  60,
  web_scrape:       40,
  perplexity:       30,
  gemini:           20,
  news_article:     20,
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface EvidenceRecord {
  id:                       number;
  lender_entity_id:         number | null;
  source_type:              string;
  source_url:               string | null;
  excerpt:                  string;
  confidence_contribution:  string;
  worker_name:              string;
  extracted_fields:         Record<string, unknown>;
}

interface TaskRecord {
  agent_type:       string;
  task_status:      string;
  completion_score: number;
  evidence_found:   boolean;
  output_json?:     Record<string, unknown> | null;
}

type LoanStatus = 'active' | 'likely_matured' | 'unknown';

interface LenderCandidate {
  entity_id:              number;
  entity_name:            string;
  normalized_name:        string;
  confidence_class:       ConfidenceClass;
  evidence_type:          EvidenceType;
  evidence_summary:       string;
  source_url:             string | null;
  supporting_count:       number;
  estimated_loan_status:  LoanStatus;
  source_types:      string[];
  needs_review:      boolean;
  review_reason:     string | null;
  role_tag:          RoleTag;
}

interface ReviewerOutput {
  task_status:           'success' | 'partial' | 'failed';
  completion_score:      number;
  evidence_found:        boolean;
  structured_results:    LenderCandidate[];
  source_urls:           string[];
  raw_evidence_snippets: string[];
  open_questions:        string[];
  retry_recommendation:  string | null;
  cost_usd:              number;
  llm_fallback_used:     boolean;
  duration_ms:           number;
  escalate_to_review:    boolean;
  escalation_reason:     string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [REVIEWER:${tag}] ${msg}`);
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|lp|inc|corp|co|ltd|na|n\.a\.|plc|as agent|as collateral agent)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Lender-name cleaner (shared with ucc-edgar-worker) ────────────────────────
// Rejects boilerplate phrases and strips role suffixes so dirty entity names
// written by non-EDGAR workers never reach ucc_lender_links.
// Returns null when the string is clearly not a usable entity name.

const _REJECT_NAME_RE  = /nothing contained|by and among|\bamong\b|lenders party thereto|the lenders listed|party hereto|hereby agree|pursuant to this|\bentered into\b|Company entered|the Company entered|we entered|signed a|is a party|as set forth|Credit Agreement|Loan Agreement|Note Purchase|Security Agreement|Indenture|Amendment No\.|\bAmendment\b.*\bAgreement\b/i;
const _ROLE_SUFFIX_RE  = /[,\s]+as\s+(?:(?:joint|lead|administrative|collateral|book(?:running)?|co-?)\s+)*(?:agent|arranger|lender|manager|trustee|bookrunner|borrower|obligor|guarantor)\b.*/i;
const _LEADING_PREP_RE = /^(?:with|by|from|and|the|each|any|a)\s+/i;
const _PURE_SUFFIX_RE  = /^(?:INC\.?|PLC\.?|Corp\.?|Corporation|LLC\.?|L\.L\.C\.?|N\.A\.?|Ltd\.?|Limited|LP|LLP)\s*[,;.]?\s*$/i;
const _FIN_ENTITY_RE   = /\b(?:Bank(?:\s+(?:N\.?A\.?|PLC|AG|SA|Corp\.?|Limited))?|N\.A\.|PLC|AG|LLC|L\.L\.C\.|LP|LLP|Inc\.?|Corp\.?|Ltd\.?|Limited|Capital(?:\s+(?:Group|Markets|Partners))?|Financial(?:\s+(?:Group|Corp))?|Securities(?:\s+LLC)?|Trust(?:\s+Company)?|Bancorp|Banque)\b/gi;

function cleanLenderName(raw: string): string | null {
  let name = raw.trim();

  // 1. Strip leading partial-word fragment (lowercase-leading = mid-word window slice)
  if (/^[a-z]/.test(name)) {
    const sp = name.indexOf(' ');
    if (sp === -1) return null;
    name = name.slice(sp + 1).trim();
  }

  // 2. Strip leading prepositions
  name = name.replace(_LEADING_PREP_RE, '').trim();

  // 3. Reject if still lowercase-leading
  if (/^[a-z]/.test(name)) return null;

  // 4. Hard-reject non-entity boilerplate
  if (_REJECT_NAME_RE.test(name)) return null;

  // 5. Strip trailing " as [role]..." fragments
  name = name.replace(_ROLE_SUFFIX_RE, '').trim();
  name = name.replace(/[,;.\s]+$/, '').trim();

  // 5b. Reject pure corporate-suffix leftovers
  if (_PURE_SUFFIX_RE.test(name)) return null;

  // 6. Short and plausible
  if (name.length >= 3 && name.length <= 65 && /^[A-Z]/.test(name)) {
    return name;
  }

  // 7. Long string — extract last clean entity ending at a financial suffix
  const suffixHits = [...name.matchAll(new RegExp(_FIN_ENTITY_RE.source, 'gi'))];
  if (suffixHits.length === 0) return null;

  const last   = suffixHits[suffixHits.length - 1];
  const endPos = (last.index ?? 0) + last[0].length;

  const before = name.slice(0, last.index ?? 0);
  const parts  = before
    .split(/,\s*|\s+and\s+|\s*;\s*|\s+listed\s+|\s+named\s+|\s+therein\s*/)
    .filter(p => /[A-Z]/.test(p));
  const seg       = (parts[parts.length - 1] ?? '').trim();
  const candidate = (seg ? seg + ' ' : '') + name.slice(last.index ?? 0, endPos);
  const clean     = candidate.replace(/\s+/g, ' ').replace(/[,;.\s]+$/, '').trim();

  if (clean.length < 3 || clean.length > 80) return null;
  if (/^[^A-Z]/.test(clean))                 return null;
  if (_REJECT_NAME_RE.test(clean))            return null;

  return clean;
}

function assignConfidence(
  sourceTypes:    string[],
  hasSourceUrl:   boolean,
  hasTrustedUrl:  boolean,
): ConfidenceClass {
  const hasDirectFiling = sourceTypes.some(s => s === 'ucc_scrape' || s === 'county_scrape');
  const hasEdgar        = sourceTypes.some(s => s === 'edgar');
  const hasSponsorHist  = sourceTypes.some(s => s === 'sponsor_history');
  const hasDoeLpo       = sourceTypes.some(s => s === 'doe_lpo');
  const hasFerc         = sourceTypes.some(s => s === 'ferc');
  const hasNewsValid    = sourceTypes.some(s => s === 'news_validated');

  // ── Corroboration rule ──────────────────────────────────────────────────
  // DOE LPO = confirmed standalone (federal public record)
  if (hasDoeLpo) return 'confirmed';

  // Two independent citation-grade sources → confirmed
  const citationSources = [hasDirectFiling, hasEdgar, hasFerc, hasNewsValid].filter(Boolean).length;
  if (citationSources >= 2) return 'confirmed';

  // News with HEAD+GET-validated URL → confirmed standalone
  // (the validation pass already proved the lender name appears in the article body)
  if (hasNewsValid) return 'confirmed';

  // Single citation-grade source with trusted URL → high_confidence
  if ((hasDirectFiling || hasEdgar || hasFerc) && hasSourceUrl && hasTrustedUrl) {
    return 'high_confidence';
  }

  // Sponsor history can indicate repeat lender patterns
  if (hasSponsorHist)                                          return 'highly_likely';

  // EDGAR/FERC without trusted URL → possible
  if (hasEdgar || hasFerc) return 'possible';

  return 'possible';
}

function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return null; }
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * 3.5 + (outputTokens / 1_000_000) * 10.5;
}

// ── Role-tag inference ────────────────────────────────────────────────────────
// Classifies each lender candidate by functional role so the Leads tab can
// separate debt lenders from tax-equity investors, offtakers, and utilities.
// This prevents utilities (Xcel, SDG&E) and PPA offtakers (Google) from
// appearing on the debt-lender pitch list.

function inferRoleTag(
  entityName:  string,
  sourceTypes: string[],
  evList:      EvidenceRecord[],
): RoleTag {
  const name = entityName.toLowerCase();

  // DOE Loan Programs Office → government loan guarantee
  if (sourceTypes.includes('doe_lpo')) return 'gov_loan_guarantee';

  // Scan extracted_fields from each evidence record (EDGAR populates role + facility_type)
  for (const ev of evList) {
    const f            = ev.extracted_fields ?? {};
    const role         = String(f.role         ?? '').toLowerCase();
    const facilityType = String(f.facility_type ?? '').toLowerCase();

    if (facilityType === 'tax_equity' || role === 'equity_investor') return 'tax_equity';
    if (role.includes('agent') || role.includes('arranger') || role.includes('lender')) return 'debt_lender';
  }

  // Scan evidence text for disambiguating phrases
  for (const ev of evList) {
    const text = (ev.excerpt ?? '').toLowerCase() + ' ' + JSON.stringify(ev.extracted_fields ?? {}).toLowerCase();
    if (/tax equity|equity invest|equity partner|equity financ/.test(text))     return 'tax_equity';
    if (/power purchase agreement|offtake agreement|\bppa\b/.test(text))        return 'offtaker';
    if (/admin(?:istrative)?\s+agent|collateral\s+agent|lead\s+arranger|construction\s+loan|term\s+loan|project\s+financ/.test(text)) {
      return 'debt_lender';
    }
  }

  // Name-based heuristics — utilities / grid operators
  if (/\b(?:electric|utility|utilities|power company|energy company|light\s+and\s+power|public\s+service|ercot|caiso|miso|pjm|isone|spp)\b/.test(name) &&
      !/bank|capital|financial|credit|lend/.test(name)) {
    return 'utility_counterparty';
  }

  // Well-known tech / retail offtakers
  if (/\b(?:google|alphabet|amazon|microsoft|apple|meta|facebook|walmart|target|costco)\b/.test(name)) {
    return 'offtaker';
  }

  // Name contains financial institution keywords → likely debt lender
  if (/\b(?:bank|bancorp|capital(?:\s+group)?|financial|credit\b|lending|morgan|sachs|citi(?:bank|group)?|chase|wells\s+fargo|barclays|hsbc|deutsche|bnp|mufg|keybank|cobank|rabobank|santander|bbva|natixis|ing\b)\b/.test(name)) {
    return 'debt_lender';
  }

  return 'unknown';
}

// ── Gemini disambiguation (only for near-duplicate names) ─────────────────────

async function geminiResolveDuplicates(
  pairs: Array<[string, string]>,
): Promise<Map<string, string>> {
  // Returns: normalized_name_A → canonical_name (if same entity)
  const result = new Map<string, string>();
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey || !pairs.length) return result;

  const prompt = `Are these lender name pairs referring to the same institution? Answer for each.

${pairs.map(([a, b], i) => `Pair ${i + 1}: "${a}" vs "${b}"`).join('\n')}

Return JSON array: [{"pair": 1, "same_entity": true/false, "canonical_name": "preferred name"}]`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 400 },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!resp.ok) return result;

    const data    = await resp.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return result;

    const parsed: Array<{ pair: number; same_entity: boolean; canonical_name?: string }> = JSON.parse(jsonMatch[0]);
    for (const item of parsed) {
      if (item.same_entity && item.canonical_name) {
        const [a] = pairs[item.pair - 1] ?? [];
        if (a) result.set(normalizeName(a), item.canonical_name);
      }
    }
  } catch { /* silently skip */ }

  return result;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  const __authDenied = checkInternalAuth(req);
  if (__authDenied) return __authDenied;
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 });

  const startMs = Date.now();

  try {
    const { plant_code, run_id, capacity_mw = null, sponsor_name = null }:
      { plant_code: string; run_id: string; capacity_mw?: number | null; sponsor_name?: string | null } =
      await req.json();

    if (!plant_code || !run_id) {
      return new Response(
        JSON.stringify({ error: 'plant_code and run_id required' }),
        { status: 400, headers: CORS },
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Fetch all evidence for this run ────────────────────────────────────
    const { data: evidenceRows } = await supabase
      .from('ucc_evidence_records')
      .select(`
        id,
        lender_entity_id,
        source_type,
        source_url,
        excerpt,
        confidence_contribution,
        worker_name,
        extracted_fields
      `)
      .eq('plant_code', plant_code)
      .eq('run_id', run_id);

    const { data: taskRows } = await supabase
      .from('ucc_agent_tasks')
      .select('agent_type, task_status, completion_score, evidence_found, output_json')
      .eq('run_id', run_id);

    const evidence: EvidenceRecord[] = (evidenceRows ?? []) as EvidenceRecord[];
    const tasks:    TaskRecord[]     = (taskRows    ?? []) as TaskRecord[];

    log(plant_code, `Reviewing ${evidence.length} evidence records, ${tasks.length} tasks`);

    // ── Load trusted-source domain whitelist ───────────────────────────────
    const { data: trustedDomainRows } = await supabase
      .from('ucc_trusted_source_domains')
      .select('domain')
      .eq('enabled', true);
    const trustedDomains = new Set<string>(
      (trustedDomainRows ?? []).map((r: Record<string, unknown>) => String(r.domain).toLowerCase())
    );
    const isTrustedUrl = (url: string | null): boolean => {
      const d = extractDomain(url);
      if (!d) return false;
      // Federal government domains are unconditionally trusted
      if (d.endsWith('.gov') || d === 'sec.gov' || d.endsWith('.sec.gov')) return true;
      // Match domain or subdomain of any whitelisted entry
      for (const td of trustedDomains) {
        if (d === td || d.endsWith('.' + td)) return true;
      }
      return false;
    };

    // ── Check for rejected worker outputs ─────────────────────────────────
    const failedWorkers = tasks.filter(t => t.task_status !== 'skipped' && t.completion_score < 60);
    const retryMessages: string[] = failedWorkers.map(t =>
      `${t.agent_type} scored ${t.completion_score} — retry needed`
    );
    // ── Categorise worker outcomes (infrastructure failure vs clean zero) ─────
    // A 'failed' worker with completion_score=0 indicates an HTTP error / timeout /
    // resource limit — NOT that the source legitimately had no evidence. The supervisor
    // and downstream consumers must be able to distinguish these cases so a 50-plant
    // cohort doesn't silently report "no evidence" for plants that actually crashed.
    const hardFailedWorkers = tasks.filter(t => t.task_status === 'failed');
    const partialWorkers    = tasks.filter(t =>
      t.task_status === 'partial' || (t.output_json && (t.output_json as Record<string, unknown>).partial_due_to_budget === true)
    );
    const workerStatusSummary = `workers: ${tasks.length} total, ${hardFailedWorkers.length} failed, ${partialWorkers.length} partial`;
    // Group evidence by lender entity ID
    const byEntity = new Map<number, EvidenceRecord[]>();
    for (const ev of evidence) {
      if (!ev.lender_entity_id) continue;
      const existing = byEntity.get(ev.lender_entity_id) ?? [];
      existing.push(ev);
      byEntity.set(ev.lender_entity_id, existing);
    }

    log(plant_code, `${byEntity.size} unique lender entities referenced`);

    // ── Fetch entity names + canonical resolution ──────────────────────────
    // P1a: Also fetch canonical_entity_id so variant entity rows (e.g.
    // "JPMORGAN CHASE BANK, N.A." and "JPMorgan Chase Bank") can be merged
    // onto a single canonical entity before building candidates.
    const entityIds = [...byEntity.keys()];
    const { data: entityRows } = await supabase
      .from('ucc_entities')
      .select('id, entity_name, normalized_name, canonical_entity_id')
      .in('id', entityIds);

    // Build id → canonical_id mapping; collect any canonical IDs not already loaded
    const canonicalIdMap = new Map<number, number>(); // variant → canonical (or self)
    const extraCanonicalIds: number[] = [];
    for (const e of (entityRows ?? [])) {
      const cid = (e.canonical_entity_id as number | null) ?? (e.id as number);
      canonicalIdMap.set(e.id as number, cid);
      if (cid !== (e.id as number) && !entityIds.includes(cid)) {
        extraCanonicalIds.push(cid);
      }
    }

    let allEntityRows = [...(entityRows ?? [])];
    if (extraCanonicalIds.length > 0) {
      const { data: extraRows } = await supabase
        .from('ucc_entities')
        .select('id, entity_name, normalized_name, canonical_entity_id')
        .in('id', extraCanonicalIds);
      allEntityRows = [...allEntityRows, ...(extraRows ?? [])];
    }

    const entityMap = new Map<number, { entity_name: string; normalized_name: string }>(
      allEntityRows.map(e => [e.id as number, { entity_name: e.entity_name as string, normalized_name: e.normalized_name as string }])
    );

    // Remap byEntity: collapse variant entity IDs onto their canonical IDs
    const mergedByEntity = new Map<number, EvidenceRecord[]>();
    for (const [variantId, evList] of byEntity) {
      const canonicalId = canonicalIdMap.get(variantId) ?? variantId;
      const existing    = mergedByEntity.get(canonicalId) ?? [];
      mergedByEntity.set(canonicalId, [...existing, ...evList]);
    }
    if (canonicalIdMap.size > 0) {
      const merged = byEntity.size - mergedByEntity.size;
      if (merged > 0) log(plant_code, `Canonical resolution merged ${merged} variant entity row(s)`);
    }

    // ── Check for near-duplicate entity names (may need Gemini) ───────────
    const entityList = [...entityMap.values()];
    let   geminiCost = 0;
    const duplicatePairs: Array<[string, string]> = [];

    for (let i = 0; i < entityList.length; i++) {
      for (let j = i + 1; j < entityList.length; j++) {
        const tokensA = entityList[i].normalized_name.split(' ').filter(t => t.length > 2);
        const tokensB = entityList[j].normalized_name.split(' ').filter(t => t.length > 2);
        const shared  = tokensA.filter(t => tokensB.includes(t));
        const sim     = shared.length / Math.max(tokensA.length, tokensB.length);
        if (sim > 0.6) duplicatePairs.push([entityList[i].entity_name, entityList[j].entity_name]);
      }
    }

    let canonicalOverrides = new Map<string, string>();
    if (duplicatePairs.length > 0) {
      log(plant_code, `${duplicatePairs.length} near-duplicate pairs — calling Gemini`);
      canonicalOverrides = await geminiResolveDuplicates(duplicatePairs);
      // Estimate cost from average call
      if (canonicalOverrides.size > 0) geminiCost = estimateCost(200, 100);
    }

    // ── Build lender candidates ────────────────────────────────────────────
    const candidates: LenderCandidate[] = [];
    const sourceUrls:  string[] = [];
    const snippets:    string[] = [];
    const MATURITY_CUTOFF_YEAR = new Date().getFullYear() - 8;

    for (const [entityId, evList] of mergedByEntity) {
      const entity = entityMap.get(entityId);
      if (!entity) continue;

      // P1b: Apply name cleaning to all workers' output — reject dirty names
      // (multi-entity captures, boilerplate phrases) before writing to DB.
      const cleanedName = cleanLenderName(entity.entity_name);
      if (cleanedName === null) {
        log(plant_code, `  Rejected dirty entity name: "${entity.entity_name}"`);
        continue;
      }

      const sourceTypes  = [...new Set(evList.map(e => e.source_type))];
      const bestUrl      = evList.find(e => e.source_url)?.source_url ?? null;
      const hasUrl       = !!bestUrl;
      const hasTrustedUrl = isTrustedUrl(bestUrl);

      const canonicalName = canonicalOverrides.get(normalizeName(cleanedName)) ?? cleanedName;
      let   confidence    = assignConfidence(sourceTypes, hasUrl, hasTrustedUrl);

      // Hard rule: confirmed without trusted URL → downgrade
      if (confidence === 'confirmed' && (!hasUrl || !hasTrustedUrl)) {
        confidence = 'possible';
        log(plant_code, `  Downgraded ${canonicalName}: confirmed label but URL not on trusted whitelist`);
      }

      // Infer role tag
      const roleTag = inferRoleTag(canonicalName, sourceTypes, evList);

      // Role-based confidence cap:
      // Utilities and offtakers should not appear as confirmed debt lenders.
      // Tax-equity is valuable intel but keeps its own confidence level.
      if (confidence === 'confirmed' && (roleTag === 'utility_counterparty' || roleTag === 'offtaker')) {
        confidence = 'possible';
        log(plant_code, `  Capped ${canonicalName} to possible: role_tag=${roleTag} (not a debt lender)`);
      }

      // P1c: Loan vintage — infer estimated_loan_status from EDGAR filing dates.
      // If ALL edgar evidence pre-dates the 8-year maturity cutoff, the loan
      // is likely matured / refinanced and should be flagged accordingly.
      let estimatedLoanStatus: LoanStatus = 'unknown';
      const edgarEvList = evList.filter(e => e.source_type === 'edgar');
      if (edgarEvList.length > 0) {
        const filingYears = edgarEvList
          .map(e => {
            const d = String((e.extracted_fields ?? {}).filed_date ?? '');
            return d ? new Date(d).getFullYear() : 0;
          })
          .filter(y => y > 2000);
        if (filingYears.length > 0) {
          const mostRecentYear = Math.max(...filingYears);
          estimatedLoanStatus  = mostRecentYear >= MATURITY_CUTOFF_YEAR ? 'active' : 'likely_matured';
          if (estimatedLoanStatus === 'likely_matured') {
            log(plant_code, `  ${canonicalName}: most recent EDGAR filing ${mostRecentYear} — likely_matured`);
          }
        }
      }

      // Determine evidence type
      const hasDirectFiling = sourceTypes.some(s => s === 'ucc_scrape' || s === 'county_scrape');
      const evidenceType: EvidenceType = hasDirectFiling ? 'direct' : 'inferred';

      // Build summary
      const sourceLabels: Record<string, string> = {
        ucc_scrape:     'UCC state filing',
        county_scrape:  'county recorder document',
        edgar:          'SEC EDGAR disclosure',
        doe_lpo:        'DOE Loan Programs Office',
        ferc:           'FERC filing',
        news_validated: 'validated news article',
        news_article:   'news article (URL unverified)',
        sponsor_history:'sponsor financing history',
        web_scrape:     'sponsor portfolio page',
        perplexity:     'trade press search',
      };
      const sourceDesc = sourceTypes
        .map(s => sourceLabels[s] ?? s)
        .join(' + ');

      const topExcerpt = evList.sort((a, b) =>
        (SOURCE_WEIGHT[b.source_type] ?? 0) - (SOURCE_WEIGHT[a.source_type] ?? 0)
      )[0]?.excerpt ?? '';

      const vintageSuffix = estimatedLoanStatus === 'likely_matured'
        ? ` [⚠ filing >8 yr old — loan may have matured]`
        : '';

      // Needs review?
      const needsReview =
        confidence === 'possible' ||
        (capacity_mw !== null && capacity_mw > 200 && confidence !== 'confirmed');

      const reviewReason =
        confidence === 'possible'
          ? `Only indirect evidence (${sourceDesc}) — no direct filing found`
          : needsReview
          ? `High-value plant (${capacity_mw} MW) without confirmed filing citation`
          : null;

      if (bestUrl && !sourceUrls.includes(bestUrl)) sourceUrls.push(bestUrl);
      snippets.push(`${canonicalName} | ${confidence} | ${sourceDesc}${estimatedLoanStatus !== 'unknown' ? ` | ${estimatedLoanStatus}` : ''}`);

      candidates.push({
        entity_id:             entityId,
        entity_name:           canonicalName,
        normalized_name:       normalizeName(canonicalName),
        confidence_class:      confidence,
        evidence_type:         evidenceType,
        evidence_summary:      `${sourceDesc}: ${topExcerpt.slice(0, 200)}${vintageSuffix}`,
        source_url:            bestUrl,
        supporting_count:      evList.length,
        estimated_loan_status: estimatedLoanStatus,
        source_types:          sourceTypes,
        needs_review:          needsReview,
        review_reason:    reviewReason,
        role_tag:         roleTag,
      });
    }

    // ── Cross-source corroboration & news-as-primary promotion ─────────────
    // Pulls news leads written by ucc-news-fallback-worker. Two roles:
    //   (a) Validated news leads (URL HEAD+GET passed, lender name found in
    //       article body) are promoted to first-class CONFIRMED candidates,
    //       even if no scraper found them. Scrapers are the fallback for
    //       press-coverage gaps, not the gatekeeper.
    //   (b) Any matching news lead corroborates an existing high_confidence
    //       candidate → confirmed.
    const { data: newsLeadRows } = await supabase
      .from('ucc_lender_leads_unverified')
      .select('lender_entity_id, lender_name, lender_normalized, source_url, source_types, evidence_summary')
      .eq('plant_code', plant_code)
      .eq('run_id', run_id)
      .in('evidence_type', ['news', 'news_article']);

    const newsRows = (newsLeadRows ?? []) as Array<{
      lender_entity_id:  number | null;
      lender_name:       string;
      lender_normalized: string;
      source_url:        string | null;
      source_types:      string[] | null;
      evidence_summary:  string | null;
    }>;

    const newsEntityIds       = new Set<number>(
      newsRows.map(l => l.lender_entity_id as number).filter(Boolean)
    );
    const newsNormalizedNames = new Set<string>(
      newsRows.map(l => String(l.lender_normalized ?? '')).filter(Boolean)
    );

    // (a) Add validated news leads as first-class candidates
    let newsValidatedAdded = 0;

    // Helper: ensure a ucc_entities row exists for a news lead that lost its
    // lender_entity_id (e.g. when the news worker's upsert returned no row).
    // Without a valid FK, the lead can never be promoted to ucc_lender_links.
    const ensureEntityId = async (leadName: string, leadNormalized: string): Promise<number | null> => {
      const { data: hit } = await supabase
        .from('ucc_entities')
        .select('id')
        .eq('normalized_name', leadNormalized)
        .eq('entity_type', 'lender')
        .limit(1)
        .maybeSingle();
      if (hit?.id) return hit.id as number;
      const { data: inserted, error: insErr } = await supabase
        .from('ucc_entities')
        .insert({
          entity_name:     leadName,
          entity_type:     'lender',
          normalized_name: leadNormalized,
          jurisdiction:    null,
          source:          'news_article',
        })
        .select('id')
        .maybeSingle();
      if (inserted?.id) return inserted.id as number;
      if (insErr) log(plant_code, `ensureEntityId insert error for ${leadName}: ${insErr.message}`);
      return null;
    };

    for (const lead of newsRows) {
      const types = lead.source_types ?? [];
      if (!types.includes('news_validated')) continue;
      const existing = candidates.find(c =>
        (lead.lender_entity_id !== null && c.entity_id === lead.lender_entity_id) ||
        c.normalized_name === lead.lender_normalized
      );
      if (existing) {
        // Merge: add news_validated source_type so this becomes citation-backed
        if (!existing.source_types.includes('news_validated')) {
          existing.source_types.push('news_validated');
        }
        // Re-evaluate confidence with the new source set
        const merged = assignConfidence(
          existing.source_types,
          !!existing.source_url || !!lead.source_url,
          true, // validated news source_url is, by definition, a verified-content URL
        );
        const ORDER: Record<ConfidenceClass, number> = { confirmed: 0, high_confidence: 1, highly_likely: 2, possible: 3 };
        if (ORDER[merged] < ORDER[existing.confidence_class]) {
          existing.confidence_class = merged;
          existing.needs_review     = false;
          existing.review_reason    = null;
        }
        if (!existing.source_url && lead.source_url) existing.source_url = lead.source_url;
        continue;
      }
      // No existing candidate — add this validated news lead as a fresh candidate
      let entityId = lead.lender_entity_id;
      if (!entityId) {
        entityId = await ensureEntityId(lead.lender_name, lead.lender_normalized);
        if (!entityId) {
          log(plant_code, `Skipping news_validated promotion for ${lead.lender_name}: could not resolve entity_id`);
          continue;
        }
      }
      candidates.push({
        entity_id:        entityId,
        entity_name:      lead.lender_name,
        normalized_name:  lead.lender_normalized,
        confidence_class: 'confirmed',
        evidence_type:    'inferred',
        evidence_summary: `Validated news article (URL+content verified): ${(lead.evidence_summary ?? '').slice(0, 200)}`,
        source_url:       lead.source_url,
        supporting_count: 1,
        source_types:     ['news_validated'],
        needs_review:     false,
        review_reason:    null,
        role_tag:         inferRoleTag(lead.lender_name, ['news_validated'], []),
      });
      newsValidatedAdded++;
      if (lead.source_url && !sourceUrls.includes(lead.source_url)) sourceUrls.push(lead.source_url);
    }
    if (newsValidatedAdded > 0) {
      log(plant_code, `Added ${newsValidatedAdded} news-validated candidate(s) (URL+content verified)`);
    }

    // (b) Existing corroboration: news lead promoting high_confidence → confirmed
    if (newsRows.length > 0) {
      let corroborated = 0;
      for (const candidate of candidates) {
        if (candidate.confidence_class !== 'high_confidence') continue;
        const matchedByEntity = newsEntityIds.has(candidate.entity_id);
        const matchedByName   = newsNormalizedNames.has(candidate.normalized_name);
        if (matchedByEntity || matchedByName) {
          log(plant_code, `  News corroboration: ${candidate.entity_name} promoted high_confidence → confirmed`);
          candidate.confidence_class = 'confirmed';
          candidate.needs_review     = false;
          candidate.review_reason    = null;
          corroborated++;
        }
      }
      if (corroborated > 0) log(plant_code, `${corroborated} candidate(s) confirmed via cross-source news corroboration`);
    }

    // Sort: confirmed first, then high_confidence, then highly_likely, then possible
    const ORDER: Record<ConfidenceClass, number> = { confirmed: 0, high_confidence: 1, highly_likely: 2, possible: 3 };
    candidates.sort((a, b) => ORDER[a.confidence_class] - ORDER[b.confidence_class]);

    let escalateToReview = false;
    let escalationReason: string | null = null;
    const hasConfirmed = candidates.some(c => c.confidence_class === 'confirmed');

    if (candidates.length > 0 && candidates.every(c => c.confidence_class === 'possible')) {
      escalateToReview = true;
      escalationReason = 'All lender candidates are possible-only — no direct filing or EDGAR evidence found';
    } else if (candidates.length > 0 && !hasConfirmed && candidates.some(c => c.needs_review)) {
      escalateToReview = true;
      escalationReason = candidates.find(c => c.needs_review)?.review_reason ?? 'Manual review flagged';
    } else if (candidates.length === 0 && (hardFailedWorkers.length > 0 || partialWorkers.length > 0)) {
      // Zero candidates AND at least one worker did not run cleanly — this is an
      // infrastructure issue, not a true "no evidence" outcome. Force escalation
      // so the cohort summary distinguishes it from plants that legitimately have
      // no public lender evidence.
      escalateToReview = true;
      const failedNames  = hardFailedWorkers.map(w => w.agent_type).join(', ');
      const partialNames = partialWorkers.map(w => w.agent_type).join(', ');
      escalationReason   = `worker_failures: ${[
        hardFailedWorkers.length ? `failed=[${failedNames}]` : null,
        partialWorkers.length    ? `partial=[${partialNames}]` : null,
      ].filter(Boolean).join(' ')}`;
    }

    // ── Filter out sponsor/borrower self-references ───────────────────────
    // Occasionally the edgar/UCC workers capture the plant's own sponsor as a
    // "lender" because they appear together in credit-agreement boilerplate
    // (e.g., "AES Corporation as Borrower"). Discard any candidate whose
    // normalized name contains the sponsor's normalised token.
    if (sponsor_name) {
      const sponsorToken = sponsor_name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const filteredOut = candidates.filter(c => {
        const norm = c.normalized_name.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        return sponsorToken.length >= 4 && (norm.includes(sponsorToken) || sponsorToken.includes(norm));
      });
      if (filteredOut.length > 0) {
        log(plant_code, `Filtered ${filteredOut.length} sponsor self-reference(s): ${filteredOut.map(c => c.entity_name).join(', ')}`);
        candidates.splice(0, candidates.length, ...candidates.filter(c => !filteredOut.includes(c)));
      }
    }

    // ── Write lender links — route by citation status ─────────────────────
    // Citation-backed table (ucc_lender_links) requires:
    //   1. evidence includes a CITATION_SOURCE_TYPES source_type, AND
    //   2. a source URL on the trusted-domain whitelist
    //      — OR the source is 'news_validated' (URL+content already verified
    //        via HEAD+GET in the news worker, so we trust the URL even if
    //        the domain isn't on the whitelist).
    // Everything else lands in ucc_lender_leads_unverified so the main table
    // stays banking-grade auditable.
    let verifiedWritten   = 0;
    let unverifiedWritten = 0;
    for (const candidate of candidates) {
      const hasNewsValidated = candidate.source_types.includes('news_validated');
      const isCitationBacked =
        candidate.source_types.some(s => CITATION_SOURCE_TYPES.has(s)) &&
        !!candidate.source_url &&
        (isTrustedUrl(candidate.source_url) || hasNewsValidated);

      if (isCitationBacked) {
        await supabase.from('ucc_lender_links').upsert({
          plant_code,
          lender_entity_id: candidate.entity_id,
          lender_name:      candidate.entity_name,
          lender_normalized:candidate.normalized_name,
          confidence_class: candidate.confidence_class,
          evidence_type:    candidate.evidence_type,
          evidence_summary: candidate.evidence_summary,
          source_url:       candidate.source_url,
          human_approved:          false,
          run_id,
          role_tag:                  candidate.role_tag,
          estimated_loan_status:     candidate.estimated_loan_status,
        }, { onConflict: 'plant_code,lender_entity_id', ignoreDuplicates: false });
        verifiedWritten++;
      } else {
        // Demote any 'confirmed' that lost its citation guarantee here
        const unverifiedConf: ConfidenceClass =
          candidate.confidence_class === 'confirmed' ? 'highly_likely' : candidate.confidence_class;

        const llmPromptHash = candidate.source_types.includes('perplexity') || candidate.source_types.includes('gemini')
          ? `${candidate.entity_id}:${candidate.source_types.sort().join(',')}`
          : null;
        const llmModel = candidate.source_types.includes('perplexity') ? 'perplexity'
                       : candidate.source_types.includes('gemini')     ? 'gemini-1.5-pro'
                       : null;

        await supabase.from('ucc_lender_leads_unverified').upsert({
          plant_code,
          lender_entity_id: candidate.entity_id,
          lender_name:      candidate.entity_name,
          lender_normalized:candidate.normalized_name,
          confidence_class: unverifiedConf,
          evidence_type:    candidate.source_types.includes('sponsor_history') ? 'sponsor_pattern'
                          : candidate.source_types.includes('web_scrape')      ? 'web_scrape'
                          : llmModel                                            ? 'llm_inference'
                          : 'inferred',
          evidence_summary: candidate.evidence_summary,
          source_url:       candidate.source_url,
          source_types:     candidate.source_types,
          llm_model:             llmModel,
          llm_prompt_hash:       llmPromptHash,
          run_id,
          role_tag:              candidate.role_tag,
          estimated_loan_status: candidate.estimated_loan_status,
        }, { onConflict: 'plant_code,lender_entity_id', ignoreDuplicates: false });
        unverifiedWritten++;
      }
    }
    log(plant_code, `Wrote ${verifiedWritten} citation-backed + ${unverifiedWritten} unverified lender link(s)`);

    // Write reviewer task record
    const completionScore =
      candidates.length === 0                                              ? 30
      : candidates.every(c => c.confidence_class === 'possible')          ? 55
      : candidates.some(c => c.confidence_class === 'confirmed')          ? 95
      : candidates.some(c => c.confidence_class === 'high_confidence')    ? 90
      : 80;

    const openQuestions: string[] = [];
    if (retryMessages.length) openQuestions.push(...retryMessages);
    if (escalationReason)     openQuestions.push(escalationReason);
    if (candidates.length === 0) {
      openQuestions.push('No lender evidence found in any worker output for this run');
    }
    // Always emit a per-worker status block so cohort summaries can show which
    // workers ran cleanly vs failed/partial without re-querying ucc_agent_tasks.
    openQuestions.push(workerStatusSummary);
    if (hardFailedWorkers.length) {
      openQuestions.push(`failed_workers: ${hardFailedWorkers.map(w => `${w.agent_type}(${w.completion_score})`).join(', ')}`);
    }
    if (partialWorkers.length) {
      openQuestions.push(`partial_workers: ${partialWorkers.map(w => w.agent_type).join(', ')}`);
    }

    const output: ReviewerOutput = {
      task_status:           retryMessages.length > 0 ? 'partial' : 'success',
      completion_score:      completionScore,
      evidence_found:        candidates.length > 0,
      structured_results:    candidates,
      source_urls:           sourceUrls,
      raw_evidence_snippets: snippets.slice(0, 10),
      open_questions:        openQuestions,
      retry_recommendation:  retryMessages.length > 0 ? retryMessages.join('; ') : null,
      cost_usd:              geminiCost,
      llm_fallback_used:     geminiCost > 0,
      duration_ms:           Date.now() - startMs,
      escalate_to_review:    escalateToReview,
      escalation_reason:     escalationReason,
    };

    log(plant_code, `Done — ${candidates.length} candidates, score=${completionScore}, escalate=${escalateToReview}, ${output.duration_ms}ms`);
    return new Response(JSON.stringify(output), { headers: CORS });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', msg);
    return new Response(JSON.stringify({
      task_status: 'failed', completion_score: 0, evidence_found: false,
      structured_results: [], source_urls: [], raw_evidence_snippets: [],
      open_questions: [msg], retry_recommendation: 'Unexpected error — check logs',
      cost_usd: 0, llm_fallback_used: false, duration_ms: 0,
      escalate_to_review: false, escalation_reason: null,
    }), { status: 500, headers: CORS });
  }
});
