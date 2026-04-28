/**
 * GenTrack — lender-verification-agent Edge Function (Deno)
 *
 * Takes candidate lenders from the identification agent and applies
 * cross-source consensus to determine confidence and loan status.
 * Also computes pitch urgency and classifies the consulting pitch angle.
 *
 * Steps:
 *   A — Source count → confidence (2=high, 1=medium)
 *   B — Loan status resolution (heuristics + consensus + Gemini fallback)
 *   C — Pitch urgency score (maturity proximity × distress factor)
 *   D — Pitch angle classification
 *   E — Upsert to plant_lenders (UPDATE existing, INSERT new)
 *   F — Write per-source evidence to plant_lender_evidence
 *   G — Mark plant_news_state as ingested
 *
 * POST body:
 *   { eia_plant_code, plantInfo: PlantInfo, candidates: CandidateLender[], runLogId?: string }
 *
 * Returns:
 *   { ok: true, upserted: number, costUsd: number }
 *
 * Required secrets:
 *   GEMINI_API_KEY
 *   SUPABASE_URL              (auto-injected)
 *   SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { scoreHeuristic } from '../lender-currency-agent/heuristics.ts';
import type { CandidateLender, PlantInfo, LoanStatus, SyndicateRole } from '../lender-identification-agent/index.ts';
import { checkInternalAuth } from '../_shared/auth.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const GEMINI_FLASH_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

// ── Supabase client ───────────────────────────────────────────────────────────

function makeSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [VERIF:${tag}] ${msg}`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Confidence    = 'high' | 'medium' | 'low';
type PitchAngle    = 'interconnection_advisory' | 'asset_management' | 'merchant_risk' | 'refinancing_advisory' | 'general_exposure';

interface VerificationResult {
  confidence:           Confidence;
  source_count:         number;
  verification_sources: string[];
  loan_status:          LoanStatus;
  currency_confidence:  number;
  currency_reasoning:   string;
  currency_source:      string;
  maturity_date:        string | null;
  financial_close_date: string | null;
  pitch_urgency_score:  number;
  pitch_angle:          PitchAngle;
  pitch_angle_reasoning: string;
  syndicate_role:       SyndicateRole;
}

// ── Step A: Cross-source confidence ──────────────────────────────────────────

function computeConfidence(candidate: CandidateLender): {
  confidence: Confidence;
  source_count: number;
  verification_sources: string[];
} {
  const sources: string[] = [];

  // Perplexity (P1+P2+P3) counts as ONE source; Gemini counts as a second independent source
  if (candidate.sources.perplexity?.found) sources.push('perplexity');
  if (candidate.sources.gemini?.found)     sources.push('gemini');

  const count = sources.length;
  const confidence: Confidence = count >= 2 ? 'high' : count >= 1 ? 'medium' : 'low';

  return { confidence, source_count: count, verification_sources: sources };
}

// ── Step B: Loan status resolution ───────────────────────────────────────────

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates: Record<string, [number, number]> = {
    'gemini-2.5-flash': [0.30, 2.50],
  };
  const [inRate, outRate] = rates[model] ?? [1.0, 5.0];
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

async function synthesizeWithGemini(
  candidate:   CandidateLender,
  plant:       PlantInfo,
  heuristic:   { reasoning: string; confidence: number; loan_status: LoanStatus },
  apiKey:      string,
): Promise<{ loan_status: LoanStatus; confidence: number; reasoning: string; maturity_date: string | null; financial_close_date: string | null; costUsd: number }> {
  const codYear   = plant.cod ? plant.cod.slice(0, 4) : 'unknown';
  const capacity  = Math.round(plant.nameplate_capacity_mw);
  const ownerText = plant.owner ? `Owner: ${plant.owner}` : 'Owner: unknown';
  const currentYear = new Date().getFullYear();

  const evidenceLines: string[] = [];

  if (candidate.sources.perplexity?.found) {
    evidenceLines.push(`Perplexity web search: ${candidate.sources.perplexity.evidence}`);
    if (candidate.sources.perplexity.statusVote) {
      evidenceLines.push(`  → status vote: ${candidate.sources.perplexity.statusVote} (confidence: ${candidate.sources.perplexity.statusConfidence ?? '?'})`);
    }
  }
  if (candidate.sources.gemini?.found) {
    evidenceLines.push(`Gemini web search: ${candidate.sources.gemini.evidence}`);
    if (candidate.sources.gemini.statusVote) {
      evidenceLines.push(`  → status vote: ${candidate.sources.gemini.statusVote} (confidence: ${candidate.sources.gemini.statusConfidence ?? '?'})`);
    }
  }
  evidenceLines.push(`Heuristic (confidence ${heuristic.confidence}): ${heuristic.reasoning}`);

  const prompt = `You are a project finance analyst determining whether a specific loan is currently active or has matured/been refinanced.

LOAN:
  Lender: ${candidate.lender_name}
  Facility: ${candidate.facility_type.replace(/_/g, ' ')}
  Plant: ${plant.name} (${capacity} MW ${plant.fuel_source}, ${plant.state})
  ${ownerText}
  COD: ~${codYear}
  Maturity text: "${candidate.maturity_text ?? 'unknown'}"
  Current year: ${currentYear}

EVIDENCE:
${evidenceLines.map(l => `  ${l}`).join('\n')}

Return ONLY valid JSON:
{
  "loan_status": "active|matured|refinanced|unknown",
  "currency_confidence": 0-100,
  "currency_reasoning": "2-3 sentences",
  "maturity_date": "YYYY-MM-DD or null",
  "financial_close_date": "YYYY-MM-DD or null"
}`;

  try {
    const res = await fetch(`${GEMINI_FLASH_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512, responseMimeType: 'application/json' },
      }),
    });

    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json() as any;
    const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const usage = data.usageMetadata ?? {};
    const costUsd = estimateCost('gemini-2.5-flash', usage.promptTokenCount ?? 500, usage.candidatesTokenCount ?? 150);

    const validStatuses = ['active', 'matured', 'refinanced', 'unknown'];
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim());

    return {
      loan_status:          validStatuses.includes(parsed.loan_status) ? parsed.loan_status : 'unknown',
      confidence:           typeof parsed.currency_confidence === 'number'
                              ? Math.max(0, Math.min(100, parsed.currency_confidence)) : 30,
      reasoning:            parsed.currency_reasoning ?? 'Gemini synthesis.',
      maturity_date:        parsed.maturity_date ?? null,
      financial_close_date: parsed.financial_close_date ?? null,
      costUsd,
    };
  } catch {
    return {
      loan_status:          heuristic.loan_status,
      confidence:           heuristic.confidence,
      reasoning:            `Gemini failed — using heuristic: ${heuristic.reasoning}`,
      maturity_date:        null,
      financial_close_date: null,
      costUsd:              0,
    };
  }
}

function resolveLoansStatus(
  candidate: CandidateLender,
  heuristic: ReturnType<typeof scoreHeuristic>,
): { loan_status: LoanStatus; currency_confidence: number; currency_source: string; currency_reasoning: string; maturity_date: string | null; needsGemini: boolean } {
  // Collect status votes from each source
  interface Vote { status: LoanStatus; confidence: number; source: string }
  const votes: Vote[] = [];

  // Heuristic (only count if not ambiguous)
  if (!heuristic.is_ambiguous) {
    votes.push({ status: heuristic.loan_status, confidence: heuristic.confidence, source: 'heuristic' });
  }

  // Perplexity (P1+P2+P3 aggregate vote)
  if (candidate.sources.perplexity?.statusVote && candidate.sources.perplexity.statusVote !== 'unknown') {
    votes.push({
      status:     candidate.sources.perplexity.statusVote,
      confidence: candidate.sources.perplexity.statusConfidence ?? 40,
      source:     'perplexity',
    });
  }

  // Gemini web search vote
  if (candidate.sources.gemini?.statusVote && candidate.sources.gemini.statusVote !== 'unknown') {
    votes.push({
      status:     candidate.sources.gemini.statusVote,
      confidence: candidate.sources.gemini.statusConfidence ?? 40,
      source:     'gemini',
    });
  }

  if (votes.length === 0) {
    return {
      loan_status:          'unknown',
      currency_confidence:  20,
      currency_source:      'heuristic',
      currency_reasoning:   heuristic.reasoning,
      maturity_date:        null,
      needsGemini:          false,
    };
  }

  // Check consensus: count status votes
  const statusCounts = votes.reduce((acc, v) => {
    acc[v.status] = (acc[v.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const sortedStatuses = Object.entries(statusCounts).sort((a, b) => b[1] - a[1]);
  const [topStatus, topCount] = sortedStatuses[0] ?? ['unknown', 0];

  // Consensus: 2+ sources agree
  if (topCount >= 2) {
    const consensusVotes = votes.filter(v => v.status === topStatus);
    const avgConfidence  = Math.round(consensusVotes.reduce((s, v) => s + v.confidence, 0) / consensusVotes.length);
    const sources        = consensusVotes.map(v => v.source);
    return {
      loan_status:          topStatus as LoanStatus,
      currency_confidence:  avgConfidence,
      currency_source:      sources.join('+'),
      currency_reasoning:   `Consensus from ${sources.join(' + ')}: loan is ${topStatus}.`,
      maturity_date:        null,
      needsGemini:          false,
    };
  }

  // Single high-confidence heuristic
  if (!heuristic.is_ambiguous && heuristic.confidence >= 75) {
    return {
      loan_status:          heuristic.loan_status,
      currency_confidence:  heuristic.confidence,
      currency_source:      'heuristic',
      currency_reasoning:   heuristic.reasoning,
      maturity_date:        null,
      needsGemini:          false,
    };
  }

  // Disagreement → need Gemini synthesis
  return {
    loan_status:          'unknown',
    currency_confidence:  25,
    currency_source:      'gemini_synthesis',
    currency_reasoning:   'Sources disagree — Gemini synthesis required.',
    maturity_date:        null,
    needsGemini:          true,
  };
}

// ── Step C: Pitch urgency score ───────────────────────────────────────────────

function computePitchUrgency(
  candidate:    CandidateLender,
  plant:        PlantInfo,
  maturityDate: string | null,
): number {
  const distressScore = plant.distress_score ?? 50;
  const distressFactor = Math.min(100, distressScore) / 100;

  // Try to derive maturity year from maturity_date, then maturity_text
  let maturityYear: number | null = null;

  if (maturityDate) {
    maturityYear = parseInt(maturityDate.slice(0, 4), 10);
  } else if (candidate.maturity_text) {
    const match = candidate.maturity_text.match(/\b(20\d{2})\b/);
    if (match) maturityYear = parseInt(match[1], 10);
  }

  const currentYear = new Date().getFullYear();

  let maturityProximityScore = 20; // default: no maturity info known
  if (maturityYear !== null) {
    const yearsToMaturity = maturityYear - currentYear;
    if (yearsToMaturity < 0)      maturityProximityScore = 10;  // already matured
    else if (yearsToMaturity < 1)  maturityProximityScore = 100; // maturing this year
    else if (yearsToMaturity <= 2) maturityProximityScore = 75;
    else if (yearsToMaturity <= 3) maturityProximityScore = 50;
    else                           maturityProximityScore = 20;
  }

  return Math.round(maturityProximityScore * distressFactor);
}

// ── Step D: Pitch angle classification ───────────────────────────────────────

function classifyPitchAngle(
  candidate:   CandidateLender,
  plant:       PlantInfo,
  loanStatus:  LoanStatus,
  pitchUrgency: number,
): { angle: PitchAngle; reasoning: string } {
  const allEvidence = [
    candidate.sources.perplexity?.evidence ?? '',
    candidate.sources.gemini?.evidence ?? '',
    candidate.notes,
  ].join(' ').toLowerCase();

  // Rule 1: Refinancing advisory — active loan within 36 months of maturity on distressed plant
  if (loanStatus === 'active' && pitchUrgency >= 40) {
    return {
      angle:     'refinancing_advisory',
      reasoning: `Active ${candidate.facility_type.replace(/_/g, ' ')} approaching maturity (urgency score ${pitchUrgency}) on curtailed ${plant.fuel_source} plant. Lender will need advisory support for refi decision or extension.`,
    };
  }

  // Rule 2: Interconnection / transmission advisory
  const interconnectionKeywords = [
    'curtailment', 'grid congestion', 'transmission constraint', 'interconnection',
    'dispatch', 'negative pricing', 'iso', 'rto', 'grid operator',
  ];
  if (interconnectionKeywords.some(k => allEvidence.includes(k))) {
    return {
      angle:     'interconnection_advisory',
      reasoning: `Evidence of grid/interconnection-related curtailment at ${plant.name}. Lender needs advisory support on grid access, curtailment mitigation, or interconnection upgrade options.`,
    };
  }

  // Rule 3: Merchant / PPA risk
  const merchantKeywords = ['merchant', 'ppa', 'power purchase agreement', 'unhedged', 'price risk', 'spot'];
  if (merchantKeywords.some(k => allEvidence.includes(k)) || plant.fuel_source === 'Wind') {
    return {
      angle:     'merchant_risk',
      reasoning: `${plant.name} has potential merchant or PPA risk exposure. Lender needs advisory on revenue hedging strategy, PPA renewal, or market risk management.`,
    };
  }

  // Rule 4: Asset management / O&M
  const omKeywords = ['performance', 'degradation', 'maintenance', 'o&m', 'availability', 'capacity factor'];
  if (omKeywords.some(k => allEvidence.includes(k))) {
    return {
      angle:     'asset_management',
      reasoning: `Evidence of performance or O&M issues at ${plant.name}. Lender could benefit from asset management advisory to protect collateral value.`,
    };
  }

  // Default
  return {
    angle:     'general_exposure',
    reasoning: `${plant.name} is a curtailed ${plant.fuel_source} plant with active lender exposure. General advisory opportunity to help lender understand and manage underperformance risk.`,
  };
}

// ── Step E: Upsert to plant_lenders ──────────────────────────────────────────

async function upsertLender(
  sb:          ReturnType<typeof makeSupabase>,
  candidate:   CandidateLender,
  plant:       PlantInfo,
  verification: VerificationResult,
  runLogId:    string | null,
): Promise<{ plantLenderId: number | null }> {
  const now = new Date().toISOString();

  // Check if row already exists
  const { data: existing } = await sb
    .from('plant_lenders')
    .select('id, source')
    .eq('eia_plant_code', plant.eia_plant_code)
    .eq('lender_name', candidate.lender_name)
    .eq('facility_type', candidate.facility_type)
    .single();

  if (existing) {
    // UPDATE — preserve original source provenance
    const { error } = await sb
      .from('plant_lenders')
      .update({
        confidence:               verification.confidence,
        loan_status:              verification.loan_status,
        currency_confidence:      verification.currency_confidence,
        currency_reasoning:       verification.currency_reasoning,
        currency_source:          verification.currency_source,
        currency_checked_at:      now,
        maturity_date:            verification.maturity_date ?? null,
        financial_close_date:     verification.financial_close_date ?? null,
        verification_sources:     verification.verification_sources,
        source_count:             verification.source_count,
        verification_checked_at:  now,
        run_log_id:               runLogId ?? null,
        syndicate_role:           verification.syndicate_role,
        pitch_urgency_score:      verification.pitch_urgency_score,
        pitch_angle:              verification.pitch_angle,
        pitch_angle_reasoning:    verification.pitch_angle_reasoning,
        // Merge new data if better than existing nulls
        ...(candidate.loan_amount_usd !== null ? { loan_amount_usd: candidate.loan_amount_usd } : {}),
        ...(candidate.maturity_text           ? { maturity_text: candidate.maturity_text }     : {}),
        ...(candidate.notes                   ? { notes: candidate.notes }                     : {}),
      })
      .eq('id', existing.id);

    if (error) {
      log('UPSERT-ERR', `Update failed for ${candidate.lender_name}: ${error.message}`);
      return { plantLenderId: null };
    }
    return { plantLenderId: existing.id };
  } else {
    // INSERT — new lender discovered by this pipeline
    const { data: inserted, error } = await sb
      .from('plant_lenders')
      .insert({
        eia_plant_code:           plant.eia_plant_code,
        lender_name:              candidate.lender_name.trim().slice(0, 200),
        role:                     candidate.role,
        facility_type:            candidate.facility_type,
        loan_amount_usd:          candidate.loan_amount_usd ?? null,
        maturity_text:            candidate.maturity_text ?? null,
        confidence:               verification.confidence,
        notes:                    candidate.notes?.slice(0, 500) ?? null,
        source:                   'lender_ingest_agent',
        loan_status:              verification.loan_status,
        currency_confidence:      verification.currency_confidence,
        currency_reasoning:       verification.currency_reasoning,
        currency_source:          verification.currency_source,
        currency_checked_at:      now,
        maturity_date:            verification.maturity_date ?? null,
        financial_close_date:     verification.financial_close_date ?? null,
        verification_sources:     verification.verification_sources,
        source_count:             verification.source_count,
        verification_checked_at:  now,
        run_log_id:               runLogId ?? null,
        syndicate_role:           verification.syndicate_role,
        pitch_urgency_score:      verification.pitch_urgency_score,
        pitch_angle:              verification.pitch_angle,
        pitch_angle_reasoning:    verification.pitch_angle_reasoning,
      })
      .select('id')
      .single();

    if (error) {
      log('UPSERT-ERR', `Insert failed for ${candidate.lender_name}: ${error.message}`);
      return { plantLenderId: null };
    }
    return { plantLenderId: inserted?.id ?? null };
  }
}

// ── Step F: Write evidence rows ───────────────────────────────────────────────

async function writeEvidenceRows(
  sb:            ReturnType<typeof makeSupabase>,
  plantLenderId: number,
  candidate:     CandidateLender,
): Promise<void> {
  const rows: { plant_lender_id: number; source_type: string; raw_text: string; source_url?: string; loan_status_vote?: string }[] = [];

  if (candidate.sources.perplexity?.found) {
    rows.push({
      plant_lender_id:  plantLenderId,
      source_type:      'perplexity',
      raw_text:         candidate.sources.perplexity.evidence?.slice(0, 2000) ?? '',
      loan_status_vote: candidate.sources.perplexity.statusVote ?? undefined,
    });
  }
  if (candidate.sources.gemini?.found) {
    rows.push({
      plant_lender_id:  plantLenderId,
      source_type:      'gemini',
      raw_text:         candidate.sources.gemini.evidence?.slice(0, 2000) ?? '',
      source_url:       candidate.sources.gemini.source_url,
      loan_status_vote: candidate.sources.gemini.statusVote ?? undefined,
    });
  }

  if (rows.length > 0) {
    const { error } = await sb.from('plant_lender_evidence').insert(rows);
    if (error) log('EVIDENCE-ERR', `Evidence insert failed: ${error.message}`);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const __authDenied = checkInternalAuth(req);
  if (__authDenied) return __authDenied;
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }

  let body: { eia_plant_code: string; plantInfo: PlantInfo; candidates: CandidateLender[]; runLogId?: string };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS }); }

  const { plantInfo, candidates, runLogId } = body;
  if (!plantInfo?.eia_plant_code) {
    return new Response(JSON.stringify({ error: 'plantInfo.eia_plant_code required' }), { status: 400, headers: CORS });
  }
  if (!Array.isArray(candidates)) {
    return new Response(JSON.stringify({ error: 'candidates array required' }), { status: 400, headers: CORS });
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), { status: 500, headers: CORS });
  }

  const sb  = makeSupabase();
  const now = new Date().toISOString();
  log('START', `${plantInfo.name}: verifying ${candidates.length} candidates`);

  let upserted  = 0;
  let costUsd   = 0;

  for (const candidate of candidates) {
    try {
      // ── Step A: Confidence ──────────────────────────────────────────────────
      const { confidence, source_count, verification_sources } = computeConfidence(candidate);

      // ── Step B: Loan status ─────────────────────────────────────────────────
      const heuristic = scoreHeuristic({
        cod:                  plantInfo.cod,
        facility_type:        candidate.facility_type,
        maturity_text:        candidate.maturity_text,
        loan_amount_usd:      candidate.loan_amount_usd,
        article_published_at: null,
        source:               'lender_ingest_agent',
      });

      let statusResult = resolveLoansStatus(candidate, heuristic);

      if (statusResult.needsGemini) {
        log('GEMINI', `${candidate.lender_name} @ ${plantInfo.name} — sources disagree, calling Gemini`);
        const geminiResult = await synthesizeWithGemini(candidate, plantInfo, heuristic, geminiKey);
        costUsd += geminiResult.costUsd;
        statusResult = {
          loan_status:          geminiResult.loan_status,
          currency_confidence:  geminiResult.confidence,
          currency_source:      'gemini_synthesis',
          currency_reasoning:   geminiResult.reasoning,
          maturity_date:        geminiResult.maturity_date,
          financial_close_date: geminiResult.financial_close_date,
          needsGemini:          false,
        } as typeof statusResult;
      }

      // ── Step C: Pitch urgency ───────────────────────────────────────────────
      const pitchUrgency = computePitchUrgency(candidate, plantInfo, statusResult.maturity_date ?? null);

      // ── Step D: Pitch angle ─────────────────────────────────────────────────
      const { angle: pitchAngle, reasoning: pitchReasoning } = classifyPitchAngle(
        candidate, plantInfo, statusResult.loan_status, pitchUrgency
      );

      const verification: VerificationResult = {
        confidence,
        source_count,
        verification_sources,
        loan_status:           statusResult.loan_status,
        currency_confidence:   statusResult.currency_confidence,
        currency_reasoning:    statusResult.currency_reasoning,
        currency_source:       statusResult.currency_source,
        maturity_date:         statusResult.maturity_date ?? null,
        financial_close_date:  (statusResult as any).financial_close_date ?? null,
        pitch_urgency_score:   pitchUrgency,
        pitch_angle:           pitchAngle,
        pitch_angle_reasoning: pitchReasoning,
        syndicate_role:        candidate.syndicate_role,
      };

      log('CANDIDATE', `${candidate.lender_name}: ${confidence} confidence (${source_count} sources), status=${statusResult.loan_status}, urgency=${pitchUrgency}, angle=${pitchAngle}`);

      // ── Step E: Upsert ──────────────────────────────────────────────────────
      const { plantLenderId } = await upsertLender(sb, candidate, plantInfo, verification, runLogId ?? null);

      // ── Step F: Evidence rows ───────────────────────────────────────────────
      if (plantLenderId) {
        await writeEvidenceRows(sb, plantLenderId, candidate);
        upserted++;
      }
    } catch (err) {
      log('CANDIDATE-ERR', `${candidate.lender_name}: ${String(err).slice(0, 200)}`);
    }
  }

  // ── Step G: Mark plant_news_state ─────────────────────────────────────────
  // Write both timestamps for AdminPage counter compatibility
  await sb.from('plant_news_state').upsert({
    eia_plant_code:           plantInfo.eia_plant_code,
    lender_ingest_checked_at: now,
    lender_search_checked_at: now,
    updated_at:               now,
  }, { onConflict: 'eia_plant_code' });

  // Also update plant_financing_summary lenders_found flag
  if (upserted > 0) {
    await sb.from('plant_financing_summary').upsert({
      eia_plant_code: plantInfo.eia_plant_code,
      lenders_found:  true,
      searched_at:    now,
      updated_at:     now,
    }, { onConflict: 'eia_plant_code' });
  }

  log('DONE', `${plantInfo.name}: ${upserted} upserted, $${costUsd.toFixed(4)} spent`);

  return new Response(JSON.stringify({
    ok:       true,
    upserted,
    costUsd,
  }), { headers: CORS });
});
