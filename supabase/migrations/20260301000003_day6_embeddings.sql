-- ============================================================
-- GenTrack Day 6 — pgvector embeddings + search_plant_news RPC
-- Run via Supabase Management API (migration)
-- ============================================================

-- ── Enable pgvector extension ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Add embedding columns to news_articles ───────────────────────────────────
ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS embedding    vector(768),
  ADD COLUMN IF NOT EXISTS embedded_at  timestamptz;

-- ── HNSW index for fast cosine similarity search ─────────────────────────────
-- Only index rows that have embeddings (partial index speeds up build)
CREATE INDEX IF NOT EXISTS news_articles_embedding_hnsw
  ON news_articles USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── search_plant_news() RPC ───────────────────────────────────────────────────
-- Called by the SemanticSearch UI: embed query client-side → call this RPC.
CREATE OR REPLACE FUNCTION search_plant_news(
  p_plant_code       text,
  p_query_embedding  vector(768),
  p_days_back        int     DEFAULT 365,
  p_max_results      int     DEFAULT 10
)
RETURNS TABLE (
  id                   text,
  title                text,
  description          text,
  url                  text,
  source_name          text,
  published_at         timestamptz,
  topics               text[],
  sentiment_label      text,
  event_type           text,
  impact_tags          text[],
  fti_relevance_tags   text[],
  importance           text,
  entity_company_names text[],
  similarity           float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id::text,
    title,
    description,
    url,
    source_name,
    published_at,
    topics,
    sentiment_label,
    event_type,
    impact_tags,
    fti_relevance_tags,
    importance,
    entity_company_names,
    (1 - (embedding <=> p_query_embedding))::float AS similarity
  FROM news_articles
  WHERE
    embedding IS NOT NULL
    AND plant_codes @> ARRAY[p_plant_code]
    AND published_at >= (NOW() - (p_days_back || ' days')::interval)
  ORDER BY embedding <=> p_query_embedding
  LIMIT p_max_results;
$$;

-- Also allow company-level semantic search (no plant_codes filter)
CREATE OR REPLACE FUNCTION search_company_news(
  p_company_name     text,
  p_query_embedding  vector(768),
  p_days_back        int     DEFAULT 365,
  p_max_results      int     DEFAULT 10
)
RETURNS TABLE (
  id                   text,
  title                text,
  description          text,
  url                  text,
  source_name          text,
  published_at         timestamptz,
  topics               text[],
  sentiment_label      text,
  event_type           text,
  fti_relevance_tags   text[],
  importance           text,
  similarity           float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id::text,
    title,
    description,
    url,
    source_name,
    published_at,
    topics,
    sentiment_label,
    event_type,
    fti_relevance_tags,
    importance,
    (1 - (embedding <=> p_query_embedding))::float AS similarity
  FROM news_articles
  WHERE
    embedding IS NOT NULL
    AND entity_company_names @> ARRAY[p_company_name]
    AND published_at >= (NOW() - (p_days_back || ' days')::interval)
  ORDER BY embedding <=> p_query_embedding
  LIMIT p_max_results;
$$;

-- ── pg_cron: embed-articles at 07:00 UTC (1h after news-ingest) ─────────────
SELECT cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'embed-articles-nightly';

SELECT cron.schedule(
  'embed-articles-nightly',
  '0 7 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/embed-articles',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer '|| (select decrypted_secret from vault.decrypted_secrets where name = ''service_role_key'') ||'"}'::jsonb,
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
