-- ============================================================
-- GenTrack: Drop EDGAR pipeline tables
--
-- The SEC EDGAR extraction pipeline (lender_pipeline/) is replaced
-- by the RSS-based lender-ingest edge function. These tables are
-- no longer populated or read.
-- ============================================================

DROP TABLE IF EXISTS plant_lenders      CASCADE;
DROP TABLE IF EXISTS edgar_filings_seen CASCADE;
