/**
 * GenTrack — company-analyze Edge Function
 *
 * On-demand per-company LLM advisory analysis via Gemini Flash Lite.
 * Caches result in company_stats for 12 hours.
 *
 * POST { ult_parent_name: string }
 * → { analysis_text, analysis_angle_bullets, portfolio_synopsis, analysis_updated_at, from_cache }
 *
 * Required secrets:
 *   GEMINI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const CACHE_HOURS  = 12;
const MAX_ARTICLES = 10;
const MAX_PLANTS   = 20;

Deno.serve(async (req: Request) => {
  const __authDenied = checkInternalAuth(req);
  if (__authDenied) return __authDenied;
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405 });
  }

  const { ult_parent_name } = await req.json();
  if (!ult_parent_name) {
    return new Response(JSON.stringify({ error: 'ult_parent_name required' }), { status: 400 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const geminiKey   = Deno.env.get('GEMINI_API_KEY') ?? '';
  const sb          = createClient(supabaseUrl, serviceKey);

  // ── Cache check ───────────────────────────────────────────────────────────
  const { data: existing } = await sb
    .from('company_stats')
    .select('analysis_text, analysis_angle_bullets, portfolio_synopsis, analysis_updated_at, total_mw, plant_count, avg_cf, tech_breakdown, state_breakdown, event_counts, relevance_scores, distress_score')
    .eq('ult_parent_name', ult_parent_name)
    .single();

  if (existing?.analysis_updated_at) {
    const ageHours = (Date.now() - new Date(existing.analysis_updated_at).getTime()) / 3_600_000;
    if (ageHours < CACHE_HOURS && existing.analysis_text) {
      return new Response(JSON.stringify({
        analysis_text:          existing.analysis_text,
        analysis_angle_bullets: existing.analysis_angle_bullets ?? [],
        portfolio_synopsis:     existing.portfolio_synopsis ?? null,
        analysis_updated_at:    existing.analysis_updated_at,
        from_cache:             true,
      }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  // ── Fetch top articles linked to this company ─────────────────────────────
  const cutoff = new Date(Date.now() - 90 * 864e5).toISOString();
  const { data: articles } = await sb
    .from('news_articles')
    .select('title, source_name, published_at, event_type, fti_relevance_tags, importance')
    .contains('entity_company_names', [ult_parent_name])
    .gte('published_at', cutoff)
    .order('importance', { ascending: false })
    .order('published_at', { ascending: false })
    .limit(MAX_ARTICLES);

  // ── Fetch portfolio plants + their news signals ────────────────────────────
  interface PlantDetail { eia_plant_code: string; name: string; state: string; fuel_source: string; nameplate_capacity_mw: number; ttm_avg_factor: number | null; is_likely_curtailed: boolean; distress_score: number | null }
  interface PlantState  { eia_plant_code: string; plant_summary: string | null }

  const { data: plantsRaw } = await sb
    .from('plants')
    .select('eia_plant_code, name, state, fuel_source, nameplate_capacity_mw, ttm_avg_factor, is_likely_curtailed, distress_score')
    .eq('ult_parent_name', ult_parent_name)
    .order('distress_score', { ascending: false, nullsFirst: false })
    .limit(MAX_PLANTS);

  const plants: PlantDetail[] = (plantsRaw ?? []) as PlantDetail[];
  const plantCodes = plants.map(p => p.eia_plant_code);

  let plantStates: PlantState[] = [];
  if (plantCodes.length > 0) {
    const { data: statesRaw } = await sb
      .from('plant_news_state')
      .select('eia_plant_code, plant_summary')
      .in('eia_plant_code', plantCodes);
    plantStates = (statesRaw ?? []) as PlantState[];
  }

  const stateMap = new Map(plantStates.map(s => [s.eia_plant_code, s.plant_summary]));

  const curtailedCount  = plants.filter(p => p.is_likely_curtailed).length;
  const underperforming = plants.filter(p => p.is_likely_curtailed || (p.distress_score != null && p.distress_score > 50)).length;
  const assetCount      = existing?.plant_count ?? plants.length;

  const plantDetails = plants
    .map(p => {
      const cf = p.ttm_avg_factor != null ? `${(p.ttm_avg_factor * 100).toFixed(1)}% CF` : 'CF N/A';
      const curtailed = p.is_likely_curtailed ? ' [CURTAILED]' : '';
      const signal = stateMap.get(p.eia_plant_code);
      return `- ${p.name} (${p.fuel_source}, ${p.state}, ${p.nameplate_capacity_mw} MW, ${cf}${curtailed})${signal ? `\n  Signal: ${signal.slice(0, 200)}` : ''}`;
    }).join('\n');

  // ── Build Gemini prompt ───────────────────────────────────────────────────
  const stats = existing ?? {};
  const techSummary  = Object.entries(stats.tech_breakdown  ?? {}).map(([k,v]) => `${k}: ${v} MW`).join(', ') || 'N/A';
  const stateSummary = Object.entries(stats.state_breakdown ?? {}).sort(([,a],[,b]) => (b as number)-(a as number)).slice(0,5).map(([k,v]) => `${k}: ${v} MW`).join(', ') || 'N/A';
  const eventSummary = Object.entries(stats.event_counts    ?? {}).map(([k,v]) => `${k}: ${v}`).join(', ')          || 'none';
  const distressScore = stats.distress_score != null ? String(Number(stats.distress_score).toFixed(0)) : 'N/A';

  const articleBlurbs = (articles ?? []).map((a: Record<string, unknown>, i: number) =>
    `[${i+1}] ${a.title} (${a.source_name ?? 'unknown'}, ${String(a.published_at ?? '').slice(0,10)}) — Event: ${a.event_type ?? 'none'}`
  ).join('\n');

  const prompt = `You are an FTI Consulting power & utilities sector analyst generating an advisory briefing for a power generation owner/operator.

COMPANY: ${ult_parent_name}
TOTAL ASSETS: ${assetCount} plants
TOTAL NAMEPLATE CAPACITY: ${stats.total_mw ?? 0} MW
TECHNOLOGY MIX: ${techSummary}
TOP STATES BY CAPACITY: ${stateSummary}
AVG TTM CAPACITY FACTOR: ${stats.avg_cf != null ? (Number(stats.avg_cf) * 100).toFixed(1) + '%' : 'N/A'}
DISTRESS SCORE: ${distressScore} / 100
CURTAILED ASSETS: ${curtailedCount} of ${assetCount}
UNDERPERFORMING ASSETS (curtailed or distress >50): ${underperforming} of ${assetCount}
RECENT EVENT COUNTS (90 days): ${eventSummary}

PORTFOLIO PLANTS (sorted by distress, highest first):
${plantDetails || 'No plant data available.'}

RECENT NEWS ARTICLES:
${articleBlurbs || '(no recent articles found)'}

INSTRUCTIONS:
- Do NOT include specific dollar amounts, market capitalizations, or transaction values.
- Use asset counts, percentages, MW figures, and directional language only.
- Be factual and concise. Do not invent details.

Generate three outputs:

1. analysis_text (2–3 sentences): Portfolio-level situation summary. Lead with total asset count and share underperforming. Cover operational health across the portfolio, any financial stress signals, and strategic/regulatory activity. No dollar amounts.

2. portfolio_synopsis: Two parts:
   PART A — 2-3 sentence aggregate overview (asset count, tech mix, % curtailed/underperforming, overall risk characterization)
   PART B — Per-asset signal list (one line per plant, highest-distress first):
     Format: "Plant Name (State, Fuel, CF): [curtailed|underperforming|stable] — [key news signal or 'no news signal']"
   Separate Part A from Part B with a blank line.

3. analysis_angle_bullets (3–5 bullets): Advisory angles for FTI's Restructuring, Transactions, Disputes, or Market & Strategy teams.

Respond ONLY with valid JSON — no markdown fences, no extra keys:
{
  "analysis_text": "<2–3 sentence summary>",
  "portfolio_synopsis": "<Part A overview>\\n\\n<Part B per-asset lines>",
  "analysis_angle_bullets": ["<bullet 1>", "<bullet 2>", "<bullet 3>"]
}`;

  // ── Call Gemini ───────────────────────────────────────────────────────────
  let analysisText        = 'Analysis unavailable — Gemini API key not configured.';
  let analysisAngleBullets: string[] = [];
  let portfolioSynopsis: string | null = null;

  if (geminiKey) {
    try {
      const geminiResp = await fetch(`${GEMINI_BASE}?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
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
        console.error('[company-analyze] Gemini error:', geminiResp.status, await geminiResp.text());
      }
    } catch (err) {
      console.error('[company-analyze] Gemini parse error:', err);
    }
  }

  const now = new Date().toISOString();

  // ── Upsert into company_stats ─────────────────────────────────────────────
  await sb.from('company_stats').upsert({
    ult_parent_name,
    analysis_text:            analysisText,
    analysis_angle_bullets:   analysisAngleBullets,
    portfolio_synopsis:       portfolioSynopsis,
    analysis_updated_at:      now,
    computed_at:              existing?.analysis_updated_at ?? now,
  }, { onConflict: 'ult_parent_name' });

  return new Response(JSON.stringify({
    analysis_text:          analysisText,
    analysis_angle_bullets: analysisAngleBullets,
    portfolio_synopsis:     portfolioSynopsis,
    analysis_updated_at:    now,
    from_cache:             false,
  }), { headers: { 'Content-Type': 'application/json' } });
});
