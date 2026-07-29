-- ============================================================
-- GenTrack — Supabase RPC functions for regional trend lines
-- Run this in the Supabase dashboard SQL editor (once only).
-- ============================================================

-- Drops for idempotency
DROP FUNCTION IF EXISTS get_regional_trend(text, text);
DROP FUNCTION IF EXISTS get_subregional_trend(text, text, text);
DROP FUNCTION IF EXISTS get_plant_cf_windows();


-- ------------------------------------------------------------
-- get_regional_trend(p_region, p_fuel_source)
-- Returns monthly average capacity factor across all plants
-- in the given ISO/RTO region with the given fuel source.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_regional_trend(p_region text, p_fuel_source text)
RETURNS TABLE(month text, avg_factor float8)
LANGUAGE sql
STABLE
AS $$
  SELECT
    mg.month,
    AVG(
      CASE
        WHEN mg.mwh IS NULL OR p.nameplate_capacity_mw = 0 THEN NULL
        ELSE mg.mwh / (
          p.nameplate_capacity_mw *
          (EXTRACT(DAY FROM (
            DATE_TRUNC('month', TO_DATE(mg.month, 'YYYY-MM')) + INTERVAL '1 month'
            - DATE_TRUNC('month', TO_DATE(mg.month, 'YYYY-MM'))
          )) * 24)
        )
      END
    ) AS avg_factor
  FROM monthly_generation mg
  JOIN plants p ON p.id = mg.plant_id
  WHERE p.region = p_region
    AND p.fuel_source = p_fuel_source
  GROUP BY mg.month
  ORDER BY mg.month;
$$;


-- ------------------------------------------------------------
-- get_subregional_trend(p_region, p_sub_region, p_fuel_source)
-- Same as above but further filtered to a sub-region (balancing
-- authority / zone) within the ISO/RTO.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_subregional_trend(p_region text, p_sub_region text, p_fuel_source text)
RETURNS TABLE(month text, avg_factor float8)
LANGUAGE sql
STABLE
AS $$
  SELECT
    mg.month,
    AVG(
      CASE
        WHEN mg.mwh IS NULL OR p.nameplate_capacity_mw = 0 THEN NULL
        ELSE mg.mwh / (
          p.nameplate_capacity_mw *
          (EXTRACT(DAY FROM (
            DATE_TRUNC('month', TO_DATE(mg.month, 'YYYY-MM')) + INTERVAL '1 month'
            - DATE_TRUNC('month', TO_DATE(mg.month, 'YYYY-MM'))
          )) * 24)
        )
      END
    ) AS avg_factor
  FROM monthly_generation mg
  JOIN plants p ON p.id = mg.plant_id
  WHERE p.region = p_region
    AND p.sub_region = p_sub_region
    AND p.fuel_source = p_fuel_source
  GROUP BY mg.month
  ORDER BY mg.month;
$$;


-- Grant anonymous access (needed for the browser client with anon key)
GRANT EXECUTE ON FUNCTION get_regional_trend(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_subregional_trend(text, text, text) TO anon, authenticated;


-- ------------------------------------------------------------
-- get_plant_cf_windows()
-- Returns two 12-month CF windows per plant (Wind + Solar only):
--   recent_cf = avg CF over the 12 months ending at MAX(month)
--   prior_cf  = avg CF over the 12 months immediately before that
-- Used by the Regional Analysis tab to compute deterioration
-- (prior_cf − recent_cf) as the primary distress signal.
--
-- Same CF formula as get_regional_trend: mwh / (nameplate * days * 24).
-- NULL mwh rows are excluded (not treated as zero).
-- Nuclear is excluded — the Regional Analysis feature only screens
-- Wind + Solar.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_plant_cf_windows()
RETURNS TABLE(
  plant_id text,
  recent_cf float8,
  prior_cf float8,
  recent_months int,
  prior_months int
)
LANGUAGE sql
STABLE
AS $$
  WITH anchor AS (
    SELECT MAX(month) AS max_month FROM monthly_generation
  ),
  bounds AS (
    -- Compute anchor month as a date, then derive window edges.
    -- recent window = 12 months ending at max_month (inclusive):
    --   months in [max_month - 11, max_month]
    -- prior window  = 12 months before that:
    --   months in [max_month - 23, max_month - 12]
    SELECT
      TO_DATE(max_month, 'YYYY-MM') AS max_dt,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '11 months' AS recent_start,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '12 months' AS prior_end,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '23 months' AS prior_start
    FROM anchor
  ),
  cf AS (
    SELECT
      mg.plant_id,
      TO_DATE(mg.month, 'YYYY-MM') AS mdt,
      CASE
        WHEN mg.mwh IS NULL OR p.nameplate_capacity_mw = 0 THEN NULL
        ELSE mg.mwh / (
          p.nameplate_capacity_mw *
          (EXTRACT(DAY FROM (
            DATE_TRUNC('month', TO_DATE(mg.month, 'YYYY-MM')) + INTERVAL '1 month'
            - DATE_TRUNC('month', TO_DATE(mg.month, 'YYYY-MM'))
          )) * 24)
        )
      END AS cf_val
    FROM monthly_generation mg
    JOIN plants p ON p.id = mg.plant_id
    WHERE p.fuel_source IN ('Wind', 'Solar')
  )
  SELECT
    cf.plant_id,
    AVG(cf.cf_val) FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.recent_start AND b.max_dt)   AS recent_cf,
    AVG(cf.cf_val) FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.prior_start  AND b.prior_end) AS prior_cf,
    COUNT(*)      FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.recent_start AND b.max_dt)::int AS recent_months,
    COUNT(*)      FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.prior_start  AND b.prior_end)::int AS prior_months
  FROM cf CROSS JOIN bounds b
  GROUP BY cf.plant_id
  HAVING
    COUNT(*) FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.recent_start AND b.max_dt) > 0
    OR
    COUNT(*) FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.prior_start  AND b.prior_end) > 0;
$$;

GRANT EXECUTE ON FUNCTION get_plant_cf_windows() TO anon, authenticated;


-- ------------------------------------------------------------
-- get_subregion_monthly_cf(p_region, p_fuel_source)
-- Phase 3 — Sub-region sparklines.
-- Returns capacity-weighted monthly CF for each sub-region
-- within the given ISO, for the last 24 calendar months.
-- One call per region replaces N calls per sub-region.
--
-- Note: when techFilter is "Both" the frontend passes Wind by
-- default; call twice (Wind + Solar) if a blended sparkline is
-- needed in future.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS get_subregion_monthly_cf(text, text);
CREATE OR REPLACE FUNCTION get_subregion_monthly_cf(p_region text, p_fuel_source text)
RETURNS TABLE(sub_region text, month text, cap_weighted_cf float8)
LANGUAGE sql
STABLE
AS $$
  SELECT
    p.sub_region,
    mg.month,
    -- Capacity-weighted CF: SUM(mwh) / SUM(nameplate_hours) across sub-region
    SUM(
      CASE WHEN mg.mwh IS NULL OR p.nameplate_capacity_mw = 0 THEN NULL ELSE mg.mwh END
    ) /
    NULLIF(
      SUM(
        CASE WHEN mg.mwh IS NULL OR p.nameplate_capacity_mw = 0 THEN NULL
          ELSE p.nameplate_capacity_mw * (
            EXTRACT(DAY FROM (
              DATE_TRUNC('month', TO_DATE(mg.month, 'YYYY-MM')) + INTERVAL '1 month'
              - DATE_TRUNC('month', TO_DATE(mg.month, 'YYYY-MM'))
            )) * 24
          )
        END
      ), 0
    ) AS cap_weighted_cf
  FROM monthly_generation mg
  JOIN plants p ON p.id = mg.plant_id
  WHERE p.region      = p_region
    AND p.fuel_source = p_fuel_source
    AND mg.month     >= TO_CHAR(CURRENT_DATE - INTERVAL '24 months', 'YYYY-MM')
  GROUP BY p.sub_region, mg.month
  ORDER BY p.sub_region, mg.month;
$$;

GRANT EXECUTE ON FUNCTION get_subregion_monthly_cf(text, text) TO anon, authenticated;
