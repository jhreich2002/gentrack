-- ============================================================
-- GenTrack v3 — Phase 1: Sub-region label migration
-- Aligns plants.sub_region to ISO price/load zone names.
--
-- Phase 2: Add history_unreliable column.
--
-- Run in Supabase SQL Editor (safe to run multiple times).
-- After Phase 1, re-run fix-subregions.ts --apply to catch any
-- plants that weren't covered by state mapping (coord-assigned).
-- ============================================================

-- ── Phase 2: Add column (idempotent) ─────────────────────────────
ALTER TABLE plants
  ADD COLUMN IF NOT EXISTS history_unreliable boolean NOT NULL DEFAULT false;

-- ── Phase 1: Sub-region label renames ────────────────────────────

-- ERCOT: Coast → Houston
UPDATE plants SET sub_region = 'Houston'
WHERE region = 'ERCOT' AND sub_region = 'Coast';

-- PJM: Southern → Dominion
UPDATE plants SET sub_region = 'Dominion'
WHERE region = 'PJM' AND sub_region = 'Southern';

-- MISO: split North — WI/MI become East
UPDATE plants SET sub_region = 'East'
WHERE region = 'MISO' AND sub_region = 'North'
  AND state IN ('WI', 'MI');

-- ISO-NE: flatten 3 old zones into new labels
UPDATE plants SET sub_region = 'Northern NE'
WHERE region = 'ISO-NE' AND sub_region = 'Maine/NH';

UPDATE plants SET sub_region = 'Southern NE'
WHERE region = 'ISO-NE' AND sub_region = 'VT/CT/RI'
  AND state IN ('CT', 'RI');

UPDATE plants SET sub_region = 'Northern NE'
WHERE region = 'ISO-NE' AND sub_region = 'VT/CT/RI'
  AND state = 'VT';

-- Massachusetts label stays the same — no UPDATE needed.

-- NYISO: rename zones
UPDATE plants SET sub_region = 'West/Upstate'
WHERE region = 'NYISO' AND sub_region = 'Upstate';

UPDATE plants SET sub_region = 'Capital-Hudson'
WHERE region = 'NYISO' AND sub_region = 'Hudson Valley';

UPDATE plants SET sub_region = 'NYC/LI'
WHERE region = 'NYISO' AND sub_region = 'NYC/Long Island';

-- CAISO and SPP are unchanged — no UPDATE needed.

-- ── Verification: count any remaining stale labels ─────────────
SELECT region, sub_region, count(*) AS n
FROM plants
WHERE (region = 'ERCOT'  AND sub_region = 'Coast')
   OR (region = 'PJM'    AND sub_region = 'Southern')
   OR (region = 'NYISO'  AND sub_region IN ('Upstate','Hudson Valley','NYC/Long Island'))
   OR (region = 'ISO-NE' AND sub_region IN ('Maine/NH','VT/CT/RI'))
GROUP BY region, sub_region
ORDER BY region, sub_region;
-- Expected: 0 rows (all stale labels migrated).
