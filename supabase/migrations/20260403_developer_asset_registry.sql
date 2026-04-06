-- ============================================================
-- Developer-First Asset Registry: 5 new tables
-- ============================================================

-- 1. developers
CREATE TABLE IF NOT EXISTS developers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  aliases       TEXT[] DEFAULT '{}',
  entity_type   TEXT CHECK (entity_type IN ('developer','sponsor','IPP','utility')),
  website       TEXT,
  hq_state      TEXT,
  total_mw_claimed    NUMERIC,
  asset_count_discovered INTEGER DEFAULT 0,
  crawl_status  TEXT DEFAULT 'pending' CHECK (crawl_status IN ('pending','running','completed','failed','budget_paused')),
  eia_benchmark_count INTEGER,
  coverage_rate       NUMERIC,
  avg_confidence      NUMERIC,
  verification_pct    NUMERIC,
  change_velocity     NUMERIC,
  total_spend_usd     NUMERIC DEFAULT 0,
  last_pulse_at       TIMESTAMPTZ,
  last_full_crawl_at  TIMESTAMPTZ,
  next_refresh_due    TIMESTAMPTZ,
  last_crawled_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE developers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'developers' AND policyname = 'developers_public_read') THEN
    CREATE POLICY developers_public_read ON developers FOR SELECT USING (true);
  END IF;
END $$;

-- 2. developer_crawl_log
CREATE TABLE IF NOT EXISTS developer_crawl_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id      UUID NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  run_type          TEXT CHECK (run_type IN ('initial','pulse','targeted','full_recrawl','manual','resume_staging')),
  status            TEXT DEFAULT 'running' CHECK (status IN ('running','completed','failed','aborted','budget_paused')),
  phase             TEXT CHECK (phase IN ('discovery','extraction','asset_triage','eia_match','ownership','verification')),
  checkpoint_data   JSONB,
  strategies_used   TEXT[] DEFAULT '{}',
  rounds            INTEGER DEFAULT 0,
  api_calls         JSONB DEFAULT '{}',
  total_cost_usd    NUMERIC DEFAULT 0,
  budget_limit_usd  NUMERIC,
  assets_discovered INTEGER DEFAULT 0,
  assets_graduated  INTEGER DEFAULT 0,
  assets_staged     INTEGER DEFAULT 0,
  assets_updated    INTEGER DEFAULT 0,
  assets_removed    INTEGER DEFAULT 0,
  eia_match_rate    NUMERIC,
  avg_confidence    NUMERIC,
  completion_report JSONB,
  estimated_cost_to_complete NUMERIC,
  started_at        TIMESTAMPTZ DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  error_log         TEXT
);

ALTER TABLE developer_crawl_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'developer_crawl_log' AND policyname = 'crawl_log_public_read') THEN
    CREATE POLICY crawl_log_public_read ON developer_crawl_log FOR SELECT USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crawl_log_developer ON developer_crawl_log(developer_id);
CREATE INDEX IF NOT EXISTS idx_crawl_log_status    ON developer_crawl_log(status);

-- 3. asset_registry (graduated + staging in one table)
CREATE TABLE IF NOT EXISTS asset_registry (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  technology          TEXT CHECK (technology IN ('solar','wind','nuclear','storage','hybrid','hydro','geothermal','biomass')),
  status              TEXT CHECK (status IN ('operating','construction','development','planned','decommissioned')),
  capacity_mw         NUMERIC,
  storage_mw          NUMERIC,
  storage_mwh         NUMERIC,
  is_hybrid           BOOLEAN DEFAULT false,
  state               TEXT,
  county              TEXT,
  lat                 NUMERIC,
  lng                 NUMERIC,
  eia_plant_code      TEXT,
  match_confidence    TEXT CHECK (match_confidence IN ('high','medium','low','none')),
  expected_cod        TEXT,
  acreage             NUMERIC,
  offtaker            TEXT,
  ppa_price_per_mwh   NUMERIC,
  ppa_term_years      INTEGER,
  acquisition_date    DATE,
  acquisition_price_usd NUMERIC,
  previous_owner      TEXT,
  permitting_status   TEXT,
  project_company_name TEXT,
  interconnection_queue_id   TEXT,
  interconnection_status     TEXT,
  confidence_score    NUMERIC CHECK (confidence_score >= 0 AND confidence_score <= 100),
  confidence_breakdown JSONB,
  source_urls         TEXT[] DEFAULT '{}',
  source_types        TEXT[] DEFAULT '{}',
  content_hash        TEXT,
  graduated           BOOLEAN DEFAULT false,
  blocking_reason     TEXT,
  estimated_cost_to_resolve NUMERIC,
  staging_attempts    INTEGER DEFAULT 0,
  crawl_run_id        UUID REFERENCES developer_crawl_log(id) ON DELETE SET NULL,
  verified            BOOLEAN DEFAULT false,
  verified_by         UUID,
  verified_at         TIMESTAMPTZ,
  manual_overrides    JSONB,
  last_refreshed_at   TIMESTAMPTZ DEFAULT now(),
  refresh_source      TEXT CHECK (refresh_source IN ('initial_crawl','monthly_pulse','quarterly_recrawl','manual')),
  discovered_at       TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE asset_registry ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'asset_registry' AND policyname = 'asset_registry_public_read') THEN
    CREATE POLICY asset_registry_public_read ON asset_registry FOR SELECT USING (true);
  END IF;
END $$;

-- Dedup key: lowercase name + state + technology (COALESCE to avoid NULL != NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_registry_dedup
  ON asset_registry (LOWER(name), COALESCE(state, ''), COALESCE(technology, ''));

CREATE INDEX IF NOT EXISTS idx_asset_registry_graduated   ON asset_registry(graduated);
CREATE INDEX IF NOT EXISTS idx_asset_registry_eia         ON asset_registry(eia_plant_code);
CREATE INDEX IF NOT EXISTS idx_asset_registry_crawl_run   ON asset_registry(crawl_run_id);
CREATE INDEX IF NOT EXISTS idx_asset_registry_state       ON asset_registry(state);
CREATE INDEX IF NOT EXISTS idx_asset_registry_technology  ON asset_registry(technology);

-- 4. developer_assets (many-to-many link)
CREATE TABLE IF NOT EXISTS developer_assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id  UUID NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  asset_id      UUID NOT NULL REFERENCES asset_registry(id) ON DELETE CASCADE,
  ownership_pct NUMERIC,
  role          TEXT CHECK (role IN ('developer','sponsor','tax_equity','offtaker','O&M','co-developer')),
  entry_date    DATE,
  exit_date     DATE,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (developer_id, asset_id)
);

ALTER TABLE developer_assets ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'developer_assets' AND policyname = 'developer_assets_public_read') THEN
    CREATE POLICY developer_assets_public_read ON developer_assets FOR SELECT USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_developer_assets_developer ON developer_assets(developer_id);
CREATE INDEX IF NOT EXISTS idx_developer_assets_asset     ON developer_assets(asset_id);

-- 5. developer_changelog
CREATE TABLE IF NOT EXISTS developer_changelog (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id  UUID NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  change_type   TEXT CHECK (change_type IN ('asset_added','asset_divested','status_change','capacity_change','ownership_change')),
  asset_id      UUID REFERENCES asset_registry(id) ON DELETE SET NULL,
  old_value     JSONB,
  new_value     JSONB,
  detected_at   TIMESTAMPTZ DEFAULT now(),
  source_urls   TEXT[] DEFAULT '{}',
  detected_by   TEXT CHECK (detected_by IN ('pulse_check','full_recrawl','news_pipeline','manual'))
);

ALTER TABLE developer_changelog ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'developer_changelog' AND policyname = 'developer_changelog_public_read') THEN
    CREATE POLICY developer_changelog_public_read ON developer_changelog FOR SELECT USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_developer_changelog_developer ON developer_changelog(developer_id);
CREATE INDEX IF NOT EXISTS idx_developer_changelog_asset     ON developer_changelog(asset_id);
CREATE INDEX IF NOT EXISTS idx_developer_changelog_detected  ON developer_changelog(detected_at DESC);
