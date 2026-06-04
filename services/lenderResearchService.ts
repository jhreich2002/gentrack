import { supabase } from './supabaseClient';

export type LastRunBucket = 'any' | 'gt7d' | 'gt30d' | 'never';

export interface PlantLenderEvidenceRow {
  plantId: string;
  lenderName: string;
  role: string | null;
  roleSummary: string | null;
  sourceUrl: string;
  evidenceQuote: string | null;
  inferred: boolean;
  inferredFromSiblingPlantId: string | null;
  lastResearchAt: string | null;
  researchStatus: 'complete' | 'no_lender_identifiable' | 'error' | 'never';
}

export interface AdminPlantRow {
  plantId: string;
  plantName: string;
  state: string | null;
  nameplateMw: number | null;
  isLikelyCurtailed: boolean;
  lastResearchAt: string | null;
  lastStatus: 'complete' | 'no_lender_identifiable' | 'error' | 'never';
  lenderCount: number;
  daysSinceResearch: number | null;
}

export interface MonthlyCostSummary {
  month: string;
  calls: number;
  totalCostUsd: number;
}

export interface TriggerResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  researchId?: string;
  status?: string;
  costUsd?: number;
  lendersInserted?: number;
  siblingsFannedOutTo?: number;
  error?: string;
}

export async function fetchPlantLenderRows(plantId: string): Promise<PlantLenderEvidenceRow[]> {
  const { data, error } = await supabase
    .from('v_plant_financing')
    .select('plant_id, lender_name, role, role_summary, source_url, evidence_quote, inferred, inferred_from_sibling_plant_id, last_research_at, research_status')
    .eq('plant_id', plantId)
    .order('lender_name');

  if (error || !data) {
    console.error('fetchPlantLenderRows:', error?.message);
    return [];
  }

  return (data as any[]).map((row) => ({
    plantId: String(row.plant_id),
    lenderName: String(row.lender_name ?? ''),
    role: row.role ? String(row.role) : null,
    roleSummary: row.role_summary ? String(row.role_summary) : null,
    sourceUrl: String(row.source_url ?? ''),
    evidenceQuote: row.evidence_quote ? String(row.evidence_quote) : null,
    inferred: Boolean(row.inferred),
    inferredFromSiblingPlantId: row.inferred_from_sibling_plant_id ? String(row.inferred_from_sibling_plant_id) : null,
    lastResearchAt: row.last_research_at ? String(row.last_research_at) : null,
    researchStatus: (String(row.research_status ?? 'never') as PlantLenderEvidenceRow['researchStatus']),
  }));
}

export async function fetchAdminPlantState(filters: {
  curtailedOnly: boolean;
  lastRunBucket: LastRunBucket;
  search: string;
}): Promise<AdminPlantRow[]> {
  let query = supabase
    .from('v_admin_plant_research_state')
    .select('plant_id, plant_name, state, nameplate_capacity_mw, is_likely_curtailed, last_research_at, last_status, lender_count, days_since_research')
    .order('plant_name');

  if (filters.curtailedOnly) {
    query = query.eq('is_likely_curtailed', true);
  }

  const { data, error } = await query;
  if (error || !data) {
    console.error('fetchAdminPlantState:', error?.message);
    return [];
  }

  let rows: AdminPlantRow[] = (data as any[]).map((row) => ({
    plantId: String(row.plant_id),
    plantName: String(row.plant_name ?? ''),
    state: row.state ? String(row.state) : null,
    nameplateMw: row.nameplate_capacity_mw != null ? Number(row.nameplate_capacity_mw) : null,
    isLikelyCurtailed: Boolean(row.is_likely_curtailed),
    lastResearchAt: row.last_research_at ? String(row.last_research_at) : null,
    lastStatus: (String(row.last_status ?? 'never') as AdminPlantRow['lastStatus']),
    lenderCount: Number(row.lender_count ?? 0),
    daysSinceResearch: row.days_since_research != null ? Number(row.days_since_research) : null,
  }));

  const searchTerm = filters.search.trim().toLowerCase();
  if (searchTerm) {
    rows = rows.filter((row) => row.plantName.toLowerCase().includes(searchTerm));
  }

  if (filters.lastRunBucket === 'never') {
    rows = rows.filter((row) => row.lastResearchAt === null);
  } else if (filters.lastRunBucket === 'gt7d') {
    rows = rows.filter((row) => row.daysSinceResearch != null && row.daysSinceResearch > 7);
  } else if (filters.lastRunBucket === 'gt30d') {
    rows = rows.filter((row) => row.daysSinceResearch != null && row.daysSinceResearch > 30);
  }

  return rows;
}

export async function fetchMonthlyCost(): Promise<MonthlyCostSummary | null> {
  const { data, error } = await supabase
    .from('v_admin_cost_summary')
    .select('month, calls, total_cost_usd')
    .order('month', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error('fetchMonthlyCost:', error.message);
    return null;
  }

  return {
    month: String(data.month),
    calls: Number((data as any).calls ?? 0),
    totalCostUsd: Number((data as any).total_cost_usd ?? 0),
  };
}

export async function triggerPlantResearch(plantId: string, force: boolean): Promise<TriggerResult> {
  const gate = await supabase.rpc('trigger_plant_research', {
    p_plant_id: plantId,
    p_force: force,
  });

  if (gate.error) {
    return { ok: false, error: gate.error.message };
  }

  const gateData = (gate.data ?? {}) as Record<string, unknown>;
  if (gateData.skipped === true) {
    return {
      ok: true,
      skipped: true,
      reason: String(gateData.reason ?? 'recent_research_exists'),
      researchId: gateData.research_id ? String(gateData.research_id) : undefined,
    };
  }

  const invoked = await supabase.functions.invoke('lender-research-sonar', {
    body: { plant_id: plantId, force },
  });

  if (invoked.error || !invoked.data) {
    return { ok: false, error: invoked.error?.message ?? 'Function invocation failed' };
  }

  const out = invoked.data as Record<string, unknown>;
  return {
    ok: true,
    skipped: false,
    researchId: out.research_id ? String(out.research_id) : undefined,
    status: out.status ? String(out.status) : undefined,
    costUsd: out.cost_usd != null ? Number(out.cost_usd) : undefined,
    lendersInserted: out.lenders_inserted != null ? Number(out.lenders_inserted) : undefined,
    siblingsFannedOutTo: out.siblings_fanned_out_to != null ? Number(out.siblings_fanned_out_to) : undefined,
    error: out.error_detail ? String(out.error_detail) : undefined,
  };
}

// ============================================================
// v5.4 Validation workflow types + functions
// ============================================================

export interface LenderQueueRow {
  lenderId: string;
  lenderName: string;
  pendingCount: number;
  validatedCount: number;
  rejectedCount: number;
  distinctPlantCount: number;
  mostRecentLinkAt: string | null;
}

export interface LenderValidatedRow {
  lenderId: string;
  lenderName: string;
  pursuitLabel: 'hot' | 'warm' | 'cold' | null;
  pursuitSetAt: string | null;
  validatedCount: number;
  distinctValidatedPlantCount: number;
  mostRecentValidationAt: string | null;
}

export interface LenderPlantRow {
  linkId: string;
  lenderId: string;
  plantId: string;
  plantName: string;
  state: string | null;
  nameplateMw: number | null;
  role: string | null;
  roleSummary: string | null;
  sourceUrl: string;
  evidenceQuote: string | null;
  isManual: boolean;
  manualNote: string | null;
  validatedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  validationState: 'pending' | 'validated' | 'rejected';
  lastResearchAt: string | null;
}

export async function fetchLenderValidationQueue(search?: string): Promise<LenderQueueRow[]> {
  const { data, error } = await supabase
    .from('v_lender_validation_queue')
    .select('lender_id, lender_name, pending_count, validated_count, rejected_count, distinct_plant_count, most_recent_link_at')
    .order('pending_count', { ascending: false });

  if (error || !data) {
    console.error('fetchLenderValidationQueue:', error?.message);
    return [];
  }

  let rows: LenderQueueRow[] = (data as any[]).map((row) => ({
    lenderId: String(row.lender_id),
    lenderName: String(row.lender_name ?? ''),
    pendingCount: Number(row.pending_count ?? 0),
    validatedCount: Number(row.validated_count ?? 0),
    rejectedCount: Number(row.rejected_count ?? 0),
    distinctPlantCount: Number(row.distinct_plant_count ?? 0),
    mostRecentLinkAt: row.most_recent_link_at ? String(row.most_recent_link_at) : null,
  }));

  if (search?.trim()) {
    const term = search.trim().toLowerCase();
    rows = rows.filter((r) => r.lenderName.toLowerCase().includes(term));
  }

  return rows;
}

export async function fetchLenderValidatedPortfolio(search?: string): Promise<LenderValidatedRow[]> {
  const { data, error } = await supabase
    .from('v_lender_validated_portfolio')
    .select('lender_id, lender_name, pursuit_label, pursuit_set_at, validated_count, distinct_validated_plant_count, most_recent_validation_at')
    .order('validated_count', { ascending: false });

  if (error || !data) {
    console.error('fetchLenderValidatedPortfolio:', error?.message);
    return [];
  }

  let rows: LenderValidatedRow[] = (data as any[]).map((row) => ({
    lenderId: String(row.lender_id),
    lenderName: String(row.lender_name ?? ''),
    pursuitLabel: row.pursuit_label as LenderValidatedRow['pursuitLabel'] ?? null,
    pursuitSetAt: row.pursuit_set_at ? String(row.pursuit_set_at) : null,
    validatedCount: Number(row.validated_count ?? 0),
    distinctValidatedPlantCount: Number(row.distinct_validated_plant_count ?? 0),
    mostRecentValidationAt: row.most_recent_validation_at ? String(row.most_recent_validation_at) : null,
  }));

  if (search?.trim()) {
    const term = search.trim().toLowerCase();
    rows = rows.filter((r) => r.lenderName.toLowerCase().includes(term));
  }

  return rows;
}

export async function fetchLenderPlants(
  lenderId: string,
  scope: 'pending' | 'validated' | 'all',
): Promise<LenderPlantRow[]> {
  let query = supabase
    .from('v_lender_plant_summary')
    .select('link_id, lender_id, plant_id, plant_name, state, nameplate_capacity_mw, role, role_summary, source_url, evidence_quote, is_manual, manual_note, validated_at, rejected_at, rejection_reason, validation_state, last_research_at')
    .eq('lender_id', lenderId)
    .order('plant_name');

  if (scope !== 'all') {
    query = query.eq('validation_state', scope);
  }

  const { data, error } = await query;
  if (error || !data) {
    console.error('fetchLenderPlants:', error?.message);
    return [];
  }

  return (data as any[]).map((row) => ({
    linkId: String(row.link_id),
    lenderId: String(row.lender_id),
    plantId: String(row.plant_id),
    plantName: String(row.plant_name ?? ''),
    state: row.state ? String(row.state) : null,
    nameplateMw: row.nameplate_capacity_mw != null ? Number(row.nameplate_capacity_mw) : null,
    role: row.role ? String(row.role) : null,
    roleSummary: row.role_summary ? String(row.role_summary) : null,
    sourceUrl: String(row.source_url ?? ''),
    evidenceQuote: row.evidence_quote ? String(row.evidence_quote) : null,
    isManual: Boolean(row.is_manual),
    manualNote: row.manual_note ? String(row.manual_note) : null,
    validatedAt: row.validated_at ? String(row.validated_at) : null,
    rejectedAt: row.rejected_at ? String(row.rejected_at) : null,
    rejectionReason: row.rejection_reason ? String(row.rejection_reason) : null,
    validationState: String(row.validation_state ?? 'pending') as LenderPlantRow['validationState'],
    lastResearchAt: row.last_research_at ? String(row.last_research_at) : null,
  }));
}

export async function validateLink(linkId: string): Promise<void> {
  const { error } = await supabase.rpc('validate_lender_link', { p_link_id: linkId });
  if (error) throw new Error(error.message);
}

export async function rejectLink(linkId: string, reason: string | null): Promise<void> {
  const { error } = await supabase.rpc('reject_lender_link', { p_link_id: linkId, p_reason: reason ?? null });
  if (error) throw new Error(error.message);
}

export async function addManualLink(input: {
  plantId: string;
  lenderName: string;
  role: string | null;
  sourceUrl: string;
  evidenceQuote: string | null;
  manualNote: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('add_manual_lender_link', {
    p_plant_id: input.plantId,
    p_lender_name: input.lenderName,
    p_role: input.role ?? null,
    p_source_url: input.sourceUrl,
    p_evidence_quote: input.evidenceQuote ?? null,
    p_manual_note: input.manualNote ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function setLenderPursuit(
  lenderId: string,
  label: 'hot' | 'warm' | 'cold' | null,
): Promise<void> {
  const { error } = await supabase.rpc('set_lender_pursuit', {
    p_lender_id: lenderId,
    p_label: label,
  });
  if (error) throw new Error(error.message);
}
