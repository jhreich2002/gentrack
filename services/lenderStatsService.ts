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
 *   callLenderAnalyze     — retired in v4 (returns null; briefing must come from cached stats)
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
  facilityType:     string;
  loanAmountUsd:    number | null;
  interestRateText: string | null;
  maturityText:     string | null;
  loanStatus?:      import('../types').LoanStatus | null;
  // Feature additions
  maturityDate?:    string | null;  // YYYY-MM-DD from plant_lenders.maturity_date
  ownerName?:       string | null;  // plants.owner (majority owner)
  fuelSource?:      string | null;  // plants.fuel_source
  cfTrend?:         number | null;  // (ttmAvgFactor - recentCf) / ttmAvgFactor; >0 = degrading
}

export async function fetchLenderPlants(lenderName: string): Promise<LenderPlant[]> {
  // v4: resolve canonical lender id by name
  const { data: lender, error: lenderLookupErr } = await supabase
    .from('lenders_canonical')
    .select('id')
    .eq('name', lenderName)
    .maybeSingle();

  if (lenderLookupErr) {
    console.error('fetchLenderPlants lender lookup error:', lenderLookupErr.message);
    return [];
  }
  if (!lender) return [];

  // v4: validated lender_links for this canonical lender
  const { data: linkRows, error: linkErr } = await supabase
    .from('lender_links')
    .select('plant_id')
    .eq('canonical_lender_id', (lender as Record<string, unknown>).id)
    .eq('validation_status', 'validated');

  if (linkErr || !linkRows || linkRows.length === 0) {
    if (linkErr) console.error('fetchLenderPlants links error:', linkErr.message);
    return [];
  }

  const plantIds = [...new Set((linkRows as { plant_id: string }[]).map(r => r.plant_id))];

  const [plantsResult, genResult] = await Promise.all([
    supabase
      .from('plants')
      .select('id, eia_plant_code, name, state, nameplate_capacity_mw, ttm_avg_factor, curtailment_score, is_likely_curtailed, owner, fuel_source')
      .in('id', plantIds),
    supabase
      .from('monthly_generation')
      .select('plant_id, month, mwh')
      .in('plant_id', plantIds.map(id => {
        // monthly_generation uses eia_plant_code; derive it from plant id (EIA-XXXXX → XXXXX)
        return String(id).replace(/^EIA-/i, '');
      }))
      .gte('month', (() => {
        const d = new Date();
        d.setMonth(d.getMonth() - 3);
        return d.toISOString().slice(0, 7); // YYYY-MM
      })()),
  ]);

  if (plantsResult.error) {
    console.error('fetchLenderPlants plants error:', plantsResult.error.message);
    return [];
  }

  const plantMap = new Map<string, Record<string, unknown>>();
  for (const p of plantsResult.data ?? []) plantMap.set((p as Record<string, unknown>).id as string, p);

  // Build recent-generation map for cfTrend computation
  const genByPlant = new Map<string, { totalMwh: number; months: number }>();
  for (const row of genResult.data ?? []) {
    const r = row as { plant_id: string; month: string; mwh: number };
    const entry = genByPlant.get(r.plant_id) ?? { totalMwh: 0, months: 0 };
    entry.totalMwh += Number(r.mwh) || 0;
    entry.months += 1;
    genByPlant.set(r.plant_id, entry);
  }

  // One row per validated lender_link → plant
  return linkRows.map((r: { plant_id: string }) => {
    const p = plantMap.get(r.plant_id);
    const nameplateMw   = Number(p?.nameplate_capacity_mw) || 0;
    const ttmAvgFactor  = Number(p?.ttm_avg_factor) || 0;
    const eiaCode       = (p?.eia_plant_code as string) ?? String(r.plant_id).replace(/^EIA-/i, '');

    // Compute cfTrend: positive = recent CF below TTM avg (degrading)
    let cfTrend: number | null = null;
    const gen = genByPlant.get(eiaCode);
    if (gen && gen.months > 0 && nameplateMw > 0 && ttmAvgFactor > 0) {
      const recentCf = (gen.totalMwh / gen.months) / (nameplateMw * 730);
      cfTrend = (ttmAvgFactor - recentCf) / ttmAvgFactor;
    }

    return {
      eiaPlantCode:      eiaCode,
      plantName:         (p?.name as string) ?? r.plant_id,
      plantKey:          null,
      techType:          null,
      state:             (p?.state as string) ?? null,
      region:            null,
      nameplateMw,
      ttmAvgFactor,
      curtailmentScore:  Number(p?.curtailment_score) || 0,
      isLikelyCurtailed: Boolean(p?.is_likely_curtailed),
      ownershipPct:      null,
      ownStatus:         null,
      ppaCounterparty:   null,
      ppaExpirationDate: null,
      facilityType:      'term_loan',
      loanAmountUsd:     null,
      interestRateText:  null,
      maturityText:      null,
      loanStatus:        null,
      maturityDate:      null,
      ownerName:         (p?.owner as string) ?? null,
      fuelSource:        (p?.fuel_source as string) ?? null,
      cfTrend,
    };
  }).sort((a, b) => b.nameplateMw - a.nameplateMw);
}

// ── fetchCoLenders ────────────────────────────────────────────────────────────

/**
 * Returns other lenders who share plant exposure with the given lender.
 * Used to build the syndicate partner map in EntityDetailView.
 */
export interface CoLender {
  lenderName:       string;
  sharedPlantCount: number;
  syndicateRoles:   string[];  // distinct roles this lender plays across shared plants
}

export async function fetchCoLenders(
  lenderName: string,
  plantCodes: string[],
): Promise<CoLender[]> {
  if (plantCodes.length === 0) return [];

  // v4: resolve plant_ids from eia_plant_codes
  const { data: plantIdRows, error: pidErr } = await supabase
    .from('plants')
    .select('id')
    .in('eia_plant_code', plantCodes);

  if (pidErr || !plantIdRows || plantIdRows.length === 0) {
    if (pidErr) console.error('fetchCoLenders plant id lookup error:', pidErr.message);
    return [];
  }

  const plantIds = (plantIdRows as { id: string }[]).map(p => p.id);

  // v4: find all validated links for these plants, joined to canonical lender name
  const { data, error } = await supabase
    .from('lender_links')
    .select('plant_id, lenders_canonical!canonical_lender_id(name)')
    .in('plant_id', plantIds)
    .eq('validation_status', 'validated');

  if (error || !data) {
    console.error('fetchCoLenders error:', error?.message);
    return [];
  }

  // Aggregate by canonical lender name
  const map = new Map<string, { plants: Set<string>; roles: Set<string> }>();
  for (const row of data as Array<Record<string, unknown>>) {
    const name = (row.lenders_canonical as Record<string, unknown>)?.name as string | undefined;
    if (!name || name === lenderName) continue;
    const entry = map.get(name) ?? { plants: new Set(), roles: new Set() };
    entry.plants.add(row.plant_id as string);
    map.set(name, entry);
  }

  return Array.from(map.entries())
    .map(([name, { plants, roles }]) => ({
      lenderName:       name,
      sharedPlantCount: plants.size,
      syndicateRoles:   Array.from(roles),
    }))
    .sort((a, b) => b.sharedPlantCount - a.sharedPlantCount)
    .slice(0, 10);
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
  console.warn(`callLenderAnalyze: retired endpoint (lender-analyze) for lender '${lenderName}'`);
  return null;
}
