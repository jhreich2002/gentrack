/**
 * GenTrack — lenderValidationService
 *
 * The unified data layer for the new Lender Research workflow:
 *
 *   To Validate  → fetchLenderValidationQueue / fetchLenderCandidatePlants /
 *                  fetchPlantEvidenceForLender + validate / reject / manual /
 *                  no-lender RPCs.
 *   Validated    → fetchValidatedLenders + fetchValidatedPortfolio +
 *                  fetchValidationAudit + setLenderTier.
 *   Pursuits     → fetchPursuitsByTier (reuses validated portfolio rows).
 *
 * All write paths go through Supabase RPCs defined in
 * `supabase/migrations/20260506_unify_lender_validation.sql`.
 */

import { supabase } from './supabaseClient';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type EvidenceType =
  | 'inferred'
  | 'sponsor_pattern'
  | 'web_scrape'
  | 'llm_inference'
  | 'news'
  | 'news_article'
  | 'doe_lpo'
  | 'ferc'
  | 'edgar_loan'
  | 'manual'
  | 'direct_filing'
  | 'county_record'
  | 'edgar'
  | 'supplement';

export type ConfidenceClass = 'confirmed' | 'high_confidence' | 'highly_likely' | 'possible';
export type LeadStatus = 'pending' | 'validated' | 'rejected' | 'superseded';
export type LenderTier = 'hot' | 'warm' | 'cold';
export type LenderResolution = 'pending' | 'validated' | 'no_lender_identifiable' | 'manual';

export interface ValidationQueueRow {
  lenderNormalized: string;
  lenderName: string;
  pendingCount: number;
  pendingPlantCount: number;
  curtailedPlantCount: number;
  curtailedMw: number;
  lastLeadAt: string | null;
}

export interface CandidatePlant {
  plantCode: string;
  plantName: string | null;
  state: string | null;
  fuelSource: string | null;
  nameplateMw: number | null;
  isLikelyCurtailed: boolean;
  distressScore: number | null;
  pendingLeadCount: number;
  resolution: LenderResolution;
}

export interface PlantEvidenceRow {
  id: number;
  leadStatus: LeadStatus;
  evidenceType: EvidenceType;
  confidenceClass: ConfidenceClass;
  evidenceSummary: string | null;
  sourceUrl: string | null;
  lenderName: string | null;
  lenderNormalized: string | null;
  runId: string | null;
  createdAt: string;
  legacyPlantLenderId: number | null;
}

export interface ValidatedLender {
  lenderNormalized: string;
  lenderName: string;
  validatedPlantCount: number;
  curtailedPlantCount: number;
  curtailedMw: number;
  lastValidatedAt: string | null;
  tier: LenderTier | null;
  tierSetAt: string | null;
  notes: string | null;
  promotedAt: string | null;
}

export interface ValidatedPortfolioRow {
  linkId: number;
  plantCode: string;
  plantName: string | null;
  state: string | null;
  fuelSource: string | null;
  nameplateMw: number | null;
  isLikelyCurtailed: boolean;
  evidenceType: EvidenceType;
  confidenceClass: ConfidenceClass;
  evidenceSummary: string | null;
  sourceUrl: string | null;
  validatedAt: string | null;
}

export interface ValidationAuditEntry {
  action: 'approve' | 'reject' | 'rerun' | 'needs_more';
  notes: string | null;
  reviewerEmail: string | null;
  timestamp: string;
}

export interface LenderEntitySuggestion {
  id: number;
  entityName: string;
  normalizedName: string;
}

function firstHttpUrlDeep(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const s = value.trim();
    return /^https?:\/\//i.test(s) ? s : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstHttpUrlDeep(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/url|link|source/i.test(k) && typeof v === 'string') {
        const s = v.trim();
        if (/^https?:\/\//i.test(s)) return s;
      }
      const found = firstHttpUrlDeep(v);
      if (found) return found;
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Queue (To Validate tab)
// ──────────────────────────────────────────────────────────────────────────────

export interface QueueOptions {
  minPlants?: number;       // default 2 — multi-plant exposure threshold
  curtailedOnly?: boolean;  // default true — only count curtailed plants
  search?: string;
  sort?: 'curtailed_mw' | 'pending_count' | 'name';
}

export async function fetchLenderValidationQueue(opts: QueueOptions = {}): Promise<ValidationQueueRow[]> {
  const { minPlants = 2, curtailedOnly = true, search, sort = 'curtailed_mw' } = opts;

  const { data, error } = await supabase
    .from('v_lender_validation_queue')
    .select('lender_normalized, lender_name, pending_count, pending_plant_count, curtailed_plant_count, curtailed_mw, last_lead_at');

  if (error || !data) {
    console.error('fetchLenderValidationQueue:', error?.message);
    return [];
  }

  let rows: ValidationQueueRow[] = data.map((r: any) => ({
    lenderNormalized:    String(r.lender_normalized ?? ''),
    lenderName:          String(r.lender_name ?? r.lender_normalized ?? ''),
    pendingCount:        Number(r.pending_count) || 0,
    pendingPlantCount:   Number(r.pending_plant_count) || 0,
    curtailedPlantCount: Number(r.curtailed_plant_count) || 0,
    curtailedMw:         Number(r.curtailed_mw) || 0,
    lastLeadAt:          (r.last_lead_at as string | null) ?? null,
  }));

  rows = rows.filter(r => {
    const planted = curtailedOnly ? r.curtailedPlantCount : r.pendingPlantCount;
    return planted >= minPlants;
  });

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r =>
      r.lenderName.toLowerCase().includes(q) ||
      r.lenderNormalized.toLowerCase().includes(q));
  }

  rows.sort((a, b) => {
    if (sort === 'name') return a.lenderName.localeCompare(b.lenderName);
    if (sort === 'pending_count') return b.pendingCount - a.pendingCount;
    return b.curtailedMw - a.curtailedMw;
  });

  return rows;
}

// ──────────────────────────────────────────────────────────────────────────────
// Candidate plants for a single lender (To Validate detail panel)
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchLenderCandidatePlants(lenderNormalized: string): Promise<CandidatePlant[]> {
  const { data: leads, error: leadsErr } = await supabase
    .from('ucc_lender_leads_unverified')
    .select('plant_code, lead_status')
    .eq('lender_normalized', lenderNormalized);

  if (leadsErr || !leads) {
    console.error('fetchLenderCandidatePlants leads:', leadsErr?.message);
    return [];
  }

  const counts = new Map<string, number>();
  for (const r of leads as any[]) {
    if (r.lead_status === 'pending') {
      counts.set(r.plant_code, (counts.get(r.plant_code) ?? 0) + 1);
    } else if (!counts.has(r.plant_code)) {
      counts.set(r.plant_code, 0);
    }
  }
  const plantCodes = Array.from(counts.keys());
  if (plantCodes.length === 0) return [];

  const [{ data: plants }, { data: research }] = await Promise.all([
    supabase
      .from('plants')
      .select('eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, is_likely_curtailed, distress_score')
      .in('eia_plant_code', plantCodes),
    supabase
      .from('ucc_research_plants')
      .select('plant_code, lender_resolution')
      .in('plant_code', plantCodes),
  ]);

  const plantMap = new Map<string, any>();
  for (const p of (plants ?? []) as any[]) plantMap.set(p.eia_plant_code, p);
  const resMap = new Map<string, LenderResolution>();
  for (const r of (research ?? []) as any[]) {
    resMap.set(r.plant_code, (r.lender_resolution as LenderResolution) ?? 'pending');
  }

  return plantCodes.map(code => {
    const p = plantMap.get(code) ?? {};
    return {
      plantCode:         code,
      plantName:         (p.name as string | null) ?? null,
      state:             (p.state as string | null) ?? null,
      fuelSource:        (p.fuel_source as string | null) ?? null,
      nameplateMw:       p.nameplate_capacity_mw != null ? Number(p.nameplate_capacity_mw) : null,
      isLikelyCurtailed: Boolean(p.is_likely_curtailed),
      distressScore:     p.distress_score != null ? Number(p.distress_score) : null,
      pendingLeadCount:  counts.get(code) ?? 0,
      resolution:        resMap.get(code) ?? 'pending',
    };
  }).sort((a, b) => {
    if (a.pendingLeadCount !== b.pendingLeadCount) return b.pendingLeadCount - a.pendingLeadCount;
    if (a.isLikelyCurtailed !== b.isLikelyCurtailed) return a.isLikelyCurtailed ? -1 : 1;
    return (b.nameplateMw ?? 0) - (a.nameplateMw ?? 0);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Evidence stack for a (plant, lender) pair
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchPlantEvidenceForLender(
  plantCode: string,
  lenderNormalized: string,
): Promise<PlantEvidenceRow[]> {
  const { data, error } = await supabase
    .from('ucc_lender_leads_unverified')
    .select('id, lead_status, evidence_type, confidence_class, evidence_summary, source_url, lender_name, lender_normalized, run_id, created_at, legacy_plant_lender_id')
    .eq('plant_code', plantCode)
    .eq('lender_normalized', lenderNormalized)
    .order('created_at', { ascending: false });

  if (error || !data) {
    console.error('fetchPlantEvidenceForLender:', error?.message);
    return [];
  }

  const rows: PlantEvidenceRow[] = (data as any[]).map(r => ({
    id:                   Number(r.id),
    leadStatus:           r.lead_status as LeadStatus,
    evidenceType:         r.evidence_type as EvidenceType,
    confidenceClass:      r.confidence_class as ConfidenceClass,
    evidenceSummary:      (r.evidence_summary as string | null) ?? null,
    sourceUrl:            (r.source_url as string | null) ?? null,
    lenderName:           (r.lender_name as string | null) ?? null,
    lenderNormalized:     (r.lender_normalized as string | null) ?? null,
    runId:                (r.run_id as string | null) ?? null,
    createdAt:            String(r.created_at ?? ''),
    legacyPlantLenderId:  r.legacy_plant_lender_id != null ? Number(r.legacy_plant_lender_id) : null,
  }));

  const pairKey = `${plantCode}::${lenderNormalized}`;
  const pairUrl = rows.find(r => !!r.sourceUrl)?.sourceUrl ?? null;

  // Resolve missing links from related evidence stores so the UI surfaces
  // source URLs automatically whenever we can prove one.
  const missing = rows.filter(r => !r.sourceUrl);
  if (missing.length === 0) return rows;

  const legacyIds = Array.from(new Set(
    missing.map(r => r.legacyPlantLenderId).filter((id): id is number => typeof id === 'number')
  ));

  const [
    linksRes,
    claimsRes,
    docsRes,
    legacyRes,
  ] = await Promise.all([
    supabase
      .from('ucc_lender_links')
      .select('source_url, created_at')
      .eq('plant_code', plantCode)
      .eq('lender_normalized', lenderNormalized)
      .not('source_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('lender_evidence_claims')
      .select('source_url, created_at')
      .eq('plant_code', plantCode)
      .eq('lender_normalized', lenderNormalized)
      .not('source_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('lender_evidence_documents')
      .select('url, created_at')
      .eq('plant_code', plantCode)
      .eq('lender_normalized', lenderNormalized)
      .not('url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1),
    legacyIds.length > 0
      ? supabase
          .from('plant_lenders')
          .select('id, source_url, source_evidence')
          .in('id', legacyIds)
      : Promise.resolve({ data: [], error: null } as any),
  ]);

  const linkUrl = (linksRes.data?.[0] as any)?.source_url as string | undefined;
  const claimUrl = (claimsRes.data?.[0] as any)?.source_url as string | undefined;
  const docUrl = (docsRes.data?.[0] as any)?.url as string | undefined;

  const legacyMap = new Map<number, string>();
  for (const row of (legacyRes.data ?? []) as any[]) {
    const direct = typeof row.source_url === 'string' ? row.source_url : null;
    const deep = firstHttpUrlDeep(row.source_evidence);
    const resolved = direct || deep;
    if (resolved) legacyMap.set(Number(row.id), resolved);
  }

  const resolvedForPair = pairUrl || linkUrl || claimUrl || docUrl || null;

  return rows.map(r => {
    if (r.sourceUrl) return r;
    const legacyUrl = r.legacyPlantLenderId ? legacyMap.get(r.legacyPlantLenderId) : null;
    return {
      ...r,
      sourceUrl: resolvedForPair || legacyUrl || null,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Validated lenders (Validated + Pursuits tabs)
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchValidatedLenders(): Promise<ValidatedLender[]> {
  const [{ data: portfolio, error: pErr }, { data: pursuits, error: tErr }] = await Promise.all([
    supabase
      .from('v_validated_lender_portfolio')
      .select('lender_normalized, lender_name, validated_plant_count, curtailed_plant_count, curtailed_mw, last_validated_at'),
    supabase
      .from('ucc_lender_pursuits')
      .select('lender_normalized, lender_name, tier, tier_set_at, notes, promoted_at'),
  ]);

  if (pErr) console.error('fetchValidatedLenders portfolio:', pErr.message);
  if (tErr) console.error('fetchValidatedLenders pursuits:', tErr.message);

  // Source list = every validated lender (v_validated_lender_portfolio is
  // already scoped to human_approved=true). Pursuit metadata is layered on.
  const tierMap = new Map<string, any>();
  for (const r of (pursuits ?? []) as any[]) tierMap.set(r.lender_normalized, r);

  return ((portfolio ?? []) as any[]).map(port => {
    const t = tierMap.get(port.lender_normalized) ?? {};
    return {
      lenderNormalized:    String(port.lender_normalized),
      lenderName:          String(port.lender_name ?? t.lender_name ?? port.lender_normalized),
      validatedPlantCount: Number(port.validated_plant_count) || 0,
      curtailedPlantCount: Number(port.curtailed_plant_count) || 0,
      curtailedMw:         Number(port.curtailed_mw) || 0,
      lastValidatedAt:     (port.last_validated_at as string | null) ?? null,
      tier:                (t.tier as LenderTier | null) ?? null,
      tierSetAt:           (t.tier_set_at as string | null) ?? null,
      notes:               (t.notes as string | null) ?? null,
      promotedAt:          (t.promoted_at as string | null) ?? null,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Validated portfolio drawer (per-plant breakdown for one lender)
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchValidatedPortfolio(lenderNormalized: string): Promise<ValidatedPortfolioRow[]> {
  const { data: links, error: linksErr } = await supabase
    .from('ucc_lender_links')
    .select('id, plant_code, evidence_type, confidence_class, evidence_summary, source_url, updated_at, created_at')
    .eq('lender_normalized', lenderNormalized)
    .eq('human_approved', true);

  if (linksErr || !links) {
    console.error('fetchValidatedPortfolio links:', linksErr?.message);
    return [];
  }

  const codes = Array.from(new Set((links as any[]).map(l => l.plant_code as string)));
  if (codes.length === 0) return [];

  const { data: plants } = await supabase
    .from('plants')
    .select('eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, is_likely_curtailed')
    .in('eia_plant_code', codes);

  const plantMap = new Map<string, any>();
  for (const p of (plants ?? []) as any[]) plantMap.set(p.eia_plant_code, p);

  return (links as any[]).map(l => {
    const p = plantMap.get(l.plant_code) ?? {};
    return {
      linkId:            Number(l.id),
      plantCode:         String(l.plant_code),
      plantName:         (p.name as string | null) ?? null,
      state:             (p.state as string | null) ?? null,
      fuelSource:        (p.fuel_source as string | null) ?? null,
      nameplateMw:       p.nameplate_capacity_mw != null ? Number(p.nameplate_capacity_mw) : null,
      isLikelyCurtailed: Boolean(p.is_likely_curtailed),
      evidenceType:      l.evidence_type as EvidenceType,
      confidenceClass:   l.confidence_class as ConfidenceClass,
      evidenceSummary:   (l.evidence_summary as string | null) ?? null,
      sourceUrl:         (l.source_url as string | null) ?? null,
      validatedAt:       (l.updated_at as string | null) ?? (l.created_at as string | null) ?? null,
    };
  }).sort((a, b) => {
    if (a.isLikelyCurtailed !== b.isLikelyCurtailed) return a.isLikelyCurtailed ? -1 : 1;
    return (b.nameplateMw ?? 0) - (a.nameplateMw ?? 0);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Audit chain-of-custody for a validated plant link
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchValidationAudit(plantCode: string): Promise<ValidationAuditEntry[]> {
  const { data, error } = await supabase
    .from('ucc_review_actions')
    .select('action, notes, reviewer_email, timestamp')
    .eq('plant_code', plantCode)
    .order('timestamp', { ascending: false });

  if (error || !data) {
    console.error('fetchValidationAudit:', error?.message);
    return [];
  }
  return (data as any[]).map(r => ({
    action:        r.action as ValidationAuditEntry['action'],
    notes:         (r.notes as string | null) ?? null,
    reviewerEmail: (r.reviewer_email as string | null) ?? null,
    timestamp:     String(r.timestamp ?? ''),
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Pursuits (tier-grouped view)
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchPursuitsByTier(tier: LenderTier | null = null): Promise<ValidatedLender[]> {
  const all = await fetchValidatedLenders();
  if (tier === null) return all;
  return all.filter(l => l.tier === tier);
}

// ──────────────────────────────────────────────────────────────────────────────
// Manual-entry lender autocomplete
// ──────────────────────────────────────────────────────────────────────────────

export async function searchLenderEntities(q: string, limit = 10): Promise<LenderEntitySuggestion[]> {
  if (!q || q.trim().length < 2) return [];
  const { data, error } = await supabase
    .from('ucc_entities')
    .select('id, entity_name, normalized_name')
    .eq('entity_type', 'lender')
    .ilike('normalized_name', `%${q.toLowerCase()}%`)
    .limit(limit);

  if (error || !data) return [];
  return (data as any[]).map(r => ({
    id:             Number(r.id),
    entityName:     String(r.entity_name ?? ''),
    normalizedName: String(r.normalized_name ?? ''),
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Action RPCs
// ──────────────────────────────────────────────────────────────────────────────

export async function validateLenderLead(leadId: number, note?: string): Promise<{ success: boolean; linkId?: number; error?: string }> {
  const { data, error } = await supabase.rpc('validate_lender_lead', { p_lead_id: leadId, p_note: note ?? null });
  if (error) return { success: false, error: error.message };
  return { success: true, linkId: Number(data) };
}

export async function rejectLenderLead(leadId: number, reason?: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.rpc('reject_lender_lead', { p_lead_id: leadId, p_reason: reason ?? null });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function addManualLenderLink(args: {
  plantCode: string;
  lenderName: string;
  sourceUrl: string;
  note: string;
  facilityType?: string;
}): Promise<{ success: boolean; linkId?: number; error?: string }> {
  const { data, error } = await supabase.rpc('add_manual_lender_link', {
    p_plant_code:    args.plantCode,
    p_lender_name:   args.lenderName,
    p_source_url:    args.sourceUrl,
    p_note:          args.note,
    p_facility_type: args.facilityType ?? null,
  });
  if (error) return { success: false, error: error.message };
  return { success: true, linkId: Number(data) };
}

export async function markNoLenderIdentifiable(plantCode: string, note?: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.rpc('mark_no_lender_identifiable', {
    p_plant_code: plantCode,
    p_note:       note ?? null,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function setLenderPursuitTier(
  lenderNormalized: string,
  tier: LenderTier | null,
  notes?: string,
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.rpc('set_lender_pursuit_tier', {
    p_lender_normalized: lenderNormalized,
    p_tier:              tier,
    p_notes:             notes ?? null,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}
