import { PowerPlant, Region, FuelSource, CapacityFactorStats, MonthlyGeneration } from '../types';
import { TYPICAL_CAPACITY_FACTORS, SUBREGIONS } from '../constants';
import { FALLBACK_PLANTS } from './fallbackData';

// -------------------------------------------------------------------
// Static data loading
// -------------------------------------------------------------------
// The app reads from /data/plants.json, which is generated monthly
// by scripts/fetch-eia-data.ts (run via GitHub Actions cron).
// If that file is missing or invalid, the built-in fallback data is used.

interface DataManifest {
  fetchedAt: string;
  plantCount: number;
  fuelBreakdown: Record<string, number>;
  plants: PowerPlant[];
}

let _dataTimestamp: string | null = null;

/** Returns the ISO timestamp of when the static data was last fetched */
export function getDataTimestamp(): string | null {
  return _dataTimestamp;
}

// --- Core: Load plants from static JSON, fall back to built-in data ---
export const fetchPowerPlants = async (): Promise<PowerPlant[]> => {
  try {
    const res = await fetch('/data/plants.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const manifest: DataManifest = await res.json();

    if (manifest.plants && manifest.plants.length > 0) {
      _dataTimestamp = manifest.fetchedAt || null;
      console.log(
        `[GenTrack] Loaded ${manifest.plantCount} plants from static data (fetched ${manifest.fetchedAt})`
      );
      // Map region strings back to enum values
      return manifest.plants.map(p => ({
        ...p,
        region: p.region as Region,
        fuelSource: p.fuelSource as FuelSource,
      }));
    }
  } catch (err) {
    console.warn('[GenTrack] Could not load /data/plants.json, using fallback:', err);
  }

  // Fallback to built-in data
  console.log('[GenTrack] Using built-in fallback data (' + FALLBACK_PLANTS.length + ' plants)');
  _dataTimestamp = null;
  return [...FALLBACK_PLANTS];
};

// --- Calculate Capacity Factor Stats from plant data ---
export const calculateCapacityFactorStats = (plant: PowerPlant): CapacityFactorStats => {
  const history = plant.generationHistory;

  const monthlyFactors = history.map(h => {
    // Months with no EIA data are passed through as null — excluded from all calculations
    if (h.mwh === null) {
      return { month: h.month, factor: null };
    }
    const [yearStr, monthStr] = h.month.split('-');
    const year = parseInt(yearStr, 10);
    const monthNum = parseInt(monthStr, 10);
    // new Date(year, monthNum, 0) gives the last day of the month — handles leap years correctly
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    const hoursInMonth = daysInMonth * 24;
    const maxGeneration = plant.nameplateCapacityMW * hoursInMonth;
    const factor = maxGeneration > 0 ? h.mwh / maxGeneration : 0;
    return {
      month: h.month,
      factor: Math.min(Math.max(factor, 0), 1),
    };
  });

  // TTM: only include months that have real EIA data
  const ttmData = monthlyFactors.slice(-12).filter((f): f is { month: string; factor: number } => f.factor !== null);
  const ttmAverage = ttmData.length > 0
    ? ttmData.reduce((acc, curr) => acc + curr.factor, 0) / ttmData.length
    : 0;

  const typical = TYPICAL_CAPACITY_FACTORS[plant.fuelSource];
  const isLikelyCurtailed = ttmAverage < (typical * 0.7);
  const curtailmentScore = Math.min(100, Math.max(0, ((typical - ttmAverage) / typical) * 100));

  return {
    plantId: plant.id,
    monthlyFactors,
    ttmAverage,
    isLikelyCurtailed,
    curtailmentScore: Math.round(curtailmentScore),
  };
};
