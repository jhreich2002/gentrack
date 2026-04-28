-- ============================================================
-- GenTrack: Curtailment-Driven News Ingest Cron Jobs
--
-- Replaces MW-based tiering with curtailment-based plant selection.
-- Plants selected by: is_likely_curtailed=true, trailing_zero_months=0,
-- is_maintenance_offline=false (actively generating, consistently reporting,
-- measurably underperforming — the consulting firm's target audience).
--
-- Tier 1: Top 100 curtailed plants >100 MW — DAILY at 6 AM UTC
-- Tier 2: Next 200 curtailed plants <=100 MW — Monday + Thursday at 12 PM UTC
--
-- Cost estimate: ~$3.65/month (Tavily $1/1K + Gemini Flash sentiment)
-- ============================================================

-- Remove old MW-based jobs
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'news-ingest-tier1';

SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'news-ingest-tier2';

-- Tier 1: Daily at 6 AM UTC — Top 100 curtailed plants >100 MW
SELECT cron.schedule(
  'news-ingest-curtailed-t1',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/news-ingest?tier=1',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer '|| (select decrypted_secret from vault.decrypted_secrets where name = ''service_role_key'') ||'"}'::jsonb,
      body    := '{}'::jsonb
    ) AS request_id;
  $$
);

-- Tier 2: Monday and Thursday at 12 PM UTC — Next 200 curtailed plants <=100 MW
SELECT cron.schedule(
  'news-ingest-curtailed-t2',
  '0 12 * * 1,4',
  $$
    SELECT net.http_post(
      url     := 'https://ohmmtplnaddrfuoowpuq.supabase.co/functions/v1/news-ingest?tier=2',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer '|| (select decrypted_secret from vault.decrypted_secrets where name = ''service_role_key'') ||'"}'::jsonb,
      body    := '{}'::jsonb
    ) AS request_id;
  $$
);
