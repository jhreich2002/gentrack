-- ============================================================
-- Lender Currency Identification Schema
-- Adds loan status tracking, SEC EDGAR CIK map, and agent run log
-- to support the agentic lender currency identification workflow.
-- ============================================================

-- ── 1. Extend plant_lenders with currency tracking columns ────────────────────
-- All new columns are nullable with safe defaults so existing lender-extract
-- and lender-search upsert paths continue to work without modification.
-- loan_status DEFAULT 'unknown' ensures all existing rows satisfy the
-- IN ('active','unknown') filter in refresh-entity-stats until backfill runs.

ALTER TABLE plant_lenders
  ADD COLUMN IF NOT EXISTS loan_status           text DEFAULT 'unknown'
    CHECK (loan_status IN ('active','matured','refinanced','unknown')),
  ADD COLUMN IF NOT EXISTS maturity_date         date,
  ADD COLUMN IF NOT EXISTS financial_close_date  date,
  ADD COLUMN IF NOT EXISTS article_published_at  timestamptz,
  ADD COLUMN IF NOT EXISTS currency_confidence   integer
    CHECK (currency_confidence >= 0 AND currency_confidence <= 100),
  ADD COLUMN IF NOT EXISTS currency_reasoning    text,
  ADD COLUMN IF NOT EXISTS currency_checked_at   timestamptz,
  ADD COLUMN IF NOT EXISTS currency_source       text
    CHECK (currency_source IN ('heuristic','perplexity','edgar','gemini_synthesis','manual')),
  -- Refinancing chain: self-referential by id (bigint PK) rather than compound key,
  -- because a refinanced loan is typically a different facility_type (new row).
  ADD COLUMN IF NOT EXISTS superseded_by         bigint REFERENCES plant_lenders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS supersedes            bigint REFERENCES plant_lenders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS refinanced_at         date;

CREATE INDEX IF NOT EXISTS idx_plant_lenders_loan_status
  ON plant_lenders (loan_status);
CREATE INDEX IF NOT EXISTS idx_plant_lenders_currency_checked
  ON plant_lenders (currency_checked_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_plant_lenders_maturity_date
  ON plant_lenders (maturity_date);

-- ── 2. Add lender_currency_checked_at to plant_news_state ────────────────────
-- Mirrors existing lender_search_checked_at / lender_last_checked_at pattern
-- for independent scheduling of the currency verification pass.

ALTER TABLE plant_news_state
  ADD COLUMN IF NOT EXISTS lender_currency_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_plant_news_state_currency_checked
  ON plant_news_state (lender_currency_checked_at NULLS FIRST);

-- ── 3. owner_cik_map — selective SEC EDGAR re-integration ────────────────────
-- Maps EIA plant owner names to SEC CIK numbers for public companies only.
-- The previous EDGAR pipeline (20260312_drop_edgar.sql) was dropped because
-- it attempted EDGAR for all plants. This table enables selective use only
-- when the owner is a known public company with a seeded CIK.

CREATE TABLE IF NOT EXISTS owner_cik_map (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_name       text NOT NULL,
  cik              text NOT NULL,          -- zero-padded 10-digit SEC CIK
  entity_name      text,                   -- SEC EDGAR canonical entity name
  match_confidence text DEFAULT 'medium'
    CHECK (match_confidence IN ('high','medium','low')),
  verified_at      timestamptz DEFAULT now(),
  notes            text,
  UNIQUE (owner_name, cik)
);

ALTER TABLE owner_cik_map ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'owner_cik_map' AND policyname = 'owner_cik_map_public_read'
  ) THEN
    CREATE POLICY owner_cik_map_public_read ON owner_cik_map FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'owner_cik_map' AND policyname = 'owner_cik_map_service_write'
  ) THEN
    CREATE POLICY owner_cik_map_service_write ON owner_cik_map FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_owner_cik_map_owner ON owner_cik_map (lower(owner_name));
CREATE INDEX IF NOT EXISTS idx_owner_cik_map_cik   ON owner_cik_map (cik);

-- ── 4. agent_run_log — cost and progress tracking ────────────────────────────
-- Modeled on developer_crawl_log from 20260403_developer_asset_registry.sql.
-- The api_calls JSONB keys (perplexity_sonar_pro, gemini_flash) are compatible
-- with the admin_platform_cost_monthly_lines view which already reads these keys
-- from developer_crawl_log.

CREATE TABLE IF NOT EXISTS agent_run_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type        text NOT NULL
    CHECK (agent_type IN (
      'lender_currency_backfill',
      'lender_currency_eia_trigger',
      'lender_currency_quarterly',
      'lender_currency_manual'
    )),
  status            text DEFAULT 'running'
    CHECK (status IN ('running','completed','failed','aborted','budget_paused')),
  trigger_source    text,                   -- 'eia_fetch', 'cron', 'manual', 'backfill_script'
  batch_offset      integer DEFAULT 0,
  batch_size        integer,
  plants_attempted  integer DEFAULT 0,
  plants_heuristic  integer DEFAULT 0,      -- classified by heuristic (no API cost)
  plants_api        integer DEFAULT 0,      -- required Perplexity/Gemini calls
  lenders_updated   integer DEFAULT 0,
  api_calls         jsonb DEFAULT '{}',     -- {perplexity_sonar_pro: 0.00, gemini_flash: 0.00}
  total_cost_usd    numeric DEFAULT 0,
  budget_limit_usd  numeric,
  completion_report jsonb,
  started_at        timestamptz DEFAULT now(),
  completed_at      timestamptz,
  error_log         text
);

ALTER TABLE agent_run_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'agent_run_log' AND policyname = 'agent_run_log_public_read'
  ) THEN
    CREATE POLICY agent_run_log_public_read ON agent_run_log FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'agent_run_log' AND policyname = 'agent_run_log_service_write'
  ) THEN
    CREATE POLICY agent_run_log_service_write ON agent_run_log FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_run_log_status  ON agent_run_log (status);
CREATE INDEX IF NOT EXISTS idx_agent_run_log_type    ON agent_run_log (agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_run_log_started ON agent_run_log (started_at DESC);

-- ── 5. Cost reporting view for agent_run_log ─────────────────────────────────
-- Extends the existing admin cost dashboard with lender currency agent spend.
-- Union-compatible with admin_platform_cost_monthly_lines output columns.

CREATE OR REPLACE VIEW admin_currency_agent_cost_monthly AS
SELECT
  date_trunc('month', started_at)::date                             AS month_start,
  agent_type,
  COUNT(*)                                                          AS run_count,
  SUM(total_cost_usd)::numeric(12,4)                               AS total_usd,
  SUM(plants_attempted)                                             AS plants_processed,
  SUM(plants_heuristic)                                             AS plants_heuristic,
  SUM(plants_api)                                                   AS plants_api,
  SUM(lenders_updated)                                              AS lenders_updated,
  SUM(COALESCE((api_calls ->> 'perplexity_sonar_pro')::numeric, 0)) AS perplexity_usd,
  SUM(COALESCE((api_calls ->> 'gemini_flash')::numeric, 0))         AS gemini_usd
FROM agent_run_log
WHERE status = 'completed'
  AND started_at IS NOT NULL
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
