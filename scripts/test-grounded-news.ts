/**
 * Fetch real news using Gemini grounded search with URL verification.
 * Usage: npx tsx scripts/test-grounded-news.ts [--limit N]
 */

import { createClient } from '@supabase/supabase-js';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

interface Article {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  description: string;
}

async function isUrlLive(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GenTrack/1.0)' },
    });
    clearTimeout(timeout);
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

const BAD_DOMAINS = ['example.com', 'vertexaisearch.cloud.google.com', 'news.google.com/rss', 'google.com/search', 'govinfo.gov', 'federalregister.gov'];

async function findRealArticles(plantName: string, state: string, fuelType: string, owner: string, geminiKey: string): Promise<Article[]> {
  const prompt = `Find 8 recent real news articles about "${plantName}" power plant in ${state}. 
This is a ${fuelType} power plant owned by ${owner || 'unknown'}.

IMPORTANT: Only include articles from reputable news websites (e.g. Reuters, Bloomberg, Utility Dive, Power Engineering, local newspapers, AP News, ans.org). Each URL must be a direct link to an actual published article page - NOT a search page, government database, or directory listing.

Return ONLY a JSON array with these exact fields for each article:
- title: the article headline
- url: the direct link to the article (must be real and currently accessible)
- source: the publication name
- publishedAt: publication date in ISO format (YYYY-MM-DD)
- description: 1-sentence summary

Return JSON array only, no other text.`;

  const res = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1 },
    }),
  });

  if (!res.ok) {
    console.error(`Gemini error: HTTP ${res.status}`);
    return [];
  }

  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  
  // Extract grounding metadata (Google's own verified URLs)
  const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const groundingUrls = new Map<string, { title: string; uri: string }>();
  for (const chunk of groundingChunks) {
    if (chunk?.web?.uri && chunk?.web?.title) {
      groundingUrls.set(chunk.web.uri, { title: chunk.web.title, uri: chunk.web.uri });
    }
  }
  
  const candidates: Article[] = [];
  
  // From LLM JSON
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1) {
    try {
      const articles = JSON.parse(text.slice(start, end + 1));
      for (const a of articles) {
        if (a.url && a.title && a.url.startsWith('http') &&
            !BAD_DOMAINS.some(d => a.url.includes(d))) {
          candidates.push({
            title: String(a.title).trim(),
            url: String(a.url).trim(),
            source: String(a.source || 'Unknown').trim(),
            publishedAt: a.publishedAt || new Date().toISOString().split('T')[0],
            description: String(a.description || '').trim(),
          });
        }
      }
    } catch {}
  }
  
  // From grounding metadata
  for (const [uri, info] of groundingUrls) {
    if (!BAD_DOMAINS.some(d => uri.includes(d)) &&
        !candidates.some(c => c.url === uri)) {
      candidates.push({
        title: info.title,
        url: uri,
        source: new URL(uri).hostname.replace('www.', ''),
        publishedAt: new Date().toISOString().split('T')[0],
        description: '',
      });
    }
  }
  
  // Verify URLs are live
  const verified: Article[] = [];
  for (const article of candidates) {
    if (verified.length >= 3) break;
    const live = await isUrlLive(article.url);
    if (live) {
      console.log(`   ✓ LIVE: ${article.url}`);
      verified.push(article);
    } else {
      console.log(`   ✗ DEAD: ${article.url}`);
    }
  }
  
  return verified;
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  
  if (!supabaseUrl || !supabaseKey || !geminiKey) {
    console.error('Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY');
    process.exit(1);
  }
  
  const limitArg = process.argv.find(a => a === '--limit');
  const limitIdx = process.argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1]) : 5;
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  const { data: plants } = await supabase
    .from('plants')
    .select('eia_plant_code, name, state, fuel_source, owner')
    .neq('eia_plant_code', '99999')
    .gt('ttm_avg_factor', 0)
    .order('nameplate_capacity_mw', { ascending: false })
    .limit(limit);
  
  if (!plants?.length) {
    console.error('No plants found');
    process.exit(1);
  }
  
  console.log(`\n🔍 Fetching verified news for ${plants.length} plants...\n`);
  
  const allArticles: any[] = [];
  
  for (const plant of plants) {
    console.log(`📡 ${plant.name} (${plant.state}, ${plant.fuel_source})...`);
    
    const articles = await findRealArticles(
      plant.name, plant.state, plant.fuel_source, plant.owner || '', geminiKey
    );
    
    console.log(`   → ${articles.length} verified articles\n`);
    for (const a of articles) {
      allArticles.push({
        ...a,
        plantCode: plant.eia_plant_code,
        owner: plant.owner || '',
        state: plant.state,
        fuelType: plant.fuel_source,
      });
    }
    
    await new Promise(r => setTimeout(r, 1500));
  }
  
  if (allArticles.length === 0) {
    console.log('\nNo verified articles found.');
    return;
  }
  
  console.log(`\n💾 Inserting ${allArticles.length} verified articles...`);
  
  const toInsert = await Promise.all(allArticles.map(async a => ({
    external_id: await sha256(a.url),
    title: a.title,
    description: a.description || null,
    source_name: a.source,
    url: a.url,
    published_at: a.publishedAt,
    query_tag: `grounded:${a.plantCode}`,
    plant_codes: [a.plantCode],
    owner_names: a.owner ? [a.owner] : [],
    states: [a.state],
    fuel_types: [a.fuelType],
    topics: [],
    sentiment_label: 'neutral',
    event_type: 'none',
    importance: 'medium',
  })));
  
  const { error } = await supabase
    .from('news_articles')
    .upsert(toInsert, { onConflict: 'external_id', ignoreDuplicates: true });
  
  if (error) {
    console.error('Insert error:', error.message);
  } else {
    console.log(`✅ Done! ${toInsert.length} verified articles with clickable URLs inserted.`);
  }
}

main().catch(console.error);
