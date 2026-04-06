import React, { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import {
  fetchDeveloperAssets, fetchChangelog,
  fetchDeveloperOpportunityScore,
  approveStagedAssets,
  DeveloperRow, AssetRegistryRow, ChangelogRow, DeveloperOpportunityScoreRow,
} from '../services/developerService';
import { PowerPlant, CapacityFactorStats } from '../types';
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

function scoreTone(score: number | null) {
  if (score == null) return 'text-slate-600';
  if (score >= 70) return 'text-red-400';
  if (score >= 50) return 'text-amber-400';
  return 'text-emerald-400';
}

function scoreBarColor(score: number) {
  if (score >= 70) return 'bg-red-500';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-emerald-500';
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
  const [opportunity, setOpportunity] = useState<DeveloperOpportunityScoreRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [selectedStaged, setSelectedStaged] = useState<Set<string>>(new Set());
  const [assetSearch, setAssetSearch] = useState('');
  const [mapSearch, setMapSearch] = useState('');
  const [mapSelectedState, setMapSelectedState] = useState('all');
  const [mapSelectedTech, setMapSelectedTech] = useState('all');
  const [mapPerformanceFilter, setMapPerformanceFilter] = useState<MapPerformanceFilter>('all');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchDeveloperAssets(developer.id),
      fetchChangelog(developer.id),
      fetchDeveloperOpportunityScore(developer.id),
    ]).then(([a, ch, opp]) => {
      setAssets(a);
      setChangelog(ch);
      setOpportunity(opp);
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
            {t === 'overview' ? 'Overview' : t === 'portfolio' ? 'Portfolio' : t === 'map' ? 'Asset Map' : 'Lead Drilldown'}
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

      {/* ── Lead Drilldown Tab ── */}
      {tab === 'lead' && (
        <div className="space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <h3 className="text-lg font-black text-white">FTI Lead Drilldown</h3>
                <p className="text-xs text-slate-500 mt-1">Opportunity components for outreach prioritization.</p>
              </div>
              <div className={`text-3xl font-black font-mono ${scoreTone(opportunity?.opportunity_score ?? null)}`}>
                {(opportunity?.opportunity_score ?? 0).toFixed(1)}
              </div>
            </div>

            {opportunity ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                  {[
                    ['Distress', opportunity.distress_score],
                    ['Complexity', opportunity.complexity_score],
                    ['Trigger Immediacy', opportunity.trigger_immediacy_score],
                    ['Engagement Potential', opportunity.engagement_potential_score],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">{label}</div>
                      <div className="h-2 bg-slate-800 rounded-full overflow-hidden mb-2">
                        <div className={scoreBarColor(Number(value))} style={{ width: `${Math.min(100, Math.max(0, Number(value)))}%`, height: '100%' }} />
                      </div>
                      <div className="text-sm font-mono text-slate-300">{Number(value).toFixed(1)}</div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Top Signals</div>
                    <div className="space-y-2 text-sm text-slate-300">
                      {(opportunity.top_signals || []).map((signal) => (
                        <div key={signal} className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">{signal}</div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Recommended Service Lines</div>
                    <div className="flex flex-wrap gap-2 mb-4">
                      {(opportunity.recommended_service_lines || []).map((line) => (
                        <span key={line} className="px-2 py-1 rounded-full text-[10px] font-bold bg-blue-900/30 border border-blue-500/30 text-blue-300 uppercase tracking-wide">
                          {line.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                    <div className="text-xs text-slate-500 space-y-1">
                      <div>Total MW at risk: <span className="text-slate-300 font-mono">{opportunity.total_mw_at_risk.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span></div>
                      <div>High-risk assets: <span className="text-slate-300 font-mono">{opportunity.high_risk_asset_count}</span></div>
                      <div>Likely curtailed: <span className="text-slate-300 font-mono">{opportunity.likely_curtailed_count}</span></div>
                      <div>Weekly delta: <span className={opportunity.weekly_delta_score != null && opportunity.weekly_delta_score > 0 ? 'text-red-400 font-mono' : opportunity.weekly_delta_score != null && opportunity.weekly_delta_score < 0 ? 'text-emerald-400 font-mono' : 'text-slate-400 font-mono'}>{opportunity.weekly_delta_score == null ? '—' : `${opportunity.weekly_delta_score > 0 ? '+' : ''}${opportunity.weekly_delta_score.toFixed(1)}`}</span></div>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-500">
                No lead score snapshot found yet. Run score:developers to populate this tab.
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
