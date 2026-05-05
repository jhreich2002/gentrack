-- ── Priority 1 data-quality enhancements ─────────────────────────────────────
-- P1a: canonical entity resolver — self-referencing FK on ucc_entities so that
--      variant names ("JPMorgan Chase Bank" vs "JPMORGAN CHASE BANK, N.A.") can
--      be collapsed onto a single canonical entity row at review time.
-- P1c: loan vintage — estimated_loan_status on both link tables so the UI can
--      flag evidence from filings > 8 years old as likely_matured.

-- ── P1a: canonical_entity_id ──────────────────────────────────────────────────
ALTER TABLE ucc_entities
  ADD COLUMN IF NOT EXISTS canonical_entity_id BIGINT
    REFERENCES ucc_entities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ue_canonical_entity_id
  ON ucc_entities (canonical_entity_id)
  WHERE canonical_entity_id IS NOT NULL;

-- ── P1c: estimated_loan_status ────────────────────────────────────────────────
ALTER TABLE ucc_lender_links
  ADD COLUMN IF NOT EXISTS estimated_loan_status TEXT
    NOT NULL DEFAULT 'unknown'
    CHECK (estimated_loan_status IN ('active', 'likely_matured', 'unknown'));

ALTER TABLE ucc_lender_leads_unverified
  ADD COLUMN IF NOT EXISTS estimated_loan_status TEXT
    NOT NULL DEFAULT 'unknown'
    CHECK (estimated_loan_status IN ('active', 'likely_matured', 'unknown'));
