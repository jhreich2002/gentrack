-- ============================================================
-- Migration: Add article-level ranking columns to news_articles
-- and plant_summary column to plant_news_state.
--
-- These columns are populated by the plant-news-rank edge function
-- which sits between ingest and embed in the pipeline.
-- ============================================================

-- ── 1. Extend news_articles with ranking fields ─────────────────────────────

ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS asset_linkage_tier      text     CHECK (asset_linkage_tier IN ('high', 'medium', 'none')),
  ADD COLUMN IF NOT EXISTS asset_linkage_rationale text,
  ADD COLUMN IF NOT EXISTS curtailment_relevant    boolean  DEFAULT false,
  ADD COLUMN IF NOT EXISTS curtailment_rationale   text,
  ADD COLUMN IF NOT EXISTS relevance_score         real     DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS include_for_embedding   boolean  DEFAULT false,
  ADD COLUMN IF NOT EXISTS categories              text[]   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tags                    text[]   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS article_summary         text,
  ADD COLUMN IF NOT EXISTS ranked_at               timestamptz;

-- Indexes for the new filter columns
CREATE INDEX IF NOT EXISTS idx_news_articles_linkage_tier
  ON news_articles (asset_linkage_tier);

CREATE INDEX IF NOT EXISTS idx_news_articles_curtailment_relevant
  ON news_articles (curtailment_relevant)
  WHERE curtailment_relevant = true;

CREATE INDEX IF NOT EXISTS idx_news_articles_include_embed
  ON news_articles (include_for_embedding)
  WHERE include_for_embedding = true;

CREATE INDEX IF NOT EXISTS idx_news_articles_relevance_score
  ON news_articles (relevance_score DESC);

CREATE INDEX IF NOT EXISTS idx_news_articles_categories
  ON news_articles USING GIN (categories);

CREATE INDEX IF NOT EXISTS idx_news_articles_tags
  ON news_articles USING GIN (tags);

-- ── 2. Add plant_summary to plant_news_state ────────────────────────────────

ALTER TABLE plant_news_state
  ADD COLUMN IF NOT EXISTS plant_summary       text,
  ADD COLUMN IF NOT EXISTS ranking_last_run_at timestamptz;

-- ── 3. Partial index: unranked articles (for batch processing) ──────────────

CREATE INDEX IF NOT EXISTS idx_news_articles_unranked
  ON news_articles (created_at)
  WHERE ranked_at IS NULL;
