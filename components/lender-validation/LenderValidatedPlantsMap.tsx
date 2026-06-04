import React, { useCallback } from 'react';
import DeveloperAssetMap, { DeveloperAssetMapPoint } from '../DeveloperAssetMap';
import { DigestPlantRow } from '../../types';

interface Props {
  plants: DigestPlantRow[];
  onPlantClick: (plantId: string, eiaPlantCode: string) => void;
}

/** Map a CF delta (pp) to a performance band for dot coloring. */
function deltaToBand(delta: number | null | undefined): 'strong' | 'watch' | 'risk' | 'offline' | 'unknown' {
  if (delta == null) return 'unknown';
  if (delta >= 3) return 'strong';
  if (delta < -3) return 'risk';
  return 'watch';
}

/** Role chip style (matches the roleBadge in LenderValidatedDigestView). */
function roleChipStyle(role: string | null): string {
  switch (role?.toLowerCase()) {
    case 'senior debt':      return 'bg-blue-900/50 text-blue-300 border-blue-700/40';
    case 'construction loan': return 'bg-amber-900/50 text-amber-300 border-amber-700/40';
    case 'mezzanine':        return 'bg-purple-900/50 text-purple-300 border-purple-700/40';
    case 'term loan':        return 'bg-cyan-900/50 text-cyan-300 border-cyan-700/40';
    default:                 return 'bg-slate-800 text-slate-400 border-slate-600/40';
  }
}

export default function LenderValidatedPlantsMap({ plants, onPlantClick }: Props) {
  const mappedPlants = plants.filter((p) => p.lat != null && p.lng != null) as (DigestPlantRow & { lat: number; lng: number })[];
  const unmappedCount = plants.length - mappedPlants.length;

  // Adapt DigestPlantRow → DeveloperAssetMapPoint
  const points: DeveloperAssetMapPoint[] = mappedPlants.map((p) => ({
    id:                   p.plantId,
    name:                 p.plantName,
    assetId:              p.plantId,
    eiaPlantCode:         p.eiaPlantCode,
    technology:           p.fuelSource,
    status:               null,
    state:                p.state,
    county:               null,
    lat:                  p.lat,
    lng:                  p.lng,
    capacityMw:           p.nameplateMw ?? 0,
    ttmAverage:           p.ttmCf != null ? p.ttmCf / 100 : null,
    curtailmentScore:     null,
    isLikelyCurtailed:    false,
    isMaintenanceOffline: false,
    dataMonthsCount:      12,
    hasPlantMatch:        true,
  }));

  // Build a lookup from point id → DigestPlantRow for the popup callback
  const plantById = new Map(plants.map((p) => [p.plantId, p]));

  const colorBy = useCallback(
    (point: DeveloperAssetMapPoint) => {
      const row = plantById.get(point.id);
      return deltaToBand(row?.cfDeltaPp);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plants],
  );

  const popupContent = useCallback(
    (point: DeveloperAssetMapPoint): React.ReactNode => {
      const row = plantById.get(point.id);
      if (!row) return null;

      const deltaSign = (row.cfDeltaPp ?? 0) >= 0 ? '+' : '';
      const deltaColor =
        (row.cfDeltaPp ?? 0) >= 3 ? 'text-emerald-400' :
        (row.cfDeltaPp ?? 0) < -3 ? 'text-rose-400' :
        'text-slate-400';

      return (
        <div className="space-y-2 min-w-[240px] font-sans">
          <div className="font-bold text-slate-900 text-sm leading-tight">{row.plantName}</div>
          <div className="text-xs text-slate-600">{row.state ?? '—'}</div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-700">
            <span className="text-slate-500">Capacity</span>
            <span className="font-semibold">{row.nameplateMw?.toLocaleString() ?? '—'} MW</span>
            <span className="text-slate-500">Fuel</span>
            <span className="font-semibold">{row.fuelSource}</span>
            <span className="text-slate-500">TTM CF</span>
            <span className="font-semibold">
              {row.ttmCf != null ? `${row.ttmCf.toFixed(1)}%` : '—'}
              {row.cfDeltaPp != null && (
                <span className={`ml-1 ${deltaColor}`}>
                  ({deltaSign}{row.cfDeltaPp.toFixed(1)} pp)
                </span>
              )}
            </span>
          </div>

          {row.role && (
            <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border ${roleChipStyle(row.role)}`}>
              {row.role}
            </span>
          )}

          <div className="pt-1">
            <button
              type="button"
              className="px-2 py-1 text-xs font-semibold rounded bg-cyan-600 text-white hover:bg-cyan-500 w-full"
              onClick={() => onPlantClick(row.plantId, row.eiaPlantCode)}
            >
              Open plant detail
            </button>
          </div>
        </div>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plants, onPlantClick],
  );

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      {/* Section header */}
      <div className="px-5 pt-4 pb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Validated plants — geographic view</h3>
        <div className="flex items-center gap-3 text-xs">
          {/* Delta legend */}
          <span className="flex items-center gap-1 text-slate-400">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
            Outperforming (&gt;+3 pp)
          </span>
          <span className="flex items-center gap-1 text-slate-400">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-400 inline-block" />
            In-line (±3 pp)
          </span>
          <span className="flex items-center gap-1 text-slate-400">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" />
            Underperforming (&lt;−3 pp)
          </span>
          {unmappedCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-400">
              {unmappedCount} plant{unmappedCount !== 1 ? 's' : ''} without coordinates
            </span>
          )}
        </div>
      </div>

      {/* Map */}
      <div className="px-4 pb-4">
        {points.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-sm text-slate-500 bg-slate-950/40 rounded-lg border border-slate-800">
            No plants with coordinates to display
            {unmappedCount > 0 && ` (${unmappedCount} without coordinates)`}
          </div>
        ) : (
          // Wrap in a fixed-height div — DeveloperAssetMap's MapContainer fills its parent
          <div style={{ height: 480 }}>
            <DeveloperAssetMap
              points={points}
              unmappedCount={0}           // we show our own badge above
              colorBy={colorBy}
              popupContent={popupContent}
            />
          </div>
        )}
      </div>
    </div>
  );
}
