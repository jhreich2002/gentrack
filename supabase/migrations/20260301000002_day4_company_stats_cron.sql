-- ============================================================
-- GenTrack Day 4 — company_stats analysis columns + pg_cron
-- Run via Supabase Management API (migration)
-- ============================================================

-- ── Extend company_stats with LLM analysis columns ─────────────────────────
ALTER TABLE company_stats
  ADD COLUMN IF NOT EXISTS analysis_text            text,
  ADD COLUMN IF NOT EXISTS analysis_angle_bullets   text[]     DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS analysis_updated_at      timestamptz;

-- ── Schedule company-stats-refresh at 06:30 UTC (after news-ingest) ────────
SELECT cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'company-stats-refresh-nightly';

SELECT cron.schedule(
  'company-stats-refresh-nightly',
  '30 6 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/company-stats-refresh',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer '|| (select decrypted_secret from vault.decrypted_secrets where name = ''service_role_key'') ||'"}'::jsonb,
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
