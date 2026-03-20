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
  distressScore:   number | null;
  newsScore:       number | null;
  blendedScore:    number | null;
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

  // 2. Fetch plant info (curtailed only)
  const { data: plantsData, error: plantsErr } = await supabase
    .from('plants')
    .select('eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, distress_score, ttm_avg_factor, pursuit_status')
    .in('eia_plant_code', codes)
    .eq('is_likely_curtailed', true)
    .order('distress_score', { ascending: false, nullsFirst: false });

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

  // 4. Fetch recent news activity (past 90 days) for these plants
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: newsData } = await supabase
    .from('news_articles')
    .select('plant_codes, importance')
    .overlaps('plant_codes', plantCodes)
    .gte('published_at', cutoff);

  // Aggregate news counts per plant
  const newsCountsByCode = new Map<string, { high: number; medium: number; low: number }>();
  for (const row of newsData ?? []) {
    const r = row as { plant_codes: string[]; importance: string | null };
    for (const code of r.plant_codes ?? []) {
      if (!plantCodes.includes(code)) continue;
      if (!newsCountsByCode.has(code)) newsCountsByCode.set(code, { high: 0, medium: 0, low: 0 });
      const counts = newsCountsByCode.get(code)!;
      if (r.importance === 'high')   counts.high++;
      else if (r.importance === 'medium') counts.medium++;
      else counts.low++;
    }
  }

  return (plantsData ?? []).map((p: Record<string, unknown>) => {
    const code = p.eia_plant_code as string;
    const distressScore = p.distress_score != null ? Number(p.distress_score) : null;
    const counts = newsCountsByCode.get(code) ?? { high: 0, medium: 0, low: 0 };
    const rawNews = counts.high * 30 + counts.medium * 10 + counts.low * 3;
    const newsScore = Math.min(100, rawNews);
    const blendedScore = distressScore != null
      ? Math.min(100, 0.7 * distressScore + 0.3 * newsScore)
      : newsScore > 0 ? newsScore : null;

    return {
      eiaPlantCode:    code,
      name:            (p.name as string) ?? code,
      state:           (p.state as string) ?? '',
      fuelSource:      (p.fuel_source as string) ?? '',
      nameplateMw:     Number(p.nameplate_capacity_mw) || 0,
      distressScore,
      newsScore,
      blendedScore,
      ttmAvgFactor:    p.ttm_avg_factor != null ? Number(p.ttm_avg_factor) : null,
      pursuitStatus:   (p.pursuit_status as string | null) ?? null,
      lenders:         lendersByCode.get(code) ?? [],
      searchedAt:      searchedAtMap.get(code) ?? null,
    };
  });
}
