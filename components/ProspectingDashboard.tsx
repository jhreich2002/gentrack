/**
 * GenTrack — ProspectingDashboard
 *
 * Screens all companies in company_stats by composite FTI advisory signal.
 * Sortable by any service-line score, total MW, or plant count.
 * Clicking a row navigates to CompanyDetailView.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { CompanyStats } from '../types';
import { fetchAllCompanyStats } from '../services/companyService';

interface Props {
  onCompanyClick: (ultParentName: string) => void;
}

type SortKey = 'restructuring' | 'transactions' | 'disputes' | 'market_strategy' | 'total_mw' | 'plant_count' | 'avg_cf' | 'composite';

const FTI_SERVICE_LINES: SortKey[] = ['restructuring', 'transactions', 'disputes', 'market_strategy'];

const FTI_LABELS: Record<string, string> = {
  restructuring:   'Restructuring',
  transactions:    'Transactions',
  disputes:        'Disputes',
  market_strategy: 'Mkt Strategy',
};

const FTI_COLORS: Record<string, string> = {
  restructuring:   '#ef4444',
  transactions:    '#22c55e',
  disputes:        '#f59e0b',
  market_strategy: '#6366f1',
};

const TECH_DOTS: Record<string, string> = {
  Solar:   '#f59e0b',
  Wind:    '#22d3ee',
  Nuclear: '#a855f7',
};

/** Weighted composite score: restructuring × 3, transactions × 2, disputes × 2, market_strategy × 1 */
function compositeScore(s: CompanyStats): number {
  return (
    (s.relevanceScores['restructuring']   ?? 0) * 3 +
    (s.relevanceScores['transactions']    ?? 0) * 2 +
    (s.relevanceScores['disputes']        ?? 0) * 2 +
    (s.relevanceScores['market_strategy'] ?? 0) * 1
  );
}

const ProspectingDashboard: React.FC<Props> = ({ onCompanyClick }) => {
  const [companies, setCompanies] = useState<CompanyStats[]>([]);
  const [loading, setLoading]     = useState(true);
  const [sortKey, setSortKey]     = useState<SortKey>('composite');
  const [sortDesc, setSortDesc]   = useState(true);
  const [serviceFilter, setServiceFilter] = useState<string>('all');
  const [search, setSearch]       = useState('');
  const [minMw, setMinMw]         = useState(0);
  const [page, setPage]           = useState(1);
  const PAGE_SIZE = 50;

  useEffect(() => {
    fetchAllCompanyStats().then(rows => { setCompanies(rows); setLoading(false); });
  }, []);

  // ── Filter + Sort ──────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let result = companies;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(c => c.ultParentName.toLowerCase().includes(q));
    }

    if (minMw > 0) {
      result = result.filter(c => c.totalMw >= minMw);
    }

    if (serviceFilter !== 'all') {
      // Only show companies with a non-zero score in the selected service line
      result = result.filter(c => (c.relevanceScores[serviceFilter] ?? 0) > 0);
    }

    result = [...result].sort((a, b) => {
      let va: number, vb: number;
      switch (sortKey) {
        case 'restructuring':   va = a.relevanceScores['restructuring']   ?? 0; vb = b.relevanceScores['restructuring']   ?? 0; break;
        case 'transactions':    va = a.relevanceScores['transactions']    ?? 0; vb = b.relevanceScores['transactions']    ?? 0; break;
        case 'disputes':        va = a.relevanceScores['disputes']        ?? 0; vb = b.relevanceScores['disputes']        ?? 0; break;
        case 'market_strategy': va = a.relevanceScores['market_strategy'] ?? 0; vb = b.relevanceScores['market_strategy'] ?? 0; break;
        case 'total_mw':        va = a.totalMw;    vb = b.totalMw;    break;
        case 'plant_count':     va = a.plantCount; vb = b.plantCount; break;
        case 'avg_cf':          va = a.avgCf;      vb = b.avgCf;      break;
        default:                va = compositeScore(a); vb = compositeScore(b);
      }
      return sortDesc ? vb - va : va - vb;
    });

    return result;
  }, [companies, search, minMw, serviceFilter, sortKey, sortDesc]);

  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated   = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const maxComposite = filtered.length > 0 ? Math.max(1, ...filtered.map(compositeScore)) : 1;

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
        <h1 className="text-4xl font-black text-white tracking-tight mb-2">Prospecting Intelligence</h1>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed">
          All portfolio companies ranked by FTI advisory signal strength. Scores are weighted sums from news article classifications — high scores indicate active mandate opportunities.
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
            placeholder="Search company..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="bg-transparent text-xs text-slate-200 placeholder-slate-600 outline-none flex-1"
          />
        </div>

        {/* Service line filter */}
        <div className="flex gap-1">
          {(['all', ...FTI_SERVICE_LINES] as string[]).map(sl => (
            <button
              key={sl}
              onClick={() => { setServiceFilter(sl); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-all ${
                serviceFilter === sl
                  ? sl === 'all'
                    ? 'bg-slate-600 border-slate-400 text-white'
                    : `border-transparent text-white`
                  : 'bg-slate-800/40 border-slate-700/50 text-slate-500 hover:text-slate-300'
              }`}
              style={serviceFilter === sl && sl !== 'all' ? { backgroundColor: FTI_COLORS[sl], borderColor: FTI_COLORS[sl] } : {}}
            >
              {sl === 'all' ? 'All' : FTI_LABELS[sl]}
            </button>
          ))}
        </div>

        {/* Min MW */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Min MW</span>
          {[0, 100, 500, 1000, 5000].map(mw => (
            <button
              key={mw}
              onClick={() => { setMinMw(mw); setPage(1); }}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all ${
                minMw === mw
                  ? 'bg-slate-700 border-slate-500 text-white'
                  : 'bg-slate-800/40 border-slate-700/50 text-slate-500 hover:text-slate-300'
              }`}
            >
              {mw === 0 ? 'Any' : `${mw >= 1000 ? `${mw / 1000}k` : mw}`}
            </button>
          ))}
        </div>

        {/* Count badge */}
        <div className="ml-auto text-[10px] font-bold text-slate-500">
          <span className="text-white">{filtered.length}</span> companies
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="py-24 flex flex-col items-center justify-center space-y-4">
          <div className="w-12 h-12 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin" />
          <p className="text-slate-400 text-sm font-bold">Loading company intelligence...</p>
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="py-20 text-center bg-slate-900 rounded-2xl border border-slate-800">
          <p className="text-sm font-bold text-slate-400">No companies match the current filters.</p>
          <p className="text-xs text-slate-600 mt-1">Run company-stats-refresh to populate this dashboard.</p>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
            {/* Table header */}
            <div className="grid grid-cols-[2fr_1fr_1fr_1fr_repeat(4,_0.8fr)_1.2fr] gap-4 px-6 py-3 border-b border-slate-800 bg-slate-900/80">
              <ColHeader k="composite"     label="Company" />
              <ColHeader k="total_mw"     label="Total MW" />
              <ColHeader k="plant_count"  label="Plants" />
              <ColHeader k="avg_cf"       label="Avg CF" />
              <ColHeader k="restructuring"   label="Restruct." />
              <ColHeader k="transactions"    label="Trans." />
              <ColHeader k="disputes"        label="Disputes" />
              <ColHeader k="market_strategy" label="Mkt Strat." />
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Composite Signal</span>
            </div>

            {/* Rows */}
            {paginated.map((company) => {
              const composite = compositeScore(company);
              const compositePct = (composite / maxComposite) * 100;
              const techKeys = Object.keys(company.techBreakdown);

              return (
                <button
                  key={company.ultParentName}
                  onClick={() => onCompanyClick(company.ultParentName)}
                  className="w-full grid grid-cols-[2fr_1fr_1fr_1fr_repeat(4,_0.8fr)_1.2fr] gap-4 px-6 py-4 border-b border-slate-800/60 hover:bg-slate-800/40 transition-all text-left group"
                >
                  {/* Name + tech dots */}
                  <div className="flex flex-col justify-center gap-1 min-w-0">
                    <span className="text-sm font-bold text-slate-200 group-hover:text-white truncate leading-tight">{company.ultParentName}</span>
                    <div className="flex items-center gap-1">
                      {techKeys.map(t => (
                        <span key={t} className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: TECH_DOTS[t] ?? '#64748b' }} title={t} />
                      ))}
                      {Object.entries(company.eventCounts).slice(0, 2).map(([ev]) => (
                        <span key={ev} className="text-[8px] px-1 py-0.5 rounded bg-slate-800 text-slate-500 border border-slate-700/50 uppercase">{ev.replace('_', ' ')}</span>
                      ))}
                    </div>
                  </div>

                  {/* Total MW */}
                  <div className="flex items-center">
                    <span className="text-xs font-black text-slate-300">{company.totalMw.toLocaleString()}</span>
                    <span className="text-[9px] text-slate-600 ml-1">MW</span>
                  </div>

                  {/* Plant count */}
                  <div className="flex items-center">
                    <span className="text-xs font-black text-slate-300">{company.plantCount}</span>
                  </div>

                  {/* Avg CF */}
                  <div className="flex items-center">
                    <span className="text-xs font-black text-slate-300">{company.avgCf > 0 ? `${(company.avgCf * 100).toFixed(0)}%` : '—'}</span>
                  </div>

                  {/* FTI service-line score mini-bars */}
                  {FTI_SERVICE_LINES.map(sl => {
                    const score = company.relevanceScores[sl] ?? 0;
                    return (
                      <div key={sl} className="flex items-center gap-1.5">
                        {score > 0 ? (
                          <>
                            <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${Math.min(100, (score / Math.max(1, ...companies.map(c => c.relevanceScores[sl] ?? 0))) * 100)}%`,
                                  backgroundColor: FTI_COLORS[sl],
                                }}
                              />
                            </div>
                            <span className="text-[9px] font-black text-slate-400">{score}</span>
                          </>
                        ) : (
                          <span className="text-[9px] text-slate-700">—</span>
                        )}
                      </div>
                    );
                  })}

                  {/* Composite signal bar */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${compositePct}%`,
                          background: compositePct > 60
                            ? 'linear-gradient(90deg, #ef4444, #f59e0b)'
                            : compositePct > 30
                            ? 'linear-gradient(90deg, #6366f1, #22c55e)'
                            : '#334155',
                        }}
                      />
                    </div>
                    <span className="text-[9px] font-black text-slate-400 w-8 text-right">{composite}</span>
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

export default ProspectingDashboard;
