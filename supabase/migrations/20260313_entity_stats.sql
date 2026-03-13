-- ============================================================
-- GenTrack: Entity Stats Tables
--
-- Creates aggregate tables for lender and tax equity investor
-- entities, derived from plant_lenders (high/medium confidence).
-- Populated nightly by the refresh-entity-stats edge function.
-- ============================================================

-- ── lender_stats ─────────────────────────────────────────────────────────────
-- One row per unique lender name (non-tax-equity facility types).

CREATE TABLE IF NOT EXISTS lender_stats (
  lender_name            text        PRIMARY KEY,
  asset_count            integer     NOT NULL DEFAULT 0,
  total_exposure_usd     numeric,
  plant_codes            text[]      NOT NULL DEFAULT '{}',
  facility_types         text[]      NOT NULL DEFAULT '{}',
  avg_plant_cf           numeric,
  pct_curtailed          numeric,
  news_sentiment_score   numeric,            -- 0–100 (% positive articles × 100)
  distress_score         numeric,            -- 0–100 composite
  relevance_scores       jsonb       DEFAULT '{}',  -- { restructuring, transactions, disputes, market_strategy }
  analysis_text          text,               -- cached LLM advisory briefing
  analysis_angle_bullets text[]      DEFAULT '{}',  -- cached LLM FTI bullets
  analysis_updated_at    timestamptz,
  last_news_date         timestamptz,
  computed_at            timestamptz DEFAULT now()
);

ALTER TABLE lender_stats ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='lender_stats' AND policyname='lender_stats_public_read') THEN
    CREATE POLICY "lender_stats_public_read" ON lender_stats FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='lender_stats' AND policyname='lender_stats_service_write') THEN
    CREATE POLICY "lender_stats_service_write" ON lender_stats FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lender_stats_distress
  ON lender_stats (distress_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_lender_stats_exposure
  ON lender_stats (total_exposure_usd DESC NULLS LAST);

-- ── tax_equity_stats ──────────────────────────────────────────────────────────
-- One row per unique tax equity investor name (facility_type = 'tax_equity').

CREATE TABLE IF NOT EXISTS tax_equity_stats (
  investor_name          text        PRIMARY KEY,
  asset_count            integer     NOT NULL DEFAULT 0,
  total_committed_usd    numeric,
  plant_codes            text[]      NOT NULL DEFAULT '{}',
  portfolio_avg_cf       numeric,
  portfolio_benchmark_cf numeric,            -- weighted avg regional benchmark CF
  pct_curtailed          numeric,
  news_sentiment_score   numeric,
  distress_score         numeric,
  relevance_scores       jsonb       DEFAULT '{}',
  analysis_text          text,
  analysis_angle_bullets text[]      DEFAULT '{}',
  analysis_updated_at    timestamptz,
  last_news_date         timestamptz,
  computed_at            timestamptz DEFAULT now()
);

ALTER TABLE tax_equity_stats ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tax_equity_stats' AND policyname='tax_equity_stats_public_read') THEN
    CREATE POLICY "tax_equity_stats_public_read" ON tax_equity_stats FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tax_equity_stats' AND policyname='tax_equity_stats_service_write') THEN
    CREATE POLICY "tax_equity_stats_service_write" ON tax_equity_stats FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tax_equity_stats_distress
  ON tax_equity_stats (distress_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_tax_equity_stats_committed
  ON tax_equity_stats (total_committed_usd DESC NULLS LAST);
