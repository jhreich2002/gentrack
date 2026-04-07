import React, { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  fetchDeveloperAssets, fetchChangelog, fetchPlantsMonthlyGeneration,
  approveStagedAssets,
  DeveloperRow, AssetRegistryRow, ChangelogRow,
} from '../services/developerService';
import { PowerPlant, CapacityFactorStats } from '../types';
import { formatMonthYear } from '../constants';
import type { DeveloperAssetMapPoint, DeveloperMapViewport } from './DeveloperAssetMap';

interface Props {
  developer: DeveloperRow;
  onBack: () => void;
  onAssetClick: (assetId: string) => void;
  onPlantClick?: (plantId: string) => void;
  onTabChange?: (tab: Tab) => void;
  mapViewport?: DeveloperMapViewport | null;
  onMapViewportChange?: (viewport: DeveloperMapViewport) => void;
  plants: PowerPlant[];
  statsMap: Record<string, CapacityFactorStats>;
  initialTab?: Tab;
}

type Tab = 'overview' | 'portfolio' | 'map' | 'lead';
type MapPerformanceFilter = 'all' | 'strong' | 'watch' | 'risk' | 'offline' | 'unknown';

const DeveloperAssetMap = lazy(() => import('./DeveloperAssetMap'));

function getMapPerformanceBand(point: DeveloperAssetMapPoint): Exclude<MapPerformanceFilter, 'all'> {
  if (point.isMaintenanceOffline) return 'offline';
  if (point.dataMonthsCount != null && point.dataMonthsCount < 6) return 'unknown';
  if (point.ttmAverage == null && point.curtailmentScore == null) return 'unknown';
  if (point.curtailmentScore != null && point.curtailmentScore >= 60) return 'risk';
  if (point.isLikelyCurtailed) return 'risk';
  if (point.ttmAverage != null && point.ttmAverage < 0.15) return 'risk';
  if (point.ttmAverage != null && point.ttmAverage >= 0.25) return 'strong';
  return 'watch';
}

function confidenceColor(score: number | null) {
  if (!score) return 'text-slate-500';
  if (score >= 85) return 'text-emerald-400';
  if (score >= 60) return 'text-amber-400';
  return 'text-red-400';
}

function matchBadge(confidence: string | null) {
  const styles: Record<string, string> = {
    high: 'bg-emerald-900/30 text-emerald-400 border-emerald-500/30',
    medium: 'bg-amber-900/30 text-amber-400 border-amber-500/30',
    low: 'bg-red-900/30 text-red-400 border-red-500/30',
    none: 'bg-slate-800 text-slate-600 border-slate-700',
  };
  return styles[confidence || 'none'] || styles.none;
}

export default function DeveloperDetailView({ developer, onBack, onAssetClick, onPlantClick, onTabChange, mapViewport, onMapViewportChange, plants, statsMap, initialTab = 'overview' }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [assets, setAssets] = useState<AssetRegistryRow[]>([]);
  const [changelog, setChangelog] = useState<ChangelogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [selectedStaged, setSelectedStaged] = useState<Set<string>>(new Set());
  const [assetSearch, setAssetSearch] = useState('');
  const [mapSearch, setMapSearch] = useState('');
  const [mapSelectedState, setMapSelectedState] = useState('all');
  const [mapSelectedTech, setMapSelectedTech] = useState('all');
  const [mapPerformanceFilter, setMapPerformanceFilter] = useState<MapPerformanceFilter>('all');
  const [isoFilter, setIsoFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [techFilter, setTechFilter] = useState('all');
  const [devMonthlyRows, setDevMonthlyRows] = useState<{ plant_id: string; month: string; mwh: number | null }[]>([]);
  const [benchmarkMonthlyRows, setBenchmarkMonthlyRows] = useState<{ plant_id: string; month: string; mwh: number | null }[]>([]);
  const [perfLoading, setPerfLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchDeveloperAssets(developer.id),
      fetchChangelog(developer.id),
    ]).then(([a, ch]) => {
      setAssets(a);
      setChangelog(ch);
      setLoading(false);
    });
  }, [developer.id]);

  const graduated = useMemo(() => assets.filter(a => a.graduated), [assets]);
  const staged = useMemo(() => assets.filter(a => !a.graduated), [assets]);

  const filteredAssets = useMemo(() => {
    const src = tab === 'portfolio' ? assets : [];
    if (!assetSearch.trim()) return src;
    const q = assetSearch.toLowerCase();
    return src.filter(a => a.name.toLowerCase().includes(q) || (a.state || '').toLowerCase().includes(q));
  }, [assets, assetSearch, tab]);

  const totalMW = assets.reduce((s, a) => s + (a.capacity_mw || 0), 0);
  const techBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of assets) {
      const t = a.technology || 'unknown';
      map.set(t, (map.get(t) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [assets]);

  const stateBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of assets) {
      const s = a.state || 'Unknown';
      map.set(s, (map.get(s) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [assets]);

  const plantsByEia = useMemo(() => {
    const map = new Map<string, PowerPlant>();
    for (const plant of plants) {
      map.set(plant.eiaPlantCode, plant);
    }
    return map;
  }, [plants]);

  const mapPoints = useMemo<DeveloperAssetMapPoint[]>(() => {
    return assets
      .map((asset) => {
        const matchedPlant = asset.eia_plant_code ? plantsByEia.get(asset.eia_plant_code) : undefined;
        const stats = matchedPlant ? statsMap[matchedPlant.id] : undefined;
        const lat = matchedPlant?.location?.lat ?? asset.lat;
        const lng = matchedPlant?.location?.lng ?? asset.lng;
        if (lat == null || lng == null) return null;

        return {
          id: asset.id,
          assetId: asset.id,
          name: matchedPlant?.name || asset.name,
          eiaPlantCode: asset.eia_plant_code,
          technology: asset.technology || matchedPlant?.fuelSource || null,
          status: asset.status,
          state: matchedPlant?.location?.state || asset.state,
          county: matchedPlant?.location?.county || asset.county,
          lat,
          lng,
          capacityMw: Math.max(0, matchedPlant?.nameplateCapacityMW ?? asset.capacity_mw ?? 0),
          ttmAverage: stats?.ttmAverage ?? null,
          curtailmentScore: stats?.curtailmentScore ?? null,
          isLikelyCurtailed: Boolean(stats?.isLikelyCurtailed),
          isMaintenanceOffline: Boolean(stats?.isMaintenanceOffline),
          dataMonthsCount: stats?.dataMonthsCount ?? null,
          hasPlantMatch: Boolean(matchedPlant),
        };
      })
      .filter((point): point is DeveloperAssetMapPoint => point !== null);
  }, [assets, plantsByEia, statsMap]);

  const unmappedCount = assets.length - mapPoints.length;

  const mapStateOptions = useMemo(() => {
    return Array.from(new Set(mapPoints.map((point) => point.state).filter((state): state is string => Boolean(state)))).sort();
  }, [mapPoints]);

  const mapTechOptions = useMemo(() => {
    return Array.from(new Set(mapPoints.map((point) => point.technology).filter((tech): tech is string => Boolean(tech)))).sort();
  }, [mapPoints]);

  const filteredMapPoints = useMemo(() => {
    const q = mapSearch.trim().toLowerCase();
    return mapPoints.filter((point) => {
      const stateMatch = mapSelectedState === 'all' || point.state === mapSelectedState;
      const techMatch = mapSelectedTech === 'all' || point.technology === mapSelectedTech;
      const perfMatch = mapPerformanceFilter === 'all' || getMapPerformanceBand(point) === mapPerformanceFilter;
      const searchMatch = !q
        || point.name.toLowerCase().includes(q)
        || (point.state || '').toLowerCase().includes(q)
        || (point.county || '').toLowerCase().includes(q)
        || (point.eiaPlantCode || '').toLowerCase().includes(q);
      return stateMatch && techMatch && perfMatch && searchMatch;
    });
  }, [mapPoints, mapSearch, mapSelectedState, mapSelectedTech, mapPerformanceFilter]);

  // ── Performance tab filter options ───────────────────────────────────────
  const isoFilterOptions = useMemo(() => {
    const regions = new Set<string>();
    for (const point of mapPoints) {
      if (!point.eiaPlantCode) continue;
      const plant = plantsByEia.get(point.eiaPlantCode);
      if (plant?.region) regions.add(String(plant.region));
    }
    return Array.from(regions).sort();
  }, [mapPoints, plantsByEia]);

  const perfStateFilterOptions = useMemo(() => {
    return Array.from(
      new Set(mapPoints.map(p => p.state).filter((s): s is string => Boolean(s)))
    ).sort();
  }, [mapPoints]);

  const perfTechFilterOptions = useMemo(() => {
    return Array.from(
      new Set(mapPoints.map(p => p.technology).filter((t): t is string => Boolean(t)))
    ).sort();
  }, [mapPoints]);

  const filteredDevPoints = useMemo(() => {
    return mapPoints.filter(point => {
      if (isoFilter !== 'all') {
        const plant = point.eiaPlantCode ? plantsByEia.get(point.eiaPlantCode) : undefined;
        if (String(plant?.region ?? '') !== isoFilter) return false;
      }
      if (stateFilter !== 'all' && point.state !== stateFilter) return false;
      if (techFilter !== 'all' && (point.technology ?? '').toLowerCase() !== techFilter.toLowerCase()) return false;
      return true;
    });
  }, [mapPoints, plantsByEia, isoFilter, stateFilter, techFilter]);

  // Fetch monthly generation for developer's matched plants when Performance tab opens
  useEffect(() => {
    if (tab !== 'lead') return;
    const plantIds = Array.from(new Set(
      mapPoints
        .filter(p => p.eiaPlantCode)
        .map(p => plantsByEia.get(p.eiaPlantCode!)?.id)
        .filter((id): id is string => Boolean(id))
    ));
    if (plantIds.length === 0) { setDevMonthlyRows([]); return; }
    setPerfLoading(true);
    fetchPlantsMonthlyGeneration(plantIds).then(rows => {
      setDevMonthlyRows(rows);
      setPerfLoading(false);
    });
  }, [tab, developer.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch monthly generation for all system plants matching active filters (benchmark line)
  useEffect(() => {
    if (tab !== 'lead') return;
    const filteredSystemPlants = plants.filter(plant => {
      if (isoFilter !== 'all' && String(plant.region) !== isoFilter) return false;
      if (stateFilter !== 'all' && plant.location.state !== stateFilter) return false;
      if (techFilter !== 'all' && plant.fuelSource.toLowerCase() !== techFilter.toLowerCase()) return false;
      return true;
    });
    const plantIds = filteredSystemPlants.map(p => p.id);
    if (plantIds.length === 0) { setBenchmarkMonthlyRows([]); return; }
    fetchPlantsMonthlyGeneration(plantIds).then(rows => setBenchmarkMonthlyRows(rows));
  }, [tab, isoFilter, stateFilter, techFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Developer line: compute monthly avg CF from raw MWh rows for currently filtered plants
  const devLineData = useMemo(() => {
    const capacityById = new Map<string, number>();
    for (const point of filteredDevPoints) {
      if (!point.eiaPlantCode) continue;
      const plant = plantsByEia.get(point.eiaPlantCode);
      if (plant) capacityById.set(plant.id, plant.nameplateCapacityMW);
    }
    if (capacityById.size === 0) return [];
    const relevantIds = new Set(capacityById.keys());
    const monthMap = new Map<string, { sum: number; count: number }>();
    for (const row of devMonthlyRows) {
      if (!relevantIds.has(row.plant_id) || row.mwh == null) continue;
      const cap = capacityById.get(row.plant_id)!;
      if (cap <= 0) continue;
      const [yr, mo] = row.month.split('-').map(Number);
      const maxMwh = cap * new Date(yr, mo, 0).getDate() * 24;
      const cf = Math.min(1, Math.max(0, row.mwh / maxMwh));
      const agg = monthMap.get(row.month) ?? { sum: 0, count: 0 };
      monthMap.set(row.month, { sum: agg.sum + cf, count: agg.count + 1 });
    }
    return Array.from(monthMap.entries())
      .map(([month, { sum, count }]) => ({ month, dev: sum / count }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [devMonthlyRows, filteredDevPoints, plantsByEia]);

  // Benchmark line: avg CF per month across all filtered system plants
  const benchmarkLineData = useMemo(() => {
    const capacityById = new Map<string, number>();
    for (const plant of plants) { capacityById.set(plant.id, plant.nameplateCapacityMW); }
    const monthMap = new Map<string, { sum: number; count: number }>();
    for (const row of benchmarkMonthlyRows) {
      if (row.mwh == null) continue;
      const cap = capacityById.get(row.plant_id);
      if (!cap || cap <= 0) continue;
      const [yr, mo] = row.month.split('-').map(Number);
      const maxMwh = cap * new Date(yr, mo, 0).getDate() * 24;
      const cf = Math.min(1, Math.max(0, row.mwh / maxMwh));
      const agg = monthMap.get(row.month) ?? { sum: 0, count: 0 };
      monthMap.set(row.month, { sum: agg.sum + cf, count: agg.count + 1 });
    }
    return Array.from(monthMap.entries())
      .map(([month, { sum, count }]) => ({ month, benchmark: sum / count }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [benchmarkMonthlyRows, plants]);

  const chartData = useMemo(() => {
    const monthMap = new Map<string, { month: string; dev?: number; benchmark?: number }>();
    for (const d of devLineData) {
      monthMap.set(d.month, { month: d.month, dev: d.dev });
    }
    for (const b of benchmarkLineData) {
      const existing = monthMap.get(b.month) ?? { month: b.month };
      monthMap.set(b.month, { ...existing, benchmark: b.benchmark });
    }
    return Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [devLineData, benchmarkLineData]);

  const handleApprove = async () => {
    if (selectedStaged.size === 0) return;
    setApproving(true);
    const count = await approveStagedAssets(Array.from(selectedStaged));
    // Refresh assets
    const updated = await fetchDeveloperAssets(developer.id);
    setAssets(updated);
    setSelectedStaged(new Set());
    setApproving(false);
    alert(`Graduated ${count} asset(s)`);
  };

  const toggleStaged = (id: string) => {
    setSelectedStaged(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleTabChange = (nextTab: Tab) => {
    setTab(nextTab);
    onTabChange?.(nextTab);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500">
        Loading developer details…
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <header className="flex items-start justify-between mb-8">
        <div>
          <button onClick={onBack} className="flex items-center gap-2 text-slate-500 hover:text-blue-400 transition-colors mb-4 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
            <span className="text-sm font-medium group-hover:underline">Developer Registry</span>
          </button>
          <h1 className="text-3xl font-black text-white tracking-tight">{developer.name}</h1>
          <div className="flex items-center gap-4 mt-2">
            <span className="text-sm text-slate-500">{developer.entity_type || 'Developer'}</span>
            {developer.hq_state && <span className="text-sm text-slate-500">• {developer.hq_state}</span>}
            {developer.website && (
              <a href={developer.website} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-500 hover:underline">
                {developer.website.replace(/^https?:\/\//, '')}
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-slate-900 rounded-xl p-1 w-fit border border-slate-800">
        {(['overview', 'portfolio', 'map', 'lead'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              tab === t ? 'bg-slate-800 text-white shadow' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t === 'overview' ? 'Overview' : t === 'portfolio' ? 'Portfolio' : t === 'map' ? 'Asset Map' : 'Performance'}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {tab === 'overview' && (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-5 gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Assets</div>
              <div className="text-2xl font-black text-white">{assets.length}</div>
              <div className="text-[10px] text-slate-600 mt-1">{graduated.length} graduated • {staged.length} staged</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Total MW</div>
              <div className="text-2xl font-black text-white">{totalMW.toLocaleString()}</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">EIA Coverage</div>
              <div className="text-2xl font-black text-emerald-400">
                {developer.coverage_rate != null ? `${(developer.coverage_rate * 100).toFixed(0)}%` : '—'}
              </div>
              <div className="text-[10px] text-slate-600 mt-1">
                {developer.eia_benchmark_count ? `vs ${developer.eia_benchmark_count} EIA plants` : ''}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Avg Confidence</div>
              <div className={`text-2xl font-black ${confidenceColor(developer.avg_confidence)}`}>
                {developer.avg_confidence != null ? developer.avg_confidence.toFixed(0) : '—'}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">API Spend</div>
              <div className="text-2xl font-black text-amber-400">${(developer.total_spend_usd || 0).toFixed(2)}</div>
            </div>
          </div>

          {/* Technology + State Breakdown */}
          <div className="grid grid-cols-2 gap-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Technology Breakdown</h3>
              <div className="space-y-3">
                {techBreakdown.map(([tech, count]) => (
                  <div key={tech} className="flex items-center justify-between">
                    <span className="text-sm text-slate-300 capitalize">{tech}</span>
                    <div className="flex items-center gap-3">
                      <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(count / assets.length) * 100}%` }} />
                      </div>
                      <span className="text-sm font-mono text-slate-400 w-8 text-right">{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Top States</h3>
              <div className="space-y-3">
                {stateBreakdown.map(([state, count]) => (
                  <div key={state} className="flex items-center justify-between">
                    <span className="text-sm text-slate-300">{state}</span>
                    <div className="flex items-center gap-3">
                      <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(count / assets.length) * 100}%` }} />
                      </div>
                      <span className="text-sm font-mono text-slate-400 w-8 text-right">{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Recent Changes */}
          {changelog.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Recent Changes</h3>
              <div className="space-y-2">
                {changelog.slice(0, 10).map(ch => (
                  <div key={ch.id} className="flex items-center gap-3 text-sm">
                    <span className="text-[10px] text-slate-600 font-mono w-20 flex-shrink-0">
                      {new Date(ch.detected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase bg-slate-800 text-slate-500 border border-slate-700">
                      {ch.change_type.replace('_', ' ')}
                    </span>
                    <span className="text-slate-400 truncate">
                      {ch.new_value?.details || JSON.stringify(ch.new_value)}
                    </span>
                    <span className="text-[10px] text-slate-700 ml-auto">{ch.detected_by}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Portfolio Tab ── */}
      {tab === 'portfolio' && (
        <div className="space-y-6">
          {/* Search */}
          <input
            type="text"
            placeholder="Search assets…"
            value={assetSearch}
            onChange={(e) => setAssetSearch(e.target.value)}
            className="w-full max-w-md px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-600 transition-colors"
          />

          {/* Graduated Assets */}
          <div>
            <h3 className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Graduated ({graduated.length})
            </h3>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                    <th className="px-5 py-4">Asset Name</th>
                    <th className="px-5 py-4">Tech</th>
                    <th className="px-5 py-4">State</th>
                    <th className="px-5 py-4 text-right">MW</th>
                    <th className="px-5 py-4">Status</th>
                    <th className="px-5 py-4">EIA Match</th>
                    <th className="px-5 py-4 text-right">Confidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {(assetSearch ? filteredAssets.filter(a => a.graduated) : graduated).map(a => (
                    <tr key={a.id} onClick={() => a.eia_plant_code && onPlantClick ? onPlantClick(a.eia_plant_code) : onAssetClick(a.id)} className="cursor-pointer hover:bg-slate-800/60 group transition-all">
                      <td className="px-5 py-4">
                        <div className="font-bold text-slate-200 group-hover:text-blue-400 transition-colors text-sm">{a.name}</div>
                        {a.eia_plant_code && <div className="text-[10px] text-slate-600 font-mono">EIA: {a.eia_plant_code}</div>}
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-[10px] px-2 py-0.5 rounded font-bold uppercase bg-blue-900/20 text-blue-400 border border-blue-500/20">
                          {a.technology || '—'}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-400">{a.state || '—'}</td>
                      <td className="px-5 py-4 text-right font-mono text-sm text-slate-300">{a.capacity_mw?.toLocaleString() || '—'}</td>
                      <td className="px-5 py-4">
                        <span className="text-[10px] font-bold uppercase text-slate-500">{a.status || '—'}</span>
                      </td>
                      <td className="px-5 py-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${matchBadge(a.match_confidence)}`}>
                          {a.match_confidence || 'none'}
                        </span>
                      </td>
                      <td className={`px-5 py-4 text-right font-mono text-sm font-bold ${confidenceColor(a.confidence_score)}`}>
                        {a.confidence_score != null ? a.confidence_score.toFixed(0) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Staged (Pending Review) */}
          {staged.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[10px] font-bold text-amber-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  Pending Review ({staged.length})
                </h3>
                {selectedStaged.size > 0 && (
                  <button
                    onClick={handleApprove}
                    disabled={approving}
                    className="px-4 py-2 rounded-lg text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-all"
                  >
                    {approving ? 'Approving…' : `Graduate ${selectedStaged.size} Selected`}
                  </button>
                )}
              </div>
              <div className="bg-slate-900 border border-amber-500/20 rounded-2xl overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                      <th className="px-5 py-4 w-8">
                        <input
                          type="checkbox"
                          checked={selectedStaged.size === staged.length}
                          onChange={() => {
                            if (selectedStaged.size === staged.length) setSelectedStaged(new Set());
                            else setSelectedStaged(new Set(staged.map(a => a.id)));
                          }}
                          className="rounded border-slate-700"
                        />
                      </th>
                      <th className="px-5 py-4">Asset Name</th>
                      <th className="px-5 py-4">Blocking Reason</th>
                      <th className="px-5 py-4">Tech</th>
                      <th className="px-5 py-4">State</th>
                      <th className="px-5 py-4 text-right">MW</th>
                      <th className="px-5 py-4 text-right">Attempts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {(assetSearch ? filteredAssets.filter(a => !a.graduated) : staged).map(a => (
                      <tr key={a.id} className="hover:bg-slate-800/60 transition-all">
                        <td className="px-5 py-4">
                          <input
                            type="checkbox"
                            checked={selectedStaged.has(a.id)}
                            onChange={() => toggleStaged(a.id)}
                            className="rounded border-slate-700"
                          />
                        </td>
                        <td className="px-5 py-4">
                          <div
                            onClick={() => onAssetClick(a.id)}
                            className="font-bold text-slate-200 hover:text-blue-400 transition-colors text-sm cursor-pointer"
                          >
                            {a.name}
                          </div>
                        </td>
                        <td className="px-5 py-4 text-sm text-amber-400/80">{a.blocking_reason || '—'}</td>
                        <td className="px-5 py-4 text-[10px] font-bold uppercase text-slate-500">{a.technology || '—'}</td>
                        <td className="px-5 py-4 text-sm text-slate-400">{a.state || '—'}</td>
                        <td className="px-5 py-4 text-right font-mono text-sm text-slate-300">{a.capacity_mw || '—'}</td>
                        <td className="px-5 py-4 text-right font-mono text-sm text-slate-600">{a.staging_attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Asset Map Tab ── */}
      {tab === 'map' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <input
                type="text"
                placeholder="Search by name, state, county, or EIA code"
                value={mapSearch}
                onChange={(e) => setMapSearch(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan-600 transition-colors"
              />

              <select
                value={mapSelectedState}
                onChange={(e) => setMapSelectedState(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-300 focus:outline-none focus:border-cyan-600 transition-colors"
              >
                <option value="all">All States</option>
                {mapStateOptions.map((state) => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </select>

              <select
                value={mapSelectedTech}
                onChange={(e) => setMapSelectedTech(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-300 focus:outline-none focus:border-cyan-600 transition-colors"
              >
                <option value="all">All Technologies</option>
                {mapTechOptions.map((tech) => (
                  <option key={tech} value={tech}>{tech}</option>
                ))}
              </select>

              <select
                value={mapPerformanceFilter}
                onChange={(e) => setMapPerformanceFilter(e.target.value as MapPerformanceFilter)}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-300 focus:outline-none focus:border-cyan-600 transition-colors"
              >
                <option value="all">All Performance Bands</option>
                <option value="strong">Strong CF</option>
                <option value="watch">Moderate</option>
                <option value="risk">Curtailed Risk</option>
                <option value="offline">Offline</option>
                <option value="unknown">Limited Data</option>
              </select>
            </div>
            <div className="text-xs text-slate-500 mt-3">
              Showing {filteredMapPoints.length.toLocaleString()} of {mapPoints.length.toLocaleString()} mapped assets. {unmappedCount.toLocaleString()} assets have no coordinates.
            </div>
          </div>

          {filteredMapPoints.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-sm text-slate-400">
              No assets match current map filters. Try clearing search or widening state/technology/performance filters.
            </div>
          ) : (
            <Suspense
              fallback={(
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-sm text-slate-400">
                  Loading asset map...
                </div>
              )}
            >
              <DeveloperAssetMap
                points={filteredMapPoints}
                unmappedCount={unmappedCount}
                onPlantClick={onPlantClick}
                initialViewport={mapViewport}
                onViewportChange={onMapViewportChange}
              />
            </Suspense>
          )}
        </div>
      )}

      {/* ── Performance Tab ── */}
      {tab === 'lead' && (
        <div className="space-y-6">
          {/* Title */}
          <div>
            <h2 className="text-xl font-black text-white">Portfolio Performance</h2>
            <p className="text-xs text-slate-500 mt-1">
              Capacity factor over time vs. system benchmark · filtered by ISO/RTO, state, and technology
            </p>
          </div>

          {/* Filter bar */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] font-bold text-slate-600 uppercase tracking-widest block mb-1.5">ISO / RTO</label>
                <select
                  value={isoFilter}
                  onChange={e => setIsoFilter(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-300 focus:outline-none focus:border-blue-600 transition-colors"
                >
                  <option value="all">All ISOs</option>
                  {isoFilterOptions.map(iso => (
                    <option key={iso} value={iso}>{iso}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-600 uppercase tracking-widest block mb-1.5">State</label>
                <select
                  value={stateFilter}
                  onChange={e => setStateFilter(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-300 focus:outline-none focus:border-blue-600 transition-colors"
                >
                  <option value="all">All States</option>
                  {perfStateFilterOptions.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] font-bold text-slate-600 uppercase tracking-widest block mb-1.5">Technology</label>
                <select
                  value={techFilter}
                  onChange={e => setTechFilter(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-slate-300 focus:outline-none focus:border-blue-600 transition-colors"
                >
                  <option value="all">All Technologies</option>
                  {perfTechFilterOptions.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>
            {/* Summary pills */}
            <div className="flex items-center gap-4 mt-4 text-xs text-slate-400">
              <span><span className="font-mono text-slate-200">{filteredDevPoints.length}</span> assets shown</span>
              <span className="text-slate-700">•</span>
              <span>
                Avg CF:{' '}
                <span className="font-mono text-slate-200">
                  {(() => {
                    const withCf = filteredDevPoints.filter(p => p.ttmAverage != null);
                    if (withCf.length === 0) return '—';
                    const avg = withCf.reduce((s, p) => s + p.ttmAverage!, 0) / withCf.length;
                    return `${(avg * 100).toFixed(1)}%`;
                  })()}
                </span>
              </span>
              <span className="text-slate-700">•</span>
              <span>
                Curtailed: <span className="font-mono text-red-400">{filteredDevPoints.filter(p => p.isLikelyCurtailed).length}</span>
              </span>
            </div>
          </div>

          {/* Chart */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
            <div className="mb-4">
              <h3 className="text-sm font-bold text-white">Monthly Capacity Factor</h3>
              <p className="text-[10px] text-slate-500 mt-0.5">
                {developer.name} vs. system average for the same filter scope
              </p>
            </div>
            {perfLoading ? (
              <div className="flex items-center justify-center h-[240px] text-sm text-slate-600">
                Loading generation data…
              </div>
            ) : chartData.length === 0 ? (
              <div className="flex items-center justify-center h-[240px] text-sm text-slate-600">
                No generation data available for assets matching these filters.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis
                    dataKey="month"
                    tickFormatter={formatMonthYear}
                    tick={{ fill: '#64748b', fontSize: 10 }}
                    tickLine={false}
                    axisLine={{ stroke: '#1e293b' }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                    tick={{ fill: '#64748b', fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                  />
                  <Tooltip
                    formatter={(value: number, name: string) => [`${(value * 100).toFixed(1)}%`, name]}
                    labelFormatter={(label: string) => formatMonthYear(label)}
                    contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: '#94a3b8' }}
                    itemStyle={{ color: '#e2e8f0' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#64748b', paddingTop: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="dev"
                    name={developer.name}
                    stroke="#60a5fa"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: '#60a5fa' }}
                    connectNulls={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="benchmark"
                    name="System Avg (filtered)"
                    stroke="#475569"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                    activeDot={{ r: 3, fill: '#475569' }}
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Asset table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800">
              <h3 className="text-sm font-bold text-white">Matched Assets</h3>
              <p className="text-[10px] text-slate-500 mt-0.5">Projects included in the chart above · sorted by lowest CF first</p>
            </div>
            {filteredDevPoints.length === 0 ? (
              <div className="px-5 py-8 text-sm text-slate-600 text-center">
                No assets match the current filters.
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-800/60 text-slate-500 text-[10px] font-bold uppercase tracking-[0.12em]">
                    <th className="px-5 py-3">Asset</th>
                    <th className="px-5 py-3">ISO</th>
                    <th className="px-5 py-3">State</th>
                    <th className="px-5 py-3">Technology</th>
                    <th className="px-5 py-3 text-right">MW</th>
                    <th className="px-5 py-3 text-right">TTM CF</th>
                    <th className="px-5 py-3 text-center">Curtailed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {[...filteredDevPoints]
                    .sort((a, b) => {
                      if (a.ttmAverage == null && b.ttmAverage == null) return 0;
                      if (a.ttmAverage == null) return 1;
                      if (b.ttmAverage == null) return -1;
                      return a.ttmAverage - b.ttmAverage;
                    })
                    .map(point => {
                      const plant = point.eiaPlantCode ? plantsByEia.get(point.eiaPlantCode) : undefined;
                      const cfPct = point.ttmAverage != null ? point.ttmAverage * 100 : null;
                      const cfColor = cfPct == null
                        ? 'text-slate-600'
                        : cfPct < 15
                        ? 'text-red-400'
                        : cfPct < 25
                        ? 'text-amber-400'
                        : 'text-emerald-400';
                      return (
                        <tr
                          key={point.id}
                          onClick={() => point.eiaPlantCode && onPlantClick ? onPlantClick(point.eiaPlantCode) : onAssetClick(point.assetId)}
                          className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                        >
                          <td className="px-5 py-3">
                            <div className="text-sm font-medium text-slate-200 hover:text-blue-400 transition-colors">{point.name}</div>
                            {point.eiaPlantCode && <div className="text-[10px] text-slate-600 font-mono">EIA {point.eiaPlantCode}</div>}
                          </td>
                          <td className="px-5 py-3 text-xs text-slate-400">{plant?.region ?? '—'}</td>
                          <td className="px-5 py-3 text-xs text-slate-400">{point.state ?? '—'}</td>
                          <td className="px-5 py-3">
                            <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-blue-900/20 text-blue-400 border border-blue-500/20">
                              {point.technology ?? '—'}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-right font-mono text-sm text-slate-300">
                            {point.capacityMw > 0 ? point.capacityMw.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}
                          </td>
                          <td className={`px-5 py-3 text-right font-mono text-sm font-bold ${cfColor}`}>
                            {cfPct != null ? `${cfPct.toFixed(1)}%` : '—'}
                          </td>
                          <td className="px-5 py-3 text-center">
                            {point.isLikelyCurtailed
                              ? <span className="text-[10px] font-bold text-red-400 bg-red-900/20 border border-red-500/20 px-2 py-0.5 rounded">Yes</span>
                              : <span className="text-[10px] text-slate-700">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
