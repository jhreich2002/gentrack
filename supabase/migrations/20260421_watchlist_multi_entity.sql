-- ============================================================
-- Migration: Expand watchlist to support lenders and tax equity
-- Date: 2026-04-21
-- ============================================================

-- 1. Rename old table for backup
ALTER TABLE watchlist RENAME TO watchlist_old;

-- 2. Create new watchlist table
CREATE TABLE IF NOT EXISTS watchlist (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('plant', 'lender', 'tax_equity')),
  entity_id   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

-- 3. Migrate existing data
INSERT INTO watchlist (user_id, entity_type, entity_id, created_at)
SELECT user_id, 'plant', plant_id, created_at FROM watchlist_old;

-- 4. Drop old table
DROP TABLE watchlist_old;

-- 5. RLS and policies
ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "watchlist: own read"   ON watchlist FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "watchlist: own insert" ON watchlist FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "watchlist: own delete" ON watchlist FOR DELETE USING (auth.uid() = user_id);
