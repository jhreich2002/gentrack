import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchLenderValidationQueue,
  fetchLenderCandidatePlants,
  fetchPlantEvidenceForLender,
  validateLenderLead,
  rejectLenderLead,
  markNoLenderIdentifiable,
  ValidationQueueRow,
  CandidatePlant,
  PlantEvidenceRow,
} from '../../services/lenderValidationService';
import EvidenceCard from './EvidenceCard';
import ManualLenderForm from './ManualLenderForm';

function fmtMw(mw: number | null): string {
  if (mw == null) return '—';
  if (mw >= 1000) return `${(mw / 1000).toFixed(1)} GW`;
  return `${Math.round(mw).toLocaleString()} MW`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const RESOLUTION_BADGE: Record<string, string> = {
  pending:                'bg-slate-800 text-slate-400',
  validated:              'bg-emerald-900/40 text-emerald-300',
  manual:                 'bg-violet-900/40 text-violet-300',
  no_lender_identifiable: 'bg-red-900/30 text-red-400',
};

interface Props {
  refreshKey?: number;
  onRefresh?: () => void;
}

const ToValidateTab: React.FC<Props> = ({ refreshKey = 0, onRefresh }) => {
  // Queue state
  const [queue, setQueue] = useState<ValidationQueueRow[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [search, setSearch] = useState('');
  const [minPlants, setMinPlants] = useState(2);
  const [sort, setSort] = useState<'curtailed_mw' | 'pending_count' | 'name'>('curtailed_mw');
  const [curtailedOnly, setCurtailedOnly] = useState(true);

  // Selection
  const [selectedLender, setSelectedLender] = useState<ValidationQueueRow | null>(null);
  const [plants, setPlants] = useState<CandidatePlant[]>([]);
  const [selectedPlantCode, setSelectedPlantCode] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<PlantEvidenceRow[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // UI state
  const [confirmingValidate, setConfirmingValidate] = useState<PlantEvidenceRow | null>(null);
  const [showingManual, setShowingManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setLoadingQueue(true);
    const rows = await fetchLenderValidationQueue({ minPlants, curtailedOnly, search, sort });
    setQueue(rows);
    setLoadingQueue(false);
  }, [minPlants, curtailedOnly, search, sort]);

  useEffect(() => { loadQueue(); }, [loadQueue, refreshKey]);

  const loadDetail = useCallback(async (lenderNormalized: string, plantCode?: string) => {
    setLoadingDetail(true);
    const ps = await fetchLenderCandidatePlants(lenderNormalized);
    setPlants(ps);
    const next = plantCode
      || ps.find(p => p.pendingLeadCount > 0)?.plantCode
      || ps[0]?.plantCode
      || null;
    setSelectedPlantCode(next);
    if (next) {
      const ev = await fetchPlantEvidenceForLender(next, lenderNormalized);
      setEvidence(ev);
    } else {
      setEvidence([]);
    }
    setLoadingDetail(false);
  }, []);

  useEffect(() => {
    if (selectedLender) loadDetail(selectedLender.lenderNormalized);
    else { setPlants([]); setSelectedPlantCode(null); setEvidence([]); }
  }, [selectedLender, loadDetail]);

  async function refreshAll(lenderNormalized: string | null) {
    await loadQueue();
    onRefresh?.();
    if (lenderNormalized) {
      // Find the (possibly updated) queue row.
      const next = (await fetchLenderValidationQueue({ minPlants, curtailedOnly, search, sort }))
        .find(r => r.lenderNormalized === lenderNormalized) ?? null;
      setSelectedLender(next);
      if (next) await loadDetail(next.lenderNormalized);
      else { setPlants([]); setSelectedPlantCode(null); setEvidence([]); }
    }
  }

  async function selectPlant(code: string) {
    if (!selectedLender) return;
    setSelectedPlantCode(code);
    setShowingManual(false);
    const ev = await fetchPlantEvidenceForLender(code, selectedLender.lenderNormalized);
    setEvidence(ev);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  // Pick the "best" pending evidence row to validate against (highest confidence first).
  const CONF_RANK: Record<string, number> = {
    confirmed: 4, high_confidence: 3, highly_likely: 2, possible: 1,
  };
  const bestPending = evidence
    .filter(e => e.leadStatus === 'pending')
    .sort((a, b) => (CONF_RANK[b.confidenceClass] ?? 0) - (CONF_RANK[a.confidenceClass] ?? 0))[0] ?? null;

  async function handleValidateConfirm(note: string) {
    if (!confirmingValidate || !selectedLender) return;
    setBusy(true);
    const res = await validateLenderLead(confirmingValidate.id, note || undefined);
    setBusy(false);
    setConfirmingValidate(null);
    if (!res.success) {
      showToast(res.error ?? 'Validation failed');
      return;
    }
    showToast(`Linked ${selectedLender.lenderName} → ${selectedPlantCode}`);
    await refreshAll(selectedLender.lenderNormalized);
  }

  async function handleRejectAll() {
    if (!selectedPlantCode || !selectedLender) return;
    const reason = window.prompt('Reason for rejecting all evidence on this plant? (optional)') ?? undefined;
    setBusy(true);
    const pending = evidence.filter(e => e.leadStatus === 'pending');
    for (const lead of pending) {
      // eslint-disable-next-line no-await-in-loop
      await rejectLenderLead(lead.id, reason);
    }
    setBusy(false);
    showToast(`Rejected ${pending.length} evidence record${pending.length === 1 ? '' : 's'}`);
    await refreshAll(selectedLender.lenderNormalized);
  }

  async function handleNoLender() {
    if (!selectedPlantCode) return;
    if (!window.confirm('Mark this plant as having NO identifiable lender? This will supersede all pending evidence.')) return;
    const note = window.prompt('Optional note on why no lender could be identified:') ?? undefined;
    setBusy(true);
    const res = await markNoLenderIdentifiable(selectedPlantCode, note);
    setBusy(false);
    if (!res.success) { showToast(res.error ?? 'Failed'); return; }
    showToast(`Marked ${selectedPlantCode} as no-lender-identifiable`);
    await refreshAll(selectedLender?.lenderNormalized ?? null);
  }

  return (
    <div className="flex flex-col h-full">
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-2 bg-emerald-900/90 border border-emerald-700 rounded-lg text-emerald-100 text-sm shadow-lg">
          {toast}
        </div>
      )}

      {/* Filter bar */}
      <div className="px-5 py-3 border-b border-slate-800 bg-slate-900/50 flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search lender…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 w-56"
        />
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Min plants
          <input
            type="number"
            min={1}
            max={20}
            value={minPlants}
            onChange={(e) => setMinPlants(Math.max(1, Number(e.target.value) || 1))}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 w-16"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={curtailedOnly}
            onChange={(e) => setCurtailedOnly(e.target.checked)}
            className="accent-blue-500"
          />
          Curtailed plants only
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400 ml-auto">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as any)}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100"
          >
            <option value="curtailed_mw">Curtailed MW</option>
            <option value="pending_count">Pending count</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Lender list */}
        <div className="w-80 flex-shrink-0 border-r border-slate-800 overflow-y-auto">
          {loadingQueue ? (
            <div className="p-6 text-center text-slate-500 text-sm">Loading…</div>
          ) : queue.length === 0 ? (
            <div className="p-6 text-center text-slate-500 text-sm">
              No multi-plant lenders match the filters.
            </div>
          ) : (
            queue.map(row => (
              <button
                key={row.lenderNormalized}
                onClick={() => setSelectedLender(row)}
                className={`block w-full text-left px-4 py-3 border-b border-slate-800 transition-colors ${
                  selectedLender?.lenderNormalized === row.lenderNormalized
                    ? 'bg-blue-900/30 border-l-2 border-l-blue-500'
                    : 'hover:bg-slate-800/40'
                }`}
              >
                <div className="font-semibold text-sm text-white truncate">{row.lenderName || row.lenderNormalized}</div>
                <div className="text-xs text-slate-400 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>{row.pendingCount} pending</span>
                  <span>{row.curtailedPlantCount} curtailed</span>
                  <span>{fmtMw(row.curtailedMw)}</span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail panel */}
        {selectedLender ? (
          <div className="flex-1 flex min-h-0">
            {/* Plant list */}
            <div className="w-72 flex-shrink-0 border-r border-slate-800 overflow-y-auto">
              <div className="px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900/95">
                <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Candidate plants</div>
                <div className="text-[11px] text-slate-500">{plants.length} total · {plants.filter(p => p.pendingLeadCount > 0).length} pending</div>
              </div>
              {loadingDetail ? (
                <div className="p-4 text-center text-slate-500 text-sm">Loading…</div>
              ) : (
                plants.map(p => (
                  <button
                    key={p.plantCode}
                    onClick={() => selectPlant(p.plantCode)}
                    className={`block w-full text-left px-4 py-2.5 border-b border-slate-800 ${
                      selectedPlantCode === p.plantCode ? 'bg-slate-800/60' : 'hover:bg-slate-800/30'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm text-white truncate">{p.plantName ?? p.plantCode}</div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {p.state ?? '—'} · {fmtMw(p.nameplateMw)}
                          {p.isLikelyCurtailed && <span className="text-amber-400"> · curtailed</span>}
                        </div>
                      </div>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide flex-shrink-0 ${RESOLUTION_BADGE[p.resolution] ?? 'bg-slate-800 text-slate-400'}`}>
                        {p.pendingLeadCount > 0 ? `${p.pendingLeadCount}` : p.resolution.replace(/_/g, ' ')}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* Evidence + actions */}
            <div className="flex-1 overflow-y-auto p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold text-white">{selectedLender.lenderName}</h3>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {selectedPlantCode ? `Reviewing plant ${selectedPlantCode}` : 'Select a plant on the left'}
                  </div>
                </div>
              </div>

              {selectedPlantCode && !showingManual && (
                <div className="flex flex-wrap gap-2 mb-4">
                  <button
                    onClick={() => bestPending && setConfirmingValidate(bestPending)}
                    disabled={!bestPending || busy}
                    className="px-3 py-1.5 text-xs font-semibold rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed"
                  >
                    Validate this lender
                  </button>
                  <button
                    onClick={handleRejectAll}
                    disabled={busy || evidence.filter(e => e.leadStatus === 'pending').length === 0}
                    className="px-3 py-1.5 text-xs font-semibold rounded bg-slate-700 hover:bg-slate-600 text-white disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed"
                  >
                    Reject evidence
                  </button>
                  <button
                    onClick={() => setShowingManual(true)}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs font-semibold rounded bg-violet-700 hover:bg-violet-600 text-white disabled:bg-slate-800 disabled:cursor-not-allowed"
                  >
                    Enter lender manually
                  </button>
                  <button
                    onClick={handleNoLender}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs font-semibold rounded bg-red-900/60 hover:bg-red-800/80 text-red-200 border border-red-800/50 disabled:opacity-50"
                  >
                    No lender identifiable
                  </button>
                </div>
              )}

              {showingManual && selectedPlantCode && (
                <div className="mb-4">
                  <ManualLenderForm
                    plantCode={selectedPlantCode}
                    plantName={plants.find(p => p.plantCode === selectedPlantCode)?.plantName}
                    onCancel={() => setShowingManual(false)}
                    onSuccess={async (_id, lenderName) => {
                      setShowingManual(false);
                      showToast(`Manual link saved: ${lenderName}`);
                      await refreshAll(selectedLender.lenderNormalized);
                    }}
                  />
                </div>
              )}

              <div className="space-y-2">
                {evidence.length === 0 ? (
                  <div className="text-sm text-slate-500 italic">No evidence on file for this plant + lender.</div>
                ) : (
                  evidence.map(ev => (
                    <EvidenceCard
                      key={ev.id}
                      evidence={ev}
                      plantCode={selectedPlantCode ?? undefined}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
            Select a lender on the left to begin validation.
          </div>
        )}
      </div>

      {/* Validate confirm modal */}
      {confirmingValidate && selectedLender && selectedPlantCode && (
        <ValidateConfirmModal
          lenderName={selectedLender.lenderName}
          plantCode={selectedPlantCode}
          plantName={plants.find(p => p.plantCode === selectedPlantCode)?.plantName ?? null}
          busy={busy}
          onCancel={() => setConfirmingValidate(null)}
          onConfirm={handleValidateConfirm}
        />
      )}
    </div>
  );
};

interface ConfirmProps {
  lenderName: string;
  plantCode: string;
  plantName: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}

const ValidateConfirmModal: React.FC<ConfirmProps> = ({ lenderName, plantCode, plantName, busy, onCancel, onConfirm }) => {
  const [note, setNote] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl max-w-md w-full p-6">
        <h3 className="text-lg font-bold text-white mb-2">Confirm lender validation</h3>
        <p className="text-sm text-slate-300 mb-4">
          Link <span className="font-semibold text-emerald-300">{lenderName}</span> to plant{' '}
          <span className="font-semibold">{plantName ?? plantCode}</span>?
        </p>
        <p className="text-xs text-slate-500 mb-3">
          This action is logged and the link will appear in the Validated tab.
        </p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Optional reviewer note…"
          className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 mb-4"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(note)}
            disabled={busy}
            className="px-3 py-1.5 text-xs font-semibold rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:bg-slate-700 disabled:cursor-not-allowed"
          >
            {busy ? 'Saving…' : 'Yes, validate'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ToValidateTab;
