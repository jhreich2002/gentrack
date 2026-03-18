-- Architecture redesign — Phase 2 schema additions
-- Run in Supabase SQL editor

-- ── plant_news_state: new tracking timestamps ─────────────────────────────────
ALTER TABLE plant_news_state
  ADD COLUMN IF NOT EXISTS lender_search_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS news_initial_ingest_at   timestamptz;

-- ── plant_financing_summary: Perplexity search results per plant ──────────────
CREATE TABLE IF NOT EXISTS plant_financing_summary (
  eia_plant_code  text        PRIMARY KEY,
  summary         text,                      -- Perplexity prose summary (shown on financing tab)
  citations       jsonb       DEFAULT '[]',  -- [{url, title, snippet}]
  lenders_found   boolean     DEFAULT false,
  searched_at     timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE plant_financing_summary ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'plant_financing_summary' AND policyname = 'plant_financing_summary_public_read'
  ) THEN
    CREATE POLICY "plant_financing_summary_public_read"
      ON plant_financing_summary FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'plant_financing_summary' AND policyname = 'plant_financing_summary_service_write'
  ) THEN
    CREATE POLICY "plant_financing_summary_service_write"
      ON plant_financing_summary FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── plants: distress scoring + pursuit status ─────────────────────────────────
ALTER TABLE plants
  ADD COLUMN IF NOT EXISTS distress_score      numeric,
  ADD COLUMN IF NOT EXISTS distress_rationale  text,
  ADD COLUMN IF NOT EXISTS distress_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS pursuit_status      text
    CHECK (pursuit_status IN ('active', 'watch', 'skip'));

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_plant_financing_summary_lenders_found
  ON plant_financing_summary (lenders_found);

CREATE INDEX IF NOT EXISTS idx_plants_pursuit_status
  ON plants (pursuit_status);

CREATE INDEX IF NOT EXISTS idx_plants_distress_score
  ON plants (distress_score DESC NULLS LAST);
