
import React, { useEffect, useState } from 'react';
import { PowerPlant, CapacityFactorStats, FuelSource, PlantOwner, PlantOwnership, NewsArticle, PlantNewsRating } from '../types';
import { COLORS, TYPICAL_CAPACITY_FACTORS, EIA_START_MONTH, formatMonthYear } from '../constants';
import CapacityChart from './CapacityChart';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine, AreaChart, Area } from 'recharts';
import { fetchPlantOwnership } from '../services/ownershipService';
import { fetchPlantNewsArticles, fetchPlantNewsRating, fetchPlantNewsState, callPlantSummarize, PlantSummaryResponse, semanticSearchPlantNews, SemanticSearchResult } from '../services/newsIntelService';
import { getGlobalLatestMonth } from '../services/dataService';

interface Props {
  plant: PowerPlant;
  stats: CapacityFactorStats;
  regionalAvg: number;
  subRegionalAvg: number;
  regionalTrend: { month: string; factor: number }[];
  subRegionalTrend: { month: string; factor: number }[];
  generationLoading?: boolean;
  isWatched: boolean;
  onToggleWatch: (e: React.MouseEvent) => void;
  onBack: () => void;
  onCompanyClick?: (ultParentName: string) => void;
}

type DetailTab = 'overview' | 'monthly' | 'generation' | 'ownership' | 'news';

const PlantDetailView: React.FC<Props> = ({ 
  plant, 
  stats, 
  regionalAvg, 
  subRegionalAvg, 
  regionalTrend,
  subRegionalTrend,
  generationLoading = false,
  isWatched,
  onToggleWatch,
  onBack,
  onCompanyClick,
}) => {
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');

  const [ownership, setOwnership] = useState<PlantOwnership | null>(null);
  const [loadingOwnership, setLoadingOwnership] = useState(false);
  const [ownershipFetched, setOwnershipFetched] = useState(false);

  // ── News Intelligence (stored articles + risk rating) ────────────────────
  const [newsArticles, setNewsArticles] = useState<NewsArticle[]>([]);
  const [newsRating, setNewsRating] = useState<PlantNewsRating | null>(null);
  const [loadingIntel, setLoadingIntel] = useState(false);
  const [intelFetched, setIntelFetched] = useState(false);
  const [intelTopicFilter, setIntelTopicFilter] = useState<string>('all');
  const [intelDaysBack, setIntelDaysBack] = useState<number>(9999);

  // ── Situation Summary (LLM) ──────────────────────────────────────────────
  const [plantSummary, setPlantSummary] = useState<PlantSummaryResponse | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);

  // ── Expanded article (click to expand instead of link) ──────────────────
  const [expandedArticleId, setExpandedArticleId] = useState<string | null>(null);

  // ── Semantic Search ──────────────────────────────────────────────────────
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticResults, setSemanticResults] = useState<SemanticSearchResult[]>([]);
  const [searchingSemantics, setSearchingSemantics] = useState(false);
  const [semanticSearched, setSemanticSearched] = useState(false);

  const handleLoadNewsIntel = async (daysBack = intelDaysBack) => {
    if (loadingIntel || intelFetched) return;
    setLoadingIntel(true);
    // Kick off articles + rating + cached summary in parallel
    const [articles, rating, cachedState] = await Promise.all([
      fetchPlantNewsArticles(plant.eiaPlantCode, { daysBack }),
      fetchPlantNewsRating(plant.eiaPlantCode),
      fetchPlantNewsState(plant.eiaPlantCode),
    ]);
    setNewsArticles(articles);
    setNewsRating(rating);
    if (cachedState?.summaryText) {
      setPlantSummary({
        summary_text: cachedState.summaryText,
        fti_angle_bullets: cachedState.ftiAngleBullets,
        summary_last_updated_at: cachedState.summaryLastUpdatedAt ?? '',
        from_cache: true,
      });
    } else {
      // No cached summary — auto-generate one
      setLoadingSummary(true);
      callPlantSummarize(plant.eiaPlantCode, plant.name, plant.owner)
        .then(result => { if (result) setPlantSummary(result); })
        .finally(() => setLoadingSummary(false));
    }
    setLoadingIntel(false);
    setIntelFetched(true);
  };

  const handleRefreshSummary = async () => {
    if (loadingSummary) return;
    setLoadingSummary(true);
    const result = await callPlantSummarize(
      plant.eiaPlantCode,
      plant.name,
      plant.owner,
    );
    if (result) setPlantSummary(result);
    setLoadingSummary(false);
  };

  // Reset all per-plant state when the plant changes
  useEffect(() => {
    setActiveTab('overview');
    setOwnership(null); setOwnershipFetched(false);
    setNewsArticles([]); setNewsRating(null);
    setPlantSummary(null); setLoadingSummary(false);
    setIntelFetched(false); setIntelTopicFilter('all'); setIntelDaysBack(9999);
    setExpandedArticleId(null);
  }, [plant.eiaPlantCode]);

  const handleLoadOwnership = async () => {
    if (loadingOwnership || ownershipFetched) return;
    setLoadingOwnership(true);
    const data = await fetchPlantOwnership(plant.eiaPlantCode);
    setOwnership(data);
    setLoadingOwnership(false);
    setOwnershipFetched(true);
  };

  const diffFromRegAvg = stats.ttmAverage - regionalAvg;
  const diffFromSubAvg = stats.ttmAverage - subRegionalAvg;

  const comparisonData = [
    { name: 'This Plant', value: Math.round(stats.ttmAverage * 100), color: COLORS[plant.fuelSource] },
    { name: 'Sub-Region Avg', value: Math.round(subRegionalAvg * 100), color: '#3b82f6' },
    { name: 'ISO/RTO Avg', value: Math.round(regionalAvg * 100), color: '#6366f1' },
    { name: 'National Typical', value: Math.round(TYPICAL_CAPACITY_FACTORS[plant.fuelSource] * 100), color: '#334155' },
  ];

  // Prepare full-history data for the overview spark-graph (Jan 2024 → present)
  const ttmTrendData = stats.monthlyFactors.map(f => {
    const regionalPoint = regionalTrend?.find(rt => rt.month === f.month);
    const subRegionalPoint = subRegionalTrend?.find(rt => rt.month === f.month);
    return {
      month: f.month,
      factor: f.factor !== null ? Math.round(f.factor * 100) : null,
      regionalFactor: regionalPoint ? Math.round(regionalPoint.factor * 100) : null,
      subRegionalFactor: subRegionalPoint ? Math.round(subRegionalPoint.factor * 100) : null,
    };
  });

  // TTM average as a flat reference value for the chart
  const ttmAvgPct = Math.round(stats.ttmAverage * 100);

  // Auto-scale the TTM Y-axis so variance is visually legible.
  // If any month is 0 (e.g. solar in winter), anchor floor at 0 so the zero
  // months remain visible; otherwise tighten with ±5-point padding.
  const ttmAllValues = ttmTrendData
    .flatMap(d => [d.factor, d.regionalFactor, d.subRegionalFactor])
    .filter((v): v is number => v !== null);
  const ttmHasZero = ttmAllValues.some(v => v === 0);
  const ttmMin = ttmAllValues.length > 0 ? Math.min(...ttmAllValues) : 0;
  const ttmMax = ttmAllValues.length > 0 ? Math.max(...ttmAllValues) : 100;
  const ttmYDomain: [number, number] = ttmAllValues.length > 0
    ? [ttmHasZero ? 0 : Math.max(0, Math.floor(ttmMin) - 5), Math.min(100, Math.ceil(ttmMax) + 5)]
    : [0, 100];

  return (
    <div className="flex flex-col h-full overflow-y-auto pb-20">
      {/* Header Section */}
      <div className="flex items-start gap-4 mb-6">
        <button 
          onClick={onBack}
          className="p-2 mt-1 hover:bg-slate-800 rounded-full text-slate-400 transition-colors border border-transparent hover:border-slate-700"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-black text-white tracking-tight">{plant.name}</h1>
            <span style={{ color: COLORS[plant.fuelSource], backgroundColor: `${COLORS[plant.fuelSource]}10` }} className="text-[10px] px-2 py-0.5 rounded font-bold border border-current uppercase">
              {plant.fuelSource}
            </span>
          </div>
          <p className="text-slate-400 text-sm mt-1">
            {plant.owners && plant.owners.length > 1 ? (
              <>
                Owned by{' '}
                {plant.owners.map((o, i) => (
                  <span key={i}>
                    <span className="text-blue-400 font-bold">{o.name}</span>
                    <span className="text-slate-500 text-xs font-mono ml-1">({o.percent}%)</span>
                    {i < plant.owners!.length - 1 && <span className="text-slate-600 mx-1">•</span>}
                  </span>
                ))}
              </>
            ) : (
              <>Owned by <span className="text-blue-400 font-bold">{plant.owner}</span></>
            )}
            {' '}• {plant.region} / <span className="text-blue-300 font-semibold">{plant.subRegion}</span>
          </p>
          <p className="text-slate-500 text-xs mt-1 font-mono">
            EIA Plant Code: <span className="text-slate-300 font-bold">{plant.eiaPlantCode}</span>
            {plant.operatorId && <> • Operator ID: <span className="text-slate-300 font-bold">{plant.operatorId}</span></>}
            {' • '}
            {plant.county ? `${plant.county}, ` : ''}{plant.location.state}
            {plant.cod && (
              <> • Online: <span className="text-slate-300 font-bold">
                {new Date(plant.cod + '-02').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
              </span></>
            )}
          </p>
        </div>
        <button 
          onClick={onToggleWatch}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-xs transition-all border ${
            isWatched 
              ? 'bg-amber-900/20 border-amber-500/50 text-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.1)]' 
              : 'bg-slate-900 border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-500'
          }`}
        >
          <svg className="w-4 h-4" fill={isWatched ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.382-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
          {isWatched ? 'WATCHING' : 'WATCH ASSET'}
        </button>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b border-slate-800 mb-8 p-1 bg-slate-900/40 rounded-t-xl w-fit">
        <button 
          onClick={() => setActiveTab('overview')}
          className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === 'overview' ? 'bg-slate-800 text-white shadow-lg shadow-black/20' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
          PERFORMANCE OVERVIEW
        </button>
        <button 
          onClick={() => setActiveTab('monthly')}
          className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === 'monthly' ? 'bg-slate-800 text-white shadow-lg shadow-black/20' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" /></svg>
          MONTHLY TREND
        </button>
        <button 
          onClick={() => setActiveTab('generation')}
          className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === 'generation' ? 'bg-slate-800 text-white shadow-lg shadow-black/20' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="12" width="4" height="9" rx="1" strokeWidth="2"/><rect x="10" y="7" width="4" height="14" rx="1" strokeWidth="2"/><rect x="17" y="3" width="4" height="18" rx="1" strokeWidth="2"/></svg>
          GENERATION (MWH)
        </button>
        <button
          onClick={() => { setActiveTab('ownership'); handleLoadOwnership(); }}
          className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === 'ownership' ? 'bg-slate-800 text-white shadow-lg shadow-black/20' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
          OWNERSHIP & PPA
        </button>
        <button 
          onClick={() => { setActiveTab('news'); handleLoadNewsIntel(); }}
          className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === 'news' ? 'bg-slate-800 text-white shadow-lg shadow-black/20' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10l4 4v10a2 2 0 01-2 2zM14 4v4h4" /></svg>
          NEWS & INTELLIGENCE
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 relative">
        {generationLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/80 rounded-2xl">
            <div className="flex items-center gap-3 text-slate-400">
              <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-blue-500"></div>
              <span className="text-sm font-medium">Loading generation data...</span>
            </div>
          </div>
        )}
        {activeTab === 'overview' && (
          <div className="space-y-8 animate-in fade-in duration-500">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col justify-center items-center text-center shadow-lg relative overflow-hidden group">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-blue-500/20 to-transparent"></div>
                <div className="text-[10px] uppercase font-bold text-slate-500 mb-2 tracking-widest">TTM Capacity Factor</div>
                <div className="text-6xl font-black mb-2 transition-transform group-hover:scale-110 duration-300" style={{ color: stats.isMaintenanceOffline ? '#d97706' : stats.hasNoRecentData ? '#64748b' : stats.isLikelyCurtailed ? COLORS.curtailed : COLORS[plant.fuelSource] }}>
                  {(stats.ttmAverage * 100).toFixed(1)}%
                </div>
                <div className="flex flex-col gap-2 mt-4 w-full">
                  <div className={`text-[10px] px-3 py-1.5 rounded-lg font-bold flex items-center justify-between ${diffFromSubAvg >= 0 ? 'bg-green-900/20 text-green-400 border border-green-500/20' : 'bg-red-900/20 text-red-400 border border-red-500/20'}`}>
                    <span>Sub-Zone Delta</span>
                    <span className="font-mono">{diffFromSubAvg >= 0 ? '+' : ''}{(diffFromSubAvg * 100).toFixed(1)}%</span>
                  </div>
                  <div className={`text-[10px] px-3 py-1.5 rounded-lg font-bold flex items-center justify-between ${diffFromRegAvg >= 0 ? 'bg-indigo-900/20 text-indigo-400 border border-indigo-500/20' : 'bg-slate-800 text-slate-500 border border-slate-700'}`}>
                    <span>Market Delta</span>
                    <span className="font-mono">{diffFromRegAvg >= 0 ? '+' : ''}{(diffFromRegAvg * 100).toFixed(1)}%</span>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em]">Comparative Drill-Down</h3>
                  <div className="text-[10px] text-slate-500 font-bold">TRAILING 12 MONTHS</div>
                </div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={comparisonData} layout="vertical" margin={{ left: 20 }}>
                      <XAxis type="number" domain={[0, 100]} hide />
                      <YAxis dataKey="name" type="category" stroke="#475569" fontSize={10} width={120} tickLine={false} axisLine={false} />
                      <Tooltip 
                        cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                        contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '11px' }}
                      />
                      <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={28}>
                        {comparisonData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} fillOpacity={0.9} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-8">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg overflow-hidden">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Capacity Factor vs Regional Average</h3>
                    <p className="text-[10px] text-slate-600 font-bold">JAN 2024 — PRESENT — {plant.fuelSource.toUpperCase()} PEERS IN {plant.region.toUpperCase()}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-1 rounded-full" style={{ backgroundColor: COLORS[plant.fuelSource] }}></div>
                      <span className="text-[10px] text-slate-400 font-bold uppercase">{plant.name.split(' ').slice(0, 2).join(' ')}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-px bg-violet-500"></div>
                      <span className="text-[10px] text-slate-500 font-bold uppercase">{plant.subRegion}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-px bg-slate-600" style={{ borderTop: '1px dashed #475569' }}></div>
                      <span className="text-[10px] text-slate-600 font-bold uppercase">{plant.region} Avg</span>
                    </div>
                  </div>
                </div>
                <div className="h-48 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={ttmTrendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorFactor" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={COLORS[plant.fuelSource]} stopOpacity={0.25}/>
                          <stop offset="95%" stopColor={COLORS[plant.fuelSource]} stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="month" stroke="#475569" fontSize={10} tickLine={false} axisLine={false} tickFormatter={formatMonthYear} interval={2} />
                      <YAxis stroke="#475569" fontSize={10} domain={ttmYDomain} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '10px' }}
                        labelFormatter={(label: string) => formatMonthYear(label)}
                        formatter={(value: number | null, name: string) => [
                          value !== null ? `${value}%` : 'N/A',
                          name === 'factor' ? plant.name : name === 'subRegionalFactor' ? `${plant.subRegion} Avg` : `${plant.region} Avg`
                        ]}
                      />
                      {/* TTM average reference line */}
                      <ReferenceLine y={ttmAvgPct} stroke={COLORS[plant.fuelSource]} strokeDasharray="3 3" strokeOpacity={0.5} label={{ value: `TTM ${ttmAvgPct}%`, position: 'insideTopRight', fill: COLORS[plant.fuelSource], fontSize: 9, opacity: 0.7 }} />
                      {/* ISO/RTO regional average */}
                      <Area type="monotone" dataKey="regionalFactor" stroke="#475569" fill="transparent" strokeWidth={1} strokeDasharray="5 5" dot={false} />
                      {/* Sub-regional zone average */}
                      <Area type="monotone" dataKey="subRegionalFactor" stroke="#8b5cf6" fill="transparent" strokeWidth={1.5} dot={false} />
                      {/* This plant */}
                      <Area type="monotone" dataKey="factor" stroke={COLORS[plant.fuelSource]} fillOpacity={1} fill="url(#colorFactor)" strokeWidth={2.5} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-8">Grid Hierarchy & Metrics</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                <div className="space-y-1 group">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest transition-colors group-hover:text-blue-400">Sub-Zone Average</div>
                  <div className="text-2xl font-black text-slate-200">{(subRegionalAvg * 100).toFixed(1)}%</div>
                  <div className="text-[10px] text-slate-600 font-medium">{plant.subRegion} Zone</div>
                </div>
                <div className="space-y-1 group">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest transition-colors group-hover:text-indigo-400">ISO/RTO Average</div>
                  <div className="text-2xl font-black text-slate-200">{(regionalAvg * 100).toFixed(1)}%</div>
                  <div className="text-[10px] text-slate-600 font-medium">{plant.region} Market</div>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Nameplate Capacity</div>
                  <div className="text-2xl font-black text-slate-200">{plant.nameplateCapacityMW.toLocaleString()} <span className="text-xs text-slate-600">MW</span></div>
                  <div className="text-[10px] text-slate-600 font-medium">Design Specification</div>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest">Curtailment Risk</div>
                  {stats.isMaintenanceOffline
                    ? <div className="text-2xl font-black text-amber-500">N/A<span className="text-xs opacity-40 ml-1">maintenance</span></div>
                    : stats.hasNoRecentData
                      ? <div className="text-2xl font-black text-slate-600">N/A<span className="text-xs opacity-40 ml-1">no data</span></div>
                      : <div className={`text-2xl font-black ${stats.curtailmentScore > 50 ? 'text-red-500' : 'text-slate-200'}`}>{stats.curtailmentScore}<span className="text-xs opacity-40">/100</span></div>
                  }
                  <div className="text-[10px] text-slate-600 font-medium">Internal Algorithm</div>
                </div>
              </div>

              {/* Ownership breakdown — only shown when Schedule 2 data is available */}
              {plant.owners && plant.owners.length > 0 && (
                <div className="mt-8 pt-8 border-t border-slate-800">
                  <div className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-4">Ownership — EIA-860 Schedule 2</div>
                  {/* Stacked percentage bar */}
                  <div className="flex h-2 rounded-full overflow-hidden w-full mb-5">
                    {plant.owners.map((o, i) => (
                      <div
                        key={i}
                        style={{
                          width: `${o.percent}%`,
                          backgroundColor: i === 0 ? '#3b82f6' : i === 1 ? '#6366f1' : i === 2 ? '#8b5cf6' : '#475569'
                        }}
                        title={`${o.name}: ${o.percent}%`}
                      />
                    ))}
                  </div>
                  {/* Owner rows */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {plant.owners.map((o, i) => (
                      <div key={i} className="flex items-center justify-between bg-slate-800/30 px-4 py-2.5 rounded-xl border border-slate-700/50">
                        <div className="flex items-center gap-2.5">
                          <div
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: i === 0 ? '#3b82f6' : i === 1 ? '#6366f1' : i === 2 ? '#8b5cf6' : '#475569' }}
                          />
                          <span className="text-xs text-slate-300 font-medium truncate">{o.name}</span>
                        </div>
                        <span className="text-xs font-black text-slate-200 font-mono ml-4 flex-shrink-0">{o.percent}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'monthly' && (
          <div className="animate-in slide-in-from-bottom-4 fade-in duration-500">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Historical Performance Analysis</h3>
                  <p className="text-xs text-slate-600 font-medium">Comparing month-to-month capacity factor against regional peers</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-0.5" style={{ backgroundColor: COLORS[plant.fuelSource] }}></div>
                    <span className="text-[10px] font-bold text-slate-500">{plant.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-0.5 bg-slate-600 border-dashed"></div>
                    <span className="text-[10px] font-bold text-slate-500">Regional Avg</span>
                  </div>
                </div>
              </div>
              <div className="h-96">
                <CapacityChart plant={plant} stats={stats} regionalTrend={regionalTrend} />
              </div>
              <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                  <div className="text-[9px] font-bold text-slate-500 uppercase mb-2">Max Historical Factor</div>
                  <div className="text-xl font-black text-white">
                    {(() => { const vals = stats.monthlyFactors.filter(f => f.factor !== null).map(f => f.factor as number); return vals.length > 0 ? `${Math.round(Math.max(...vals) * 100)}%` : 'N/A'; })()}
                  </div>
                </div>
                <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                  <div className="text-[9px] font-bold text-slate-500 uppercase mb-2">Min Historical Factor</div>
                  <div className="text-xl font-black text-white">
                    {(() => { const vals = stats.monthlyFactors.filter(f => f.factor !== null).map(f => f.factor as number); return vals.length > 0 ? `${Math.round(Math.min(...vals) * 100)}%` : 'N/A'; })()}
                  </div>
                </div>
                <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                  <div className="text-[9px] font-bold text-slate-500 uppercase mb-2">Historical Volatility</div>
                  <div className="text-xl font-black text-white">LOW</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'generation' && (() => {
          // Expand to full EIA range (EIA_START_MONTH → global latest month), null = not in EIA database
          const genHistMap = new Map<string, number | null>(plant.generationHistory.map(g => [g.month, g.mwh]));
          const globalLatest = getGlobalLatestMonth();
          const genData: { name: string; mwh: number | null }[] = [];
          let genCursor = EIA_START_MONTH;
          while (genCursor <= globalLatest) {
            genData.push({ name: genCursor, mwh: genHistMap.get(genCursor) ?? null });
            const [gy, gm] = genCursor.split('-').map(Number);
            genCursor = gm === 12 ? `${gy + 1}-01` : `${gy}-${String(gm + 1).padStart(2, '0')}`;
          }
          const nonNullMwh = plant.generationHistory
            .filter(g => g.mwh !== null)
            .map(g => g.mwh as number);
          const ttmMwh = plant.generationHistory
            .slice(-12)
            .filter(g => g.mwh !== null)
            .map(g => g.mwh as number);
          const totalTTM = ttmMwh.reduce((a, b) => a + b, 0);
          const peakMwh = nonNullMwh.length > 0 ? Math.max(...nonNullMwh) : null;
          const peakMonth = peakMwh !== null
            ? plant.generationHistory.find(g => g.mwh === peakMwh)?.month ?? null
            : null;
          const avgMonthly = nonNullMwh.length > 0
            ? nonNullMwh.reduce((a, b) => a + b, 0) / nonNullMwh.length
            : null;
          const color = COLORS[plant.fuelSource];
          return (
            <div className="animate-in slide-in-from-bottom-4 fade-in duration-500">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Monthly Generation Output</h3>
                    <p className="text-xs text-slate-600 font-medium">Raw MWh produced per month — full available history</p>
                  </div>
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.15em]">{plant.nameplateCapacityMW.toLocaleString()} MW Nameplate</div>
                </div>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={genData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis
                        dataKey="name"
                        stroke="#475569"
                        fontSize={9}
                        tickLine={false}
                        axisLine={false}
                        interval={2}
                        tickFormatter={formatMonthYear}
                      />
                      <YAxis
                        stroke="#475569"
                        fontSize={9}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`}
                        width={45}
                      />
                      <Tooltip
                        cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                        contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '11px' }}
                        labelFormatter={(label: string) => formatMonthYear(label)}
                        formatter={(value: number | null) => [
                          value !== null ? `${value.toLocaleString()} MWh` : 'N/A',
                          'Generation'
                        ]}
                      />
                      <Bar dataKey="mwh" fill={color} fillOpacity={0.85} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                    <div className="text-[9px] font-bold text-slate-500 uppercase mb-2">Total TTM Generation</div>
                    <div className="text-xl font-black text-white">
                      {ttmMwh.length > 0 ? `${Math.round(totalTTM).toLocaleString()} MWh` : 'N/A'}
                    </div>
                    <div className="text-[9px] text-slate-600 mt-1">Last 12 reported months</div>
                  </div>
                  <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                    <div className="text-[9px] font-bold text-slate-500 uppercase mb-2">Peak Month</div>
                    <div className="text-xl font-black text-white">
                      {peakMwh !== null ? `${Math.round(peakMwh).toLocaleString()} MWh` : 'N/A'}
                    </div>
                    <div className="text-[9px] text-slate-600 mt-1">
                      {peakMonth ? formatMonthYear(peakMonth) : ''}
                    </div>
                  </div>
                  <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                    <div className="text-[9px] font-bold text-slate-500 uppercase mb-2">Avg Monthly Generation</div>
                    <div className="text-xl font-black text-white">
                      {avgMonthly !== null ? `${Math.round(avgMonthly).toLocaleString()} MWh` : 'N/A'}
                    </div>
                    <div className="text-[9px] text-slate-600 mt-1">All available months</div>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {activeTab === 'ownership' && (
          <div className="animate-in slide-in-from-right-4 fade-in duration-500 space-y-6">
            {loadingOwnership && (
              <div className="py-20 flex flex-col items-center justify-center space-y-6">
                <div className="w-12 h-12 rounded-full border-2 border-emerald-500/20 border-t-emerald-500 animate-spin"></div>
                <p className="text-slate-400 font-bold text-sm">Loading ownership data...</p>
              </div>
            )}

            {ownershipFetched && !loadingOwnership && !ownership && (
              <div className="py-20 text-center bg-slate-900 rounded-2xl border border-slate-800">
                <p className="text-sm font-bold text-slate-400">No ownership data on record for this plant.</p>
                <p className="text-xs text-slate-600 mt-1">EIA Site Code: {plant.eiaPlantCode}</p>
              </div>
            )}

            {ownershipFetched && !loadingOwnership && ownership && (
              <>
                {/* Ownership Structure */}
                <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="bg-emerald-600 p-2.5 rounded-xl shadow-lg shadow-emerald-900/20">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-white tracking-tight">Ownership Structure</h2>
                      <p className="text-xs text-slate-500 font-medium">Ownership chain and operating interest</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {([
                      { label: 'Owner',                        value: ownership.owner },
                      { label: 'Ultimate Parent',              value: ownership.ultParent, isCompany: true },
                      { label: 'Operator',                     value: ownership.plantOperator },
                      { label: 'Operator Ultimate Parent',     value: ownership.operatorUltParent, isCompany: true },
                      { label: 'Technology Type',              value: ownership.techType },
                      { label: 'Operating Ownership',          value: ownership.operOwnPct != null ? `${ownership.operOwnPct}%` : null },
                      { label: 'Ownership Status',             value: ownership.ownStatus },
                      { label: 'Planned Ownership',            value: ownership.plannedOwn },
                      { label: 'Owner EIA Utility Code',       value: ownership.ownerEiaUtilityCode },
                      { label: 'Parent EIA Utility Code',      value: ownership.parentEiaUtilityCode },
                    ] as { label: string; value: string | null; isCompany?: boolean }[]).map(({ label, value, isCompany }) => (
                      <div key={label} className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1">{label}</div>
                        {value && isCompany && onCompanyClick
                          ? <button onClick={() => onCompanyClick(value)} className="text-sm font-bold text-blue-400 hover:text-blue-300 hover:underline text-left transition-colors">{value}</button>
                          : <div className="text-sm font-bold text-white">{value ?? <span className="text-slate-600 font-normal italic">N/A</span>}</div>
                        }
                      </div>
                    ))}
                  </div>
                </section>

                {/* PPA Details */}
                <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="bg-blue-600 p-2.5 rounded-xl shadow-lg shadow-blue-900/20">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-white tracking-tight">Power Purchase Agreement</h2>
                      <p className="text-xs text-slate-500 font-medium">Largest PPA counterparty and contract terms</p>
                    </div>
                  </div>
                  {ownership.largestPpaCounterparty ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                      {([
                        { label: 'Counterparty',        value: ownership.largestPpaCounterparty },
                        { label: 'Contracted Capacity', value: ownership.largestPpaCapacityMW != null ? `${ownership.largestPpaCapacityMW} MW` : null },
                        { label: 'Contract Start',      value: ownership.largestPpaStartDate },
                        { label: 'Contract Expiration', value: ownership.largestPpaExpirationDate },
                      ] as { label: string; value: string | null }[]).map(({ label, value }) => (
                        <div key={label} className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                          <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1">{label}</div>
                          <div className="text-sm font-bold text-white">{value ?? <span className="text-slate-600 font-normal italic">N/A</span>}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-10 text-center text-slate-600 bg-slate-800/10 rounded-2xl border border-dashed border-slate-800">
                      <p className="text-xs font-bold italic">No PPA data on record for this plant.</p>
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        )}

        {activeTab === 'news' && (
          <div className="animate-in slide-in-from-right-4 fade-in duration-500 space-y-8">

            {/* ── Situation Summary Card ────────────────────────────────── */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className="bg-violet-700 p-2.5 rounded-xl shadow-lg shadow-violet-900/20">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white tracking-tight">Situation Summary</h2>
                    <p className="text-xs text-slate-500 font-medium">AI-generated advisory analysis via Gemini Flash</p>
                  </div>
                </div>
                <button
                  onClick={handleRefreshSummary}
                  disabled={loadingSummary}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all bg-violet-900/20 border-violet-500/30 text-violet-400 hover:bg-violet-900/40 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {loadingSummary ? (
                    <div className="w-3 h-3 rounded-full border border-violet-400/30 border-t-violet-400 animate-spin" />
                  ) : (
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                  )}
                  {loadingSummary ? 'Analyzing...' : 'Refresh Analysis'}
                </button>
              </div>

              {/* Loading state */}
              {loadingSummary && !plantSummary && (
                <div className="py-10 flex flex-col items-center justify-center space-y-4">
                  <div className="w-8 h-8 rounded-full border-2 border-violet-500/20 border-t-violet-500 animate-spin"></div>
                  <p className="text-slate-400 text-xs font-bold">Generating advisory analysis...</p>
                </div>
              )}

              {/* Summary content */}
              {plantSummary && (
                <div className="space-y-5">
                  <p className="text-sm text-slate-300 leading-relaxed">{plantSummary.summary_text}</p>

                  {plantSummary.fti_angle_bullets.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-[9px] font-black text-violet-400 uppercase tracking-widest">Advisory Angles</div>
                      <ul className="space-y-1.5">
                        {plantSummary.fti_angle_bullets.map((bullet, i) => (
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
                      {plantSummary.from_cache ? 'Cached analysis' : 'Fresh analysis'} •{' '}
                      {plantSummary.summary_last_updated_at
                        ? (() => {
                            const ageMs = Date.now() - new Date(plantSummary.summary_last_updated_at).getTime();
                            const ageH  = Math.floor(ageMs / 3_600_000);
                            const ageM  = Math.floor((ageMs % 3_600_000) / 60_000);
                            return ageH > 0 ? `${ageH}h ${ageM}m ago` : `${ageM}m ago`;
                          })()
                        : 'just now'}
                    </div>
                    <div className="text-[9px] text-slate-600">Gemini 2.5 Flash Lite</div>
                  </div>
                </div>
              )}

              {/* No summary yet + not loading */}
              {!plantSummary && !loadingSummary && (
                <div className="py-8 text-center text-slate-600 bg-slate-800/10 rounded-2xl border border-dashed border-slate-800">
                  <svg className="w-7 h-7 mx-auto mb-3 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                  <p className="text-xs font-bold italic">No analysis generated yet.</p>
                  <p className="text-[10px] text-slate-700 mt-1">Click <span className="text-violet-500">Refresh Analysis</span> to generate an AI situation summary.</p>
                </div>
              )}
            </section>

            {/* ── Semantic Search Section ────────────────────────────── */}
            <section className="bg-slate-900 border border-indigo-900/40 rounded-2xl p-8 shadow-lg">
              <div className="flex items-center gap-3 mb-5">
                <div className="bg-indigo-700 p-2.5 rounded-xl shadow-lg shadow-indigo-900/20">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white tracking-tight">Semantic Search</h2>
                  <p className="text-xs text-slate-500 font-medium">Ask a question — AI matches it against stored articles</p>
                </div>
              </div>

              <form
                onSubmit={async e => {
                  e.preventDefault();
                  if (!semanticQuery.trim() || searchingSemantics) return;
                  setSearchingSemantics(true);
                  setSemanticSearched(false);
                  const results = await semanticSearchPlantNews(plant.eiaPlantCode, semanticQuery.trim());
                  setSemanticResults(results);
                  setSearchingSemantics(false);
                  setSemanticSearched(true);
                }}
                className="flex gap-2 mb-5"
              >
                <input
                  type="text"
                  value={semanticQuery}
                  onChange={e => setSemanticQuery(e.target.value)}
                  placeholder="e.g. environmental violations, grid connection disputes, transmission upgrades..."
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/40 transition-all"
                />
                <button
                  type="submit"
                  disabled={!semanticQuery.trim() || searchingSemantics}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-black uppercase tracking-widest bg-indigo-600 hover:bg-indigo-500 text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {searchingSemantics
                    ? <div className="w-4 h-4 rounded-full border border-indigo-300/30 border-t-indigo-200 animate-spin" />
                    : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>}
                  {searchingSemantics ? 'Searching...' : 'Search'}
                </button>
              </form>

              {/* Results */}
              {semanticSearched && semanticResults.length === 0 && (
                <div className="py-10 text-center text-slate-600 bg-slate-800/10 rounded-2xl border border-dashed border-slate-800">
                  <svg className="w-7 h-7 mx-auto mb-3 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <p className="text-xs font-bold italic">No matching articles found. Try a broader query or ensure embeddings have been generated.</p>
                </div>
              )}

              {semanticResults.length > 0 && (
                <div className="space-y-3">
                  <div className="text-[9px] font-black text-indigo-400 uppercase tracking-widest mb-1">{semanticResults.length} result{semanticResults.length !== 1 ? 's' : ''} — ranked by semantic similarity</div>
                  {semanticResults.map(article => (
                    <div
                      key={article.id}
                      onClick={() => setExpandedArticleId(expandedArticleId === article.id ? null : article.id)}
                      className="block bg-slate-800/40 border border-indigo-900/30 rounded-xl p-4 hover:bg-slate-800/60 hover:border-indigo-700/50 transition-all cursor-pointer"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">{article.sourceName}</span>
                            {article.publishedAt && (
                              <span className="text-[9px] text-slate-600">
                                {new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                              </span>
                            )}
                            {article.topics?.slice(0,2).map(t => (
                              <span key={t} className="text-[8px] px-1.5 py-0.5 rounded-full bg-slate-700/60 text-slate-400 border border-slate-600/50 uppercase font-bold tracking-wide">{t}</span>
                            ))}
                          </div>
                          {article.url && !article.url.includes('gentrack.app/synthetic') ? (
                            <a
                              href={article.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="text-sm font-bold text-slate-100 hover:text-blue-400 leading-snug mb-1 flex items-center gap-1.5 group/link"
                            >
                              {article.title}
                              <svg className="w-3 h-3 shrink-0 opacity-50 group-hover/link:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                            </a>
                          ) : (
                            <div className="text-sm font-bold text-slate-100 leading-snug mb-1">{article.title}</div>
                          )}
                          {expandedArticleId === article.id && article.description ? (
                            <p className="text-xs text-slate-300 mt-2 leading-relaxed whitespace-pre-wrap">{article.description}</p>
                          ) : article.description ? (
                            <p className="text-xs text-slate-400 line-clamp-2">{article.description}</p>
                          ) : null}
                          {expandedArticleId === article.id && article.url && !article.url.includes('gentrack.app/synthetic') && (
                            <a
                              href={article.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-lg text-[10px] font-bold bg-blue-600/20 border border-blue-500/30 text-blue-400 hover:bg-blue-600/40 hover:text-blue-300 transition-all"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                              Open Article
                            </a>
                          )}
                        </div>
                        <div className="flex-shrink-0 flex flex-col items-end gap-1">
                          <span className="text-[9px] font-black px-2 py-1 rounded-lg bg-indigo-900/40 border border-indigo-700/40 text-indigo-300 whitespace-nowrap">
                            {((article.similarity ?? 0) * 100).toFixed(0)}% match
                          </span>
                          {article.sentimentLabel && (
                            <span className={`text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-wide ${
                              article.sentimentLabel === 'negative' ? 'bg-red-500/10 text-red-400' :
                              article.sentimentLabel === 'positive' ? 'bg-emerald-500/10 text-emerald-400' :
                              'bg-slate-700/40 text-slate-500'
                            }`}>{article.sentimentLabel}</span>
                          )}
                          <svg className={`w-3 h-3 text-slate-600 transition-transform ${expandedArticleId === article.id ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ── Historical Intelligence Section ───────────────────────── */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="bg-emerald-700 p-2.5 rounded-xl shadow-lg shadow-emerald-900/20">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white tracking-tight">Historical Intelligence</h2>
                    <p className="text-xs text-slate-500 font-medium">Stored articles from nightly news pipeline</p>
                  </div>
                </div>
                {/* Risk badge */}
                {newsRating && (
                  <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-black uppercase tracking-widest ${
                    newsRating.newsRiskScore >= 50 ? 'bg-red-500/10 border-red-500/30 text-red-400' :
                    newsRating.newsRiskScore >= 20 ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' :
                    'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  }`}>
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                    Risk: {newsRating.newsRiskScore.toFixed(0)}/100
                  </div>
                )}
              </div>

              {/* Window counts strip */}
              {newsRating && (
                <div className="grid grid-cols-3 gap-3 mb-6">
                  {[['30d', newsRating.articles30d, newsRating.negative30d, newsRating.outage30d],
                    ['90d', newsRating.articles90d, newsRating.negative90d, newsRating.outage90d],
                    ['1yr', newsRating.articles365d, newsRating.negative365d, newsRating.outage365d]
                  ].map(([label, total, neg, outage]) => (
                    <div key={String(label)} className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/50">
                      <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">{label}</div>
                      <div className="text-lg font-black text-white">{String(total)} <span className="text-xs font-normal text-slate-400">articles</span></div>
                      <div className="flex gap-3 mt-1">
                        <span className="text-[10px] font-bold text-red-400">{String(neg)} neg</span>
                        <span className="text-[10px] font-bold text-amber-400">{String(outage)} outage</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Topic filter pills + time window selector */}
              {intelFetched && newsArticles.length > 0 && (
                <div className="flex items-center gap-2 mb-5 flex-wrap">
                  {['all','outage','regulatory','financial','weather','construction'].map(t => (
                    <button
                      key={t}
                      onClick={() => setIntelTopicFilter(t)}
                      className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border transition-all ${
                        intelTopicFilter === t
                          ? 'bg-emerald-600 border-emerald-500 text-white'
                          : 'bg-slate-800/40 border-slate-700/50 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                  <div className="ml-auto flex gap-1">
                    {[30, 90, 365, 9999].map(d => (
                      <button
                        key={d}
                        onClick={() => {
                          setIntelDaysBack(d);
                          setIntelFetched(false);
                          setNewsArticles([]);
                          setNewsRating(null);
                          setLoadingIntel(true);
                          Promise.all([
                            fetchPlantNewsArticles(plant.eiaPlantCode, { daysBack: d }),
                            fetchPlantNewsRating(plant.eiaPlantCode),
                          ]).then(([arts, rat]) => {
                            setNewsArticles(arts); setNewsRating(rat);
                            setLoadingIntel(false); setIntelFetched(true);
                          });
                        }}
                        className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all ${
                          intelDaysBack === d
                            ? 'bg-slate-700 border-slate-500 text-white'
                            : 'bg-slate-800/40 border-slate-700/50 text-slate-500 hover:text-slate-300'
                        }`}
                      >{d === 9999 ? 'All' : d === 365 ? '1yr' : `${d}d`}</button>
                    ))}
                  </div>
                </div>
              )}

              {/* Loading */}
              {loadingIntel && (
                <div className="py-14 flex flex-col items-center justify-center space-y-4">
                  <div className="w-10 h-10 rounded-full border-2 border-emerald-500/20 border-t-emerald-500 animate-spin"></div>
                  <p className="text-slate-400 text-xs font-bold">Loading historical articles...</p>
                </div>
              )}

              {/* Empty / not yet ingested */}
              {intelFetched && !loadingIntel && newsArticles.length === 0 && !newsRating && (
                <div className="py-12 text-center text-slate-600 bg-slate-800/10 rounded-2xl border border-dashed border-slate-800">
                  <svg className="w-8 h-8 mx-auto mb-3 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2" /></svg>
                  <p className="text-xs font-bold italic">No historical articles yet — the nightly pipeline hasn't run or no news matched this plant.</p>
                </div>
              )}

              {/* Article list */}
              {intelFetched && !loadingIntel && newsArticles.length > 0 && (() => {
                const filtered = intelTopicFilter === 'all'
                  ? newsArticles
                  : newsArticles.filter(a => a.topics?.includes(intelTopicFilter));

                const TOPIC_COLORS: Record<string, string> = {
                  outage: 'text-red-400 bg-red-500/10 border-red-500/20',
                  regulatory: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
                  financial: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
                  weather: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
                  construction: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
                  other: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
                };

                return (
                  <div className="space-y-3">
                    {filtered.length === 0 && (
                      <p className="text-center text-xs text-slate-600 py-8 italic">No {intelTopicFilter} articles in this window.</p>
                    )}
                    {filtered.map(article => (
                      <div
                        key={article.id}
                        onClick={() => setExpandedArticleId(expandedArticleId === article.id ? null : article.id)}
                        className={`flex flex-col p-4 rounded-xl border transition-all group cursor-pointer ${
                          article.sentimentLabel === 'negative'
                            ? 'bg-red-950/10 border-red-900/30 hover:border-red-600/40'
                            : article.sentimentLabel === 'positive'
                            ? 'bg-emerald-950/10 border-emerald-900/30 hover:border-emerald-600/40'
                            : 'bg-slate-800/20 border-slate-700/40 hover:border-slate-600/60'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="flex-1">
                            {article.url && !article.url.includes('gentrack.app/synthetic') ? (
                              <a
                                href={article.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="text-sm font-bold text-slate-200 hover:text-blue-400 line-clamp-2 leading-snug flex items-center gap-1.5 group/link"
                              >
                                {article.title}
                                <svg className="w-3 h-3 shrink-0 opacity-50 group-hover/link:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                              </a>
                            ) : (
                              <div className="text-sm font-bold text-slate-200 group-hover:text-white line-clamp-2 leading-snug">{article.title}</div>
                            )}
                            {expandedArticleId === article.id && article.description ? (
                              <div className="text-xs text-slate-300 mt-2 leading-relaxed whitespace-pre-wrap">{article.description}</div>
                            ) : article.description ? (
                              <div className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">{article.description}</div>
                            ) : null}
                          </div>
                          <svg className={`w-4 h-4 shrink-0 text-slate-600 group-hover:text-slate-400 transition-all mt-0.5 ${expandedArticleId === article.id ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          {article.sourceName && (
                            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">{article.sourceName}</span>
                          )}
                          <span className="text-[9px] text-slate-600">•</span>
                          <span className="text-[9px] text-slate-600">
                            {article.publishedAt ? new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'Date unknown'}
                          </span>
                          {(article.topics ?? []).map(t => (
                            <span key={t} className={`text-[9px] px-1.5 py-0.5 rounded border font-bold uppercase tracking-widest ${TOPIC_COLORS[t] ?? TOPIC_COLORS.other}`}>{t}</span>
                          ))}
                          {article.sentimentLabel === 'negative' && (
                            <span className="ml-auto text-[9px] font-black text-red-400 uppercase tracking-widest">◼ Negative</span>
                          )}
                          {article.sentimentLabel === 'positive' && (
                            <span className="ml-auto text-[9px] font-black text-emerald-400 uppercase tracking-widest">◼ Positive</span>
                          )}
                        </div>
                        {expandedArticleId === article.id && (
                          <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-slate-700/30">
                            <div className="flex items-center gap-3 flex-wrap">
                              {article.eventType && (
                                <span className="text-[9px] px-2 py-0.5 rounded bg-violet-500/10 border border-violet-500/20 text-violet-400 font-bold uppercase tracking-widest">{article.eventType}</span>
                              )}
                              {article.importance && (
                                <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-widest ${
                                  article.importance === 'high' ? 'bg-red-500/10 border border-red-500/20 text-red-400' :
                                  article.importance === 'medium' ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400' :
                                  'bg-slate-500/10 border border-slate-500/20 text-slate-400'
                                }`}>{article.importance} importance</span>
                              )}
                              {(article.impactTags ?? []).slice(0, 3).map(tag => (
                                <span key={tag} className="text-[8px] px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-400 border border-slate-600/30 font-bold">{tag}</span>
                              ))}
                            </div>
                            {article.url && !article.url.includes('gentrack.app/synthetic') && (
                              <a
                                href={article.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold bg-blue-600/20 border border-blue-500/30 text-blue-400 hover:bg-blue-600/40 hover:text-blue-300 transition-all"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                                Open Article
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

export default PlantDetailView;
