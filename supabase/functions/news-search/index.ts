/**
 * GenTrack — news-search Edge Function (Deno)
 *
 * Uses Perplexity sonar to do a one-time initial news sweep for curtailed plants
 * that have confirmed lenders (lenders_found=true) but no prior news ingest.
 *
 * For each plant:
 *   1. Calls Perplexity sonar with a broad news query about the plant
 *   2. Stores each citation URL as a news_articles row (pipeline='plant_news')
 *   3. Saves Perplexity's prose overview to plant_news_state.summary_text
 *   4. Marks news_initial_ingest_at
 *
 * After initial sweep, weekly RSS (news-ingest) takes over for ongoing updates.
 *
 * POST body:
 *   { plantCount?: number, offset?: number, limit?: number }
 *
 * Self-batching: processes `limit` plants per call (default 5).
 *
 * Required secrets:
 *   PERPLEXITY_API_KEY        — from perplexity.ai/settings/api
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_PLANT_COUNT    = 9999;
const DEFAULT_BATCH_LIMIT    = 5;     // plants per call (Perplexity is slow)
const DELAY_BETWEEN_PLANTS_MS = 1500;

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const MODEL          = 'sonar';       // sonar (cheaper) is sufficient for news

// ── Supabase client ────────────────────────────────────────────────────────────

function makeSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function sha256(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface PlantInfo {
  eia_plant_code:        string;
  name:                  string;
  owner:                 string | null;
  state:                 string;
  fuel_source:           string;
  nameplate_capacity_mw: number;
}

// ── Prompt ─────────────────────────────────────────────────────────────────────

function buildPrompt(plant: PlantInfo): string {
  const capacity = Math.round(plant.nameplate_capacity_mw);
  const ownerClause = plant.owner ? `, owned by ${plant.owner}` : '';
  return `What is the most recent news about "${plant.name}", a ${capacity} MW ${plant.fuel_source} power plant in ${plant.state}${ownerClause}? Include operational issues, curtailment events, output reductions, ownership changes, regulatory filings, bankruptcy or distress, and any financial news from the past 3 years.`;
}

// ── Perplexity call ────────────────────────────────────────────────────────────

async function searchPlantNews(plant: PlantInfo): Promise<{
  overview:  string;
  citations: string[];  // plain URL strings
}> {
  const apiKey = Deno.env.get('PERPLEXITY_API_KEY');
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  const res = await fetch(PERPLEXITY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:           MODEL,
      messages: [
        {
          role:    'system',
          content: 'You are a power industry analyst. Summarize recent news about the given power plant concisely and factually. Focus on operational issues, financial distress, curtailment, ownership changes, and regulatory developments.',
        },
        { role: 'user', content: buildPrompt(plant) },
      ],
      temperature:      0.2,
      return_citations: true,
      return_images:    false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Perplexity HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const overview: string = data.choices?.[0]?.message?.content ?? '';
  const citations: string[] = (data.citations ?? [])
    .filter((c: unknown): c is string => typeof c === 'string' && c.startsWith('http'));

  return { overview, citations };
}

// ── Plant discovery ────────────────────────────────────────────────────────────

async function loadPlants(
  sb:         ReturnType<typeof createClient>,
  plantCount: number,
  offset:     number,
  limit:      number,
): Promise<{ plants: PlantInfo[]; totalEligible: number }> {
  // Get plants with confirmed lenders that haven't had initial news sweep
  const { data: summaryData } = await sb
    .from('plant_financing_summary')
    .select('eia_plant_code')
    .eq('lenders_found', true);

  const lenderPlantCodes = new Set(
    (summaryData ?? []).map((r: { eia_plant_code: string }) => r.eia_plant_code)
  );

  if (lenderPlantCodes.size === 0) {
    return { plants: [], totalEligible: 0 };
  }

  // Find which ones already have news_initial_ingest_at set
  const { data: stateData } = await sb
    .from('plant_news_state')
    .select('eia_plant_code')
    .not('news_initial_ingest_at', 'is', null)
    .in('eia_plant_code', [...lenderPlantCodes]);

  const alreadyIngested = new Set(
    (stateData ?? []).map((r: { eia_plant_code: string }) => r.eia_plant_code)
  );

  const eligible = [...lenderPlantCodes].filter(c => !alreadyIngested.has(c));
  const totalEligible = Math.min(eligible.length, plantCount);
  const batch = eligible.slice(offset, Math.min(offset + limit, plantCount));

  if (batch.length === 0) return { plants: [], totalEligible };

  const { data: plantsData } = await sb
    .from('plants')
    .select('id, eia_plant_code, name, owner, state, fuel_source, nameplate_capacity_mw')
    .in('eia_plant_code', batch);

  console.log(`Eligible (lenders confirmed, no news): ${eligible.length}, cap: ${plantCount}, batch: ${batch.length}`);

  return { plants: (plantsData ?? []) as PlantInfo[], totalEligible };
}

// ── Save results ───────────────────────────────────────────────────────────────

async function saveResults(
  sb:        ReturnType<typeof createClient>,
  plant:     PlantInfo,
  overview:  string,
  citations: string[],
): Promise<{ inserted: number }> {
  const now = new Date().toISOString();
  let inserted = 0;

  // 1. Insert each citation as a news_articles row
  for (const url of citations) {
    const externalId = await sha256(url);
    let hostname = url;
    try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep */ }

    const { error } = await sb.from('news_articles').upsert({
      external_id:     externalId,
      title:           hostname,   // will be enriched by downstream ranking
      description:     null,
      content:         null,
      source_name:     hostname,
      url,
      published_at:    null,
      query_tag:       `news-search:${plant.eia_plant_code}`,
      plant_codes:     [plant.eia_plant_code],
      owner_names:     plant.owner ? [plant.owner] : [],
      states:          [plant.state],
      fuel_types:      [plant.fuel_source],
      topics:          [],
      sentiment_label: null,
      pipeline:        'plant_news',
    }, { onConflict: 'external_id', ignoreDuplicates: true });

    if (!error) inserted++;
  }

  // 2. Save Perplexity overview as plant news summary
  await sb.from('plant_news_state').upsert({
    eia_plant_code:        plant.eia_plant_code,
    summary_text:          overview || null,
    news_initial_ingest_at: now,
    updated_at:            now,
  }, { onConflict: 'eia_plant_code' });

  return { inserted };
}

// ── Chain call helper ──────────────────────────────────────────────────────────

function fireAndForget(url: string, body: Record<string, unknown>): void {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body:    JSON.stringify(body),
  }).catch(err => console.error('Chain call failed:', err));
}

// ── Handler ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  let body: { plantCount?: number; offset?: number; limit?: number };
  try { body = await req.json(); } catch { body = {}; }

  const plantCount = body.plantCount ?? DEFAULT_PLANT_COUNT;
  const offset     = body.offset     ?? 0;
  const limit      = body.limit      ?? DEFAULT_BATCH_LIMIT;

  const sb          = makeSupabase();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  try {
    const { plants, totalEligible } = await loadPlants(sb, plantCount, offset, limit);

    if (plants.length === 0) {
      return new Response(JSON.stringify({ ok: true, message: 'No plants to process', inserted: 0 }), { headers: CORS });
    }

    let totalInserted = 0;
    const results: { plant: string; citations: number; inserted: number; error?: string }[] = [];

    for (let i = 0; i < plants.length; i++) {
      const plant = plants[i];
      console.log(`[${offset + i + 1}/${totalEligible}] ${plant.name} (${plant.eia_plant_code})`);

      try {
        const { overview, citations } = await searchPlantNews(plant);
        console.log(`  citations=${citations.length}, overview_len=${overview.length}`);

        const { inserted } = await saveResults(sb, plant, overview, citations);
        totalInserted += inserted;
        results.push({ plant: plant.name, citations: citations.length, inserted });
      } catch (err) {
        const errMsg = String(err);
        console.error(`  Error for ${plant.name}:`, errMsg);
        results.push({ plant: plant.name, citations: 0, inserted: 0, error: errMsg });
      }

      if (i < plants.length - 1) await sleep(DELAY_BETWEEN_PLANTS_MS);
    }

    // Self-batch
    const nextOffset  = offset + limit;
    const isLastBatch = nextOffset >= totalEligible;

    if (!isLastBatch) {
      console.log(`Self-batching: next offset=${nextOffset}`);
      fireAndForget(`${supabaseUrl}/functions/v1/news-search`, { plantCount, offset: nextOffset, limit });
    }

    return new Response(JSON.stringify({
      ok: true,
      batch: { offset, limit, plantCount, isLastBatch },
      totalInserted,
      plantsProcessed: plants.length,
      results,
    }), { headers: CORS });

  } catch (err) {
    console.error('news-search fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
