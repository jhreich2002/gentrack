-- ============================================================
-- GenTrack — news_articles table
-- Run AFTER 001_enable_extensions.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS news_articles (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Dedup key: SHA-256 prefix of the canonical URL (set by ingest job)
  external_id      text        UNIQUE NOT NULL,

  -- Raw article fields from NewsAPI.org "everything" endpoint
  title            text        NOT NULL,
  description      text,
  content          text,       -- may be truncated (NewsAPI free tier)
  source_name      text,
  url              text        NOT NULL,
  published_at     timestamptz NOT NULL,

  -- Which coarse query string produced this article (e.g. "NextEra Energy power plant")
  query_tag        text,

  -- Plant/owner linkage derived in the ingest job by scanning title+description
  plant_codes      text[]      NOT NULL DEFAULT '{}',   -- EIA plant codes matched
  owner_names      text[]      NOT NULL DEFAULT '{}',   -- owner/operator names matched
  states           text[]      NOT NULL DEFAULT '{}',   -- US state abbreviations matched
  fuel_types       text[]      NOT NULL DEFAULT '{}',   -- Wind|Solar|Nuclear matched

  -- Keyword-derived classification (cheap, no LLM needed)
  topics           text[]      NOT NULL DEFAULT '{}',   -- outage|regulatory|financial|weather|construction|other
  sentiment_label  text        CHECK (sentiment_label IN ('positive','negative','neutral')),

  -- Gemini text-embedding-004 (768-dim), filled by embed-articles job
  embedding        vector(768),
  embedded_at      timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

-- Fast lookup of all articles for a given plant code
CREATE INDEX IF NOT EXISTS idx_news_articles_plant_codes
  ON news_articles USING GIN (plant_codes);

-- Fast lookup of all articles for a given owner name
CREATE INDEX IF NOT EXISTS idx_news_articles_owner_names
  ON news_articles USING GIN (owner_names);

-- Date range filtering (used by all rating windows)
CREATE INDEX IF NOT EXISTS idx_news_articles_published_at
  ON news_articles (published_at DESC);

-- Only articles that still need embeddings (partial index — tiny footprint)
CREATE INDEX IF NOT EXISTS idx_news_articles_unembedded
  ON news_articles (created_at)
  WHERE embedded_at IS NULL;

-- Approximate nearest-neighbour search on embeddings.
-- IVFFlat is lighter than HNSW on free-tier Supabase RAM.
-- Create AFTER you have at least ~500 rows (index needs training data).
-- If you run this migration before data exists, it will still succeed but
-- recall may be slightly lower until the first VACUUM ANALYZE.
CREATE INDEX IF NOT EXISTS idx_news_articles_embedding
  ON news_articles USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE news_articles ENABLE ROW LEVEL SECURITY;

-- Public read (anon browser client can read articles for the News tab)
CREATE POLICY "news_articles: public read"
  ON news_articles FOR SELECT
  USING (true);

-- No insert/update/delete policy = only service role key can write
