-- Fix v_plant_financing and v_admin_plant_research_state to show only latest-research
-- links per plant. Previously both views showed ALL historical links, causing stale
-- lenders (e.g. DOE, "Other Debt") from older prompt versions to appear even after
-- a newer run found different/no lenders.

CREATE OR REPLACE VIEW public.v_plant_financing AS
WITH latest_research AS (
  SELECT DISTINCT ON (plant_id)
    id AS research_id,
    plant_id,
    completed_at,
    status
  FROM public.plant_lender_research
  WHERE completed_at IS NOT NULL
  ORDER BY plant_id, completed_at DESC
)
SELECT
  pll.plant_id,
  lc.canonical_name AS lender_name,
  pll.role,
  pll.role_summary,
  pll.source_url,
  pll.evidence_quote,
  (pll.inferred_from_sibling_plant_id IS NOT NULL) AS inferred,
  pll.inferred_from_sibling_plant_id,
  lr.completed_at AS last_research_at,
  lr.status AS research_status
FROM latest_research lr
JOIN public.plant_lender_links pll ON pll.research_id = lr.research_id
JOIN public.lenders_canonical lc ON lc.id = pll.lender_id
WHERE lc.is_tax_equity = false;

CREATE OR REPLACE VIEW public.v_admin_plant_research_state AS
WITH latest_research AS (
  SELECT DISTINCT ON (plant_id)
    id, plant_id, status, completed_at
  FROM public.plant_lender_research
  WHERE completed_at IS NOT NULL
  ORDER BY plant_id, completed_at DESC
)
SELECT
  p.id AS plant_id,
  p.name AS plant_name,
  p.state,
  p.nameplate_capacity_mw,
  p.is_likely_curtailed,
  lr.completed_at AS last_research_at,
  lr.status AS last_status,
  COALESCE(COUNT(pll.id), 0)::integer AS lender_count,
  CASE
    WHEN lr.completed_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - lr.completed_at)) / 86400.0
  END AS days_since_research
FROM public.plants p
LEFT JOIN latest_research lr ON lr.plant_id = p.id
LEFT JOIN public.plant_lender_links pll ON pll.research_id = lr.id
GROUP BY p.id, p.name, p.state, p.nameplate_capacity_mw, p.is_likely_curtailed, lr.completed_at, lr.status;
