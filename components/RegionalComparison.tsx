
import React, { useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { Region, FuelSource, CapacityFactorStats, PowerPlant } from '../types';
import { REGIONS, COLORS, SUBREGIONS } from '../constants';

interface Props {
  plants: PowerPlant[];
  statsMap: Record<string, CapacityFactorStats>;
  selectedFuels: FuelSource[];
}

const RegionalComparison: React.FC<Props> = ({ plants, statsMap, selectedFuels }) => {
  const [activeRegion, setActiveRegion] = useState<Region | null>(null);

  const displayData = useMemo(() => {
    if (activeRegion) {
      // SubRegion View
      const subRegionList = SUBREGIONS[activeRegion];
      return subRegionList.map(sub => {
        const subPlants = plants.filter(p => p.region === activeRegion && p.subRegion === sub && selectedFuels.includes(p.fuelSource));
        const avgFactor = subPlants.length > 0
          ? subPlants.reduce((acc, p) => acc + (statsMap[p.id]?.ttmAverage || 0), 0) / subPlants.length
          : 0;
        return {
          name: sub,
          avgFactor: Math.round(avgFactor * 100),
          count: subPlants.length,
          id: sub
        };
      }).filter(d => d.count > 0);
    } else {
      // ISO/RTO View
      return REGIONS.map(region => {
        const regionPlants = plants.filter(p => p.region === region && selectedFuels.includes(p.fuelSource));
        const avgFactor = regionPlants.length > 0 
          ? regionPlants.reduce((acc, p) => acc + (statsMap[p.id]?.ttmAverage || 0), 0) / regionPlants.length
          : 0;
        
        return {
          name: region,
          avgFactor: Math.round(avgFactor * 100),
          count: regionPlants.length,
          id: region
        };
      }).filter(d => d.count > 0);
    }
  }, [activeRegion, plants, statsMap, selectedFuels]);

  // Total average for the current view
  const currentAvg = displayData.length > 0 
    ? displayData.reduce((acc, curr) => acc + curr.avgFactor, 0) / displayData.length
    : 0;

  const handleBarClick = (data: any) => {
    if (!activeRegion) {
      setActiveRegion(data.id as Region);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-8 shadow-xl">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-4">
          {activeRegion && (
            <button 
              onClick={() => setActiveRegion(null)}
              className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 border border-slate-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
            </button>
          )}
          <div>
            <h2 className="text-xl font-bold text-white">
              {activeRegion ? `${activeRegion} Sub-Zone Analysis` : 'Regional Benchmarks'}
            </h2>
            <p className="text-xs text-slate-400">
              {activeRegion ? 'TTM Average across local subregions' : 'Comparing TTM average capacity factors across ISOs/RTOs'}
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-blue-400">{currentAvg.toFixed(1)}%</div>
          <div className="text-[10px] uppercase font-bold text-slate-500">
            {activeRegion ? 'Regional Avg' : 'National Selection Avg'}
          </div>
        </div>
      </div>

      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={displayData} margin={{ top: 5, right: 30, left: 0, bottom: 5 }} onClick={(state) => {
              if (state && state.activePayload) {
                handleBarClick(state.activePayload[0].payload);
              }
            }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
            <XAxis 
              dataKey="name" 
              stroke="#94a3b8" 
              fontSize={10} 
              tickLine={false}
              axisLine={false}
              interval={0}
            />
            <YAxis 
              stroke="#94a3b8" 
              fontSize={10} 
              tickLine={false} 
              axisLine={false}
              domain={[0, 100]}
              tickFormatter={(val) => `${val}%`}
            />
            <Tooltip 
              cursor={{ fill: 'rgba(255,255,255,0.05)' }}
              contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', fontSize: '12px' }}
              formatter={(value: number) => [`${value}%`, 'Avg. Capacity Factor']}
            />
            <ReferenceLine 
              y={currentAvg} 
              stroke="#64748b" 
              strokeDasharray="5 5"
              label={{ position: 'right', value: 'Avg', fill: '#64748b', fontSize: 10 }} 
            />
            <Bar dataKey="avgFactor" radius={[4, 4, 0, 0]} barSize={40} className="cursor-pointer">
              {displayData.map((entry, index) => (
                <Cell 
                  key={`cell-${index}`} 
                  fill={entry.avgFactor < currentAvg * 0.9 ? COLORS.curtailed : '#3b82f6'} 
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      
      {!activeRegion && (
        <div className="mt-4 flex gap-4 overflow-x-auto pb-2 scrollbar-hide">
          {displayData.map(d => (
            <button 
              key={d.name} 
              onClick={() => setActiveRegion(d.id as Region)}
              className="flex-shrink-0 bg-slate-800/50 hover:bg-slate-800 rounded-lg px-3 py-2 border border-slate-700/50 transition-colors text-left group"
            >
              <div className="text-[9px] uppercase font-bold text-slate-500 group-hover:text-blue-400 transition-colors">{d.name}</div>
              <div className="text-sm font-mono font-bold text-slate-200">{d.avgFactor}%</div>
            </button>
          ))}
        </div>
      )}

      {activeRegion && (
         <div className="mt-4 p-3 bg-blue-900/10 border border-blue-500/20 rounded-xl flex items-center gap-3">
           <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
           <p className="text-xs text-blue-300">
             Drilled down into <span className="font-bold">{activeRegion}</span>. Each bar represents a specific local balancing zone or geographic sub-grid.
           </p>
         </div>
      )}
    </div>
  );
};

export default RegionalComparison;
