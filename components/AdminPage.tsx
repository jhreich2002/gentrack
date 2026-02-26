import React, { useEffect, useState, useCallback } from 'react';
import { fetchAllUsers, setUserRole, fetchDataHealth, AdminUserRow, UserRole } from '../services/authService';

interface Props {
  currentUserId: string;
  onBack: () => void;
}

type WorkflowStatus = 'idle' | 'triggering' | 'queued' | 'in_progress' | 'success' | 'failure';

const ROLE_STYLES: Record<UserRole, string> = {
  user:    'bg-slate-800 text-slate-400 border-slate-700',
  admin:   'bg-indigo-900/30 text-indigo-400 border-indigo-500/30',
  blocked: 'bg-red-900/30 text-red-400 border-red-500/30',
};

const AdminPage: React.FC<Props> = ({ currentUserId, onBack }) => {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState<string | null>(null);

  const [health, setHealth] = useState<Awaited<ReturnType<typeof fetchDataHealth>> | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>('idle');
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [roleLoading, setRoleLoading] = useState<string | null>(null);

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

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const data = await fetchDataHealth();
      setHealth(data);
    } catch {
      /* non-critical */
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
    loadHealth();
  }, [loadUsers, loadHealth]);

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
      const status: WorkflowStatus =
        run.status === 'completed'
          ? run.conclusion === 'success' ? 'success' : 'failure'
          : run.status === 'in_progress' ? 'in_progress' : 'queued';
      setWorkflowStatus(status);
      setLastRun(run.updated_at);
    } catch { /* swallow */ }
  }, []);

  // Poll every 10s while running/queued
  useEffect(() => {
    if (workflowStatus !== 'queued' && workflowStatus !== 'in_progress') return;
    const id = setInterval(pollWorkflowStatus, 10_000);
    return () => clearInterval(id);
  }, [workflowStatus, pollWorkflowStatus]);

  const triggerFetch = async () => {
    const pat = import.meta.env.VITE_GITHUB_ADMIN_PAT as string;
    if (!pat) { alert('VITE_GITHUB_ADMIN_PAT is not configured.'); return; }
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

        {/* ── Data Health ─────────────────────────────── */}
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
          <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-6">Data Health</h2>
          {healthLoading ? (
            <div className="text-slate-600 text-sm">Loading...</div>
          ) : health ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <div>
                <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Plants in DB</div>
                <div className="text-2xl font-black text-white">{health.plantCount.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Generation Rows</div>
                <div className="text-2xl font-black text-blue-400">{(health.genRowCount as number).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Last Updated</div>
                <div className="text-sm font-black text-white">
                  {health.lastUpdated
                    ? new Date(health.lastUpdated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : 'Unknown'}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-1">Fuel Breakdown</div>
                <div className="flex flex-col gap-0.5">
                  {Object.entries(health.fuelBreakdown).map(([fuel, count]) => (
                    <div key={fuel} className="text-xs text-slate-400 font-mono">{fuel}: <span className="text-white font-bold">{count as number}</span></div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-slate-600 text-sm">Could not load health data.</div>
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
        </section>

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
