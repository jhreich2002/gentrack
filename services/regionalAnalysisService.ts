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
  /** A plant is "underperforming" if TTM CF < peerAvg × (1 − relUnderperf). */
  relUnderperf: 0.10,
  /** A plant is "deteriorating" if (prior_cf − recent_cf) ≥ detPts (as CF fraction). */
  detPts: 0.03,
  /** Minimum non-null months in EACH window before deterioration is trusted. */
  minMonths: 8,
  /** Suppress subregion stats when eligible plant count is below this. */
  minPlantsPerSubregion: 3,
  /** Data-months floor for a plant to be eligible at all. */
  minDataMonths: 6,

  /** HOT tier requires distress score ≥ this. */
  distressHot: 60,
  /** WARM tier requires distress score ≥ this. */
  distressWarm: 35,

  /** HOT tier requires exposed MW ≥ this OR portfolio share ≥ exposureHotPortfolioShare. */
  exposureHotMw: 100,
  exposureHotPortfolioShare: 0.25,
  /** WARM tier requires at least this much exposed MW. */
  exposureWarmMw: 25,

  // ── Top Targets BD scoring (Phase 2) ─────────────────────────────────────────────
  /**
   * Priority score weights: priorityScore = exposedMwNorm*mwWeight
   *   + portfolioShare*concentrationWeight + (distressScore/100)*distressWeight.
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
  recentCf: number | null;
  priorCf: number | null;
  recentMonths: number;
  priorMonths: number;
}

/** Flags computed per plant for use in the analysis. */
export interface PlantAnalysis {
  plantId: string;
  region: Region;
  subRegion: string;
  fuelSource: FuelSource;
  nameplateMw: number;
  ttmCf: number;
  peerAvgTtmCf: number | null;
  recentCf: number | null;
  priorCf: number | null;
  deteriorationPts: number | null; // priorCf − recentCf (positive = getting worse)
  isDeteriorating: boolean;
  isUnderperforming: boolean;
  isFlagged: boolean; // isDeteriorating || isUnderperforming
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
  plantCount: number; // eligible plants only
  totalMw: number;
  capWeightedTtmCf: number | null;
  deterioratingMw: number;
  underperformingMw: number;
  flaggedMw: number; // union of the two
  avgCurtailmentScore: number;
  /** 0–100 distress score, or null when suppressed (too few plants). */
  distressScore: number | null;
  distressComponents: {
    deteriorationShare: number; // 0–1, MW-weighted
    underperformingShare: number; // 0–1, MW-weighted
    curtailmentComponent: number; // 0–1, cap-weighted curtailmentScore / 100
  };
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
  /** Distress score of the scope this row was computed against (for tier context). */
  scopeDistressScore: number | null;
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
  /** Estimated annual revenue at risk in $M, or null when data is insufficient. */
  revenueAtRiskUsd: number | null;
  /** One-sentence pitch hook for the BD conversation. */
  whyNow: string;
  /** Unique sub-regions containing this entity's flagged exposure. */
  subRegions: string[];
}

// ─── RPC + bulk fetch functions ─────────────────────────────────────────────

/**
 * Fetch two 12-month CF windows per plant (Wind + Solar).
 * Returns an empty map + rpcError flag on failure so the UI can show
 * the right diagnostic: "RPC not deployed" vs "no data".
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
        recentCf: row.recent_cf == null ? null : Number(row.recent_cf),
        priorCf: row.prior_cf == null ? null : Number(row.prior_cf),
        recentMonths: Number(row.recent_months ?? 0),
        priorMonths: Number(row.prior_months ?? 0),
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

/** Compute per-plant analysis flags (deterioration / underperformance). */
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

    const peerKey = `${p.region}|${p.subRegion}|${p.fuelSource}`;
    const peerAvg = benchmarks.subRegionTech.get(peerKey) ?? null;

    const win = cfWindows.get(p.id);
    const recentCf = win?.recentCf ?? null;
    const priorCf = win?.priorCf ?? null;
    const enoughMonths =
      !!win && win.recentMonths >= THRESHOLDS.minMonths && win.priorMonths >= THRESHOLDS.minMonths;
    const detPts = recentCf != null && priorCf != null ? priorCf - recentCf : null;
    const isDeteriorating =
      enoughMonths && detPts != null && detPts >= THRESHOLDS.detPts;

    const isUnderperforming =
      peerAvg != null &&
      stats.ttmAverage > 0 &&
      stats.ttmAverage < peerAvg * (1 - THRESHOLDS.relUnderperf);

    out.push({
      plantId: p.id,
      region: p.region,
      subRegion: p.subRegion,
      fuelSource: p.fuelSource,
      nameplateMw: p.nameplateCapacityMW,
      ttmCf: stats.ttmAverage,
      peerAvgTtmCf: peerAvg,
      recentCf,
      priorCf,
      deteriorationPts: detPts,
      isDeteriorating,
      isUnderperforming,
      isFlagged: isDeteriorating || isUnderperforming,
      curtailmentScore: stats.curtailmentScore ?? 0,
    });
  }
  return out;
}

/** Compute per-subregion aggregate stats + distress score. */
export function computeSubregionStats(
  analyses: PlantAnalysis[],
  benchmarks: Benchmarks,
  techFilter: FuelSource[],
): SubregionStats[] {
  const groups = new Map<string, PlantAnalysis[]>();
  for (const a of analyses) {
    const key = `${a.region}|${a.subRegion}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
  }

  const out: SubregionStats[] = [];
  for (const [key, arr] of groups.entries()) {
    const [region, subRegion] = key.split('|') as [Region, string];
    const totalMw = arr.reduce((s, a) => s + a.nameplateMw, 0);
    const deterioratingMw = arr.filter(a => a.isDeteriorating).reduce((s, a) => s + a.nameplateMw, 0);
    const underperformingMw = arr.filter(a => a.isUnderperforming).reduce((s, a) => s + a.nameplateMw, 0);
    const flaggedMw = arr.filter(a => a.isFlagged).reduce((s, a) => s + a.nameplateMw, 0);

    // Cap-weighted subregion CF (over the selected techs).
    const cfPairs = arr.map(a => [a.ttmCf, a.nameplateMw] as [number, number]);
    const capWeightedTtmCf = capWeighted(cfPairs);

    // Cap-weighted curtailment score.
    const curtPairs = arr.map(a => [a.curtailmentScore, a.nameplateMw] as [number, number]);
    const avgCurt = capWeighted(curtPairs) ?? 0;

    const deteriorationShare = totalMw > 0 ? deterioratingMw / totalMw : 0;
    const underperformingShare = totalMw > 0 ? underperformingMw / totalMw : 0;
    const curtailmentComponent = Math.max(0, Math.min(1, avgCurt / 100));

    const suppressed = arr.length < THRESHOLDS.minPlantsPerSubregion;
    const distressScore = suppressed
      ? null
      : Math.round(
          100 * (0.5 * deteriorationShare + 0.3 * underperformingShare + 0.2 * curtailmentComponent),
        );

    out.push({
      region,
      subRegion,
      plantCount: arr.length,
      totalMw,
      capWeightedTtmCf,
      deterioratingMw,
      underperformingMw,
      flaggedMw,
      avgCurtailmentScore: avgCurt,
      distressScore,
      distressComponents: { deteriorationShare, underperformingShare, curtailmentComponent },
    });
  }

  // Silence lint about unused benchmarks param — signature kept for future use.
  void benchmarks;
  void techFilter;

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
  scopeDistressScore: number | null;
}

function tierFor(exposedMw: number, portfolioShare: number, distress: number | null): 'hot' | 'warm' | 'cold' {
  const d = distress ?? 0;
  if (
    d >= THRESHOLDS.distressHot &&
    (exposedMw >= THRESHOLDS.exposureHotMw || portfolioShare >= THRESHOLDS.exposureHotPortfolioShare)
  ) {
    return 'hot';
  }
  if (d >= THRESHOLDS.distressWarm && exposedMw >= THRESHOLDS.exposureWarmMw) {
    return 'warm';
  }
  return 'cold';
}

/** Compute owner exposures for a given scope. */
export function computeOwnerExposures(input: EntityExposureInput): EntityExposure[] {
  const out: EntityExposure[] = [];
  const { plantsById, ownerStakes, scope, scopeDistressScore } = input;
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
      tier: tierFor(exposed, portfolioShare, scopeDistressScore),
      exposedMw: exposed,
      totalMwInScope: inScopeTotal,
      entityTotalTrackedMw: totalTracked,
      plantCount: plantIdsInScope.size,
      flaggedPlantIds,
      portfolioShare,
      scopeDistressScore,
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
  const { plantsById, lenderStakes, scope, scopeDistressScore } = input;
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
      tier: tierFor(exposed, portfolioShare, scopeDistressScore),
      exposedMw: exposed,
      totalMwInScope: inScopeTotal,
      entityTotalTrackedMw: totalTracked,
      plantCount: plantIdsInScope.size,
      flaggedPlantIds,
      portfolioShare,
      scopeDistressScore,
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
  const benchmarks = computeBenchmarks(plants, statsMap);
  const analyses = computePlantAnalyses(plants, statsMap, cfWindows, benchmarks, techFilter);
  const subregionStats = computeSubregionStats(analyses, benchmarks, techFilter);

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

  return { benchmarks, analyses, subregionStats, subregionStatsMap, regionCapWeightedCf };
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
  scopeDistressScore: number | null,
): EntityExposure[] {
  return computeOwnerExposures({
    plantsById,
    ownerStakes: groupOwnerStakes(ownerStakes),
    lenderStakes: new Map(),
    scope,
    scopeDistressScore,
  });
}

/** Convenience helper — assemble the compound lender exposures for a scope. */
export function lenderExposuresForScope(
  plantsById: ReturnType<typeof buildPlantsById>,
  lenderStakes: LenderStake[],
  scope: { region: Region; subRegion?: string },
  scopeDistressScore: number | null,
): { exposures: EntityExposure[]; coverage: LenderCoverage } {
  return computeLenderExposures({
    plantsById,
    ownerStakes: new Map(),
    lenderStakes: groupLenderStakes(lenderStakes),
    scope,
    scopeDistressScore,
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
 *         + distressScore/100 × distressWeight
 *
 * Revenue-at-risk uses per-plant CF shortfall vs sub-region benchmark,
 * pro-rated by entity share, multiplied by AVG_REALIZED_PRICE_BY_REGION.
 * Label this as a directional estimate in the UI.
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

  // Build a fast lookup for plant analyses.
  const analysesById = new Map<string, PlantAnalysis>();
  for (const a of analyses) analysesById.set(a.plantId, a);

  const maxMw = Math.max(...candidates.map(c => c.exposedMw), 1);
  const { mwWeight, concentrationWeight, distressWeight } = THRESHOLDS.priorityWeights;

  const scored: TopTarget[] = candidates.map(e => {
    const mwNorm = e.exposedMw / maxMw;
    const distressNorm = e.scopeDistressScore != null ? e.scopeDistressScore / 100 : 0;
    const priorityScore =
      mwNorm * mwWeight + e.portfolioShare * concentrationWeight + distressNorm * distressWeight;

    // Per-plant revenue-at-risk computation.
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
        // Attribute exposedMw pro-rata by each plant's nameplate share.
        const proRataMw = totalFlaggedNominalMw > 0
          ? (a.nameplateMw / totalFlaggedNominalMw) * e.exposedMw
          : 0;
        const peerCf =
          benchmarks.subRegionTech.get(`${a.region}|${a.subRegion}|${a.fuelSource}`) ??
          benchmarks.regionTech.get(`${a.region}|${a.fuelSource}`) ??
          null;
        if (peerCf == null) continue;
        const cfGap = Math.max(0, peerCf - a.ttmCf);
        const price = AVG_REALIZED_PRICE_BY_REGION[String(a.region)] ?? 35;
        totalRisk += proRataMw * 8760 * cfGap * price;
      }
      revenueAtRiskUsd = totalRisk / 1_000_000; // → $M
    } else {
      // No analyses resolved; still collect sub-regions from plantIds if possible.
      // (This can happen when a plant is flagged but excluded from analyses after tech filter.)
    }

    // Build the "why now" sentence.
    const verb = e.entityType === 'owner' ? 'Owns' : 'Finances';
    const subList = Array.from(uniqueSubRegions);
    const subStr = subList.length > 0 ? subList.slice(0, 3).join(', ') : 'the region';
    const n = e.flaggedPlantIds.length;
    const m = e.plantCount;

    let cfNote = '';
    if (flaggedAnalyses.length > 0) {
      // Cap-weighted CF for this entity's flagged plants vs region benchmark.
      const entityFlaggedCf =
        flaggedAnalyses.reduce((s, a) => s + a.ttmCf * a.nameplateMw, 0) /
        Math.max(1, flaggedAnalyses.reduce((s, a) => s + a.nameplateMw, 0));
      const a0 = flaggedAnalyses[0];
      const regionBenchmark = benchmarks.regionTech.get(`${a0.region}|${a0.fuelSource}`);
      if (regionBenchmark != null && entityFlaggedCf > 0) {
        const pts = (regionBenchmark - entityFlaggedCf) * 100;
        if (pts > 0) cfNote = `; CF ${pts.toFixed(1)} pts below ${a0.region} benchmark`;
      }
    }

    const whyNow =
      `${verb} ${Math.round(e.exposedMw)} MW across ${subStr} ` +
      `where ${n} of ${m} tracked assets are flagged${cfNote}.`;

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
