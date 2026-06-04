/**
 * lender-validated-digest
 *
 * Computes and caches a senior-manager engagement digest for a validated lender.
 * Triggered by admin from the AdminPage; result is stored in lender_validated_digest.
 *
 * Steps:
 *  1. Resolve validated plants for the lender
 *  2. Fetch last 24 months of monthly_generation
 *  3. Compute MW-weighted portfolio CF series
 *  4. Compute MW-weighted blended regional baseline (via get_regional_trend RPC)
 *  5. Compute KPIs
 *  6. Fetch top news articles overlapping validated plant EIA codes
 *  7. Call Gemini 2.0 Flash with structured JSON output
 *  8. UPSERT lender_validated_digest (includes per-plant snapshot in kpis.plants[])
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalOrAdminAuth } from '../_shared/auth.ts';

const MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const CF_MONTHS = 24;
const COST_CAP_USD = 0.10;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

type RequestBody = {
  lender_id?: string;
  force?: boolean;
};

// ── helpers ────────────────────────────────────────────────────────────────────

function parseJwtSub(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = JSON.parse(atob(parts[1]));
    return typeof json.sub === 'string' ? json.sub : null;
  } catch {
    return null;
  }
}

/** Days in a given YYYY-MM month */
function daysInMonth(yyyyMm: string): number {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** Returns the last N months as YYYY-MM strings, most-recent last */
function lastNMonths(n: number): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

/** Estimate Gemini Flash cost. Input: ~$0.075/1M, output: ~$0.30/1M tokens */
function estimateGeminiCost(usage: Record<string, unknown> | null): number {
  if (!usage) return 0;
  const input = Number(usage.promptTokenCount ?? usage.input_tokens ?? 0);
  const output = Number(usage.candidatesTokenCount ?? usage.output_tokens ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return 0;
  return (input * 0.075 + output * 0.30) / 1_000_000;
}

// ── main handler ───────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const denied = await checkInternalOrAdminAuth(req);
  if (denied) return denied;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: CORS });
  }

  const lenderId = typeof body.lender_id === 'string' ? body.lender_id.trim() : '';
  if (!lenderId) {
    return new Response(JSON.stringify({ error: 'lender_id is required' }), { status: 400, headers: CORS });
  }

  const supabaseUrl  = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRole  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY') ?? '';

  if (!supabaseUrl || !serviceRole || !geminiApiKey) {
    return new Response(JSON.stringify({ error: 'server_misconfigured' }), { status: 500, headers: CORS });
  }

  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const requestedBy = (() => {
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    return parseJwtSub(token);
  })();

  // ── 1. Validated plants ─────────────────────────────────────────────────────

  const { data: plantLinks, error: plantErr } = await supabase
    .from('plant_lender_links')
    .select(`
      plant_id,
      role,
      role_summary,
      validated_at,
      plants!inner(
        id, name, eia_plant_code, state, region, sub_region,
        fuel_source, nameplate_capacity_mw, lat, lng,
        is_likely_curtailed, distress_score
      )
    `)
    .eq('lender_id', lenderId)
    .not('validated_at', 'is', null)
    .is('rejected_at', null);

  if (plantErr) {
    return new Response(JSON.stringify({ error: plantErr.message }), { status: 500, headers: CORS });
  }
  if (!plantLinks || plantLinks.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: 'no_validated_plants' }), { status: 200, headers: CORS });
  }

  const plants = (plantLinks as any[]).map((link) => ({
    plantId:       String(link.plant_id),
    eiaPlantCode:  String(link.plants.eia_plant_code ?? ''),
    plantName:     String(link.plants.name ?? ''),
    state:         link.plants.state ? String(link.plants.state) : null,
    region:        String(link.plants.region ?? ''),
    fuelSource:    String(link.plants.fuel_source ?? ''),
    nameplateMw:   link.plants.nameplate_capacity_mw != null ? Number(link.plants.nameplate_capacity_mw) : null,
    lat:           link.plants.lat != null ? Number(link.plants.lat) : null,
    lng:           link.plants.lng != null ? Number(link.plants.lng) : null,
    isLikelyCurtailed: Boolean(link.plants.is_likely_curtailed),
    distressScore: link.plants.distress_score != null ? Number(link.plants.distress_score) : null,
    role:          link.role ? String(link.role) : null,
    roleSummary:   link.role_summary ? String(link.role_summary) : null,
    validatedAt:   link.validated_at ? String(link.validated_at) : null,
  }));

  const plantIds    = plants.map((p) => p.plantId);
  const eiaCodes    = plants.map((p) => p.eiaPlantCode).filter(Boolean);
  const totalMw     = plants.reduce((s, p) => s + (p.nameplateMw ?? 0), 0);
  const plantCount  = plants.length;

  // ── 2. Monthly generation (last 24 months) ──────────────────────────────────

  const months = lastNMonths(CF_MONTHS);
  const cutoff  = months[0];

  const { data: genRows, error: genErr } = await supabase
    .from('monthly_generation')
    .select('plant_id, month, mwh')
    .in('plant_id', plantIds)
    .gte('month', cutoff)
    .order('month');

  if (genErr) {
    return new Response(JSON.stringify({ error: genErr.message }), { status: 500, headers: CORS });
  }

  // Index generation by plant → month
  const genByPlant = new Map<string, Map<string, number | null>>();
  for (const row of (genRows ?? []) as any[]) {
    if (!genByPlant.has(row.plant_id)) genByPlant.set(row.plant_id, new Map());
    genByPlant.get(row.plant_id)!.set(row.month, row.mwh != null ? Number(row.mwh) : null);
  }

  // ── 3. Portfolio CF series (MW-weighted) ─────────────────────────────────────

  const cfSeries: Array<{ month: string; portfolioCf: number | null; blendedRegionalCf: number | null }> = [];

  for (const month of months) {
    const hours = daysInMonth(month) * 24;
    let numerator   = 0;
    let denominator = 0;

    for (const plant of plants) {
      if (!plant.nameplateMw) continue;
      const mwh = genByPlant.get(plant.plantId)?.get(month);
      if (mwh == null) continue;  // exclude plants with null mwh from this month
      numerator   += mwh;
      denominator += plant.nameplateMw * hours;
    }

    cfSeries.push({
      month,
      portfolioCf: denominator > 0 ? Math.round((numerator / denominator) * 100 * 10) / 10 : null,
      blendedRegionalCf: null,  // filled in step 4
    });
  }

  // ── 4. Blended regional baseline ─────────────────────────────────────────────
  // Dedup by (region, fuel_source); avg_factor from RPC is in 0..1 range.

  const uniquePairs = new Map<string, { region: string; fuelSource: string }>();
  for (const plant of plants) {
    const key = `${plant.region}||${plant.fuelSource}`;
    if (!uniquePairs.has(key)) uniquePairs.set(key, { region: plant.region, fuelSource: plant.fuelSource });
  }

  const regionalData = new Map<string, Map<string, number>>();
  for (const [key, pair] of uniquePairs) {
    const { data: trend } = await supabase.rpc('get_regional_trend', {
      p_region: pair.region,
      p_fuel_source: pair.fuelSource,
    });
    const monthMap = new Map<string, number>();
    for (const row of (trend ?? []) as any[]) {
      monthMap.set(String(row.month), Number(row.avg_factor ?? 0));
    }
    regionalData.set(key, monthMap);
  }

  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    let weightedSum = 0;
    let totalWeight = 0;

    for (const plant of plants) {
      if (!plant.nameplateMw) continue;
      const key = `${plant.region}||${plant.fuelSource}`;
      const factor = regionalData.get(key)?.get(month);
      if (factor == null) continue;
      weightedSum  += plant.nameplateMw * factor * 100;  // factor is 0..1 → multiply by 100 for %
      totalWeight  += plant.nameplateMw;
    }

    cfSeries[i].blendedRegionalCf = totalWeight > 0
      ? Math.round((weightedSum / totalWeight) * 10) / 10
      : null;
  }

  // ── 5. KPIs ──────────────────────────────────────────────────────────────────

  // TTM = last 12 months
  const ttmMonths = months.slice(-12);

  // Per-plant TTM CF (MW-weighted avg of last 12 months)
  let ttmNumerator = 0, ttmDenominator = 0;
  let regNumerator = 0, regDenominator = 0;

  for (const plant of plants) {
    if (!plant.nameplateMw) continue;
    let mwhSum = 0, hoursSum = 0, validMonths = 0;

    for (const month of ttmMonths) {
      const mwh = genByPlant.get(plant.plantId)?.get(month);
      if (mwh == null) continue;
      mwhSum += mwh;
      hoursSum += daysInMonth(month) * 24;
      validMonths++;
    }

    if (validMonths > 0 && hoursSum > 0) {
      const plantTtmCf = (mwhSum / (plant.nameplateMw * hoursSum)) * 100;
      ttmNumerator   += plant.nameplateMw * plantTtmCf;
      ttmDenominator += plant.nameplateMw;
    }

    // Regional TTM from blended series
    let regSum = 0, regCount = 0;
    for (const month of ttmMonths) {
      const idx = months.indexOf(month);
      if (idx >= 0 && cfSeries[idx].blendedRegionalCf != null) {
        regSum += cfSeries[idx].blendedRegionalCf!;
        regCount++;
      }
    }
    if (regCount > 0) {
      regNumerator   += plant.nameplateMw * (regSum / regCount);
      regDenominator += plant.nameplateMw;
    }
  }

  const weightedTtmCf      = ttmDenominator > 0 ? Math.round((ttmNumerator / ttmDenominator) * 10) / 10 : null;
  const blendedRegionalTtmCf = regDenominator > 0 ? Math.round((regNumerator / regDenominator) * 10) / 10 : null;
  const cfDeltaPp = (weightedTtmCf != null && blendedRegionalTtmCf != null)
    ? Math.round((weightedTtmCf - blendedRegionalTtmCf) * 10) / 10
    : null;

  // Distress score (MW-weighted avg; null-tolerant)
  let distNumerator = 0, distDenominator = 0;
  for (const plant of plants) {
    if (plant.distressScore == null || !plant.nameplateMw) continue;
    distNumerator   += plant.nameplateMw * plant.distressScore;
    distDenominator += plant.nameplateMw;
  }
  const avgDistressScore = distDenominator > 0 ? Math.round(distNumerator / distDenominator) : null;

  const curtailedCount = plants.filter((p) => p.isLikelyCurtailed).length;

  // ── 6. News articles ─────────────────────────────────────────────────────────

  const { data: articles } = await supabase
    .from('news_articles')
    .select('id, title, description, published_at, sentiment_label, relevance_score, entity_company_names, lenders, article_summary')
    .overlaps('plant_codes', eiaCodes)
    .order('relevance_score', { ascending: false, nullsFirst: false })
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(30);

  const top10Articles = ((articles ?? []) as any[]).slice(0, 10);

  // ── 7. Gemini call ────────────────────────────────────────────────────────────

  const plantSummaryLines = plants.map((p) =>
    `- ${p.plantName} (${p.state ?? '?'}) — ${p.fuelSource} ${p.nameplateMw != null ? p.nameplateMw + ' MW' : 'MW unknown'}, role: ${p.role ?? 'unknown'}`
  ).join('\n');

  const articleLines = top10Articles.map((a: any, i: number) =>
    `${i + 1}. "${a.title}" [${a.sentiment_label ?? 'neutral'}] — ${a.article_summary ?? a.description ?? ''}`
  ).join('\n');

  const kpiSummary = JSON.stringify({
    totalMw,
    plantCount,
    weightedTtmCf,
    blendedRegionalTtmCf,
    cfDeltaPp,
    avgDistressScore,
    curtailedCount,
  }, null, 2);

  const cfTrend = cfSeries.slice(-12).map((p) =>
    `${p.month}: portfolio ${p.portfolioCf ?? 'n/a'}%, regional ${p.blendedRegionalCf ?? 'n/a'}%`
  ).join('\n');

  const systemPrompt = `You are an asset finance relationship manager preparing a senior-manager-ready engagement memo for a US power-finance lender. Write in a confident, direct voice. Avoid filler. Reference specific plants by name where relevant. Pitch bullets must propose concrete next steps or outreach angles. Risk bullets must call out specific, named concerns from the data.`;

  const userPrompt = `Lender portfolio analysis for generating an engagement digest.

VALIDATED PLANTS (${plantCount} total, ${totalMw.toFixed(0)} MW):
${plantSummaryLines}

PORTFOLIO KPIs:
${kpiSummary}

CF TREND (last 12 months, portfolio vs blended regional baseline):
${cfTrend}

RECENT NEWS (top 10 by relevance):
${articleLines || '(no recent news found)'}

Generate:
1. engagement_thesis — 2–3 concise paragraphs: why this lender is a high-quality relationship target, specific plants and roles that anchor the pitch
2. portfolio_health — 2 paragraphs: candid assessment of portfolio performance, CF vs regional baseline, any underperformers
3. pitch_bullets — 3–5 specific action bullets (e.g., "Reach out re refinancing of X which matures in 2027")
4. risk_bullets — 2–4 specific risk flags drawn from the news and KPI data`;

  const geminiBody = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] },
    ],
    generationConfig: {
      temperature: 0.15,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        required: ['engagement_thesis', 'portfolio_health', 'pitch_bullets', 'risk_bullets'],
        properties: {
          engagement_thesis: { type: 'string' },
          portfolio_health:  { type: 'string' },
          pitch_bullets:     { type: 'array', items: { type: 'string' } },
          risk_bullets:      { type: 'array', items: { type: 'string' } },
        },
      },
    },
  };

  let geminiResponse: Record<string, unknown> | null = null;
  let costUsd = 0;
  let aiData: { engagement_thesis: string; portfolio_health: string; pitch_bullets: string[]; risk_bullets: string[] } | null = null;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${geminiApiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(geminiBody),
    });

    geminiResponse = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: `Gemini HTTP ${res.status}`, detail: geminiResponse }), { status: 200, headers: CORS });
    }

    const usage = (geminiResponse?.usageMetadata as Record<string, unknown> | undefined) ?? null;
    costUsd = estimateGeminiCost(usage);

    if (costUsd > COST_CAP_USD) {
      return new Response(JSON.stringify({ ok: false, error: 'cost_cap_exceeded', cost_usd: costUsd }), { status: 200, headers: CORS });
    }

    const text = (geminiResponse?.candidates as any[])?.[0]?.content?.parts?.[0]?.text ?? '';
    aiData = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 200, headers: CORS });
  }

  if (!aiData) {
    return new Response(JSON.stringify({ ok: false, error: 'gemini_empty_response' }), { status: 200, headers: CORS });
  }

  // ── 8. Build per-plant snapshot for kpis.plants[] ────────────────────────────
  // Stored inside the kpis jsonb so the frontend service can read it without a
  // separate query.

  const plantSnapshots = plants.map((plant) => {
    // Per-plant TTM CF
    let mwhSum = 0, hoursSum = 0, validM = 0;
    for (const month of ttmMonths) {
      const mwh = genByPlant.get(plant.plantId)?.get(month);
      if (mwh == null) continue;
      mwhSum += mwh;
      hoursSum += daysInMonth(month) * 24;
      validM++;
    }
    const plantTtmCf = (validM > 0 && hoursSum > 0 && plant.nameplateMw)
      ? Math.round((mwhSum / (plant.nameplateMw * hoursSum)) * 100 * 10) / 10
      : null;

    // Per-plant regional TTM (from blended series — region-level)
    const key = `${plant.region}||${plant.fuelSource}`;
    let regSum = 0, regCount = 0;
    for (const month of ttmMonths) {
      const factor = regionalData.get(key)?.get(month);
      if (factor != null) { regSum += factor * 100; regCount++; }
    }
    const plantRegionalCf = regCount > 0 ? Math.round((regSum / regCount) * 10) / 10 : null;

    return {
      plantId:       plant.plantId,
      eiaPlantCode:  plant.eiaPlantCode,
      plantName:     plant.plantName,
      state:         plant.state,
      fuelSource:    plant.fuelSource,
      nameplateMw:   plant.nameplateMw,
      role:          plant.role,
      ttmCf:         plantTtmCf,
      regionalCf:    plantRegionalCf,
      cfDeltaPp:     (plantTtmCf != null && plantRegionalCf != null)
                       ? Math.round((plantTtmCf - plantRegionalCf) * 10) / 10
                       : null,
      newsRiskScore: null,   // not stored per-plant in current schema
      distressScore: plant.distressScore,
      validatedAt:   plant.validatedAt,
      lat:           plant.lat,
      lng:           plant.lng,
    };
  });

  const kpis = {
    totalMw,
    plantCount,
    weightedTtmCf,
    blendedRegionalTtmCf,
    cfDeltaPp,
    avgNewsRisk: null,      // would need per-plant risk score lookup — nullable
    avgDistressScore,
    activeLoanCount: plantCount,
    curtailedCount,
    plants: plantSnapshots,
  };

  // ── 9. UPSERT digest ─────────────────────────────────────────────────────────

  const cfSeriesDb = cfSeries.map((p) => ({
    month: p.month,
    portfolio_cf: p.portfolioCf,
    blended_regional_cf: p.blendedRegionalCf,
  }));

  const { error: upsertErr } = await supabase
    .from('lender_validated_digest')
    .upsert({
      lender_id:            lenderId,
      kpis:                 kpis,
      cf_series:            cfSeriesDb,
      ai_engagement_thesis: aiData.engagement_thesis,
      ai_portfolio_health:  aiData.portfolio_health,
      ai_pitch_bullets:     aiData.pitch_bullets,
      ai_risk_bullets:      aiData.risk_bullets,
      plant_count:          plantCount,
      total_mw:             totalMw,
      cost_usd:             costUsd,
      model_used:           MODEL,
      generated_at:         new Date().toISOString(),
      generated_by:         requestedBy,
    }, { onConflict: 'lender_id' });

  if (upsertErr) {
    return new Response(JSON.stringify({ ok: false, error: upsertErr.message }), { status: 500, headers: CORS });
  }

  return new Response(JSON.stringify({
    ok: true,
    lender_id: lenderId,
    plant_count: plantCount,
    total_mw: totalMw,
    cost_usd: Number(costUsd.toFixed(6)),
    model_used: MODEL,
  }), { status: 200, headers: CORS });
});
