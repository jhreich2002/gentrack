-- ============================================================
-- GenTrack: Lender/Financing Pipeline — Schema additions
--
-- 1. Add `pipeline` column to news_articles to distinguish
--    general news ('news') from financing ('financing') articles.
-- 2. Add `lender_last_checked_at` to plant_news_state to track
--    the financing pipeline independently from news ingestion.
-- ============================================================

-- ── Pipeline column on news_articles ─────────────────────────────────────────

ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS pipeline text NOT NULL DEFAULT 'news';

CREATE INDEX IF NOT EXISTS idx_news_articles_pipeline
  ON news_articles (pipeline);

-- ── Lender pipeline state tracking ───────────────────────────────────────────

ALTER TABLE plant_news_state
  ADD COLUMN IF NOT EXISTS lender_last_checked_at timestamptz;
