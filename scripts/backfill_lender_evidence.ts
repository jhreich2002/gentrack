// scripts/backfill_lender_evidence.ts
// Phase 4: backfill lender_evidence_documents + lender_evidence_chunks
// from two seed sources:
//   1. news_articles whose title/description match financing keywords
//      (fti_relevance_tags is empty in practice — keywords are the gate).
//   2. ucc_lender_links + ucc_lender_leads_unverified rows that are not
//      quarantined; their evidence_summary + source_url are already curated.
//
// One row = one document = one chunk in this initial pass. UCC/EDGAR full-
// text chunking is a follow-up once we validate the approach. After running,
// invoke the embed-evidence Edge Function to populate vectors.
//
// Usage:
//   npx tsx scripts/backfill_lender_evidence.ts                 # dry-run
//   npx tsx scripts/backfill_lender_evidence.ts --apply         # write
//   npx tsx scripts/backfill_lender_evidence.ts --apply --limit 200
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

function loadEnv(): void {
  for (const f of ['.env', '.env.local']) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k && !process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key);

const APPLY  = process.argv.includes('--apply');
const limArg = process.argv.indexOf('--limit');
const LIMIT  = limArg !== -1 ? Number(process.argv[limArg + 1]) : 5000;

const FINANCING_KEYWORDS = [
  'financing', 'refinanc', 'loan', 'lender', 'lending',
  'credit facility', 'project finance', 'tax equity',
  'debt facility', 'term loan', 'revolver', 'syndicated',
  'construction loan', 'back leverage', 'letter of credit',
];

function newsKeywordOr(): string {
  // PostgREST .or() filter joining title/description ILIKE for each keyword.
  return FINANCING_KEYWORDS
    .flatMap(k => [`title.ilike.%${k}%`, `description.ilike.%${k}%`])
    .join(',');
}

interface Article {
  id:                   string;
  title:                string | null;
  description:          string | null;
  url:                  string | null;
  published_at:         string | null;
  plant_codes:          string[] | null;
  fti_relevance_tags:   string[] | null;
}

async function fetchArticles(): Promise<Article[]> {
  const out: Article[] = [];
  const PAGE = 500;
  const orFilter = newsKeywordOr();
  for (let from = 0; from < LIMIT; from += PAGE) {
    const { data, error } = await sb
      .from('news_articles')
      .select('id, title, description, url, published_at, plant_codes, fti_relevance_tags')
      .or(orFilter)
      .order('published_at', { ascending: false, nullsFirst: false })
      .range(from, Math.min(from + PAGE, LIMIT) - 1);
    if (error) throw new Error(`news_articles fetch: ${error.message}`);
    const rows = (data ?? []) as Article[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

interface UccRow {
  id:               number;
  plant_code:       string;
  lender_name:      string | null;
  evidence_type:    string | null;
  evidence_summary: string | null;
  source_url:       string | null;
  created_at:       string | null;
}

const UCC_EVIDENCE_TO_SOURCE: Record<string, string> = {
  direct_filing:   'ucc_filing',
  county_record:   'ucc_filing',
  edgar:           'edgar_filing',
  sponsor_pattern: 'manual',
  supplement:      'manual',
  inferred:        'manual',
  web_scrape:      'manual',
  llm_inference:   'manual',
  news:            'news_article',
};

async function fetchUccRows(table: 'ucc_lender_links' | 'ucc_lender_leads_unverified'): Promise<UccRow[]> {
  const out: UccRow[] = [];
  const PAGE = 500;
  for (let from = 0; from < LIMIT; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select('id, plant_code, lender_name, evidence_type, evidence_summary, source_url, created_at')
      .is('quarantined_at', null)
      .order('created_at', { ascending: false, nullsFirst: false })
      .range(from, Math.min(from + PAGE, LIMIT) - 1);
    if (error) throw new Error(`${table} fetch: ${error.message}`);
    const rows = (data ?? []) as UccRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}, limit ${LIMIT}`);
  const arts = await fetchArticles();
  console.log(`Financing-keyword news_articles selected: ${arts.length}`);

  const links = await fetchUccRows('ucc_lender_links');
  const leads = await fetchUccRows('ucc_lender_leads_unverified');
  console.log(`ucc_lender_links (non-quarantined): ${links.length}`);
  console.log(`ucc_lender_leads_unverified (non-quarantined): ${leads.length}`);

  // Build candidate documents (one per article, optionally one per plant_code link)
  type Doc = {
    source_type: 'news_article' | 'ucc_filing' | 'edgar_filing' | 'manual' | 'press_release';
    source_id:   string;
    plant_code:  string | null;
    title:       string;
    url:         string | null;
    published_at: string | null;
    content:     string;
  };

  const docs: Doc[] = [];
  for (const a of arts) {
    const title = (a.title ?? '').trim();
    const desc  = (a.description ?? '').trim();
    const content = `${title}. ${desc}`.trim();
    if (content.length < 50) continue;

    if (a.plant_codes && a.plant_codes.length > 0) {
      // Fan out per plant so per-plant retrieval finds the doc directly
      for (const pc of a.plant_codes) {
        docs.push({
          source_type: 'news_article',
          source_id: `${a.id}::${pc}`,
          plant_code: pc,
          title: title || '(untitled)',
          url: a.url,
          published_at: a.published_at,
          content,
        });
      }
    } else {
      docs.push({
        source_type: 'news_article',
        source_id: a.id,
        plant_code: null,
        title: title || '(untitled)',
        url: a.url,
        published_at: a.published_at,
        content,
      });
    }
  }

  const newsDocCount = docs.length;

  // ── UCC link / lead seed rows ─────────────────────────────────────────────
  const pushUccRow = (r: UccRow, table: 'ucc_lender_links' | 'ucc_lender_leads_unverified') => {
    const summary = (r.evidence_summary ?? '').trim();
    const lender  = (r.lender_name ?? '').trim();
    if (!lender && summary.length < 30) return;
    const title = lender ? `${lender} — plant ${r.plant_code}` : `Lender evidence — plant ${r.plant_code}`;
    const content = [lender, summary].filter(Boolean).join('. ');
    if (content.length < 20) return;
    const sourceType = (UCC_EVIDENCE_TO_SOURCE[r.evidence_type ?? ''] ?? 'manual') as Doc['source_type'];
    docs.push({
      source_type: sourceType,
      source_id:   `${table}:${r.id}`,
      plant_code:  r.plant_code,
      title,
      url:         r.source_url,
      published_at: r.created_at,
      content,
    });
  };
  for (const r of links) pushUccRow(r, 'ucc_lender_links');
  for (const r of leads) pushUccRow(r, 'ucc_lender_leads_unverified');

  console.log(`Candidate documents — news (× plant fan-out): ${newsDocCount}`);
  console.log(`Candidate documents — UCC links + leads:      ${docs.length - newsDocCount}`);
  console.log(`Candidate documents — total:                  ${docs.length}`);

  if (!APPLY) {
    console.log('\nSample (first 5):');
    for (const d of docs.slice(0, 5)) {
      console.log(`  [${d.source_type} | ${d.plant_code ?? '∅'}] ${d.title.slice(0, 80)}`);
    }
    console.log('\nDry-run complete. Re-run with --apply to write.');
    return;
  }

  // ── Insert documents (idempotent on (source_type, source_id)) ───────────
  const BATCH = 200;
  let docInserted = 0, chunkInserted = 0;

  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);

    const { data: docRows, error: docErr } = await sb
      .from('lender_evidence_documents')
      .upsert(
        batch.map(d => ({
          source_type:  d.source_type,
          source_id:    d.source_id,
          plant_code:   d.plant_code,
          title:        d.title,
          url:          d.url,
          published_at: d.published_at,
          pipeline_version: 'v2',
        })),
        { onConflict: 'source_type,source_id' }
      )
      .select('id, source_type, source_id');

    if (docErr) { console.error(`doc upsert batch ${i}:`, docErr.message); continue; }

    const idMap = new Map<string, number>();
    for (const r of docRows ?? []) {
      idMap.set(`${(r as any).source_type}::${(r as any).source_id}`, Number((r as any).id));
    }
    docInserted += idMap.size;

    // Insert one chunk per doc (idempotent on (document_id, chunk_index=0))
    const chunks: any[] = [];
    for (const d of batch) {
      const docId = idMap.get(`${d.source_type}::${d.source_id}`);
      if (docId === undefined) continue;
      chunks.push({
        document_id: docId,
        chunk_index: 0,
        content: d.content,
        token_count: Math.ceil(d.content.length / 4), // crude estimate
      });
    }

    if (chunks.length > 0) {
      const { error: chunkErr } = await sb
        .from('lender_evidence_chunks')
        .upsert(chunks, { onConflict: 'document_id,chunk_index' });
      if (chunkErr) { console.error(`chunk upsert batch ${i}:`, chunkErr.message); continue; }
      chunkInserted += chunks.length;
    }

    console.log(`  batch ${i}–${i + batch.length - 1}: docs=${idMap.size} chunks=${chunks.length}`);
  }

  console.log(`\nDocuments upserted: ${docInserted}`);
  console.log(`Chunks upserted:    ${chunkInserted}`);
  console.log('\nNext step: invoke embed-evidence to populate embeddings.');
}

main().catch(e => { console.error(e); process.exit(1); });
