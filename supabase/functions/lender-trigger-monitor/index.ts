/**
 * GenTrack — lender-trigger-monitor Edge Function (Deno)
 *
 * Weekly monitor that scans for events making a lender pitch timely.
 * Writes detected events to lender_trigger_events table.
 *
 * Trigger types:
 *   covenant_waiver         — New 8-K filings mentioning covenant/amendment + known plant/lender
 *   accelerating_curtailment — Plant CF trending worse over last 3 months vs prior 3 months
 *   ownership_change        — Plant owner name changed in EIA data since last check
 *   market_refinancing      — Perplexity: recent refinancing at comparable plants (market signal)
 *
 * Schedule: Weekly cron — Monday 7am UTC (configured in lender_currency_cron.sql)
 *
 * POST body: {} (no parameters needed — processes all known lender/plant combos)
 *
 * Required secrets:
 *   PERPLEXITY_API_KEY
 *   SUPABASE_URL              (auto-injected)
 *   SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

const PERPLEXITY_URL    = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL  = 'sonar-pro';
const EDGAR_SEARCH_URL  = 'https://efts.sec.gov/LATEST/search-index';

// Curtailment acceleration threshold: if last-3-month CF dropped by this fraction
// vs prior-3-month CF, flag as accelerating curtailment
const CURTAILMENT_ACCELERATION_THRESHOLD = 0.10; // 10% relative drop

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

// ── Supabase client ───────────────────────────────────────────────────────────

function makeSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [TRIGGER:${tag}] ${msg}`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Fetch with timeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TriggerEvent {
  eia_plant_code: string;
  lender_name:    string | null;
  trigger_type:   'covenant_waiver' | 'accelerating_curtailment' | 'ownership_change' | 'market_refinancing';
  evidence:       string;
  source_url:     string | null;
}

// ── Signal 1: Covenant waivers via EDGAR 8-K filings ─────────────────────────

async function detectCovenantWaivers(
  sb: ReturnType<typeof makeSupabase>,
): Promise<TriggerEvent[]> {
  const events: TriggerEvent[] = [];

  // Load known plant-lender combos (high/medium confidence, active/unknown status)
  const { data: lenderData } = await sb
    .from('plant_lenders')
    .select('eia_plant_code, lender_name, plants!inner(name, state)')
    .in('confidence', ['high', 'medium'])
    .or('loan_status.is.null,loan_status.eq.active,loan_status.eq.unknown')
    .limit(200);

  if (!lenderData?.length) return events;

  // Search EDGAR for recent 8-K filings mentioning covenant/amendment + plant name
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today       = new Date().toISOString().slice(0, 10);

  // Build unique plant set to avoid duplicate EDGAR queries
  const plantsSeen = new Set<string>();
  const plantLenderMap = new Map<string, string[]>(); // plant_code → [lender_names]

  for (const row of lenderData) {
    const code = row.eia_plant_code;
    if (!plantLenderMap.has(code)) plantLenderMap.set(code, []);
    if (row.lender_name) plantLenderMap.get(code)!.push(row.lender_name);
    plantsSeen.add(code);
  }

  for (const row of lenderData) {
    const plantName: string = (row.plants as any)?.name ?? '';
    if (!plantName || plantsSeen.has(`done:${row.eia_plant_code}`)) continue;
    plantsSeen.add(`done:${row.eia_plant_code}`);

    // Search EDGAR for recent 8-K amendments/waivers mentioning this plant
    const covenantTerms = ['covenant waiver', 'amendment', 'forbearance', 'default notice'];
    for (const term of covenantTerms.slice(0, 2)) { // limit to 2 queries per plant
      const params = new URLSearchParams({
        q:         `"${plantName}" "${term}"`,
        dateRange: 'custom',
        startdt:   twoWeeksAgo,
        enddt:     today,
        forms:     '8-K',
      });

      try {
        const res = await fetchWithTimeout(
          `${EDGAR_SEARCH_URL}?${params}`,
          { headers: { 'User-Agent': 'GenTrack/1.0 contact@gentrack.io' } },
          8_000,
        );
        if (!res.ok) continue;

        const data = await res.json() as any;
        const hits = data.hits?.hits ?? [];

        for (const hit of hits) {
          const src     = hit._source ?? {};
          const accNo   = src.accession_no ?? '';
          const cik     = src.entity_id ?? '';
          const fileUrl = accNo && cik
            ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accNo.replace(/-/g, '')}/`
            : null;

          events.push({
            eia_plant_code: row.eia_plant_code,
            lender_name:    plantLenderMap.get(row.eia_plant_code)?.[0] ?? null,
            trigger_type:   'covenant_waiver',
            evidence:       `EDGAR 8-K filing (${src.period_of_report ?? 'recent'}) mentions "${plantName}" and "${term}". Form type: ${src.form_type ?? '8-K'}.`,
            source_url:     fileUrl,
          });
        }
      } catch { /* EDGAR failures are non-fatal */ }

      await sleep(400);
    }
  }

  log('COVENANT', `${events.length} potential covenant/amendment filings detected`);
  return events;
}

// ── Signal 2: Accelerating curtailment ───────────────────────────────────────

async function detectAcceleratingCurtailment(
  sb: ReturnType<typeof makeSupabase>,
): Promise<TriggerEvent[]> {
  const events: TriggerEvent[] = [];

  // Load curtailed plants with active lenders
  const { data: plants } = await sb
    .from('plants')
    .select('eia_plant_code, name')
    .eq('is_likely_curtailed', true)
    .in('eia_plant_code',
      (await sb.from('plant_lenders')
        .select('eia_plant_code')
        .in('confidence', ['high', 'medium'])
        .or('loan_status.is.null,loan_status.eq.active,loan_status.eq.unknown')
      ).data?.map((r: any) => r.eia_plant_code) ?? []
    )
    .limit(200);

  if (!plants?.length) return events;

  // Load last 6 months of generation data for these plants
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 7); // YYYY-MM

  const codes = plants.map((p: any) => p.eia_plant_code);
  const { data: genData } = await sb
    .from('monthly_generation')
    .select('plant_id, month, capacity_factor')
    .in('plant_id',
      (await sb.from('plants').select('id').in('eia_plant_code', codes)).data?.map((r: any) => r.id) ?? []
    )
    .gte('month', `${sixMonthsAgo}-01`)
    .order('month', { ascending: true });

  if (!genData?.length) return events;

  // Build plant_id → eia_plant_code map
  const { data: plantIdData } = await sb
    .from('plants')
    .select('id, eia_plant_code, name')
    .in('eia_plant_code', codes);

  const idToCode = new Map<string, { code: string; name: string }>(
    (plantIdData ?? []).map((p: any) => [p.id, { code: p.eia_plant_code, name: p.name }])
  );

  // Group CF by plant_id, sorted by month
  const plantGen = new Map<string, { month: string; cf: number }[]>();
  for (const row of genData) {
    if (!plantGen.has(row.plant_id)) plantGen.set(row.plant_id, []);
    if (row.capacity_factor != null) {
      plantGen.get(row.plant_id)!.push({ month: row.month, cf: row.capacity_factor });
    }
  }

  // Detect acceleration: compare last 3 months vs prior 3 months
  for (const [plantId, rows] of plantGen) {
    if (rows.length < 6) continue;
    const sorted   = rows.slice(-6); // last 6 months
    const prior3   = sorted.slice(0, 3);
    const recent3  = sorted.slice(3, 6);

    const priorAvg  = prior3.reduce((s, r) => s + r.cf, 0) / 3;
    const recentAvg = recent3.reduce((s, r) => s + r.cf, 0) / 3;

    if (priorAvg <= 0) continue;

    const dropFraction = (priorAvg - recentAvg) / priorAvg;
    if (dropFraction >= CURTAILMENT_ACCELERATION_THRESHOLD) {
      const info = idToCode.get(plantId);
      if (!info) continue;

      events.push({
        eia_plant_code: info.code,
        lender_name:    null, // affects all lenders at this plant
        trigger_type:   'accelerating_curtailment',
        evidence:       `${info.name}: capacity factor dropped from ${(priorAvg * 100).toFixed(1)}% (prior 3mo avg) to ${(recentAvg * 100).toFixed(1)}% (recent 3mo avg) — ${(dropFraction * 100).toFixed(1)}% relative decline.`,
        source_url:     null,
      });
    }
  }

  log('ACCEL', `${events.length} plants with accelerating curtailment`);
  return events;
}

// ── Signal 3: Ownership changes ───────────────────────────────────────────────

async function detectOwnershipChanges(
  sb: ReturnType<typeof makeSupabase>,
): Promise<TriggerEvent[]> {
  const events: TriggerEvent[] = [];

  // Load plants that have lenders and track ownership changes
  // Strategy: compare current owner in plants table vs the owner captured at
  // last lender ingest. Since we store notes in plant_lenders with owner name,
  // we can detect mismatches. A simpler approach: flag plants with lender records
  // where the plant_news_state.lender_ingest_checked_at is older than a year
  // AND the plant owner recently changed (we track this via plants.updated_at).

  // Load plants where updated_at is recent (last 30 days) and has active lenders
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: recentlyUpdated } = await sb
    .from('plants')
    .select('eia_plant_code, name, owner, updated_at')
    .gte('updated_at', thirtyDaysAgo)
    .eq('is_likely_curtailed', true)
    .limit(100);

  if (!recentlyUpdated?.length) return events;

  const updatedCodes = recentlyUpdated.map((p: any) => p.eia_plant_code);

  // Check which of these have lender ingest records older than the plant update
  const { data: stateData } = await sb
    .from('plant_news_state')
    .select('eia_plant_code, lender_ingest_checked_at')
    .in('eia_plant_code', updatedCodes)
    .not('lender_ingest_checked_at', 'is', null);

  const ingestCheckedMap = new Map<string, string>(
    (stateData ?? []).map((r: any) => [r.eia_plant_code, r.lender_ingest_checked_at])
  );

  for (const plant of recentlyUpdated) {
    const lastIngest = ingestCheckedMap.get(plant.eia_plant_code);
    if (!lastIngest) continue;

    // If plant was updated more recently than the last lender ingest, flag it
    if (plant.updated_at > lastIngest) {
      events.push({
        eia_plant_code: plant.eia_plant_code,
        lender_name:    null,
        trigger_type:   'ownership_change',
        evidence:       `Plant "${plant.name}" (owner: ${plant.owner ?? 'unknown'}) was updated on ${plant.updated_at.slice(0, 10)}, after the last lender ingest (${lastIngest.slice(0, 10)}). Ownership or operational status may have changed — lender records should be re-verified.`,
        source_url:     null,
      });
    }
  }

  log('OWNERSHIP', `${events.length} plants with potential ownership/update changes`);
  return events;
}

// ── Signal 4: Market refinancing signals ─────────────────────────────────────

async function detectMarketRefinancing(
  sb:      ReturnType<typeof makeSupabase>,
  apiKey:  string,
): Promise<TriggerEvent[]> {
  const events: TriggerEvent[] = [];

  // Get the fuel types we have curtailed plants for
  const { data: fuelData } = await sb
    .from('plants')
    .select('fuel_source')
    .eq('is_likely_curtailed', true)
    .limit(500);

  const fuelTypes = [...new Set((fuelData ?? []).map((r: any) => r.fuel_source as string))]
    .filter(f => ['Solar', 'Wind', 'Natural Gas'].includes(f))
    .slice(0, 3);

  for (const fuel of fuelTypes) {
    const currentYear = new Date().getFullYear();
    const userPrompt  = `Are there any notable project finance refinancing deals for ${fuel} power plants in the US in the past 3 months (${currentYear})?

Return JSON only:
{
  "found": true|false,
  "deals": [
    {
      "description": "brief description of the deal",
      "lender": "name of new lender or lead arranger if known, else null",
      "state": "US state or null",
      "source_url": "URL or null"
    }
  ]
}

If nothing notable: {"found": false, "deals": []}`;

    try {
      const res = await fetchWithTimeout(PERPLEXITY_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          model:            PERPLEXITY_MODEL,
          messages:         [
            { role: 'system', content: 'You are a renewable energy project finance analyst. Return ONLY valid JSON.' },
            { role: 'user',   content: userPrompt },
          ],
          temperature:      0.1,
          return_citations: false,
          return_images:    false,
        }),
      }, 20_000);

      if (!res.ok) continue;

      const data     = await res.json() as any;
      const content: string = data.choices?.[0]?.message?.content ?? '';
      const jsonStr  = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

      let parsed: { found: boolean; deals: any[] };
      try { parsed = JSON.parse(jsonStr); }
      catch { continue; }

      if (!parsed.found || !parsed.deals?.length) continue;

      // Market signals are not plant-specific; use a sentinel plant code
      // or find a matching plant by state if available
      for (const deal of parsed.deals.slice(0, 3)) {
        // Try to find a matching plant in that state
        let matchCode = 'MARKET_SIGNAL';
        if (deal.state) {
          const { data: statePlants } = await sb
            .from('plants')
            .select('eia_plant_code')
            .eq('is_likely_curtailed', true)
            .eq('state', deal.state)
            .eq('fuel_source', fuel)
            .limit(1);
          if (statePlants?.length) matchCode = statePlants[0].eia_plant_code;
        }

        if (matchCode === 'MARKET_SIGNAL') continue; // Skip if we can't tie to a plant

        events.push({
          eia_plant_code: matchCode,
          lender_name:    deal.lender ?? null,
          trigger_type:   'market_refinancing',
          evidence:       `Market signal: ${deal.description} This suggests active ${fuel} refinancing market — nearby curtailed ${fuel} plants may be refinancing candidates.`,
          source_url:     deal.source_url ?? null,
        });
      }
    } catch { /* non-fatal */ }

    await sleep(1_500);
  }

  log('MARKET', `${events.length} market refinancing signals`);
  return events;
}

// ── Deduplicate and write events ──────────────────────────────────────────────

async function writeEvents(
  sb:     ReturnType<typeof makeSupabase>,
  events: TriggerEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  // Load existing unactioned events from last 30 days to prevent duplicates
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: existing } = await sb
    .from('lender_trigger_events')
    .select('eia_plant_code, trigger_type, lender_name')
    .eq('actioned', false)
    .gte('detected_at', thirtyDaysAgo);

  const existingSet = new Set<string>(
    (existing ?? []).map((r: any) =>
      `${r.eia_plant_code}::${r.trigger_type}::${r.lender_name ?? ''}`
    )
  );

  // Filter out duplicates
  const newEvents = events.filter(e => {
    const key = `${e.eia_plant_code}::${e.trigger_type}::${e.lender_name ?? ''}`;
    return !existingSet.has(key);
  });

  if (newEvents.length === 0) {
    log('WRITE', 'No new events (all already detected within last 30 days)');
    return 0;
  }

  const { error } = await sb.from('lender_trigger_events').insert(
    newEvents.map(e => ({
      eia_plant_code: e.eia_plant_code,
      lender_name:    e.lender_name,
      trigger_type:   e.trigger_type,
      evidence:       e.evidence,
      source_url:     e.source_url,
    }))
  );

  if (error) {
    log('WRITE-ERR', error.message);
    return 0;
  }

  log('WRITE', `Wrote ${newEvents.length} new trigger events`);
  return newEvents.length;
}

// ── Main handler ──────────────────────────────────────────────────────────────

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

  const perplexityKey = Deno.env.get('PERPLEXITY_API_KEY');
  if (!perplexityKey) {
    return new Response(JSON.stringify({ error: 'PERPLEXITY_API_KEY not configured' }), { status: 500, headers: CORS });
  }

  const sb  = makeSupabase();
  const now = new Date().toISOString();

  // Log run start
  const { data: logData } = await sb.from('agent_run_log').insert({
    agent_type:    'lender_trigger_monitor',
    status:        'running',
    trigger_source: 'cron',
    batch_size:    1,
  }).select('id').single();

  const runLogId = logData?.id ?? null;
  log('START', `run_log=${runLogId}`);

  try {
    // Run all 4 signal detectors
    const [covenantEvents, accelEvents, ownershipEvents, marketEvents] = await Promise.all([
      detectCovenantWaivers(sb),
      detectAcceleratingCurtailment(sb),
      detectOwnershipChanges(sb),
      detectMarketRefinancing(sb, perplexityKey),
    ]);

    const allEvents = [...covenantEvents, ...accelEvents, ...ownershipEvents, ...marketEvents];
    const written   = await writeEvents(sb, allEvents);

    log('DONE', `${allEvents.length} events detected, ${written} new events written`);

    if (runLogId) {
      await sb.from('agent_run_log').update({
        status:       'completed',
        completed_at: now,
        completion_report: {
          covenant_waiver:          covenantEvents.length,
          accelerating_curtailment: accelEvents.length,
          ownership_change:         ownershipEvents.length,
          market_refinancing:       marketEvents.length,
          total_detected:           allEvents.length,
          new_events_written:       written,
        },
      }).eq('id', runLogId);
    }

    return new Response(JSON.stringify({
      ok:      true,
      signals: {
        covenant_waiver:          covenantEvents.length,
        accelerating_curtailment: accelEvents.length,
        ownership_change:         ownershipEvents.length,
        market_refinancing:       marketEvents.length,
      },
      total_detected:     allEvents.length,
      new_events_written: written,
    }), { headers: CORS });

  } catch (err) {
    const errMsg = String(err);
    log('FATAL', errMsg);
    if (runLogId) {
      await sb.from('agent_run_log').update({
        status:       'failed',
        completed_at: now,
        error_log:    errMsg,
      }).eq('id', runLogId);
    }
    return new Response(JSON.stringify({ error: errMsg }), { status: 500, headers: CORS });
  }
});
