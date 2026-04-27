/**
 * GenTrack — ucc-news-fallback-worker Edge Function (Deno)
 *
 * FALLBACK ONLY — runs after all evidence workers return zero confirmed lenders.
 * Uses Perplexity sonar-pro to search for news articles, press releases, and
 * investor announcements that name lenders for this plant.
 *
 * Results are written ONLY to ucc_lender_leads_unverified — never to
 * ucc_evidence_records or ucc_lender_links (those require hard citation).
 *
 * The supervisor sets the plant status to "partial" (not "confirmed") when
 * this worker is the only source of leads.
 *
 * POST body:
 *   { plant_code, run_id, plant_name, sponsor_name, state, capacity_mw?, cod_year? }
 *
 * Returns standard worker output schema.
 *
 * Required secrets:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 *   PERPLEXITY_API_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

const PERPLEXITY_URL     = 'https://api.perplexity.ai/chat/completions';
const PERPLEXITY_MODEL   = 'sonar-pro';
const PERPLEXITY_TIMEOUT = 30_000;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkerOutput {
  task_status:           'success' | 'partial' | 'failed';
  completion_score:      number;
  evidence_found:        boolean;
  structured_results:    NewsLead[];
  source_urls:           string[];
  raw_evidence_snippets: string[];
  open_questions:        string[];
  retry_recommendation:  string | null;
  cost_usd:              number;
  llm_fallback_used:     true;
  duration_ms:           number;
  queries_attempted:     Array<{ source: string; query: string; hit_count: number; url: string | null }>;
}

interface NewsLead {
  lender_name:   string;
  normalized:    string;
  role:          string;
  facility_type: string | null;
  article_url:   string | null;
  article_title: string | null;
  article_date:  string | null;
  confidence:    number;   // 0-100 — always lower than citation-grade sources
  excerpt:       string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [NEWS_FALLBACK:${tag}] ${msg}`);
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|lp|inc|corp|co|ltd|na|n\.a\.|as agent)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0 + 0.005;
}

// ── Perplexity news search ────────────────────────────────────────────────────

async function searchNewsForLenders(
  plantName:     string,
  sponsorName:   string | null,
  state:         string,
  capacityMw:    number | null,
  perplexityKey: string,
): Promise<{ leads: NewsLead[]; costUsd: number; rawText: string }> {
  const stateHint    = state ? ` in ${state}` : '';
  const sponsorHint  = sponsorName ? ` developed by ${sponsorName}` : '';
  const capacityHint = capacityMw ? ` (${capacityMw} MW)` : '';

  const prompt = `Find news articles, press releases, or announcements that name the lenders, banks, or tax equity investors who financed the ${plantName} renewable energy project${capacityHint}${stateHint}${sponsorHint}.

Look for:
- Construction loan or term loan announcements
- Tax equity closing announcements
- Project finance tombstones or league table entries
- Developer investor relations pages or press releases

Return ONLY a JSON array (no markdown):
[
  {
    "lender_name": "Exact bank or investor name",
    "role": "construction_lender | term_lender | tax_equity_investor | lead_arranger | administrative_agent",
    "facility_type": "construction_loan | term_loan | tax_equity | revolving_credit | null",
    "confidence": 60,
    "article_url": "https://... or null",
    "article_title": "Article or press release title or null",
    "article_date": "YYYY-MM-DD or null",
    "excerpt": "The exact sentence from the article naming this lender"
  }
]

Return [] if nothing is found. Only include entries with actual article/URL evidence — do not guess or fabricate.`;

  const body = {
    model:    PERPLEXITY_MODEL,
    messages: [
      {
        role:    'system',
        content: 'You are a renewable energy project finance researcher. Return only valid JSON arrays. Never fabricate citations.',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens:  1200,
    temperature: 0,
  };

  try {
    const resp = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${perplexityKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PERPLEXITY_TIMEOUT),
    });

    if (!resp.ok) throw new Error(`Perplexity HTTP ${resp.status}`);

    const data  = await resp.json();
    const usage = data.usage ?? {};
    const cost  = estimateCost(usage.prompt_tokens ?? 800, usage.completion_tokens ?? 600);
    const raw   = data.choices?.[0]?.message?.content ?? '[]';

    let parsed: Array<{
      lender_name:   string;
      role?:         string;
      facility_type?: string;
      confidence?:   number;
      article_url?:  string;
      article_title?: string;
      article_date?: string;
      excerpt?:      string;
    }> = [];

    try {
      parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
    } catch {
      log('PERP', 'JSON parse failed — no leads extracted');
    }

    const leads: NewsLead[] = parsed
      .filter(p => p.lender_name && typeof p.lender_name === 'string')
      .map(p => ({
        lender_name:   p.lender_name.trim(),
        normalized:    normalizeName(p.lender_name),
        role:          p.role ?? 'lender',
        facility_type: p.facility_type ?? null,
        article_url:   p.article_url ?? null,
        article_title: p.article_title ?? null,
        article_date:  p.article_date ?? null,
        confidence:    Math.min(Math.max(p.confidence ?? 55, 0), 70), // cap at 70 — news is never "confirmed"
        excerpt:       (p.excerpt ?? '').slice(0, 500),
      }));

    return { leads, costUsd: cost, rawText: raw };
  } catch (err) {
    log('PERP', `Error: ${err instanceof Error ? err.message : String(err)}`);
    return { leads: [], costUsd: 0, rawText: '' };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 });

  const startMs = Date.now();

  try {
    const { plant_code, run_id, plant_name, sponsor_name, state, capacity_mw }:
      { plant_code: string; run_id: string; plant_name: string; sponsor_name: string | null; state: string; capacity_mw?: number } =
      await req.json();

    if (!plant_code || !plant_name) {
      return new Response(JSON.stringify({ error: 'plant_code and plant_name required' }), { status: 400, headers: CORS });
    }

    const perplexityKey = Deno.env.get('PERPLEXITY_API_KEY') ?? '';
    if (!perplexityKey) {
      log(plant_code, 'PERPLEXITY_API_KEY not set — returning empty');
      return new Response(JSON.stringify({
        task_status: 'failed', completion_score: 0, evidence_found: false,
        structured_results: [], source_urls: [], raw_evidence_snippets: [],
        open_questions: ['PERPLEXITY_API_KEY secret not configured'],
        retry_recommendation: 'Set PERPLEXITY_API_KEY in Supabase edge function secrets',
        cost_usd: 0, llm_fallback_used: true, duration_ms: Date.now() - startMs, queries_attempted: [],
      }), { headers: CORS });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const queriesAttempted: Array<{ source: string; query: string; hit_count: number; url: string | null }> = [];

    log(plant_code, `Running news fallback search for "${plant_name}"`);

    const { leads, costUsd, rawText } = await searchNewsForLenders(
      plant_name, sponsor_name, state, capacity_mw ?? null, perplexityKey,
    );

    queriesAttempted.push({
      source:    'perplexity_news',
      query:     `${plant_name} lender financing ${state}`,
      hit_count: leads.length,
      url:       null,
    });

    log(plant_code, `News fallback: ${leads.length} leads, cost $${costUsd.toFixed(4)}`);

    // Persist leads to UNVERIFIED table only (using the existing table schema)
    const seen = new Set<string>();
    for (const lead of leads) {
      if (seen.has(lead.normalized)) continue;
      seen.add(lead.normalized);

      // Upsert entity first to get lender_entity_id
      const { data: lenderEntity } = await supabase
        .from('ucc_entities')
        .upsert({
          entity_name:     lead.lender_name,
          entity_type:     'lender',
          normalized_name: lead.normalized,
          jurisdiction:    state,
          source:          'news_article',
          source_url:      lead.article_url ?? null,
        }, { onConflict: 'normalized_name,entity_type,jurisdiction', ignoreDuplicates: false })
        .select('id')
        .single();

      await supabase.from('ucc_lender_leads_unverified').upsert({
        plant_code:        plant_code,
        lender_entity_id:  lenderEntity?.id ?? null,
        lender_name:       lead.lender_name,
        lender_normalized: lead.normalized,
        confidence_class:  lead.confidence >= 60 ? 'highly_likely' : 'possible',
        evidence_type:     'news',
        evidence_summary:  `${lead.role}${lead.facility_type ? ` (${lead.facility_type})` : ''}: ${lead.excerpt}`,
        source_url:        lead.article_url ?? null,
        source_types:      ['news_article'],
        llm_model:         PERPLEXITY_MODEL,
        run_id:            run_id || null,
      }, { onConflict: 'plant_code,lender_entity_id', ignoreDuplicates: false });
    }

    const completionScore = leads.length > 0 ? 60 : 30;

    const output: WorkerOutput = {
      task_status:           'success',
      completion_score:      completionScore,
      evidence_found:        leads.length > 0,
      structured_results:    leads,
      source_urls:           leads.filter(l => l.article_url).map(l => l.article_url!),
      raw_evidence_snippets: leads.map(l => l.excerpt).slice(0, 5),
      open_questions:        leads.length === 0 ? ['No lender news found — plant may be too new, private, or too small for press coverage'] : [],
      retry_recommendation:  null,
      cost_usd:              costUsd,
      llm_fallback_used:     true,
      duration_ms:           Date.now() - startMs,
      queries_attempted:     queriesAttempted,
    };

    if (rawText) output.raw_evidence_snippets.push(`Perplexity raw: ${rawText.slice(0, 300)}`);

    log(plant_code, `Done — ${leads.length} leads, score=${completionScore}, cost=$${costUsd.toFixed(4)}, ${output.duration_ms}ms`);
    return new Response(JSON.stringify(output), { headers: CORS });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('ERROR', msg);
    return new Response(JSON.stringify({
      task_status: 'failed', completion_score: 0, evidence_found: false,
      structured_results: [], source_urls: [], raw_evidence_snippets: [],
      open_questions: [msg], retry_recommendation: 'Unexpected error — check logs',
      cost_usd: 0, llm_fallback_used: true, duration_ms: 0, queries_attempted: [],
    }), { status: 500, headers: CORS });
  }
});
