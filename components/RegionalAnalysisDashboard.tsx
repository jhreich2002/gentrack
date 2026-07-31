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
import { GeoJSON, MapContainer, TileLayer, Tooltip as LeafletTooltip } from 'react-leaflet';
import type { Feature, FeatureCollection } from 'geojson';
import type { Layer, PathOptions } from 'leaflet';
import {
  BarChart,
  Bar,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';

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
} from '../services/regionalAnalysisService';

// ─── Props ───────────────────────────────────────────────────────────────────
interface Props {
  plants: PowerPlant[];
  statsMap: Record<string, CapacityFactorStats>;
  onPlantClick: (plantId: string) => void;
  onOwnerClick: (ultParentName: string) => void;
  onLenderClick: (lenderName: string) => void;
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
}) => {
  // ── UI state ──────────────────────────────────────────────────────────────
  const [selectedRegion, setSelectedRegion] = useState<Region>(Region.ERCOT);
  const [techFilter, setTechFilter] = useState<TechFilter>('Both');
  const [selectedSubRegion, setSelectedSubRegion] = useState<string | null>(null);
  const [mapMetric, setMapMetric] = useState<MapMetric>('struggle');
  const [ownerTierFilter, setOwnerTierFilter] = useState<TierFilter>('all');
  const [lenderTierFilter, setLenderTierFilter] = useState<TierFilter>('all');
  const [showInternalDetail, setShowInternalDetail] = useState(false);

  // ── Async data ────────────────────────────────────────────────────────────
  const [cfWindows, setCfWindows] = useState<Map<string, CfWindow> | null>(null);
  const [cfWindowsError, setCfWindowsError] = useState<string | null>(null);
  const [ownerStakes, setOwnerStakes] = useState<OwnershipStake[] | null>(null);
  const [lenderStakes, setLenderStakes] = useState<LenderStake[] | null>(null);
  const [geojson, setGeojson] = useState<FeatureCollection | null>(null);
  const [geojsonError, setGeojsonError] = useState<string | null>(null);
  // Subregion monthly CF for sparklines (Phase 3). Null = not yet fetched.
  const [subregionMonthly, setSubregionMonthly] = useState<Map<string, number[]> | null>(null);

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

  // Subregion sparkline fetch (Phase 3) — re-fires when region or tech changes.
  useEffect(() => {
    let cancelled = false;
    const tech = techFilter === 'Both' ? 'Wind' : techFilter; // default to Wind when both
    (async () => {
      const data = await fetchSubregionMonthlyCf(selectedRegion, tech as any);
      if (!cancelled) setSubregionMonthly(data);
    })();
    return () => { cancelled = true; };
  }, [selectedRegion, techFilter]);

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

      {/* ── Map + benchmark strip ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-bold text-white">Sub-region map — {selectedRegion}</h2>
              <p className="text-[11px] text-slate-500">
                {selectedSubRegion ? `Selected: ${selectedSubRegion}` : 'Click a zone to drill down'}
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
                >
                  <LeafletTooltip sticky opacity={0.95}>
                    <SubregionTooltip
                      subregionStatsMap={analysis?.subregionStatsMap}
                      selectedRegion={selectedRegion}
                      regionTtmCf={regionTtmCf}
                      nationalTtmCf={nationalTtmCf}
                    />
                  </LeafletTooltip>
                </GeoJSON>
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
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={benchmarkChart} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis dataKey="name" stroke="#94a3b8" fontSize={10} tickLine={false} axisLine={false} interval={0} />
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
                <Bar dataKey="yoyDecline" radius={[4, 4, 0, 0]} barSize={36}>
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
                  return (
                    <div key={s.subRegion} className="flex items-center gap-2 text-[11px]">
                      <span
                        className="w-32 truncate text-slate-400 cursor-pointer hover:text-slate-200"
                        onClick={() => setSelectedSubRegion(prev => prev === s.subRegion ? null : s.subRegion)}
                      >
                        {s.subRegion}
                      </span>
                      <Sparkline data={pts} color={struggleColor(s.struggleScore)} />
                      <span className="font-mono text-slate-500 text-[10px]">
                        {pts.length > 0 ? `${(pts[pts.length - 1] * 100).toFixed(1)}%` : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

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
      <LenderBriefingsSection briefings={lenderBriefings} onLenderClick={onLenderClick} loading={loading} />

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

// ─── LenderBriefingsSection ───────────────────────────────────────────────────

interface LenderBriefingsSectionProps {
  briefings: LenderBriefing[];
  onLenderClick: (name: string) => void;
  loading: boolean;
}

const LenderBriefingsSection: React.FC<LenderBriefingsSectionProps> = ({
  briefings,
  onLenderClick,
  loading,
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
