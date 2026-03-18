-- Recreate plant_lenders with news-extract-compatible schema (no EDGAR deps)
-- Root cause fix: old schema had NOT NULL EDGAR fields (accession_no FK, filing_type,
-- filing_date, filing_url) that lender-extract never writes → every upsert failed silently.

DROP TABLE IF EXISTS edgar_filings_seen CASCADE;
DROP TABLE IF EXISTS plant_lenders CASCADE;

CREATE TABLE plant_lenders (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  eia_plant_code      text NOT NULL,
  lender_name         text NOT NULL,
  role                text NOT NULL DEFAULT 'lender'
    CHECK (role IN ('lender','tax_equity','sponsor','co-investor','other')),
  facility_type       text NOT NULL
    CHECK (facility_type IN (
      'term_loan','revolving_credit','construction_loan','tax_equity',
      'bridge_loan','letter_of_credit','other'
    )),
  loan_amount_usd     numeric,
  interest_rate_text  text,
  maturity_text       text,
  confidence          text NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('high','medium','low')),
  source_article_id   uuid,
  source              text NOT NULL DEFAULT 'news_extract',
  extracted_at        timestamptz DEFAULT now(),

  UNIQUE (eia_plant_code, lender_name, facility_type)
);

CREATE INDEX idx_plant_lenders_plant   ON plant_lenders (eia_plant_code);
CREATE INDEX idx_plant_lenders_lender  ON plant_lenders (lender_name);
CREATE INDEX idx_plant_lenders_role    ON plant_lenders (role);
CREATE INDEX idx_plant_lenders_type    ON plant_lenders (facility_type);

ALTER TABLE plant_lenders ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'plant_lenders' AND policyname = 'plant_lenders_public_read'
  ) THEN
    CREATE POLICY "plant_lenders_public_read" ON plant_lenders FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'plant_lenders' AND policyname = 'plant_lenders_service_write'
  ) THEN
    CREATE POLICY "plant_lenders_service_write" ON plant_lenders FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;
