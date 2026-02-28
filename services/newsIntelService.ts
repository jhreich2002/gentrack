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
import { NewsArticle, PlantNewsRating } from '../types';

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
      published_at, topics, sentiment_label, plant_codes
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
    id:             row.id as string,
    title:          row.title as string,
    description:    row.description as string | null,
    url:            row.url as string,
    sourceName:     row.source_name as string | null,
    publishedAt:    row.published_at as string,
    topics:         row.topics as string[],
    sentimentLabel: row.sentiment_label as 'positive' | 'negative' | 'neutral' | null,
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
    id:             row.id as string,
    title:          row.title as string,
    description:    row.description as string | null,
    url:            row.url as string,
    sourceName:     row.source_name as string | null,
    publishedAt:    row.published_at as string,
    topics:         row.topics as string[],
    sentimentLabel: row.sentiment_label as 'positive' | 'negative' | 'neutral' | null,
    similarity:     row.similarity as number,
  }));
}
