/**
 * GenTrack — embed-articles Edge Function
 *
 * Runs nightly (08:00 UTC via pg_cron, 2h after news-ingest).
 * Finds all news_articles where embedded_at IS NULL and combined
 * title+description length >= 50 chars, then calls Gemini
 * text-embedding-004 in batches of 100, storing the resulting
 * 768-dimensional vectors back into the embedding column.
 *
 * Cost: Gemini text-embedding-004 is FREE within quota
 * (1,500 requests/minute, no per-token cost on free tier).
 * Typical nightly run: ~500 new articles → 5 batch requests.
 *
 * Required secrets:
 *   GEMINI_API_KEY            — Google AI Studio key (already in .env.local)
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const GEMINI_EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';

const BATCH_SIZE   = 100;  // Gemini batchEmbedContents supports up to 100 texts
const FETCH_LIMIT  = 500;  // Max articles to embed per run (avoids timeout)
const MIN_TEXT_LEN = 50;   // Skip trivially short articles

interface ArticleRow {
  id: string;
  title: string;
  description: string | null;
}

interface EmbedRequest {
  model: string;
  content: { parts: [{ text: string }] };
  outputDimensionality?: number;
}

interface BatchEmbedResponse {
  embeddings: Array<{ values: number[] }>;
}

async function batchEmbed(texts: string[], apiKey: string): Promise<number[][]> {
  const requests: EmbedRequest[] = texts.map(text => ({
    model: 'models/gemini-embedding-001',
    content: { parts: [{ text }] },
    outputDimensionality: 768,
  }));

  const res = await fetch(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ requests }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini embed API error ${res.status}: ${errText}`);
  }

  const data: BatchEmbedResponse = await res.json();
  return data.embeddings.map(e => e.values);
}

Deno.serve(async (_req) => {
  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const geminiApiKey   = Deno.env.get('GEMINI_API_KEY');

    if (!geminiApiKey) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY secret not set' }), { status: 500 });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── Fetch articles that need embeddings ───────────────────────────────
    const { data: rows, error: fetchErr } = await supabase
      .from('news_articles')
      .select('id, title, description')
      .is('embedded_at', null)
      .order('created_at', { ascending: true })
      .limit(FETCH_LIMIT);

    if (fetchErr) {
      return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500 });
    }

    const articles: ArticleRow[] = (rows ?? []).filter((r: ArticleRow) => {
      const text = `${r.title ?? ''} ${r.description ?? ''}`.trim();
      return text.length >= MIN_TEXT_LEN;
    });

    console.log(`Found ${articles.length} articles to embed`);

    if (articles.length === 0) {
      return new Response(JSON.stringify({ ok: true, embedded: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Process in batches ────────────────────────────────────────────────
    let embedded = 0;
    let errors   = 0;

    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
      const batch = articles.slice(i, i + BATCH_SIZE);
      const texts = batch.map(a => `${a.title}. ${a.description ?? ''}`.trim());

      let vectors: number[][];
      try {
        vectors = await batchEmbed(texts, geminiApiKey);
      } catch (err) {
        console.error(`Embed batch ${i}–${i + batch.length - 1} failed:`, err);
        errors++;
        // Back off and continue rather than aborting the entire run
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // Update each article with its embedding vector
      const updates = batch.map((article, j) => ({
        id:          article.id,
        embedding:   `[${vectors[j].join(',')}]`, // pgvector literal format
        embedded_at: new Date().toISOString(),
      }));

      for (const update of updates) {
        const { error: updateErr } = await supabase
          .from('news_articles')
          .update({ embedding: update.embedding, embedded_at: update.embedded_at })
          .eq('id', update.id);

        if (updateErr) {
          console.error(`Update failed for article ${update.id}:`, updateErr.message);
          errors++;
        } else {
          embedded++;
        }
      }

      console.log(`Embedded ${embedded}/${articles.length}...`);

      // Respect Gemini rate limit (1,500 rpm = 25 rps; 100-item batches need ~0.1s gap)
      if (i + BATCH_SIZE < articles.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const result = { ok: true, embedded, errors };
    console.log('embed-articles complete:', result);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('embed-articles fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
