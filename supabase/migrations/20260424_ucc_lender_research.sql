-- ============================================================
-- UCC-Based Lender Research Workflow Schema
-- Parallel lender identification pipeline using public filing
-- records (state UCC portals, county recorders, EDGAR) rather
-- than news-first discovery. Completely isolated from the
-- existing plant_lenders / lender_stats pipeline.
-- All tables prefixed ucc_ to avoid any collision.
-- ============================================================

-- ── 1. ucc_research_plants ────────────────────────────────────────────────────
-- One row per plant that has been added to the research queue.
-- Tracks overall workflow status across supervisor runs.

CREATE TABLE IF NOT EXISTS ucc_research_plants (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  eia_plant_code      text NOT NULL UNIQUE,
  plant_name          text,
  state               text,
  county              text,
  capacity_mw         numeric,
  fuel_type           text,
  cod_year            integer,
  sponsor_name        text,
  owner_name          text,
  operator_name       text,
  workflow_status     text NOT NULL DEFAULT 'pending'
    CHECK (workflow_status IN ('pending', 'running', 'complete', 'unresolved', 'needs_review')),
  last_run_at         timestamptz,
  last_run_id         uuid,
  total_cost_usd      numeric DEFAULT 0,
  spv_alias_count     integer DEFAULT 0,
  lender_count        integer DEFAULT 0,
  top_confidence      text
    CHECK (top_confidence IN ('confirmed', 'highly_likely', 'possible')),
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

ALTER TABLE ucc_research_plants ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_research_plants' AND policyname = 'urp_public_read'
  ) THEN
    CREATE POLICY "urp_public_read" ON ucc_research_plants FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_research_plants' AND policyname = 'urp_service_write'
  ) THEN
    CREATE POLICY "urp_service_write" ON ucc_research_plants FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_urp_plant_code       ON ucc_research_plants (eia_plant_code);
CREATE INDEX IF NOT EXISTS idx_urp_status           ON ucc_research_plants (workflow_status);
CREATE INDEX IF NOT EXISTS idx_urp_last_run         ON ucc_research_plants (last_run_at DESC NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_urp_top_confidence   ON ucc_research_plants (top_confidence);
CREATE INDEX IF NOT EXISTS idx_urp_state            ON ucc_research_plants (state);

-- ── 2. ucc_entities ───────────────────────────────────────────────────────────
-- All named entities encountered: SPVs, sponsors, lenders, agents.
-- Normalized names allow cross-plant deduplication and sponsor history.

CREATE TABLE IF NOT EXISTS ucc_entities (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_name       text NOT NULL,
  entity_type       text NOT NULL
    CHECK (entity_type IN ('spv', 'sponsor', 'lender', 'agent', 'trustee', 'other')),
  normalized_name   text NOT NULL,
  parent_company    text,
  jurisdiction      text,
  source            text
    CHECK (source IN ('opencorporates', 'sos_scrape', 'ucc_filing', 'county_record', 'edgar', 'perplexity', 'algorithmic')),
  source_url        text,
  created_at        timestamptz DEFAULT now(),
  UNIQUE (normalized_name, entity_type, jurisdiction)
);

ALTER TABLE ucc_entities ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_entities' AND policyname = 'ue_public_read'
  ) THEN
    CREATE POLICY "ue_public_read" ON ucc_entities FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_entities' AND policyname = 'ue_service_write'
  ) THEN
    CREATE POLICY "ue_service_write" ON ucc_entities FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ue_entity_type         ON ucc_entities (entity_type);
CREATE INDEX IF NOT EXISTS idx_ue_normalized_name     ON ucc_entities (normalized_name);
CREATE INDEX IF NOT EXISTS idx_ue_parent_company      ON ucc_entities (parent_company);

-- ── 3. ucc_plant_entities ─────────────────────────────────────────────────────
-- Links plants to entities with relationship type and confidence.
-- A plant may link to multiple SPV candidates at different confidence levels.

CREATE TABLE IF NOT EXISTS ucc_plant_entities (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_code        text NOT NULL,
  entity_id         bigint NOT NULL REFERENCES ucc_entities(id) ON DELETE CASCADE,
  relationship_type text NOT NULL
    CHECK (relationship_type IN ('spv', 'sponsor', 'lender', 'agent')),
  confidence_score  integer NOT NULL DEFAULT 0
    CHECK (confidence_score >= 0 AND confidence_score <= 100),
  source            text,
  created_at        timestamptz DEFAULT now(),
  UNIQUE (plant_code, entity_id, relationship_type)
);

ALTER TABLE ucc_plant_entities ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_plant_entities' AND policyname = 'upe_public_read'
  ) THEN
    CREATE POLICY "upe_public_read" ON ucc_plant_entities FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_plant_entities' AND policyname = 'upe_service_write'
  ) THEN
    CREATE POLICY "upe_service_write" ON ucc_plant_entities FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_upe_plant_code         ON ucc_plant_entities (plant_code);
CREATE INDEX IF NOT EXISTS idx_upe_entity_id          ON ucc_plant_entities (entity_id);
CREATE INDEX IF NOT EXISTS idx_upe_relationship       ON ucc_plant_entities (relationship_type);
CREATE INDEX IF NOT EXISTS idx_upe_confidence         ON ucc_plant_entities (confidence_score DESC);

-- ── 4. ucc_filings ────────────────────────────────────────────────────────────
-- Raw filing records from state UCC portals, county recorders, and EDGAR.
-- Preserves the original document text for auditability.

CREATE TABLE IF NOT EXISTS ucc_filings (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_code              text NOT NULL,
  filing_type             text NOT NULL
    CHECK (filing_type IN ('ucc1', 'ucc3_amendment', 'ucc3_termination', 'deed_of_trust', 'mortgage', 'fixture_filing', 'assignment', 'release', 'lease_memorandum', 'edgar_8k', 'edgar_10k', 'edgar_exhibit')),
  state                   text,
  county                  text,
  filing_date             date,
  amendment_date          date,
  termination_date        date,
  debtor_name             text,
  debtor_normalized       text,
  secured_party_name      text,
  secured_party_normalized text,
  is_representative_party boolean DEFAULT false,
  representative_role     text,  -- 'collateral_agent' | 'administrative_agent' | 'trustee'
  collateral_text         text,
  loan_amount_usd         numeric,
  maturity_text           text,
  source_url              text,
  raw_text                text,
  filing_number           text,
  worker_name             text NOT NULL,
  run_id                  uuid,
  created_at              timestamptz DEFAULT now()
);

ALTER TABLE ucc_filings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_filings' AND policyname = 'uf_public_read'
  ) THEN
    CREATE POLICY "uf_public_read" ON ucc_filings FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_filings' AND policyname = 'uf_service_write'
  ) THEN
    CREATE POLICY "uf_service_write" ON ucc_filings FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_uf_plant_code          ON ucc_filings (plant_code);
CREATE INDEX IF NOT EXISTS idx_uf_filing_type         ON ucc_filings (filing_type);
CREATE INDEX IF NOT EXISTS idx_uf_debtor_normalized   ON ucc_filings (debtor_normalized);
CREATE INDEX IF NOT EXISTS idx_uf_secured_party       ON ucc_filings (secured_party_normalized);
CREATE INDEX IF NOT EXISTS idx_uf_filing_date         ON ucc_filings (filing_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_uf_run_id              ON ucc_filings (run_id);
CREATE INDEX IF NOT EXISTS idx_uf_state               ON ucc_filings (state);

-- ── 5. ucc_lender_links ───────────────────────────────────────────────────────
-- Final lender attributions per plant, written only after reviewer approval.
-- These are the outputs that appear in the UI and drive the lead generation view.

CREATE TABLE IF NOT EXISTS ucc_lender_links (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_code          text NOT NULL,
  lender_entity_id    bigint REFERENCES ucc_entities(id) ON DELETE SET NULL,
  lender_name         text NOT NULL,
  lender_normalized   text NOT NULL,
  confidence_class    text NOT NULL
    CHECK (confidence_class IN ('confirmed', 'highly_likely', 'possible')),
  evidence_type       text NOT NULL
    CHECK (evidence_type IN ('direct_filing', 'county_record', 'edgar', 'sponsor_pattern', 'supplement')),
  evidence_summary    text,
  source_url          text,
  filing_id           bigint REFERENCES ucc_filings(id) ON DELETE SET NULL,
  human_approved      boolean,
  review_action_id    bigint,
  run_id              uuid,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  UNIQUE (plant_code, lender_normalized, evidence_type)
);

ALTER TABLE ucc_lender_links ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_lender_links' AND policyname = 'ull_public_read'
  ) THEN
    CREATE POLICY "ull_public_read" ON ucc_lender_links FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_lender_links' AND policyname = 'ull_service_write'
  ) THEN
    CREATE POLICY "ull_service_write" ON ucc_lender_links FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ull_plant_code         ON ucc_lender_links (plant_code);
CREATE INDEX IF NOT EXISTS idx_ull_lender_normalized  ON ucc_lender_links (lender_normalized);
CREATE INDEX IF NOT EXISTS idx_ull_confidence         ON ucc_lender_links (confidence_class);
CREATE INDEX IF NOT EXISTS idx_ull_human_approved     ON ucc_lender_links (human_approved);
CREATE INDEX IF NOT EXISTS idx_ull_run_id             ON ucc_lender_links (run_id);
CREATE INDEX IF NOT EXISTS idx_ull_lender_entity      ON ucc_lender_links (lender_entity_id);

-- ── 6. ucc_sponsor_history ────────────────────────────────────────────────────
-- Accumulates confirmed sponsor→lender pairings across all plants.
-- Grows richer over time — used by the supplement worker to infer likely
-- lenders on plants where direct filing evidence is incomplete.

CREATE TABLE IF NOT EXISTS ucc_sponsor_history (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sponsor_normalized  text NOT NULL,
  lender_normalized   text NOT NULL,
  sponsor_entity_id   bigint REFERENCES ucc_entities(id) ON DELETE SET NULL,
  lender_entity_id    bigint REFERENCES ucc_entities(id) ON DELETE SET NULL,
  observed_count      integer NOT NULL DEFAULT 1,
  first_seen          timestamptz DEFAULT now(),
  last_seen           timestamptz DEFAULT now(),
  plant_codes         text[] DEFAULT '{}',
  UNIQUE (sponsor_normalized, lender_normalized)
);

ALTER TABLE ucc_sponsor_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_sponsor_history' AND policyname = 'ush_public_read'
  ) THEN
    CREATE POLICY "ush_public_read" ON ucc_sponsor_history FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_sponsor_history' AND policyname = 'ush_service_write'
  ) THEN
    CREATE POLICY "ush_service_write" ON ucc_sponsor_history FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ush_sponsor           ON ucc_sponsor_history (sponsor_normalized);
CREATE INDEX IF NOT EXISTS idx_ush_lender            ON ucc_sponsor_history (lender_normalized);
CREATE INDEX IF NOT EXISTS idx_ush_count             ON ucc_sponsor_history (observed_count DESC);

-- ── 7. ucc_risk_overlay ───────────────────────────────────────────────────────
-- Per-plant curtailment risk context. Populated from existing curtailment data.
-- Drives the outreach priority score in the Lender Leads view.

CREATE TABLE IF NOT EXISTS ucc_risk_overlay (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_code              text NOT NULL UNIQUE,
  curtailment_proxy_score numeric,
  congestion_region       text,
  queue_context           text,
  merchant_exposure_flag  boolean DEFAULT false,
  distress_score          numeric,
  iso_rto                 text,
  notes                   text,
  updated_at              timestamptz DEFAULT now()
);

ALTER TABLE ucc_risk_overlay ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_risk_overlay' AND policyname = 'uro_public_read'
  ) THEN
    CREATE POLICY "uro_public_read" ON ucc_risk_overlay FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_risk_overlay' AND policyname = 'uro_service_write'
  ) THEN
    CREATE POLICY "uro_service_write" ON ucc_risk_overlay FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_uro_plant_code         ON ucc_risk_overlay (plant_code);
CREATE INDEX IF NOT EXISTS idx_uro_curtailment        ON ucc_risk_overlay (curtailment_proxy_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_uro_iso_rto            ON ucc_risk_overlay (iso_rto);

-- ── 8. ucc_agent_runs ─────────────────────────────────────────────────────────
-- One row per plant per supervisor execution. Tracks overall run state,
-- cost, and final outcome. Equivalent to agent_run_log in the existing pipeline.

CREATE TABLE IF NOT EXISTS ucc_agent_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_code          text NOT NULL,
  supervisor_status   text NOT NULL DEFAULT 'running'
    CHECK (supervisor_status IN ('running', 'complete', 'unresolved', 'needs_review', 'failed', 'budget_exceeded')),
  mode                text NOT NULL DEFAULT 'single'
    CHECK (mode IN ('single', 'bulk')),
  started_at          timestamptz DEFAULT now(),
  completed_at        timestamptz,
  final_outcome       text,
  total_cost_usd      numeric DEFAULT 0,
  plants_attempted    integer DEFAULT 1,
  lenders_found       integer DEFAULT 0,
  entity_retries      integer DEFAULT 0,
  ucc_retries         integer DEFAULT 0,
  county_retries      integer DEFAULT 0,
  supplement_skipped  boolean DEFAULT false,
  error_message       text
);

ALTER TABLE ucc_agent_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_agent_runs' AND policyname = 'uar_public_read'
  ) THEN
    CREATE POLICY "uar_public_read" ON ucc_agent_runs FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_agent_runs' AND policyname = 'uar_service_write'
  ) THEN
    CREATE POLICY "uar_service_write" ON ucc_agent_runs FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_uar_plant_code         ON ucc_agent_runs (plant_code);
CREATE INDEX IF NOT EXISTS idx_uar_status             ON ucc_agent_runs (supervisor_status);
CREATE INDEX IF NOT EXISTS idx_uar_started_at         ON ucc_agent_runs (started_at DESC);

-- ── 9. ucc_agent_tasks ────────────────────────────────────────────────────────
-- One row per worker dispatch within a supervisor run.
-- Stores the structured JSON output for debugging and audit.

CREATE TABLE IF NOT EXISTS ucc_agent_tasks (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id              uuid NOT NULL REFERENCES ucc_agent_runs(id) ON DELETE CASCADE,
  plant_code          text NOT NULL,
  agent_type          text NOT NULL
    CHECK (agent_type IN ('entity_worker', 'ucc_records_worker', 'county_worker', 'edgar_worker', 'supplement_worker', 'reviewer')),
  attempt_number      integer NOT NULL DEFAULT 1,
  task_status         text NOT NULL
    CHECK (task_status IN ('success', 'partial', 'failed')),
  completion_score    integer
    CHECK (completion_score >= 0 AND completion_score <= 100),
  evidence_found      boolean DEFAULT false,
  llm_fallback_used   boolean DEFAULT false,
  cost_usd            numeric DEFAULT 0,
  duration_ms         integer,
  error_reason        text,
  retry_reason        text,
  output_json         jsonb,
  created_at          timestamptz DEFAULT now()
);

ALTER TABLE ucc_agent_tasks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_agent_tasks' AND policyname = 'uat_public_read'
  ) THEN
    CREATE POLICY "uat_public_read" ON ucc_agent_tasks FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_agent_tasks' AND policyname = 'uat_service_write'
  ) THEN
    CREATE POLICY "uat_service_write" ON ucc_agent_tasks FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_uat_run_id             ON ucc_agent_tasks (run_id);
CREATE INDEX IF NOT EXISTS idx_uat_plant_code         ON ucc_agent_tasks (plant_code);
CREATE INDEX IF NOT EXISTS idx_uat_agent_type         ON ucc_agent_tasks (agent_type);
CREATE INDEX IF NOT EXISTS idx_uat_status             ON ucc_agent_tasks (task_status);
CREATE INDEX IF NOT EXISTS idx_uat_llm_fallback       ON ucc_agent_tasks (llm_fallback_used);

-- ── 10. ucc_evidence_records ──────────────────────────────────────────────────
-- Every piece of evidence found by every worker, with full provenance.
-- source_type distinguishes direct scrapes from LLM-extracted results.

CREATE TABLE IF NOT EXISTS ucc_evidence_records (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_code          text NOT NULL,
  run_id              uuid REFERENCES ucc_agent_runs(id) ON DELETE SET NULL,
  lender_entity_id    bigint REFERENCES ucc_entities(id) ON DELETE SET NULL,
  source_type         text NOT NULL
    CHECK (source_type IN ('ucc_scrape', 'county_scrape', 'edgar', 'opencorporates', 'sos_scrape', 'perplexity', 'gemini', 'sponsor_pattern')),
  source_url          text,
  excerpt             text,
  raw_text            text,
  extracted_fields    jsonb DEFAULT '{}',
  worker_name         text NOT NULL,
  confidence_contribution text
    CHECK (confidence_contribution IN ('confirmed', 'highly_likely', 'possible')),
  review_status       text DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  created_at          timestamptz DEFAULT now()
);

ALTER TABLE ucc_evidence_records ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_evidence_records' AND policyname = 'uer_public_read'
  ) THEN
    CREATE POLICY "uer_public_read" ON ucc_evidence_records FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_evidence_records' AND policyname = 'uer_service_write'
  ) THEN
    CREATE POLICY "uer_service_write" ON ucc_evidence_records FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_uer_plant_code         ON ucc_evidence_records (plant_code);
CREATE INDEX IF NOT EXISTS idx_uer_run_id             ON ucc_evidence_records (run_id);
CREATE INDEX IF NOT EXISTS idx_uer_source_type        ON ucc_evidence_records (source_type);
CREATE INDEX IF NOT EXISTS idx_uer_worker_name        ON ucc_evidence_records (worker_name);
CREATE INDEX IF NOT EXISTS idx_uer_lender_entity      ON ucc_evidence_records (lender_entity_id);
CREATE INDEX IF NOT EXISTS idx_uer_review_status      ON ucc_evidence_records (review_status);

-- ── 11. ucc_review_actions ────────────────────────────────────────────────────
-- Human review decisions on lender attributions.
-- Written when a reviewer approves, rejects, or requests rerun.

CREATE TABLE IF NOT EXISTS ucc_review_actions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_code          text NOT NULL,
  lender_link_id      bigint REFERENCES ucc_lender_links(id) ON DELETE CASCADE,
  action              text NOT NULL
    CHECK (action IN ('approve', 'reject', 'rerun', 'needs_more')),
  notes               text,
  reviewer_email      text,
  timestamp           timestamptz DEFAULT now()
);

ALTER TABLE ucc_review_actions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_review_actions' AND policyname = 'ura_public_read'
  ) THEN
    CREATE POLICY "ura_public_read" ON ucc_review_actions FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_review_actions' AND policyname = 'ura_service_write'
  ) THEN
    CREATE POLICY "ura_service_write" ON ucc_review_actions FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ura_plant_code         ON ucc_review_actions (plant_code);
CREATE INDEX IF NOT EXISTS idx_ura_lender_link        ON ucc_review_actions (lender_link_id);
CREATE INDEX IF NOT EXISTS idx_ura_action             ON ucc_review_actions (action);
CREATE INDEX IF NOT EXISTS idx_ura_timestamp          ON ucc_review_actions (timestamp DESC);

-- ── 12. ucc_test_cases ────────────────────────────────────────────────────────
-- Benchmark dataset with known or partially known ground truth.
-- Seeded from existing plant_lenders high-confidence rows at deploy time.

CREATE TABLE IF NOT EXISTS ucc_test_cases (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_code            text NOT NULL,
  plant_name            text,
  expected_lender       text NOT NULL,
  expected_confidence   text NOT NULL
    CHECK (expected_confidence IN ('confirmed', 'highly_likely', 'possible')),
  ground_truth_source   text,
  benchmark_status      text NOT NULL DEFAULT 'active'
    CHECK (benchmark_status IN ('active', 'retired')),
  notes                 text,
  created_at            timestamptz DEFAULT now()
);

ALTER TABLE ucc_test_cases ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_test_cases' AND policyname = 'utc_public_read'
  ) THEN
    CREATE POLICY "utc_public_read" ON ucc_test_cases FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_test_cases' AND policyname = 'utc_service_write'
  ) THEN
    CREATE POLICY "utc_service_write" ON ucc_test_cases FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_utc_plant_code         ON ucc_test_cases (plant_code);
CREATE INDEX IF NOT EXISTS idx_utc_status             ON ucc_test_cases (benchmark_status);

-- ── 13. ucc_test_results ──────────────────────────────────────────────────────
-- Per-run evaluation results against test cases.
-- Metrics gate promotion of results to the Lender Leads outreach view.

CREATE TABLE IF NOT EXISTS ucc_test_results (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id                uuid REFERENCES ucc_agent_runs(id) ON DELETE CASCADE,
  test_case_id          bigint NOT NULL REFERENCES ucc_test_cases(id) ON DELETE CASCADE,
  passed                boolean,
  lender_found          boolean DEFAULT false,
  confidence_matched    boolean DEFAULT false,
  precision_flag        boolean,
  recall_flag           boolean,
  llm_fallback_used     boolean DEFAULT false,
  source_traced         boolean DEFAULT false,
  notes                 text,
  created_at            timestamptz DEFAULT now()
);

ALTER TABLE ucc_test_results ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_test_results' AND policyname = 'utr_public_read'
  ) THEN
    CREATE POLICY "utr_public_read" ON ucc_test_results FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_test_results' AND policyname = 'utr_service_write'
  ) THEN
    CREATE POLICY "utr_service_write" ON ucc_test_results FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_utr_run_id             ON ucc_test_results (run_id);
CREATE INDEX IF NOT EXISTS idx_utr_test_case          ON ucc_test_results (test_case_id);
CREATE INDEX IF NOT EXISTS idx_utr_passed             ON ucc_test_results (passed);
