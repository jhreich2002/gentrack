-- v5.5: Filter lender research to plants with current generation data
-- Adds has_current_generation_data boolean to plants, backfills it via a
-- correlated subquery, and rebuilds the 3 v5.4 lender views so that all
-- lender-level counts reflect only plants whose generation is current
-- through the global MAX(month) in monthly_generation.
--
-- Per-plant Financing tab (v_plant_financing, lenderService.ts) is intentionally
-- NOT modified — existing evidence remains visible at the individual plant level.

-- ============================================================
-- 1. Column + backfill
-- ============================================================
ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS has_current_generation_data boolean NOT NULL DEFAULT false;

-- Backfill: true iff the plant has at least one non-null mwh row at the
-- global max month. Plants with no generation data at all stay false.
UPDATE public.plants p
SET has_current_generation_data = COALESCE(
  (
    SELECT MAX(g.month) >= (SELECT MAX(month) FROM monthly_generation)
    FROM monthly_generation g
    WHERE g.plant_id = p.id
      AND g.mwh IS NOT NULL
  ),
  false
);

CREATE INDEX IF NOT EXISTS idx_plants_curtailed_current
  ON public.plants (is_likely_curtailed, has_current_generation_data)
  WHERE is_likely_curtailed = true AND has_current_generation_data = true;

-- ============================================================
-- 2. Refresh function (called by fetch-eia-data.ts after each EIA pull)
-- ============================================================
CREATE OR REPLACE FUNCTION public.recompute_current_generation_flag()
RETURNS void LANGUAGE sql AS $$
  UPDATE public.plants p
  SET has_current_generation_data = COALESCE(
    (
      SELECT MAX(g.month) >= (SELECT MAX(month) FROM monthly_generation)
      FROM monthly_generation g
      WHERE g.plant_id = p.id
        AND g.mwh IS NOT NULL
    ),
    false
  )
$$;

GRANT EXECUTE ON FUNCTION public.recompute_current_generation_flag()
  TO anon, authenticated, service_role;

-- ============================================================
-- 3. Rebuild v5.4 lender views with has_current_generation_data filter
--    Use DROP + CREATE (not CREATE OR REPLACE) to avoid column-order errors.
-- ============================================================

-- 3a. v_lender_validation_queue
--     Add JOIN to plants + predicate; two others don't currently join plants.
DROP VIEW IF EXISTS public.v_lender_validation_queue CASCADE;
CREATE VIEW public.v_lender_validation_queue AS
SELECT
  lc.id                                                                                   AS lender_id,
  lc.canonical_name                                                                       AS lender_name,
  COUNT(*) FILTER (WHERE pll.validated_at IS NULL AND pll.rejected_at IS NULL)::integer   AS pending_count,
  COUNT(*) FILTER (WHERE pll.validated_at IS NOT NULL)::integer                           AS validated_count,
  COUNT(*) FILTER (WHERE pll.rejected_at  IS NOT NULL)::integer                           AS rejected_count,
  COUNT(DISTINCT pll.plant_id)::integer                                                   AS distinct_plant_count,
  MAX(pll.created_at)                                                                     AS most_recent_link_at
FROM public.lenders_canonical lc
JOIN public.plant_lender_links pll ON pll.lender_id = lc.id
JOIN public.plants p ON p.id = pll.plant_id
WHERE lc.is_tax_equity = false
  AND p.has_current_generation_data = true
GROUP BY lc.id, lc.canonical_name
HAVING COUNT(*) FILTER (WHERE pll.validated_at IS NULL AND pll.rejected_at IS NULL) > 0;

-- 3b. v_lender_validated_portfolio
DROP VIEW IF EXISTS public.v_lender_validated_portfolio CASCADE;
CREATE VIEW public.v_lender_validated_portfolio AS
SELECT
  lc.id                                                                                        AS lender_id,
  lc.canonical_name                                                                            AS lender_name,
  lc.pursuit_label,
  lc.pursuit_set_at,
  COUNT(*) FILTER (WHERE pll.validated_at IS NOT NULL)::integer                               AS validated_count,
  COUNT(DISTINCT pll.plant_id) FILTER (WHERE pll.validated_at IS NOT NULL)::integer           AS distinct_validated_plant_count,
  MAX(pll.validated_at)                                                                        AS most_recent_validation_at
FROM public.lenders_canonical lc
JOIN public.plant_lender_links pll ON pll.lender_id = lc.id
JOIN public.plants p ON p.id = pll.plant_id
WHERE lc.is_tax_equity = false
  AND p.has_current_generation_data = true
GROUP BY lc.id, lc.canonical_name, lc.pursuit_label, lc.pursuit_set_at
HAVING COUNT(*) FILTER (WHERE pll.validated_at IS NOT NULL) > 0;

-- 3c. v_lender_plant_summary (already joins plants — just add WHERE predicate)
DROP VIEW IF EXISTS public.v_lender_plant_summary CASCADE;
CREATE VIEW public.v_lender_plant_summary AS
SELECT
  pll.id                                                    AS link_id,
  pll.lender_id,
  pll.plant_id,
  p.name                                                    AS plant_name,
  p.state,
  p.nameplate_capacity_mw,
  pll.role,
  pll.role_summary,
  pll.source_url,
  pll.evidence_quote,
  pll.is_manual,
  pll.manual_note,
  pll.validated_at,
  pll.rejected_at,
  pll.rejection_reason,
  pll.created_at,
  plr.completed_at                                          AS last_research_at,
  CASE
    WHEN pll.validated_at IS NOT NULL THEN 'validated'
    WHEN pll.rejected_at  IS NOT NULL THEN 'rejected'
    ELSE 'pending'
  END                                                       AS validation_state
FROM public.plant_lender_links pll
JOIN public.plants p ON p.id = pll.plant_id
LEFT JOIN public.plant_lender_research plr ON plr.id = pll.research_id
WHERE p.has_current_generation_data = true;
