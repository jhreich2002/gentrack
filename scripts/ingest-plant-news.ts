/**
 * ingest-plant-news.ts — Unified news ingest for curtailed power plants
 *
 * Fetches articles from Google News RSS, Bing News RSS, and GDELT DOC API,
 * deduplicates against existing DB entries and across sources, then inserts
 * raw articles into news_articles for downstream ranking by plant-news-rank.
 *
 * Usage:
 *   npx tsx scripts/ingest-plant-news.ts --plants 65678,59448,57275   # specific plants
 *   npx tsx scripts/ingest-plant-news.ts --top 10 --min-month 2025-11 # top N curtailed
 *   npx tsx scripts/ingest-plant-news.ts --top 10 --dry-run           # preview only
 *   npx tsx scripts/ingest-plant-news.ts --top 10 --clean             # delete existing first
 *   npx tsx scripts/ingest-plant-news.ts --top 10 --backfill-years 5  # historical depth
 *
 * Environment:
 *   SUPABASE_URL              (or VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import GoogleNewsDecoder from 'google-news-decoder';

// ── Env loader ─────────────────────────────────────────────────────────────────

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

// ── Environment ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Config ─────────────────────────────────────────────────────────────────────

const MAX_ARTICLES_PER_SOURCE = 15;   // per plant per source
const BING_DELAY_MS     = 1200;       // delay between Bing RSS requests
const GOOGLE_DELAY_MS   = 1200;       // delay between Google RSS requests
const GDELT_DELAY_MS    = 1500;       // delay between GDELT API requests
const UPSERT_BATCH_SIZE = 50;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

const gnewsDecoder = new GoogleNewsDecoder();

/** Decode a Google News article URL to the actual publisher URL */
async function decodeGoogleNewsUrl(url: string): Promise<string> {
  try {
    const result = await gnewsDecoder.decodeGoogleNewsUrl(url);
    if (result.status && result.decodedUrl) return result.decodedUrl;
    return url;
  } catch {
    return url;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/** Normalize URL for dedup: strip tracking params, lowercase host */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hostname = u.hostname.toLowerCase();
    // Strip common tracking params
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'msclkid']) {
      u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return raw.trim();
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface PlantInfo {
  eia_plant_code: string;
  name:           string;
  owner:          string;
  state:          string;
  fuel_source:    string;
}

interface RawArticle {
  title:        string;
  url:          string;
  source_name:  string;
  published_at: string;
  description:  string;
  fetch_source: 'google_rss' | 'bing_rss' | 'gdelt';
}

// ── Plant Selection ────────────────────────────────────────────────────────────

async function loadPlants(
  sb: SupabaseClient,
  opts: { plantCodes?: string[]; top?: number; minMonth?: string }
): Promise<PlantInfo[]> {
  if (opts.plantCodes && opts.plantCodes.length > 0) {
    const { data, error } = await sb
      .from('plants')
      .select('eia_plant_code, name, owner, state, fuel_source')
      .in('eia_plant_code', opts.plantCodes);
    if (error) throw new Error(`Failed to load plants: ${error.message}`);
    return (data ?? []) as PlantInfo[];
  }

  // Top N curtailed plants with data through minMonth
  const minMonth = opts.minMonth ?? '2025-11';
  const top = opts.top ?? 10;

  // Step 1: get plant IDs with generation data >= minMonth
  console.log(`  Finding plants with generation data >= ${minMonth}...`);
  const { data: genData } = await sb
    .from('monthly_generation')
    .select('plant_id')
    .gte('month', minMonth)
    .not('mwh', 'is', null);

  const eligibleIds = new Set((genData ?? []).map((r: { plant_id: string }) => r.plant_id));
  console.log(`  ${eligibleIds.size} plants have data through ${minMonth}`);

  // Step 2: load curtailed plants
  const { data: plantsData, error } = await sb
    .from('plants')
    .select('id, eia_plant_code, name, owner, state, fuel_source, curtailment_score, nameplate_capacity_mw')
    .eq('is_likely_curtailed', true)
    .eq('is_maintenance_offline', false)
    .eq('trailing_zero_months', 0)
    .neq('eia_plant_code', '99999')
    .not('owner', 'is', null)
    .order('curtailment_score', { ascending: false })
    .order('nameplate_capacity_mw', { ascending: false })
    .limit(10000);

  if (error) throw new Error(`Failed to load plants: ${error.message}`);

  // Step 3: intersect
  const filtered = (plantsData ?? [])
    .filter((p: { id: string }) => eligibleIds.has(p.id))
    .slice(0, top);

  console.log(`  Selected ${filtered.length} top curtailed plants`);
  return filtered as PlantInfo[];
}

// ── Bing News RSS ──────────────────────────────────────────────────────────────

async function fetchBingRSS(plant: PlantInfo): Promise<RawArticle[]> {
  // Try multiple query strategies for better coverage
  const queries = [
    `"${plant.name}" ${plant.state} solar OR power`,
    `${plant.name} power plant ${plant.state}`,
    `"${plant.owner}" ${plant.fuel_source} ${plant.state} plant`,
  ];

  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    if (allArticles.length >= MAX_ARTICLES_PER_SOURCE) break;

    const encoded = encodeURIComponent(query);
    const rssUrl = `https://www.bing.com/news/search?q=${encoded}&format=rss`;

    try {
      const res = await fetch(rssUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) {
        console.warn(`  [bing] HTTP ${res.status} for query: ${query.slice(0, 50)}`);
        await sleep(BING_DELAY_MS);
        continue;
      }

      const xml = await res.text();
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;

      while ((match = itemRegex.exec(xml)) !== null && allArticles.length < MAX_ARTICLES_PER_SOURCE) {
        const item = match[1];
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
        const linkMatch = item.match(/<link>(.*?)<\/link>/);
        const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/);
        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
        const sourceMatch = item.match(/<news:Source>(.*?)<\/news:Source>|<source[^>]*>(.*?)<\/source>/i);

        if (titleMatch && linkMatch) {
          let title = decodeHtmlEntities(titleMatch[1] || titleMatch[2] || '');
          const url = normalizeUrl(linkMatch[1].trim());

          if (seenUrls.has(url)) continue;
          seenUrls.add(url);

          let source_name = sourceMatch ? (sourceMatch[1] || sourceMatch[2] || '').trim() : '';
          if (!source_name && title.includes(' - ')) {
            const parts = title.split(' - ');
            source_name = parts.pop() || '';
            title = parts.join(' - ');
          }

          allArticles.push({
            title: title.trim(),
            url,
            source_name: source_name || 'Bing News',
            published_at: pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString(),
            description: decodeHtmlEntities(descMatch?.[1] || descMatch?.[2] || '').trim(),
            fetch_source: 'bing_rss',
          });
        }
      }
    } catch (e) {
      console.warn(`  [bing] Error for query ${query.slice(0, 40)}:`, e);
    }

    await sleep(BING_DELAY_MS);
  }

  return allArticles;
}

// ── Google News RSS ────────────────────────────────────────────────────────────

async function fetchGoogleRSS(plant: PlantInfo, backfillYears: number): Promise<RawArticle[]> {
  // Google News RSS supports "before:" and "after:" date operators  
  const queries: string[] = [];

  // Build query variants: plant name, owner-based
  const nameBase = `"${plant.name}"`;
  const ownerBase = `"${plant.owner}" ${plant.fuel_source} ${plant.state}`;

  if (backfillYears > 1) {
    const now = new Date();
    for (let y = 0; y < backfillYears; y++) {
      const afterDate = new Date(now.getFullYear() - y - 1, now.getMonth(), now.getDate());
      const beforeDate = new Date(now.getFullYear() - y, now.getMonth(), now.getDate());
      const after = afterDate.toISOString().split('T')[0];
      const before = beforeDate.toISOString().split('T')[0];
      queries.push(`${nameBase} power plant after:${after} before:${before}`);
    }
    // Owner fallback queries (one for recent, one for older)
    queries.push(`${ownerBase} after:${new Date(now.getFullYear() - 2, 0, 1).toISOString().split('T')[0]}`);
    queries.push(`${ownerBase} before:${new Date(now.getFullYear() - 2, 0, 1).toISOString().split('T')[0]}`);
  } else {
    queries.push(`${nameBase} power plant`);
    queries.push(ownerBase); // owner fallback
  }

  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    if (allArticles.length >= MAX_ARTICLES_PER_SOURCE * 2) break; // allow more from yearly splits

    const encoded = encodeURIComponent(query);
    const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

    try {
      const res = await fetch(rssUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) {
        console.warn(`  [google] HTTP ${res.status} for query: ${query.slice(0, 60)}...`);
        await sleep(GOOGLE_DELAY_MS);
        continue;
      }

      const xml = await res.text();
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;

      while ((match = itemRegex.exec(xml)) !== null) {
        const item = match[1];
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
        const linkMatch = item.match(/<link>(.*?)<\/link>/);
        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
        const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/i);

        if (titleMatch && linkMatch) {
          let rawUrl = linkMatch[1].trim();
          // Google News URLs are redirects — decode to actual article URL
          if (rawUrl.includes('news.google.com')) {
            rawUrl = await decodeGoogleNewsUrl(rawUrl);
            await sleep(150); // rate-limit Google News decode requests
          }
          const url = normalizeUrl(rawUrl);

          if (seenUrls.has(url)) continue;
          seenUrls.add(url);

          let title = decodeHtmlEntities(titleMatch[1] || titleMatch[2] || '');
          let source_name = sourceMatch ? decodeHtmlEntities(sourceMatch[1] || '') : '';
          if (!source_name && title.includes(' - ')) {
            const parts = title.split(' - ');
            source_name = parts.pop() || '';
            title = parts.join(' - ');
          }

          allArticles.push({
            title: title.trim(),
            url,
            source_name: source_name || 'Google News',
            published_at: pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString(),
            description: '', // Google RSS doesn't include descriptions
            fetch_source: 'google_rss',
          });
        }
      }
    } catch (e) {
      console.warn(`  [google] Error for query ${query.slice(0, 40)}:`, e);
    }

    await sleep(GOOGLE_DELAY_MS);
  }

  return allArticles;
}

// ── GDELT DOC API ──────────────────────────────────────────────────────────────

interface GDELTArticle {
  url:          string;
  title:        string;
  seendate:     string;   // YYYYMMDDTHHMMSSZ
  domain:       string;
  language:     string;
  sourcecountry: string;
}

async function fetchGDELT(plant: PlantInfo, backfillYears: number): Promise<RawArticle[]> {
  // GDELT DOC API: timespan in months, max 250 articles per query
  const timespanMonths = Math.min(backfillYears * 12, 60); // max 5 years
  const query = encodeURIComponent(`"${plant.name}" power plant`);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=artlist&maxrecords=75&format=json&timespan=${timespanMonths}months&sourcelang=english`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`  [gdelt] HTTP ${res.status} for ${plant.name}`);
      return [];
    }

    const text = await res.text();
    if (!text.trim() || text.trim() === '{}') {
      return [];
    }

    let data: { articles?: GDELTArticle[] };
    try {
      data = JSON.parse(text);
    } catch {
      console.warn(`  [gdelt] Invalid JSON for ${plant.name}`);
      return [];
    }

    if (!data.articles || !Array.isArray(data.articles)) {
      return [];
    }

    return data.articles
      .filter(a => a.language === 'English' || !a.language)
      .slice(0, MAX_ARTICLES_PER_SOURCE * 2)
      .map(a => {
        // GDELT seendate format: 20240301T120000Z → ISO
        let published_at: string;
        try {
          const y = a.seendate.slice(0, 4);
          const m = a.seendate.slice(4, 6);
          const d = a.seendate.slice(6, 8);
          const h = a.seendate.slice(9, 11) || '00';
          const mi = a.seendate.slice(11, 13) || '00';
          published_at = new Date(`${y}-${m}-${d}T${h}:${mi}:00Z`).toISOString();
        } catch {
          published_at = new Date().toISOString();
        }

        return {
          title: a.title?.trim() || '',
          url: normalizeUrl(a.url),
          source_name: a.domain?.replace('www.', '') || 'GDELT',
          published_at,
          description: '', // GDELT artlist mode doesn't include descriptions
          fetch_source: 'gdelt' as const,
        };
      });
  } catch (e) {
    console.warn(`  [gdelt] Error for ${plant.name}:`, e);
    return [];
  }
}

// ── Deduplication ──────────────────────────────────────────────────────────────

async function loadExistingHashes(sb: SupabaseClient, plantCodes: string[]): Promise<Set<string>> {
  const hashes = new Set<string>();

  // Load all existing external_ids for these plants
  for (const code of plantCodes) {
    const { data } = await sb
      .from('news_articles')
      .select('external_id')
      .contains('plant_codes', [code]);

    for (const row of (data ?? [])) {
      hashes.add(row.external_id);
    }
  }

  return hashes;
}

function deduplicateArticles(articles: RawArticle[]): RawArticle[] {
  const seen = new Map<string, RawArticle>();

  for (const a of articles) {
    if (!a.title || !a.url) continue;
    const hash = sha256(a.url);
    if (!seen.has(hash)) {
      seen.set(hash, a);
    }
  }

  return [...seen.values()];
}

// ── DB Operations ──────────────────────────────────────────────────────────────

async function cleanExistingArticles(sb: SupabaseClient, plantCodes: string[]): Promise<number> {
  let deleted = 0;

  for (const code of plantCodes) {
    // Delete articles linked to this plant
    const { data, error } = await sb
      .from('news_articles')
      .delete()
      .contains('plant_codes', [code])
      .select('id');

    if (error) {
      console.error(`  Error deleting articles for ${code}: ${error.message}`);
    } else {
      deleted += (data ?? []).length;
    }

    // Clear plant_news_state
    await sb.from('plant_news_state').delete().eq('eia_plant_code', code);
    // Clear plant_news_ratings
    await sb.from('plant_news_ratings').delete().eq('eia_plant_code', code);
  }

  return deleted;
}

async function upsertArticles(
  sb: SupabaseClient,
  articles: RawArticle[],
  plant: PlantInfo,
  existingHashes: Set<string>,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  const rows = articles
    .map(a => {
      const externalId = sha256(a.url);
      if (existingHashes.has(externalId)) {
        skipped++;
        return null;
      }
      existingHashes.add(externalId);

      return {
        external_id:   externalId,
        title:         a.title.slice(0, 500),
        description:   a.description?.slice(0, 2000) || null,
        content:       null, // full text extraction is deferred
        source_name:   a.source_name.slice(0, 200),
        url:           a.url,
        published_at:  a.published_at,
        query_tag:     `ingest:${plant.eia_plant_code}`,
        plant_codes:   [plant.eia_plant_code],
        owner_names:   plant.owner ? [plant.owner] : [],
        states:        plant.state ? [plant.state] : [],
        fuel_types:    plant.fuel_source ? [plant.fuel_source] : [],
        topics:        [],
        sentiment_label: null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Upsert in batches
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await sb
      .from('news_articles')
      .upsert(batch, { onConflict: 'external_id', ignoreDuplicates: true });

    if (error) {
      console.error(`  Upsert error at batch ${i}: ${error.message}`);
    } else {
      inserted += batch.length;
    }
  }

  return { inserted, skipped };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  const hasFlag = (name: string) => args.includes(`--${name}`);

  const plantCodesArg = getArg('plants');
  const topN = parseInt(getArg('top') ?? '0') || 0;
  const minMonth = getArg('min-month') ?? '2025-11';
  const backfillYears = parseInt(getArg('backfill-years') ?? '1') || 1;
  const dryRun = hasFlag('dry-run');
  const clean = hasFlag('clean');

  if (!plantCodesArg && !topN) {
    console.error('Usage: npx tsx scripts/ingest-plant-news.ts --plants CODE1,CODE2 | --top N');
    console.error('Options: --min-month 2025-11  --backfill-years 5  --clean  --dry-run');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GenTrack — Plant News Ingest');
  console.log('  Sources: Google News RSS + Bing News RSS + GDELT DOC API');
  console.log(`  Backfill: ${backfillYears} year(s)`);
  console.log(`  Mode: ${dryRun ? 'DRY RUN' : clean ? 'CLEAN + INGEST' : 'INCREMENTAL'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── Load plants ────────────────────────────────────────────────────────────
  const plantCodes = plantCodesArg ? plantCodesArg.split(',').map(s => s.trim()) : undefined;
  const plants = await loadPlants(supabase, { plantCodes, top: topN, minMonth });

  if (plants.length === 0) {
    console.log('No plants found matching criteria.');
    return;
  }

  console.log(`\nTarget plants (${plants.length}):`);
  for (const p of plants) {
    console.log(`  ${p.eia_plant_code}  ${p.name.padEnd(40)}  ${p.state}  ${p.fuel_source}`);
  }
  console.log();

  // ── Clean if requested ─────────────────────────────────────────────────────
  if (clean && !dryRun) {
    console.log('Cleaning existing articles for target plants...');
    const deleted = await cleanExistingArticles(supabase, plants.map(p => p.eia_plant_code));
    console.log(`  Deleted ${deleted} existing articles\n`);
  }

  // ── Load existing hashes for dedup ─────────────────────────────────────────
  const existingHashes = await loadExistingHashes(supabase, plants.map(p => p.eia_plant_code));
  console.log(`Loaded ${existingHashes.size} existing article hashes for dedup\n`);

  // ── Fetch & insert per plant ───────────────────────────────────────────────
  const summary: { plant: string; code: string; google: number; bing: number; gdelt: number; unique: number; inserted: number; skipped: number }[] = [];

  for (let i = 0; i < plants.length; i++) {
    const plant = plants[i];
    console.log(`[${i + 1}/${plants.length}] ${plant.name} (${plant.eia_plant_code}) — ${plant.state}, ${plant.fuel_source}`);

    // Fetch from all 3 sources
    console.log('  Fetching Google News RSS...');
    const googleArticles = await fetchGoogleRSS(plant, backfillYears);
    console.log(`  → ${googleArticles.length} articles from Google`);

    await sleep(500); // brief pause between sources

    console.log('  Fetching Bing News RSS...');
    const bingArticles = await fetchBingRSS(plant);
    console.log(`  → ${bingArticles.length} articles from Bing`);

    await sleep(500);

    console.log('  Fetching GDELT DOC API...');
    const gdeltArticles = await fetchGDELT(plant, backfillYears);
    console.log(`  → ${gdeltArticles.length} articles from GDELT`);

    // Merge and deduplicate across sources
    const allRaw = [...googleArticles, ...bingArticles, ...gdeltArticles];
    const unique = deduplicateArticles(allRaw);
    console.log(`  → ${unique.length} unique articles after cross-source dedup`);

    if (dryRun) {
      // Show first few articles
      for (const a of unique.slice(0, 5)) {
        console.log(`    [${a.fetch_source}] ${a.title.slice(0, 70)}`);
        console.log(`      ${a.url.slice(0, 80)}`);
      }
      if (unique.length > 5) console.log(`    ... and ${unique.length - 5} more`);
      summary.push({
        plant: plant.name, code: plant.eia_plant_code,
        google: googleArticles.length, bing: bingArticles.length, gdelt: gdeltArticles.length,
        unique: unique.length, inserted: 0, skipped: 0,
      });
    } else {
      // Upsert to DB
      const { inserted, skipped } = await upsertArticles(supabase, unique, plant, existingHashes);
      console.log(`  → Inserted: ${inserted}, Skipped (dupes): ${skipped}`);
      summary.push({
        plant: plant.name, code: plant.eia_plant_code,
        google: googleArticles.length, bing: bingArticles.length, gdelt: gdeltArticles.length,
        unique: unique.length, inserted, skipped,
      });
    }

    console.log();

    // Rate limit between plants
    if (i < plants.length - 1) {
      await sleep(Math.max(BING_DELAY_MS, GOOGLE_DELAY_MS));
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  INGEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  ${'Plant'.padEnd(35)} Code     Goo  Bing  GDELT  Uniq  Ins   Skip`);
  console.log('─'.repeat(85));

  let totals = { google: 0, bing: 0, gdelt: 0, unique: 0, inserted: 0, skipped: 0 };
  for (const s of summary) {
    console.log(
      `  ${s.plant.slice(0, 34).padEnd(35)} ${s.code.padEnd(8)} ` +
      `${String(s.google).padStart(4)} ${String(s.bing).padStart(5)} ${String(s.gdelt).padStart(6)} ` +
      `${String(s.unique).padStart(5)} ${String(s.inserted).padStart(4)} ${String(s.skipped).padStart(6)}`
    );
    totals.google += s.google;
    totals.bing += s.bing;
    totals.gdelt += s.gdelt;
    totals.unique += s.unique;
    totals.inserted += s.inserted;
    totals.skipped += s.skipped;
  }

  console.log('─'.repeat(85));
  console.log(
    `  ${'TOTAL'.padEnd(35)} ${''.padEnd(8)} ` +
    `${String(totals.google).padStart(4)} ${String(totals.bing).padStart(5)} ${String(totals.gdelt).padStart(6)} ` +
    `${String(totals.unique).padStart(5)} ${String(totals.inserted).padStart(4)} ${String(totals.skipped).padStart(6)}`
  );
  console.log();

  if (dryRun) {
    console.log('  DRY RUN — no articles were written to the database.');
  } else {
    console.log(`  Done! ${totals.inserted} articles inserted. Ready for plant-news-rank.`);
    console.log();
    console.log('  Next step: rank articles with:');
    console.log('    npx tsx scripts/rank-plant-news.ts --plants ' + plants.map(p => p.eia_plant_code).join(','));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
