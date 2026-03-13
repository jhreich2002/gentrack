/**
 * GenTrack — EntityDetailView
 *
 * Detail view for lender and tax equity investor entities.
 * Parameterized by entityType — reusable for both entity types.
 *
 * Tabs:
 *   Overview  — KPIs, portfolio plants table, FTI signals, Analyze button
 *   News      — entity-level news articles (ILIKE match on entity_company_names)
 */

import React, { useEffect, useState } from 'react';
import { LenderStats, TaxEquityStats, NewsArticle, EntityAnalysisResponse } from '../types';
import {
  fetchLenderStats, fetchLenderPlants, fetchEntityNews, callLenderAnalyze,
  LenderPlant,
} from '../services/lenderStatsService';
import { fetchTaxEquityStats, fetchTaxEquityPlants, callTaxEquityAnalyze } from '../services/taxEquityService';

type EntityTab = 'overview' | 'news';

interface Props {
  entityName: string;
  entityType: 'lender' | 'tax_equity';
  onBack: () => void;
  onPlantClick?: (eiaPlantCode: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

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

const SENTIMENT_COLORS: Record<string, string> = {
  positive: '#22c55e',
  negative: '#ef4444',
  neutral:  '#94a3b8',
};
const IMPORTANCE_COLORS: Record<string, string> = {
  high:   '#ef4444',
  medium: '#f59e0b',
  low:    '#64748b',
};

function fmtUsd(v: number | null): string {
  if (v == null) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function distressColor(score: number | null): string {
  if (score == null) return '#64748b';
  if (score >= 70) return '#ef4444';
  if (score >= 40) return '#f59e0b';
  return '#22c55e';
}

// ── Component ─────────────────────────────────────────────────────────────────

const EntityDetailView: React.FC<Props> = ({ entityName, entityType, onBack, onPlantClick }) => {
  const [activeTab, setActiveTab] = useState<EntityTab>('overview');

  // Stats state (union of LenderStats | TaxEquityStats)
  const [stats, setStats]   = useState<LenderStats | TaxEquityStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Portfolio
  const [plants, setPlants]               = useState<LenderPlant[]>([]);
  const [loadingPlants, setLoadingPlants] = useState(false);
  const [plantsFetched, setPlantsFetched] = useState(false);

  // News
  const [articles, setArticles]           = useState<NewsArticle[]>([]);
  const [loadingNews, setLoadingNews]     = useState(false);
  const [newsFetched, setNewsFetched]     = useState(false);

  // Analysis
  const [analysis, setAnalysis]                   = useState<EntityAnalysisResponse | null>(null);
  const [portfolioSynopsis, setPortfolioSynopsis] = useState<string | null>(null);
  const [loadingAnalysis, setLoadingAnalysis]     = useState(false);

  // ── Load stats on mount ───────────────────────────────────────────────────
  useEffect(() => {
    setStats(null);
    setLoading(true);
    setAnalysis(null);
    setPortfolioSynopsis(null);
    setPlants([]);
    setPlantsFetched(false);
    setArticles([]);
    setNewsFetched(false);
    setActiveTab('overview');

    const loadStats = entityType === 'lender'
      ? fetchLenderStats(entityName)
      : fetchTaxEquityStats(entityName);

    loadStats.then(s => {
      setStats(s);
      setLoading(false);
      if (s?.analysisText) {
        setAnalysis({
          analysisText:         s.analysisText,
          analysisAngleBullets: s.analysisAngleBullets,
          portfolioSynopsis:    s.portfolioSynopsis ?? null,
          analysisUpdatedAt:    s.analysisUpdatedAt ?? '',
          fromCache:            true,
        });
      }
      if (s?.portfolioSynopsis) setPortfolioSynopsis(s.portfolioSynopsis);
    });
  }, [entityName, entityType]);

  const handleLoadPlants = async () => {
    if (loadingPlants || plantsFetched) return;
    setLoadingPlants(true);
    const data = entityType === 'lender'
      ? await fetchLenderPlants(entityName)
      : await fetchTaxEquityPlants(entityName);
    setPlants(data);
    setLoadingPlants(false);
    setPlantsFetched(true);
  };

  const handleLoadNews = async () => {
    if (loadingNews || newsFetched) return;
    setLoadingNews(true);
    const data = await fetchEntityNews(entityName, 90, 50);
    setArticles(data);
    setLoadingNews(false);
    setNewsFetched(true);
  };

  const handleAnalyze = async () => {
    if (loadingAnalysis) return;
    setLoadingAnalysis(true);
    const result = entityType === 'lender'
      ? await callLenderAnalyze(entityName)
      : await callTaxEquityAnalyze(entityName);
    if (result) {
      setAnalysis(result);
      if (result.portfolioSynopsis) setPortfolioSynopsis(result.portfolioSynopsis);
    }
    setLoadingAnalysis(false);
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const isLender    = entityType === 'lender';
  const lenderStats = isLender ? (stats as LenderStats | null) : null;
  const teStats     = !isLender ? (stats as TaxEquityStats | null) : null;

  const relevanceScores = stats?.relevanceScores ?? {};
  const maxRelevance    = Math.max(0, ...FTI_SERVICE_LINES.map(k => relevanceScores[k] ?? 0));

  const entityLabel = isLender ? 'Lender' : 'Tax Equity Investor';
  const entityColor = isLender ? '#22d3ee' : '#a855f7'; // cyan for lender, violet for TE

  return (
    <div className="flex flex-col h-full overflow-y-auto pb-20">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
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
            <h1 className="text-3xl font-black text-white tracking-tight truncate">{entityName}</h1>
            <span
              className="text-[10px] px-2 py-0.5 rounded font-bold border uppercase"
              style={{ color: entityColor, borderColor: `${entityColor}40`, backgroundColor: `${entityColor}10` }}
            >
              {entityLabel}
            </span>
            {stats?.distressScore != null && (
              <span
                className="text-[10px] px-2 py-0.5 rounded font-bold border uppercase"
                style={{ color: distressColor(stats.distressScore), borderColor: `${distressColor(stats.distressScore)}40`, backgroundColor: `${distressColor(stats.distressScore)}10` }}
              >
                Distress {stats.distressScore.toFixed(0)}
              </span>
            )}
          </div>
          <p className="text-slate-500 text-xs mt-1 font-mono">
            {isLender ? 'Project finance lender — extracted from financing news articles' : 'Tax equity investor — extracted from financing news articles'}
          </p>
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <div className="flex gap-2 mb-6 bg-slate-900/50 p-1.5 rounded-xl border border-slate-800 w-fit">
        {([
          { key: 'overview', label: 'OVERVIEW', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
          { key: 'news',     label: 'NEWS',     icon: 'M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z' },
        ] as const).map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => {
              setActiveTab(key);
              if (key === 'news') handleLoadNews();
            }}
            className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
              activeTab === key ? 'bg-slate-800 text-white shadow-lg shadow-black/20' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={icon} />
            </svg>
            {label}
          </button>
        ))}
      </div>

      {/* ── Loading ─────────────────────────────────────────────────────────── */}
      {loading && (
        <div className="py-24 flex flex-col items-center justify-center space-y-4">
          <div className="w-12 h-12 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin" />
          <p className="text-slate-400 text-sm font-bold">Loading {entityLabel.toLowerCase()} stats...</p>
        </div>
      )}

      {!loading && !stats && (
        <div className="py-20 text-center bg-slate-900 rounded-2xl border border-slate-800">
          <p className="text-sm font-bold text-slate-400">No stats on record for this entity.</p>
          <p className="text-xs text-slate-600 mt-1">Run refresh-entity-stats to populate.</p>
        </div>
      )}

      {!loading && stats && (
        <>
          {/* ── OVERVIEW TAB ──────────────────────────────────────────────────── */}
          {activeTab === 'overview' && (
            <div className="space-y-8 animate-in fade-in duration-500">

              {/* KPIs */}
              <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
                <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-6">Portfolio Overview</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
                  {isLender && lenderStats ? [
                    { label: 'Assets Financed',  value: String(lenderStats.assetCount),                          sub: 'High/medium confidence' },
                    { label: 'Total Exposure',    value: fmtUsd(lenderStats.totalExposureUsd),                   sub: 'Sum of loan amounts' },
                    { label: 'Avg Plant CF',      value: lenderStats.avgPlantCf != null ? `${(lenderStats.avgPlantCf * 100).toFixed(1)}%` : '—',  sub: 'TTM across portfolio' },
                    { label: '% Curtailed',       value: `${lenderStats.pctCurtailed.toFixed(0)}%`,              sub: 'Of financed plants' },
                  ].map(({ label, value, sub }) => (
                    <div key={label} className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/50 text-center">
                      <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</div>
                      <div className="text-2xl font-black text-white">{value}</div>
                      <div className="text-[9px] text-slate-600 mt-1">{sub}</div>
                    </div>
                  )) : teStats ? [
                    { label: 'Assets',          value: String(teStats.assetCount),                                                                sub: 'High/medium confidence' },
                    { label: 'Total Committed', value: fmtUsd(teStats.totalCommittedUsd),                                                        sub: 'Sum of equity amounts' },
                    { label: 'Portfolio Avg CF',value: teStats.portfolioAvgCf != null ? `${(teStats.portfolioAvgCf * 100).toFixed(1)}%` : '—',  sub: 'TTM across portfolio' },
                    { label: 'vs. Benchmark',
                      value: (teStats.portfolioAvgCf != null && teStats.portfolioBenchmarkCf != null)
                        ? `${((teStats.portfolioAvgCf - teStats.portfolioBenchmarkCf) * 100).toFixed(1)}pp`
                        : '—',
                      sub: 'CF delta vs. regional avg',
                    },
                  ].map(({ label, value, sub }) => (
                    <div key={label} className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/50 text-center">
                      <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</div>
                      <div className="text-2xl font-black text-white">{value}</div>
                      <div className="text-[9px] text-slate-600 mt-1">{sub}</div>
                    </div>
                  )) : null}
                </div>

                {/* Distress + Sentiment row */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-800/20 rounded-xl p-4 border border-slate-700/30">
                    <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">Distress Score</div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-3 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${stats.distressScore ?? 0}%`, backgroundColor: distressColor(stats.distressScore) }}
                        />
                      </div>
                      <span className="text-lg font-black text-white w-10 text-right">
                        {stats.distressScore != null ? stats.distressScore.toFixed(0) : '—'}
                      </span>
                    </div>
                  </div>
                  <div className="bg-slate-800/20 rounded-xl p-4 border border-slate-700/30">
                    <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">News Sentiment</div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-3 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${stats.newsSentimentScore ?? 0}%`,
                            backgroundColor: (stats.newsSentimentScore ?? 0) >= 60 ? '#22c55e' : (stats.newsSentimentScore ?? 0) >= 40 ? '#f59e0b' : '#ef4444',
                          }}
                        />
                      </div>
                      <span className="text-lg font-black text-white w-10 text-right">
                        {stats.newsSentimentScore != null ? stats.newsSentimentScore.toFixed(0) : '—'}
                      </span>
                    </div>
                  </div>
                </div>
              </section>

              {/* FTI Advisory Relevance */}
              <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
                <div className="flex items-center gap-3 mb-6">
                  <div className="bg-indigo-700 p-2.5 rounded-xl shadow-lg shadow-indigo-900/20">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white tracking-tight">FTI Advisory Relevance</h2>
                    <p className="text-xs text-slate-500 font-medium">Weighted signal from entity news articles (last 90 days)</p>
                  </div>
                </div>
                <div className="space-y-4">
                  {FTI_SERVICE_LINES.map(key => {
                    const score = relevanceScores[key] ?? 0;
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
                  <p className="text-xs text-slate-600 italic mt-4">No news-based signals yet — scores update after refresh-entity-stats runs.</p>
                )}
              </section>

              {/* Portfolio Plants */}
              <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em]">
                    Portfolio Plants ({stats.assetCount})
                  </h2>
                  {!plantsFetched && !loadingPlants && (
                    <button
                      onClick={handleLoadPlants}
                      className="text-[10px] px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 font-bold transition-all"
                    >
                      Load Plants
                    </button>
                  )}
                </div>

                {loadingPlants && (
                  <div className="py-12 flex flex-col items-center justify-center space-y-3">
                    <div className="w-8 h-8 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin" />
                    <p className="text-slate-400 text-xs font-bold">Loading portfolio plants...</p>
                  </div>
                )}

                {plantsFetched && plants.length === 0 && (
                  <p className="text-xs text-slate-500 italic">No plants found in financing records for this entity.</p>
                )}

                {plantsFetched && plants.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-slate-800">
                          {['Plant', 'State', 'MW', 'TTM CF', 'Curtailment', 'Facility Type', 'Loan Amount', 'Rate', 'Maturity'].map(h => (
                            <th key={h} className="text-left pb-2 pr-4 text-[9px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {plants.map((p, i) => (
                          <tr
                            key={`${p.eiaPlantCode}-${i}`}
                            onClick={() => onPlantClick?.(p.eiaPlantCode)}
                            className={`border-b border-slate-800/50 ${onPlantClick ? 'cursor-pointer hover:bg-slate-800/40' : ''} transition-colors`}
                          >
                            <td className="py-3 pr-4 font-bold text-slate-200 whitespace-nowrap">{p.plantName}</td>
                            <td className="py-3 pr-4 text-slate-400">{p.state ?? '—'}</td>
                            <td className="py-3 pr-4 font-black text-slate-300">{p.nameplateMw.toLocaleString()}</td>
                            <td className="py-3 pr-4 font-black text-emerald-400">{p.ttmAvgFactor > 0 ? `${(p.ttmAvgFactor * 100).toFixed(1)}%` : '—'}</td>
                            <td className="py-3 pr-4">
                              {p.isLikelyCurtailed ? (
                                <span className="text-red-400 font-black">{p.curtailmentScore.toFixed(0)}</span>
                              ) : (
                                <span className="text-slate-600">—</span>
                              )}
                            </td>
                            <td className="py-3 pr-4 text-slate-400 capitalize">{p.facilityType.replace('_', ' ')}</td>
                            <td className="py-3 pr-4 font-black text-slate-300">{fmtUsd(p.loanAmountUsd)}</td>
                            <td className="py-3 pr-4 text-slate-400 text-[10px]">{p.interestRateText ?? '—'}</td>
                            <td className="py-3 text-slate-400 text-[10px]">{p.maturityText ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Portfolio Intelligence */}
              <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
                <div className="flex items-center gap-3 mb-5">
                  <div className="bg-emerald-800 p-2.5 rounded-xl shadow-lg shadow-emerald-900/20">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white tracking-tight">Portfolio Intelligence</h2>
                    <p className="text-xs text-slate-500 font-medium">Per-asset signal breakdown from news and capacity factor data</p>
                  </div>
                </div>
                {portfolioSynopsis ? (
                  <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap font-mono bg-slate-800/30 rounded-xl p-4 border border-slate-700/40">
                    {portfolioSynopsis}
                  </div>
                ) : (
                  <div className="py-6 text-center text-slate-600 bg-slate-800/10 rounded-xl border border-dashed border-slate-800">
                    <p className="text-xs font-bold italic">No portfolio synopsis generated yet.</p>
                    <p className="text-[10px] text-slate-700 mt-1">
                      Click <span className="text-violet-500">Analyze {isLender ? 'Lender' : 'Investor'}</span> to generate a per-asset breakdown.
                    </p>
                  </div>
                )}
              </section>

              {/* Advisory Analysis */}
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
                      <p className="text-xs text-slate-500 font-medium">AI-generated {entityLabel.toLowerCase()} briefing via Gemini Flash</p>
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
                    {loadingAnalysis ? 'Analyzing...' : `Analyze ${isLender ? 'Lender' : 'Investor'}`}
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
                    <p className="text-sm text-slate-300 leading-relaxed">{analysis.analysisText}</p>
                    {analysis.analysisAngleBullets.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-[9px] font-black text-violet-400 uppercase tracking-widest">Advisory Angles</div>
                        <ul className="space-y-1.5">
                          {analysis.analysisAngleBullets.map((bullet, i) => (
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
                        {analysis.fromCache ? 'Cached analysis' : 'Fresh analysis'} •{' '}
                        {analysis.analysisUpdatedAt
                          ? (() => {
                              const ms = Date.now() - new Date(analysis.analysisUpdatedAt).getTime();
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
                      Click <span className="text-violet-500">Analyze {isLender ? 'Lender' : 'Investor'}</span> to generate an AI advisory briefing.
                    </p>
                  </div>
                )}
              </section>

              <div className="text-center text-[9px] text-slate-700 pb-4">
                Stats last computed: {stats.computedAt ? new Date(stats.computedAt).toLocaleString() : 'N/A'}
              </div>
            </div>
          )}

          {/* ── NEWS TAB ─────────────────────────────────────────────────────── */}
          {activeTab === 'news' && (
            <div className="animate-in fade-in duration-500 space-y-4">
              {loadingNews && (
                <div className="py-24 flex flex-col items-center justify-center space-y-4">
                  <div className="w-12 h-12 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin" />
                  <p className="text-slate-400 text-sm font-bold">Loading entity news...</p>
                </div>
              )}

              {newsFetched && articles.length === 0 && (
                <div className="py-20 text-center bg-slate-900 rounded-2xl border border-slate-800">
                  <p className="text-sm font-bold text-slate-400">No news articles found for this entity in the last 90 days.</p>
                  <p className="text-xs text-slate-600 mt-1">News matching uses entity_company_names from classified articles.</p>
                </div>
              )}

              {newsFetched && articles.length > 0 && (
                <>
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                    {articles.length} article{articles.length !== 1 ? 's' : ''} • Last 90 days
                  </div>

                  {articles.map(article => (
                    <div key={article.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg hover:border-slate-700 transition-all">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          {/* Title */}
                          <a
                            href={article.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-bold text-slate-200 hover:text-white hover:underline line-clamp-2 leading-tight"
                          >
                            {article.title}
                          </a>

                          {/* Meta row */}
                          <div className="flex items-center gap-2 mt-2 flex-wrap">
                            {article.sourceName && (
                              <span className="text-[9px] text-slate-500 font-medium">{article.sourceName}</span>
                            )}
                            <span className="text-[9px] text-slate-600">
                              {article.publishedAt ? new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : ''}
                            </span>

                            {/* Sentiment */}
                            {article.sentimentLabel && (
                              <span
                                className="text-[8px] px-2 py-0.5 rounded font-black uppercase tracking-wider border"
                                style={{
                                  color:            SENTIMENT_COLORS[article.sentimentLabel] ?? '#94a3b8',
                                  borderColor:      `${SENTIMENT_COLORS[article.sentimentLabel] ?? '#94a3b8'}40`,
                                  backgroundColor:  `${SENTIMENT_COLORS[article.sentimentLabel] ?? '#94a3b8'}10`,
                                }}
                              >
                                {article.sentimentLabel}
                              </span>
                            )}

                            {/* Event type */}
                            {article.eventType && article.eventType !== 'none' && (
                              <span className="text-[8px] px-2 py-0.5 rounded font-black uppercase tracking-wider bg-slate-800 border border-slate-700/50 text-slate-400">
                                {article.eventType.replace('_', ' ')}
                              </span>
                            )}

                            {/* Importance */}
                            {article.importance && article.importance !== 'low' && (
                              <span
                                className="text-[8px] px-2 py-0.5 rounded font-black uppercase tracking-wider border"
                                style={{
                                  color:           IMPORTANCE_COLORS[article.importance] ?? '#64748b',
                                  borderColor:     `${IMPORTANCE_COLORS[article.importance] ?? '#64748b'}40`,
                                  backgroundColor: `${IMPORTANCE_COLORS[article.importance] ?? '#64748b'}10`,
                                }}
                              >
                                {article.importance}
                              </span>
                            )}
                          </div>

                          {/* Summary */}
                          {article.articleSummary && (
                            <p className="text-xs text-slate-400 mt-2 leading-relaxed line-clamp-2">{article.articleSummary}</p>
                          )}

                          {/* Impact tags */}
                          {article.ftiRelevanceTags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {article.ftiRelevanceTags.map(tag => (
                                <span key={tag} className="text-[8px] px-1.5 py-0.5 rounded bg-indigo-900/20 border border-indigo-500/20 text-indigo-400 font-medium">
                                  {tag.replace('_', ' ')}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default EntityDetailView;
