/**
 * GenTrack — PlantPursuitsDashboard
 *
 * Ranked list of curtailed plants with confirmed lenders.
 * Sorted by pursuit score.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { fetchPursuitPlants, PursuitPlant } from '../services/pursuitService';
import { COLORS } from '../constants';

interface Props {
  onPlantClick: (eiaPlantCode: string) => void;
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

function fuelColor(fuel: string): string {
  const lower = fuel.toLowerCase();
  if (lower.includes('wind'))    return COLORS['Wind']    ?? '#38bdf8';
  if (lower.includes('solar'))   return COLORS['Solar']   ?? '#facc15';
  if (lower.includes('nuclear')) return COLORS['Nuclear'] ?? '#4ade80';
  return '#94a3b8';
}

function scoreLabel(val: number | null): { text: string; color: string; bg: string } {
  if (val == null) return { text: '—', color: 'text-slate-600', bg: '' };
  if (val >= 60) return { text: 'HIGH', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/30' };
  if (val >= 30) return { text: 'MED', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30' };
  return { text: 'LOW', color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/30' };
}

function trendIndicator(cfTrend: number | null): React.ReactNode {
  if (cfTrend == null) return null;
  if (cfTrend > 0.05) return <span className="text-red-400 text-[10px] font-bold ml-1" title={`Degrading ${(cfTrend * 100).toFixed(0)}%`}>▼</span>;
  if (cfTrend < -0.05) return <span className="text-emerald-400 text-[10px] font-bold ml-1" title={`Improving ${(Math.abs(cfTrend) * 100).toFixed(0)}%`}>▲</span>;
  return null;
}

const PITCH_ANGLE_ABBR: Record<string, string> = {
  interconnection_advisory: 'IA',
  asset_management:         'AM',
  merchant_risk:            'MR',
  refinancing_advisory:     'RA',
  general_exposure:         'GE',
};
const PITCH_ANGLE_LABEL: Record<string, string> = {
  interconnection_advisory: 'Interconnection Advisory',
  asset_management:         'Asset Management',
  merchant_risk:            'Merchant Risk',
  refinancing_advisory:     'Refinancing Advisory',
  general_exposure:         'General Exposure',
};
const SYNDICATE_LABEL: Record<string, string> = {
  lead_arranger: 'Lead Arranger',
  agent_bank:    'Agent Bank',
  participant:   'Participant',
  unknown:       '',
};

type SortKey = 'pursuit' | 'distress' | 'opportunity' | 'mw' | 'lenders' | 'factor' | 'currency' | 'urgency';
type FuelFilter = 'all' | string;

const PAGE_SIZE = 50;

const PlantPursuitsDashboard: React.FC<Props> = ({ onPlantClick }) => {
  const [plants, setPlants] = useState<PursuitPlant[]>([]);
  const [loading, setLoading]   = useState(true);

  const [search, setSearch]           = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [fuelFilter, setFuelFilter]   = useState<FuelFilter>('all');
  const [sortKey, setSortKey]         = useState<SortKey>('pursuit');
  const [sortDesc, setSortDesc]       = useState(true);
  const [page, setPage]               = useState(1);

  useEffect(() => {
    fetchPursuitPlants().then(rows => {
      setPlants(rows);
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

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc(d => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
    setPage(1);
  };

  const filtered = useMemo(() => {
    let result = plants;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(p => p.name.toLowerCase().includes(q));
    }
    if (stateFilter !== 'all') result = result.filter(p => p.state === stateFilter);
    if (fuelFilter !== 'all')  result = result.filter(p => p.fuelSource === fuelFilter);

    const sorted = [...result];
    const dir = sortDesc ? -1 : 1;
    if (sortKey === 'pursuit')     sorted.sort((a, b) => dir * ((a.pursuitScore ?? 0) - (b.pursuitScore ?? 0)));
    if (sortKey === 'distress')    sorted.sort((a, b) => dir * ((a.distressScore ?? 0) - (b.distressScore ?? 0)));
    if (sortKey === 'opportunity') sorted.sort((a, b) => dir * ((a.opportunityScore ?? 0) - (b.opportunityScore ?? 0)));
    if (sortKey === 'mw')          sorted.sort((a, b) => dir * (a.nameplateMw - b.nameplateMw));
    if (sortKey === 'lenders')     sorted.sort((a, b) => dir * (a.lenders.length - b.lenders.length));
    if (sortKey === 'factor')      sorted.sort((a, b) => dir * ((a.ttmAvgFactor ?? 0) - (b.ttmAvgFactor ?? 0)));
    if (sortKey === 'currency')    sorted.sort((a, b) => dir * (a.activeLenderCount - b.activeLenderCount));
    if (sortKey === 'urgency')     sorted.sort((a, b) => dir * ((a.maxUrgencyScore ?? 0) - (b.maxUrgencyScore ?? 0)));

    return sorted;
  }, [plants, search, stateFilter, fuelFilter, sortKey, sortDesc]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
          Curtailed plants with confirmed lenders — ranked by pursuit score.
          {plants.length > 0 && ` ${plants.length.toLocaleString()} plants with identified financing parties.`}
        </p>
      </div>

      {/* Filters */}
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
      </div>

      {/* Plant table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                <th className="px-6 py-5">Plant Name</th>
                <th className="px-6 py-5">Fuel</th>
                <th className="px-6 py-5 text-right cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('mw')}>
                  Capacity (MW) {sortKey === 'mw' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-right cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('factor')}>
                  TTM Factor {sortKey === 'factor' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-center cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('distress')}>
                  Distress {sortKey === 'distress' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-center cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('opportunity')}>
                  Opportunity {sortKey === 'opportunity' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-center cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('pursuit')}>
                  Pursuit Score {sortKey === 'pursuit' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('lenders')}>
                  Financing Parties {sortKey === 'lenders' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-center cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('currency')}>
                  Active {sortKey === 'currency' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-center cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('urgency')} title="Highest pitch urgency score across lenders (0–100)">
                  Urgency {sortKey === 'urgency' && (sortDesc ? '↓' : '↑')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {paginated.map((plant) => {
                const color = fuelColor(plant.fuelSource);
                // De-emphasize rows where every scored lender is confirmed matured
                const scoredLenders = plant.lenders.filter(l => l.loanStatus && l.loanStatus !== 'unknown');
                const allMatured = scoredLenders.length > 0 && scoredLenders.every(l => l.loanStatus === 'matured');
                return (
                  <tr
                    key={plant.eiaPlantCode}
                    onClick={() => onPlantClick(plant.eiaPlantCode)}
                    className={`cursor-pointer transition-all hover:bg-slate-800/60 group ${allMatured ? 'opacity-40' : ''}`}
                  >
                    {/* Plant Name */}
                    <td className="px-6 py-5">
                      <div>
                        <div className="font-bold text-slate-200 group-hover:text-blue-400 transition-colors text-sm">
                          {plant.name}
                        </div>
                        <div className="text-[10px] text-slate-600 font-mono tracking-tighter">
                          EIA ID: {plant.eiaPlantCode} | {plant.state}
                        </div>
                      </div>
                    </td>

                    {/* Fuel */}
                    <td className="px-6 py-5">
                      <span
                        style={{ color, backgroundColor: `${color}10` }}
                        className="text-[10px] px-2 py-0.5 rounded font-bold border border-current"
                      >
                        {plant.fuelSource.toUpperCase()}
                      </span>
                    </td>

                    {/* Capacity (MW) */}
                    <td className="px-6 py-5 text-right font-mono text-sm text-slate-300">
                      {plant.nameplateMw > 0 ? plant.nameplateMw.toLocaleString() : '—'}
                    </td>

                    {/* TTM Factor */}
                    <td className="px-6 py-5 text-right">
                      <div className="font-mono text-sm font-bold text-slate-200">
                        {formatCf(plant.ttmAvgFactor)}{trendIndicator(plant.cfTrend)}
                      </div>
                      {plant.ttmAvgFactor != null && (
                        <div className="w-full h-1 bg-slate-800 rounded-full mt-2 overflow-hidden max-w-[80px] ml-auto">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{
                              width: `${Math.min(100, plant.ttmAvgFactor * 100)}%`,
                              backgroundColor: color,
                            }}
                          />
                        </div>
                      )}
                    </td>

                    {/* Distress */}
                    <td className="px-6 py-5 text-center">
                      {(() => {
                        const s = scoreLabel(plant.distressScore);
                        return plant.distressScore != null ? (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${s.bg} ${s.color}`}>
                            {plant.distressScore.toFixed(0)} {s.text}
                          </span>
                        ) : <span className="text-slate-600">—</span>;
                      })()}
                    </td>

                    {/* Opportunity */}
                    <td className="px-6 py-5 text-center">
                      {(() => {
                        const s = scoreLabel(plant.opportunityScore);
                        return plant.opportunityScore != null ? (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${s.bg} ${s.color}`}>
                            {plant.opportunityScore.toFixed(0)} {s.text}
                          </span>
                        ) : <span className="text-slate-600">—</span>;
                      })()}
                    </td>

                    {/* Pursuit Score */}
                    <td className="px-6 py-5 text-center">
                      {(() => {
                        const s = scoreLabel(plant.pursuitScore);
                        return plant.pursuitScore != null ? (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${s.bg} ${s.color}`}>
                            {plant.pursuitScore.toFixed(0)} {s.text}
                          </span>
                        ) : <span className="text-slate-600">—</span>;
                      })()}
                    </td>

                    {/* Financing Parties */}
                    <td className="px-6 py-5">
                      {plant.lenders.length > 0
                        ? (
                          <div className="flex flex-wrap gap-1 max-w-sm">
                            {plant.lenders.slice(0, 4).map((l, i) => {
                              const dotColor = l.loanStatus === 'active' ? 'bg-emerald-400' : l.loanStatus === 'matured' ? 'bg-slate-600' : 'bg-amber-500';
                              const dotTitle = l.loanStatus === 'active' ? 'Active loan' : l.loanStatus === 'matured' ? 'Loan matured' : l.loanStatus === 'refinanced' ? 'Refinanced' : 'Status unknown';
                              const isKeyRole = l.syndicateRole === 'lead_arranger' || l.syndicateRole === 'agent_bank';
                              const pitchAbbr = l.pitchAngle ? PITCH_ANGLE_ABBR[l.pitchAngle] : null;
                              const tipParts = [
                                `${l.role} — ${l.facilityType}`,
                                dotTitle,
                                l.syndicateRole && SYNDICATE_LABEL[l.syndicateRole] ? SYNDICATE_LABEL[l.syndicateRole] : null,
                                l.pitchAngle ? PITCH_ANGLE_LABEL[l.pitchAngle] : null,
                                l.pitchUrgencyScore != null ? `Urgency ${l.pitchUrgencyScore}` : null,
                                l.currencyConfidence != null ? `${l.currencyConfidence}% conf` : null,
                              ].filter(Boolean).join(' | ');
                              return (
                                <span
                                  key={i}
                                  className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border font-medium ${isKeyRole ? 'bg-cyan-900/30 border-cyan-700/50 text-cyan-300' : 'bg-slate-800 border-slate-700 text-slate-300'}`}
                                  title={tipParts}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
                                  <span className={`font-bold text-[8px] ${isKeyRole ? 'text-cyan-400' : 'text-emerald-500'}`}>{facilityTypeShort(l.facilityType)}</span>
                                  {l.name}
                                  {pitchAbbr && (
                                    <span className="text-[8px] text-amber-400 font-bold ml-0.5" title={PITCH_ANGLE_LABEL[l.pitchAngle!]}>{pitchAbbr}</span>
                                  )}
                                </span>
                              );
                            })}
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

                    {/* Active lender count */}
                    <td className="px-6 py-5 text-center">
                      {plant.activeLenderCount > 0
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 border border-emerald-700/50 text-emerald-400 font-mono font-bold">{plant.activeLenderCount}</span>
                        : allMatured
                          ? <span className="text-[10px] text-slate-600 font-mono">none</span>
                          : <span className="text-[10px] text-slate-600 font-mono">?</span>
                      }
                    </td>

                    {/* Urgency score */}
                    <td className="px-6 py-5 text-center">
                      {plant.maxUrgencyScore != null ? (() => {
                        const u = plant.maxUrgencyScore;
                        const cls = u >= 60 ? 'bg-red-900/40 border-red-700/50 text-red-400' : u >= 30 ? 'bg-amber-900/40 border-amber-700/50 text-amber-400' : 'bg-slate-800 border-slate-700 text-slate-400';
                        return <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono font-bold ${cls}`}>{u}</span>;
                      })() : <span className="text-slate-700 text-[10px]">—</span>}
                      {plant.topPitchAngle && (
                        <div className="text-[9px] text-amber-500 mt-0.5 font-mono">{PITCH_ANGLE_ABBR[plant.topPitchAngle] ?? ''}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 && (
          <div className="py-32 text-center text-slate-700 bg-slate-900/20">
            <p className="font-semibold text-lg">
              {plants.length === 0
                ? 'No pursuit data available.'
                : 'No plants match your filters.'}
            </p>
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
                onClick={() => setPage(1)}
                disabled={page === 1}
                className="px-2 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
              >
                ««
              </button>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-2 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
              >
                ‹ Prev
              </button>
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 7) {
                    pageNum = i + 1;
                  } else if (page <= 4) {
                    pageNum = i + 1;
                  } else if (page >= totalPages - 3) {
                    pageNum = totalPages - 6 + i;
                  } else {
                    pageNum = page - 3 + i;
                  }
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setPage(pageNum)}
                      className={`w-8 h-8 rounded text-xs font-bold transition-all ${page === pageNum ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-2 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
              >
                Next ›
              </button>
              <button
                onClick={() => setPage(totalPages)}
                disabled={page === totalPages}
                className="px-2 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
              >
                »»
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PlantPursuitsDashboard;
