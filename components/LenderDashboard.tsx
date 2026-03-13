/**
 * GenTrack — LenderDashboard
 *
 * Screens all lender entities from lender_stats.
 * Sortable by distress score, exposure, CF, curtailment, sentiment.
 * Clicking a row navigates to EntityDetailView with entityType='lender'.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { LenderStats } from '../types';
import { fetchAllLenderStats } from '../services/lenderStatsService';

interface Props {
  onLenderClick: (lenderName: string) => void;
}

type SortKey =
  | 'distress_score' | 'total_exposure_usd' | 'asset_count'
  | 'avg_plant_cf' | 'pct_curtailed' | 'news_sentiment_score' | 'last_news_date';

const FACILITY_COLORS: Record<string, string> = {
  term_loan:         '#22d3ee',
  revolver:          '#818cf8',
  construction_loan: '#f59e0b',
  bond:              '#a855f7',
  bridge_loan:       '#fb923c',
  letter_of_credit:  '#34d399',
  mezzanine:         '#f472b6',
  preferred_equity:  '#60a5fa',
  other:             '#64748b',
};

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

function distressColor(score: number | null): string {
  if (score == null) return '#64748b';
  if (score >= 70) return '#ef4444';
  if (score >= 40) return '#f59e0b';
  return '#22c55e';
}

const LenderDashboard: React.FC<Props> = ({ onLenderClick }) => {
  const [lenders, setLenders]     = useState<LenderStats[]>([]);
  const [loading, setLoading]     = useState(true);
  const [sortKey, setSortKey]     = useState<SortKey>('distress_score');
  const [sortDesc, setSortDesc]   = useState(true);
  const [search, setSearch]       = useState('');
  const [minExposure, setMinExposure] = useState(0);
  const [page, setPage]           = useState(1);
  const PAGE_SIZE = 50;

  useEffect(() => {
    fetchAllLenderStats().then(rows => { setLenders(rows); setLoading(false); });
  }, []);

  const filtered = useMemo(() => {
    let result = lenders;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(l => l.lenderName.toLowerCase().includes(q));
    }

    if (minExposure > 0) {
      result = result.filter(l => (l.totalExposureUsd ?? 0) >= minExposure);
    }

    result = [...result].sort((a, b) => {
      let va: number, vb: number;
      switch (sortKey) {
        case 'distress_score':       va = a.distressScore       ?? -1; vb = b.distressScore       ?? -1; break;
        case 'total_exposure_usd':   va = a.totalExposureUsd    ?? -1; vb = b.totalExposureUsd    ?? -1; break;
        case 'asset_count':          va = a.assetCount;               vb = b.assetCount;               break;
        case 'avg_plant_cf':         va = a.avgPlantCf          ?? -1; vb = b.avgPlantCf          ?? -1; break;
        case 'pct_curtailed':        va = a.pctCurtailed;             vb = b.pctCurtailed;             break;
        case 'news_sentiment_score': va = a.newsSentimentScore  ?? -1; vb = b.newsSentimentScore  ?? -1; break;
        case 'last_news_date':       va = a.lastNewsDate ? new Date(a.lastNewsDate).getTime() : 0; vb = b.lastNewsDate ? new Date(b.lastNewsDate).getTime() : 0; break;
        default:                     va = a.distressScore ?? -1; vb = b.distressScore ?? -1;
      }
      return sortDesc ? vb - va : va - vb;
    });

    return result;
  }, [lenders, search, minExposure, sortKey, sortDesc]);

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
        <h1 className="text-4xl font-black text-white tracking-tight mb-2">Lender Intelligence</h1>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed">
          Portfolio lenders ranked by distress score. Data aggregated from financing articles — high distress indicates curtailment risk across the lender's book.
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
            placeholder="Search lender..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="bg-transparent text-xs text-slate-200 placeholder-slate-600 outline-none flex-1"
          />
        </div>

        {/* Min Exposure */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Min Exposure</span>
          {[0, 100e6, 500e6, 1e9].map(v => (
            <button
              key={v}
              onClick={() => { setMinExposure(v); setPage(1); }}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all ${
                minExposure === v
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
          <span className="text-white">{filtered.length}</span> lenders
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="py-24 flex flex-col items-center justify-center space-y-4">
          <div className="w-12 h-12 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin" />
          <p className="text-slate-400 text-sm font-bold">Loading lender intelligence...</p>
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="py-20 text-center bg-slate-900 rounded-2xl border border-slate-800">
          <p className="text-sm font-bold text-slate-400">No lenders match the current filters.</p>
          <p className="text-xs text-slate-600 mt-1">Run refresh-entity-stats to populate this dashboard.</p>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
            {/* Header row */}
            <div className="grid grid-cols-[2fr_0.8fr_1fr_0.8fr_0.8fr_1fr_0.8fr_1fr_0.9fr] gap-4 px-6 py-3 border-b border-slate-800 bg-slate-900/80">
              <ColHeader k="distress_score"     label="Lender" />
              <ColHeader k="asset_count"        label="Assets" />
              <ColHeader k="total_exposure_usd" label="Exposure" />
              <ColHeader k="avg_plant_cf"       label="Avg CF" />
              <ColHeader k="pct_curtailed"      label="% Curtailed" />
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Loan Types</span>
              <ColHeader k="news_sentiment_score" label="Sentiment" />
              <ColHeader k="distress_score"     label="Distress" />
              <ColHeader k="last_news_date"     label="Last News" />
            </div>

            {paginated.map(lender => (
              <button
                key={lender.lenderName}
                onClick={() => onLenderClick(lender.lenderName)}
                className="w-full grid grid-cols-[2fr_0.8fr_1fr_0.8fr_0.8fr_1fr_0.8fr_1fr_0.9fr] gap-4 px-6 py-4 border-b border-slate-800/60 hover:bg-slate-800/40 transition-all text-left group"
              >
                {/* Name */}
                <div className="flex flex-col justify-center gap-1 min-w-0">
                  <span className="text-sm font-bold text-slate-200 group-hover:text-white truncate">{lender.lenderName}</span>
                  {lender.facilityTypes.length > 0 && (
                    <span className="text-[8px] text-slate-500 truncate">{lender.facilityTypes.join(' · ')}</span>
                  )}
                </div>

                {/* Assets */}
                <div className="flex items-center">
                  <span className="text-xs font-black text-slate-300">{lender.assetCount}</span>
                </div>

                {/* Exposure */}
                <div className="flex items-center">
                  <span className="text-xs font-black text-slate-300">{fmtUsd(lender.totalExposureUsd)}</span>
                </div>

                {/* Avg CF */}
                <div className="flex items-center">
                  <span className="text-xs font-black text-slate-300">
                    {lender.avgPlantCf != null ? `${(lender.avgPlantCf * 100).toFixed(0)}%` : '—'}
                  </span>
                </div>

                {/* % Curtailed */}
                <div className="flex items-center">
                  <span className={`text-xs font-black ${lender.pctCurtailed >= 50 ? 'text-red-400' : lender.pctCurtailed >= 25 ? 'text-amber-400' : 'text-slate-300'}`}>
                    {lender.pctCurtailed.toFixed(0)}%
                  </span>
                </div>

                {/* Loan type dots */}
                <div className="flex items-center gap-1 flex-wrap">
                  {lender.facilityTypes.slice(0, 4).map(ft => (
                    <span
                      key={ft}
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: FACILITY_COLORS[ft] ?? FACILITY_COLORS.other }}
                      title={ft.replace('_', ' ')}
                    />
                  ))}
                </div>

                {/* News Sentiment */}
                <div className="flex items-center">
                  {lender.newsSentimentScore != null ? (
                    <span className={`text-xs font-black ${
                      lender.newsSentimentScore >= 60 ? 'text-green-400' :
                      lender.newsSentimentScore >= 40 ? 'text-amber-400' : 'text-red-400'
                    }`}>
                      {lender.newsSentimentScore.toFixed(0)}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-700">—</span>
                  )}
                </div>

                {/* Distress score bar */}
                <div className="flex items-center gap-2">
                  {lender.distressScore != null ? (
                    <>
                      <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width:           `${lender.distressScore}%`,
                            backgroundColor: distressColor(lender.distressScore),
                          }}
                        />
                      </div>
                      <span className="text-[9px] font-black text-slate-400 w-7 text-right">
                        {lender.distressScore.toFixed(0)}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-slate-700">—</span>
                  )}
                </div>

                {/* Last News */}
                <div className="flex items-center">
                  <span className="text-[10px] text-slate-500">{fmtDate(lender.lastNewsDate)}</span>
                </div>
              </button>
            ))}
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

export default LenderDashboard;
