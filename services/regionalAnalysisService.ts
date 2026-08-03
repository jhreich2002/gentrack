/**
 * GenTrack — regionalAnalysisService
 *
 * Compute engine for the Regional Analysis tab.
 *
 * Responsibilities
 *   • Fetch two 12-month CF windows per plant (Wind + Solar) via the
 *     `get_plant_cf_windows` RPC to derive DETERIORATION (prior − recent).
 *   • Fetch bulk ownership rows from `plant_ownership` and validated lender
 *     links from `v_plant_financing` so we can attribute exposure to entities.
 *   • Compute capacity-weighted benchmarks per (region, tech), per
 *     (region, subRegion, tech), and national.
 *   • Flag plants as deteriorating and/or underperforming.
 *   • Score sub-region distress (0–100).
 *   • Aggregate entity exposure (owners and lenders, kept separate) with
 *     hot/warm/cold tiering.
 *
 * All computation is pure over its inputs — the dashboard component calls
 * `buildRegionalAnalysis(...)` once when data changes.
 *
 * Hard constraints (from the approved plan):
 *   • ISOs: ERCOT, CAISO, SPP, MISO, PJM, NYISO, ISO-NE only.
 *   • Technologies: Wind + Solar only. Nuclear is never included.
 *   • Owners and lenders are kept in SEPARATE result panels.
 *   • Lender coverage caveat data (`lenderCoverage`) must be surfaced by the
 *     UI whenever the lender panel is rendered.
 */

import { PowerPlant, Region, FuelSource, CapacityFactorStats } from '../types';
import { supabase } from './supabaseClient';

// ─── Public constants ────────────────────────────────────────────────────────

/** ISOs included in the Regional Analysis feature. */
export const ANALYSIS_REGIONS: Region[] = [
  Region.ERCOT,
  Region.CAISO,
  Region.SPP,
  Region.MISO,
  Region.PJM,
  Region.NYISO,
  Region.ISONE,
];

/** Fuel sources analyzed. Nuclear is intentionally excluded. */
export const ANALYSIS_TECHS: FuelSource[] = [FuelSource.Wind, FuelSource.Solar];

/**
 * Tunable thresholds. Centralized here so the user can re-calibrate after the
 * first data pass. Keep comments up to date with intent.
 */
export const THRESHOLDS = {
  /** A plant is "deteriorating" if (prior_cf − recent_cf) ≥ detPts (as CF fraction). */
  detPts: 0.03,
  /** Minimum non-null months in EACH 12-month window before deterioration is trusted. */
  minMonths: 8,
  /** Minimum non-null months in each 6-month half-window before momentum is trusted. */
  minHalfMonths: 4,
  /** Suppress subregion stats when eligible plant count is below this. */
  minPlantsPerSubregion: 3,
  /** Data-months floor for a plant to be eligible at all. */
  minDataMonths: 6,

  /** HOT tier requires struggle score ≥ this. */
  struggleHot: 60,
  /** WARM tier requires struggle score ≥ this. */
  struggleWarm: 35,

  /** HOT tier requires exposed MW ≥ this OR portfolio share ≥ exposureHotPortfolioShare. */
  exposureHotMw: 100,
  exposureHotPortfolioShare: 0.25,
  /** WARM tier requires at least this much exposed MW. */
  exposureWarmMw: 25,

  /**
   * Struggle score component weights. Must sum to 1.0.
   * excessDecline = sub-region YoY decline minus national same-tech YoY (controls weather).
   * breadth       = MW share of plants individually deteriorating (systemic vs isolated).
   * selfTrend     = raw sub-region YoY decline.
   * momentum      = acceleration in decline (recent-6mo YoY vs prior-6mo YoY).
   */
  struggleWeights: { excessDecline: 0.40, breadth: 0.25, selfTrend: 0.20, momentum: 0.15 },
  /** Normaliser: X pts of YoY excess decline → max contribution from that component. */
  excessDeclineNorm: 0.05,
  selfTrendNorm: 0.05,
  momentumNorm: 0.03,

  // ── Top Targets BD scoring ────────────────────────────────────────────────
  /**
   * Priority score weights: priorityScore = exposedMwNorm*mwWeight
   *   + portfolioShare*concentrationWeight + (struggleScore/100)*struggleWeight.
   * Weights should sum to 1.0.
   */
  priorityWeights: { mwWeight: 0.5, concentrationWeight: 0.3, distressWeight: 0.2 },
  /** Max rows shown in the Top BD Targets table. */
  topTargetsCount: 10,
} as const;

/**
 * Directional average realized price per ISO (\$/MWh, EIA public data).
 * Used ONLY for revenue-at-risk estimates in the Top Targets table.
 * Label clearly as "directional estimate" in the UI; not a price forecast.
 * Update seasonally for more accurate client discussions.
 */
export const AVG_REALIZED_PRICE_BY_REGION: Record<string, number> = {
  ERCOT: 35,
  CAISO: 40,
  SPP: 28,
  MISO: 32,
  PJM: 38,
  NYISO: 45,
  'ISO-NE': 48,
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CfWindow {
  plantId: string;
  /** Cap-weighted avg CF over the 12 months ending at anchor month M (inclusive). */
  recentCf: number | null;
  /** Cap-weighted avg CF over the 12 months immediately before the recent window. */
  priorCf: number | null;
  recentMonths: number;
  priorMonths: number;
  /** 6-month half-windows for the momentum signal (null when RPC not yet upgraded). */
  r2Cf: number | null;  // [M-5, M]   — most recent half-year
  r1Cf: number | null;  // [M-11, M-6] — earlier half of recent year
  p2Cf: number | null;  // [M-17, M-12] — YoY peer of r2
  p1Cf: number | null;  // [M-23, M-18] — YoY peer of r1
  r2Months: number;
  r1Months: number;
  p2Months: number;
  p1Months: number;
}

/** Flags computed per plant for use in the analysis. */
export interface PlantAnalysis {
  plantId: string;
  region: Region;
  subRegion: string;
  fuelSource: FuelSource;
  nameplateMw: number;
  ttmCf: number;
  /** Kept for internal drill-down display only — NOT used for sub-region flagging. */
  peerAvgTtmCf: number | null;
  recentCf: number | null;
  priorCf: number | null;
  r2Cf: number | null;
  r1Cf: number | null;
  p2Cf: number | null;
  p1Cf: number | null;
  /** priorCf − recentCf (positive = getting worse). Primary YoY self-trend signal. */
  yoyDeclinePts: number | null;
  /** (p2Cf − r2Cf) − (p1Cf − r1Cf) — positive = decline accelerating. Null when half-window data missing. */
  momentumPts: number | null;
  isDeteriorating: boolean;
  /** Alias for isDeteriorating — peer-relative underperformance retired. */
  isFlagged: boolean;
  curtailmentScore: number;
}

export interface Benchmarks {
  /** Capacity-weighted TTM CF, keyed by `${region}|${tech}`. */
  regionTech: Map<string, number>;
  /** Capacity-weighted TTM CF, keyed by `${region}|${subRegion}|${tech}`. */
  subRegionTech: Map<string, number>;
  /** Capacity-weighted TTM CF, keyed by `${tech}`. */
  nationalTech: Map<string, number>;
}

export interface SubregionStats {
  region: Region;
  subRegion: string;
  plantCount: number;    // eligible plants only
  totalMw: number;
  capWeightedTtmCf: number | null;
  deterioratingMw: number;
  /** Same as deterioratingMw (peer-relative flagging retired). */
  flaggedMw: number;
  avgCurtailmentScore: number;
  /** 0–100 composite struggle score, or null when suppressed (< minPlantsPerSubregion). */
  struggleScore: number | null;
  /** Raw signal values that feed into struggleScore. */
  signalComponents: {
    /** Cap-weighted YoY CF decline for this sub-region (positive = worse). */
    selfTrendPts: number | null;
    /** selfTrendPts minus national same-tech YoY decline — controls for fleet/weather effects. */
    excessDeclinePts: number | null;
    /** MW share of plants individually deteriorating (0–1). */
    breadth: number;
    /** Acceleration: (recent-6mo YoY) − (prior-6mo YoY). Positive = worsening. */
    momentumPts: number | null;
    /** Cap-weighted curtailment score normalised to 0–1. */
    curtailmentComponent: number;
  };
  /** ‘Systemic’ (breadth ≥ 60%), ‘Mixed’ (30–60%), ‘Asset-specific’ (≤ 30%), or null when suppressed. */
  diagnosisLabel: string | null;
  /** 5-year persistence signal, populated after fetchPlantAnnualCf + computePersistenceSignals. */
  persistence?: PersistenceSignal | null;
}

// ─── 5-year persistence types ────────────────────────────────────────────────

/** Per-plant annual CF data point returned by the get_plant_annual_cf RPC. */
export interface AnnualCfRow {
  plant_id: string;
  year: number;
  year_cf: number;
  month_count: number;
}

/** Per-plant multi-year decline analysis. */
export interface PlantPersistence {
  plantId: string;
  /** Qualifying annual CF points (≥10 months/yr), sorted by year ascending. */
  annualPoints: { year: number; cf: number }[];
  /** Count of consecutive YoY declines ≥1 pp ending at the most recent qualifying year. */
  downYears: number;
  /** OLS slope in CF units per year (negative = worsening trend). */
  slopeCfPerYear: number | null;
  /** True when downYears ≥ 3. */
  persistentDecline: boolean;
  /** True when plant was marked history_unreliable (expansion step-change). */
  excluded: boolean;
}

/** Sub-region persistence badge, aggregated from PlantPersistence records. */
export interface PersistenceSignal {
  /** Number of plants eligible for persistence analysis (not excluded, ≥4 qualifying years). */
  eligiblePlants: number;
  /** Number of those with persistentDecline = true. */
  persistentDeclinePlants: number;
  /** persistentDeclinePlants / eligiblePlants (0 when eligiblePlants = 0). */
  persistentDeclineShare: number;
  /** True when persistentDeclineShare ≥ 0.25 AND eligiblePlants ≥ 3. */
  hasBadge: boolean;
  /** Average downYears across eligible plants (informational). */
  avgDownYears: number | null;
}

export interface EntityExposure {
  entityName: string;
  entityType: 'owner' | 'lender';
  tier: 'hot' | 'warm' | 'cold';
  /** Pro-rata MW attributable to this entity across FLAGGED plants in scope. */
  exposedMw: number;
  /** Pro-rata MW attributable to this entity across ALL eligible plants in scope. */
  totalMwInScope: number;
  /** Pro-rata MW attributable to this entity across ALL eligible plants in ANALYSIS_REGIONS. */
  entityTotalTrackedMw: number;
  plantCount: number;
  flaggedPlantIds: string[];
  /** exposedMw ÷ entityTotalTrackedMw, or 0 when the denominator is 0. */
  portfolioShare: number;
  /** Struggle score of the scope this row was computed against (for tier context). */
  scopeStruggleScore: number | null;
}

export interface LenderCoverage {
  flaggedPlantsInScope: number;
  flaggedPlantsWithValidatedLender: number;
  /** flaggedPlantsWithValidatedLender / flaggedPlantsInScope (0 when denom is 0). */
  ratio: number;
}

export interface OwnershipStake {
  entityName: string; // ult_parent
  plantId: string;
  sharePct: number; // 0–1
}

export interface LenderStake {
  lenderName: string;
  plantId: string;
}

/**
 * A ranked BD target produced by computeTopTargets.
 * Contains everything needed to render the Top Targets table row
 * and a one-sentence pitch hook.
 */
export interface TopTarget {
  entityName: string;
  entityType: 'owner' | 'lender';
  tier: 'hot' | 'warm' | 'cold';
  /** Pro-rata MW exposed in flagged plants within the current scope. */
  exposedMw: number;
  flaggedPlantCount: number;
  /** exposedMw / entityTotalTrackedMw */
  portfolioShare: number;
  /** 0–1 composite score for table ranking. */
  priorityScore: number;
  /** Estimated annual revenue at risk in $M (based on YoY CF decline), or null. */
  revenueAtRiskUsd: number | null;
  /** One-sentence pitch hook for the BD conversation. */
  whyNow: string;
  /** Unique sub-regions containing this entity's flagged exposure. */
  subRegions: string[];
}

/**
 * Per-lender outreach briefing produced by buildLenderBriefings.
 * Surfaces the ready-to-use narrative for the “lender-first” BD pitch.
 */
export interface LenderBriefing {
  lenderName: string;
  tier: 'hot' | 'warm' | 'cold';
  exposedMw: number;
  flaggedPlantCount: number;
  portfolioShare: number;
  /** MW-weighted average struggle score across this lender's flagged sub-regions. */
  weightedStruggleScore: number | null;
  /** Per-sub-region breakdown ordered by exposed MW descending. */
  subRegionBreakdowns: Array<{
    subRegion: string;
    region: Region;
    exposedMw: number;
    struggleScore: number | null;
    selfTrendPts: number | null;
    excessDeclinePts: number | null;
    breadth: number;
    momentumPts: number | null;
    diagnosisLabel: string | null;
    avgCurtailmentScore: number;
  }>;
  /**
   * Ready-to-use outreach paragraph (regional framing only — no plant-level CF).
   * Suitable for direct use in a client email or briefing document.
   */
  outreachNarrative: string;
}

// ─── RPC + bulk fetch functions ─────────────────────────────────────────────

/**
 * Fetch CF windows per plant (Wind + Solar).
 * Maps the extended RPC shape (with half-window columns) — falls back
 * gracefully to null for half-window fields when the old RPC is deployed.
 * Returns an empty map + rpcError flag on failure.
 */
export async function fetchCfWindows(): Promise<{ windows: Map<string, CfWindow>; rpcError: boolean }> {
  const windows = new Map<string, CfWindow>();
  try {
    const { data, error } = await supabase.rpc('get_plant_cf_windows');
    if (error) {
      console.warn('[RegionalAnalysis] get_plant_cf_windows RPC failed:', error.message);
      return { windows, rpcError: true };
    }
    for (const row of (data ?? []) as any[]) {
      const plantId = String(row.plant_id);
      windows.set(plantId, {
        plantId,
        recentCf:   row.recent_cf  == null ? null : Number(row.recent_cf),
        priorCf:    row.prior_cf   == null ? null : Number(row.prior_cf),
        recentMonths: Number(row.recent_months  ?? 0),
        priorMonths:  Number(row.prior_months   ?? 0),
        // Half-window fields — null when old RPC shape (back-compat).
        r2Cf: row.r2_cf == null ? null : Number(row.r2_cf),
        r1Cf: row.r1_cf == null ? null : Number(row.r1_cf),
        p2Cf: row.p2_cf == null ? null : Number(row.p2_cf),
        p1Cf: row.p1_cf == null ? null : Number(row.p1_cf),
        r2Months: Number(row.r2_months ?? 0),
        r1Months: Number(row.r1_months ?? 0),
        p2Months: Number(row.p2_months ?? 0),
        p1Months: Number(row.p1_months ?? 0),
      });
    }
    return { windows, rpcError: false };
  } catch (err) {
    console.warn('[RegionalAnalysis] get_plant_cf_windows threw:', err);
    return { windows, rpcError: true };
  }
}

/**
 * Bulk-fetch ownership rows (one row per (plant, owner)). Uses
 * `ult_parent` as the entity key, matching handleCompanyClick semantics.
 *
 * Each returned stake carries a `sharePct` in [0,1]. When `oper_own` is null
 * or 0, we treat the ult_parent as a 100% owner (fallback so we never lose
 * exposure when EIA-923 didn't publish a percentage split).
 */
export async function fetchOwnershipStakes(
  eligibleEiaCodes: Set<string>,
): Promise<OwnershipStake[]> {
  const stakes: OwnershipStake[] = [];
  try {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const to = from + PAGE - 1;
      const { data, error } = await supabase
        .from('plant_ownership')
        .select('eia_site_code, ult_parent, oper_own')
        .range(from, to);
      if (error) {
        console.warn('[RegionalAnalysis] plant_ownership fetch failed:', error.message);
        break;
      }
      if (!data || data.length === 0) break;
      for (const row of data as any[]) {
        const code = String(row.eia_site_code ?? '');
        if (!eligibleEiaCodes.has(code)) continue;
        const entity = row.ult_parent ? String(row.ult_parent) : null;
        if (!entity) continue;
        const rawPct = row.oper_own == null ? null : Number(row.oper_own);
        const share = rawPct != null && rawPct > 0 && rawPct <= 1
          ? rawPct
          : rawPct != null && rawPct > 1 && rawPct <= 100
            ? rawPct / 100
            : 1; // fallback: treat null/0 as 100%
        stakes.push({ entityName: entity, plantId: code, sharePct: share });
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  } catch (err) {
    console.warn('[RegionalAnalysis] fetchOwnershipStakes threw:', err);
  }
  return stakes;
}

/**
 * Bulk-fetch validated lender links from v_plant_financing.
 * Only rows with a non-null validated_at are returned — pending / rejected
 * links do NOT contribute to lender exposure.
 */
export async function fetchLenderStakes(
  eligiblePlantIds: Set<string>,
): Promise<LenderStake[]> {
  const stakes: LenderStake[] = [];
  try {
    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const to = from + PAGE - 1;
      const { data, error } = await supabase
        .from('v_plant_financing')
        .select('plant_id, lender_name, validated_at')
        .not('validated_at', 'is', null)
        .range(from, to);
      if (error) {
        console.warn('[RegionalAnalysis] v_plant_financing fetch failed:', error.message);
        break;
      }
      if (!data || data.length === 0) break;
      for (const row of data as any[]) {
        const pid = String(row.plant_id ?? '');
        if (!eligiblePlantIds.has(pid)) continue;
        const lender = row.lender_name ? String(row.lender_name) : null;
        if (!lender) continue;
        stakes.push({ lenderName: lender, plantId: pid });
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  } catch (err) {
    console.warn('[RegionalAnalysis] fetchLenderStakes threw:', err);
  }
  return stakes;
}

// ─── Pure compute functions ─────────────────────────────────────────────────

/** Is a plant eligible for the Regional Analysis screen? */
export function isEligible(plant: PowerPlant, stats: CapacityFactorStats | undefined): boolean {
  if (!ANALYSIS_TECHS.includes(plant.fuelSource)) return false;
  if (!ANALYSIS_REGIONS.includes(plant.region)) return false;
  if (!stats) return false;
  if (stats.isMaintenanceOffline) return false;
  if ((stats.dataMonthsCount ?? 0) < THRESHOLDS.minDataMonths) return false;
  return true;
}

function capWeighted(pairs: Array<[number, number]>): number | null {
  let num = 0;
  let den = 0;
  for (const [val, w] of pairs) {
    if (!Number.isFinite(val) || w <= 0) continue;
    num += val * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/** Compute capacity-weighted benchmarks at region/subregion/national × tech. */
export function computeBenchmarks(
  plants: PowerPlant[],
  statsMap: Record<string, CapacityFactorStats>,
): Benchmarks {
  const regionTechAgg = new Map<string, Array<[number, number]>>();
  const subRegionTechAgg = new Map<string, Array<[number, number]>>();
  const nationalTechAgg = new Map<string, Array<[number, number]>>();

  for (const p of plants) {
    const stats = statsMap[p.id];
    if (!isEligible(p, stats)) continue;
    const cf = stats.ttmAverage;
    const mw = p.nameplateCapacityMW;
    if (!Number.isFinite(cf) || cf <= 0 || mw <= 0) continue;

    const rt = `${p.region}|${p.fuelSource}`;
    const srt = `${p.region}|${p.subRegion}|${p.fuelSource}`;
    const nt = `${p.fuelSource}`;
    (regionTechAgg.get(rt) ?? regionTechAgg.set(rt, []).get(rt)!).push([cf, mw]);
    (subRegionTechAgg.get(srt) ?? subRegionTechAgg.set(srt, []).get(srt)!).push([cf, mw]);
    (nationalTechAgg.get(nt) ?? nationalTechAgg.set(nt, []).get(nt)!).push([cf, mw]);
  }

  const finalize = (agg: Map<string, Array<[number, number]>>): Map<string, number> => {
    const out = new Map<string, number>();
    for (const [k, arr] of agg.entries()) {
      const v = capWeighted(arr);
      if (v != null) out.set(k, v);
    }
    return out;
  };

  return {
    regionTech: finalize(regionTechAgg),
    subRegionTech: finalize(subRegionTechAgg),
    nationalTech: finalize(nationalTechAgg),
  };
}

/** Compute per-plant analysis flags (YoY deterioration only — peer-relative underperformance retired). */
export function computePlantAnalyses(
  plants: PowerPlant[],
  statsMap: Record<string, CapacityFactorStats>,
  cfWindows: Map<string, CfWindow>,
  benchmarks: Benchmarks,
  techFilter: FuelSource[],
): PlantAnalysis[] {
  const out: PlantAnalysis[] = [];
  for (const p of plants) {
    const stats = statsMap[p.id];
    if (!isEligible(p, stats)) continue;
    if (!techFilter.includes(p.fuelSource)) continue;

    // peerAvgTtmCf is kept for the internal drill-down display, not for flagging.
    const peerKey = `${p.region}|${p.subRegion}|${p.fuelSource}`;
    const peerAvg = benchmarks.subRegionTech.get(peerKey) ?? null;

    const win = cfWindows.get(p.id);
    const recentCf = win?.recentCf ?? null;
    const priorCf  = win?.priorCf  ?? null;
    const enoughMonths =
      !!win && win.recentMonths >= THRESHOLDS.minMonths && win.priorMonths >= THRESHOLDS.minMonths;

    const yoyDeclinePts = recentCf != null && priorCf != null ? priorCf - recentCf : null;
    const isDeteriorating = enoughMonths && yoyDeclinePts != null && yoyDeclinePts >= THRESHOLDS.detPts;

    // Momentum: (p2 − r2) − (p1 − r1). Positive = accelerating decline.
    const r2Cf = win?.r2Cf ?? null;
    const r1Cf = win?.r1Cf ?? null;
    const p2Cf = win?.p2Cf ?? null;
    const p1Cf = win?.p1Cf ?? null;
    const enoughHalfMonths =
      !!win &&
      win.r2Months >= THRESHOLDS.minHalfMonths && win.r1Months >= THRESHOLDS.minHalfMonths &&
      win.p2Months >= THRESHOLDS.minHalfMonths && win.p1Months >= THRESHOLDS.minHalfMonths;
    const momentumPts =
      enoughHalfMonths && r2Cf != null && r1Cf != null && p2Cf != null && p1Cf != null
        ? (p2Cf - r2Cf) - (p1Cf - r1Cf)
        : null;

    out.push({
      plantId:       p.id,
      region:        p.region,
      subRegion:     p.subRegion,
      fuelSource:    p.fuelSource,
      nameplateMw:   p.nameplateCapacityMW,
      ttmCf:         stats.ttmAverage,
      peerAvgTtmCf:  peerAvg,
      recentCf,
      priorCf,
      r2Cf,
      r1Cf,
      p2Cf,
      p1Cf,
      yoyDeclinePts,
      momentumPts,
      isDeteriorating,
      isFlagged: isDeteriorating,
      curtailmentScore: stats.curtailmentScore ?? 0,
    });
  }
  return out;
}

/**
 * Compute cap-weighted national YoY CF decline per fuel type.
 * Used as the cohort baseline: subtracting this from sub-region self-trend
 * controls for fleet-wide or weather-wide effects so we flag genuine
 * structural problems rather than a weak wind year.
 *
 * Returns Map<FuelSource (as string), decline in CF fraction> where positive = worse.
 * Only plants with enough months in BOTH windows contribute.
 */
export function computeNationalYoY(analyses: PlantAnalysis[]): Map<string, number | null> {
  // Group cap-weighted prior/recent pairs by tech.
  const priorByTech  = new Map<string, Array<[number, number]>>();
  const recentByTech = new Map<string, Array<[number, number]>>();

  for (const a of analyses) {
    if (a.priorCf == null || a.recentCf == null) continue;
    const t = String(a.fuelSource);
    (priorByTech.get(t)  ?? priorByTech.set(t, []).get(t)!).push([a.priorCf,  a.nameplateMw]);
    (recentByTech.get(t) ?? recentByTech.set(t, []).get(t)!).push([a.recentCf, a.nameplateMw]);
  }

  const result = new Map<string, number | null>();
  for (const t of priorByTech.keys()) {
    const prior  = capWeighted(priorByTech.get(t)!);
    const recent = capWeighted(recentByTech.get(t)!);
    result.set(t, prior != null && recent != null ? prior - recent : null);
  }
  return result;
}

/**
 * Compute per-subregion aggregate stats using the v2 struggle-signal model.
 *
 * Three orthogonal signals — all anchored to the plant's own history, not
 * compared to sibling sub-regions (which drives the regional average):
 *
 *  1. Self-trend       = cap-weighted YoY decline (prior12 CF \u2212 recent12 CF)
 *  2. Excess decline   = self-trend \u2212 national same-tech YoY (removes fleet effects)
 *  3. Breadth          = MW share of individually deteriorating plants
 *  4. Momentum         = acceleration in decline (recent-6mo YoY \u2212 prior-6mo YoY)
 *
 * Struggle score = weighted composite of the four signals (0\u2013100).
 * Suppressed (null) when the sub-region has fewer than minPlantsPerSubregion plants.
 */
export function computeSubregionStats(
  analyses: PlantAnalysis[],
  nationalYoY: Map<string, number | null>,
): SubregionStats[] {
  const groups = new Map<string, PlantAnalysis[]>();
  for (const a of analyses) {
    const key = `${a.region}|${a.subRegion}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
  }

  const out: SubregionStats[] = [];
  const { excessDecline: wExcess, breadth: wBreadth, selfTrend: wSelf, momentum: wMom } =
    THRESHOLDS.struggleWeights;

  for (const [key, arr] of groups.entries()) {
    const [region, subRegion] = key.split('|') as [Region, string];
    const totalMw = arr.reduce((s, a) => s + a.nameplateMw, 0);
    const deterioratingMw = arr.filter(a => a.isDeteriorating).reduce((s, a) => s + a.nameplateMw, 0);
    const flaggedMw = deterioratingMw;

    // ── 1. Self-trend: cap-weighted YoY decline for this sub-region ───────
    const priorPairs  = arr.filter(a => a.priorCf  != null).map(a => [a.priorCf!,  a.nameplateMw] as [number, number]);
    const recentPairs = arr.filter(a => a.recentCf != null).map(a => [a.recentCf!, a.nameplateMw] as [number, number]);
    const cwPrior  = capWeighted(priorPairs);
    const cwRecent = capWeighted(recentPairs);
    const selfTrendPts = cwPrior != null && cwRecent != null ? cwPrior - cwRecent : null;

    // ── 2. Excess decline: subtract national same-tech YoY ────────────────
    // For mixed-tech sub-regions, pick the dominant tech by MW.
    const techMw = new Map<string, number>();
    for (const a of arr) techMw.set(String(a.fuelSource), (techMw.get(String(a.fuelSource)) ?? 0) + a.nameplateMw);
    const dominantTech = [...techMw.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const natYoY = nationalYoY.get(dominantTech) ?? null;
    const excessDeclinePts = selfTrendPts != null && natYoY != null ? selfTrendPts - natYoY : null;

    // ── 3. Breadth: MW share of plants individually deteriorating ─────────
    const breadth = totalMw > 0 ? deterioratingMw / totalMw : 0;

    // ── 4. Momentum: cap-weighted sub-region acceleration ─────────────────
    // recentHalfDecline = capWt(p2Cf) \u2212 capWt(r2Cf)  (most recent 6mo YoY)
    // earlierHalfDecline = capWt(p1Cf) \u2212 capWt(r1Cf) (earlier 6mo YoY)
    // momentum = recentHalfDecline \u2212 earlierHalfDecline  (positive = accelerating)
    const r2Pairs = arr.filter(a => a.r2Cf != null).map(a => [a.r2Cf!, a.nameplateMw] as [number, number]);
    const r1Pairs = arr.filter(a => a.r1Cf != null).map(a => [a.r1Cf!, a.nameplateMw] as [number, number]);
    const p2Pairs = arr.filter(a => a.p2Cf != null).map(a => [a.p2Cf!, a.nameplateMw] as [number, number]);
    const p1Pairs = arr.filter(a => a.p1Cf != null).map(a => [a.p1Cf!, a.nameplateMw] as [number, number]);
    const cwR2 = capWeighted(r2Pairs);
    const cwR1 = capWeighted(r1Pairs);
    const cwP2 = capWeighted(p2Pairs);
    const cwP1 = capWeighted(p1Pairs);
    const recentHalfDecline  = cwP2 != null && cwR2 != null ? cwP2 - cwR2 : null;
    const earlierHalfDecline = cwP1 != null && cwR1 != null ? cwP1 - cwR1 : null;
    const momentumPts =
      recentHalfDecline != null && earlierHalfDecline != null
        ? recentHalfDecline - earlierHalfDecline
        : null;

    // ── 5. Curtailment (supporting context, lower weight) ─────────────────
    const curtPairs = arr.map(a => [a.curtailmentScore, a.nameplateMw] as [number, number]);
    const avgCurt = capWeighted(curtPairs) ?? 0;
    const curtailmentComponent = Math.max(0, Math.min(1, avgCurt / 100));

    // ── 6. Struggle score ─────────────────────────────────────────────────
    const suppressed = arr.length < THRESHOLDS.minPlantsPerSubregion;
    let struggleScore: number | null = null;
    if (!suppressed) {
      const excessNorm   = Math.max(0, Math.min(1, (excessDeclinePts ?? 0) / THRESHOLDS.excessDeclineNorm));
      const selfNorm     = Math.max(0, Math.min(1, (selfTrendPts    ?? 0) / THRESHOLDS.selfTrendNorm));
      const momentumNorm = Math.max(0, Math.min(1, (momentumPts     ?? 0) / THRESHOLDS.momentumNorm));
      struggleScore = Math.round(
        100 * (
          wExcess * excessNorm +
          wBreadth * breadth   +
          wSelf   * selfNorm   +
          wMom    * momentumNorm
        ),
      );
    }

    // ── 7. Diagnosis ──────────────────────────────────────────────────────
    let diagnosisLabel: string | null = null;
    if (!suppressed) {
      diagnosisLabel = breadth >= 0.6 ? 'Systemic' : breadth <= 0.3 ? 'Asset-specific' : 'Mixed';
    }

    // ── 8. TTM CF ─────────────────────────────────────────────────────────
    const cfPairs = arr.map(a => [a.ttmCf, a.nameplateMw] as [number, number]);
    const capWeightedTtmCf = capWeighted(cfPairs);

    out.push({
      region,
      subRegion,
      plantCount: arr.length,
      totalMw,
      capWeightedTtmCf,
      deterioratingMw,
      flaggedMw,
      avgCurtailmentScore: avgCurt,
      struggleScore,
      signalComponents: {
        selfTrendPts,
        excessDeclinePts,
        breadth,
        momentumPts,
        curtailmentComponent,
      },
      diagnosisLabel,
    });
  }

  return out;
}

/** Group stakes into a Map<entity, Map<plantId, sharePct>>. */
function groupOwnerStakes(stakes: OwnershipStake[]): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const s of stakes) {
    let inner = m.get(s.entityName);
    if (!inner) {
      inner = new Map();
      m.set(s.entityName, inner);
    }
    // If duplicate rows appear for the same (entity, plant), keep the max share.
    const prev = inner.get(s.plantId) ?? 0;
    if (s.sharePct > prev) inner.set(s.plantId, s.sharePct);
  }
  return m;
}

function groupLenderStakes(stakes: LenderStake[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const s of stakes) {
    let set = m.get(s.lenderName);
    if (!set) {
      set = new Set();
      m.set(s.lenderName, set);
    }
    set.add(s.plantId);
  }
  return m;
}

interface EntityExposureInput {
  plantsById: Map<string, { plantId: string; eiaCode: string; mw: number; region: Region; subRegion: string; isFlagged: boolean }>;
  ownerStakes: Map<string, Map<string, number>>; // entity → plantId(=eia) → share
  lenderStakes: Map<string, Set<string>>; // lender → set of plantIds (id, not eia)
  scope: { region: Region; subRegion?: string };
  scopeStruggleScore: number | null;
}

function tierFor(exposedMw: number, portfolioShare: number, struggle: number | null): 'hot' | 'warm' | 'cold' {
  const s = struggle ?? 0;
  if (
    s >= THRESHOLDS.struggleHot &&
    (exposedMw >= THRESHOLDS.exposureHotMw || portfolioShare >= THRESHOLDS.exposureHotPortfolioShare)
  ) {
    return 'hot';
  }
  if (s >= THRESHOLDS.struggleWarm && exposedMw >= THRESHOLDS.exposureWarmMw) {
    return 'warm';
  }
  return 'cold';
}

/** Compute owner exposures for a given scope. */
export function computeOwnerExposures(input: EntityExposureInput): EntityExposure[] {
  const out: EntityExposure[] = [];
  const { plantsById, ownerStakes, scope, scopeStruggleScore } = input;
  const inScope = (p: { region: Region; subRegion: string }): boolean =>
    p.region === scope.region && (scope.subRegion == null || p.subRegion === scope.subRegion);

  for (const [entity, stakeMap] of ownerStakes.entries()) {
    let totalTracked = 0;
    let inScopeTotal = 0;
    let exposed = 0;
    const flaggedPlantIds: string[] = [];
    const plantIdsInScope = new Set<string>();

    for (const [eiaOrId, share] of stakeMap.entries()) {
      // Ownership rows key by eia_site_code; plantsById is keyed by both.
      const p = plantsById.get(eiaOrId);
      if (!p) continue;
      const attributed = share * p.mw;
      totalTracked += attributed;
      if (!inScope(p)) continue;
      inScopeTotal += attributed;
      plantIdsInScope.add(p.plantId);
      if (p.isFlagged) {
        exposed += attributed;
        flaggedPlantIds.push(p.plantId);
      }
    }

    if (exposed <= 0 && inScopeTotal <= 0) continue;

    const portfolioShare = totalTracked > 0 ? exposed / totalTracked : 0;
    out.push({
      entityName: entity,
      entityType: 'owner',
      tier: tierFor(exposed, portfolioShare, scopeStruggleScore),
      exposedMw: exposed,
      totalMwInScope: inScopeTotal,
      entityTotalTrackedMw: totalTracked,
      plantCount: plantIdsInScope.size,
      flaggedPlantIds,
      portfolioShare,
      scopeStruggleScore,
    });
  }

  out.sort((a, b) => b.exposedMw - a.exposedMw);
  return out;
}

/** Compute lender exposures for a given scope + coverage stat. */
export function computeLenderExposures(input: EntityExposureInput): {
  exposures: EntityExposure[];
  coverage: LenderCoverage;
} {
  const out: EntityExposure[] = [];
  const { plantsById, lenderStakes, scope, scopeStruggleScore } = input;
  const inScope = (p: { region: Region; subRegion: string }): boolean =>
    p.region === scope.region && (scope.subRegion == null || p.subRegion === scope.subRegion);

  // Lender exposure has no percent split — treat each validated link as 100%.
  for (const [lender, plantIds] of lenderStakes.entries()) {
    let totalTracked = 0;
    let inScopeTotal = 0;
    let exposed = 0;
    const flaggedPlantIds: string[] = [];
    const plantIdsInScope = new Set<string>();

    for (const pid of plantIds) {
      const p = plantsById.get(pid);
      if (!p) continue;
      totalTracked += p.mw;
      if (!inScope(p)) continue;
      inScopeTotal += p.mw;
      plantIdsInScope.add(p.plantId);
      if (p.isFlagged) {
        exposed += p.mw;
        flaggedPlantIds.push(p.plantId);
      }
    }

    if (exposed <= 0 && inScopeTotal <= 0) continue;

    const portfolioShare = totalTracked > 0 ? exposed / totalTracked : 0;
    out.push({
      entityName: lender,
      entityType: 'lender',
      tier: tierFor(exposed, portfolioShare, scopeStruggleScore),
      exposedMw: exposed,
      totalMwInScope: inScopeTotal,
      entityTotalTrackedMw: totalTracked,
      plantCount: plantIdsInScope.size,
      flaggedPlantIds,
      portfolioShare,
      scopeStruggleScore,
    });
  }
  out.sort((a, b) => b.exposedMw - a.exposedMw);

  // Coverage: of FLAGGED plants in scope, how many have any validated lender?
  const flaggedInScope: string[] = [];
  for (const p of plantsById.values()) {
    if (!inScope(p)) continue;
    if (p.isFlagged) flaggedInScope.push(p.plantId);
  }
  const flaggedSet = new Set(flaggedInScope);
  let coveredCount = 0;
  for (const pids of lenderStakes.values()) {
    for (const pid of pids) {
      if (flaggedSet.has(pid)) {
        coveredCount++;
        break;
      }
    }
  }
  // Above counts lenders that touch any flagged plant; we actually want
  // # flagged plants that have ≥1 validated lender. Recompute properly:
  coveredCount = 0;
  for (const pid of flaggedInScope) {
    let covered = false;
    for (const pids of lenderStakes.values()) {
      if (pids.has(pid)) { covered = true; break; }
    }
    if (covered) coveredCount++;
  }
  const coverage: LenderCoverage = {
    flaggedPlantsInScope: flaggedInScope.length,
    flaggedPlantsWithValidatedLender: coveredCount,
    ratio: flaggedInScope.length > 0 ? coveredCount / flaggedInScope.length : 0,
  };

  return { exposures: out, coverage };
}

// ─── Top-level orchestrator ─────────────────────────────────────────────────

export interface RegionalAnalysisResult {
  benchmarks: Benchmarks;
  analyses: PlantAnalysis[];
  subregionStats: SubregionStats[];
  /** Convenience lookup: `${region}|${subRegion}` → stats. */
  subregionStatsMap: Map<string, SubregionStats>;
  /** Convenience lookup: `region` → cap-weighted TTM CF across selected techs. */
  regionCapWeightedCf: Map<Region, number>;
  /** National cap-weighted YoY CF decline per tech (positive = worse). */
  nationalYoY: Map<string, number | null>;
}

/**
 * Build the derived analysis surface. Purely from the loaded fleet + statsMap
 * + CF windows. Ownership / lender fetching is separate (see fetchOwnership*).
 */
export function buildRegionalAnalysis(
  plants: PowerPlant[],
  statsMap: Record<string, CapacityFactorStats>,
  cfWindows: Map<string, CfWindow>,
  techFilter: FuelSource[],
): RegionalAnalysisResult {
  const benchmarks   = computeBenchmarks(plants, statsMap);
  const analyses     = computePlantAnalyses(plants, statsMap, cfWindows, benchmarks, techFilter);
  const nationalYoY  = computeNationalYoY(analyses);
  const subregionStats = computeSubregionStats(analyses, nationalYoY);

  const subregionStatsMap = new Map<string, SubregionStats>();
  for (const s of subregionStats) {
    subregionStatsMap.set(`${s.region}|${s.subRegion}`, s);
  }

  const regionCapWeightedCf = new Map<Region, number>();
  const regionAgg = new Map<Region, Array<[number, number]>>();
  for (const a of analyses) {
    (regionAgg.get(a.region) ?? regionAgg.set(a.region, []).get(a.region)!).push([a.ttmCf, a.nameplateMw]);
  }
  for (const [region, arr] of regionAgg.entries()) {
    const v = capWeighted(arr);
    if (v != null) regionCapWeightedCf.set(region, v);
  }

  return { benchmarks, analyses, subregionStats, subregionStatsMap, regionCapWeightedCf, nationalYoY };
}

/** Build the plantsById map consumed by exposure functions. */
export function buildPlantsById(
  plants: PowerPlant[],
  analyses: PlantAnalysis[],
): Map<string, { plantId: string; eiaCode: string; mw: number; region: Region; subRegion: string; isFlagged: boolean }> {
  const flaggedIds = new Set(analyses.filter(a => a.isFlagged).map(a => a.plantId));
  const analysisRegions = new Set<Region>(ANALYSIS_REGIONS);
  const m = new Map<string, { plantId: string; eiaCode: string; mw: number; region: Region; subRegion: string; isFlagged: boolean }>();
  for (const p of plants) {
    if (!analysisRegions.has(p.region)) continue;
    if (!ANALYSIS_TECHS.includes(p.fuelSource)) continue;
    const rec = {
      plantId: p.id,
      eiaCode: p.eiaPlantCode,
      mw: p.nameplateCapacityMW,
      region: p.region,
      subRegion: p.subRegion,
      isFlagged: flaggedIds.has(p.id),
    };
    // Key by BOTH id and eiaCode so ownership rows (keyed by eia_site_code)
    // and lender rows (keyed by plant_id) both resolve to the same record.
    m.set(p.id, rec);
    if (p.eiaPlantCode && p.eiaPlantCode !== p.id) m.set(p.eiaPlantCode, rec);
  }
  return m;
}

/** Convenience helper — assemble the compound owner exposures for a scope. */
export function ownerExposuresForScope(
  plantsById: ReturnType<typeof buildPlantsById>,
  ownerStakes: OwnershipStake[],
  scope: { region: Region; subRegion?: string },
  scopeStruggleScore: number | null,
): EntityExposure[] {
  return computeOwnerExposures({
    plantsById,
    ownerStakes: groupOwnerStakes(ownerStakes),
    lenderStakes: new Map(),
    scope,
    scopeStruggleScore,
  });
}

/** Convenience helper — assemble the compound lender exposures for a scope. */
export function lenderExposuresForScope(
  plantsById: ReturnType<typeof buildPlantsById>,
  lenderStakes: LenderStake[],
  scope: { region: Region; subRegion?: string },
  scopeStruggleScore: number | null,
): { exposures: EntityExposure[]; coverage: LenderCoverage } {
  return computeLenderExposures({
    plantsById,
    ownerStakes: new Map(),
    lenderStakes: groupLenderStakes(lenderStakes),
    scope,
    scopeStruggleScore,
  });
}

// ─── Top BD Targets ──────────────────────────────────────────────────────────

/**
 * Produce a ranked list of BD targets from the scoped owner + lender exposures.
 *
 * Candidates = hot + warm exposures from both entity types.
 * Priority score formula (tunable via THRESHOLDS.priorityWeights):
 *   score = norm(exposedMw) × mwWeight
 *         + portfolioShare   × concentrationWeight
 *         + struggleScore/100 × distressWeight
 *
 * Revenue-at-risk uses each plant's own YoY CF decline (not peer comparison),
 * pro-rated by entity share, multiplied by AVG_REALIZED_PRICE_BY_REGION.
 * Label this as a directional estimate in the UI; not a price forecast.
 */
export function computeTopTargets(
  ownerExposures: EntityExposure[],
  lenderExposures: EntityExposure[],
  analyses: PlantAnalysis[],
  benchmarks: Benchmarks,
): TopTarget[] {
  const candidates = [
    ...ownerExposures.filter(e => e.tier !== 'cold'),
    ...lenderExposures.filter(e => e.tier !== 'cold'),
  ];
  if (candidates.length === 0) return [];

  const analysesById = new Map<string, PlantAnalysis>();
  for (const a of analyses) analysesById.set(a.plantId, a);

  const maxMw = Math.max(...candidates.map(c => c.exposedMw), 1);
  const { mwWeight, concentrationWeight, distressWeight } = THRESHOLDS.priorityWeights;

  const scored: TopTarget[] = candidates.map(e => {
    const mwNorm      = e.exposedMw / maxMw;
    const struggleNorm = e.scopeStruggleScore != null ? e.scopeStruggleScore / 100 : 0;
    const priorityScore =
      mwNorm * mwWeight + e.portfolioShare * concentrationWeight + struggleNorm * distressWeight;

    const flaggedAnalyses = e.flaggedPlantIds
      .map(id => analysesById.get(id))
      .filter((a): a is PlantAnalysis => a != null);

    const totalFlaggedNominalMw = flaggedAnalyses.reduce((s, a) => s + a.nameplateMw, 0);
    const uniqueSubRegions = new Set<string>();
    let revenueAtRiskUsd: number | null = null;

    if (flaggedAnalyses.length > 0) {
      let totalRisk = 0;
      for (const a of flaggedAnalyses) {
        uniqueSubRegions.add(a.subRegion);
        if (a.yoyDeclinePts == null || a.yoyDeclinePts <= 0) continue;
        // Pro-rata MW attribution by nameplate share.
        const proRataMw = totalFlaggedNominalMw > 0
          ? (a.nameplateMw / totalFlaggedNominalMw) * e.exposedMw
          : 0;
        const price = AVG_REALIZED_PRICE_BY_REGION[String(a.region)] ?? 35;
        // Revenue lost = MW × hours × YoY CF decline × price ($/MWh)
        totalRisk += proRataMw * 8760 * a.yoyDeclinePts * price;
      }
      revenueAtRiskUsd = totalRisk > 0 ? totalRisk / 1_000_000 : null; // → $M
    }

    // Build the "why now" sentence using YoY decline instead of peer delta.
    const verb = e.entityType === 'owner' ? 'Owns' : 'Finances';
    const subList = Array.from(uniqueSubRegions);
    const subStr = subList.length > 0 ? subList.slice(0, 3).join(', ') : 'the region';
    const n = e.flaggedPlantIds.length;
    const m = e.plantCount;

    let cfNote = '';
    if (flaggedAnalyses.length > 0) {
      const cwDecline =
        flaggedAnalyses.reduce((s, a) => s + (a.yoyDeclinePts ?? 0) * a.nameplateMw, 0) /
        Math.max(1, flaggedAnalyses.reduce((s, a) => s + a.nameplateMw, 0));
      if (cwDecline > 0.001) {
        cfNote = `; CF down ${(cwDecline * 100).toFixed(1)} pts YoY`;
      }
    }

    const whyNow =
      `${verb} ${Math.round(e.exposedMw)} MW across ${subStr} ` +
      `where ${n} of ${m} tracked assets are deteriorating${cfNote}.`;

    return {
      entityName: e.entityName,
      entityType: e.entityType,
      tier: e.tier,
      exposedMw: e.exposedMw,
      flaggedPlantCount: e.flaggedPlantIds.length,
      portfolioShare: e.portfolioShare,
      priorityScore,
      revenueAtRiskUsd,
      whyNow,
      subRegions: subList,
    };
  });

  scored.sort((a, b) => b.priorityScore - a.priorityScore);
  return scored.slice(0, THRESHOLDS.topTargetsCount);
}

// ─── Lender Briefings ────────────────────────────────────────────────────────

/**
 * Build per-lender outreach briefings for hot/warm lender exposures.
 *
 * For each lender, we aggregate the struggle signals across their flagged
 * sub-regions, weight by exposed MW, and generate a ready-to-use outreach
 * paragraph in regional framing (no plant-level CF disclosed).
 *
 * The narrative is safe to include verbatim in a client email:
 *   "ERCOT West wind CF declined 4.2 pts YoY (vs 0.6 pts nationally);
 *    decline spans 78% of installed MW and is accelerating.
 *    Our data shows validated financing exposure in this zone worth
 *    approximately 220 MW of deteriorating assets."
 */
export function buildLenderBriefings(
  lenderExposures: EntityExposure[],
  subregionStatsMap: Map<string, SubregionStats>,
  analysesById: Map<string, PlantAnalysis>,
): LenderBriefing[] {
  const briefings: LenderBriefing[] = [];

  for (const e of lenderExposures) {
    if (e.tier === 'cold') continue;

    // Gather flagged plant analyses and group by sub-region.
    const flaggedAnalyses = e.flaggedPlantIds
      .map(id => analysesById.get(id))
      .filter((a): a is PlantAnalysis => a != null);

    const subRegionMw = new Map<string, number>(); // subKey → exposed MW
    const subRegionRegion = new Map<string, Region>();
    for (const a of flaggedAnalyses) {
      const k = `${a.region}|${a.subRegion}`;
      subRegionMw.set(k, (subRegionMw.get(k) ?? 0) + a.nameplateMw);
      subRegionRegion.set(k, a.region);
    }

    const subRegionBreakdowns: LenderBriefing['subRegionBreakdowns'] = [];
    let weightedStruggleNum = 0;
    let weightedStruggleDen = 0;

    for (const [k, mw] of subRegionMw.entries()) {
      const s = subregionStatsMap.get(k);
      const [, subRegion] = k.split('|');
      const region = subRegionRegion.get(k)!;
      subRegionBreakdowns.push({
        subRegion,
        region,
        exposedMw: mw,
        struggleScore:     s?.struggleScore     ?? null,
        selfTrendPts:      s?.signalComponents.selfTrendPts     ?? null,
        excessDeclinePts:  s?.signalComponents.excessDeclinePts ?? null,
        breadth:           s?.signalComponents.breadth          ?? 0,
        momentumPts:       s?.signalComponents.momentumPts      ?? null,
        diagnosisLabel:    s?.diagnosisLabel    ?? null,
        avgCurtailmentScore: s?.avgCurtailmentScore ?? 0,
      });
      if (s?.struggleScore != null) {
        weightedStruggleNum += s.struggleScore * mw;
        weightedStruggleDen += mw;
      }
    }
    subRegionBreakdowns.sort((a, b) => b.exposedMw - a.exposedMw);

    const weightedStruggleScore = weightedStruggleDen > 0
      ? Math.round(weightedStruggleNum / weightedStruggleDen)
      : null;

    // ── Generate outreach narrative ───────────────────────────────────────
    const totalMw = Math.round(e.exposedMw);
    let outreachNarrative = '';

    if (subRegionBreakdowns.length === 1) {
      const bd = subRegionBreakdowns[0];
      const selfPts    = bd.selfTrendPts     != null ? (bd.selfTrendPts     * 100).toFixed(1) : null;
      const excessPts  = bd.excessDeclinePts != null ? (bd.excessDeclinePts * 100).toFixed(1) : null;
      const breadthPct = Math.round(bd.breadth * 100);
      const accel      = bd.momentumPts != null && bd.momentumPts > 0.005;

      const declineClause = selfPts != null
        ? `CF declined ${selfPts} pts YoY${excessPts != null ? ` (${Number(excessPts) >= 0 ? '+' : ''}${excessPts} pts vs national trend)` : ''}`
        : 'CF showing deterioration';
      const breadthClause = `decline spans ${breadthPct}% of installed MW`;
      const accelClause   = accel ? ' and is accelerating' : '';
      const diagClause    = bd.diagnosisLabel ? ` (${bd.diagnosisLabel.toLowerCase()} pattern)` : '';

      outreachNarrative =
        `${bd.region} \u2014 ${bd.subRegion}: ${declineClause}; ` +
        `${breadthClause}${accelClause}${diagClause}. ` +
        `Our data shows validated financing exposure in this zone worth approximately ${totalMw} MW of deteriorating assets.`;
    } else if (subRegionBreakdowns.length > 1) {
      const worst = subRegionBreakdowns[0]; // highest exposed MW
      const otherNames = subRegionBreakdowns.slice(1).map(b => b.subRegion).join(', ');
      const selfPts = worst.selfTrendPts != null ? `${(worst.selfTrendPts * 100).toFixed(1)} pts` : 'measurable deterioration';
      const accel   = worst.momentumPts != null && worst.momentumPts > 0.005;

      outreachNarrative =
        `${worst.region} shows CF deterioration across multiple sub-regions: ` +
        `${worst.subRegion} (down ${selfPts} YoY) and ${otherNames}. ` +
        `${accel ? 'The decline is accelerating. ' : ''}` +
        `Our data shows validated financing exposure totalling approximately ${totalMw} MW across these zones.`;
    } else {
      outreachNarrative =
        `Our data shows validated financing exposure of approximately ${totalMw} MW ` +
        `in a sub-region exhibiting CF deterioration.`;
    }

    briefings.push({
      lenderName: e.entityName,
      tier: e.tier,
      exposedMw: e.exposedMw,
      flaggedPlantCount: e.flaggedPlantIds.length,
      portfolioShare: e.portfolioShare,
      weightedStruggleScore,
      subRegionBreakdowns,
      outreachNarrative,
    });
  }

  briefings.sort((a, b) => (b.weightedStruggleScore ?? 0) - (a.weightedStruggleScore ?? 0));
  return briefings;
}

// ─── Phase 3 — Sub-region sparkline RPC ──────────────────────────────────────

// ─── Phase 3 — Sub-region sparkline RPC ──────────────────────────────────────

/**
 * Fetch 24 months of capacity-weighted CF per sub-region for a given region+tech.
 * Calls the `get_subregion_monthly_cf` RPC which must be deployed separately.
 * Returns an empty map on failure — sparklines are optional context, not critical.
 *
 * Key = subRegion label, Value = array of CF values (chronological, last 24 months).
 * When techFilter is "Both", call twice (Wind + Solar) and merge via cap-weighted avg
 * — for now the caller passes the dominant tech to keep the RPC count low.
 */
// ─── 5-year persistence helpers ──────────────────────────────────────────────

/**
 * Fetch annual CF data for all Wind + Solar plants via the get_plant_annual_cf RPC.
 * Returns an empty array when the RPC has not yet been deployed or data unavailable
 * (caller should degrade gracefully — persistence badge simply absent).
 */
export async function fetchPlantAnnualCf(): Promise<AnnualCfRow[]> {
  try {
    const { data, error } = await supabase.rpc('get_plant_annual_cf');
    if (error) {
      console.warn('[RegionalAnalysis] get_plant_annual_cf RPC failed:', error.message);
      return [];
    }
    return (data ?? []) as AnnualCfRow[];
  } catch (err) {
    console.warn('[RegionalAnalysis] fetchPlantAnnualCf threw:', err);
    return [];
  }
}

/** Minimum CF decline (in CF fraction, not %) to count as a "down year". */
const DOWN_YEAR_MIN_DECLINE = 0.01; // 1 percentage point
/** Minimum qualifying annual data points (≥10 months each) for persistence analysis. */
const MIN_ANNUAL_POINTS = 4;

/**
 * Compute per-plant persistence from annual CF rows.
 * Excludes plants marked history_unreliable in the analyses map.
 */
export function computePlantPersistence(
  annualRows: AnnualCfRow[],
  analysesById: Map<string, { plantId: string; isFlagged: boolean }>,
  historyUnreliablePlantIds: Set<string>,
): Map<string, PlantPersistence> {
  // Group by plant_id
  const byPlant = new Map<string, { year: number; cf: number }[]>();
  for (const row of annualRows) {
    if (!byPlant.has(row.plant_id)) byPlant.set(row.plant_id, []);
    byPlant.get(row.plant_id)!.push({ year: row.year, cf: row.year_cf });
  }

  const result = new Map<string, PlantPersistence>();
  for (const [plantId, pts] of byPlant) {
    const excluded = historyUnreliablePlantIds.has(plantId);
    const sorted = pts.sort((a, b) => a.year - b.year);

    if (excluded || sorted.length < MIN_ANNUAL_POINTS) {
      result.set(plantId, {
        plantId, annualPoints: sorted, downYears: 0,
        slopeCfPerYear: null, persistentDecline: false, excluded,
      });
      continue;
    }

    // Count consecutive down years ending at the most recent qualifying year
    let downYears = 0;
    for (let i = sorted.length - 1; i >= 1; i--) {
      const yoyDecline = sorted[i - 1].cf - sorted[i].cf; // positive = decline
      if (yoyDecline >= DOWN_YEAR_MIN_DECLINE) {
        downYears++;
      } else {
        break; // must be consecutive
      }
    }

    // OLS slope using all qualifying points (x = year − mean_year, y = cf)
    let slopeCfPerYear: number | null = null;
    if (sorted.length >= 2) {
      const n = sorted.length;
      const meanX = sorted.reduce((s, p) => s + p.year, 0) / n;
      const meanY = sorted.reduce((s, p) => s + p.cf, 0) / n;
      const ssXY = sorted.reduce((s, p) => s + (p.year - meanX) * (p.cf - meanY), 0);
      const ssXX = sorted.reduce((s, p) => s + Math.pow(p.year - meanX, 2), 0);
      if (ssXX > 0) slopeCfPerYear = ssXY / ssXX;
    }

    result.set(plantId, {
      plantId, annualPoints: sorted, downYears,
      slopeCfPerYear, persistentDecline: downYears >= 3, excluded,
    });
  }
  return result;
}

/** Threshold: sub-region gets persistence badge when ≥25% of eligible plants have persistentDecline. */
const PERSISTENCE_BADGE_THRESHOLD = 0.25;
const PERSISTENCE_MIN_ELIGIBLE = 3;

/**
 * Aggregate plant persistence records onto sub-region stats.
 * Mutates the `persistence` field on each SubregionStats entry.
 */
export function applyPersistenceToSubregions(
  subregionStats: SubregionStats[],
  plantPersistence: Map<string, PlantPersistence>,
  analysesById: Map<string, { plantId: string; region: Region; subRegion: string }>,
): void {
  // Group plant persistence by (region, subRegion)
  const bySubregion = new Map<string, PlantPersistence[]>();
  for (const [plantId, pp] of plantPersistence) {
    const analysis = analysesById.get(plantId);
    if (!analysis) continue;
    const key = `${analysis.region}|${analysis.subRegion}`;
    if (!bySubregion.has(key)) bySubregion.set(key, []);
    bySubregion.get(key)!.push(pp);
  }

  for (const stat of subregionStats) {
    const key = `${stat.region}|${stat.subRegion}`;
    const plants = bySubregion.get(key) ?? [];
    const eligible = plants.filter(p => !p.excluded && p.annualPoints.length >= MIN_ANNUAL_POINTS);
    if (eligible.length === 0) {
      stat.persistence = null;
      continue;
    }
    const persistentCount = eligible.filter(p => p.persistentDecline).length;
    const share = persistentCount / eligible.length;
    const avgDownYears = eligible.reduce((s, p) => s + p.downYears, 0) / eligible.length;
    stat.persistence = {
      eligiblePlants: eligible.length,
      persistentDeclinePlants: persistentCount,
      persistentDeclineShare: share,
      hasBadge: share >= PERSISTENCE_BADGE_THRESHOLD && eligible.length >= PERSISTENCE_MIN_ELIGIBLE,
      avgDownYears,
    };
  }
}

export async function fetchSubregionMonthlyCf(
  region: Region,
  fuelSource: FuelSource,
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  try {
    const { data, error } = await supabase.rpc('get_subregion_monthly_cf', {
      p_region: String(region),
      p_fuel_source: String(fuelSource),
    });
    if (error) {
      console.warn('[RegionalAnalysis] get_subregion_monthly_cf RPC failed:', error.message);
      return result;
    }
    for (const row of (data ?? []) as any[]) {
      const sr = String(row.sub_region ?? '');
      const cf = row.cap_weighted_cf == null ? null : Number(row.cap_weighted_cf);
      if (!sr || cf == null || !Number.isFinite(cf)) continue;
      if (!result.has(sr)) result.set(sr, []);
      result.get(sr)!.push(cf);
    }
  } catch (err) {
    console.warn('[RegionalAnalysis] fetchSubregionMonthlyCf threw:', err);
  }
  return result;
}

// ─── CSP watchlist ────────────────────────────────────────────────────────────

export interface CspWatchlistEntry {
  id: string;
  name: string;
  region: string;
  state: string;
  nameplateCapacityMw: number;
  ttmAvgFactor: number | null;
  yoyDeclinePts: number | null; // prior_cf - recent_cf (positive = decline)
  owner: string;
}

/**
 * Fetch all plants with fuel_source = 'Solar Thermal' for the CSP Watchlist card.
 * Returns an empty array when no CSP plants exist yet (prior to a 60-month backfill run).
 */
export async function fetchCspWatchlist(): Promise<CspWatchlistEntry[]> {
  try {
    const { data, error } = await supabase
      .from('plants')
      .select('id, name, region, state, nameplate_capacity_mw, ttm_avg_factor, owner')
      .eq('fuel_source', 'Solar Thermal')
      .order('nameplate_capacity_mw', { ascending: false });

    if (error) {
      console.warn('[RegionalAnalysis] fetchCspWatchlist query failed:', error.message);
      return [];
    }
    if (!data || data.length === 0) return [];

    // Fetch CF windows for YoY column (uses the same get_plant_cf_windows RPC but we
    // only want the CSP subset). Since CSP is excluded from that RPC's fuel filter,
    // we compute a rough YoY from ttm_avg_factor alone for now — the RPC will be
    // updated separately.
    return (data as any[]).map(row => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      region: String(row.region ?? ''),
      state: String(row.state ?? ''),
      nameplateCapacityMw: Number(row.nameplate_capacity_mw ?? 0),
      ttmAvgFactor: row.ttm_avg_factor != null ? Number(row.ttm_avg_factor) : null,
      yoyDeclinePts: null, // Populated by a future CSP-specific RPC
      owner: String(row.owner ?? 'Unknown'),
    }));
  } catch (err) {
    console.warn('[RegionalAnalysis] fetchCspWatchlist threw:', err);
    return [];
  }
}

// ─── Sub-region lender ingestion ──────────────────────────────────────────────

/** Summary of lender-research candidates for a given sub-region. */
export interface SubregionResearchCandidate {
  plantId: string;
  plantName: string;
  nameplateCapacityMw: number;
  /** True when this plant has been researched within the last 90 days. */
  recentlyResearched: boolean;
  /** True when this plant already has at least one validated lender link. */
  hasValidatedLink: boolean;
}

/**
 * Fetch lender-research candidates for a given (region, subRegion).
 * Returns flagged (deteriorating) plants that lack validated financing and
 * have not been researched in the last 90 days.
 *
 * Admin-only — caller must gate on userRole === 'admin'.
 */
export async function fetchSubregionResearchCandidates(
  region: Region,
  subRegion: string,
  plantAnalyses: { plantId: string; isFlagged: boolean; region: string; subRegion: string }[],
): Promise<SubregionResearchCandidate[]> {
  // Step 1: filter flagged plants in this sub-region
  const flaggedInSub = plantAnalyses.filter(
    a => a.region === String(region) && a.subRegion === subRegion && a.isFlagged,
  );
  if (flaggedInSub.length === 0) return [];

  const plantIds = flaggedInSub.map(a => a.plantId);

  // Step 2: fetch plant names + capacity
  const { data: plantRows, error: plantErr } = await supabase
    .from('plants')
    .select('id, name, nameplate_capacity_mw')
    .in('id', plantIds);

  if (plantErr) {
    console.warn('[RegionalAnalysis] fetchSubregionResearchCandidates plants error:', plantErr.message);
    return [];
  }
  const plantMeta = new Map((plantRows ?? []).map((r: any) => [String(r.id), r]));

  // Step 3: fetch validated lender links for these plants
  const { data: finRows, error: finErr } = await supabase
    .from('v_plant_financing')
    .select('plant_id, validated_at')
    .in('plant_id', plantIds)
    .not('validated_at', 'is', null);

  const validatedPlantIds = new Set<string>(
    finErr ? [] : (finRows ?? []).map((r: any) => String(r.plant_id)),
  );

  // Step 4: fetch recent research timestamps
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: resRows, error: resErr } = await supabase
    .from('plant_lender_research')
    .select('plant_id, researched_at')
    .in('plant_id', plantIds)
    .gte('researched_at', cutoff);

  const recentlyResearchedIds = new Set<string>(
    resErr ? [] : (resRows ?? []).map((r: any) => String(r.plant_id)),
  );

  return plantIds.map(id => {
    const meta = plantMeta.get(id);
    return {
      plantId: id,
      plantName: meta ? String(meta.name) : id,
      nameplateCapacityMw: meta ? Number(meta.nameplate_capacity_mw ?? 0) : 0,
      recentlyResearched: recentlyResearchedIds.has(id),
      hasValidatedLink: validatedPlantIds.has(id),
    };
  });
}
