import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  fetchAllUsers,
  setUserRole,
  fetchAdminUserActivity,
  fetchAdminMonthlyCosts,
  fetchAdminIngestionFreshness,
  fetchUnsearchedCurtailedPlants,
  fetchAllCurtailedPlants,
  AdminDailyActivityRow,
  AdminUserDailyActivityRow,
  AdminMonthlyCostLine,
  AdminMonthlyCostTotal,
  AdminUserRow,
  UnsearchedCurtailedPlant,
  CurtailedPlant,
  UserRole,
} from '../services/authService';

interface Props {
  currentUserId: string;
  onBack: () => void;
  onDataIngested?: () => Promise<void> | void;
}

type WorkflowStatus = 'idle' | 'triggering' | 'queued' | 'in_progress' | 'success' | 'failure';

const ROLE_STYLES: Record<UserRole, string> = {
  user:    'bg-slate-800 text-slate-400 border-slate-700',
  admin:   'bg-indigo-900/30 text-indigo-400 border-indigo-500/30',
  blocked: 'bg-red-900/30 text-red-400 border-red-500/30',
};

function monthStart(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

const AdminPage: React.FC<Props> = ({ currentUserId, onBack, onDataIngested }) => {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);

  const [selectedMonth, setSelectedMonth] = useState(() => monthStart(new Date()));
  const [dailyActivity, setDailyActivity] = useState<AdminDailyActivityRow[]>([]);
  const [dailyUserActivity, setDailyUserActivity] = useState<AdminUserDailyActivityRow[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);

  const [costLines, setCostLines] = useState<AdminMonthlyCostLine[]>([]);
  const [monthlyTotals, setMonthlyTotals] = useState<AdminMonthlyCostTotal[]>([]);
  const [costLoading, setCostLoading] = useState(true);
  const [costError, setCostError] = useState<string | null>(null);

  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>('idle');
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [workflowDetail, setWorkflowDetail] = useState<string | null>(null);
  const [preRunLatestMonth, setPreRunLatestMonth] = useState<string | null>(null);
  const [preRunLatestPlantUpdateAt, setPreRunLatestPlantUpdateAt] = useState<string | null>(null);
  const [roleLoading, setRoleLoading] = useState<string | null>(null);

  const [unsearchedPlants, setUnsearchedPlants] = useState<UnsearchedCurtailedPlant[]>([]);
  const [unsearchedLoading, setUnsearchedLoading] = useState(true);
  const [unsearchedError, setUnsearchedError] = useState<string | null>(null);
  const [lenderSearchTriggering, setLenderSearchTriggering] = useState(false);
  const [lenderIngestMaxPlants, setLenderIngestMaxPlants] = useState<number | null>(25);

  const [curtailedPlants, setCurtailedPlants] = useState<CurtailedPlant[]>([]);
  const [curtailedLoading, setCurtailedLoading] = useState(true);
  const [curtailedError, setCurtailedError] = useState<string | null>(null);
  const [showIngestConfirm, setShowIngestConfirm] = useState(false);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError(null);
    try {
      const data = await fetchAllUsers();
      setUsers(data);
    } catch (err: any) {
      setUsersError(err.message ?? 'Failed to load users');
    } finally {
      setUsersLoading(false);
    }
  }, []);

  const loadActivity = useCallback(async (month: string) => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      const data = await fetchAdminUserActivity(month);
      setDailyActivity(data.daily);
      setDailyUserActivity(data.users);
    } catch (err: any) {
      setActivityError(err.message ?? 'Failed to load activity metrics');
    } finally {
      setActivityLoading(false);
    }
  }, []);

  const loadCosts = useCallback(async () => {
    setCostLoading(true);
    setCostError(null);
    try {
      const data = await fetchAdminMonthlyCosts();
      setCostLines(data.lines);
      setMonthlyTotals(data.totals);
    } catch (err: any) {
      setCostError(err.message ?? 'Failed to load monthly costs');
    } finally {
      setCostLoading(false);
    }
  }, []);

  const loadUnsearchedPlants = useCallback(async () => {
    setUnsearchedLoading(true);
    setUnsearchedError(null);
    try {
      const data = await fetchUnsearchedCurtailedPlants();
      setUnsearchedPlants(data);
    } catch (err: any) {
      setUnsearchedError(err.message ?? 'Failed to load unsearched plants');
    } finally {
      setUnsearchedLoading(false);
    }
  }, []);

  const loadCurtailedPlants = useCallback(async () => {
    setCurtailedLoading(true);
    setCurtailedError(null);
    try {
      const data = await fetchAllCurtailedPlants();
      setCurtailedPlants(data);
    } catch (err: any) {
      setCurtailedError(err.message ?? 'Failed to load curtailed plants');
    } finally {
      setCurtailedLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    loadActivity(selectedMonth);
  }, [selectedMonth, loadActivity]);

  useEffect(() => {
    loadCosts();
    // Refresh costs once per day
    const id = setInterval(loadCosts, 24 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadCosts]);

  useEffect(() => {
    loadUnsearchedPlants();
  }, [loadUnsearchedPlants]);

  useEffect(() => {
    loadCurtailedPlants();
  }, [loadCurtailedPlants]);

  // Re-fetch after a successful EIA workflow run
  useEffect(() => {
    if (workflowStatus === 'success') {
      loadUnsearchedPlants();
      loadCurtailedPlants();
    }
  }, [workflowStatus, loadUnsearchedPlants, loadCurtailedPlants]);

  const monthOptions = useMemo(() => {
    const options = new Set<string>();
    options.add(selectedMonth);
    for (const t of monthlyTotals) options.add(t.month_start);
    const now = new Date();
    for (let i = 1; i <= 2; i++) {
      options.add(monthStart(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
    }
    return Array.from(options).sort((a, b) => b.localeCompare(a));
  }, [monthlyTotals, selectedMonth]);

  // Cost memos
  const selectedMonthLines = useMemo(
    () => costLines.filter(c => c.month_start === selectedMonth),
    [costLines, selectedMonth]
  );

  const selectedMonthTotal = useMemo(
    () => monthlyTotals.find(t => t.month_start === selectedMonth)?.total_usd
      ?? selectedMonthLines.reduce((sum, c) => sum + Number(c.amount_usd || 0), 0),
    [monthlyTotals, selectedMonthLines, selectedMonth]
  );

  const allMonths = useMemo(
    () => [...monthlyTotals].sort((a, b) => a.month_start.localeCompare(b.month_start)),
    [monthlyTotals]
  );

  const earliestMonth = allMonths[0]?.month_start ?? null;

  const cumulativeTotal = useMemo(
    () => allMonths.reduce((sum, t) => sum + Number(t.total_usd || 0), 0),
    [allMonths]
  );

  const allServices = useMemo(() => {
    const totals = new Map<string, { type: string; total: number }>();
    for (const c of costLines) {
      const existing = totals.get(c.service_name) ?? { type: c.cost_type, total: 0 };
      existing.total += Number(c.amount_usd || 0);
      totals.set(c.service_name, existing);
    }
    return Array.from(totals.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, meta]) => ({ name, type: meta.type }));
  }, [costLines]);

  const costMatrix = useMemo(() => {
    const matrix = new Map<string, Map<string, number>>();
    for (const c of costLines) {
      if (!matrix.has(c.service_name)) matrix.set(c.service_name, new Map());
      matrix.get(c.service_name)!.set(c.month_start, Number(c.amount_usd || 0));
    }
    return matrix;
  }, [costLines]);

  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  // Auto-refresh activity every 30s
  useEffect(() => {
    const id = setInterval(() => {
      loadActivity(selectedMonth);
      setLastRefreshed(new Date());
    }, 30_000);
    return () => clearInterval(id);
  }, [selectedMonth, loadActivity]);

  const [selectedDay, setSelectedDay] = useState<string>('all');

  // Reset day filter when month changes
  useEffect(() => { setSelectedDay('all'); }, [selectedMonth]);

  const sortedUserActivity = useMemo(() => {
    return [...dailyUserActivity].sort(
      (a, b) => b.day.localeCompare(a.day) || Number(b.action_count || 0) - Number(a.action_count || 0)
    );
  }, [dailyUserActivity]);

  const dayOptions = useMemo(() => {
    const days = Array.from(new Set(sortedUserActivity.map((r) => r.day as string))).sort((a, b) => b.localeCompare(a));
    return days;
  }, [sortedUserActivity]);

  const filteredUserActivity = useMemo(() => {
    if (selectedDay === 'all') return sortedUserActivity;
    return sortedUserActivity.filter((r) => r.day === selectedDay);
  }, [sortedUserActivity, selectedDay]);

  // Poll GitHub Actions for workflow status after a trigger
  const pollWorkflowStatus = useCallback(async () => {
    const pat = import.meta.env.VITE_GITHUB_ADMIN_PAT as string;
    if (!pat) return;
    try {
      const res = await fetch(
        'https://api.github.com/repos/jhreich2002/gentrack/actions/workflows/monthly-update.yml/runs?per_page=1',
        { headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' } }
      );
      const json = await res.json();
      const run = json.workflow_runs?.[0];
      if (!run) return;

      if (run.status === 'completed') {
        if (run.conclusion !== 'success') {
          setWorkflowStatus('failure');
          setWorkflowDetail(`GitHub workflow failed (${run.conclusion ?? 'unknown'}).`);
          setLastRun(run.updated_at);
          return;
        }

        const freshness = await fetchAdminIngestionFreshness();
        const latestMonth = freshness.latestGenerationMonth;
        const latestPlantUpdate = freshness.latestPlantUpdateAt;
        const monthAdvanced =
          preRunLatestMonth === null
            ? Boolean(latestMonth)
            : Boolean(latestMonth && latestMonth > preRunLatestMonth);
        const plantUpdated =
          preRunLatestPlantUpdateAt === null
            ? Boolean(latestPlantUpdate)
            : Boolean(latestPlantUpdate && latestPlantUpdate > preRunLatestPlantUpdateAt);

        if (!monthAdvanced || !plantUpdated) {
          setWorkflowStatus('failure');
          setWorkflowDetail(
            `Workflow completed but no new ingestion detected (latest month ${latestMonth ?? 'none'}).`
          );
          setLastRun(run.updated_at);
          return;
        }

        setWorkflowStatus('success');
        setWorkflowDetail(`Ingestion confirmed at month ${latestMonth}. Triggering news refresh for curtailed plants...`);
        setLastRun(run.updated_at);

        // Trigger news-ingest for newly/still curtailed plants
        try {
          const sbUrl = import.meta.env.VITE_SUPABASE_URL as string;
          const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
          if (sbUrl && sbKey) {
            fetch(`${sbUrl}/functions/v1/news-ingest`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${sbKey}`,
              },
              body: JSON.stringify({ plantCount: 30, limit: 15 }),
            }).catch(() => {});
          }
        } catch { /* non-blocking */ }

        if (onDataIngested) {
          await Promise.resolve(onDataIngested());
        }
        return;
      }

      const status: WorkflowStatus =
        run.status === 'in_progress' ? 'in_progress' : 'queued';
      setWorkflowStatus(status);
      setWorkflowDetail(null);
      setLastRun(run.updated_at);
    } catch { /* swallow */ }
  }, [onDataIngested, preRunLatestMonth, preRunLatestPlantUpdateAt]);

  // Poll every 10s while running/queued
  useEffect(() => {
    if (workflowStatus !== 'queued' && workflowStatus !== 'in_progress') return;
    const id = setInterval(pollWorkflowStatus, 10_000);
    return () => clearInterval(id);
  }, [workflowStatus, pollWorkflowStatus]);

  const triggerFetch = async () => {
    const pat = import.meta.env.VITE_GITHUB_ADMIN_PAT as string;
    if (!pat) { alert('VITE_GITHUB_ADMIN_PAT is not configured.'); return; }
    try {
      const freshness = await fetchAdminIngestionFreshness();
      setPreRunLatestMonth(freshness.latestGenerationMonth);
      setPreRunLatestPlantUpdateAt(freshness.latestPlantUpdateAt);
    } catch {
      setPreRunLatestMonth(null);
      setPreRunLatestPlantUpdateAt(null);
    }
    setWorkflowDetail(null);
    setWorkflowStatus('triggering');
    try {
      const res = await fetch(
        'https://api.github.com/repos/jhreich2002/gentrack/actions/workflows/monthly-update.yml/dispatches',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: 'main' }),
        }
      );
      if (!res.ok) throw new Error(`GitHub API error ${res.status}`);
      setWorkflowStatus('queued');
      setTimeout(pollWorkflowStatus, 5_000);
    } catch (err: any) {
      setWorkflowStatus('failure');
      alert(`Failed to trigger workflow: ${err.message}`);
    }
  };

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    setRoleLoading(userId);
    try {
      await setUserRole(userId, newRole);
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u));
    } catch (err: any) {
      alert(`Failed to update role: ${err.message}`);
    } finally {
      setRoleLoading(null);
    }
  };

  const triggerLenderSearch = async () => {
    const sbUrl = import.meta.env.VITE_SUPABASE_URL as string;
    const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
    if (!sbUrl || !sbKey) { alert('Supabase credentials not configured.'); return; }
    setLenderSearchTriggering(true);
    try {
      const res = await fetch(`${sbUrl}/functions/v1/lender-ingest-coordinator`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sbKey}` },
        body: JSON.stringify({
          mode:        'full',
          budgetLimit: 30.0,
          maxPlants:   lenderIngestMaxPlants,
          batchOffset: 0,
          recheck:     false,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as any;
        if (body?.reason === 'already_running') {
          alert('A lender identification run is already in progress. Check back in a few minutes.');
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      setShowIngestConfirm(false);
      // Coordinator processes plants asynchronously via self-chaining — refresh after a delay
      setTimeout(() => { loadUnsearchedPlants(); loadCurtailedPlants(); }, 20_000);
    } catch (err: any) {
      alert(`Failed to trigger lender identification: ${err.message}`);
    } finally {
      setLenderSearchTriggering(false);
    }
  };

  const workflowColor: Record<WorkflowStatus, string> = {
    idle:       'text-slate-500',
    triggering: 'text-yellow-400',
    queued:     'text-yellow-400',
    in_progress:'text-blue-400',
    success:    'text-green-400',
    failure:    'text-red-400',
  };
  const workflowLabel: Record<WorkflowStatus, string> = {
    idle:       'Idle — never triggered this session',
    triggering: 'Sending request...',
    queued:     'Queued — waiting to start',
    in_progress:'Running now...',
    success:    'Completed successfully',
    failure:    'Failed — check GitHub Actions',
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto pb-20 custom-scrollbar">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={onBack}
          className="p-2 hover:bg-slate-800 rounded-full text-slate-400 transition-colors border border-transparent hover:border-slate-700"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
        <div>
          <h1 className="text-3xl font-black text-white tracking-tight">Admin Dashboard</h1>
          <p className="text-slate-500 text-sm mt-0.5">System management and user administration</p>
        </div>
      </div>

      <div className="space-y-8">

        {/* ── User Activity ─────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
          <div className="flex items-center justify-between mb-6 gap-4">
            <div>
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-1">User Activity</h2>
              <p className="text-xs text-slate-600">
                Per-user daily actions and app opens · auto-refreshes every 30s
                {' · '}<span className="text-slate-500">last updated {lastRefreshed.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              </p>
            </div>
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-300 focus:outline-none focus:border-blue-600"
            >
              {monthOptions.map((month) => (
                <option key={month} value={month}>
                  {new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                </option>
              ))}
            </select>
          </div>

          {activityLoading ? (
            <div className="text-slate-600 text-sm">Loading activity...</div>
          ) : activityError ? (
            <div className="text-red-400 text-sm">{activityError}</div>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Active Users (Month)</div>
                  <div className="text-2xl font-black text-white">
                    {new Set(dailyUserActivity.map((r) => r.user_id)).size.toLocaleString()}
                  </div>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Actions (Month)</div>
                  <div className="text-2xl font-black text-blue-400">
                    {dailyActivity.reduce((sum, d) => sum + Number(d.action_count || 0), 0).toLocaleString()}
                  </div>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">App Opens (Month)</div>
                  <div className="text-2xl font-black text-emerald-400">
                    {dailyActivity.reduce((sum, d) => sum + Number(d.app_open_count || 0), 0).toLocaleString()}
                  </div>
                </div>
              </div>

              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[10px] text-slate-500 uppercase font-black tracking-widest">Activity by User</h3>
                  <select
                    value={selectedDay}
                    onChange={(e) => setSelectedDay(e.target.value)}
                    className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-300 focus:outline-none focus:border-blue-600"
                  >
                    <option value="all">All days</option>
                    {dayOptions.map((day) => (
                      <option key={day} value={day}>
                        {new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="max-h-96 overflow-y-auto custom-scrollbar">
                  {filteredUserActivity.length === 0 ? (
                    <div className="text-xs text-slate-600">No activity tracked for this {selectedDay === 'all' ? 'month' : 'date'} yet.</div>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-950 z-10">
                        <tr className="text-[10px] text-slate-500 uppercase border-b border-slate-800">
                          {selectedDay === 'all' && <th className="text-left py-2 pr-6 font-black tracking-widest">Date</th>}
                          <th className="text-left py-2 pr-6 font-black tracking-widest">Email</th>
                          <th className="text-right py-2 pr-6 font-black tracking-widest">Actions</th>
                          <th className="text-right py-2 font-black tracking-widest">Opens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredUserActivity.map((row) => (
                          <tr key={`${row.day}-${row.user_id}`} className="border-b border-slate-800/50 hover:bg-slate-900/40">
                            {selectedDay === 'all' && (
                              <td className="py-2 pr-6 text-slate-400 font-mono whitespace-nowrap">
                                {new Date(`${row.day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              </td>
                            )}
                            <td className="py-2 pr-6 text-slate-300 truncate max-w-[200px]">{row.email}</td>
                            <td className="py-2 pr-6 text-blue-400 text-right font-bold">{Number(row.action_count || 0)}</td>
                            <td className="py-2 text-emerald-400 text-right font-bold">{Number(row.app_open_count || 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* ── Platform Cost ─────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
          <div className="flex items-center justify-between mb-6 gap-4">
            <div>
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Platform Cost</h2>
              <p className="text-xs text-slate-600">Service cost matrix by month · auto-refreshes daily</p>
            </div>
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-300 focus:outline-none focus:border-blue-600"
            >
              {monthOptions.map((month) => (
                <option key={month} value={month}>
                  {new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                </option>
              ))}
            </select>
          </div>

          {costLoading ? (
            <div className="text-slate-600 text-sm">Loading monthly costs...</div>
          ) : costError ? (
            <div className="text-red-400 text-sm">{costError}</div>
          ) : (
            <div className="space-y-6">

              {/* Stat cards */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">
                    {new Date(`${selectedMonth}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} Total
                  </div>
                  <div className="text-2xl font-black text-white">${Number(selectedMonthTotal || 0).toFixed(2)}</div>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Variable</div>
                  <div className="text-2xl font-black text-amber-400">
                    ${selectedMonthLines.filter(c => c.cost_type === 'variable').reduce((sum, c) => sum + Number(c.amount_usd || 0), 0).toFixed(2)}
                  </div>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Fixed</div>
                  <div className="text-2xl font-black text-indigo-400">
                    ${selectedMonthLines.filter(c => c.cost_type === 'fixed').reduce((sum, c) => sum + Number(c.amount_usd || 0), 0).toFixed(2)}
                  </div>
                </div>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">
                    Cumulative{earliestMonth ? ` since ${new Date(`${earliestMonth}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : ''}
                  </div>
                  <div className="text-2xl font-black text-violet-400">${cumulativeTotal.toFixed(2)}</div>
                </div>
              </div>



              {/* Service × Month matrix */}
              <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto custom-scrollbar">
                  {allServices.length === 0 ? (
                    <div className="text-xs text-slate-600 p-4">No cost data available yet.</div>
                  ) : (
                    <table className="text-xs w-full min-w-max">
                      <thead>
                        <tr className="border-b border-slate-800 bg-slate-900/60">
                          <th className="text-left py-3 px-4 font-black text-[10px] text-slate-500 uppercase tracking-widest sticky left-0 bg-slate-900/60 z-10 min-w-[180px]">Service</th>
                          {allMonths.map(t => (
                            <th key={t.month_start} className="text-right py-3 px-4 font-black text-[10px] text-slate-500 uppercase tracking-widest whitespace-nowrap">
                              {new Date(`${t.month_start}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {allServices.map(svc => (
                          <tr key={svc.name} className="border-b border-slate-800/50 hover:bg-slate-900/40">
                            <td className="py-2.5 px-4 sticky left-0 bg-slate-950 hover:bg-slate-900/40 z-10">
                              <div className="flex items-center gap-2">
                                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${svc.type === 'fixed' ? 'bg-indigo-900/40 text-indigo-400' : 'bg-amber-900/40 text-amber-400'}`}>
                                  {svc.type}
                                </span>
                                <span className="text-slate-300">{svc.name}</span>
                              </div>
                            </td>
                            {allMonths.map(t => {
                              const amt = costMatrix.get(svc.name)?.get(t.month_start);
                              return (
                                <td key={t.month_start} className="py-2.5 px-4 text-right font-mono whitespace-nowrap">
                                  {amt != null ? (
                                    <span className="text-white">${amt.toFixed(2)}</span>
                                  ) : (
                                    <span className="text-slate-700">—</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-slate-700 bg-slate-900/60">
                          <td className="py-3 px-4 font-black text-slate-400 text-[10px] uppercase tracking-widest sticky left-0 bg-slate-900/60 z-10">Monthly Total</td>
                          {allMonths.map(t => (
                            <td key={t.month_start} className="py-3 px-4 text-right font-mono font-black text-violet-400 whitespace-nowrap">
                              ${Number(monthlyTotals.find(m => m.month_start === t.month_start)?.total_usd || 0).toFixed(2)}
                            </td>
                          ))}
                        </tr>
                      </tfoot>
                    </table>
                  )}
                </div>
              </div>

            </div>
          )}
        </section>

        {/* ── EIA Data Refresh ──────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
          <div className="flex items-start justify-between mb-6">
            <div>
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-1">EIA Data Refresh</h2>
              <p className="text-xs text-slate-600">Triggers the monthly-update GitHub Actions workflow to fetch fresh EIA data and push to Supabase.</p>
            </div>
            <button
              onClick={triggerFetch}
              disabled={workflowStatus === 'triggering' || workflowStatus === 'queued' || workflowStatus === 'in_progress'}
              className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-black text-xs tracking-wide transition-all flex items-center gap-2 whitespace-nowrap"
            >
              {(workflowStatus === 'triggering' || workflowStatus === 'queued' || workflowStatus === 'in_progress') && (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              )}
              Run EIA Fetch
            </button>
          </div>
          <div className="flex items-center gap-3 bg-slate-800/40 rounded-xl px-5 py-3">
            <div className={`w-2 h-2 rounded-full ${workflowStatus === 'success' ? 'bg-green-400' : workflowStatus === 'failure' ? 'bg-red-400' : workflowStatus === 'idle' ? 'bg-slate-600' : 'bg-yellow-400 animate-pulse'}`} />
            <span className={`text-xs font-bold ${workflowColor[workflowStatus]}`}>{workflowLabel[workflowStatus]}</span>
            {lastRun && (
              <span className="text-[10px] text-slate-600 ml-auto font-mono">
                Last: {new Date(lastRun).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          {workflowDetail && (
            <p className={`mt-3 text-[11px] ${workflowStatus === 'failure' ? 'text-red-400' : 'text-slate-500'}`}>
              {workflowDetail}
            </p>
          )}
        </section>

        {/* ── Lender Search Coverage ────────────────────── */}
        {(() => {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - 90);
          const neverSearched = curtailedPlants.filter(p => !p.lenderIngestCheckedAt).length;
          const stale = curtailedPlants.filter(p => p.lenderIngestCheckedAt && new Date(p.lenderIngestCheckedAt) < cutoff).length;
          const topN = lenderIngestMaxPlants === null ? curtailedPlants.length : Math.min(lenderIngestMaxPlants, curtailedPlants.length);
          const eligibleInTopN = curtailedPlants.slice(0, lenderIngestMaxPlants ?? undefined).filter(
            p => !p.lenderIngestCheckedAt || new Date(p.lenderIngestCheckedAt) < cutoff
          ).length;
          const estimatedCost = (eligibleInTopN * 0.065).toFixed(2);

          return (
            <section className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
              {/* Header */}
              <div className="flex items-center justify-between px-8 py-6 border-b border-slate-800">
                <div>
                  <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Lender Identification Coverage</h2>
                  <p className="text-xs text-slate-600">
                    Multi-source agentic pipeline — identifies lenders, classifies loan status, and generates pitch intelligence. Ranked by distress score.
                    {!curtailedLoading && curtailedPlants.length > 0 && (
                      <>
                        <span className="mx-1 text-slate-700">·</span>
                        <span className="text-slate-500">{curtailedPlants.length} curtailed plants</span>
                        {neverSearched > 0 && (
                          <><span className="mx-1 text-slate-700">·</span><span className="text-amber-400 font-semibold">{neverSearched} never searched</span></>
                        )}
                        {stale > 0 && (
                          <><span className="mx-1 text-slate-700">·</span><span className="text-slate-500">{stale} stale (&gt;90 days)</span></>
                        )}
                        {neverSearched === 0 && stale === 0 && (
                          <><span className="mx-1 text-slate-700">·</span><span className="text-emerald-500 font-semibold">All plants recently searched</span></>
                        )}
                      </>
                    )}
                  </p>
                </div>
                <button
                  onClick={loadCurtailedPlants}
                  className="p-2 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                  title="Refresh list"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              </div>

              {/* Plant table */}
              {curtailedLoading ? (
                <div className="py-12 text-center text-slate-600 text-sm">Loading...</div>
              ) : curtailedError ? (
                <div className="py-12 text-center text-red-400 text-sm">{curtailedError}</div>
              ) : curtailedPlants.length === 0 ? (
                <div className="py-12 text-center text-slate-600 text-sm">No curtailed plants found.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="bg-slate-800/50 text-slate-500 text-[10px] font-black uppercase tracking-[0.15em]">
                        <th className="px-8 py-3">#</th>
                        <th className="px-6 py-3">Plant</th>
                        <th className="px-6 py-3">State</th>
                        <th className="px-6 py-3">Fuel</th>
                        <th className="px-6 py-3 text-right">MW</th>
                        <th className="px-6 py-3 text-right">Distress</th>
                        <th className="px-6 py-3 text-right">Last Searched</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {curtailedPlants.map((plant, idx) => {
                        const isStale = plant.lenderIngestCheckedAt && new Date(plant.lenderIngestCheckedAt) < cutoff;
                        const isInRun = lenderIngestMaxPlants === null || idx < lenderIngestMaxPlants;
                        return (
                          <tr
                            key={plant.eiaPlantCode}
                            className={`transition-colors ${isInRun ? 'hover:bg-slate-800/40' : 'opacity-40 hover:bg-slate-800/20'}`}
                          >
                            <td className={`px-8 py-3 text-xs font-mono ${isInRun ? 'text-cyan-600' : 'text-slate-700'}`}>{idx + 1}</td>
                            <td className="px-6 py-3">
                              <div className="text-sm font-semibold text-slate-200">{plant.name}</div>
                              <div className="text-[10px] text-slate-600 font-mono mt-0.5">{plant.eiaPlantCode}</div>
                            </td>
                            <td className="px-6 py-3 text-xs text-slate-400">{plant.state}</td>
                            <td className="px-6 py-3 text-xs text-slate-400">{plant.fuelSource}</td>
                            <td className="px-6 py-3 text-xs text-slate-400 text-right font-mono">
                              {plant.nameplateMw.toLocaleString()}
                            </td>
                            <td className="px-6 py-3 text-right">
                              {plant.distressScore != null ? (
                                <div className="flex items-center justify-end gap-2">
                                  <div className="w-12 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full ${plant.distressScore >= 70 ? 'bg-red-500' : plant.distressScore >= 40 ? 'bg-amber-500' : 'bg-slate-500'}`}
                                      style={{ width: `${Math.min(plant.distressScore, 100)}%` }}
                                    />
                                  </div>
                                  <span className={`text-sm font-black w-7 text-right font-mono ${plant.distressScore >= 70 ? 'text-red-400' : plant.distressScore >= 40 ? 'text-amber-400' : 'text-slate-400'}`}>
                                    {Math.round(plant.distressScore)}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs text-slate-700 font-mono">—</span>
                              )}
                            </td>
                            <td className="px-6 py-3 text-right">
                              {plant.lenderIngestCheckedAt ? (
                                <span className={`text-[10px] font-mono ${isStale ? 'text-slate-500' : 'text-emerald-500'}`}>
                                  {new Date(plant.lenderIngestCheckedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                                </span>
                              ) : (
                                <span className="text-[10px] px-2 py-0.5 rounded-md bg-amber-900/30 text-amber-400 border border-amber-500/20 font-bold">
                                  Never
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Footer: count selector + cost + confirm */}
              {!curtailedLoading && curtailedPlants.length > 0 && (
                <div className="px-8 py-5 border-t border-slate-800 bg-slate-800/20 flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs text-slate-400">Process top</span>
                    <select
                      value={lenderIngestMaxPlants === null ? 'all' : String(lenderIngestMaxPlants)}
                      onChange={e => { setLenderIngestMaxPlants(e.target.value === 'all' ? null : Number(e.target.value)); setShowIngestConfirm(false); }}
                      disabled={lenderSearchTriggering}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-cyan-600"
                    >
                      <option value="10">10</option>
                      <option value="25">25</option>
                      <option value="50">50</option>
                      <option value="100">100</option>
                      <option value="all">All ({curtailedPlants.length})</option>
                    </select>
                    <span className="text-xs text-slate-400">plants</span>
                    <span className="text-xs text-slate-700">·</span>
                    <span className="text-xs text-slate-500">
                      {eligibleInTopN} eligible
                      <span className="mx-1 text-slate-700">·</span>
                      estimated cost: <span className="text-cyan-400 font-mono font-semibold">~${estimatedCost}</span>
                    </span>
                  </div>

                  {showIngestConfirm ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-amber-300 font-semibold">
                        Run for top {topN} plants ({eligibleInTopN} eligible)?
                      </span>
                      <button
                        onClick={() => setShowIngestConfirm(false)}
                        disabled={lenderSearchTriggering}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 font-semibold text-xs transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={triggerLenderSearch}
                        disabled={lenderSearchTriggering}
                        className="px-4 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-black text-xs tracking-wide transition-all flex items-center gap-2"
                      >
                        {lenderSearchTriggering && (
                          <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        )}
                        Confirm &amp; Run
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowIngestConfirm(true)}
                      disabled={lenderSearchTriggering || eligibleInTopN === 0}
                      className="px-4 py-2 rounded-xl bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-black text-xs tracking-wide transition-all"
                    >
                      Run Lender Identification
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })()}

        {/* ── User Management ───────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
          <div className="flex items-center justify-between px-8 py-6 border-b border-slate-800">
            <div>
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-1">User Management</h2>
              <p className="text-xs text-slate-600">{users.length} registered account{users.length !== 1 ? 's' : ''}</p>
            </div>
            <button onClick={loadUsers} className="p-2 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors" title="Refresh">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>

          {usersLoading ? (
            <div className="py-16 text-center text-slate-600 text-sm">Loading users...</div>
          ) : usersError ? (
            <div className="py-16 text-center text-red-400 text-sm">{usersError}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-slate-800/50 text-slate-500 text-[10px] font-black uppercase tracking-[0.15em]">
                    <th className="px-8 py-4">Email</th>
                    <th className="px-6 py-4">Role</th>
                    <th className="px-6 py-4">Signed Up</th>
                    <th className="px-6 py-4">Last Login</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {users.map(user => {
                    const isSelf = user.id === currentUserId;
                    const isProcessing = roleLoading === user.id;
                    return (
                      <tr key={user.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="px-8 py-4">
                          <div className="text-sm font-medium text-slate-200 flex items-center gap-2">
                            {user.email}
                            {isSelf && <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-900/30 text-blue-400 border border-blue-500/20 font-bold">YOU</span>}
                          </div>
                          <div className="text-[10px] text-slate-600 font-mono mt-0.5">{user.id.slice(0, 16)}…</div>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`text-[10px] px-2.5 py-1 rounded-lg font-bold border uppercase ${ROLE_STYLES[user.role ?? 'user']}`}>
                            {user.role ?? 'user'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-xs text-slate-500">
                          {user.created_at ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                        </td>
                        <td className="px-6 py-4 text-xs text-slate-500">
                          {user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never'}
                        </td>
                        <td className="px-6 py-4 text-right">
                          {isSelf ? (
                            <span className="text-[10px] text-slate-700">—</span>
                          ) : (
                            <div className="flex items-center justify-end gap-2">
                              {isProcessing ? (
                                <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
                              ) : (
                                <>
                                  {user.role !== 'admin' && (
                                    <button
                                      onClick={() => handleRoleChange(user.id, 'admin')}
                                      className="text-[10px] px-3 py-1.5 rounded-lg bg-indigo-900/20 text-indigo-400 border border-indigo-500/20 hover:bg-indigo-900/40 font-bold transition-colors"
                                    >
                                      Make Admin
                                    </button>
                                  )}
                                  {user.role === 'blocked' ? (
                                    <button
                                      onClick={() => handleRoleChange(user.id, 'user')}
                                      className="text-[10px] px-3 py-1.5 rounded-lg bg-green-900/20 text-green-400 border border-green-500/20 hover:bg-green-900/40 font-bold transition-colors"
                                    >
                                      Restore
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => handleRoleChange(user.id, 'blocked')}
                                      className="text-[10px] px-3 py-1.5 rounded-lg bg-red-900/20 text-red-400 border border-red-500/20 hover:bg-red-900/40 font-bold transition-colors"
                                    >
                                      Block
                                    </button>
                                  )}
                                  {user.role === 'admin' && (
                                    <button
                                      onClick={() => handleRoleChange(user.id, 'user')}
                                      className="text-[10px] px-3 py-1.5 rounded-lg bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700 font-bold transition-colors"
                                    >
                                      Demote
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default AdminPage;
