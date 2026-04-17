/**
 * GenTrack — EntityDetailView
 *
 * Detail view for lender and tax equity investor entities.
 * Parameterized by entityType — reusable for both entity types.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { LenderStats, TaxEquityStats, EntityAnalysisResponse } from '../types';
import {
  fetchLenderStats, fetchLenderPlants, callLenderAnalyze,
  LenderPlant,
} from '../services/lenderStatsService';
import { fetchTaxEquityStats, fetchTaxEquityPlants, callTaxEquityAnalyze } from '../services/taxEquityService';
import {
  PITCH_ANGLE_LABEL, PITCH_ANGLE_COLOR, FACILITY_ABBR,
  loanStatusBadge, fmtUsd,
} from '../utils/lenderUtils';

interface Props {
  entityName: string;
  entityType: 'lender' | 'tax_equity';
  onBack: () => void;
  onPlantClick?: (eiaPlantCode: string) => void;
}

function distressColor(score: number | null): string {
  if (score == null) return '#64748b';
  if (score >= 70) return '#ef4444';
  if (score >= 40) return '#f59e0b';
  return '#22c55e';
}

function plantAccentColor(p: LenderPlant): string {
  if (p.curtailmentScore >= 70) return 'bg-red-500';
  if (p.curtailmentScore >= 40) return 'bg-amber-500';
  if (p.isLikelyCurtailed) return 'bg-amber-600';
  return 'bg-slate-700';
}

// ── Component ─────────────────────────────────────────────────────────────────

const EntityDetailView: React.FC<Props> = ({ entityName, entityType, onBack, onPlantClick }) => {
  const [stats, setStats]   = useState<LenderStats | TaxEquityStats | null>(null);
  const [loading, setLoading] = useState(true);

  const [plants, setPlants]               = useState<LenderPlant[]>([]);
  const [loadingPlants, setLoadingPlants] = useState(false);
  const [plantsFetched, setPlantsFetched] = useState(false);

  const [analysis, setAnalysis]                   = useState<EntityAnalysisResponse | null>(null);
  const [portfolioSynopsis, setPortfolioSynopsis] = useState<string | null>(null);
  const [loadingAnalysis, setLoadingAnalysis]     = useState(false);
  const [briefingExpanded, setBriefingExpanded]   = useState(false);

  // ── Load stats on mount ───────────────────────────────────────────────────
  useEffect(() => {
    setStats(null);
    setLoading(true);
    setAnalysis(null);
    setPortfolioSynopsis(null);
    setPlants([]);
    setPlantsFetched(false);
    setBriefingExpanded(false);

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
        // Keep briefing collapsed when we already have a cached analysis
        setBriefingExpanded(false);
      } else {
        // No cached analysis — expand so the generate button is visible
        setBriefingExpanded(true);
      }
      if (s?.portfolioSynopsis) setPortfolioSynopsis(s.portfolioSynopsis);

      setLoadingPlants(true);
      const plantData = entityType === 'lender'
        ? await fetchLenderPlants(entityName)
        : await fetchTaxEquityPlants(entityName);
      setPlants(plantData);
      setLoadingPlants(false);
      setPlantsFetched(true);

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

  const handleAnalyze = async () => {
    if (loadingAnalysis) return;
    setBriefingExpanded(true);
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
  const entityColor = isLender ? '#22d3ee' : '#a855f7';

  const lenderStats = isLender ? (stats as LenderStats | null) : null;

  // Group plants by loan status (lender only)
  const plantsByGroup = useMemo(() => {
    if (!isLender) return { active: plants, unknown: [] as LenderPlant[], historical: [] as LenderPlant[] };
    return {
      active:    plants.filter(p => (p as LenderPlant).loanStatus === 'active'),
      unknown:   plants.filter(p => { const s = (p as LenderPlant).loanStatus; return !s || s === 'unknown'; }),
      historical: plants.filter(p => { const s = (p as LenderPlant).loanStatus; return s === 'matured' || s === 'refinanced'; }),
    };
  }, [plants, isLender]);

  const activeLoanCount = lenderStats?.activeLoanCount ?? (plantsByGroup.active.length || null);
  const pitchBullets = analysis?.analysisAngleBullets ?? lenderStats?.analysisAngleBullets ?? [];
  const topPitchAngle = lenderStats?.topPitchAngle ?? null;

  // ── Plant group renderer ──────────────────────────────────────────────────
  const renderPlantGroup = (
    groupPlants: LenderPlant[],
    groupLabel: string,
    headerColor: string,
    dimmed = false,
  ) => {
    if (groupPlants.length === 0) return null;
    return (
      <div className={dimmed ? 'opacity-60' : ''}>
        <div className={`text-[9px] font-black uppercase tracking-widest mb-3 ${headerColor}`}>
          {groupLabel} ({groupPlants.length})
        </div>
        <div className="space-y-2">
          {groupPlants.map((p, i) => (
            <div
              key={`${p.eiaPlantCode}-${i}`}
              onClick={() => onPlantClick?.(p.eiaPlantCode)}
              className={`flex items-center rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden ${onPlantClick ? 'cursor-pointer hover:bg-slate-800/60' : ''} transition-colors`}
            >
              {/* Left accent bar */}
              <div className={`w-1 self-stretch flex-shrink-0 ${plantAccentColor(p)}`} />

              {/* Row content */}
              <div className="flex flex-1 items-center gap-4 px-4 py-3 min-w-0 flex-wrap">
                {/* Name + State */}
                <div className="flex-1 min-w-[140px]">
                  <div className="text-sm font-bold text-slate-200 truncate">{p.plantName}</div>
                  <div className="text-[10px] text-slate-500 font-mono">{p.state ?? '—'}</div>
                </div>

                {/* MW */}
                <div className="w-16 text-right flex-shrink-0">
                  <div className="text-xs font-mono font-black text-slate-300">{p.nameplateMw.toLocaleString()}</div>
                  <div className="text-[9px] text-slate-600">MW</div>
                </div>

                {/* CF% */}
                <div className="w-14 text-right flex-shrink-0">
                  <div className={`text-xs font-mono font-black ${p.ttmAvgFactor > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                    {p.ttmAvgFactor > 0 ? `${(p.ttmAvgFactor * 100).toFixed(1)}%` : '—'}
                  </div>
                  <div className="text-[9px] text-slate-600">TTM CF</div>
                </div>

                {/* Curtailment */}
                <div className="w-14 text-right flex-shrink-0">
                  {p.isLikelyCurtailed ? (
                    <>
                      <div className="text-xs font-mono font-black text-red-400">{p.curtailmentScore.toFixed(0)}</div>
                      <div className="text-[9px] text-slate-600">Curt.</div>
                    </>
                  ) : (
                    <div className="text-xs text-slate-700">—</div>
                  )}
                </div>

                {/* Loan status badge */}
                <div className="w-16 flex-shrink-0">
                  {isLender && loanStatusBadge((p as LenderPlant).loanStatus)}
                </div>

                {/* Facility type */}
                <div className="w-24 flex-shrink-0">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-500 font-mono font-bold">
                    {FACILITY_ABBR[(p as LenderPlant).facilityType] ?? (p as LenderPlant).facilityType?.slice(0, 2).toUpperCase() ?? '—'}
                  </span>
                  <div className="text-[9px] text-slate-600 mt-0.5 capitalize">
                    {(p as LenderPlant).facilityType?.replace(/_/g, ' ') ?? ''}
                  </div>
                </div>

                {/* Loan amount + maturity */}
                <div className="w-28 text-right flex-shrink-0">
                  <div className="text-xs font-bold text-slate-300">{fmtUsd((p as LenderPlant).loanAmountUsd)}</div>
                  <div className="text-[9px] text-slate-600">{(p as LenderPlant).maturityText ?? '—'}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto pb-20">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-4 mb-6">
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
        <div className="space-y-6 animate-in fade-in duration-500">

          {/* ── Hero Stats Row ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Total Exposure */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-5 flex items-center gap-4">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${isLender ? 'bg-cyan-900/30' : 'bg-violet-900/30'}`}>
                <svg className={`w-5 h-5 ${isLender ? 'text-cyan-400' : 'text-violet-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <div className="text-2xl font-black text-white">
                  {isLender
                    ? fmtUsd(lenderStats?.totalExposureUsd ?? null)
                    : fmtUsd((stats as TaxEquityStats).totalCommittedUsd ?? null)}
                </div>
                <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Total Exposure</div>
              </div>
            </div>

            {/* Active Loans (lender) / Asset Count (TE) */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-5 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <div className="text-2xl font-black text-white">
                  {isLender ? (activeLoanCount ?? '—') : stats.assetCount}
                </div>
                <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">
                  {isLender ? 'Active Loans' : 'Portfolio Assets'}
                </div>
              </div>
            </div>

            {/* Curtailed Plants */}
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-5 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <div className="text-2xl font-black text-white">
                  {lenderStats?.curtailedPlantCount ?? (plantsByGroup.active.filter(p => p.isLikelyCurtailed).length || '—')}
                </div>
                <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Curtailed Plants</div>
              </div>
            </div>

            {/* Portfolio Distress */}
            <div
              className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-5 flex items-center gap-4"
              style={{ borderColor: `${distressColor(stats.distressScore)}20` }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: `${distressColor(stats.distressScore)}20` }}
              >
                <svg className="w-5 h-5" style={{ color: distressColor(stats.distressScore) }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              </div>
              <div>
                <div className="text-2xl font-black" style={{ color: distressColor(stats.distressScore) }}>
                  {stats.distressScore != null ? stats.distressScore.toFixed(0) : '—'}
                </div>
                <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Portfolio Distress</div>
              </div>
            </div>
          </div>

          {/* ── Pitch Intelligence Panel ────────────────────────────────────── */}
          {(topPitchAngle || pitchBullets.length > 0) && (
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Primary Opportunity Signal</div>
                {topPitchAngle && (
                  <span className={`text-xs px-2.5 py-1 rounded border font-semibold ${PITCH_ANGLE_COLOR[topPitchAngle] ?? 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                    {PITCH_ANGLE_LABEL[topPitchAngle] ?? topPitchAngle}
                  </span>
                )}
                {(lenderStats?.highUrgencyCount ?? 0) > 0 && (
                  <span className="text-[9px] px-2 py-0.5 rounded bg-red-900/50 border border-red-700/50 text-red-300 font-mono font-bold">
                    {lenderStats!.highUrgencyCount} urgent
                  </span>
                )}
              </div>
              {pitchBullets.length > 0 && (
                <ul className="space-y-2">
                  {pitchBullets.map((bullet, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-slate-300">
                      <span
                        className="mt-0.5 font-black flex-shrink-0 text-xs"
                        style={{ color: topPitchAngle ? undefined : '#a855f7' }}
                      >
                        {topPitchAngle && PITCH_ANGLE_COLOR[topPitchAngle]?.includes('blue') ? '◆' :
                         topPitchAngle && PITCH_ANGLE_COLOR[topPitchAngle]?.includes('purple') ? '◆' :
                         topPitchAngle && PITCH_ANGLE_COLOR[topPitchAngle]?.includes('red') ? '◆' :
                         topPitchAngle && PITCH_ANGLE_COLOR[topPitchAngle]?.includes('amber') ? '◆' : '◆'}
                      </span>
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ── Portfolio Plants ────────────────────────────────────────────── */}
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg">
            <div className="flex items-center justify-between mb-5">
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
              <div className="space-y-6">
                {isLender ? (
                  <>
                    {renderPlantGroup(plantsByGroup.active,    'Active Loans',     'text-emerald-500')}
                    {renderPlantGroup(plantsByGroup.unknown,   'Unknown Status',    'text-slate-500')}
                    {renderPlantGroup(plantsByGroup.historical,'Historical',        'text-slate-600', true)}
                  </>
                ) : (
                  renderPlantGroup(plants, 'All Plants', 'text-slate-400')
                )}
              </div>
            )}
          </section>

          {/* ── AI Intelligence Briefing (collapsible) ──────────────────────── */}
          <section className="bg-slate-900 border border-slate-800 rounded-2xl shadow-lg overflow-hidden">
            {/* Section header — always visible, toggles expand */}
            <div
              className="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-slate-800/40 transition-colors"
              onClick={() => setBriefingExpanded(e => !e)}
            >
              <div className="flex items-center gap-3">
                <div className="bg-violet-700 p-2 rounded-xl shadow-lg shadow-violet-900/20">
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                </div>
                <div>
                  <div className="text-sm font-bold text-white">AI Intelligence Briefing</div>
                  {!briefingExpanded && analysis && (
                    <div className="text-[10px] text-slate-500 font-mono">
                      {analysis.analysisAngleBullets.length} angles · {analysis.fromCache ? 'cached' : 'fresh'} ·{' '}
                      {analysis.analysisUpdatedAt
                        ? (() => {
                            const ms = Date.now() - new Date(analysis.analysisUpdatedAt).getTime();
                            const h  = Math.floor(ms / 3_600_000);
                            const m  = Math.floor((ms % 3_600_000) / 60_000);
                            return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
                          })()
                        : 'just generated'}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {!loadingAnalysis && (
                  <button
                    onClick={e => { e.stopPropagation(); handleAnalyze(); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest border transition-all bg-violet-900/20 border-violet-500/30 text-violet-400 hover:bg-violet-900/40"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Refresh
                  </button>
                )}
                <svg
                  className={`w-4 h-4 text-slate-500 transition-transform ${briefingExpanded ? 'rotate-180' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>

            {/* Collapsible content */}
            {briefingExpanded && (
              <div className="px-6 pb-6 border-t border-slate-800">
                <div className="pt-5">
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
                      <button
                        onClick={handleAnalyze}
                        className="mt-3 flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all bg-violet-900/20 border-violet-500/30 text-violet-400 hover:bg-violet-900/40 mx-auto"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        Analyze {isLender ? 'Lender' : 'Investor'}
                      </button>
                    </div>
                  )}
                </div>
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
