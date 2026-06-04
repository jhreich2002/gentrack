/**
 * Mock data for dev-only preview of LenderValidatedDigestView.
 * Accessible at /?preview=lender-digest when running in development mode.
 * This file is NOT imported by any production code path.
 */

import {
  LenderValidatedDigest,
  DigestPlantRow,
  NewsArticle,
} from '../../../types';

// ── 24-month CF series ─────────────────────────────────────────────────────
// Portfolio CF trends from 22% → 28% with some noise; blended regional 24–26%.
// Using 2024-07 → 2026-06 (24 months).

const MONTHS: string[] = [];
for (let y = 2024; y <= 2026; y++) {
  const startM = y === 2024 ? 7 : 1;
  const endM   = y === 2026 ? 6 : 12;
  for (let m = startM; m <= endM; m++) {
    MONTHS.push(`${y}-${String(m).padStart(2, '0')}`);
  }
}

const portfolioBase = 22;
const regionalBase  = 24;

export const MOCK_CF_SERIES: LenderValidatedDigest['cfSeries'] = MONTHS.map((month, i) => {
  const trend = (i / (MONTHS.length - 1)) * 6; // +6 pp over 24 months
  const noise = Math.sin(i * 0.9) * 1.8;
  const portfolioCf = Math.round((portfolioBase + trend + noise) * 10) / 10;
  const regNoise    = Math.sin(i * 0.5) * 1.2;
  const blendedRegionalCf = Math.round((regionalBase + trend * 0.4 + regNoise) * 10) / 10;
  return { month, portfolioCf, blendedRegionalCf };
});

// ── Mock plants (6–8 across 3 regions) ─────────────────────────────────────

export const MOCK_PLANTS: DigestPlantRow[] = [
  {
    plantId:        'plant-01',
    eiaPlantCode:   '57394',
    plantName:      'Mesquite Star Wind Farm',
    state:          'TX',
    fuelSource:     'Wind',
    nameplateMw:    350,
    role:           'Senior Debt',
    ttmCf:          29.4,
    regionalCf:     26.1,
    cfDeltaPp:      3.3,
    newsRiskScore:  22,
    distressScore:  15,
    validatedAt:    '2026-05-14T10:23:00Z',
    lat:            33.45,
    lng:            -100.9,
  },
  {
    plantId:        'plant-02',
    eiaPlantCode:   '60011',
    plantName:      'Desert Sunlight Solar II',
    state:          'CA',
    fuelSource:     'Solar',
    nameplateMw:    250,
    role:           'Senior Debt',
    ttmCf:          24.8,
    regionalCf:     25.9,
    cfDeltaPp:      -1.1,
    newsRiskScore:  38,
    distressScore:  41,
    validatedAt:    '2026-05-21T15:47:00Z',
    lat:            33.82,
    lng:            -115.4,
  },
  {
    plantId:        'plant-03',
    eiaPlantCode:   '63540',
    plantName:      'Bison Wind Energy Center',
    state:          'ND',
    fuelSource:     'Wind',
    nameplateMw:    205,
    role:           'Construction Loan',
    ttmCf:          32.1,
    regionalCf:     30.4,
    cfDeltaPp:      1.7,
    newsRiskScore:  11,
    distressScore:  8,
    validatedAt:    '2026-04-30T09:12:00Z',
    lat:            47.1,
    lng:            -101.7,
  },
  {
    plantId:        'plant-04',
    eiaPlantCode:   '58720',
    plantName:      'Copper Mountain Solar IV',
    state:          'NV',
    fuelSource:     'Solar',
    nameplateMw:    150,
    role:           'Term Loan',
    ttmCf:          19.2,
    regionalCf:     24.6,
    cfDeltaPp:      -5.4,
    newsRiskScore:  71,
    distressScore:  68,
    validatedAt:    '2026-05-03T11:00:00Z',
    lat:            35.9,
    lng:            -114.8,
  },
  {
    plantId:        'plant-05',
    eiaPlantCode:   '61300',
    plantName:      'Panhandle Wind Ranch',
    state:          'TX',
    fuelSource:     'Wind',
    nameplateMw:    459,
    role:           'Senior Debt',
    ttmCf:          31.5,
    regionalCf:     26.1,
    cfDeltaPp:      5.4,
    newsRiskScore:  17,
    distressScore:  12,
    validatedAt:    '2026-05-18T08:30:00Z',
    lat:            35.5,
    lng:            -101.5,
  },
  {
    plantId:        'plant-06',
    eiaPlantCode:   '55801',
    plantName:      'Ironwood Solar Complex',
    state:          'AZ',
    fuelSource:     'Solar',
    nameplateMw:    75,
    role:           'Mezzanine',
    ttmCf:          22.9,
    regionalCf:     23.8,
    cfDeltaPp:      -0.9,
    newsRiskScore:  29,
    distressScore:  33,
    validatedAt:    '2026-05-27T14:15:00Z',
    lat:            33.1,
    lng:            -112.0,
  },
  {
    plantId:        'plant-07',
    eiaPlantCode:   '64102',
    plantName:      'Glacier Wind Farm',
    state:          'MT',
    fuelSource:     'Wind',
    nameplateMw:    115,
    role:           'Senior Debt',
    ttmCf:          28.7,
    regionalCf:     27.3,
    cfDeltaPp:      1.4,
    newsRiskScore:  44,
    distressScore:  37,
    validatedAt:    '2026-04-22T16:00:00Z',
    lat:            null,   // no coordinates — exercises the unmapped badge
    lng:            null,
  },
];

// ── KPIs derived from plant list ─────────────────────────────────────────────
// Total MW = 1604; MW-weighted TTM CF; blended regional CF.

const totalMw = MOCK_PLANTS.reduce((s, p) => s + (p.nameplateMw ?? 0), 0); // 1604
const wTtm = MOCK_PLANTS.reduce((s, p) => s + (p.ttmCf ?? 0) * (p.nameplateMw ?? 0), 0) / totalMw;
const wReg = MOCK_PLANTS.reduce((s, p) => s + (p.regionalCf ?? 0) * (p.nameplateMw ?? 0), 0) / totalMw;
const wNews = MOCK_PLANTS.reduce((s, p) => s + (p.newsRiskScore ?? 0) * (p.nameplateMw ?? 0), 0) / totalMw;
const wDist = MOCK_PLANTS.reduce((s, p) => s + (p.distressScore ?? 0) * (p.nameplateMw ?? 0), 0) / totalMw;

// ── News articles ─────────────────────────────────────────────────────────────

export const MOCK_ARTICLES: NewsArticle[] = [
  {
    id:                 'art-01',
    title:              'Copper Mountain Solar IV operator discloses PPA dispute with utility buyer',
    description:        'The operator of Copper Mountain Solar IV has filed a complaint alleging material breach of its power purchase agreement.',
    url:                'https://example.com/copper-mountain-dispute',
    sourceName:         'Utility Dive',
    publishedAt:        '2026-06-01T10:00:00Z',
    topics:             ['regulatory'],
    sentimentLabel:     'negative',
    eventType:          'dispute',
    impactTags:         ['ppa_dispute', 'distress'],
    ftiRelevanceTags:   ['disputes'],
    importance:         'high',
    entityCompanyNames: ['Sempra Renewables'],
    lenders:            ['Pacific Premier Bank'],
    assetLinkageTier:   'high',
    relevanceScore:     0.92,
    includeForEmbedding: true,
    categories:         ['regulatory'],
    tags:               ['ppa', 'dispute'],
  },
  {
    id:                 'art-02',
    title:              'ERCOT wind generation hits record despite seasonal curtailment warnings',
    description:        'Wind resources in the ERCOT West and North zones delivered above-forecast output in May.',
    url:                'https://example.com/ercot-wind-record',
    sourceName:         'S&P Global Commodity Insights',
    publishedAt:        '2026-05-28T14:00:00Z',
    topics:             ['financial'],
    sentimentLabel:     'positive',
    eventType:          'none',
    impactTags:         ['capacity_addition'],
    ftiRelevanceTags:   ['market_strategy'],
    importance:         'medium',
    entityCompanyNames: ['NextEra Energy', 'Invenergy'],
    lenders:            [],
    assetLinkageTier:   'medium',
    relevanceScore:     0.74,
    includeForEmbedding: true,
    categories:         ['market'],
    tags:               ['ercot', 'wind', 'curtailment'],
  },
  {
    id:                 'art-03',
    title:              'Pacific Premier Bank expands renewable energy credit exposure in Q1 2026 filing',
    description:        'SEC 10-Q filing shows the lender grew its clean energy loan book by 14% YoY.',
    url:                'https://example.com/ppb-10q',
    sourceName:         'EDGAR / SEC EDGAR',
    publishedAt:        '2026-05-15T09:00:00Z',
    topics:             ['financial'],
    sentimentLabel:     'positive',
    eventType:          'financial',
    impactTags:         [],
    ftiRelevanceTags:   ['transactions'],
    importance:         'high',
    entityCompanyNames: ['Pacific Premier Bank'],
    lenders:            ['Pacific Premier Bank'],
    assetLinkageTier:   'high',
    relevanceScore:     0.88,
    includeForEmbedding: true,
    categories:         ['financing'],
    tags:               ['sec', '10q', 'credit'],
  },
  {
    id:                 'art-04',
    title:              'Glacier Wind Farm faces transmission queue delays as MISO interconnection backlog grows',
    description:        'MISO\'s interconnection queue delays threaten capacity additions across the Northern Plains.',
    url:                'https://example.com/miso-queue-delays',
    sourceName:         'RenewablesBiz',
    publishedAt:        '2026-05-10T07:30:00Z',
    topics:             ['regulatory'],
    sentimentLabel:     'negative',
    eventType:          'regulatory',
    impactTags:         ['curtailment'],
    ftiRelevanceTags:   ['restructuring'],
    importance:         'medium',
    entityCompanyNames: ['NextEra Energy', 'Enel'],
    lenders:            [],
    assetLinkageTier:   'medium',
    relevanceScore:     0.61,
    includeForEmbedding: false,
    categories:         ['regulatory'],
    tags:               ['miso', 'interconnection'],
  },
  {
    id:                 'art-05',
    title:              'Panhandle Wind Ranch refinancing closes at tighter spread, citing strong performance record',
    description:        'A $620M project finance refinancing for the Panhandle facility closed in April.',
    url:                'https://example.com/panhandle-refi',
    sourceName:         'PFI — Project Finance International',
    publishedAt:        '2026-04-30T11:00:00Z',
    topics:             ['financial'],
    sentimentLabel:     'positive',
    eventType:          'm_and_a',
    impactTags:         [],
    ftiRelevanceTags:   ['transactions'],
    importance:         'high',
    entityCompanyNames: ['Invenergy', 'Pacific Premier Bank'],
    lenders:            ['Pacific Premier Bank', 'Wells Fargo'],
    assetLinkageTier:   'high',
    relevanceScore:     0.95,
    includeForEmbedding: true,
    categories:         ['financing'],
    tags:               ['refi', 'project-finance', 'wind'],
  },
  {
    id:                 'art-06',
    title:              'Desert Sunlight operator reports O&M cost overruns amid inverter replacement program',
    description:        'Inverter aging across the Mojave Solar portfolio is triggering ahead-of-schedule capex.',
    url:                'https://example.com/desert-sunlight-opex',
    sourceName:         'PV Tech',
    publishedAt:        '2026-04-18T13:45:00Z',
    topics:             ['financial'],
    sentimentLabel:     'negative',
    eventType:          'financial',
    impactTags:         ['distress', 'curtailment'],
    ftiRelevanceTags:   ['restructuring', 'disputes'],
    importance:         'medium',
    entityCompanyNames: ['Sempra Renewables'],
    lenders:            [],
    assetLinkageTier:   'high',
    relevanceScore:     0.79,
    includeForEmbedding: true,
    categories:         ['operations'],
    tags:               ['o&m', 'capex', 'solar'],
  },
  {
    id:                 'art-07',
    title:              'State regulators approve rate case supporting renewable integration in Montana',
    description:        'The Montana PSC approved a new transmission rate structure expected to benefit wind operators.',
    url:                'https://example.com/montana-rate-case',
    sourceName:         'Platts',
    publishedAt:        '2026-04-05T10:00:00Z',
    topics:             ['regulatory'],
    sentimentLabel:     'positive',
    eventType:          'regulatory',
    impactTags:         [],
    ftiRelevanceTags:   ['market_strategy'],
    importance:         'low',
    entityCompanyNames: [],
    lenders:            [],
    assetLinkageTier:   'medium',
    relevanceScore:     0.45,
    includeForEmbedding: false,
    categories:         ['regulatory'],
    tags:               ['montana', 'transmission', 'rate-case'],
  },
  {
    id:                 'art-08',
    title:              'IRS issues guidance clarifying transferable ITC credit for operational solar assets',
    description:        'New IRS Notice 2026-18 clarifies transferability eligibility for assets placed in service before 2025.',
    url:                'https://example.com/irs-itc-guidance',
    sourceName:         'Bloomberg Tax',
    publishedAt:        '2026-03-28T08:00:00Z',
    topics:             ['regulatory'],
    sentimentLabel:     'positive',
    eventType:          'policy',
    impactTags:         [],
    ftiRelevanceTags:   ['transactions'],
    importance:         'high',
    entityCompanyNames: [],
    lenders:            [],
    assetLinkageTier:   'none',
    relevanceScore:     0.55,
    includeForEmbedding: true,
    categories:         ['policy'],
    tags:               ['irs', 'itc', 'transferability'],
  },
];

// ── Full mock digest ──────────────────────────────────────────────────────────

export const MOCK_DIGEST: LenderValidatedDigest = {
  lenderId:    '42',
  lenderName:  'Pacific Premier Bank',
  pursuitLabel: 'warm',

  kpis: {
    totalMw:               Math.round(totalMw),
    plantCount:            MOCK_PLANTS.length,
    weightedTtmCf:         Math.round(wTtm * 10) / 10,
    blendedRegionalTtmCf:  Math.round(wReg * 10) / 10,
    cfDeltaPp:             Math.round((wTtm - wReg) * 10) / 10,
    avgNewsRisk:           Math.round(wNews * 10) / 10,
    avgDistressScore:      Math.round(wDist * 10) / 10,
    activeLoanCount:       5,
    curtailedCount:        1,
  },

  cfSeries: MOCK_CF_SERIES,

  aiEngagementThesis: `Pacific Premier Bank maintains a $1.6 GW portfolio of validated renewables exposure spanning wind and solar assets across ERCOT, CAISO, and the Northwest. The portfolio's TTM capacity factor of ~${Math.round(wTtm * 10) / 10}% outperforms the blended regional baseline by ${Math.round((wTtm - wReg) * 10) / 10} percentage points, suggesting the lender's credit selection has skewed toward higher-performing assets.

However, one material credit — Copper Mountain Solar IV (150 MW, NV) — is running 5.4 pp below its regional baseline and is now embroiled in a PPA dispute with the offtake utility. This creates a near-term credit event risk that FTI is well-positioned to address through our Disputes + Restructuring practice. The bank's recent 10-Q disclosure of a 14% YoY increase in clean energy loan book exposure signals continued appetite for sector growth, making this an opportune moment to position FTI as a strategic advisor on both the distressed credit and the broader portfolio optimization opportunity.`,

  aiPortfolioHealth: `The seven-asset portfolio shows a bifurcated performance profile. Four assets (Mesquite Star, Bison Wind, Panhandle, and Glacier) are performing at or above regional benchmarks, contributing to an aggregate portfolio outperformance. The two California/Nevada solar assets (Desert Sunlight and Copper Mountain) are the primary sources of risk: Desert Sunlight is tracking near-benchmark but incurring elevated O&M capex from an inverter replacement program, while Copper Mountain's production has deteriorated materially and is now subject to active litigation.

The Panhandle refinancing that closed in April demonstrates that the high-quality wind credits remain financeable at attractive terms. From a portfolio health standpoint, the concentration of ~25% of MW exposure in underperforming CAISO/Southwest solar deserves close monitoring. Overall news risk score of ${Math.round(wNews * 10) / 10} and distress score of ${Math.round(wDist * 10) / 10} (out of 100) reflect a mixed but manageable risk profile.`,

  aiPitchBullets: [
    'Copper Mountain PPA dispute is a live engagement opportunity for FTI Disputes team',
    'Desert Sunlight O&M cost overrun may require lender consent for unbudgeted capex — Restructuring angle',
    'Panhandle Wind refinancing success shows bank receptive to proactive advisory on high-performing credits',
    'Bank\'s growing renewables book creates opportunity to pitch portfolio monitoring as ongoing advisory mandate',
  ],

  aiRiskBullets: [
    'PPA dispute at Copper Mountain could trigger DSCR covenant breach; timing of resolution uncertain',
    'MISO interconnection delays affecting Glacier Wind could reduce near-term production and DSCR',
    'IRS transferable ITC guidance may prompt bank to revisit tax equity structures across portfolio',
  ],

  plantCount:  MOCK_PLANTS.length,
  totalMw:     Math.round(totalMw),
  costUsd:     0.0042,
  modelUsed:   'gemini-2.0-flash',
  generatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), // 2 days ago
};
