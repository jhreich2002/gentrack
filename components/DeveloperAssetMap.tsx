import React, { useEffect, useMemo, useRef, useState } from 'react';
import L, { LatLngBounds } from 'leaflet';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';

export interface DeveloperMapViewport {
  center: [number, number];
  zoom: number;
}

export interface DeveloperAssetMapPoint {
  id: string;
  name: string;
  assetId: string;
  eiaPlantCode: string | null;
  technology: string | null;
  status: string | null;
  state: string | null;
  county: string | null;
  lat: number;
  lng: number;
  capacityMw: number;
  ttmAverage: number | null;
  curtailmentScore: number | null;
  isLikelyCurtailed: boolean;
  isMaintenanceOffline: boolean;
  dataMonthsCount: number | null;
  hasPlantMatch: boolean;
}

interface DisplayMarker {
  id: string;
  lat: number;
  lng: number;
  capacityMw: number;
  color: string;
  radius: number;
  points: DeveloperAssetMapPoint[];
  count: number;
  isCluster: boolean;
}

interface Props {
  points: DeveloperAssetMapPoint[];
  unmappedCount: number;
  onPlantClick?: (eiaPlantCode: string) => void;
  initialViewport?: DeveloperMapViewport | null;
  onViewportChange?: (viewport: DeveloperMapViewport) => void;
}

function getPerformanceBand(point: DeveloperAssetMapPoint): 'strong' | 'watch' | 'risk' | 'offline' | 'unknown' {
  if (point.isMaintenanceOffline) return 'offline';
  if (point.dataMonthsCount != null && point.dataMonthsCount < 6) return 'unknown';
  if (point.ttmAverage == null && point.curtailmentScore == null) return 'unknown';
  if (point.curtailmentScore != null && point.curtailmentScore >= 60) return 'risk';
  if (point.isLikelyCurtailed) return 'risk';
  if (point.ttmAverage != null && point.ttmAverage < 0.15) return 'risk';
  if (point.ttmAverage != null && point.ttmAverage >= 0.25) return 'strong';
  return 'watch';
}

function getBandColor(band: ReturnType<typeof getPerformanceBand>): string {
  switch (band) {
    case 'strong':
      return '#10b981';
    case 'watch':
      return '#38bdf8';
    case 'risk':
      return '#ef4444';
    case 'offline':
      return '#f59e0b';
    default:
      return '#94a3b8';
  }
}

function scaleRadius(capacityMw: number): number {
  const safe = Math.max(1, capacityMw);
  const min = 4;
  const max = 22;
  const normalized = Math.log10(safe + 1) / Math.log10(1000);
  return Math.max(min, Math.min(max, min + normalized * (max - min)));
}

function MapStateController({
  points,
  initialViewport,
  onViewportChange,
  onBoundsChange,
  onZoomChange,
}: {
  points: DeveloperAssetMapPoint[];
  initialViewport?: DeveloperMapViewport | null;
  onViewportChange?: (viewport: DeveloperMapViewport) => void;
  onBoundsChange: (bounds: LatLngBounds) => void;
  onZoomChange: (zoom: number) => void;
}) {
  const map = useMap();
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;

    if (initialViewport) {
      map.setView(initialViewport.center, initialViewport.zoom, { animate: false });
    } else if (points.length > 0) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
      map.fitBounds(bounds.pad(0.18), { maxZoom: 7, animate: false });
    } else {
      map.setView([39.8, -98.6], 4, { animate: false });
    }

    initializedRef.current = true;
    onZoomChange(map.getZoom());
    onBoundsChange(map.getBounds());
    const center = map.getCenter();
    onViewportChange?.({ center: [center.lat, center.lng], zoom: map.getZoom() });
  }, [map, points, initialViewport, onBoundsChange, onViewportChange, onZoomChange]);

  useMapEvents({
    zoomend: () => {
      const nextZoom = map.getZoom();
      const nextBounds = map.getBounds();
      const center = map.getCenter();
      onZoomChange(nextZoom);
      onBoundsChange(nextBounds);
      onViewportChange?.({ center: [center.lat, center.lng], zoom: nextZoom });
    },
    moveend: () => {
      const nextZoom = map.getZoom();
      const nextBounds = map.getBounds();
      const center = map.getCenter();
      onZoomChange(nextZoom);
      onBoundsChange(nextBounds);
      onViewportChange?.({ center: [center.lat, center.lng], zoom: nextZoom });
    },
  });

  return null;
}

function getCellSizeDegrees(zoom: number): number {
  if (zoom <= 3) return 2.5;
  if (zoom === 4) return 1.6;
  if (zoom === 5) return 1.0;
  if (zoom === 6) return 0.55;
  if (zoom === 7) return 0.3;
  return 0;
}

function markerTitle(point: DeveloperAssetMapPoint): string {
  const cf = point.ttmAverage != null ? `${(point.ttmAverage * 100).toFixed(1)}%` : 'N/A';
  const curtailment = point.curtailmentScore != null ? point.curtailmentScore.toFixed(0) : 'N/A';

  return `${point.name}\n${point.capacityMw.toLocaleString()} MW\nCF: ${cf} | Curtailment: ${curtailment}`;
}

function buildMarkers(points: DeveloperAssetMapPoint[], zoom: number): DisplayMarker[] {
  if (points.length === 0) return [];

  const cellSize = getCellSizeDegrees(zoom);
  if (zoom >= 8 || cellSize === 0) {
    return points.map((point) => {
      const band = getPerformanceBand(point);
      return {
        id: point.id,
        lat: point.lat,
        lng: point.lng,
        capacityMw: point.capacityMw,
        color: getBandColor(band),
        radius: scaleRadius(point.capacityMw),
        points: [point],
        count: 1,
        isCluster: false,
      };
    });
  }

  const buckets = new Map<string, DeveloperAssetMapPoint[]>();
  for (const point of points) {
    const latKey = Math.floor((point.lat + 90) / cellSize);
    const lngKey = Math.floor((point.lng + 180) / cellSize);
    const key = `${latKey}:${lngKey}`;
    const list = buckets.get(key);
    if (list) list.push(point);
    else buckets.set(key, [point]);
  }

  const severityRank: Record<ReturnType<typeof getPerformanceBand>, number> = {
    strong: 1,
    watch: 2,
    unknown: 3,
    risk: 4,
    offline: 5,
  };

  return Array.from(buckets.entries()).map(([key, group]) => {
    const count = group.length;
    const sumLat = group.reduce((acc, p) => acc + p.lat, 0);
    const sumLng = group.reduce((acc, p) => acc + p.lng, 0);
    const totalCapacity = group.reduce((acc, p) => acc + p.capacityMw, 0);

    let worstBand: ReturnType<typeof getPerformanceBand> = 'strong';
    for (const p of group) {
      const current = getPerformanceBand(p);
      if (severityRank[current] > severityRank[worstBand]) worstBand = current;
    }

    const radius = Math.max(8, Math.min(30, scaleRadius(totalCapacity) + Math.sqrt(count) * 1.25));

    return {
      id: `cluster-${key}`,
      lat: sumLat / count,
      lng: sumLng / count,
      capacityMw: totalCapacity,
      color: getBandColor(worstBand),
      radius,
      points: group,
      count,
      isCluster: count > 1,
    };
  });
}

export default function DeveloperAssetMap({ points, unmappedCount, onPlantClick, initialViewport, onViewportChange }: Props) {
  const [zoom, setZoom] = useState(4);
  const [bounds, setBounds] = useState<LatLngBounds | null>(null);

  const visiblePoints = useMemo(() => {
    if (!bounds) return points;
    const padded = bounds.pad(0.15);
    return points.filter((p) => padded.contains([p.lat, p.lng]));
  }, [points, bounds]);

  const markers = useMemo(() => buildMarkers(visiblePoints, zoom), [visiblePoints, zoom]);

  if (points.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-sm text-slate-400">
        No mappable assets found for this developer. Assets without coordinates: {unmappedCount}.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Mapped Assets</div>
          <div className="text-xl font-black text-white mt-1">{points.length.toLocaleString()}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Unmapped Assets</div>
          <div className="text-xl font-black text-slate-300 mt-1">{unmappedCount.toLocaleString()}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Cluster Mode</div>
          <div className="text-xl font-black text-cyan-400 mt-1">{zoom < 8 ? 'On' : 'Off'}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Size Encoding</div>
          <div className="text-xl font-black text-blue-400 mt-1">Capacity MW</div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <MapContainer
          center={[39.8, -98.6]}
          zoom={4}
          minZoom={3}
          maxZoom={11}
          scrollWheelZoom={true}
          className="developer-asset-map"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          <MapStateController
            points={points}
            initialViewport={initialViewport}
            onViewportChange={onViewportChange}
            onZoomChange={setZoom}
            onBoundsChange={setBounds}
          />

          {markers.map((marker) => (
            <CircleMarker
              key={marker.id}
              center={[marker.lat, marker.lng]}
              radius={marker.radius}
              pathOptions={{
                color: '#0b1020',
                weight: 1.5,
                fillColor: marker.color,
                fillOpacity: marker.isCluster ? 0.8 : 0.72,
              }}
            >
              <Popup>
                {marker.isCluster ? (
                  <div className="space-y-2 min-w-[220px]">
                    <div className="font-bold text-slate-900">{marker.count} assets in cluster</div>
                    <div className="text-xs text-slate-700">
                      Total capacity: {marker.capacityMw.toLocaleString(undefined, { maximumFractionDigits: 1 })} MW
                    </div>
                    <div className="max-h-36 overflow-auto text-xs space-y-1">
                      {marker.points.slice(0, 8).map((point) => (
                        <div key={point.id} className="border-b border-slate-200 pb-1">
                          {point.name}
                        </div>
                      ))}
                      {marker.points.length > 8 && (
                        <div className="text-slate-500">+{marker.points.length - 8} more</div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2 min-w-[240px]">
                    <div className="font-bold text-slate-900">{marker.points[0].name}</div>
                    <div className="text-xs text-slate-700">{marker.points[0].state || 'Unknown state'}{marker.points[0].county ? `, ${marker.points[0].county} County` : ''}</div>
                    <div className="text-xs text-slate-700">{markerTitle(marker.points[0])}</div>
                    <div className="flex gap-2 pt-1">
                      {marker.points[0].eiaPlantCode && onPlantClick ? (
                        <button
                          type="button"
                          className="px-2 py-1 text-xs font-semibold rounded bg-cyan-600 text-white hover:bg-cyan-500"
                          onClick={() => onPlantClick(marker.points[0].eiaPlantCode as string)}
                        >
                          Open Plant
                        </button>
                      ) : (
                        <span className="text-xs text-slate-500">No linked EIA plant</span>
                      )}
                    </div>
                  </div>
                )}
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Legend</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs text-slate-300">
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-emerald-500" /> Strong CF</div>
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-sky-400" /> Moderate</div>
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-red-500" /> Curtailed risk</div>
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-amber-500" /> Offline</div>
          <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-slate-400" /> Limited data</div>
        </div>
        <div className="text-xs text-slate-500 mt-3">
          Marker area scales with capacity MW. National view clusters nearby assets; individual assets appear at higher zoom.
        </div>
      </div>
    </div>
  );
}
