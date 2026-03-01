/**
 * GenTrack — plant-news-summarize Edge Function
 *
 * On-demand LLM summary for a single plant. Called from the plant detail
 * view when the user opens the News & Intelligence tab or clicks
 * "Refresh Analysis".
 *
 * POST body: { eia_plant_code: string, plant_name?: string, plant_owner?: string }
 *
 * Logic:
 *   1. Check plant_news_state.summary_last_updated_at
 *      → If fresher than CACHE_HOURS, return cached data immediately.
 *   2. Pull up to MAX_ARTICLES recent news_articles for the plant (30d window).
 *   3. Build a Gemini Flash prompt with plant context + article snippets.
 *   4. Parse response → summary_text (1-2 paragraphs) + fti_angle_bullets (3-5).
 *   5. Upsert plant_news_state.
 *   6. Return { summary_text, fti_angle_bullets, summary_last_updated_at, from_cache }.
 *
 * Required secrets:
 *   GEMINI_API_KEY            — Gemini Flash API key
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ──────────────────────────────────────────────────────────────────

const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';
const CACHE_HOURS  = 6;     // skip re-summarise if state is fresher than this
const MAX_ARTICLES = 10;    // articles to feed into the prompt
const LOOKBACK_DAYS = 30;   // news window for summary context

// ── Supabase client factory ────────────────────────────────────────────────────

function makeSupabase() {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Gemini call ────────────────────────────────────────────────────────────────

interface SummaryResult {
  summary_text: string;
  fti_angle_bullets: string[];
}

async function generatePlantSummary(
  geminiKey: string,
  plantName: string,
  plantOwner: string,
  articles: Array<{ title: string; description: string | null; event_type: string | null; published_at: string }>,
): Promise<SummaryResult> {
  const articleSnippets = articles
    .map((a, i) => {
      const date = new Date(a.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const snippet = [a.title, a.description].filter(Boolean).join(' — ').slice(0, 200);
      return `${i + 1}. [${date}] ${snippet}`;
    })
    .join('\n');

  const prompt = `You are a financial advisory analyst specializing in power and energy sector intelligence.

PLANT CONTEXT:
- Name: ${plantName}
- Owner / Sponsor: ${plantOwner}

RECENT NEWS ARTICLES (last 30 days, up to ${MAX_ARTICLES}):
${articleSnippets || '(No recent articles — base assessment on general knowledge of this plant/owner.)'}

TASK:
Produce a JSON object with exactly two fields:

1. "summary_text": A concise 2-3 sentence plain-English situation summary. Focus on operational status, ownership dynamics, and any material events. Be specific and factual.

2. "fti_angle_bullets": An array of 3-5 short advisory angle bullets (each ≤12 words). These should identify potential FTI Consulting-style advisory opportunities such as:
   - Restructuring/distress signals
   - M&A / asset sale risk or opportunity
   - PPA dispute or offtake counterparty risk
   - Regulatory / FERC compliance exposure
   - Strategic alternatives / board-level tensions

If no articles are present, write a brief neutral summary and 3 generic monitoring bullets.

Respond ONLY with a valid JSON object — no markdown fences, no commentary.

Example format:
{"summary_text":"...","fti_angle_bullets":["bullet 1","bullet 2","bullet 3"]}`;

  const resp = await fetch(`${GEMINI_BASE}?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!resp.ok) {
    throw new Error(`Gemini HTTP ${resp.status}: ${await resp.text()}`);
  }

  const body = await resp.json();
  const raw = (body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();

  // Strip optional ```json fences just in case
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      summary_text:       String(parsed.summary_text ?? ''),
      fti_angle_bullets:  Array.isArray(parsed.fti_angle_bullets)
        ? (parsed.fti_angle_bullets as unknown[]).map(String)
        : [],
    };
  } catch {
    return { summary_text: raw.slice(0, 500), fti_angle_bullets: [] };
  }
}

// ── Handler ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
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

  let body: { eia_plant_code?: string; plant_name?: string; plant_owner?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS });
  }

  const { eia_plant_code, plant_name = 'Unknown Plant', plant_owner = 'Unknown Owner' } = body;
  if (!eia_plant_code) {
    return new Response(JSON.stringify({ error: 'eia_plant_code is required' }), { status: 400, headers: CORS });
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY secret not configured' }), { status: 500, headers: CORS });
  }

  const sb = makeSupabase();

  // ── 1. Check cache ─────────────────────────────────────────────────────────
  const { data: existing } = await sb
    .from('plant_news_state')
    .select('summary_text, fti_angle_bullets, summary_last_updated_at, last_event_types, last_sentiment')
    .eq('eia_plant_code', eia_plant_code)
    .single();

  if (existing?.summary_last_updated_at) {
    const ageHours = (Date.now() - new Date(existing.summary_last_updated_at).getTime()) / 3_600_000;
    if (ageHours < CACHE_HOURS) {
      return new Response(JSON.stringify({
        summary_text:           existing.summary_text,
        fti_angle_bullets:      existing.fti_angle_bullets ?? [],
        summary_last_updated_at: existing.summary_last_updated_at,
        from_cache:             true,
      }), { headers: CORS });
    }
  }

  // ── 2. Pull recent articles ────────────────────────────────────────────────
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
  const { data: articles } = await sb
    .from('news_articles')
    .select('title, description, event_type, published_at')
    .contains('plant_codes', [eia_plant_code])
    .gte('published_at', cutoff)
    .order('importance', { ascending: false })
    .order('published_at', { ascending: false })
    .limit(MAX_ARTICLES);

  // ── 3. Collect event_types seen ───────────────────────────────────────────
  const lastEventTypes = [
    ...new Set(
      (articles ?? [])
        .map((a: { event_type: string | null }) => a.event_type)
        .filter((t): t is string => Boolean(t))
    ),
  ];

  // ── 4. Call Gemini ─────────────────────────────────────────────────────────
  let summaryResult: SummaryResult;
  try {
    summaryResult = await generatePlantSummary(geminiKey, plant_name, plant_owner, articles ?? []);
  } catch (err) {
    console.error('Gemini summary error:', err);
    return new Response(JSON.stringify({ error: 'LLM call failed', detail: String(err) }), { status: 500, headers: CORS });
  }

  // ── 5. Upsert plant_news_state ─────────────────────────────────────────────
  const now = new Date().toISOString();
  const { error: upsertErr } = await sb
    .from('plant_news_state')
    .upsert({
      eia_plant_code,
      summary_text:            summaryResult.summary_text,
      fti_angle_bullets:       summaryResult.fti_angle_bullets,
      summary_last_updated_at: now,
      last_checked_at:         now,
      last_event_types:        lastEventTypes,
    }, { onConflict: 'eia_plant_code' });

  if (upsertErr) {
    console.error('plant_news_state upsert error:', upsertErr.message);
  }

  // ── 6. Return ──────────────────────────────────────────────────────────────
  return new Response(JSON.stringify({
    summary_text:            summaryResult.summary_text,
    fti_angle_bullets:       summaryResult.fti_angle_bullets,
    summary_last_updated_at: now,
    from_cache:              false,
  }), { headers: CORS });
});
