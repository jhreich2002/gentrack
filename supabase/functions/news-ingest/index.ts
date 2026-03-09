/**
 * GenTrack — news-ingest Edge Function (Gemini Grounded Search)
 *
 * Uses Gemini 2.5 Flash with Google Search grounding to find REAL news articles
 * with actual clickable URLs. No more fake/synthetic content!
 *
 * Tiered refresh strategy:
 *   - Tier 1: Top 200 plants by MW (daily)
 *   - Tier 2: Next 300 plants (Mon/Thu)
 *
 * Cost estimate:
 *   ~200 plants × 1 grounded search call ≈ $0.05-0.10/day → ~$2-3/month
 *
 * Required secrets:
 *   GEMINI_API_KEY            — Google AI Studio key
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

const TIER_1_SIZE     = 200;
const TIER_2_SIZE     = 300;
const ARTICLES_PER_PLANT = 8;  // Ask for more since some will fail validation
const UPSERT_BATCH    = 50;
const RATE_LIMIT_MS   = 1500;  // Be conservative with Gemini grounding
const GEMINI_URL      = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Verify a URL is live (returns 200-399). Timeout after 8s. */
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

// ── Gemini Grounded Search ────────────────────────────────────────────────────

interface GroundedArticle {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  description: string;
}

interface PlantInfo {
  eia_plant_code: string;
  name: string;
  owner: string;
  state: string;
  fuel_source: string;
}

async function findRealArticles(
  plant: PlantInfo,
  geminiKey: string,
): Promise<GroundedArticle[]> {
  const prompt = `Find ${ARTICLES_PER_PLANT} recent real news articles about "${plant.name}" power plant in ${plant.state}. 
This is a ${plant.fuel_source} power plant owned by ${plant.owner || 'unknown'}.

IMPORTANT: Only include articles from reputable news websites (e.g. Reuters, Bloomberg, Utility Dive, Power Engineering, local newspapers, AP News, ans.org). Each URL must be a direct link to an actual published article page - NOT a search page, government database, or directory listing.

Return ONLY a JSON array with these exact fields for each article:
- title: the article headline
- url: the direct link to the article (must be real and currently accessible)
- source: the publication name
- publishedAt: publication date in ISO format (YYYY-MM-DD)
- description: 1-sentence summary

Return JSON array only, no other text.`;

  try {
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
      console.error(`Gemini error for ${plant.name}: HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    
    // ── Also extract grounding metadata (Google's own verified URLs) ─────────
    const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const groundingUrls = new Map<string, { title: string; uri: string }>();
    for (const chunk of groundingChunks) {
      if (chunk?.web?.uri && chunk?.web?.title) {
        groundingUrls.set(chunk.web.uri, { title: chunk.web.title, uri: chunk.web.uri });
      }
    }
    
    // Extract JSON array from LLM response
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    
    const BAD_DOMAINS = ['example.com', 'vertexaisearch.cloud.google.com', 'news.google.com/rss', 'google.com/search', 'govinfo.gov', 'federalregister.gov'];
    
    // Combine: LLM-parsed articles + grounding metadata articles
    const candidates: GroundedArticle[] = [];
    
    // 1) From LLM JSON response
    if (start !== -1 && end !== -1) {
      try {
        const articles = JSON.parse(text.slice(start, end + 1));
        for (const a of articles) {
          if (a.url && a.title && a.url.startsWith('http') &&
              !BAD_DOMAINS.some(d => a.url.includes(d))) {
            candidates.push({
              title: String(a.title || '').trim(),
              url: String(a.url || '').trim(),
              source: String(a.source || 'Unknown').trim(),
              publishedAt: a.publishedAt ? new Date(a.publishedAt).toISOString() : new Date().toISOString(),
              description: String(a.description || '').trim(),
            });
          }
        }
      } catch { /* JSON parse error, fall through to grounding */ }
    }
    
    // 2) From grounding metadata (these are Google's own verified links)
    for (const [uri, info] of groundingUrls) {
      if (!BAD_DOMAINS.some(d => uri.includes(d)) &&
          !candidates.some(c => c.url === uri)) {
        candidates.push({
          title: info.title,
          url: uri,
          source: new URL(uri).hostname.replace('www.', ''),
          publishedAt: new Date().toISOString(),
          description: '',
        });
      }
    }
    
    // 3) Verify URLs are actually live (HEAD request)
    const verified: GroundedArticle[] = [];
    for (const article of candidates) {
      if (verified.length >= 3) break; // We only need 3 good ones
      const live = await isUrlLive(article.url);
      if (live) {
        verified.push(article);
        console.log(`  ✓ ${article.url}`);
      } else {
        console.log(`  ✗ DEAD: ${article.url}`);
      }
    }
    
    return verified;
  } catch (e) {
    console.error(`Error fetching articles for ${plant.name}:`, e);
    return [];
  }
}

// ── Main Handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  try {
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiKey) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not set' }), { status: 500 });
    }
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Determine tier
    const url = new URL(req.url);
    const tierParam = url.searchParams.get('tier');
    const limitParam = url.searchParams.get('limit');
    const hour = new Date().getUTCHours();
    const dayOfWeek = new Date().getUTCDay();
    
    let tier: 1 | 2;
    if (tierParam) {
      tier = parseInt(tierParam) as 1 | 2;
    } else if (hour < 10) {
      tier = 1;
    } else if (dayOfWeek === 1 || dayOfWeek === 4) {
      tier = 2;
    } else {
      tier = 1;
    }

    console.log(`news-ingest starting: tier=${tier}`);

    // Load plants sorted by MW
    const maxPlants = limitParam ? parseInt(limitParam) : (tier === 1 ? TIER_1_SIZE : TIER_1_SIZE + TIER_2_SIZE);
    const { data: plantsData, error: plantsErr } = await supabase
      .from('plants')
      .select('eia_plant_code, name, owner, state, fuel_source, nameplate_capacity_mw')
      .neq('eia_plant_code', '99999')
      .gt('ttm_avg_factor', 0)
      .order('nameplate_capacity_mw', { ascending: false })
      .limit(maxPlants);

    if (plantsErr || !plantsData) {
      throw new Error(`Failed to load plants: ${plantsErr?.message}`);
    }

    // Select plants based on tier
    let plants: PlantInfo[];
    if (tier === 1) {
      plants = plantsData.slice(0, TIER_1_SIZE) as PlantInfo[];
    } else {
      plants = plantsData.slice(TIER_1_SIZE, TIER_1_SIZE + TIER_2_SIZE) as PlantInfo[];
    }

    if (limitParam) {
      plants = plants.slice(0, parseInt(limitParam));
    }

    console.log(`Processing ${plants.length} plants for tier ${tier}`);

    // Load existing URLs to avoid duplicates
    const { data: existingData } = await supabase
      .from('news_articles')
      .select('url')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    
    const existingUrls = new Set((existingData || []).map(r => r.url));

    // Fetch articles for each plant
    const allArticles: Array<GroundedArticle & { plantCode: string; owner: string; state: string; fuelType: string }> = [];
    let plantsFetched = 0;
    let geminiCalls = 0;

    for (const plant of plants) {
      const articles = await findRealArticles(plant, geminiKey);
      geminiCalls++;
      
      for (const a of articles) {
        if (!existingUrls.has(a.url)) {
          existingUrls.add(a.url);
          allArticles.push({
            ...a,
            plantCode: plant.eia_plant_code,
            owner: plant.owner || '',
            state: plant.state || '',
            fuelType: plant.fuel_source || '',
          });
        }
      }

      plantsFetched++;
      if (plantsFetched % 10 === 0) {
        console.log(`Fetched ${plantsFetched}/${plants.length} plants, ${allArticles.length} articles`);
      }

      await sleep(RATE_LIMIT_MS);
    }

    console.log(`Found ${allArticles.length} new articles from ${geminiCalls} Gemini calls`);

    // Upsert to database
    const toUpsert = await Promise.all(allArticles.map(async a => ({
      external_id: await sha256(a.url),
      title: a.title,
      description: a.description || null,
      content: null,
      source_name: a.source,
      url: a.url,
      published_at: a.publishedAt,
      query_tag: `grounded:${a.plantCode}`,
      plant_codes: [a.plantCode],
      owner_names: a.owner ? [a.owner] : [],
      states: a.state ? [a.state] : [],
      fuel_types: a.fuelType ? [a.fuelType] : [],
      topics: [],
      sentiment_label: 'neutral',
      event_type: 'none',
      impact_tags: [],
      fti_relevance_tags: [],
      importance: 'medium',
      entity_company_names: [],
      llm_classified_at: new Date().toISOString(),
    })));

    let inserted = 0;
    let errors = 0;
    for (let i = 0; i < toUpsert.length; i += UPSERT_BATCH) {
      const batch = toUpsert.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from('news_articles')
        .upsert(batch, { onConflict: 'external_id', ignoreDuplicates: true });
      
      if (error) {
        console.error(`Upsert error at ${i}:`, error.message);
        errors++;
      } else {
        inserted += batch.length;
      }
    }

    const result = {
      ok: true,
      tier,
      plantsProcessed: plants.length,
      geminiCalls,
      articlesFound: allArticles.length,
      articlesInserted: inserted,
      errors,
    };

    console.log('news-ingest complete:', result);
    return new Response(JSON.stringify(result), { 
      headers: { 'Content-Type': 'application/json' } 
    });

  } catch (err) {
    console.error('news-ingest fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});


