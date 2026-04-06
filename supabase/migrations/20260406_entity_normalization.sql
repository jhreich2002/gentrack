-- ============================================================
-- Entity Normalization: alias resolution + blocklist
--
-- entity_aliases  — maps variant names → canonical names
-- entity_blocklist — junk/generic names to exclude from stats
-- ============================================================

-- ── entity_aliases ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_aliases (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_name      TEXT        NOT NULL,
  canonical_name  TEXT        NOT NULL,
  entity_type     TEXT        NOT NULL CHECK (entity_type IN ('lender','tax_equity','developer','company')),
  confidence      TEXT        DEFAULT 'high' CHECK (confidence IN ('high','medium','auto')),
  source          TEXT        DEFAULT 'manual',
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (alias_name, entity_type)
);

ALTER TABLE entity_aliases ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='entity_aliases' AND policyname='entity_aliases_public_read') THEN
    CREATE POLICY "entity_aliases_public_read" ON entity_aliases FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='entity_aliases' AND policyname='entity_aliases_service_write') THEN
    CREATE POLICY "entity_aliases_service_write" ON entity_aliases FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_entity_aliases_lookup
  ON entity_aliases (lower(alias_name), entity_type);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_canonical
  ON entity_aliases (lower(canonical_name), entity_type);

-- ── entity_blocklist ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_blocklist (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  entity_type TEXT        NOT NULL CHECK (entity_type IN ('lender','tax_equity','developer','company')),
  reason      TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (name, entity_type)
);

ALTER TABLE entity_blocklist ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='entity_blocklist' AND policyname='entity_blocklist_public_read') THEN
    CREATE POLICY "entity_blocklist_public_read" ON entity_blocklist FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='entity_blocklist' AND policyname='entity_blocklist_service_write') THEN
    CREATE POLICY "entity_blocklist_service_write" ON entity_blocklist FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_entity_blocklist_lookup
  ON entity_blocklist (lower(name), entity_type);
