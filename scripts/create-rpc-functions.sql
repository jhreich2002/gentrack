-- ============================================================
-- GenTrack — Supabase RPC functions for regional trend lines
-- Run this in the Supabase dashboard SQL editor (once only).
-- ============================================================

-- Drops for idempotency
DROP FUNCTION IF EXISTS get_regional_trend(text, text);
DROP FUNCTION IF EXISTS get_subregional_trend(text, text, text);


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
