/**
 * GenTrack — lender-search Edge Function (Deno)
 *
 * Uses Perplexity sonar-pro to find lenders, tax equity investors, and sponsors
 * for curtailed power plants. Searches the full web index (not RSS-limited),
 * returning both structured lender data and a prose summary with citation URLs.
 *
 * Writes to:
 *   - plant_lenders         (source = 'perplexity_search')
 *   - plant_financing_summary (prose summary + citations)
 *   - plant_news_state.lender_search_checked_at
 *
 * POST body:
 *   { plantCount?: number, offset?: number, limit?: number }
 *
 * Self-batching: processes `limit` plants per call (default 10).
 * If more plants remain, fires a follow-up call to itself.
 * After last batch, if any plants had lenders_found=true and no prior
 * news ingest, chains to news-search.
 *
 * Required secrets:
 *   PERPLEXITY_API_KEY        — from perplexity.ai/settings/api
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_PLANT_COUNT   = 9999;
const DEFAULT_BATCH_LIMIT   = 10;    // plants per edge function call (Perplexity is slower)
const DELAY_BETWEEN_PLANTS_MS = 1500; // stay within Perplexity rate limits

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const MODEL          = 'sonar-pro';

// ── Supabase client ────────────────────────────────────────────────────────────

function makeSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Types ──────────────────────────────────────────────────────────────────────

interface PlantInfo {
  eia_plant_code:        string;
  name:                  string;
  owner:                 string | null;
  state:                 string;
  fuel_source:           string;
  nameplate_capacity_mw: number;
}

interface PerplexityLender {
  name:          string;
  role:          'lender' | 'tax_equity' | 'sponsor' | 'co-investor' | 'other';
  facility_type: 'term_loan' | 'revolving_credit' | 'construction_loan' | 'tax_equity' | 'bridge_loan' | 'letter_of_credit' | 'other';
  confidence:    'high' | 'medium' | 'low';
  notes:         string;
  source_url:    string | null;
}

interface PerplexityResult {
  found:   boolean;
  summary: string;
  lenders: PerplexityLender[];
}

interface Citation {
  url:     string;
  title:   string;
  snippet: string;
}

// ── Prompts ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a project finance research assistant specializing in US renewable energy and power plant financing. Your task is to identify the specific banks, lenders, and tax equity investors that financed a given power plant. Search press wire services (BusinessWire, PRNewswire, GlobeNewswire), energy trade press (PV Tech, Recharge, Wind Power Monthly, S&P Global Commodity Insights, Bloomberg NEF, Project Finance International, IJGlobal), and SEC filings or FERC submissions. Only return confirmed named institutions explicitly linked to THIS specific plant or project. Never hallucinate. Return JSON only — no markdown fences, no explanation outside the JSON.

NAMING RULES:
- Use the full, commonly recognized institutional name (e.g. "JPMorgan Chase" not "JPMC" or "JP Morgan Chase & Co.").
- Do NOT include generic descriptions like "consortium of banks", "a group of lenders", "undisclosed investor", "various banks", or "multiple lenders".
- If the specific institution cannot be identified by name, omit the entry entirely.
- Do NOT include legal suffixes like "N.A.", "LLC", "Inc." unless they disambiguate between different entities.

SOURCE URL RULES:
- For each lender, include the single best URL from your search citations that directly supports that lender's involvement with this plant.
- Prefer press releases or news articles that explicitly name the lender AND the plant/project.
- If no citation directly supports a specific lender, use the most relevant citation available.
- Set source_url to null only if you have absolutely no supporting URL.`;

function buildUserPrompt(plant: PlantInfo): string {
  const capacity = Math.round(plant.nameplate_capacity_mw);
  const ownerClause = plant.owner ? `, owned by ${plant.owner}` : '';

  return `Who provided construction loans, term loans, revolving credit, and tax equity investment for "${plant.name}", a ${capacity} MW ${plant.fuel_source} power plant in ${plant.state}${ownerClause}?

Search for press releases, news articles, project finance announcements, and public filings about this plant's debt financing and equity investment. Look for financial close announcements, refinancing news, and ownership transfer deals. Note that the EIA plant name may differ from the project finance name — if you find financing for a project with the same capacity, state, and owner, include it.

Return valid JSON only (no markdown):
{
  "found": true,
  "summary": "JPMorgan Chase provided a $150M construction loan at financial close in April 2019, converting to a term loan at COD. US Bancorp provided $65M in tax equity.",
  "lenders": [
    {
      "name": "JPMorgan Chase",
      "role": "lender",
      "facility_type": "construction_loan",
      "confidence": "high",
      "notes": "$150M construction loan, financial close April 2019",
      "source_url": "https://www.businesswire.com/news/home/..."
    }
  ]
}

The "summary" field: 1-3 sentences for an infrastructure investor. Include deal size, lender names, facility types, and year when known.
Valid roles: lender, tax_equity, sponsor, co-investor, other
Valid facility_types: term_loan, revolving_credit, construction_loan, tax_equity, bridge_loan, letter_of_credit, other
Valid confidence: "high" = press release or article explicitly names them for this plant; "medium" = indirect mention or portfolio-level; "low" = mentioned in context but role unclear

If no financing information is found: {"found": false, "summary": "", "lenders": []}`;
}

// ── Perplexity API call ────────────────────────────────────────────────────────

async function searchPlantFinancing(plant: PlantInfo): Promise<{
  result:    PerplexityResult;
  summary:   string;
  citations: Citation[];
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
      model:    MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserPrompt(plant) },
      ],
      temperature:       0.1,
      return_citations:  true,
      return_images:     false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Perplexity HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const content: string = data.choices?.[0]?.message?.content ?? '';

  // Perplexity returns citations as plain URL strings (not objects)
  const rawCitations: unknown[] = data.citations ?? [];
  const citations: Citation[] = rawCitations
    .filter((c): c is string => typeof c === 'string' && c.startsWith('http'))
    .map(url => {
      let hostname = url;
      try { hostname = new URL(url).hostname; } catch { /* keep full url */ }
      return { url, title: hostname, snippet: '' };
    });

  // Parse JSON from content (strip markdown fences if present)
  const jsonStr = content
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  let result: PerplexityResult;
  try {
    result = JSON.parse(jsonStr);
    if (!Array.isArray(result.lenders)) result.lenders = [];
    if (typeof result.summary !== 'string') result.summary = '';
  } catch {
    console.warn(`  [perplexity] JSON parse failed for ${plant.name}, treating as not found`);
    result = { found: false, summary: '', lenders: [] };
  }

  // Use the summary field from the parsed JSON; fall back to a plain sentence
  const summary = result.summary?.trim() || (
    result.found && result.lenders.length > 0
      ? `Financing identified for ${plant.name}: ` +
        result.lenders.map(l => `${l.name} (${l.role.replace(/_/g, ' ')})`).join(', ') + '.'
      : `No public financing information found for ${plant.name}.`
  );

  return { result, summary, citations };
}

// ── Plant Discovery ────────────────────────────────────────────────────────────

async function loadPlants(
  sb:         ReturnType<typeof createClient>,
  plantCount: number,
  offset:     number,
  limit:      number,
): Promise<{ plants: PlantInfo[]; totalEligible: number }> {
  // Plants eligible: is_likely_curtailed=true, not offline, has active generation
  const { data: maxRow } = await sb
    .from('monthly_generation')
    .select('month')
    .not('mwh', 'is', null)
    .order('month', { ascending: false })
    .limit(1);
  const latestMonth = maxRow?.[0]?.month ?? '2025-11';

  const { data: genData } = await sb
    .from('monthly_generation')
    .select('plant_id')
    .eq('month', latestMonth)
    .not('mwh', 'is', null);
  const eligibleIds = new Set((genData ?? []).map((r: { plant_id: string }) => r.plant_id));

  const { data: plantsData, error } = await sb
    .from('plants')
    .select('id, eia_plant_code, name, owner, state, fuel_source, nameplate_capacity_mw')
    .eq('is_likely_curtailed', true)
    .eq('is_maintenance_offline', false)
    .eq('trailing_zero_months', 0)
    .neq('eia_plant_code', '99999')
    .order('curtailment_score', { ascending: false })
    .limit(10000);

  if (error) throw new Error(`Failed to load plants: ${error.message}`);

  // Filter to plants that have data through the latest month
  const all = (plantsData ?? []).filter((p: { id: string }) => eligibleIds.has(p.id));

  // Filter to plants not yet searched (lender_search_checked_at IS NULL)
  const plantCodes = all.map((p: { eia_plant_code: string }) => p.eia_plant_code);
  const { data: stateData } = await sb
    .from('plant_news_state')
    .select('eia_plant_code, lender_search_checked_at')
    .in('eia_plant_code', plantCodes)
    .not('lender_search_checked_at', 'is', null);

  const alreadySearched = new Set((stateData ?? []).map((r: { eia_plant_code: string }) => r.eia_plant_code));
  const unsearched = all.filter((p: { eia_plant_code: string }) => !alreadySearched.has(p.eia_plant_code));

  const totalEligible = Math.min(unsearched.length, plantCount);
  const batch = unsearched.slice(offset, Math.min(offset + limit, plantCount));

  console.log(`Eligible unsearched: ${unsearched.length}, cap: ${plantCount}, batch offset=${offset} → ${batch.length} plants`);

  return { plants: batch as PlantInfo[], totalEligible };
}

// ── Write results ──────────────────────────────────────────────────────────────

async function saveResults(
  sb:        ReturnType<typeof createClient>,
  plant:     PlantInfo,
  result:    PerplexityResult,
  summary:   string,
  citations: Citation[],
): Promise<{ inserted: number }> {
  const now = new Date().toISOString();

  // 1. Upsert plant_financing_summary
  await sb.from('plant_financing_summary').upsert({
    eia_plant_code: plant.eia_plant_code,
    summary,
    citations:      citations,
    lenders_found:  result.found && result.lenders.length > 0,
    searched_at:    now,
    updated_at:     now,
  }, { onConflict: 'eia_plant_code' });

  // 2. Upsert each lender into plant_lenders
  let inserted = 0;
  for (const lender of result.lenders) {
    if (!lender.name?.trim()) continue;

    // Validate enums — default to 'other' if invalid
    const validRoles = ['lender', 'tax_equity', 'sponsor', 'co-investor', 'other'];
    const validTypes = ['term_loan', 'revolving_credit', 'construction_loan', 'tax_equity', 'bridge_loan', 'letter_of_credit', 'other'];
    const validConf  = ['high', 'medium', 'low'];

    // Use lender-specific URL from Perplexity; fall back to first citation URL
    const sourceUrl = (lender.source_url?.startsWith('http') ? lender.source_url : null)
      ?? citations[0]?.url
      ?? null;

    const row = {
      eia_plant_code:     plant.eia_plant_code,
      lender_name:        lender.name.trim().slice(0, 200),
      role:               validRoles.includes(lender.role)          ? lender.role          : 'other',
      facility_type:      validTypes.includes(lender.facility_type) ? lender.facility_type : 'other',
      loan_amount_usd:    null,
      interest_rate_text: null,
      maturity_text:      null,
      confidence:         validConf.includes(lender.confidence)     ? lender.confidence    : 'low',
      notes:              lender.notes?.trim().slice(0, 500) ?? null,
      source_article_id:  null,
      source:             'perplexity_search',
      source_url:         sourceUrl,
    };

    const { error } = await sb
      .from('plant_lenders')
      .upsert(row, { onConflict: 'eia_plant_code,lender_name,facility_type' });

    if (error) {
      console.warn(`  Upsert error for ${lender.name}: ${error.message}`);
    } else {
      inserted++;
    }
  }

  // 3. Mark lender_search_checked_at
  await sb.from('plant_news_state').upsert({
    eia_plant_code:           plant.eia_plant_code,
    lender_search_checked_at: now,
    updated_at:               now,
  }, { onConflict: 'eia_plant_code' });

  return { inserted };
}

// ── Chain call helper ──────────────────────────────────────────────────────────

function fireAndForget(url: string, body: Record<string, unknown>): void {
  const key = Deno.env.get('INTERNAL_AUTH_TOKEN')!;
  const p = fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body:    JSON.stringify(body),
  }).catch(err => console.error('Chain call failed:', err));
  // Keep the worker alive until the fetch completes so Deno doesn't kill it early
  EdgeRuntime.waitUntil(p);
}

// ── Handler ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const __authDenied = checkInternalAuth(req);
  if (__authDenied) return __authDenied;
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
      console.log('No unsearched plants in this batch — done.');
      return new Response(JSON.stringify({ ok: true, message: 'No plants to process', inserted: 0 }), { headers: CORS });
    }

    let totalInserted   = 0;
    let totalFound      = 0;
    let newLenderPlants = 0;
    const results: {
      plant: string; code: string; found: boolean; lenders: number; inserted: number; error?: string;
    }[] = [];

    for (let i = 0; i < plants.length; i++) {
      const plant = plants[i];
      console.log(`[${offset + i + 1}/${totalEligible}] ${plant.name} (${plant.eia_plant_code})`);

      try {
        const { result, summary, citations } = await searchPlantFinancing(plant);

        console.log(`  found=${result.found}, lenders=${result.lenders.length}, citations=${citations.length}`);
        if (result.lenders.length > 0) {
          result.lenders.forEach(l => console.log(`    - ${l.name} [${l.role}/${l.facility_type}/${l.confidence}]`));
        }

        const { inserted } = await saveResults(sb, plant, result, summary, citations);

        if (result.found && result.lenders.length > 0) {
          totalFound++;
          newLenderPlants++;
        }
        totalInserted += inserted;
        results.push({
          plant:    plant.name,
          code:     plant.eia_plant_code,
          found:    result.found,
          lenders:  result.lenders.length,
          inserted,
        });
      } catch (err) {
        const errMsg = String(err);
        console.error(`  Error for ${plant.name}:`, errMsg);
        results.push({ plant: plant.name, code: plant.eia_plant_code, found: false, lenders: 0, inserted: 0, error: errMsg });
      }

      if (i < plants.length - 1) {
        await sleep(DELAY_BETWEEN_PLANTS_MS);
      }
    }

    console.log(`Batch complete: ${totalFound} plants with lenders found, ${totalInserted} lender rows inserted`);

    // Self-batch: more plants remaining?
    const nextOffset  = offset + limit;
    const isLastBatch = nextOffset >= totalEligible;

    if (!isLastBatch) {
      // Always offset=0: unsearched list is recomputed fresh each call (already-done plants
      // are excluded by lender_search_checked_at filter), so cumulative offsets cause gaps.
      console.log(`Self-batching: next call (offset=0, ${totalEligible - limit} remaining)`);
      fireAndForget(`${supabaseUrl}/functions/v1/lender-search`, { plantCount, offset: 0, limit });
    } else {
      // Last batch — chain to lender-currency-agent to classify all newly discovered lender rows.
      // The agent applies heuristics + Perplexity + EDGAR + Gemini to determine whether each
      // loan is active, matured, or refinanced, then chains to refresh-entity-stats on completion.
      console.log(`Last batch complete — triggering lender-currency-agent for currency classification`);
      fireAndForget(`${supabaseUrl}/functions/v1/lender-currency-agent`, {
        mode:          'backfill',
        offset:        0,
        limit:         8,
        budget_limit:  20.0,
        force_recheck: false,
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      batch: { offset, limit, plantCount, isLastBatch },
      totalFound,
      totalInserted,
      newLenderPlants,
      plantsProcessed: plants.length,
      results,
    }), { headers: CORS });

  } catch (err) {
    console.error('lender-search fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
