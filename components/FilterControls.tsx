
import React, { useState } from 'react';
import { Region, FuelSource } from '../types';
import { FUEL_SOURCES, SUBREGIONS } from '../constants';

interface Props {
  activeRegion: Region | 'Overview' | 'Watchlist';
  selectedFuels: FuelSource[];
  setSelectedFuels: (fuels: FuelSource[]) => void;
  selectedSubRegions: string[];
  setSelectedSubRegions: (subs: string[]) => void;
  search: string;
  setSearch: (s: string) => void;
  dataGapThreshold: number | null;
  setDataGapThreshold: (n: number | null) => void;
  minCurtailmentLag: number;
  setMinCurtailmentLag: (n: number) => void;
  maxCFThreshold: number | null;
  setMaxCFThreshold: (n: number | null) => void;
}

const GAP_OPTIONS: { label: string; value: number | null }[] = [
  { label: 'Off', value: null },
  { label: '≥3 mo', value: 3 },
  { label: '≥6 mo', value: 6 },
  { label: '≥9 mo', value: 9 },
  { label: '≥12 mo', value: 12 },
];

const LAG_OPTIONS: { label: string; value: number }[] = [
  { label: 'Off', value: 0 },
  { label: '>10%', value: 10 },
  { label: '>20%', value: 20 },
  { label: '>30%', value: 30 },
  { label: '>50%', value: 50 },
];

const CF_PRESETS: { label: string; value: number }[] = [
  { label: '10%', value: 10 },
  { label: '25%', value: 25 },
  { label: '50%', value: 50 },
  { label: '75%', value: 75 },
];

const FilterControls: React.FC<Props> = ({
  activeRegion,
  selectedFuels,
  setSelectedFuels,
  selectedSubRegions,
  setSelectedSubRegions,
  search,
  setSearch,
  dataGapThreshold,
  setDataGapThreshold,
  minCurtailmentLag,
  setMinCurtailmentLag,
  maxCFThreshold,
  setMaxCFThreshold,
}) => {
  const [cfInput, setCfInput] = useState('');

  const toggleFuel = (fuel: FuelSource) => {
    setSelectedFuels(selectedFuels.includes(fuel)
      ? selectedFuels.filter(f => f !== fuel)
      : [...selectedFuels, fuel]);
  };

  const toggleSubRegion = (sub: string) => {
    setSelectedSubRegions(selectedSubRegions.includes(sub)
      ? selectedSubRegions.filter(s => s !== sub)
      : [...selectedSubRegions, sub]);
  };

  const handleCfInput = (val: string) => {
    setCfInput(val);
    const n = parseFloat(val);
    if (!isNaN(n) && n >= 0 && n <= 100) setMaxCFThreshold(n);
    else if (val === '') setMaxCFThreshold(null);
  };

  const clearCF = () => {
    setCfInput('');
    setMaxCFThreshold(null);
  };

  const isRegionalTab = activeRegion !== 'Overview' && activeRegion !== 'Watchlist';

  const activeFiltersCount = [
    dataGapThreshold !== null,
    minCurtailmentLag > 0,
    maxCFThreshold !== null,
  ].filter(Boolean).length;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-6 shadow-lg relative z-10 space-y-4">

      {/* Row 1: Search, Fuel, Sub-zone, Clear */}
      <div className="flex flex-wrap items-end gap-5">
        <div className="flex-1 min-w-[200px]">
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 block">Search Assets</label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, ID, Owner, or State..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
          />
        </div>

        <div>
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 block">Fuel Source</label>
          <div className="flex gap-1.5 bg-slate-800 p-1 rounded-lg border border-slate-700">
            {FUEL_SOURCES.map(fuel => (
              <button
                key={fuel}
                onClick={() => toggleFuel(fuel)}
                className={`px-3 py-1 rounded text-xs font-medium transition-all ${
                  selectedFuels.includes(fuel)
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {fuel}
              </button>
            ))}
          </div>
        </div>

        {isRegionalTab && (
          <div className="max-w-[300px]">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 block">Sub-Zone Focus</label>
            <div className="flex flex-wrap gap-1.5">
              {SUBREGIONS[activeRegion as Region].map(sub => (
                <button
                  key={sub}
                  onClick={() => toggleSubRegion(sub)}
                  className={`px-2 py-1 rounded text-[10px] font-bold border transition-all ${
                    selectedSubRegions.includes(sub)
                      ? 'bg-blue-900/40 border-blue-500 text-blue-300'
                      : 'bg-slate-800 border-slate-700 text-slate-500 hover:border-slate-500'
                  }`}
                >
                  {sub}
                </button>
              ))}
            </div>
          </div>
        )}

        {activeFiltersCount > 0 && (
          <button
            onClick={() => { setDataGapThreshold(null); setMinCurtailmentLag(0); setMaxCFThreshold(null); setCfInput(''); }}
            className="px-3 py-2 rounded-lg text-xs font-bold border border-slate-600 bg-slate-800 text-slate-400 hover:text-white hover:border-slate-400 transition-all self-end"
          >
            ✕ Clear Filters ({activeFiltersCount})
          </button>
        )}
      </div>

      {/* Row 2: Advanced Filters */}
      <div className="flex flex-wrap items-start gap-6 pt-3 border-t border-slate-800">

        {/* Data Gap */}
        <div>
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 flex items-center gap-2">
            Data Gap
            <span className="text-slate-600 normal-case font-normal">hide plants offline ≥N months</span>
          </label>
          <div className="flex gap-1 bg-slate-800 p-1 rounded-lg border border-slate-700">
            {GAP_OPTIONS.map(opt => (
              <button
                key={String(opt.value)}
                onClick={() => setDataGapThreshold(opt.value)}
                className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${
                  dataGapThreshold === opt.value
                    ? 'bg-amber-600/80 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Curtailment Lag */}
        <div>
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 flex items-center gap-2">
            Curtailment Lag
            <span className="text-slate-600 normal-case font-normal">min % below regional avg</span>
          </label>
          <div className="flex gap-1 bg-slate-800 p-1 rounded-lg border border-slate-700">
            {LAG_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setMinCurtailmentLag(opt.value)}
                className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${
                  minCurtailmentLag === opt.value
                    ? 'bg-red-700/70 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Cap Factor ≤ */}
        <div>
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 flex items-center gap-2">
            Cap Factor ≤
            <span className="text-slate-600 normal-case font-normal">show plants at or below TTM CF</span>
          </label>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 bg-slate-800 p-1 rounded-lg border border-slate-700">
              {CF_PRESETS.map(p => (
                <button
                  key={p.value}
                  onClick={() => { setMaxCFThreshold(p.value); setCfInput(String(p.value)); }}
                  className={`px-2.5 py-1.5 rounded text-xs font-bold transition-all ${
                    maxCFThreshold === p.value
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={0}
              max={100}
              value={cfInput}
              onChange={e => handleCfInput(e.target.value)}
              placeholder="Custom %"
              className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
            />
            {maxCFThreshold !== null && (
              <button onClick={clearCF} className="text-slate-500 hover:text-slate-300 text-xs font-bold transition-colors">
                ✕
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};

export default FilterControls;
