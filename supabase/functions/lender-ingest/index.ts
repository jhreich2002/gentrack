/**
 * GenTrack — lender-ingest Edge Function (Deno)
 *
 * Fetches financing/lender/tax-equity articles from Google News RSS
 * and Bing News RSS for the top curtailed power plants, deduplicates
 * against existing DB entries, and inserts into news_articles with
 * pipeline = 'financing' for downstream ranking.
 *
 * POST body:
 *   { plantCount?: number, offset?: number, limit?: number }
 *
 * Pipeline position:
 *   lender-ingest → lender-news-rank → embed-articles → compute-ratings
 *
 * Self-batching: processes `limit` plants per call (default 15).
 * If more plants remain, fires off a follow-up call to itself.
 * At the end of the final batch, if new articles were inserted,
 * chains to lender-news-rank (batch mode).
 *
 * Incremental: reads plant_news_state.lender_last_checked_at per plant.
 * Uses Google `after:YYYY-MM-DD` and Bing `freshness` to limit
 * results to articles since the last check. First-ever run defaults
 * to 5 years lookback (1825 days).
 *
 * Required secrets:
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_PLANT_COUNT = 30;
const DEFAULT_BATCH_LIMIT = 15;       // plants per edge function call
const MAX_ARTICLES_PER_SOURCE = 15;
const UPSERT_BATCH_SIZE = 50;
const DELAY_BETWEEN_PLANTS_MS = 800;
const DELAY_BETWEEN_QUERIES_MS = 1000;
const GOOGLE_DECODE_DELAY_MS = 150;
const DEFAULT_LOOKBACK_DAYS = 1825;   // 5 years for first run
const MIN_ARTICLES_FOR_OWNER_FALLBACK = 3;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Supabase client ────────────────────────────────────────────────────────────

function makeSupabase() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function sha256(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
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

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hostname = u.hostname.toLowerCase();
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'msclkid']) {
      u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return raw.trim();
  }
}

// ── Google News URL Decoder (inline — avoids CJS interop issues) ──────────────

async function decodeGoogleNewsUrl(url: string): Promise<string> {
  if (!url.includes('news.google.com')) return url;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!res.ok) return url;

    const html = await res.text();

    const auMatch = html.match(/data-n-au="([^"]+)"/);
    if (auMatch?.[1]) return decodeHtmlEntities(auMatch[1]);

    const wizMatch = html.match(/data-url="([^"]+)"/);
    if (wizMatch?.[1]) return decodeHtmlEntities(wizMatch[1]);

    const articleIdMatch = url.match(/\/articles\/([^?]+)/);
    if (!articleIdMatch) return url;

    const articleId = articleIdMatch[1];
    const sigMatch = html.match(/data-n-a-sg="([^"]+)"/);
    const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);

    if (sigMatch?.[1] && tsMatch?.[1]) {
      const sig = sigMatch[1];
      const ts = tsMatch[1];

      const batchUrl = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';
      const payload = `f.req=[[["Fbv4je","[\\"garturlreq\\",[[\\"en-US\\",\\"US\\",[\\"FINANCE_TOP_INDICES\\",\\"WEB_TEST_1_0_0\\"],null,null,1,1,\\"US:en\\",null,180,null,null,null,null,null,0,null,null,[1608992183,723341000]],\\"en-US\\",\\"US\\",1,[2,3,4,8],1,0,\\"655000234\\",0,0,null,0],\\"${articleId}\\",${ts},\\"${sig}\\"]",null,"generic"]]]`;

      const batchRes = await fetch(batchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          'User-Agent': USER_AGENT,
        },
        body: payload,
      });

      if (batchRes.ok) {
        const batchText = await batchRes.text();
        const urlMatch = batchText.match(/https?:\/\/[^\s"\\]+/);
        if (urlMatch?.[0] && !urlMatch[0].includes('news.google.com')) {
          return urlMatch[0];
        }
      }
    }

    return url;
  } catch {
    return url;
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
  fetch_source: 'google_rss' | 'bing_rss';
}

// ── Plant Discovery ────────────────────────────────────────────────────────────

async function loadTopCurtailedPlants(
  sb: ReturnType<typeof createClient>,
  plantCount: number,
  offset: number,
  limit: number,
): Promise<{ plants: PlantInfo[]; totalEligible: number }> {
  const { data: maxRow } = await sb
    .from('monthly_generation')
    .select('month')
    .not('mwh', 'is', null)
    .order('month', { ascending: false })
    .limit(1);

  const latestMonth = maxRow?.[0]?.month ?? '2025-11';
  console.log(`Latest generation month: ${latestMonth}`);

  const { data: genData } = await sb
    .from('monthly_generation')
    .select('plant_id')
    .eq('month', latestMonth)
    .not('mwh', 'is', null);

  const eligibleIds = new Set((genData ?? []).map((r: { plant_id: string }) => r.plant_id));

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

  const all = (plantsData ?? []).filter((p: { id: string }) => eligibleIds.has(p.id));
  const totalEligible = Math.min(all.length, plantCount);
  const batch = all.slice(offset, Math.min(offset + limit, plantCount));

  console.log(`Eligible curtailed: ${all.length}, plantCount cap: ${plantCount}, batch offset=${offset} limit=${limit} → ${batch.length} plants this call`);

  return { plants: batch as PlantInfo[], totalEligible };
}

// ── Last-Checked Timestamps (financing-specific) ──────────────────────────────

async function loadLenderLastCheckedMap(
  sb: ReturnType<typeof createClient>,
  plantCodes: string[],
): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (plantCodes.length === 0) return map;

  const { data } = await sb
    .from('plant_news_state')
    .select('eia_plant_code, lender_last_checked_at')
    .in('eia_plant_code', plantCodes)
    .not('lender_last_checked_at', 'is', null);

  for (const row of (data ?? [])) {
    map.set(row.eia_plant_code, new Date(row.lender_last_checked_at));
  }
  return map;
}

async function updateLenderLastChecked(
  sb: ReturnType<typeof createClient>,
  plantCode: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sb
    .from('plant_news_state')
    .upsert({
      eia_plant_code: plantCode,
      lender_last_checked_at: now,
      updated_at: now,
    }, { onConflict: 'eia_plant_code' });
}

// ── Google News RSS (financing-focused queries) ────────────────────────────────

async function fetchGoogleRSS(
  plant: PlantInfo,
  afterDate: string | null,
): Promise<RawArticle[]> {
  const financingTerms = 'financing OR lender OR "tax equity" OR refinancing OR "credit facility"';
  const plantQuery = `"${plant.name}" ${financingTerms}`;

  const queries: string[] = [];
  if (afterDate) {
    queries.push(`${plantQuery} after:${afterDate}`);
  } else {
    queries.push(plantQuery);
  }

  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    if (allArticles.length >= MAX_ARTICLES_PER_SOURCE) break;

    const encoded = encodeURIComponent(query);
    const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

    try {
      const res = await fetch(rssUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) {
        console.warn(`[google] HTTP ${res.status} for: ${query.slice(0, 60)}`);
        await sleep(DELAY_BETWEEN_QUERIES_MS);
        continue;
      }

      const xml = await res.text();
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;

      while ((match = itemRegex.exec(xml)) !== null && allArticles.length < MAX_ARTICLES_PER_SOURCE) {
        const item = match[1];
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
        const linkMatch = item.match(/<link>(.*?)<\/link>/);
        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
        const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/i);

        if (titleMatch && linkMatch) {
          let rawUrl = linkMatch[1].trim();
          if (rawUrl.includes('news.google.com')) {
            rawUrl = await decodeGoogleNewsUrl(rawUrl);
            await sleep(GOOGLE_DECODE_DELAY_MS);
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
            description: '',
            fetch_source: 'google_rss',
          });
        }
      }
    } catch (e) {
      console.warn(`[google] Error for: ${query.slice(0, 40)}`, e);
    }

    await sleep(DELAY_BETWEEN_QUERIES_MS);
  }

  return allArticles;
}

// ── Google News RSS (owner-name fallback) ──────────────────────────────────────

async function fetchGoogleRSSOwnerFallback(
  plant: PlantInfo,
  afterDate: string | null,
): Promise<RawArticle[]> {
  const ownerQuery = afterDate
    ? `"${plant.owner}" power plant financing after:${afterDate}`
    : `"${plant.owner}" power plant financing`;

  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();

  const encoded = encodeURIComponent(ownerQuery);
  const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const res = await fetch(rssUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return allArticles;

    const xml = await res.text();
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null && allArticles.length < MAX_ARTICLES_PER_SOURCE) {
      const item = match[1];
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/i);

      if (titleMatch && linkMatch) {
        let rawUrl = linkMatch[1].trim();
        if (rawUrl.includes('news.google.com')) {
          rawUrl = await decodeGoogleNewsUrl(rawUrl);
          await sleep(GOOGLE_DECODE_DELAY_MS);
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
          description: '',
          fetch_source: 'google_rss',
        });
      }
    }
  } catch (e) {
    console.warn(`[google-owner] Error for: ${plant.owner.slice(0, 40)}`, e);
  }

  return allArticles;
}

// ── Bing News RSS (financing-focused queries) ──────────────────────────────────

async function fetchBingRSS(
  plant: PlantInfo,
  lastCheckedAt: Date | null,
): Promise<RawArticle[]> {
  let freshness = '';
  if (lastCheckedAt) {
    const hoursSinceCheck = (Date.now() - lastCheckedAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceCheck <= 26) freshness = '&freshness=Day';
    else if (hoursSinceCheck <= 170) freshness = '&freshness=Week';
    else freshness = '&freshness=Month';
  }

  const queries = [
    `"${plant.name}" financing OR lender OR "tax equity"`,
    `"${plant.name}" refinancing OR "credit facility" OR loan`,
    `"${plant.name}" sponsor OR "project finance" OR PPA`,
  ];

  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    if (allArticles.length >= MAX_ARTICLES_PER_SOURCE) break;

    const encoded = encodeURIComponent(query);
    const rssUrl = `https://www.bing.com/news/search?q=${encoded}&format=rss${freshness}`;

    try {
      const res = await fetch(rssUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) {
        console.warn(`[bing] HTTP ${res.status} for: ${query.slice(0, 50)}`);
        await sleep(DELAY_BETWEEN_QUERIES_MS);
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
      console.warn(`[bing] Error for: ${query.slice(0, 40)}`, e);
    }

    await sleep(DELAY_BETWEEN_QUERIES_MS);
  }

  return allArticles;
}

// ── Deduplication ──────────────────────────────────────────────────────────────

async function loadExistingHashes(
  sb: ReturnType<typeof createClient>,
  plantCodes: string[],
): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const code of plantCodes) {
    const { data } = await sb
      .from('news_articles')
      .select('external_id')
      .contains('plant_codes', [code])
      .eq('pipeline', 'financing');

    for (const row of (data ?? [])) {
      hashes.add(row.external_id);
    }
  }
  return hashes;
}

async function deduplicateArticles(articles: RawArticle[]): Promise<RawArticle[]> {
  const seen = new Map<string, RawArticle>();
  for (const a of articles) {
    if (!a.title || !a.url) continue;
    const hash = await sha256(a.url);
    if (!seen.has(hash)) {
      seen.set(hash, a);
    }
  }
  return [...seen.values()];
}

// ── Upsert ─────────────────────────────────────────────────────────────────────

async function upsertArticles(
  sb: ReturnType<typeof createClient>,
  articles: RawArticle[],
  plant: PlantInfo,
  existingHashes: Set<string>,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  const rows: Record<string, unknown>[] = [];
  for (const a of articles) {
    const externalId = await sha256(a.url);
    if (existingHashes.has(externalId)) {
      skipped++;
      continue;
    }
    existingHashes.add(externalId);

    rows.push({
      external_id:    externalId,
      title:          a.title.slice(0, 500),
      description:    a.description?.slice(0, 2000) || null,
      content:        null,
      source_name:    a.source_name.slice(0, 200),
      url:            a.url,
      published_at:   a.published_at,
      query_tag:      `financing:${plant.eia_plant_code}`,
      plant_codes:    [plant.eia_plant_code],
      owner_names:    plant.owner ? [plant.owner] : [],
      states:         plant.state ? [plant.state] : [],
      fuel_types:     plant.fuel_source ? [plant.fuel_source] : [],
      topics:         [],
      sentiment_label: null,
      pipeline:       'financing',
    });
  }

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await sb
      .from('news_articles')
      .upsert(batch, { onConflict: 'external_id', ignoreDuplicates: true });

    if (error) {
      console.error(`Upsert error at batch ${i}: ${error.message}`);
    } else {
      inserted += batch.length;
    }
  }

  return { inserted, skipped };
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

  let body: { plantCount?: number; offset?: number; limit?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const plantCount = body.plantCount ?? DEFAULT_PLANT_COUNT;
  const offset = body.offset ?? 0;
  const limit = body.limit ?? DEFAULT_BATCH_LIMIT;

  const sb = makeSupabase();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  try {
    const { plants, totalEligible } = await loadTopCurtailedPlants(sb, plantCount, offset, limit);

    if (plants.length === 0) {
      console.log('No plants in this batch — done.');
      return new Response(JSON.stringify({ ok: true, message: 'No plants to process', inserted: 0 }), { headers: CORS });
    }

    const plantCodes = plants.map(p => p.eia_plant_code);

    const lastCheckedMap = await loadLenderLastCheckedMap(sb, plantCodes);
    const existingHashes = await loadExistingHashes(sb, plantCodes);

    console.log(`Loaded ${existingHashes.size} existing hashes, ${lastCheckedMap.size} lender-last-checked timestamps`);

    let totalInserted = 0;
    let totalSkipped = 0;
    const results: { plant: string; code: string; google: number; bing: number; ownerFallback: number; inserted: number; skipped: number }[] = [];

    for (let i = 0; i < plants.length; i++) {
      const plant = plants[i];
      const lastCheckedAt = lastCheckedMap.get(plant.eia_plant_code) ?? null;

      let googleAfterDate: string | null = null;
      if (lastCheckedAt) {
        googleAfterDate = lastCheckedAt.toISOString().split('T')[0];
      } else {
        const lookback = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400_000);
        googleAfterDate = lookback.toISOString().split('T')[0];
      }

      console.log(`[${offset + i + 1}/${totalEligible}] ${plant.name} (${plant.eia_plant_code}) — last lender check: ${lastCheckedAt?.toISOString() ?? 'never'}, after: ${googleAfterDate}`);

      // Fetch from both sources in parallel
      const [googleArticles, bingArticles] = await Promise.all([
        fetchGoogleRSS(plant, googleAfterDate),
        fetchBingRSS(plant, lastCheckedAt),
      ]);

      // Owner-name fallback if plant-name query returned sparse results
      let ownerFallbackArticles: RawArticle[] = [];
      if (googleArticles.length < MIN_ARTICLES_FOR_OWNER_FALLBACK) {
        console.log(`  Plant query sparse (${googleArticles.length}) — trying owner fallback: "${plant.owner}"`);
        ownerFallbackArticles = await fetchGoogleRSSOwnerFallback(plant, googleAfterDate);
      }

      console.log(`  Google: ${googleArticles.length}, Bing: ${bingArticles.length}, Owner fallback: ${ownerFallbackArticles.length}`);

      const allRaw = [...googleArticles, ...bingArticles, ...ownerFallbackArticles];
      const unique = await deduplicateArticles(allRaw);
      console.log(`  Unique after dedup: ${unique.length}`);

      const { inserted, skipped } = await upsertArticles(sb, unique, plant, existingHashes);
      console.log(`  Inserted: ${inserted}, Skipped: ${skipped}`);

      totalInserted += inserted;
      totalSkipped += skipped;
      results.push({
        plant: plant.name,
        code: plant.eia_plant_code,
        google: googleArticles.length,
        bing: bingArticles.length,
        ownerFallback: ownerFallbackArticles.length,
        inserted,
        skipped,
      });

      await updateLenderLastChecked(sb, plant.eia_plant_code);

      if (i < plants.length - 1) {
        await sleep(DELAY_BETWEEN_PLANTS_MS);
      }
    }

    console.log(`Batch complete: ${totalInserted} inserted, ${totalSkipped} skipped across ${plants.length} plants`);

    // ── Self-batch: more plants remaining? ────────────────────────────────
    const nextOffset = offset + limit;
    const isLastBatch = nextOffset >= totalEligible;

    if (!isLastBatch) {
      console.log(`Self-batching: next call with offset=${nextOffset}`);
      fireAndForget(`${supabaseUrl}/functions/v1/lender-ingest`, {
        plantCount,
        offset: nextOffset,
        limit,
      });
    }

    // ── Chain to lender-news-rank if last batch AND new articles ──────────
    if (isLastBatch && totalInserted > 0) {
      console.log(`Last batch with ${totalInserted} new articles — chaining to lender-news-rank`);
      fireAndForget(`${supabaseUrl}/functions/v1/lender-news-rank`, {
        batch: true,
        limit: 30,
      });
    } else if (isLastBatch) {
      console.log('Last batch — no new financing articles found, skipping downstream chain');
    }

    return new Response(JSON.stringify({
      ok: true,
      batch: { offset, limit, plantCount, isLastBatch },
      totalInserted,
      totalSkipped,
      plantsProcessed: plants.length,
      results,
    }), { headers: CORS });

  } catch (err) {
    console.error('lender-ingest fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS });
  }
});
