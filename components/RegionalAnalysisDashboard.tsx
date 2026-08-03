/**
 * GenTrack — RegionalAnalysisDashboard
 *
 * "Regional Analysis" tab. Region-first distress screening across the Big 7
 * ISOs (Wind + Solar only), with deterioration (recent-12mo CF vs prior-12mo
 * CF) as the primary signal.
 *
 * The centerpiece is the entity concentration table:
 *   • Owner Exposure   — pro-rata MW via plant_ownership.oper_own × nameplate
 *   • Lender Exposure  — validated links from v_plant_financing (with a
 *                        permanent coverage caveat)
 * Both are tiered hot / warm / cold via the composite in regionalAnalysisService.
 *
 * Plant-level CF detail is INTERNAL DRILL-DOWN ONLY — the client pitch framing
 * stays regional ("our analysis suggests you likely have exposed assets here"),
 * never plant-specific.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { GeoJSON, MapContainer, TileLayer } from 'react-leaflet';
import type { Feature, FeatureCollection } from 'geojson';
import type { Layer, PathOptions } from 'leaflet';
import {
  BarChart,
  Bar,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { triggerPlantResearch } from '../services/lenderResearchService';

import { PowerPlant, Region, FuelSource, CapacityFactorStats } from '../types';
import {
  ANALYSIS_REGIONS,
  ANALYSIS_TECHS,
  AVG_REALIZED_PRICE_BY_REGION,
  THRESHOLDS,
  computeTopTargets,
  buildLenderBriefings,
  fetchCfWindows,
  fetchOwnershipStakes,
  fetchLenderStakes,
  fetchSubregionMonthlyCf,
  buildRegionalAnalysis,
  buildPlantsById,
  ownerExposuresForScope,
  lenderExposuresForScope,
  computeVintageGap,
  computeZoneDistressScores,
  buildZoneTargetSheet,
  fetchBdDispositions,
  upsertBdDisposition,
  fetchLatestBdSnapshot,
  type CfWindow,
  type EntityExposure,
  type LenderBriefing,
  type LenderCoverage,
  type LenderStake,
  type OwnershipStake,
  type PlantAnalysis,
  type RegionalAnalysisResult,
  type SubregionStats,
  type TopTarget,
  type VintageGap,
  type ZoneTargetSheet,
  type ZoneHuntEntry,
  type OwnerCluster,
  type ZoneTargetPlant,
  type BdDisposition,
  type BdDispositionStatus,
  type BdSnapshotEntry,
  fetchCspWatchlist,
  type CspWatchlistEntry,
  fetchPlantAnnualCf,
  type AnnualCfRow,
  computePlantPersistence,
  fetchSubregionResearchCandidates,
} from '../services/regionalAnalysisService';

// ─── Props ───────────────────────────────────────────────────────────────────
interface Props {
  plants: PowerPlant[];
  statsMap: Record<string, CapacityFactorStats>;
  onPlantClick: (plantId: string) => void;
  onOwnerClick: (ultParentName: string) => void;
  onLenderClick: (lenderName: string) => void;
  userRole?: string | null;
}

// ─── UI-local types ──────────────────────────────────────────────────────────
type TechFilter = 'Wind' | 'Solar' | 'Both';
type MapMetric = 'struggle' | 'excessDecline' | 'flaggedCount';
type TierFilter = 'all' | 'hot' | 'warm' | 'cold';

// ─── Constants ───────────────────────────────────────────────────────────────
const REGION_CENTERS: Record<Region, [number, number]> = {
  [Region.ERCOT]: [31.5, -99.5],
  [Region.CAISO]: [37.2, -119.5],
  [Region.SPP]: [37.5, -98.5],
  [Region.MISO]: [43.0, -91.5],
  [Region.PJM]: [40.0, -78.5],
  [Region.NYISO]: [42.8, -75.5],
  [Region.ISONE]: [43.8, -71.0],
  // Non-ISO fillers (unused, kept for TS completeness):
  [Region.Northwest]: [45.5, -118.0],
  [Region.Southwest]: [35.0, -108.0],
  [Region.Southeast]: [32.5, -85.0],
  [Region.Hawaii]: [20.5, -157.5],
  [Region.Alaska]: [62.0, -150.0],
};

/** One-line description of the zone-split basis, shown as a tooltip on the map header. */
const REGION_ZONE_BASIS: Partial<Record<Region, string>> = {
  [Region.CAISO]: 'CAISO price zones (NP15 / ZP26 / SP15) — basis for day-ahead LMP settlement.',
  [Region.ERCOT]: 'ERCOT load zones (North / South / Houston / West) — nodal price aggregation areas.',
  [Region.PJM]: 'PJM super-zones: Mid-Atlantic (PA/NJ/MD/DE/DC), Western (OH/WV), Dominion (VA).',
  [Region.MISO]: 'MISO LRZ groups: North (MN/ND/SD), East (WI/MI), Central (IL/IN/IA), South (MO).',
  [Region.NYISO]: 'NYISO load zones: West/Upstate (A–E), Capital-Hudson (F–I), NYC/LI (J–K).',
  [Region.ISONE]: 'ISO-NE state groups: Northern NE (ME/NH/VT), Southern NE (CT/RI), Massachusetts.',
  [Region.SPP]: 'SPP geography: North (KS/NE), Central (OK), South (AR/TX/NM).',
};

const REGION_ZOOM: Partial<Record<Region, number>> = {
  [Region.ERCOT]: 5,
  [Region.CAISO]: 5,
  [Region.SPP]: 5,
  [Region.MISO]: 5,
  [Region.PJM]: 6,
  [Region.NYISO]: 6,
  [Region.ISONE]: 6,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function techFilterToArr(t: TechFilter): FuelSource[] {
  if (t === 'Wind') return [FuelSource.Wind];
  if (t === 'Solar') return [FuelSource.Solar];
  return ANALYSIS_TECHS;
}

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}
function fmtMw(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(1)} GW`;
  return `${v.toFixed(0)} MW`;
}
function fmtInt(v: number): string {
  return v.toLocaleString();
}

/**
 * Struggle score → color. Green (low) → amber (mid) → red (high). Null → gray.
 * Values below `struggleWarm` blend green→amber; between warm and hot
 * blend amber→red; ≥ hot is deep red.
 */
function struggleColor(score: number | null): string {
  if (score == null) return '#334155'; // suppressed
  const w = THRESHOLDS.struggleWarm;
  const h = THRESHOLDS.struggleHot;
  if (score < w) {
    const t = Math.max(0, Math.min(1, score / w));
    return lerpColor('#10b981', '#f59e0b', t);
  }
  if (score < h) {
    const t = Math.max(0, Math.min(1, (score - w) / (h - w)));
    return lerpColor('#f59e0b', '#ef4444', t);
  }
  return '#ef4444';
}

function lerpColor(a: string, b: string, t: number): string {
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const to2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${to2(ar + (br - ar) * t)}${to2(ag + (bg - ag) * t)}${to2(ab + (bb - ab) * t)}`;
}

function tierBadgeClasses(tier: 'hot' | 'warm' | 'cold'): string {
  if (tier === 'hot') return 'bg-rose-900/40 text-rose-300 border-rose-700/40';
  if (tier === 'warm') return 'bg-amber-900/40 text-amber-300 border-amber-700/40';
  return 'bg-slate-800 text-slate-400 border-slate-700';
}

// ─── Component ───────────────────────────────────────────────────────────────
const RegionalAnalysisDashboard: React.FC<Props> = ({
  plants,
  statsMap,
  onPlantClick,
  onOwnerClick,
  onLenderClick,
  userRole,
}) => {
  const isAdmin = userRole === 'admin';
  // ── UI state ──────────────────────────────────────────────────────────────
  const [selectedRegion, setSelectedRegion] = useState<Region>(Region.ERCOT);
  const [techFilter, setTechFilter] = useState<TechFilter>('Both');
  const [selectedSubRegion, setSelectedSubRegion] = useState<string | null>(null);
  const [mapMetric, setMapMetric] = useState<MapMetric>('struggle');
  const [ownerTierFilter, setOwnerTierFilter] = useState<TierFilter>('all');
  const [lenderTierFilter, setLenderTierFilter] = useState<TierFilter>('all');
  // Lender ingestion state (admin only)
  const [ingestionSubRegion, setIngestionSubRegion] = useState<string | null>(null);
  const [ingestionCandidates, setIngestionCandidates] = useState<import('../services/regionalAnalysisService').SubregionResearchCandidate[] | null>(null);
  const [ingestionProgress, setIngestionProgress] = useState<{ done: number; total: number; errors: number } | null>(null);
  const [ingestionRunning, setIngestionRunning] = useState(false);
  const [showInternalDetail, setShowInternalDetail] = useState(false);
  // Zone Target Sheet
  const [showTargetPlants, setShowTargetPlants] = useState(false);
  const [autoSelectedZone, setAutoSelectedZone] = useState(false);
  // BD dispositions (sticky MD review loop)
  const [bdDispositions, setBdDispositions] = useState<BdDisposition[]>([]);
  const [bdSnapshot, setBdSnapshot] = useState<BdSnapshotEntry[]>([]);

  // ── Async data ────────────────────────────────────────────────────────────
  const [cfWindows, setCfWindows] = useState<Map<string, CfWindow> | null>(null);
  const [cfWindowsError, setCfWindowsError] = useState<string | null>(null);
  const [ownerStakes, setOwnerStakes] = useState<OwnershipStake[] | null>(null);
  const [lenderStakes, setLenderStakes] = useState<LenderStake[] | null>(null);
  const [geojson, setGeojson] = useState<FeatureCollection | null>(null);
  const [geojsonError, setGeojsonError] = useState<string | null>(null);
  // Subregion monthly CF for sparklines. Null = not yet fetched.
  const [subregionMonthly, setSubregionMonthly] = useState<Map<string, number[]> | null>(null);
  // 5-year annual CF rows for persistence signals. Empty = RPC not yet deployed / no data.
  const [annualCfRows, setAnnualCfRows] = useState<AnnualCfRow[]>([]);
  // CSP watchlist (populated after first 60-month fetch run; empty until then)
  const [cspWatchlist, setCspWatchlist] = useState<CspWatchlistEntry[]>([]);
  const [cspWatchlistOpen, setCspWatchlistOpen] = useState(false);

  useEffect(() => {
    fetchCspWatchlist().then(setCspWatchlist).catch(() => setCspWatchlist([]));
    fetchPlantAnnualCf().then(setAnnualCfRows).catch(() => setAnnualCfRows([]));
    fetchBdDispositions().then(setBdDispositions).catch(() => setBdDispositions([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { windows, rpcError } = await fetchCfWindows();
      if (!cancelled) {
        setCfWindows(windows);
        if (rpcError) {
          setCfWindowsError(
            'Deterioration data unavailable — the get_plant_cf_windows RPC has not been deployed to Supabase. ' +
            'Run the SQL block at the bottom of scripts/create-rpc-functions.sql in the Supabase SQL Editor ' +
            '(https://supabase.com/dashboard/project/ohmmtplnaddrfuoowpuq/sql/new). ' +
            'Until then, only peer-relative underperformance is flagged.'
          );
        } else if (windows.size === 0) {
          setCfWindowsError(
            'Deterioration data unavailable — the RPC returned no rows. ' +
            'monthly_generation may be empty for Wind/Solar plants.'
          );
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // We only need ownership/lender rows for eligible plants — pass the full set
    // of eligible ids/eia codes so the queries filter server-side pages down.
    const eligiblePlantIds = new Set<string>();
    const eligibleEiaCodes = new Set<string>();
    for (const p of plants) {
      if (!ANALYSIS_REGIONS.includes(p.region)) continue;
      if (!ANALYSIS_TECHS.includes(p.fuelSource)) continue;
      eligiblePlantIds.add(p.id);
      if (p.eiaPlantCode) eligibleEiaCodes.add(p.eiaPlantCode);
    }
    (async () => {
      const [own, lend] = await Promise.all([
        fetchOwnershipStakes(eligibleEiaCodes),
        fetchLenderStakes(eligiblePlantIds),
      ]);
      if (!cancelled) {
        setOwnerStakes(own);
        setLenderStakes(lend);
      }
    })();
    return () => { cancelled = true; };
  }, [plants]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Use import.meta.env.BASE_URL so the path works when Vite is deployed
        // to a subpath (e.g. GitHub Pages serves from /<repo>/).
        const res = await fetch(`${import.meta.env.BASE_URL}data/subregions.geojson`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const gj = (await res.json()) as FeatureCollection;
        if (!cancelled) setGeojson(gj);
      } catch (err) {
        if (!cancelled) {
          setGeojsonError(`Failed to load sub-region map: ${(err as Error).message}`);
          console.warn('[RegionalAnalysis] geojson load error:', err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Derived analysis ──────────────────────────────────────────────────────
  const techArr = useMemo(() => techFilterToArr(techFilter), [techFilter]);

  const analysis: RegionalAnalysisResult | null = useMemo(() => {
    if (!cfWindows) return null;
    return buildRegionalAnalysis(plants, statsMap, cfWindows, techArr);
  }, [plants, statsMap, cfWindows, techArr]);

  const plantsById = useMemo(() => {
    if (!analysis) return null;
    return buildPlantsById(plants, analysis.analyses);
  }, [plants, analysis]);

  // Filter for the selected region.
  const regionSubStats: SubregionStats[] = useMemo(() => {
    if (!analysis) return [];
    return analysis.subregionStats.filter(s => s.region === selectedRegion);
  }, [analysis, selectedRegion]);

  const nationalTtmCf = useMemo(() => {
    if (!analysis) return null;
    if (techFilter === 'Both') {
      // Cap-weight across the two techs.
      let num = 0;
      let den = 0;
      for (const t of ANALYSIS_TECHS) {
        const v = analysis.benchmarks.nationalTech.get(t);
        // Weight by tech capacity in ANALYSIS_REGIONS.
        const w = plants
          .filter(p => p.fuelSource === t && ANALYSIS_REGIONS.includes(p.region))
          .reduce((s, p) => s + p.nameplateCapacityMW, 0);
        if (v != null && w > 0) { num += v * w; den += w; }
      }
      return den > 0 ? num / den : null;
    }
    return analysis.benchmarks.nationalTech.get(techFilter) ?? null;
  }, [analysis, techFilter, plants]);

  const regionTtmCf = analysis?.regionCapWeightedCf.get(selectedRegion) ?? null;

  // Deteriorating plants in selected region.
  const regionAnalyses: PlantAnalysis[] = useMemo(() => {
    if (!analysis) return [];
    return analysis.analyses.filter(a => a.region === selectedRegion);
  }, [analysis, selectedRegion]);
  const regionDeterioratingCount = regionAnalyses.filter(a => a.isDeteriorating).length;
  const regionFlaggedCount = regionAnalyses.filter(a => a.isFlagged).length;
  const regionMwAnalyzed = regionAnalyses.reduce((s, a) => s + a.nameplateMw, 0);
  const flaggedSubregions = regionSubStats.filter(
    s => s.struggleScore != null && s.struggleScore >= THRESHOLDS.struggleWarm,
  ).length;

  // National YoY for the selected tech (for the KPI strip).
  const nationalYoY = useMemo<number | null>(() => {
    if (!analysis) return null;
    const t = techFilter === 'Both' ? null : String(techFilter);
    if (t) return analysis.nationalYoY.get(t) ?? null;
    // Both: cap-weighted average of Wind and Solar national YoY.
    let num = 0; let den = 0;
    for (const tech of ANALYSIS_TECHS) {
      const v = analysis.nationalYoY.get(String(tech));
      const w = plants.filter(p => p.fuelSource === tech && ANALYSIS_REGIONS.includes(p.region))
        .reduce((s, p) => s + p.nameplateCapacityMW, 0);
      if (v != null && w > 0) { num += v * w; den += w; }
    }
    return den > 0 ? num / den : null;
  }, [analysis, techFilter, plants]);

  // Region-level YoY (cap-weighted across all sub-regions in this region).
  const regionYoY = useMemo<number | null>(() => {
    const sub = regionSubStats.filter(s => s.signalComponents.selfTrendPts != null);
    if (sub.length === 0) return null;
    const num = sub.reduce((s, r) => s + (r.signalComponents.selfTrendPts ?? 0) * r.totalMw, 0);
    const den = sub.reduce((s, r) => s + r.totalMw, 0);
    return den > 0 ? num / den : null;
  }, [regionSubStats]);

  // Scope for entity exposure.
  const scope = useMemo(
    () => ({ region: selectedRegion, subRegion: selectedSubRegion ?? undefined }),
    [selectedRegion, selectedSubRegion],
  );
  const scopeStruggle = useMemo<number | null>(() => {
    if (selectedSubRegion) {
      const s = analysis?.subregionStatsMap.get(`${selectedRegion}|${selectedSubRegion}`);
      return s?.struggleScore ?? null;
    }
    // Region-level: cap-weighted average of per-subregion struggle scores.
    if (!analysis) return null;
    const subs = analysis.subregionStats.filter(s => s.region === selectedRegion && s.struggleScore != null);
    if (subs.length === 0) return null;
    const num = subs.reduce((sum, s) => sum + (s.struggleScore ?? 0) * Math.max(1, s.totalMw), 0);
    const den = subs.reduce((sum, s) => sum + Math.max(1, s.totalMw), 0);
    return den > 0 ? Math.round(num / den) : null;
  }, [analysis, selectedRegion, selectedSubRegion]);

  const ownerExposures: EntityExposure[] = useMemo(() => {
    if (!plantsById || !ownerStakes) return [];
    return ownerExposuresForScope(plantsById, ownerStakes, scope, scopeStruggle);
  }, [plantsById, ownerStakes, scope, scopeStruggle]);

  const lenderResult = useMemo<{ exposures: EntityExposure[]; coverage: LenderCoverage } | null>(() => {
    if (!plantsById || !lenderStakes) return null;
    return lenderExposuresForScope(plantsById, lenderStakes, scope, scopeStruggle);
  }, [plantsById, lenderStakes, scope, scopeStruggle]);

  // Top BD Targets — ranked by priority score across hot+warm exposures.
  const topTargets: TopTarget[] = useMemo(() => {
    if (!analysis) return [];
    return computeTopTargets(
      ownerExposures,
      lenderResult?.exposures ?? [],
      analysis.analyses,
      analysis.benchmarks,
    );
  }, [analysis, ownerExposures, lenderResult]);

  // Lender briefings — built from lender exposures + subregion struggle signals.
  const lenderBriefings: LenderBriefing[] = useMemo(() => {
    if (!analysis || !lenderResult) return [];
    const analysesById = new Map<string, PlantAnalysis>();
    for (const a of analysis.analyses) analysesById.set(a.plantId, a);
    return buildLenderBriefings(
      lenderResult.exposures,
      analysis.subregionStatsMap,
      analysesById,
    );
  }, [analysis, lenderResult]);

  // Subregion sparkline fetch — re-fires when region or tech changes.
  useEffect(() => {
    let cancelled = false;
    const tech = techFilter === 'Both' ? 'Wind' : techFilter; // default to Wind when both
    (async () => {
      const data = await fetchSubregionMonthlyCf(selectedRegion, tech as any);
      if (!cancelled) setSubregionMonthly(data);
    })();
    return () => { cancelled = true; };
  }, [selectedRegion, techFilter]);

  // 5-year persistence — computed from annualCfRows + analysis, keyed by subregion.
  const subregionPersistenceMap = useMemo<Map<string, import('../services/regionalAnalysisService').PersistenceSignal | null>>(() => {
    if (!analysis || annualCfRows.length === 0) return new Map();
    const analysesById = new Map<string, { plantId: string; region: Region; subRegion: string }>();
    for (const a of analysis.analyses) {
      analysesById.set(a.plantId, { plantId: a.plantId, region: a.region as Region, subRegion: a.subRegion });
    }
    const pp = computePlantPersistence(annualCfRows, new Map(), new Set());
    // Build a (region|subRegion) → PersistenceSignal map from the plant-level data
    const bySubregion = new Map<string, import('../services/regionalAnalysisService').PlantPersistence[]>();
    for (const [plantId, ppItem] of pp) {
      const meta = analysesById.get(plantId);
      if (!meta) continue;
      const key = `${meta.region}|${meta.subRegion}`;
      if (!bySubregion.has(key)) bySubregion.set(key, []);
      bySubregion.get(key)!.push(ppItem);
    }
    const result = new Map<string, import('../services/regionalAnalysisService').PersistenceSignal | null>();
    const BADGE_THRESHOLD = 0.25;
    const MIN_ELIGIBLE = 3;
    const MIN_ANNUAL_PTS = 4;
    for (const [key, plants] of bySubregion) {
      const eligible = plants.filter(p => !p.excluded && p.annualPoints.length >= MIN_ANNUAL_PTS);
      if (eligible.length === 0) { result.set(key, null); continue; }
      const persistentCount = eligible.filter(p => p.persistentDecline).length;
      const share = persistentCount / eligible.length;
      result.set(key, {
        eligiblePlants: eligible.length,
        persistentDeclinePlants: persistentCount,
        persistentDeclineShare: share,
        hasBadge: share >= BADGE_THRESHOLD && eligible.length >= MIN_ELIGIBLE,
        avgDownYears: eligible.reduce((s, p) => s + p.downYears, 0) / eligible.length,
      });
    }
    return result;
  }, [analysis, annualCfRows]);

  // 5-year cap-weighted annual CF for selected region / sub-region scope.
  const annualCfChartData = useMemo(() => {
    if (!analysis || annualCfRows.length === 0) return [];
    const plantMeta = new Map<string, { region: string; subRegion: string; mw: number; fuel: string }>();
    for (const a of analysis.analyses) {
      plantMeta.set(a.plantId, { region: a.region, subRegion: a.subRegion, mw: a.nameplateMw, fuel: String(a.fuelSource) });
    }
    const techSet = new Set(techArr.map(String));
    const byYear = new Map<number, { mwSum: number; cfMwSum: number }>();
    for (const r of annualCfRows) {
      const meta = plantMeta.get(r.plant_id);
      if (!meta || meta.region !== selectedRegion) continue;
      if (selectedSubRegion && meta.subRegion !== selectedSubRegion) continue;
      if (!techSet.has(meta.fuel)) continue;
      const prev = byYear.get(r.year) ?? { mwSum: 0, cfMwSum: 0 };
      byYear.set(r.year, { mwSum: prev.mwSum + meta.mw, cfMwSum: prev.cfMwSum + r.year_cf * meta.mw });
    }
    return Array.from(byYear.entries())
      .sort(([a], [b]) => a - b)
      .map(([year, { mwSum, cfMwSum }]) => ({
        year: String(year),
        cf: mwSum > 0 ? Math.round((cfMwSum / mwSum) * 1000) / 10 : null,
      }));
  }, [analysis, annualCfRows, selectedRegion, selectedSubRegion, techArr]);

  // ── Vintage gaps (per-plant baseline vs TTM) ──────────────────────────────
  const plantsMapForGap = useMemo(() => {
    const m = new Map<string, PowerPlant>();
    for (const p of plants) m.set(p.id, p);
    return m;
  }, [plants]);

  const vintageGaps = useMemo<Map<string, VintageGap>>(() => {
    if (!analysis || annualCfRows.length === 0 || !cfWindows) return new Map();
    return computeVintageGap(
      analysis.analyses,
      annualCfRows,
      cfWindows,
      plantsMapForGap,
      new Set(), // historyUnreliable — not tracked client-side; service uses plant data
    );
  }, [analysis, annualCfRows, cfWindows, plantsMapForGap]);

  // ── Zone distress scores for "Where to Hunt" strip ────────────────────────
  const zoneHuntEntries = useMemo<ZoneHuntEntry[]>(() => {
    if (!analysis || vintageGaps.size === 0) return [];
    return computeZoneDistressScores(
      selectedRegion,
      techArr,
      analysis.analyses,
      vintageGaps,
      analysis.subregionStatsMap,
    );
  }, [analysis, vintageGaps, selectedRegion, techArr]);

  // Auto-select the worst zone on first load (once per region switch).
  useEffect(() => {
    if (zoneHuntEntries.length === 0) return;
    if (autoSelectedZone && selectedSubRegion !== null) return;
    const worst = zoneHuntEntries[0];
    if (worst) {
      setSelectedSubRegion(worst.subRegion);
      setAutoSelectedZone(true);
    }
  }, [zoneHuntEntries, autoSelectedZone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset auto-select flag when user switches region so we re-auto-select.
  useEffect(() => {
    setAutoSelectedZone(false);
    setSelectedSubRegion(null);
  }, [selectedRegion]);

  // ── Zone target sheet for the selected zone ───────────────────────────────
  const zoneTargetSheet = useMemo<ZoneTargetSheet | null>(() => {
    if (!analysis || !selectedSubRegion || vintageGaps.size === 0 || !ownerStakes || !lenderStakes) return null;
    const zoneLenderExposures = lenderResult?.exposures ?? [];
    return buildZoneTargetSheet(
      selectedRegion,
      selectedSubRegion,
      techArr,
      analysis.analyses,
      vintageGaps,
      plantsMapForGap,
      ownerStakes,
      zoneLenderExposures,
      analysis.subregionStatsMap.get(`${selectedRegion}|${selectedSubRegion}`) ?? null,
    );
  }, [analysis, selectedRegion, selectedSubRegion, techArr, vintageGaps, plantsMapForGap, ownerStakes, lenderStakes, lenderResult]);

  // BD snapshot fetch — re-fires when region changes.
  useEffect(() => {
    fetchLatestBdSnapshot(selectedRegion).then(setBdSnapshot).catch(() => setBdSnapshot([]));
  }, [selectedRegion]);

  // BD disposition lookup helpers
  const getDisposition = (scope: BdDisposition['scope'], key: string): BdDisposition | undefined =>
    bdDispositions.find(d => d.scope === scope && d.key === key);

  const handleDispose = async (scope: BdDisposition['scope'], key: string, status: BdDispositionStatus) => {
    const res = await upsertBdDisposition(scope, key, status, null);
    if (res.ok) {
      setBdDispositions(prev => {
        const next = prev.filter(d => !(d.scope === scope && d.key === key));
        next.push({ id: key, scope, key, status, note: null, decidedBy: null, decidedAt: new Date().toISOString() });
        return next;
      });
    }
  };

  // Filter entity lists to those with actual exposed MW when tier != all.
  const filterByTier = (rows: EntityExposure[], tier: TierFilter): EntityExposure[] => {
    if (tier === 'all') return rows.filter(r => r.exposedMw > 0 || tier === 'all');
    return rows.filter(r => r.tier === tier);
  };

  const ownerRows = filterByTier(ownerExposures, ownerTierFilter);
  const lenderRows = lenderResult ? filterByTier(lenderResult.exposures, lenderTierFilter) : [];

  // ── Benchmark chart data (YoY decline per sub-region) ────────────────────
  const benchmarkChart = regionSubStats.map(s => ({
    name: s.subRegion,
    yoyDecline: s.signalComponents.selfTrendPts == null
      ? null
      : Math.round(s.signalComponents.selfTrendPts * 1000) / 10,
    excessDecline: s.signalComponents.excessDeclinePts == null
      ? null
      : Math.round(s.signalComponents.excessDeclinePts * 1000) / 10,
    struggle: s.struggleScore,
    plants: s.plantCount,
  }));

  // ── Choropleth styling ────────────────────────────────────────────────────
  const styleFeature = (feature?: Feature): PathOptions => {
    if (!feature || !feature.properties) return { fillColor: '#334155', color: '#0f172a', weight: 1, fillOpacity: 0.6 };
    const props = feature.properties as Record<string, string>;
    if (props.region !== selectedRegion) {
      // Should not appear once filtered, but defensive.
      return { fillColor: '#1e293b', color: '#0f172a', weight: 1, fillOpacity: 0.1 };
    }
    const s = analysis?.subregionStatsMap.get(`${selectedRegion}|${props.subRegion}`);
    let fill = '#334155';
    if (s) {
      if (mapMetric === 'struggle') {
        fill = struggleColor(s.struggleScore);
      } else if (mapMetric === 'excessDecline') {
        // Excess YoY decline vs national cohort — positive (worse) = red.
        const excess = s.signalComponents.excessDeclinePts;
        if (excess != null) {
          const norm = Math.max(0, Math.min(1, excess / THRESHOLDS.excessDeclineNorm));
          fill = lerpColor('#10b981', '#ef4444', norm);
        }
      } else {
        // flaggedCount → red scaling by flagged MW share.
        const share = s.totalMw > 0 ? s.flaggedMw / s.totalMw : 0;
        fill = lerpColor('#10b981', '#ef4444', Math.max(0, Math.min(1, share * 1.5)));
      }
    }
    const isSelected = selectedSubRegion === props.subRegion;
    return {
      fillColor: fill,
      color: isSelected ? '#38bdf8' : '#0f172a',
      weight: isSelected ? 3 : 1,
      fillOpacity: 0.72,
    };
  };

  const geojsonFilter = (feature: Feature): boolean => {
    const props = feature.properties as Record<string, string> | undefined;
    return !!props && props.region === selectedRegion;
  };

  const onEachFeature = (feature: Feature, layer: Layer): void => {
    const props = feature.properties as Record<string, string> | undefined;
    if (props && props.region === selectedRegion) {
      const s = analysis?.subregionStatsMap.get(`${selectedRegion}|${props.subRegion}`);
      const ttmStr = s?.capWeightedTtmCf != null ? fmtPct(s.capWeightedTtmCf) : '—';
      const yoyPts = s?.signalComponents.selfTrendPts;
      const yoyStr = yoyPts != null
        ? `${yoyPts >= 0 ? '+' : ''}${(yoyPts * 100).toFixed(1)} pt`
        : '—';
      const yoyColor = yoyPts != null && yoyPts > 0 ? '#f87171' : '#34d399';
      const mwStr = s?.totalMw != null ? fmtMw(s.totalMw) : '—';
      const html = [
        `<div style="font-size:11px;line-height:1.6;min-width:170px;font-family:sans-serif">`,
        `<div style="font-weight:700;font-size:12px;margin-bottom:4px;border-bottom:1px solid #334155;padding-bottom:3px">${props.subRegion}</div>`,
        `<div>TTM CF: <b style="color:#e2e8f0">${ttmStr}</b></div>`,
        `<div>YoY: <b style="color:${yoyColor}">${yoyStr}</b></div>`,
        `<div style="color:#94a3b8">${s?.plantCount ?? 0} plants · ${mwStr}</div>`,
        s?.struggleScore != null
          ? `<div style="font-size:10px;margin-top:3px;color:#64748b">Struggle score: ${s.struggleScore} / 100</div>`
          : '',
        `<div style="font-size:10px;color:#475569;margin-top:3px">Click to drill down ↓</div>`,
        `</div>`,
      ].join('');
      layer.bindTooltip(html, { sticky: true, opacity: 0.95 });
    }
    layer.on({
      click: () => {
        const props = feature.properties as Record<string, string> | undefined;
        if (!props) return;
        setSelectedSubRegion(prev => (prev === props.subRegion ? null : props.subRegion));
      },
    });
  };

  // Force re-render of GeoJSON layer when the shading inputs change.
  const geojsonKey = `${selectedRegion}|${mapMetric}|${techFilter}|${selectedSubRegion ?? ''}|${cfWindows?.size ?? 0}`;

  // Loading state ───────────────────────────────────────────────────────────
  const loading = !cfWindows || !ownerStakes || !lenderStakes;

  return (
    <div className="p-6 lg:p-10 max-w-[1400px] mx-auto space-y-6">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-white tracking-tight">Regional Analysis</h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Region-first distress screening across the Big 7 ISOs (Wind &amp; Solar). Deterioration
            (recent-12mo CF vs prior-12mo CF) is the primary distress signal. Use the concentration
            tables to target owners and lenders exposed to distressed sub-regions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(['Both', 'Wind', 'Solar'] as TechFilter[]).map(t => (
            <button
              key={t}
              onClick={() => setTechFilter(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                techFilter === t
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* ── ISO selector ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {ANALYSIS_REGIONS.map(r => (
          <button
            key={r}
            onClick={() => { setSelectedRegion(r); setSelectedSubRegion(null); }}
            className={`px-3 py-2 rounded-xl text-xs font-bold border transition-colors ${
              selectedRegion === r
                ? 'bg-slate-800 border-blue-500 text-white'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {r}
          </button>
        ))}
        {selectedSubRegion && (
          <button
            onClick={() => setSelectedSubRegion(null)}
            className="ml-auto px-3 py-2 rounded-xl text-xs font-bold border bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800 flex items-center gap-2"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
            Clear sub-region: {selectedSubRegion}
          </button>
        )}
      </div>

      {/* ── Where to Hunt strip ──────────────────────────────────────────── */}
      {zoneHuntEntries.length > 0 && (
        <WhereToHuntStrip
          entries={zoneHuntEntries.slice(0, 3)}
          selectedSubRegion={selectedSubRegion}
          onSelectZone={setSelectedSubRegion}
          dispositions={bdDispositions}
        />
      )}

      {/* ── Zone Target Sheet ────────────────────────────────────────────── */}
      {zoneTargetSheet && (
        <ZoneTargetSheetPanel
          sheet={zoneTargetSheet}
          showTargetPlants={showTargetPlants}
          onToggleTargetPlants={() => setShowTargetPlants(v => !v)}
          onOwnerClick={onOwnerClick}
          onPlantClick={onPlantClick}
          dispositions={bdDispositions}
          snapshot={bdSnapshot}
          onDispose={handleDispose}
        />
      )}

      {/* ── Top BD Targets ───────────────────────────────────────────────── */}
      <TopTargetsTable
        targets={topTargets}
        onOwnerClick={onOwnerClick}
        onLenderClick={onLenderClick}
        loading={loading}
      />

      {/* ── KPI strip ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label={`${selectedRegion} Cap-Weighted CF`}
          value={fmtPct(regionTtmCf)}
          sub={`National: ${fmtPct(nationalTtmCf)}`}
        />
        <KpiCard label="MW analyzed" value={fmtMw(regionMwAnalyzed)} sub={`${fmtInt(regionAnalyses.length)} plants`} />
        <KpiCard
          label="Sub-regions ≥ warm"
          value={fmtInt(flaggedSubregions)}
          sub={`of ${regionSubStats.length}`}
          tone={flaggedSubregions > 0 ? 'warn' : 'neutral'}
        />
        <KpiCard
          label="Plants deteriorating"
          value={fmtInt(regionDeterioratingCount)}
          sub={`${fmtInt(regionFlaggedCount)} flagged total`}
          tone={regionDeterioratingCount > 0 ? 'warn' : 'neutral'}
        />
      </div>

      {loading && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-sm text-slate-400">
          Loading regional analysis data…
        </div>
      )}
      {cfWindowsError && (
        <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-3 text-xs text-amber-200">
          {cfWindowsError}
        </div>
      )}
      {geojsonError && (
        <div className="bg-rose-900/20 border border-rose-700/40 rounded-xl p-3 text-xs text-rose-200">
          {geojsonError}
        </div>
      )}

      {/* ── CSP Watchlist (national, all regions) ──────────────────────── */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-slate-800/50 transition-colors"
          onClick={() => setCspWatchlistOpen(o => !o)}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white">☀ CSP Watchlist</span>
            <span className="text-[11px] text-slate-400">
              Concentrated Solar Power — excluded from PV benchmarks
            </span>
            {cspWatchlist.length > 0 && (
              <span className="px-1.5 py-0.5 bg-orange-900/60 text-orange-300 text-[10px] rounded-full font-semibold">
                {cspWatchlist.length} plant{cspWatchlist.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <span className="text-slate-500 text-xs">{cspWatchlistOpen ? '▲' : '▼'}</span>
        </button>
        {cspWatchlistOpen && (
          <div className="px-5 pb-4">
            {cspWatchlist.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">
                No CSP plants found. Re-run the EIA ingestion script after the 60-month backfill
                to classify Solar Thermal plants.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 text-left">
                      <th className="pb-1.5 pr-3 font-medium">Plant</th>
                      <th className="pb-1.5 pr-3 font-medium">Region</th>
                      <th className="pb-1.5 pr-3 font-medium text-right">MW</th>
                      <th className="pb-1.5 pr-3 font-medium text-right">TTM CF</th>
                      <th className="pb-1.5 font-medium">Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cspWatchlist.map(plant => (
                      <tr key={plant.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                        <td className="py-1.5 pr-3 text-white font-medium">{plant.name}</td>
                        <td className="py-1.5 pr-3 text-slate-400">{plant.region}</td>
                        <td className="py-1.5 pr-3 text-right text-slate-300">{plant.nameplateCapacityMw.toFixed(0)}</td>
                        <td className="py-1.5 pr-3 text-right text-slate-300">
                          {plant.ttmAvgFactor != null ? fmtPct(plant.ttmAvgFactor) : '—'}
                        </td>
                        <td className="py-1.5 text-slate-400">{plant.owner}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[10px] text-slate-600 mt-2">
                  CSP plants are tagged via EIA-860 prime mover codes (ST/CP). Not peer-benchmarked.
                  Informational only — these plants were removed from Solar CF benchmarks.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Map + benchmark strip ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-bold text-white">Sub-region map — {selectedRegion}</h2>
              <p className="text-[11px] text-slate-500">
                {selectedSubRegion ? `Selected: ${selectedSubRegion}` : 'Click a zone to drill down'}
                {REGION_ZONE_BASIS[selectedRegion] && (
                  <span
                    className="ml-1.5 cursor-help text-slate-600 hover:text-slate-400 transition-colors"
                    title={REGION_ZONE_BASIS[selectedRegion]}
                  >
                    ⓘ
                  </span>
                )}
              </p>
            </div>
            <div className="flex gap-1">
              {(['struggle', 'excessDecline', 'flaggedCount'] as MapMetric[]).map(m => (
                <button
                  key={m}
                  onClick={() => setMapMetric(m)}
                  className={`px-2 py-1 rounded-md text-[10px] font-semibold border transition-colors ${
                    mapMetric === m
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {m === 'struggle' ? 'Struggle' : m === 'excessDecline' ? 'Excess ↓' : 'Flagged share'}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-xl overflow-hidden border border-slate-800">
            <MapContainer
              key={selectedRegion} // re-init the map so recenter is clean
              center={REGION_CENTERS[selectedRegion]}
              zoom={REGION_ZOOM[selectedRegion] ?? 5}
              minZoom={3}
              maxZoom={9}
              scrollWheelZoom={true}
              className="regional-analysis-map"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {geojson && (
                <GeoJSON
                  key={geojsonKey}
                  data={geojson}
                  filter={geojsonFilter}
                  style={styleFeature as (feature?: Feature) => PathOptions}
                  onEachFeature={onEachFeature}
                />
              )}
            </MapContainer>
          </div>
          <MapLegend metric={mapMetric} />
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-bold text-white">Sub-region YoY decline</h2>
              <p className="text-[11px] text-slate-500">Cap-weighted CF change vs same period prior year (pts). National cohort reference line.</p>
            </div>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={benchmarkChart} margin={{ top: 5, right: 16, left: 0, bottom: 52 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis
                  dataKey="name"
                  stroke="#94a3b8"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  angle={-38}
                  textAnchor="end"
                  height={60}
                />
                <YAxis
                  stroke="#94a3b8"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v} pt`}
                />
                <RechartsTooltip
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                  contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', fontSize: '12px' }}
                  formatter={(value: number | null, name: string) => [
                    value == null ? 'N/A' : `${value > 0 ? '+' : ''}${value} pt`,
                    name === 'yoyDecline' ? 'YoY decline' : name === 'excessDecline' ? 'vs national' : name,
                  ]}
                />
                {nationalYoY != null && (
                  <ReferenceLine
                    y={Math.round(nationalYoY * 1000) / 10}
                    stroke="#94a3b8"
                    strokeDasharray="3 5"
                    label={{ position: 'right', value: 'National', fill: '#94a3b8', fontSize: 10 }}
                  />
                )}
                <ReferenceLine y={0} stroke="#475569" strokeWidth={1} />
                <Bar dataKey="yoyDecline" radius={[4, 4, 0, 0]} maxBarSize={36}>
                  {benchmarkChart.map((d, i) => (
                    <Cell
                      key={i}
                      fill={struggleColor(d.struggle)}
                      stroke={selectedSubRegion === d.name ? '#38bdf8' : 'transparent'}
                      strokeWidth={selectedSubRegion === d.name ? 2 : 0}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Sub-region trend sparklines — rendered when Phase 3 RPC is deployed */}
          {subregionMonthly && subregionMonthly.size > 0 && (
            <div className="mt-3 border-t border-slate-800 pt-3">
              <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-2">
                24-month trend {techFilter === 'Both' ? '(Wind — switch to single tech for Solar)' : `(${techFilter})`}
              </div>
              <div className="grid grid-cols-1 gap-1">
                {regionSubStats.map(s => {
                  const pts = subregionMonthly.get(s.subRegion) ?? [];
                  const persKey = `${s.region}|${s.subRegion}`;
                  const pers = subregionPersistenceMap.get(persKey);
                  return (
                    <div key={s.subRegion} className="flex items-center gap-2 text-[11px]">
                      <span
                        className="w-40 truncate text-slate-400 cursor-pointer hover:text-slate-200"
                        onClick={() => setSelectedSubRegion(prev => prev === s.subRegion ? null : s.subRegion)}
                      >
                        {s.subRegion}
                      </span>
                      <Sparkline data={pts} color={struggleColor(s.struggleScore)} />
                      <span className="font-mono text-slate-500 text-[10px]">
                        {pts.length > 0 ? `${(pts[pts.length - 1] * 100).toFixed(1)}%` : '—'}
                      </span>
                      {pers?.hasBadge && (
                        <span
                          className="px-1.5 py-0.5 bg-rose-900/60 text-rose-300 text-[9px] rounded-full font-semibold"
                          title={`Persistent decline: ${pers.persistentDeclinePlants}/${pers.eligiblePlants} plants with ≥3 down years (avg ${pers.avgDownYears?.toFixed(1)} down years)`}
                        >
                          ↓ Persistent
                        </span>
                      )}
                      {pers != null && !pers.hasBadge && pers.eligiblePlants < 3 && (
                        <span className="text-[9px] text-slate-700" title="Insufficient history for multi-year analysis">
                          ~hist
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 5-year annual CF trend ────────────────────────────────────────── */}
      {annualCfChartData.length >= 3 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <h2 className="text-sm font-bold text-white">
                5-year annual capacity factor
                {selectedSubRegion ? (
                  <span className="text-blue-400 ml-1.5">{selectedSubRegion}</span>
                ) : (
                  <span className="text-slate-400 ml-1.5">{selectedRegion} — all zones</span>
                )}
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Cap-weighted avg annual CF · {techFilter === 'Both' ? 'Wind + Solar' : techFilter} · min 10 reported months/yr · calendar years 2021–2025
              </p>
            </div>
            {(() => {
              const persKey = selectedSubRegion ? `${selectedRegion}|${selectedSubRegion}` : null;
              const pers = persKey ? subregionPersistenceMap.get(persKey) : null;
              if (!pers) return null;
              return (
                <div className="text-right text-[11px]">
                  {pers.hasBadge ? (
                    <span className="px-2 py-1 bg-rose-900/50 text-rose-300 rounded-full font-semibold">
                      ↓ Persistent decline · {pers.persistentDeclinePlants}/{pers.eligiblePlants} plants
                    </span>
                  ) : (
                    <span className="text-slate-600">
                      {pers.eligiblePlants} plant{pers.eligiblePlants !== 1 ? 's' : ''} w/ 5yr history
                    </span>
                  )}
                </div>
              );
            })()}
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={annualCfChartData} margin={{ top: 4, right: 16, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="cfGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.18} />
                    <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="year"
                  stroke="#475569"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#475569"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  domain={['auto', 'auto']}
                  width={36}
                />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px', fontSize: '12px' }}
                  formatter={(v: number | null) => [
                    v != null ? `${v.toFixed(1)}%` : '—',
                    `${techFilter === 'Both' ? 'Wind + Solar' : techFilter} avg CF`,
                  ]}
                  labelFormatter={(label: string) => `${label}`}
                />
                {annualCfChartData.length > 0 && annualCfChartData[0].cf != null && (
                  <ReferenceLine
                    y={annualCfChartData[0].cf}
                    stroke="#334155"
                    strokeDasharray="4 4"
                    label={{ position: 'right', value: `${annualCfChartData[0].year} baseline`, fill: '#475569', fontSize: 9 }}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="cf"
                  stroke="#38bdf8"
                  strokeWidth={2}
                  fill="url(#cfGradient)"
                  dot={{ fill: '#38bdf8', r: 4, strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: '#7dd3fc' }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {annualCfChartData.length > 0 && (() => {
            const first = annualCfChartData.find(d => d.cf != null)?.cf;
            const last = [...annualCfChartData].reverse().find(d => d.cf != null)?.cf;
            if (first == null || last == null || first === last) return null;
            const delta = last - first;
            return (
              <p className={`text-[11px] mt-2 ${delta < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {delta < 0 ? '▼' : '▲'} {Math.abs(delta).toFixed(1)} pp change from {annualCfChartData[0].year} to {annualCfChartData[annualCfChartData.length - 1].year}
                {delta < -2 && (
                  <span className="text-slate-500 ml-2">— multi-year deterioration visible in generation data</span>
                )}
              </p>
            );
          })()}
        </div>
      )}

      {/* ── Regional Pursuit Targets — concentration tables ──────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <EntityExposureCard
          title="Owner Exposure"
          subtitle={
            selectedSubRegion
              ? `${selectedRegion} — ${selectedSubRegion}`
              : `${selectedRegion} — all sub-regions`
          }
          entityType="owner"
          rows={ownerRows}
          allRows={ownerExposures}
          tierFilter={ownerTierFilter}
          onTierFilterChange={setOwnerTierFilter}
          onEntityClick={onOwnerClick}
        />
        <EntityExposureCard
          title="Lender Exposure"
          subtitle={
            selectedSubRegion
              ? `${selectedRegion} — ${selectedSubRegion} (validated links only)`
              : `${selectedRegion} — all sub-regions (validated links only)`
          }
          entityType="lender"
          rows={lenderRows}
          allRows={lenderResult?.exposures ?? []}
          tierFilter={lenderTierFilter}
          onTierFilterChange={setLenderTierFilter}
          onEntityClick={onLenderClick}
          coverage={lenderResult?.coverage}
        />
      </div>

      {/* ── Lender Briefings ─────────────────────────────────────────────── */}
      <LenderBriefingsSection briefings={lenderBriefings} onLenderClick={onLenderClick} loading={loading} subregionPersistenceMap={subregionPersistenceMap} />

      {/* ── Admin: Sub-region lender ingestion ───────────────────────────── */}
      {isAdmin && (
        <SubregionIngestionPanel
          regionSubStats={regionSubStats}
          analyses={analysis?.analyses ?? []}
          selectedRegion={selectedRegion}
          ingestionSubRegion={ingestionSubRegion}
          ingestionCandidates={ingestionCandidates}
          ingestionProgress={ingestionProgress}
          ingestionRunning={ingestionRunning}
          onRequestCandidates={async (subRegion) => {
            setIngestionSubRegion(subRegion);
            setIngestionCandidates(null);
            setIngestionProgress(null);
            const candidates = await fetchSubregionResearchCandidates(
              selectedRegion,
              subRegion,
              (analysis?.analyses ?? []).map(a => ({
                plantId: a.plantId, isFlagged: a.isFlagged,
                region: a.region, subRegion: a.subRegion,
              })),
            );
            setIngestionCandidates(candidates);
          }}
          onRunIngestion={async () => {
            if (!ingestionCandidates) return;
            // Queue: plants lacking validated links AND not recently researched
            const queue = ingestionCandidates.filter(c => !c.hasValidatedLink && !c.recentlyResearched);
            if (queue.length === 0) return;
            setIngestionRunning(true);
            setIngestionProgress({ done: 0, total: queue.length, errors: 0 });
            let done = 0; let errors = 0;
            for (const c of queue) {
              const result = await triggerPlantResearch(c.plantId, false);
              done++;
              if (!result.ok && !result.skipped) errors++;
              setIngestionProgress({ done, total: queue.length, errors });
              // Small delay to avoid hammering the edge function
              await new Promise(r => setTimeout(r, 400));
            }
            setIngestionRunning(false);
          }}
          onDismiss={() => { setIngestionSubRegion(null); setIngestionCandidates(null); setIngestionProgress(null); }}
        />
      )}

      {/* ── Internal drill-down ──────────────────────────────────────────── */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl">
        <button
          onClick={() => setShowInternalDetail(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-left"
        >
          <div>
            <h2 className="text-sm font-bold text-white">Underperforming Assets — FTI internal detail</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Plant-level CF is internal only — do not share these numbers with external counterparties.
            </p>
          </div>
          <svg
            className={`w-4 h-4 text-slate-400 transform transition-transform ${showInternalDetail ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showInternalDetail && (
          <InternalDetailTable
            analyses={regionAnalyses}
            selectedSubRegion={selectedSubRegion}
            plantsById={plantsById}
            plants={plants}
            onPlantClick={onPlantClick}
          />
        )}
      </div>
    </div>
  );
};

export default RegionalAnalysisDashboard;

// ─── WhereToHuntStrip ─────────────────────────────────────────────────────────

interface WhereToHuntStripProps {
  entries: ZoneHuntEntry[];
  selectedSubRegion: string | null;
  onSelectZone: (z: string) => void;
  dispositions: BdDisposition[];
}

const WhereToHuntStrip: React.FC<WhereToHuntStripProps> = ({
  entries, selectedSubRegion, onSelectZone, dispositions,
}) => {
  if (entries.length === 0) return null;

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-bold text-white">Where to Hunt</span>
        <span className="text-[11px] text-slate-500">Top zones by vintage gap severity × MW</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {entries.map((e, i) => {
          const isSelected = selectedSubRegion === e.subRegion;
          const disp = dispositions.find(d => d.scope === 'zone' && d.key === `${e.region}|${e.subRegion}`);
          const dismissed = disp?.status === 'dismissed';
          return (
            <button
              key={e.subRegion}
              onClick={() => onSelectZone(e.subRegion)}
              disabled={dismissed}
              className={`text-left rounded-xl border p-3 transition-colors relative ${
                isSelected
                  ? 'bg-blue-900/30 border-blue-500'
                  : dismissed
                  ? 'bg-slate-900/30 border-slate-800 opacity-50 cursor-not-allowed'
                  : 'bg-slate-900 border-slate-800 hover:border-slate-600'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5">
                    {i === 0 && !dismissed && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse flex-shrink-0 mt-0.5" />
                    )}
                    <span className="text-xs font-bold text-white">{e.subRegion}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {e.capWeightedGapPp != null
                      ? `↓ ${(e.capWeightedGapPp * 100).toFixed(1)} pp vs baseline`
                      : '—'}
                  </div>
                  <div className="text-[10px] text-slate-600 mt-0.5">
                    {fmtMw(e.affectedMw)} affected
                    {e.vintageCount > 0 && (
                      <span className="ml-1.5 text-amber-600/80">{e.vintageCount} 2021–22 vintage</span>
                    )}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  {e.struggleScore != null && (
                    <span
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                      style={{ color: struggleColor(e.struggleScore), backgroundColor: `${struggleColor(e.struggleScore)}20` }}
                    >
                      {e.struggleScore}
                    </span>
                  )}
                  {disp && disp.status !== 'new' && (
                    <div className="mt-1">
                      <span className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded ${
                        disp.status === 'pursue' ? 'bg-emerald-900/40 text-emerald-400' :
                        disp.status === 'watch'  ? 'bg-amber-900/40 text-amber-400' :
                        'bg-slate-800 text-slate-500'
                      }`}>
                        {disp.status}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// ─── ZoneTargetSheetPanel ─────────────────────────────────────────────────────

interface ZoneTargetSheetPanelProps {
  sheet: ZoneTargetSheet;
  showTargetPlants: boolean;
  onToggleTargetPlants: () => void;
  onOwnerClick: (name: string) => void;
  onPlantClick: (id: string) => void;
  dispositions: BdDisposition[];
  snapshot: BdSnapshotEntry[];
  onDispose: (scope: BdDisposition['scope'], key: string, status: BdDispositionStatus) => Promise<void>;
}

const DISPOSITION_OPTIONS: { status: BdDispositionStatus; label: string; cls: string }[] = [
  { status: 'watch',     label: 'Watch',     cls: 'text-amber-400 border-amber-700/40 bg-amber-900/20' },
  { status: 'pursue',    label: 'Pursue',    cls: 'text-emerald-400 border-emerald-700/40 bg-emerald-900/20' },
  { status: 'dismissed', label: 'Dismiss',   cls: 'text-slate-500 border-slate-700 bg-slate-900' },
];

const DispositionPicker: React.FC<{
  scope: BdDisposition['scope'];
  keyStr: string;
  dispositions: BdDisposition[];
  onDispose: (scope: BdDisposition['scope'], key: string, status: BdDispositionStatus) => Promise<void>;
}> = ({ scope, keyStr, dispositions, onDispose }) => {
  const current = dispositions.find(d => d.scope === scope && d.key === keyStr);
  return (
    <div className="flex gap-1 items-center">
      {DISPOSITION_OPTIONS.map(o => (
        <button
          key={o.status}
          onClick={() => onDispose(scope, keyStr, o.status)}
          className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border transition-colors ${
            current?.status === o.status
              ? o.cls + ' ring-1 ring-offset-0'
              : 'text-slate-600 border-slate-800 bg-slate-950 hover:text-slate-400'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
};

const ZoneTargetSheetPanel: React.FC<ZoneTargetSheetPanelProps> = ({
  sheet, showTargetPlants, onToggleTargetPlants, onOwnerClick, onPlantClick,
  dispositions, snapshot, onDispose,
}) => {
  // Snapshot delta for a zone entry
  const snapshotEntry = snapshot.find(s => s.scope === 'zone' && s.key === `${sheet.region}|${sheet.subRegion}`);
  const scoreDelta = snapshotEntry ? sheet.zoneScore - snapshotEntry.targetScore : null;

  const sigLabel: Record<import('../services/regionalAnalysisService').DeclineSignature, string> = {
    'curtailment-like': 'Curtailment-like',
    'degradation-like': 'Multi-year degradation',
    mixed: 'Mixed pattern',
    unknown: '—',
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-800">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-bold text-white">Zone Target Sheet</h2>
              <span className="text-xs font-bold text-blue-400">{sheet.subRegion}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                sheet.declineSignature === 'curtailment-like' ? 'bg-amber-900/30 text-amber-300 border-amber-700/30' :
                sheet.declineSignature === 'degradation-like' ? 'bg-rose-900/30 text-rose-300 border-rose-700/30' :
                'bg-slate-800 text-slate-400 border-slate-700'
              }`}>
                {sigLabel[sheet.declineSignature]}
              </span>
              {scoreDelta != null && Math.abs(scoreDelta) > 0.5 && (
                <span className={`text-[10px] font-mono ${scoreDelta > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {scoreDelta > 0 ? '▲' : '▼'} vs last snapshot
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{sheet.thesisText}</p>
          </div>
          <div className="flex-shrink-0 text-right">
            <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">MD Review</div>
            <DispositionPicker
              scope="zone"
              keyStr={`${sheet.region}|${sheet.subRegion}`}
              dispositions={dispositions}
              onDispose={onDispose}
            />
          </div>
        </div>

        {/* Zone KPI strip */}
        <div className="mt-3 flex flex-wrap gap-4 text-[11px]">
          <div>
            <span className="text-slate-500">Baseline CF </span>
            <span className="text-slate-200 font-mono">
              {sheet.baselineCf != null ? `${(sheet.baselineCf * 100).toFixed(1)}%` : '—'}
            </span>
          </div>
          <div>
            <span className="text-slate-500">TTM CF </span>
            <span className="text-slate-200 font-mono">
              {sheet.ttmCf != null ? `${(sheet.ttmCf * 100).toFixed(1)}%` : '—'}
            </span>
          </div>
          <div>
            <span className="text-slate-500">Gap </span>
            <span className={`font-mono font-bold ${sheet.gapPp != null && sheet.gapPp > 0 ? 'text-rose-300' : 'text-slate-400'}`}>
              {sheet.gapPp != null ? `${sheet.gapPp > 0 ? '−' : ''}${(Math.abs(sheet.gapPp) * 100).toFixed(1)} pp` : '—'}
            </span>
          </div>
          <div>
            <span className="text-slate-500">Plants / MW </span>
            <span className="text-slate-200 font-mono">{sheet.affectedPlantCount} / {fmtMw(sheet.totalMw)}</span>
          </div>
        </div>
      </div>

      {/* Owner cluster table */}
      <div className="px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider">Owner Clusters</h3>
          <span className="text-[10px] text-slate-500">Ranked by BD targeting score · sorted by concentration × gap × vintage</span>
        </div>

        {sheet.ownerClusters.length === 0 ? (
          <p className="text-xs text-slate-500 py-3">No owner clusters with sufficient vintage gap data in this zone.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-xs min-w-[700px]">
              <thead className="bg-slate-950/60 text-slate-500 uppercase text-[10px] font-bold">
                <tr>
                  <th className="text-left px-3 py-2">Owner</th>
                  <th className="text-right px-2 py-2">Plants</th>
                  <th className="text-right px-2 py-2">MW</th>
                  <th className="text-right px-2 py-2">Avg Gap</th>
                  <th className="text-right px-2 py-2">Est. $/yr<sup className="text-[8px]">†</sup></th>
                  <th className="text-left px-2 py-2">Lenders</th>
                  <th className="text-left px-2 py-2">MD Review</th>
                </tr>
              </thead>
              <tbody>
                {sheet.ownerClusters.map(cluster => {
                  const ownerKey = `owner:${cluster.owner}`;
                  const disp = dispositions.find(d => d.scope === 'owner' && d.key === ownerKey);
                  const dismissed = disp?.status === 'dismissed';
                  return (
                    <React.Fragment key={cluster.owner}>
                      <tr className={`border-t border-slate-800 ${dismissed ? 'opacity-40' : 'hover:bg-slate-800/30'} transition-colors`}>
                        <td className="px-3 py-2.5">
                          <button
                            onClick={() => onOwnerClick(cluster.owner)}
                            className="text-blue-400 hover:text-blue-300 font-semibold text-left leading-tight"
                          >
                            {cluster.owner}
                          </button>
                          {cluster.plants.length >= 2 && (
                            <span className={`ml-2 px-1.5 py-0.5 rounded-full text-[9px] font-bold border ${
                              cluster.plants.length >= 3
                                ? 'bg-rose-900/40 text-rose-300 border-rose-700/30'
                                : 'bg-amber-900/40 text-amber-300 border-amber-700/30'
                            }`}>
                              {cluster.plants.length} plants — portfolio exposure
                            </span>
                          )}
                          {cluster.qualifiedLenderDoor && (
                            <span className="ml-1.5 px-1.5 py-0.5 bg-violet-900/40 text-violet-300 border border-violet-700/30 rounded-full text-[9px] font-bold">
                              lender door
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-slate-300">{cluster.plants.length}</td>
                        <td className="px-2 py-2.5 text-right font-mono text-slate-300">{fmtMw(cluster.totalMw)}</td>
                        <td className="px-2 py-2.5 text-right font-mono text-rose-300">
                          {cluster.capWeightedGapPp > 0 ? `−${(cluster.capWeightedGapPp * 100).toFixed(1)} pp` : '—'}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-slate-300">
                          {cluster.estAnnualShortfallUsd != null && cluster.estAnnualShortfallUsd > 0.05
                            ? `~$${cluster.estAnnualShortfallUsd.toFixed(1)}M`
                            : '—'}
                        </td>
                        <td className="px-2 py-2.5">
                          {cluster.knownLenders.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {cluster.knownLenders.slice(0, 2).map(l => (
                                <span key={l} className={`px-1.5 py-0.5 rounded text-[9px] border font-medium ${
                                  cluster.qualifiedLenderDoor
                                    ? 'bg-violet-900/30 text-violet-300 border-violet-700/30'
                                    : 'bg-slate-800 text-slate-400 border-slate-700'
                                }`}>
                                  {l}
                                </span>
                              ))}
                              {cluster.knownLenders.length > 2 && (
                                <span className="text-[9px] text-slate-600">+{cluster.knownLenders.length - 2}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-600">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          <DispositionPicker
                            scope="owner"
                            keyStr={ownerKey}
                            dispositions={dispositions}
                            onDispose={onDispose}
                          />
                        </td>
                      </tr>
                      {/* Conversation opener (internal — collapsed by default) */}
                      {!dismissed && (
                        <tr className="bg-slate-950/40 border-t border-slate-800/50">
                          <td colSpan={7} className="px-3 pb-2 pt-1">
                            <div className="flex items-start gap-1.5">
                              <span className="text-[9px] text-slate-600 uppercase tracking-widest font-bold mt-0.5 flex-shrink-0">
                                Internal opener
                              </span>
                              <span className="text-[11px] text-slate-500 italic leading-relaxed">
                                {cluster.conversationOpener}
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[10px] text-slate-600 mt-2">
          <sup>†</sup> Revenue shortfall estimate: cap-weighted CF gap × MW × 8,760 hr/yr × {
            AVG_REALIZED_PRICE_BY_REGION[String(sheet.region)] ?? 35
          }/MWh (EIA avg realized — directional only, not a price forecast).
          Conversation openers are internal-only — do not share plant-specific CF data externally.
        </p>
      </div>

      {/* Top-10 target plants (expandable, INTERNAL) */}
      <div className="border-t border-slate-800">
        <button
          onClick={onToggleTargetPlants}
          className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-slate-800/40 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-300">
              Top {Math.min(sheet.topPlants.length, 10)} Target Plants — FTI Internal Only
            </span>
            <span className="px-1.5 py-0.5 bg-rose-900/30 text-rose-300 border border-rose-700/30 text-[9px] rounded font-bold uppercase">
              INTERNAL
            </span>
          </div>
          <svg
            className={`w-3.5 h-3.5 text-slate-500 transform transition-transform ${showTargetPlants ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showTargetPlants && (
          <div className="px-5 pb-5">
            <div className="bg-rose-950/20 border border-rose-800/30 rounded-xl p-3 mb-3 text-[11px] text-rose-300">
              These are internal analysis assets only. Never share plant-specific CF data, gap figures, or
              this ranking with external counterparties.
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-xs min-w-[760px]">
                <thead className="bg-slate-950/60 text-slate-500 uppercase text-[10px] font-bold">
                  <tr>
                    <th className="text-center px-2 py-2 w-6">#</th>
                    <th className="text-left px-3 py-2">Plant</th>
                    <th className="text-left px-2 py-2">Owner</th>
                    <th className="text-right px-2 py-2">COD</th>
                    <th className="text-right px-2 py-2">MW</th>
                    <th className="text-right px-2 py-2">Baseline</th>
                    <th className="text-right px-2 py-2">TTM</th>
                    <th className="text-right px-2 py-2">Gap</th>
                    <th className="text-left px-2 py-2">Signature</th>
                    <th className="text-left px-3 py-2">MD Review</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.topPlants.map(p => {
                    const plantKey = `plant:${p.plantId}`;
                    const disp = dispositions.find(d => d.scope === 'plant' && d.key === plantKey);
                    const dismissed = disp?.status === 'dismissed';
                    return (
                      <tr
                        key={p.plantId}
                        className={`border-t border-slate-800 ${dismissed ? 'opacity-40' : 'hover:bg-slate-800/30'} transition-colors`}
                      >
                        <td className="px-2 py-2 text-center text-slate-600 font-mono text-[11px]">{p.rank}</td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => onPlantClick(p.plantId)}
                            className="text-blue-400 hover:text-blue-300 font-semibold text-left"
                          >
                            {p.plantName}
                          </button>
                          {p.knownLenders.length > 0 && (
                            <span className="ml-1.5 text-[9px] text-violet-400">• lender known</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-slate-400">{p.owner}</td>
                        <td className="px-2 py-2 text-right font-mono text-slate-400">
                          {p.codYear ?? '—'}
                          {p.codYear != null && p.codYear >= 2021 && p.codYear <= 2022 && (
                            <span className="ml-1 text-amber-500" title="2021–22 vintage: likely underwritten at peak">★</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-slate-300">{p.mw.toFixed(0)}</td>
                        <td className="px-2 py-2 text-right font-mono text-slate-400">{(p.baselineCf * 100).toFixed(1)}%</td>
                        <td className="px-2 py-2 text-right font-mono text-slate-300">{(p.currentCf * 100).toFixed(1)}%</td>
                        <td className="px-2 py-2 text-right font-mono font-bold text-rose-300">
                          {p.gapPp > 0 ? `−${(p.gapPp * 100).toFixed(1)} pp` : '—'}
                        </td>
                        <td className="px-2 py-2">
                          <span className={`text-[9px] px-1 py-0.5 rounded border ${
                            p.declineSignature === 'curtailment-like' ? 'text-amber-300 bg-amber-900/20 border-amber-700/30' :
                            p.declineSignature === 'degradation-like' ? 'text-rose-300 bg-rose-900/20 border-rose-700/30' :
                            'text-slate-500 bg-slate-800 border-slate-700'
                          }`}>
                            {p.declineSignature === 'unknown' ? '—' : p.declineSignature}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <DispositionPicker
                            scope="plant"
                            keyStr={plantKey}
                            dispositions={dispositions}
                            onDispose={onDispose}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Sub-components ──────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  tone?: 'neutral' | 'warn';
}
const KpiCard: React.FC<KpiCardProps> = ({ label, value, sub, tone = 'neutral' }) => (
  <div className={`bg-slate-900 border rounded-2xl p-4 ${tone === 'warn' ? 'border-amber-800/40' : 'border-slate-800'}`}>
    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{label}</div>
    <div className={`text-2xl font-black mt-1 ${tone === 'warn' ? 'text-amber-300' : 'text-white'}`}>{value}</div>
    {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
  </div>
);

interface MapLegendProps { metric: MapMetric }
const MapLegend: React.FC<MapLegendProps> = ({ metric }) => {
  const stops = metric === 'struggle'
    ? [
        { c: struggleColor(0), l: '0' },
        { c: struggleColor(THRESHOLDS.struggleWarm), l: `${THRESHOLDS.struggleWarm}` },
        { c: struggleColor(THRESHOLDS.struggleHot), l: `${THRESHOLDS.struggleHot}+` },
      ]
    : metric === 'excessDecline'
    ? [
        { c: '#10b981', l: 'at/above national' },
        { c: '#f59e0b', l: 'slight excess' },
        { c: '#ef4444', l: 'large excess' },
      ]
    : [
        { c: '#10b981', l: 'few' },
        { c: '#f59e0b', l: 'mixed' },
        { c: '#ef4444', l: 'many' },
      ];
  return (
    <div className="mt-3 flex items-center gap-3 text-[10px] text-slate-500">
      <span className="uppercase tracking-widest font-bold">Legend</span>
      {stops.map((s, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: s.c }} />
          {s.l}
        </span>
      ))}
      <span className="flex items-center gap-1 ml-auto">
        <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: '#334155' }} />
        <span>&lt; {THRESHOLDS.minPlantsPerSubregion} plants (suppressed)</span>
      </span>
    </div>
  );
};

interface SubregionTooltipProps {
  subregionStatsMap: Map<string, SubregionStats> | undefined;
  selectedRegion: Region;
  regionTtmCf: number | null;
  nationalTtmCf: number | null;
}
const SubregionTooltip: React.FC<SubregionTooltipProps> = ({
  subregionStatsMap,
  selectedRegion,
  regionTtmCf,
  nationalTtmCf,
}) => {
  // The tooltip is sticky so it follows the cursor — we show generic region-level
  // context here; the sub-region signal detail is in the entity tables below.
  return (
    <div className="text-xs max-w-[220px]">
      <div className="font-bold text-slate-900">{selectedRegion}</div>
      <div className="text-slate-700">
        Regional CF: {fmtPct(regionTtmCf)} · National CF: {fmtPct(nationalTtmCf)}
      </div>
      <div className="text-slate-500 mt-1 text-[10px]">
        Colour shows sub-region struggle score (YoY decline vs own history + national cohort).
        Click to drill down.
      </div>
    </div>
  );
};

interface EntityExposureCardProps {
  title: string;
  subtitle: string;
  entityType: 'owner' | 'lender';
  rows: EntityExposure[];
  allRows: EntityExposure[];
  tierFilter: TierFilter;
  onTierFilterChange: (t: TierFilter) => void;
  onEntityClick: (name: string) => void;
  coverage?: LenderCoverage;
}
const EntityExposureCard: React.FC<EntityExposureCardProps> = ({
  title,
  subtitle,
  entityType,
  rows,
  allRows,
  tierFilter,
  onTierFilterChange,
  onEntityClick,
  coverage,
}) => {
  const counts = {
    all: allRows.length,
    hot: allRows.filter(r => r.tier === 'hot').length,
    warm: allRows.filter(r => r.tier === 'warm').length,
    cold: allRows.filter(r => r.tier === 'cold').length,
  };
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="text-sm font-bold text-white">{title}</h2>
          <p className="text-[11px] text-slate-500">{subtitle}</p>
        </div>
      </div>

      {entityType === 'lender' && coverage && (
        <div className="mb-3 rounded-xl border border-amber-800/40 bg-amber-900/15 p-3 text-[11px] text-amber-200">
          <div className="font-semibold text-amber-100 mb-0.5">Coverage caveat</div>
          Validated lender data available for{' '}
          <span className="font-mono">{coverage.flaggedPlantsWithValidatedLender}</span>{' '}
          of <span className="font-mono">{coverage.flaggedPlantsInScope}</span> flagged plants
          ({(coverage.ratio * 100).toFixed(0)}%). Public lender data is incomplete — absence of a
          lender here does not mean absence of exposure.
        </div>
      )}

      <div className="flex gap-1 mb-3">
        {(['all', 'hot', 'warm', 'cold'] as TierFilter[]).map(t => (
          <button
            key={t}
            onClick={() => onTierFilterChange(t)}
            className={`px-2 py-1 rounded-md text-[10px] font-semibold border transition-colors capitalize ${
              tierFilter === t
                ? 'bg-slate-800 border-slate-600 text-white'
                : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {t} <span className="ml-1 text-slate-500">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="overflow-auto max-h-[420px] rounded-xl border border-slate-800">
        <table className="w-full text-xs">
          <thead className="bg-slate-950/50 text-slate-500 uppercase text-[10px] font-bold sticky top-0">
            <tr>
              <th className="text-left px-3 py-2">Entity</th>
              <th className="text-left px-2 py-2">Tier</th>
              <th className="text-right px-2 py-2">Exposed MW</th>
              <th className="text-right px-2 py-2">Plants</th>
              <th className="text-right px-3 py-2">Portfolio Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  No {entityType}s in this tier for the current scope.
                </td>
              </tr>
            )}
            {rows.map(r => (
              <tr key={r.entityName} className="border-t border-slate-800 hover:bg-slate-800/40">
                <td className="px-3 py-2">
                  <button
                    onClick={() => onEntityClick(r.entityName)}
                    className="text-blue-400 hover:text-blue-300 font-semibold text-left"
                  >
                    {r.entityName}
                  </button>
                </td>
                <td className="px-2 py-2">
                  <span
                    className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-widest ${tierBadgeClasses(r.tier)}`}
                  >
                    {r.tier}
                  </span>
                </td>
                <td className="px-2 py-2 text-right font-mono text-slate-200">{fmtMw(r.exposedMw)}</td>
                <td className="px-2 py-2 text-right font-mono text-slate-400">{r.plantCount}</td>
                <td className="px-3 py-2 text-right font-mono text-slate-400">
                  {(r.portfolioShare * 100).toFixed(0)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

interface InternalDetailTableProps {
  analyses: PlantAnalysis[];
  selectedSubRegion: string | null;
  plantsById: ReturnType<typeof buildPlantsById> | null;
  plants: PowerPlant[];
  onPlantClick: (plantId: string) => void;
}
const InternalDetailTable: React.FC<InternalDetailTableProps> = ({
  analyses,
  selectedSubRegion,
  plants,
  onPlantClick,
}) => {
  const scoped = selectedSubRegion
    ? analyses.filter(a => a.subRegion === selectedSubRegion && a.isFlagged)
    : analyses.filter(a => a.isFlagged);
  const [sortKey, setSortKey] = useState<'delta' | 'deterioration'>('deterioration');
  const rows = useMemo(() => {
    const arr = [...scoped];
    if (sortKey === 'delta') {
      arr.sort((a, b) => {
        const da = a.peerAvgTtmCf != null ? a.ttmCf - a.peerAvgTtmCf : 0;
        const db = b.peerAvgTtmCf != null ? b.ttmCf - b.peerAvgTtmCf : 0;
        return da - db;
      });
    } else {
      arr.sort((a, b) => (b.yoyDeclinePts ?? -1) - (a.yoyDeclinePts ?? -1));
    }
    return arr;
  }, [scoped, sortKey]);

  const plantMap = useMemo(() => {
    const m = new Map<string, PowerPlant>();
    for (const p of plants) m.set(p.id, p);
    return m;
  }, [plants]);

  return (
    <div className="px-5 pb-5">
      <div className="flex gap-2 mb-2">
        <button
          onClick={() => setSortKey('deterioration')}
          className={`px-2 py-1 rounded-md text-[10px] font-semibold border ${
            sortKey === 'deterioration'
              ? 'bg-slate-800 border-slate-600 text-white'
              : 'bg-slate-950 border-slate-800 text-slate-400'
          }`}
        >
          Sort: Deterioration ↓
        </button>
        <button
          onClick={() => setSortKey('delta')}
          className={`px-2 py-1 rounded-md text-[10px] font-semibold border ${
            sortKey === 'delta'
              ? 'bg-slate-800 border-slate-600 text-white'
              : 'bg-slate-950 border-slate-800 text-slate-400'
          }`}
        >
          Sort: Δ vs peer ↑
        </button>
        <div className="ml-auto text-[11px] text-slate-500 self-center">
          {rows.length} flagged plant{rows.length === 1 ? '' : 's'}
        </div>
      </div>
      <div className="overflow-auto max-h-[420px] rounded-xl border border-slate-800">
        <table className="w-full text-xs">
          <thead className="bg-slate-950/50 text-slate-500 uppercase text-[10px] font-bold sticky top-0">
            <tr>
              <th className="text-left px-3 py-2">Plant</th>
              <th className="text-left px-2 py-2">Sub-region</th>
              <th className="text-left px-2 py-2">Tech</th>
              <th className="text-left px-2 py-2">Owner</th>
              <th className="text-right px-2 py-2">MW</th>
              <th className="text-right px-2 py-2">TTM CF</th>
              <th className="text-right px-2 py-2">Δ vs peer</th>
              <th className="text-right px-2 py-2">Det. (pts)</th>
              <th className="text-right px-3 py-2">Curt.</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                  No flagged plants for the current scope.
                </td>
              </tr>
            )}
            {rows.map(a => {
              const plant = plantMap.get(a.plantId);
              const delta = a.peerAvgTtmCf != null ? a.ttmCf - a.peerAvgTtmCf : null;
              return (
                <tr
                  key={a.plantId}
                  className="border-t border-slate-800 hover:bg-slate-800/40"
                >
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onPlantClick(a.plantId)}
                      className="text-blue-400 hover:text-blue-300 font-semibold text-left"
                    >
                      {plant?.name ?? a.plantId}
                    </button>
                  </td>
                  <td className="px-2 py-2 text-slate-400">{a.subRegion}</td>
                  <td className="px-2 py-2 text-slate-400">{a.fuelSource}</td>
                  <td className="px-2 py-2 text-slate-400">{plant?.owner ?? '—'}</td>
                  <td className="px-2 py-2 text-right font-mono text-slate-200">{a.nameplateMw.toFixed(0)}</td>
                  <td className="px-2 py-2 text-right font-mono text-slate-200">{fmtPct(a.ttmCf)}</td>
                  <td className={`px-2 py-2 text-right font-mono ${delta != null && delta < 0 ? 'text-rose-300' : 'text-slate-400'}`}>
                    {delta == null ? '—' : `${(delta * 100).toFixed(1)}pt`}
                  </td>
                  <td className={`px-2 py-2 text-right font-mono ${a.isDeteriorating ? 'text-rose-300' : 'text-slate-400'}`}>
                    {a.yoyDeclinePts == null ? '—' : `${(a.yoyDeclinePts * 100).toFixed(1)}pt`}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">{a.curtailmentScore.toFixed(0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ─── TopTargetsTable ──────────────────────────────────────────────────────────

interface TopTargetsTableProps {
  targets: TopTarget[];
  onOwnerClick: (name: string) => void;
  onLenderClick: (name: string) => void;
  loading: boolean;
}
const TopTargetsTable: React.FC<TopTargetsTableProps> = ({
  targets,
  onOwnerClick,
  onLenderClick,
  loading,
}) => {
  if (loading) return null;
  if (targets.length === 0) return (
    <div className="bg-slate-900 border border-dashed border-slate-700 rounded-2xl p-5 text-sm text-slate-500">
      No hot or warm targets in the current scope. Select a different ISO, adjust the tech filter, or
      deploy the <code className="text-amber-400 text-[11px]">get_plant_cf_windows</code> RPC to enable
      deterioration-based signals (see deterioration banner above).
    </div>
  );

  const hasLenders = targets.some(t => t.entityType === 'lender');

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
      <div className="flex items-end justify-between mb-3">
        <div>
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
            Top BD Targets — Regional Pursuit Priority
          </h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Hot &amp; warm entities ranked by exposed MW concentration, portfolio share, and sub-region distress.
            {' '}<span className="text-amber-600">Pitch externally at regional level only — do not share plant-specific CF data.</span>
          </p>
        </div>
        <span className="text-[10px] text-slate-500 whitespace-nowrap ml-4">
          {targets.length} target{targets.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-xs min-w-[720px]">
          <thead className="bg-slate-950/60 text-slate-500 uppercase text-[10px] font-bold sticky top-0">
            <tr>
              <th className="text-center px-2 py-2 w-8">#</th>
              <th className="text-left px-3 py-2">Entity</th>
              <th className="text-left px-2 py-2">Role</th>
              <th className="text-left px-2 py-2">Tier</th>
              <th className="text-right px-2 py-2">Exposed MW</th>
              <th className="text-right px-2 py-2">Portfolio %</th>
              <th className="text-right px-2 py-2">
                Est. $/yr <sup className="text-[8px] normal-case">†</sup>
              </th>
              <th className="text-left px-3 py-2">Why now</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t, i) => (
              <tr
                key={`${t.entityName}|${t.entityType}`}
                className="border-t border-slate-800 hover:bg-slate-800/30 transition-colors"
              >
                <td className="px-2 py-2.5 text-center text-slate-500 font-mono text-[11px]">{i + 1}</td>
                <td className="px-3 py-2.5">
                  <button
                    onClick={() =>
                      t.entityType === 'owner'
                        ? onOwnerClick(t.entityName)
                        : onLenderClick(t.entityName)
                    }
                    className="text-blue-400 hover:text-blue-300 font-semibold text-left leading-tight"
                  >
                    {t.entityName}
                  </button>
                </td>
                <td className="px-2 py-2.5">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase border ${
                      t.entityType === 'owner'
                        ? 'bg-sky-900/40 text-sky-300 border-sky-700/40'
                        : 'bg-violet-900/40 text-violet-300 border-violet-700/40'
                    }`}
                  >
                    {t.entityType === 'owner' ? 'Owner' : 'Lender'}
                  </span>
                </td>
                <td className="px-2 py-2.5">
                  <span
                    className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-widest ${tierBadgeClasses(t.tier)}`}
                  >
                    {t.tier}
                  </span>
                </td>
                <td className="px-2 py-2.5 text-right font-mono text-slate-200">{fmtMw(t.exposedMw)}</td>
                <td className="px-2 py-2.5 text-right font-mono text-slate-400">
                  {(t.portfolioShare * 100).toFixed(0)}%
                </td>
                <td className="px-2 py-2.5 text-right font-mono text-slate-300">
                  {t.revenueAtRiskUsd != null && t.revenueAtRiskUsd > 0.05
                    ? `~$${t.revenueAtRiskUsd.toFixed(1)}M`
                    : '—'}
                </td>
                <td className="px-3 py-2.5 text-slate-400 max-w-[280px]">
                  <span title={t.whyNow} className="block truncate">{t.whyNow}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-col gap-1 text-[10px] text-slate-600">
        <span>
          <sup>†</sup> Revenue-at-risk is a directional estimate: CF shortfall vs sub-region benchmark ×
          exposed MW × 8,760 hr/yr × EIA average realized price
          (ERCOT ${AVG_REALIZED_PRICE_BY_REGION['ERCOT']}/MWh, CAISO ${AVG_REALIZED_PRICE_BY_REGION['CAISO']},
          SPP ${AVG_REALIZED_PRICE_BY_REGION['SPP']}, MISO ${AVG_REALIZED_PRICE_BY_REGION['MISO']},
          PJM ${AVG_REALIZED_PRICE_BY_REGION['PJM']}, NYISO ${AVG_REALIZED_PRICE_BY_REGION['NYISO']},
          ISO-NE ${AVG_REALIZED_PRICE_BY_REGION['ISO-NE']}/MWh). Not a price forecast.
        </span>
        {hasLenders && (
          <span className="text-amber-700/80">
            Lender entries reflect validated links only — public lender data is incomplete; absence here does not mean absence of exposure.
          </span>
        )}
      </div>
    </div>
  );
};

// ─── Sparkline ────────────────────────────────────────────────────────────────

interface SparklineProps {
  data: number[];
  color?: string;
}
/**
 * Tiny inline sparkline (80 × 28 px). Requires get_subregion_monthly_cf RPC.
 * Shows nothing if data is empty.
 */
const Sparkline: React.FC<SparklineProps> = ({ data, color = '#38bdf8' }) => {
  if (data.length < 2) return <span className="inline-block w-20 text-slate-700 text-[10px]">—</span>;
  const pts = data.map((cf, i) => ({ i, cf: Math.round(cf * 1000) / 10 }));
  return (
    <LineChart width={80} height={28} data={pts} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
      <Line
        type="monotone"
        dataKey="cf"
        dot={false}
        stroke={color}
        strokeWidth={1.5}
        isAnimationActive={false}
      />
    </LineChart>
  );
};

// ─── SubregionIngestionPanel (admin only) ────────────────────────────────────

interface SubregionIngestionPanelProps {
  regionSubStats: import('../services/regionalAnalysisService').SubregionStats[];
  analyses: import('../services/regionalAnalysisService').PlantAnalysis[];
  selectedRegion: Region;
  ingestionSubRegion: string | null;
  ingestionCandidates: import('../services/regionalAnalysisService').SubregionResearchCandidate[] | null;
  ingestionProgress: { done: number; total: number; errors: number } | null;
  ingestionRunning: boolean;
  onRequestCandidates: (subRegion: string) => Promise<void>;
  onRunIngestion: () => Promise<void>;
  onDismiss: () => void;
}

const COST_PER_PLANT_USD = 0.004;

const SubregionIngestionPanel: React.FC<SubregionIngestionPanelProps> = ({
  regionSubStats, selectedRegion,
  ingestionSubRegion, ingestionCandidates, ingestionProgress, ingestionRunning,
  onRequestCandidates, onRunIngestion, onDismiss,
}) => {
  const hotWarmStats = regionSubStats.filter(
    s => s.struggleScore != null && s.struggleScore >= 35 // warm+ threshold
  );

  if (hotWarmStats.length === 0) return null;

  const queue = ingestionCandidates?.filter(c => !c.hasValidatedLink && !c.recentlyResearched) ?? [];
  const estimatedCostUsd = queue.length * COST_PER_PLANT_USD;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-bold text-white">🔬 Lender Research — Admin</span>
        <span className="px-1.5 py-0.5 bg-violet-900/60 text-violet-300 text-[10px] rounded-full font-semibold">Admin only</span>
      </div>
      <p className="text-xs text-slate-400 mb-3">
        Queue flagged plants lacking validated lender links through the sonar pipeline
        (~${COST_PER_PLANT_USD.toFixed(3)}/plant).
      </p>

      {/* Sub-region picker */}
      <div className="flex flex-wrap gap-2 mb-4">
        {hotWarmStats.map(s => (
          <button
            key={s.subRegion}
            disabled={ingestionRunning}
            onClick={() => onRequestCandidates(s.subRegion)}
            className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors ${
              ingestionSubRegion === s.subRegion
                ? 'bg-violet-700 border-violet-500 text-white'
                : 'bg-slate-950 border-slate-700 text-slate-300 hover:border-slate-500'
            } disabled:opacity-40`}
          >
            {s.subRegion}
            {s.struggleScore != null && (
              <span className="ml-1.5 opacity-70">({s.struggleScore})</span>
            )}
          </button>
        ))}
        {ingestionSubRegion && (
          <button onClick={onDismiss} className="px-2 py-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors">
            ✕ dismiss
          </button>
        )}
      </div>

      {/* Candidate list */}
      {ingestionSubRegion && ingestionCandidates === null && (
        <p className="text-xs text-slate-500 py-2">Loading candidates…</p>
      )}
      {ingestionCandidates !== null && (
        <div>
          <div className="text-[11px] text-slate-400 mb-2">
            <span className="text-white font-semibold">{queue.length}</span> plants in queue
            {' '}<span className="text-slate-600">·</span>{' '}
            {ingestionCandidates.filter(c => c.hasValidatedLink).length} already validated
            {' '}<span className="text-slate-600">·</span>{' '}
            {ingestionCandidates.filter(c => c.recentlyResearched && !c.hasValidatedLink).length} recently researched (skip)
            {queue.length > 0 && (
              <span className="ml-2 text-slate-500">≈ ${estimatedCostUsd.toFixed(2)} est. cost</span>
            )}
          </div>

          {queue.length > 0 && !ingestionProgress && (
            <button
              onClick={onRunIngestion}
              disabled={ingestionRunning}
              className="px-4 py-2 bg-violet-700 hover:bg-violet-600 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-40"
            >
              Run research on {queue.length} plant{queue.length !== 1 ? 's' : ''} (~${estimatedCostUsd.toFixed(2)})
            </button>
          )}
          {queue.length === 0 && (
            <p className="text-xs text-slate-500">All flagged plants in this sub-region are already covered.</p>
          )}

          {/* Progress */}
          {ingestionProgress && (
            <div className="mt-2">
              <div className="flex items-center gap-3 text-xs">
                <div className="flex-1 bg-slate-800 rounded-full h-1.5">
                  <div
                    className="bg-violet-500 h-1.5 rounded-full transition-all"
                    style={{ width: `${Math.round((ingestionProgress.done / ingestionProgress.total) * 100)}%` }}
                  />
                </div>
                <span className="text-slate-400 whitespace-nowrap">
                  {ingestionProgress.done}/{ingestionProgress.total}
                  {ingestionProgress.errors > 0 && (
                    <span className="text-rose-400 ml-1">({ingestionProgress.errors} err)</span>
                  )}
                </span>
              </div>
              {!ingestionRunning && ingestionProgress.done === ingestionProgress.total && (
                <p className="text-xs text-emerald-400 mt-1">
                  ✓ Done — results will appear in the Lender Validation queue shortly.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── LenderBriefingsSection ───────────────────────────────────────────────────

interface LenderBriefingsSectionProps {
  briefings: LenderBriefing[];
  onLenderClick: (name: string) => void;
  loading: boolean;
  subregionPersistenceMap: Map<string, import('../services/regionalAnalysisService').PersistenceSignal | null>;
}

const LenderBriefingsSection: React.FC<LenderBriefingsSectionProps> = ({
  briefings,
  onLenderClick,
  loading,
  subregionPersistenceMap,
}) => {
  const [open, setOpen] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  if (loading) return null;

  const handleCopy = (text: string, idx: number) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(idx);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <div>
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-violet-400" />
            Lender Outreach Briefings
          </h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Per-lender struggle signal breakdown + ready-to-use outreach narrative. Regional framing only.
            {' '}{briefings.length > 0 ? `${briefings.length} lender${briefings.length > 1 ? 's' : ''} with hot/warm exposure.` : 'No hot/warm lender exposure in current scope.'}
          </p>
        </div>
        <svg
          className={`w-4 h-4 text-slate-400 transform transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3">
          {briefings.length === 0 && (
            <div className="text-sm text-slate-500 py-3">
              No hot or warm lender exposures in the current scope.
            </div>
          )}
          {briefings.map((b, idx) => (
            <div key={b.lenderName} className="border border-slate-800 rounded-xl overflow-hidden">
              {/* Row header */}
              <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-800/40 transition-colors"
                onClick={() => setExpandedIdx(prev => prev === idx ? null : idx)}
              >
                <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase tracking-widest ${tierBadgeClasses(b.tier)}`}>
                  {b.tier}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); onLenderClick(b.lenderName); }}
                  className="text-blue-400 hover:text-blue-300 font-semibold text-sm text-left"
                >
                  {b.lenderName}
                </button>
                <span className="ml-auto text-[11px] text-slate-400 font-mono">
                  {Math.round(b.exposedMw)} MW · {b.flaggedPlantCount} plant{b.flaggedPlantCount !== 1 ? 's' : ''}
                </span>
                {b.weightedStruggleScore != null && (
                  <span
                    className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold"
                    style={{ backgroundColor: struggleColor(b.weightedStruggleScore) + '33', color: struggleColor(b.weightedStruggleScore) }}
                  >
                    Score {b.weightedStruggleScore}
                  </span>
                )}
                <svg
                  className={`w-3 h-3 text-slate-500 ml-2 transform transition-transform ${expandedIdx === idx ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                </svg>
              </div>

              {expandedIdx === idx && (
                <div className="px-4 pb-4 space-y-3 border-t border-slate-800 pt-3">
                  {/* Sub-region breakdown table */}
                  {b.subRegionBreakdowns.length > 0 && (
                    <div className="overflow-auto rounded-lg border border-slate-700/50">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-950/50 text-slate-500 uppercase text-[10px] font-bold">
                          <tr>
                            <th className="text-left px-3 py-2">Sub-region</th>
                            <th className="text-right px-2 py-2">Exposed MW</th>
                            <th className="text-right px-2 py-2">Score</th>
                            <th className="text-right px-2 py-2">YoY ↓</th>
                            <th className="text-right px-2 py-2">vs National</th>
                            <th className="text-right px-2 py-2">Breadth</th>
                            <th className="text-right px-2 py-2">Momentum</th>
                            <th className="text-right px-2 py-2">Persistence</th>
                            <th className="text-left px-3 py-2">Diagnosis</th>
                          </tr>
                        </thead>
                        <tbody>
                          {b.subRegionBreakdowns.map(bd => (
                            <tr key={bd.subRegion} className="border-t border-slate-800">
                              <td className="px-3 py-2 font-semibold text-slate-200">{bd.subRegion}</td>
                              <td className="px-2 py-2 text-right font-mono text-slate-300">{Math.round(bd.exposedMw)} MW</td>
                              <td className="px-2 py-2 text-right font-mono">
                                {bd.struggleScore != null ? (
                                  <span style={{ color: struggleColor(bd.struggleScore) }}>{bd.struggleScore}</span>
                                ) : '—'}
                              </td>
                              <td className={`px-2 py-2 text-right font-mono ${bd.selfTrendPts != null && bd.selfTrendPts > 0 ? 'text-rose-300' : 'text-slate-400'}`}>
                                {bd.selfTrendPts != null ? `${(bd.selfTrendPts * 100).toFixed(1)} pt` : '—'}
                              </td>
                              <td className={`px-2 py-2 text-right font-mono ${bd.excessDeclinePts != null && bd.excessDeclinePts > 0 ? 'text-rose-300' : 'text-slate-400'}`}>
                                {bd.excessDeclinePts != null ? `${bd.excessDeclinePts >= 0 ? '+' : ''}${(bd.excessDeclinePts * 100).toFixed(1)} pt` : '—'}
                              </td>
                              <td className="px-2 py-2 text-right font-mono text-slate-400">
                                {`${Math.round(bd.breadth * 100)}%`}
                              </td>
                              <td className={`px-2 py-2 text-right font-mono ${bd.momentumPts != null && bd.momentumPts > 0 ? 'text-amber-300' : 'text-slate-400'}`}>
                                {bd.momentumPts != null ? `${bd.momentumPts >= 0 ? '↑' : '↓'} ${Math.abs(bd.momentumPts * 100).toFixed(1)} pt` : '—'}
                              </td>
                              <td className="px-2 py-2 text-right">
                                {(() => {
                                  const persKey = `${bd.region}|${bd.subRegion}`;
                                  const pers = subregionPersistenceMap.get(persKey);
                                  if (!pers) return <span className="text-slate-600 text-[10px]">—</span>;
                                  if (pers.eligiblePlants < 3) return <span className="text-slate-600 text-[10px]">~hist</span>;
                                  return pers.hasBadge
                                    ? <span className="text-rose-300 text-[10px] font-semibold" title={`${pers.persistentDeclinePlants}/${pers.eligiblePlants} plants`}>↓ {(pers.persistentDeclineShare * 100).toFixed(0)}%</span>
                                    : <span className="text-slate-500 text-[10px]">{(pers.persistentDeclineShare * 100).toFixed(0)}%</span>;
                                })()}
                              </td>
                              <td className="px-3 py-2 text-slate-400">{bd.diagnosisLabel ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Outreach narrative */}
                  <div className="bg-slate-950 rounded-xl border border-violet-800/30 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold text-violet-300 uppercase tracking-widest">
                        Outreach narrative — regional framing only
                      </span>
                      <button
                        onClick={() => handleCopy(b.outreachNarrative, idx)}
                        className="text-[10px] text-slate-400 hover:text-slate-200 border border-slate-700 rounded px-2 py-0.5 transition-colors"
                      >
                        {copied === idx ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">{b.outreachNarrative}</p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
