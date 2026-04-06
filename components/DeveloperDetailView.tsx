import React, { useState, useEffect, useMemo } from 'react';
import {
  fetchDeveloperAssets, fetchCrawlLogs, fetchChangelog,
  approveStagedAssets,
  DeveloperRow, AssetRegistryRow, CrawlLogRow, ChangelogRow,
} from '../services/developerService';

interface Props {
  developer: DeveloperRow;
  onBack: () => void;
  onAssetClick: (assetId: string) => void;
  onPlantClick?: (plantId: string) => void;
}

type Tab = 'overview' | 'portfolio' | 'provenance';

function confidenceColor(score: number | null) {
  if (!score) return 'text-slate-500';
  if (score >= 85) return 'text-emerald-400';
  if (score >= 60) return 'text-amber-400';
  return 'text-red-400';
}

function matchBadge(confidence: string | null) {
  const styles: Record<string, string> = {
    high: 'bg-emerald-900/30 text-emerald-400 border-emerald-500/30',
    medium: 'bg-amber-900/30 text-amber-400 border-amber-500/30',
    low: 'bg-red-900/30 text-red-400 border-red-500/30',
    none: 'bg-slate-800 text-slate-600 border-slate-700',
  };
  return styles[confidence || 'none'] || styles.none;
}

export default function DeveloperDetailView({ developer, onBack, onAssetClick, onPlantClick }: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const [assets, setAssets] = useState<AssetRegistryRow[]>([]);
  const [crawlLogs, setCrawlLogs] = useState<CrawlLogRow[]>([]);
  const [changelog, setChangelog] = useState<ChangelogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [selectedStaged, setSelectedStaged] = useState<Set<string>>(new Set());
  const [assetSearch, setAssetSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchDeveloperAssets(developer.id),
      fetchCrawlLogs(developer.id),
      fetchChangelog(developer.id),
    ]).then(([a, cl, ch]) => {
      setAssets(a);
      setCrawlLogs(cl);
      setChangelog(ch);
      setLoading(false);
    });
  }, [developer.id]);

  const graduated = useMemo(() => assets.filter(a => a.graduated), [assets]);
  const staged = useMemo(() => assets.filter(a => !a.graduated), [assets]);

  const filteredAssets = useMemo(() => {
    const src = tab === 'portfolio' ? assets : [];
    if (!assetSearch.trim()) return src;
    const q = assetSearch.toLowerCase();
    return src.filter(a => a.name.toLowerCase().includes(q) || (a.state || '').toLowerCase().includes(q));
  }, [assets, assetSearch, tab]);

  const totalMW = assets.reduce((s, a) => s + (a.capacity_mw || 0), 0);
  const techBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of assets) {
      const t = a.technology || 'unknown';
      map.set(t, (map.get(t) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [assets]);

  const stateBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of assets) {
      const s = a.state || 'Unknown';
      map.set(s, (map.get(s) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [assets]);

  const handleApprove = async () => {
    if (selectedStaged.size === 0) return;
    setApproving(true);
    const count = await approveStagedAssets(Array.from(selectedStaged));
    // Refresh assets
    const updated = await fetchDeveloperAssets(developer.id);
    setAssets(updated);
    setSelectedStaged(new Set());
    setApproving(false);
    alert(`Graduated ${count} asset(s)`);
  };

  const toggleStaged = (id: string) => {
    setSelectedStaged(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500">
        Loading developer details…
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <header className="flex items-start justify-between mb-8">
        <div>
          <button onClick={onBack} className="flex items-center gap-2 text-slate-500 hover:text-blue-400 transition-colors mb-4 group">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
            <span className="text-sm font-medium group-hover:underline">Developer Registry</span>
          </button>
          <h1 className="text-3xl font-black text-white tracking-tight">{developer.name}</h1>
          <div className="flex items-center gap-4 mt-2">
            <span className="text-sm text-slate-500">{developer.entity_type || 'Developer'}</span>
            {developer.hq_state && <span className="text-sm text-slate-500">• {developer.hq_state}</span>}
            {developer.website && (
              <a href={developer.website} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-500 hover:underline">
                {developer.website.replace(/^https?:\/\//, '')}
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-slate-900 rounded-xl p-1 w-fit border border-slate-800">
        {(['overview', 'portfolio', 'provenance'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              tab === t ? 'bg-slate-800 text-white shadow' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {t === 'overview' ? 'Overview' : t === 'portfolio' ? 'Portfolio' : 'Data Provenance'}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {tab === 'overview' && (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-5 gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Assets</div>
              <div className="text-2xl font-black text-white">{assets.length}</div>
              <div className="text-[10px] text-slate-600 mt-1">{graduated.length} graduated • {staged.length} staged</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Total MW</div>
              <div className="text-2xl font-black text-white">{totalMW.toLocaleString()}</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">EIA Coverage</div>
              <div className="text-2xl font-black text-emerald-400">
                {developer.coverage_rate != null ? `${(developer.coverage_rate * 100).toFixed(0)}%` : '—'}
              </div>
              <div className="text-[10px] text-slate-600 mt-1">
                {developer.eia_benchmark_count ? `vs ${developer.eia_benchmark_count} EIA plants` : ''}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Avg Confidence</div>
              <div className={`text-2xl font-black ${confidenceColor(developer.avg_confidence)}`}>
                {developer.avg_confidence != null ? developer.avg_confidence.toFixed(0) : '—'}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">API Spend</div>
              <div className="text-2xl font-black text-amber-400">${(developer.total_spend_usd || 0).toFixed(2)}</div>
            </div>
          </div>

          {/* Technology + State Breakdown */}
          <div className="grid grid-cols-2 gap-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Technology Breakdown</h3>
              <div className="space-y-3">
                {techBreakdown.map(([tech, count]) => (
                  <div key={tech} className="flex items-center justify-between">
                    <span className="text-sm text-slate-300 capitalize">{tech}</span>
                    <div className="flex items-center gap-3">
                      <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(count / assets.length) * 100}%` }} />
                      </div>
                      <span className="text-sm font-mono text-slate-400 w-8 text-right">{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Top States</h3>
              <div className="space-y-3">
                {stateBreakdown.map(([state, count]) => (
                  <div key={state} className="flex items-center justify-between">
                    <span className="text-sm text-slate-300">{state}</span>
                    <div className="flex items-center gap-3">
                      <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(count / assets.length) * 100}%` }} />
                      </div>
                      <span className="text-sm font-mono text-slate-400 w-8 text-right">{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Recent Changes */}
          {changelog.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Recent Changes</h3>
              <div className="space-y-2">
                {changelog.slice(0, 10).map(ch => (
                  <div key={ch.id} className="flex items-center gap-3 text-sm">
                    <span className="text-[10px] text-slate-600 font-mono w-20 flex-shrink-0">
                      {new Date(ch.detected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase bg-slate-800 text-slate-500 border border-slate-700">
                      {ch.change_type.replace('_', ' ')}
                    </span>
                    <span className="text-slate-400 truncate">
                      {ch.new_value?.details || JSON.stringify(ch.new_value)}
                    </span>
                    <span className="text-[10px] text-slate-700 ml-auto">{ch.detected_by}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Portfolio Tab ── */}
      {tab === 'portfolio' && (
        <div className="space-y-6">
          {/* Search */}
          <input
            type="text"
            placeholder="Search assets…"
            value={assetSearch}
            onChange={(e) => setAssetSearch(e.target.value)}
            className="w-full max-w-md px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-600 transition-colors"
          />

          {/* Graduated Assets */}
          <div>
            <h3 className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Graduated ({graduated.length})
            </h3>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                    <th className="px-5 py-4">Asset Name</th>
                    <th className="px-5 py-4">Tech</th>
                    <th className="px-5 py-4">State</th>
                    <th className="px-5 py-4 text-right">MW</th>
                    <th className="px-5 py-4">Status</th>
                    <th className="px-5 py-4">EIA Match</th>
                    <th className="px-5 py-4 text-right">Confidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {(assetSearch ? filteredAssets.filter(a => a.graduated) : graduated).map(a => (
                    <tr key={a.id} onClick={() => a.eia_plant_code && onPlantClick ? onPlantClick(a.eia_plant_code) : onAssetClick(a.id)} className="cursor-pointer hover:bg-slate-800/60 group transition-all">
                      <td className="px-5 py-4">
                        <div className="font-bold text-slate-200 group-hover:text-blue-400 transition-colors text-sm">{a.name}</div>
                        {a.eia_plant_code && <div className="text-[10px] text-slate-600 font-mono">EIA: {a.eia_plant_code}</div>}
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-[10px] px-2 py-0.5 rounded font-bold uppercase bg-blue-900/20 text-blue-400 border border-blue-500/20">
                          {a.technology || '—'}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-400">{a.state || '—'}</td>
                      <td className="px-5 py-4 text-right font-mono text-sm text-slate-300">{a.capacity_mw?.toLocaleString() || '—'}</td>
                      <td className="px-5 py-4">
                        <span className="text-[10px] font-bold uppercase text-slate-500">{a.status || '—'}</span>
                      </td>
                      <td className="px-5 py-4">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${matchBadge(a.match_confidence)}`}>
                          {a.match_confidence || 'none'}
                        </span>
                      </td>
                      <td className={`px-5 py-4 text-right font-mono text-sm font-bold ${confidenceColor(a.confidence_score)}`}>
                        {a.confidence_score != null ? a.confidence_score.toFixed(0) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Staged (Pending Review) */}
          {staged.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[10px] font-bold text-amber-500 uppercase tracking-widest flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  Pending Review ({staged.length})
                </h3>
                {selectedStaged.size > 0 && (
                  <button
                    onClick={handleApprove}
                    disabled={approving}
                    className="px-4 py-2 rounded-lg text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-all"
                  >
                    {approving ? 'Approving…' : `Graduate ${selectedStaged.size} Selected`}
                  </button>
                )}
              </div>
              <div className="bg-slate-900 border border-amber-500/20 rounded-2xl overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                      <th className="px-5 py-4 w-8">
                        <input
                          type="checkbox"
                          checked={selectedStaged.size === staged.length}
                          onChange={() => {
                            if (selectedStaged.size === staged.length) setSelectedStaged(new Set());
                            else setSelectedStaged(new Set(staged.map(a => a.id)));
                          }}
                          className="rounded border-slate-700"
                        />
                      </th>
                      <th className="px-5 py-4">Asset Name</th>
                      <th className="px-5 py-4">Blocking Reason</th>
                      <th className="px-5 py-4">Tech</th>
                      <th className="px-5 py-4">State</th>
                      <th className="px-5 py-4 text-right">MW</th>
                      <th className="px-5 py-4 text-right">Attempts</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {(assetSearch ? filteredAssets.filter(a => !a.graduated) : staged).map(a => (
                      <tr key={a.id} className="hover:bg-slate-800/60 transition-all">
                        <td className="px-5 py-4">
                          <input
                            type="checkbox"
                            checked={selectedStaged.has(a.id)}
                            onChange={() => toggleStaged(a.id)}
                            className="rounded border-slate-700"
                          />
                        </td>
                        <td className="px-5 py-4">
                          <div
                            onClick={() => onAssetClick(a.id)}
                            className="font-bold text-slate-200 hover:text-blue-400 transition-colors text-sm cursor-pointer"
                          >
                            {a.name}
                          </div>
                        </td>
                        <td className="px-5 py-4 text-sm text-amber-400/80">{a.blocking_reason || '—'}</td>
                        <td className="px-5 py-4 text-[10px] font-bold uppercase text-slate-500">{a.technology || '—'}</td>
                        <td className="px-5 py-4 text-sm text-slate-400">{a.state || '—'}</td>
                        <td className="px-5 py-4 text-right font-mono text-sm text-slate-300">{a.capacity_mw || '—'}</td>
                        <td className="px-5 py-4 text-right font-mono text-sm text-slate-600">{a.staging_attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Data Provenance Tab ── */}
      {tab === 'provenance' && (
        <div className="space-y-6">
          {/* Crawl Logs */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Crawl Run History</h3>
            {crawlLogs.length === 0 ? (
              <p className="text-sm text-slate-600">No crawl runs recorded.</p>
            ) : (
              <div className="space-y-3">
                {crawlLogs.map(log => (
                  <div key={log.id} className="flex items-center gap-4 p-3 rounded-lg bg-slate-800/50 border border-slate-800">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${
                      log.status === 'completed' ? 'bg-emerald-900/30 text-emerald-400 border-emerald-500/30'
                        : log.status === 'failed' ? 'bg-red-900/30 text-red-400 border-red-500/30'
                        : 'bg-blue-900/30 text-blue-400 border-blue-500/30'
                    }`}>
                      {log.status}
                    </span>
                    <span className="text-[10px] font-bold uppercase text-slate-500 w-20">{log.run_type}</span>
                    <span className="text-sm text-slate-400 flex-1">
                      {log.assets_discovered > 0 && `${log.assets_discovered} discovered`}
                      {log.assets_graduated > 0 && ` • ${log.assets_graduated} graduated`}
                      {log.assets_staged > 0 && ` • ${log.assets_staged} staged`}
                    </span>
                    <span className="text-sm font-mono text-amber-400">${log.total_cost_usd.toFixed(4)}</span>
                    <span className="text-[10px] text-slate-600 font-mono w-16 text-right">
                      R{log.rounds}
                    </span>
                    <span className="text-[10px] text-slate-600 w-24 text-right">
                      {new Date(log.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Cost Breakdown */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Cumulative Cost Breakdown</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="text-[10px] text-slate-600 mb-1">Total API Spend</div>
                <div className="text-xl font-black text-amber-400">${(developer.total_spend_usd || 0).toFixed(2)}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-600 mb-1">Crawl Runs</div>
                <div className="text-xl font-black text-white">{crawlLogs.length}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-600 mb-1">Cost per Asset</div>
                <div className="text-xl font-black text-white">
                  ${assets.length > 0 ? ((developer.total_spend_usd || 0) / assets.length).toFixed(4) : '0.00'}
                </div>
              </div>
            </div>
          </div>

          {/* Full Changelog */}
          {changelog.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-4">Change Log</h3>
              <div className="space-y-2 max-h-96 overflow-y-auto custom-scrollbar">
                {changelog.map(ch => (
                  <div key={ch.id} className="flex items-start gap-3 text-sm py-2 border-b border-slate-800/50 last:border-0">
                    <span className="text-[10px] text-slate-600 font-mono w-24 flex-shrink-0 pt-0.5">
                      {new Date(ch.detected_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase bg-slate-800 text-slate-500 border border-slate-700 flex-shrink-0">
                      {ch.change_type.replace(/_/g, ' ')}
                    </span>
                    <span className="text-slate-400 flex-1 min-w-0">
                      {ch.new_value?.details || (ch.old_value ? `${JSON.stringify(ch.old_value)} → ${JSON.stringify(ch.new_value)}` : JSON.stringify(ch.new_value))}
                    </span>
                    <span className="text-[9px] text-slate-700 flex-shrink-0">{ch.detected_by}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
