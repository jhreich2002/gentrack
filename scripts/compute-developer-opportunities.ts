/**
 * compute-developer-opportunities.ts
 *
 * Builds actionable FTI lead scores for each developer portfolio.
 *
 * Usage:
 *   npx tsx scripts/compute-developer-opportunities.ts
 *
 * Environment:
 *   SUPABASE_URL or VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MODEL_VERSION = 'v1';
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

type DeveloperRow = {
  id: string;
  name: string;
  coverage_rate: number | null;
  verification_pct: number | null;
};

type AssetRow = {
  id: string;
  developer_id: string;
  eia_plant_code: string | null;
  capacity_mw: number | null;
  technology: string | null;
  state: string | null;
  expected_cod: string | null;
  graduated: boolean;
  verified: boolean;
  blocking_reason: string | null;
};

type PlantRow = {
  eia_plant_code: string;
  nameplate_capacity_mw: number | null;
  ttm_avg_factor: number | null;
  curtailment_score: number | null;
  is_likely_curtailed: boolean | null;
  is_maintenance_offline: boolean | null;
};

type OpportunityRow = {
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
};

type ExistingOpportunityRow = {
  developer_id: string;
  opportunity_score: number | null;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeNum(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value as number) ? Number(value) : fallback;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function uniqueCount(values: Array<string | null | undefined>): number {
  return new Set(values.filter((v): v is string => Boolean(v))).size;
}

function computeOpportunity(
  developer: DeveloperRow,
  assets: AssetRow[],
  plantsByCode: Map<string, PlantRow>,
  previousOpportunityScore: number | null
): OpportunityRow {
  const today = new Date();

  let totalMw = 0;
  let mappedCount = 0;
  let likelyCurtailedCount = 0;
  let maintenanceOfflineCount = 0;
  let highRiskCount = 0;
  let upcomingCodCount = 0;
  let lowCfCount = 0;
  let curtailmentSum = 0;
  let curtailmentN = 0;

  const techValues: string[] = [];
  const stateValues: string[] = [];

  for (const asset of assets) {
    const plant = asset.eia_plant_code ? plantsByCode.get(asset.eia_plant_code) : undefined;
    const mw = safeNum(plant?.nameplate_capacity_mw, safeNum(asset.capacity_mw, 0));
    totalMw += mw;

    if (asset.eia_plant_code && plant) mappedCount++;
    if (asset.technology) techValues.push(asset.technology);
    if (asset.state) stateValues.push(asset.state);

    const cod = parseDate(asset.expected_cod);
    if (cod) {
      const days = daysBetween(today, cod);
      if (days >= 0 && days <= 540) upcomingCodCount++;
    }

    const likelyCurtailed = Boolean(plant?.is_likely_curtailed);
    const maintenanceOffline = Boolean(plant?.is_maintenance_offline);
    const curtailment = safeNum(plant?.curtailment_score, 0);
    const ttm = plant?.ttm_avg_factor;

    if (likelyCurtailed) likelyCurtailedCount++;
    if (maintenanceOffline) maintenanceOfflineCount++;
    if (ttm != null && ttm < 0.15) lowCfCount++;

    if (plant?.curtailment_score != null) {
      curtailmentSum += curtailment;
      curtailmentN++;
    }

    const assetRisk = (
      (curtailment >= 60 ? 1 : 0) +
      (likelyCurtailed ? 1 : 0) +
      (maintenanceOffline ? 1 : 0) +
      (ttm != null && ttm < 0.15 ? 1 : 0)
    );

    if (assetRisk >= 2) highRiskCount++;
  }

  const assetCount = assets.length;
  const stagedCount = assets.filter((a) => !a.graduated).length;
  const unverifiedCount = assets.filter((a) => !a.verified).length;
  const stateCount = uniqueCount(stateValues);
  const techCount = uniqueCount(techValues);
  const avgCurtailment = curtailmentN > 0 ? curtailmentSum / curtailmentN : 0;

  const pctLikelyCurtailed = assetCount > 0 ? likelyCurtailedCount / assetCount : 0;
  const pctMaintenance = assetCount > 0 ? maintenanceOfflineCount / assetCount : 0;
  const pctLowCf = assetCount > 0 ? lowCfCount / assetCount : 0;
  const pctHighRisk = assetCount > 0 ? highRiskCount / assetCount : 0;
  const pctStaged = assetCount > 0 ? stagedCount / assetCount : 0;
  const pctUnverified = assetCount > 0 ? unverifiedCount / assetCount : 0;

  const distressScore = clamp(
    avgCurtailment * 0.45 +
    pctLikelyCurtailed * 100 * 0.25 +
    pctMaintenance * 100 * 0.15 +
    pctLowCf * 100 * 0.15,
    0,
    100
  );

  const complexityScore = clamp(
    (Math.min(stateCount, 12) / 12) * 30 +
    (Math.min(techCount, 6) / 6) * 20 +
    pctUnverified * 30 +
    pctStaged * 20,
    0,
    100
  );

  const coverageRate = developer.coverage_rate ?? null;
  const verificationPct = developer.verification_pct ?? null;

  const triggerImmediacyScore = clamp(
    (assetCount > 0 ? (upcomingCodCount / assetCount) : 0) * 100 * 0.45 +
    (coverageRate != null ? (1 - coverageRate) : 0.5) * 100 * 0.25 +
    pctStaged * 100 * 0.2 +
    pctHighRisk * 100 * 0.1,
    0,
    100
  );

  const scaledMw = clamp((Math.log10(totalMw + 1) / Math.log10(10000)) * 100, 0, 100);
  const engagementPotentialScore = clamp(
    scaledMw * 0.6 +
    pctHighRisk * 100 * 0.25 +
    (assetCount > 0 ? (mappedCount / assetCount) : 0) * 100 * 0.15,
    0,
    100
  );

  const opportunityScore = clamp(
    distressScore * 0.35 +
    complexityScore * 0.25 +
    triggerImmediacyScore * 0.2 +
    engagementPotentialScore * 0.2,
    0,
    100
  );

  const roundedScore = Number(opportunityScore.toFixed(2));
  const roundedPrev = previousOpportunityScore == null ? null : Number(previousOpportunityScore.toFixed(2));
  const weeklyDelta = roundedPrev == null ? null : Number((roundedScore - roundedPrev).toFixed(2));

  const signals: string[] = [];
  if (pctLikelyCurtailed >= 0.2) signals.push(`${Math.round(pctLikelyCurtailed * 100)}% assets likely curtailed`);
  if (avgCurtailment >= 45) signals.push(`average curtailment score ${avgCurtailment.toFixed(0)}`);
  if (upcomingCodCount > 0) signals.push(`${upcomingCodCount} assets with near-term COD milestone`);
  if (stateCount >= 4) signals.push(`multi-state complexity across ${stateCount} states`);
  if (pctStaged >= 0.2) signals.push(`${Math.round(pctStaged * 100)}% assets pending verification`);
  if (signals.length === 0) signals.push('portfolio scale and quality suggest moderate advisory potential');

  const serviceLines: string[] = [];
  if (distressScore >= 60) serviceLines.push('performance_turnaround');
  if (triggerImmediacyScore >= 55) serviceLines.push('refinance_readiness');
  if (complexityScore >= 55) serviceLines.push('portfolio_optimization');
  if (engagementPotentialScore >= 60) serviceLines.push('capital_structure_advisory');
  if (serviceLines.length === 0) serviceLines.push('monitoring_watchlist');

  return {
    developer_id: developer.id,
    developer_name: developer.name,
    model_version: MODEL_VERSION,
    opportunity_score: roundedScore,
    distress_score: Number(distressScore.toFixed(2)),
    complexity_score: Number(complexityScore.toFixed(2)),
    trigger_immediacy_score: Number(triggerImmediacyScore.toFixed(2)),
    engagement_potential_score: Number(engagementPotentialScore.toFixed(2)),
    total_mw_at_risk: Number(totalMw.toFixed(2)),
    asset_count: assetCount,
    mapped_asset_count: mappedCount,
    high_risk_asset_count: highRiskCount,
    likely_curtailed_count: likelyCurtailedCount,
    maintenance_offline_count: maintenanceOfflineCount,
    upcoming_cod_count: upcomingCodCount,
    coverage_rate: coverageRate,
    verification_pct: verificationPct,
    top_signals: signals.slice(0, 3),
    recommended_service_lines: serviceLines,
    previous_opportunity_score: roundedPrev,
    weekly_delta_score: weeklyDelta,
    computed_at: new Date().toISOString(),
  };
}

async function fetchExistingScores(client: SupabaseClient): Promise<Map<string, number>> {
  const { data, error } = await client
    .from('developer_opportunity_scores')
    .select('developer_id, opportunity_score');

  if (error || !data) return new Map<string, number>();

  const map = new Map<string, number>();
  for (const row of data as ExistingOpportunityRow[]) {
    if (row.opportunity_score != null) map.set(row.developer_id, Number(row.opportunity_score));
  }
  return map;
}

async function fetchDevelopers(client: SupabaseClient): Promise<DeveloperRow[]> {
  const { data, error } = await client
    .from('developers')
    .select('id, name, coverage_rate, verification_pct')
    .gt('asset_count_discovered', 0)
    .order('name');

  if (error) throw error;
  return (data ?? []) as DeveloperRow[];
}

async function fetchAssets(client: SupabaseClient): Promise<AssetRow[]> {
  const { data, error } = await client
    .from('developer_assets')
    .select(`
      developer_id,
      asset:asset_registry (
        id, eia_plant_code, capacity_mw, technology, state,
        expected_cod, graduated, verified, blocking_reason
      )
    `);

  if (error) throw error;

  const rows: AssetRow[] = [];
  for (const row of data ?? []) {
    const asset = (row as any).asset;
    if (!asset) continue;
    rows.push({
      id: asset.id,
      developer_id: (row as any).developer_id,
      eia_plant_code: asset.eia_plant_code,
      capacity_mw: asset.capacity_mw,
      technology: asset.technology,
      state: asset.state,
      expected_cod: asset.expected_cod,
      graduated: Boolean(asset.graduated),
      verified: Boolean(asset.verified),
      blocking_reason: asset.blocking_reason,
    });
  }

  return rows;
}

async function fetchPlants(client: SupabaseClient): Promise<Map<string, PlantRow>> {
  const { data, error } = await client
    .from('plants')
    .select('eia_plant_code, nameplate_capacity_mw, ttm_avg_factor, curtailment_score, is_likely_curtailed, is_maintenance_offline');

  if (error) throw error;

  const map = new Map<string, PlantRow>();
  for (const row of (data ?? []) as PlantRow[]) {
    map.set(row.eia_plant_code, row);
  }
  return map;
}

async function run() {
  console.log(`[LEADS] Starting developer opportunity scoring (dry-run=${DRY_RUN})`);

  const [developers, assets, plantsByCode, existingScores] = await Promise.all([
    fetchDevelopers(supabase),
    fetchAssets(supabase),
    fetchPlants(supabase),
    fetchExistingScores(supabase),
  ] as const);

  const assetsByDeveloper = new Map<string, AssetRow[]>();
  for (const asset of assets) {
    const list = assetsByDeveloper.get(asset.developer_id);
    if (list) list.push(asset);
    else assetsByDeveloper.set(asset.developer_id, [asset]);
  }

  const rows: OpportunityRow[] = developers.map((developer) => {
    const devAssets = assetsByDeveloper.get(developer.id) ?? [];
    const previous = existingScores.get(developer.id) ?? null;
    return computeOpportunity(developer, devAssets, plantsByCode, previous);
  });

  rows.sort((a, b) => b.opportunity_score - a.opportunity_score);

  console.log(`[LEADS] Computed ${rows.length} developer opportunity rows`);
  console.table(rows.slice(0, 15).map((r) => ({
    developer: r.developer_name,
    score: r.opportunity_score,
    distress: r.distress_score,
    triggers: r.trigger_immediacy_score,
    mw: r.total_mw_at_risk,
    signal: r.top_signals[0] || '',
  })));

  if (!DRY_RUN) {
    const { error } = await supabase
      .from('developer_opportunity_scores')
      .upsert(rows, { onConflict: 'developer_id' });

    if (error) throw error;
    console.log('[LEADS] Upserted developer_opportunity_scores successfully');

    const historyRows = rows.map((r) => ({
      developer_id: r.developer_id,
      developer_name: r.developer_name,
      model_version: r.model_version,
      opportunity_score: r.opportunity_score,
      distress_score: r.distress_score,
      complexity_score: r.complexity_score,
      trigger_immediacy_score: r.trigger_immediacy_score,
      engagement_potential_score: r.engagement_potential_score,
      weekly_delta_score: r.weekly_delta_score,
      top_signals: r.top_signals,
      recommended_service_lines: r.recommended_service_lines,
      computed_at: r.computed_at,
    }));

    const { error: historyErr } = await supabase
      .from('developer_opportunity_score_history')
      .insert(historyRows);

    if (historyErr) throw historyErr;
    console.log('[LEADS] Inserted developer_opportunity_score_history snapshot');
  }

  const outPath = path.resolve(process.cwd(), 'logs', `developer-opportunity-scores-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
  console.log(`[LEADS] Saved report: ${outPath}`);
}

run().catch((err) => {
  console.error('[LEADS] Failed:', err);
  process.exit(1);
});
