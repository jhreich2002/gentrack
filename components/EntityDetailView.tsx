/**
 * GenTrack — EntityDetailView
 *
 * Detail view for lender and tax equity investor entities.
 * Parameterized by entityType — reusable for both entity types.
 */

import React, { useEffect, useState } from 'react';
import { LenderStats, TaxEquityStats, EntityAnalysisResponse } from '../types';
import {
  fetchLenderStats, fetchLenderPlants, callLenderAnalyze,
  LenderPlant,
} from '../services/lenderStatsService';
import { fetchTaxEquityStats, fetchTaxEquityPlants, callTaxEquityAnalyze } from '../services/taxEquityService';

interface Props {
  entityName: string;
  entityType: 'lender' | 'tax_equity';
  onBack: () => void;
  onPlantClick?: (eiaPlantCode: string) => void;
}

function fmtUsd(v: number | null): string {
  if (v == null) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
}

function distressColor(score: number | null): string {
  if (score == null) return '#64748b';
  if (score >= 70) return '#ef4444';
  if (score >= 40) return '#f59e0b';
  return '#22c55e';
}

// ── Component ─────────────────────────────────────────────────────────────────

const EntityDetailView: React.FC<Props> = ({ entityName, entityType, onBack, onPlantClick }) => {
  // Stats state (union of LenderStats | TaxEquityStats)
  const [stats, setStats]   = useState<LenderStats | TaxEquityStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Portfolio
  const [plants, setPlants]               = useState<LenderPlant[]>([]);
  const [loadingPlants, setLoadingPlants] = useState(false);
  const [plantsFetched, setPlantsFetched] = useState(false);

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

    const loadStats = entityType === 'lender'
      ? fetchLenderStats(entityName)
      : fetchTaxEquityStats(entityName);

    loadStats.then(async s => {
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

      // Auto-load plants
      setLoadingPlants(true);
      const plantData = entityType === 'lender'
        ? await fetchLenderPlants(entityName)
        : await fetchTaxEquityPlants(entityName);
      setPlants(plantData);
      setLoadingPlants(false);
      setPlantsFetched(true);

      // Auto-generate briefing if no cached analysis exists
      if (!s?.analysisText) {
        setLoadingAnalysis(true);
        const result = entityType === 'lender'
          ? await callLenderAnalyze(entityName)
          : await callTaxEquityAnalyze(entityName);
        if (result) {
          setAnalysis(result);
          if (result.portfolioSynopsis) setPortfolioSynopsis(result.portfolioSynopsis);
        }
        setLoadingAnalysis(false);
      }
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
  const isLender = entityType === 'lender';

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
        <div className="space-y-8 animate-in fade-in duration-500">

              {/* Portfolio Plants */}
              <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em]">
                    Portfolio Plants ({stats.assetCount})
                  </h2>
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

              {/* AI Intelligence Briefing */}
              <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-3">
                    <div className="bg-violet-700 p-2.5 rounded-xl shadow-lg shadow-violet-900/20">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-white tracking-tight">AI Intelligence Briefing</h2>
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
                    <p className="text-slate-400 text-xs font-bold">Generating intelligence briefing...</p>
                  </div>
                )}

                {(analysis || portfolioSynopsis) ? (
                  <div className="space-y-5">
                    {analysis && (
                      <>
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
                      </>
                    )}
                    {portfolioSynopsis && (
                      <div>
                        <div className="text-[9px] font-black text-emerald-400 uppercase tracking-widest mb-2">Per-Asset Breakdown</div>
                        <div className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap font-mono bg-slate-800/30 rounded-xl p-4 border border-slate-700/40">
                          {portfolioSynopsis}
                        </div>
                      </div>
                    )}
                    {analysis && (
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
                    )}
                  </div>
                ) : !loadingAnalysis && (
                  <div className="py-8 text-center text-slate-600 bg-slate-800/10 rounded-2xl border border-dashed border-slate-800">
                    <svg className="w-7 h-7 mx-auto mb-3 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    <p className="text-xs font-bold italic">No briefing generated yet.</p>
                    <p className="text-[10px] text-slate-700 mt-1">
                      Click <span className="text-violet-500">Analyze {isLender ? 'Lender' : 'Investor'}</span> to generate an AI intelligence briefing.
                    </p>
                  </div>
                )}
              </section>

          <div className="text-center text-[9px] text-slate-700 pb-4">
            Stats last computed: {stats.computedAt ? new Date(stats.computedAt).toLocaleString() : 'N/A'}
          </div>
        </div>
      )}
    </div>
  );
};

export default EntityDetailView;
