/**
 * GenTrack — embed-evidence Edge Function (Phase 4)
 *
 * Mirrors embed-articles, but embeds rows from lender_evidence_chunks where
 * embedding IS NULL. Uses Gemini gemini-embedding-001 with outputDimensionality
 * = 768 to match search_lender_evidence(vector(768)).
 *
 * Required secrets:
 *   GEMINI_API_KEY            — Google AI Studio key
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 *   INTERNAL_AUTH_TOKEN       — gate (see _shared/auth.ts)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const GEMINI_EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';

const BATCH_SIZE   = 100;
const FETCH_LIMIT  = 1000;
const MIN_TEXT_LEN = 40;

interface ChunkRow {
  id:      number;
  content: string;
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

Deno.serve(async (req: Request) => {
  const denied = checkInternalAuth(req);
  if (denied) return denied;

  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const geminiApiKey   = Deno.env.get('GEMINI_API_KEY');

    if (!geminiApiKey) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY secret not set' }), { status: 500 });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: rows, error: fetchErr } = await supabase
      .from('lender_evidence_chunks')
      .select('id, content')
      .is('embedding', null)
      .order('created_at', { ascending: true })
      .limit(FETCH_LIMIT);

    if (fetchErr) {
      return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500 });
    }

    const chunks: ChunkRow[] = (rows ?? []).filter((r: ChunkRow) => (r.content ?? '').trim().length >= MIN_TEXT_LEN);
    console.log(`embed-evidence: ${chunks.length} chunk(s) to embed`);

    if (chunks.length === 0) {
      return new Response(JSON.stringify({ ok: true, embedded: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let embedded = 0;
    let errors   = 0;

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map(c => c.content.trim());

      let vectors: number[][];
      try {
        vectors = await batchEmbed(texts, geminiApiKey);
      } catch (err) {
        console.error(`embed-evidence batch ${i}–${i + batch.length - 1} failed:`, err);
        errors++;
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const nowIso = new Date().toISOString();
      for (let j = 0; j < batch.length; j++) {
        const { error: upErr } = await supabase
          .from('lender_evidence_chunks')
          .update({ embedding: `[${vectors[j].join(',')}]`, embedded_at: nowIso })
          .eq('id', batch[j].id);
        if (upErr) {
          console.error(`embed-evidence update chunk ${batch[j].id}:`, upErr.message);
          errors++;
        } else {
          embedded++;
        }
      }

      console.log(`embed-evidence: ${embedded}/${chunks.length} done`);

      if (i + BATCH_SIZE < chunks.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const result = { ok: true, embedded, errors };
    console.log('embed-evidence complete:', result);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('embed-evidence fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
