import React, { useEffect, useState } from 'react';
import { CompanyStats } from '../types';
import { fetchCompanyStats, callCompanyAnalyze, CompanyAnalysisResponse, fetchCompanyPlants, CompanyPlant } from '../services/companyService';

type CompanyTab = 'overview' | 'portfolio';

interface Props {
  ultParentName: string;
  onBack: () => void;
  onPlantClick?: (eiaPlantCode: string) => void;
  initialTab?: CompanyTab;
  onTabChange?: (tab: CompanyTab) => void;
}

// ── Colour palette for tech/state bars ────────────────────────────────────────
const TECH_COLORS: Record<string, string> = {
  Solar:   '#f59e0b',
  Wind:    '#22d3ee',
  Nuclear: '#a855f7',
};

const FTI_SERVICE_LINES = ['restructuring', 'transactions', 'disputes', 'market_strategy'] as const;
const FTI_LABELS: Record<string, string> = {
  restructuring:   'Restructuring',
  transactions:    'Transactions',
  disputes:        'Disputes & Lit.',
  market_strategy: 'Market Strategy',
};
const FTI_COLORS: Record<string, string> = {
  restructuring:   '#ef4444',
  transactions:    '#22c55e',
  disputes:        '#f59e0b',
  market_strategy: '#6366f1',
};

const EVENT_LABELS: Record<string, string> = {
  outage:        'Outage',
  regulatory:    'Regulatory',
  financial:     'Financial',
  m_and_a:       'M&A',
  dispute:       'Dispute',
  construction:  'Construction',
  policy:        'Policy',
  restructuring: 'Restructuring',
  none:          'Unclassified',
};

// ── Component ─────────────────────────────────────────────────────────────────

const CompanyDetailView: React.FC<Props> = ({ ultParentName, onBack, onPlantClick, initialTab, onTabChange }) => {
  const [activeTab, setActiveTab] = useState<CompanyTab>(initialTab ?? 'overview');
  const [stats, setStats]       = useState<CompanyStats | null>(null);
  const [loading, setLoading]   = useState(true);
  const [analysis, setAnalysis] = useState<CompanyAnalysisResponse | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);

  // Portfolio state
  const [plants, setPlants]         = useState<CompanyPlant[]>([]);
  const [loadingPlants, setLoadingPlants] = useState(false);
  const [plantsFetched, setPlantsFetched] = useState(false);

  useEffect(() => {
    setStats(null);
    setLoading(true);
    setAnalysis(null);
    setActiveTab(initialTab ?? 'overview');
    setPlants([]);
    setPlantsFetched(false);

    fetchCompanyStats(ultParentName).then(s => {
      setStats(s);
      setLoading(false);
      // Pre-populate analysis from cached company_stats row if available
      if (s?.analysisText) {
        setAnalysis({
          analysis_text:          s.analysisText,
          analysis_angle_bullets: s.analysisAngleBullets,
          analysis_updated_at:    s.analysisUpdatedAt ?? '',
          from_cache:             true,
        });
      }
    });
  }, [ultParentName]);

  const handleLoadPlants = async () => {
    if (loadingPlants || plantsFetched) return;
    setLoadingPlants(true);
    const data = await fetchCompanyPlants(ultParentName);
    setPlants(data);
    setLoadingPlants(false);
    setPlantsFetched(true);
  };

  const handleAnalyze = async () => {
    if (loadingAnalysis) return;
    setLoadingAnalysis(true);
    const result = await callCompanyAnalyze(ultParentName);
    if (result) setAnalysis(result);
    setLoadingAnalysis(false);
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  const techEntries   = stats ? (Object.entries(stats.techBreakdown)  as [string, number][]).sort(([,a],[,b]) => b - a)                 : [];
  const stateEntries  = stats ? (Object.entries(stats.stateBreakdown) as [string, number][]).sort(([,a],[,b]) => b - a).slice(0, 8)    : [];
  const eventEntries  = stats ? (Object.entries(stats.eventCounts)    as [string, number][]).sort(([,a],[,b]) => b - a)                 : [];
  const maxRelevance  = stats ? Math.max(0, ...FTI_SERVICE_LINES.map(k => stats.relevanceScores[k] ?? 0)) : 0;

  return (
    <div className="flex flex-col h-full overflow-y-auto pb-20">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-4 mb-8">
        <button
          onClick={onBack}
          className="p-2 mt-1 hover:bg-slate-800 rounded-full text-slate-400 transition-colors border border-transparent hover:border-slate-700"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-black text-white tracking-tight truncate">{ultParentName}</h1>
            <span className="text-[10px] px-2 py-0.5 rounded font-bold border border-emerald-500/40 text-emerald-400 bg-emerald-500/10 uppercase">
              Portfolio Company
            </span>
          </div>
          <p className="text-slate-500 text-xs mt-1 font-mono">
            Ultimate Parent Entity — EIA-860 ownership records
          </p>
        </div>
      </div>

      {/* ── Tab Navigation ─────────────────────────────────────────────────── */}
      <div className="flex gap-2 mb-6 bg-slate-900/50 p-1.5 rounded-xl border border-slate-800 w-fit">
        <button
          onClick={() => { setActiveTab('overview'); onTabChange?.('overview'); }}
          className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === 'overview' ? 'bg-slate-800 text-white shadow-lg shadow-black/20' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
          OVERVIEW
        </button>
        <button
          onClick={() => { setActiveTab('portfolio'); onTabChange?.('portfolio'); handleLoadPlants(); }}
          className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === 'portfolio' ? 'bg-slate-800 text-white shadow-lg shadow-black/20' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
          PORTFOLIO ({stats?.plantCount ?? 0})
        </button>
      </div>

      {/* ── Loading ────────────────────────────────────────────────────────── */}
      {loading && (
        <div className="py-24 flex flex-col items-center justify-center space-y-4">
          <div className="w-12 h-12 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin" />
          <p className="text-slate-400 text-sm font-bold">Loading company stats...</p>
        </div>
      )}

      {/* ── No data ────────────────────────────────────────────────────────── */}
      {!loading && !stats && (
        <div className="py-20 text-center bg-slate-900 rounded-2xl border border-slate-800">
          <p className="text-sm font-bold text-slate-400">No stats on record for this company.</p>
          <p className="text-xs text-slate-600 mt-1">Run company-stats-refresh to populate.</p>
        </div>
      )}

      {!loading && stats && (
        <>
        {activeTab === 'overview' && (
        <div className="space-y-8 animate-in fade-in duration-500">

          {/* ── Portfolio Overview ──────────────────────────────────────────── */}
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-6">Portfolio Overview</h2>

            {/* KPI row */}
            <div className="grid grid-cols-3 gap-6 mb-8">
              {[
                { label: 'Total Nameplate',  value: `${stats.totalMw.toLocaleString()} MW`, sub: 'Nameplate capacity' },
                { label: 'Plant Count',      value: stats.plantCount.toLocaleString(),       sub: 'EIA-860 sites' },
                { label: 'Avg TTM CF',       value: stats.avgCf > 0 ? `${(stats.avgCf * 100).toFixed(1)}%` : 'N/A', sub: 'Trailing 12 months' },
              ].map(({ label, value, sub }) => (
                <div key={label} className="bg-slate-800/40 rounded-xl p-5 border border-slate-700/50 text-center">
                  <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</div>
                  <div className="text-3xl font-black text-white">{value}</div>
                  <div className="text-[9px] text-slate-600 mt-1">{sub}</div>
                </div>
              ))}
            </div>

            {/* Technology breakdown */}
            {techEntries.length > 0 && (
              <div className="mb-6">
                <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">Technology Mix</div>
                <div className="space-y-2">
                  {techEntries.map(([fuel, mw]) => {
                    const pct = stats.totalMw > 0 ? (mw / stats.totalMw) * 100 : 0;
                    return (
                      <div key={fuel} className="flex items-center gap-3">
                        <div className="w-20 text-[10px] font-bold text-slate-400 text-right">{fuel}</div>
                        <div className="flex-1 h-5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-700"
                            style={{ width: `${pct}%`, backgroundColor: TECH_COLORS[fuel] ?? '#64748b' }}
                          />
                        </div>
                        <div className="w-28 text-[10px] font-bold text-slate-300 font-mono">
                          {mw.toLocaleString()} MW ({pct.toFixed(0)}%)
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Top states */}
            {stateEntries.length > 0 && (
              <div>
                <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">Geographic Footprint (Top States by MW)</div>
                <div className="flex flex-wrap gap-2">
                  {stateEntries.map(([state, mw]) => (
                    <div key={state} className="bg-slate-800/50 border border-slate-700/50 rounded-lg px-3 py-2 text-center">
                      <div className="text-sm font-black text-white">{state}</div>
                      <div className="text-[9px] text-slate-500">{(mw as number).toLocaleString()} MW</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* ── FTI Advisory Signal Scores ──────────────────────────────────── */}
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
            <div className="flex items-center gap-3 mb-6">
              <div className="bg-indigo-700 p-2.5 rounded-xl shadow-lg shadow-indigo-900/20">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div>
                <h2 className="text-xl font-bold text-white tracking-tight">FTI Advisory Relevance</h2>
                <p className="text-xs text-slate-500 font-medium">Weighted signal strength from news articles (last 90 days)</p>
              </div>
            </div>

            <div className="space-y-4">
              {FTI_SERVICE_LINES.map(key => {
                const score = stats.relevanceScores[key] ?? 0;
                const pct   = maxRelevance > 0 ? (score / maxRelevance) * 100 : 0;
                return (
                  <div key={key} className="flex items-center gap-4">
                    <div className="w-32 text-[10px] font-bold text-slate-400">{FTI_LABELS[key]}</div>
                    <div className="flex-1 h-6 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-700 flex items-center justify-end pr-2"
                        style={{ width: `${Math.max(pct, score > 0 ? 4 : 0)}%`, backgroundColor: FTI_COLORS[key] }}
                      >
                        {score > 0 && pct > 15 && (
                          <span className="text-[9px] font-black text-white">{score}</span>
                        )}
                      </div>
                    </div>
                    <div className="w-12 text-xs font-black text-slate-300 font-mono text-right">{score}</div>
                  </div>
                );
              })}
            </div>
            {maxRelevance === 0 && (
              <p className="text-xs text-slate-600 italic mt-4">No news-based signals yet — scores update nightly after sector-news-ingest.</p>
            )}
          </section>

          {/* ── Recent Event Activity ────────────────────────────────────────── */}
          {eventEntries.length > 0 && (
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-6">Recent Event Activity (90 days)</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {eventEntries.map(([event, count]) => (
                  <div key={event} className="bg-slate-800/30 rounded-xl p-4 border border-slate-700/50 text-center">
                    <div className="text-2xl font-black text-white">{String(count)}</div>
                    <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">
                      {EVENT_LABELS[event] ?? event}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Company Analysis (Gemini) ────────────────────────────────────── */}
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="bg-violet-700 p-2.5 rounded-xl shadow-lg shadow-violet-900/20">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white tracking-tight">Advisory Analysis</h2>
                  <p className="text-xs text-slate-500 font-medium">AI-generated company briefing via Gemini Flash</p>
                </div>
              </div>
              <button
                onClick={handleAnalyze}
                disabled={loadingAnalysis}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all bg-violet-900/20 border-violet-500/30 text-violet-400 hover:bg-violet-900/40 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loadingAnalysis ? (
                  <div className="w-3 h-3 rounded-full border border-violet-400/30 border-t-violet-400 animate-spin" />
                ) : (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                )}
                {loadingAnalysis ? 'Analyzing...' : 'Analyze Company'}
              </button>
            </div>

            {loadingAnalysis && !analysis && (
              <div className="py-10 flex flex-col items-center justify-center space-y-4">
                <div className="w-8 h-8 rounded-full border-2 border-violet-500/20 border-t-violet-500 animate-spin" />
                <p className="text-slate-400 text-xs font-bold">Generating advisory briefing...</p>
              </div>
            )}

            {analysis && (
              <div className="space-y-5">
                <p className="text-sm text-slate-300 leading-relaxed">{analysis.analysis_text}</p>
                {analysis.analysis_angle_bullets.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-[9px] font-black text-violet-400 uppercase tracking-widest">Advisory Angles</div>
                    <ul className="space-y-1.5">
                      {analysis.analysis_angle_bullets.map((bullet, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-slate-300">
                          <span className="mt-0.5 text-violet-500 font-black flex-shrink-0">◆</span>
                          <span>{bullet}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                  <div className="text-[9px] text-slate-600 font-medium">
                    {analysis.from_cache ? 'Cached analysis' : 'Fresh analysis'} •{' '}
                    {analysis.analysis_updated_at
                      ? (() => {
                          const ms = Date.now() - new Date(analysis.analysis_updated_at).getTime();
                          const h  = Math.floor(ms / 3_600_000);
                          const m  = Math.floor((ms % 3_600_000) / 60_000);
                          return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
                        })()
                      : 'just now'}
                  </div>
                  <div className="text-[9px] text-slate-600">Gemini 2.0 Flash Lite</div>
                </div>
              </div>
            )}

            {!analysis && !loadingAnalysis && (
              <div className="py-8 text-center text-slate-600 bg-slate-800/10 rounded-2xl border border-dashed border-slate-800">
                <svg className="w-7 h-7 mx-auto mb-3 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <p className="text-xs font-bold italic">No analysis generated yet.</p>
                <p className="text-[10px] text-slate-700 mt-1">
                  Click <span className="text-violet-500">Analyze Company</span> to generate an AI advisory briefing.
                </p>
              </div>
            )}
          </section>

          {/* Footer */}
          <div className="text-center text-[9px] text-slate-700 pb-4">
            Stats last computed: {stats.computedAt ? new Date(stats.computedAt).toLocaleString() : 'N/A'}
          </div>
        </div>
        )}

        {/* ── PORTFOLIO TAB ──────────────────────────────────────────────────── */}
        {activeTab === 'portfolio' && (
          <div className="animate-in fade-in duration-500">
            {/* Loading plants */}
            {loadingPlants && (
              <div className="py-24 flex flex-col items-center justify-center space-y-4">
                <div className="w-12 h-12 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin" />
                <p className="text-slate-400 text-sm font-bold">Loading portfolio plants...</p>
              </div>
            )}

            {/* Empty state */}
            {plantsFetched && plants.length === 0 && (
              <div className="py-20 text-center bg-slate-900 rounded-2xl border border-slate-800">
                <svg className="w-10 h-10 mx-auto mb-4 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                <p className="text-sm font-bold text-slate-400">No plants found in ownership records.</p>
                <p className="text-xs text-slate-600 mt-1">This company may not have EIA-860 ownership data uploaded.</p>
              </div>
            )}

            {/* Plant list */}
            {plantsFetched && plants.length > 0 && (
              <div className="space-y-3">
                <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">
                  {plants.length} Plant{plants.length !== 1 ? 's' : ''} • Sorted by Nameplate Capacity
                </div>
                {plants.map(plant => (
                  <div
                    key={plant.eiaPlantCode}
                    onClick={() => onPlantClick?.(plant.eiaPlantCode)}
                    className={`bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg transition-all ${onPlantClick ? 'cursor-pointer hover:border-slate-600 hover:bg-slate-800/50' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <h3 className="text-base font-bold text-white truncate">{plant.plantName}</h3>
                          {plant.techType && (
                            <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-widest border ${
                              plant.techType === 'Solar' ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' :
                              plant.techType === 'Wind'  ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400' :
                              plant.techType === 'Nuclear' ? 'bg-violet-500/10 border-violet-500/30 text-violet-400' :
                              'bg-slate-500/10 border-slate-500/30 text-slate-400'
                            }`}>{plant.techType}</span>
                          )}
                          {plant.ownStatus && (
                            <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-widest border ${
                              plant.ownStatus === 'Current' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' :
                              'bg-slate-500/10 border-slate-500/30 text-slate-400'
                            }`}>{plant.ownStatus}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-slate-500">
                          <span className="font-mono">{plant.eiaPlantCode}</span>
                          {plant.state && <span>• {plant.state}</span>}
                          {plant.region && <span>• {plant.region}</span>}
                          {plant.ownershipPct != null && <span>• {(plant.ownershipPct * 100).toFixed(1)}% owned</span>}
                        </div>
                      </div>

                      {/* Stats block */}
                      <div className="flex items-center gap-6 text-right shrink-0">
                        <div>
                          <div className="text-lg font-black text-white">{plant.nameplateMw.toLocaleString()} MW</div>
                          <div className="text-[9px] text-slate-500 uppercase tracking-widest">Nameplate</div>
                        </div>
                        <div>
                          <div className={`text-lg font-black ${plant.ttmAvgFactor > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                            {plant.ttmAvgFactor > 0 ? `${(plant.ttmAvgFactor * 100).toFixed(1)}%` : 'N/A'}
                          </div>
                          <div className="text-[9px] text-slate-500 uppercase tracking-widest">TTM CF</div>
                        </div>
                        {plant.isLikelyCurtailed && plant.curtailmentScore > 0 && (
                          <div>
                            <div className="text-lg font-black text-red-400">{plant.curtailmentScore.toFixed(0)}%</div>
                            <div className="text-[9px] text-red-500 uppercase tracking-widest">Curtailed</div>
                          </div>
                        )}
                        {onPlantClick && (
                          <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                          </svg>
                        )}
                      </div>
                    </div>

                    {/* PPA info row */}
                    {(plant.ppaCounterparty || plant.ppaExpirationDate) && (
                      <div className="mt-3 pt-3 border-t border-slate-800 flex items-center gap-4 text-[10px]">
                        {plant.ppaCounterparty && (
                          <span className="text-slate-400">
                            <span className="text-slate-600">PPA:</span> {plant.ppaCounterparty}
                          </span>
                        )}
                        {plant.ppaExpirationDate && (
                          <span className="text-slate-400">
                            <span className="text-slate-600">Expires:</span> {plant.ppaExpirationDate}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        </>
      )}
    </div>
  );
};

export default CompanyDetailView;
