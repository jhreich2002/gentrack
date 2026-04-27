-- ── Pipeline v2 — status constraint expansion ────────────────────────────────
--
-- Adds the new workflow_status values introduced in Phase 1 and 6:
--   partial         — pipeline ran but only news-article leads found (no filings)
--   budget_exceeded — run halted before all plants processed (budget hit)
--
-- Also adds source_type values for DOE LPO and FERC evidence records.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop the old workflow_status CHECK constraint and replace with expanded version
ALTER TABLE ucc_research_plants
  DROP CONSTRAINT IF EXISTS ucc_research_plants_workflow_status_check;

ALTER TABLE ucc_research_plants
  ADD CONSTRAINT ucc_research_plants_workflow_status_check
  CHECK (workflow_status IN (
    'pending',
    'running',
    'complete',
    'unresolved',
    'needs_review',
    'partial',
    'budget_exceeded'
  ));

-- 2. Drop the old evidence_type CHECK on ucc_lender_leads_unverified and expand
ALTER TABLE ucc_lender_leads_unverified
  DROP CONSTRAINT IF EXISTS ucc_lender_leads_unverified_evidence_type_check;

ALTER TABLE ucc_lender_leads_unverified
  ADD CONSTRAINT ucc_lender_leads_unverified_evidence_type_check
  CHECK (evidence_type IN (
    'inferred',
    'sponsor_pattern',
    'web_scrape',
    'llm_inference',
    'news',
    'news_article',
    'doe_lpo',
    'ferc'
  ));

-- 3. Seed trusted domains for DOE LPO and FERC if the table exists
-- (Safe to re-run; uses DO block to avoid duplicates)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ucc_trusted_domains'
  ) THEN
    INSERT INTO ucc_trusted_domains (domain, enabled, notes)
    VALUES
      ('energy.gov',         true, 'DOE Loan Programs Office — federal public record'),
      ('elibrary.ferc.gov',  true, 'FERC eLibrary — regulatory filings')
    ON CONFLICT (domain) DO NOTHING;
  END IF;
END $$;
