
import React, { useEffect, useState } from 'react';
import { PowerPlant, CapacityFactorStats, FuelSource, NewsAnalysis, PlantOwner } from '../types';
import { COLORS, TYPICAL_CAPACITY_FACTORS } from '../constants';
import CapacityChart from './CapacityChart';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine, AreaChart, Area } from 'recharts';
import { getPlantNews } from '../services/geminiService';

interface Props {
  plant: PowerPlant;
  stats: CapacityFactorStats;
  regionalAvg: number;
  subRegionalAvg: number;
  regionalTrend: { month: string; factor: number }[];
  isWatched: boolean;
  onToggleWatch: (e: React.MouseEvent) => void;
  onBack: () => void;
}

type DetailTab = 'overview' | 'monthly' | 'generation' | 'news';

const PlantDetailView: React.FC<Props> = ({ 
  plant, 
  stats, 
  regionalAvg, 
  subRegionalAvg, 
  regionalTrend, 
  isWatched,
  onToggleWatch,
  onBack 
}) => {
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [news, setNews] = useState<NewsAnalysis | null>(null);
  const [loadingNews, setLoadingNews] = useState(false);
  const [newsFetched, setNewsFetched] = useState(false);

  // Only fetch news the first time the news tab is opened
  useEffect(() => {
    if (activeTab !== 'news' || newsFetched) return;
    const fetchNews = async () => {
      setLoadingNews(true);
      const data = await getPlantNews(plant);
      setNews(data);
      setLoadingNews(false);
      setNewsFetched(true);
    };
    fetchNews();
  }, [activeTab, plant, newsFetched]);

  const diffFromRegAvg = stats.ttmAverage - regionalAvg;
  const diffFromSubAvg = stats.ttmAverage - subRegionalAvg;

  const comparisonData = [
    { name: 'This Plant', value: Math.round(stats.ttmAverage * 100), color: COLORS[plant.fuelSource] },
    { name: 'Sub-Region Avg', value: Math.round(subRegionalAvg * 100), color: '#3b82f6' },
    { name: 'ISO/RTO Avg', value: Math.round(regionalAvg * 100), color: '#6366f1' },
    { name: 'National Typical', value: Math.round(TYPICAL_CAPACITY_FACTORS[plant.fuelSource] * 100), color: '#334155' },
  ];

  // Prepare focused TTM data for the overview spark-graph
  const ttmTrendData = stats.monthlyFactors.slice(-12).map(f => {
    const regionalPoint = regionalTrend?.find(rt => rt.month === f.month);
    return {
      month: f.month.split('-')[1],
      factor: f.factor !== null ? Math.round(f.factor * 100) : null,
      regionalFactor: regionalPoint ? Math.round(regionalPoint.factor * 100) : null
    };
  });

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
            EIA Plant Code: <span className="text-slate-300 font-bold">{plant.eiaPlantCode}</span> • ID: {plant.id}
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
          onClick={() => setActiveTab('news')}
          className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === 'news' ? 'bg-slate-800 text-white shadow-lg shadow-black/20' : 'text-slate-500 hover:text-slate-300'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10l4 4v10a2 2 0 01-2 2zM14 4v4h4" /></svg>
          NEWS & INTELLIGENCE
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1">
        {activeTab === 'overview' && (
          <div className="space-y-8 animate-in fade-in duration-500">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col justify-center items-center text-center shadow-lg relative overflow-hidden group">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-blue-500/20 to-transparent"></div>
                <div className="text-[10px] uppercase font-bold text-slate-500 mb-2 tracking-widest">TTM Capacity Factor</div>
                <div className="text-6xl font-black mb-2 transition-transform group-hover:scale-110 duration-300" style={{ color: stats.isLikelyCurtailed ? COLORS.curtailed : COLORS[plant.fuelSource] }}>
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
                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Trailing 12 Month Trend</h3>
                    <p className="text-[10px] text-slate-600 font-bold">Performance Stability vs Regional Market</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[plant.fuelSource] }}></div>
                      <span className="text-[10px] text-slate-500 font-bold uppercase">Asset</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-slate-700"></div>
                      <span className="text-[10px] text-slate-500 font-bold uppercase">Market Avg</span>
                    </div>
                  </div>
                </div>
                <div className="h-40 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={ttmTrendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorFactor" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={COLORS[plant.fuelSource]} stopOpacity={0.3}/>
                          <stop offset="95%" stopColor={COLORS[plant.fuelSource]} stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="month" hide />
                      <YAxis stroke="#475569" fontSize={10} domain={[0, 100]} tickLine={false} axisLine={false} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '10px' }}
                      />
                      <Area 
                        type="monotone" 
                        dataKey="regionalFactor" 
                        stroke="#475569" 
                        fill="transparent" 
                        strokeWidth={1} 
                        strokeDasharray="5 5" 
                        dot={false}
                      />
                      <Area 
                        type="monotone" 
                        dataKey="factor" 
                        stroke={COLORS[plant.fuelSource]} 
                        fillOpacity={1} 
                        fill="url(#colorFactor)" 
                        strokeWidth={2}
                      />
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
                  <div className={`text-2xl font-black ${stats.curtailmentScore > 50 ? 'text-red-500' : 'text-slate-200'}`}>{stats.curtailmentScore}<span className="text-xs opacity-40">/100</span></div>
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
          const genData = plant.generationHistory.map(g => ({
            name: g.month.split('-')[1] + '/' + g.month.split('-')[0].slice(2),
            mwh: g.mwh,
          }));
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
                        interval="preserveStartEnd"
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
                      {peakMonth ? peakMonth.split('-')[1] + '/' + peakMonth.split('-')[0].slice(2) : ''}
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

        {activeTab === 'news' && (
          <div className="animate-in slide-in-from-right-4 fade-in duration-500 space-y-8">
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-lg">
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                  <div className="bg-indigo-600 p-2.5 rounded-xl shadow-lg shadow-indigo-900/20">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white tracking-tight">AI Intelligence Summary</h2>
                    <p className="text-xs text-slate-500 font-medium">Recent operational news and market context</p>
                  </div>
                </div>
                <div className="text-[10px] font-black text-indigo-500 uppercase tracking-[0.2em] bg-indigo-500/10 px-3 py-1.5 rounded-lg border border-indigo-500/20">Powered by Perplexity</div>
              </div>

              {loadingNews ? (
                <div className="py-20 flex flex-col items-center justify-center space-y-6">
                  <div className="relative">
                    <div className="w-12 h-12 rounded-full border-2 border-indigo-500/20 border-t-indigo-500 animate-spin"></div>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse"></div>
                    </div>
                  </div>
                  <div className="text-center">
                    <p className="text-slate-400 font-bold text-sm">Searching for updates on {plant.name}...</p>
                    <p className="text-xs text-slate-600 mt-1">Fetching maintenance logs and regional curtailment reports</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-8">
                  <div className="bg-indigo-900/10 p-6 rounded-2xl border border-indigo-500/20 relative overflow-hidden group">
                    <div className="absolute top-0 right-0 p-4 opacity-5 transition-opacity group-hover:opacity-10">
                      <svg className="w-24 h-24" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                    </div>
                    <h4 className="text-[10px] font-black text-indigo-400 uppercase mb-3 tracking-widest">Gemini Analysis</h4>
                    <p className="text-slate-200 text-sm leading-relaxed font-medium relative z-10">
                      {news?.summary}
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {news && news.items.length > 0 ? (
                      news.items.map((item, idx) => (
                        <a 
                          key={idx}
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex flex-col p-5 bg-slate-800/30 border border-slate-700/50 rounded-2xl hover:bg-slate-800/60 hover:border-indigo-500/50 transition-all group shadow-sm hover:shadow-indigo-500/5"
                        >
                          <div className="flex justify-between items-start mb-2">
                            <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">{item.source}</span>
                            <svg className="w-4 h-4 text-slate-600 group-hover:text-indigo-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                          </div>
                          <div className="text-sm font-bold text-slate-200 group-hover:text-white line-clamp-2 leading-snug">{item.title}</div>
                        </a>
                      ))
                    ) : (
                      <div className="col-span-full text-center py-10 text-slate-600 bg-slate-800/10 rounded-2xl border border-dashed border-slate-800">
                        <p className="text-xs font-bold italic">No specific news articles indexed for this plant recently.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

export default PlantDetailView;
