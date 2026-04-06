/**
 * GenTrack — lender-extract Edge Function
 *
 * Reads ranked financing articles (pipeline='financing',
 * asset_linkage_tier IN ('high','medium'), lender_extracted_at IS NULL),
 * calls Gemini Flash to extract structured financing counterparty data,
 * writes rows to plant_lenders, tags article entity_company_names,
 * and marks articles as extracted.
 *
 * POST body:
 *   {}                         — process all unextracted high/medium articles
 *   { batch_size?: number }    — how many articles to process per call (default 30)
 *   { eia_plant_code: string } — process only articles for a specific plant
 *
 * Pipeline position:
 *   lender-news-rank → lender-extract → refresh-entity-stats
 *
 * Required secrets:
 *   GEMINI_API_KEY            — Gemini API key
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ──────────────────────────────────────────────────────────────────

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const DEFAULT_BATCH_SIZE = 30;
const DELAY_BETWEEN_CALLS_MS = 500;

const VALID_ROLES = new Set(['lender', 'tax_equity', 'sponsor', 'co-investor', 'other']);
const VALID_FACILITY_TYPES = new Set([
  'term_loan', 'revolving_credit', 'construction_loan', 'tax_equity',
  'bridge_loan', 'letter_of_credit', 'other',
]);
const VALID_CONFIDENCES = new Set(['high', 'medium', 'low']);

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

interface ArticleRow {
  id: string;
  title: string;
  description: string | null;
  article_summary: string | null;
  tags: string[] | null;
  plant_codes: string[];
  published_at: string;
  entity_company_names: string[] | null;
}

interface ExtractedCounterparty {
  name: string;
  role: string;
  facility_type: string;
  amount_usd: number | null;
  confidence: string;
}

interface ExtractionResult {
  counterparties: ExtractedCounterparty[];
  entity_names: string[];
}

// ── Gemini extraction prompt ───────────────────────────────────────────────────

function buildExtractionPrompt(articles: ArticleRow[]): string {
  const articleList = articles.map(a => ({
    id: a.id,
    title: a.title,
    summary: a.article_summary ?? a.description ?? '',
    tags: a.tags ?? [],
    published_at: a.published_at,
  }));

  return `You are a financial data extraction assistant. Extract structured financing counterparty data from power plant financing news articles.

For each article, identify ALL named financing counterparties — lenders, tax equity investors, sponsors, co-investors, or other financing parties.

RULES:
- Only extract NAMED entities (real institution or company names). Do not extract generic terms like "a major bank", "an unnamed investor", "the lender", "consortium of banks", "a group of lenders", "undisclosed investor", "various banks", or "multiple lenders".
- If the specific institution cannot be identified by name, omit the entry entirely.
- Use the full, commonly recognized institutional name (e.g. "JPMorgan Chase" not "JPMC" or "JP Morgan Chase & Co."). Do not include legal suffixes like "N.A.", "LLC", "Inc." unless they disambiguate different entities.
- For each named counterparty, identify their role and facility type as best you can from context.
- amount_usd: extract only if a specific dollar amount is stated for THIS counterparty's facility. Use null otherwise.
- confidence: "high" = article explicitly names them as a financing party for this plant; "medium" = likely but indirect; "low" = mentioned in context but role unclear.
- entity_names: flat list of ALL named financial institution/company names across all articles (for search indexing). Include only real named entities.
- Do NOT include dollar amounts in your output — set amount_usd to null always.

INPUT ARTICLES:
${JSON.stringify(articleList, null, 2)}

OUTPUT FORMAT — return ONLY valid JSON, no markdown:
{
  "articles": [
    {
      "id": "article-uuid",
      "counterparties": [
        {
          "name": "JPMorgan Chase",
          "role": "lender",
          "facility_type": "term_loan",
          "amount_usd": null,
          "confidence": "high"
        }
      ],
      "entity_names": ["JPMorgan Chase", "US Bancorp"]
    }
  ]
}

Valid roles: lender, tax_equity, sponsor, co-investor, other
Valid facility_types: term_loan, revolving_credit, construction_loan, tax_equity, bridge_loan, letter_of_credit, other
Valid confidence: high, medium, low`;
}

// ── Call Gemini ────────────────────────────────────────────────────────────────

async function callGeminiExtraction(
  geminiKey: string,
  articles: ArticleRow[],
): Promise<{ id: string; counterparties: ExtractedCounterparty[]; entity_names: string[] }[]> {
  const prompt = buildExtractionPrompt(articles);

  const resp = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini HTTP ${resp.status}: ${errText}`);
  }

  const body = await resp.json();

  let raw = '';
  for (const part of (body?.candidates?.[0]?.content?.parts ?? [])) {
    if (part.text && !part.thought) raw = part.text;
  }

  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(raw);
  return (parsed.articles ?? []) as { id: string; counterparties: ExtractedCounterparty[]; entity_names: string[] }[];
}

// ── Sanitize extraction output ─────────────────────────────────────────────────

function sanitizeCounterparty(cp: ExtractedCounterparty): ExtractedCounterparty | null {
  if (!cp.name || typeof cp.name !== 'string' || cp.name.trim().length < 3) return null;
  if (!VALID_ROLES.has(cp.role)) return null;
  if (!VALID_FACILITY_TYPES.has(cp.facility_type)) cp.facility_type = 'other';
  if (!VALID_CONFIDENCES.has(cp.confidence)) cp.confidence = 'low';
  cp.amount_usd = null; // enforce: never store dollar amounts
  cp.name = cp.name.trim().slice(0, 200);
  return cp;
}

// ── Persist to plant_lenders ───────────────────────────────────────────────────

async function persistExtractions(
  sb: ReturnType<typeof createClient>,
  article: ArticleRow,
  counterparties: ExtractedCounterparty[],
  entityNames: string[],
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  const validCps = counterparties
    .map(sanitizeCounterparty)
    .filter((cp): cp is ExtractedCounterparty => cp !== null && cp.confidence !== 'low');

  for (const plantCode of article.plant_codes) {
    for (const cp of validCps) {
      const row = {
        eia_plant_code:     plantCode,
        lender_name:        cp.name,
        role:               cp.role,
        facility_type:      cp.facility_type,
        loan_amount_usd:    null,  // never store dollar amounts
        interest_rate_text: null,
        maturity_text:      null,
        confidence:         cp.confidence,
        source_article_id:  article.id,
        source:             'news_extract',
      };

      const { error } = await sb
        .from('plant_lenders')
        .upsert(row, {
          onConflict: 'eia_plant_code,lender_name,facility_type',
          ignoreDuplicates: false,
        });

      if (error) {
        console.warn(`  plant_lenders upsert failed for ${cp.name} / ${plantCode}: ${error.message}`);
        skipped++;
      } else {
        inserted++;
      }
    }
  }

  // Update entity_company_names on the article so it's discoverable via search_entity_news
  if (entityNames.length > 0) {
    const existingNames = article.entity_company_names ?? [];
    const merged = [...new Set([...existingNames, ...entityNames.map(n => n.trim()).filter(n => n.length >= 3)])];

    await sb
      .from('news_articles')
      .update({ entity_company_names: merged })
      .eq('id', article.id);
  }

  return { inserted, skipped };
}

// ── Load unextracted articles ──────────────────────────────────────────────────

async function loadUnextractedArticles(
  sb: ReturnType<typeof createClient>,
  batchSize: number,
  eiaPlantCode?: string,
): Promise<ArticleRow[]> {
  let query = sb
    .from('news_articles')
    .select('id, title, description, article_summary, tags, plant_codes, published_at, entity_company_names')
    .eq('pipeline', 'financing')
    .in('asset_linkage_tier', ['high', 'medium'])
    .is('lender_extracted_at', null)
    .order('published_at', { ascending: false })
    .limit(batchSize);

  if (eiaPlantCode) {
    query = query.contains('plant_codes', [eiaPlantCode]);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load unextracted articles: ${error.message}`);
  return (data ?? []) as ArticleRow[];
}

// ── Mark articles as extracted ─────────────────────────────────────────────────

async function markExtracted(
  sb: ReturnType<typeof createClient>,
  articleIds: string[],
): Promise<void> {
  if (articleIds.length === 0) return;
  await sb
    .from('news_articles')
    .update({ lender_extracted_at: new Date().toISOString() })
    .in('id', articleIds);
}

// ── Chain call helper ──────────────────────────────────────────────────────────

function fireAndForget(url: string, body: Record<string, unknown>): void {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify(body),
  }).catch(err => console.error('Chain call failed:', err));
}

// ── Handler ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not set' }), { status: 500, headers: CORS });
  }

  let body: { batch_size?: number; eia_plant_code?: string } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const batchSize = body.batch_size ?? DEFAULT_BATCH_SIZE;
  const sb = makeSupabase();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  try {
    const articles = await loadUnextractedArticles(sb, batchSize, body.eia_plant_code);

    if (articles.length === 0) {
      console.log('No unextracted financing articles found — done.');
      return new Response(JSON.stringify({ ok: true, message: 'No articles to process', extracted: 0 }), { headers: CORS });
    }

    console.log(`Processing ${articles.length} financing articles for extraction`);

    // Process articles in groups of 10 to keep Gemini prompt size manageable
    const GEMINI_BATCH = 10;
    let totalInserted = 0;
    let totalSkipped = 0;
    const processedIds: string[] = [];
    const results: { articleId: string; counterparties: number; entities: string[] }[] = [];

    for (let i = 0; i < articles.length; i += GEMINI_BATCH) {
      const chunk = articles.slice(i, i + GEMINI_BATCH);

      try {
        const extractions = await callGeminiExtraction(geminiKey, chunk);
        const extractionMap = new Map(extractions.map(e => [e.id, e]));

        for (const article of chunk) {
          const extraction = extractionMap.get(article.id);
          if (!extraction) {
            processedIds.push(article.id);
            continue;
          }

          const { inserted, skipped } = await persistExtractions(
            sb,
            article,
            extraction.counterparties,
            extraction.entity_names,
          );

          totalInserted += inserted;
          totalSkipped += skipped;
          processedIds.push(article.id);

          results.push({
            articleId: article.id,
            counterparties: extraction.counterparties.filter(cp => cp.confidence !== 'low').length,
            entities: extraction.entity_names,
          });

          console.log(`  ${article.title.slice(0, 60)} → ${inserted} rows, entities: [${extraction.entity_names.join(', ')}]`);
        }
      } catch (err) {
        console.error(`Gemini extraction failed for chunk starting at ${i}:`, err);
        // Mark articles as extracted anyway to avoid infinite retry loops
        for (const a of chunk) processedIds.push(a.id);
      }

      if (i + GEMINI_BATCH < articles.length) {
        await sleep(DELAY_BETWEEN_CALLS_MS);
      }
    }

    // Mark all processed articles as extracted
    await markExtracted(sb, processedIds);

    console.log(`Extraction complete: ${totalInserted} plant_lenders rows inserted across ${processedIds.length} articles`);

    // Chain to refresh-entity-stats
    if (totalInserted > 0) {
      console.log('Chaining to refresh-entity-stats');
      fireAndForget(`${supabaseUrl}/functions/v1/refresh-entity-stats`, {});
    }

    return new Response(JSON.stringify({
      ok: true,
      articlesProcessed: processedIds.length,
      plantLendersInserted: totalInserted,
      plantLendersSkipped: totalSkipped,
      results,
    }), { headers: CORS });

  } catch (err) {
    console.error('lender-extract fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
