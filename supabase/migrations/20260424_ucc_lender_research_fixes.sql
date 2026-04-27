-- ============================================================
-- UCC Lender Research — Schema Fix Migration
-- Corrects mismatches between the initial migration and the
-- edge function implementations:
--   1. ucc_research_plants: rename eia_plant_code → plant_code
--   2. ucc_lender_links: relax NULLs, fix evidence_type CHECK,
--      add unique on (plant_code, lender_entity_id)
--   3. ucc_entities.source: broaden CHECK for new source values
--   4. ucc_evidence_records.source_type: add sponsor_history, web_scrape
--   5. ucc_sponsor_history: add UNIQUE on (sponsor_entity_id, lender_entity_id)
--   6. ucc_filings: add is_current column
--   7. ucc_test_results: add UNIQUE on (test_case_id, run_id)
-- ============================================================

-- ── 1. ucc_research_plants: rename eia_plant_code → plant_code ───────────────

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ucc_research_plants' AND column_name = 'eia_plant_code'
  ) THEN
    ALTER TABLE ucc_research_plants RENAME COLUMN eia_plant_code TO plant_code;
  END IF;
END $$;

-- Drop old index if it still references the old name, recreate
DROP INDEX IF EXISTS idx_urp_plant_code;
CREATE UNIQUE INDEX IF NOT EXISTS idx_urp_plant_code ON ucc_research_plants (plant_code);

-- ── 2. ucc_lender_links ──────────────────────────────────────────────────────

-- Make lender_name / lender_normalized nullable (reviewer derives them via join)
ALTER TABLE ucc_lender_links
  ALTER COLUMN lender_name DROP NOT NULL,
  ALTER COLUMN lender_normalized DROP NOT NULL;

-- Drop old unique constraint that used evidence_type (reviewer doesn't write it)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ucc_lender_links_plant_code_lender_normalized_evidence_type_key'
  ) THEN
    ALTER TABLE ucc_lender_links
      DROP CONSTRAINT ucc_lender_links_plant_code_lender_normalized_evidence_type_key;
  END IF;
END $$;

-- Add unique constraint on (plant_code, lender_entity_id) — what the reviewer uses for upsert
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ucc_lender_links_plant_lender_entity_key'
  ) THEN
    ALTER TABLE ucc_lender_links
      ADD CONSTRAINT ucc_lender_links_plant_lender_entity_key
      UNIQUE (plant_code, lender_entity_id);
  END IF;
END $$;

-- Replace evidence_type CHECK to match what reviewer writes ('direct' | 'inferred')
ALTER TABLE ucc_lender_links DROP CONSTRAINT IF EXISTS ucc_lender_links_evidence_type_check;
ALTER TABLE ucc_lender_links
  ADD CONSTRAINT ucc_lender_links_evidence_type_check
  CHECK (evidence_type IN ('direct', 'inferred', 'direct_filing', 'county_record', 'edgar', 'sponsor_pattern', 'supplement'));

-- ── 3. ucc_entities: broaden source CHECK ────────────────────────────────────

ALTER TABLE ucc_entities DROP CONSTRAINT IF EXISTS ucc_entities_source_check;
ALTER TABLE ucc_entities
  ADD CONSTRAINT ucc_entities_source_check
  CHECK (source IN (
    'opencorporates', 'sos_scrape', 'ucc_filing', 'county_record', 'county_scrape',
    'edgar', 'perplexity', 'algorithmic', 'web_scrape', 'sponsor_history',
    'supplement_worker', 'sponsor_pattern'
  ));

-- ── 4. ucc_evidence_records: broaden source_type CHECK ───────────────────────

ALTER TABLE ucc_evidence_records DROP CONSTRAINT IF EXISTS ucc_evidence_records_source_type_check;
ALTER TABLE ucc_evidence_records
  ADD CONSTRAINT ucc_evidence_records_source_type_check
  CHECK (source_type IN (
    'ucc_scrape', 'county_scrape', 'edgar', 'opencorporates', 'sos_scrape',
    'perplexity', 'gemini', 'sponsor_pattern', 'sponsor_history', 'web_scrape'
  ));

-- ── 5. ucc_sponsor_history: add unique constraint on (sponsor_entity_id, lender_entity_id) ──

-- The supplement worker upserts on this pair; PostgREST onConflict needs a real constraint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ucc_sponsor_history_sponsor_lender_entities_key'
  ) THEN
    ALTER TABLE ucc_sponsor_history
      ADD CONSTRAINT ucc_sponsor_history_sponsor_lender_entities_key
      UNIQUE (sponsor_entity_id, lender_entity_id);
  END IF;
END $$;

-- ── 6. ucc_filings: add is_current column ────────────────────────────────────

ALTER TABLE ucc_filings
  ADD COLUMN IF NOT EXISTS is_current boolean DEFAULT true;

-- ── 7. ucc_test_results: add unique on (test_case_id, run_id) ────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ucc_test_results_test_case_run_key'
  ) THEN
    ALTER TABLE ucc_test_results
      ADD CONSTRAINT ucc_test_results_test_case_run_key
      UNIQUE (test_case_id, run_id);
  END IF;
END $$;

-- ── 8. Seed ucc_research_plants from existing plants table ───────────────────
-- Auto-populate so the UI has plants to show without manual seeding.
-- Only inserts plants not already in the research queue.

INSERT INTO ucc_research_plants (
  plant_code, plant_name, state, county, capacity_mw,
  fuel_type, cod_year, workflow_status
)
SELECT
  p.eia_plant_code,
  p.name,
  p.state,
  p.county,
  p.nameplate_capacity_mw,
  p.fuel_source,
  CASE
    WHEN p.cod ~ '^\d{4}$'            THEN p.cod::integer
    WHEN p.cod ~ '^\d{4}-\d{2}$'      THEN LEFT(p.cod, 4)::integer
    WHEN p.cod ~ '^\d{4}-\d{2}-\d{2}' THEN EXTRACT(YEAR FROM p.cod::date)::integer
    ELSE NULL
  END,
  'pending'
FROM plants p
WHERE NOT EXISTS (
  SELECT 1 FROM ucc_research_plants r WHERE r.plant_code = p.eia_plant_code
)
ON CONFLICT (plant_code) DO NOTHING;

-- ── 9. Seed ucc_test_cases from existing plant_lenders (high-confidence) ─────
-- Pull up to 20 plants with known lenders for benchmark testing.

INSERT INTO ucc_test_cases (plant_code, plant_name, expected_lender, expected_confidence, ground_truth_source, benchmark_status, notes)
SELECT
  pl.eia_plant_code,
  p.name,
  pl.lender_name,
  CASE
    WHEN pl.confidence = 'high'   THEN 'confirmed'
    WHEN pl.confidence = 'medium' THEN 'highly_likely'
    ELSE 'possible'
  END,
  'plant_lenders',
  'active',
  'Seeded from existing plant_lenders pipeline for benchmark validation'
FROM plant_lenders pl
JOIN plants p ON p.eia_plant_code = pl.eia_plant_code
WHERE pl.confidence IN ('high', 'medium')
  AND pl.lender_name IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ucc_test_cases tc
    WHERE tc.plant_code = pl.eia_plant_code
      AND tc.expected_lender = pl.lender_name
  )
LIMIT 20;
