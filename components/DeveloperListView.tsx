import React, { useState, useEffect, useMemo } from 'react';
import { fetchDevelopers, DeveloperRow } from '../services/developerService';

interface Props {
  onDeveloperClick: (developerId: string) => void;
}

function statusBadge(status: string) {
  const styles: Record<string, string> = {
    completed: 'bg-green-900/30 text-green-400 border-green-500/30',
    running: 'bg-blue-900/30 text-blue-400 border-blue-500/30',
    pending: 'bg-slate-800 text-slate-500 border-slate-700',
    failed: 'bg-red-900/30 text-red-400 border-red-500/30',
    budget_paused: 'bg-amber-900/30 text-amber-400 border-amber-500/30',
  };
  return styles[status] || styles.pending;
}

export default function DeveloperListView({ onDeveloperClick }: Props) {
  const [developers, setDevelopers] = useState<DeveloperRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'name' | 'assets' | 'coverage' | 'spend'>('name');
  const [sortDesc, setSortDesc] = useState(false);

  useEffect(() => {
    fetchDevelopers().then(devs => {
      setDevelopers(devs);
      setLoading(false);
    });
  }, []);

  const toggleSort = (key: typeof sort) => {
    if (sort === key) setSortDesc(d => !d);
    else { setSort(key); setSortDesc(true); }
  };

  const filtered = useMemo(() => {
    let rows = developers;
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(d => d.name.toLowerCase().includes(q) || (d.hq_state || '').toLowerCase().includes(q));
    }
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sort === 'name') cmp = a.name.localeCompare(b.name);
      else if (sort === 'assets') cmp = (a.asset_count_discovered || 0) - (b.asset_count_discovered || 0);
      else if (sort === 'coverage') cmp = (a.coverage_rate || 0) - (b.coverage_rate || 0);
      else if (sort === 'spend') cmp = (a.total_spend_usd || 0) - (b.total_spend_usd || 0);
      return sortDesc ? -cmp : cmp;
    });
  }, [developers, search, sort, sortDesc]);

  // Summary stats
  const totalAssets = developers.reduce((s, d) => s + (d.asset_count_discovered || 0), 0);
  const totalSpend = developers.reduce((s, d) => s + (d.total_spend_usd || 0), 0);
  const avgCoverage = developers.length > 0
    ? developers.reduce((s, d) => s + (d.coverage_rate || 0), 0) / developers.length
    : 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500">
        Loading developer registry…
      </div>
    );
  }

  return (
    <div>
      <header className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-4xl font-black text-white mb-2 tracking-tight">Developer Registry</h1>
          <p className="text-slate-400 font-medium max-w-xl leading-relaxed">
            AI-crawled developer portfolios with EIA-validated asset coverage. {developers.length} developer{developers.length !== 1 ? 's' : ''} tracked.
          </p>
        </div>
      </header>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Developers</div>
          <div className="text-2xl font-black text-white">{developers.length}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Total Assets</div>
          <div className="text-2xl font-black text-white">{totalAssets.toLocaleString()}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Avg Coverage</div>
          <div className="text-2xl font-black text-emerald-400">{(avgCoverage * 100).toFixed(0)}%</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest mb-1">Total API Spend</div>
          <div className="text-2xl font-black text-amber-400">${totalSpend.toFixed(2)}</div>
        </div>
      </div>

      {/* Search */}
      <div className="mb-6">
        <input
          type="text"
          placeholder="Search developers…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-md px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-600 transition-colors"
        />
      </div>

      {/* Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                <th className="px-6 py-5 cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('name')}>
                  Developer {sort === 'name' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5">Status</th>
                <th className="px-6 py-5 text-right cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('assets')}>
                  Assets {sort === 'assets' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-right">EIA Benchmark</th>
                <th className="px-6 py-5 text-right cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('coverage')}>
                  Coverage {sort === 'coverage' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-right">Confidence</th>
                <th className="px-6 py-5 text-right">Verified</th>
                <th className="px-6 py-5 text-right cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('spend')}>
                  API Spend {sort === 'spend' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-right">Last Pulse</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map(dev => (
                <tr
                  key={dev.id}
                  onClick={() => onDeveloperClick(dev.id)}
                  className="cursor-pointer transition-all hover:bg-slate-800/60 group"
                >
                  <td className="px-6 py-5">
                    <div className="font-bold text-slate-200 group-hover:text-blue-400 transition-colors text-sm">{dev.name}</div>
                    <div className="text-[10px] text-slate-600">{dev.entity_type || 'developer'} {dev.hq_state ? `• ${dev.hq_state}` : ''}</div>
                  </td>
                  <td className="px-6 py-5">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${statusBadge(dev.crawl_status)}`}>
                      {dev.crawl_status}
                    </span>
                  </td>
                  <td className="px-6 py-5 text-right font-mono text-sm text-slate-300">
                    {dev.asset_count_discovered || 0}
                  </td>
                  <td className="px-6 py-5 text-right font-mono text-sm text-slate-500">
                    {dev.eia_benchmark_count ?? '—'}
                  </td>
                  <td className="px-6 py-5 text-right">
                    <div className="font-mono text-sm font-bold text-slate-200">
                      {dev.coverage_rate != null ? `${(dev.coverage_rate * 100).toFixed(0)}%` : '—'}
                    </div>
                    <div className="w-full h-1 bg-slate-800 rounded-full mt-1 overflow-hidden max-w-[60px] ml-auto">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all"
                        style={{ width: `${Math.min(100, (dev.coverage_rate || 0) * 100)}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-6 py-5 text-right font-mono text-sm text-slate-300">
                    {dev.avg_confidence != null ? `${dev.avg_confidence.toFixed(0)}` : '—'}
                  </td>
                  <td className="px-6 py-5 text-right font-mono text-sm text-slate-300">
                    {dev.verification_pct != null ? `${(dev.verification_pct * 100).toFixed(0)}%` : '—'}
                  </td>
                  <td className="px-6 py-5 text-right font-mono text-sm text-amber-400">
                    ${(dev.total_spend_usd || 0).toFixed(2)}
                  </td>
                  <td className="px-6 py-5 text-right text-[10px] text-slate-600">
                    {dev.last_pulse_at
                      ? new Date(dev.last_pulse_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="py-20 text-center text-slate-700">
            <p className="font-semibold text-lg">No developers found</p>
            <p className="text-sm">Run the crawl pipeline to populate the developer registry.</p>
          </div>
        )}
      </div>
    </div>
  );
}
