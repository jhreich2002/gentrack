import React, { useEffect, useMemo, useState } from 'react';
import {
  fetchOwnershipAssets,
  aggregateByRole,
  assetsForEntity,
  OWNERSHIP_ROLE_LABEL,
  OwnershipAsset,
  OwnershipRole,
} from '../services/ownershipAnalysisService';

interface Props {
  onBack: () => void;
  onCompanyClick: (ultParentName: string) => void;
  onPlantClick: (eiaPlantCode: string) => void;
}

const ROLE_ORDER: OwnershipRole[] = [
  'owner',
  'ult_parent',
  'plant_operator',
  'operator_ult_parent',
];

const ROLES_WITH_COMPANY_PROFILE: OwnershipRole[] = [
  'ult_parent',
  'operator_ult_parent',
];

const TECH_COLORS: Record<string, string> = {
  Solar:   '#facc15',
  Wind:    '#38bdf8',
  Nuclear: '#4ade80',
};

function techColor(tech: string | null): string {
  if (!tech) return '#64748b';
  return TECH_COLORS[tech] ?? '#94a3b8';
}

const OwnerAnalysisView: React.FC<Props> = ({ onBack, onCompanyClick, onPlantClick }) => {
  const [assets, setAssets]           = useState<OwnershipAsset[]>([]);
  const [loading, setLoading]         = useState(true);
  const [role, setRole]               = useState<OwnershipRole>('ult_parent');
  const [search, setSearch]           = useState('');
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchOwnershipAssets()
      .then(rows => {
        if (cancelled) return;
        setAssets(rows);
        setLoading(false);
      })
      .catch(err => {
        console.error('[OwnerAnalysis] fetch error:', err);
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Reset selection whenever the role toggle changes — an ult_parent name
  // rarely maps 1:1 to an operator, so selection carry-over would confuse.
  useEffect(() => {
    setSelectedEntity(null);
  }, [role]);

  const aggregates = useMemo(() => aggregateByRole(assets, role), [assets, role]);

  const filteredEntities = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return aggregates;
    return aggregates.filter(e => e.name.toLowerCase().includes(q));
  }, [aggregates, search]);

  const selectedAssets = useMemo(() => {
    if (!selectedEntity) return [];
    return assetsForEntity(assets, role, selectedEntity)
      .sort((a, b) => b.nameplateMw - a.nameplateMw);
  }, [assets, role, selectedEntity]);

  const selectedSummary = useMemo(() => {
    if (!selectedEntity) return null;
    return aggregates.find(e => e.name === selectedEntity) ?? null;
  }, [aggregates, selectedEntity]);

  const showCompanyProfileButton = ROLES_WITH_COMPANY_PROFILE.includes(role);

  return (
    <div>
      {/* Header */}
      <header className="mb-6">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-slate-500 hover:text-blue-400 transition-colors mb-4 group"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
          <span className="text-sm font-medium group-hover:underline">Back to Dashboard</span>
        </button>
        <h1 className="text-4xl font-black text-white mb-2 tracking-tight">Owner Analysis</h1>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed">
          Pivot the asset base by ownership role. Choose a role, then search or select an
          entity to see every plant they own or operate.
        </p>
      </header>

      {/* Controls: role toggle + search */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex gap-1 bg-slate-900 rounded-xl p-1 border border-slate-800">
          {ROLE_ORDER.map(r => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                role === r
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {OWNERSHIP_ROLE_LABEL[r]}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder={`Search ${OWNERSHIP_ROLE_LABEL[role].toLowerCase()}…`}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 max-w-md px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-600 transition-colors"
        />
        <div className="text-xs text-slate-500 font-mono ml-auto">
          {loading ? 'Loading…' : `${filteredEntities.length.toLocaleString()} entities • ${assets.length.toLocaleString()} asset records`}
        </div>
      </div>

      {loading ? (
        <div className="py-32 text-center text-slate-500">
          <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-sm font-medium">Loading ownership records…</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-6">
          {/* ── Left: entity list ─────────────────────────────────────────── */}
          <div className="col-span-1 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col" style={{ maxHeight: 'calc(100vh - 320px)' }}>
            <div className="px-5 py-3 bg-slate-800/70 border-b border-slate-800 flex items-center justify-between">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.15em]">
                {OWNERSHIP_ROLE_LABEL[role]}
              </span>
              <span className="text-[10px] font-mono text-slate-500">
                {filteredEntities.length.toLocaleString()}
              </span>
            </div>
            <div className="overflow-y-auto custom-scrollbar divide-y divide-slate-800">
              {filteredEntities.length === 0 ? (
                <div className="px-5 py-10 text-center text-slate-600 text-sm">
                  No {OWNERSHIP_ROLE_LABEL[role].toLowerCase()} entities match “{search}”.
                </div>
              ) : (
                filteredEntities.slice(0, 500).map(e => {
                  const isSelected = e.name === selectedEntity;
                  return (
                    <button
                      key={e.name}
                      onClick={() => setSelectedEntity(e.name)}
                      className={`w-full text-left px-5 py-3 transition-colors ${
                        isSelected
                          ? 'bg-blue-950/40 border-l-2 border-blue-500'
                          : 'hover:bg-slate-800/60 border-l-2 border-transparent'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className={`text-sm font-bold truncate ${isSelected ? 'text-white' : 'text-slate-300'}`}>
                            {e.name}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] text-slate-500 font-mono">
                              {e.assetCount} asset{e.assetCount === 1 ? '' : 's'}
                            </span>
                            {e.topTech && (
                              <span
                                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                                style={{ backgroundColor: techColor(e.topTech) }}
                                title={e.topTech}
                              />
                            )}
                            {e.topState && (
                              <span className="text-[10px] text-slate-600 font-mono">{e.topState}</span>
                            )}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className="text-xs font-mono font-bold text-slate-400">
                            {Math.round(e.totalMW).toLocaleString()}
                          </div>
                          <div className="text-[9px] text-slate-600 font-mono uppercase">MW</div>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
              {filteredEntities.length > 500 && (
                <div className="px-5 py-3 text-[10px] text-slate-600 text-center italic bg-slate-950/50">
                  Showing first 500 of {filteredEntities.length.toLocaleString()}. Refine the search to narrow.
                </div>
              )}
            </div>
          </div>

          {/* ── Right: selected entity detail ─────────────────────────────── */}
          <div className="col-span-2 space-y-6">
            {!selectedEntity || !selectedSummary ? (
              <div className="bg-slate-900 border border-dashed border-slate-800 rounded-2xl py-32 text-center">
                <svg className="w-12 h-12 mx-auto mb-4 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
                <p className="text-slate-500 text-sm font-medium">Select or search for a {OWNERSHIP_ROLE_LABEL[role].toLowerCase()} to view its assets.</p>
              </div>
            ) : (
              <>
                {/* Entity header + optional company link */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">
                        {OWNERSHIP_ROLE_LABEL[role]}
                      </div>
                      <h2 className="text-2xl font-black text-white tracking-tight truncate">{selectedSummary.name}</h2>
                    </div>
                    {showCompanyProfileButton && (
                      <button
                        onClick={() => onCompanyClick(selectedSummary.name)}
                        className="px-4 py-2 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-500 transition-all flex-shrink-0"
                      >
                        View Company Profile →
                      </button>
                    )}
                  </div>

                  {/* Summary cards */}
                  <div className="grid grid-cols-4 gap-3 mt-5">
                    <div className="bg-slate-800/40 rounded-xl px-4 py-3 border border-slate-700/50">
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Assets</div>
                      <div className="text-2xl font-black text-white">{selectedSummary.assetCount.toLocaleString()}</div>
                    </div>
                    <div className="bg-slate-800/40 rounded-xl px-4 py-3 border border-slate-700/50">
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Total MW</div>
                      <div className="text-2xl font-black text-white">{Math.round(selectedSummary.totalMW).toLocaleString()}</div>
                    </div>
                    <div className="bg-slate-800/40 rounded-xl px-4 py-3 border border-slate-700/50">
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Top Tech</div>
                      <div className="text-lg font-black" style={{ color: techColor(selectedSummary.topTech) }}>
                        {selectedSummary.topTech ?? '—'}
                      </div>
                    </div>
                    <div className="bg-slate-800/40 rounded-xl px-4 py-3 border border-slate-700/50">
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Top State</div>
                      <div className="text-lg font-black text-white">{selectedSummary.topState ?? '—'}</div>
                    </div>
                  </div>
                </div>

                {/* Asset table */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                  <div className="px-5 py-3 bg-slate-800/70 border-b border-slate-800 flex items-center justify-between">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.15em]">Assets</span>
                    <span className="text-[10px] font-mono text-slate-500">{selectedAssets.length.toLocaleString()}</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="text-slate-500 text-[10px] font-bold uppercase tracking-[0.15em] bg-slate-950/50">
                          <th className="px-5 py-3">Plant</th>
                          <th className="px-5 py-3">State</th>
                          <th className="px-5 py-3">Region</th>
                          <th className="px-5 py-3">Tech</th>
                          <th className="px-5 py-3 text-right">MW</th>
                          <th className="px-5 py-3 text-right">Ownership</th>
                          <th className="px-5 py-3 text-right">TTM Factor</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {selectedAssets.map(a => (
                          <tr
                            key={`${a.eiaPlantCode}-${a.owner}-${a.plantOperator}`}
                            onClick={() => onPlantClick(a.eiaPlantCode)}
                            className="cursor-pointer transition-colors hover:bg-slate-800/60 group"
                          >
                            <td className="px-5 py-3">
                              <div className="font-bold text-sm text-slate-200 group-hover:text-blue-400 transition-colors">
                                {a.plantName}
                              </div>
                              <div className="text-[10px] text-slate-600 font-mono">EIA {a.eiaPlantCode}</div>
                            </td>
                            <td className="px-5 py-3 text-xs text-slate-400">{a.state ?? '—'}</td>
                            <td className="px-5 py-3 text-xs text-slate-400">{a.region ?? '—'}</td>
                            <td className="px-5 py-3">
                              {a.techType ? (
                                <span
                                  className="text-[10px] px-2 py-0.5 rounded font-bold border"
                                  style={{
                                    color:           techColor(a.techType),
                                    backgroundColor: `${techColor(a.techType)}10`,
                                    borderColor:     `${techColor(a.techType)}40`,
                                  }}
                                >
                                  {a.techType.toUpperCase()}
                                </span>
                              ) : (
                                <span className="text-[10px] text-slate-600">—</span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-right text-xs font-mono text-slate-300">
                              {a.nameplateMw ? Math.round(a.nameplateMw).toLocaleString() : '—'}
                            </td>
                            <td className="px-5 py-3 text-right text-xs font-mono text-slate-400">
                              {a.ownershipPct != null ? `${a.ownershipPct.toFixed(1)}%` : '—'}
                            </td>
                            <td className="px-5 py-3 text-right text-xs font-mono text-slate-300">
                              {a.ttmAvgFactor ? `${(a.ttmAvgFactor * 100).toFixed(1)}%` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {selectedAssets.length === 0 && (
                      <div className="py-16 text-center text-slate-600 text-sm">
                        No matching assets on record.
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default OwnerAnalysisView;
