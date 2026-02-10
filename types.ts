
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
  ISONE = 'ISO-NE'
}

export enum FuelSource {
  Wind = 'Wind',
  Solar = 'Solar',
  Nuclear = 'Nuclear'
}

export interface MonthlyGeneration {
  month: string; // YYYY-MM
  mwh: number;
}

export interface PowerPlant {
  id: string;
  eiaPlantCode: string; // EIA plant code from Form EIA-923
  name: string;
  owner: string;
  region: Region;
  subRegion: string;
  fuelSource: FuelSource;
  nameplateCapacityMW: number;
  generationHistory: MonthlyGeneration[];
  location: {
    state: string;
    lat: number;
    lng: number;
  };
}

export interface CapacityFactorStats {
  plantId: string;
  monthlyFactors: { month: string; factor: number }[];
  ttmAverage: number; // Trailing 12 Month Average
  isLikelyCurtailed: boolean;
  curtailmentScore: number; // 0 to 100
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
