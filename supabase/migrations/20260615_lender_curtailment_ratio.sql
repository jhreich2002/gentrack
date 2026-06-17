-- ============================================================
-- Lender curtailment ratio (2026-06-15)
-- Adds curtailed_plant_count to v_lender_validation_queue
-- and curtailed_validated_plant_count to v_lender_validated_portfolio.
-- Both views already join plants and respect has_current_generation_data.
-- Apply via Supabase SQL Editor (CLI pooler is unreliable on this project).
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. v_lender_validation_queue
--    Adds: curtailed_plant_count (non-rejected links on curtailed plants)
--    Preserves: all existing columns, has_current_generation_data filter
-- ─────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.v_lender_validation_queue CASCADE;
CREATE VIEW public.v_lender_validation_queue AS
SELECT
  lc.id                                                                                   AS lender_id,
  lc.canonical_name                                                                       AS lender_name,
  COUNT(*) FILTER (WHERE pll.validated_at IS NULL AND pll.rejected_at IS NULL)::integer   AS pending_count,
  COUNT(*) FILTER (WHERE pll.validated_at IS NOT NULL)::integer                           AS validated_count,
  COUNT(*) FILTER (WHERE pll.rejected_at  IS NOT NULL)::integer                           AS rejected_count,
  COUNT(DISTINCT pll.plant_id)::integer                                                   AS distinct_plant_count,
  COUNT(DISTINCT pll.plant_id)
    FILTER (WHERE pll.rejected_at IS NULL AND p.is_likely_curtailed = true)::integer      AS curtailed_plant_count,
  MAX(pll.created_at)                                                                     AS most_recent_link_at
FROM public.lenders_canonical lc
JOIN public.plant_lender_links pll ON pll.lender_id = lc.id
JOIN public.plants p ON p.id = pll.plant_id
WHERE lc.is_tax_equity = false
  AND p.has_current_generation_data = true
GROUP BY lc.id, lc.canonical_name
HAVING COUNT(*) FILTER (WHERE pll.validated_at IS NULL AND pll.rejected_at IS NULL) > 0;

GRANT SELECT ON public.v_lender_validation_queue TO authenticated, anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. v_lender_validated_portfolio
--    Adds: curtailed_validated_plant_count (validated links on curtailed plants)
--    Preserves: all existing columns, has_current_generation_data filter
-- ─────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.v_lender_validated_portfolio CASCADE;
CREATE VIEW public.v_lender_validated_portfolio AS
SELECT
  lc.id                                                                                        AS lender_id,
  lc.canonical_name                                                                            AS lender_name,
  lc.pursuit_label,
  lc.pursuit_set_at,
  COUNT(*) FILTER (WHERE pll.validated_at IS NOT NULL)::integer                               AS validated_count,
  COUNT(DISTINCT pll.plant_id) FILTER (WHERE pll.validated_at IS NOT NULL)::integer           AS distinct_validated_plant_count,
  COUNT(DISTINCT pll.plant_id)
    FILTER (WHERE pll.validated_at IS NOT NULL AND p.is_likely_curtailed = true)::integer     AS curtailed_validated_plant_count,
  MAX(pll.validated_at)                                                                        AS most_recent_validation_at
FROM public.lenders_canonical lc
JOIN public.plant_lender_links pll ON pll.lender_id = lc.id
JOIN public.plants p ON p.id = pll.plant_id
WHERE lc.is_tax_equity = false
  AND p.has_current_generation_data = true
GROUP BY lc.id, lc.canonical_name, lc.pursuit_label, lc.pursuit_set_at
HAVING COUNT(*) FILTER (WHERE pll.validated_at IS NOT NULL) > 0;

GRANT SELECT ON public.v_lender_validated_portfolio TO authenticated, anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. v_lender_plant_summary — re-grant after CASCADE
--    No structural change; CASCADE from queue drop may have removed it.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views
     WHERE table_schema = 'public' AND table_name = 'v_lender_plant_summary'
  ) THEN
    EXECUTE 'GRANT SELECT ON public.v_lender_plant_summary TO authenticated, anon';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. v_admin_lender_digest_state — recreate after CASCADE
--    v_lender_validated_portfolio DROP CASCADE silently drops this view.
--    Recreate it here so the Admin "Validated Lender Digests" panel works.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_admin_lender_digest_state AS
SELECT
  lc.id                                          AS lender_id,
  lc.canonical_name                              AS lender_name,
  vp.distinct_validated_plant_count              AS validated_plant_count,
  vp.pursuit_label,
  d.generated_at                                 AS last_digest_at,
  d.cost_usd                                     AS last_digest_cost_usd,
  d.model_used,
  d.plant_count                                  AS digest_plant_count,
  CASE
    WHEN d.generated_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - d.generated_at)) / 86400.0
  END                                            AS digest_age_days,
  CASE
    WHEN d.generated_at IS NULL THEN true
    WHEN EXTRACT(EPOCH FROM (now() - d.generated_at)) / 86400.0 > 7 THEN true
    ELSE false
  END                                            AS is_stale
FROM public.lenders_canonical lc
JOIN public.v_lender_validated_portfolio vp ON vp.lender_id = lc.id
LEFT JOIN public.lender_validated_digest d ON d.lender_id = lc.id
WHERE vp.distinct_validated_plant_count > 0
ORDER BY vp.distinct_validated_plant_count DESC;

GRANT SELECT ON public.v_admin_lender_digest_state TO authenticated, anon;
