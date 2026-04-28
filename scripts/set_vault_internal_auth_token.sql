-- ============================================================
-- GenTrack — set/update the Vault secret used by pg_cron jobs
-- to authenticate against Edge Functions.
--
-- Run this ONCE in the Supabase Dashboard → SQL Editor.
-- The secret name MUST be 'service_role_key' (existing migrations
-- reference this name; we keep it for backward compat even though
-- the value is now the sb_secret_ INTERNAL_AUTH_TOKEN).
--
-- After running this, re-apply any of the cron migrations under
-- supabase/migrations/ so pg_cron jobs pick up the Vault value.
-- ============================================================

-- Remove existing entry if present (so we can re-create with new value)
DELETE FROM vault.secrets WHERE name = 'service_role_key';

-- Store the new INTERNAL_AUTH_TOKEN (the sb_secret_ value) under the
-- name pg_cron jobs already reference.
--
-- BEFORE RUNNING: replace <REPLACE_WITH_INTERNAL_AUTH_TOKEN> with the value
-- of the INTERNAL_AUTH_TOKEN platform secret (Settings → Edge Functions →
-- Secrets, or your local .env's SUPABASE_SERVICE_ROLE_KEY).
SELECT vault.create_secret(
  '<REPLACE_WITH_INTERNAL_AUTH_TOKEN>',
  'service_role_key',
  'Bearer token for pg_cron → Edge Function calls (matches INTERNAL_AUTH_TOKEN platform secret)'
);

-- Verify:
-- SELECT name, created_at FROM vault.secrets WHERE name = 'service_role_key';
-- SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key';
