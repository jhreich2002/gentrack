/**
 * lender-validated-digest
 *
 * Computes and caches a senior-manager engagement digest for a validated lender.
 * Triggered by admin from the AdminPage; result is stored in lender_validated_digest.
 *
 * Steps:
 *  1. Resolve validated plants for the lender (with source_url for evidence dating)
 *  2. Fetch last 24 months of monthly_generation
 *  3. Compute MW-weighted portfolio CF series
 *  4. Compute MW-weighted blended regional baseline (via get_regional_trend RPC)
 *  5. Compute KPIs
 *  6. Fetch top news articles overlapping validated plant EIA codes
 *  7. Compute per-plant outreach priority (deterministic heuristic)
 *  8. Call Gemini 2.0 Flash with structured JSON output (includes priority overlay)
 *  9. UPSERT lender_validated_digest (includes per-plant snapshot in kpis.plants[])
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalOrAdminAuth } from '../_shared/auth.ts';

const MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const CF_MONTHS = 24;
const COST_CAP_USD = 0.15;  // slightly raised: priority overlay adds ~20% tokens

// ── Priority scoring constants ────────────────────────────────────────────────

/** Expected loan tenor by role (years from financial close / evidence date) */
const EXPECTED_TENOR: Record<string, number> = {
  senior_debt:  10,
  term_loan:     7,
  construction:  2,   // expect to refinance at COD → very short
  mezzanine:     5,
  refinancing:   8,
  tax_equity:    8,   // until investor flip
  sponsor:      30,   // sponsors stay forever — we apply a floor
  other:         8,
};
const DEFAULT_TENOR = 8;

/** Logistic sigmoid: σ(x) = 1 / (1 + e^(-k*x)) */
function sigmoid(x: number, k = 0.6): number {
  return 1 / (1 + Math.exp(-k * x));
}

type PriorityBand = 'high' | 'medium' | 'low' | 'cold';

interface PriorityResult {
  evidenceArticleDate: string | null;
  evidenceAgeYears: number | null;
  expectedTenorYears: number;
  loanLikelyActivePct: number;
  recentNewsCount: number;
  priorityScore: number;
  priorityBand: PriorityBand;
}

/**
 * Deterministic outreach priority for a single plant.
 *
 * @param role           – e.g. 'senior_debt', 'construction', 'sponsor'
 * @param mostRecentEvidenceDate – most recent article date linked to this plant-lender pair
 * @param recentNewsCount – # articles for this plant in last 12 months
 * @param cfDeltaPp       – TTM CF vs regional baseline (negative = underperforming)
 * @param distressScore   – 0–100 (higher = more distressed)
 */
function computePriority(
  role: string | null,
  mostRecentEvidenceDate: string | null,
  recentNewsCount: number,
  cfDeltaPp: number | null,
  distressScore: number | null,
): PriorityResult {
  const roleKey = (role ?? '').toLowerCase().replace(/\s+/g, '_');
  const expectedTenorYears = EXPECTED_TENOR[roleKey] ?? DEFAULT_TENOR;
  const isSponsor = roleKey === 'sponsor';

  // Evidence age
  let evidenceAgeYears: number | null = null;
  let loanLikelyActivePct = 50;  // default when no evidence date

  if (mostRecentEvidenceDate) {
    const ageMs = Date.now() - new Date(mostRecentEvidenceDate).getTime();
    evidenceAgeYears = ageMs / (365.25 * 24 * 3600 * 1000);

    // How far past the expected tenor are we? Negative = still within tenor.
    const excessAge = evidenceAgeYears - expectedTenorYears;

    // Sigmoid gives 95% at -5yr, 50% at 0yr, 5% at +5yr
    loanLikelyActivePct = Math.round(100 * (1 - sigmoid(excessAge, 0.6)));

    // Sponsors never fall below 80%
    if (isSponsor) loanLikelyActivePct = Math.max(loanLikelyActivePct, 80);

    // Recent-news boost (+15%, capped at 100)
    if (recentNewsCount > 0) {
      loanLikelyActivePct = Math.min(100, Math.round(loanLikelyActivePct * 1.15));
    }

    loanLikelyActivePct = Math.max(0, Math.min(100, loanLikelyActivePct));
  }

  // Component scores (all 0–100)
  // Underperformance: cfDeltaPp=-10 → 100, cfDeltaPp=0 → 50, cfDeltaPp=+5 → 0
  const underperformanceBoost = cfDeltaPp != null
    ? Math.max(0, Math.min(100, 50 - cfDeltaPp * 5))
    : 50;

  const distressBoost = distressScore != null ? Math.min(100, distressScore) : 0;

  // Recency boost: 0→0, 1→50, ≥3→100
  const recencyBoost = recentNewsCount === 0 ? 0
    : recentNewsCount === 1 ? 50
    : recentNewsCount === 2 ? 75
    : 100;

  const priorityScore = Math.round(
    loanLikelyActivePct * 0.55
    + underperformanceBoost * 0.20
    + distressBoost * 0.15
    + recencyBoost * 0.10,
  );

  const priorityBand: PriorityBand =
    priorityScore >= 70 ? 'high'
    : priorityScore >= 45 ? 'medium'
    : priorityScore >= 25 ? 'low'
    : 'cold';

  return {
    evidenceArticleDate: mostRecentEvidenceDate,
    evidenceAgeYears: evidenceAgeYears != null ? Math.round(evidenceAgeYears * 10) / 10 : null,
    expectedTenorYears,
    loanLikelyActivePct,
    recentNewsCount,
    priorityScore,
    priorityBand,
  };
}

/** Clamp an AI-returned band to be at most ±1 step away from the heuristic band */
function clampBandShift(heuristic: PriorityBand, ai: string): PriorityBand {
  const order: PriorityBand[] = ['cold', 'low', 'medium', 'high'];
  const hi = order.indexOf(heuristic);
  const ai_norm = ai.toLowerCase() as PriorityBand;
  if (!order.includes(ai_norm)) return heuristic;
  const ai_idx = order.indexOf(ai_norm);
  const clamped = Math.max(0, Math.min(order.length - 1, Math.min(hi + 1, Math.max(hi - 1, ai_idx))));
  return order[clamped];
}

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
  // Include source_url so we can look up evidence article dates.

  const { data: plantLinks, error: plantErr } = await supabase
    .from('plant_lender_links')
    .select(`
      id,
      plant_id,
      role,
      role_summary,
      validated_at,
      source_url,
      plants!plant_id(
        id, name, eia_plant_code, state, region, sub_region,
        fuel_source, nameplate_capacity_mw, lat, lng,
        is_likely_curtailed, distress_score, cod
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
    plantId:           String(link.plant_id),
    eiaPlantCode:      String(link.plants.eia_plant_code ?? ''),
    plantName:         String(link.plants.name ?? ''),
    state:             link.plants.state ? String(link.plants.state) : null,
    region:            String(link.plants.region ?? ''),
    fuelSource:        String(link.plants.fuel_source ?? ''),
    nameplateMw:       link.plants.nameplate_capacity_mw != null ? Number(link.plants.nameplate_capacity_mw) : null,
    lat:               link.plants.lat != null ? Number(link.plants.lat) : null,
    lng:               link.plants.lng != null ? Number(link.plants.lng) : null,
    isLikelyCurtailed: Boolean(link.plants.is_likely_curtailed),
    distressScore:     link.plants.distress_score != null ? Number(link.plants.distress_score) : null,
    cod:               link.plants.cod ? String(link.plants.cod) : null,
    role:              link.role ? String(link.role) : null,
    roleSummary:       link.role_summary ? String(link.role_summary) : null,
    validatedAt:       link.validated_at ? String(link.validated_at) : null,
    sourceUrl:         link.source_url ? String(link.source_url) : null,
  }));

  // Deduplicate plants (multiple links to same plant → keep all for evidence-date resolution)
  // uniquePlants indexed by plantId
  const uniquePlantMap = new Map<string, typeof plants[0]>();
  for (const p of plants) {
    if (!uniquePlantMap.has(p.plantId)) uniquePlantMap.set(p.plantId, p);
  }
  const uniquePlants = Array.from(uniquePlantMap.values());

  const plantIds   = uniquePlants.map((p) => p.plantId);
  const eiaCodes   = uniquePlants.map((p) => p.eiaPlantCode).filter(Boolean);
  const totalMw    = uniquePlants.reduce((s, p) => s + (p.nameplateMw ?? 0), 0);
  const plantCount = uniquePlants.length;

  // ── 2. Evidence article dates per plant ──────────────────────────────────────
  // For each link, look up the most recent news_articles.published_at
  // by matching source_url. One plant may have multiple links; we keep the MAX.

  const sourceUrls = (plantLinks as any[])
    .map((l: any) => l.source_url)
    .filter((u: any) => typeof u === 'string' && u.startsWith('http'));

  // Map: plant_id → most-recent evidence article date (ISO string)
  const evidenceDateByPlant = new Map<string, string>();

  if (sourceUrls.length > 0) {
    // news_articles.url matches source_url
    const { data: evidenceArticles } = await supabase
      .from('news_articles')
      .select('url, published_at')
      .in('url', sourceUrls)
      .not('published_at', 'is', null);

    // Build: url → published_at
    const urlToDate = new Map<string, string>();
    for (const row of (evidenceArticles ?? []) as any[]) {
      if (row.url && row.published_at) urlToDate.set(String(row.url), String(row.published_at));
    }

    // Resolve per plant (take max date across all links)
    for (const link of (plantLinks as any[])) {
      const date = urlToDate.get(String(link.source_url ?? ''));
      if (!date) continue;
      const pid = String(link.plant_id);
      const existing = evidenceDateByPlant.get(pid);
      if (!existing || date > existing) evidenceDateByPlant.set(pid, date);
    }
  }

  // ── 3. Monthly generation (last 24 months) ──────────────────────────────────

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

  // ── 4. Portfolio CF series (MW-weighted) ─────────────────────────────────────

  const cfSeries: Array<{ month: string; portfolioCf: number | null; blendedRegionalCf: number | null }> = [];

  for (const month of months) {
    const hours = daysInMonth(month) * 24;
    let numerator   = 0;
    let denominator = 0;

    for (const plant of uniquePlants) {
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

  // ── 5. Blended regional baseline ─────────────────────────────────────────────
  // Dedup by (region, fuel_source); avg_factor from RPC is in 0..1 range.

  const uniquePairs = new Map<string, { region: string; fuelSource: string }>();
  for (const plant of uniquePlants) {
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

    for (const plant of uniquePlants) {
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

  // ── 6. KPIs ──────────────────────────────────────────────────────────────────

  // TTM = last 12 months
  const ttmMonths = months.slice(-12);

  // Per-plant TTM CF (MW-weighted avg of last 12 months)
  let ttmNumerator = 0, ttmDenominator = 0;
  let regNumerator = 0, regDenominator = 0;

  for (const plant of uniquePlants) {
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
  for (const plant of uniquePlants) {
    if (plant.distressScore == null || !plant.nameplateMw) continue;
    distNumerator   += plant.nameplateMw * plant.distressScore;
    distDenominator += plant.nameplateMw;
  }
  const avgDistressScore = distDenominator > 0 ? Math.round(distNumerator / distDenominator) : null;

  const curtailedCount = uniquePlants.filter((p) => p.isLikelyCurtailed).length;

  // ── 7. News articles + per-plant recent-news count ───────────────────────────

  const recentCutoff = new Date();
  recentCutoff.setMonth(recentCutoff.getMonth() - 12);
  const recentCutoffIso = recentCutoff.toISOString();

  const { data: articles } = await supabase
    .from('news_articles')
    .select('id, title, description, published_at, sentiment_label, relevance_score, entity_company_names, lenders, article_summary, plant_codes')
    .overlaps('plant_codes', eiaCodes)
    .order('relevance_score', { ascending: false, nullsFirst: false })
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(50);  // fetch more so we can count per-plant recency

  const allArticles = (articles ?? []) as any[];
  const top10Articles = allArticles.slice(0, 10);

  // Count recent articles (last 12 months) per plant EIA code
  const recentCountByEia = new Map<string, number>();
  for (const art of allArticles) {
    if (!art.published_at || art.published_at < recentCutoffIso) continue;
    const codes: string[] = Array.isArray(art.plant_codes) ? art.plant_codes : [];
    for (const code of codes) {
      recentCountByEia.set(code, (recentCountByEia.get(code) ?? 0) + 1);
    }
  }

  // ── 8. Per-plant heuristic priority scoring ───────────────────────────────────

  // We need per-plant cfDeltaPp; compute inline with the same logic as plantSnapshots
  const plantPriorityMap = new Map<string, PriorityResult>();

  for (const plant of uniquePlants) {
    // TTM CF for this plant
    let mwhSum = 0, hoursSum = 0, validM = 0;
    for (const month of ttmMonths) {
      const mwh = genByPlant.get(plant.plantId)?.get(month);
      if (mwh == null) continue;
      mwhSum += mwh;
      hoursSum += daysInMonth(month) * 24;
      validM++;
    }
    const plantTtmCf = (validM > 0 && hoursSum > 0 && plant.nameplateMw)
      ? (mwhSum / (plant.nameplateMw * hoursSum)) * 100
      : null;

    const regKey = `${plant.region}||${plant.fuelSource}`;
    let regSum = 0, regCount = 0;
    for (const month of ttmMonths) {
      const factor = regionalData.get(regKey)?.get(month);
      if (factor != null) { regSum += factor * 100; regCount++; }
    }
    const plantRegionalCf = regCount > 0 ? regSum / regCount : null;
    const plantCfDelta = (plantTtmCf != null && plantRegionalCf != null)
      ? plantTtmCf - plantRegionalCf
      : null;

    const evidenceDate = evidenceDateByPlant.get(plant.plantId) ?? null;
    const recentNews = recentCountByEia.get(plant.eiaPlantCode) ?? 0;

    plantPriorityMap.set(
      plant.plantId,
      computePriority(plant.role, evidenceDate, recentNews, plantCfDelta, plant.distressScore),
    );
  }

  // ── 9. Gemini call (digest narrative + per-plant priority overlay) ─────────────

  // Build per-plant priority input lines for AI context
  const plantPriorityLines = uniquePlants.map((p) => {
    const pr = plantPriorityMap.get(p.plantId)!;
    const artDate = pr.evidenceArticleDate
      ? new Date(pr.evidenceArticleDate).toISOString().slice(0, 10)
      : 'unknown';
    // Find headline from articles overlapping this plant
    const headlineArt = allArticles.find(
      (a: any) => Array.isArray(a.plant_codes) && a.plant_codes.includes(p.eiaPlantCode)
    );
    const headline = headlineArt ? String(headlineArt.title ?? '').slice(0, 80) : '(no article found)';
    return `  plant_id: ${p.plantId} | "${p.plantName}" (${p.state ?? '?'}) | ${p.fuelSource} ${p.nameplateMw ?? '?'} MW ` +
      `| role: ${p.role ?? 'unknown'} | COD: ${p.cod ?? 'unknown'} | evidence: ${artDate} — "${headline}" ` +
      `| CF delta: ${pr.recentNewsCount > 0 ? `${recentCountByEia.get(p.eiaPlantCode)}` : '0'} recent news ` +
      `| heuristic_band: ${pr.priorityBand} (score ${pr.priorityScore}, loan_likely_active ${pr.loanLikelyActivePct}%)`;
  }).join('\n');

  const plantSummaryLines = uniquePlants.map((p) =>
    `- ${p.plantName} (${p.state ?? '?'}) — ${p.fuelSource} ${p.nameplateMw != null ? p.nameplateMw + ' MW' : 'MW unknown'}, role: ${p.role ?? 'unknown'}, COD: ${p.cod ?? 'unknown'}`
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
4. risk_bullets — 2–4 specific risk flags drawn from the news and KPI data

---
OUTREACH PRIORITY OVERLAY

Below is each plant's heuristic priority band (based on evidence age vs expected loan tenor, CF performance, distress score, and recent news). Review and optionally shift the band by ±1 step when you see strong qualitative reasons — for example:
- A construction loan from 2009 on a plant operating since 2010 is almost certainly matured → mark cold even if heuristic says low.
- Evidence from a 2023 refinancing article on an active distressed plant → promote to high.
- A sponsor-equity relationship is perpetual regardless of vintage.

Plants:
${plantPriorityLines}

5. plant_priorities — for EVERY plant_id listed above, return: ai_priority_band (high/medium/low/cold, max ±1 step from heuristic_band) and ai_priority_reason (≤30 words, cite article date or COD where relevant).`;

  const geminiBody = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] },
    ],
    generationConfig: {
      temperature: 0.15,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        required: ['engagement_thesis', 'portfolio_health', 'pitch_bullets', 'risk_bullets', 'plant_priorities'],
        properties: {
          engagement_thesis: { type: 'string' },
          portfolio_health:  { type: 'string' },
          pitch_bullets:     { type: 'array', items: { type: 'string' } },
          risk_bullets:      { type: 'array', items: { type: 'string' } },
          plant_priorities:  {
            type: 'array',
            items: {
              type: 'object',
              required: ['plant_id', 'ai_priority_band', 'ai_priority_reason'],
              properties: {
                plant_id:          { type: 'string' },
                ai_priority_band:  { type: 'string' },
                ai_priority_reason:{ type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  let geminiResponse: Record<string, unknown> | null = null;
  let costUsd = 0;
  let aiData: {
    engagement_thesis: string;
    portfolio_health: string;
    pitch_bullets: string[];
    risk_bullets: string[];
    plant_priorities: Array<{ plant_id: string; ai_priority_band: string; ai_priority_reason: string }>;
  } | null = null;

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

  // ── 10. Build per-plant snapshot for kpis.plants[] ───────────────────────────
  // Merge heuristic priority + AI overlay into each snapshot.
  // Stored inside the kpis jsonb so the frontend service can read it without a
  // separate query.

  // Build AI priority overlay index: plant_id → { band, reason }
  const aiPriorityIndex = new Map<string, { band: PriorityBand; reason: string }>();
  if (aiData?.plant_priorities) {
    for (const p of aiData.plant_priorities) {
      const heuristic = plantPriorityMap.get(p.plant_id)?.priorityBand ?? 'low';
      aiPriorityIndex.set(p.plant_id, {
        band: clampBandShift(heuristic, p.ai_priority_band ?? ''),
        reason: String(p.ai_priority_reason ?? '').slice(0, 200),
      });
    }
  }

  const plantSnapshots = uniquePlants.map((plant) => {
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

    const plantCfDeltaPp = (plantTtmCf != null && plantRegionalCf != null)
      ? Math.round((plantTtmCf - plantRegionalCf) * 10) / 10
      : null;

    const priority = plantPriorityMap.get(plant.plantId)!;
    const aiOverride = aiPriorityIndex.get(plant.plantId) ?? null;

    return {
      plantId:              plant.plantId,
      eiaPlantCode:         plant.eiaPlantCode,
      plantName:            plant.plantName,
      state:                plant.state,
      fuelSource:           plant.fuelSource,
      nameplateMw:          plant.nameplateMw,
      role:                 plant.role,
      cod:                  plant.cod,
      ttmCf:                plantTtmCf,
      regionalCf:           plantRegionalCf,
      cfDeltaPp:            plantCfDeltaPp,
      newsRiskScore:        null,
      distressScore:        plant.distressScore,
      validatedAt:          plant.validatedAt,
      lat:                  plant.lat,
      lng:                  plant.lng,
      // Outreach priority
      evidenceArticleDate:  priority.evidenceArticleDate,
      evidenceAgeYears:     priority.evidenceAgeYears,
      expectedTenorYears:   priority.expectedTenorYears,
      loanLikelyActivePct:  priority.loanLikelyActivePct,
      recentNewsCount:      priority.recentNewsCount,
      priorityScore:        priority.priorityScore,
      priorityBand:         priority.priorityBand,
      aiPriorityBand:       aiOverride?.band ?? null,
      aiPriorityReason:     aiOverride?.reason ?? null,
    };
  });

  const kpis = {
    totalMw,
    plantCount,
    weightedTtmCf,
    blendedRegionalTtmCf,
    cfDeltaPp,
    avgNewsRisk: null,
    avgDistressScore,
    activeLoanCount: plantCount,
    curtailedCount,
    plants: plantSnapshots,
  };

  // ── 11. UPSERT digest ─────────────────────────────────────────────────────────

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
