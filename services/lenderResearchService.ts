/**
 * GenTrack — lenderResearchService (v4)
 *
 * Admin-triggered research flows. Calls the lender-research-orchestrator
 * edge function for single and bulk plant research runs.
 *
 * Separate from lenderValidationService which owns the human review RPCs.
 */

import { supabase } from './supabaseClient';

const ORCHESTRATOR_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/lender-research-orchestrator`;

async function orchHeaders(): Promise<Record<string, string> | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('orchHeaders session error:', error.message);
    return null;
  }
  const accessToken = data.session?.access_token;
  if (!accessToken) return null;

  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${accessToken}`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type ResearchStatus =
  | 'never'
  | 'in_progress'
  | 'complete'
  | 'budget_exceeded'
  | 'failed'
  | 'no_lender_identifiable';

export interface PlantResearchState {
  plantId:              string;
  plantName:            string;
  state:                string | null;
  nameplateMw:          number | null;
  isLikelyCurtailed:    boolean;
  researchStatus:       ResearchStatus;
  lastResearchedAt:     string | null;
  validatedCount:       number;
  pendingCount:         number;
  lastSessionCostUsd:   number | null;
  budgetExceeded:       boolean;
}

export interface ResearchCostRow {
  month:              string;
  sessions:           number;
  totalCostUsd:       number;
  avgCostUsd:         number;
  budgetExceededCount: number;
}

export interface ResearchRunResult {
  ok:             boolean;
  session_id?:    string;
  status?:        string;
  links_created?: number;
  cost_usd?:      number;
  budget_exceeded?: boolean;
  error?:         string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Fetch plant research state (Admin panel table)
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchPlantResearchState(opts: {
  curtailedOnly?: boolean;
  statusFilter?:  ResearchStatus | 'all';
  search?:        string;
} = {}): Promise<PlantResearchState[]> {
  const { curtailedOnly = false, statusFilter = 'all', search } = opts;

  let q = supabase
    .from('v_plant_research_state')
    .select('plant_id, plant_name, state, nameplate_capacity_mw, is_likely_curtailed, research_status, last_researched_at, validated_count, pending_count, last_session_cost_usd, budget_exceeded');

  if (curtailedOnly) q = q.eq('is_likely_curtailed', true);
  if (statusFilter !== 'all') q = q.eq('research_status', statusFilter);

  const { data, error } = await q.order('plant_name');

  if (error || !data) {
    console.error('fetchPlantResearchState:', error?.message);
    return [];
  }

  let rows: PlantResearchState[] = (data as any[]).map(r => ({
    plantId:           String(r.plant_id),
    plantName:         String(r.plant_name ?? ''),
    state:             (r.state as string | null) ?? null,
    nameplateMw:       r.nameplate_capacity_mw != null ? Number(r.nameplate_capacity_mw) : null,
    isLikelyCurtailed: Boolean(r.is_likely_curtailed),
    researchStatus:    (r.research_status as ResearchStatus) ?? 'never',
    lastResearchedAt:  (r.last_researched_at as string | null) ?? null,
    validatedCount:    Number(r.validated_count) || 0,
    pendingCount:      Number(r.pending_count) || 0,
    lastSessionCostUsd: r.last_session_cost_usd != null ? Number(r.last_session_cost_usd) : null,
    budgetExceeded:    Boolean(r.budget_exceeded),
  }));

  if (search) {
    const q2 = search.toLowerCase();
    rows = rows.filter(r => r.plantName.toLowerCase().includes(q2));
  }

  return rows;
}

// ──────────────────────────────────────────────────────────────────────────────
// Fetch cost dashboard (admin-only)
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchAdminResearchCosts(): Promise<ResearchCostRow[]> {
  const { data, error } = await supabase
    .from('v_admin_research_costs')
    .select('month, sessions, total_cost_usd, avg_cost_usd, budget_exceeded_count');

  if (error || !data) {
    console.error('fetchAdminResearchCosts:', error?.message);
    return [];
  }

  return (data as any[]).map(r => ({
    month:               String(r.month ?? ''),
    sessions:            Number(r.sessions) || 0,
    totalCostUsd:        Number(r.total_cost_usd) || 0,
    avgCostUsd:          Number(r.avg_cost_usd) || 0,
    budgetExceededCount: Number(r.budget_exceeded_count) || 0,
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Trigger research for a single plant
// ──────────────────────────────────────────────────────────────────────────────

export async function triggerPlantResearch(
  plantId:    string,
  budgetUsd?: number,
  trigger?:   'initial' | 'refresh' | 'manual',
): Promise<ResearchRunResult> {
  try {
    const headers = await orchHeaders();
    if (!headers) {
      return { ok: false, error: 'Not signed in' };
    }

    const resp = await fetch(ORCHESTRATOR_URL, {
      method:  'POST',
      headers,
      body: JSON.stringify({
        plant_id:   plantId,
        budget_usd: budgetUsd ?? 0.25,
        trigger:    trigger ?? 'manual',
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return { ok: false, error: err.slice(0, 200) };
    }

    return await resp.json() as ResearchRunResult;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Trigger research for multiple plants (sequential to control cost)
// ──────────────────────────────────────────────────────────────────────────────

export async function triggerBulkResearch(
  plantIds:   string[],
  budgetUsd?: number,
  onProgress?: (completed: number, total: number, latest: ResearchRunResult) => void,
): Promise<{ succeeded: number; failed: number; totalCostUsd: number }> {
  let succeeded   = 0;
  let failed      = 0;
  let totalCost   = 0;

  for (let i = 0; i < plantIds.length; i++) {
    const result = await triggerPlantResearch(plantIds[i], budgetUsd, 'initial');
    if (result.ok) {
      succeeded++;
      totalCost += result.cost_usd ?? 0;
    } else {
      failed++;
    }
    onProgress?.(i + 1, plantIds.length, result);
  }

  return { succeeded, failed, totalCostUsd: totalCost };
}
