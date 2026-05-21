/**
 * GenTrack — AdminResearchPanel (v4)
 *
 * Admin-only panel for triggering and monitoring lender research runs.
 *
 * Columns: Plant · State · MW · Status · Last Run · Validated · Pending · Cost · Actions
 *
 * Features:
 *   - Filter by research status and curtailed-only
 *   - Search by plant name
 *   - Per-plant Research / Refresh button (calls orchestrator directly)
 *   - Budget-exceeded badge + configurable budget slider
 *   - Cost dashboard (monthly rollup)
 *   - Bulk-research selected plants
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchPlantResearchState,
  fetchAdminResearchCosts,
  triggerPlantResearch,
  triggerBulkResearch,
  PlantResearchState,
  ResearchCostRow,
  ResearchStatus,
} from '../../services/lenderResearchService';

function fmtMw(mw: number | null): string {
  if (mw == null) return '—';
  if (mw >= 1000) return `${(mw / 1000).toFixed(1)} GW`;
  return `${Math.round(mw).toLocaleString()} MW`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

const STATUS_BADGE: Record<ResearchStatus, string> = {
  never:                  'bg-slate-800 text-slate-500',
  in_progress:            'bg-blue-900/40 text-blue-300 animate-pulse',
  complete:               'bg-emerald-900/40 text-emerald-300',
  budget_exceeded:        'bg-amber-900/40 text-amber-300',
  failed:                 'bg-red-900/40 text-red-300',
  no_lender_identifiable: 'bg-slate-700/60 text-slate-400',
};

const STATUS_LABELS: Record<ResearchStatus, string> = {
  never:                  'Never',
  in_progress:            'Running…',
  complete:               'Done',
  budget_exceeded:        'Budget hit',
  failed:                 'Failed',
  no_lender_identifiable: 'No lender',
};

interface Props {
  onRefresh?: () => void;
}

const AdminResearchPanel: React.FC<Props> = ({ onRefresh }) => {
  const [plants,       setPlants]       = useState<PlantResearchState[]>([]);
  const [costs,        setCosts]        = useState<ResearchCostRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<ResearchStatus | 'all'>('all');
  const [curtailedOnly, setCurtailedOnly] = useState(false);
  const [budgetUsd,    setBudgetUsd]    = useState(0.25);
  const [showCosts,    setShowCosts]    = useState(false);

  // Running state: plantId → 'running' | 'done' | 'error'
  const [runState, setRunState]         = useState<Record<string, 'running' | 'done' | 'error'>>({});
  const [runMsg,   setRunMsg]           = useState<Record<string, string>>({});

  // Bulk selection
  const [selected, setSelected]         = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning]   = useState(false);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);

  // Toast
  const [toast, setToast]               = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  const load = useCallback(async () => {
    setLoading(true);
    const [ps, cs] = await Promise.all([
      fetchPlantResearchState({ curtailedOnly, statusFilter, search }),
      fetchAdminResearchCosts(),
    ]);
    setPlants(ps);
    setCosts(cs);
    setLoading(false);
  }, [curtailedOnly, statusFilter, search]);

  useEffect(() => { load(); }, [load]);

  async function handleResearch(plant: PlantResearchState) {
    setRunState(s => ({ ...s, [plant.plantId]: 'running' }));
    setRunMsg(m => ({ ...m, [plant.plantId]: 'Queuing…' }));

    const result = await triggerPlantResearch(
      plant.plantId,
      budgetUsd,
      plant.researchStatus === 'never' ? 'initial' : 'refresh',
    );

    if (result.ok) {
      setRunState(s => ({ ...s, [plant.plantId]: 'done' }));
      const msg = result.budget_exceeded
        ? `Budget exceeded — ${result.links_created ?? 0} links · $${(result.cost_usd ?? 0).toFixed(3)}`
        : `Done — ${result.links_created ?? 0} links · $${(result.cost_usd ?? 0).toFixed(3)}`;
      setRunMsg(m => ({ ...m, [plant.plantId]: msg }));
      showToast(`${plant.plantName}: ${msg}`);
      onRefresh?.();
      await load();
    } else {
      setRunState(s => ({ ...s, [plant.plantId]: 'error' }));
      setRunMsg(m => ({ ...m, [plant.plantId]: result.error ?? 'Unknown error' }));
      showToast(`${plant.plantName}: ${result.error ?? 'Research failed'}`);
    }
  }

  async function handleBulkResearch() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!window.confirm(`Run research for ${ids.length} plants at $${budgetUsd.toFixed(2)}/plant? Estimated cost: $${(ids.length * budgetUsd).toFixed(2)}`)) return;
    setBulkRunning(true);
    setBulkProgress(`0 / ${ids.length}`);

    const summary = await triggerBulkResearch(ids, budgetUsd, (completed, total) => {
      setBulkProgress(`${completed} / ${total}`);
    });

    setBulkRunning(false);
    setBulkProgress(null);
    setSelected(new Set());
    showToast(`Bulk research: ${summary.succeeded} OK, ${summary.failed} failed, $${summary.totalCostUsd.toFixed(2)} total`);
    onRefresh?.();
    await load();
  }

  function toggleSelect(plantId: string) {
    setSelected(s => {
      const n = new Set(s);
      n.has(plantId) ? n.delete(plantId) : n.add(plantId);
      return n;
    });
  }

  function toggleSelectAll() {
    if (selected.size === plants.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(plants.map(p => p.plantId)));
    }
  }

  // Cost summary
  const totalCostAllTime = costs.reduce((s, r) => s + r.totalCostUsd, 0);
  const budgetExceededAll = costs.reduce((s, r) => s + r.budgetExceededCount, 0);

  return (
    <div className="flex flex-col h-full">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-slate-100 text-sm shadow-lg max-w-sm">
          {toast}
        </div>
      )}

      {/* Controls bar */}
      <div className="px-5 py-3 border-b border-slate-800 bg-slate-900/50 flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search plant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 w-52"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ResearchStatus | 'all')}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-100"
        >
          <option value="all">All statuses</option>
          <option value="never">Never researched</option>
          <option value="budget_exceeded">Budget exceeded</option>
          <option value="failed">Failed</option>
          <option value="complete">Complete</option>
          <option value="no_lender_identifiable">No lender</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={curtailedOnly}
            onChange={(e) => setCurtailedOnly(e.target.checked)}
            className="accent-blue-500"
          />
          Curtailed only
        </label>

        <div className="flex items-center gap-2 text-xs text-slate-400 ml-auto">
          <span>Budget</span>
          <input
            type="number"
            min={0.05}
            max={2.00}
            step={0.05}
            value={budgetUsd}
            onChange={(e) => setBudgetUsd(Math.max(0.05, Number(e.target.value) || 0.25))}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 w-20"
          />
          <span>$/plant</span>
        </div>

        <button
          onClick={() => setShowCosts(v => !v)}
          className="text-xs text-slate-400 hover:text-slate-200 underline"
        >
          {showCosts ? 'Hide' : 'Show'} costs
        </button>
      </div>

      {/* Cost dashboard (expandable) */}
      {showCosts && (
        <div className="px-5 py-3 border-b border-slate-800 bg-slate-900/30">
          <div className="flex gap-6 text-sm mb-3">
            <div>
              <div className="text-slate-400 text-xs">All-time spend</div>
              <div className="text-white font-semibold">${totalCostAllTime.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-slate-400 text-xs">Budget exceeded</div>
              <div className="text-amber-300 font-semibold">{budgetExceededAll} sessions</div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs text-slate-300 w-full">
              <thead>
                <tr className="text-slate-500 border-b border-slate-800">
                  <th className="text-left pb-1 pr-4">Month</th>
                  <th className="text-right pb-1 pr-4">Sessions</th>
                  <th className="text-right pb-1 pr-4">Total $</th>
                  <th className="text-right pb-1 pr-4">Avg $</th>
                  <th className="text-right pb-1">Budget hits</th>
                </tr>
              </thead>
              <tbody>
                {costs.map(r => (
                  <tr key={r.month} className="border-b border-slate-800/50">
                    <td className="py-1 pr-4">{r.month.slice(0, 7)}</td>
                    <td className="text-right pr-4">{r.sessions}</td>
                    <td className="text-right pr-4">${r.totalCostUsd.toFixed(3)}</td>
                    <td className="text-right pr-4">${r.avgCostUsd.toFixed(3)}</td>
                    <td className="text-right text-amber-400">{r.budgetExceededCount || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="px-5 py-2 border-b border-slate-800 bg-blue-900/20 flex items-center gap-3">
          <span className="text-sm text-blue-300">{selected.size} selected</span>
          <button
            onClick={handleBulkResearch}
            disabled={bulkRunning}
            className="px-3 py-1 text-xs font-semibold rounded bg-blue-700 hover:bg-blue-600 text-white disabled:bg-slate-700 disabled:cursor-not-allowed"
          >
            {bulkRunning ? `Running… ${bulkProgress ?? ''}` : `Research ${selected.size} plants`}
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            Clear
          </button>
          <span className="text-xs text-slate-500 ml-auto">
            Estimated cost: ${(selected.size * budgetUsd).toFixed(2)}
          </span>
        </div>
      )}

      {/* Plant table */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-8 text-center text-slate-500 text-sm">Loading plants…</div>
        ) : plants.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">No plants match the filters.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-900 z-10 border-b border-slate-800">
              <tr className="text-left text-xs text-slate-500 uppercase tracking-wide">
                <th className="px-4 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === plants.length}
                    onChange={toggleSelectAll}
                    className="accent-blue-500"
                  />
                </th>
                <th className="px-4 py-2">Plant</th>
                <th className="px-4 py-2">State</th>
                <th className="px-4 py-2 text-right">MW</th>
                <th className="px-4 py-2 text-center">Status</th>
                <th className="px-4 py-2">Last run</th>
                <th className="px-4 py-2 text-right">Validated</th>
                <th className="px-4 py-2 text-right">Pending</th>
                <th className="px-4 py-2 text-right">Cost</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {plants.map(p => {
                const state  = runState[p.plantId];
                const msg    = runMsg[p.plantId];
                const isRunning = state === 'running';
                return (
                  <tr
                    key={p.plantId}
                    className={`border-b border-slate-800/60 hover:bg-slate-800/20 ${selected.has(p.plantId) ? 'bg-blue-900/10' : ''}`}
                  >
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(p.plantId)}
                        onChange={() => toggleSelect(p.plantId)}
                        className="accent-blue-500"
                        disabled={isRunning}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="text-white font-medium truncate max-w-[260px]">{p.plantName}</div>
                      {p.isLikelyCurtailed && (
                        <span className="text-[10px] text-amber-400">curtailed</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-400">{p.state ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right text-slate-300">{fmtMw(p.nameplateMw)}</td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${STATUS_BADGE[p.researchStatus]}`}>
                        {STATUS_LABELS[p.researchStatus]}
                      </span>
                      {p.budgetExceeded && (
                        <span className="ml-1 text-[10px] text-amber-400">⚠</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {timeAgo(p.lastResearchedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {p.validatedCount > 0 ? (
                        <span className="text-emerald-300 font-semibold">{p.validatedCount}</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {p.pendingCount > 0 ? (
                        <span className="text-blue-300">{p.pendingCount}</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-500 text-xs">
                      {p.lastSessionCostUsd != null ? `$${p.lastSessionCostUsd.toFixed(3)}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {msg && (
                        <span className={`text-[10px] mr-2 ${state === 'error' ? 'text-red-400' : 'text-slate-400'}`}>
                          {msg}
                        </span>
                      )}
                      <button
                        onClick={() => handleResearch(p)}
                        disabled={isRunning || bulkRunning}
                        className={`px-2 py-1 text-[11px] font-semibold rounded uppercase tracking-wide transition-colors ${
                          isRunning
                            ? 'bg-slate-800 text-slate-500 cursor-wait'
                            : p.researchStatus === 'never' || p.researchStatus === 'failed'
                            ? 'bg-blue-700 hover:bg-blue-600 text-white'
                            : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                        }`}
                      >
                        {isRunning ? '…' : p.researchStatus === 'never' ? 'Research' : 'Re-run'}
                      </button>
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
};

export default AdminResearchPanel;
