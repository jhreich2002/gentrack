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
  lenders:         {
    name:               string;
    role:               string;
    facilityType:       string;
    loanStatus:         string | null;
    currencyConfidence: number | null;
    syndicateRole:      string | null;
    pitchAngle:         string | null;
    pitchUrgencyScore:  number | null;
  }[];
  activeLenderCount:  number;
  maxUrgencyScore:    number | null;
  topPitchAngle:      string | null;
  searchedAt:         string | null;
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
  // 1. Get all plant codes that have at least one high/medium confidence lender row
  //    (covers both old lender-search pipeline and new agentic pipeline)
  const { data: lenderCodeData, error: lenderCodeErr } = await supabase
    .from('plant_lenders')
    .select('eia_plant_code')
    .in('confidence', ['high', 'medium']);

  if (lenderCodeErr) {
    console.error('pursuitService: plant_lenders code fetch error:', lenderCodeErr.message);
    return [];
  }

  const codes = [...new Set((lenderCodeData ?? []).map((r: any) => r.eia_plant_code as string))];
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
      name:          (r.name as string) ?? (r.eia_plant_code as string),
      state:         (r.state as string) ?? '',
      fuelSource:    (r.fuel_source as string) ?? '',
      nameplateMw:   Number(r.nameplate_capacity_mw) || 0,
      distressScore: r.distress_score != null ? Number(r.distress_score) : null,
    });
  }

  const plantCodes = Array.from(plantMap.keys());

  // 3. Fetch lenders for these plants (active/unknown only — exclude confirmed matured)
  const { data: lendersData } = await supabase
    .from('plant_lenders')
    .select('eia_plant_code, lender_name')
    .in('eia_plant_code', plantCodes)
    .in('confidence', ['high', 'medium'])
    .in('loan_status', ['active', 'unknown']);

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
  // 1. Get all plant codes that have at least one high/medium confidence lender row
  //    (covers both old lender-search pipeline and new agentic pipeline)
  const { data: lenderCodeData, error: lenderCodeErr } = await supabase
    .from('plant_lenders')
    .select('eia_plant_code')
    .in('confidence', ['high', 'medium']);

  if (lenderCodeErr) {
    console.error('pursuitService: plant_lenders code fetch error:', lenderCodeErr.message);
    return [];
  }

  const codes = [...new Set((lenderCodeData ?? []).map((r: any) => r.eia_plant_code as string))];
  if (codes.length === 0) return [];

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

  // 3. Fetch lender data with new agentic pipeline columns
  const { data: lendersData } = await supabase
    .from('plant_lenders')
    .select('eia_plant_code, lender_name, role, facility_type, loan_status, currency_confidence, syndicate_role, pitch_angle, pitch_urgency_score')
    .in('eia_plant_code', plantCodes)
    .in('confidence', ['high', 'medium'])
    .in('loan_status', ['active', 'unknown']);

  type LenderRow = {
    name: string; role: string; facilityType: string;
    loanStatus: string | null; currencyConfidence: number | null;
    syndicateRole: string | null; pitchAngle: string | null; pitchUrgencyScore: number | null;
  };
  const lendersByCode = new Map<string, LenderRow[]>();
  for (const row of lendersData ?? []) {
    const r = row as {
      eia_plant_code: string; lender_name: string; role: string; facility_type: string;
      loan_status: string | null; currency_confidence: number | null;
      syndicate_role: string | null; pitch_angle: string | null; pitch_urgency_score: number | null;
    };
    if (!lendersByCode.has(r.eia_plant_code)) lendersByCode.set(r.eia_plant_code, []);
    lendersByCode.get(r.eia_plant_code)!.push({
      name:              r.lender_name,
      role:              r.role,
      facilityType:      r.facility_type,
      loanStatus:        r.loan_status,
      currencyConfidence: r.currency_confidence,
      syndicateRole:     r.syndicate_role ?? null,
      pitchAngle:        r.pitch_angle ?? null,
      pitchUrgencyScore: r.pitch_urgency_score != null ? Number(r.pitch_urgency_score) : null,
    });
  }

  // 3b. Fetch searchedAt from plant_news_state (prefer lender_ingest_checked_at, fall back to lender_search_checked_at)
  const { data: newsStateData } = await supabase
    .from('plant_news_state')
    .select('eia_plant_code, lender_ingest_checked_at, lender_search_checked_at')
    .in('eia_plant_code', plantCodes);

  const searchedAtMap = new Map<string, string | null>(
    (newsStateData ?? []).map((r: { eia_plant_code: string; lender_ingest_checked_at: string | null; lender_search_checked_at: string | null }) =>
      [r.eia_plant_code, r.lender_ingest_checked_at ?? r.lender_search_checked_at]
    )
  );

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

    const lenders = lendersByCode.get(code) ?? [];
    const activeLenderCount = lenders.filter(l => l.loanStatus === 'active').length;
    const urgencyScores = lenders.map(l => l.pitchUrgencyScore).filter((s): s is number => s != null);
    const maxUrgencyScore = urgencyScores.length > 0 ? Math.max(...urgencyScores) : null;
    // Most common pitch angle across this plant's lenders
    const angleCounts = new Map<string, number>();
    for (const l of lenders) { if (l.pitchAngle) angleCounts.set(l.pitchAngle, (angleCounts.get(l.pitchAngle) ?? 0) + 1); }
    const topPitchAngle = angleCounts.size > 0
      ? [...angleCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
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
      lenders,
      activeLenderCount,
      maxUrgencyScore,
      topPitchAngle,
      searchedAt:      (searchedAtMap.get(code) ?? null) as string | null,
    };
  });
}

export interface LenderCurrencySummary {
  totalRows:      number;
  activeCount:    number;
  maturedCount:   number;
  refinancedCount: number;
  unknownCount:   number;
  avgConfidence:  number | null;
  lastCheckedAt:  string | null;
}

export async function fetchLenderCurrencyStats(eiaPlantCode: string): Promise<LenderCurrencySummary> {
  const { data, error } = await supabase
    .from('plant_lenders')
    .select('loan_status, currency_confidence, currency_checked_at')
    .eq('eia_plant_code', eiaPlantCode)
    .in('confidence', ['high', 'medium']);

  if (error || !data) return { totalRows: 0, activeCount: 0, maturedCount: 0, refinancedCount: 0, unknownCount: 0, avgConfidence: null, lastCheckedAt: null };

  const rows = data as { loan_status: string | null; currency_confidence: number | null; currency_checked_at: string | null }[];
  const confidences = rows.map(r => r.currency_confidence).filter((c): c is number => c != null);
  const checkedDates = rows.map(r => r.currency_checked_at).filter((d): d is string => d != null).sort().reverse();

  return {
    totalRows:      rows.length,
    activeCount:    rows.filter(r => r.loan_status === 'active').length,
    maturedCount:   rows.filter(r => r.loan_status === 'matured').length,
    refinancedCount: rows.filter(r => r.loan_status === 'refinanced').length,
    unknownCount:   rows.filter(r => !r.loan_status || r.loan_status === 'unknown').length,
    avgConfidence:  confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
    lastCheckedAt:  checkedDates[0] ?? null,
  };
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
    .select('eia_plant_code, lender_name, role, facility_type, loan_status, currency_confidence, syndicate_role, pitch_angle, pitch_urgency_score')
    .in('eia_plant_code', plantCodes)
    .in('confidence', ['high', 'medium'])
    .in('loan_status', ['active', 'unknown']);

  type WLenderRow = { name: string; role: string; facilityType: string; loanStatus: string | null; currencyConfidence: number | null; syndicateRole: string | null; pitchAngle: string | null; pitchUrgencyScore: number | null };
  const lendersByCode = new Map<string, WLenderRow[]>();
  for (const row of lendersData ?? []) {
    const r = row as { eia_plant_code: string; lender_name: string; role: string; facility_type: string; loan_status: string | null; currency_confidence: number | null; syndicate_role: string | null; pitch_angle: string | null; pitch_urgency_score: number | null };
    if (!lendersByCode.has(r.eia_plant_code)) lendersByCode.set(r.eia_plant_code, []);
    lendersByCode.get(r.eia_plant_code)!.push({ name: r.lender_name, role: r.role, facilityType: r.facility_type, loanStatus: r.loan_status, currencyConfidence: r.currency_confidence, syndicateRole: r.syndicate_role ?? null, pitchAngle: r.pitch_angle ?? null, pitchUrgencyScore: r.pitch_urgency_score != null ? Number(r.pitch_urgency_score) : null });
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

    const lenders = lendersByCode.get(code) ?? [];
    const activeLenderCount = lenders.filter(l => l.loanStatus === 'active').length;
    const urgencyScores = lenders.map(l => l.pitchUrgencyScore).filter((s): s is number => s != null);
    const maxUrgencyScore = urgencyScores.length > 0 ? Math.max(...urgencyScores) : null;
    const angleCounts = new Map<string, number>();
    for (const l of lenders) { if (l.pitchAngle) angleCounts.set(l.pitchAngle, (angleCounts.get(l.pitchAngle) ?? 0) + 1); }
    const topPitchAngle = angleCounts.size > 0 ? [...angleCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
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
      lenders,
      activeLenderCount,
      maxUrgencyScore,
      topPitchAngle,
      searchedAt:      null,
    };
  });
}
