import React, { useState, useEffect, useMemo } from 'react';
import { PowerPlant, Region, FuelSource, CapacityFactorStats, AnalysisResult } from './types';
import { REGIONS, FUEL_SOURCES, COLORS, SUBREGIONS } from './constants';
import { fetchPowerPlants, fetchGenerationHistory, fetchRegionalTrend, fetchSubRegionalTrend, calculateCapacityFactorStats, getDataTimestamp } from './services/dataService';
import { getGeminiInsights } from './services/geminiService';
import CapacityChart from './components/CapacityChart';
import RegionalComparison from './components/RegionalComparison';
import PlantDetailView from './components/PlantDetailView';
import FilterControls from './components/FilterControls';

type View = 'dashboard' | 'detail';
type Tab = 'Overview' | 'Watchlist' | Region;
type SortKey = 'name' | 'capacity' | 'curtailment' | 'factor';

const App: React.FC = () => {
  const [plants, setPlants] = useState<PowerPlant[]>([]);
  const [statsMap, setStatsMap] = useState<Record<string, CapacityFactorStats>>({});
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [insights, setInsights] = useState<AnalysisResult | null>(null);

  // Persistence for Watchlist
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    const saved = localStorage.getItem('plant_watchlist');
    return saved ? JSON.parse(saved) : [];
  });

  // View & Tab State
  const [view, setView] = useState<View>('dashboard');
  const [activeTab, setActiveTab] = useState<Tab>('Overview');

  // Filters
  const [selectedFuels, setSelectedFuels] = useState<FuelSource[]>(FUEL_SOURCES);
  const [selectedOwners, setSelectedOwners] = useState<string[]>([]);
  const [selectedSubRegions, setSelectedSubRegions] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [dataGapThreshold, setDataGapThreshold] = useState<number | null>(null);
  const [minCurtailmentLag, setMinCurtailmentLag] = useState<number>(0);
  const [maxCFThreshold, setMaxCFThreshold] = useState<number | null>(null);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 50;
  
  // Sorting State
  const [sortKey, setSortKey] = useState<SortKey>('curtailment');
  const [sortDesc, setSortDesc] = useState(true);
  
  // Selection
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  const [generationLoading, setGenerationLoading] = useState(false);
  const [regionalTrend, setRegionalTrend] = useState<{ month: string; factor: number }[]>([]);
  const [subRegionalTrend, setSubRegionalTrend] = useState<{ month: string; factor: number }[]>([]);

  // Handle row click to view plant details
  const handlePlantClick = async (id: string) => {
    setSelectedPlantId(id);
    setView('detail');
    setGenerationLoading(true);
    setRegionalTrend([]);
    setSubRegionalTrend([]);
    try {
      const plant = plants.find(p => p.id === id);
      if (!plant) return;
      // Use allSettled so a failing RPC (regional/subregional trend) does NOT
      // block the generation history update — the chart must always render.
      const [histResult, regResult, subRegResult] = await Promise.allSettled([
        fetchGenerationHistory(id),
        fetchRegionalTrend(plant.region, plant.fuelSource),
        fetchSubRegionalTrend(plant.region, plant.subRegion, plant.fuelSource),
      ]);

      const history = histResult.status === 'fulfilled' ? histResult.value : [];
      const regTrend = regResult.status === 'fulfilled' ? regResult.value : [];
      const subRegTrend = subRegResult.status === 'fulfilled' ? subRegResult.value : [];

      if (histResult.status === 'rejected') console.error('[GenTrack] Generation history fetch failed:', histResult.reason);
      if (regResult.status === 'rejected') console.warn('[GenTrack] Regional trend fetch failed:', regResult.reason);
      if (subRegResult.status === 'rejected') console.warn('[GenTrack] Sub-regional trend fetch failed:', subRegResult.reason);

      const updatedPlant = { ...plant, generationHistory: history };
      setPlants(prev => prev.map(p => p.id === id ? updatedPlant : p));
      const regAvgMap = regTrend.length > 0
        ? new Map<string, number>(regTrend.map(r => [r.month, r.factor]))
        : undefined;
      setStatsMap(prev => ({ ...prev, [id]: calculateCapacityFactorStats(updatedPlant, regAvgMap) }));
      setRegionalTrend(regTrend);
      setSubRegionalTrend(subRegTrend);
    } catch (err) {
      console.error('[GenTrack] Failed to load plant detail data:', err);
    } finally {
      setGenerationLoading(false);
    }
  };

  useEffect(() => {
    localStorage.setItem('plant_watchlist', JSON.stringify(watchlist));
  }, [watchlist]);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      const { plants: data, statsMap: stats } = await fetchPowerPlants();
      setPlants(data);
      setStatsMap(stats);
      const uniqueOwners = [...new Set(data.map(p => p.owner))].sort();
      setSelectedOwners(uniqueOwners);
      setLoading(false);
    };
    init();
  }, []);

  // When changing tabs, handle sub-region filters carefully
  useEffect(() => {
    if (activeTab === 'Overview' || activeTab === 'Watchlist') {
      setSelectedSubRegions([]);
    } else if (REGIONS.includes(activeTab as Region)) {
      setSelectedSubRegions(SUBREGIONS[activeTab as Region]);
    }
  }, [activeTab]);

  const filteredPlants = useMemo(() => {
    let result = plants.filter(p => {
      // Tab/Region Match
      const regionMatch = activeTab === 'Overview' ? true : 
                         activeTab === 'Watchlist' ? watchlist.includes(p.id) :
                         p.region === activeTab;
      
      // Sub-Region Match (only if in a specific region tab)
      const subRegionMatch = (activeTab !== 'Overview' && activeTab !== 'Watchlist' && selectedSubRegions.length > 0)
        ? selectedSubRegions.includes(p.subRegion)
        : true;

      const fuelMatch = selectedFuels.includes(p.fuelSource);
      const searchMatch = 
        p.name.toLowerCase().includes(search.toLowerCase()) || 
        p.id.toLowerCase().includes(search.toLowerCase()) ||
        p.eiaPlantCode.toLowerCase().includes(search.toLowerCase()) ||
        p.owner.toLowerCase().includes(search.toLowerCase()) ||
        p.location?.state?.toLowerCase().includes(search.toLowerCase()) ||
        p.county?.toLowerCase().includes(search.toLowerCase());
      const stats = statsMap[p.id];
      const gapMatch = dataGapThreshold === null
        ? true
        : (stats?.trailingZeroMonths ?? 0) < dataGapThreshold;
      const lagMatch = minCurtailmentLag === 0
        ? true
        : (stats?.isLikelyCurtailed && (stats?.curtailmentScore ?? 0) >= minCurtailmentLag);
      const cfMatch = maxCFThreshold === null
        ? true
        : (stats?.ttmAverage ?? 0) * 100 <= maxCFThreshold;
      
      return regionMatch && subRegionMatch && fuelMatch && searchMatch && gapMatch && lagMatch && cfMatch;
    });

    result.sort((a, b) => {
      let comparison = 0;
      const statsA = statsMap[a.id];
      const statsB = statsMap[b.id];
      switch (sortKey) {
        case 'curtailment': comparison = (statsA?.curtailmentScore || 0) - (statsB?.curtailmentScore || 0); break;
        case 'factor': comparison = (statsA?.ttmAverage || 0) - (statsB?.ttmAverage || 0); break;
        case 'capacity': comparison = a.nameplateCapacityMW - b.nameplateCapacityMW; break;
        case 'name': comparison = a.name.localeCompare(b.name); break;
      }
      return sortDesc ? -comparison : comparison;
    });

    return result;
  }, [plants, activeTab, selectedSubRegions, selectedFuels, search, dataGapThreshold, minCurtailmentLag, maxCFThreshold, statsMap, sortKey, sortDesc, watchlist]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, selectedFuels, selectedSubRegions, search, dataGapThreshold, minCurtailmentLag, maxCFThreshold, sortKey, sortDesc]);

  // Paginated slice
  const totalPages = Math.max(1, Math.ceil(filteredPlants.length / PAGE_SIZE));
  const paginatedPlants = filteredPlants.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Dynamic owners list extracted from loaded data
  const allOwners = useMemo(() => [...new Set(plants.map(p => p.owner))].sort(), [plants]);

  // Watchlist specific stats for the summary bar
  const watchlistStats = useMemo(() => {
    const watchedPlants = plants.filter(p => watchlist.includes(p.id));
    if (watchedPlants.length === 0) return null;
    
    const totalCapacity = watchedPlants.reduce((acc, p) => acc + p.nameplateCapacityMW, 0);
    const avgFactor = watchedPlants.reduce((acc, p) => acc + (statsMap[p.id]?.ttmAverage || 0), 0) / watchedPlants.length;
    const curtailedCount = watchedPlants.filter(p => statsMap[p.id]?.isLikelyCurtailed).length;
    
    return { totalCapacity, avgFactor, curtailedCount, count: watchedPlants.length };
  }, [plants, watchlist, statsMap]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDesc(!sortDesc);
    else { setSortKey(key); setSortDesc(true); }
  };

  const toggleWatch = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setWatchlist(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  const handleGenerateInsights = async () => {
    if (filteredPlants.length === 0) return;
    setAnalyzing(true);
    const result = await getGeminiInsights(filteredPlants.slice(0, 50), statsMap);
    setInsights(result);
    setAnalyzing(false);
  };

  const selectedPlant = useMemo(() => plants.find(p => p.id === selectedPlantId) || null, [plants, selectedPlantId]);

  const regionalAvgFactor = useMemo(() => {
    const ttm = regionalTrend.slice(-12);
    return ttm.length > 0 ? ttm.reduce((acc, curr) => acc + curr.factor, 0) / ttm.length : 0;
  }, [regionalTrend]);

  const subRegionalAvgFactor = useMemo(() => {
    const ttm = subRegionalTrend.slice(-12);
    return ttm.length > 0 ? ttm.reduce((acc, curr) => acc + curr.factor, 0) / ttm.length : 0;
  }, [subRegionalTrend]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-slate-400 font-medium tracking-tight">Loading GenTrack Analytics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950 text-slate-200">
      <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col h-full shadow-2xl z-10">
        <div className="p-6 border-b border-slate-800">
          <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
            <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse"></div>
            GENTRACK
          </h2>
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">Power Plant Analytics</p>
        </div>
        
        <nav className="flex-1 overflow-y-auto p-4 space-y-1 custom-scrollbar">
          <button
            onClick={() => { setActiveTab('Overview'); setView('dashboard'); }}
            className={`w-full text-left px-4 py-3 rounded-xl transition-all duration-200 flex items-center gap-3 ${
              activeTab === 'Overview' && view === 'dashboard'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' 
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
            <span className="text-sm font-semibold tracking-wide">National Overview</span>
          </button>

          <button
            onClick={() => { setActiveTab('Watchlist'); setView('dashboard'); }}
            className={`w-full text-left px-4 py-3 rounded-xl transition-all duration-200 flex items-center gap-3 ${
              activeTab === 'Watchlist' && view === 'dashboard'
                ? 'bg-amber-600 text-white shadow-lg shadow-amber-900/20' 
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <svg className="w-5 h-5" fill={activeTab === 'Watchlist' ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.382-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
            <span className="text-sm font-semibold tracking-wide flex-1">Watch List</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${activeTab === 'Watchlist' ? 'bg-amber-900/40 text-amber-100' : 'bg-slate-800 text-slate-500'}`}>{watchlist.length}</span>
          </button>
          
          <div className="pt-6 pb-2 px-4">
            <span className="text-[10px] font-bold text-slate-600 uppercase tracking-[0.2em]">ISO / RTO SECTORS</span>
          </div>

          <div className="pt-4 pb-2 px-4">
            <span className="text-[10px] font-bold text-slate-600 uppercase tracking-[0.2em]">Data Source</span>
            <p className="text-[10px] text-slate-500 mt-1">
              {getDataTimestamp()
                ? `EIA • ${new Date(getDataTimestamp()!).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
                : 'Built-in dataset'}
            </p>
          </div>

          {REGIONS.map(region => (
            <button
              key={region}
              onClick={() => { setActiveTab(region); setView('dashboard'); }}
              className={`w-full text-left px-4 py-2.5 rounded-xl transition-all duration-200 flex items-center justify-between group ${
                activeTab === region && view === 'dashboard'
                  ? 'bg-slate-800 text-blue-400 border border-slate-700' 
                  : 'text-slate-500 hover:bg-slate-800/50 hover:text-slate-300'
              }`}
            >
              <span className={`text-sm font-medium ${activeTab === region ? 'font-bold' : ''}`}>{region}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${activeTab === region ? 'bg-blue-900/40 text-blue-400' : 'bg-slate-800 text-slate-600 group-hover:text-slate-400'}`}>
                {plants.filter(p => p.region === region).length}
              </span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex-1 overflow-y-auto bg-slate-950 p-8 custom-scrollbar relative">
        {view === 'dashboard' ? (
          <>
            <header className="flex justify-between items-start mb-8">
              <div>
                <h1 className="text-4xl font-black text-white mb-2 tracking-tight">
                  {activeTab === 'Overview' ? 'National Grid Matrix' : activeTab === 'Watchlist' ? 'Monitored Assets' : `${activeTab} Performance`}
                </h1>
                <p className="text-slate-400 font-medium max-w-xl leading-relaxed">
                  {activeTab === 'Watchlist' 
                    ? `Tracking ${watchlist.length} specific assets across jurisdictions. Monitoring for performance drift.`
                    : `Analyzing ${filteredPlants.length} active power stations. Benchmarking TTM capacity factors vs design capacity.`
                  }
                </p>
              </div>
              <button 
                onClick={handleGenerateInsights}
                disabled={analyzing}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-blue-900/20 transition-all flex items-center gap-2 border border-blue-400/20"
              >
                {analyzing ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white"></div> : <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
                AI ANALYTICS
              </button>
            </header>

            <FilterControls 
              activeRegion={activeTab}
              selectedFuels={selectedFuels}
              setSelectedFuels={setSelectedFuels}
              selectedSubRegions={selectedSubRegions}
              setSelectedSubRegions={setSelectedSubRegions}
              search={search}
              setSearch={setSearch}
              dataGapThreshold={dataGapThreshold}
              setDataGapThreshold={setDataGapThreshold}
              minCurtailmentLag={minCurtailmentLag}
              setMinCurtailmentLag={setMinCurtailmentLag}
              maxCFThreshold={maxCFThreshold}
              setMaxCFThreshold={setMaxCFThreshold}
            />

            {/* Overview Summary */}
            {activeTab === 'Overview' && (
              <RegionalComparison plants={plants} statsMap={statsMap} selectedFuels={selectedFuels} />
            )}

            {/* Watchlist Summary Bar (Mirroring Overview table layout) */}
            {activeTab === 'Watchlist' && watchlistStats && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8 animate-in fade-in slide-in-from-top-4 duration-500">
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg">
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Portfolio Size</div>
                  <div className="text-2xl font-black text-white">{watchlistStats.count} <span className="text-xs text-slate-600">Assets</span></div>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg">
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Total Monitored Capacity</div>
                  <div className="text-2xl font-black text-blue-400">{Math.round(watchlistStats.totalCapacity).toLocaleString()} <span className="text-xs text-slate-600">MW</span></div>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg">
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Portfolio Avg TTM</div>
                  <div className="text-2xl font-black text-indigo-400">{(watchlistStats.avgFactor * 100).toFixed(1)}%</div>
                </div>
                <div className={`bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg ${watchlistStats.curtailedCount > 0 ? 'border-red-500/30' : ''}`}>
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Risk Alerts</div>
                  <div className={`text-2xl font-black ${watchlistStats.curtailedCount > 0 ? 'text-red-500' : 'text-green-500'}`}>
                    {watchlistStats.curtailedCount} <span className="text-xs opacity-50">CURTAILED</span>
                  </div>
                </div>
              </div>
            )}

            {insights && (
              <section className="mb-8 bg-indigo-950/20 border border-indigo-500/30 rounded-2xl p-6 backdrop-blur-md">
                <div className="flex items-center gap-3 mb-4">
                  <div className="bg-indigo-600 p-2 rounded-lg shadow-lg">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                  </div>
                  <h2 className="text-xl font-bold text-white tracking-tight">AI Generated Insights for {activeTab}</h2>
                </div>
                <p className="text-slate-300 leading-relaxed mb-6 italic">"{insights.summary}"</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                    <h3 className="text-[10px] font-bold text-slate-500 uppercase mb-3 tracking-widest">Anomalies</h3>
                    <ul className="space-y-3">{insights.outliers.map((o, i) => <li key={i} className="flex items-start gap-3 text-sm text-slate-300"><span className="text-red-500">●</span> {o}</li>)}</ul>
                  </div>
                  <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                    <h3 className="text-[10px] font-bold text-slate-500 uppercase mb-3 tracking-widest">Optimizations</h3>
                    <ul className="space-y-3">{insights.recommendations.map((r, i) => <li key={i} className="flex items-start gap-3 text-sm text-slate-300"><span className="text-blue-500">▶</span> {r}</li>)}</ul>
                  </div>
                </div>
              </section>
            )}

            {/* Asset Table - Consistently rendered for all tabs */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative z-0">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                      <th className="px-6 py-5 cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('name')}>Plant Name {sortKey === 'name' && (sortDesc ? '↓' : '↑')}</th>
                      <th className="px-6 py-5">Operator</th>
                      <th className="px-6 py-5">Region & Zone</th>
                      <th className="px-6 py-5">Fuel</th>
                      <th className="px-6 py-5 text-right cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('capacity')}>Capacity (MW) {sortKey === 'capacity' && (sortDesc ? '↓' : '↑')}</th>
                      <th className="px-6 py-5 text-right cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('factor')}>TTM Factor {sortKey === 'factor' && (sortDesc ? '↓' : '↑')}</th>
                      <th className="px-6 py-5 text-center cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('curtailment')}>Grid Status {sortKey === 'curtailment' && (sortDesc ? '↓' : '↑')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {paginatedPlants.map(plant => {
                      const stats = statsMap[plant.id];
                      const isWatched = watchlist.includes(plant.id);
                      return (
                        <tr key={plant.id} onClick={() => handlePlantClick(plant.id)} className="cursor-pointer transition-all hover:bg-slate-800/60 group">
                          <td className="px-6 py-5">
                            <div className="flex items-start gap-3">
                              <button onClick={(e) => toggleWatch(e, plant.id)} className={`mt-0.5 transition-colors ${isWatched ? 'text-amber-400' : 'text-slate-700 hover:text-slate-500'}`}>
                                <svg className="w-4 h-4" fill={isWatched ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.382-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                              </button>
                              <div>
                                <div className="font-bold text-slate-200 group-hover:text-blue-400 transition-colors text-sm">{plant.name}</div>
                                <div className="text-[10px] text-slate-600 font-mono tracking-tighter">EIA ID: {plant.eiaPlantCode} | {plant.id}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-5"><div className="text-xs font-semibold text-blue-500/80">{plant.owner}</div></td>
                          <td className="px-6 py-5"><div className="flex flex-col"><span className="text-[10px] text-slate-400 font-bold">{plant.region}</span><span className="text-[10px] text-slate-600 font-medium">{plant.subRegion}</span></div></td>
                          <td className="px-6 py-5"><span style={{ color: COLORS[plant.fuelSource], backgroundColor: `${COLORS[plant.fuelSource]}10` }} className="text-[10px] px-2 py-0.5 rounded font-bold border border-current">{plant.fuelSource.toUpperCase()}</span></td>
                          <td className="px-6 py-5 text-right font-mono text-sm text-slate-300">{plant.nameplateCapacityMW.toLocaleString()}</td>
                          <td className="px-6 py-5 text-right">
                            <div className="font-mono text-sm font-bold text-slate-200">{(stats.ttmAverage * 100).toFixed(1)}%</div>
                            <div className="w-full h-1 bg-slate-800 rounded-full mt-2 overflow-hidden max-w-[80px] ml-auto"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(100, stats.ttmAverage * 100)}%`, backgroundColor: stats.isMaintenanceOffline ? '#d97706' : stats.hasNoRecentData ? '#475569' : stats.isLikelyCurtailed ? COLORS.curtailed : COLORS[plant.fuelSource] }} /></div>
                          </td>
                          <td className="px-6 py-5 text-center">
                            {stats.isMaintenanceOffline
                              ? <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-900/30 text-amber-400 border border-amber-500/30">Maintenance</span>
                              : stats.hasNoRecentData
                                ? <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-800 text-slate-500 border border-slate-700">No Data</span>
                                : stats.isLikelyCurtailed
                                  ? <div className="flex flex-col items-center gap-1 scale-90"><span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-red-900/40 text-red-400 border border-red-500/30">Curtailed</span><span className="text-[9px] text-red-500/60 font-mono">Score: {stats.curtailmentScore}</span></div>
                                  : <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-green-900/20 text-green-400/80 border border-green-500/20">Optimal</span>
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filteredPlants.length === 0 && (
                <div className="py-32 text-center text-slate-700 bg-slate-900/20">
                  <p className="font-semibold text-lg">{activeTab === 'Watchlist' ? 'Your Watch List is empty.' : 'No assets match your search.'}</p>
                  <p className="text-sm">{activeTab === 'Watchlist' ? 'Click the star icon next to a plant name in the Overview to track it.' : 'Adjust filters to see more results.'}</p>
                </div>
              )}

              {/* Pagination Controls */}
              {filteredPlants.length > PAGE_SIZE && (
                <div className="flex items-center justify-between px-6 py-4 bg-slate-800/40 border-t border-slate-800">
                  <div className="text-xs text-slate-500">
                    Showing {((currentPage - 1) * PAGE_SIZE) + 1}–{Math.min(currentPage * PAGE_SIZE, filteredPlants.length)} of {filteredPlants.length.toLocaleString()} plants
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage(1)}
                      disabled={currentPage === 1}
                      className="px-2 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
                    >
                      ««
                    </button>
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="px-2 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
                    >
                      ‹ Prev
                    </button>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                        let pageNum: number;
                        if (totalPages <= 7) {
                          pageNum = i + 1;
                        } else if (currentPage <= 4) {
                          pageNum = i + 1;
                        } else if (currentPage >= totalPages - 3) {
                          pageNum = totalPages - 6 + i;
                        } else {
                          pageNum = currentPage - 3 + i;
                        }
                        return (
                          <button
                            key={pageNum}
                            onClick={() => setCurrentPage(pageNum)}
                            className={`w-8 h-8 rounded text-xs font-bold transition-all ${
                              currentPage === pageNum
                                ? 'bg-blue-600 text-white shadow-lg'
                                : 'text-slate-400 hover:text-white hover:bg-slate-700'
                            }`}
                          >
                            {pageNum}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      className="px-2 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
                    >
                      Next ›
                    </button>
                    <button
                      onClick={() => setCurrentPage(totalPages)}
                      disabled={currentPage === totalPages}
                      className="px-2 py-1 rounded text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-700 disabled:opacity-30 disabled:cursor-default transition-all"
                    >
                      »»
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          selectedPlant && <PlantDetailView plant={selectedPlant} stats={statsMap[selectedPlant.id]} regionalAvg={regionalAvgFactor} subRegionalAvg={subRegionalAvgFactor} regionalTrend={regionalTrend} subRegionalTrend={subRegionalTrend} generationLoading={generationLoading} isWatched={watchlist.includes(selectedPlant.id)} onToggleWatch={(e) => toggleWatch(e, selectedPlant.id)} onBack={() => setView('dashboard')} />
        )}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `.custom-scrollbar::-webkit-scrollbar { width: 5px; } .custom-scrollbar::-webkit-scrollbar-track { background: #0f172a; } .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 10px; }` }} />
    </div>
  );
};

export default App;