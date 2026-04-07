-- ============================================================
-- Admin Activity + Monthly Cost Analytics
-- ============================================================

-- 1) User activity events (client-write, admin-read via service role)
CREATE TABLE IF NOT EXISTS user_activity_events (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL CHECK (event_type IN ('app_open','view_change','filter_search','watchlist_toggle')),
  event_name     TEXT NOT NULL,
  event_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_activity_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_activity_events' AND policyname = 'user_activity_events_own_insert'
  ) THEN
    CREATE POLICY user_activity_events_own_insert
      ON user_activity_events FOR INSERT
      WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_activity_events' AND policyname = 'user_activity_events_own_read'
  ) THEN
    CREATE POLICY user_activity_events_own_read
      ON user_activity_events FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_activity_events_user_time
  ON user_activity_events (user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_events_time
  ON user_activity_events (occurred_at DESC);

CREATE OR REPLACE VIEW admin_user_activity_daily AS
SELECT
  (occurred_at AT TIME ZONE 'UTC')::date AS day,
  COUNT(DISTINCT user_id) AS active_users,
  COUNT(*) FILTER (WHERE event_type IN ('view_change','filter_search','watchlist_toggle')) AS action_count,
  COUNT(*) FILTER (WHERE event_type = 'app_open') AS app_open_count
FROM user_activity_events
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW admin_user_activity_user_daily AS
SELECT
  (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
  e.user_id,
  COALESCE(p.email, 'unknown') AS email,
  COUNT(*) FILTER (WHERE e.event_type IN ('view_change','filter_search','watchlist_toggle')) AS action_count,
  COUNT(*) FILTER (WHERE e.event_type = 'app_open') AS app_open_count,
  MAX(e.occurred_at) AS last_seen_at
FROM user_activity_events e
LEFT JOIN profiles p ON p.id = e.user_id
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 4 DESC;

-- 2) Monthly cost line items
CREATE TABLE IF NOT EXISTS platform_cost_monthly_overrides (
  id          BIGSERIAL PRIMARY KEY,
  month_start DATE NOT NULL,
  service_name TEXT NOT NULL,
  cost_type    TEXT NOT NULL CHECK (cost_type IN ('variable','fixed')),
  amount_usd   NUMERIC(12,2) NOT NULL CHECK (amount_usd >= 0),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (month_start, service_name, cost_type)
);

ALTER TABLE platform_cost_monthly_overrides ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'platform_cost_monthly_overrides' AND policyname = 'platform_cost_monthly_overrides_public_read'
  ) THEN
    CREATE POLICY platform_cost_monthly_overrides_public_read
      ON platform_cost_monthly_overrides FOR SELECT USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_platform_cost_monthly_overrides_month
  ON platform_cost_monthly_overrides (month_start DESC);

-- Seed fixed monthly subscriptions and estimate placeholders for current month.
INSERT INTO platform_cost_monthly_overrides (month_start, service_name, cost_type, amount_usd, notes)
VALUES
  (date_trunc('month', now())::date, 'Claude Pro', 'fixed', 20.60, 'Monthly subscription'),
  (date_trunc('month', now())::date, 'Perplexity Pro', 'fixed', 20.60, 'Monthly subscription'),
  (date_trunc('month', now())::date, 'GitHub Copilot Pro', 'fixed', 10.30, 'Monthly subscription'),
  (date_trunc('month', now())::date, 'Supabase (Estimate)', 'fixed', 0.00, 'Set monthly estimate'),
  (date_trunc('month', now())::date, 'GitHub Actions (Estimate)', 'fixed', 0.00, 'Set monthly estimate')
ON CONFLICT (month_start, service_name, cost_type) DO NOTHING;

CREATE OR REPLACE VIEW admin_platform_cost_monthly_lines AS
WITH crawl_monthly AS (
  SELECT
    date_trunc('month', started_at)::date AS month_start,
    SUM(COALESCE((api_calls ->> 'perplexity_sonar')::numeric, 0)
      + COALESCE((api_calls ->> 'perplexity_sonar_pro')::numeric, 0)
      + COALESCE((api_calls ->> 'perplexity_deep_research')::numeric, 0))::numeric(12,2) AS perplexity_usd,
    SUM(COALESCE((api_calls ->> 'gemini_flash')::numeric, 0)
      + COALESCE((api_calls ->> 'gemini_pro')::numeric, 0))::numeric(12,2) AS gemini_usd,
    SUM(COALESCE(total_cost_usd, 0)
      - (COALESCE((api_calls ->> 'perplexity_sonar')::numeric, 0)
      + COALESCE((api_calls ->> 'perplexity_sonar_pro')::numeric, 0)
      + COALESCE((api_calls ->> 'perplexity_deep_research')::numeric, 0)
      + COALESCE((api_calls ->> 'gemini_flash')::numeric, 0)
      + COALESCE((api_calls ->> 'gemini_pro')::numeric, 0)))::numeric(12,2) AS unattributed_variable_usd
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
  SELECT month_start, 'Other Variable Usage'::text, 'variable'::text, GREATEST(unattributed_variable_usd, 0)
  FROM crawl_monthly
)
SELECT month_start, service_name, cost_type, amount_usd
FROM variable_lines
WHERE amount_usd > 0
UNION ALL
SELECT month_start, service_name, cost_type, amount_usd
FROM platform_cost_monthly_overrides;

CREATE OR REPLACE VIEW admin_platform_cost_monthly_totals AS
SELECT
  month_start,
  SUM(amount_usd)::numeric(12,2) AS total_usd
FROM admin_platform_cost_monthly_lines
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE FUNCTION admin_cost_forecast(months_ahead integer DEFAULT 3)
RETURNS TABLE (month_start date, projected_total_usd numeric)
LANGUAGE sql
AS $$
WITH history AS (
  SELECT month_start, total_usd
  FROM admin_platform_cost_monthly_totals
  ORDER BY month_start DESC
  LIMIT 6
),
ordered AS (
  SELECT
    month_start,
    total_usd,
    ROW_NUMBER() OVER (ORDER BY month_start) - 1 AS x
  FROM history
),
stats AS (
  SELECT
    COALESCE(AVG(x::numeric), 0) AS x_mean,
    COALESCE(AVG(total_usd), 0) AS y_mean,
    COALESCE(COUNT(*), 0) AS n
  FROM ordered
),
regression AS (
  SELECT
    CASE
      WHEN s.n < 2 THEN 0::numeric
      ELSE
        COALESCE(
          SUM((o.x - s.x_mean) * (o.total_usd - s.y_mean))
          / NULLIF(SUM((o.x - s.x_mean) * (o.x - s.x_mean)), 0),
          0
        )
    END AS slope,
    s.y_mean AS y_mean,
    s.x_mean AS x_mean,
    COALESCE((SELECT MAX(x) FROM ordered), -1) AS last_x
  FROM ordered o
  CROSS JOIN stats s
  GROUP BY s.n, s.y_mean, s.x_mean
)
SELECT
  (date_trunc('month', now()) + (g.n || ' month')::interval)::date AS month_start,
  ROUND(
    GREATEST(0,
      (r.y_mean - (r.slope * r.x_mean)) + (r.slope * (r.last_x + g.n))
    )
  , 2)::numeric AS projected_total_usd
FROM generate_series(1, GREATEST(months_ahead, 1)) AS g(n)
CROSS JOIN regression r
ORDER BY 1;
$$;