/**
 * GenTrack — opportunityService
 *
 * Fetches entity data from all four tables (company_stats, lender_stats,
 * tax_equity_stats, plants) and computes a unified opportunity_score for
 * the Opportunities tab.
 *
 * Opportunity score formula (0–100):
 *   distress_score  × 0.5
 *   + size_score    × 0.3   (normalized exposure/committed/MW across all entities)
 *   + recency_score × 0.2   (100 if ≤7d, 50 if ≤30d, 25 if ≤90d, 0 otherwise)
 */

import { supabase } from './supabaseClient';
import { OpportunityItem } from '../types';

// ── helpers ───────────────────────────────────────────────────────────────────

function recencyScore(lastNewsDate: string | null): number {
  if (!lastNewsDate) return 0;
  const ageMs = Date.now() - new Date(lastNewsDate).getTime();
  const ageDays = ageMs / 86_400_000;
  if (ageDays <= 7)  return 100;
  if (ageDays <= 30) return 50;
  if (ageDays <= 90) return 25;
  return 0;
}

function topFtiServiceLines(relevanceScores: Record<string, number> | null): string[] {
  if (!relevanceScores) return [];
  const MAP: Record<string, string> = {
    restructuring:    'Restructuring',
    transactions:     'Transactions',
    disputes:         'Disputes',
    market_strategy:  'Policy',
  };
  return Object.entries(relevanceScores)
    .filter(([, v]) => v >= 40)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k]) => MAP[k] ?? k);
}

// ── fetchOpportunities ────────────────────────────────────────────────────────

export interface OpportunityFilters {
  entityTypes?:  Array<'plant' | 'owner' | 'tax_equity' | 'lender'>;
  ftiServiceLine?: string;       // e.g. 'Restructuring'
  minDollarsAtRisk?: number;
  newsRecencyDays?: number;      // 7 | 30 | 90 | 0 (any)
}

export async function fetchOpportunities(
  filters?: OpportunityFilters,
): Promise<OpportunityItem[]> {
  const items: OpportunityItem[] = [];

  // ── Fetch all four sources in parallel ───────────────────────────────────
  const [
    { data: companies },
    { data: lenders },
    { data: taxEquity },
    { data: curtailedPlants },
  ] = await Promise.all([
    supabase
      .from('company_stats')
      .select('ult_parent_name, total_mw, avg_cf, distress_score, relevance_scores, analysis_angle_bullets, computed_at')
      .gt('total_mw', 0),
    supabase
      .from('lender_stats')
      .select('lender_name, total_exposure_usd, asset_count, distress_score, relevance_scores, analysis_angle_bullets, last_news_date, computed_at')
      .gt('asset_count', 0),
    supabase
      .from('tax_equity_stats')
      .select('investor_name, total_committed_usd, asset_count, distress_score, relevance_scores, analysis_angle_bullets, last_news_date, computed_at')
      .gt('asset_count', 0),
    supabase
      .from('plants')
      .select('eia_plant_code, name, nameplate_capacity_mw, distress_score, ttm_avg_factor, is_likely_curtailed')
      .eq('is_likely_curtailed', true)
      .not('distress_score', 'is', null)
      .order('distress_score', { ascending: false })
      .limit(200),
  ]);

  // ── Build raw items ───────────────────────────────────────────────────────

  for (const c of companies ?? []) {
    items.push({
      entityId:        c.ult_parent_name,
      entityType:      'owner',
      entityName:      c.ult_parent_name,
      opportunityScore: 0,  // computed below
      distressScore:   c.distress_score != null ? Number(c.distress_score) : null,
      keySignal:       (c.analysis_angle_bullets as string[] | null)?.[0] ?? null,
      dollarsAtRisk:   null,
      lastNewsDate:    null,
      ftiServiceLines: topFtiServiceLines(c.relevance_scores as Record<string, number> | null),
      _sizeMw:         Number(c.total_mw) || 0,
      _sizeUsd:        0,
    } as OpportunityItem & { _sizeMw: number; _sizeUsd: number });
  }

  for (const l of lenders ?? []) {
    items.push({
      entityId:        l.lender_name,
      entityType:      'lender',
      entityName:      l.lender_name,
      opportunityScore: 0,
      distressScore:   l.distress_score != null ? Number(l.distress_score) : null,
      keySignal:       (l.analysis_angle_bullets as string[] | null)?.[0] ?? null,
      dollarsAtRisk:   l.total_exposure_usd != null ? Number(l.total_exposure_usd) : null,
      lastNewsDate:    (l.last_news_date as string | null) ?? null,
      ftiServiceLines: topFtiServiceLines(l.relevance_scores as Record<string, number> | null),
      _sizeMw:         0,
      _sizeUsd:        Number(l.total_exposure_usd) || 0,
    } as OpportunityItem & { _sizeMw: number; _sizeUsd: number });
  }

  for (const te of taxEquity ?? []) {
    items.push({
      entityId:        te.investor_name,
      entityType:      'tax_equity',
      entityName:      te.investor_name,
      opportunityScore: 0,
      distressScore:   te.distress_score != null ? Number(te.distress_score) : null,
      keySignal:       (te.analysis_angle_bullets as string[] | null)?.[0] ?? null,
      dollarsAtRisk:   te.total_committed_usd != null ? Number(te.total_committed_usd) : null,
      lastNewsDate:    (te.last_news_date as string | null) ?? null,
      ftiServiceLines: topFtiServiceLines(te.relevance_scores as Record<string, number> | null),
      _sizeMw:         0,
      _sizeUsd:        Number(te.total_committed_usd) || 0,
    } as OpportunityItem & { _sizeMw: number; _sizeUsd: number });
  }

  for (const p of curtailedPlants ?? []) {
    items.push({
      entityId:        p.eia_plant_code,
      entityType:      'plant',
      entityName:      p.name ?? p.eia_plant_code,
      opportunityScore: 0,
      distressScore:   p.distress_score != null ? Number(p.distress_score) : null,
      keySignal:       `Curtailed — TTM CF ${p.ttm_avg_factor != null ? (Number(p.ttm_avg_factor) * 100).toFixed(1) + '%' : 'N/A'}`,
      dollarsAtRisk:   null,
      lastNewsDate:    null,
      ftiServiceLines: [],
      _sizeMw:         Number(p.nameplate_capacity_mw) || 0,
      _sizeUsd:        0,
    } as OpportunityItem & { _sizeMw: number; _sizeUsd: number });
  }

  // ── Normalize size scores across all items ────────────────────────────────

  type ItemExt = OpportunityItem & { _sizeMw: number; _sizeUsd: number };
  const ext = items as ItemExt[];

  const maxMw  = Math.max(...ext.map(i => i._sizeMw),  1);
  const maxUsd = Math.max(...ext.map(i => i._sizeUsd), 1);

  for (const item of ext) {
    const sizeScore = item._sizeUsd > 0
      ? (item._sizeUsd / maxUsd) * 100
      : (item._sizeMw  / maxMw)  * 100;

    const distress = item.distressScore ?? 0;
    const recency  = recencyScore(item.lastNewsDate);

    item.opportunityScore = Math.round(
      distress  * 0.5 +
      sizeScore * 0.3 +
      recency   * 0.2,
    );

    // Clean up internal fields
    delete (item as unknown as Record<string, unknown>)._sizeMw;
    delete (item as unknown as Record<string, unknown>)._sizeUsd;
  }

  // ── Apply filters ─────────────────────────────────────────────────────────

  let result = items.filter(i => i.opportunityScore > 0 || i.distressScore != null);

  if (filters?.entityTypes?.length) {
    result = result.filter(i => filters.entityTypes!.includes(i.entityType));
  }

  if (filters?.ftiServiceLine) {
    result = result.filter(i => i.ftiServiceLines.includes(filters.ftiServiceLine!));
  }

  if (filters?.minDollarsAtRisk) {
    result = result.filter(i =>
      i.entityType === 'plant' || (i.dollarsAtRisk != null && i.dollarsAtRisk >= filters.minDollarsAtRisk!),
    );
  }

  if (filters?.newsRecencyDays) {
    result = result.filter(i => recencyScore(i.lastNewsDate) >= (
      filters.newsRecencyDays === 7  ? 100 :
      filters.newsRecencyDays === 30 ? 50  :
      filters.newsRecencyDays === 90 ? 25  : 0
    ));
  }

  result.sort((a, b) => b.opportunityScore - a.opportunityScore);

  return result.slice(0, 200);
}
