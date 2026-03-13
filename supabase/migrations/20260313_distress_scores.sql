-- ============================================================
-- GenTrack: Distress Score Columns
--
-- Adds distress_score (0–100) to plants and company_stats.
-- Computed nightly by compute-ratings → refresh-entity-stats.
--
-- Formula:
--   plant:   curtailment_score × 0.6 + news_risk_score × 0.4
--   entity:  avg_plant_distress × 0.6 + (100 - news_sentiment_score) × 0.4
-- ============================================================

ALTER TABLE plants
  ADD COLUMN IF NOT EXISTS distress_score numeric;

ALTER TABLE company_stats
  ADD COLUMN IF NOT EXISTS distress_score numeric;

-- Indexes for Opportunities tab sorting
CREATE INDEX IF NOT EXISTS idx_plants_distress_score
  ON plants (distress_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_company_stats_distress_score
  ON company_stats (distress_score DESC NULLS LAST);
