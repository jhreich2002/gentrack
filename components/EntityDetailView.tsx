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
  fetchCoLenders,
  LenderPlant, CoLender,
} from '../services/lenderStatsService';
import { fetchTaxEquityStats, fetchTaxEquityPlants, callTaxEquityAnalyze } from '../services/taxEquityService';
import {
  PITCH_ANGLE_LABEL, PITCH_ANGLE_COLOR, FACILITY_ABBR,
  FTI_SERVICE_LINE_LABEL, FTI_SERVICE_LINE_COLOR, SYNDICATE_ROLE_LABEL,
  loanStatusBadge, fmtUsd, scoreBarColor, topServiceLines,
  cfTrendLabel, TYPICAL_CF, fmtMaturityDate, monthsUntil,
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

  const [coLenders, setCoLenders]           = useState<CoLender[]>([]);
  const [coLendersLoading, setCoLendersLoading] = useState(false);

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
    setCoLenders([]);
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
        setBriefingExpanded(false);
      } else {
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

      // Load co-lenders after we have plant codes
      if (entityType === 'lender' && plantData.length > 0) {
        const codes = [...new Set(plantData.map(p => p.eiaPlantCode))];
        setCoLendersLoading(true);
        fetchCoLenders(entityName, codes).then(cl => {
          setCoLenders(cl);
          setCoLendersLoading(false);
        });
      }

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

  // Group plants by loan status
  const plantsByGroup = useMemo(() => {
    if (!isLender) return { active: plants, unknown: [] as LenderPlant[], historical: [] as LenderPlant[] };
    return {
      active:     plants.filter(p => p.loanStatus === 'active'),
      unknown:    plants.filter(p => !p.loanStatus || p.loanStatus === 'unknown'),
      historical: plants.filter(p => p.loanStatus === 'matured' || p.loanStatus === 'refinanced'),
    };
  }, [plants, isLender]);

  // Maturity timeline buckets (one row per loan)
  const maturityBuckets = useMemo(() => {
    const now12  = new Date(); now12.setMonth(now12.getMonth() + 12);
    const now24  = new Date(); now24.setMonth(now24.getMonth() + 24);
    const soon:    LenderPlant[] = [];
    const medium:  LenderPlant[] = [];
    const later:   LenderPlant[] = [];
    const unknown: LenderPlant[] = [];
    for (const p of plants) {
      if (!p.maturityDate) { unknown.push(p); continue; }
      const d = new Date(p.maturityDate);
      if (isNaN(d.getTime())) { unknown.push(p); continue; }
      if (d <= now12)  soon.push(p);
      else if (d <= now24) medium.push(p);
      else later.push(p);
    }
    return { soon, medium, later, unknown };
  }, [plants]);

  // Operator concentration
  const operatorGroups = useMemo(() => {
    const map = new Map<string, { plants: LenderPlant[]; totalCf: number; cfCount: number; curtailed: number }>();
    for (const p of plants) {
      const key = p.ownerName ?? 'Unknown';
      const g = map.get(key) ?? { plants: [], totalCf: 0, cfCount: 0, curtailed: 0 };
      g.plants.push(p);
      if (p.ttmAvgFactor > 0) { g.totalCf += p.ttmAvgFactor; g.cfCount++; }
      if (p.isLikelyCurtailed) g.curtailed++;
      map.set(key, g);
    }
    return Array.from(map.entries())
      .map(([name, g]) => ({
        name,
        count:    g.plants.length,
        avgCf:    g.cfCount > 0 ? g.totalCf / g.cfCount : null,
        curtailed: g.curtailed,
      }))
      .sort((a, b) => b.count - a.count);
  }, [plants]);

  const activeLoanCount = lenderStats?.activeLoanCount ?? (plantsByGroup.active.length || null);
  const pitchBullets = analysis?.analysisAngleBullets ?? lenderStats?.analysisAngleBullets ?? [];
  const topPitchAngle = lenderStats?.topPitchAngle ?? null;
  const ftiServiceLines = topServiceLines(lenderStats?.relevanceScores ?? {}, 1, 4);

  // "Why now" trigger
  const whyNow = useMemo((): { text: string; level: 'red' | 'amber' | 'blue' } | null => {
    if (!lenderStats) return null;
    const now = Date.now();

    // 1. Imminent maturities ≤12 months
    if (maturityBuckets.soon.length > 0) {
      const total = maturityBuckets.soon.reduce((s, p) => s + (p.loanAmountUsd ?? 0), 0);
      const n = maturityBuckets.soon.length;
      const amt = total > 0 ? ` totaling ${fmtUsd(total)}` : '';
      return { text: `⚡ ${n} loan${n !== 1 ? 's' : ''}${amt} mature within 12 months — refinancing advisory window open`, level: 'red' };
    }
    // 2. Maturities 12–24 months
    if (maturityBuckets.medium.length > 0) {
      const n = maturityBuckets.medium.length;
      return { text: `${n} loan${n !== 1 ? 's' : ''} maturing in 12–24 months — early engagement window`, level: 'amber' };
    }
    // 3. High urgency + recent news
    const urgent = lenderStats.highUrgencyCount ?? 0;
    if (urgent > 0 && lenderStats.lastNewsDate) {
      const daysAgo = Math.round((now - new Date(lenderStats.lastNewsDate).getTime()) / 86_400_000);
      if (daysAgo <= 14) {
        return { text: `⚡ ${urgent} plant${urgent !== 1 ? 's' : ''} flagged high urgency · New intelligence ${daysAgo}d ago`, level: 'red' };
      }
    }
    if (urgent > 0) {
      return { text: `${urgent} plant${urgent !== 1 ? 's' : ''} with high-urgency advisory signals`, level: 'amber' };
    }
    // 4. Declining CF
    const plantsWithTrend = plants.filter(p => (p.cfTrend ?? 0) > 0.1);
    if (plantsWithTrend.length >= 2) {
      return { text: `↓ Portfolio generation declining — ${plantsWithTrend.length} plants trending below baseline`, level: 'amber' };
    }
    // 5. High distress with active loans
    const distress = lenderStats.distressScore ?? 0;
    const active = activeLoanCount ?? 0;
    if (distress >= 60 && typeof active === 'number' && active > 0) {
      return { text: `Portfolio distress ${Math.round(distress)}/100 with ${active} active loan${active !== 1 ? 's' : ''} on books`, level: 'amber' };
    }
    // 6. Recent news
    if (lenderStats.lastNewsDate) {
      const daysAgo = Math.round((now - new Date(lenderStats.lastNewsDate).getTime()) / 86_400_000);
      if (daysAgo <= 7) {
        return { text: `New portfolio intelligence ${daysAgo}d ago`, level: 'blue' };
      }
    }
    // 7. First bullet as fallback
    if (pitchBullets[0]) {
      return { text: pitchBullets[0].slice(0, 110), level: 'blue' };
    }
    return null;
  }, [lenderStats, maturityBuckets, plants, activeLoanCount, pitchBullets]);

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
          {groupPlants.map((p, i) => {
            const benchmark = p.fuelSource ? TYPICAL_CF[p.fuelSource] : null;
            const cfGapPts = benchmark && p.ttmAvgFactor > 0
              ? Math.round((p.ttmAvgFactor - benchmark) * 100)
              : null;
            const trend = cfTrendLabel(p.cfTrend);
            return (
              <div
                key={`${p.eiaPlantCode}-${i}`}
                onClick={() => onPlantClick?.(p.eiaPlantCode)}
                className={`flex items-center rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden ${onPlantClick ? 'cursor-pointer hover:bg-slate-800/60' : ''} transition-colors`}
              >
                {/* Left accent bar */}
                <div className={`w-1 self-stretch flex-shrink-0 ${plantAccentColor(p)}`} />

                <div className="flex flex-1 items-center gap-3 px-4 py-3 min-w-0 flex-wrap">
                  {/* Name + State */}
                  <div className="flex-1 min-w-[140px]">
                    <div className="text-sm font-bold text-slate-200 truncate">{p.plantName}</div>
                    <div className="text-[10px] text-slate-500 font-mono">{p.state ?? '—'}</div>
                  </div>

                  {/* MW */}
                  <div className="w-14 text-right flex-shrink-0">
                    <div className="text-xs font-mono font-black text-slate-300">{p.nameplateMw.toLocaleString()}</div>
                    <div className="text-[9px] text-slate-600">MW</div>
                  </div>

                  {/* CF% + benchmark gap */}
                  <div className="w-20 text-right flex-shrink-0">
                    <div className={`text-xs font-mono font-black ${p.ttmAvgFactor > 0 ? 'text-emerald-400' : 'text-slate-600'}`}>
                      {p.ttmAvgFactor > 0 ? `${(p.ttmAvgFactor * 100).toFixed(1)}%` : '—'}
                    </div>
                    {benchmark != null ? (
                      <div className="text-[9px] font-mono text-slate-600">
                        vs {(benchmark * 100).toFixed(0)}% typ.
                        {cfGapPts != null && (
                          <span className={cfGapPts < 0 ? 'text-red-500 font-bold' : 'text-emerald-600 font-bold'}>
                            {' '}{cfGapPts > 0 ? `+${cfGapPts}` : cfGapPts}pt
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="text-[9px] text-slate-600">TTM CF</div>
                    )}
                  </div>

                  {/* Curtailment + trend */}
                  <div className="w-20 text-right flex-shrink-0">
                    {p.isLikelyCurtailed ? (
                      <>
                        <div className="text-xs font-mono font-black text-red-400">{p.curtailmentScore.toFixed(0)}</div>
                        <div className="text-[9px] text-slate-600">Curt.</div>
                      </>
                    ) : (
                      <div className="text-xs text-slate-700">—</div>
                    )}
                    {p.cfTrend != null && (
                      <div className={`text-[9px] font-mono font-bold ${trend.color}`}>{trend.arrow}</div>
                    )}
                  </div>

                  {/* Loan status badge */}
                  <div className="w-16 flex-shrink-0">
                    {isLender && loanStatusBadge(p.loanStatus)}
                  </div>

                  {/* Facility type */}
                  <div className="w-20 flex-shrink-0">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-500 font-mono font-bold">
                      {FACILITY_ABBR[p.facilityType] ?? p.facilityType?.slice(0, 2).toUpperCase() ?? '—'}
                    </span>
                  </div>

                  {/* Loan amount + maturity */}
                  <div className="w-28 text-right flex-shrink-0">
                    <div className="text-xs font-bold text-slate-300">{fmtUsd(p.loanAmountUsd)}</div>
                    <div className="text-[9px] text-slate-600">{fmtMaturityDate(p.maturityDate) ?? p.maturityText ?? '—'}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── Maturity bucket renderer ──────────────────────────────────────────────
  const renderMaturityBucket = (
    bucketPlants: LenderPlant[],
    label: string,
    headerColor: string,
    bgColor: string,
  ) => {
    if (bucketPlants.length === 0) return null;
    const totalAmt = bucketPlants.reduce((s, p) => s + (p.loanAmountUsd ?? 0), 0);
    const visible = bucketPlants.slice(0, 3);
    const extra = bucketPlants.length - visible.length;
    return (
      <div className={`${bgColor} border border-slate-700/50 rounded-xl p-4 flex-1 min-w-[200px]`}>
        <div className={`text-[9px] font-black uppercase tracking-widest mb-1 ${headerColor}`}>{label}</div>
        <div className="text-2xl font-black text-white mb-0.5">{bucketPlants.length}</div>
        {totalAmt > 0 && (
          <div className="text-[10px] text-slate-400 font-mono mb-3">{fmtUsd(totalAmt)} total</div>
        )}
        <div className="space-y-1.5">
          {visible.map((p, i) => (
            <div key={`${p.eiaPlantCode}-${i}`} className="flex items-center justify-between gap-2">
              <div className="text-[10px] text-slate-300 font-semibold truncate flex-1">{p.plantName}</div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {p.loanAmountUsd && (
                  <span className="text-[9px] text-slate-500 font-mono">{fmtUsd(p.loanAmountUsd)}</span>
                )}
                <span className={`text-[9px] font-mono ${headerColor}`}>{fmtMaturityDate(p.maturityDate)}</span>
              </div>
            </div>
          ))}
          {extra > 0 && (
            <div className="text-[9px] text-slate-600">+{extra} more</div>
          )}
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
        <div className="space-y-5 animate-in fade-in duration-500">

          {/* ── Hero Stats Row ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-5 flex items-center gap-4">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${isLender ? 'bg-cyan-900/30' : 'bg-violet-900/30'}`}>
                <svg className={`w-5 h-5 ${isLender ? 'text-cyan-400' : 'text-violet-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <div className="text-2xl font-black text-white">
                  {isLender ? fmtUsd(lenderStats?.totalExposureUsd ?? null) : fmtUsd((stats as TaxEquityStats).totalCommittedUsd ?? null)}
                </div>
                <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Total Exposure</div>
              </div>
            </div>

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

          {/* ── Why Now Trigger Banner ─────────────────────────────────────── */}
          {whyNow && (
            <div className={`rounded-2xl px-5 py-3 flex items-center gap-3 ${
              whyNow.level === 'red'   ? 'bg-red-900/20 border border-red-700/30' :
              whyNow.level === 'amber' ? 'bg-amber-900/20 border border-amber-700/30' :
                                         'bg-blue-900/20 border border-blue-700/30'
            }`}>
              <svg className={`w-4 h-4 flex-shrink-0 ${
                whyNow.level === 'red' ? 'text-red-400' : whyNow.level === 'amber' ? 'text-amber-400' : 'text-blue-400'
              }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <div>
                <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Why Call Now</div>
                <div className={`text-sm font-semibold ${
                  whyNow.level === 'red' ? 'text-red-300' : whyNow.level === 'amber' ? 'text-amber-300' : 'text-blue-300'
                }`}>{whyNow.text}</div>
              </div>
            </div>
          )}

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
                      <span className="mt-0.5 font-black flex-shrink-0 text-xs text-violet-500">◆</span>
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ── FTI Service Line Fit ────────────────────────────────────────── */}
          {isLender && ftiServiceLines.length > 0 && (
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-4">FTI Service Line Fit</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {(['restructuring', 'transactions', 'disputes', 'market_strategy'] as const).map(key => {
                  const score = lenderStats?.relevanceScores?.[key] ?? 0;
                  const dim = score < 20;
                  return (
                    <div
                      key={key}
                      className={`bg-slate-800/40 border border-slate-700/50 rounded-xl px-4 py-3 ${dim ? 'opacity-30' : ''}`}
                    >
                      <div className={`text-[9px] font-black uppercase tracking-widest mb-2 ${FTI_SERVICE_LINE_COLOR[key]?.split(' ')[2] ?? 'text-slate-400'}`}>
                        {FTI_SERVICE_LINE_LABEL[key]}
                      </div>
                      <div className="flex items-center gap-2 mb-1">
                        <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${FTI_SERVICE_LINE_COLOR[key]?.includes('rose') ? 'bg-rose-500' : FTI_SERVICE_LINE_COLOR[key]?.includes('emerald') ? 'bg-emerald-500' : FTI_SERVICE_LINE_COLOR[key]?.includes('orange') ? 'bg-orange-500' : 'bg-sky-500'}`}
                            style={{ width: `${score}%` }}
                          />
                        </div>
                        <span className="text-xs font-black text-white w-6 text-right">{score}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── Maturity Timeline ───────────────────────────────────────────── */}
          {isLender && plantsFetched && plants.some(p => p.maturityDate) && (
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-4">Loan Maturity Timeline</div>
              <div className="flex flex-wrap gap-3">
                {renderMaturityBucket(maturityBuckets.soon,   '≤ 12 Months',  'text-red-400',   'bg-red-900/10')}
                {renderMaturityBucket(maturityBuckets.medium, '12–24 Months', 'text-amber-400', 'bg-amber-900/10')}
                {renderMaturityBucket(maturityBuckets.later,  '> 24 Months',  'text-slate-400', 'bg-slate-800/30')}
                {maturityBuckets.unknown.length > 0 && (
                  <div className="bg-slate-800/30 border border-slate-700/50 rounded-xl p-4 flex-1 min-w-[160px]">
                    <div className="text-[9px] font-black uppercase tracking-widest mb-1 text-slate-600">Unknown</div>
                    <div className="text-2xl font-black text-slate-600">{maturityBuckets.unknown.length}</div>
                    <div className="text-[10px] text-slate-700 mt-0.5">loans — maturity not tracked</div>
                  </div>
                )}
              </div>
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
                    {renderPlantGroup(plantsByGroup.active,    'Active Loans',    'text-emerald-500')}
                    {renderPlantGroup(plantsByGroup.unknown,   'Unknown Status',  'text-slate-500')}
                    {renderPlantGroup(plantsByGroup.historical,'Historical',      'text-slate-600', true)}
                  </>
                ) : (
                  renderPlantGroup(plants, 'All Plants', 'text-slate-400')
                )}
              </div>
            )}
          </section>

          {/* ── Operator Concentration ──────────────────────────────────────── */}
          {plantsFetched && operatorGroups.length >= 2 && (
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-4">Operator / Developer Concentration</div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-800">
                      {['Operator', 'Plants', 'Avg CF', 'Curtailed'].map(h => (
                        <th key={h} className="text-left pb-2 pr-6 text-[9px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {operatorGroups.map(op => {
                      const pctCurtailed = op.curtailed / op.count;
                      const warn = pctCurtailed >= 0.5 && op.curtailed > 0;
                      return (
                        <tr key={op.name} className="border-b border-slate-800/40">
                          <td className="py-2.5 pr-6 font-semibold text-slate-200 whitespace-nowrap">
                            {warn && <span className="text-amber-400 mr-1.5" title="≥50% of plants curtailed">⚠</span>}
                            {op.name}
                          </td>
                          <td className="py-2.5 pr-6 font-mono text-slate-300">{op.count}</td>
                          <td className="py-2.5 pr-6 font-mono text-emerald-400">
                            {op.avgCf != null ? `${(op.avgCf * 100).toFixed(1)}%` : '—'}
                          </td>
                          <td className="py-2.5 pr-6">
                            {op.curtailed > 0 ? (
                              <span className="text-red-400 font-mono font-bold">{op.curtailed}</span>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Syndicate Co-Lenders ────────────────────────────────────────── */}
          {isLender && (coLendersLoading || coLenders.length > 0) && (
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-4">Syndicate Network — Frequent Co-Lenders</div>
              {coLendersLoading && (
                <div className="flex items-center gap-2 text-slate-600 text-xs">
                  <div className="w-3 h-3 rounded-full border border-slate-600 border-t-slate-400 animate-spin" />
                  Loading syndicate data...
                </div>
              )}
              {!coLendersLoading && coLenders.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-800">
                        {['Co-Lender', 'Shared Plants', 'Role(s)'].map(h => (
                          <th key={h} className="text-left pb-2 pr-6 text-[9px] font-black text-slate-500 uppercase tracking-widest whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {coLenders.map(cl => (
                        <tr key={cl.lenderName} className="border-b border-slate-800/40">
                          <td className="py-2.5 pr-6 font-semibold text-slate-200 whitespace-nowrap">
                            {cl.lenderName}
                            {cl.sharedPlantCount > 3 && (
                              <span className="ml-2 text-[9px] px-1.5 py-px rounded bg-cyan-900/30 border border-cyan-700/30 text-cyan-400 font-bold">Frequent</span>
                            )}
                          </td>
                          <td className="py-2.5 pr-6 font-mono text-slate-300">{cl.sharedPlantCount}</td>
                          <td className="py-2.5 pr-6">
                            <div className="flex flex-wrap gap-1">
                              {cl.syndicateRoles.map(role => (
                                <span key={role} className="text-[9px] px-1.5 py-px rounded bg-slate-800 border border-slate-700 text-slate-400 font-mono">
                                  {SYNDICATE_ROLE_LABEL[role] ?? role}
                                </span>
                              ))}
                              {cl.syndicateRoles.length === 0 && <span className="text-slate-700">—</span>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* ── AI Intelligence Briefing (collapsible) ──────────────────────── */}
          <section className="bg-slate-900 border border-slate-800 rounded-2xl shadow-lg overflow-hidden">
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
