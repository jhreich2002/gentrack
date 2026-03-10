-- ============================================================
-- GenTrack: Plant Lender Intelligence — SEC EDGAR extraction
--
-- Two tables:
--   edgar_filings_seen  — dedup cache (never re-fetch a processed accession)
--   plant_lenders       — one row per lender/facility per plant per filing
-- ============================================================

-- ── Filing dedup cache ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS edgar_filings_seen (
  accession_no     text        PRIMARY KEY,   -- "0001234567-23-000123" normalized with dashes
  cik              text        NOT NULL,
  form_type        text        NOT NULL,      -- "10-K", "8-K", etc.
  filing_date      date        NOT NULL,
  owner_name       text        NOT NULL,      -- as stored in plants.owner
  processed_at     timestamptz DEFAULT now(),
  extraction_count integer     DEFAULT 0      -- number of plant_lenders rows written
);

CREATE INDEX IF NOT EXISTS idx_edgar_filings_cik
  ON edgar_filings_seen (cik, filing_date DESC);

-- ── Main lender intelligence table ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS plant_lenders (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Plant linkage (no FK — eia_plant_code is not unique-constrained on plants)
  eia_plant_code      text        NOT NULL,

  -- Lender / facility details
  lender_name         text        NOT NULL,
  facility_type       text        NOT NULL
    CHECK (facility_type IN (
      'term_loan', 'revolver', 'letter_of_credit',
      'bond', 'tax_equity', 'construction_loan',
      'bridge_loan', 'mezzanine', 'preferred_equity', 'other'
    )),
  loan_amount_usd     numeric,               -- NULL if not stated
  interest_rate_text  text,                  -- e.g. "SOFR + 2.50%", "6.875% fixed"
  maturity_date       date,                  -- NULL if not parseable to a date
  maturity_text       text,                  -- raw text e.g. "5 years from closing"

  -- Source filing provenance
  filing_type         text        NOT NULL,  -- "10-K", "8-K", "EX-10.1", etc.
  filing_date         date        NOT NULL,
  filing_url          text        NOT NULL,
  accession_no        text        NOT NULL
    REFERENCES edgar_filings_seen (accession_no),

  -- LLM output
  excerpt_text        text,                  -- ≤500-char supporting passage
  confidence          text        NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('high', 'medium', 'low')),
  extracted_at        timestamptz DEFAULT now(),

  -- Soft-dedup: same plant + lender + facility + filing = same row
  UNIQUE (eia_plant_code, lender_name, facility_type, accession_no)
);

CREATE INDEX IF NOT EXISTS idx_plant_lenders_plant
  ON plant_lenders (eia_plant_code, filing_date DESC);

CREATE INDEX IF NOT EXISTS idx_plant_lenders_lender
  ON plant_lenders (lender_name);

CREATE INDEX IF NOT EXISTS idx_plant_lenders_type
  ON plant_lenders (facility_type);

CREATE INDEX IF NOT EXISTS idx_plant_lenders_confidence
  ON plant_lenders (confidence);

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE plant_lenders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE edgar_filings_seen ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'plant_lenders' AND policyname = 'plant_lenders_public_read'
  ) THEN
    CREATE POLICY "plant_lenders_public_read"
      ON plant_lenders FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'plant_lenders' AND policyname = 'plant_lenders_service_write'
  ) THEN
    CREATE POLICY "plant_lenders_service_write"
      ON plant_lenders FOR ALL USING (auth.role() = 'service_role');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'edgar_filings_seen' AND policyname = 'edgar_filings_seen_public_read'
  ) THEN
    CREATE POLICY "edgar_filings_seen_public_read"
      ON edgar_filings_seen FOR SELECT USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'edgar_filings_seen' AND policyname = 'edgar_filings_seen_service_write'
  ) THEN
    CREATE POLICY "edgar_filings_seen_service_write"
      ON edgar_filings_seen FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
