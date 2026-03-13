/**
 * GenTrack — TaxEquityDashboard
 *
 * Screens all tax equity investors from tax_equity_stats.
 * Sortable by distress score, committed capital, CF vs. benchmark, curtailment.
 * Clicking a row navigates to EntityDetailView with entityType='tax_equity'.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { TaxEquityStats } from '../types';
import { fetchAllTaxEquityStats } from '../services/taxEquityService';

interface Props {
  onInvestorClick: (investorName: string) => void;
}

type SortKey =
  | 'distress_score' | 'total_committed_usd' | 'asset_count'
  | 'portfolio_avg_cf' | 'cf_vs_benchmark' | 'pct_curtailed'
  | 'news_sentiment_score' | 'last_news_date';

function fmtUsd(v: number | null): string {
  if (v == null) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function cfDiff(s: TaxEquityStats): number | null {
  if (s.portfolioAvgCf == null || s.portfolioBenchmarkCf == null) return null;
  return s.portfolioAvgCf - s.portfolioBenchmarkCf;
}

function distressColor(score: number | null): string {
  if (score == null) return '#64748b';
  if (score >= 70) return '#ef4444';
  if (score >= 40) return '#f59e0b';
  return '#22c55e';
}

const TaxEquityDashboard: React.FC<Props> = ({ onInvestorClick }) => {
  const [investors, setInvestors] = useState<TaxEquityStats[]>([]);
  const [loading, setLoading]     = useState(true);
  const [sortKey, setSortKey]     = useState<SortKey>('distress_score');
  const [sortDesc, setSortDesc]   = useState(true);
  const [search, setSearch]       = useState('');
  const [minCommitted, setMinCommitted] = useState(0);
  const [page, setPage]           = useState(1);
  const PAGE_SIZE = 50;

  useEffect(() => {
    fetchAllTaxEquityStats().then(rows => { setInvestors(rows); setLoading(false); });
  }, []);

  const filtered = useMemo(() => {
    let result = investors;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(i => i.investorName.toLowerCase().includes(q));
    }

    if (minCommitted > 0) {
      result = result.filter(i => (i.totalCommittedUsd ?? 0) >= minCommitted);
    }

    result = [...result].sort((a, b) => {
      let va: number, vb: number;
      switch (sortKey) {
        case 'distress_score':       va = a.distressScore      ?? -1; vb = b.distressScore      ?? -1; break;
        case 'total_committed_usd':  va = a.totalCommittedUsd  ?? -1; vb = b.totalCommittedUsd  ?? -1; break;
        case 'asset_count':          va = a.assetCount;              vb = b.assetCount;              break;
        case 'portfolio_avg_cf':     va = a.portfolioAvgCf     ?? -1; vb = b.portfolioAvgCf     ?? -1; break;
        case 'cf_vs_benchmark': {
          const da = cfDiff(a); const db = cfDiff(b);
          va = da ?? -99; vb = db ?? -99; break;
        }
        case 'pct_curtailed':        va = a.pctCurtailed;            vb = b.pctCurtailed;            break;
        case 'news_sentiment_score': va = a.newsSentimentScore ?? -1; vb = b.newsSentimentScore ?? -1; break;
        case 'last_news_date':
          va = a.lastNewsDate ? new Date(a.lastNewsDate).getTime() : 0;
          vb = b.lastNewsDate ? new Date(b.lastNewsDate).getTime() : 0;
          break;
        default: va = a.distressScore ?? -1; vb = b.distressScore ?? -1;
      }
      return sortDesc ? vb - va : va - vb;
    });

    return result;
  }, [investors, search, minCommitted, sortKey, sortDesc]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDesc(d => !d);
    else { setSortKey(key); setSortDesc(true); }
    setPage(1);
  };

  const ColHeader = ({ k, label }: { k: SortKey; label: string }) => (
    <button
      onClick={() => toggleSort(k)}
      className={`flex items-center gap-1 text-[9px] font-black uppercase tracking-widest transition-colors whitespace-nowrap ${
        sortKey === k ? 'text-white' : 'text-slate-500 hover:text-slate-300'
      }`}
    >
      {label}
      {sortKey === k && <span className="text-[8px]">{sortDesc ? '▼' : '▲'}</span>}
    </button>
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-4xl font-black text-white tracking-tight mb-2">Tax Equity Intelligence</h1>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed">
          Tax equity investors ranked by distress score. Portfolio CF vs. regional benchmark signals yield risk from curtailment.
        </p>
      </div>

      {/* Filters */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-wrap gap-4 items-center shadow-lg">
        {/* Search */}
        <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/50 rounded-xl px-3 py-2 min-w-[220px]">
          <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search investor..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="bg-transparent text-xs text-slate-200 placeholder-slate-600 outline-none flex-1"
          />
        </div>

        {/* Min Committed */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Min Capital</span>
          {[0, 100e6, 500e6, 1e9].map(v => (
            <button
              key={v}
              onClick={() => { setMinCommitted(v); setPage(1); }}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all ${
                minCommitted === v
                  ? 'bg-slate-700 border-slate-500 text-white'
                  : 'bg-slate-800/40 border-slate-700/50 text-slate-500 hover:text-slate-300'
              }`}
            >
              {v === 0 ? 'Any' : fmtUsd(v)}
            </button>
          ))}
        </div>

        {/* Count badge */}
        <div className="ml-auto text-[10px] font-bold text-slate-500">
          <span className="text-white">{filtered.length}</span> investors
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="py-24 flex flex-col items-center justify-center space-y-4">
          <div className="w-12 h-12 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin" />
          <p className="text-slate-400 text-sm font-bold">Loading tax equity intelligence...</p>
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="py-20 text-center bg-slate-900 rounded-2xl border border-slate-800">
          <p className="text-sm font-bold text-slate-400">No investors match the current filters.</p>
          <p className="text-xs text-slate-600 mt-1">Run refresh-entity-stats to populate this dashboard.</p>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
            <div className="grid grid-cols-[2fr_0.8fr_1fr_0.8fr_0.9fr_0.8fr_0.8fr_1fr_0.9fr] gap-4 px-6 py-3 border-b border-slate-800 bg-slate-900/80">
              <ColHeader k="distress_score"      label="Investor" />
              <ColHeader k="asset_count"         label="Assets" />
              <ColHeader k="total_committed_usd" label="Committed" />
              <ColHeader k="portfolio_avg_cf"    label="Avg CF" />
              <ColHeader k="cf_vs_benchmark"     label="vs. Benchmark" />
              <ColHeader k="pct_curtailed"       label="% Curtailed" />
              <ColHeader k="news_sentiment_score" label="Sentiment" />
              <ColHeader k="distress_score"      label="Distress" />
              <ColHeader k="last_news_date"      label="Last News" />
            </div>

            {paginated.map(investor => {
              const diff = cfDiff(investor);

              return (
                <button
                  key={investor.investorName}
                  onClick={() => onInvestorClick(investor.investorName)}
                  className="w-full grid grid-cols-[2fr_0.8fr_1fr_0.8fr_0.9fr_0.8fr_0.8fr_1fr_0.9fr] gap-4 px-6 py-4 border-b border-slate-800/60 hover:bg-slate-800/40 transition-all text-left group"
                >
                  {/* Name */}
                  <div className="flex flex-col justify-center gap-0.5 min-w-0">
                    <span className="text-sm font-bold text-slate-200 group-hover:text-white truncate">{investor.investorName}</span>
                    <span className="text-[8px] text-slate-600">Tax Equity</span>
                  </div>

                  {/* Assets */}
                  <div className="flex items-center">
                    <span className="text-xs font-black text-slate-300">{investor.assetCount}</span>
                  </div>

                  {/* Committed */}
                  <div className="flex items-center">
                    <span className="text-xs font-black text-slate-300">{fmtUsd(investor.totalCommittedUsd)}</span>
                  </div>

                  {/* Portfolio Avg CF */}
                  <div className="flex items-center">
                    <span className="text-xs font-black text-slate-300">
                      {investor.portfolioAvgCf != null ? `${(investor.portfolioAvgCf * 100).toFixed(0)}%` : '—'}
                    </span>
                  </div>

                  {/* vs Benchmark */}
                  <div className="flex items-center">
                    {diff != null ? (
                      <span className={`text-xs font-black ${diff >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {diff >= 0 ? '+' : ''}{(diff * 100).toFixed(1)}pp
                      </span>
                    ) : (
                      <span className="text-xs text-slate-700">—</span>
                    )}
                  </div>

                  {/* % Curtailed */}
                  <div className="flex items-center">
                    <span className={`text-xs font-black ${investor.pctCurtailed >= 50 ? 'text-red-400' : investor.pctCurtailed >= 25 ? 'text-amber-400' : 'text-slate-300'}`}>
                      {investor.pctCurtailed.toFixed(0)}%
                    </span>
                  </div>

                  {/* News Sentiment */}
                  <div className="flex items-center">
                    {investor.newsSentimentScore != null ? (
                      <span className={`text-xs font-black ${
                        investor.newsSentimentScore >= 60 ? 'text-green-400' :
                        investor.newsSentimentScore >= 40 ? 'text-amber-400' : 'text-red-400'
                      }`}>
                        {investor.newsSentimentScore.toFixed(0)}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-700">—</span>
                    )}
                  </div>

                  {/* Distress score bar */}
                  <div className="flex items-center gap-2">
                    {investor.distressScore != null ? (
                      <>
                        <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width:           `${investor.distressScore}%`,
                              backgroundColor: distressColor(investor.distressScore),
                            }}
                          />
                        </div>
                        <span className="text-[9px] font-black text-slate-400 w-7 text-right">
                          {investor.distressScore.toFixed(0)}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-slate-700">—</span>
                    )}
                  </div>

                  {/* Last News */}
                  <div className="flex items-center">
                    <span className="text-[10px] text-slate-500">{fmtDate(investor.lastNewsDate)}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 py-2">
              <button onClick={() => setPage(1)} disabled={page === 1} className="px-2 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30">««</button>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-3 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30">‹ Prev</button>
              <span className="text-xs font-bold text-slate-500">{page} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-3 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30">Next ›</button>
              <button onClick={() => setPage(totalPages)} disabled={page === totalPages} className="px-2 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30">»»</button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default TaxEquityDashboard;
