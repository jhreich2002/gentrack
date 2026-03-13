-- Quarterly cron jobs for Tier B (non-curtailed ≥200 MW plants)
-- Runs on the 1st of January, April, July, October

-- General news ingest for Tier B plants — 09:00 UTC
SELECT cron.schedule(
  'news-ingest-tier-b',
  '0 9 1 1,4,7,10 *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL') || '/functions/v1/news-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body := '{"tier":"B","plantCount":402}'::jsonb
  );
  $$
);

-- Financing news ingest for Tier B plants — 10:00 UTC (after general news)
SELECT cron.schedule(
  'lender-ingest-tier-b',
  '0 10 1 1,4,7,10 *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL') || '/functions/v1/lender-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')
    ),
    body := '{"tier":"B","plantCount":402}'::jsonb
  );
  $$
);
