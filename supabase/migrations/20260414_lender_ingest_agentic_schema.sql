-- ============================================================
-- Agentic Lender Ingestion Workflow Schema
-- Extends the lender pipeline with multi-source verification,
-- syndicate role tracking, pitch intelligence, and trigger monitoring.
-- Depends on: 20260414_lender_currency_schema.sql
-- ============================================================

-- ── 1. Extend agent_run_log to support new agent types ───────────────────────
-- Must drop and recreate the CHECK constraint (Postgres does not support ALTER CONSTRAINT).

ALTER TABLE agent_run_log DROP CONSTRAINT IF EXISTS agent_run_log_agent_type_check;
ALTER TABLE agent_run_log ADD CONSTRAINT agent_run_log_agent_type_check
  CHECK (agent_type IN (
    'lender_currency_backfill',
    'lender_currency_eia_trigger',
    'lender_currency_quarterly',
    'lender_currency_manual',
    'lender_ingest_full',
    'lender_ingest_incremental',
    'lender_trigger_monitor'
  ));

-- ── 2. Extend plant_lenders with verification and pitch intelligence ─────────

ALTER TABLE plant_lenders
  -- Multi-source verification tracking
  ADD COLUMN IF NOT EXISTS verification_sources     jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS source_count             integer DEFAULT 0
    CHECK (source_count >= 0 AND source_count <= 3),
  ADD COLUMN IF NOT EXISTS source_evidence          jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS verification_checked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS run_log_id               uuid REFERENCES agent_run_log(id) ON DELETE SET NULL,

  -- Enhancement 1: Syndicate role — lead arranger is the pitch target
  ADD COLUMN IF NOT EXISTS syndicate_role           text DEFAULT 'unknown'
    CHECK (syndicate_role IN ('lead_arranger', 'agent_bank', 'participant', 'unknown')),

  -- Enhancement 2: Pitch urgency — combines loan maturity proximity with plant distress
  ADD COLUMN IF NOT EXISTS pitch_urgency_score      integer
    CHECK (pitch_urgency_score >= 0 AND pitch_urgency_score <= 100),

  -- Enhancement 3: Pitch angle — what consulting service to offer this lender
  ADD COLUMN IF NOT EXISTS pitch_angle              text
    CHECK (pitch_angle IN (
      'interconnection_advisory',
      'asset_management',
      'merchant_risk',
      'refinancing_advisory',
      'general_exposure'
    )),
  ADD COLUMN IF NOT EXISTS pitch_angle_reasoning    text;

CREATE INDEX IF NOT EXISTS idx_plant_lenders_verification_checked
  ON plant_lenders (verification_checked_at NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_plant_lenders_source_count
  ON plant_lenders (source_count DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_plant_lenders_pitch_urgency
  ON plant_lenders (pitch_urgency_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_plant_lenders_syndicate_role
  ON plant_lenders (syndicate_role);

-- ── 3. Add lender_ingest_checked_at to plant_news_state ──────────────────────
-- Separate from lender_search_checked_at so both pipelines can coexist.
-- The agentic pipeline writes to both columns for AdminPage counter compatibility.

ALTER TABLE plant_news_state
  ADD COLUMN IF NOT EXISTS lender_ingest_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_plant_news_state_ingest_checked
  ON plant_news_state (lender_ingest_checked_at NULLS FIRST);

-- ── 4. Per-source evidence audit table ───────────────────────────────────────
-- Stores raw evidence text per source per lender row without bloating
-- plant_lenders JSONB columns. Useful for debugging and manual review.

CREATE TABLE IF NOT EXISTS plant_lender_evidence (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_lender_id bigint NOT NULL REFERENCES plant_lenders(id) ON DELETE CASCADE,
  source_type     text NOT NULL
    CHECK (source_type IN ('perplexity', 'gemini', 'heuristic')),
  raw_text        text,
  source_url      text,
  loan_status_vote text
    CHECK (loan_status_vote IN ('active', 'matured', 'refinanced', 'unknown')),
  captured_at     timestamptz DEFAULT now()
);

ALTER TABLE plant_lender_evidence ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'plant_lender_evidence' AND policyname = 'ple_public_read'
  ) THEN
    CREATE POLICY "ple_public_read" ON plant_lender_evidence FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'plant_lender_evidence' AND policyname = 'ple_service_write'
  ) THEN
    CREATE POLICY "ple_service_write" ON plant_lender_evidence FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ple_plant_lender_id
  ON plant_lender_evidence (plant_lender_id);

CREATE INDEX IF NOT EXISTS idx_ple_source_type
  ON plant_lender_evidence (source_type);

-- ── 5. Trigger events table ───────────────────────────────────────────────────
-- Enhancement 6: Weekly monitor writes here when it detects events that make
-- a pitch timely (covenant waivers, accelerating curtailment, ownership changes).

CREATE TABLE IF NOT EXISTS lender_trigger_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  eia_plant_code  text,  -- plain text ref — plants.eia_plant_code may lack unique constraint
  lender_name     text,
  trigger_type    text NOT NULL
    CHECK (trigger_type IN (
      'covenant_waiver',
      'accelerating_curtailment',
      'ownership_change',
      'market_refinancing'
    )),
  evidence        text,
  source_url      text,
  detected_at     timestamptz DEFAULT now(),
  actioned        boolean DEFAULT false
);

ALTER TABLE lender_trigger_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'lender_trigger_events' AND policyname = 'lte_public_read'
  ) THEN
    CREATE POLICY "lte_public_read" ON lender_trigger_events FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'lender_trigger_events' AND policyname = 'lte_service_write'
  ) THEN
    CREATE POLICY "lte_service_write" ON lender_trigger_events FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lte_plant_code
  ON lender_trigger_events (eia_plant_code);

CREATE INDEX IF NOT EXISTS idx_lte_trigger_type
  ON lender_trigger_events (trigger_type);

CREATE INDEX IF NOT EXISTS idx_lte_detected_at
  ON lender_trigger_events (detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_lte_actioned
  ON lender_trigger_events (actioned) WHERE actioned = false;

-- ── 6. Extend lender_stats with portfolio exposure columns ───────────────────
-- Enhancement 5: Populated by refresh-entity-stats after each pipeline run.
-- total_curtailed_mw_exposure — sum of MW across curtailed plants where lender
--   has an active/unknown loan (represents lender's at-risk renewable portfolio).
-- high_urgency_count — plants where pitch_urgency_score >= 60.
-- top_pitch_angle — most common pitch angle across this lender's portfolio.

ALTER TABLE lender_stats
  ADD COLUMN IF NOT EXISTS total_curtailed_mw_exposure  numeric,
  ADD COLUMN IF NOT EXISTS curtailed_plant_count         integer,
  ADD COLUMN IF NOT EXISTS avg_distress_score            numeric,
  ADD COLUMN IF NOT EXISTS high_urgency_count            integer,
  ADD COLUMN IF NOT EXISTS top_pitch_angle               text;

CREATE INDEX IF NOT EXISTS idx_lender_stats_mw_exposure
  ON lender_stats (total_curtailed_mw_exposure DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_lender_stats_urgency
  ON lender_stats (high_urgency_count DESC NULLS LAST);
