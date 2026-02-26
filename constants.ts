
import { Region, FuelSource } from './types';

export const REGIONS: Region[] = [
  Region.Northwest,
  Region.CAISO,
  Region.Southwest,
  Region.ERCOT,
  Region.SPP,
  Region.MISO,
  Region.Southeast,
  Region.PJM,
  Region.NYISO,
  Region.ISONE,
  Region.Hawaii,
  Region.Alaska
];

export const SUBREGIONS: Record<Region, string[]> = {
  [Region.CAISO]: ['NP15', 'SP15', 'ZP26'],
  [Region.ERCOT]: ['West', 'North', 'South', 'Coast'],
  [Region.PJM]: ['Mid-Atlantic', 'Western', 'Southern'],
  [Region.MISO]: ['North', 'Central', 'South'],
  [Region.NYISO]: ['Upstate', 'Hudson Valley', 'NYC/Long Island'],
  [Region.ISONE]: ['Maine/NH', 'VT/CT/RI', 'Massachusetts'],
  [Region.SPP]: ['North', 'Central', 'South'],
  [Region.Northwest]: ['WA/OR Coast', 'Inland PNW', 'Mountain'],
  [Region.Southwest]: ['Arizona/Nevada', 'New Mexico', 'Colorado'],
  [Region.Southeast]: ['Florida', 'Carolinas', 'Deep South'],
  [Region.Hawaii]: ['Oahu', 'Maui', 'Big Island'],
  [Region.Alaska]: ['Railbelt', 'Remote']
};

export const FUEL_SOURCES: FuelSource[] = [
  FuelSource.Wind,
  FuelSource.Solar,
  FuelSource.Nuclear,
];

// Top operators — dynamically populated in the app from loaded data.
// This fallback list is used when no plants are loaded yet.
export const DEFAULT_OWNERS = [
  "NextEra Energy", "Duke Energy", "Vistra Corp", "Exelon", "Dominion Energy",
  "Southern Company", "Constellation Energy", "NRG Energy", "Avangrid", "Brookfield Renewable",
  "AES Corporation", "Berkshire Hathaway Energy", "Enel", "Invenergy", "Pattern Energy"
];

// Typical expected TTM Capacity Factors for identifying curtailment
export const TYPICAL_CAPACITY_FACTORS: Record<FuelSource, number> = {
  [FuelSource.Wind]: 0.35,
  [FuelSource.Solar]: 0.22,
  [FuelSource.Nuclear]: 0.92,
};

export const COLORS: Record<string, string> = {
  [FuelSource.Wind]: '#38bdf8',
  [FuelSource.Solar]: '#facc15',
  [FuelSource.Nuclear]: '#4ade80',
  curtailed: '#f87171',
  normal: '#94a3b8'
};

// First month of available EIA generation data
export const EIA_START_MONTH = '2024-01';

/**
 * Format a YYYY-MM string as a short month + year label, e.g. "Jan 2024".
 * Safe for use in Recharts tickFormatter and labelFormatter.
 */
export function formatMonthYear(yyyyMm: string): string {
  const [year, month] = yyyyMm.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
