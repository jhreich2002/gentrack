-- ============================================================
-- GenTrack: Entity News Search RPC
--
-- search_entity_news(entity_name, days_back, limit)
-- Returns news articles where entity_company_names contains
-- the entity name via case-insensitive bidirectional substring match.
-- Used by EntityDetailView to show entity-level news.
-- ============================================================

CREATE OR REPLACE FUNCTION search_entity_news(
  p_entity_name text,
  p_days_back   int  DEFAULT 90,
  p_limit       int  DEFAULT 50
)
RETURNS TABLE (
  id                  text,
  title               text,
  description         text,
  url                 text,
  source_name         text,
  published_at        timestamptz,
  topics              text[],
  sentiment_label     text,
  event_type          text,
  impact_tags         text[],
  fti_relevance_tags  text[],
  importance          text,
  entity_company_names text[],
  article_summary     text,
  relevance_score     real
)
LANGUAGE sql STABLE AS $$
  SELECT
    id, title, description, url, source_name, published_at,
    topics, sentiment_label, event_type, impact_tags, fti_relevance_tags,
    importance, entity_company_names, article_summary, relevance_score
  FROM news_articles
  WHERE published_at >= now() - (p_days_back || ' days')::interval
    AND array_length(entity_company_names, 1) > 0
    AND EXISTS (
      SELECT 1
      FROM unnest(entity_company_names) n
      WHERE n          ILIKE '%' || p_entity_name || '%'
         OR p_entity_name ILIKE '%' || n || '%'
    )
  ORDER BY published_at DESC
  LIMIT p_limit;
$$;

-- Allow public read (same pattern as search_plant_news)
GRANT EXECUTE ON FUNCTION search_entity_news(text, int, int) TO anon, authenticated;
