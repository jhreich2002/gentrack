-- ============================================================
-- GenTrack — pg_cron schedules for the news intelligence pipeline
-- Run AFTER 001_enable_extensions.sql and after all three Edge
-- Functions have been deployed (news-ingest, embed-articles, compute-ratings)
--
-- Replace the two placeholders before running:
--   <PROJECT_URL>  → https://ohmmtplnaddrfuoowpuq.supabase.co
--   <SERVICE_ROLE_KEY> → your Supabase service_role JWT
-- ============================================================

-- Remove any previous versions of these jobs (idempotent)
SELECT cron.unschedule('gentrack-news-ingest')    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gentrack-news-ingest');
SELECT cron.unschedule('gentrack-embed-articles')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gentrack-embed-articles');
SELECT cron.unschedule('gentrack-compute-ratings') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gentrack-compute-ratings');

-- ── 1. News Ingest — 06:00 UTC every day ─────────────────────────────────────
SELECT cron.schedule(
  'gentrack-news-ingest',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/news-ingest',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- ── 2. Embed Articles — 08:00 UTC every day ──────────────────────────────────
SELECT cron.schedule(
  'gentrack-embed-articles',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/embed-articles',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- ── 3. Compute Ratings — 09:30 UTC every day ─────────────────────────────────
SELECT cron.schedule(
  'gentrack-compute-ratings',
  '30 9 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/compute-ratings',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- Verify schedules were created:
-- SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
