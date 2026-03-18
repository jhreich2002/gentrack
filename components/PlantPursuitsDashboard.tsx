/**
 * GenTrack — PlantPursuitsDashboard
 *
 * Ranked list of curtailed plants with confirmed lenders (lenders_found=true).
 * Sorted by distress_score. Click-through opens plant detail.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { fetchPursuitPlants, PursuitPlant, fetchLenderRankings, LenderRanking } from '../services/pursuitService';

interface Props {
  onPlantClick: (eiaPlantCode: string) => void;
}

function scoreColor(score: number): string {
  if (score >= 70) return 'text-red-400';
  if (score >= 40) return 'text-amber-400';
  return 'text-green-400';
}

function scoreBarColor(score: number): string {
  if (score >= 70) return 'bg-red-500';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-green-500';
}

function formatCf(f: number | null): string {
  if (f == null) return '—';
  return (f * 100).toFixed(1) + '%';
}

function facilityTypeShort(ft: string): string {
  const MAP: Record<string, string> = {
    tax_equity:        'TE',
    construction_loan: 'CL',
    term_loan:         'TL',
    revolving_credit:  'RC',
    other:             '?',
  };
  return MAP[ft?.toLowerCase().replace(/ /g, '_')] ?? ft?.slice(0, 2).toUpperCase() ?? '?';
}

const FUEL_COLORS: Record<string, string> = {
  Solar:   'bg-yellow-900/30 text-yellow-400 border-yellow-500/30',
  Wind:    'bg-sky-900/30 text-sky-400 border-sky-500/30',
  Nuclear: 'bg-violet-900/30 text-violet-400 border-violet-500/30',
  Gas:     'bg-orange-900/30 text-orange-400 border-orange-500/30',
  Coal:    'bg-stone-900/30 text-stone-400 border-stone-500/30',
  Hydro:   'bg-blue-900/30 text-blue-400 border-blue-500/30',
};

function fuelChipClass(fuel: string): string {
  for (const [key, cls] of Object.entries(FUEL_COLORS)) {
    if (fuel.toLowerCase().includes(key.toLowerCase())) return cls;
  }
  return 'bg-slate-800 text-slate-400 border-slate-600';
}

type SortKey = 'distress' | 'mw' | 'lenders';
type FuelFilter = 'all' | string;
type ViewMode = 'lenders' | 'plants';

const PAGE_SIZE = 50;

const PlantPursuitsDashboard: React.FC<Props> = ({ onPlantClick }) => {
  const [plants, setPlants]           = useState<PursuitPlant[]>([]);
  const [lenderRankings, setLenderRankings] = useState<LenderRanking[]>([]);
  const [loading, setLoading]         = useState(true);
  const [viewMode, setViewMode]       = useState<ViewMode>('lenders');

  const [search, setSearch]       = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [fuelFilter, setFuelFilter]   = useState<FuelFilter>('all');
  const [sortKey, setSortKey]     = useState<SortKey>('distress');
  const [page, setPage]           = useState(1);

  useEffect(() => {
    Promise.all([fetchPursuitPlants(), fetchLenderRankings()]).then(([plantRows, lenderRows]) => {
      setPlants(plantRows);
      setLenderRankings(lenderRows);
      setLoading(false);
    });
  }, []);

  const states = useMemo(() => {
    const s = new Set(plants.map(p => p.state).filter(Boolean));
    return ['all', ...Array.from(s).sort()];
  }, [plants]);

  const fuels = useMemo(() => {
    const s = new Set(plants.map(p => p.fuelSource).filter(Boolean));
    return ['all', ...Array.from(s).sort()];
  }, [plants]);

  const filtered = useMemo(() => {
    let result = plants;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(p => p.name.toLowerCase().includes(q));
    }
    if (stateFilter !== 'all') result = result.filter(p => p.state === stateFilter);
    if (fuelFilter !== 'all')  result = result.filter(p => p.fuelSource === fuelFilter);

    const sorted = [...result];
    if (sortKey === 'distress') sorted.sort((a, b) => (b.distressScore ?? 0) - (a.distressScore ?? 0));
    if (sortKey === 'mw')       sorted.sort((a, b) => b.nameplateMw - a.nameplateMw);
    if (sortKey === 'lenders')     sorted.sort((a, b) => b.lenders.length - a.lenders.length);

    return sorted;
  }, [plants, search, stateFilter, fuelFilter, sortKey]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Lender view search filter
  const filteredLenders = useMemo(() => {
    if (!search.trim()) return lenderRankings;
    const q = search.toLowerCase();
    return lenderRankings.filter(l => l.name.toLowerCase().includes(q));
  }, [lenderRankings, search]);

  // Summary stats
  const highDistress = plants.filter(p => (p.distressScore ?? 0) >= 70).length;
  const midDistress  = plants.filter(p => (p.distressScore ?? 0) >= 40 && (p.distressScore ?? 0) < 70).length;
  const totalLenders = plants.reduce((sum, p) => sum + p.lenders.length, 0);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-emerald-500 mx-auto mb-3" />
          <p className="text-slate-400 text-sm font-medium">Loading plant pursuits…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in slide-in-from-top-4 duration-500">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-2 h-8 rounded-full bg-emerald-500" />
          <h1 className="text-4xl font-black text-white tracking-tight">Plant Pursuits</h1>
        </div>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed">
          Curtailed plants with confirmed lenders — ranked by distress for active pursuit.
          {plants.length > 0 && ` ${plants.length.toLocaleString()} plants with identified financing parties.`}
        </p>
        {/* View toggle */}
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => { setViewMode('lenders'); setPage(1); setSearch(''); }}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${viewMode === 'lenders' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'}`}
          >
            By Lender
          </button>
          <button
            onClick={() => { setViewMode('plants'); setPage(1); setSearch(''); }}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${viewMode === 'plants' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'}`}
          >
            By Plant
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <div className="text-[10px] font-black uppercase tracking-widest mb-1 text-emerald-400">Confirmed Lenders</div>
          <div className="text-2xl font-black text-white">{plants.length.toLocaleString()}</div>
          <div className="text-xs text-slate-500 mt-0.5">plants</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <div className="text-[10px] font-black uppercase tracking-widest mb-1 text-red-400">High Distress ≥70</div>
          <div className="text-2xl font-black text-red-400">{highDistress.toLocaleString()}</div>
          <div className="text-xs text-slate-500 mt-0.5">actively pursue</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <div className="text-[10px] font-black uppercase tracking-widest mb-1 text-amber-400">Watch 40–69</div>
          <div className="text-2xl font-black text-amber-400">{midDistress.toLocaleString()}</div>
          <div className="text-xs text-slate-500 mt-0.5">monitor closely</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg">
          <div className="text-[10px] font-black uppercase tracking-widest mb-1 text-cyan-400">Financing Parties</div>
          <div className="text-2xl font-black text-white">{totalLenders.toLocaleString()}</div>
          <div className="text-xs text-slate-500 mt-0.5">named lenders / TE</div>
        </div>
      </div>

      {viewMode === 'lenders' ? (
        <>
          {/* Lender search */}
          <div className="flex flex-wrap gap-3 mb-6">
            <input
              type="text"
              placeholder="Search lender name…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 w-56"
            />
            {search && (
              <span className="self-center text-xs text-slate-500">
                {filteredLenders.length.toLocaleString()} lenders
              </span>
            )}
          </div>

          {/* Lender rankings table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                    <th className="px-4 py-4 w-10 text-center">#</th>
                    <th className="px-4 py-4">Lender</th>
                    <th className="px-4 py-4 text-right">Curtailed Plants</th>
                    <th className="px-4 py-4 text-right">Total MW at Risk</th>
                    <th className="px-4 py-4 text-right">Avg Distress</th>
                    <th className="px-4 py-4">Plant Exposures</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {filteredLenders.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((lender, idx) => {
                    const rank = (page - 1) * PAGE_SIZE + idx + 1;
                    const avg = lender.avgDistressScore ?? 0;
                    return (
                      <tr key={lender.name} className="transition-all hover:bg-slate-800/60 group">
                        <td className="px-4 py-4 text-center">
                          <span className="text-xs font-mono text-slate-600">{rank}</span>
                        </td>

                        <td className="px-4 py-4">
                          <div className="text-sm font-bold text-slate-200 group-hover:text-emerald-400 transition-colors">
                            {lender.name}
                          </div>
                        </td>

                        <td className="px-4 py-4 text-right">
                          <span className="text-lg font-black text-white">{lender.curtailedPlantCount}</span>
                        </td>

                        <td className="px-4 py-4 text-right font-mono text-xs text-slate-400">
                          {lender.totalCurtailedMw > 0 ? lender.totalCurtailedMw.toLocaleString() + ' MW' : '—'}
                        </td>

                        <td className="px-4 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-14 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${scoreBarColor(avg)}`}
                                style={{ width: `${avg}%` }}
                              />
                            </div>
                            <span className={`text-sm font-black w-7 text-right ${scoreColor(avg)}`}>
                              {Math.round(avg)}
                            </span>
                          </div>
                        </td>

                        <td className="px-4 py-4">
                          <div className="flex flex-wrap gap-1 max-w-sm">
                            {lender.plants.slice(0, 4).map(p => (
                              <span
                                key={p.eiaPlantCode}
                                onClick={(e) => { e.stopPropagation(); onPlantClick(p.eiaPlantCode); }}
                                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-medium cursor-pointer hover:border-emerald-500/50 hover:text-emerald-400 transition-colors"
                                title={`${p.fuelSource} · ${p.nameplateMw} MW`}
                              >
                                <span className={`text-[8px] font-bold ${scoreColor(p.distressScore ?? 0)}`}>
                                  {Math.round(p.distressScore ?? 0)}
                                </span>
                                {p.name}
                              </span>
                            ))}
                            {lender.plants.length > 4 && (
                              <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-500">
                                +{lender.plants.length - 4} more
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {filteredLenders.length === 0 && (
              <div className="py-24 text-center text-slate-600">
                <p className="font-semibold">No lenders found.</p>
                <p className="text-sm mt-1">
                  {lenderRankings.length === 0
                    ? 'Run the lender-search sweep to populate financing data.'
                    : 'Adjust the search criteria.'}
                </p>
              </div>
            )}

            {filteredLenders.length > PAGE_SIZE && (
              <div className="flex items-center justify-between px-6 py-4 bg-slate-800/40 border-t border-slate-800">
                <div className="text-xs text-slate-500">
                  Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, filteredLenders.length)} of {filteredLenders.length.toLocaleString()} lenders
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                    className="px-3 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all">
                    ‹ Prev
                  </button>
                  <span className="text-xs text-slate-500 font-mono">{page} / {Math.max(1, Math.ceil(filteredLenders.length / PAGE_SIZE))}</span>
                  <button onClick={() => setPage(p => Math.min(Math.ceil(filteredLenders.length / PAGE_SIZE), p + 1))} disabled={page === Math.ceil(filteredLenders.length / PAGE_SIZE)}
                    className="px-3 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all">
                    Next ›
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Plant filters */}
          <div className="flex flex-wrap gap-3 mb-6">
            <input
              type="text"
              placeholder="Search plant name…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 w-48"
            />

            <select
              value={stateFilter}
              onChange={e => { setStateFilter(e.target.value); setPage(1); }}
              className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {states.map(s => <option key={s} value={s}>{s === 'all' ? 'All States' : s}</option>)}
            </select>

            <select
              value={fuelFilter}
              onChange={e => { setFuelFilter(e.target.value); setPage(1); }}
              className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              {fuels.map(f => <option key={f} value={f}>{f === 'all' ? 'All Fuels' : f}</option>)}
            </select>

            <select
              value={sortKey}
              onChange={e => { setSortKey(e.target.value as SortKey); setPage(1); }}
              className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
            >
              <option value="distress">Sort: Pursuit Score</option>
              <option value="mw">Sort: Capacity (MW)</option>
              <option value="lenders">Sort: # Lenders</option>
            </select>
          </div>

          {/* Plant table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                    <th className="px-4 py-4 w-10 text-center">#</th>
                    <th className="px-4 py-4">Plant</th>
                    <th className="px-4 py-4 text-right">Pursuit Score</th>
                    <th className="px-4 py-4 text-right">TTM CF</th>
                    <th className="px-4 py-4 text-right">MW</th>
                    <th className="px-4 py-4">Financing Parties</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {paginated.map((plant, idx) => {
                    const rank = (page - 1) * PAGE_SIZE + idx + 1;
                    const distress = plant.distressScore ?? 0;
                    return (
                      <tr
                        key={plant.eiaPlantCode}
                        onClick={() => onPlantClick(plant.eiaPlantCode)}
                        className="cursor-pointer transition-all hover:bg-slate-800/60 group"
                      >
                        <td className="px-4 py-4 text-center">
                          <span className="text-xs font-mono text-slate-600">{rank}</span>
                        </td>

                        <td className="px-4 py-4">
                          <div className="flex items-start gap-2">
                            <div>
                              <div className="text-sm font-bold text-slate-200 group-hover:text-emerald-400 transition-colors leading-snug">
                                {plant.name}
                              </div>
                              <div className="flex items-center gap-1.5 mt-1">
                                <span className="text-[10px] text-slate-500 font-mono">{plant.state}</span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-bold ${fuelChipClass(plant.fuelSource)}`}>
                                  {plant.fuelSource}
                                </span>
                              </div>
                            </div>
                          </div>
                        </td>

                        <td className="px-4 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${scoreBarColor(distress)}`}
                                style={{ width: `${distress}%` }}
                              />
                            </div>
                            <span className={`text-sm font-black w-7 text-right ${scoreColor(distress)}`}>
                              {Math.round(distress)}
                            </span>
                          </div>
                        </td>

                        <td className="px-4 py-4 text-right font-mono text-xs text-slate-400">
                          {formatCf(plant.ttmAvgFactor)}
                        </td>

                        <td className="px-4 py-4 text-right font-mono text-xs text-slate-400">
                          {plant.nameplateMw > 0 ? `${plant.nameplateMw.toLocaleString()}` : '—'}
                        </td>

                        <td className="px-4 py-4">
                          {plant.lenders.length > 0
                            ? (
                              <div className="flex flex-wrap gap-1 max-w-sm">
                                {plant.lenders.slice(0, 4).map((l, i) => (
                                  <span
                                    key={i}
                                    className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-medium"
                                    title={`${l.role} — ${l.facilityType}`}
                                  >
                                    <span className="text-emerald-500 font-bold text-[8px]">{facilityTypeShort(l.facilityType)}</span>
                                    {l.name}
                                  </span>
                                ))}
                                {plant.lenders.length > 4 && (
                                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-500">
                                    +{plant.lenders.length - 4} more
                                  </span>
                                )}
                              </div>
                            )
                            : <span className="text-slate-600 text-xs">Lender names not parsed</span>
                          }
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {filtered.length === 0 && (
              <div className="py-24 text-center text-slate-600">
                <p className="font-semibold">No plants match your filters.</p>
                <p className="text-sm mt-1">
                  {plants.length === 0
                    ? 'Run the lender-search sweep to populate confirmed financing data.'
                    : 'Adjust the search or filter criteria.'}
                </p>
              </div>
            )}

            {filtered.length > PAGE_SIZE && (
              <div className="flex items-center justify-between px-6 py-4 bg-slate-800/40 border-t border-slate-800">
                <div className="text-xs text-slate-500">
                  Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length.toLocaleString()} plants
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="px-3 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
                  >
                    ‹ Prev
                  </button>
                  <span className="text-xs text-slate-500 font-mono">{page} / {totalPages}</span>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="px-3 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
                  >
                    Next ›
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default PlantPursuitsDashboard;
