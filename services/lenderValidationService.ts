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
  | 'edgar_filing'
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
  canonicalLenderId: string;  // uuid
  lenderName: string;
  pendingCount: number;
  pendingPlantCount: number;
  curtailedPlantCount: number;
  curtailedMw: number;
  lastLeadAt: string | null;
  /** v3 compat alias — use canonicalLenderId for new code */
  lenderNormalized: string;
}

export interface CandidatePlant {
  plantId: string;        // v4: plants.id is TEXT
  plantCode: string;      // eia_plant_code
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
  /** v4: this is a lender_links.id (bigint). leadStatus maps to validation_status */
  leadStatus: LeadStatus;
  evidenceType: EvidenceType;
  confidenceClass: ConfidenceClass;
  evidenceSummary: string | null;
  sourceUrl: string | null;
  evidenceDate: string | null;  // ISO date of the filing / article
  lenderName: string | null;
  lenderNormalized: string | null;
  runId: string | null;
  createdAt: string;
  legacyPlantLenderId: number | null;
  loanStatus: string | null;
  roleTag: string | null;
}

export interface ValidatedLender {
  canonicalLenderId: string;  // uuid
  lenderName: string;
  validatedPlantCount: number;
  curtailedPlantCount: number;
  curtailedMw: number;
  lastValidatedAt: string | null;
  tier: LenderTier | null;
  tierSetAt: string | null;
  notes: string | null;
  promotedAt: string | null;
  /** v3 compat alias */
  lenderNormalized: string;
}

export interface ValidatedPortfolioRow {
  linkId: number;
  plantId: string;
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
  loanStatus: string | null;
  roleTag: string | null;
}

export interface ValidationAuditEntry {
  action: 'approve' | 'reject' | 'rerun' | 'needs_more';
  notes: string | null;
  reviewerEmail: string | null;
  timestamp: string;
}

export interface LenderEntitySuggestion {
  id: string | number;  // v4: uuid string; v3 compat: number
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

  // v4 view: canonical_lender_id (uuid), lender_name, pending_count, pending_plant_count, curtailed_plant_count, curtailed_mw, last_lead_at
  const { data, error } = await supabase
    .from('v_lender_validation_queue')
    .select('canonical_lender_id, lender_name, pending_count, pending_plant_count, curtailed_plant_count, curtailed_mw, last_lead_at');

  if (error || !data) {
    console.error('fetchLenderValidationQueue:', error?.message);
    return [];
  }

  let rows: ValidationQueueRow[] = data.map((r: any) => ({
    canonicalLenderId:   String(r.canonical_lender_id ?? ''),
    lenderName:          String(r.lender_name ?? ''),
    pendingCount:        Number(r.pending_count) || 0,
    pendingPlantCount:   Number(r.pending_plant_count) || 0,
    curtailedPlantCount: Number(r.curtailed_plant_count) || 0,
    curtailedMw:         Number(r.curtailed_mw) || 0,
    lastLeadAt:          (r.last_lead_at as string | null) ?? null,
    // v3 compat
    lenderNormalized:    String(r.canonical_lender_id ?? ''),
  }));

  rows = rows.filter(r => {
    const planted = curtailedOnly ? r.curtailedPlantCount : r.pendingPlantCount;
    return planted >= minPlants;
  });

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r =>
      r.lenderName.toLowerCase().includes(q) ||
      r.canonicalLenderId.toLowerCase().includes(q));
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

export async function fetchLenderCandidatePlants(canonicalLenderId: string): Promise<CandidatePlant[]> {
  // v4: lender_links groups by canonical_lender_id (uuid), joined to plants (integer id)
  const { data: links, error: linksErr } = await supabase
    .from('lender_links')
    .select('plant_id, validation_status')
    .eq('canonical_lender_id', canonicalLenderId);

  if (linksErr || !links) {
    console.error('fetchLenderCandidatePlants links:', linksErr?.message);
    return [];
  }

  const plantIds = Array.from(new Set((links as any[]).map(l => String(l.plant_id))));
  if (plantIds.length === 0) return [];

  const pendingMap = new Map<string, number>();
  const resMap     = new Map<string, LenderResolution>();

  for (const l of links as any[]) {
    const pid = String(l.plant_id);
    if (l.validation_status === 'pending') {
      pendingMap.set(pid, (pendingMap.get(pid) ?? 0) + 1);
    }
    // Determine resolution: if any validated/manual link exists, use that
    const existing = resMap.get(pid);
    const vs = l.validation_status as string;
    if (vs === 'validated' || vs === 'manual') {
      resMap.set(pid, vs as LenderResolution);
    } else if (vs === 'no_lender_identifiable') {
      if (!existing || existing === 'pending') resMap.set(pid, 'no_lender_identifiable');
    } else if (!existing) {
      resMap.set(pid, 'pending');
    }
  }

  const { data: plants } = await supabase
    .from('plants')
    .select('id, eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, is_likely_curtailed, distress_score')
    .in('id', plantIds);

  return plantIds.map(pid => {
    const p = (plants ?? []).find((x: any) => String(x.id) === pid) as any ?? {};
    return {
      plantId:           pid,
      plantCode:         String(p.eia_plant_code ?? pid),
      plantName:         (p.name as string | null) ?? null,
      state:             (p.state as string | null) ?? null,
      fuelSource:        (p.fuel_source as string | null) ?? null,
      nameplateMw:       p.nameplate_capacity_mw != null ? Number(p.nameplate_capacity_mw) : null,
      isLikelyCurtailed: Boolean(p.is_likely_curtailed),
      distressScore:     p.distress_score != null ? Number(p.distress_score) : null,
      pendingLeadCount:  pendingMap.get(pid) ?? 0,
      resolution:        resMap.get(pid) ?? 'pending',
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
  plantIdOrCode: string,
  canonicalLenderId: string,
): Promise<PlantEvidenceRow[]> {
  // Accept plants.id (TEXT) or eia_plant_code; both are strings.
  // Try as-is first; if no rows, look up by eia_plant_code.
  let plantId: string | null = plantIdOrCode;
  {
    const { data: p } = await supabase
      .from('plants')
      .select('id')
      .eq('id', plantIdOrCode)
      .maybeSingle();
    if (!p) {
      const { data: p2 } = await supabase
        .from('plants')
        .select('id')
        .eq('eia_plant_code', plantIdOrCode)
        .maybeSingle();
      plantId = p2 ? String((p2 as any).id) : null;
    }
  }
  if (plantId === null) return [];

  // Fetch all lender_links for this plant+lender pair (there may be one link with multiple claims)
  const { data: links } = await supabase
    .from('lender_links')
    .select('id, validation_status, created_at, primary_claim_id')
    .eq('plant_id', plantId)
    .eq('canonical_lender_id', canonicalLenderId);

  if (!links || links.length === 0) return [];

  const linkIds = (links as any[]).map(l => Number(l.id));

  // Fetch all evidence claims via lender_link_evidence join
  const { data: evidenceJoin } = await supabase
    .from('lender_link_evidence')
    .select('link_id, claim_id')
    .in('link_id', linkIds);

  const claimIds = Array.from(new Set((evidenceJoin ?? []).map((e: any) => Number(e.claim_id))));

  let claimsMap = new Map<number, any>();
  if (claimIds.length > 0) {
    const { data: claims } = await supabase
      .from('lender_research_claims')
      .select('id, raw_lender_name, quote, source_url, source_type, evidence_date, loan_status, role_tag, confidence, session_id, created_at')
      .in('id', claimIds);

    for (const c of (claims ?? []) as any[]) claimsMap.set(Number(c.id), c);
  }

  // Build PlantEvidenceRow per link (one row per link, using primary_claim for evidence details)
  return (links as any[]).map(link => {
    const primaryClaim = claimsMap.get(Number(link.primary_claim_id)) ?? claimsMap.get(claimIds[0]) ?? null;
    const vs: string = link.validation_status ?? 'pending';
    const leadStatus: LeadStatus = vs === 'validated' ? 'validated'
      : vs === 'rejected' ? 'rejected'
      : vs === 'manual' ? 'validated'
      : 'pending';

    // Derive evidence type from claim source_type
    const sourceType = (primaryClaim?.source_type as string | null) ?? 'inferred';
    const evidenceType: EvidenceType = (sourceType as EvidenceType);

    // Derive confidence class from numeric confidence
    const conf = Number(primaryClaim?.confidence ?? 0.5);
    const confidenceClass: ConfidenceClass =
      conf >= 0.9  ? 'confirmed'
      : conf >= 0.75 ? 'high_confidence'
      : conf >= 0.55 ? 'highly_likely'
      : 'possible';

    return {
      id:                  Number(link.id),
      leadStatus,
      evidenceType,
      confidenceClass,
      evidenceSummary:     (primaryClaim?.quote as string | null) ?? null,
      sourceUrl:           (primaryClaim?.source_url as string | null) ?? null,
      evidenceDate:        (primaryClaim?.evidence_date as string | null) ?? null,
      lenderName:          (primaryClaim?.raw_lender_name as string | null) ?? null,
      lenderNormalized:    canonicalLenderId,
      runId:               (primaryClaim?.session_id as string | null) ?? null,
      createdAt:           String(link.created_at ?? ''),
      legacyPlantLenderId: null,
      loanStatus:          (primaryClaim?.loan_status as string | null) ?? null,
      roleTag:             (primaryClaim?.role_tag as string | null) ?? null,
    } satisfies PlantEvidenceRow;
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Validated lenders (Validated + Pursuits tabs)
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchValidatedLenders(): Promise<ValidatedLender[]> {
  // v4: v_validated_lender_portfolio has: canonical_lender_id, lender_name, tier, validated_plant_count, total_curtailed_mw, last_validated_at
  // lender_pursuits has: canonical_lender_id, tier, notes, classified_at
  const { data: portfolio, error: pErr } = await supabase
    .from('v_validated_lender_portfolio')
    .select('canonical_lender_id, lender_name, tier, validated_plant_count, total_curtailed_mw, last_validated_at');

  if (pErr) console.error('fetchValidatedLenders portfolio:', pErr.message);

  return ((portfolio ?? []) as any[]).map(port => ({
    canonicalLenderId:   String(port.canonical_lender_id),
    lenderName:          String(port.lender_name ?? port.canonical_lender_id),
    validatedPlantCount: Number(port.validated_plant_count) || 0,
    curtailedPlantCount: 0, // v4 view doesn't break this out — use total_curtailed_mw
    curtailedMw:         Number(port.total_curtailed_mw) || 0,
    lastValidatedAt:     (port.last_validated_at as string | null) ?? null,
    tier:                (port.tier as LenderTier | null) ?? null,
    tierSetAt:           null,
    notes:               null,
    promotedAt:          (port.last_validated_at as string | null) ?? null,
    lenderNormalized:    String(port.canonical_lender_id),
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Validated portfolio drawer (per-plant breakdown for one lender)
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchValidatedPortfolio(canonicalLenderId: string): Promise<ValidatedPortfolioRow[]> {
  // v4: lender_links + lender_research_claims via primary_claim_id + plants
  const { data: links, error: linksErr } = await supabase
    .from('lender_links')
    .select('id, plant_id, validation_status, validated_at, primary_claim_id')
    .eq('canonical_lender_id', canonicalLenderId)
    .in('validation_status', ['validated','manual']);

  if (linksErr || !links) {
    console.error('fetchValidatedPortfolio links:', linksErr?.message);
    return [];
  }

  const plantIds = Array.from(new Set((links as any[]).map(l => String(l.plant_id))));
  if (plantIds.length === 0) return [];

  const claimIds = Array.from(new Set(
    (links as any[]).map(l => l.primary_claim_id).filter(Boolean),
  ));

  const [{ data: plants }, { data: claims }] = await Promise.all([
    supabase
      .from('plants')
      .select('id, eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, is_likely_curtailed')
      .in('id', plantIds),
    claimIds.length > 0
      ? supabase
          .from('lender_research_claims')
          .select('id, source_url, quote, source_type, confidence, loan_status, role_tag')
          .in('id', claimIds)
      : Promise.resolve({ data: [], error: null }) as any,
  ]);

  const plantMap = new Map<string, any>();
  for (const p of (plants ?? []) as any[]) plantMap.set(String(p.id), p);
  const claimMap = new Map<number, any>();
  for (const c of (claims ?? []) as any[]) claimMap.set(Number(c.id), c);

  return (links as any[]).map(l => {
    const p     = plantMap.get(String(l.plant_id)) ?? {};
    const claim = claimMap.get(Number(l.primary_claim_id)) ?? null;
    const conf  = Number(claim?.confidence ?? 0.7);
    const confidenceClass: ConfidenceClass =
      conf >= 0.9  ? 'confirmed'
      : conf >= 0.75 ? 'high_confidence'
      : conf >= 0.55 ? 'highly_likely'
      : 'possible';
    const evidenceType: EvidenceType = (claim?.source_type as EvidenceType) ?? 'inferred';
    return {
      linkId:            Number(l.id),
      plantId:           String(l.plant_id),
      plantCode:         String(p.eia_plant_code ?? l.plant_id),
      plantName:         (p.name as string | null) ?? null,
      state:             (p.state as string | null) ?? null,
      fuelSource:        (p.fuel_source as string | null) ?? null,
      nameplateMw:       p.nameplate_capacity_mw != null ? Number(p.nameplate_capacity_mw) : null,
      isLikelyCurtailed: Boolean(p.is_likely_curtailed),
      evidenceType,
      confidenceClass,
      evidenceSummary:   (claim?.quote as string | null) ?? null,
      sourceUrl:         (claim?.source_url as string | null) ?? null,
      validatedAt:       (l.validated_at as string | null) ?? null,
      loanStatus:        (claim?.loan_status as string | null) ?? null,
      roleTag:           (claim?.role_tag as string | null) ?? null,
    } satisfies ValidatedPortfolioRow;
  }).sort((a, b) => {
    if (a.isLikelyCurtailed !== b.isLikelyCurtailed) return a.isLikelyCurtailed ? -1 : 1;
    return (b.nameplateMw ?? 0) - (a.nameplateMw ?? 0);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Audit chain-of-custody for a validated plant link
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchValidationAudit(_plantCode: string): Promise<ValidationAuditEntry[]> {
  // v4: no separate audit table — validation is tracked on lender_links directly.
  // Return empty array; audit can be reconstructed from lender_links if needed.
  return [];
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
    .from('lenders_canonical')
    .select('id, name')
    .ilike('name', `%${q.trim()}%`)
    .limit(limit);

  if (error || !data) return [];
  return (data as any[]).map(r => ({
    id:             String(r.id),    // uuid in v4
    entityName:     String(r.name ?? ''),
    normalizedName: String(r.name ?? '').toLowerCase(),
  })) as any;
}

// ──────────────────────────────────────────────────────────────────────────────
// Action RPCs
// ──────────────────────────────────────────────────────────────────────────────

export async function validateLenderLead(linkId: number, note?: string): Promise<{ success: boolean; linkId?: number; error?: string }> {
  const { error } = await supabase.rpc('validate_lender_link', { p_link_id: linkId, p_note: note ?? null });
  if (error) return { success: false, error: error.message };
  return { success: true, linkId };
}

export async function rejectLenderLead(linkId: number, reason?: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.rpc('reject_lender_link', { p_link_id: linkId, p_note: reason ?? null });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function revertLenderLink(linkId: number): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.rpc('revert_lender_link', { p_link_id: linkId });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function addManualLenderLink(args: {
  plantCode?: string;
  plantId?: string;
  lenderName: string;
  sourceUrl?: string;
  note?: string;
  facilityType?: string;
}): Promise<{ success: boolean; linkId?: number; error?: string }> {
  // v4 RPC: add_manual_lender_link(p_plant_id text, p_lender_name text, p_source_url text, p_note text)
  let plantId = args.plantId;
  if (!plantId && args.plantCode) {
    const { data: p } = await supabase
      .from('plants')
      .select('id')
      .eq('eia_plant_code', args.plantCode)
      .single();
    plantId = p ? String((p as any).id) : undefined;
  }
  if (!plantId) return { success: false, error: 'Could not resolve plant_id' };

  const { data, error } = await supabase.rpc('add_manual_lender_link', {
    p_plant_id:   plantId,
    p_lender_name: args.lenderName,
    p_source_url:  args.sourceUrl ?? null,
    p_note:        args.note ?? null,
  });
  if (error) return { success: false, error: error.message };
  return { success: true, linkId: Number(data) };
}

export async function markNoLenderIdentifiable(plantCodeOrId: string, note?: string): Promise<{ success: boolean; error?: string }> {
  // Try as plants.id (TEXT) first; if not found, try eia_plant_code.
  let plantId: string | undefined;
  const { data: byId } = await supabase
    .from('plants')
    .select('id')
    .eq('id', plantCodeOrId)
    .maybeSingle();
  if (byId) {
    plantId = String((byId as any).id);
  } else {
    const { data: byCode } = await supabase
      .from('plants')
      .select('id')
      .eq('eia_plant_code', plantCodeOrId)
      .maybeSingle();
    plantId = byCode ? String((byCode as any).id) : undefined;
  }
  if (!plantId) return { success: false, error: 'Could not resolve plant_id' };

  const { error } = await supabase.rpc('mark_plant_no_lender', {
    p_plant_id: plantId,
    p_note:     note ?? null,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function setLenderPursuitTier(
  canonicalLenderId: string,
  tier: LenderTier | null,
  _notes?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!tier) {
    // v4 has no "clear tier" RPC — delete the pursuit row
    const { error } = await supabase
      .from('lender_pursuits')
      .delete()
      .eq('canonical_lender_id', canonicalLenderId);
    if (error) return { success: false, error: error.message };
    return { success: true };
  }
  const { error } = await supabase.rpc('set_lender_pursuit_tier', {
    p_canonical_lender_id: canonicalLenderId,
    p_tier:                tier,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ──────────────────────────────────────────────────────────────────────────────
// No-lender plants (Not Identified tab)
// ──────────────────────────────────────────────────────────────────────────────

export interface NoLenderPlant {
  plantId: string;
  plantCode: string;
  plantName: string | null;
  state: string | null;
  nameplateMw: number | null;
  isLikelyCurtailed: boolean;
  lastResearchedAt: string | null;
}

export interface NoLenderOptions {
  search?: string;
  sortBy?: 'mw' | 'name' | 'date';
}

export async function fetchNoLenderPlants(opts: NoLenderOptions = {}): Promise<NoLenderPlant[]> {
  const { search, sortBy = 'mw' } = opts;

  const { data, error } = await supabase
    .from('v_plant_research_state')
    .select('plant_id, plant_name, state, nameplate_capacity_mw, is_likely_curtailed, last_researched_at')
    .eq('research_status', 'no_lender_identifiable');

  if (error || !data) {
    console.error('fetchNoLenderPlants:', error?.message);
    return [];
  }

  let rows: NoLenderPlant[] = (data as any[]).map(r => ({
    plantId:          String(r.plant_id ?? ''),
    plantCode:        String(r.plant_id ?? '').replace('EIA-', ''),
    plantName:        (r.plant_name as string | null) ?? null,
    state:            (r.state as string | null) ?? null,
    nameplateMw:      r.nameplate_capacity_mw != null ? Number(r.nameplate_capacity_mw) : null,
    isLikelyCurtailed: Boolean(r.is_likely_curtailed),
    lastResearchedAt: (r.last_researched_at as string | null) ?? null,
  }));

  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(r =>
      r.plantName?.toLowerCase().includes(q) ||
      r.state?.toLowerCase().includes(q) ||
      r.plantCode.includes(q),
    );
  }

  rows.sort((a, b) => {
    if (sortBy === 'name') return (a.plantName ?? '').localeCompare(b.plantName ?? '');
    if (sortBy === 'date') {
      return (b.lastResearchedAt ?? '').localeCompare(a.lastResearchedAt ?? '');
    }
    return (b.nameplateMw ?? 0) - (a.nameplateMw ?? 0);
  });

  return rows;
}
