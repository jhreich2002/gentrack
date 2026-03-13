/**
 * GenTrack — companyService
 *
 * Client-side data functions for the Company Detail Panel:
 *   fetchCompanyStats      — reads company_stats row for a given ult_parent
 *   fetchCompanyPlants     — reads plants owned by a given ult_parent (joined from plant_ownership + plants)
 *   callCompanyAnalyze     — calls company-analyze Edge Function (on-demand Gemini briefing)
 */

import { supabase } from './supabaseClient';
import { CompanyStats } from '../types';

// ── CompanyPlant interface (for Portfolio tab) ────────────────────────────────

export interface CompanyPlant {
  eiaPlantCode:       string;
  plantName:          string;
  plantKey:           string | null;
  techType:           string | null;
  state:              string | null;
  region:             string | null;
  nameplateMw:        number;
  ttmAvgFactor:       number;
  curtailmentScore:   number;
  isLikelyCurtailed:  boolean;
  ownershipPct:       number | null;
  ownStatus:          string | null;
  ppaCounterparty:    string | null;
  ppaExpirationDate:  string | null;
}

// ── fetchCompanyPlants ────────────────────────────────────────────────────────

/**
 * Returns all plants owned by a given ult_parent (ultimate parent company).
 * Joins plant_ownership with plants table to get operational stats.
 */
export async function fetchCompanyPlants(
  ultParentName: string
): Promise<CompanyPlant[]> {
  // First get all plant codes owned by this company
  const { data: ownership, error: ownershipErr } = await supabase
    .from('plant_ownership')
    .select('eia_site_code, power_plant, plant_key, tech_type, oper_own, own_status, largest_ppa_counterparty, largest_ppa_contracted_expiration_date')
    .eq('ult_parent', ultParentName);

  if (ownershipErr || !ownership || ownership.length === 0) {
    console.error('fetchCompanyPlants ownership error:', ownershipErr?.message);
    return [];
  }

  const plantCodes = ownership.map(o => o.eia_site_code);

  // Fetch plant details for those codes
  const { data: plants, error: plantsErr } = await supabase
    .from('plants')
    .select('eia_plant_code, name, state, region, nameplate_capacity_mw, ttm_avg_factor, curtailment_score, is_likely_curtailed')
    .in('eia_plant_code', plantCodes);

  if (plantsErr) {
    console.error('fetchCompanyPlants plants error:', plantsErr.message);
    return [];
  }

  // Build a map of plant data keyed by eia_plant_code
  const plantMap = new Map<string, Record<string, unknown>>();
  for (const p of plants ?? []) {
    plantMap.set(p.eia_plant_code, p);
  }

  // Merge ownership + plant data
  return ownership.map(o => {
    const p = plantMap.get(o.eia_site_code);
    return {
      eiaPlantCode:       o.eia_site_code,
      plantName:          o.power_plant ?? (p?.name as string) ?? o.eia_site_code,
      plantKey:           o.plant_key,
      techType:           o.tech_type,
      state:              (p?.state as string) ?? null,
      region:             (p?.region as string) ?? null,
      nameplateMw:        Number(p?.nameplate_capacity_mw) || 0,
      ttmAvgFactor:       Number(p?.ttm_avg_factor) || 0,
      curtailmentScore:   Number(p?.curtailment_score) || 0,
      isLikelyCurtailed:  Boolean(p?.is_likely_curtailed),
      ownershipPct:       o.oper_own != null ? Number(o.oper_own) : null,
      ownStatus:          o.own_status,
      ppaCounterparty:    o.largest_ppa_counterparty,
      ppaExpirationDate:  o.largest_ppa_contracted_expiration_date,
    };
  }).sort((a, b) => b.nameplateMw - a.nameplateMw);
}

// ── fetchCompanyStats ─────────────────────────────────────────────────────────

export async function fetchCompanyStats(
  ultParentName: string
): Promise<CompanyStats | null> {
  const { data, error } = await supabase
    .from('company_stats')
    .select('*')
    .eq('ult_parent_name', ultParentName)
    .single();

  if (error || !data) return null;

  return mapRow(data);
}

// ── fetchAllCompanyStats ──────────────────────────────────────────────────────

/**
 * Returns all company_stats rows for the Prospecting Dashboard.
 * Only fetches the columns needed for the screening table to keep payload small.
 * Filters out entries with 0 plants (ISOs, market operators, etc.).
 */
export async function fetchAllCompanyStats(): Promise<CompanyStats[]> {
  const { data, error } = await supabase
    .from('company_stats')
    .select('*')
    .gt('plant_count', 0)
    .order('computed_at', { ascending: false });

  if (error || !data) {
    console.error('fetchAllCompanyStats error:', error?.message);
    return [];
  }

  return data.map(mapRow);
}

// ── mapRow helper ─────────────────────────────────────────────────────────────

function mapRow(data: Record<string, unknown>): CompanyStats {
  return {
    ultParentName:         data.ult_parent_name as string,
    totalMw:               Number(data.total_mw)    || 0,
    plantCount:            Number(data.plant_count)  || 0,
    avgCf:                 Number(data.avg_cf)       || 0,
    techBreakdown:         (data.tech_breakdown    as Record<string, number>) ?? {},
    stateBreakdown:        (data.state_breakdown   as Record<string, number>) ?? {},
    eventCounts:           (data.event_counts      as Record<string, number>) ?? {},
    relevanceScores:       (data.relevance_scores  as Record<string, number>) ?? {},
    computedAt:            data.computed_at as string,
    analysisText:          (data.analysis_text          as string | null) ?? null,
    analysisAngleBullets:  (data.analysis_angle_bullets as string[])     ?? [],
    analysisUpdatedAt:     (data.analysis_updated_at    as string | null) ?? null,
    portfolioSynopsis:     (data.portfolio_synopsis     as string | null) ?? null,
  };
}

// ── CompanyAnalysisResponse ───────────────────────────────────────────────────

export interface CompanyAnalysisResponse {
  analysis_text:          string;
  analysis_angle_bullets: string[];
  portfolio_synopsis:     string | null;
  analysis_updated_at:    string;
  from_cache:             boolean;
}

// ── callCompanyAnalyze ────────────────────────────────────────────────────────

export async function callCompanyAnalyze(
  ultParentName: string
): Promise<CompanyAnalysisResponse | null> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  if (!supabaseUrl) {
    console.warn('callCompanyAnalyze: VITE_SUPABASE_URL not set');
    return null;
  }

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/company-analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(anonKey ? { Authorization: `Bearer ${anonKey}`, apikey: anonKey } : {}),
      },
      body: JSON.stringify({ ult_parent_name: ultParentName }),
    });
    if (!resp.ok) {
      console.error('callCompanyAnalyze HTTP', resp.status, await resp.text());
      return null;
    }
    return (await resp.json()) as CompanyAnalysisResponse;
  } catch (err) {
    console.error('callCompanyAnalyze fetch error:', err);
    return null;
  }
}
