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
  // A plant with ttm_avg_factor === 0 had no reported generation in the trailing 12 months.
  // Treat it as "no recent data" rather than "curtailed" so it doesn't pollute curtailment analysis.
  const hasNoRecentData = row.ttm_avg_factor === 0;
  return {
    plantId: row.id,
    monthlyFactors: [],
    ttmAverage: row.ttm_avg_factor,
    isLikelyCurtailed: hasNoRecentData ? false : row.is_likely_curtailed,
    curtailmentScore: hasNoRecentData ? 0 : row.curtailment_score,
    hasNoRecentData,
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
      const statsMap: Record<string, CapacityFactorStats> = {};
      plants.forEach(p => { statsMap[p.id] = calculateCapacityFactorStats(p); });
      console.log(`[GenTrack] Loaded ${plants.length} plants from static JSON`);
      return { plants, statsMap };
    }
  } catch (err) {
    console.warn('[GenTrack] Static JSON unavailable:', err);
  }

  console.log(`[GenTrack] Using built-in fallback data (${FALLBACK_PLANTS.length} plants)`);
  _dataTimestamp = null;
  const plants = [...FALLBACK_PLANTS];
  const statsMap: Record<string, CapacityFactorStats> = {};
  plants.forEach(p => { statsMap[p.id] = calculateCapacityFactorStats(p); });
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

export const calculateCapacityFactorStats = (plant: PowerPlant): CapacityFactorStats => {
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

  // A plant whose entire TTM window contains only null or 0-MWh months has no reported generation.
  // Mark it distinctly so it doesn't distort curtailment analysis.
  const ttmRaw = history.slice(-12);
  const hasNoRecentData = ttmRaw.length === 0 || ttmRaw.every(h => h.mwh === null || h.mwh === 0);

  const typical = TYPICAL_CAPACITY_FACTORS[plant.fuelSource];
  const isLikelyCurtailed = hasNoRecentData ? false : ttmAverage < typical * 0.7;
  const curtailmentScore = hasNoRecentData ? 0 : Math.min(100, Math.max(0, ((typical - ttmAverage) / typical) * 100));

  return {
    plantId: plant.id,
    monthlyFactors,
    ttmAverage,
    isLikelyCurtailed,
    curtailmentScore: Math.round(curtailmentScore),
    hasNoRecentData,
  };
};