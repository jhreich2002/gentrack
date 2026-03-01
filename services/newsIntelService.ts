/**
 * GenTrack — newsIntelService
 *
 * Three functions used by the PlantDetailView News tab:
 *
 *   fetchPlantNewsArticles  — chronological stored articles for a plant
 *   fetchPlantNewsRating    — precomputed risk score + window counts
 *   semanticSearchPlantNews — embed a free-text query → cosine similarity search
 *
 * All reads use the public anon key (RLS allows SELECT for everyone).
 * Semantic search embeds the query via Gemini text-embedding-004 client-side,
 * then calls the search_plant_news() Postgres function via supabase.rpc().
 */

import { GoogleGenAI } from "@google/genai";
import { supabase } from './supabaseClient';
import { NewsArticle, PlantNewsRating, PlantNewsState } from '../types';

// ── Gemini embedding (client-side, free tier) ─────────────────────────────────

async function embedQuery(text: string): Promise<number[]> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY ?? import.meta.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');

  const ai = new GoogleGenAI({ apiKey });
  // @ts-ignore — embedContent is available in @google/genai ≥1.0
  const result = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: text,
    config: { outputDimensionality: 768 },
  });
  return result.embeddings[0].values as number[];
}

// ── fetchPlantNewsArticles ────────────────────────────────────────────────────

/**
 * Returns stored news articles linked to a specific EIA plant code,
 * ordered most-recent first. Optionally filter to a topic.
 */
export async function fetchPlantNewsArticles(
  eiaPlantCode: string,
  options: {
    daysBack?:  number;       // default 90
    topic?:     string | null; // 'outage'|'regulatory'|'financial'|'weather'|'construction'|null
    limit?:     number;        // default 20
  } = {}
): Promise<NewsArticle[]> {
  const { daysBack = 90, topic = null, limit = 20 } = options;

  const cutoff = new Date(Date.now() - daysBack * 86400 * 1000).toISOString();

  let query = supabase
    .from('news_articles')
    .select(`
      id, title, description, url, source_name,
      published_at, topics, sentiment_label, plant_codes,
      event_type, impact_tags, fti_relevance_tags, importance, entity_company_names
    `)
    .contains('plant_codes', [eiaPlantCode])
    .gte('published_at', cutoff)
    .order('published_at', { ascending: false })
    .limit(limit);

  if (topic) {
    query = query.contains('topics', [topic]);
  }

  const { data, error } = await query;

  if (error) {
    console.error('fetchPlantNewsArticles error:', error.message);
    return [];
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id:                 row.id as string,
    title:              row.title as string,
    description:        row.description as string | null,
    url:                row.url as string,
    sourceName:         row.source_name as string | null,
    publishedAt:        row.published_at as string,
    topics:             (row.topics as string[]) ?? [],
    sentimentLabel:     row.sentiment_label as 'positive' | 'negative' | 'neutral' | null,
    eventType:          row.event_type as string | null,
    impactTags:         (row.impact_tags as string[]) ?? [],
    ftiRelevanceTags:   (row.fti_relevance_tags as string[]) ?? [],
    importance:         row.importance as 'low' | 'medium' | 'high' | null,
    entityCompanyNames: (row.entity_company_names as string[]) ?? [],
  }));
}

// ── fetchPlantNewsRating ──────────────────────────────────────────────────────

/**
 * Returns the precomputed news risk rating for a plant.
 * Returns null if no rating has been computed yet (first ingest hasn't run).
 */
export async function fetchPlantNewsRating(
  eiaPlantCode: string
): Promise<PlantNewsRating | null> {
  const { data, error } = await supabase
    .from('plant_news_ratings')
    .select('*')
    .eq('eia_plant_code', eiaPlantCode)
    .single();

  if (error || !data) return null;

  return {
    eiaPlantCode:    data.eia_plant_code,
    articles30d:     data.articles_30d,
    negative30d:     data.negative_30d,
    outage30d:       data.outage_30d,
    articles90d:     data.articles_90d,
    negative90d:     data.negative_90d,
    outage90d:       data.outage_90d,
    articles365d:    data.articles_365d,
    negative365d:    data.negative_365d,
    outage365d:      data.outage_365d,
    newsRiskScore:   parseFloat(data.news_risk_score),
    topArticleIds:   data.top_article_ids ?? [],
    computedAt:      data.computed_at,
  };
}

// ── fetchPlantNewsState ─────────────────────────────────────────────

/**
 * Returns the cached LLM summary and FTI advisory bullets for a plant.
 * Returns null if no summary has been generated yet.
 */
export async function fetchPlantNewsState(
  eiaPlantCode: string
): Promise<PlantNewsState | null> {
  const { data, error } = await supabase
    .from('plant_news_state')
    .select('*')
    .eq('eia_plant_code', eiaPlantCode)
    .single();

  if (error || !data) return null;

  return {
    eiaPlantCode:         data.eia_plant_code,
    lastCheckedAt:        data.last_checked_at,
    summaryText:          data.summary_text,
    ftiAngleBullets:      data.fti_angle_bullets ?? [],
    summaryLastUpdatedAt: data.summary_last_updated_at,
    lastEventTypes:       data.last_event_types ?? [],
    lastSentiment:        data.last_sentiment,
  };
}

// ── callPlantSummarize ────────────────────────────────────────────────────────

export interface PlantSummaryResponse {
  summary_text: string;
  fti_angle_bullets: string[];
  summary_last_updated_at: string;
  from_cache: boolean;
}

/**
 * Calls the plant-news-summarize Edge Function to get (or refresh) the
 * Gemini-generated situation summary and FTI advisory bullets for a plant.
 * Returns null if the call fails.
 */
export async function callPlantSummarize(
  eiaPlantCode: string,
  plantName: string,
  plantOwner: string,
): Promise<PlantSummaryResponse | null> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  if (!supabaseUrl) {
    console.warn('callPlantSummarize: VITE_SUPABASE_URL not set');
    return null;
  }

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/plant-news-summarize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(anonKey ? { Authorization: `Bearer ${anonKey}`, apikey: anonKey } : {}),
      },
      body: JSON.stringify({ eia_plant_code: eiaPlantCode, plant_name: plantName, plant_owner: plantOwner }),
    });
    if (!resp.ok) {
      console.error('callPlantSummarize HTTP', resp.status, await resp.text());
      return null;
    }
    return (await resp.json()) as PlantSummaryResponse;
  } catch (err) {
    console.error('callPlantSummarize fetch error:', err);
    return null;
  }
}

// ── semanticSearchPlantNews ───────────────────────────────────────────────────

export interface SemanticSearchResult extends NewsArticle {
  similarity: number; // cosine similarity 0–1
}

/**
 * Embeds queryText via Gemini text-embedding-004, then calls the
 * search_plant_news() Postgres RPC for nearest-neighbour search.
 * Returns articles sorted by semantic relevance.
 */
export async function semanticSearchPlantNews(
  eiaPlantCode: string,
  queryText: string,
  options: { daysBack?: number; maxResults?: number } = {}
): Promise<SemanticSearchResult[]> {
  const { daysBack = 365, maxResults = 10 } = options;

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedQuery(queryText);
  } catch (err) {
    console.error('Embedding query failed:', err);
    return [];
  }

  const { data, error } = await supabase.rpc('search_plant_news', {
    p_plant_code:      eiaPlantCode,
    p_query_embedding: `[${queryEmbedding.join(',')}]`,
    p_days_back:       daysBack,
    p_max_results:     maxResults,
  });

  if (error) {
    console.error('search_plant_news RPC error:', error.message);
    return [];
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id:                 row.id as string,
    title:              row.title as string,
    description:        row.description as string | null,
    url:                row.url as string,
    sourceName:         row.source_name as string | null,
    publishedAt:        row.published_at as string,
    topics:             (row.topics as string[]) ?? [],
    sentimentLabel:     row.sentiment_label as 'positive' | 'negative' | 'neutral' | null,
    eventType:          row.event_type as string | null,
    impactTags:         (row.impact_tags as string[]) ?? [],
    ftiRelevanceTags:   (row.fti_relevance_tags as string[]) ?? [],
    importance:         row.importance as 'low' | 'medium' | 'high' | null,
    entityCompanyNames: (row.entity_company_names as string[]) ?? [],
    similarity:         row.similarity as number,
  }));
}
