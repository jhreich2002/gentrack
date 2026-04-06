import React, { useState, useEffect, useMemo } from 'react';
import {
  fetchDevelopers,
  fetchDeveloperAssets,
  fetchDeveloperOpportunityScores,
  DeveloperRow,
  AssetRegistryRow,
  DeveloperOpportunityScoreRow,
} from '../services/developerService';

const TYPICAL_CF: Record<string, number> = {
  solar: 0.22,
  wind: 0.35,
  nuclear: 0.92,
  storage: 0.15,
};

function computePortfolioStats(assets: AssetRegistryRow[]) {
  let totalMw = 0;
  let weightedCfSum = 0;
  const techSet = new Set<string>();
  const stateSet = new Set<string>();
  for (const a of assets) {
    const mw = a.capacity_mw || 0;
    totalMw += mw;
    const tech = (a.technology || '').toLowerCase();
    const cf = Object.entries(TYPICAL_CF).find(([k]) => tech.includes(k))?.[1] ?? 0.22;
    weightedCfSum += mw * cf;
    if (a.technology) techSet.add(a.technology);
    if (a.state) stateSet.add(a.state);
  }
  return {
    totalGw: totalMw / 1000,
    avgCf: totalMw > 0 ? weightedCfSum / totalMw : 0,
    techs: Array.from(techSet),
    states: Array.from(stateSet),
  };
}

interface Props {
  onDeveloperClick: (developerId: string) => void;
}

interface DevStats {
  totalGw: number;
  avgCf: number;
  techs: string[];
  states: string[];
}

function scoreTone(score: number | null): string {
  if (score == null) return 'text-slate-600';
  if (score >= 70) return 'text-red-400';
  if (score >= 50) return 'text-amber-400';
  return 'text-emerald-400';
}

export default function DeveloperListView({ onDeveloperClick }: Props) {
  const [developers, setDevelopers] = useState<DeveloperRow[]>([]);
  const [stats, setStats] = useState<Record<string, DevStats>>({});
  const [opportunities, setOpportunities] = useState<Record<string, DeveloperOpportunityScoreRow>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [fuelFilter, setFuelFilter] = useState('all');
  const [minLeadScore, setMinLeadScore] = useState(0);
  const [serviceLineFilter, setServiceLineFilter] = useState('all');

  useEffect(() => {
    Promise.all([fetchDevelopers(), fetchDeveloperOpportunityScores()]).then(async ([devs, oppMap]) => {
      // Compute portfolio stats and only keep developers with actual asset data
      const statsMap: Record<string, DevStats> = {};
      const withData: DeveloperRow[] = [];
      await Promise.all(
        devs.map(async dev => {
          const assets = await fetchDeveloperAssets(dev.id);
          if (assets.length > 0) {
            statsMap[dev.id] = computePortfolioStats(assets);
            withData.push(dev);
          }
        })
      );
      withData.sort((a, b) => {
        const aScore = oppMap[a.id]?.opportunity_score ?? -1;
        const bScore = oppMap[b.id]?.opportunity_score ?? -1;
        if (bScore !== aScore) return bScore - aScore;
        return (b.asset_count_discovered || 0) - (a.asset_count_discovered || 0);
      });

      setDevelopers(withData);
      setStats(statsMap);
      setOpportunities(oppMap);
      setLoading(false);
    });
  }, []);

  const allStates = useMemo(() => {
    const s = new Set<string>();
    Object.values(stats).forEach((st: DevStats) => st.states.forEach(v => s.add(v)));
    return ['all', ...Array.from(s).sort()];
  }, [stats]);

  const allFuels = useMemo(() => {
    const s = new Set<string>();
    Object.values(stats).forEach((st: DevStats) => st.techs.forEach(v => s.add(v)));
    return ['all', ...Array.from(s).sort()];
  }, [stats]);

  const allServiceLines = useMemo(() => {
    const s = new Set<string>();
    Object.values(opportunities).forEach((opp) => {
      (opp.recommended_service_lines || []).forEach((line) => s.add(line));
    });
    return ['all', ...Array.from(s).sort()];
  }, [opportunities]);

  const filtered = useMemo(() => {
    let rows = developers;
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(d => d.name.toLowerCase().includes(q));
    }
    if (stateFilter !== 'all') {
      rows = rows.filter(d => stats[d.id]?.states.includes(stateFilter));
    }
    if (fuelFilter !== 'all') {
      rows = rows.filter(d => stats[d.id]?.techs.includes(fuelFilter));
    }
    rows = rows.filter((d) => (opportunities[d.id]?.opportunity_score ?? 0) >= minLeadScore);
    if (serviceLineFilter !== 'all') {
      rows = rows.filter((d) => (opportunities[d.id]?.recommended_service_lines || []).includes(serviceLineFilter));
    }
    return rows;
  }, [developers, search, stateFilter, fuelFilter, minLeadScore, serviceLineFilter, stats, opportunities]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500">
        Loading developer registry…
      </div>
    );
  }

  return (
    <div>
      <header className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-2 h-8 rounded-full bg-blue-500" />
          <h1 className="text-4xl font-black text-white tracking-tight">Developer Registry</h1>
        </div>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed">
          AI-crawled developer portfolios with EIA-validated asset coverage.
          {developers.length > 0 && ` ${developers.length} developers tracked.`}
        </p>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="text"
          placeholder="Search developer name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500 w-48"
        />
        <select
          value={stateFilter}
          onChange={e => setStateFilter(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
        >
          {allStates.map(s => <option key={s} value={s}>{s === 'all' ? 'All States' : s}</option>)}
        </select>
        <select
          value={fuelFilter}
          onChange={e => setFuelFilter(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
        >
          {allFuels.map(f => <option key={f} value={f}>{f === 'all' ? 'All Fuels' : f}</option>)}
        </select>
        <select
          value={serviceLineFilter}
          onChange={e => setServiceLineFilter(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
        >
          {allServiceLines.map(line => (
            <option key={line} value={line}>{line === 'all' ? 'All Service Lines' : line.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <div className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 flex items-center gap-2">
          <span className="text-slate-500">Min Lead Score</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={minLeadScore}
            onChange={e => setMinLeadScore(Number(e.target.value))}
            className="accent-blue-500"
          />
          <span className="font-mono text-xs w-8 text-right">{minLeadScore}</span>
        </div>
      </div>

      {/* Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                <th className="px-6 py-5">Developer</th>
                <th className="px-6 py-5 text-right">Lead Score</th>
                <th className="px-6 py-5 text-right">Δ 7d</th>
                <th className="px-6 py-5">Lead Signal</th>
                <th className="px-6 py-5 text-right">Assets</th>
                <th className="px-6 py-5 text-right">Portfolio (GW)</th>
                <th className="px-6 py-5 text-right">Avg Capacity Factor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map(dev => {
                const s = stats[dev.id];
                const opp = opportunities[dev.id];
                const oppScore = opp?.opportunity_score ?? null;
                const delta = opp?.weekly_delta_score ?? null;
                const leadSignal = opp?.top_signals?.[0] || 'Run score:developers to generate signals';
                return (
                  <tr
                    key={dev.id}
                    onClick={() => onDeveloperClick(dev.id)}
                    className="cursor-pointer transition-all hover:bg-slate-800/60 group"
                  >
                    <td className="px-6 py-5">
                      <div className="font-bold text-slate-200 group-hover:text-blue-400 transition-colors text-sm">{dev.name}</div>
                      <div className="text-[10px] text-slate-600">{dev.hq_state || ''}</div>
                    </td>
                    <td className={`px-6 py-5 text-right font-mono text-sm font-bold ${scoreTone(oppScore)}`}>
                      {oppScore != null ? oppScore.toFixed(1) : '—'}
                    </td>
                    <td className={`px-6 py-5 text-right font-mono text-sm font-bold ${
                      delta == null ? 'text-slate-600' : delta > 0 ? 'text-red-400' : delta < 0 ? 'text-emerald-400' : 'text-slate-500'
                    }`}>
                      {delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`}
                    </td>
                    <td className="px-6 py-5 max-w-[420px]">
                      <div className="text-xs text-slate-400 truncate" title={leadSignal}>{leadSignal}</div>
                    </td>
                    <td className="px-6 py-5 text-right font-mono text-sm text-slate-300">
                      {dev.asset_count_discovered || 0}
                    </td>
                    <td className="px-6 py-5 text-right font-mono text-sm text-slate-300">
                      {s ? s.totalGw.toFixed(2) : '—'}
                    </td>
                    <td className="px-6 py-5 text-right font-mono text-sm text-emerald-400">
                      {s ? `${(s.avgCf * 100).toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {developers.length === 0 && (
          <div className="py-20 text-center text-slate-700">
            <p className="font-semibold text-lg">No developers found</p>
            <p className="text-sm">Run the crawl pipeline to populate the developer registry.</p>
          </div>
        )}
      </div>
    </div>
  );
}
