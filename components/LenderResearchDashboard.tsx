import React, { useCallback, useEffect, useRef, useState } from 'react';
import LenderEvidenceTable, { LenderEvidenceRow } from './lender-validation/LenderEvidenceTable';
import {
  LenderPlantRow,
  LenderQueueRow,
  LenderValidatedRow,
  addManualLink,
  fetchLenderPlants,
  fetchLenderValidationQueue,
  fetchLenderValidatedPortfolio,
  rejectLink,
  setLenderPursuit,
  validateLink,
} from '../services/lenderResearchService';

interface Props {
  userRole: 'admin' | 'analyst' | 'viewer';
}

type Tab = 'queue' | 'validated';

const ROLE_OPTIONS = [
  { value: 'senior_debt', label: 'Senior Debt' },
  { value: 'mezzanine', label: 'Mezzanine' },
  { value: 'construction', label: 'Construction Loan' },
  { value: 'term_loan', label: 'Term Loan' },
  { value: 'refinancing', label: 'Refinancing' },
  { value: 'other', label: 'Other' },
];

const PURSUIT_OPTIONS: Array<{ value: 'hot' | 'warm' | 'cold' | null; label: string }> = [
  { value: null, label: '—' },
  { value: 'hot', label: 'Hot' },
  { value: 'warm', label: 'Warm' },
  { value: 'cold', label: 'Cold' },
];

// ── helpers ────────────────────────────────────────────────

function sourceDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.slice(0, 40); }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function pursuitBadge(label: 'hot' | 'warm' | 'cold' | null): React.ReactNode {
  if (!label) return <span className="text-slate-500 text-xs">—</span>;
  const cfg: Record<string, string> = {
    hot: 'border-rose-500/40 bg-rose-900/20 text-rose-400',
    warm: 'border-amber-500/40 bg-amber-900/20 text-amber-400',
    cold: 'border-sky-500/40 bg-sky-900/20 text-sky-400',
  };
  return (
    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border tracking-wider ${cfg[label]}`}>
      {label}
    </span>
  );
}

// ── Manual entry form ──────────────────────────────────────

interface ManualFormProps {
  plantId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

const ManualLenderForm: React.FC<ManualFormProps> = ({ plantId, onSuccess, onCancel }) => {
  const [lenderName, setLenderName] = useState('');
  const [role, setRole] = useState<string>('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [evidenceQuote, setEvidenceQuote] = useState('');
  const [manualNote, setManualNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = (): string | null => {
    if (!lenderName.trim()) return 'Lender name is required.';
    if (!sourceUrl.trim()) return 'Source URL is required.';
    if (!/^https?:\/\/.+/.test(sourceUrl.trim())) return 'Source URL must start with http:// or https://';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }
    setSubmitting(true);
    setError(null);
    try {
      await addManualLink({
        plantId,
        lenderName: lenderName.trim(),
        role: role || null,
        sourceUrl: sourceUrl.trim(),
        evidenceQuote: evidenceQuote.trim() || null,
        manualNote: manualNote.trim() || null,
      });
      onSuccess();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 bg-slate-900/60 border border-slate-700 rounded-xl p-5 space-y-4">
      <h4 className="text-sm font-semibold text-slate-200">Add manual lender</h4>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">
            Lender name <span className="text-rose-400">*</span>
          </label>
          <input
            type="text"
            value={lenderName}
            onChange={(e) => setLenderName(e.target.value)}
            placeholder="e.g. Wells Fargo"
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">— Not specified —</option>
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">
          Source URL <span className="text-rose-400">*</span>
        </label>
        <input
          type="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="https://..."
          className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">Evidence quote (optional)</label>
        <textarea
          value={evidenceQuote}
          onChange={(e) => setEvidenceQuote(e.target.value)}
          rows={2}
          placeholder="Paste a relevant excerpt from the source"
          className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
        />
      </div>

      <div>
        <label className="block text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">Note (optional)</label>
        <textarea
          value={manualNote}
          onChange={(e) => setManualNote(e.target.value)}
          rows={2}
          placeholder="Internal note about this entry"
          className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
        />
      </div>

      {error && <p className="text-rose-400 text-xs">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded text-sm font-semibold text-white transition-colors"
        >
          {submitting ? 'Saving…' : 'Save lender'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm text-slate-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
};

// ── Queue tab lender table ─────────────────────────────────

interface QueueTableProps {
  rows: LenderQueueRow[];
  onSelect: (id: string, name: string) => void;
}

const QueueTable: React.FC<QueueTableProps> = ({ rows, onSelect }) => {
  if (rows.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
        <p className="text-slate-500 text-sm">No lenders pending validation.</p>
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800/60 bg-slate-900/70">
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Lender</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5"># Plants</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5"># Pending</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5"># Validated</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Last Link</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.lenderId}
              className="border-b border-slate-800/30 last:border-b-0 hover:bg-slate-800/40 cursor-pointer transition-colors"
              onClick={() => onSelect(row.lenderId, row.lenderName)}
            >
              <td className="px-5 py-3 text-slate-200 font-semibold">{row.lenderName}</td>
              <td className="px-5 py-3 text-slate-400 text-xs">{row.distinctPlantCount}</td>
              <td className="px-5 py-3 text-xs">
                <span className="text-amber-400 font-semibold">{row.pendingCount}</span>
              </td>
              <td className="px-5 py-3 text-xs">
                <span className="text-emerald-400">{row.validatedCount}</span>
              </td>
              <td className="px-5 py-3 text-slate-400 text-xs">{fmtDate(row.mostRecentLinkAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ── Validated tab lender table ─────────────────────────────

interface PortfolioTableProps {
  rows: LenderValidatedRow[];
  canWrite: boolean;
  onSelect: (id: string, name: string) => void;
  onPursuitChange: (lenderId: string, label: 'hot' | 'warm' | 'cold' | null) => void;
}

const PortfolioTable: React.FC<PortfolioTableProps> = ({ rows, canWrite, onSelect, onPursuitChange }) => {
  if (rows.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
        <p className="text-slate-500 text-sm">No validated lenders yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800/60 bg-slate-900/70">
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Lender</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5"># Validated Plants</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Pursuit</th>
            <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Last Validated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.lenderId}
              className="border-b border-slate-800/30 last:border-b-0 hover:bg-slate-800/40 cursor-pointer transition-colors"
              onClick={() => onSelect(row.lenderId, row.lenderName)}
            >
              <td className="px-5 py-3 text-slate-200 font-semibold">{row.lenderName}</td>
              <td className="px-5 py-3 text-slate-400 text-xs">{row.distinctValidatedPlantCount}</td>
              <td
                className="px-5 py-3 text-xs"
                onClick={(e) => { if (canWrite) e.stopPropagation(); }}
              >
                {canWrite ? (
                  <select
                    value={row.pursuitLabel ?? ''}
                    onChange={(e) => {
                      const val = e.target.value || null;
                      onPursuitChange(row.lenderId, val as 'hot' | 'warm' | 'cold' | null);
                    }}
                    className="bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {PURSUIT_OPTIONS.map((o) => (
                      <option key={String(o.value)} value={o.value ?? ''}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  pursuitBadge(row.pursuitLabel)
                )}
              </td>
              <td className="px-5 py-3 text-slate-400 text-xs">{fmtDate(row.mostRecentValidationAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ── Main component ─────────────────────────────────────────

const LenderResearchDashboard: React.FC<Props> = ({ userRole }) => {
  const canWrite = userRole === 'admin' || userRole === 'analyst';

  // Navigation state
  const [activeTab, setActiveTab] = useState<Tab>('queue');
  const [selectedLenderId, setSelectedLenderId] = useState<string | null>(null);
  const [selectedLenderName, setSelectedLenderName] = useState<string>('');
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  const [selectedPlantName, setSelectedPlantName] = useState<string>('');
  const [search, setSearch] = useState('');

  // Data
  const [queueRows, setQueueRows] = useState<LenderQueueRow[]>([]);
  const [portfolioRows, setPortfolioRows] = useState<LenderValidatedRow[]>([]);
  const [plantRows, setPlantRows] = useState<LenderPlantRow[]>([]);
  const [evidenceRows, setEvidenceRows] = useState<LenderPlantRow[]>([]);

  // Loading
  const [loadingList, setLoadingList] = useState(false);
  const [loadingPlants, setLoadingPlants] = useState(false);
  const [loadingEvidence, setLoadingEvidence] = useState(false);

  // Manual form
  const [showManualForm, setShowManualForm] = useState(false);

  const activeTabRef = useRef(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // ── Data fetchers ──────────────────────────────────────

  const loadLenderList = useCallback(async (tab: Tab, q: string) => {
    setLoadingList(true);
    if (tab === 'queue') {
      const rows = await fetchLenderValidationQueue(q);
      setQueueRows(rows);
    } else {
      const rows = await fetchLenderValidatedPortfolio(q);
      setPortfolioRows(rows);
    }
    setLoadingList(false);
  }, []);

  const loadPlants = useCallback(async (lenderId: string, tab: Tab) => {
    setLoadingPlants(true);
    const scope = tab === 'queue' ? 'pending' : 'validated';
    const rows = await fetchLenderPlants(lenderId, scope);
    setPlantRows(rows);
    setLoadingPlants(false);
  }, []);

  const loadEvidence = useCallback(async (lenderId: string, plantId: string) => {
    setLoadingEvidence(true);
    const rows = await fetchLenderPlants(lenderId, 'all');
    setEvidenceRows(rows.filter((r) => r.plantId === plantId));
    setLoadingEvidence(false);
  }, []);

  // Initial + tab/search changes
  useEffect(() => {
    loadLenderList(activeTab, search);
  }, [activeTab, search, loadLenderList]);

  useEffect(() => {
    if (selectedLenderId) loadPlants(selectedLenderId, activeTab);
  }, [selectedLenderId, activeTab, loadPlants]);

  useEffect(() => {
    if (selectedLenderId && selectedPlantId) loadEvidence(selectedLenderId, selectedPlantId);
  }, [selectedLenderId, selectedPlantId, loadEvidence]);

  // ── Action handlers ────────────────────────────────────

  const handleValidate = async (linkId: string) => {
    if (!window.confirm('Mark this lender-plant link as validated?')) return;
    await validateLink(linkId);
    await Promise.all([
      loadLenderList(activeTab, search),
      selectedLenderId && selectedPlantId ? loadEvidence(selectedLenderId, selectedPlantId) : Promise.resolve(),
      selectedLenderId ? loadPlants(selectedLenderId, activeTab) : Promise.resolve(),
    ]);
  };

  const handleReject = async (linkId: string, reason: string | null) => {
    await rejectLink(linkId, reason);
    await Promise.all([
      loadLenderList(activeTab, search),
      selectedLenderId && selectedPlantId ? loadEvidence(selectedLenderId, selectedPlantId) : Promise.resolve(),
      selectedLenderId ? loadPlants(selectedLenderId, activeTab) : Promise.resolve(),
    ]);
  };

  const handleManualSuccess = async () => {
    setShowManualForm(false);
    await Promise.all([
      loadLenderList(activeTab, search),
      selectedLenderId && selectedPlantId ? loadEvidence(selectedLenderId, selectedPlantId) : Promise.resolve(),
      selectedLenderId ? loadPlants(selectedLenderId, activeTab) : Promise.resolve(),
    ]);
  };

  const handlePursuitChange = async (lenderId: string, label: 'hot' | 'warm' | 'cold' | null) => {
    await setLenderPursuit(lenderId, label);
    loadLenderList('validated', search);
  };

  // ── Navigation helpers ────────────────────────────────

  const handleSelectLender = (id: string, name: string) => {
    setSelectedLenderId(id);
    setSelectedLenderName(name);
    setSelectedPlantId(null);
    setSelectedPlantName('');
    setShowManualForm(false);
  };

  const handleSelectPlant = (plantId: string, plantName: string) => {
    setSelectedPlantId(plantId);
    setSelectedPlantName(plantName);
    setShowManualForm(false);
  };

  const handleBackToLenders = () => {
    setSelectedLenderId(null);
    setSelectedLenderName('');
    setSelectedPlantId(null);
    setSelectedPlantName('');
    setShowManualForm(false);
  };

  const handleBackToPlants = () => {
    setSelectedPlantId(null);
    setSelectedPlantName('');
    setShowManualForm(false);
  };

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setSelectedLenderId(null);
    setSelectedLenderName('');
    setSelectedPlantId(null);
    setSelectedPlantName('');
    setSearch('');
    setShowManualForm(false);
  };

  // ── Convert LenderPlantRow → LenderEvidenceRow ─────────

  const toEvidenceRows = (rows: LenderPlantRow[]): LenderEvidenceRow[] =>
    rows.map((r) => ({
      lenderName: selectedLenderName,
      role: r.role,
      roleSummary: r.roleSummary,
      sourceUrl: r.sourceUrl,
      evidenceQuote: r.evidenceQuote,
      inferred: false,
      linkId: r.linkId,
      isManual: r.isManual,
      manualNote: r.manualNote,
      validationState: r.validationState,
    }));

  // ── Render ─────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Tab bar (only at Level 1) */}
      {!selectedLenderId && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1 bg-slate-900/60 rounded-lg p-1 border border-slate-800">
            {(['queue', 'validated'] as Tab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => handleTabChange(tab)}
                className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-colors ${
                  activeTab === tab
                    ? 'bg-blue-700 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab === 'queue' ? 'To Be Validated' : 'Validated'}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search lenders…"
            className="ml-auto w-56 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      )}

      {/* ── Level 3: Plant evidence ── */}
      {selectedLenderId && selectedPlantId && (
        <div>
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <button
              onClick={handleBackToPlants}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              ← Back to {selectedLenderName}
            </button>
            <span className="text-slate-600">/</span>
            <span className="text-sm font-semibold text-slate-200">{selectedPlantName}</span>
          </div>

          <LenderEvidenceTable
            rows={toEvidenceRows(evidenceRows)}
            loading={loadingEvidence}
            emptyMessage="No evidence rows for this plant."
            actions={canWrite ? { onValidate: handleValidate, onReject: handleReject } : undefined}
          />

          {canWrite && !showManualForm && (
            <button
              onClick={() => setShowManualForm(true)}
              className="mt-3 text-sm text-blue-400 hover:text-blue-300 border border-blue-500/30 rounded-lg px-4 py-1.5 transition-colors"
            >
              + Add manual lender
            </button>
          )}

          {canWrite && showManualForm && (
            <ManualLenderForm
              plantId={selectedPlantId}
              onSuccess={handleManualSuccess}
              onCancel={() => setShowManualForm(false)}
            />
          )}
        </div>
      )}

      {/* ── Level 2: Plant list ── */}
      {selectedLenderId && !selectedPlantId && (
        <div>
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <button
              onClick={handleBackToLenders}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              ← Back to lenders
            </button>
            <span className="text-slate-600">/</span>
            <span className="text-sm font-semibold text-slate-200">{selectedLenderName}</span>
          </div>

          {loadingPlants ? (
            <div className="flex items-center justify-center py-16 gap-3 text-slate-400">
              <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-blue-500" />
              <span className="text-sm">Loading plants…</span>
            </div>
          ) : plantRows.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
              <p className="text-slate-500 text-sm">No plants found for this lender in this scope.</p>
            </div>
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800/60 bg-slate-900/70">
                    <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Plant</th>
                    <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">State</th>
                    <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">MW</th>
                    <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Role</th>
                    <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Source</th>
                    <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Status</th>
                    <th className="text-left text-[10px] text-slate-500 font-bold uppercase tracking-wider px-5 py-2.5">Last Research</th>
                  </tr>
                </thead>
                <tbody>
                  {plantRows.map((row) => (
                    <tr
                      key={row.linkId}
                      className="border-b border-slate-800/30 last:border-b-0 hover:bg-slate-800/40 cursor-pointer transition-colors"
                      onClick={() => handleSelectPlant(row.plantId, row.plantName)}
                    >
                      <td className="px-5 py-3 text-slate-200 font-semibold">{row.plantName}</td>
                      <td className="px-5 py-3 text-slate-400 text-xs">{row.state ?? '—'}</td>
                      <td className="px-5 py-3 text-slate-400 text-xs">{row.nameplateMw != null ? row.nameplateMw.toLocaleString() : '—'}</td>
                      <td className="px-5 py-3 text-slate-300 text-xs">{row.role ?? '—'}</td>
                      <td className="px-5 py-3 text-slate-400 text-xs">{sourceDomain(row.sourceUrl)}</td>
                      <td className="px-5 py-3 text-xs">
                        {row.validationState === 'validated' && (
                          <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-900/20 text-emerald-400">Validated</span>
                        )}
                        {row.validationState === 'rejected' && (
                          <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded border border-rose-500/40 bg-rose-900/20 text-rose-400">Rejected</span>
                        )}
                        {row.validationState === 'pending' && (
                          <span className="text-[9px] font-bold uppercase px-2 py-0.5 rounded border border-slate-600 text-slate-500">Pending</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-slate-400 text-xs">{fmtDate(row.lastResearchAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Level 1: Lender list ── */}
      {!selectedLenderId && (
        <>
          {loadingList ? (
            <div className="flex items-center justify-center py-16 gap-3 text-slate-400">
              <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-blue-500" />
              <span className="text-sm">Loading lenders…</span>
            </div>
          ) : activeTab === 'queue' ? (
            <QueueTable rows={queueRows} onSelect={handleSelectLender} />
          ) : (
            <PortfolioTable
              rows={portfolioRows}
              canWrite={canWrite}
              onSelect={handleSelectLender}
              onPursuitChange={handlePursuitChange}
            />
          )}
        </>
      )}
    </div>
  );
};

export default LenderResearchDashboard;
