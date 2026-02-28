-- ============================================================
-- GenTrack — plant_news_ratings table
-- Precomputed risk scores per plant, refreshed nightly
-- Run AFTER 002_news_articles.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS plant_news_ratings (
  eia_plant_code   text        PRIMARY KEY,

  -- Count windows
  articles_30d     integer     NOT NULL DEFAULT 0,
  negative_30d     integer     NOT NULL DEFAULT 0,
  outage_30d       integer     NOT NULL DEFAULT 0,

  articles_90d     integer     NOT NULL DEFAULT 0,
  negative_90d     integer     NOT NULL DEFAULT 0,
  outage_90d       integer     NOT NULL DEFAULT 0,

  articles_365d    integer     NOT NULL DEFAULT 0,
  negative_365d    integer     NOT NULL DEFAULT 0,
  outage_365d      integer     NOT NULL DEFAULT 0,

  -- Composite risk score: 0 = no signal, 100 = max risk
  -- Formula: outage_30d*12 + neg_30d*4 + outage_90d*4 + neg_90d*1.5 + outage_365d*1 + neg_365d*0.5, capped at 100
  news_risk_score  numeric(5,2) NOT NULL DEFAULT 0,

  -- IDs of top ≤5 most impactful articles (negative or outage, most recent first)
  top_article_ids  uuid[]       NOT NULL DEFAULT '{}',

  computed_at      timestamptz  NOT NULL DEFAULT now()
);

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE plant_news_ratings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plant_news_ratings: public read" ON plant_news_ratings;
CREATE POLICY "plant_news_ratings: public read"
  ON plant_news_ratings FOR SELECT
  USING (true);
