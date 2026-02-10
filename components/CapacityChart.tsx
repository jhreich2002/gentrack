
import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts';
import { CapacityFactorStats, PowerPlant } from '../types';
import { TYPICAL_CAPACITY_FACTORS, COLORS } from '../constants';

interface Props {
  plant: PowerPlant;
  stats: CapacityFactorStats;
  regionalTrend?: { month: string; factor: number }[];
}

const CapacityChart: React.FC<Props> = ({ plant, stats, regionalTrend }) => {
  // Combine plant data and regional trend data for Recharts
  const data = stats.monthlyFactors.map((f, index) => {
    const regionalPoint = regionalTrend?.find(rt => rt.month === f.month);
    return {
      name: f.month,
      plantFactor: Math.round(f.factor * 100),
      regionalFactor: regionalPoint ? Math.round(regionalPoint.factor * 100) : null
    };
  });

  const typicalLine = TYPICAL_CAPACITY_FACTORS[plant.fuelSource] * 100;

  return (
    <div className="h-72 w-full bg-slate-800/50 rounded-xl p-4 border border-slate-700">
      <h3 className="text-sm font-medium text-slate-400 mb-4">Capacity Factor Trend (%)</h3>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
          <XAxis 
            dataKey="name" 
            stroke="#94a3b8" 
            fontSize={10} 
            tickFormatter={(val) => val.split('-')[1] + '/' + val.split('-')[0].slice(2)}
          />
          <YAxis stroke="#94a3b8" fontSize={10} domain={[0, 100]} />
          <Tooltip 
            contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', fontSize: '12px' }}
          />
          <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
          <ReferenceLine 
            y={typicalLine} 
            label={{ position: 'right', value: 'National Exp.', fill: '#64748b', fontSize: 9 }} 
            stroke="#475569" 
            strokeDasharray="3 3" 
          />
          
          {/* Regional Average Line */}
          {regionalTrend && (
            <Line 
              name={`Regional Avg (${plant.region})`}
              type="monotone" 
              dataKey="regionalFactor" 
              stroke="#64748b" 
              strokeWidth={2} 
              strokeDasharray="5 5"
              dot={false}
              activeDot={{ r: 4 }}
            />
          )}

          {/* Plant Line */}
          <Line 
            name={plant.name}
            type="monotone" 
            dataKey="plantFactor" 
            stroke={COLORS[plant.fuelSource]} 
            strokeWidth={3} 
            dot={false}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default CapacityChart;
