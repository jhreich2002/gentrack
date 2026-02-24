-- Run this once in the Supabase SQL editor before the next fetch-eia-data.ts run.
-- https://supabase.com/dashboard/project/ohmmtplnaddrfuoowpuq/sql/new
--
-- Adds the is_maintenance_offline column to the plants table.
-- Plants with ≥3 trailing consecutive zero/null generation months are classified
-- as Maintenance / Offline rather than Curtailed.

ALTER TABLE plants
  ADD COLUMN IF NOT EXISTS is_maintenance_offline boolean NOT NULL DEFAULT false;
