/**
 * GenTrack — ArchivedPursuitsDashboard
 *
 * Shows all archived pursuits (plants, lenders, tax equity investors) with
 * the ability to unarchive them back to their respective active dashboards.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  fetchArchivedPursuitsList,
  unarchivePursuit,
  ArchivedPursuit,
} from '../services/archiveService';
import { fetchPursuitPlants, PursuitPlant } from '../services/pursuitService';
import { fetchAllLenderStats } from '../services/lenderStatsService';
import { fetchAllTaxEquityStats } from '../services/taxEquityService';
import { LenderStats, TaxEquityStats } from '../types';

type SubTab = 'plants' | 'lenders' | 'tax_equity';

function UnarchiveIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 8.25H7.5a2.25 2.25 0 00-2.25 2.25v9a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25H15M9 12l3 3m0 0l3-3m-3 3V2.25" />
    </svg>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function scoreLabel(val: number | null): { text: string; color: string; bg: string } {
  if (val == null) return { text: '—', color: 'text-slate-600', bg: '' };
  if (val >= 60) return { text: 'HIGH', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/30' };
  if (val >= 30) return { text: 'MED', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30' };
  return { text: 'LOW', color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/30' };
}

export default function ArchivedPursuitsDashboard() {
  const [archived, setArchived] = useState<ArchivedPursuit[]>([]);
  const [plants, setPlants] = useState<PursuitPlant[]>([]);
  const [lenders, setLenders] = useState<LenderStats[]>([]);
  const [taxEquity, setTaxEquity] = useState<TaxEquityStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<SubTab>('plants');
  const [unarchiving, setUnarchiving] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const [archivedList, plantData, lenderData, teData] = await Promise.all([
      fetchArchivedPursuitsList(),
      fetchPursuitPlants(),
      fetchAllLenderStats(),
      fetchAllTaxEquityStats(),
    ]);
    setArchived(archivedList);
    setPlants(plantData);
    setLenders(lenderData);
    setTaxEquity(teData);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const archivedPlantIds    = new Set(archived.filter(a => a.entityType === 'plant').map(a => a.entityId));
  const archivedLenderIds   = new Set(archived.filter(a => a.entityType === 'lender').map(a => a.entityId));
  const archivedTEIds       = new Set(archived.filter(a => a.entityType === 'tax_equity').map(a => a.entityId));

  const archivedPlants    = plants.filter(p => archivedPlantIds.has(p.eiaPlantCode));
  const archivedLenderStats = lenders.filter(l => archivedLenderIds.has(l.lenderName));
  const archivedTEStats   = taxEquity.filter(t => archivedTEIds.has(t.investorName));

  const archivedAtMap = new Map(archived.map(a => [`${a.entityType}:${a.entityId}`, a.archivedAt]));

  const handleUnarchive = async (entityType: ArchivedPursuit['entityType'], entityId: string) => {
    const key = `${entityType}:${entityId}`;
    setUnarchiving(prev => new Set([...prev, key]));
    await unarchivePursuit(entityType, entityId);
    setArchived(prev => prev.filter(a => !(a.entityType === entityType && a.entityId === entityId)));
    setUnarchiving(prev => { const s = new Set(prev); s.delete(key); return s; });
  };

  const counts = {
    plants:    archivedPlants.length,
    lenders:   archivedLenderStats.length,
    tax_equity: archivedTEStats.length,
  };

  const tabs: { key: SubTab; label: string; color: string; activeColor: string }[] = [
    { key: 'plants',    label: 'Plants',     color: 'text-emerald-400', activeColor: 'bg-emerald-700' },
    { key: 'lenders',   label: 'Lenders',    color: 'text-cyan-400',    activeColor: 'bg-cyan-700' },
    { key: 'tax_equity', label: 'Tax Equity', color: 'text-violet-400',  activeColor: 'bg-violet-700' },
  ];

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-slate-500 mx-auto mb-3" />
          <p className="text-slate-400 text-sm font-medium">Loading archived pursuits…</p>
        </div>
      </div>
    );
  }

  const totalArchived = counts.plants + counts.lenders + counts.tax_equity;

  return (
    <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="mb-6 px-1 flex-shrink-0">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-2 h-8 rounded-full bg-slate-500" />
          <h1 className="text-4xl font-black text-white tracking-tight">Archived Pursuits</h1>
        </div>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed">
          {totalArchived === 0
            ? 'No pursuits archived yet. Use the archive button on any pursuit row to hide it from active dashboards.'
            : `${totalArchived} archived pursuit${totalArchived !== 1 ? 's' : ''} across plants, lenders, and tax equity investors. Unarchive to restore to active dashboards.`}
        </p>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-6 flex-shrink-0">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
              activeTab === tab.key
                ? `${tab.activeColor} text-white shadow-lg`
                : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700'
            }`}
          >
            {tab.label}
            {counts[tab.key] > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-black ${
                activeTab === tab.key ? 'bg-white/20 text-white' : 'bg-slate-700 text-slate-400'
              }`}>
                {counts[tab.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Plants tab */}
        {activeTab === 'plants' && (
          archivedPlants.length === 0 ? (
            <EmptyState label="plants" />
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                    <th className="px-6 py-4">Plant Name</th>
                    <th className="px-6 py-4">Fuel</th>
                    <th className="px-6 py-4 text-right">Capacity (MW)</th>
                    <th className="px-6 py-4 text-center">Distress</th>
                    <th className="px-6 py-4 text-center">Pursuit Score</th>
                    <th className="px-6 py-4 text-right">Archived</th>
                    <th className="px-6 py-4 w-28 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {archivedPlants.map(plant => {
                    const key = `plant:${plant.eiaPlantCode}`;
                    const isUnarchiving = unarchiving.has(key);
                    const distress = scoreLabel(plant.distressScore);
                    const pursuit = scoreLabel(plant.pursuitScore);
                    return (
                      <tr key={plant.eiaPlantCode} className="opacity-60 hover:opacity-100 transition-opacity">
                        <td className="px-6 py-4">
                          <div className="font-bold text-slate-300 text-sm">{plant.name}</div>
                          <div className="text-[10px] text-slate-600 font-mono">EIA {plant.eiaPlantCode} | {plant.state}</div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-[10px] px-2 py-0.5 rounded border border-slate-600 text-slate-400 font-bold">
                            {plant.fuelSource.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right font-mono text-sm text-slate-400">
                          {plant.nameplateMw > 0 ? plant.nameplateMw.toLocaleString() : '—'}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {plant.distressScore != null ? (
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${distress.bg} ${distress.color}`}>
                              {plant.distressScore.toFixed(0)} {distress.text}
                            </span>
                          ) : <span className="text-slate-700">—</span>}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {plant.pursuitScore != null ? (
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${pursuit.bg} ${pursuit.color}`}>
                              {plant.pursuitScore.toFixed(0)} {pursuit.text}
                            </span>
                          ) : <span className="text-slate-700">—</span>}
                        </td>
                        <td className="px-6 py-4 text-right text-[10px] text-slate-600 font-mono">
                          {archivedAtMap.has(key) ? formatDate(archivedAtMap.get(key)!) : '—'}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <button
                            onClick={() => handleUnarchive('plant', plant.eiaPlantCode)}
                            disabled={isUnarchiving}
                            title="Restore to active pursuits"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-900/40 border border-emerald-700/50 text-emerald-400 hover:bg-emerald-800/50 hover:text-emerald-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <UnarchiveIcon className="w-3.5 h-3.5" />
                            {isUnarchiving ? 'Restoring…' : 'Restore'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* Lenders tab */}
        {activeTab === 'lenders' && (
          archivedLenderStats.length === 0 ? (
            <EmptyState label="lenders" />
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                    <th className="px-6 py-4">Lender</th>
                    <th className="px-6 py-4 text-center">Distress Score</th>
                    <th className="px-6 py-4 text-right">Curtailed Plants</th>
                    <th className="px-6 py-4 text-right">Archived</th>
                    <th className="px-6 py-4 w-28 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {archivedLenderStats.map(lender => {
                    const key = `lender:${lender.lenderName}`;
                    const isUnarchiving = unarchiving.has(key);
                    const distress = scoreLabel(lender.distressScore ?? null);
                    return (
                      <tr key={lender.lenderName} className="opacity-60 hover:opacity-100 transition-opacity">
                        <td className="px-6 py-4">
                          <div className="font-bold text-slate-300 text-sm">{lender.lenderName}</div>
                          {lender.facilityTypes.length > 0 && (
                            <div className="flex gap-1 mt-1">
                              {lender.facilityTypes.slice(0, 4).map(ft => (
                                <span key={ft} className="text-[9px] px-1 py-px rounded bg-slate-800 border border-slate-700 text-slate-500 font-mono font-bold">
                                  {ft.slice(0, 2).toUpperCase()}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {lender.distressScore != null ? (
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${distress.bg} ${distress.color}`}>
                              {Math.round(lender.distressScore)} {distress.text}
                            </span>
                          ) : <span className="text-slate-700">—</span>}
                        </td>
                        <td className="px-6 py-4 text-right text-sm text-slate-400 font-mono">
                          {lender.plantCodes.length}
                        </td>
                        <td className="px-6 py-4 text-right text-[10px] text-slate-600 font-mono">
                          {archivedAtMap.has(key) ? formatDate(archivedAtMap.get(key)!) : '—'}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <button
                            onClick={() => handleUnarchive('lender', lender.lenderName)}
                            disabled={isUnarchiving}
                            title="Restore to active pursuits"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-900/40 border border-cyan-700/50 text-cyan-400 hover:bg-cyan-800/50 hover:text-cyan-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <UnarchiveIcon className="w-3.5 h-3.5" />
                            {isUnarchiving ? 'Restoring…' : 'Restore'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* Tax Equity tab */}
        {activeTab === 'tax_equity' && (
          archivedTEStats.length === 0 ? (
            <EmptyState label="tax equity investors" />
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                    <th className="px-6 py-4">Investor</th>
                    <th className="px-6 py-4 text-center">Distress Score</th>
                    <th className="px-6 py-4 text-right">Curtailed Plants</th>
                    <th className="px-6 py-4 text-right">Archived</th>
                    <th className="px-6 py-4 w-28 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {archivedTEStats.map(inv => {
                    const key = `tax_equity:${inv.investorName}`;
                    const isUnarchiving = unarchiving.has(key);
                    const distress = scoreLabel(inv.distressScore ?? null);
                    return (
                      <tr key={inv.investorName} className="opacity-60 hover:opacity-100 transition-opacity">
                        <td className="px-6 py-4">
                          <div className="font-bold text-slate-300 text-sm">{inv.investorName}</div>
                        </td>
                        <td className="px-6 py-4 text-center">
                          {inv.distressScore != null ? (
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${distress.bg} ${distress.color}`}>
                              {Math.round(inv.distressScore)} {distress.text}
                            </span>
                          ) : <span className="text-slate-700">—</span>}
                        </td>
                        <td className="px-6 py-4 text-right text-sm text-slate-400 font-mono">
                          {inv.plantCodes.length}
                        </td>
                        <td className="px-6 py-4 text-right text-[10px] text-slate-600 font-mono">
                          {archivedAtMap.has(key) ? formatDate(archivedAtMap.get(key)!) : '—'}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <button
                            onClick={() => handleUnarchive('tax_equity', inv.investorName)}
                            disabled={isUnarchiving}
                            title="Restore to active pursuits"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-900/40 border border-violet-700/50 text-violet-400 hover:bg-violet-800/50 hover:text-violet-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <UnarchiveIcon className="w-3.5 h-3.5" />
                            {isUnarchiving ? 'Restoring…' : 'Restore'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-slate-700">
      <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12 mb-4 text-slate-800" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-.375c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v.375c0 .621.504 1.125 1.125 1.125z" />
      </svg>
      <p className="font-semibold text-lg text-slate-600">No archived {label}</p>
      <p className="text-sm mt-1 text-slate-700">
        Hover over a row in the {label} dashboard and click the archive icon to hide it here.
      </p>
    </div>
  );
}
