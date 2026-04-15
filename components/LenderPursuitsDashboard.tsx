import React, { useState, useEffect, useMemo } from 'react';
import { LenderStats, LoanStatus } from '../types';
import { fetchAllLenderStats } from '../services/lenderStatsService';
import { fetchPursuitPlants, PursuitPlant } from '../services/pursuitService';

interface Props {
  onLenderClick: (name: string) => void;
}

const PITCH_ANGLE_LABEL: Record<string, string> = {
  interconnection_advisory: 'Interconnection Advisory',
  asset_management:         'Asset Management',
  merchant_risk:            'Merchant Risk',
  refinancing_advisory:     'Refinancing Advisory',
  general_exposure:         'General Exposure',
};
const PITCH_ANGLE_COLOR: Record<string, string> = {
  interconnection_advisory: 'bg-blue-900/30 border-blue-700/50 text-blue-400',
  asset_management:         'bg-purple-900/30 border-purple-700/50 text-purple-400',
  merchant_risk:            'bg-red-900/30 border-red-700/50 text-red-400',
  refinancing_advisory:     'bg-amber-900/30 border-amber-700/50 text-amber-400',
  general_exposure:         'bg-slate-800 border-slate-700 text-slate-400',
};

const FACILITY_ABBR: Record<string, string> = {
  term_loan:        'TL',
  construction_loan:'CL',
  tax_equity:       'TE',
  revolving_credit: 'RC',
  bridge_loan:      'BL',
  letter_of_credit: 'LC',
  other:            'OT',
};

function loanStatusBadge(status: LoanStatus | null | undefined): React.ReactNode {
  if (!status || status === 'unknown') return (
    <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-500 font-mono" title="Loan status unknown">?</span>
  );
  if (status === 'active') return (
    <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-900/40 border border-emerald-700/50 text-emerald-400 font-mono font-bold" title="Active loan">LIVE</span>
  );
  if (status === 'matured') return (
    <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/60 border border-slate-700 text-slate-500 font-mono line-through" title="Loan matured">MATURED</span>
  );
  if (status === 'refinanced') return (
    <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-900/40 border border-amber-700/50 text-amber-400 font-mono" title="Refinanced">REFI</span>
  );
  return null;
}

function scoreColor(s: number) {
  if (s >= 70) return 'text-red-400';
  if (s >= 40) return 'text-amber-400';
  return 'text-slate-400';
}
function scoreBarColor(s: number) {
  if (s >= 70) return 'bg-red-500';
  if (s >= 40) return 'bg-amber-500';
  return 'bg-slate-500';
}

export default function LenderPursuitsDashboard({ onLenderClick }: Props) {
  const [stats, setStats] = useState<LenderStats[]>([]);
  const [pursuitPlants, setPursuitPlants] = useState<PursuitPlant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [fuelFilter, setFuelFilter] = useState('all');
  const [sort, setSort] = useState<'exposure' | 'distress' | 'plants' | 'name' | 'currency'>('exposure');
  const [loanStatusFilter, setLoanStatusFilter] = useState<'active' | 'all' | 'unknown'>('active');

  useEffect(() => {
    Promise.all([fetchAllLenderStats(), fetchPursuitPlants()]).then(([s, p]) => {
      setStats(s.filter(l => l.pctCurtailed > 0));
      setPursuitPlants(p);
      setLoading(false);
    });
  }, []);

  // eiaPlantCode → { name, state, fuelSource } lookup (curtailed plants only)
  const plantDataMap = useMemo(
    () => Object.fromEntries(pursuitPlants.map(p => [p.eiaPlantCode, { name: p.name, state: p.state, fuel: p.fuelSource }])),
    [pursuitPlants],
  );
  // simple name map kept for chip display
  const plantNameMap = useMemo(
    () => Object.fromEntries(pursuitPlants.map(p => [p.eiaPlantCode, p.name])),
    [pursuitPlants],
  );

  // lenderName → { totalCurtailedMw, curtailedCount } — for ratio column + exposure sort
  const lenderExposureMap = useMemo(() => {
    const map = new Map<string, { totalCurtailedMw: number; curtailedCount: number }>();
    for (const plant of pursuitPlants) {
      for (const l of plant.lenders) {
        const prev = map.get(l.name) ?? { totalCurtailedMw: 0, curtailedCount: 0 };
        map.set(l.name, {
          totalCurtailedMw: prev.totalCurtailedMw + plant.nameplateMw,
          curtailedCount:   prev.curtailedCount + 1,
        });
      }
    }
    return map;
  }, [pursuitPlants]);

  // lenderName → { activeLoanCount, hasActiveExposure } derived from pursuitPlants
  const lenderCurrencyMap = useMemo(() => {
    const map = new Map<string, { activeLoanCount: number; hasActiveExposure: boolean }>();
    for (const plant of pursuitPlants) {
      for (const l of plant.lenders) {
        const prev = map.get(l.name) ?? { activeLoanCount: 0, hasActiveExposure: false };
        const isActive = l.loanStatus === 'active';
        map.set(l.name, {
          activeLoanCount: prev.activeLoanCount + (isActive ? 1 : 0),
          hasActiveExposure: prev.hasActiveExposure || isActive,
        });
      }
    }
    return map;
  }, [pursuitPlants]);

  const states = useMemo(() => {
    const s = new Set<string>();
    stats.forEach(l => l.plantCodes.forEach(c => { if (plantDataMap[c]?.state) s.add(plantDataMap[c].state); }));
    return ['all', ...Array.from(s).sort()];
  }, [stats, plantDataMap]);

  const fuels = useMemo(() => {
    const s = new Set<string>();
    stats.forEach(l => l.plantCodes.forEach(c => { if (plantDataMap[c]?.fuel) s.add(plantDataMap[c].fuel); }));
    return ['all', ...Array.from(s).sort()];
  }, [stats, plantDataMap]);

  const filtered = useMemo(() => {
    let rows = stats;
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(l => l.lenderName.toLowerCase().includes(q));
    }
    if (stateFilter !== 'all') {
      rows = rows.filter(l => l.plantCodes.some(c => plantDataMap[c]?.state === stateFilter));
    }
    if (fuelFilter !== 'all') {
      rows = rows.filter(l => l.plantCodes.some(c => plantDataMap[c]?.fuel === fuelFilter));
    }
    // Currency filter: 'active' shows lenders with at least one active loan
    if (loanStatusFilter === 'active') {
      rows = rows.filter(l => lenderCurrencyMap.get(l.lenderName)?.hasActiveExposure !== false);
    } else if (loanStatusFilter === 'unknown') {
      rows = rows.filter(l => !lenderCurrencyMap.get(l.lenderName)?.hasActiveExposure);
    }
    return [...rows].sort((a, b) => {
      if (sort === 'exposure') {
        // Primary: active-loan lenders first
        const aActive = lenderCurrencyMap.get(a.lenderName)?.hasActiveExposure ? 1 : 0;
        const bActive = lenderCurrencyMap.get(b.lenderName)?.hasActiveExposure ? 1 : 0;
        if (bActive !== aActive) return bActive - aActive;
        // Secondary: curtailed exposure — $ amount (pro-rated) preferred, MW fallback
        const aExp = lenderExposureMap.get(a.lenderName);
        const bExp = lenderExposureMap.get(b.lenderName);
        const aVal = a.totalExposureUsd != null && a.assetCount > 0
          ? a.totalExposureUsd * ((aExp?.curtailedCount ?? 0) / a.assetCount)
          : (aExp?.totalCurtailedMw ?? 0);
        const bVal = b.totalExposureUsd != null && b.assetCount > 0
          ? b.totalExposureUsd * ((bExp?.curtailedCount ?? 0) / b.assetCount)
          : (bExp?.totalCurtailedMw ?? 0);
        return bVal - aVal;
      }
      if (sort === 'distress') return (b.distressScore ?? 0) - (a.distressScore ?? 0);
      if (sort === 'currency') {
        const ac = lenderCurrencyMap.get(a.lenderName)?.activeLoanCount ?? 0;
        const bc = lenderCurrencyMap.get(b.lenderName)?.activeLoanCount ?? 0;
        return bc - ac;
      }
      if (sort === 'plants') {
        const ac = a.plantCodes.filter(c => plantNameMap[c]).length;
        const bc = b.plantCodes.filter(c => plantNameMap[c]).length;
        return bc - ac;
      }
      return a.lenderName.localeCompare(b.lenderName);
    });
  }, [stats, search, stateFilter, fuelFilter, sort, loanStatusFilter, plantDataMap, plantNameMap, lenderCurrencyMap, lenderExposureMap]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500">
        Loading lender data…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-900">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-2 h-8 rounded-full bg-cyan-500" />
          <h1 className="text-4xl font-black text-white tracking-tight">Lender Pursuits</h1>
        </div>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed">
          Lenders with exposure to curtailed plants — ranked by active loan exposure.
          {stats.length > 0 && ` ${stats.length} lenders identified.`}
        </p>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mt-4">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search lenders…"
            className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500 w-48"
          />
          <select
            value={stateFilter}
            onChange={e => setStateFilter(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            {states.map(s => <option key={s} value={s}>{s === 'all' ? 'All States' : s}</option>)}
          </select>
          <select
            value={fuelFilter}
            onChange={e => setFuelFilter(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            {fuels.map(f => <option key={f} value={f}>{f === 'all' ? 'All Fuels' : f}</option>)}
          </select>
          <select
            value={loanStatusFilter}
            onChange={e => setLoanStatusFilter(e.target.value as typeof loanStatusFilter)}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            <option value="active">Active Loans Only</option>
            <option value="all">All (incl. Matured)</option>
            <option value="unknown">Unknown Status</option>
          </select>
          <div className="flex rounded-lg overflow-hidden border border-slate-700 text-xs font-semibold">
            {(['exposure', 'distress', 'plants', 'currency', 'name'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`px-3 py-2 ${sort === s ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
              >
                {s === 'exposure' ? 'Exposure' : s === 'distress' ? 'Distress' : s === 'plants' ? 'Plants' : s === 'currency' ? 'Active' : 'A–Z'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-slate-600 text-sm">
            No lenders match your search.
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-slate-900/95 backdrop-blur z-10">
              <tr className="border-b border-slate-800">
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-10 text-center">#</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider">Lender</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider text-right w-36">Distress</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-20 text-center">Currency</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-32 text-right">Curt. Exposure</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-32">Facility Types</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-40" title="Primary pitch angle across portfolio">Pitch Angle</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-16 text-center" title="Plants with urgency ≥ 60">Urgent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map((lender, idx) => {
                const distress = lender.distressScore ?? 0;
                const curtailedCodes = lender.plantCodes.filter(c => plantNameMap[c]);
                const isMulti = curtailedCodes.length >= 2;
                const currency = lenderCurrencyMap.get(lender.lenderName);
                const overallStatus: LoanStatus | null = currency?.hasActiveExposure
                  ? 'active'
                  : currency?.activeLoanCount === 0 && curtailedCodes.length > 0
                    ? 'unknown'
                    : null;
                return (
                  <tr
                    key={lender.lenderName}
                    onClick={() => onLenderClick(lender.lenderName)}
                    className="cursor-pointer hover:bg-slate-800/60 group transition-colors"
                  >
                        {/* Rank */}
                        <td className="px-4 py-4 text-center align-top">
                          <span className="text-xs font-mono text-slate-600">{idx + 1}</span>
                        </td>

                        {/* Name + plant chips */}
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-slate-200 group-hover:text-cyan-400 transition-colors">
                              {lender.lenderName}
                            </span>
                            {isMulti && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-800/50 font-bold">
                                {curtailedCodes.length} plants
                              </span>
                            )}
                          </div>
                          {curtailedCodes.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {curtailedCodes.map(code => (
                                <span
                                  key={code}
                                  className="text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400"
                                >
                                  {plantNameMap[code]}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>

                        {/* Distress */}
                        <td className="px-4 py-4 text-right align-top">
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

                        {/* Currency status badge */}
                        <td className="px-4 py-4 align-top text-center">
                          {loanStatusBadge(overallStatus)}
                          {currency?.activeLoanCount != null && currency.activeLoanCount > 0 && (
                            <div className="text-[9px] text-slate-500 mt-1 font-mono">{currency.activeLoanCount} active</div>
                          )}
                        </td>

                        {/* Curtailment exposure ratio */}
                        {(() => {
                          const exposure   = lenderExposureMap.get(lender.lenderName);
                          const curtailed  = curtailedCodes.length;
                          const total      = lender.assetCount || 1;
                          const ratio      = curtailed / total;
                          const proRatedUsd = lender.totalExposureUsd != null
                            ? lender.totalExposureUsd * (curtailed / total)
                            : null;
                          const mw         = exposure?.totalCurtailedMw ?? 0;
                          const fmtUsd = (v: number) =>
                            v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B`
                            : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M`
                            : `$${Math.round(v).toLocaleString()}`;
                          return (
                            <td className="px-4 py-4 align-top text-right">
                              <div className="text-xs font-bold text-slate-200">
                                {curtailed}
                                <span className="text-slate-500 font-normal"> / {lender.assetCount}</span>
                              </div>
                              <div className="w-16 h-1 bg-slate-800 rounded-full overflow-hidden mt-1 ml-auto">
                                <div
                                  className={`h-full rounded-full ${ratio >= 0.7 ? 'bg-red-500' : ratio >= 0.4 ? 'bg-amber-500' : 'bg-cyan-600'}`}
                                  style={{ width: `${Math.round(ratio * 100)}%` }}
                                />
                              </div>
                              <div className="text-[10px] text-slate-500 mt-0.5">
                                {proRatedUsd != null ? fmtUsd(proRatedUsd) : mw > 0 ? `${Math.round(mw)} MW` : '—'}
                              </div>
                            </td>
                          );
                        })()}

                        {/* Facility types */}
                        <td className="px-4 py-4 align-top">
                          <div className="flex flex-wrap gap-1">
                            {lender.facilityTypes.map(ft => (
                              <span
                                key={ft}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 font-mono font-bold"
                              >
                                {FACILITY_ABBR[ft] ?? ft.slice(0, 2).toUpperCase()}
                              </span>
                            ))}
                          </div>
                        </td>

                        {/* Top pitch angle */}
                        <td className="px-4 py-4 align-top">
                          {lender.topPitchAngle ? (
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${PITCH_ANGLE_COLOR[lender.topPitchAngle] ?? 'bg-slate-800 border-slate-700 text-slate-400'}`}
                              title={PITCH_ANGLE_LABEL[lender.topPitchAngle]}
                            >
                              {PITCH_ANGLE_LABEL[lender.topPitchAngle] ?? lender.topPitchAngle}
                            </span>
                          ) : (
                            <span className="text-slate-700 text-[10px]">—</span>
                          )}
                          {lender.highUrgencyCount != null && lender.highUrgencyCount > 0 && (
                            <div className="text-[9px] text-red-400 font-mono mt-0.5">{lender.highUrgencyCount} high urgency</div>
                          )}
                        </td>

                        {/* Urgency count */}
                        <td className="px-4 py-4 align-top text-center">
                          {lender.highUrgencyCount != null && lender.highUrgencyCount > 0 ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/40 border border-red-700/50 text-red-400 font-mono font-bold">
                              {lender.highUrgencyCount}
                            </span>
                          ) : (
                            <span className="text-slate-700 text-[10px]">—</span>
                          )}
                        </td>

                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
