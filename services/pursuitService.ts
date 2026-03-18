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
  curtailmentScore: number | null;
  ttmAvgFactor:    number | null;
  pursuitStatus:   string | null;
  lenders:         { name: string; role: string; facilityType: string }[];
  searchedAt:      string | null;
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
    .select('eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, distress_score, curtailment_score, ttm_avg_factor, pursuit_status')
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

  return (plantsData ?? []).map((p: Record<string, unknown>) => ({
    eiaPlantCode:    p.eia_plant_code as string,
    name:            (p.name as string) ?? p.eia_plant_code,
    state:           (p.state as string) ?? '',
    fuelSource:      (p.fuel_source as string) ?? '',
    nameplateMw:     Number(p.nameplate_capacity_mw) || 0,
    distressScore:   p.distress_score != null ? Number(p.distress_score) : null,
    curtailmentScore: p.curtailment_score != null ? Number(p.curtailment_score) : null,
    ttmAvgFactor:    p.ttm_avg_factor != null ? Number(p.ttm_avg_factor) : null,
    pursuitStatus:   (p.pursuit_status as string | null) ?? null,
    lenders:         lendersByCode.get(p.eia_plant_code as string) ?? [],
    searchedAt:      searchedAtMap.get(p.eia_plant_code as string) ?? null,
  }));
}
