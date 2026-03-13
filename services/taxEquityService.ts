/**
 * GenTrack — taxEquityService
 *
 * Portfolio-level tax equity investor data functions.
 *
 * Functions:
 *   fetchAllTaxEquityStats   — all tax_equity_stats rows for TaxEquityDashboard
 *   fetchTaxEquityStats      — single row for EntityDetailView
 *   fetchTaxEquityPlants     — plants in investor's portfolio (from plant_lenders + plants)
 *   callTaxEquityAnalyze     — on-demand Gemini advisory briefing via tax-equity-analyze edge function
 */

import { supabase } from './supabaseClient';
import { TaxEquityStats, EntityAnalysisResponse } from '../types';
import { LenderPlant } from './lenderStatsService';

// ── mapTaxEquityRow ───────────────────────────────────────────────────────────

function mapTaxEquityRow(data: Record<string, unknown>): TaxEquityStats {
  return {
    investorName:          data.investor_name           as string,
    assetCount:            Number(data.asset_count)     || 0,
    totalCommittedUsd:     data.total_committed_usd     != null ? Number(data.total_committed_usd) : null,
    plantCodes:            (data.plant_codes            as string[]) ?? [],
    portfolioAvgCf:        data.portfolio_avg_cf        != null ? Number(data.portfolio_avg_cf) : null,
    portfolioBenchmarkCf:  data.portfolio_benchmark_cf  != null ? Number(data.portfolio_benchmark_cf) : null,
    pctCurtailed:          Number(data.pct_curtailed)   || 0,
    newsSentimentScore:    data.news_sentiment_score    != null ? Number(data.news_sentiment_score) : null,
    distressScore:         data.distress_score          != null ? Number(data.distress_score) : null,
    relevanceScores:       (data.relevance_scores       as Record<string, number>) ?? {},
    analysisText:          (data.analysis_text          as string | null) ?? null,
    analysisAngleBullets:  (data.analysis_angle_bullets as string[]) ?? [],
    analysisUpdatedAt:     (data.analysis_updated_at    as string | null) ?? null,
    portfolioSynopsis:     (data.portfolio_synopsis     as string | null) ?? null,
    lastNewsDate:          (data.last_news_date          as string | null) ?? null,
    computedAt:            data.computed_at              as string,
  };
}

// ── fetchAllTaxEquityStats ────────────────────────────────────────────────────

export async function fetchAllTaxEquityStats(): Promise<TaxEquityStats[]> {
  const { data, error } = await supabase
    .from('tax_equity_stats')
    .select('*')
    .gt('asset_count', 0)
    .order('distress_score', { ascending: false, nullsFirst: false });

  if (error || !data) {
    console.error('fetchAllTaxEquityStats error:', error?.message);
    return [];
  }

  return data.map(mapTaxEquityRow);
}

// ── fetchTaxEquityStats ───────────────────────────────────────────────────────

export async function fetchTaxEquityStats(investorName: string): Promise<TaxEquityStats | null> {
  const { data, error } = await supabase
    .from('tax_equity_stats')
    .select('*')
    .eq('investor_name', investorName)
    .single();

  if (error || !data) return null;
  return mapTaxEquityRow(data);
}

// ── fetchTaxEquityPlants ──────────────────────────────────────────────────────

export async function fetchTaxEquityPlants(investorName: string): Promise<LenderPlant[]> {
  const { data: lenderRows, error: lenderErr } = await supabase
    .from('plant_lenders')
    .select('eia_plant_code, facility_type, loan_amount_usd, interest_rate_text, maturity_text')
    .eq('lender_name', investorName)
    .eq('facility_type', 'tax_equity')
    .in('confidence', ['high', 'medium']);

  if (lenderErr || !lenderRows || lenderRows.length === 0) {
    console.error('fetchTaxEquityPlants error:', lenderErr?.message);
    return [];
  }

  const plantCodes = [...new Set(lenderRows.map(r => r.eia_plant_code))];

  const { data: plants, error: plantsErr } = await supabase
    .from('plants')
    .select('eia_plant_code, name, state, region, nameplate_capacity_mw, ttm_avg_factor, curtailment_score, is_likely_curtailed')
    .in('eia_plant_code', plantCodes);

  if (plantsErr) {
    console.error('fetchTaxEquityPlants plants error:', plantsErr.message);
    return [];
  }

  const plantMap = new Map<string, Record<string, unknown>>();
  for (const p of plants ?? []) plantMap.set(p.eia_plant_code, p);

  return lenderRows.map(r => {
    const p = plantMap.get(r.eia_plant_code);
    return {
      eiaPlantCode:      r.eia_plant_code,
      plantName:         (p?.name as string) ?? r.eia_plant_code,
      plantKey:          null,
      techType:          null,
      state:             (p?.state as string) ?? null,
      region:            (p?.region as string) ?? null,
      nameplateMw:       Number(p?.nameplate_capacity_mw) || 0,
      ttmAvgFactor:      Number(p?.ttm_avg_factor) || 0,
      curtailmentScore:  Number(p?.curtailment_score) || 0,
      isLikelyCurtailed: Boolean(p?.is_likely_curtailed),
      ownershipPct:      null,
      ownStatus:         null,
      ppaCounterparty:   null,
      ppaExpirationDate: null,
      facilityType:      r.facility_type,
      loanAmountUsd:     r.loan_amount_usd != null ? Number(r.loan_amount_usd) : null,
      interestRateText:  r.interest_rate_text ?? null,
      maturityText:      r.maturity_text ?? null,
    };
  }).sort((a, b) => b.nameplateMw - a.nameplateMw);
}

// ── callTaxEquityAnalyze ──────────────────────────────────────────────────────

export async function callTaxEquityAnalyze(
  investorName: string,
): Promise<EntityAnalysisResponse | null> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  if (!supabaseUrl) {
    console.warn('callTaxEquityAnalyze: VITE_SUPABASE_URL not set');
    return null;
  }

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/tax-equity-analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(anonKey ? { Authorization: `Bearer ${anonKey}`, apikey: anonKey } : {}),
      },
      body: JSON.stringify({ investor_name: investorName }),
    });
    if (!resp.ok) {
      console.error('callTaxEquityAnalyze HTTP', resp.status, await resp.text());
      return null;
    }
    return (await resp.json()) as EntityAnalysisResponse;
  } catch (err) {
    console.error('callTaxEquityAnalyze fetch error:', err);
    return null;
  }
}
