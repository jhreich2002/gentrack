/**
 * GenTrack — pursuitService
 *
 * Fetches curtailed plants with confirmed lenders (lenders_found=true)
 * for the Plant Pursuits tab. Combines plant_financing_summary, plants,
 * and plant_lenders to produce actionable pursuit candidates.
 */

import { supabase } from './supabaseClient';

export interface PursuitPlant {
  eiaPlantCode:    string;
  name:            string;
  state:           string;
  fuelSource:      string;
  nameplateMw:     number;
  curtailmentScore: number | null;
  newsRiskScore:   number | null;
  distressScore:   number | null;
  cfTrend:         number | null;
  recentCf:        number | null;
  opportunityScore: number | null;
  pursuitScore:    number | null;
  ttmAvgFactor:    number | null;
  pursuitStatus:   string | null;
  lenders:         { name: string; role: string; facilityType: string }[];
  searchedAt:      string | null;
}

export interface LenderRanking {
  name:                string;
  curtailedPlantCount: number;
  totalCurtailedMw:    number;
  avgDistressScore:    number | null;
  plants: {
    eiaPlantCode: string;
    name:         string;
    state:        string;
    fuelSource:   string;
    nameplateMw:  number;
    distressScore: number | null;
  }[];
}

export async function fetchLenderRankings(): Promise<LenderRanking[]> {
  // 1. Get all curtailed plants with confirmed lenders
  const { data: summaryData, error: summaryErr } = await supabase
    .from('plant_financing_summary')
    .select('eia_plant_code')
    .eq('lenders_found', true);

  if (summaryErr) {
    console.error('pursuitService: plant_financing_summary error:', summaryErr.message);
    return [];
  }

  const codes = (summaryData ?? []).map((r: { eia_plant_code: string }) => r.eia_plant_code);
  if (codes.length === 0) return [];

  // 2. Fetch curtailed plant info
  const { data: plantsData, error: plantsErr } = await supabase
    .from('plants')
    .select('eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, distress_score')
    .in('eia_plant_code', codes)
    .eq('is_likely_curtailed', true);

  if (plantsErr || !plantsData?.length) return [];

  const plantMap = new Map<string, {
    eiaPlantCode: string; name: string; state: string; fuelSource: string;
    nameplateMw: number; distressScore: number | null;
  }>();
  for (const p of plantsData) {
    const r = p as Record<string, unknown>;
    plantMap.set(r.eia_plant_code as string, {
      eiaPlantCode:  r.eia_plant_code as string,
      name:          (r.name as string) ?? r.eia_plant_code,
      state:         (r.state as string) ?? '',
      fuelSource:    (r.fuel_source as string) ?? '',
      nameplateMw:   Number(r.nameplate_capacity_mw) || 0,
      distressScore: r.distress_score != null ? Number(r.distress_score) : null,
    });
  }

  const plantCodes = Array.from(plantMap.keys());

  // 3. Fetch lenders for these plants
  const { data: lendersData } = await supabase
    .from('plant_lenders')
    .select('eia_plant_code, lender_name')
    .in('eia_plant_code', plantCodes)
    .in('confidence', ['high', 'medium']);

  // 4. Aggregate by lender
  const lenderMap = new Map<string, Set<string>>();
  for (const row of lendersData ?? []) {
    const r = row as { eia_plant_code: string; lender_name: string };
    if (!lenderMap.has(r.lender_name)) lenderMap.set(r.lender_name, new Set());
    lenderMap.get(r.lender_name)!.add(r.eia_plant_code);
  }

  const rankings: LenderRanking[] = [];
  for (const [lenderName, plantCodes] of lenderMap.entries()) {
    const plants = Array.from(plantCodes)
      .map(code => plantMap.get(code))
      .filter(Boolean) as LenderRanking['plants'];

    const scores = plants.map(p => p.distressScore).filter((s): s is number => s != null);
    const avgDistressScore = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null;

    rankings.push({
      name:                lenderName,
      curtailedPlantCount: plants.length,
      totalCurtailedMw:    plants.reduce((sum, p) => sum + p.nameplateMw, 0),
      avgDistressScore,
      plants:              plants.sort((a, b) => (b.distressScore ?? 0) - (a.distressScore ?? 0)),
    });
  }

  // Sort by curtailed plant count desc, then by total MW as tiebreaker
  return rankings.sort(
    (a, b) => b.curtailedPlantCount - a.curtailedPlantCount || b.totalCurtailedMw - a.totalCurtailedMw,
  );
}

export async function fetchPursuitPlants(): Promise<PursuitPlant[]> {
  // 1. Get all plant codes with confirmed lenders
  const { data: summaryData, error: summaryErr } = await supabase
    .from('plant_financing_summary')
    .select('eia_plant_code, searched_at')
    .eq('lenders_found', true);

  if (summaryErr) {
    console.error('pursuitService: plant_financing_summary error:', summaryErr.message);
    return [];
  }

  const codes = (summaryData ?? []).map((r: { eia_plant_code: string }) => r.eia_plant_code);
  if (codes.length === 0) return [];

  const searchedAtMap = new Map<string, string | null>(
    (summaryData ?? []).map((r: { eia_plant_code: string; searched_at: string | null }) => [r.eia_plant_code, r.searched_at]),
  );

  // 2. Fetch plant info (curtailed only) — use curtailment_score directly
  const { data: plantsData, error: plantsErr } = await supabase
    .from('plants')
    .select('eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, curtailment_score, ttm_avg_factor, pursuit_status')
    .in('eia_plant_code', codes)
    .eq('is_likely_curtailed', true)
    .order('curtailment_score', { ascending: false, nullsFirst: false });

  if (plantsErr) {
    console.error('pursuitService: plants error:', plantsErr.message);
    return [];
  }

  const plantCodes = (plantsData ?? []).map((p: { eia_plant_code: string }) => p.eia_plant_code);
  if (plantCodes.length === 0) return [];

  // 3. Fetch lender names for these plants
  const { data: lendersData } = await supabase
    .from('plant_lenders')
    .select('eia_plant_code, lender_name, role, facility_type')
    .in('eia_plant_code', plantCodes)
    .in('confidence', ['high', 'medium']);

  const lendersByCode = new Map<string, { name: string; role: string; facilityType: string }[]>();
  for (const row of lendersData ?? []) {
    const r = row as { eia_plant_code: string; lender_name: string; role: string; facility_type: string };
    if (!lendersByCode.has(r.eia_plant_code)) lendersByCode.set(r.eia_plant_code, []);
    lendersByCode.get(r.eia_plant_code)!.push({
      name:         r.lender_name,
      role:         r.role,
      facilityType: r.facility_type,
    });
  }

  // 4. Fetch precomputed news_risk_score (used once, no double-counting)
  const { data: ratingsData } = await supabase
    .from('plant_news_ratings')
    .select('eia_plant_code, news_risk_score')
    .in('eia_plant_code', plantCodes);

  const newsRiskMap = new Map<string, number>();
  for (const row of ratingsData ?? []) {
    const r = row as { eia_plant_code: string; news_risk_score: number | null };
    if (r.news_risk_score != null) newsRiskMap.set(r.eia_plant_code, Number(r.news_risk_score));
  }

  // 5. Fetch recent 3-month generation to compute CF trend
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const cutoffMonth = threeMonthsAgo.toISOString().slice(0, 7);

  const { data: genData } = await supabase
    .from('monthly_generation')
    .select('plant_id, month, mwh')
    .in('plant_id', plantCodes)
    .gte('month', cutoffMonth);

  const genByPlant = new Map<string, { totalMwh: number; months: number }>();
  for (const row of genData ?? []) {
    const r = row as { plant_id: string; month: string; mwh: number };
    const entry = genByPlant.get(r.plant_id) ?? { totalMwh: 0, months: 0 };
    entry.totalMwh += Number(r.mwh) || 0;
    entry.months += 1;
    genByPlant.set(r.plant_id, entry);
  }

  // 6. Compute capacity normalization signal
  const maxMw = Math.max(...(plantsData ?? []).map((p: Record<string, unknown>) => Number(p.nameplate_capacity_mw) || 0), 1);

  return (plantsData ?? []).map((p: Record<string, unknown>) => {
    const code = p.eia_plant_code as string;
    const curtailmentScore = p.curtailment_score != null ? Number(p.curtailment_score) : null;
    const newsRiskScore = newsRiskMap.get(code) ?? null;
    const ttmAvgFactor = p.ttm_avg_factor != null ? Number(p.ttm_avg_factor) : null;
    const nameplateMw = Number(p.nameplate_capacity_mw) || 0;

    // CF trend: (TTM - recent3mo) / TTM; positive = degrading
    let recentCf: number | null = null;
    let cfTrend: number | null = null;
    const gen = genByPlant.get(code);
    if (gen && gen.months > 0 && nameplateMw > 0) {
      const avgMonthlyMwh = gen.totalMwh / gen.months;
      recentCf = avgMonthlyMwh / (nameplateMw * 730);
      if (ttmAvgFactor != null && ttmAvgFactor > 0) {
        cfTrend = (ttmAvgFactor - recentCf) / ttmAvgFactor;
      }
    }

    // Distress: curtailment 60% + news risk 40% — no lender bonus
    const cVal = curtailmentScore ?? 0;
    const nVal = newsRiskScore ?? 0;
    const distressScore = (curtailmentScore != null || newsRiskScore != null)
      ? Math.min(100, cVal * 0.6 + nVal * 0.4)
      : null;

    // Opportunity: lender signal (40) + capacity signal (35) + trend bonus (25)
    const lenderSignal = (lendersByCode.get(code)?.length ?? 0) > 0 ? 1 : 0;
    const capacitySignal = nameplateMw / maxMw;
    const trendBonus = (cfTrend != null && cfTrend > 0) ? Math.min(1, cfTrend / 0.5) : 0;
    const opportunityScore = lenderSignal * 40 + capacitySignal * 35 + trendBonus * 25;

    // Pursuit score: geometric mean of distress × opportunity
    const pursuitScore = (distressScore != null && distressScore > 0 && opportunityScore > 0)
      ? Math.sqrt(distressScore * opportunityScore)
      : null;

    return {
      eiaPlantCode:    code,
      name:            (p.name as string) ?? code,
      state:           (p.state as string) ?? '',
      fuelSource:      (p.fuel_source as string) ?? '',
      nameplateMw,
      curtailmentScore,
      newsRiskScore,
      distressScore,
      cfTrend,
      recentCf,
      opportunityScore,
      pursuitScore,
      ttmAvgFactor,
      pursuitStatus:   (p.pursuit_status as string | null) ?? null,
      lenders:         lendersByCode.get(code) ?? [],
      searchedAt:      searchedAtMap.get(code) ?? null,
    };
  });
}

/**
 * Fetches pursuit-style scoring data for a specific set of EIA plant codes.
 * Used by the Watchlist dashboard — no lenders_found filter, works for any plant.
 */
export async function fetchWatchlistPursuitData(eiaPlantCodes: string[]): Promise<PursuitPlant[]> {
  if (eiaPlantCodes.length === 0) return [];

  const { data: plantsData, error: plantsErr } = await supabase
    .from('plants')
    .select('eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, curtailment_score, ttm_avg_factor, pursuit_status')
    .in('eia_plant_code', eiaPlantCodes);

  if (plantsErr || !plantsData?.length) return [];

  const plantCodes = (plantsData as Record<string, unknown>[]).map(p => p.eia_plant_code as string);

  const { data: lendersData } = await supabase
    .from('plant_lenders')
    .select('eia_plant_code, lender_name, role, facility_type')
    .in('eia_plant_code', plantCodes)
    .in('confidence', ['high', 'medium']);

  const lendersByCode = new Map<string, { name: string; role: string; facilityType: string }[]>();
  for (const row of lendersData ?? []) {
    const r = row as { eia_plant_code: string; lender_name: string; role: string; facility_type: string };
    if (!lendersByCode.has(r.eia_plant_code)) lendersByCode.set(r.eia_plant_code, []);
    lendersByCode.get(r.eia_plant_code)!.push({ name: r.lender_name, role: r.role, facilityType: r.facility_type });
  }

  const { data: ratingsData } = await supabase
    .from('plant_news_ratings')
    .select('eia_plant_code, news_risk_score')
    .in('eia_plant_code', plantCodes);

  const newsRiskMap = new Map<string, number>();
  for (const row of ratingsData ?? []) {
    const r = row as { eia_plant_code: string; news_risk_score: number | null };
    if (r.news_risk_score != null) newsRiskMap.set(r.eia_plant_code, Number(r.news_risk_score));
  }

  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const cutoffMonth = threeMonthsAgo.toISOString().slice(0, 7);

  const { data: genData } = await supabase
    .from('monthly_generation')
    .select('plant_id, month, mwh')
    .in('plant_id', plantCodes)
    .gte('month', cutoffMonth);

  const genByPlant = new Map<string, { totalMwh: number; months: number }>();
  for (const row of genData ?? []) {
    const r = row as { plant_id: string; month: string; mwh: number };
    const entry = genByPlant.get(r.plant_id) ?? { totalMwh: 0, months: 0 };
    entry.totalMwh += Number(r.mwh) || 0;
    entry.months += 1;
    genByPlant.set(r.plant_id, entry);
  }

  const maxMw = Math.max(...(plantsData as Record<string, unknown>[]).map(p => Number(p.nameplate_capacity_mw) || 0), 1);

  return (plantsData as Record<string, unknown>[]).map(p => {
    const code = p.eia_plant_code as string;
    const curtailmentScore = p.curtailment_score != null ? Number(p.curtailment_score) : null;
    const newsRiskScore = newsRiskMap.get(code) ?? null;
    const ttmAvgFactor = p.ttm_avg_factor != null ? Number(p.ttm_avg_factor) : null;
    const nameplateMw = Number(p.nameplate_capacity_mw) || 0;

    let recentCf: number | null = null;
    let cfTrend: number | null = null;
    const gen = genByPlant.get(code);
    if (gen && gen.months > 0 && nameplateMw > 0) {
      const avgMonthlyMwh = gen.totalMwh / gen.months;
      recentCf = avgMonthlyMwh / (nameplateMw * 730);
      if (ttmAvgFactor != null && ttmAvgFactor > 0) {
        cfTrend = (ttmAvgFactor - recentCf) / ttmAvgFactor;
      }
    }

    const cVal = curtailmentScore ?? 0;
    const nVal = newsRiskScore ?? 0;
    const distressScore = (curtailmentScore != null || newsRiskScore != null)
      ? Math.min(100, cVal * 0.6 + nVal * 0.4)
      : null;

    const lenderSignal = (lendersByCode.get(code)?.length ?? 0) > 0 ? 1 : 0;
    const capacitySignal = nameplateMw / maxMw;
    const trendBonus = (cfTrend != null && cfTrend > 0) ? Math.min(1, cfTrend / 0.5) : 0;
    const opportunityScore = lenderSignal * 40 + capacitySignal * 35 + trendBonus * 25;

    const pursuitScore = (distressScore != null && distressScore > 0 && opportunityScore > 0)
      ? Math.sqrt(distressScore * opportunityScore)
      : null;

    return {
      eiaPlantCode:    code,
      name:            (p.name as string) ?? code,
      state:           (p.state as string) ?? '',
      fuelSource:      (p.fuel_source as string) ?? '',
      nameplateMw,
      curtailmentScore,
      newsRiskScore,
      distressScore,
      cfTrend,
      recentCf,
      opportunityScore,
      pursuitScore,
      ttmAvgFactor,
      pursuitStatus:   (p.pursuit_status as string | null) ?? null,
      lenders:         lendersByCode.get(code) ?? [],
      searchedAt:      null,
    };
  });
}
