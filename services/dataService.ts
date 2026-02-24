import { PowerPlant, Region, FuelSource, CapacityFactorStats, MonthlyGeneration } from '../types';
import { TYPICAL_CAPACITY_FACTORS } from '../constants';
import { FALLBACK_PLANTS } from './fallbackData';
import { supabase } from './supabaseClient';

let _dataTimestamp: string | null = null;

export function getDataTimestamp(): string | null {
  return _dataTimestamp;
}

interface PlantRow {
  id: string;
  eia_plant_code: string;
  operator_id: string | null;
  name: string;
  owner: string;
  region: string;
  sub_region: string;
  fuel_source: string;
  nameplate_capacity_mw: number;
  cod: string | null;
  county: string | null;
  state: string;
  lat: number;
  lng: number;
  ttm_avg_factor: number;
  curtailment_score: number;
  is_likely_curtailed: boolean;
  is_maintenance_offline: boolean | null;
  last_updated: string;
}

function rowToPlant(row: PlantRow): PowerPlant {
  return {
    id: row.id,
    eiaPlantCode: row.eia_plant_code,
    operatorId: row.operator_id ?? undefined,
    name: row.name,
    owner: row.owner,
    region: row.region as Region,
    subRegion: row.sub_region,
    fuelSource: row.fuel_source as FuelSource,
    nameplateCapacityMW: row.nameplate_capacity_mw,
    cod: row.cod ?? undefined,
    county: row.county ?? undefined,
    generationHistory: [],
    location: {
      state: row.state,
      lat: row.lat,
      lng: row.lng,
      county: row.county ?? undefined,
    },
  };
}

function rowToStats(row: PlantRow): CapacityFactorStats {
  const isMaintenanceOffline = row.is_maintenance_offline ?? false;
  // "No recent data" = insufficient active months and not a known maintenance outage.
  // We proxy this from Supabase using ttm_avg_factor === 0 when not maintenance offline.
  const hasNoRecentData = !isMaintenanceOffline && row.ttm_avg_factor === 0;
  return {
    plantId: row.id,
    monthlyFactors: [],
    ttmAverage: row.ttm_avg_factor,
    isLikelyCurtailed: (isMaintenanceOffline || hasNoRecentData) ? false : row.is_likely_curtailed,
    curtailmentScore: (isMaintenanceOffline || hasNoRecentData) ? 0 : row.curtailment_score,
    hasNoRecentData,
    isMaintenanceOffline,
  };
}

type FetchPlantsResult = { plants: PowerPlant[]; statsMap: Record<string, CapacityFactorStats> };

export const fetchPowerPlants = async (): Promise<FetchPlantsResult> => {
  try {
    if (!import.meta.env.VITE_SUPABASE_URL) throw new Error('No Supabase URL');

    const PAGE = 1000;
    let allRows: PlantRow[] = [];
    let from = 0;

    while (true) {
      const { data, error } = await supabase
        .from('plants')
        .select('*')
        .range(from, from + PAGE - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;
      allRows = allRows.concat(data as PlantRow[]);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    if (allRows.length === 0) throw new Error('No plants returned from Supabase');

    _dataTimestamp = allRows[0]?.last_updated ?? new Date().toISOString();
    console.log(`[GenTrack] Loaded ${allRows.length} plants from Supabase`);

    const plants = allRows.map(rowToPlant);
    const statsMap: Record<string, CapacityFactorStats> = {};
    allRows.forEach(row => { statsMap[row.id] = rowToStats(row); });

    return { plants, statsMap };
  } catch (err) {
    console.warn('[GenTrack] Supabase unavailable — falling back to static JSON:', err);
  }

  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/plants.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = await res.json();
    if (manifest.plants?.length > 0) {
      _dataTimestamp = manifest.fetchedAt ?? null;
      const plants: PowerPlant[] = manifest.plants.map((p: any) => ({
        ...p,
        region: p.region as Region,
        fuelSource: p.fuelSource as FuelSource,
      }));
      const statsMap = computeAllStats(plants);
      console.log(`[GenTrack] Loaded ${plants.length} plants from static JSON`);
      return { plants, statsMap };
    }
  } catch (err) {
    console.warn('[GenTrack] Static JSON unavailable:', err);
  }

  console.log(`[GenTrack] Using built-in fallback data (${FALLBACK_PLANTS.length} plants)`);
  _dataTimestamp = null;
  const plants = [...FALLBACK_PLANTS];
  const statsMap = computeAllStats(plants);
  return { plants, statsMap };
};

export const fetchGenerationHistory = async (plantId: string): Promise<MonthlyGeneration[]> => {
  const { data, error } = await supabase
    .from('monthly_generation')
    .select('month, mwh')
    .eq('plant_id', plantId)
    .order('month');

  if (error) throw error;
  return (data ?? []).map(r => ({ month: r.month as string, mwh: r.mwh as number | null }));
};

export const fetchRegionalTrend = async (
  region: string,
  fuelSource: string
): Promise<{ month: string; factor: number }[]> => {
  const { data, error } = await supabase.rpc('get_regional_trend', {
    p_region: region,
    p_fuel_source: fuelSource,
  });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ month: r.month, factor: r.avg_factor ?? 0 }));
};

export const fetchSubRegionalTrend = async (
  region: string,
  subRegion: string,
  fuelSource: string
): Promise<{ month: string; factor: number }[]> => {
  const { data, error } = await supabase.rpc('get_subregional_trend', {
    p_region: region,
    p_sub_region: subRegion,
    p_fuel_source: fuelSource,
  });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ month: r.month, factor: r.avg_factor ?? 0 }));
};

/**
 * Build a per-region+fuel monthly average CF map from all plants.
 * Only months where a plant actually generated (CF > 2%) contribute.
 * Returns Map< "region-fuel" → Map< "YYYY-MM" → avgCF > >
 */
export function computeRegionalMonthlyAverages(
  plants: PowerPlant[]
): Map<string, Map<string, number>> {
  const accum = new Map<string, Map<string, { sum: number; count: number }>>();

  for (const plant of plants) {
    const key = `${plant.region}-${plant.fuelSource}`;
    if (!accum.has(key)) accum.set(key, new Map());
    const monthMap = accum.get(key)!;

    for (const h of plant.generationHistory) {
      if (h.mwh === null || h.mwh === 0) continue;
      const [yr, mo] = h.month.split('-').map(Number);
      const days = new Date(yr, mo, 0).getDate();
      const max = plant.nameplateCapacityMW * days * 24;
      if (max <= 0) continue;
      const cf = Math.min(1, Math.max(0, h.mwh / max));
      if (cf < 0.02) continue;
      const prev = monthMap.get(h.month) ?? { sum: 0, count: 0 };
      monthMap.set(h.month, { sum: prev.sum + cf, count: prev.count + 1 });
    }
  }

  const result = new Map<string, Map<string, number>>();
  for (const [key, monthMap] of accum) {
    const avgMap = new Map<string, number>();
    for (const [month, { sum, count }] of monthMap) {
      avgMap.set(month, sum / count);
    }
    result.set(key, avgMap);
  }
  return result;
}

/**
 * Compute stats for all plants at once, using regional peer averages as the benchmark.
 * Use this instead of calling calculateCapacityFactorStats per-plant when you have
 * the full plant list available (static JSON / fallback data paths).
 */
export function computeAllStats(plants: PowerPlant[]): Record<string, CapacityFactorStats> {
  const regionalAvgMaps = computeRegionalMonthlyAverages(plants);
  const map: Record<string, CapacityFactorStats> = {};
  for (const plant of plants) {
    const key = `${plant.region}-${plant.fuelSource}`;
    map[plant.id] = calculateCapacityFactorStats(plant, regionalAvgMaps.get(key));
  }
  return map;
}

/**
 * Compute capacity factor stats for a single plant.
 * Pass `regionalAvgByMonth` (month → avg CF) to use regional peer comparison;
 * falls back to national typical CF when omitted or incomplete.
 */
export const calculateCapacityFactorStats = (
  plant: PowerPlant,
  regionalAvgByMonth?: Map<string, number>
): CapacityFactorStats => {
  const history = plant.generationHistory;

  const monthlyFactors = history.map(h => {
    if (h.mwh === null) return { month: h.month, factor: null };
    const [yearStr, monthStr] = h.month.split('-');
    const year = parseInt(yearStr, 10);
    const monthNum = parseInt(monthStr, 10);
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    const hoursInMonth = daysInMonth * 24;
    const maxGeneration = plant.nameplateCapacityMW * hoursInMonth;
    const factor = maxGeneration > 0 ? h.mwh / maxGeneration : 0;
    return { month: h.month, factor: Math.min(Math.max(factor, 0), 1) };
  });

  const ttmSlice = monthlyFactors.slice(-12);
  const ttmData = ttmSlice.filter((f): f is { month: string; factor: number } => f.factor !== null);
  const ttmAverage = ttmData.length > 0
    ? ttmData.reduce((acc, curr) => acc + curr.factor, 0) / ttmData.length
    : 0;

  // Trailing consecutive zero/null months → planned maintenance or extended offline period
  const ttmRaw = history.slice(-12);
  let trailingZeroCount = 0;
  for (let i = ttmRaw.length - 1; i >= 0; i--) {
    const h = ttmRaw[i];
    if (h.mwh === null || h.mwh === 0) trailingZeroCount++;
    else break;
  }
  const isMaintenanceOffline = trailingZeroCount >= 3;

  // Active months: months in TTM where the plant was actually generating (CF > 2%)
  const activeTtmMonths = ttmSlice.filter(
    (f): f is { month: string; factor: number } => f.factor !== null && f.factor > 0.02
  );
  const hasEnoughData = activeTtmMonths.length >= 6;

  // Insufficient signal — not in maintenance, just not enough reporting history
  const hasNoRecentData = !isMaintenanceOffline && !hasEnoughData;

  // Regional benchmark: average CF for this region+fuel on the same active months
  const typical = TYPICAL_CAPACITY_FACTORS[plant.fuelSource];
  let regionalRef = typical;
  if (regionalAvgByMonth && activeTtmMonths.length > 0) {
    const regionVals = activeTtmMonths
      .map(f => regionalAvgByMonth.get(f.month))
      .filter((v): v is number => v !== undefined);
    if (regionVals.length > 0) {
      regionalRef = regionVals.reduce((a, b) => a + b, 0) / regionVals.length;
    }
  }

  const activeAvgCF = hasEnoughData
    ? activeTtmMonths.reduce((a, b) => a + b.factor, 0) / activeTtmMonths.length
    : ttmAverage;

  // Curtailed = generating plant consistently underperforming regional peers by >20%
  const isLikelyCurtailed =
    !isMaintenanceOffline && hasEnoughData && activeAvgCF < regionalRef * 0.80;

  const curtailmentScore =
    isMaintenanceOffline || !hasEnoughData
      ? 0
      : Math.round(Math.min(100, Math.max(0, ((regionalRef - activeAvgCF) / regionalRef) * 100)));

  return {
    plantId: plant.id,
    monthlyFactors,
    ttmAverage,
    isLikelyCurtailed,
    curtailmentScore,
    hasNoRecentData,
    isMaintenanceOffline,
  };
};