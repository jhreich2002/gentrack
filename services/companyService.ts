/**
 * GenTrack — companyService
 *
 * Client-side data functions for the Company Detail Panel:
 *   fetchCompanyStats      — reads company_stats row for a given ult_parent
 *   callCompanyAnalyze     — calls company-analyze Edge Function (on-demand Gemini briefing)
 */

import { supabase } from './supabaseClient';
import { CompanyStats } from '../types';

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
 */
export async function fetchAllCompanyStats(): Promise<CompanyStats[]> {
  const { data, error } = await supabase
    .from('company_stats')
    .select('*')
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
  };
}

// ── CompanyAnalysisResponse ───────────────────────────────────────────────────

export interface CompanyAnalysisResponse {
  analysis_text:          string;
  analysis_angle_bullets: string[];
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
