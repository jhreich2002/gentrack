-- ============================================================
-- Day 1 — "Power Asset Brain" LLM Schema
--
-- 1. Extend news_articles with LLM classification columns
-- 2. Create plant_news_state  (per-plant summary cache)
-- 3. Create company_stats     (nightly-computed sponsor metrics)
-- ============================================================

-- ── 1. Extend news_articles ──────────────────────────────────────────────────
ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS event_type            text,
  ADD COLUMN IF NOT EXISTS impact_tags           text[]      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS fti_relevance_tags    text[]      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS importance            text        DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS entity_company_names  text[]      DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS llm_classified_at     timestamptz;

-- Index the high-value filter columns
CREATE INDEX IF NOT EXISTS idx_news_articles_event_type
  ON news_articles (event_type);

CREATE INDEX IF NOT EXISTS idx_news_articles_importance
  ON news_articles (importance);

CREATE INDEX IF NOT EXISTS idx_news_articles_fti_tags
  ON news_articles USING GIN (fti_relevance_tags);

CREATE INDEX IF NOT EXISTS idx_news_articles_entity_companies
  ON news_articles USING GIN (entity_company_names);

-- ── 2. plant_news_state ──────────────────────────────────────────────────────
-- Caches per-plant LLM summaries and FTI advisory bullets.
-- Populated by the plant-news-summarize edge function (Day 2).

CREATE TABLE IF NOT EXISTS plant_news_state (
  eia_plant_code          text        PRIMARY KEY,
  last_checked_at         timestamptz,               -- when we last looked for new articles
  summary_text            text,                      -- 1-2 para Gemini-generated situation summary
  fti_angle_bullets       text[]      DEFAULT '{}',  -- 3-5 advisory angle bullets
  summary_last_updated_at timestamptz,               -- when summary was last regenerated
  last_event_types        text[]      DEFAULT '{}',  -- event_types seen in recent articles
  last_sentiment          text,                      -- overall recent sentiment
  created_at              timestamptz DEFAULT now(),
  updated_at              timestamptz DEFAULT now()
);

ALTER TABLE plant_news_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "plant_news_state_public_read"
  ON plant_news_state FOR SELECT USING (true);

CREATE POLICY "plant_news_state_service_write"
  ON plant_news_state FOR ALL USING (auth.role() = 'service_role');

-- ── 3. company_stats ─────────────────────────────────────────────────────────
-- Nightly-materialized metrics per ult_parent (no separate companies table needed).
-- Populated by the company-stats-refresh edge function (Day 4).

CREATE TABLE IF NOT EXISTS company_stats (
  ult_parent_name   text        PRIMARY KEY,
  total_mw          numeric     DEFAULT 0,
  plant_count       integer     DEFAULT 0,
  avg_cf            numeric     DEFAULT 0,
  tech_breakdown    jsonb       DEFAULT '{}',   -- { "Solar": 1200, "Wind": 450, ... }
  state_breakdown   jsonb       DEFAULT '{}',   -- { "CA": 800, "TX": 850, ... }
  event_counts      jsonb       DEFAULT '{}',   -- { "restructuring": 3, "m_and_a": 1, ... }
  relevance_scores  jsonb       DEFAULT '{}',   -- { "restructuring": 72, "transactions": 45, ... }
  computed_at       timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

ALTER TABLE company_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_stats_public_read"
  ON company_stats FOR SELECT USING (true);

CREATE POLICY "company_stats_service_write"
  ON company_stats FOR ALL USING (auth.role() = 'service_role');

-- Helpful index for ranked prospecting queries
CREATE INDEX IF NOT EXISTS idx_company_stats_total_mw
  ON company_stats (total_mw DESC);
