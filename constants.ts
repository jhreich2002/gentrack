
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
  Region.ISONE
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
  [Region.Southwest]: ['Arizona/Nevada', 'New Mexico'],
  [Region.Southeast]: ['Florida', 'Carolinas', 'Deep South']
};

export const FUEL_SOURCES: FuelSource[] = [
  FuelSource.Wind,
  FuelSource.Solar,
  FuelSource.Nuclear
];

export const OWNERS = [
  "NextEra Energy", "Duke Energy", "Vistra Corp", "Exelon", "Dominion Energy",
  "Southern Company", "Constellation Energy", "NRG Energy", "Avangrid", "Brookfield Renewable"
];

// Typical expected TTM Capacity Factors for identifying curtailment
export const TYPICAL_CAPACITY_FACTORS = {
  [FuelSource.Wind]: 0.35,
  [FuelSource.Solar]: 0.22,
  [FuelSource.Nuclear]: 0.92
};

export const COLORS = {
  [FuelSource.Wind]: '#38bdf8',
  [FuelSource.Solar]: '#facc15',
  [FuelSource.Nuclear]: '#4ade80',
  curtailed: '#f87171',
  normal: '#94a3b8'
};
