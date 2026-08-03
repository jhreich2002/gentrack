-- ============================================================
-- GenTrack — BD Review Loop tables
-- Apply via Supabase SQL Editor (CLI db push blocked by pooler).
-- ============================================================

-- ── bd_dispositions ──────────────────────────────────────────
-- Sticky MD review decisions on zones / owners / plants.
-- 'dismissed' items are hidden from the Zone Target Sheet until
-- their score worsens materially (frontend logic).
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bd_dispositions (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       text          NOT NULL CHECK (scope IN ('zone', 'owner', 'plant')),
  key         text          NOT NULL,
  status      text          NOT NULL CHECK (status IN ('new', 'watch', 'pursue', 'dismissed')),
  note        text,
  decided_by  text,
  decided_at  timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (scope, key)
);

COMMENT ON TABLE bd_dispositions IS
  'Sticky MD review decisions on BD targets. '
  'key format: zone = "ERCOT|West", owner = "owner:Apex Clean Energy", plant = "plant:EIA-12345".';

-- Indexed for fast lookups by scope+key
CREATE INDEX IF NOT EXISTS idx_bd_dispositions_scope_key ON bd_dispositions (scope, key);

-- RLS: readable by any authenticated user; writable by admin
ALTER TABLE bd_dispositions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bd_dispositions_read" ON bd_dispositions;
CREATE POLICY "bd_dispositions_read"
  ON bd_dispositions FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "bd_dispositions_write" ON bd_dispositions;
CREATE POLICY "bd_dispositions_write"
  ON bd_dispositions FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );


-- ── bd_target_snapshots ──────────────────────────────────────
-- Point-in-time snapshot of zone/owner/plant target scores.
-- Written by scripts/snapshot-bd-targets.ts after each monthly
-- EIA refresh.  The "What Changed" panel diffs current scores
-- against the most recent snapshot.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bd_target_snapshots (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date          NOT NULL,
  scope         text          NOT NULL CHECK (scope IN ('zone', 'owner', 'plant')),
  key           text          NOT NULL,
  target_score  float8        NOT NULL,
  gap_pp        float8,
  mw            float8,
  rank          int,
  payload       jsonb,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (snapshot_date, scope, key)
);

COMMENT ON TABLE bd_target_snapshots IS
  'Monthly point-in-time snapshots of BD target scores for the "What Changed" review panel.';

CREATE INDEX IF NOT EXISTS idx_bd_snapshots_date_scope ON bd_target_snapshots (snapshot_date DESC, scope, key);

ALTER TABLE bd_target_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bd_snapshots_read" ON bd_target_snapshots;
CREATE POLICY "bd_snapshots_read"
  ON bd_target_snapshots FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "bd_snapshots_write" ON bd_target_snapshots;
CREATE POLICY "bd_snapshots_write"
  ON bd_target_snapshots FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );
