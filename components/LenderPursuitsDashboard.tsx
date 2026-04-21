import React, { useState, useEffect, useMemo, useRef } from 'react';
import { LenderStats } from '../types';
import { fetchAllLenderStats } from '../services/lenderStatsService';
import { fetchPursuitPlants, PursuitPlant } from '../services/pursuitService';
import { fetchArchivedPursuits, archivePursuit, unarchivePursuit } from '../services/archiveService';
import { getSession, getProfile, UserRole } from '../services/authService';
import {
  PITCH_ANGLE_LABEL, PITCH_ANGLE_COLOR, FACILITY_ABBR,
  FTI_SERVICE_LINE_LABEL, FTI_SERVICE_LINE_COLOR,
  scoreColor, scoreBarColor, cfTrendLabel, topServiceLines,
} from '../utils/lenderUtils';

type Tier = 'HOT' | 'WARM' | 'WATCH' | null;

interface Props {
  onLenderClick: (name: string) => void;
  watchlist: import('../services/authService').WatchlistEntry[];
  onToggleWatch: (e: React.MouseEvent, entityType: 'lender', entityId: string) => void;
}

const TIER_STYLES: Record<NonNullable<Tier>, { badge: string; border: string }> = {
  HOT:   { badge: 'bg-red-900/50 border-red-700/50 text-red-300',    border: 'bg-red-500' },
  WARM:  { badge: 'bg-amber-900/50 border-amber-700/50 text-amber-300', border: 'bg-amber-500' },
  WATCH: { badge: 'bg-slate-800 border-slate-700 text-slate-400',     border: 'bg-slate-600' },
};

function fmtMw(mw: number): string {
  if (mw >= 1000) return `${(mw / 1000).toFixed(1)} GW`;
  return `${Math.round(mw).toLocaleString()} MW`;
}

function fmtUsdCompact(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${Math.round(v).toLocaleString()}`;
}

interface Toast {
  message: string;
  onUndo: () => void;
}

  const [stats, setStats] = useState<LenderStats[]>([]);
  const [pursuitPlants, setPursuitPlants] = useState<PursuitPlant[]>([]);
  const [loading, setLoading] = useState(true);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [fuelFilter, setFuelFilter] = useState('all');
  const [sort, setSort] = useState<'exposure' | 'distress' | 'plants' | 'name' | 'currency' | 'tier'>('exposure');
  const [loanStatusFilter, setLoanStatusFilter] = useState<'active' | 'all' | 'unknown'>('active');
  const [userRole, setUserRole] = useState<UserRole>('user');

  useEffect(() => {
    async function load() {
      const session = await getSession();
      let role: UserRole = 'user';
      if (session?.user?.id) {
        const profile = await getProfile(session.user.id);
        if (profile?.role) role = profile.role;
      }
      setUserRole(role);
      const [s, p, archived] = await Promise.all([
        fetchAllLenderStats(),
        fetchPursuitPlants(),
        fetchArchivedPursuits(role === 'admin'),
      ]);
      setStats(s.filter(l => l.pctCurtailed > 0));
      setPursuitPlants(p);
      setArchivedIds(archived.lenders);
      setLoading(false);
    }
    load();
  }, []);

  const showToast = (msg: string, onUndo: () => void) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message: msg, onUndo });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  const handleArchive = async (e: React.MouseEvent, lenderName: string, permanent = false) => {
    e.stopPropagation();
    setArchivedIds(prev => new Set([...prev, lenderName]));
    await archivePursuit('lender', lenderName, permanent);
    if (permanent) {
      showToast(`Permanently archived "${lenderName}"`, undefined);
    } else {
      showToast(`Archived "${lenderName}"`, async () => {
        setArchivedIds(prev => { const s = new Set(prev); s.delete(lenderName); return s; });
        await unarchivePursuit('lender', lenderName);
        setToast(null);
      });
    }
  };

  // eiaPlantCode → { name, state, fuelSource } lookup
  const plantDataMap = useMemo(
    () => Object.fromEntries(pursuitPlants.map(p => [p.eiaPlantCode, { name: p.name, state: p.state, fuel: p.fuelSource }])),
    [pursuitPlants],
  );
  const plantNameMap = useMemo(
    () => Object.fromEntries(pursuitPlants.map(p => [p.eiaPlantCode, p.name])),
    [pursuitPlants],
  );

  // lenderName → { totalCurtailedMw, curtailedCount }
  const lenderExposureMap = useMemo(() => {
    const map = new Map<string, { totalCurtailedMw: number; curtailedCount: number }>();
    for (const plant of pursuitPlants) {
      for (const l of plant.lenders) {
        const prev = map.get(l.name) ?? { totalCurtailedMw: 0, curtailedCount: 0 };
        map.set(l.name, {
          totalCurtailedMw: prev.totalCurtailedMw + plant.nameplateMw,
          curtailedCount:   prev.curtailedCount + 1,
        });
      }
    }
    return map;
  }, [pursuitPlants]);

  // lenderName → { activeLoanCount, hasActiveExposure }
  const lenderCurrencyMap = useMemo(() => {
    const map = new Map<string, { activeLoanCount: number; hasActiveExposure: boolean }>();
    for (const plant of pursuitPlants) {
      for (const l of plant.lenders) {
        const prev = map.get(l.name) ?? { activeLoanCount: 0, hasActiveExposure: false };
        const isActive = l.loanStatus === 'active';
        map.set(l.name, {
          activeLoanCount: prev.activeLoanCount + (isActive ? 1 : 0),
          hasActiveExposure: prev.hasActiveExposure || isActive,
        });
      }
    }
    return map;
  }, [pursuitPlants]);

  // lenderName → priority tier
  const lenderTierMap = useMemo(() => {
    const map = new Map<string, Tier>();
    for (const lender of stats) {
      const currency = lenderCurrencyMap.get(lender.lenderName);
      const hasActive = currency?.hasActiveExposure ?? false;
      const distress = lender.distressScore ?? 0;
      const urgent = lender.highUrgencyCount ?? 0;
      let tier: Tier = null;
      if (hasActive && distress >= 60 && urgent > 0)      tier = 'HOT';
      else if (hasActive && (distress >= 40 || urgent > 0)) tier = 'WARM';
      else if (hasActive)                                   tier = 'WATCH';
      map.set(lender.lenderName, tier);
    }
    return map;
  }, [stats, lenderCurrencyMap]);

  // lenderName → avg cfTrend across its curtailed plants (from pursuitPlants)
  const lenderTrendMap = useMemo(() => {
    const map = new Map<string, { sum: number; count: number }>();
    for (const plant of pursuitPlants) {
      if (plant.cfTrend == null) continue;
      for (const l of plant.lenders) {
        const prev = map.get(l.name) ?? { sum: 0, count: 0 };
        map.set(l.name, { sum: prev.sum + plant.cfTrend, count: prev.count + 1 });
      }
    }
    const result = new Map<string, number>();
    map.forEach((v, k) => result.set(k, v.count > 0 ? v.sum / v.count : 0));
    return result;
  }, [pursuitPlants]);

  // lenderName → synthesized "why now" trigger line
  const lenderTriggerMap = useMemo(() => {
    const map = new Map<string, string>();
    const now = Date.now();
    for (const lender of stats) {
      const currency = lenderCurrencyMap.get(lender.lenderName);
      const distress = lender.distressScore ?? 0;
      const urgent = lender.highUrgencyCount ?? 0;
      const activeLoanCount = currency?.activeLoanCount ?? 0;

      let trigger = '';
      if (urgent > 0 && lender.lastNewsDate) {
        const daysAgo = Math.round((now - new Date(lender.lastNewsDate).getTime()) / 86_400_000);
        if (daysAgo <= 14) {
          trigger = `${urgent} urgent plant${urgent !== 1 ? 's' : ''} · Intelligence ${daysAgo}d ago`;
        }
      }
      if (!trigger && urgent > 0) {
        trigger = `${urgent} plant${urgent !== 1 ? 's' : ''} with high-urgency advisory signals`;
      }
      if (!trigger && (lender.newsSentimentScore ?? 100) < 30) {
        trigger = 'Negative news sentiment across portfolio';
      }
      if (!trigger && lender.lastNewsDate) {
        const daysAgo = Math.round((now - new Date(lender.lastNewsDate).getTime()) / 86_400_000);
        if (daysAgo <= 14) trigger = `New portfolio intelligence ${daysAgo}d ago`;
      }
      if (!trigger && activeLoanCount > 2 && distress >= 60) {
        trigger = `${activeLoanCount} active loans on distressed portfolio (${Math.round(distress)})`;
      }
      if (!trigger && lender.analysisAngleBullets?.[0]) {
        trigger = lender.analysisAngleBullets[0].slice(0, 90);
      }
      if (trigger) map.set(lender.lenderName, trigger);
    }
    return map;
  }, [stats, lenderCurrencyMap]);

  const states = useMemo(() => {
    const s = new Set<string>();
    stats.forEach(l => l.plantCodes.forEach(c => { if (plantDataMap[c]?.state) s.add(plantDataMap[c].state); }));
    return ['all', ...Array.from(s).sort()];
  }, [stats, plantDataMap]);

  const fuels = useMemo(() => {
    const s = new Set<string>();
    stats.forEach(l => l.plantCodes.forEach(c => { if (plantDataMap[c]?.fuel) s.add(plantDataMap[c].fuel); }));
    return ['all', ...Array.from(s).sort()];
  }, [stats, plantDataMap]);

  const TIER_ORDER: Record<string, number> = { HOT: 0, WARM: 1, WATCH: 2 };

  const filtered = useMemo(() => {
    let rows = stats.filter(l => !archivedIds.has(l.lenderName));
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(l => l.lenderName.toLowerCase().includes(q));
    }
    if (stateFilter !== 'all') {
      rows = rows.filter(l => l.plantCodes.some(c => plantDataMap[c]?.state === stateFilter));
    }
    if (fuelFilter !== 'all') {
      rows = rows.filter(l => l.plantCodes.some(c => plantDataMap[c]?.fuel === fuelFilter));
    }
    if (loanStatusFilter === 'active') {
      rows = rows.filter(l => lenderCurrencyMap.get(l.lenderName)?.hasActiveExposure !== false);
    } else if (loanStatusFilter === 'unknown') {
      rows = rows.filter(l => !lenderCurrencyMap.get(l.lenderName)?.hasActiveExposure);
    }
    return [...rows].sort((a: LenderStats, b: LenderStats) => {
      if (sort === 'tier') {
        const at = lenderTierMap.get(a.lenderName);
        const bt = lenderTierMap.get(b.lenderName);
        const ao = at != null ? (TIER_ORDER[at] ?? 3) : 3;
        const bo = bt != null ? (TIER_ORDER[bt] ?? 3) : 3;
        if (ao !== bo) return ao - bo;
      }
      if (sort === 'exposure' || sort === 'tier') {
        const aActive = lenderCurrencyMap.get(a.lenderName)?.hasActiveExposure ? 1 : 0;
        const bActive = lenderCurrencyMap.get(b.lenderName)?.hasActiveExposure ? 1 : 0;
        if (bActive !== aActive) return bActive - aActive;
        const aExp = lenderExposureMap.get(a.lenderName);
        const bExp = lenderExposureMap.get(b.lenderName);
        const curtailedCodes_a = a.plantCodes.filter(c => plantNameMap[c]).length;
        const curtailedCodes_b = b.plantCodes.filter(c => plantNameMap[c]).length;
        const aVal = a.totalExposureUsd != null && a.assetCount > 0
          ? a.totalExposureUsd * ((aExp?.curtailedCount ?? 0) / a.assetCount)
          : (aExp?.totalCurtailedMw ?? 0);
        const bVal = b.totalExposureUsd != null && b.assetCount > 0
          ? b.totalExposureUsd * ((bExp?.curtailedCount ?? 0) / b.assetCount)
          : (bExp?.totalCurtailedMw ?? 0);
        return bVal - aVal;
      }
      if (sort === 'distress') return (b.distressScore ?? 0) - (a.distressScore ?? 0);
      if (sort === 'currency') {
        const ac = lenderCurrencyMap.get(a.lenderName)?.activeLoanCount ?? 0;
        const bc = lenderCurrencyMap.get(b.lenderName)?.activeLoanCount ?? 0;
        return bc - ac;
      }
      if (sort === 'plants') {
        const ac = a.plantCodes.filter(c => plantNameMap[c]).length;
        const bc = b.plantCodes.filter(c => plantNameMap[c]).length;
        return bc - ac;
      }
      return a.lenderName.localeCompare(b.lenderName);
    });
  }, [stats, archivedIds, search, stateFilter, fuelFilter, sort, loanStatusFilter, plantDataMap, plantNameMap, lenderCurrencyMap, lenderExposureMap, lenderTierMap]);

  // Summary stats for the header bar
  const summaryStats = useMemo(() => {
    const withActive = filtered.filter(l => lenderCurrencyMap.get(l.lenderName)?.hasActiveExposure).length;
    const totalMw = filtered.reduce((acc, l) => acc + (lenderExposureMap.get(l.lenderName)?.totalCurtailedMw ?? 0), 0);
    const highUrgency = filtered.filter(l => (l.highUrgencyCount ?? 0) > 0).length;
    // Modal pitch angle
    const pitchCounts = new Map<string, number>();
    filtered.forEach(l => {
      if (l.topPitchAngle) pitchCounts.set(l.topPitchAngle, (pitchCounts.get(l.topPitchAngle) ?? 0) + 1);
    });
    let topPitch: string | null = null;
    let topPitchCount = 0;
    pitchCounts.forEach((count, angle) => {
      if (count > topPitchCount) { topPitch = angle; topPitchCount = count; }
    });
    return { totalLenders: filtered.length, withActive, totalMw, highUrgency, topPitch };
  }, [filtered, lenderCurrencyMap, lenderExposureMap]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500">
        Loading lender data…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-900">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-2 h-8 rounded-full bg-cyan-500" />
          <h1 className="text-4xl font-black text-white tracking-tight">Lender Pursuits</h1>
        </div>
        <p className="text-slate-400 font-medium max-w-2xl leading-relaxed text-sm mb-4">
          Lenders with exposure to curtailed plants — ranked by active loan exposure.
        </p>

        {/* Summary Stats Bar */}
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-2.5 flex items-center gap-3">
            <div className="text-[9px] font-black text-cyan-500 uppercase tracking-widest">Lenders</div>
            <div className="text-xl font-black text-white">{summaryStats.totalLenders}</div>
          </div>
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-2.5 flex items-center gap-3">
            <div className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">Active Exposure</div>
            <div className="text-xl font-black text-white">{summaryStats.withActive}</div>
            <div className="text-[10px] text-slate-500">lenders</div>
          </div>
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-2.5 flex items-center gap-3">
            <div className="text-[9px] font-black text-amber-500 uppercase tracking-widest">Curtailed MW</div>
            <div className="text-xl font-black text-white">{fmtMw(summaryStats.totalMw)}</div>
          </div>
          <div className={`bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-2.5 flex items-center gap-3 ${summaryStats.highUrgency === 0 ? 'opacity-40' : ''}`}>
            <div className="text-[9px] font-black text-red-500 uppercase tracking-widest">High Urgency</div>
            <div className="text-xl font-black text-white">{summaryStats.highUrgency}</div>
            <div className="text-[10px] text-slate-500">lenders</div>
          </div>
          {summaryStats.topPitch && (
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-2.5 flex items-center gap-3">
              <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Top Signal</div>
              <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${PITCH_ANGLE_COLOR[summaryStats.topPitch] ?? 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                {PITCH_ANGLE_LABEL[summaryStats.topPitch] ?? summaryStats.topPitch}
              </span>
            </div>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search lenders…"
            className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500 w-48"
          />
          <select
            value={stateFilter}
            onChange={e => setStateFilter(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            {states.map(s => <option key={s} value={s}>{s === 'all' ? 'All States' : s}</option>)}
          </select>
          <select
            value={fuelFilter}
            onChange={e => setFuelFilter(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            {fuels.map(f => <option key={f} value={f}>{f === 'all' ? 'All Fuels' : f}</option>)}
          </select>
          <select
            value={loanStatusFilter}
            onChange={e => setLoanStatusFilter(e.target.value as typeof loanStatusFilter)}
            className="bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            <option value="active">Active Loans Only</option>
            <option value="all">All (incl. Matured)</option>
            <option value="unknown">Unknown Status</option>
          </select>
          <div className="flex rounded-lg overflow-hidden border border-slate-700 text-xs font-semibold">
            {(['tier', 'exposure', 'distress', 'plants', 'name'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`px-3 py-2 ${sort === s ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
              >
                {s === 'tier' ? 'Priority' : s === 'exposure' ? 'Exposure' : s === 'distress' ? 'Distress' : s === 'plants' ? 'Plants' : 'A–Z'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-slate-600 text-sm">
            No lenders match your search.
          </div>
        ) : (
          <table className="w-full text-left table-fixed">
            <thead className="sticky top-0 bg-slate-900/95 backdrop-blur z-10">
              <tr className="border-b border-slate-800">
                {/* Tier border cell */}
                <th className="w-1 p-0" />
                <th className="px-3 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-16 text-center">#</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider">Lender</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-52" title="Primary advisory angle for this lender's portfolio">Opportunity</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-44 text-right">Exposure</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-48">Health</th>
                <th className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-56">Assets</th>
                <th className="px-3 py-3 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map((lender, idx) => {
                                const isWatched = props.watchlist.some(w => w.entity_type === 'lender' && w.entity_id === lender.lenderName);
                const distress = lender.distressScore ?? 0;
                const curtailedCodes = lender.plantCodes.filter(c => plantNameMap[c]);
                const currency = lenderCurrencyMap.get(lender.lenderName);
                const exposure = lenderExposureMap.get(lender.lenderName);
                const tier = lenderTierMap.get(lender.lenderName) ?? null;

                const curtailed = curtailedCodes.length;
                const total = lender.assetCount || 1;
                const ratio = curtailed / total;
                const proRatedUsd = lender.totalExposureUsd != null
                  ? lender.totalExposureUsd * (curtailed / total)
                  : null;
                const mw = exposure?.totalCurtailedMw ?? 0;
                const activeLoanCount = currency?.activeLoanCount ?? 0;

                const visibleChips = curtailedCodes.slice(0, 5);
                const extraCount = curtailedCodes.length - visibleChips.length;
                const trigger = lenderTriggerMap.get(lender.lenderName);
                const ftiLines = topServiceLines(lender.relevanceScores ?? {}, 40, 2);
                const avgTrend = lenderTrendMap.get(lender.lenderName) ?? null;
                const trendInfo = cfTrendLabel(avgTrend);

                return (
                  <tr
                    key={lender.lenderName}
                    onClick={() => onLenderClick(lender.lenderName)}
                    className="cursor-pointer hover:bg-slate-800/60 group/row transition-colors"
                  >
                    {/* Tier left border */}
                    <td className="w-1 p-0">
                      <div
                        className={`h-full min-h-[3.5rem] w-1 ${tier ? TIER_STYLES[tier].border : 'bg-transparent'}`}
                      />
                    </td>

                    {/* Rank + tier badge */}
                    <td className="px-3 py-4 text-center align-top">
                      <div className="flex flex-col items-center gap-1.5">
                        <span className="text-xs font-mono text-slate-600">{idx + 1}</span>
                        {tier && (
                          <span className={`text-[8px] px-1.5 py-px rounded border font-black tracking-widest ${TIER_STYLES[tier].badge}`}>
                            {tier}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Lender name + trigger line + facility chips + FTI pills */}
                                        {/* Lender name + watchlist star + trigger line + facility chips + FTI pills */}
                                        <td className="px-4 py-4 align-top min-w-0">
                                          <div className="flex items-center gap-2">
                                            <button
                                              onClick={e => { e.stopPropagation(); props.onToggleWatch(e, 'lender', lender.lenderName); }}
                                              className={`transition-colors ${isWatched ? 'text-amber-400' : 'text-slate-700 hover:text-slate-500'}`}
                                              title={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
                                              aria-label={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
                                            >
                                              <svg className="w-4 h-4" fill={isWatched ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.382-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                                              </svg>
                                            </button>
                                            <span className="font-bold text-sm text-slate-200 group-hover/row:text-cyan-400 transition-colors truncate">
                                              {lender.lenderName}
                                            </span>
                                          </div>
                    <td className="px-4 py-4 align-top min-w-0">
                      <div className="font-bold text-sm text-slate-200 group-hover/row:text-cyan-400 transition-colors truncate">
                        {lender.lenderName}
                      </div>
                      {trigger && (
                        <div className="text-[10px] text-slate-500 italic mt-0.5 truncate" title={trigger}>
                          {trigger}
                        </div>
                      )}
                      {lender.facilityTypes.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {lender.facilityTypes.map(ft => (
                            <span
                              key={ft}
                              className="text-[9px] px-1 py-px rounded bg-slate-800 border border-slate-700 text-slate-500 font-mono font-bold"
                            >
                              {FACILITY_ABBR[ft] ?? ft.slice(0, 2).toUpperCase()}
                            </span>
                          ))}
                        </div>
                      )}
                      {ftiLines.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {ftiLines.map(({ key }) => (
                            <span
                              key={key}
                              className={`text-[9px] px-1.5 py-px rounded border font-semibold ${FTI_SERVICE_LINE_COLOR[key] ?? 'bg-slate-800 border-slate-700 text-slate-400'}`}
                              title={`FTI ${FTI_SERVICE_LINE_LABEL[key] ?? key}`}
                            >
                              {FTI_SERVICE_LINE_LABEL[key] ?? key}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    {/* Opportunity signal */}
                    <td className="px-4 py-4 align-top">
                      {lender.topPitchAngle ? (
                        <span
                          className={`inline-block text-xs px-2.5 py-1 rounded border font-semibold ${PITCH_ANGLE_COLOR[lender.topPitchAngle] ?? 'bg-slate-800 border-slate-700 text-slate-400'}`}
                          title={PITCH_ANGLE_LABEL[lender.topPitchAngle]}
                        >
                          {PITCH_ANGLE_LABEL[lender.topPitchAngle] ?? lender.topPitchAngle}
                        </span>
                      ) : (
                        <span className="text-slate-700 text-xs">—</span>
                      )}
                      {(lender.highUrgencyCount ?? 0) > 0 && (
                        <div className="mt-1.5">
                          <span className="text-[9px] px-2 py-0.5 rounded bg-red-900/50 border border-red-700/50 text-red-300 font-mono font-bold">
                            {lender.highUrgencyCount} urgent
                          </span>
                        </div>
                      )}
                    </td>

                    {/* Exposure */}
                    <td className="px-4 py-4 align-top text-right">
                      <div className="text-sm font-black text-slate-200">
                        {proRatedUsd != null ? fmtUsdCompact(proRatedUsd) : mw > 0 ? fmtMw(mw) : '—'}
                      </div>
                      {activeLoanCount > 0 ? (
                        <div className="text-[10px] text-emerald-500 font-mono mt-0.5">
                          {activeLoanCount} active loan{activeLoanCount !== 1 ? 's' : ''}
                        </div>
                      ) : (
                        <div className="text-[10px] text-slate-600 font-mono mt-0.5">no active loans</div>
                      )}
                      <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden mt-1.5 ml-auto" style={{ maxWidth: '80px' }}>
                        <div
                          className={`h-full rounded-full ${ratio >= 0.7 ? 'bg-red-500' : ratio >= 0.4 ? 'bg-amber-500' : 'bg-cyan-600'}`}
                          style={{ width: `${Math.round(ratio * 100)}%` }}
                        />
                      </div>
                      <div className="text-[9px] text-slate-600 mt-0.5">
                        {curtailed}/{lender.assetCount} plants curtailed
                      </div>
                    </td>

                    {/* Portfolio health */}
                    <td className="px-4 py-4 align-top">
                      <div className="space-y-2">
                        <div>
                          <div className="text-[9px] text-slate-600 uppercase tracking-wider mb-1">Distress</div>
                          <div className="flex items-center gap-2">
                            <div className="w-20 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${scoreBarColor(distress)}`}
                                style={{ width: `${distress}%` }}
                              />
                            </div>
                            <span className={`text-sm font-black w-7 ${scoreColor(distress)}`}>
                              {Math.round(distress)}
                            </span>
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] text-slate-600 uppercase tracking-wider mb-1">Avg CF</div>
                          <div className="text-xs font-mono text-slate-400">
                            {lender.avgPlantCf != null ? `${(lender.avgPlantCf * 100).toFixed(1)}%` : '—'}
                          </div>
                        </div>
                        {avgTrend != null && (
                          <div className={`text-[9px] font-mono font-bold ${trendInfo.color}`}>
                            {trendInfo.arrow} {trendInfo.label}
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Assets */}
                    <td className="px-4 py-4 align-top">
                      <div className="flex flex-wrap gap-1">
                        {visibleChips.map(code => (
                          <span
                            key={code}
                            className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/70 border border-slate-700/50 text-slate-500 font-mono"
                            title={plantNameMap[code]}
                          >
                            {plantDataMap[code]?.state ?? '??'}
                          </span>
                        ))}
                        {extraCount > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800/50 border border-slate-700/30 text-slate-600 font-mono">
                            +{extraCount}
                          </span>
                        )}
                      </div>
                      {curtailedCodes.length > 0 && (
                        <div className="text-[9px] text-slate-600 mt-1 font-mono">
                          {curtailedCodes.length} curtailed plant{curtailedCodes.length !== 1 ? 's' : ''}
                        </div>
                      )}
                    </td>

                    {/* Archive button */}
                    <td className="px-3 py-4 align-top text-center">
                      <button
                        onClick={e => handleArchive(e, lender.lenderName)}
                        title="Archive this pursuit"
                        className="opacity-0 group-hover/row:opacity-100 transition-opacity p-1.5 rounded hover:bg-slate-700 text-slate-500 hover:text-amber-400"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-.375c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v.375c0 .621.504 1.125 1.125 1.125z" />
                        </svg>
                      </button>
                      {userRole === 'admin' && (
                        <button
                          onClick={e => handleArchive(e, lender.lenderName, true)}
                          title="Permanently archive (admin only)"
                          className="ml-2 opacity-0 group-hover/row:opacity-100 transition-opacity p-1.5 rounded hover:bg-red-700 text-slate-500 hover:text-red-400 border border-red-700"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Archive toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 shadow-2xl text-sm text-slate-200 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-.375c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v.375c0 .621.504 1.125 1.125 1.125z" />
          </svg>
          <span>{toast.message}</span>
          <button
            onClick={toast.onUndo}
            className="ml-1 text-xs font-bold text-amber-400 hover:text-amber-300 transition-colors underline underline-offset-2"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
