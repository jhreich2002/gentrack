/**
 * GenTrack — company-analyze Edge Function
 *
 * On-demand per-company LLM advisory analysis via Gemini Flash Lite.
 * Caches result in company_stats.analysis_text for 12 hours.
 *
 * POST { ult_parent_name: string }
 * → { analysis_text, analysis_angle_bullets, analysis_updated_at, from_cache }
 *
 * Required secrets:
 *   GEMINI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const GEMINI_BASE   = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';
const CACHE_HOURS   = 12;
const MAX_ARTICLES  = 10;

Deno.serve(async (req: Request) => {
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
    .select('analysis_text, analysis_angle_bullets, analysis_updated_at, total_mw, plant_count, avg_cf, tech_breakdown, state_breakdown, event_counts, relevance_scores')
    .eq('ult_parent_name', ult_parent_name)
    .single();

  if (existing?.analysis_updated_at) {
    const ageHours = (Date.now() - new Date(existing.analysis_updated_at).getTime()) / 3_600_000;
    if (ageHours < CACHE_HOURS && existing.analysis_text) {
      return new Response(JSON.stringify({
        analysis_text:          existing.analysis_text,
        analysis_angle_bullets: existing.analysis_angle_bullets ?? [],
        analysis_updated_at:    existing.analysis_updated_at,
        from_cache:             true,
      }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  // ── Fetch top articles linked to this company ─────────────────────────────
  const cutoff = new Date(Date.now() - 90 * 864e5).toISOString();
  const { data: articles } = await sb
    .from('news_articles')
    .select('title, description, source_name, published_at, event_type, fti_relevance_tags, importance')
    .contains('entity_company_names', [ult_parent_name])
    .gte('published_at', cutoff)
    .order('importance', { ascending: false })
    .order('published_at', { ascending: false })
    .limit(MAX_ARTICLES);

  // ── Build Gemini prompt ───────────────────────────────────────────────────
  const stats = existing ?? {};
  const techSummary  = Object.entries(stats.tech_breakdown  ?? {}).map(([k,v]) => `${k}: ${v} MW`).join(', ') || 'N/A';
  const stateSummary = Object.entries(stats.state_breakdown ?? {}).sort(([,a],[,b]) => (b as number)-(a as number)).slice(0,5).map(([k,v]) => `${k}: ${v} MW`).join(', ') || 'N/A';
  const eventSummary = Object.entries(stats.event_counts    ?? {}).map(([k,v]) => `${k}: ${v}`).join(', ')          || 'none';

  const articleBlurbs = (articles ?? []).map((a, i) =>
    `[${i+1}] ${a.title} (${a.source_name ?? 'unknown'}, ${a.published_at?.slice(0,10) ?? ''}) — Event: ${a.event_type ?? 'none'}`
  ).join('\n');

  const prompt = `You are an FTI Consulting power & utilities sector analyst generating a concise advisory briefing.

COMPANY: ${ult_parent_name}
PORTFOLIO: ${stats.total_mw ?? 0} MW nameplate capacity across ${stats.plant_count ?? 0} plants
TECHNOLOGY MIX: ${techSummary}
TOP STATES: ${stateSummary}
AVG TTM CAPACITY FACTOR: ${stats.avg_cf != null ? (Number(stats.avg_cf) * 100).toFixed(1) + '%' : 'N/A'}
RECENT NEWS EVENT COUNTS (90 days): ${eventSummary}

RECENT NEWS ARTICLES:
${articleBlurbs || '(no recent articles found)'}

Write a 2–3 sentence situation summary of this company's current standing from an FTI advisory perspective — covering portfolio health, any financial/operational stress signals, and strategic activity.

Then provide 3–5 advisory angle bullets (one sentence each) that FTI's Restructuring, Transactions, Disputes, or Market & Strategy teams could pursue with this company as a client or counterparty.

Respond ONLY with valid JSON in this exact schema — no markdown fences, no extra keys:
{
  "analysis_text": "<2–3 sentence situation summary>",
  "analysis_angle_bullets": ["<bullet 1>", "<bullet 2>", "<bullet 3>"]
}`;

  // ── Call Gemini ───────────────────────────────────────────────────────────
  let analysisText        = 'Analysis unavailable — Gemini API key not configured.';
  let analysisAngleBullets: string[] = [];

  if (geminiKey) {
    try {
      const geminiResp = await fetch(`${GEMINI_BASE}?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 512 },
        }),
      });

      if (geminiResp.ok) {
        const geminiData = await geminiResp.json();
        const raw = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed  = JSON.parse(cleaned);
        analysisText         = parsed.analysis_text         ?? analysisText;
        analysisAngleBullets = parsed.analysis_angle_bullets ?? [];
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
    ult_parent_name:          ult_parent_name,
    analysis_text:            analysisText,
    analysis_angle_bullets:   analysisAngleBullets,
    analysis_updated_at:      now,
    computed_at:              existing?.analysis_updated_at ?? now, // don't overwrite full refresh date
  }, { onConflict: 'ult_parent_name' });

  return new Response(JSON.stringify({
    analysis_text:          analysisText,
    analysis_angle_bullets: analysisAngleBullets,
    analysis_updated_at:    now,
    from_cache:             false,
  }), { headers: { 'Content-Type': 'application/json' } });
});
