-- ============================================================
-- GenTrack — search_plant_news() RPC function
-- Called from the browser via supabase.rpc('search_plant_news', {...})
-- Run AFTER 002_news_articles.sql
-- ============================================================

-- Drop and recreate if updating (idempotent)
DROP FUNCTION IF EXISTS search_plant_news(text, vector, integer, integer);

CREATE OR REPLACE FUNCTION search_plant_news(
  p_plant_code     text,        -- EIA plant code to filter by
  p_query_embedding vector(768),-- Pre-computed embedding of user's query text
  p_days_back      integer DEFAULT 365,
  p_max_results    integer DEFAULT 10
)
RETURNS TABLE (
  id               uuid,
  title            text,
  description      text,
  url              text,
  source_name      text,
  published_at     timestamptz,
  topics           text[],
  sentiment_label  text,
  similarity       float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    a.id,
    a.title,
    a.description,
    a.url,
    a.source_name,
    a.published_at,
    a.topics,
    a.sentiment_label,
    1 - (a.embedding <=> p_query_embedding) AS similarity
  FROM news_articles a
  WHERE
    p_plant_code = ANY(a.plant_codes)
    AND a.published_at > now() - (p_days_back || ' days')::interval
    AND a.embedding IS NOT NULL
  ORDER BY a.embedding <=> p_query_embedding
  LIMIT p_max_results;
$$;

-- Grant execute to the anon role so the browser client can call it
GRANT EXECUTE ON FUNCTION search_plant_news(text, vector, integer, integer) TO anon;
GRANT EXECUTE ON FUNCTION search_plant_news(text, vector, integer, integer) TO authenticated;
