-- ============================================================
-- GenTrack: Add source_url to plant_lenders
--
-- Stores the best-matched citation URL per lender row so the
-- UI can link directly to the source without relying on the
-- broken title/snippet heuristic against plant_financing_summary.citations.
-- ============================================================

ALTER TABLE plant_lenders
  ADD COLUMN IF NOT EXISTS source_url text;
