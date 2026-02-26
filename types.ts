
export enum Region {
  Northwest = 'Northwest',
  CAISO = 'CAISO',
  Southwest = 'Southwest',
  ERCOT = 'ERCOT',
  SPP = 'SPP',
  MISO = 'MISO',
  Southeast = 'Southeast',
  PJM = 'PJM',
  NYISO = 'NYISO',
  ISONE = 'ISO-NE',
  Hawaii = 'Hawaii',
  Alaska = 'Alaska'
}

export enum FuelSource {
  Wind = 'Wind',
  Solar = 'Solar',
  Nuclear = 'Nuclear'
}

export interface MonthlyGeneration {
  month: string; // YYYY-MM
  mwh: number | null; // null = EIA did not report generation for this month
}

export interface PlantOwner {
  name: string;
  percent: number;
}

export interface PowerPlant {
  id: string;
  eiaPlantCode: string; // EIA plant code from Form EIA-923 / EIA-860
  operatorId?: string;   // EIA entity ID from EIA-860 (entityid)
  name: string;
  owner: string;        // Majority owner entity name from EIA-860
  owners?: PlantOwner[]; // All owners with percentages from EIA-860 Schedule 2
  region: Region;
  subRegion: string;
  fuelSource: FuelSource;
  nameplateCapacityMW: number; // Actual nameplate from EIA-860 (sum of all generators)
  cod?: string;         // Commercial Operation Date (YYYY-MM), earliest generator at plant
  county?: string;      // County from EIA-860
  generationHistory: MonthlyGeneration[];
  location: {
    state: string;
    county?: string;
    lat: number;
    lng: number;
  };
}

export interface CapacityFactorStats {
  plantId: string;
  monthlyFactors: { month: string; factor: number | null }[]; // null = no EIA data for that month
  ttmAverage: number; // Trailing 12 Month Average
  isLikelyCurtailed: boolean;
  curtailmentScore: number; // 0 to 100 — deficit vs regional avg on active months
  hasNoRecentData: boolean; // true when <6 active TTM months and not in maintenance
  isMaintenanceOffline: boolean; // true when ≥3 trailing consecutive zero/null months (planned outage)
  trailingZeroMonths: number; // count of consecutive trailing zero/null months
}

export interface AnalysisResult {
  summary: string;
  outliers: string[];
  recommendations: string[];
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
}

export interface NewsAnalysis {
  summary: string;
  items: NewsItem[];
}
