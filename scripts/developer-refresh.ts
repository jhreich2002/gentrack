/**
 * GenTrack — Phase 5: Developer Refresh Pipeline
 *
 * Three refresh tiers:
 *   Tier 1 — Pulse Check:   Quick Sonar query ($0.01-0.05) to detect major changes
 *   Tier 2 — Targeted:      Re-crawl specific assets flagged by pulse or staging
 *   Tier 3 — Full Re-crawl: Smart diff re-crawl with dedup against existing state
 *
 * Usage:
 *   $env:PERPLEXITY_API_KEY="..."
 *   $env:GEMINI_API_KEY="..."
 *   $env:SUPABASE_URL="..."
 *   $env:SUPABASE_SERVICE_ROLE_KEY="..."
 *   npx tsx scripts/developer-refresh.ts
 *
 * Optional env:
 *   DEVELOPER_NAME  — override (default: Cypress Creek Renewables)
 *   REFRESH_TIER    — "1", "2", or "3" (default: 1)
 *   BUDGET_LIMIT    — cap for this refresh run
 *   RESUME_STAGING  — "true" to re-attempt graduating staged assets
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Config ───────────────────────────────────────────────────────────────────

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY || '';
const SUPABASE_URL       = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DEVELOPER_NAME     = process.env.DEVELOPER_NAME || 'Cypress Creek Renewables';
const REFRESH_TIER       = parseInt(process.env.REFRESH_TIER || '1', 10) as 1 | 2 | 3;
const BUDGET_LIMIT       = parseFloat(process.env.BUDGET_LIMIT || '1.00');
const RESUME_STAGING     = process.env.RESUME_STAGING === 'true';

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const GEMINI_FLASH_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const DELAY_MS = 1500;

// ── Supabase Client ──────────────────────────────────────────────────────────

let db: SupabaseClient | null = null;
function getDb(): SupabaseClient {
  if (!db) {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    db = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return db;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface CostTracker {
  total_usd: number;
  call_count: number;
}

interface AssetRow {
  id: string;
  name: string;
  technology: string | null;
  status: string | null;
  capacity_mw: number | null;
  state: string | null;
  eia_plant_code: string | null;
  graduated: boolean;
  blocking_reason: string | null;
  confidence_score: number | null;
  last_refreshed_at: string | null;
  staging_attempts: number;
}

interface PulseResult {
  asset_name: string;
  change_detected: boolean;
  change_type: string | null;
  details: string;
  new_status: string | null;
  new_capacity_mw: number | null;
  new_owner: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates: Record<string, [number, number]> = {
    'sonar': [1.0, 1.0],
    'sonar-pro': [3.0, 15.0],
    'gemini-2.5-flash': [0.30, 2.50],
  };
  const [inRate, outRate] = rates[model] || [1.0, 5.0];
  const requestFee = model.startsWith('sonar') ? 0.005 : 0;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate + requestFee;
}

// ── API Calls ────────────────────────────────────────────────────────────────

async function callPerplexity(
  model: 'sonar' | 'sonar-pro',
  systemPrompt: string,
  userPrompt: string,
  cost: CostTracker,
): Promise<string> {
  if (!PERPLEXITY_API_KEY) throw new Error('PERPLEXITY_API_KEY not set');

  const res = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      return_citations: true,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Perplexity ${model} error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const text = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || {};
  const callCost = estimateCost(model, usage.prompt_tokens || 300, usage.completion_tokens || 500);
  cost.total_usd += callCost;
  cost.call_count++;

  log('PERPLEXITY', `${model} — $${callCost.toFixed(4)} — total $${cost.total_usd.toFixed(4)}`);
  return text;
}

async function callGemini(
  prompt: string,
  cost: CostTracker,
): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const res = await fetch(`${GEMINI_FLASH_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);

  const data = await res.json() as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const usage = data.usageMetadata || {};
  const callCost = estimateCost('gemini-2.5-flash', usage.promptTokenCount || 500, usage.candidatesTokenCount || 1000);
  cost.total_usd += callCost;
  cost.call_count++;

  return text;
}

// ── Tier 1: Pulse Check ──────────────────────────────────────────────────────

async function tier1PulseCheck(developerId: string, assets: AssetRow[], cost: CostTracker): Promise<void> {
  log('TIER1', `▶ Pulse check for ${DEVELOPER_NAME} (${assets.length} assets)`);

  // Batch assets into groups of 20 for efficiency
  const batchSize = 20;
  const batches: AssetRow[][] = [];
  for (let i = 0; i < assets.length; i += batchSize) {
    batches.push(assets.slice(i, i + batchSize));
  }

  const changes: PulseResult[] = [];
  const supabase = getDb();

  for (let bi = 0; bi < batches.length; bi++) {
    if (cost.total_usd >= BUDGET_LIMIT) {
      log('TIER1', `Budget limit reached ($${cost.total_usd.toFixed(4)})`);
      break;
    }

    const batch = batches[bi];
    const assetList = batch.map(a => `- ${a.name} (${a.capacity_mw || '?'} MW, ${a.state || '?'}, ${a.status || '?'})`).join('\n');

    const text = await callPerplexity('sonar', 
      'You are a renewable energy market analyst. Report ONLY confirmed changes from the last 6 months. Be factual and cite sources.',
      `Have there been any recent changes (last 6 months) to these ${DEVELOPER_NAME} renewable energy projects? Report ownership changes, status changes, capacity changes, or new developments.

${assetList}

For each project with a change, state:
- Project name (exact match from list)
- Change type (ownership_change, status_change, capacity_change, asset_divested)
- Brief details
- New value (if applicable)

If no changes found for a project, do NOT list it.`,
      cost
    );
    await sleep(DELAY_MS);

    // Parse with Gemini
    const parsed = await callGemini(
      `Extract change detections from this text. Return JSON array:
[{"asset_name": "exact name", "change_detected": true, "change_type": "ownership_change|status_change|capacity_change|asset_divested", "details": "brief", "new_status": null, "new_capacity_mw": null, "new_owner": null}]

If no changes detected, return empty array [].

TEXT:
${text.slice(0, 6000)}`,
      cost
    );

    try {
      const results: PulseResult[] = JSON.parse(parsed);
      changes.push(...results.filter(r => r.change_detected));
    } catch {
      log('TIER1', `Failed to parse batch ${bi + 1} results`);
    }
  }

  log('TIER1', `Detected ${changes.length} changes across ${assets.length} assets`);

  // Write changes to developer_changelog
  for (const change of changes) {
    const asset = assets.find(a => a.name.toLowerCase() === change.asset_name.toLowerCase());
    if (!asset) continue;

    const oldValue: Record<string, any> = {};
    const newValue: Record<string, any> = {};

    if (change.new_status) {
      oldValue.status = asset.status;
      newValue.status = change.new_status;
    }
    if (change.new_capacity_mw) {
      oldValue.capacity_mw = asset.capacity_mw;
      newValue.capacity_mw = change.new_capacity_mw;
    }
    if (change.new_owner) {
      newValue.new_owner = change.new_owner;
    }

    await supabase.from('developer_changelog').insert({
      developer_id: developerId,
      change_type: change.change_type || 'status_change',
      asset_id: asset.id,
      old_value: oldValue,
      new_value: { ...newValue, details: change.details },
      detected_by: 'pulse_check',
    });

    // Update asset if status/capacity changed
    const updates: Record<string, any> = { last_refreshed_at: new Date().toISOString() };
    if (change.new_status) updates.status = change.new_status;
    if (change.new_capacity_mw) updates.capacity_mw = change.new_capacity_mw;

    await supabase.from('asset_registry').update(updates).eq('id', asset.id);

    log('TIER1', `  Change: ${change.asset_name} — ${change.change_type}: ${change.details}`);
  }

  // Update developer pulse timestamp
  await supabase.from('developers').update({
    last_pulse_at: new Date().toISOString(),
    change_velocity: changes.length,
  }).eq('id', developerId);
}

// ── Tier 2: Targeted Refresh ─────────────────────────────────────────────────

async function tier2TargetedRefresh(developerId: string, assets: AssetRow[], cost: CostTracker): Promise<void> {
  // Only refresh staged assets or those with low confidence
  const targets = assets.filter(a => !a.graduated || (a.confidence_score && a.confidence_score < 70));
  log('TIER2', `▶ Targeted refresh for ${targets.length} assets`);

  const supabase = getDb();

  for (const asset of targets) {
    if (cost.total_usd >= BUDGET_LIMIT) {
      log('TIER2', `Budget limit reached`);
      break;
    }

    log('TIER2', `  Refreshing: ${asset.name} (blocking: ${asset.blocking_reason || 'low confidence'})`);

    const text = await callPerplexity('sonar-pro',
      'You are a renewable energy project analyst. Provide factual, verifiable information.',
      `Provide detailed information about the "${asset.name}" ${asset.technology || 'renewable energy'} project in ${asset.state || 'the US'} by ${DEVELOPER_NAME}:

1. Current status (operating, under construction, in development, planned)
2. Capacity in MW (nameplate)
3. Location (state, county)
4. Technology type
5. Expected or actual commercial operation date
6. PPA/offtaker details
7. Any recent ownership changes

Include specific numbers and dates.`,
      cost
    );
    await sleep(DELAY_MS);

    // Extract with Gemini
    const parsed = await callGemini(
      `Extract project details from this text. Return JSON:
{
  "name": "project name",
  "status": "operating|construction|development|planned|decommissioned",
  "capacity_mw": null,
  "state": null,
  "county": null,
  "technology": "solar|wind|storage|hybrid|nuclear|hydro|geothermal|biomass",
  "expected_cod": null,
  "offtaker": null,
  "verified": true
}

Only include fields that are explicitly stated. Set unmentioned fields to null.

TEXT:
${text.slice(0, 6000)}`,
      cost
    );

    try {
      const info = JSON.parse(parsed);
      const updates: Record<string, any> = {
        last_refreshed_at: new Date().toISOString(),
        refresh_source: 'quarterly_recrawl',
        staging_attempts: (asset.staging_attempts || 0) + 1,
      };

      if (info.capacity_mw && !asset.capacity_mw) updates.capacity_mw = info.capacity_mw;
      if (info.status) updates.status = info.status;
      if (info.county && !asset.state) updates.county = info.county;
      if (info.expected_cod) updates.expected_cod = info.expected_cod;
      if (info.offtaker) updates.offtaker = info.offtaker;

      // Check if we resolved the blocking reason
      if (asset.blocking_reason === 'missing: capacity_mw' && info.capacity_mw) {
        updates.blocking_reason = null;
        updates.graduated = true;
        updates.confidence_score = Math.max(asset.confidence_score || 0, 75);
        log('TIER2', `  ✓ Resolved "${asset.name}" — capacity_mw = ${info.capacity_mw} MW → graduated`);
      } else if (asset.blocking_reason?.startsWith('verification_failed') && info.verified) {
        updates.verified = true;
        updates.blocking_reason = null;
        updates.graduated = true;
        log('TIER2', `  ✓ Verified "${asset.name}" → graduated`);
      }

      await supabase.from('asset_registry').update(updates).eq('id', asset.id);
    } catch {
      log('TIER2', `  Failed to parse refresh for ${asset.name}`);
    }
  }
}

// ── Tier 3: Full Re-crawl (Smart Diff) ──────────────────────────────────────

async function tier3FullRecrawl(developerId: string, assets: AssetRow[], cost: CostTracker): Promise<void> {
  log('TIER3', `▶ Full smart-diff re-crawl for ${DEVELOPER_NAME}`);

  const supabase = getDb();
  const existingNames = new Set(assets.map(a => a.name.toLowerCase()));

  // Query Perplexity for comprehensive updated portfolio
  const text = await callPerplexity('sonar-pro',
    'You are a renewable energy analyst. Provide a comprehensive, factual list.',
    `List ALL renewable energy projects (solar, wind, storage, hybrid) currently in ${DEVELOPER_NAME}'s portfolio. Include:
- Projects operating, under construction, or in development
- Project name, state, capacity (MW), technology, status
- Any projects sold/divested in the last 12 months

Be comprehensive — include small community solar projects.`,
    cost
  );
  await sleep(DELAY_MS);

  // Extract structured list
  const parsed = await callGemini(
    `Extract all projects from this portfolio summary. Return JSON array:
[{
  "name": "project name",
  "state": "XX",
  "capacity_mw": null,
  "technology": "solar|wind|storage|hybrid",
  "status": "operating|construction|development|planned|decommissioned|divested"
}]

TEXT:
${text.slice(0, 8000)}`,
    cost
  );

  try {
    const projects: { name: string; state: string | null; capacity_mw: number | null; technology: string | null; status: string | null }[] = JSON.parse(parsed);
    log('TIER3', `Found ${projects.length} projects in re-crawl`);

    let newAssets = 0;
    let updatedAssets = 0;

    for (const proj of projects) {
      const normName = proj.name.toLowerCase().trim();
      const isExisting = existingNames.has(normName) || assets.some(a => 
        a.name.toLowerCase().includes(normName) || normName.includes(a.name.toLowerCase())
      );

      if (isExisting) {
        // Update existing asset if we have new info
        const existing = assets.find(a => 
          a.name.toLowerCase() === normName ||
          a.name.toLowerCase().includes(normName) || 
          normName.includes(a.name.toLowerCase())
        );
        if (existing) {
          const updates: Record<string, any> = { last_refreshed_at: new Date().toISOString() };
          if (proj.status === 'divested') {
            updates.status = 'decommissioned';
            await supabase.from('developer_changelog').insert({
              developer_id: developerId,
              change_type: 'asset_divested',
              asset_id: existing.id,
              new_value: { status: 'divested' },
              detected_by: 'full_recrawl',
            });
          }
          if (proj.capacity_mw && !existing.capacity_mw) updates.capacity_mw = proj.capacity_mw;
          if (proj.status && proj.status !== 'divested') updates.status = proj.status;
          await supabase.from('asset_registry').update(updates).eq('id', existing.id);
          updatedAssets++;
        }
      } else {
        // New asset discovered in re-crawl
        const { data: newAsset, error } = await supabase
          .from('asset_registry')
          .upsert({
            name: proj.name,
            technology: proj.technology as any,
            status: proj.status === 'divested' ? 'decommissioned' : proj.status as any,
            capacity_mw: proj.capacity_mw,
            state: proj.state,
            graduated: false,
            blocking_reason: 'new_discovery_needs_verification',
            refresh_source: 'quarterly_recrawl',
            source_types: ['perplexity_recrawl'],
          }, { onConflict: 'idx_asset_registry_dedup', ignoreDuplicates: true })
          .select('id')
          .maybeSingle();

        if (newAsset) {
          await supabase.from('developer_assets')
            .upsert({ developer_id: developerId, asset_id: newAsset.id, role: 'developer' }, { onConflict: 'developer_id,asset_id' });

          await supabase.from('developer_changelog').insert({
            developer_id: developerId,
            change_type: 'asset_added',
            asset_id: newAsset.id,
            new_value: proj,
            detected_by: 'full_recrawl',
          });
          newAssets++;
        }
      }
    }

    log('TIER3', `Updated: ${updatedAssets}, New: ${newAssets}`);
  } catch (err) {
    log('TIER3', `Failed to parse re-crawl results: ${err}`);
  }

  // Update developer timestamps
  await supabase.from('developers').update({
    last_full_crawl_at: new Date().toISOString(),
    next_refresh_due: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  }).eq('id', developerId);
}

// ── Resume-from-Staging ──────────────────────────────────────────────────────

async function resumeStaging(developerId: string, assets: AssetRow[], cost: CostTracker): Promise<void> {
  const staged = assets.filter(a => !a.graduated);
  if (staged.length === 0) {
    log('STAGING', 'No staged assets to resolve');
    return;
  }

  log('STAGING', `▶ Attempting to resolve ${staged.length} staged assets`);
  await tier2TargetedRefresh(developerId, staged, cost);

  // Re-check graduation state
  const supabase = getDb();
  const { data: updated } = await supabase
    .from('asset_registry')
    .select('id, name, graduated')
    .in('id', staged.map(a => a.id));

  const resolved = (updated || []).filter((a: { graduated: boolean }) => a.graduated).length;
  log('STAGING', `Resolved ${resolved}/${staged.length} staged assets`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const supabase = getDb();
  const cost: CostTracker = { total_usd: 0, call_count: 0 };

  log('REFRESH', `▶ Developer Refresh Pipeline — Tier ${REFRESH_TIER} for ${DEVELOPER_NAME}`);
  log('REFRESH', `Budget: $${BUDGET_LIMIT.toFixed(2)} | Resume staging: ${RESUME_STAGING}`);

  // Load developer
  const { data: devRow } = await supabase
    .from('developers')
    .select('id, name, crawl_status')
    .ilike('name', `%${DEVELOPER_NAME}%`)
    .maybeSingle();

  if (!devRow) {
    log('REFRESH', `Developer "${DEVELOPER_NAME}" not found`);
    return;
  }
  const developerId = devRow.id;

  // Create crawl log entry
  const runType = RESUME_STAGING ? 'resume_staging' : REFRESH_TIER === 1 ? 'pulse' : REFRESH_TIER === 2 ? 'targeted' : 'full_recrawl';
  const { data: logRow } = await supabase
    .from('developer_crawl_log')
    .insert({
      developer_id: developerId,
      run_type: runType,
      status: 'running',
      budget_limit_usd: BUDGET_LIMIT,
    })
    .select('id')
    .single();

  const crawlRunId = logRow?.id;

  // Load assets
  const { data: links } = await supabase
    .from('developer_assets')
    .select('asset_id')
    .eq('developer_id', developerId);

  const assetIds = (links || []).map((l: { asset_id: string }) => l.asset_id);

  const { data: assetsData } = await supabase
    .from('asset_registry')
    .select('id, name, technology, status, capacity_mw, state, eia_plant_code, graduated, blocking_reason, confidence_score, last_refreshed_at, staging_attempts')
    .in('id', assetIds.length > 0 ? assetIds : ['00000000-0000-0000-0000-000000000000']);

  const assets = (assetsData || []) as AssetRow[];
  log('REFRESH', `Loaded ${assets.length} assets (${assets.filter(a => a.graduated).length} graduated, ${assets.filter(a => !a.graduated).length} staged)`);

  // Run appropriate tier
  try {
    if (RESUME_STAGING) {
      await resumeStaging(developerId, assets, cost);
    } else if (REFRESH_TIER === 1) {
      await tier1PulseCheck(developerId, assets, cost);
    } else if (REFRESH_TIER === 2) {
      await tier2TargetedRefresh(developerId, assets, cost);
    } else {
      await tier3FullRecrawl(developerId, assets, cost);
    }

    // Complete crawl log
    if (crawlRunId) {
      // Reload to get updated counts
      const { data: finalAssets } = await supabase
        .from('asset_registry')
        .select('id, graduated')
        .in('id', assetIds);

      const graduated = (finalAssets || []).filter((a: { graduated: boolean }) => a.graduated).length;
      const staged = (finalAssets || []).length - graduated;

      await supabase.from('developer_crawl_log').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_cost_usd: cost.total_usd,
        api_calls: { total: cost.call_count },
        assets_graduated: graduated,
        assets_staged: staged,
      }).eq('id', crawlRunId);
    }

    // Update developer total spend
    const { data: devData } = await supabase
      .from('developers')
      .select('total_spend_usd')
      .eq('id', developerId)
      .single();
    
    await supabase.from('developers').update({
      total_spend_usd: (devData?.total_spend_usd || 0) + cost.total_usd,
    }).eq('id', developerId);

  } catch (err: any) {
    log('REFRESH', `Error: ${err.message}`);
    if (crawlRunId) {
      await supabase.from('developer_crawl_log').update({
        status: 'failed',
        error_log: err.message,
        completed_at: new Date().toISOString(),
        total_cost_usd: cost.total_usd,
      }).eq('id', crawlRunId);
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`  REFRESH COMPLETE — Tier ${REFRESH_TIER}`);
  console.log(`  API Calls: ${cost.call_count}`);
  console.log(`  Cost:      $${cost.total_usd.toFixed(4)}`);
  console.log('='.repeat(50));
}

run().catch(err => {
  console.error('Refresh pipeline failed:', err);
  process.exit(1);
});
