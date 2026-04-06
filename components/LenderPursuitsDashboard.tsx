import React, { useState, useEffect, useMemo } from 'react';
import { LenderStats } from '../types';
import { fetchAllLenderStats } from '../services/lenderStatsService';
import { fetchPursuitPlants, PursuitPlant } from '../services/pursuitService';

interface Props {
  onLenderClick: (name: string) => void;
}

const FACILITY_ABBR: Record<string, string> = {
  term_loan:        'TL',
  construction_loan:'CL',
  tax_equity:       'TE',
  revolving_credit: 'RC',
  bridge_loan:      'BL',
  letter_of_credit: 'LC',
  other:            'OT',
};

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
  const [sort, setSort] = useState<'distress' | 'plants' | 'name'>('plants');

  useEffect(() => {
    Promise.all([fetchAllLenderStats(), fetchPursuitPlants()]).then(([s, p]) => {
      setStats(s.filter(l => l.pctCurtailed > 0));
      setPursuitPlants(p);
      setLoading(false);
    });
  }, []);

  // eiaPlantCode → plant name lookup (curtailed plants only)
  const plantNameMap = useMemo(
    () => Object.fromEntries(pursuitPlants.map(p => [p.eiaPlantCode, p.name])),
    [pursuitPlants],
  );

  const filtered = useMemo(() => {
    let rows = stats;
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(l => l.lenderName.toLowerCase().includes(q));
    }
    return [...rows].sort((a, b) => {
      if (sort === 'distress') return (b.distressScore ?? 0) - (a.distressScore ?? 0);
      if (sort === 'plants') {
        const ac = a.plantCodes.filter(c => plantNameMap[c]).length;
        const bc = b.plantCodes.filter(c => plantNameMap[c]).length;
        return bc - ac;
      }
      return a.lenderName.localeCompare(b.lenderName);
    });
  }, [stats, search, sort]);

  const multiPlantCount = stats.filter(l => {
    const curtailed = l.plantCodes.filter(c => plantNameMap[c]);
    return curtailed.length >= 2;
  }).length;
  const totalCurtailedExposures = stats.reduce(
    (sum, l) => sum + l.plantCodes.filter(c => plantNameMap[c]).length, 0,
  );

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
        <h1 className="text-xl font-bold text-slate-100">Lender Pursuits</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Lenders with exposure to curtailed plants — ranked by plant count
        </p>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-3 mt-4">
          {[
            { label: 'Lenders Identified', value: stats.length, color: 'text-cyan-400' },
            { label: 'Multi-Plant Exposure', value: multiPlantCount, color: 'text-amber-400' },
            { label: 'Curtailed Plant Touches', value: totalCurtailedExposures, color: 'text-red-400' },
          ].map(c => (
            <div key={c.label} className="bg-slate-800/60 rounded-xl px-4 py-3">
              <div className={`text-2xl font-black ${c.color}`}>{c.value}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{c.label}</div>
            </div>
          ))}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 mt-4">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search lenders…"
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-600"
          />
          <div className="flex rounded-lg overflow-hidden border border-slate-700 text-xs font-semibold">
            {(['distress', 'plants', 'name'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`px-3 py-2 ${sort === s ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
              >
                {s === 'distress' ? 'Distress' : s === 'plants' ? 'Plants' : 'A–Z'}
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
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider text-right w-28">Plants</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider text-right w-36">Distress</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-32">Facility Types</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map((lender, idx) => {
                const distress = lender.distressScore ?? 0;
                const curtailedCodes = lender.plantCodes.filter(c => plantNameMap[c]);
                const isMulti = curtailedCodes.length >= 2;
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

                    {/* Plant count */}
                    <td className="px-4 py-4 text-right align-top">
                      <span className="text-sm font-bold text-slate-200">{curtailedCodes.length}</span>
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
