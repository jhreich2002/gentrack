-- Remove zero-dollar placeholder rows seeded in the initial migration.
-- Supabase and GitHub Actions costs can be added manually when real amounts are known.
DELETE FROM platform_cost_monthly_overrides
WHERE service_name IN ('Supabase (Estimate)', 'GitHub Actions (Estimate)');
