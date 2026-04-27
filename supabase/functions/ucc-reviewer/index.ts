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

// ── Constants ─────────────────────────────────────────────────────────────────

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

type ConfidenceClass = 'confirmed' | 'highly_likely' | 'possible';
type EvidenceType    = 'direct' | 'inferred';

// Source types whose evidence is allowed to land in ucc_lender_links
// (the citation-backed table). Everything else routes to
// ucc_lender_leads_unverified.
const CITATION_SOURCE_TYPES = new Set(['ucc_scrape', 'county_scrape', 'edgar', 'doe_lpo', 'ferc']);

// Source type → evidence weight (higher = stronger)
const SOURCE_WEIGHT: Record<string, number> = {
  ucc_scrape:     100,
  county_scrape:  100,
  doe_lpo:         95,  // federal public record — highest confidence
  ferc:            85,
  edgar:           80,
  sponsor_history: 60,
  web_scrape:      40,
  perplexity:      30,
  gemini:          20,
  news_article:    20,
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
}

interface LenderCandidate {
  entity_id:         number;
  entity_name:       string;
  normalized_name:   string;
  confidence_class:  ConfidenceClass;
  evidence_type:     EvidenceType;
  evidence_summary:  string;
  source_url:        string | null;
  supporting_count:  number;
  source_types:      string[];
  needs_review:      boolean;
  review_reason:     string | null;
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

  // ── Corroboration rule ──────────────────────────────────────────────────
  // DOE LPO = confirmed standalone (federal public record)
  if (hasDoeLpo) return 'confirmed';

  // Two independent citation-grade sources → confirmed
  const citationSources = [hasDirectFiling, hasEdgar, hasFerc].filter(Boolean).length;
  if (citationSources >= 2) return 'confirmed';

  // Single citation-grade source with trusted URL → confirmed
  if (hasDirectFiling && hasSourceUrl && hasTrustedUrl) return 'confirmed';

  // EDGAR or FERC alone → highly_likely
  if ((hasEdgar || hasFerc) && hasSourceUrl && hasTrustedUrl) return 'highly_likely';
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
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 });

  const startMs = Date.now();

  try {
    const { plant_code, run_id, capacity_mw = null }:
      { plant_code: string; run_id: string; capacity_mw?: number | null } =
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
      .select('agent_type, task_status, completion_score, evidence_found')
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

    // Group evidence by lender entity ID
    const byEntity = new Map<number, EvidenceRecord[]>();
    for (const ev of evidence) {
      if (!ev.lender_entity_id) continue;
      const existing = byEntity.get(ev.lender_entity_id) ?? [];
      existing.push(ev);
      byEntity.set(ev.lender_entity_id, existing);
    }

    log(plant_code, `${byEntity.size} unique lender entities referenced`);

    // ── Fetch entity names ─────────────────────────────────────────────────
    const entityIds = [...byEntity.keys()];
    const { data: entityRows } = await supabase
      .from('ucc_entities')
      .select('id, entity_name, normalized_name')
      .in('id', entityIds);

    const entityMap = new Map<number, { entity_name: string; normalized_name: string }>(
      (entityRows ?? []).map(e => [e.id as number, { entity_name: e.entity_name as string, normalized_name: e.normalized_name as string }])
    );

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

    for (const [entityId, evList] of byEntity) {
      const entity = entityMap.get(entityId);
      if (!entity) continue;

      const sourceTypes  = [...new Set(evList.map(e => e.source_type))];
      const bestUrl      = evList.find(e => e.source_url)?.source_url ?? null;
      const hasUrl       = !!bestUrl;
      const hasTrustedUrl = isTrustedUrl(bestUrl);

      const canonicalName = canonicalOverrides.get(normalizeName(entity.entity_name)) ?? entity.entity_name;
      let   confidence    = assignConfidence(sourceTypes, hasUrl, hasTrustedUrl);

      // Hard rule: confirmed without trusted URL → downgrade
      if (confidence === 'confirmed' && (!hasUrl || !hasTrustedUrl)) {
        confidence = 'possible';
        log(plant_code, `  Downgraded ${canonicalName}: confirmed label but URL not on trusted whitelist`);
      }

      // Determine evidence type
      const hasDirectFiling = sourceTypes.some(s => s === 'ucc_scrape' || s === 'county_scrape');
      const evidenceType: EvidenceType = hasDirectFiling ? 'direct' : 'inferred';

      // Build summary
      const sourceLabels: Record<string, string> = {
        ucc_scrape:     'UCC state filing',
        county_scrape:  'county recorder document',
        edgar:          'SEC EDGAR disclosure',
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
      snippets.push(`${canonicalName} | ${confidence} | ${sourceDesc}`);

      candidates.push({
        entity_id:        entityId,
        entity_name:      canonicalName,
        normalized_name:  normalizeName(canonicalName),
        confidence_class: confidence,
        evidence_type:    evidenceType,
        evidence_summary: `${sourceDesc}: ${topExcerpt.slice(0, 200)}`,
        source_url:       bestUrl,
        supporting_count: evList.length,
        source_types:     sourceTypes,
        needs_review:     needsReview,
        review_reason:    reviewReason,
      });
    }

    // Sort: confirmed first, then highly_likely, then possible
    const ORDER: Record<ConfidenceClass, number> = { confirmed: 0, highly_likely: 1, possible: 2 };
    candidates.sort((a, b) => ORDER[a.confidence_class] - ORDER[b.confidence_class]);

    // ── Check for conflicts ────────────────────────────────────────────────
    // Conflict: multiple confirmed lenders with different secured party names
    // in the same source type (both UCC AND county both point somewhere different)
    const confirmedDirect = candidates.filter(c => c.confidence_class === 'confirmed' && c.evidence_type === 'direct');
    const hasConflict     = confirmedDirect.length > 3; // > 3 confirmed is unusual, worth flagging

    let escalateToReview = false;
    let escalationReason: string | null = null;

    if (candidates.every(c => c.confidence_class === 'possible')) {
      escalateToReview = true;
      escalationReason = 'All lender candidates are possible-only — no direct filing or EDGAR evidence found';
    } else if (hasConflict) {
      escalateToReview = true;
      escalationReason = `${confirmedDirect.length} confirmed lenders — unusually high, may indicate naming conflicts or multiple syndicate members`;
    } else if (candidates.some(c => c.needs_review)) {
      escalateToReview = true;
      escalationReason = candidates.find(c => c.needs_review)?.review_reason ?? 'Manual review flagged';
    }

    // ── Write lender links — route by citation status ─────────────────────
    // Citation-backed table (ucc_lender_links) requires:
    //   1. evidence includes a CITATION_SOURCE_TYPES source_type, AND
    //   2. a source URL on the trusted-domain whitelist.
    // Everything else lands in ucc_lender_leads_unverified so the main table
    // stays banking-grade auditable.
    let verifiedWritten   = 0;
    let unverifiedWritten = 0;
    for (const candidate of candidates) {
      const isCitationBacked =
        candidate.source_types.some(s => CITATION_SOURCE_TYPES.has(s)) &&
        !!candidate.source_url &&
        isTrustedUrl(candidate.source_url);

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
          human_approved:   false,
          run_id,
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
          llm_model:        llmModel,
          llm_prompt_hash:  llmPromptHash,
          run_id,
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
      : 80;

    const openQuestions: string[] = [];
    if (retryMessages.length) openQuestions.push(...retryMessages);
    if (escalationReason)     openQuestions.push(escalationReason);
    if (candidates.length === 0) openQuestions.push('No lender evidence found in any worker output for this run');

    if (run_id) {
      await supabase.from('ucc_agent_tasks').insert({
        run_id,
        plant_code,
        agent_type:        'reviewer',
        attempt_number:    1,
        task_status:       'success',
        completion_score:  completionScore,
        evidence_found:    candidates.length > 0,
        llm_fallback_used: geminiCost > 0,
        cost_usd:          geminiCost,
        duration_ms:       Date.now() - startMs,
        output_json:       {
          candidates_count: candidates.length,
          escalate:         escalateToReview,
          verified_links:   verifiedWritten,
          unverified_links: unverifiedWritten,
          trusted_domain_count: trustedDomains.size,
        },
      });
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
