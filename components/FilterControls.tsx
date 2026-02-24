
import React from 'react';
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
  showOnlyCurtailed: boolean;
  setShowOnlyCurtailed: (b: boolean) => void;
  hideNoData: boolean;
  setHideNoData: (b: boolean) => void;
}

const FilterControls: React.FC<Props> = ({
  activeRegion,
  selectedFuels,
  setSelectedFuels,
  selectedSubRegions,
  setSelectedSubRegions,
  search,
  setSearch,
  showOnlyCurtailed,
  setShowOnlyCurtailed,
  hideNoData,
  setHideNoData,
}) => {
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

  const isRegionalTab = activeRegion !== 'Overview' && activeRegion !== 'Watchlist';

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-6 flex flex-wrap items-end gap-6 shadow-lg relative z-10">
      <div className="flex-1 min-w-[200px]">
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 block">Search Assets</label>
        <input 
          type="text" 
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name, ID, or Owner..."
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

      <div>
        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5 block">Status</label>
        <div className="flex gap-1.5">
          <button 
            onClick={() => setShowOnlyCurtailed(!showOnlyCurtailed)}
            className={`px-3 py-2 rounded-lg text-xs font-bold transition-all border ${
              showOnlyCurtailed 
                ? 'bg-red-900/30 border-red-500 text-red-400 shadow-[0_0_15px_rgba(239,68,68,0.2)]' 
                : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
            }`}
          >
            {showOnlyCurtailed ? '⚠️ CURTAILED ONLY' : 'ALL ASSETS'}
          </button>
          <button 
            onClick={() => setHideNoData(!hideNoData)}
            className={`px-3 py-2 rounded-lg text-xs font-bold transition-all border ${
              hideNoData 
                ? 'bg-slate-700 border-slate-500 text-slate-200 shadow-[0_0_12px_rgba(148,163,184,0.15)]' 
                : 'bg-slate-800 border-slate-700 text-slate-500 hover:border-slate-600'
            }`}
          >
            {hideNoData ? '✕ NO DATA HIDDEN' : 'SHOW NO DATA'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FilterControls;
