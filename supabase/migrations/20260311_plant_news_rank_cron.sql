-- ============================================================
-- GenTrack: plant-news-rank Cron Job
--
-- Runs daily at 7 AM UTC — after news-ingest (6 AM) and before
-- embed-articles (8 AM). Batch-ranks all unranked articles.
--
-- Pipeline order:
--   06:00 UTC  news-ingest (fetch + basic classify)
--   07:00 UTC  plant-news-rank (asset linkage, curtailment, scoring)
--   08:00 UTC  embed-articles (only include_for_embedding = true)
--   09:30 UTC  compute-ratings (aggregate risk scores)
-- ============================================================

-- Remove if exists (idempotent)
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'plant-news-rank-daily';

-- Batch rank all plants with unranked articles, daily at 7 AM UTC
SELECT cron.schedule(
  'plant-news-rank-daily',
  '0 7 * * *',
  $$
    SELECT net.http_post(
      url     := current_setting('app.settings.supabase_url') || '/functions/v1/plant-news-rank',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
      ),
      body    := '{"batch": true, "limit": 10}'::jsonb
    ) AS request_id;
  $$
);
