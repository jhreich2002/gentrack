/**
 * GenTrack — WatchlistDashboard
 *
 * Renders watchlisted plants in pursuit-style format, with an AI-generated
 * portfolio overview highlighting recent news and where to focus.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import { PowerPlant, CapacityFactorStats } from '../types';
import { COLORS } from '../constants';
import { fetchWatchlistPursuitData, PursuitPlant } from '../services/pursuitService';
import { supabase } from '../services/supabaseClient';

interface Props {
  plants: PowerPlant[];
  statsMap: Record<string, CapacityFactorStats>;
  watchlist: string[];
  onPlantClick: (eiaPlantCode: string) => void;
  onToggleWatch: (e: React.MouseEvent, plantId: string) => void;
}

interface WatchlistOverview {
  summary: string;
  priorities: { plantName: string; reason: string; urgency: 'high' | 'medium' | 'low' }[];
  keyDevelopments: string[];
}

type SortKey = 'distress' | 'opportunity' | 'pursuit' | 'mw' | 'factor' | 'lenders';

function formatCf(f: number | null): string {
  if (f == null) return '—';
  return (f * 100).toFixed(1) + '%';
}

function facilityTypeShort(ft: string): string {
  const MAP: Record<string, string> = {
    tax_equity: 'TE', construction_loan: 'CL', term_loan: 'TL',
    revolving_credit: 'RC', other: '?',
  };
  return MAP[ft?.toLowerCase().replace(/ /g, '_')] ?? ft?.slice(0, 2).toUpperCase() ?? '?';
}

function fuelColor(fuel: string): string {
  const lower = fuel.toLowerCase();
  if (lower.includes('wind'))    return COLORS['Wind']    ?? '#38bdf8';
  if (lower.includes('solar'))   return COLORS['Solar']   ?? '#facc15';
  if (lower.includes('nuclear')) return COLORS['Nuclear'] ?? '#4ade80';
  return '#94a3b8';
}

function scoreLabel(val: number | null): { text: string; color: string; bg: string } {
  if (val == null) return { text: '—', color: 'text-slate-600', bg: '' };
  if (val >= 60) return { text: 'HIGH', color: 'text-red-400',   bg: 'bg-red-500/10 border-red-500/30' };
  if (val >= 30) return { text: 'MED',  color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30' };
  return           { text: 'LOW',  color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/30' };
}

function trendIndicator(cfTrend: number | null): React.ReactNode {
  if (cfTrend == null) return null;
  if (cfTrend > 0.05)  return <span className="text-red-400 text-[10px] font-bold ml-1">▼</span>;
  if (cfTrend < -0.05) return <span className="text-emerald-400 text-[10px] font-bold ml-1">▲</span>;
  return null;
}

function urgencyColor(u: string) {
  if (u === 'high')   return { dot: 'bg-red-500',    text: 'text-red-400',   badge: 'bg-red-500/10 border-red-500/30 text-red-400' };
  if (u === 'medium') return { dot: 'bg-amber-500',  text: 'text-amber-400', badge: 'bg-amber-500/10 border-amber-500/30 text-amber-400' };
  return               { dot: 'bg-slate-500',  text: 'text-slate-400', badge: 'bg-slate-700/50 border-slate-600/30 text-slate-400' };
}

const AI_CACHE_PREFIX = 'gentrack_watchlist_overview_';

async function fetchWatchlistArticles(eiaPlantCodes: string[]) {
  if (eiaPlantCodes.length === 0) return [];
  const cutoff = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
  const orFilter = eiaPlantCodes.map(c => `plant_codes.cs.{${c}}`).join(',');
  const { data } = await supabase
    .from('news_articles')
    .select('title, article_summary, published_at, plant_codes, importance, sentiment_label')
    .or(orFilter)
    .gte('published_at', cutoff)
    .order('published_at', { ascending: false })
    .limit(Math.min(80, eiaPlantCodes.length * 5));
  return (data ?? []) as { title: string; article_summary: string | null; plant_codes: string[]; importance: string | null; sentiment_label: string | null }[];
}

async function buildAiOverview(
  watchedPlants: PowerPlant[],
  pursuitData: PursuitPlant[],
  articles: { title: string; article_summary: string | null; plant_codes: string[] }[],
): Promise<WatchlistOverview> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY ?? (import.meta as any).env?.GEMINI_API_KEY;
  if (!apiKey) return { summary: 'Gemini API key not configured.', priorities: [], keyDevelopments: [] };

  const pursuitMap = new Map(pursuitData.map(p => [p.eiaPlantCode, p]));

  // Group article summaries per plant (up to 3 each)
  const articlesByPlant = new Map<string, string[]>();
  for (const article of articles) {
    for (const code of article.plant_codes) {
      if (!articlesByPlant.has(code)) articlesByPlant.set(code, []);
      const existing = articlesByPlant.get(code)!;
      if (existing.length < 3) existing.push(article.article_summary || article.title);
    }
  }

  const plantContext = watchedPlants.map(plant => {
    const p = pursuitMap.get(plant.eiaPlantCode);
    return {
      name: plant.name,
      state: plant.location?.state ?? '',
      fuel: plant.fuelSource,
      mw: plant.nameplateCapacityMW,
      distressScore: p?.distressScore ?? null,
      newsRiskScore: p?.newsRiskScore ?? null,
      ttmFactor: p?.ttmAvgFactor != null ? `${(p.ttmAvgFactor * 100).toFixed(1)}%` : 'N/A',
      recentNews: articlesByPlant.get(plant.eiaPlantCode) ?? [],
    };
  });

  const prompt = `You are an energy investment analyst reviewing a client's watchlisted power plants.

Portfolio:
${JSON.stringify(plantContext, null, 2)}

Provide:
1. A 2-3 sentence executive summary of overall portfolio risk and opportunity.
2. Top plants to focus on (urgency: high/medium/low), with a specific one-sentence reason for each.
3. 3-5 key recent developments or themes across the portfolio.

Be direct and specific. Distress scores are 0–100 (higher = more distressed). Plants with no recent news have fewer data points.`;

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          priorities: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                plantName:  { type: Type.STRING },
                reason:     { type: Type.STRING },
                urgency:    { type: Type.STRING },
              },
              required: ['plantName', 'reason', 'urgency'],
            },
          },
          keyDevelopments: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['summary', 'priorities', 'keyDevelopments'],
      },
    },
  });

  const text = response.text;
  if (!text) throw new Error('Empty Gemini response');
  return JSON.parse(text) as WatchlistOverview;
}

const WatchlistDashboard: React.FC<Props> = ({ plants, statsMap, watchlist, onPlantClick, onToggleWatch }) => {
  const watchedPlants = useMemo(() =>
    plants.filter(p => watchlist.includes(p.id)),
    [plants, watchlist]
  );

  const eiaPlantCodes = useMemo(() =>
    watchedPlants.map(p => p.eiaPlantCode),
    [watchedPlants]
  );

  const [pursuitMap, setPursuitMap] = useState<Map<string, PursuitPlant>>(new Map());
  const [loadingData, setLoadingData] = useState(false);

  const [aiOverview, setAiOverview] = useState<WatchlistOverview | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(false);

  const [search, setSearch]     = useState('');
  const [sortKey, setSortKey]   = useState<SortKey>('distress');
  const [sortDesc, setSortDesc] = useState(true);

  const cacheKey = AI_CACHE_PREFIX + [...eiaPlantCodes].sort().join(',');

  useEffect(() => {
    if (eiaPlantCodes.length === 0) { setPursuitMap(new Map()); return; }

    setLoadingData(true);
    setAiOverview(null);
    setAiError(false);

    fetchWatchlistPursuitData(eiaPlantCodes).then(async pursuitData => {
      setPursuitMap(new Map(pursuitData.map(p => [p.eiaPlantCode, p])));
      setLoadingData(false);

      // Check cache first
      try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) { setAiOverview(JSON.parse(cached)); return; }
      } catch { /* ignore */ }

      setAiLoading(true);
      try {
        const articles = await fetchWatchlistArticles(eiaPlantCodes);
        const overview = await buildAiOverview(watchedPlants, pursuitData, articles);
        setAiOverview(overview);
        try { sessionStorage.setItem(cacheKey, JSON.stringify(overview)); } catch { /* ignore */ }
      } catch {
        setAiError(true);
      } finally {
        setAiLoading(false);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDesc(d => !d);
    else { setSortKey(key); setSortDesc(true); }
  };

  const sorted = useMemo(() => {
    let result = watchedPlants;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(p => p.name.toLowerCase().includes(q) || p.eiaPlantCode.includes(q));
    }
    const dir = sortDesc ? -1 : 1;
    return [...result].sort((a, b) => {
      const pa = pursuitMap.get(a.eiaPlantCode);
      const pb = pursuitMap.get(b.eiaPlantCode);
      switch (sortKey) {
        case 'distress':     return dir * ((pa?.distressScore ?? 0)     - (pb?.distressScore ?? 0));
        case 'opportunity':  return dir * ((pa?.opportunityScore ?? 0)  - (pb?.opportunityScore ?? 0));
        case 'pursuit':      return dir * ((pa?.pursuitScore ?? 0)      - (pb?.pursuitScore ?? 0));
        case 'mw':           return dir * (a.nameplateCapacityMW        - b.nameplateCapacityMW);
        case 'factor':       return dir * ((pa?.ttmAvgFactor ?? 0)      - (pb?.ttmAvgFactor ?? 0));
        case 'lenders':      return dir * ((pa?.lenders.length ?? 0)    - (pb?.lenders.length ?? 0));
        default:             return 0;
      }
    });
  }, [watchedPlants, pursuitMap, search, sortKey, sortDesc]);

  // Empty state
  if (watchlist.length === 0) {
    return (
      <div className="animate-in fade-in duration-500 py-32 text-center">
        <div className="text-slate-600 text-5xl mb-4">☆</div>
        <p className="text-slate-400 font-semibold text-lg mb-1">Your Watch List is empty</p>
        <p className="text-slate-600 text-sm">Click the star icon next to any plant in the Overview to track it here.</p>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in slide-in-from-top-4 duration-500 space-y-8">

      {/* AI Portfolio Overview */}
      <div className="bg-amber-950/20 border border-amber-500/30 rounded-2xl p-6 shadow-lg">
        <div className="flex items-center gap-3 mb-5">
          <div className="bg-amber-500/20 p-2 rounded-lg border border-amber-500/30">
            <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <div>
            <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-[0.2em]">AI Portfolio Brief</div>
            <h2 className="text-base font-black text-white leading-tight">Watchlist Intelligence Overview</h2>
          </div>
          {aiLoading && (
            <div className="ml-auto flex items-center gap-2 text-amber-400/60 text-xs font-medium">
              <div className="animate-spin rounded-full h-3.5 w-3.5 border-t-2 border-b-2 border-amber-400/60" />
              Analyzing portfolio…
            </div>
          )}
        </div>

        {aiError && (
          <p className="text-slate-500 text-sm italic">Unable to generate AI overview at this time.</p>
        )}

        {aiOverview && !aiLoading && (
          <div className="space-y-6">
            {/* Summary */}
            <p className="text-slate-300 leading-relaxed text-sm italic border-l-2 border-amber-500/40 pl-4">
              "{aiOverview.summary}"
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Priority plants */}
              {aiOverview.priorities.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Focus Areas</div>
                  <div className="space-y-2">
                    {aiOverview.priorities.map((p, i) => {
                      const u = urgencyColor(p.urgency);
                      return (
                        <div key={i} className="flex items-start gap-3 bg-slate-900/50 rounded-xl px-4 py-3 border border-slate-800">
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${u.dot}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-xs font-black text-slate-200">{p.plantName}</span>
                              <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase border ${u.badge}`}>
                                {p.urgency}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-500 leading-relaxed">{p.reason}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Key developments */}
              {aiOverview.keyDevelopments.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Key Developments</div>
                  <ul className="space-y-2">
                    {aiOverview.keyDevelopments.map((d, i) => (
                      <li key={i} className="flex items-start gap-2.5 text-[11px] text-slate-400 leading-relaxed">
                        <span className="text-amber-500 mt-0.5 flex-shrink-0">▶</span>
                        {d}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {!aiOverview && !aiLoading && !aiError && (
          <div className="h-8 flex items-center">
            <div className="animate-pulse text-slate-600 text-sm">Loading portfolio data…</div>
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Search plant name or EIA ID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500 w-56"
        />
        <div className="text-xs text-slate-600 font-medium ml-auto">
          {sorted.length} asset{sorted.length !== 1 ? 's' : ''} tracked
        </div>
      </div>

      {/* Plant table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-800/70 text-slate-400 text-[10px] font-bold uppercase tracking-[0.15em]">
                <th className="px-6 py-5">Plant Name</th>
                <th className="px-6 py-5">Fuel</th>
                <th className="px-6 py-5 text-right cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('mw')}>
                  Capacity (MW) {sortKey === 'mw' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-right cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('factor')}>
                  TTM Factor {sortKey === 'factor' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-center cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('distress')}>
                  Distress {sortKey === 'distress' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-center cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('opportunity')}>
                  Opportunity {sortKey === 'opportunity' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 text-center cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('pursuit')}>
                  Pursuit Score {sortKey === 'pursuit' && (sortDesc ? '↓' : '↑')}
                </th>
                <th className="px-6 py-5 cursor-pointer hover:text-white transition-colors" onClick={() => toggleSort('lenders')}>
                  Financing Parties {sortKey === 'lenders' && (sortDesc ? '↓' : '↑')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {loadingData
                ? Array.from({ length: Math.min(watchedPlants.length, 5) }).map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td className="px-6 py-5"><div className="h-4 bg-slate-800 rounded w-40" /></td>
                    <td className="px-6 py-5"><div className="h-4 bg-slate-800 rounded w-12" /></td>
                    <td className="px-6 py-5"><div className="h-4 bg-slate-800 rounded w-16 ml-auto" /></td>
                    <td className="px-6 py-5"><div className="h-4 bg-slate-800 rounded w-16 ml-auto" /></td>
                    <td className="px-6 py-5"><div className="h-4 bg-slate-800 rounded w-14 mx-auto" /></td>
                    <td className="px-6 py-5"><div className="h-4 bg-slate-800 rounded w-14 mx-auto" /></td>
                    <td className="px-6 py-5"><div className="h-4 bg-slate-800 rounded w-14 mx-auto" /></td>
                    <td className="px-6 py-5"><div className="h-4 bg-slate-800 rounded w-32" /></td>
                  </tr>
                ))
                : sorted.map(plant => {
                  const pursuit = pursuitMap.get(plant.eiaPlantCode);
                  const color = fuelColor(plant.fuelSource);
                  return (
                    <tr
                      key={plant.id}
                      onClick={() => onPlantClick(plant.eiaPlantCode)}
                      className="cursor-pointer transition-all hover:bg-slate-800/60 group"
                    >
                      {/* Plant Name */}
                      <td className="px-6 py-5">
                        <div className="flex items-start gap-3">
                          <button
                            onClick={e => { e.stopPropagation(); onToggleWatch(e, plant.id); }}
                            className="mt-0.5 transition-colors text-amber-400 hover:text-slate-500"
                            title="Remove from watchlist"
                          >
                            <svg className="w-4 h-4" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.382-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                            </svg>
                          </button>
                          <div>
                            <div className="font-bold text-slate-200 group-hover:text-blue-400 transition-colors text-sm">
                              {plant.name}
                            </div>
                            <div className="text-[10px] text-slate-600 font-mono tracking-tighter">
                              EIA ID: {plant.eiaPlantCode} | {plant.location?.state ?? ''}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Fuel */}
                      <td className="px-6 py-5">
                        <span
                          style={{ color, backgroundColor: `${color}10` }}
                          className="text-[10px] px-2 py-0.5 rounded font-bold border border-current"
                        >
                          {plant.fuelSource.toUpperCase()}
                        </span>
                      </td>

                      {/* Capacity */}
                      <td className="px-6 py-5 text-right font-mono text-sm text-slate-300">
                        {plant.nameplateCapacityMW.toLocaleString()}
                      </td>

                      {/* TTM Factor */}
                      <td className="px-6 py-5 text-right">
                        <div className="font-mono text-sm font-bold text-slate-200">
                          {formatCf(pursuit?.ttmAvgFactor ?? null)}{trendIndicator(pursuit?.cfTrend ?? null)}
                        </div>
                        {pursuit?.ttmAvgFactor != null && (
                          <div className="w-full h-1 bg-slate-800 rounded-full mt-2 overflow-hidden max-w-[80px] ml-auto">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${Math.min(100, pursuit.ttmAvgFactor * 100)}%`, backgroundColor: color }}
                            />
                          </div>
                        )}
                      </td>

                      {/* Distress */}
                      <td className="px-6 py-5 text-center">
                        {(() => {
                          const s = scoreLabel(pursuit?.distressScore ?? null);
                          return pursuit?.distressScore != null ? (
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${s.bg} ${s.color}`}>
                              {pursuit.distressScore.toFixed(0)} {s.text}
                            </span>
                          ) : <span className="text-slate-600">—</span>;
                        })()}
                      </td>

                      {/* Opportunity */}
                      <td className="px-6 py-5 text-center">
                        {(() => {
                          const s = scoreLabel(pursuit?.opportunityScore ?? null);
                          return pursuit?.opportunityScore != null ? (
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${s.bg} ${s.color}`}>
                              {pursuit.opportunityScore.toFixed(0)} {s.text}
                            </span>
                          ) : <span className="text-slate-600">—</span>;
                        })()}
                      </td>

                      {/* Pursuit Score */}
                      <td className="px-6 py-5 text-center">
                        {(() => {
                          const s = scoreLabel(pursuit?.pursuitScore ?? null);
                          return pursuit?.pursuitScore != null ? (
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${s.bg} ${s.color}`}>
                              {pursuit.pursuitScore.toFixed(0)} {s.text}
                            </span>
                          ) : <span className="text-slate-600">—</span>;
                        })()}
                      </td>

                      {/* Financing Parties */}
                      <td className="px-6 py-5">
                        {pursuit && pursuit.lenders.length > 0 ? (
                          <div className="flex flex-wrap gap-1 max-w-sm">
                            {pursuit.lenders.slice(0, 4).map((l, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 font-medium"
                                title={`${l.role} — ${l.facilityType}`}
                              >
                                <span className="text-emerald-500 font-bold text-[8px]">{facilityTypeShort(l.facilityType)}</span>
                                {l.name}
                              </span>
                            ))}
                            {pursuit.lenders.length > 4 && (
                              <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-500">
                                +{pursuit.lenders.length - 4} more
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-600 text-xs">No financing data</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        {sorted.length === 0 && !loadingData && (
          <div className="py-16 text-center text-slate-600">
            <p className="font-semibold">No plants match your search.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default WatchlistDashboard;
