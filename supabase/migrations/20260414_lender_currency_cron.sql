-- ============================================================
-- Lender Currency Identification — Quarterly Cron
-- Fires lender-currency-agent on the first day of each quarter
-- at 06:00 UTC with force_recheck=true for full re-verification.
-- ============================================================

SELECT cron.schedule(
  'lender-currency-quarterly',
  '0 6 1 1,4,7,10 *',
  $$SELECT net.http_post(
    url     := current_setting('app.settings.supabase_url') || '/functions/v1/lender-currency-agent',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body    := '{"mode":"quarterly","offset":0,"limit":10,"budget_limit":20.0,"force_recheck":true}'::jsonb
  ) AS request_id;$$
);

-- ============================================================
-- Lender Trigger Monitor — Weekly Cron
-- Scans for timely outreach signals: covenant waivers, accelerating
-- curtailment, ownership changes, and comparable-plant refinancing.
-- Runs every Monday at 07:00 UTC.
-- ============================================================

SELECT cron.schedule(
  'lender-trigger-monitor-weekly',
  '0 7 * * 1',
  $$SELECT net.http_post(
    url     := current_setting('app.settings.supabase_url') || '/functions/v1/lender-trigger-monitor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body    := '{}'::jsonb
  ) AS request_id;$$
);
