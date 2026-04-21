import React, { useState, useEffect, useMemo, useRef, useTransition, useCallback } from 'react';
import { PowerPlant, Region, FuelSource, CapacityFactorStats, AnalysisResult } from './types';
import { REGIONS, FUEL_SOURCES, COLORS, SUBREGIONS } from './constants';
import { fetchPowerPlants, fetchGenerationHistory, fetchRegionalTrend, fetchSubRegionalTrend, calculateCapacityFactorStats, getDataTimestamp } from './services/dataService';
import { getGeminiInsights } from './services/geminiService';
import { onAuthStateChange, getProfile, fetchWatchlist, addToWatchlist, removeFromWatchlist, signOut, trackUserActivityEvent, WatchlistEntry, WatchlistEntityType } from './services/authService';
import { supabase } from './services/supabaseClient';
import CapacityChart from './components/CapacityChart';
import RegionalComparison from './components/RegionalComparison';
import PlantDetailView from './components/PlantDetailView';
import CompanyDetailView from './components/CompanyDetailView';
import FilterControls from './components/FilterControls';
import CoverPage from './components/CoverPage';
import AdminPage from './components/AdminPage';
import EntityDetailView from './components/EntityDetailView';
import PlantPursuitsDashboard from './components/PlantPursuitsDashboard';
import LenderPursuitsDashboard from './components/LenderPursuitsDashboard';
import TaxEquityPursuitsDashboard from './components/TaxEquityPursuitsDashboard';
import ArchivedPursuitsDashboard from './components/ArchivedPursuitsDashboard';
import PipelineTourModal from './components/PipelineTourModal';
import WatchlistDashboard from './components/WatchlistDashboard';
import DeveloperListView from './components/DeveloperListView';
import DeveloperDetailView from './components/DeveloperDetailView';
import AssetRegistryDetailView from './components/AssetRegistryDetailView';
import type { DeveloperMapViewport } from './components/DeveloperAssetMap';
import { fetchDevelopers, DeveloperRow } from './services/developerService';

type View = 'dashboard' | 'detail' | 'admin' | 'company' | 'lenders' | 'taxequity' | 'pursuits' | 'entity' | 'developers' | 'developer-detail' | 'asset-detail' | 'archived';
type Tab = 'Overview' | 'Watchlist' | Region;
type SortKey = 'name' | 'capacity' | 'curtailment' | 'factor' | 'data';

const App: React.FC = () => {
  const [plants, setPlants] = useState<PowerPlant[]>([]);
  const [statsMap, setStatsMap] = useState<Record<string, CapacityFactorStats>>({});
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [insights, setInsights] = useState<AnalysisResult | null>(null);

  // Persistence for Watchlist (synced to Supabase when logged in)
  // Multi-entity watchlist
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);

  // Auth state
  const [session, setSession] = useState<any>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // View & Tab State
  const [view, setView] = useState<View>('dashboard');
  const [activeTab, setActiveTab] = useState<Tab>('Overview');

  // Filters
  const [selectedFuels, setSelectedFuels] = useState<FuelSource[]>(FUEL_SOURCES);
  const [selectedOwners, setSelectedOwners] = useState<string[]>([]);
  const [selectedSubRegions, setSelectedSubRegions] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [minCurtailmentLag, setMinCurtailmentLag] = useState<number>(0);
  const [maxCFThreshold, setMaxCFThreshold] = useState<number | null>(null);


  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 50;
  
  // Sorting State
  const [sortKey, setSortKey] = useState<SortKey>('data');
  const [sortDesc, setSortDesc] = useState(true);

  // Plants with confirmed financing parties (lenders_found=true)
  const [confirmedFinancingCodes, setConfirmedFinancingCodes] = useState<Set<string>>(new Set());
  
  // Sidebar
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Pipeline tour
  const [showPipelineTour, setShowPipelineTour] = useState(false);


  // Selection
  const [selectedPlantId, setSelectedPlantId]       = useState<string | null>(null);
  const [selectedUltParent, setSelectedUltParent]   = useState<string | null>(null);
  const [cameFromCompany, setCameFromCompany]       = useState(false);
  const [cameFromPursuits, setCameFromPursuits]     = useState(false);
  const [cameFromEntity, setCameFromEntity]         = useState(false);
  const [cameFromDeveloper, setCameFromDeveloper]   = useState(false);
  const [companyActiveTab, setCompanyActiveTab]     = useState<'overview' | 'portfolio'>('overview');
  const [developerActiveTab, setDeveloperActiveTab] = useState<'overview' | 'portfolio' | 'map' | 'lead'>('overview');
  const [developerMapViewport, setDeveloperMapViewport] = useState<DeveloperMapViewport | null>(null);
  const [selectedEntity, setSelectedEntity]         = useState<{ name: string; type: 'lender' | 'tax_equity' } | null>(null);
  const [selectedDeveloper, setSelectedDeveloper]   = useState<DeveloperRow | null>(null);
  const [selectedAssetId, setSelectedAssetId]       = useState<string | null>(null);
  const [developersList, setDevelopersList]         = useState<DeveloperRow[]>([]);
  const [generationLoading, setGenerationLoading] = useState(false);
  const [regionalTrend, setRegionalTrend] = useState<{ month: string; factor: number }[]>([]);
  const [subRegionalTrend, setSubRegionalTrend] = useState<{ month: string; factor: number }[]>([]);
  const previousViewRef = useRef<View | null>(null);
  const filtersTrackingReadyRef = useRef(false);

  // Developer registry handlers
  const handleDeveloperClick = (developerId: string) => {
    const dev = developersList.find(d => d.id === developerId);
    if (!dev) {
      fetchDevelopers().then(devs => {
        setDevelopersList(devs);
        const found = devs.find(d => d.id === developerId);
        if (found) {
          setSelectedDeveloper(found);
          setDeveloperActiveTab('overview');
          setDeveloperMapViewport(null);
          setView('developer-detail');
        }
      });
    } else {
      setSelectedDeveloper(dev);
      setDeveloperActiveTab('overview');
      setDeveloperMapViewport(null);
      setView('developer-detail');
    }
  };

  const handleAssetRegistryClick = (assetId: string) => {
    setSelectedAssetId(assetId);
    setView('asset-detail');
  };

  const handleLenderClick = (lenderName: string) => {
    setSelectedEntity({ name: lenderName, type: 'lender' });
    setView('entity');
  };

  const handleTaxEquityClick = (investorName: string) => {
    setSelectedEntity({ name: investorName, type: 'tax_equity' });
    setView('entity');
  };

  // Navigate to company detail view
  const handleCompanyClick = (ultParentName: string) => {
    setSelectedUltParent(ultParentName);
    setCompanyActiveTab('overview');
    setView('company');
  };

  // Navigate to plant detail from pursuits tab (by EIA code)
  const handlePlantClickFromPursuits = (eiaPlantCode: string) => {
    const plant = plants.find(p => p.eiaPlantCode === eiaPlantCode);
    if (plant) {
      handlePlantClick(plant.id, 'pursuits');
    }
  };

  // Navigate to plant detail from developer registry (by EIA code)
  const handlePlantClickFromDeveloper = (eiaPlantCode: string) => {
    const plant = plants.find(p => p.eiaPlantCode === eiaPlantCode);
    if (plant) {
      handlePlantClick(plant.id, 'developer');
    }
  };

  // Navigate to plant detail from company portfolio (by EIA code)
  const handlePlantClickFromCompany = (eiaPlantCode: string) => {
    const plant = plants.find(p => p.eiaPlantCode === eiaPlantCode);
    if (plant) {
      handlePlantClick(plant.id, 'company');
    }
  };

  // Navigate to plant detail from lender/tax equity entity detail (by EIA code)
  const handlePlantClickFromEntity = (eiaPlantCode: string) => {
    const plant = plants.find(p => p.eiaPlantCode === eiaPlantCode);
    if (plant) {
      handlePlantClick(plant.id, 'entity');
    }
  };

  // Handle row click to view plant details
  const handlePlantClick = async (id: string, origin: 'dashboard' | 'company' | 'pursuits' | 'entity' | 'developer' = 'dashboard') => {
    setSelectedPlantId(id);
    setView('detail');
    setCameFromCompany(origin === 'company');
    setCameFromPursuits(origin === 'pursuits');
    setCameFromEntity(origin === 'entity');
    setCameFromDeveloper(origin === 'developer');
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

  // Auth: restore session, sync role and watchlist from Supabase
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setAuthLoading(false);
    });
    const sub = onAuthStateChange(async (sess, event) => {
      setSession(sess);
      setAuthLoading(false);
      if (sess) {
        if (event === 'SIGNED_IN') {
          trackUserActivityEvent(sess.user.id, 'app_open', 'login_success').catch(() => {});
        }
        const profile = await getProfile(sess.user.id);
        setUserRole(profile?.role ?? 'user');
        try { const wl = await fetchWatchlist(sess.user.id); setWatchlist(wl); }
        catch { setWatchlist([]); }
      } else {
        setUserRole(null);
        setWatchlist([]);
      }
    });
    return () => sub.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    if (previousViewRef.current === null) {
      previousViewRef.current = view;
      return;
    }
    if (previousViewRef.current === view) return;
    trackUserActivityEvent(session.user.id, 'view_change', 'view_navigation', {
      from: previousViewRef.current,
      to: view,
    }).catch(() => {});
    previousViewRef.current = view;
  }, [view, session]);

  useEffect(() => {
    if (!session || view !== 'dashboard') return;
    if (!filtersTrackingReadyRef.current) {
      filtersTrackingReadyRef.current = true;
      return;
    }
    trackUserActivityEvent(session.user.id, 'filter_search', 'dashboard_filters_updated', {
      activeTab,
      searchLength: search.length,
      selectedFuelCount: selectedFuels.length,
      selectedSubRegionCount: selectedSubRegions.length,
      minCurtailmentLag,
      maxCFThreshold,
    }).catch(() => {});
  }, [session, view, activeTab, search, selectedFuels, selectedSubRegions, minCurtailmentLag, maxCFThreshold]);

  const refreshAllPlantData = useCallback(async () => {
    const { plants: data, statsMap: stats } = await fetchPowerPlants();
    setPlants(data);
    setStatsMap(stats);
    const uniqueOwners = [...new Set(data.map(p => p.owner))].sort();
    setSelectedOwners(uniqueOwners);
  }, []);

  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await refreshAllPlantData();
      setLoading(false);
    };
    init();
  }, [refreshAllPlantData]);

  useEffect(() => {
    supabase
      .from('plant_financing_summary')
      .select('eia_plant_code')
      .eq('lenders_found', true)
      .then(({ data }) => {
        if (data) setConfirmedFinancingCodes(new Set((data as { eia_plant_code: string }[]).map(r => r.eia_plant_code)));
      });
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
             activeTab === 'Watchlist' ? watchlist.some(w => w.entity_type === 'plant' && w.entity_id === p.id) :
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
      const lagMatch = minCurtailmentLag === 0
        ? true
        : (stats?.isLikelyCurtailed && (stats?.curtailmentScore ?? 0) >= minCurtailmentLag);
      const cfMatch = maxCFThreshold === null
        ? true
        : (stats?.ttmAverage ?? 0) * 100 <= maxCFThreshold;

      return regionMatch && subRegionMatch && fuelMatch && searchMatch && lagMatch && cfMatch;
    });

    result.sort((a, b) => {
      // Primary: plants with confirmed financing always float to top
      const aHasFinancing = confirmedFinancingCodes.has(a.eiaPlantCode);
      const bHasFinancing = confirmedFinancingCodes.has(b.eiaPlantCode);
      if (aHasFinancing !== bHasFinancing) return aHasFinancing ? -1 : 1;

      // Secondary: user-selected sort
      let comparison = 0;
      const statsA = statsMap[a.id];
      const statsB = statsMap[b.id];
      switch (sortKey) {
        case 'curtailment': comparison = (statsA?.curtailmentScore || 0) - (statsB?.curtailmentScore || 0); break;
        case 'factor': comparison = (statsA?.ttmAverage || 0) - (statsB?.ttmAverage || 0); break;
        case 'capacity': comparison = a.nameplateCapacityMW - b.nameplateCapacityMW; break;
        case 'name': comparison = a.name.localeCompare(b.name); break;
        case 'data': comparison = (statsA?.dataMonthsCount || 0) - (statsB?.dataMonthsCount || 0); break;
      }
      return sortDesc ? -comparison : comparison;
    });

    return result;
  }, [plants, activeTab, selectedSubRegions, selectedFuels, search, minCurtailmentLag, maxCFThreshold, statsMap, sortKey, sortDesc, watchlist, confirmedFinancingCodes]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, selectedFuels, selectedSubRegions, search, minCurtailmentLag, maxCFThreshold, sortKey, sortDesc]);

  // Paginated slice
  const totalPages = Math.max(1, Math.ceil(filteredPlants.length / PAGE_SIZE));
  const paginatedPlants = filteredPlants.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Dynamic owners list extracted from loaded data
  const allOwners = useMemo(() => [...new Set(plants.map(p => p.owner))].sort(), [plants]);

  // Watchlist specific stats for the summary bar
  const watchlistStats = useMemo(() => {
    const watchedPlants = plants.filter(p => watchlist.some(w => w.entity_type === 'plant' && w.entity_id === p.id));
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

  // Generic toggle for any entity type
  const toggleWatch = (e: React.MouseEvent, entityType: WatchlistEntityType, entityId: string) => {
    e.stopPropagation();
    if (!session) return;
    const userId = session.user.id;
    setWatchlist(prev => {
      const isWatched = prev.some(w => w.entity_type === entityType && w.entity_id === entityId);
      if (isWatched) {
        removeFromWatchlist(userId, entityType, entityId).catch(console.error);
        trackUserActivityEvent(userId, 'watchlist_toggle', `watchlist_remove_${entityType}`, { entityId }).catch(() => {});
        return prev.filter(w => !(w.entity_type === entityType && w.entity_id === entityId));
      } else {
        addToWatchlist(userId, entityType, entityId).catch(console.error);
        trackUserActivityEvent(userId, 'watchlist_toggle', `watchlist_add_${entityType}`, { entityId }).catch(() => {});
        return [...prev, { entity_type: entityType, entity_id: entityId, created_at: new Date().toISOString() }];
      }
    });
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

  if (authLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
      </div>
    );
  }

  if (!session) {
    return <CoverPage />;
  }

  if (userRole === 'blocked') {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 flex-col gap-6 text-center px-6">
        <div className="w-16 h-16 rounded-full bg-red-900/20 border border-red-500/20 flex items-center justify-center">
          <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
        </div>
        <div>
          <h2 className="text-xl font-black text-white mb-2">Account Suspended</h2>
          <p className="text-slate-500 text-sm max-w-sm">Your account has been suspended. Please contact the administrator.</p>
        </div>
        <button onClick={() => signOut()} className="px-6 py-2.5 rounded-xl border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 text-sm font-bold transition-all">
          Sign Out
        </button>
      </div>
    );
  }

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
      <aside className={`${sidebarCollapsed ? 'w-14' : 'w-64'} bg-slate-900 border-r border-slate-800 flex flex-col h-full shadow-2xl z-10 transition-all duration-200 overflow-hidden flex-shrink-0`}>
        <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-2">
          {!sidebarCollapsed && (
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse flex-shrink-0"></div>
                GENTRACK
              </h2>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">Power Plant Analytics</p>
            </div>
          )}
          {sidebarCollapsed && <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse mx-auto" />}
          <div className="flex items-center gap-1 flex-shrink-0">
            {!sidebarCollapsed && (
              <button
                onClick={() => setShowPipelineTour(true)}
                className="p-1.5 rounded-lg text-slate-500 hover:text-blue-400 hover:bg-slate-800 transition-colors"
                title="How the Pursuit Pipeline Works"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            )}
            <button
              onClick={() => setSidebarCollapsed(c => !c)}
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={sidebarCollapsed ? 'M13 5l7 7-7 7M5 5l7 7-7 7' : 'M11 19l-7-7 7-7m8 14l-7-7 7-7'} />
              </svg>
            </button>
          </div>
        </div>
        
        <nav className="flex-1 overflow-y-auto p-4 space-y-1 custom-scrollbar">
          <button
            onClick={() => { setActiveTab('Watchlist'); setView('dashboard'); }}
            title={sidebarCollapsed ? 'Watch List' : undefined}
            className={`w-full text-left rounded-xl transition-all duration-200 flex items-center gap-3 ${sidebarCollapsed ? 'justify-center px-2 py-3' : 'px-4 py-3'} ${
              activeTab === 'Watchlist' && view === 'dashboard'
                ? 'bg-amber-600 text-white shadow-lg shadow-amber-900/20' 
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <svg className="w-5 h-5 flex-shrink-0" fill={activeTab === 'Watchlist' ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.382-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
            {!sidebarCollapsed && <span className="text-sm font-semibold tracking-wide flex-1">Watch List</span>}
            {!sidebarCollapsed && <span className={`text-[10px] px-1.5 py-0.5 rounded ${activeTab === 'Watchlist' ? 'bg-amber-900/40 text-amber-100' : 'bg-slate-800 text-slate-500'}`}>{watchlist.length}</span>}
          </button>
          
          <button
            onClick={() => setView('lenders')}
            title={sidebarCollapsed ? 'Lender Pursuits' : undefined}
            className={`w-full text-left rounded-xl transition-all duration-200 flex items-center gap-3 ${sidebarCollapsed ? 'justify-center px-2 py-3' : 'px-4 py-3'} ${
              view === 'lenders' || (view === 'entity' && selectedEntity?.type === 'lender')
                ? 'bg-cyan-700 text-white shadow-lg shadow-cyan-900/20'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" /></svg>
            {!sidebarCollapsed && <span className="text-sm font-semibold tracking-wide">Lender Pursuits</span>}
          </button>

          <button
            onClick={() => setView('taxequity')}
            title={sidebarCollapsed ? 'Tax Equity Pursuits' : undefined}
            className={`w-full text-left rounded-xl transition-all duration-200 flex items-center gap-3 ${sidebarCollapsed ? 'justify-center px-2 py-3' : 'px-4 py-3'} ${
              view === 'taxequity' || (view === 'entity' && selectedEntity?.type === 'tax_equity')
                ? 'bg-violet-700 text-white shadow-lg shadow-violet-900/20'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {!sidebarCollapsed && <span className="text-sm font-semibold tracking-wide">Tax Equity Pursuits</span>}
          </button>

          <button
            onClick={() => setView('pursuits')}
            title={sidebarCollapsed ? 'Plant Pursuits' : undefined}
            className={`w-full text-left rounded-xl transition-all duration-200 flex items-center gap-3 ${sidebarCollapsed ? 'justify-center px-2 py-3' : 'px-4 py-3'} ${
              view === 'pursuits'
                ? 'bg-emerald-700 text-white shadow-lg shadow-emerald-900/20'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            {!sidebarCollapsed && <span className="text-sm font-semibold tracking-wide">Plant Pursuits</span>}
          </button>

          <button
            onClick={() => setView('archived')}
            title={sidebarCollapsed ? 'Archived Pursuits' : undefined}
            className={`w-full text-left rounded-xl transition-all duration-200 flex items-center gap-3 ${sidebarCollapsed ? 'justify-center px-2 py-3' : 'px-4 py-3'} ${
              view === 'archived'
                ? 'bg-slate-600 text-white shadow-lg shadow-slate-900/20'
                : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-.375c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v.375c0 .621.504 1.125 1.125 1.125z" />
            </svg>
            {!sidebarCollapsed && <span className="text-sm font-semibold tracking-wide">Archived Pursuits</span>}
          </button>

          <button
            onClick={() => setView('developers')}
            title={sidebarCollapsed ? 'Developer Registry' : undefined}
            className={`w-full text-left rounded-xl transition-all duration-200 flex items-center gap-3 ${sidebarCollapsed ? 'justify-center px-2 py-3' : 'px-4 py-3'} ${
              view === 'developers' || view === 'developer-detail' || view === 'asset-detail'
                ? 'bg-orange-700 text-white shadow-lg shadow-orange-900/20'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>
            {!sidebarCollapsed && <span className="text-sm font-semibold tracking-wide">Developer Registry</span>}
          </button>

          <button
            onClick={() => { setActiveTab('Overview'); setView('dashboard'); }}
            title={sidebarCollapsed ? 'National Overview' : undefined}
            className={`w-full text-left rounded-xl transition-all duration-200 flex items-center gap-3 ${sidebarCollapsed ? 'justify-center px-2 py-3' : 'px-4 py-3'} ${
              activeTab === 'Overview' && view === 'dashboard'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
            {!sidebarCollapsed && <span className="text-sm font-semibold tracking-wide">National Overview</span>}
          </button>

          {!sidebarCollapsed && (
            <div className="pt-6 pb-2 px-4">
              <span className="text-[10px] font-bold text-slate-600 uppercase tracking-[0.2em]">ISO / RTO SECTORS</span>
            </div>
          )}
          {sidebarCollapsed && <div className="pt-3 pb-1"><div className="h-px bg-slate-800 mx-2" /></div>}

          {!sidebarCollapsed && (
            <div className="pt-4 pb-2 px-4">
              <span className="text-[10px] font-bold text-slate-600 uppercase tracking-[0.2em]">Data Source</span>
              <p className="text-[10px] text-slate-500 mt-1">
                {getDataTimestamp()
                  ? `EIA • ${new Date(getDataTimestamp()!).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
                  : 'Built-in dataset'}
              </p>
            </div>
          )}

          {REGIONS.map(region => (
            <button
              key={region}
              onClick={() => { setActiveTab(region); setView('dashboard'); }}
              title={sidebarCollapsed ? region : undefined}
              className={`w-full text-left rounded-xl transition-all duration-200 flex items-center justify-between group ${sidebarCollapsed ? 'justify-center px-2 py-2.5' : 'px-4 py-2.5'} ${
                activeTab === region && view === 'dashboard'
                  ? 'bg-slate-800 text-blue-400 border border-slate-700' 
                  : 'text-slate-500 hover:bg-slate-800/50 hover:text-slate-300'
              }`}
            >
              {sidebarCollapsed
                ? <span className={`text-[10px] font-bold ${activeTab === region ? 'text-blue-400' : ''}`}>{region.slice(0, 3)}</span>
                : <>
                    <span className={`text-sm font-medium ${activeTab === region ? 'font-bold' : ''}`}>{region}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${activeTab === region ? 'bg-blue-900/40 text-blue-400' : 'bg-slate-800 text-slate-600 group-hover:text-slate-400'}`}>
                      {plants.filter(p => p.region === region).length}
                    </span>
                  </>
              }
            </button>
          ))}
        </nav>

        {/* User info + admin link + sign out */}
        <div className="p-4 border-t border-slate-800 space-y-1">
          {userRole === 'admin' && (
            <button
              onClick={() => setView('admin')}
              title={sidebarCollapsed ? 'Admin' : undefined}
              className={`w-full text-left rounded-xl transition-all duration-200 flex items-center gap-3 ${sidebarCollapsed ? 'justify-center px-2 py-3' : 'px-4 py-3'} ${
                view === 'admin'
                  ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/20'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              {!sidebarCollapsed && <span className="text-sm font-semibold">Admin</span>}
            </button>
          )}
          {sidebarCollapsed ? (
            <div className="flex justify-center py-2">
              <button
                onClick={() => signOut()}
                className="p-2 rounded-lg text-slate-600 hover:text-red-400 hover:bg-slate-800 transition-colors"
                title="Sign Out"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
              </button>
            </div>
          ) : (
            <div className="px-4 py-3 flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Signed in as</div>
                <div className="text-xs text-slate-400 font-medium truncate mt-0.5">{session?.user?.email}</div>
              </div>
              <button
                onClick={() => signOut()}
                className="ml-3 p-2 rounded-lg text-slate-600 hover:text-red-400 hover:bg-slate-800 transition-colors flex-shrink-0"
                title="Sign Out"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
              </button>
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-slate-950 p-8 custom-scrollbar relative">
        {view === 'admin' && userRole === 'admin' ? (
          <AdminPage
            currentUserId={session.user.id}
            onBack={() => setView('dashboard')}
            onDataIngested={refreshAllPlantData}
          />
        ) : view === 'dashboard' ? (
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
            </header>

            {/* Search Bar */}
            {activeTab === 'Overview' && (
              <div className="mb-6">
                <input
                  type="text"
                  placeholder="Search by plant name, operator, state, EIA code…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full max-w-md px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-600 transition-colors"
                />
              </div>
            )}

            {/* Overview Summary */}
            {activeTab === 'Overview' && (
              <RegionalComparison plants={plants} statsMap={statsMap} selectedFuels={selectedFuels} />
            )}

            {activeTab === 'Watchlist' && (
              <WatchlistDashboard
                plants={plants}
                statsMap={statsMap}
                watchlist={watchlist}
                onPlantClick={handlePlantClickFromPursuits}
                onToggleWatch={toggleWatch}
              />
            )}

            {activeTab !== 'Watchlist' && insights && (
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

            {activeTab !== 'Watchlist' && (
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
                      const isWatched = watchlist.some(w => w.entity_type === 'plant' && w.entity_id === plant.id);
                      return (
                        <tr key={plant.id} onClick={() => handlePlantClick(plant.id)} className="cursor-pointer transition-all hover:bg-slate-800/60 group">
                          <td className="px-6 py-5">
                            <div className="flex items-start gap-3">
                              <button onClick={(e) => toggleWatch(e, 'plant', plant.id)} className={`mt-0.5 transition-colors ${isWatched ? 'text-amber-400' : 'text-slate-700 hover:text-slate-500'}`}>
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
            )}
          </>
        ) : (
          view === 'company' && selectedUltParent
            ? <CompanyDetailView ultParentName={selectedUltParent} onBack={() => { setView(selectedPlantId ? 'detail' : 'dashboard'); }} onPlantClick={handlePlantClickFromCompany} initialTab={companyActiveTab} onTabChange={setCompanyActiveTab} />
            : view === 'lenders'
            ? <LenderPursuitsDashboard onLenderClick={handleLenderClick} watchlist={watchlist} onToggleWatch={toggleWatch} />
            : view === 'taxequity'
            ? <TaxEquityPursuitsDashboard onInvestorClick={handleTaxEquityClick} watchlist={watchlist} onToggleWatch={toggleWatch} />
            : view === 'pursuits'
            ? <PlantPursuitsDashboard onPlantClick={handlePlantClickFromPursuits} />
            : view === 'archived'
            ? <ArchivedPursuitsDashboard />
            : view === 'entity' && selectedEntity
            ? <EntityDetailView entityName={selectedEntity.name} entityType={selectedEntity.type} onBack={() => setView(selectedEntity.type === 'lender' ? 'lenders' : 'taxequity')} onPlantClick={handlePlantClickFromEntity} />
            : view === 'developers'
            ? <DeveloperListView onDeveloperClick={handleDeveloperClick} />
            : view === 'developer-detail' && selectedDeveloper
            ? <DeveloperDetailView developer={selectedDeveloper} onBack={() => { setView('developers'); setDeveloperActiveTab('overview'); setDeveloperMapViewport(null); }} onAssetClick={handleAssetRegistryClick} onPlantClick={handlePlantClickFromDeveloper} onTabChange={setDeveloperActiveTab} mapViewport={developerMapViewport} onMapViewportChange={setDeveloperMapViewport} plants={plants} statsMap={statsMap} initialTab={developerActiveTab} />
            : view === 'asset-detail' && selectedAssetId
            ? <AssetRegistryDetailView assetId={selectedAssetId} onBack={() => selectedDeveloper ? setView('developer-detail') : setView('developers')} onPlantClick={handlePlantClickFromDeveloper} />
            : selectedPlant && <PlantDetailView plant={selectedPlant} stats={statsMap[selectedPlant.id]} regionalAvg={regionalAvgFactor} subRegionalAvg={subRegionalAvgFactor} regionalTrend={regionalTrend} subRegionalTrend={subRegionalTrend} generationLoading={generationLoading} isWatched={watchlist.some(w => w.entity_type === 'plant' && w.entity_id === selectedPlant.id)} onToggleWatch={(e) => toggleWatch(e, 'plant', selectedPlant.id)} onBack={() => { if (cameFromDeveloper && selectedDeveloper) { setView('developer-detail'); setCameFromDeveloper(false); } else if (cameFromPursuits) { setView('pursuits'); setCameFromPursuits(false); } else if (cameFromEntity) { setView('entity'); setCameFromEntity(false); } else if (cameFromCompany && selectedUltParent) { setView('company'); setCameFromCompany(false); } else { setView('dashboard'); } }} onCompanyClick={handleCompanyClick} />
        )}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `.custom-scrollbar::-webkit-scrollbar { width: 5px; } .custom-scrollbar::-webkit-scrollbar-track { background: #0f172a; } .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 10px; }` }} />

      {showPipelineTour && (
        <PipelineTourModal onClose={() => setShowPipelineTour(false)} />
      )}

    </div>
  );
};

export default App;