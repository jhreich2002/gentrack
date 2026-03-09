-- ============================================================
-- GenTrack: Tiered Google News RSS Cron Jobs
--
-- Tier 1: Top 200 plants by MW — DAILY at 6 AM UTC
-- Tier 2: Next 300 plants — Monday + Thursday at 12 PM UTC
--
-- Estimated cost: ~$1-2/month (well under $5 budget)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove old news-ingest cron job
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'news-ingest-nightly';

-- Remove any existing tiered jobs
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'news-ingest-tier1';

SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'news-ingest-tier2';

-- Tier 1: Daily at 6 AM UTC — Top 200 plants
SELECT cron.schedule(
  'news-ingest-tier1',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/news-ingest?tier=1',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"}'::jsonb,
      body    := '{}'::jsonb
    ) AS request_id;
  $$
);

-- Tier 2: Monday and Thursday at 12 PM UTC — Next 300 plants
SELECT cron.schedule(
  'news-ingest-tier2',
  '0 12 * * 1,4',
  $$
    SELECT net.http_post(
      url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/news-ingest?tier=2',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"}'::jsonb,
      body    := '{}'::jsonb
    ) AS request_id;
  $$
);
