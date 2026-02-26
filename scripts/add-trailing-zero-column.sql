-- Run once in Supabase SQL editor:
-- https://supabase.com/dashboard/project/ohmmtplnaddrfuoowpuq/sql/new
ALTER TABLE plants ADD COLUMN IF NOT EXISTS trailing_zero_months integer NOT NULL DEFAULT 0;
