/**
 * fetch-real-news.ts
 * 
 * Fetches REAL news articles from Google News RSS and classifies them with Gemini.
 * Returns actual clickable URLs to real news sources.
 * 
 * Usage:
 *   npx tsx scripts/fetch-real-news.ts [--tier 1|2|3] [--limit N]
 * 
 * Tiers:
 *   1 = Top 200 plants by MW (daily)
 *   2 = Next 500 plants (twice weekly)
 *   3 = All remaining plants (weekly)
 * 
 * Cost estimate: ~$0.01 per 100 articles classified with Gemini 2.5 Flash
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

// ── Environment ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite-preview-06-17:generateContent';

// ── Config ────────────────────────────────────────────────────────────────────

const TIER_LIMITS = {
  1: { start: 0, end: 200 },      // Top 200 plants by MW
  2: { start: 200, end: 700 },    // Next 500 plants
  3: { start: 700, end: 99999 },  // All remaining
};

const MAX_ARTICLES_PER_PLANT = 5;
const BATCH_SIZE = 20; // Articles per Gemini classification call
const RATE_LIMIT_MS = 1000; // Delay between Google News requests

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

interface RawArticle {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  plantCode: string;
  plantName: string;
  owner: string;
  state: string;
  fuelType: string;
}

interface ClassifiedArticle extends RawArticle {
  description: string;
  topics: string[];
  sentimentLabel: string;
  eventType: string;
  impactTags: string[];
  ftiRelevanceTags: string[];
  importance: string;
  entityCompanyNames: string[];
}

// ── Bing News RSS Fetcher (provides direct article URLs) ──────────────────────

async function fetchBingNewsRSS(query: string): Promise<{ title: string; url: string; source: string; publishedAt: string }[]> {
  const encoded = encodeURIComponent(query);
  const rssUrl = `https://www.bing.com/news/search?q=${encoded}&format=rss`;
  
  try {
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    
    if (!res.ok) {
      console.warn(`  [rss] HTTP ${res.status} for query: ${query}`);
      return [];
    }
    
    const xml = await res.text();
    const articles: { title: string; url: string; source: string; publishedAt: string }[] = [];
    
    // Parse RSS items
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    
    while ((match = itemRegex.exec(xml)) !== null && articles.length < MAX_ARTICLES_PER_PLANT) {
      const item = match[1];
      
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      const sourceMatch = item.match(/<news:Source>(.*?)<\/news:Source>|<source[^>]*>(.*?)<\/source>/i);
      const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      
      if (titleMatch && linkMatch) {
        let title = (titleMatch[1] || titleMatch[2] || '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        
        // Bing RSS provides direct URLs to the source articles
        const url = linkMatch[1].trim();
        
        // Extract source from title if not in XML (Bing format: "Title - Source Name")
        let source = sourceMatch ? (sourceMatch[1] || sourceMatch[2] || '').trim() : '';
        if (!source && title.includes(' - ')) {
          const parts = title.split(' - ');
          source = parts.pop() || '';
          title = parts.join(' - ');
        }
        
        articles.push({
          title: title.trim(),
          url,
          source: source || 'Bing News',
          publishedAt: pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString(),
        });
      }
    }
    
    return articles;
  } catch (e) {
    console.warn(`  [rss] Error fetching: ${query}`, e);
    return [];
  }
}

// ── Gemini Classification ─────────────────────────────────────────────────────

async function classifyArticles(articles: RawArticle[]): Promise<ClassifiedArticle[]> {
  if (!GEMINI_API_KEY || articles.length === 0) {
    return articles.map(a => ({
      ...a,
      description: '',
      topics: [],
      sentimentLabel: 'neutral',
      eventType: 'none',
      impactTags: [],
      ftiRelevanceTags: [],
      importance: 'low',
      entityCompanyNames: [],
    }));
  }

  const prompt = `You are an energy sector analyst. Classify these news articles about US power plants.

For each article, provide:
- description: 1-2 sentence summary of the article relevance to the plant
- topics: array of topics like ["outage", "regulatory", "financial", "grid", "weather", "construction"]
- sentiment_label: "positive", "negative", or "neutral"
- event_type: one of "outage", "regulatory", "financial", "m_and_a", "dispute", "construction", "policy", "restructuring", "none"
- impact_tags: array like ["grid_congestion", "ppa_risk", "credit_concern", "permitting_delay"]
- fti_relevance_tags: array from ["restructuring", "transactions", "disputes", "market_strategy"]
- importance: "high", "medium", or "low"
- entity_company_names: array of company names mentioned

Articles:
${articles.map((a, i) => `[${i}] Plant: ${a.plantName} (${a.plantCode}) - ${a.owner}
    Title: ${a.title}
    Source: ${a.source}`).join('\n\n')}

Return ONLY a JSON array with one object per article, in order. Example:
[{"description":"...","topics":["outage"],"sentiment_label":"negative","event_type":"outage","impact_tags":[],"fti_relevance_tags":[],"importance":"medium","entity_company_names":["NextEra"]}]`;

  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 4000 },
      }),
    });

    if (!res.ok) {
      console.warn(`  [gemini] HTTP ${res.status}`);
      return articles.map(a => ({ ...a, description: '', topics: [], sentimentLabel: 'neutral', eventType: 'none', impactTags: [], ftiRelevanceTags: [], importance: 'low', entityCompanyNames: [] }));
    }

    const data = await res.json();
    const raw: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    
    // Extract JSON array
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1 || end === -1) {
      return articles.map(a => ({ ...a, description: '', topics: [], sentimentLabel: 'neutral', eventType: 'none', impactTags: [], ftiRelevanceTags: [], importance: 'low', entityCompanyNames: [] }));
    }
    
    const parsed = JSON.parse(raw.slice(start, end + 1));
    
    return articles.map((a, i) => {
      const c = parsed[i] || {};
      return {
        ...a,
        description: c.description || '',
        topics: Array.isArray(c.topics) ? c.topics : [],
        sentimentLabel: c.sentiment_label || 'neutral',
        eventType: c.event_type || 'none',
        impactTags: Array.isArray(c.impact_tags) ? c.impact_tags : [],
        ftiRelevanceTags: Array.isArray(c.fti_relevance_tags) ? c.fti_relevance_tags : [],
        importance: c.importance || 'low',
        entityCompanyNames: Array.isArray(c.entity_company_names) ? c.entity_company_names : [],
      };
    });
  } catch (e) {
    console.warn(`  [gemini] Classification error:`, e);
    return articles.map(a => ({ ...a, description: '', topics: [], sentimentLabel: 'neutral', eventType: 'none', impactTags: [], ftiRelevanceTags: [], importance: 'low', entityCompanyNames: [] }));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  let tier = 1;
  let limit = 0;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tier' && args[i + 1]) tier = parseInt(args[i + 1]) || 1;
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[i + 1]) || 0;
  }
  
  const tierConfig = TIER_LIMITS[tier as 1 | 2 | 3] || TIER_LIMITS[1];
  console.log(`\n🔍 Fetching real news - Tier ${tier} (plants ${tierConfig.start}-${tierConfig.end})\n`);

  // Load plants sorted by nameplate MW
  console.log('Loading plants from Supabase...');
  const PAGE = 1000;
  let allPlants: { code: string; name: string; owner: string; state: string; fuel: string; mw: number }[] = [];
  let from = 0;
  
  while (true) {
    const { data, error } = await supabase
      .from('plants')
      .select('eia_plant_code, name, owner, state, fuel_source, nameplate_capacity_mw')
      .neq('eia_plant_code', '99999')
      .order('nameplate_capacity_mw', { ascending: false })
      .range(from, from + PAGE - 1);
    
    if (error) { console.error('Failed to load plants:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    
    allPlants = allPlants.concat(data.map(p => ({
      code: p.eia_plant_code as string,
      name: (p.name as string) || '',
      owner: (p.owner as string) || '',
      state: (p.state as string) || '',
      fuel: (p.fuel_source as string) || '',
      mw: Number(p.nameplate_capacity_mw) || 0,
    })));
    
    if (data.length < PAGE) break;
    from += PAGE;
  }

  // Filter to tier
  let plants = allPlants.slice(tierConfig.start, tierConfig.end);
  if (limit > 0) plants = plants.slice(0, limit);
  
  console.log(`Processing ${plants.length} plants...\n`);

  // Fetch existing article URLs to avoid duplicates
  console.log('Loading existing article URLs...');
  const { data: existingUrls } = await supabase
    .from('news_articles')
    .select('url');
  const urlSet = new Set((existingUrls || []).map(r => r.url));
  console.log(`Found ${urlSet.size} existing articles.\n`);

  // Collect articles
  const allArticles: RawArticle[] = [];
  let plantsFetched = 0;
  
  for (const plant of plants) {
    // Build search query
    const query = `"${plant.name}" power plant ${plant.state}`;
    
    const articles = await fetchBingNewsRSS(query);
    
    // Filter out duplicates
    const newArticles = articles.filter(a => !urlSet.has(a.url));
    
    for (const a of newArticles) {
      urlSet.add(a.url); // Track to avoid intra-run duplicates
      allArticles.push({
        ...a,
        plantCode: plant.code,
        plantName: plant.name,
        owner: plant.owner,
        state: plant.state,
        fuelType: plant.fuel,
      });
    }
    
    plantsFetched++;
    if (plantsFetched % 20 === 0) {
      console.log(`  [${plantsFetched}/${plants.length}] ${allArticles.length} articles found...`);
    }
    
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n📰 Found ${allArticles.length} new articles. Classifying with Gemini...\n`);

  // Classify in batches
  const classified: ClassifiedArticle[] = [];
  for (let i = 0; i < allArticles.length; i += BATCH_SIZE) {
    const batch = allArticles.slice(i, i + BATCH_SIZE);
    const result = await classifyArticles(batch);
    classified.push(...result);
    console.log(`  Classified ${Math.min(i + BATCH_SIZE, allArticles.length)}/${allArticles.length}`);
    await sleep(500); // Rate limit Gemini
  }

  // Insert into DB
  console.log(`\n💾 Inserting ${classified.length} articles into database...\n`);
  
  const toInsert = classified.map(a => ({
    external_id: sha256(a.url),
    title: a.title,
    description: a.description || null,
    content: null,
    source_name: a.source,
    url: a.url,
    published_at: a.publishedAt,
    query_tag: `gnews:${a.plantCode}`,
    plant_codes: [a.plantCode],
    owner_names: a.owner ? [a.owner] : [],
    states: a.state ? [a.state] : [],
    fuel_types: a.fuelType ? [a.fuelType] : [],
    topics: a.topics,
    sentiment_label: a.sentimentLabel,
    event_type: a.eventType,
    impact_tags: a.impactTags,
    fti_relevance_tags: a.ftiRelevanceTags,
    importance: a.importance,
    entity_company_names: a.entityCompanyNames,
    llm_classified_at: new Date().toISOString(),
  }));

  // Insert in chunks
  const CHUNK = 100;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('news_articles')
      .upsert(chunk, { onConflict: 'external_id' });
    
    if (error) {
      console.error(`  Insert error at ${i}:`, error.message);
    } else {
      inserted += chunk.length;
    }
  }

  console.log(`\n✅ Done! Inserted ${inserted} real articles with clickable URLs.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
