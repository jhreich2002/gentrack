// Fallback/seed data using real US power plant names and realistic generation figures.
// This data is used when the EIA API is slow or unavailable, ensuring the app loads instantly.
// Sources: EIA-923, EIA-860 public data for major US wind, solar, and nuclear facilities.

import { PowerPlant, Region, FuelSource, MonthlyGeneration } from '../types';

// Generate realistic monthly generation history (24 months) for a plant
function generateHistory(capacityMW: number, fuelSource: FuelSource, startYear: number = 2024): MonthlyGeneration[] {
  const months: MonthlyGeneration[] = [];

  // Seasonal capacity factor patterns by fuel type
  const seasonalPatterns: Record<FuelSource, number[]> = {
    [FuelSource.Solar]: [0.12, 0.15, 0.20, 0.24, 0.27, 0.28, 0.27, 0.25, 0.22, 0.18, 0.13, 0.11],
    [FuelSource.Wind]:  [0.38, 0.36, 0.40, 0.38, 0.32, 0.28, 0.25, 0.26, 0.30, 0.34, 0.37, 0.39],
    [FuelSource.Nuclear]: [0.92, 0.93, 0.88, 0.91, 0.94, 0.93, 0.92, 0.91, 0.93, 0.94, 0.92, 0.90],
  };

  const hoursInMonth = [744, 672, 744, 720, 744, 720, 744, 744, 720, 744, 720, 744];
  const pattern = seasonalPatterns[fuelSource];

  for (let y = 0; y < 2; y++) {
    const year = startYear + y;
    for (let m = 0; m < 12; m++) {
      // Add some random variation (±10%)
      const variation = 0.9 + Math.random() * 0.2;
      const cf = pattern[m] * variation;
      const mwh = capacityMW * hoursInMonth[m] * cf;
      months.push({
        month: `${year}-${String(m + 1).padStart(2, '0')}`,
        mwh: Math.round(mwh),
      });
    }
  }

  return months;
}

export const FALLBACK_PLANTS: PowerPlant[] = [
  // ======================== SOLAR ========================
  {
    id: 'EIA-62135', eiaPlantCode: '62135', name: 'Solar Star', owner: 'BHE Renewables',
    region: Region.CAISO, subRegion: 'SP15', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 579,
    generationHistory: generateHistory(579, FuelSource.Solar),
    location: { state: 'CA', lat: 34.83, lng: -118.39 },
  },
  {
    id: 'EIA-57373', eiaPlantCode: '57373', name: 'Topaz Solar Farm', owner: 'BHE Renewables',
    region: Region.CAISO, subRegion: 'SP15', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 550,
    generationHistory: generateHistory(550, FuelSource.Solar),
    location: { state: 'CA', lat: 35.38, lng: -120.04 },
  },
  {
    id: 'EIA-57372', eiaPlantCode: '57372', name: 'Desert Sunlight Solar Farm', owner: 'NextEra Energy',
    region: Region.CAISO, subRegion: 'SP15', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 550,
    generationHistory: generateHistory(550, FuelSource.Solar),
    location: { state: 'CA', lat: 33.83, lng: -115.39 },
  },
  {
    id: 'EIA-61603', eiaPlantCode: '61603', name: 'Copper Mountain Solar', owner: 'Sempra Energy',
    region: Region.Southwest, subRegion: 'Arizona/Nevada', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 458,
    generationHistory: generateHistory(458, FuelSource.Solar),
    location: { state: 'NV', lat: 35.79, lng: -115.44 },
  },
  {
    id: 'EIA-61802', eiaPlantCode: '61802', name: 'Mesquite Solar', owner: 'Sempra Energy',
    region: Region.Southwest, subRegion: 'Arizona/Nevada', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 400,
    generationHistory: generateHistory(400, FuelSource.Solar),
    location: { state: 'AZ', lat: 32.95, lng: -112.75 },
  },
  {
    id: 'EIA-64501', eiaPlantCode: '64501', name: 'Roadrunner Solar', owner: 'Enel Green Power',
    region: Region.Southwest, subRegion: 'New Mexico', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 497,
    generationHistory: generateHistory(497, FuelSource.Solar),
    location: { state: 'NM', lat: 32.60, lng: -107.30 },
  },
  {
    id: 'EIA-65210', eiaPlantCode: '65210', name: 'Samson Solar Energy Center', owner: 'Invenergy',
    region: Region.ERCOT, subRegion: 'North', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 1310,
    generationHistory: generateHistory(1310, FuelSource.Solar),
    location: { state: 'TX', lat: 33.50, lng: -95.80 },
  },
  {
    id: 'EIA-63550', eiaPlantCode: '63550', name: 'Oberon Solar', owner: 'IP Oberon LLC',
    region: Region.CAISO, subRegion: 'SP15', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 500,
    generationHistory: generateHistory(500, FuelSource.Solar),
    location: { state: 'CA', lat: 33.10, lng: -115.50 },
  },
  {
    id: 'EIA-66200', eiaPlantCode: '66200', name: 'Permian Energy Center', owner: 'Vistra Corp',
    region: Region.ERCOT, subRegion: 'West', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 460,
    generationHistory: generateHistory(460, FuelSource.Solar),
    location: { state: 'TX', lat: 31.70, lng: -103.20 },
  },
  {
    id: 'EIA-66050', eiaPlantCode: '66050', name: 'Thunderhead Solar', owner: 'NextEra Energy',
    region: Region.Southeast, subRegion: 'Florida', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 375,
    generationHistory: generateHistory(375, FuelSource.Solar),
    location: { state: 'FL', lat: 27.50, lng: -81.50 },
  },
  {
    id: 'EIA-63410', eiaPlantCode: '63410', name: 'Phoebe Solar', owner: 'Longroad Energy',
    region: Region.ERCOT, subRegion: 'West', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 316,
    generationHistory: generateHistory(316, FuelSource.Solar),
    location: { state: 'TX', lat: 31.85, lng: -102.80 },
  },
  {
    id: 'EIA-65400', eiaPlantCode: '65400', name: 'Spotsylvania Solar', owner: 'sPower',
    region: Region.PJM, subRegion: 'Southern', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 500,
    generationHistory: generateHistory(500, FuelSource.Solar),
    location: { state: 'VA', lat: 38.20, lng: -77.70 },
  },
  {
    id: 'EIA-63800', eiaPlantCode: '63800', name: 'Badger Hollow Solar', owner: 'Invenergy',
    region: Region.MISO, subRegion: 'North', fuelSource: FuelSource.Solar,
    nameplateCapacityMW: 300,
    generationHistory: generateHistory(300, FuelSource.Solar),
    location: { state: 'WI', lat: 43.20, lng: -90.50 },
  },

  // ======================== WIND ========================
  {
    id: 'EIA-57265', eiaPlantCode: '57265', name: 'Alta Wind Energy Center', owner: 'TerraGen',
    region: Region.CAISO, subRegion: 'SP15', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 1548,
    generationHistory: generateHistory(1548, FuelSource.Wind),
    location: { state: 'CA', lat: 35.08, lng: -118.38 },
  },
  {
    id: 'EIA-56564', eiaPlantCode: '56564', name: 'Shepherds Flat Wind Farm', owner: 'Caithness Energy',
    region: Region.Northwest, subRegion: 'Inland PNW', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 845,
    generationHistory: generateHistory(845, FuelSource.Wind),
    location: { state: 'OR', lat: 45.38, lng: -120.20 },
  },
  {
    id: 'EIA-57070', eiaPlantCode: '57070', name: 'Roscoe Wind Farm', owner: 'RWE Renewables',
    region: Region.ERCOT, subRegion: 'West', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 782,
    generationHistory: generateHistory(782, FuelSource.Wind),
    location: { state: 'TX', lat: 32.45, lng: -100.53 },
  },
  {
    id: 'EIA-57628', eiaPlantCode: '57628', name: 'Horse Hollow Wind Energy Center', owner: 'NextEra Energy',
    region: Region.ERCOT, subRegion: 'West', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 736,
    generationHistory: generateHistory(736, FuelSource.Wind),
    location: { state: 'TX', lat: 32.08, lng: -100.25 },
  },
  {
    id: 'EIA-56338', eiaPlantCode: '56338', name: 'Capricorn Ridge Wind Farm', owner: 'NextEra Energy',
    region: Region.ERCOT, subRegion: 'West', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 663,
    generationHistory: generateHistory(663, FuelSource.Wind),
    location: { state: 'TX', lat: 32.18, lng: -100.78 },
  },
  {
    id: 'EIA-60207', eiaPlantCode: '60207', name: 'Flat Ridge 2 Wind Farm', owner: 'BP Wind Energy',
    region: Region.SPP, subRegion: 'South', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 470,
    generationHistory: generateHistory(470, FuelSource.Wind),
    location: { state: 'KS', lat: 37.40, lng: -97.30 },
  },
  {
    id: 'EIA-57543', eiaPlantCode: '57543', name: 'Fowler Ridge Wind Farm', owner: 'BP Wind Energy',
    region: Region.MISO, subRegion: 'Central', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 600,
    generationHistory: generateHistory(600, FuelSource.Wind),
    location: { state: 'IN', lat: 40.53, lng: -87.38 },
  },
  {
    id: 'EIA-59512', eiaPlantCode: '59512', name: 'Grand Ridge Wind Farm', owner: 'Invenergy',
    region: Region.MISO, subRegion: 'Central', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 211,
    generationHistory: generateHistory(211, FuelSource.Wind),
    location: { state: 'IL', lat: 41.22, lng: -88.72 },
  },
  {
    id: 'EIA-61301', eiaPlantCode: '61301', name: 'Western Trail Wind', owner: 'Enel Green Power',
    region: Region.ERCOT, subRegion: 'North', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 367,
    generationHistory: generateHistory(367, FuelSource.Wind),
    location: { state: 'TX', lat: 33.70, lng: -99.50 },
  },
  {
    id: 'EIA-55849', eiaPlantCode: '55849', name: 'Maple Ridge Wind Farm', owner: 'Avangrid',
    region: Region.NYISO, subRegion: 'Upstate', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 322,
    generationHistory: generateHistory(322, FuelSource.Wind),
    location: { state: 'NY', lat: 43.82, lng: -75.60 },
  },
  {
    id: 'EIA-59305', eiaPlantCode: '59305', name: 'Kibby Wind Power', owner: 'TransAlta',
    region: Region.ISONE, subRegion: 'Maine/NH', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 132,
    generationHistory: generateHistory(132, FuelSource.Wind),
    location: { state: 'ME', lat: 45.20, lng: -70.30 },
  },
  {
    id: 'EIA-60804', eiaPlantCode: '60804', name: 'Glacier Hills Wind Park', owner: 'DTE Energy',
    region: Region.MISO, subRegion: 'North', fuelSource: FuelSource.Wind,
    nameplateCapacityMW: 113,
    generationHistory: generateHistory(113, FuelSource.Wind),
    location: { state: 'MI', lat: 43.60, lng: -83.40 },
  },

  // ======================== NUCLEAR ========================
  {
    id: 'EIA-6008', eiaPlantCode: '6008', name: 'Palo Verde', owner: 'Arizona Public Service',
    region: Region.Southwest, subRegion: 'Arizona/Nevada', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 3937,
    generationHistory: generateHistory(3937, FuelSource.Nuclear),
    location: { state: 'AZ', lat: 33.39, lng: -112.86 },
  },
  {
    id: 'EIA-6022', eiaPlantCode: '6022', name: 'South Texas Nuclear', owner: 'NRG Energy',
    region: Region.ERCOT, subRegion: 'Coast', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 2708,
    generationHistory: generateHistory(2708, FuelSource.Nuclear),
    location: { state: 'TX', lat: 28.80, lng: -96.05 },
  },
  {
    id: 'EIA-6146', eiaPlantCode: '6146', name: 'Braidwood', owner: 'Constellation Energy',
    region: Region.PJM, subRegion: 'Western', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 2389,
    generationHistory: generateHistory(2389, FuelSource.Nuclear),
    location: { state: 'IL', lat: 41.24, lng: -88.21 },
  },
  {
    id: 'EIA-6016', eiaPlantCode: '6016', name: 'Byron', owner: 'Constellation Energy',
    region: Region.PJM, subRegion: 'Western', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 2347,
    generationHistory: generateHistory(2347, FuelSource.Nuclear),
    location: { state: 'IL', lat: 42.08, lng: -89.28 },
  },
  {
    id: 'EIA-6004', eiaPlantCode: '6004', name: 'Vogtle', owner: 'Southern Company',
    region: Region.Southeast, subRegion: 'Deep South', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 4680,
    generationHistory: generateHistory(4680, FuelSource.Nuclear),
    location: { state: 'GA', lat: 33.14, lng: -81.76 },
  },
  {
    id: 'EIA-3483', eiaPlantCode: '3483', name: 'Limerick', owner: 'Constellation Energy',
    region: Region.PJM, subRegion: 'Mid-Atlantic', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 2264,
    generationHistory: generateHistory(2264, FuelSource.Nuclear),
    location: { state: 'PA', lat: 40.23, lng: -75.59 },
  },
  {
    id: 'EIA-2589', eiaPlantCode: '2589', name: 'Millstone', owner: 'Dominion Energy',
    region: Region.ISONE, subRegion: 'VT/CT/RI', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 2099,
    generationHistory: generateHistory(2099, FuelSource.Nuclear),
    location: { state: 'CT', lat: 41.31, lng: -72.17 },
  },
  {
    id: 'EIA-2503', eiaPlantCode: '2503', name: 'Indian Point', owner: 'Entergy',
    region: Region.NYISO, subRegion: 'Hudson Valley', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 2069,
    generationHistory: generateHistory(2069, FuelSource.Nuclear),
    location: { state: 'NY', lat: 41.27, lng: -73.95 },
  },
  {
    id: 'EIA-6155', eiaPlantCode: '6155', name: 'Comanche Peak', owner: 'Vistra Corp',
    region: Region.ERCOT, subRegion: 'North', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 2430,
    generationHistory: generateHistory(2430, FuelSource.Nuclear),
    location: { state: 'TX', lat: 32.30, lng: -97.78 },
  },
  {
    id: 'EIA-6101', eiaPlantCode: '6101', name: 'McGuire Nuclear Station', owner: 'Duke Energy',
    region: Region.Southeast, subRegion: 'Carolinas', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 2258,
    generationHistory: generateHistory(2258, FuelSource.Nuclear),
    location: { state: 'NC', lat: 35.43, lng: -80.95 },
  },
  {
    id: 'EIA-6052', eiaPlantCode: '6052', name: 'Waterford', owner: 'Entergy',
    region: Region.Southeast, subRegion: 'Deep South', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 1168,
    generationHistory: generateHistory(1168, FuelSource.Nuclear),
    location: { state: 'LA', lat: 29.99, lng: -90.47 },
  },
  {
    id: 'EIA-6042', eiaPlantCode: '6042', name: 'Grand Gulf', owner: 'Entergy',
    region: Region.Southeast, subRegion: 'Deep South', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 1419,
    generationHistory: generateHistory(1419, FuelSource.Nuclear),
    location: { state: 'MS', lat: 32.01, lng: -91.05 },
  },
  {
    id: 'EIA-3494', eiaPlantCode: '3494', name: 'Peach Bottom', owner: 'Constellation Energy',
    region: Region.PJM, subRegion: 'Mid-Atlantic', fuelSource: FuelSource.Nuclear,
    nameplateCapacityMW: 2779,
    generationHistory: generateHistory(2779, FuelSource.Nuclear),
    location: { state: 'PA', lat: 39.76, lng: -76.27 },
  },
];
