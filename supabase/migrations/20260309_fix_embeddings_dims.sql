-- Fix: Recreate news_embeddings with vector(3072) for gemini-embedding-001
DROP FUNCTION IF EXISTS match_news_embeddings;
DROP TABLE IF EXISTS news_embeddings;

CREATE TABLE news_embeddings (
  chunk_id       text        PRIMARY KEY,
  article_hash   text        NOT NULL,
  article_url    text        NOT NULL,
  plant_id       text        NOT NULL,
  owner          text        DEFAULT '',
  lenders        text[]      DEFAULT '{}',
  lender_ids     text[]      DEFAULT '{}',
  published_date text        DEFAULT '',
  sentiment      text        DEFAULT 'neutral',
  sentiment_score real       DEFAULT 0.5,
  chunk_text     text        NOT NULL,
  chunk_index    int         DEFAULT 0,
  title          text        DEFAULT '',
  source         text        DEFAULT '',
  embedding      vector(3072),
  created_at     timestamptz DEFAULT now()
);

CREATE INDEX idx_ne_plant_id   ON news_embeddings (plant_id);
CREATE INDEX idx_ne_sentiment  ON news_embeddings (sentiment);
CREATE INDEX idx_ne_pub_date   ON news_embeddings (published_date);
CREATE INDEX idx_ne_article    ON news_embeddings (article_hash);
CREATE INDEX idx_ne_lender_ids ON news_embeddings USING gin (lender_ids);

CREATE OR REPLACE FUNCTION match_news_embeddings(
  query_embedding     vector(3072),
  match_count         int DEFAULT 10,
  filter_plant_id     text DEFAULT NULL,
  filter_lender_id    text DEFAULT NULL,
  filter_sentiment    text DEFAULT NULL,
  filter_date_from    text DEFAULT NULL,
  filter_date_to      text DEFAULT NULL
)
RETURNS TABLE (
  chunk_id text, chunk_text text, similarity float,
  article_url text, article_hash text, plant_id text,
  owner text, lenders text[], lender_ids text[],
  published_date text, sentiment text, sentiment_score real,
  title text, source text
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT ne.chunk_id, ne.chunk_text,
    1 - (ne.embedding <=> query_embedding) AS similarity,
    ne.article_url, ne.article_hash, ne.plant_id,
    ne.owner, ne.lenders, ne.lender_ids,
    ne.published_date, ne.sentiment, ne.sentiment_score,
    ne.title, ne.source
  FROM news_embeddings ne
  WHERE
    (filter_plant_id  IS NULL OR ne.plant_id  = filter_plant_id)
    AND (filter_sentiment IS NULL OR ne.sentiment = filter_sentiment)
    AND (filter_date_from IS NULL OR ne.published_date >= filter_date_from)
    AND (filter_date_to   IS NULL OR ne.published_date <= filter_date_to)
    AND (filter_lender_id IS NULL OR filter_lender_id = ANY(ne.lender_ids))
    AND ne.embedding IS NOT NULL
  ORDER BY ne.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
