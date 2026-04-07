-- Add 'Developer Digests' as a distinct cost line in the cost view.
-- developer-refresh.ts now stores api_calls ->> 'developer_refresh' = total_cost_usd
-- for each refresh run. The unattributed bucket is updated to exclude those amounts.

CREATE OR REPLACE VIEW admin_platform_cost_monthly_lines AS
WITH crawl_monthly AS (
  SELECT
    date_trunc('month', started_at)::date AS month_start,
    SUM(COALESCE((api_calls ->> 'perplexity_sonar')::numeric, 0)
      + COALESCE((api_calls ->> 'perplexity_sonar_pro')::numeric, 0)
      + COALESCE((api_calls ->> 'perplexity_deep_research')::numeric, 0))::numeric(12,2) AS perplexity_usd,
    SUM(COALESCE((api_calls ->> 'gemini_flash')::numeric, 0)
      + COALESCE((api_calls ->> 'gemini_pro')::numeric, 0))::numeric(12,2) AS gemini_usd,
    SUM(COALESCE((api_calls ->> 'developer_refresh')::numeric, 0))::numeric(12,2) AS developer_refresh_usd,
    SUM(COALESCE(total_cost_usd, 0)
      - (COALESCE((api_calls ->> 'perplexity_sonar')::numeric, 0)
      + COALESCE((api_calls ->> 'perplexity_sonar_pro')::numeric, 0)
      + COALESCE((api_calls ->> 'perplexity_deep_research')::numeric, 0)
      + COALESCE((api_calls ->> 'gemini_flash')::numeric, 0)
      + COALESCE((api_calls ->> 'gemini_pro')::numeric, 0)
      + COALESCE((api_calls ->> 'developer_refresh')::numeric, 0)))::numeric(12,2) AS unattributed_variable_usd
  FROM developer_crawl_log
  WHERE started_at IS NOT NULL
  GROUP BY 1
),
variable_lines AS (
  SELECT month_start, 'Perplexity API'::text AS service_name, 'variable'::text AS cost_type, perplexity_usd AS amount_usd
  FROM crawl_monthly
  UNION ALL
  SELECT month_start, 'Gemini API'::text, 'variable'::text, gemini_usd
  FROM crawl_monthly
  UNION ALL
  SELECT month_start, 'Developer Digests'::text, 'variable'::text, developer_refresh_usd
  FROM crawl_monthly
  UNION ALL
  SELECT month_start, 'Other Variable Usage'::text, 'variable'::text, GREATEST(unattributed_variable_usd, 0)
  FROM crawl_monthly
)
SELECT month_start, service_name, cost_type, amount_usd
FROM variable_lines
WHERE amount_usd > 0
UNION ALL
SELECT month_start, service_name, cost_type, amount_usd
FROM platform_cost_monthly_overrides;
