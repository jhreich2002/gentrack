-- ============================================================
-- GenTrack: Lender/Financing Pipeline — Monthly Cron
--
-- Pipeline flow (event-driven chain):
--   1st of month, 08:00 UTC  lender-ingest (cron)
--     └─ if new articles → lender-news-rank (chained)
--         └─ if articles ranked → embed-articles (chained)
--             └─ if articles embedded → compute-ratings (chained)
--
-- Monthly cadence: financing events are less frequent than news.
-- 5-year backfill on first run; incremental via lender_last_checked_at.
-- ============================================================

-- ── Remove if exists (idempotent) ────────────────────────────────────────────

SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'lender-pipeline-monthly';

-- ── Schedule monthly pipeline trigger ────────────────────────────────────────

SELECT cron.schedule(
  'lender-pipeline-monthly',
  '0 8 1 * *',
  $$
    SELECT net.http_post(
      url     := current_setting('app.settings.supabase_url') || '/functions/v1/lender-ingest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
      ),
      body    := '{"plantCount": 30}'::jsonb
    ) AS request_id;
  $$
);
