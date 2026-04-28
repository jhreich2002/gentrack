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
import { checkInternalAuth } from '../_shared/auth.ts';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_PLANT_COUNT = 9999;
const DEFAULT_BATCH_LIMIT = 15;       // plants per edge function call
const MAX_ARTICLES_PER_SOURCE = 30;
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
  eia_plant_code:       string;
  name:                 string;
  owner:                string;
  state:                string;
  fuel_source:          string;
  nameplate_capacity_mw: number;
}

const MIN_CAPACITY_FOR_OWNER_FALLBACK = 20; // MW — skip owner fallback for small behind-the-meter plants

function fuelLabel(fuelSource: string): string {
  const map: Record<string, string> = {
    'Solar': 'solar', 'Wind': 'wind', 'Natural Gas': 'gas',
    'Nuclear': 'nuclear', 'Hydro': 'hydro', 'Coal': 'coal',
    'Petroleum': 'petroleum', 'Geothermal': 'geothermal',
    'Biomass': 'biomass', 'Other': 'energy',
  };
  return map[fuelSource] ?? 'energy';
}

// Roman ↔ Arabic numeral maps for plant name variants
const ROMAN_TO_ARABIC: Record<string, string> = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7', VIII: '8', IX: '9', X: '10' };
const ARABIC_TO_ROMAN: Record<string, string> = Object.fromEntries(Object.entries(ROMAN_TO_ARABIC).map(([r, a]) => [a, r]));

/**
 * Generate search name variants from a plant name.
 * Returns an array of { quoted, label } where quoted is the search string
 * and label describes the variant for logging.
 *
 * Example for "Appaloosa Solar I":
 *   1. "Appaloosa Solar I"   (exact)
 *   2. "Appaloosa Solar"     (suffix stripped)
 *   3. "Appaloosa Solar 1"   (roman→arabic swap)
 */
function buildNameVariants(name: string): string[] {
  const variants: string[] = [name]; // always include exact name

  // Try to detect trailing Roman or Arabic numeral suffix
  const romanSuffixMatch = name.match(/^(.+?)\s+(I{1,3}|IV|VI{0,3}|IX|X)$/i);
  const arabicSuffixMatch = name.match(/^(.+?)\s+(\d{1,2})$/);

  if (romanSuffixMatch) {
    const base = romanSuffixMatch[1].trim();
    const roman = romanSuffixMatch[2].toUpperCase();
    // Variant: stripped suffix
    if (!variants.includes(base)) variants.push(base);
    // Variant: Roman → Arabic swap
    const arabic = ROMAN_TO_ARABIC[roman];
    if (arabic) {
      const swapped = `${base} ${arabic}`;
      if (!variants.includes(swapped)) variants.push(swapped);
    }
  } else if (arabicSuffixMatch) {
    const base = arabicSuffixMatch[1].trim();
    const arabic = arabicSuffixMatch[2];
    // Variant: stripped suffix
    if (!variants.includes(base)) variants.push(base);
    // Variant: Arabic → Roman swap
    const roman = ARABIC_TO_ROMAN[arabic];
    if (roman) {
      const swapped = `${base} ${roman}`;
      if (!variants.includes(swapped)) variants.push(swapped);
    }
  }

  // Strip trailing corporate suffixes for broader matching
  // e.g. "Waxdale Energy LLC" → "Waxdale Energy"
  const CORP_SUFFIXES = /\s+(LLC|L\.L\.C\.|Inc\.?|L\.P\.|LP|Ltd\.?|Co\.?)$/i;
  const corpStripped = variants[0].replace(CORP_SUFFIXES, '').trim();
  if (corpStripped !== variants[0] && !variants.includes(corpStripped)) {
    variants.push(corpStripped);
  }

  return variants;
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
  tier?: string,
): Promise<{ plants: PlantInfo[]; totalEligible: number }> {
  const { data: maxRow } = await sb
    .from('monthly_generation')
    .select('month')
    .not('mwh', 'is', null)
    .order('month', { ascending: false })
    .limit(1);

  const latestMonth = maxRow?.[0]?.month ?? '2025-11';
  console.log(`Latest generation month: ${latestMonth} (tier=${tier ?? 'A'})`);

  const { data: genData } = await sb
    .from('monthly_generation')
    .select('plant_id')
    .eq('month', latestMonth)
    .not('mwh', 'is', null);

  const eligibleIds = new Set((genData ?? []).map((r: { plant_id: string }) => r.plant_id));

  let plantsQuery = sb
    .from('plants')
    .select('id, eia_plant_code, name, owner, state, fuel_source, curtailment_score, nameplate_capacity_mw')
    .eq('is_maintenance_offline', false)
    .eq('trailing_zero_months', 0)
    .neq('eia_plant_code', '99999')
    .not('owner', 'is', null)
    .limit(10000);

  if (tier === 'B') {
    plantsQuery = plantsQuery
      .eq('is_likely_curtailed', false)
      .gte('nameplate_capacity_mw', 200)
      .order('nameplate_capacity_mw', { ascending: false });
  } else {
    plantsQuery = plantsQuery
      .eq('is_likely_curtailed', true)
      .order('curtailment_score', { ascending: false })
      .order('nameplate_capacity_mw', { ascending: false });
  }

  const { data: plantsData, error } = await plantsQuery;
  if (error) throw new Error(`Failed to load plants: ${error.message}`);

  const all = (plantsData ?? []).filter((p: { id: string }) => eligibleIds.has(p.id));
  const totalEligible = Math.min(all.length, plantCount);
  const batch = all.slice(offset, Math.min(offset + limit, plantCount));

  console.log(`Eligible (tier ${tier ?? 'A'}): ${all.length}, plantCount cap: ${plantCount}, batch offset=${offset} limit=${limit} → ${batch.length} plants this call`);

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
  const nameVariants = buildNameVariants(plant.name);

  // Single-term queries per name variant — avoids broken OR chains where Google interprets
  // `"Plant Name" solar financing OR lender OR "tax equity"` as
  // ("Plant Name" solar financing) OR (lender) OR ("tax equity"), flooding results with
  // unrelated articles. One focused term per query gives much higher precision.
  const queries: string[] = [];
  const afterClause = afterDate ? ` after:${afterDate}` : '';

  // Exact quoted name — four focused terms
  queries.push(`"${nameVariants[0]}" lender${afterClause}`);
  queries.push(`"${nameVariants[0]}" "tax equity"${afterClause}`);
  queries.push(`"${nameVariants[0]}" financing${afterClause}`);
  queries.push(`"${nameVariants[0]}" "financial close"${afterClause}`);

  // Additional financing terms
  queries.push(`"${nameVariants[0]}" "construction loan"${afterClause}`);
  queries.push(`"${nameVariants[0]}" "project finance"${afterClause}`);
  queries.push(`"${nameVariants[0]}" refinancing${afterClause}`);

  // Stripped-suffix variant (e.g., "Appaloosa Solar" from "Appaloosa Solar I") if different
  if (nameVariants.length >= 2 && nameVariants[1] !== nameVariants[0]) {
    queries.push(`"${nameVariants[1]}" lender${afterClause}`);
    queries.push(`"${nameVariants[1]}" "tax equity"${afterClause}`);
  }

  // Press release wire services — Google deeply indexes their archives (historical coverage)
  // site: queries bypass the Google News RSS recency cap for high-authority sources
  queries.push(`"${nameVariants[0]}" site:businesswire.com`);
  queries.push(`"${nameVariants[0]}" site:prnewswire.com`);
  queries.push(`"${nameVariants[0]}" site:globenewswire.com`);

  console.log(`  [google] ${queries.length} queries for ${plant.name}`);

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
  const afterClause = afterDate ? ` after:${afterDate}` : '';

  // Two focused queries instead of one broken OR chain
  const queries = [
    `"${plant.owner}" ${plant.state} lender${afterClause}`,
    `"${plant.owner}" ${plant.state} "tax equity"${afterClause}`,
  ];

  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();

  for (const ownerQuery of queries) {
    if (allArticles.length >= MAX_ARTICLES_PER_SOURCE) break;

    const encoded = encodeURIComponent(ownerQuery);
    const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

    try {
      const res = await fetch(rssUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) {
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
      console.warn(`[google-owner] Error for: ${plant.owner.slice(0, 40)}`, e);
    }

    await sleep(DELAY_BETWEEN_QUERIES_MS);
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

  const nameVariants = buildNameVariants(plant.name);
  const exactName = nameVariants[0];
  const broadName = nameVariants.length >= 2 ? nameVariants[1] : exactName;

  // Single-term queries — same rationale as Google: avoids broken OR chains
  const queries = [
    `"${exactName}" lender`,
    `"${exactName}" "tax equity"`,
    `"${exactName}" financing`,
    `"${exactName}" "financial close"`,
    `"${exactName}" loan`,
    `"${exactName}" "construction loan"`,
    `"${exactName}" "project finance"`,
    `"${exactName}" refinancing`,
    ...(broadName !== exactName ? [
      `"${broadName}" lender`,
      `"${broadName}" "tax equity"`,
    ] : []),
    // Owner queries — surface portfolio-level financing news
    ...(plant.owner ? [
      `"${plant.owner}" ${plant.state} lender`,
      `"${plant.owner}" ${plant.state} "tax equity"`,
    ] : []),
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
    const { data, error } = await sb
      .from('news_articles')
      .upsert(batch, { onConflict: 'external_id' })
      .select('id');

    if (error) {
      console.error(`Upsert error at batch ${i}: ${error.message}`);
    } else {
      inserted += (data?.length ?? 0);
    }
  }

  return { inserted, skipped };
}

// ── Chain call helper ──────────────────────────────────────────────────────────

function fireAndForget(url: string, body: Record<string, unknown>): void {
  const internalToken = Deno.env.get('INTERNAL_AUTH_TOKEN')!;
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${internalToken}`,
    },
    body: JSON.stringify(body),
  }).catch(err => console.error('Chain call failed:', err));
}

// ── Handler ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const __authDenied = checkInternalAuth(req);
  if (__authDenied) return __authDenied;
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

  let body: { plantCount?: number; offset?: number; limit?: number; tier?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const plantCount = body.plantCount ?? DEFAULT_PLANT_COUNT;
  const offset = body.offset ?? 0;
  const limit = body.limit ?? DEFAULT_BATCH_LIMIT;
  const tier = body.tier;

  const sb = makeSupabase();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  try {
    const { plants, totalEligible } = await loadTopCurtailedPlants(sb, plantCount, offset, limit, tier);

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

      // Owner-name queries — always run for plants ≥20 MW regardless of plant-name result count
      let ownerFallbackArticles: RawArticle[] = [];
      if (plant.owner && plant.nameplate_capacity_mw >= MIN_CAPACITY_FOR_OWNER_FALLBACK) {
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
        ...(tier ? { tier } : {}),
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
