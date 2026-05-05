/**
 * GenTrack — uccResearchService
 *
 * Data access layer for the UCC Lender Research workflow.
 * Reads from all ucc_* tables and invokes the ucc-supervisor edge function.
 */

import { supabase } from './supabaseClient';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WorkflowStatus = 'pending' | 'running' | 'complete' | 'unresolved' | 'needs_review' | 'partial' | 'budget_exceeded';
export type ConfidenceClass = 'confirmed' | 'highly_likely' | 'possible';

export interface UCCResearchPlant {
  plant_code:       string;
  plant_name:       string;
  state:            string;
  sponsor_name:     string | null;
  workflow_status:  WorkflowStatus;
  last_run_at:      string | null;
  total_cost_usd:   number | null;
  // Joined from plants table
  capacity_mw:      number | null;
  technology:       string | null;
  county:           string | null;
  cod_year:         number | null;
}

export interface UCCLenderLink {
  id:               number;
  plant_code:       string;
  lender_entity_id: number;
  confidence_class: ConfidenceClass;
  evidence_type:    'direct' | 'inferred';
  evidence_summary: string;
  source_url:       string | null;
  human_approved:   boolean;
  run_id:           string | null;
  pitch_ready:      boolean;
  pitch_ready_by:   string | null;
  pitch_ready_at:   string | null;
  pitch_ready_note: string | null;
  role_tag:              string;
  estimated_loan_status: 'active' | 'likely_matured' | 'unknown';
  // Joined
  lender_name:           string;
  lender_normalized:     string;
}

export interface UCCUnverifiedLead {
  id:                number;
  plant_code:        string;
  lender_entity_id:  number | null;
  lender_name:       string;
  lender_normalized: string;
  confidence_class:  'possible' | 'highly_likely';
  evidence_type:     'inferred' | 'sponsor_pattern' | 'web_scrape' | 'llm_inference' | 'news';
  evidence_summary:  string | null;
  source_url:        string | null;
  source_types:      string[];
  llm_model:         string | null;
  llm_prompt_hash:   string | null;
  run_id:               string | null;
  human_approved:       boolean;
  created_at:           string;
  estimated_loan_status:'active' | 'likely_matured' | 'unknown';
}

export interface UCCPitchReadyLead {
  lender_link_id:    number;
  plant_code:        string;
  plant_name:        string;
  state:             string;
  capacity_mw:       number | null;
  sponsor_name:      string | null;
  lender_entity_id:  number;
  lender_name:       string;
  confidence_class:  ConfidenceClass;
  evidence_type:     string;
  evidence_summary:  string | null;
  source_url:        string | null;
  pitch_ready_by:    string | null;
  pitch_ready_at:    string | null;
  pitch_ready_note:  string | null;
  updated_at:        string;
}

export interface UCCEvidenceProvenanceRow {
  source_type:        string;
  worker_name:        string;
  evidence_count:     number;
  with_source_url:    number;
  with_trusted_url:   number;
  distinct_plants:    number;
  distinct_runs:      number;
  first_seen:         string | null;
  last_seen:          string | null;
}

export interface UCCStateScraperHealthRow {
  state:                          string;
  plants_with_evidence:           number;
  plants_with_ucc_hit:            number;
  plants_with_llm_fallback_only:  number;
  ucc_evidence_records:           number;
  llm_evidence_records:           number;
  ucc_with_trusted_url:           number;
  last_evidence_at:               string | null;
}

export interface UCCEvidenceRecord {
  id:                      number;
  plant_code:              string;
  source_type:             string;
  source_url:              string | null;
  excerpt:                 string;
  raw_text:                string | null;
  confidence_contribution: string;
  worker_name:             string;
  extracted_fields:        Record<string, unknown>;
  lender_entity_id:        number | null;
  lender_name:             string | null;
}

export interface UCCAgentRun {
  id:                string;
  plant_code:        string;
  supervisor_status: string;
  started_at:        string;
  completed_at:      string | null;
  final_outcome:     string | null;
  total_cost_usd:    number | null;
}

export interface UCCAgentTask {
  id:                number;
  run_id:            string;
  plant_code:        string;
  agent_type:        string;
  attempt_number:    number;
  task_status:       string;
  completion_score:  number;
  evidence_found:    boolean;
  llm_fallback_used: boolean;
  cost_usd:          number;
  duration_ms:       number;
  output_json:       Record<string, unknown> | null;
}

export interface UCCEntity {
  id:              number;
  entity_name:     string;
  entity_type:     string;
  normalized_name: string;
  jurisdiction:    string | null;
  source:          string | null;
  source_url:      string | null;
}

export interface LenderLeadSummary {
  lender_entity_id:  number;
  lender_name:       string;
  normalized_name:   string;
  plant_count:       number;
  confirmed_count:   number;
  inferred_count:    number;
  states:            string[];
  sponsors:          string[];
}

export interface ReviewQueueItem {
  plant_code:        string;
  plant_name:        string;
  state:             string;
  sponsor_name:      string | null;
  run_id:            string | null;
  lender_link_id:    number;
  lender_name:       string;
  confidence_class:  ConfidenceClass;
  evidence_summary:  string;
  source_url:        string | null;
  human_approved:    boolean;
}

export interface SupervisorResult {
  status:            string;
  plants_processed:  number;
  completed:         number;
  needs_review:      number;
  budget_exceeded:   number;
  unresolved:        number;
  total_cost_usd:    number;
  budget_remaining:  number;
  duration_ms:       number;
  results:           Array<{ plant_code: string; outcome: string; cost: number; debug?: string }>;
}

// ── Plants ────────────────────────────────────────────────────────────────────

export async function fetchUCCResearchPlants(filters?: {
  state?:           string;
  workflow_status?: WorkflowStatus;
  search?:          string;
}): Promise<UCCResearchPlant[]> {
  // Join ucc_research_plants with plants for capacity/tech/county
  // ucc_research_plants has all needed columns (seeded from plants table)
  let query = supabase
    .from('ucc_research_plants')
    .select('plant_code, plant_name, state, county, capacity_mw, fuel_type, cod_year, sponsor_name, workflow_status, last_run_at, total_cost_usd')
    .order('last_run_at', { ascending: false, nullsFirst: false });

  if (filters?.state)           query = query.eq('state', filters.state);
  if (filters?.workflow_status) query = query.eq('workflow_status', filters.workflow_status);
  if (filters?.search) {
    query = query.or(
      `plant_name.ilike.%${filters.search}%,sponsor_name.ilike.%${filters.search}%`
    );
  }

  const { data, error } = await query.limit(500);
  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => ({
    plant_code:      String(row.plant_code ?? ''),
    plant_name:      String(row.plant_name ?? ''),
    state:           String(row.state ?? ''),
    sponsor_name:    row.sponsor_name ? String(row.sponsor_name) : null,
    workflow_status: (row.workflow_status ?? 'pending') as WorkflowStatus,
    last_run_at:     row.last_run_at ? String(row.last_run_at) : null,
    total_cost_usd:  row.total_cost_usd != null ? Number(row.total_cost_usd) : null,
    capacity_mw:     row.capacity_mw != null ? Number(row.capacity_mw) : null,
    technology:      row.fuel_type ? String(row.fuel_type) : null,
    county:          row.county ? String(row.county) : null,
    cod_year:        row.cod_year != null ? Number(row.cod_year) : null,
  }));
}

// Ensure a plant row exists in ucc_research_plants (auto-seed from plants table)
export async function ensurePlantResearchRecord(plantCode: string): Promise<void> {
  const { data: existing } = await supabase
    .from('ucc_research_plants')
    .select('plant_code')
    .eq('plant_code', plantCode)
    .maybeSingle();

  if (existing) return;

  const { data: plant } = await supabase
    .from('plants')
    .select('eia_plant_code, name, state, county, nameplate_capacity_mw, fuel_source, cod, owner')
    .eq('eia_plant_code', plantCode)
    .maybeSingle();

  if (!plant) return;

  const p = plant as Record<string, unknown>;
  const cod     = p.cod ? String(p.cod) : null;
  const codYear = cod ? parseInt(cod.slice(0, 4), 10) : null; // handles YYYY, YYYY-MM, YYYY-MM-DD

  await supabase.from('ucc_research_plants').insert({
    plant_code:      String(p.eia_plant_code ?? plantCode),
    plant_name:      String(p.name ?? ''),
    state:           String(p.state ?? ''),
    county:          p.county ? String(p.county) : null,
    capacity_mw:     p.nameplate_capacity_mw != null ? Number(p.nameplate_capacity_mw) : null,
    fuel_type:       p.fuel_source ? String(p.fuel_source) : null,
    cod_year:        codYear && !isNaN(codYear) ? codYear : null,
    sponsor_name:    p.owner ? String(p.owner) : null,
    workflow_status: 'pending',
  });
}

// ── Lender links ──────────────────────────────────────────────────────────────

export async function fetchLenderLinks(plantCode: string): Promise<UCCLenderLink[]> {
  const { data, error } = await supabase
    .from('ucc_lender_links')
    .select(`
      id, plant_code, lender_entity_id, confidence_class,
      evidence_type, evidence_summary, source_url, human_approved, run_id,
      pitch_ready, pitch_ready_by, pitch_ready_at, pitch_ready_note,
      role_tag, estimated_loan_status,
      ucc_entities!lender_entity_id (
        entity_name, normalized_name
      )
    `)
    .eq('plant_code', plantCode)
    .order('confidence_class');

  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => {
    const entity = (row.ucc_entities as Record<string, unknown>) ?? {};
    return {
      id:               Number(row.id),
      plant_code:       String(row.plant_code ?? ''),
      lender_entity_id: Number(row.lender_entity_id),
      confidence_class: (row.confidence_class ?? 'possible') as ConfidenceClass,
      evidence_type:    (row.evidence_type ?? 'inferred') as 'direct' | 'inferred',
      evidence_summary: String(row.evidence_summary ?? ''),
      source_url:       row.source_url ? String(row.source_url) : null,
      human_approved:   Boolean(row.human_approved),
      run_id:           row.run_id ? String(row.run_id) : null,
      pitch_ready:      Boolean(row.pitch_ready),
      pitch_ready_by:   row.pitch_ready_by ? String(row.pitch_ready_by) : null,
      pitch_ready_at:   row.pitch_ready_at ? String(row.pitch_ready_at) : null,
      pitch_ready_note: row.pitch_ready_note ? String(row.pitch_ready_note) : null,
      lender_name:           String(entity.entity_name ?? ''),
      lender_normalized:     String(entity.normalized_name ?? ''),
      role_tag:              String(row.role_tag ?? 'unknown'),
      estimated_loan_status: (row.estimated_loan_status ?? 'unknown') as 'active' | 'likely_matured' | 'unknown',
    };
  });
}

// ── Unverified leads (LLM/news/perplexity-only evidence) ─────────────────────

export async function fetchUnverifiedLeads(plantCode?: string): Promise<UCCUnverifiedLead[]> {
  let query = supabase
    .from('ucc_lender_leads_unverified')
    .select('id, plant_code, lender_entity_id, lender_name, lender_normalized, confidence_class, evidence_type, evidence_summary, source_url, source_types, llm_model, llm_prompt_hash, run_id, human_approved, created_at, estimated_loan_status')
    .order('created_at', { ascending: false })
    .limit(500);

  if (plantCode) query = query.eq('plant_code', plantCode);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((r: Record<string, unknown>) => ({
    id:                Number(r.id),
    plant_code:        String(r.plant_code ?? ''),
    lender_entity_id:  r.lender_entity_id != null ? Number(r.lender_entity_id) : null,
    lender_name:       String(r.lender_name ?? ''),
    lender_normalized: String(r.lender_normalized ?? ''),
    confidence_class:  (r.confidence_class ?? 'possible') as 'possible' | 'highly_likely',
    evidence_type:     (r.evidence_type ?? 'inferred') as UCCUnverifiedLead['evidence_type'],
    evidence_summary:  r.evidence_summary ? String(r.evidence_summary) : null,
    source_url:        r.source_url ? String(r.source_url) : null,
    source_types:      Array.isArray(r.source_types) ? r.source_types as string[] : [],
    llm_model:         r.llm_model ? String(r.llm_model) : null,
    llm_prompt_hash:   r.llm_prompt_hash ? String(r.llm_prompt_hash) : null,
    run_id:               r.run_id ? String(r.run_id) : null,
    human_approved:       Boolean(r.human_approved),
    created_at:           String(r.created_at ?? ''),
    estimated_loan_status:(r.estimated_loan_status ?? 'unknown') as 'active' | 'likely_matured' | 'unknown',
  }));
}

// ── Pitch-ready leads (the partner-facing list) ──────────────────────────────

export async function fetchPitchReadyLeads(): Promise<UCCPitchReadyLead[]> {
  const { data, error } = await supabase
    .from('ucc_pitch_ready_leads')
    .select('*')
    .order('pitch_ready_at', { ascending: false });

  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => ({
    lender_link_id:   Number(r.lender_link_id),
    plant_code:       String(r.plant_code ?? ''),
    plant_name:       String(r.plant_name ?? ''),
    state:            String(r.state ?? ''),
    capacity_mw:      r.capacity_mw != null ? Number(r.capacity_mw) : null,
    sponsor_name:     r.sponsor_name ? String(r.sponsor_name) : null,
    lender_entity_id: Number(r.lender_entity_id),
    lender_name:      String(r.lender_name ?? ''),
    confidence_class: (r.confidence_class ?? 'confirmed') as ConfidenceClass,
    evidence_type:    String(r.evidence_type ?? ''),
    evidence_summary: r.evidence_summary ? String(r.evidence_summary) : null,
    source_url:       r.source_url ? String(r.source_url) : null,
    pitch_ready_by:   r.pitch_ready_by ? String(r.pitch_ready_by) : null,
    pitch_ready_at:   r.pitch_ready_at ? String(r.pitch_ready_at) : null,
    pitch_ready_note: r.pitch_ready_note ? String(r.pitch_ready_note) : null,
    updated_at:       String(r.updated_at ?? ''),
  }));
}

// Mark / unmark pitch-ready (admin only — RPC enforces role + citation rules)
export async function markPitchReady(
  lenderLinkId: number,
  ready:        boolean,
  note?:        string | null,
): Promise<UCCLenderLink> {
  const { data, error } = await supabase.rpc('mark_pitch_ready', {
    p_link_id: lenderLinkId,
    p_ready:   ready,
    p_note:    note ?? null,
  });
  if (error) throw new Error(error.message);

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
  return {
    id:               Number(row.id),
    plant_code:       String(row.plant_code ?? ''),
    lender_entity_id: Number(row.lender_entity_id),
    confidence_class: (row.confidence_class ?? 'possible') as ConfidenceClass,
    evidence_type:    (row.evidence_type ?? 'inferred') as 'direct' | 'inferred',
    evidence_summary: String(row.evidence_summary ?? ''),
    source_url:       row.source_url ? String(row.source_url) : null,
    human_approved:   Boolean(row.human_approved),
    run_id:           row.run_id ? String(row.run_id) : null,
    pitch_ready:      Boolean(row.pitch_ready),
    pitch_ready_by:   row.pitch_ready_by ? String(row.pitch_ready_by) : null,
    pitch_ready_at:   row.pitch_ready_at ? String(row.pitch_ready_at) : null,
    pitch_ready_note: row.pitch_ready_note ? String(row.pitch_ready_note) : null,
    lender_name:      String(row.lender_name ?? ''),
    lender_normalized:String(row.lender_normalized ?? ''),
  };
}

// ── Provenance audit views ───────────────────────────────────────────────────

export async function fetchEvidenceProvenance(): Promise<UCCEvidenceProvenanceRow[]> {
  const { data, error } = await supabase
    .from('ucc_evidence_provenance_summary')
    .select('*');
  if (error) throw error;
  return (data ?? []) as UCCEvidenceProvenanceRow[];
}

export async function fetchStateScraperHealth(): Promise<UCCStateScraperHealthRow[]> {
  const { data, error } = await supabase
    .from('ucc_state_scraper_health')
    .select('*');
  if (error) throw error;
  return (data ?? []) as UCCStateScraperHealthRow[];
}

// ── Evidence records ──────────────────────────────────────────────────────────

export async function fetchEvidenceRecords(
  plantCode: string,
  lenderEntityId?: number,
): Promise<UCCEvidenceRecord[]> {
  let query = supabase
    .from('ucc_evidence_records')
    .select(`
      id, plant_code, source_type, source_url, excerpt, raw_text,
      confidence_contribution, worker_name, extracted_fields, lender_entity_id,
      ucc_entities!lender_entity_id (entity_name)
    `)
    .eq('plant_code', plantCode)
    .order('id', { ascending: false });

  if (lenderEntityId != null) {
    query = query.eq('lender_entity_id', lenderEntityId);
  }

  const { data, error } = await query.limit(100);
  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => {
    const entity = (row.ucc_entities as Record<string, unknown>) ?? {};
    return {
      id:                      Number(row.id),
      plant_code:              String(row.plant_code ?? ''),
      source_type:             String(row.source_type ?? ''),
      source_url:              row.source_url ? String(row.source_url) : null,
      excerpt:                 String(row.excerpt ?? ''),
      raw_text:                row.raw_text ? String(row.raw_text) : null,
      confidence_contribution: String(row.confidence_contribution ?? ''),
      worker_name:             String(row.worker_name ?? ''),
      extracted_fields:        (row.extracted_fields ?? {}) as Record<string, unknown>,
      lender_entity_id:        row.lender_entity_id != null ? Number(row.lender_entity_id) : null,
      lender_name:             entity.entity_name ? String(entity.entity_name) : null,
    };
  });
}

// ── Run history ───────────────────────────────────────────────────────────────

export async function fetchAgentRuns(plantCode: string): Promise<UCCAgentRun[]> {
  const { data, error } = await supabase
    .from('ucc_agent_runs')
    .select('id, plant_code, supervisor_status, started_at, completed_at, final_outcome, total_cost_usd')
    .eq('plant_code', plantCode)
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) throw error;
  return (data ?? []) as UCCAgentRun[];
}

export async function fetchAgentTasks(runId: string): Promise<UCCAgentTask[]> {
  const { data, error } = await supabase
    .from('ucc_agent_tasks')
    .select('id, run_id, plant_code, agent_type, attempt_number, task_status, completion_score, evidence_found, llm_fallback_used, cost_usd, duration_ms, output_json')
    .eq('run_id', runId)
    .order('id');

  if (error) throw error;
  return (data ?? []) as UCCAgentTask[];
}

// ── Lender leads (aggregated) ─────────────────────────────────────────────────

export async function fetchLenderLeads(): Promise<LenderLeadSummary[]> {
  // Two queries — no FK between lender_links.plant_code and ucc_research_plants
  const [{ data: links }, { data: researchPlants }] = await Promise.all([
    supabase
      .from('ucc_lender_links')
      .select('lender_entity_id, plant_code, confidence_class, ucc_entities!lender_entity_id (entity_name, normalized_name)'),
    supabase
      .from('ucc_research_plants')
      .select('plant_code, state, sponsor_name'),
  ]);

  const plantMap = new Map<string, { state: string; sponsor_name: string | null }>(
    (researchPlants ?? []).map((r: Record<string, unknown>) => [
      String(r.plant_code),
      { state: String(r.state ?? ''), sponsor_name: r.sponsor_name ? String(r.sponsor_name) : null },
    ])
  );

  const byLender = new Map<number, LenderLeadSummary>();

  for (const row of (links ?? []) as Array<Record<string, unknown>>) {
    const entityId = Number(row.lender_entity_id);
    const entity   = (row.ucc_entities as Record<string, unknown>) ?? {};
    const plantInfo = plantMap.get(String(row.plant_code ?? ''));

    if (!byLender.has(entityId)) {
      byLender.set(entityId, {
        lender_entity_id: entityId,
        lender_name:      String(entity.entity_name ?? ''),
        normalized_name:  String(entity.normalized_name ?? ''),
        plant_count:      0,
        confirmed_count:  0,
        inferred_count:   0,
        states:           [],
        sponsors:         [],
      });
    }

    const lead = byLender.get(entityId)!;
    lead.plant_count++;

    if (row.confidence_class === 'confirmed') lead.confirmed_count++;
    else lead.inferred_count++;

    if (plantInfo?.state && !lead.states.includes(plantInfo.state)) lead.states.push(plantInfo.state);
    if (plantInfo?.sponsor_name && !lead.sponsors.includes(plantInfo.sponsor_name)) lead.sponsors.push(plantInfo.sponsor_name);
  }

  return [...byLender.values()].sort((a, b) => b.plant_count - a.plant_count);
}

// ── Review queue ──────────────────────────────────────────────────────────────

export async function fetchReviewQueue(): Promise<ReviewQueueItem[]> {
  // Include any link that is either:
  //   - inferred / possible-tier and not yet human-approved (the legacy review queue), OR
  //   - confirmed but not yet pitch_ready (awaiting admin sign-off for partner outreach)
  const { data: links, error } = await supabase
    .from('ucc_lender_links')
    .select('id, plant_code, lender_entity_id, confidence_class, evidence_summary, source_url, human_approved, pitch_ready, run_id, ucc_entities!lender_entity_id (entity_name)')
    .or('and(human_approved.eq.false,confidence_class.in.(possible,highly_likely)),and(confidence_class.eq.confirmed,pitch_ready.eq.false)')
    .order('confidence_class')
    .order('plant_code');

  if (error) throw error;
  if (!links?.length) return [];

  // Fetch plant info separately (no FK declared)
  const plantCodes = [...new Set((links as Array<Record<string, unknown>>).map(r => String(r.plant_code ?? '')))];
  const { data: researchPlants } = await supabase
    .from('ucc_research_plants')
    .select('plant_code, plant_name, state, sponsor_name')
    .in('plant_code', plantCodes);

  const plantMap = new Map<string, Record<string, unknown>>(
    (researchPlants ?? []).map((r: Record<string, unknown>) => [String(r.plant_code), r])
  );

  return (links as Array<Record<string, unknown>>).map(row => {
    const entity    = (row.ucc_entities as Record<string, unknown>) ?? {};
    const plantInfo = plantMap.get(String(row.plant_code ?? '')) ?? {};
    return {
      plant_code:       String(row.plant_code ?? ''),
      plant_name:       String(plantInfo.plant_name ?? ''),
      state:            String(plantInfo.state ?? ''),
      sponsor_name:     plantInfo.sponsor_name ? String(plantInfo.sponsor_name) : null,
      run_id:           row.run_id ? String(row.run_id) : null,
      lender_link_id:   Number(row.id),
      lender_name:      String(entity.entity_name ?? ''),
      confidence_class: (row.confidence_class ?? 'possible') as ConfidenceClass,
      evidence_summary: String(row.evidence_summary ?? ''),
      source_url:       row.source_url ? String(row.source_url) : null,
      human_approved:   Boolean(row.human_approved),
    };
  });
}

export async function submitReviewAction(
  lenderLinkId: number,
  plantCode:    string,
  action:       'approve' | 'reject' | 'rerun' | 'needs_more',
  notes?:       string,
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();

  await supabase.from('ucc_review_actions').insert({
    plant_code:     plantCode,
    lender_link_id: lenderLinkId,
    action,
    notes:          notes ?? null,
    reviewer_email: user?.email ?? null,
    timestamp:      new Date().toISOString(),
  });

  if (action === 'approve') {
    await supabase.from('ucc_lender_links')
      .update({ human_approved: true })
      .eq('id', lenderLinkId);
  }
}

// ── Supervisor invocation ─────────────────────────────────────────────────────

export async function runSinglePlantResearch(plantCode: string, budgetUsd?: number): Promise<SupervisorResult> {
  const { data: { session } } = await supabase.auth.getSession();

  const resp = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ucc-supervisor`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        mode:       'single',
        plant_code: plantCode,
        ...(budgetUsd != null ? { budget_usd: budgetUsd } : {}),
      }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supervisor error: ${resp.status} ${text.slice(0, 200)}`);
  }

  return resp.json();
}

export async function runBatchResearch(options?: {
  state?:      string;
  min_mw?:     number;
  max_plants?: number;
  budget_usd?: number;
}): Promise<SupervisorResult> {
  const { data: { session } } = await supabase.auth.getSession();

  const resp = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ucc-supervisor`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        mode:       'batch',
        filters:    options,
        budget_usd: options?.budget_usd ?? 5.00,
      }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supervisor error: ${resp.status} ${text.slice(0, 200)}`);
  }

  return resp.json();
}

// ── Plant aliases (for detail view) ──────────────────────────────────────────

export async function fetchPlantAliases(plantCode: string): Promise<Array<{
  entity_name:     string;
  entity_type:     string;
  confidence_score: number;
  source:          string | null;
  source_url:      string | null;
}>> {
  const { data, error } = await supabase
    .from('ucc_plant_entities')
    .select(`
      confidence_score,
      ucc_entities!entity_id (
        entity_name, entity_type, source, source_url
      )
    `)
    .eq('plant_code', plantCode)
    .order('confidence_score', { ascending: false });

  if (error) return [];

  return (data ?? []).map((row: Record<string, unknown>) => {
    const entity = (row.ucc_entities as Record<string, unknown>) ?? {};
    return {
      entity_name:      String(entity.entity_name ?? ''),
      entity_type:      String(entity.entity_type ?? ''),
      confidence_score: Number(row.confidence_score ?? 0),
      source:           entity.source ? String(entity.source) : null,
      source_url:       entity.source_url ? String(entity.source_url) : null,
    };
  });
}
