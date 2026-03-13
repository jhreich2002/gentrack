/**
 * GenTrack — tax-equity-analyze Edge Function
 *
 * On-demand per-investor LLM advisory analysis via Gemini Flash Lite.
 * Caches result in tax_equity_stats for 12 hours.
 *
 * POST { investor_name: string }
 * → { analysisText, analysisAngleBullets, portfolioSynopsis, analysisUpdatedAt, fromCache }
 *
 * Required secrets:
 *   GEMINI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';
const CACHE_HOURS  = 12;
const MAX_ARTICLES = 10;
const MAX_PLANTS   = 20;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405 });
  }

  const { investor_name } = await req.json();
  if (!investor_name) {
    return new Response(JSON.stringify({ error: 'investor_name required' }), { status: 400 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const geminiKey   = Deno.env.get('GEMINI_API_KEY') ?? '';
  const sb          = createClient(supabaseUrl, serviceKey);

  // ── Cache check ────────────────────────────────────────────────────────────
  const { data: existing } = await sb
    .from('tax_equity_stats')
    .select('analysis_text, analysis_angle_bullets, portfolio_synopsis, analysis_updated_at, asset_count, portfolio_avg_cf, portfolio_benchmark_cf, pct_curtailed, distress_score, news_sentiment_score')
    .eq('investor_name', investor_name)
    .single();

  if (existing?.analysis_updated_at) {
    const ageHours = (Date.now() - new Date(existing.analysis_updated_at).getTime()) / 3_600_000;
    if (ageHours < CACHE_HOURS && existing.analysis_text) {
      return new Response(JSON.stringify({
        analysisText:         existing.analysis_text,
        analysisAngleBullets: existing.analysis_angle_bullets ?? [],
        portfolioSynopsis:    existing.portfolio_synopsis ?? null,
        analysisUpdatedAt:    existing.analysis_updated_at,
        fromCache:            true,
      }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  // ── Fetch entity news (ILIKE match) ────────────────────────────────────────
  const { data: articles } = await sb
    .rpc('search_entity_news', {
      p_entity_name: investor_name,
      p_days_back:   90,
      p_limit:       MAX_ARTICLES,
    });

  // ── Fetch portfolio plants + their news signals ────────────────────────────
  const { data: plantRows } = await sb
    .from('plant_lenders')
    .select('eia_plant_code')
    .eq('lender_name', investor_name)
    .eq('facility_type', 'tax_equity')
    .in('confidence', ['high', 'medium'])
    .limit(MAX_PLANTS);

  const plantCodes = [...new Set((plantRows ?? []).map((r: Record<string, string>) => r.eia_plant_code))];

  interface PlantDetail { eia_plant_code: string; name: string; state: string; fuel_source: string; nameplate_capacity_mw: number; ttm_avg_factor: number | null; is_likely_curtailed: boolean; distress_score: number | null; region: string | null }
  interface PlantState  { eia_plant_code: string; plant_summary: string | null }

  let plants: PlantDetail[] = [];
  let plantStates: PlantState[] = [];

  if (plantCodes.length > 0) {
    const [plantsRes, statesRes] = await Promise.all([
      sb.from('plants')
        .select('eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, ttm_avg_factor, is_likely_curtailed, distress_score, region')
        .in('eia_plant_code', plantCodes),
      sb.from('plant_news_state')
        .select('eia_plant_code, plant_summary')
        .in('eia_plant_code', plantCodes),
    ]);
    plants      = (plantsRes.data ?? []) as PlantDetail[];
    plantStates = (statesRes.data ?? []) as PlantState[];
  }

  const stateMap = new Map(plantStates.map(s => [s.eia_plant_code, s.plant_summary]));

  const plantDetails = plants
    .sort((a, b) => (b.distress_score ?? 0) - (a.distress_score ?? 0))
    .map(p => {
      const cf = p.ttm_avg_factor != null ? `${(p.ttm_avg_factor * 100).toFixed(1)}% CF` : 'CF N/A';
      const curtailed = p.is_likely_curtailed ? ' [CURTAILED]' : '';
      const signal = stateMap.get(p.eia_plant_code);
      return `- ${p.name} (${p.fuel_source}, ${p.state}, ${p.nameplate_capacity_mw} MW, ${cf}${curtailed})${signal ? `\n  Signal: ${signal.slice(0, 200)}` : ''}`;
    }).join('\n');

  // ── Compute CF vs benchmark delta ──────────────────────────────────────────
  const assetCount      = existing?.asset_count ?? plantCodes.length;
  const curtailedCount  = plants.filter(p => p.is_likely_curtailed).length;
  const underperforming = plants.filter(p => p.is_likely_curtailed || (p.distress_score != null && p.distress_score > 50)).length;

  const avgCf       = existing?.portfolio_avg_cf != null ? `${(Number(existing.portfolio_avg_cf) * 100).toFixed(1)}%` : 'N/A';
  const benchmarkCf = existing?.portfolio_benchmark_cf != null ? `${(Number(existing.portfolio_benchmark_cf) * 100).toFixed(1)}%` : 'N/A';
  const pctCurtailed = existing?.pct_curtailed != null ? `${Number(existing.pct_curtailed).toFixed(0)}%` : 'N/A';
  const distressScore = existing?.distress_score != null ? String(Number(existing.distress_score).toFixed(0)) : 'N/A';

  let cfVsBenchmark = 'N/A';
  if (existing?.portfolio_avg_cf != null && existing?.portfolio_benchmark_cf != null) {
    const diff = (Number(existing.portfolio_avg_cf) - Number(existing.portfolio_benchmark_cf)) * 100;
    cfVsBenchmark = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pp vs. regional benchmark`;
  }

  const articleBlurbs = (articles ?? []).map((a: Record<string, unknown>, i: number) =>
    `[${i+1}] ${a.title} (${a.source_name ?? 'unknown'}, ${String(a.published_at ?? '').slice(0,10)}) — Event: ${a.event_type ?? 'none'}`
  ).join('\n');

  const prompt = `You are an FTI Consulting power & utilities sector analyst generating an advisory briefing for a tax equity investor in renewable energy projects.

INVESTOR: ${investor_name}
TOTAL TAX EQUITY POSITIONS: ${assetCount} plants
AVG PORTFOLIO CAPACITY FACTOR (TTM): ${avgCf}
VS. REGIONAL BENCHMARK: ${cfVsBenchmark}
% PORTFOLIO CURTAILED: ${pctCurtailed}
DISTRESS SCORE: ${distressScore} / 100
CURTAILED ASSETS: ${curtailedCount} of ${assetCount}
UNDERPERFORMING ASSETS (curtailed or distress >50): ${underperforming} of ${assetCount}

PORTFOLIO PLANTS (sorted by distress, highest first):
${plantDetails || 'No plant data available.'}

RECENT NEWS ARTICLES MENTIONING THIS INVESTOR (last 90 days):
${articleBlurbs || '(no recent articles found)'}

INSTRUCTIONS:
- Do NOT include specific dollar amounts, committed capital figures, or transaction values.
- Use asset counts, percentages, and directional language only.
- Be factual and concise. Do not invent details.

Generate three outputs:

1. analysis_text (2–3 sentences): Portfolio-level situation summary. Lead with total position count and share underperforming vs. regional benchmark. Cover yield performance pattern, curtailment impact on tax equity returns, and any sponsor or policy signals. No dollar amounts.

2. portfolio_synopsis: Two parts:
   PART A — 2-3 sentence aggregate overview (asset count, % curtailed, CF vs benchmark, overall return risk pattern)
   PART B — Per-asset signal list (one line per plant, highest-distress first):
     Format: "Plant Name (State, Fuel, CF vs benchmark): [curtailed|underperforming|stable] — [key news signal or 'no news signal']"
   Separate Part A from Part B with a blank line.

3. analysis_angle_bullets (3–5 bullets): Advisory angles for FTI's Restructuring, Transactions, Policy, or EFC teams.

Respond ONLY with valid JSON — no markdown fences, no extra keys:
{
  "analysis_text": "<2–3 sentence summary>",
  "portfolio_synopsis": "<Part A overview>\\n\\n<Part B per-asset lines>",
  "analysis_angle_bullets": ["<bullet 1>", "<bullet 2>", "<bullet 3>"]
}`;

  // ── Call Gemini ────────────────────────────────────────────────────────────
  let analysisText         = 'Analysis unavailable — Gemini API key not configured.';
  let analysisAngleBullets: string[] = [];
  let portfolioSynopsis: string | null = null;

  if (geminiKey) {
    try {
      const geminiResp = await fetch(`${GEMINI_BASE}?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
        }),
      });
      if (geminiResp.ok) {
        const geminiData = await geminiResp.json();
        const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed  = JSON.parse(cleaned);
        analysisText         = parsed.analysis_text          ?? analysisText;
        analysisAngleBullets = parsed.analysis_angle_bullets ?? [];
        portfolioSynopsis    = parsed.portfolio_synopsis     ?? null;
      } else {
        console.error('[tax-equity-analyze] Gemini error:', geminiResp.status, await geminiResp.text());
      }
    } catch (err) {
      console.error('[tax-equity-analyze] Gemini parse error:', err);
    }
  }

  const now = new Date().toISOString();

  // ── Upsert cache ───────────────────────────────────────────────────────────
  await sb.from('tax_equity_stats').upsert({
    investor_name,
    analysis_text:            analysisText,
    analysis_angle_bullets:   analysisAngleBullets,
    portfolio_synopsis:       portfolioSynopsis,
    analysis_updated_at:      now,
    computed_at:              existing?.analysis_updated_at ?? now,
  }, { onConflict: 'investor_name' });

  return new Response(JSON.stringify({
    analysisText,
    analysisAngleBullets,
    portfolioSynopsis,
    analysisUpdatedAt:    now,
    fromCache:            false,
  }), { headers: { 'Content-Type': 'application/json' } });
});
