-- ============================================================
-- GenTrack — Supabase RPC functions for regional trend lines
-- Run this in the Supabase dashboard SQL editor (once only).
-- ============================================================

-- Drops for idempotency
DROP FUNCTION IF EXISTS get_regional_trend(text, text);
DROP FUNCTION IF EXISTS get_subregional_trend(text, text, text);
DROP FUNCTION IF EXISTS get_plant_cf_windows();
DROP FUNCTION IF EXISTS get_plant_annual_cf();


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
-- Returns CF windows per plant (Wind + Solar only) for the
-- Regional Analysis v2 struggle-signal model:
--
--   12-month windows (YoY self-trend):
--     recent_cf  = cap-weighted avg CF over [M-11, M]
--     prior_cf   = cap-weighted avg CF over [M-23, M-12]
--     recent_months / prior_months = non-null data month counts
--
--   6-month half-windows (momentum signal):
--     r2_cf / r2_months  = [M-5, M]       — most recent half-year
--     r1_cf / r1_months  = [M-11, M-6]    — earlier half of recent year
--     p2_cf / p2_months  = [M-17, M-12]   — YoY peer of r2
--     p1_cf / p1_months  = [M-23, M-18]   — YoY peer of r1
--
--   Momentum = (p2_cf − r2_cf) − (p1_cf − r1_cf):
--     positive = decline is accelerating (strongest "why now" signal).
--
-- Frontend tolerates old RPC shape (missing half-window cols → null).
-- Same CF formula as get_regional_trend: mwh / (nameplate * days * 24).
-- NULL mwh rows are excluded (not treated as zero). Nuclear excluded.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_plant_cf_windows()
RETURNS TABLE(
  plant_id      text,
  recent_cf     float8,
  prior_cf      float8,
  recent_months int,
  prior_months  int,
  r2_cf         float8,
  r1_cf         float8,
  p2_cf         float8,
  p1_cf         float8,
  r2_months     int,
  r1_months     int,
  p2_months     int,
  p1_months     int
)
LANGUAGE sql
STABLE
AS $$
  WITH anchor AS (
    SELECT MAX(month) AS max_month FROM monthly_generation
  ),
  bounds AS (
    -- All window edges derived from a single anchor date (max_dt = M).
    -- 12-month windows:
    --   recent  : [M-11, M]
    --   prior   : [M-23, M-12]
    -- 6-month half-windows (YYYY-MM format, day always = 1st of month):
    --   r2      : [M-5, M]
    --   r1      : [M-11, M-6]
    --   p2      : [M-17, M-12]
    --   p1      : [M-23, M-18]
    SELECT
      TO_DATE(max_month, 'YYYY-MM')                                   AS max_dt,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '11 months'           AS recent_start,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '12 months'           AS prior_end,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '23 months'           AS prior_start,
      -- half-window edges
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '5 months'            AS r2_start,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '6 months'            AS r1_end,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '11 months'           AS r1_start,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '12 months'           AS p2_end,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '17 months'           AS p2_start,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '18 months'           AS p1_end,
      TO_DATE(max_month, 'YYYY-MM') - INTERVAL '23 months'           AS p1_start
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
    -- 12-month windows
    AVG(cf.cf_val)  FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.recent_start AND b.max_dt)   AS recent_cf,
    AVG(cf.cf_val)  FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.prior_start  AND b.prior_end) AS prior_cf,
    COUNT(*)        FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.recent_start AND b.max_dt)::int   AS recent_months,
    COUNT(*)        FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.prior_start  AND b.prior_end)::int AS prior_months,
    -- 6-month half-windows for momentum
    AVG(cf.cf_val)  FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.r2_start AND b.max_dt)    AS r2_cf,
    AVG(cf.cf_val)  FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.r1_start AND b.r1_end)    AS r1_cf,
    AVG(cf.cf_val)  FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.p2_start AND b.p2_end)    AS p2_cf,
    AVG(cf.cf_val)  FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.p1_start AND b.p1_end)    AS p1_cf,
    COUNT(*)        FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.r2_start AND b.max_dt)::int   AS r2_months,
    COUNT(*)        FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.r1_start AND b.r1_end)::int   AS r1_months,
    COUNT(*)        FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.p2_start AND b.p2_end)::int   AS p2_months,
    COUNT(*)        FILTER (WHERE cf.cf_val IS NOT NULL AND cf.mdt BETWEEN b.p1_start AND b.p1_end)::int   AS p1_months
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


-- ------------------------------------------------------------
-- get_plant_annual_cf()
-- Phase: 5-year persistence signals.
-- Returns per-plant, per-calendar-year capacity factor and
-- reported-month count for the last 5 complete calendar years
-- (Wind + Solar only; Solar Thermal/CSP excluded).
--
-- Definition:
--   year_cf   = SUM(mwh) / SUM(nameplate_mw * days_in_month * 24)
--               across all non-NULL reported months in that year.
--   month_count = non-NULL months with mwh IS NOT NULL in the year.
--
-- Only calendar years with month_count >= 10 are returned
-- (prevents partial-year bias for oldest and current years).
--
-- Used by regionalAnalysisService to compute:
--   downYears   = consecutive YoY declines ≥ 1 pp ending most recent year
--   slope_pct   = OLS slope in pp/year across ≥4 qualifying annual points
--   persistentDecline = downYears >= 3
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_plant_annual_cf()
RETURNS TABLE(
  plant_id     text,
  year         int,
  year_cf      float8,
  month_count  int
)
LANGUAGE sql
STABLE
AS $$
  WITH year_bounds AS (
    -- 5 most recent complete calendar years (exclude current partial year)
    SELECT generate_series(
      EXTRACT(YEAR FROM CURRENT_DATE)::int - 5,
      EXTRACT(YEAR FROM CURRENT_DATE)::int - 1
    ) AS yr
  ),
  plant_month AS (
    SELECT
      mg.plant_id,
      EXTRACT(YEAR FROM TO_DATE(mg.month, 'YYYY-MM'))::int AS yr,
      CASE
        WHEN mg.mwh IS NULL OR p.nameplate_capacity_mw = 0 THEN NULL
        ELSE mg.mwh
      END AS mwh_val,
      CASE
        WHEN mg.mwh IS NULL OR p.nameplate_capacity_mw = 0 THEN NULL
        ELSE p.nameplate_capacity_mw * (
          EXTRACT(DAY FROM (
            DATE_TRUNC('month', TO_DATE(mg.month, 'YYYY-MM')) + INTERVAL '1 month'
            - DATE_TRUNC('month', TO_DATE(mg.month, 'YYYY-MM'))
          )) * 24
        )
      END AS capacity_hours
    FROM monthly_generation mg
    JOIN plants p ON p.id = mg.plant_id
    WHERE p.fuel_source IN ('Wind', 'Solar')
      AND EXTRACT(YEAR FROM TO_DATE(mg.month, 'YYYY-MM'))::int
          BETWEEN (SELECT MIN(yr) FROM year_bounds)
              AND (SELECT MAX(yr) FROM year_bounds)
  )
  SELECT
    pm.plant_id,
    pm.yr                                       AS year,
    SUM(pm.mwh_val) / NULLIF(SUM(pm.capacity_hours), 0) AS year_cf,
    COUNT(*) FILTER (WHERE pm.mwh_val IS NOT NULL)::int  AS month_count
  FROM plant_month pm
  JOIN year_bounds yb ON yb.yr = pm.yr
  GROUP BY pm.plant_id, pm.yr
  HAVING COUNT(*) FILTER (WHERE pm.mwh_val IS NOT NULL) >= 10
  ORDER BY pm.plant_id, pm.yr;
$$;

GRANT EXECUTE ON FUNCTION get_plant_annual_cf() TO anon, authenticated;

