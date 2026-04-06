/**
 * GenTrack — developerService
 *
 * Client-side data functions for the Developer Registry UI:
 *   fetchDevelopers        — list all developers with stats
 *   fetchDeveloperDetail   — single developer with assets + crawl logs
 *   fetchAssetDetail       — single asset_registry row with owner links
 *   approveStagedAssets    — graduate staged assets
 */

import { supabase } from './supabaseClient';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeveloperRow {
  id: string;
  name: string;
  entity_type: string | null;
  website: string | null;
  hq_state: string | null;
  total_mw_claimed: number | null;
  asset_count_discovered: number;
  crawl_status: string;
  eia_benchmark_count: number | null;
  coverage_rate: number | null;
  avg_confidence: number | null;
  verification_pct: number | null;
  change_velocity: number | null;
  total_spend_usd: number;
  last_pulse_at: string | null;
  last_full_crawl_at: string | null;
  created_at: string;
}

export interface AssetRegistryRow {
  id: string;
  name: string;
  technology: string | null;
  status: string | null;
  capacity_mw: number | null;
  storage_mw: number | null;
  state: string | null;
  county: string | null;
  lat: number | null;
  lng: number | null;
  eia_plant_code: string | null;
  match_confidence: string | null;
  expected_cod: string | null;
  offtaker: string | null;
  confidence_score: number | null;
  confidence_breakdown: Record<string, any> | null;
  source_urls: string[];
  graduated: boolean;
  blocking_reason: string | null;
  verified: boolean;
  staging_attempts: number;
  discovered_at: string;
  last_refreshed_at: string | null;
}

export interface CrawlLogRow {
  id: string;
  run_type: string;
  status: string;
  phase: string | null;
  rounds: number;
  total_cost_usd: number;
  assets_discovered: number;
  assets_graduated: number;
  assets_staged: number;
  eia_match_rate: number | null;
  avg_confidence: number | null;
  started_at: string;
  completed_at: string | null;
  error_log: string | null;
}

export interface ChangelogRow {
  id: string;
  change_type: string;
  asset_id: string | null;
  old_value: Record<string, any> | null;
  new_value: Record<string, any> | null;
  detected_at: string;
  detected_by: string;
  asset_name?: string;
}

export interface DeveloperAssetLink {
  asset_id: string;
  ownership_pct: number | null;
  role: string | null;
}

export interface DeveloperOpportunityScoreRow {
  developer_id: string;
  developer_name: string;
  model_version: string;
  opportunity_score: number;
  distress_score: number;
  complexity_score: number;
  trigger_immediacy_score: number;
  engagement_potential_score: number;
  total_mw_at_risk: number;
  asset_count: number;
  mapped_asset_count: number;
  high_risk_asset_count: number;
  likely_curtailed_count: number;
  maintenance_offline_count: number;
  upcoming_cod_count: number;
  coverage_rate: number | null;
  verification_pct: number | null;
  top_signals: string[];
  recommended_service_lines: string[];
  previous_opportunity_score: number | null;
  weekly_delta_score: number | null;
  computed_at: string;
}

// ── Fetch Functions ──────────────────────────────────────────────────────────

export async function fetchDevelopers(): Promise<DeveloperRow[]> {
  const { data, error } = await supabase
    .from('developers')
    .select(`
      id, name, entity_type, website, hq_state,
      total_mw_claimed, asset_count_discovered, crawl_status,
      eia_benchmark_count, coverage_rate, avg_confidence,
      verification_pct, change_velocity, total_spend_usd,
      last_pulse_at, last_full_crawl_at, created_at
    `)
    .gt('asset_count_discovered', 0)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('fetchDevelopers error:', error.message);
    return [];
  }
  return data as DeveloperRow[];
}

export async function fetchDeveloperOpportunityScores(): Promise<Record<string, DeveloperOpportunityScoreRow>> {
  const { data, error } = await supabase
    .from('developer_opportunity_scores')
    .select(`
      developer_id, developer_name, model_version,
      opportunity_score, distress_score, complexity_score,
      trigger_immediacy_score, engagement_potential_score,
      total_mw_at_risk, asset_count, mapped_asset_count,
      high_risk_asset_count, likely_curtailed_count,
      maintenance_offline_count, upcoming_cod_count,
      coverage_rate, verification_pct,
      top_signals, recommended_service_lines,
      previous_opportunity_score, weekly_delta_score,
      computed_at
    `);

  if (error || !data) {
    if (error) console.error('fetchDeveloperOpportunityScores error:', error.message);
    return {};
  }

  const map: Record<string, DeveloperOpportunityScoreRow> = {};
  for (const row of data as DeveloperOpportunityScoreRow[]) {
    map[row.developer_id] = row;
  }
  return map;
}

export async function fetchDeveloperOpportunityScore(developerId: string): Promise<DeveloperOpportunityScoreRow | null> {
  const { data, error } = await supabase
    .from('developer_opportunity_scores')
    .select(`
      developer_id, developer_name, model_version,
      opportunity_score, distress_score, complexity_score,
      trigger_immediacy_score, engagement_potential_score,
      total_mw_at_risk, asset_count, mapped_asset_count,
      high_risk_asset_count, likely_curtailed_count,
      maintenance_offline_count, upcoming_cod_count,
      coverage_rate, verification_pct,
      top_signals, recommended_service_lines,
      previous_opportunity_score, weekly_delta_score,
      computed_at
    `)
    .eq('developer_id', developerId)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error('fetchDeveloperOpportunityScore error:', error.message);
    return null;
  }

  return data as DeveloperOpportunityScoreRow;
}

export async function fetchDeveloperAssets(developerId: string): Promise<AssetRegistryRow[]> {
  // Get asset IDs linked to this developer
  const { data: links, error: linkErr } = await supabase
    .from('developer_assets')
    .select('asset_id, ownership_pct, role')
    .eq('developer_id', developerId);

  if (linkErr || !links || links.length === 0) return [];

  const assetIds = links.map((l: DeveloperAssetLink) => l.asset_id);

  const { data, error } = await supabase
    .from('asset_registry')
    .select(`
      id, name, technology, status, capacity_mw, storage_mw,
      state, county, lat, lng, eia_plant_code, match_confidence,
      expected_cod, offtaker, confidence_score, confidence_breakdown,
      source_urls, graduated, blocking_reason, verified,
      staging_attempts, discovered_at, last_refreshed_at
    `)
    .in('id', assetIds)
    .order('name');

  if (error) {
    console.error('fetchDeveloperAssets error:', error.message);
    return [];
  }
  return data as AssetRegistryRow[];
}

export async function fetchCrawlLogs(developerId: string): Promise<CrawlLogRow[]> {
  const { data, error } = await supabase
    .from('developer_crawl_log')
    .select(`
      id, run_type, status, phase, rounds,
      total_cost_usd, assets_discovered, assets_graduated,
      assets_staged, eia_match_rate, avg_confidence,
      started_at, completed_at, error_log
    `)
    .eq('developer_id', developerId)
    .order('started_at', { ascending: false });

  if (error) {
    console.error('fetchCrawlLogs error:', error.message);
    return [];
  }
  return data as CrawlLogRow[];
}

export async function fetchChangelog(developerId: string): Promise<ChangelogRow[]> {
  const { data, error } = await supabase
    .from('developer_changelog')
    .select('id, change_type, asset_id, old_value, new_value, detected_at, detected_by')
    .eq('developer_id', developerId)
    .order('detected_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('fetchChangelog error:', error.message);
    return [];
  }
  return data as ChangelogRow[];
}

export async function fetchAssetDetail(assetId: string): Promise<AssetRegistryRow | null> {
  const { data, error } = await supabase
    .from('asset_registry')
    .select(`
      id, name, technology, status, capacity_mw, storage_mw,
      state, county, lat, lng, eia_plant_code, match_confidence,
      expected_cod, offtaker, confidence_score, confidence_breakdown,
      source_urls, graduated, blocking_reason, verified,
      staging_attempts, discovered_at, last_refreshed_at
    `)
    .eq('id', assetId)
    .single();

  if (error) return null;
  return data as AssetRegistryRow;
}

export async function fetchAssetOwners(assetId: string): Promise<{ developer_name: string; ownership_pct: number | null; role: string | null }[]> {
  const { data: links } = await supabase
    .from('developer_assets')
    .select('developer_id, ownership_pct, role')
    .eq('asset_id', assetId);

  if (!links || links.length === 0) return [];

  const devIds = links.map((l: { developer_id: string }) => l.developer_id);
  const { data: devs } = await supabase
    .from('developers')
    .select('id, name')
    .in('id', devIds);

  const devMap = new Map((devs || []).map((d: { id: string; name: string }) => [d.id, d.name]));

  return links.map((l: { developer_id: string; ownership_pct: number | null; role: string | null }) => ({
    developer_name: devMap.get(l.developer_id) || 'Unknown',
    ownership_pct: l.ownership_pct,
    role: l.role,
  }));
}

// ── Actions ──────────────────────────────────────────────────────────────────

export async function approveStagedAssets(assetIds: string[]): Promise<number> {
  let approved = 0;
  for (const id of assetIds) {
    const { error } = await supabase
      .from('asset_registry')
      .update({
        graduated: true,
        blocking_reason: null,
        verified: true,
        verified_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (!error) approved++;
  }
  return approved;
}
