-- Expand lender-ingest coverage: bi-weekly Tier A (all curtailed) + monthly Tier B (all >=200MW)
--
-- Before: Tier A monthly, 300-plant cap | Tier B quarterly, 402-plant cap
-- After:  Tier A bi-weekly, no cap      | Tier B monthly, no cap
-- Plant counts: 1,089 eligible Tier A, 401 eligible Tier B (~1,490 total)

-- ── Tier A: replace monthly → bi-weekly, remove plant cap ──────────────────────
SELECT cron.unschedule('lender-pipeline-monthly');

SELECT cron.schedule(
  'lender-ingest-tier-a',
  '0 8 1,15 * *',
  $$SELECT net.http_post(
    url     := current_setting('app.settings.supabase_url') || '/functions/v1/lender-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body    := '{"plantCount":9999}'::jsonb
  ) AS request_id;$$
);

-- ── Tier B: replace quarterly → monthly, remove plant cap ──────────────────────
SELECT cron.unschedule('lender-ingest-tier-b');

SELECT cron.schedule(
  'lender-ingest-tier-b',
  '0 10 1 * *',
  $$SELECT net.http_post(
    url     := current_setting('app.settings.supabase_url') || '/functions/v1/lender-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body    := '{"tier":"B","plantCount":9999}'::jsonb
  ) AS request_id;$$
);
