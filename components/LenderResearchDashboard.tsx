import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchUCCResearchPlants,
  fetchLenderLeads,
  fetchReviewQueue,
  fetchAgentRuns,
  fetchAgentTasks,
  fetchUnverifiedLeads,
  fetchPitchReadyLeads,
  fetchStateScraperHealth,
  fetchEvidenceProvenance,
  markPitchReady,
  runSinglePlantResearch,
  runBatchResearch,
  submitReviewAction,
  ensurePlantResearchRecord,
  UCCResearchPlant,
  LenderLeadSummary,
  ReviewQueueItem,
  UCCAgentRun,
  UCCAgentTask,
  UCCUnverifiedLead,
  UCCPitchReadyLead,
  UCCStateScraperHealthRow,
  UCCEvidenceProvenanceRow,
  WorkflowStatus,
  SupervisorResult,
} from '../services/uccResearchService';
import UCCPlantDetail from './UCCPlantDetail';

interface Props {
  userRole: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMw(mw: number | null): string {
  if (mw == null) return '—';
  if (mw >= 1000) return `${(mw / 1000).toFixed(1)} GW`;
  return `${Math.round(mw).toLocaleString()} MW`;
}

function fmtCost(cost: number | null): string {
  if (cost == null) return '—';
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const min  = Math.floor(diff / 60_000);
  if (min < 1)   return 'Just now';
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<WorkflowStatus, string> = {
  pending:        'bg-slate-800 text-slate-400',
  running:        'bg-blue-900/40 text-blue-300 animate-pulse',
  complete:       'bg-emerald-900/40 text-emerald-300',
  unresolved:     'bg-red-900/40 text-red-400',
  needs_review:   'bg-amber-900/40 text-amber-300',
  partial:        'bg-cyan-900/40 text-cyan-300',
  budget_exceeded:'bg-yellow-900/40 text-yellow-300',
};

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  pending:        'Pending',
  running:        'Running',
  complete:       'Complete',
  unresolved:     'Unresolved',
  needs_review:   'Needs Review',
  partial:        'Partial (News Only)',
  budget_exceeded:'Budget Exceeded',
};

function StatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

// ── Confidence badge ──────────────────────────────────────────────────────────

const CONF_STYLES: Record<string, string> = {
  confirmed:     'bg-emerald-900/40 text-emerald-300',
  highly_likely: 'bg-amber-900/40 text-amber-300',
  possible:      'bg-slate-700 text-slate-400',
};

const CONF_LABELS: Record<string, string> = {
  confirmed:     'CONFIRMED',
  highly_likely: 'LIKELY',
  possible:      'POSSIBLE',
};

function ConfBadge({ cls }: { cls: string }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide ${CONF_STYLES[cls] ?? 'bg-slate-700 text-slate-400'}`}>
      {CONF_LABELS[cls] ?? cls}
    </span>
  );
}

// ── Sub-tab types ─────────────────────────────────────────────────────────────

type SubTab = 'plants' | 'leads' | 'unverified' | 'review' | 'pitch_ready' | 'trace' | 'scraper';

const PAGE_SIZE = 50;

// ── Main component ────────────────────────────────────────────────────

const LenderResearchDashboard: React.FC<Props> = ({ userRole }) => {
  const isAdmin = userRole === 'admin';
  const [subTab, setSubTab]       = useState<SubTab>('plants');
  const [plants, setPlants]       = useState<UCCResearchPlant[]>([]);
  const [leads, setLeads]         = useState<LenderLeadSummary[]>([]);
  const [queue, setQueue]         = useState<ReviewQueueItem[]>([]);
  const [unverified, setUnverified] = useState<UCCUnverifiedLead[]>([]);
  const [pitchReady, setPitchReady] = useState<UCCPitchReadyLead[]>([]);
  const [loading, setLoading]     = useState(true);
  const [running, setRunning]     = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResult, setBatchResult]   = useState<SupervisorResult | null>(null);
  const [pitchActionId, setPitchActionId] = useState<number | null>(null);
  const [scraperHealth, setScraperHealth]         = useState<UCCStateScraperHealthRow[]>([]);
  const [evidenceProvenance, setEvidenceProvenance] = useState<UCCEvidenceProvenanceRow[]>([]);

  // Filters
  const [search, setSearch]         = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<WorkflowStatus | 'all'>('all');

  // Detail view
  const [selectedPlant, setSelectedPlant] = useState<UCCResearchPlant | null>(null);

  // Pagination
  const [plantPage, setPlantPage] = useState(0);

  // Run trace
  const [traceRuns, setTraceRuns]   = useState<UCCAgentRun[]>([]);
  const [traceTasks, setTraceTasks] = useState<UCCAgentTask[]>([]);
  const [traceRunId, setTraceRunId] = useState<string | null>(null);
  const [tracePlant, setTracePlant] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [p, l, q, u, pr, sh, ep] = await Promise.all([
      fetchUCCResearchPlants({ state: stateFilter !== 'all' ? stateFilter : undefined }),
      fetchLenderLeads(),
      fetchReviewQueue(),
      fetchUnverifiedLeads(),
      fetchPitchReadyLeads(),
      fetchStateScraperHealth(),
      fetchEvidenceProvenance(),
    ]);
    setPlants(p);
    setLeads(l);
    setQueue(q);
    setUnverified(u);
    setPitchReady(pr);
    setScraperHealth(sh);
    setEvidenceProvenance(ep);
    setLoading(false);
  }, [stateFilter]);

  useEffect(() => { load(); }, [load]);

  // ── Run single plant ──────────────────────────────────────────────────────

  const handleRunPlant = async (plant: UCCResearchPlant, budgetUsd?: number) => {
    if (running.has(plant.plant_code)) return;

    setRunning(prev => new Set([...prev, plant.plant_code]));
    setPlants(prev => prev.map(p =>
      p.plant_code === plant.plant_code ? { ...p, workflow_status: 'running' } : p
    ));

    try {
      await ensurePlantResearchRecord(plant.plant_code);
      await runSinglePlantResearch(plant.plant_code, budgetUsd);
      await load();
    } finally {
      setRunning(prev => { const s = new Set(prev); s.delete(plant.plant_code); return s; });
    }
  };

  // ── Batch run ─────────────────────────────────────────────────────────────

  const handleBatchRun = async () => {
    if (batchRunning) return;
    setBatchRunning(true);
    setBatchResult(null);
    try {
      const result = await runBatchResearch({ max_plants: 20, budget_usd: 5 });
      setBatchResult(result);
      await load();
    } finally {
      setBatchRunning(false);
    }
  };

  // ── Review action ─────────────────────────────────────────────────────────

  const handleReviewAction = async (
    item:   ReviewQueueItem,
    action: 'approve' | 'reject' | 'rerun' | 'needs_more',
  ) => {
    await submitReviewAction(item.lender_link_id, item.plant_code, action);
    setQueue(prev => prev.filter(q => q.lender_link_id !== item.lender_link_id));
  };
  // ── Pitch-ready toggle (admin only) ────────────────────────────────

  const handlePitchReadyToggle = async (item: ReviewQueueItem | UCCPitchReadyLead, ready: boolean) => {
    if (!isAdmin) {
      alert('Only admin reviewers can mark a lender link pitch-ready.');
      return;
    }
    const linkId = (item as UCCPitchReadyLead).lender_link_id ?? (item as ReviewQueueItem).lender_link_id;
    setPitchActionId(linkId);
    try {
      const note = ready ? (window.prompt('Optional note to record with pitch-ready sign-off:') ?? null) : null;
      await markPitchReady(linkId, ready, note);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Could not update pitch-ready: ${msg}`);
    } finally {
      setPitchActionId(null);
    }
  };
  // ── Run trace ─────────────────────────────────────────────────────────────

  const openTrace = async (plantCode: string) => {
    setSubTab('trace');
    setTracePlant(plantCode);
    setTraceRunId(null);
    setTraceTasks([]);
    const runs = await fetchAgentRuns(plantCode);
    setTraceRuns(runs);
  };

  const loadTraceTasks = async (runId: string) => {
    setTraceRunId(runId);
    const tasks = await fetchAgentTasks(runId);
    setTraceTasks(tasks);
  };

  // ── Filtered plants ───────────────────────────────────────────────────────

  const filteredPlants = plants.filter(p => {
    if (statusFilter !== 'all' && p.workflow_status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!p.plant_name.toLowerCase().includes(q) && !(p.sponsor_name ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const totalPages  = Math.max(1, Math.ceil(filteredPlants.length / PAGE_SIZE));
  const pagedPlants = filteredPlants.slice(plantPage * PAGE_SIZE, (plantPage + 1) * PAGE_SIZE);

  const states = [...new Set(plants.map(p => p.state))].sort();

  // ── If plant detail open ──────────────────────────────────────────────────

  if (selectedPlant) {
    return (
      <UCCPlantDetail
        plant={selectedPlant}
        onBack={() => setSelectedPlant(null)}
        onRun={() => handleRunPlant(selectedPlant)}
        onRunWithBudget={(budget) => handleRunPlant(selectedPlant, budget)}
        running={running.has(selectedPlant.plant_code)}
      />
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">Lender Research</h1>
            <p className="text-xs text-slate-400 mt-0.5">UCC filings · County records · SEC EDGAR · Legal-trail lender discovery</p>
          </div>

          <div className="flex items-center gap-3">
            {batchResult && (
              <span className="text-xs text-slate-400">
                Batch: {batchResult.completed} done · {batchResult.needs_review} review · {fmtCost(batchResult.total_cost_usd)} spent
              </span>
            )}
            <button
              onClick={handleBatchRun}
              disabled={batchRunning}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-amber-900/40 disabled:text-amber-700 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              {batchRunning ? (
                <span className="flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="30 70" />
                  </svg>
                  Running…
                </span>
              ) : 'Run All Pending'}
            </button>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="flex gap-1 mt-4 flex-wrap">
          {(['plants', 'leads', 'unverified', 'review', 'pitch_ready', 'scraper', 'trace'] as SubTab[]).map(tab => {
            const label =
              tab === 'pitch_ready' ? `Pitch Ready ${pitchReady.length > 0 ? `(${pitchReady.length})` : ''}`
              : tab === 'unverified'  ? `Unverified ${unverified.length > 0 ? `(${unverified.length})` : ''}`
              : tab === 'review'      ? `Review ${queue.length > 0 ? `(${queue.length})` : ''}`
              : tab === 'scraper'     ? 'Scraper Pipeline'
              : tab.charAt(0).toUpperCase() + tab.slice(1);
            return (
              <button
                key={tab}
                onClick={() => setSubTab(tab)}
                className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  subTab === tab
                    ? 'bg-amber-600/20 text-amber-300 border border-amber-600/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">

        {/* ── Plants tab ───────────────────────────────────────────────────── */}
        {subTab === 'plants' && (
          <>
            {/* Filters */}
            <div className="flex gap-3 mb-4">
              <input
                type="text"
                placeholder="Search plants or sponsors…"
                value={search}
                onChange={e => { setSearch(e.target.value); setPlantPage(0); }}
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-600"
              />
              <select
                value={stateFilter}
                onChange={e => { setStateFilter(e.target.value); setPlantPage(0); }}
                className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-600"
              >
                <option value="all">All States</option>
                {states.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select
                value={statusFilter}
                onChange={e => { setStatusFilter(e.target.value as WorkflowStatus | 'all'); setPlantPage(0); }}
                className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-amber-600"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="running">Running</option>
                <option value="complete">Complete</option>
                <option value="needs_review">Needs Review</option>
                <option value="partial">Partial (News Only)</option>
                <option value="budget_exceeded">Budget Exceeded</option>
                <option value="unresolved">Unresolved</option>
              </select>
            </div>

            {loading ? (
              <div className="text-center text-slate-500 py-16 text-sm">Loading plants…</div>
            ) : filteredPlants.length === 0 ? (
              <div className="text-center text-slate-500 py-16 text-sm">No plants found. Plants will appear here after running research.</div>
            ) : (
              <>
              <div className="space-y-1">
                {pagedPlants.map(plant => (
                  <div
                    key={plant.plant_code}
                    className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 flex items-center gap-4 hover:border-slate-700 transition-colors"
                  >
                    {/* Left: plant info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white text-sm truncate">{plant.plant_name}</span>
                        <StatusBadge status={plant.workflow_status} />
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {plant.state} · {fmtMw(plant.capacity_mw)} · {plant.technology ?? '—'}
                        {plant.sponsor_name && <> · <span className="text-slate-300">{plant.sponsor_name}</span></>}
                      </div>
                    </div>

                    {/* Cost + last run */}
                    <div className="text-right text-xs text-slate-500 hidden sm:block">
                      {plant.total_cost_usd != null && <div>{fmtCost(plant.total_cost_usd)}</div>}
                      <div>{timeAgo(plant.last_run_at)}</div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => setSelectedPlant(plant)}
                        className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors"
                      >
                        View
                      </button>
                      <button
                        onClick={() => openTrace(plant.plant_code)}
                        className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg transition-colors"
                      >
                        Trace
                      </button>
                      <button
                        onClick={() => handleRunPlant(plant)}
                        disabled={running.has(plant.plant_code) || plant.workflow_status === 'running'}
                        className="px-3 py-1.5 text-xs bg-amber-700 hover:bg-amber-600 disabled:bg-amber-900/30 disabled:text-amber-800 text-white rounded-lg transition-colors font-medium"
                      >
                        {running.has(plant.plant_code) || plant.workflow_status === 'running' ? (
                          <span className="flex items-center gap-1">
                            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="30 70" />
                            </svg>
                            Running
                          </span>
                        ) : plant.workflow_status === 'complete' ? 'Re-run' : 'Run Research'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination controls */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-800">
                  <span className="text-xs text-slate-500">
                    {plantPage * PAGE_SIZE + 1}–{Math.min((plantPage + 1) * PAGE_SIZE, filteredPlants.length)} of {filteredPlants.length} plants
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPlantPage(0)}
                      disabled={plantPage === 0}
                      className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      «
                    </button>
                    <button
                      onClick={() => setPlantPage(p => Math.max(0, p - 1))}
                      disabled={plantPage === 0}
                      className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      ‹
                    </button>
                    {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                      // Show pages around current page
                      const half  = 3;
                      let start   = Math.max(0, plantPage - half);
                      const end   = Math.min(totalPages, start + 7);
                      start       = Math.max(0, end - 7);
                      return start + i;
                    }).map(pg => (
                      <button
                        key={pg}
                        onClick={() => setPlantPage(pg)}
                        className={`w-7 h-7 text-xs rounded ${
                          pg === plantPage
                            ? 'bg-amber-600/30 text-amber-300 font-semibold'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                        }`}
                      >
                        {pg + 1}
                      </button>
                    ))}
                    <button
                      onClick={() => setPlantPage(p => Math.min(totalPages - 1, p + 1))}
                      disabled={plantPage >= totalPages - 1}
                      className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      ›
                    </button>
                    <button
                      onClick={() => setPlantPage(totalPages - 1)}
                      disabled={plantPage >= totalPages - 1}
                      className="px-2 py-1 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      »
                    </button>
                  </div>
                </div>
              )}
              </>
            )}
          </>
        )}

        {/* ── Lender Leads tab ──────────────────────────────────────────── */}
        {subTab === 'leads' && (
          <>
            <p className="text-xs text-slate-400 mb-4">
              Lenders aggregated across all researched plants. Sorted by plant count.
            </p>
            {leads.length === 0 ? (
              <div className="text-center text-slate-500 py-16 text-sm">No lender leads yet. Run research on some plants to generate leads.</div>
            ) : (
              <div className="space-y-1">
                {leads.map(lead => (
                  <div key={lead.lender_entity_id} className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-white text-sm">{lead.lender_name}</div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {lead.states.slice(0, 4).join(' · ')}
                        {lead.states.length > 4 && ` +${lead.states.length - 4}`}
                      </div>
                      {lead.sponsors.length > 0 && (
                        <div className="text-xs text-slate-500 mt-0.5 truncate">
                          Sponsors: {lead.sponsors.slice(0, 3).join(', ')}
                          {lead.sponsors.length > 3 && ` +${lead.sponsors.length - 3}`}
                        </div>
                      )}
                    </div>

                    <div className="text-right text-sm">
                      <div className="font-bold text-white">{lead.plant_count} <span className="text-xs font-normal text-slate-400">plants</span></div>
                      <div className="flex items-center gap-1.5 justify-end mt-1">
                        {lead.confirmed_count > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-emerald-900/40 text-emerald-300 rounded-full">
                            {lead.confirmed_count} confirmed
                          </span>
                        )}
                        {lead.inferred_count > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-amber-900/40 text-amber-300 rounded-full">
                            {lead.inferred_count} inferred
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Unverified Leads tab ───────────────────────────────────── */}
        {subTab === 'unverified' && (
          <>
            <div className="mb-4 px-4 py-3 bg-amber-900/10 border border-amber-700/30 rounded-lg">
              <p className="text-xs text-amber-200 font-medium">⚠ LLM-inferred / news-derived leads — NOT citation-backed</p>
              <p className="text-[11px] text-amber-200/70 mt-0.5">
                These candidates came from Perplexity, Gemini, sponsor-history pattern matching,
                or web scrapes. They have no direct UCC/county/EDGAR filing as proof.
                Use as research starting points only — never share with a lender as a confirmed fact.
              </p>
            </div>
            {unverified.length === 0 ? (
              <div className="text-center text-slate-500 py-16 text-sm">No unverified leads.</div>
            ) : (
              <div className="space-y-1">
                {unverified.map(item => (
                  <div key={item.id} className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-white text-sm">{item.lender_name || '(unnamed entity)'}</span>
                          <ConfBadge cls={item.confidence_class} />
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-400 uppercase tracking-wide">
                            {item.evidence_type.replace(/_/g, ' ')}
                          </span>
                          {item.llm_model && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-900/40 text-amber-300 uppercase tracking-wide">
                              {item.llm_model}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          Plant {item.plant_code}
                          {item.source_types.length > 0 && <> · {item.source_types.join(' · ')}</>}
                        </div>
                        {item.evidence_summary && (
                          <p className="text-xs text-slate-500 mt-1 line-clamp-2">{item.evidence_summary}</p>
                        )}
                        {item.source_url && (
                          <a href={item.source_url} target="_blank" rel="noopener noreferrer"
                             className="text-xs text-blue-400 hover:text-blue-300 mt-1 block truncate">
                            {item.source_url}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Pitch Ready tab ────────────────────────────────────────── */}
        {subTab === 'pitch_ready' && (
          <>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs text-emerald-300 font-medium">✓ Citation-backed, admin-blessed lender attributions</p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Every row has a UCC / county / EDGAR source URL on the trusted whitelist
                  AND has been signed off by a designated reviewer.
                  This is the partner-facing list — safe to share with the lender during pitch prep.
                </p>
              </div>
              {pitchReady.length > 0 && (
                <a
                  href={`data:text/csv;charset=utf-8,${encodeURIComponent(
                    'plant_code,plant_name,state,capacity_mw,sponsor_name,lender_name,confidence,evidence_type,source_url,signed_off_at,note\n' +
                    pitchReady.map(r => [
                      r.plant_code, r.plant_name, r.state, r.capacity_mw ?? '',
                      r.sponsor_name ?? '', r.lender_name, r.confidence_class,
                      r.evidence_type, r.source_url ?? '', r.pitch_ready_at ?? '',
                      (r.pitch_ready_note ?? '').replace(/[\n,]/g, ' ')
                    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
                  )}`}
                  download={`pitch-ready-leads-${new Date().toISOString().slice(0, 10)}.csv`}
                  className="text-xs px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg"
                >
                  Export CSV
                </a>
              )}
            </div>

            {pitchReady.length === 0 ? (
              <div className="text-center text-slate-500 py-16 text-sm">
                No pitch-ready leads yet.
                {isAdmin && <> Approve a confirmed link from the Review tab to add one.</>}
              </div>
            ) : (
              <div className="space-y-1">
                {pitchReady.map(item => (
                  <div key={item.lender_link_id} className="bg-slate-900 border border-emerald-800/40 rounded-xl px-4 py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-white text-sm">{item.plant_name}</span>
                          <span className="text-xs text-slate-500">{item.state}</span>
                          <span className="text-xs text-slate-500">{fmtMw(item.capacity_mw)}</span>
                          <ConfBadge cls={item.confidence_class} />
                        </div>
                        <div className="text-sm text-emerald-300 font-medium mt-1">{item.lender_name}</div>
                        {item.sponsor_name && (
                          <div className="text-xs text-slate-400 mt-0.5">Sponsor: {item.sponsor_name}</div>
                        )}
                        {item.evidence_summary && (
                          <p className="text-xs text-slate-500 mt-1 line-clamp-2">{item.evidence_summary}</p>
                        )}
                        {item.source_url && (
                          <a href={item.source_url} target="_blank" rel="noopener noreferrer"
                             className="text-xs text-blue-400 hover:text-blue-300 mt-1 block truncate">
                            {item.source_url}
                          </a>
                        )}
                        <div className="text-[11px] text-slate-500 mt-1">
                          Signed off {item.pitch_ready_at ? timeAgo(item.pitch_ready_at) : '—'}
                          {item.pitch_ready_note && <> · "{item.pitch_ready_note}"</>}
                        </div>
                      </div>
                      {isAdmin && (
                        <button
                          onClick={() => handlePitchReadyToggle(item, false)}
                          disabled={pitchActionId === item.lender_link_id}
                          className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-red-900/40 text-slate-400 hover:text-red-400 rounded-lg transition-colors flex-shrink-0"
                        >
                          {pitchActionId === item.lender_link_id ? '…' : 'Unmark'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Review Queue tab ──────────────────────────────────────────── */}
        {subTab === 'review' && (
          <>
            <p className="text-xs text-slate-400 mb-4">
              Lender candidates flagged for human review. Approve to surface in Lender Leads.
            </p>
            {queue.length === 0 ? (
              <div className="text-center text-slate-500 py-16 text-sm">Review queue is empty.</div>
            ) : (
              <div className="space-y-2">
                {queue.map(item => (
                  <div key={item.lender_link_id} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-white text-sm">{item.plant_name}</span>
                          <span className="text-xs text-slate-500">{item.state}</span>
                          <ConfBadge cls={item.confidence_class} />
                        </div>
                        <div className="text-sm text-amber-300 font-medium mt-1">{item.lender_name}</div>
                        <p className="text-xs text-slate-400 mt-1 line-clamp-2">{item.evidence_summary}</p>
                        {item.source_url && (
                          <a
                            href={item.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-400 hover:text-blue-300 mt-1 block truncate"
                          >
                            {item.source_url}
                          </a>
                        )}
                      </div>

                      <div className="flex flex-col gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => handleReviewAction(item, 'approve')}
                          className="px-3 py-1.5 text-xs bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg transition-colors font-medium"
                        >
                          Approve
                        </button>
                        {isAdmin && item.confidence_class === 'confirmed' && item.source_url && (
                          <button
                            onClick={() => handlePitchReadyToggle(item, true)}
                            disabled={pitchActionId === item.lender_link_id}
                            className="px-3 py-1.5 text-xs bg-amber-700 hover:bg-amber-600 disabled:bg-amber-900/40 text-white rounded-lg transition-colors font-medium"
                            title="Sign off as pitch-ready (admin only). Requires confirmed + trusted source URL."
                          >
                            {pitchActionId === item.lender_link_id ? '…' : 'Pitch Ready'}
                          </button>
                        )}
                        <button
                          onClick={() => handleReviewAction(item, 'reject')}
                          className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-red-900/40 text-slate-400 hover:text-red-400 rounded-lg transition-colors"
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => handleReviewAction(item, 'rerun')}
                          className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg transition-colors"
                        >
                          Re-run
                        </button>
                        <button
                          onClick={() => handleReviewAction(item, 'needs_more')}
                          className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg transition-colors"
                        >
                          Needs More
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Run Trace tab ─────────────────────────────────────────────── */}
        {subTab === 'trace' && (
          <>
            {!tracePlant ? (
              <div className="text-center text-slate-500 py-16 text-sm">
                Click "Trace" on a plant in the Plants tab to view its run history.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-4">
                  <button
                    onClick={() => { setSubTab('plants'); setTracePlant(null); }}
                    className="text-xs text-slate-400 hover:text-slate-200"
                  >
                    ← Back to Plants
                  </button>
                  <span className="text-xs text-slate-600">/</span>
                  <span className="text-xs text-slate-300">{tracePlant}</span>
                </div>

                {traceRuns.length === 0 ? (
                  <div className="text-slate-500 text-sm">No runs found for this plant.</div>
                ) : (
                  <div className="flex gap-4">
                    {/* Run list */}
                    <div className="w-64 flex-shrink-0 space-y-1">
                      {traceRuns.map(run => (
                        <button
                          key={run.id}
                          onClick={() => loadTraceTasks(run.id)}
                          className={`w-full text-left p-3 rounded-lg border transition-colors ${
                            traceRunId === run.id
                              ? 'border-amber-600/50 bg-amber-900/10'
                              : 'border-slate-800 bg-slate-900 hover:border-slate-700'
                          }`}
                        >
                          <div className="text-xs font-medium text-slate-200">{timeAgo(run.started_at)}</div>
                          <div className="text-xs text-slate-500 mt-0.5">{run.final_outcome ?? run.supervisor_status}</div>
                          {run.total_cost_usd != null && (
                            <div className="text-xs text-slate-600">{fmtCost(run.total_cost_usd)}</div>
                          )}
                        </button>
                      ))}
                    </div>

                    {/* Task list */}
                    <div className="flex-1 space-y-1">
                      {traceTasks.length === 0 ? (
                        <div className="text-slate-500 text-sm">Select a run to view worker tasks.</div>
                      ) : (
                        traceTasks.map(task => (
                          <div key={task.id} className="bg-slate-900 border border-slate-800 rounded-lg px-4 py-3">
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="text-sm font-medium text-slate-200">
                                  {task.agent_type.replace(/_/g, ' ')}
                                </span>
                                {task.attempt_number > 1 && (
                                  <span className="ml-2 text-xs text-amber-400">attempt {task.attempt_number}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-3">
                                {task.llm_fallback_used && (
                                  <span className="text-[10px] text-amber-500 bg-amber-900/20 px-1.5 py-0.5 rounded">LLM used</span>
                                )}
                                <span className={`text-xs font-bold ${
                                  task.completion_score >= 80 ? 'text-emerald-400'
                                  : task.completion_score >= 60 ? 'text-amber-400'
                                  : 'text-red-400'
                                }`}>
                                  {task.completion_score}
                                </span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                  task.task_status === 'success' ? 'bg-emerald-900/30 text-emerald-400'
                                  : task.task_status === 'partial' ? 'bg-amber-900/30 text-amber-400'
                                  : 'bg-red-900/30 text-red-400'
                                }`}>
                                  {task.task_status}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-4 mt-1 text-xs text-slate-500">
                              <span>{Math.round(task.duration_ms / 1000)}s</span>
                              {task.cost_usd > 0 && <span>{fmtCost(task.cost_usd)}</span>}
                              {task.evidence_found && <span className="text-emerald-500">evidence found</span>}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ── Scraper Pipeline tab ──────────────────────────────────────── */}
        {subTab === 'scraper' && (
          <>
            {/* Evidence Provenance */}
            <div className="mb-6">
              <h2 className="text-sm font-bold text-slate-300 mb-3 uppercase tracking-wide">Evidence by Source &amp; Worker</h2>
              {evidenceProvenance.length === 0 ? (
                <div className="text-center text-slate-500 py-8 text-sm">No evidence provenance data yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-wide">
                        <th className="pb-2 pr-4 font-semibold">Source Type</th>
                        <th className="pb-2 pr-4 font-semibold">Worker</th>
                        <th className="pb-2 pr-4 font-semibold text-right">Evidence</th>
                        <th className="pb-2 pr-4 font-semibold text-right">w/ URL</th>
                        <th className="pb-2 pr-4 font-semibold text-right">Trusted URL</th>
                        <th className="pb-2 pr-4 font-semibold text-right">Plants</th>
                        <th className="pb-2 pr-4 font-semibold text-right">Runs</th>
                        <th className="pb-2 font-semibold text-right">Last Seen</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {evidenceProvenance.map((row, i) => (
                        <tr key={i} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-2 pr-4 text-slate-200 font-medium">{row.source_type}</td>
                          <td className="py-2 pr-4 text-slate-400">{row.worker_name}</td>
                          <td className="py-2 pr-4 text-right text-white font-semibold">{row.evidence_count.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-right text-slate-300">{row.with_source_url.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-right">
                            <span className={row.with_trusted_url > 0 ? 'text-emerald-400' : 'text-slate-600'}>
                              {row.with_trusted_url.toLocaleString()}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-right text-slate-300">{row.distinct_plants}</td>
                          <td className="py-2 pr-4 text-right text-slate-300">{row.distinct_runs}</td>
                          <td className="py-2 text-right text-slate-500">{row.last_seen ? timeAgo(row.last_seen) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* State Scraper Health */}
            <div>
              <h2 className="text-sm font-bold text-slate-300 mb-3 uppercase tracking-wide">State Scraper Health</h2>
              {scraperHealth.length === 0 ? (
                <div className="text-center text-slate-500 py-8 text-sm">No scraper health data yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-500 uppercase tracking-wide">
                        <th className="pb-2 pr-4 font-semibold">State</th>
                        <th className="pb-2 pr-4 font-semibold text-right">Plants w/ Evidence</th>
                        <th className="pb-2 pr-4 font-semibold text-right">UCC Hits</th>
                        <th className="pb-2 pr-4 font-semibold text-right">LLM Only</th>
                        <th className="pb-2 pr-4 font-semibold text-right">UCC Records</th>
                        <th className="pb-2 pr-4 font-semibold text-right">LLM Records</th>
                        <th className="pb-2 pr-4 font-semibold text-right">Trusted URLs</th>
                        <th className="pb-2 font-semibold text-right">Last Evidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {scraperHealth.map(row => (
                        <tr key={row.state} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-2 pr-4 font-bold text-white">{row.state}</td>
                          <td className="py-2 pr-4 text-right text-slate-200">{row.plants_with_evidence}</td>
                          <td className="py-2 pr-4 text-right">
                            <span className={row.plants_with_ucc_hit > 0 ? 'text-emerald-400 font-semibold' : 'text-slate-600'}>
                              {row.plants_with_ucc_hit}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-right">
                            <span className={row.plants_with_llm_fallback_only > 0 ? 'text-amber-400' : 'text-slate-600'}>
                              {row.plants_with_llm_fallback_only}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-right text-slate-300">{row.ucc_evidence_records.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-right text-slate-300">{row.llm_evidence_records.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-right">
                            <span className={row.ucc_with_trusted_url > 0 ? 'text-emerald-400' : 'text-slate-600'}>
                              {row.ucc_with_trusted_url}
                            </span>
                          </td>
                          <td className="py-2 text-right text-slate-500">{row.last_evidence_at ? timeAgo(row.last_evidence_at) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default LenderResearchDashboard;
