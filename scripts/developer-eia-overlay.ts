/**
 * GenTrack — Phase 4: EIA Overlay + Validation
 *
 * Closes the recall gap by creating asset_registry entries for EIA plants
 * that were NOT discovered by the crawl. These are often small community
 * solar farms (<5 MW) with no web presence.
 *
 * Usage:
 *   $env:SUPABASE_URL="..."
 *   $env:SUPABASE_SERVICE_ROLE_KEY="..."
 *   npx tsx scripts/developer-eia-overlay.ts
 *
 * Optional env:
 *   DEVELOPER_NAME  — override (default: Cypress Creek Renewables)
 *   DRY_RUN         — "true" to skip writes, print only
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DEVELOPER_NAME = process.env.DEVELOPER_NAME || 'Cypress Creek Renewables';
const DRY_RUN = process.env.DRY_RUN === 'true';

let db: SupabaseClient | null = null;
function getDb(): SupabaseClient {
  if (!db) {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    db = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return db;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface EIAPlant {
  id: string;
  eia_plant_code: string;
  name: string;
  owner: string;
  state: string;
  county: string | null;
  fuel_source: string;
  nameplate_capacity_mw: number;
  lat: number | null;
  lng: number | null;
}

interface AssetRow {
  id: string;
  name: string;
  eia_plant_code: string | null;
  match_confidence: string | null;
  state: string | null;
  technology: string | null;
  capacity_mw: number | null;
  graduated: boolean;
}

interface ValidationReport {
  developer: string;
  eia_total: number;
  registry_total: number;
  matched_already: number;
  overlay_created: number;
  recall_before: number;
  recall_after: number;
  precision: number;
  unmatched_eia: EIAPlant[];
  staged_assets: AssetRow[];
  cost_usd: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  console.log(`[${tag}] ${msg}`);
}

function normalizeFuelSource(fs: string): string {
  const map: Record<string, string> = {
    'solar': 'solar', 'wind': 'wind', 'nuclear': 'nuclear',
    'storage': 'storage', 'batteries': 'storage', 'battery': 'storage',
    'hydro': 'hydro', 'hydroelectric': 'hydro',
    'geothermal': 'geothermal', 'biomass': 'biomass',
  };
  return map[fs.toLowerCase()] || fs.toLowerCase();
}

// ── Phase 4 Pipeline ─────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const supabase = getDb();
  log('OVERLAY', `▶ Starting EIA Overlay for ${DEVELOPER_NAME} (DRY_RUN=${DRY_RUN})`);

  // 1. Load all EIA plants for this developer
  const { data: eiaPlants, error: eiaErr } = await supabase
    .from('plants')
    .select('id, eia_plant_code, name, owner, state, county, fuel_source, nameplate_capacity_mw, lat, lng')
    .ilike('owner', `%${DEVELOPER_NAME}%`);

  if (eiaErr || !eiaPlants) {
    log('OVERLAY', `Failed to load EIA plants: ${eiaErr?.message}`);
    return;
  }
  log('OVERLAY', `Loaded ${eiaPlants.length} EIA plants`);

  // 2. Load developer record
  const { data: devRow } = await supabase
    .from('developers')
    .select('id')
    .ilike('name', `%${DEVELOPER_NAME}%`)
    .maybeSingle();

  if (!devRow) {
    log('OVERLAY', `Developer "${DEVELOPER_NAME}" not found in developers table`);
    return;
  }
  const developerId = devRow.id;
  log('OVERLAY', `Developer ID: ${developerId}`);

  // 3. Load all existing asset_registry entries for this developer
  const { data: existingLinks } = await supabase
    .from('developer_assets')
    .select('asset_id')
    .eq('developer_id', developerId);

  const existingAssetIds = new Set((existingLinks || []).map((l: { asset_id: string }) => l.asset_id));

  const { data: existingAssets } = await supabase
    .from('asset_registry')
    .select('id, name, eia_plant_code, match_confidence, state, technology, capacity_mw, graduated')
    .in('id', existingAssetIds.size > 0 ? Array.from(existingAssetIds) : ['00000000-0000-0000-0000-000000000000']);

  const assets = (existingAssets || []) as AssetRow[];
  log('OVERLAY', `Found ${assets.length} existing assets in registry`);

  // 4. Find which EIA plant codes are already matched
  const matchedCodes = new Set<string>();
  for (const asset of assets) {
    if (asset.eia_plant_code) matchedCodes.add(asset.eia_plant_code);
  }

  const unmatchedEIA = eiaPlants.filter((p: EIAPlant) => !matchedCodes.has(p.eia_plant_code));
  log('OVERLAY', `EIA matched already: ${matchedCodes.size}, EIA unmatched: ${unmatchedEIA.length}`);

  // 5. Create asset_registry entries for unmatched EIA plants
  let overlayCreated = 0;
  for (const plant of unmatchedEIA) {
    const tech = normalizeFuelSource(plant.fuel_source);

    if (DRY_RUN) {
      log('OVERLAY', `[DRY_RUN] Would create: ${plant.name} (${plant.eia_plant_code}) — ${tech} ${plant.nameplate_capacity_mw} MW in ${plant.state}`);
      overlayCreated++;
      continue;
    }

    // Try to find an existing asset by name+state first (dedup)
    const { data: existing } = await supabase
      .from('asset_registry')
      .select('id')
      .ilike('name', plant.name)
      .eq('state', plant.state || '')
      .maybeSingle();

    let assetId: string | null = null;

    if (existing) {
      // Update existing asset with EIA data
      await supabase
        .from('asset_registry')
        .update({
          eia_plant_code: plant.eia_plant_code,
          match_confidence: 'high',
          capacity_mw: plant.nameplate_capacity_mw,
          county: plant.county,
          lat: plant.lat,
          lng: plant.lng,
        })
        .eq('id', existing.id);
      assetId = existing.id;
    } else {
      // Insert new asset
      const { data: inserted, error: insertErr } = await supabase
        .from('asset_registry')
        .insert({
          name: plant.name,
          technology: tech as any,
          status: 'operating',
          capacity_mw: plant.nameplate_capacity_mw,
          state: plant.state,
          county: plant.county,
          lat: plant.lat,
          lng: plant.lng,
          eia_plant_code: plant.eia_plant_code,
          match_confidence: 'high',
          graduated: true,
          verified: true,
          confidence_score: 100,
          confidence_breakdown: { source: 'eia_overlay', reason: 'Direct EIA record — no web crawl needed' },
          source_urls: [],
          source_types: ['eia_860'],
          refresh_source: 'initial_crawl',
        })
        .select('id')
        .single();

      if (insertErr) {
        log('OVERLAY', `Failed to insert ${plant.name}: ${insertErr.message}`);
        continue;
      }
      assetId = inserted?.id || null;
    }

    if (assetId) {
      // Link asset to developer
      await supabase
        .from('developer_assets')
        .upsert(
          { developer_id: developerId, asset_id: assetId, role: 'developer' },
          { onConflict: 'developer_id,asset_id' }
        );
      overlayCreated++;
    }
  }

  // 6. Reload and compute metrics
  const { data: finalAssets } = await supabase
    .from('developer_assets')
    .select('asset_id')
    .eq('developer_id', developerId);

  const finalAssetIds = (finalAssets || []).map((l: { asset_id: string }) => l.asset_id);

  const { data: allFinal } = await supabase
    .from('asset_registry')
    .select('id, name, eia_plant_code, match_confidence, graduated, verified, confidence_score, blocking_reason')
    .in('id', finalAssetIds.length > 0 ? finalAssetIds : ['00000000-0000-0000-0000-000000000000']);

  const finalAll = (allFinal || []) as (AssetRow & { verified: boolean; confidence_score: number; blocking_reason: string | null })[];
  const finalWithEIA = finalAll.filter(a => a.eia_plant_code);
  const finalGraduated = finalAll.filter(a => a.graduated);
  const finalStaged = finalAll.filter(a => !a.graduated);

  // Recall = EIA plants we have matched / total EIA plants
  const recallBefore = matchedCodes.size / eiaPlants.length;
  const recallAfter = finalWithEIA.length / eiaPlants.length;

  // Precision = assets with high-confidence EIA match / all matched
  const highConfidence = finalAll.filter(a => a.match_confidence === 'high');
  const precision = finalWithEIA.length > 0 ? highConfidence.length / finalWithEIA.length : 0;

  const report: ValidationReport = {
    developer: DEVELOPER_NAME,
    eia_total: eiaPlants.length,
    registry_total: finalAll.length,
    matched_already: matchedCodes.size,
    overlay_created: overlayCreated,
    recall_before: recallBefore,
    recall_after: recallAfter,
    precision,
    unmatched_eia: unmatchedEIA.slice(0, 10),
    staged_assets: finalStaged,
    cost_usd: 0,
  };

  // 7. Update developer stats
  if (!DRY_RUN) {
    await supabase
      .from('developers')
      .update({
        eia_benchmark_count: eiaPlants.length,
        coverage_rate: recallAfter,
        avg_confidence: finalAll.reduce((s, a) => s + (a.confidence_score || 0), 0) / (finalAll.length || 1),
        verification_pct: finalAll.filter(a => a.verified).length / (finalAll.length || 1),
        asset_count_discovered: finalAll.length,
        crawl_status: 'completed',
      })
      .eq('id', developerId);
  }

  // 8. Print validation report
  console.log('\n' + '='.repeat(60));
  console.log('  PHASE 4 VALIDATION REPORT');
  console.log('='.repeat(60));
  console.log(`  Developer:          ${report.developer}`);
  console.log(`  EIA Ground Truth:   ${report.eia_total} plants`);
  console.log(`  Registry Total:     ${report.registry_total} assets`);
  console.log(`  Already Matched:    ${report.matched_already}`);
  console.log(`  Overlay Created:    ${report.overlay_created}`);
  console.log(`  Recall (before):    ${(report.recall_before * 100).toFixed(1)}%`);
  console.log(`  Recall (after):     ${(report.recall_after * 100).toFixed(1)}%`);
  console.log(`  Precision (high):   ${(report.precision * 100).toFixed(1)}%`);
  console.log(`  Graduated:          ${finalGraduated.length}`);
  console.log(`  Staged:             ${finalStaged.length}`);
  console.log(`  API Cost:           $${report.cost_usd.toFixed(2)} (no LLM calls)`);
  console.log('='.repeat(60));

  if (finalStaged.length > 0) {
    console.log('\n📋 Staged Assets (did not graduate):');
    for (const a of finalStaged) {
      console.log(`  • ${a.name} — ${a.blocking_reason || 'unknown reason'}`);
    }
  }

  // Write report to file
  const reportPath = `logs/phase4-validation-${DEVELOPER_NAME.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const outPath = path.join(__dirname, '..', reportPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  log('OVERLAY', `Report saved to ${reportPath}`);
}

run().catch(err => {
  console.error('Phase 4 failed:', err);
  process.exit(1);
});
