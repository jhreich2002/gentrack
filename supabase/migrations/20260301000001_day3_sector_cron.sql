-- ============================================================
-- Day 3 — Sector News Ingest Cron Schedules
--
-- Schedules sector-news-ingest to run twice daily (12:00 + 18:00 UTC)
-- and ensures news-ingest runs nightly at 06:00 UTC.
--
-- Requires:
--   pg_cron extension (enabled in Supabase by default on Pro/paid tiers,
--   or via Dashboard → Database → Extensions → pg_cron)
--   pg_net extension  (for HTTP calls from within the DB)
-- ============================================================

-- ── Ensure extensions are present ────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Service-role JWT for Authorization header (same project, never leaves DB)
-- news-ingest: nightly at 06:00 UTC
-- sector-news-ingest: twice daily at 12:00 + 18:00 UTC

-- ── news-ingest: nightly at 06:00 UTC ─────────────────────────────────────────
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'news-ingest-nightly';

SELECT cron.schedule(
  'news-ingest-nightly',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/news-ingest',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer '|| (select decrypted_secret from vault.decrypted_secrets where name = ''service_role_key'') ||'"}'::jsonb,
      body    := '{}'::jsonb
    ) AS request_id;
  $$
);

-- ── sector-news-ingest: twice daily at 12:00 + 18:00 UTC ──────────────────────
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'sector-news-ingest-midday';

SELECT cron.schedule(
  'sector-news-ingest-midday',
  '0 12 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/sector-news-ingest',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer '|| (select decrypted_secret from vault.decrypted_secrets where name = ''service_role_key'') ||'"}'::jsonb,
      body    := '{}'::jsonb
    ) AS request_id;
  $$
);

SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'sector-news-ingest-evening';

SELECT cron.schedule(
  'sector-news-ingest-evening',
  '0 18 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/sector-news-ingest',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer '|| (select decrypted_secret from vault.decrypted_secrets where name = ''service_role_key'') ||'"}'::jsonb,
      body    := '{}'::jsonb
    ) AS request_id;
  $$
);
