import React, { useState, useEffect, useMemo, useRef } from 'react';
import { TaxEquityStats } from '../types';
import { fetchAllTaxEquityStats } from '../services/taxEquityService';
import { fetchPursuitPlants, PursuitPlant } from '../services/pursuitService';
import { fetchArchivedPursuits, archivePursuit, unarchivePursuit } from '../services/archiveService';

interface Props {
  onInvestorClick: (name: string) => void;
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

interface Toast {
  message: string;
  onUndo: () => void;
}

export default function TaxEquityPursuitsDashboard({ onInvestorClick }: Props) {
  const [stats, setStats] = useState<TaxEquityStats[]>([]);
  const [pursuitPlants, setPursuitPlants] = useState<PursuitPlant[]>([]);
  const [loading, setLoading] = useState(true);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [fuelFilter, setFuelFilter] = useState('all');
  const [sort, setSort] = useState<'distress' | 'plants' | 'name'>('plants');

  useEffect(() => {
    Promise.all([fetchAllTaxEquityStats(), fetchPursuitPlants(), fetchArchivedPursuits()]).then(([s, p, archived]) => {
      setStats(s.filter(inv => inv.pctCurtailed > 0));
      setPursuitPlants(p);
      setArchivedIds(archived.taxEquity);
      setLoading(false);
    });
  }, []);

  const showToast = (msg: string, onUndo: () => void) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message: msg, onUndo });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  const handleArchive = async (e: React.MouseEvent, investorName: string) => {
    e.stopPropagation();
    setArchivedIds(prev => new Set([...prev, investorName]));
    await archivePursuit('tax_equity', investorName);
    showToast(`Archived "${investorName}"`, async () => {
      setArchivedIds(prev => { const s = new Set(prev); s.delete(investorName); return s; });
      await unarchivePursuit('tax_equity', investorName);
      setToast(null);
    });
  };

  const plantDataMap = useMemo(
    () => Object.fromEntries(pursuitPlants.map(p => [p.eiaPlantCode, { name: p.name, state: p.state, fuel: p.fuelSource }])),
    [pursuitPlants],
  );
  const plantNameMap = useMemo(
    () => Object.fromEntries(pursuitPlants.map(p => [p.eiaPlantCode, p.name])),
    [pursuitPlants],
  );

  const states = useMemo(() => {
    const s = new Set<string>();
    stats.forEach(inv => inv.plantCodes.forEach(c => { if (plantDataMap[c]?.state) s.add(plantDataMap[c].state); }));
    return ['all', ...Array.from(s).sort()];
  }, [stats, plantDataMap]);

  const fuels = useMemo(() => {
    const s = new Set<string>();
    stats.forEach(inv => inv.plantCodes.forEach(c => { if (plantDataMap[c]?.fuel) s.add(plantDataMap[c].fuel); }));
    return ['all', ...Array.from(s).sort()];
  }, [stats, plantDataMap]);

  const filtered = useMemo(() => {
    let rows = stats.filter(inv => !archivedIds.has(inv.investorName));
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(inv => inv.investorName.toLowerCase().includes(q));
    }
    if (stateFilter !== 'all') {
      rows = rows.filter(inv => inv.plantCodes.some(c => plantDataMap[c]?.state === stateFilter));
    }
    if (fuelFilter !== 'all') {
      rows = rows.filter(inv => inv.plantCodes.some(c => plantDataMap[c]?.fuel === fuelFilter));
    }
    return [...rows].sort((a, b) => {
      if (sort === 'distress') return (b.distressScore ?? 0) - (a.distressScore ?? 0);
      if (sort === 'plants') {
        const ac = a.plantCodes.filter(c => plantNameMap[c]).length;
        const bc = b.plantCodes.filter(c => plantNameMap[c]).length;
        return bc - ac;
      }
      return a.investorName.localeCompare(b.investorName);
    });
  }, [stats, archivedIds, search, stateFilter, fuelFilter, sort, plantDataMap, plantNameMap]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500">
        Loading tax equity data…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-900">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-2 h-8 rounded-full bg-violet-500" />
          <h1 className="text-4xl font-black text-white tracking-tight">Tax Equity Pursuits</h1>
        </div>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed">
          Tax equity investors with exposure to curtailed plants — ranked by plant count.
          {stats.length > 0 && ` ${stats.length} investors identified.`}
        </p>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mt-4">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search investors…"
            className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500 w-48"
          />
          <select
            value={stateFilter}
            onChange={e => setStateFilter(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-violet-500"
          >
            {states.map(s => <option key={s} value={s}>{s === 'all' ? 'All States' : s}</option>)}
          </select>
          <select
            value={fuelFilter}
            onChange={e => setFuelFilter(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-violet-500"
          >
            {fuels.map(f => <option key={f} value={f}>{f === 'all' ? 'All Fuels' : f}</option>)}
          </select>
          <div className="flex rounded-lg overflow-hidden border border-slate-700 text-xs font-semibold">
            {(['distress', 'plants', 'name'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`px-3 py-2 ${sort === s ? 'bg-violet-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
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
            No investors match your search.
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-slate-900/95 backdrop-blur z-10">
              <tr className="border-b border-slate-800">
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-10 text-center">#</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider">Investor</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider text-right w-36">Distress</th>
                <th className="px-3 py-3 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map((inv, idx) => {
                const distress = inv.distressScore ?? 0;
                const curtailedCodes = inv.plantCodes.filter(c => plantNameMap[c]);
                const isMulti = curtailedCodes.length >= 2;
                return (
                  <tr
                    key={inv.investorName}
                    onClick={() => onInvestorClick(inv.investorName)}
                    className="cursor-pointer hover:bg-slate-800/60 group/row transition-colors"
                  >
                    {/* Rank */}
                    <td className="px-4 py-4 text-center align-top">
                      <span className="text-xs font-mono text-slate-600">{idx + 1}</span>
                    </td>

                    {/* Name + plant chips */}
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-200 group-hover/row:text-violet-400 transition-colors">
                          {inv.investorName}
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

                    {/* Archive button */}
                    <td className="px-3 py-4 align-top text-center">
                      <button
                        onClick={e => handleArchive(e, inv.investorName)}
                        title="Archive this pursuit"
                        className="opacity-0 group-hover/row:opacity-100 transition-opacity p-1.5 rounded hover:bg-slate-700 text-slate-500 hover:text-amber-400"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-.375c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v.375c0 .621.504 1.125 1.125 1.125z" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Archive toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 shadow-2xl text-sm text-slate-200 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-.375c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v.375c0 .621.504 1.125 1.125 1.125z" />
          </svg>
          <span>{toast.message}</span>
          <button
            onClick={toast.onUndo}
            className="ml-1 text-xs font-bold text-amber-400 hover:text-amber-300 transition-colors underline underline-offset-2"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
