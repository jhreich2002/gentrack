import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchNoLenderPlants,
  addManualLenderLink,
  NoLenderPlant,
  NoLenderOptions,
} from '../../services/lenderValidationService';
import ManualLenderForm from './ManualLenderForm';

function fmtMw(mw: number | null): string {
  if (mw == null) return '—';
  if (mw >= 1000) return `${(mw / 1000).toFixed(1)} GW`;
  return `${Math.round(mw).toLocaleString()} MW`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface Props {
  refreshKey?: number;
  onRefresh?: () => void;
}

const NotIdentifiedTab: React.FC<Props> = ({ refreshKey = 0, onRefresh }) => {
  const [plants, setPlants] = useState<NoLenderPlant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<NoLenderOptions['sortBy']>('mw');
  const [selectedPlant, setSelectedPlant] = useState<NoLenderPlant | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const rows = await fetchNoLenderPlants({ search, sortBy });
    setPlants(rows);
    setLoading(false);
  }, [search, sortBy]);

  useEffect(() => { load(); }, [load, refreshKey]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  function handleSuccess(_linkId: number, lenderName: string) {
    setSelectedPlant(null);
    showToast(`Lender "${lenderName}" saved — plant will move to Validated.`);
    // Re-fetch so the plant naturally disappears (RPC sets plant_research_state.status='complete')
    load();
    onRefresh?.();
  }

  const curtailedCount = plants.filter(p => p.isLikelyCurtailed).length;

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left panel: plant list ── */}
      <div className="flex flex-col w-full max-w-2xl border-r border-slate-800 overflow-hidden flex-shrink-0">
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-slate-800 flex-shrink-0 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="text-sm font-semibold text-white">
                {loading ? '…' : plants.length} plants
              </span>
              {!loading && curtailedCount > 0 && (
                <span className="ml-2 text-xs text-amber-400">
                  {curtailedCount} curtailed
                </span>
              )}
              <p className="text-xs text-slate-500 mt-0.5">
                Pipeline could not identify a lender — manual research needed
              </p>
            </div>
          </div>

          {/* Search + sort */}
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Search plants…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as NoLenderOptions['sortBy'])}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-300 focus:outline-none focus:border-blue-500"
            >
              <option value="mw">By MW</option>
              <option value="name">By Name</option>
              <option value="date">By Date</option>
            </select>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
              Loading…
            </div>
          ) : plants.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-slate-500 text-sm gap-2">
              <span className="text-2xl">✓</span>
              {search ? 'No plants match your search.' : 'All plants have been resolved — great work!'}
            </div>
          ) : (
            plants.map(plant => (
              <button
                key={plant.plantId}
                onClick={() => setSelectedPlant(plant)}
                className={`w-full text-left px-4 py-3 border-b border-slate-800/60 transition-colors hover:bg-slate-800/50 ${
                  selectedPlant?.plantId === plant.plantId ? 'bg-slate-800/70' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                      {plant.plantName ?? plant.plantCode}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {[plant.state, plant.plantCode].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="text-xs font-mono text-slate-300">{fmtMw(plant.nameplateMw)}</span>
                    {plant.isLikelyCurtailed && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400">
                        curtailed
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-[10px] text-slate-600 mt-1">
                  Last researched {fmtDate(plant.lastResearchedAt)}
                </p>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right panel: manual entry form or empty state ── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-900/20">
        {selectedPlant ? (
          <div className="flex flex-col h-full overflow-y-auto">
            {/* Panel header */}
            <div className="px-5 pt-4 pb-3 border-b border-slate-800 flex-shrink-0">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    {selectedPlant.plantName ?? selectedPlant.plantCode}
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {[selectedPlant.state, fmtMw(selectedPlant.nameplateMw)].filter(Boolean).join(' · ')}
                    {selectedPlant.isLikelyCurtailed && (
                      <span className="ml-2 text-amber-400">· curtailed</span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedPlant(null)}
                  className="text-slate-500 hover:text-slate-300 text-lg leading-none flex-shrink-0"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                The automated pipeline could not identify a lender for this plant. If manual research reveals a lender, enter it below.
              </p>
            </div>

            {/* Form */}
            <div className="px-5 py-4">
              <ManualLenderForm
                plantCode={selectedPlant.plantId}
                plantName={selectedPlant.plantName}
                onSuccess={handleSuccess}
                onCancel={() => setSelectedPlant(null)}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-3 px-8 text-center">
            <svg className="w-10 h-10 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <p className="text-sm text-slate-500">
              Select a plant to add a manually researched lender
            </p>
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-emerald-800 text-emerald-100 text-sm px-4 py-2 rounded-lg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
};

export default NotIdentifiedTab;
