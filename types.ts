
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
  dataMonthsCount: number; // count of months with non-null mwh across full EIA history
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

// ── News Intelligence ────────────────────────────────────────────────────────

/** A single stored news article from the news_articles Supabase table. */
export interface NewsArticle {
  id:                   string;
  title:                string;
  description:          string | null;
  url:                  string;
  sourceName:           string | null;
  publishedAt:          string;           // ISO-8601 timestamp
  topics:               string[];         // outage | regulatory | financial | weather | construction | other
  sentimentLabel:       'positive' | 'negative' | 'neutral' | null;
  // LLM-generated classification (Day 1)
  eventType:            string | null;    // outage|regulatory|financial|m_and_a|dispute|construction|policy|restructuring|none
  impactTags:           string[];         // distress|asset_sale|capacity_addition|curtailment|ppa_dispute|…
  ftiRelevanceTags:     string[];         // restructuring|transactions|disputes|market_strategy
  importance:           'low' | 'medium' | 'high' | null;
  entityCompanyNames:   string[];         // ult_parent names mentioned in article
  lenders?:             string[];         // lender/financier names extracted from article
  // plant-news-rank classification
  assetLinkageTier?:      'high' | 'medium' | 'none' | null;
  assetLinkageRationale?: string | null;
  curtailmentRelevant?:   boolean;
  curtailmentRationale?:  string | null;
  relevanceScore?:        number | null;   // 0.0–1.0
  includeForEmbedding?:   boolean;
  categories?:            string[];
  tags?:                  string[];
  articleSummary?:        string | null;
}

/** Structured financing deal extracted by LLM from article context. */
export interface FinancingDeal {
  amount:          string;        // e.g. "$440M", "undisclosed"
  type:            string;        // e.g. "Tax Equity", "Credit Facility", "Construction Loan"
  lenderInvestor:  string;        // e.g. "U.S. Bank", "JPMorgan"
  sourceTitle:     string;        // article title for display
  sourceUrl:       string;        // article URL — clickable link
}

/** Precomputed risk rating from the plant_news_ratings Supabase table. */
export interface PlantNewsRating {
  eiaPlantCode:  string;
  articles30d:   number;
  negative30d:   number;
  outage30d:     number;
  articles90d:   number;
  negative90d:   number;
  outage90d:     number;
  articles365d:  number;
  negative365d:  number;
  outage365d:    number;
  newsRiskScore: number;   // 0–100 composite score
  topArticleIds: string[];
  computedAt:    string;   // ISO-8601 timestamp
}

/** Cached per-plant LLM summary from plant_news_state table. */
export interface PlantNewsState {
  eiaPlantCode:           string;
  lastCheckedAt:          string | null;    // ISO-8601
  summaryText:            string | null;    // 1-2 paragraph situation summary
  ftiAngleBullets:        string[];         // 3-5 advisory bullets
  summaryLastUpdatedAt:   string | null;
  lastEventTypes:         string[];         // event_types seen recently
  lastSentiment:          string | null;
  plantSummary?:          string | null;    // from plant-news-rank
  rankingLastRunAt?:      string | null;
}

/** Per-ult_parent nightly-computed metrics from company_stats table. */
export interface CompanyStats {
  ultParentName:    string;
  totalMw:          number;
  plantCount:       number;
  avgCf:            number;
  techBreakdown:    Record<string, number>;   // { Solar: 1200, Wind: 450 }
  stateBreakdown:   Record<string, number>;   // { CA: 800, TX: 850 }
  eventCounts:      Record<string, number>;   // { restructuring: 3, m_and_a: 1 }
  relevanceScores:  Record<string, number>;   // { restructuring: 72, transactions: 45 }
  computedAt:       string;
  // Day 4 — on-demand LLM advisory analysis
  analysisText:          string | null;
  analysisAngleBullets:  string[];
  analysisUpdatedAt:     string | null;
  portfolioSynopsis:     string | null;  // per-asset breakdown from company-analyze
}

// ── Entity Stats (Lenders & Tax Equity Investors) ────────────────────────────

/** Nightly-computed aggregate for a lender entity from plant_lenders. */
export interface LenderStats {
  lenderName:          string;
  assetCount:          number;
  totalExposureUsd:    number | null;
  plantCodes:          string[];
  facilityTypes:       string[];
  avgPlantCf:          number | null;
  pctCurtailed:        number;
  newsSentimentScore:  number | null;  // 0–100 (% positive articles × 100)
  distressScore:       number | null;  // 0–100 composite
  relevanceScores:     Record<string, number>;  // { restructuring, transactions, ... }
  analysisText:        string | null;
  analysisAngleBullets: string[];
  analysisUpdatedAt:   string | null;
  portfolioSynopsis:   string | null;  // per-asset breakdown from lender-analyze
  lastNewsDate:        string | null;
  computedAt:          string;
}

/** Nightly-computed aggregate for a tax equity investor from plant_lenders. */
export interface TaxEquityStats {
  investorName:          string;
  assetCount:            number;
  totalCommittedUsd:     number | null;
  plantCodes:            string[];
  portfolioAvgCf:        number | null;
  portfolioBenchmarkCf:  number | null;  // weighted regional avg
  pctCurtailed:          number;
  newsSentimentScore:    number | null;
  distressScore:         number | null;
  relevanceScores:       Record<string, number>;
  analysisText:          string | null;
  analysisAngleBullets:  string[];
  analysisUpdatedAt:     string | null;
  portfolioSynopsis:     string | null;  // per-asset breakdown from tax-equity-analyze
  lastNewsDate:          string | null;
  computedAt:            string;
}

/** Unified opportunity item for the Opportunities tab. */
export interface OpportunityItem {
  entityId:       string;   // lenderName | investorName | ult_parent_name | eia_plant_code
  entityType:     'plant' | 'owner' | 'tax_equity' | 'lender';
  entityName:     string;
  opportunityScore: number;       // 0–100 composite
  distressScore:  number | null;
  keySignal:      string | null;  // top recent headline or distress reason
  dollarsAtRisk:  number | null;  // total_exposure_usd or total_committed_usd or null
  lastNewsDate:   string | null;
  ftiServiceLines: string[];      // e.g. ['restructuring', 'disputes']
}

// ── Response types for entity analyze edge functions ─────────────────────────

export interface EntityAnalysisResponse {
  analysisText:        string;
  analysisAngleBullets: string[];
  portfolioSynopsis:   string | null;
  analysisUpdatedAt:   string;
  fromCache:           boolean;
}

export interface PlantOwnership {
  eiaPlantCode:                 string;
  powerPlant:                   string | null;
  plantKey:                     string | null;
  techType:                     string | null;
  plantOperator:                string | null;
  plantOperatorInstnKey:        string | null;
  operatorUltParent:            string | null;
  operatorUltParentInstnKey:    string | null;
  owner:                        string | null;
  operOwnPct:                   number | null;  // Operating ownership %
  ownerEiaUtilityCode:          string | null;
  ultParent:                    string | null;
  parentEiaUtilityCode:         string | null;
  ownStatus:                    string | null;
  plannedOwn:                   string | null;  // Planned ownership
  largestPpaCounterparty:       string | null;
  largestPpaCapacityMW:         number | null;
  largestPpaStartDate:          string | null;
  largestPpaExpirationDate:     string | null;
}
