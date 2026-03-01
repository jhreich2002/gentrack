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
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"}'::jsonb,
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
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"}'::jsonb,
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
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"}'::jsonb,
      body    := '{}'::jsonb
    ) AS request_id;
  $$
);
