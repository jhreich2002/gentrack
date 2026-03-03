/**
 * GenTrack — bulk-embed-articles
 *
 * Embeds all unembedded news_articles rows using Gemini text-embedding-001.
 * Processes in batches of 100 (Gemini batchEmbedContents limit), fetches
 * articles in pages of 1000 to avoid memory issues.
 *
 * Gemini text-embedding-001 is FREE within quota (1,500 RPM).
 * ~23,000 articles → ~230 batches → ~5–10 minutes.
 *
 * Usage:
 *   Set env vars in .env, then:
 *   npx tsx scripts/bulk-embed-articles.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// ── Config ───────────────────────────────────────────────────────────────────
const EMBED_BATCH_SIZE = 100;   // Gemini batchEmbedContents max
const FETCH_PAGE_SIZE  = 1000;  // rows fetched per DB query
const MIN_TEXT_LEN     = 20;    // skip near-empty articles
const INTER_BATCH_MS   = 300;   // ~200 RPM — well within 1500 RPM free quota

const GEMINI_EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';

// ── Env loader ───────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}

loadEnv();

const SUPABASE_URL      = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_ROLE_KEY  = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY in .env');
  process.exit(1);
}

// ── Types ────────────────────────────────────────────────────────────────────
interface ArticleRow { id: string; title: string; description: string | null }

// ── Gemini embed ─────────────────────────────────────────────────────────────
async function batchEmbed(texts: string[]): Promise<number[][] | null> {
  const requests = texts.map(text => ({
    model:   'models/gemini-embedding-001',
    content: { parts: [{ text }] },
    outputDimensionality: 768,
  }));

  const res = await fetch(`${GEMINI_EMBED_URL}?key=${GEMINI_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ requests }),
  });

  if (res.status === 429) {
    console.warn('  [rate-limit] 429 — waiting 60s...');
    await sleep(60000);
    return batchEmbed(texts); // retry
  }

  if (!res.ok) {
    console.error(`  [HTTP ${res.status}] Gemini embed error: ${await res.text()}`);
    return null;
  }

  const data = await res.json();
  return (data.embeddings as Array<{ values: number[] }>).map(e => e.values);
}

// ── DB: fetch one page of unembedded articles ─────────────────────────────────
async function fetchPage(sb: SupabaseClient, offset: number): Promise<ArticleRow[]> {
  const { data, error } = await sb
    .from('news_articles')
    .select('id, title, description')
    .is('embedded_at', null)
    .order('created_at', { ascending: true })
    .range(offset, offset + FETCH_PAGE_SIZE - 1);

  if (error) throw new Error(`DB fetch error: ${error.message}`);
  return (data ?? []) as ArticleRow[];
}

// ── DB: update embeddings in one batch ───────────────────────────────────────
async function updateBatch(
  sb: SupabaseClient,
  batch: ArticleRow[],
  vectors: number[][],
): Promise<number> {
  let saved = 0;
  for (let j = 0; j < batch.length; j++) {
    const { error } = await sb
      .from('news_articles')
      .update({
        embedding:   `[${vectors[j].join(',')}]`,
        embedded_at: new Date().toISOString(),
      })
      .eq('id', batch[j].id);

    if (error) {
      console.error(`  [db-err] ${batch[j].id}: ${error.message}`);
    } else {
      saved++;
    }
  }
  return saved;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ── Count total unembedded ────────────────────────────────────────────────
  const { count, error: cntErr } = await sb
    .from('news_articles')
    .select('*', { count: 'exact', head: true })
    .is('embedded_at', null);

  if (cntErr) throw new Error(`Count error: ${cntErr.message}`);
  const total = count ?? 0;

  console.log(`\n===== GenTrack Bulk Embed =====`);
  console.log(`Unembedded articles:   ${total}`);
  console.log(`Embed batch size:      ${EMBED_BATCH_SIZE}`);
  console.log(`Estimated API calls:   ~${Math.ceil(total / EMBED_BATCH_SIZE)}`);
  console.log(`Estimated time:        ~${Math.ceil(total * INTER_BATCH_MS / EMBED_BATCH_SIZE / 60000)} minutes\n`);

  if (total === 0) {
    console.log('All articles already embedded. Nothing to do.');
    return;
  }

  let totalEmbedded = 0;
  let totalErrors   = 0;
  let pageOffset    = 0;

  while (true) {
    // Fetch next page of unembedded articles
    const page = await fetchPage(sb, pageOffset);
    if (page.length === 0) break;

    // Filter out trivially short articles
    const eligible = page.filter(a => {
      const text = `${a.title ?? ''} ${a.description ?? ''}`.trim();
      return text.length >= MIN_TEXT_LEN;
    });

    // Process in EMBED_BATCH_SIZE chunks
    for (let i = 0; i < eligible.length; i += EMBED_BATCH_SIZE) {
      const batch  = eligible.slice(i, i + EMBED_BATCH_SIZE);
      const texts  = batch.map(a => `${a.title}. ${a.description ?? ''}`.trim());

      const vectors = await batchEmbed(texts);

      if (!vectors) {
        console.warn(`  [skip-batch] embed failed, skipping ${batch.length} articles`);
        totalErrors += batch.length;
      } else {
        const saved = await updateBatch(sb, batch, vectors);
        totalEmbedded += saved;
        totalErrors   += (batch.length - saved);
      }

      const pct = ((totalEmbedded / total) * 100).toFixed(1);
      console.log(`[${pct}%] ${totalEmbedded}/${total} embedded — ${totalErrors} errors`);

      if (i + EMBED_BATCH_SIZE < eligible.length) await sleep(INTER_BATCH_MS);
    }

    // Because we're querying embedded_at IS NULL and page by offset,
    // once articles on this page get embedded, the next page still starts at 0.
    // We keep fetching from offset 0 until the page comes back empty.
    // (Offset only needed for initial catch-up; after the loop empties the table it stops.)
    if (page.length < FETCH_PAGE_SIZE) break; // last page
  }

  console.log(`\n✔ Done! ${totalEmbedded} articles embedded — ${totalErrors} errors`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
