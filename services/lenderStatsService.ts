/**
 * GenTrack — lenderStatsService
 *
 * Portfolio-level lender data functions.
 * NOTE: distinct from lenderService.ts which handles plant-level financing articles.
 *
 * Functions:
 *   fetchAllLenderStats   — all lender_stats rows for LenderDashboard
 *   fetchLenderStats      — single lender_stats row for EntityDetailView
 *   fetchLenderPlants     — plants financed by a given lender (from plant_lenders + plants)
 *   fetchEntityNews       — news articles matching an entity name (shared for lender + tax equity)
 *   callLenderAnalyze     — on-demand Gemini advisory briefing via lender-analyze edge function
 */

import { supabase } from './supabaseClient';
import { LenderStats, NewsArticle, EntityAnalysisResponse } from '../types';
import { CompanyPlant } from './companyService';

// ── mapLenderRow ──────────────────────────────────────────────────────────────

function mapLenderRow(data: Record<string, unknown>): LenderStats {
  return {
    lenderName:           data.lender_name           as string,
    assetCount:           Number(data.asset_count)   || 0,
    totalExposureUsd:     data.total_exposure_usd    != null ? Number(data.total_exposure_usd) : null,
    plantCodes:           (data.plant_codes          as string[]) ?? [],
    facilityTypes:        (data.facility_types       as string[]) ?? [],
    avgPlantCf:           data.avg_plant_cf          != null ? Number(data.avg_plant_cf) : null,
    pctCurtailed:         Number(data.pct_curtailed) || 0,
    newsSentimentScore:   data.news_sentiment_score  != null ? Number(data.news_sentiment_score) : null,
    distressScore:        data.distress_score        != null ? Number(data.distress_score) : null,
    relevanceScores:      (data.relevance_scores     as Record<string, number>) ?? {},
    analysisText:         (data.analysis_text        as string | null) ?? null,
    analysisAngleBullets: (data.analysis_angle_bullets as string[]) ?? [],
    analysisUpdatedAt:    (data.analysis_updated_at  as string | null) ?? null,
    portfolioSynopsis:    (data.portfolio_synopsis    as string | null) ?? null,
    lastNewsDate:             (data.last_news_date              as string | null) ?? null,
    computedAt:               data.computed_at                  as string,
    totalCurtailedMwExposure: data.total_curtailed_mw_exposure != null ? Number(data.total_curtailed_mw_exposure) : null,
    curtailedPlantCount:      data.curtailed_plant_count       != null ? Number(data.curtailed_plant_count) : null,
    highUrgencyCount:         data.high_urgency_count          != null ? Number(data.high_urgency_count) : null,
    topPitchAngle:            (data.top_pitch_angle             as string | null) ?? null,
  };
}

// ── fetchAllLenderStats ───────────────────────────────────────────────────────

export async function fetchAllLenderStats(): Promise<LenderStats[]> {
  const { data, error } = await supabase
    .from('lender_stats')
    .select('*')
    .gt('asset_count', 0)
    .order('distress_score', { ascending: false, nullsFirst: false });

  if (error || !data) {
    console.error('fetchAllLenderStats error:', error?.message);
    return [];
  }

  return data.map(mapLenderRow);
}

// ── fetchLenderStats ──────────────────────────────────────────────────────────

export async function fetchLenderStats(lenderName: string): Promise<LenderStats | null> {
  const { data, error } = await supabase
    .from('lender_stats')
    .select('*')
    .eq('lender_name', lenderName)
    .single();

  if (error || !data) return null;
  return mapLenderRow(data);
}

// ── fetchLenderPlants ─────────────────────────────────────────────────────────

/**
 * Returns plants financed by the given lender, with facility type and loan amount.
 */
export interface LenderPlant extends CompanyPlant {
  facilityType:    string;
  loanAmountUsd:   number | null;
  interestRateText: string | null;
  maturityText:    string | null;
  loanStatus?:     import('../types').LoanStatus | null;
}

export async function fetchLenderPlants(lenderName: string): Promise<LenderPlant[]> {
  const { data: lenderRows, error: lenderErr } = await supabase
    .from('plant_lenders')
    .select('eia_plant_code, facility_type, loan_amount_usd, interest_rate_text, maturity_text, loan_status')
    .eq('lender_name', lenderName)
    .in('confidence', ['high', 'medium']);

  if (lenderErr || !lenderRows || lenderRows.length === 0) {
    console.error('fetchLenderPlants lender error:', lenderErr?.message);
    return [];
  }

  const plantCodes = [...new Set(lenderRows.map(r => r.eia_plant_code))];

  const { data: plants, error: plantsErr } = await supabase
    .from('plants')
    .select('eia_plant_code, name, state, region, nameplate_capacity_mw, ttm_avg_factor, curtailment_score, is_likely_curtailed')
    .in('eia_plant_code', plantCodes);

  if (plantsErr) {
    console.error('fetchLenderPlants plants error:', plantsErr.message);
    return [];
  }

  const plantMap = new Map<string, Record<string, unknown>>();
  for (const p of plants ?? []) plantMap.set(p.eia_plant_code, p);

  // One row per lender-plant relationship (may have multiple facilities per plant)
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
      loanStatus:        (r.loan_status as import('../types').LoanStatus | null) ?? null,
    };
  }).sort((a, b) => b.nameplateMw - a.nameplateMw);
}

// ── fetchEntityNews ───────────────────────────────────────────────────────────

/**
 * Returns news articles matching an entity name via bidirectional ILIKE substring.
 * Shared by both lenderStatsService and taxEquityService.
 */
export async function fetchEntityNews(
  entityName: string,
  daysBack = 90,
  limit = 50,
): Promise<NewsArticle[]> {
  const { data, error } = await supabase
    .rpc('search_entity_news', {
      p_entity_name: entityName,
      p_days_back:   daysBack,
      p_limit:       limit,
    });

  if (error) {
    console.error('fetchEntityNews error:', error.message);
    return [];
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id:                   row.id          as string,
    title:                row.title       as string,
    description:          (row.description  as string | null) ?? null,
    url:                  row.url         as string,
    sourceName:           (row.source_name  as string | null) ?? null,
    publishedAt:          row.published_at as string,
    topics:               (row.topics        as string[]) ?? [],
    sentimentLabel:       (row.sentiment_label as 'positive' | 'negative' | 'neutral' | null) ?? null,
    eventType:            (row.event_type     as string | null) ?? null,
    impactTags:           (row.impact_tags    as string[]) ?? [],
    ftiRelevanceTags:     (row.fti_relevance_tags as string[]) ?? [],
    importance:           (row.importance as 'low' | 'medium' | 'high' | null) ?? null,
    entityCompanyNames:   (row.entity_company_names as string[]) ?? [],
    articleSummary:       (row.article_summary as string | null) ?? null,
    relevanceScore:       (row.relevance_score as number | null) ?? null,
  }));
}

// ── callLenderAnalyze ─────────────────────────────────────────────────────────

export async function callLenderAnalyze(
  lenderName: string,
): Promise<EntityAnalysisResponse | null> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  if (!supabaseUrl) {
    console.warn('callLenderAnalyze: VITE_SUPABASE_URL not set');
    return null;
  }

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/lender-analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(anonKey ? { Authorization: `Bearer ${anonKey}`, apikey: anonKey } : {}),
      },
      body: JSON.stringify({ lender_name: lenderName }),
    });
    if (!resp.ok) {
      console.error('callLenderAnalyze HTTP', resp.status, await resp.text());
      return null;
    }
    return (await resp.json()) as EntityAnalysisResponse;
  } catch (err) {
    console.error('callLenderAnalyze fetch error:', err);
    return null;
  }
}
