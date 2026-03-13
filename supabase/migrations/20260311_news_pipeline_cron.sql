-- ============================================================
-- GenTrack: Event-Driven News Pipeline — Single Cron
--
-- Replaces standalone crons (news-ingest, plant-news-rank,
-- embed-articles, compute-ratings) with a single trigger.
--
-- Pipeline flow (event-driven chain):
--   06:00 UTC  news-ingest (cron)
--     └─ if new articles → plant-news-rank (chained)
--         └─ if articles ranked → embed-articles (chained)
--             └─ if articles embedded → compute-ratings (chained)
--
-- Each step fires the next only when it has work to pass along.
-- Self-batching: news-ingest processes 15 plants/call, auto-paginates.
-- Plant selection: top 300 curtailed plants with latest generation data.
-- Incremental: each plant checked only for articles since last_checked_at.
-- ============================================================

-- ── Remove old standalone crons ──────────────────────────────────────────────

-- plant-news-rank standalone
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'plant-news-rank-daily';

-- embed-articles standalone
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'gentrack-embed-articles';

-- compute-ratings standalone
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'gentrack-compute-ratings';

-- Old news-ingest variants (should already be gone, but be safe)
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname IN (
  'gentrack-news-ingest',
  'news-ingest-curtailed-t1',
  'news-ingest-curtailed-t2',
  'news-ingest-tier1',
  'news-ingest-tier2',
  'news-ingest-nightly'
);

-- Old sector news
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname LIKE 'sector-news-ingest%';

-- ── Schedule single pipeline trigger ─────────────────────────────────────────

-- Remove if exists (idempotent)
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'news-pipeline-daily';

-- Daily at 6 AM UTC: kick off the full event-driven chain
SELECT cron.schedule(
  'news-pipeline-daily',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url     := current_setting('app.settings.supabase_url') || '/functions/v1/news-ingest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
      ),
      body    := '{"plantCount": 300}'::jsonb
    ) AS request_id;
  $$
);
