import React, { useState, useEffect } from 'react';
import { fetchDevelopers, fetchDeveloperAssets, DeveloperRow, AssetRegistryRow } from '../services/developerService';

const TYPICAL_CF: Record<string, number> = {
  solar: 0.22,
  wind: 0.35,
  nuclear: 0.92,
  storage: 0.15,
};

function computePortfolioStats(assets: AssetRegistryRow[]) {
  let totalMw = 0;
  let weightedCfSum = 0;
  for (const a of assets) {
    const mw = a.capacity_mw || 0;
    totalMw += mw;
    const tech = (a.technology || '').toLowerCase();
    const cf = Object.entries(TYPICAL_CF).find(([k]) => tech.includes(k))?.[1] ?? 0.22;
    weightedCfSum += mw * cf;
  }
  return {
    totalGw: totalMw / 1000,
    avgCf: totalMw > 0 ? weightedCfSum / totalMw : 0,
  };
}

interface Props {
  onDeveloperClick: (developerId: string) => void;
}

interface DevStats {
  totalGw: number;
  avgCf: number;
}

export default function DeveloperListView({ onDeveloperClick }: Props) {
  const [developers, setDevelopers] = useState<DeveloperRow[]>([]);
  const [stats, setStats] = useState<Record<string, DevStats>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDevelopers().then(async devs => {
      // Only show Cypress Creek Renewables
      const filtered = devs.filter(d => d.name.toLowerCase().includes('cypress creek'));
      setDevelopers(filtered);

      // Compute portfolio stats for each developer
      const statsMap: Record<string, DevStats> = {};
      await Promise.all(
        filtered.map(async dev => {
          const assets = await fetchDeveloperAssets(dev.id);
          statsMap[dev.id] = computePortfolioStats(assets);
        })
      );
      setStats(statsMap);
      setLoading(false);
    });
  }, []);

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
            AI-crawled developer portfolios with EIA-validated asset coverage.
          </p>
        </div>
      </header>

      {/* Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                <th className="px-6 py-5">Developer</th>
                <th className="px-6 py-5 text-right">Assets</th>
                <th className="px-6 py-5 text-right">Portfolio (GW)</th>
                <th className="px-6 py-5 text-right">Avg Capacity Factor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {developers.map(dev => {
                const s = stats[dev.id];
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
