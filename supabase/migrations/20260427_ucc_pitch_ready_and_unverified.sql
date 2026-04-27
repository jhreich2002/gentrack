-- ============================================================
-- UCC Lender Research — Pitch Ready + Unverified Leads Split
-- Implements the user-approved decisions (2026-04-27):
--   1. LLM/news/perplexity evidence isolated into a new table
--      ucc_lender_leads_unverified, so ucc_lender_links is
--      100% citation-backed (UCC scrape, county scrape, EDGAR).
--   2. Single citation suffices for `confirmed` (no dual-source).
--   3. New pitch_ready flag on ucc_lender_links + RPC + RLS so
--      a designated reviewer/admin can mark a link as pitch-ready
--      after final human sign-off.
--   4. Trusted-source domain whitelist for direct-source URL gate.
--   5. Provenance audit views for the Phase A baseline report.
-- ============================================================

-- ── 1. ucc_lender_leads_unverified ───────────────────────────────────────────
-- Mirrors ucc_lender_links columns but stores LLM/news/web evidence only.
-- The reviewer routes inferred-only candidates here so the main
-- ucc_lender_links table stays banking-grade auditable.

CREATE TABLE IF NOT EXISTS ucc_lender_leads_unverified (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_code          text NOT NULL,
  lender_entity_id    bigint REFERENCES ucc_entities(id) ON DELETE SET NULL,
  lender_name         text,
  lender_normalized   text,
  confidence_class    text NOT NULL DEFAULT 'possible'
    CHECK (confidence_class IN ('possible', 'highly_likely')),
  evidence_type       text NOT NULL DEFAULT 'inferred'
    CHECK (evidence_type IN ('inferred', 'sponsor_pattern', 'web_scrape', 'llm_inference', 'news')),
  evidence_summary    text,
  source_url          text,
  source_types        text[]  DEFAULT '{}',
  llm_model           text,
  llm_prompt_hash     text,
  run_id              uuid,
  human_approved      boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  UNIQUE (plant_code, lender_entity_id)
);

ALTER TABLE ucc_lender_leads_unverified ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ucc_lender_leads_unverified' AND policyname = 'ullu_public_read'
  ) THEN
    CREATE POLICY "ullu_public_read" ON ucc_lender_leads_unverified
      FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ucc_lender_leads_unverified' AND policyname = 'ullu_service_write'
  ) THEN
    CREATE POLICY "ullu_service_write" ON ucc_lender_leads_unverified
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ullu_plant_code        ON ucc_lender_leads_unverified (plant_code);
CREATE INDEX IF NOT EXISTS idx_ullu_lender_entity     ON ucc_lender_leads_unverified (lender_entity_id);
CREATE INDEX IF NOT EXISTS idx_ullu_run_id            ON ucc_lender_leads_unverified (run_id);
CREATE INDEX IF NOT EXISTS idx_ullu_evidence_type     ON ucc_lender_leads_unverified (evidence_type);

-- ── 2. Pitch-ready columns on ucc_lender_links ───────────────────────────────

ALTER TABLE ucc_lender_links
  ADD COLUMN IF NOT EXISTS pitch_ready      boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pitch_ready_by   uuid         REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pitch_ready_at   timestamptz,
  ADD COLUMN IF NOT EXISTS pitch_ready_note text;

CREATE INDEX IF NOT EXISTS idx_ull_pitch_ready ON ucc_lender_links (pitch_ready)
  WHERE pitch_ready = true;

-- ── 3. Trusted source domain whitelist ───────────────────────────────────────
-- The reviewer enforces: a `confirmed` link's source_url must resolve to a
-- domain on this list. State SOS UCC portals, county recorders, sec.gov, etc.

CREATE TABLE IF NOT EXISTS ucc_trusted_source_domains (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain       text NOT NULL UNIQUE,           -- e.g. 'bizfileonline.sos.ca.gov'
  category     text NOT NULL                   -- 'sos_ucc' | 'county' | 'sec' | 'sos_entity'
    CHECK (category IN ('sos_ucc', 'county', 'sec', 'sos_entity')),
  state_code   text,                           -- 'CA', 'TX', etc. NULL for SEC
  notes        text,
  enabled      boolean NOT NULL DEFAULT true,
  added_at     timestamptz DEFAULT now()
);

ALTER TABLE ucc_trusted_source_domains ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ucc_trusted_source_domains' AND policyname = 'utsd_public_read'
  ) THEN
    CREATE POLICY "utsd_public_read" ON ucc_trusted_source_domains
      FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ucc_trusted_source_domains' AND policyname = 'utsd_service_write'
  ) THEN
    CREATE POLICY "utsd_service_write" ON ucc_trusted_source_domains
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- Seed the canonical state SOS UCC portals + SEC. Adapters write source_url
-- from these portals; the reviewer cross-checks domain membership.
INSERT INTO ucc_trusted_source_domains (domain, category, state_code, notes) VALUES
  ('bizfileonline.sos.ca.gov',                     'sos_ucc',    'CA', 'California SOS UCC search'),
  ('direct.sos.state.tx.us',                       'sos_ucc',    'TX', 'Texas SOSDirect UCC search'),
  ('uccsearch.coloradosos.gov',                    'sos_ucc',    'CO', 'Colorado SOS UCC'),
  ('apps.azsos.gov',                               'sos_ucc',    'AZ', 'Arizona SOS UCC'),
  ('esos.nv.gov',                                  'sos_ucc',    'NV', 'Nevada SOS UCC'),
  ('mblsportal.sos.state.mn.us',                   'sos_ucc',    'MN', 'Minnesota SOS UCC'),
  ('sos.iowa.gov',                                 'sos_ucc',    'IA', 'Iowa SOS UCC'),
  ('apps.ilsos.gov',                               'sos_ucc',    'IL', 'Illinois SOS UCC'),
  ('www.sosnc.gov',                                'sos_ucc',    'NC', 'NC SOS UCC'),
  ('sunbiz.org',                                   'sos_ucc',    'FL', 'Florida Sunbiz UCC'),
  ('inbiz.in.gov',                                 'sos_ucc',    'IN', 'Indiana SOS UCC'),
  ('ecorp.sos.ga.gov',                             'sos_ucc',    'GA', 'Georgia SOS UCC'),
  ('appext20.dos.ny.gov',                          'sos_ucc',    'NY', 'NY DOS UCC'),
  ('www.wdfi.org',                                 'sos_ucc',    'WI', 'Wisconsin DFI UCC'),
  ('portal.sos.state.nm.us',                       'sos_ucc',    'NM', 'NM SOS UCC'),
  ('www.sec.gov',                                  'sec',        NULL, 'SEC EDGAR'),
  ('efts.sec.gov',                                 'sec',        NULL, 'SEC EDGAR full-text search')
ON CONFLICT (domain) DO NOTHING;

-- Helper function: is a URL on the trusted domain whitelist?
CREATE OR REPLACE FUNCTION public.is_trusted_ucc_source(p_url text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM ucc_trusted_source_domains d
    WHERE d.enabled = true
      AND p_url IS NOT NULL
      AND p_url ILIKE 'http%://' || d.domain || '%'
  );
$$;

-- ── 4. RPC: mark_pitch_ready ─────────────────────────────────────────────────
-- Only admins (profiles.role = 'admin') may flip pitch_ready. Records who/when.

CREATE OR REPLACE FUNCTION public.mark_pitch_ready(
  p_link_id bigint,
  p_ready   boolean,
  p_note    text DEFAULT NULL
)
RETURNS ucc_lender_links
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_row    ucc_lender_links;
  v_link   ucc_lender_links;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Only admin reviewers may mark a lender link pitch-ready'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_link FROM ucc_lender_links WHERE id = p_link_id;
  IF v_link.id IS NULL THEN
    RAISE EXCEPTION 'Lender link % not found', p_link_id USING ERRCODE = '02000';
  END IF;

  -- Hard rule: only confirmed links may be pitch-ready
  IF p_ready AND v_link.confidence_class <> 'confirmed' THEN
    RAISE EXCEPTION 'Only `confirmed` lender links may be marked pitch-ready (got %)',
      v_link.confidence_class USING ERRCODE = '22000';
  END IF;

  -- Hard rule: pitch-ready requires a source URL on the trusted domain whitelist
  IF p_ready AND NOT public.is_trusted_ucc_source(v_link.source_url) THEN
    RAISE EXCEPTION 'Pitch-ready requires a source_url on the trusted UCC/SEC domain whitelist'
      USING ERRCODE = '22000';
  END IF;

  UPDATE ucc_lender_links
  SET pitch_ready      = p_ready,
      pitch_ready_by   = CASE WHEN p_ready THEN v_uid ELSE NULL END,
      pitch_ready_at   = CASE WHEN p_ready THEN now()  ELSE NULL END,
      pitch_ready_note = CASE WHEN p_ready THEN p_note ELSE NULL END,
      updated_at       = now()
  WHERE id = p_link_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_pitch_ready(bigint, boolean, text) TO authenticated;

-- ── 5. Backfill: move non-citation rows from ucc_lender_links to unverified ──
-- Anything currently in ucc_lender_links that lacks a direct UCC/county/EDGAR
-- citation OR lacks a source_url moves to the unverified table. Operates only
-- on rows that are NOT pitch_ready (defensive — backfill should never demote
-- an admin-blessed pitch-ready row, though by definition such rows pass the
-- filter).

WITH moved AS (
  SELECT l.id, l.plant_code, l.lender_entity_id, l.lender_name, l.lender_normalized,
         l.evidence_summary, l.source_url, l.run_id,
         CASE
           WHEN l.evidence_type IN ('direct', 'direct_filing', 'county_record') THEN 'inferred'
           WHEN l.evidence_type = 'sponsor_pattern'                              THEN 'sponsor_pattern'
           WHEN l.evidence_type = 'supplement'                                   THEN 'inferred'
           ELSE 'inferred'
         END AS new_evidence_type,
         l.confidence_class
  FROM ucc_lender_links l
  WHERE l.pitch_ready = false
    AND (
      l.source_url IS NULL
      OR NOT public.is_trusted_ucc_source(l.source_url)
      OR l.evidence_type NOT IN ('direct', 'direct_filing', 'county_record', 'edgar')
    )
)
INSERT INTO ucc_lender_leads_unverified (
  plant_code, lender_entity_id, lender_name, lender_normalized,
  confidence_class, evidence_type, evidence_summary, source_url, run_id
)
SELECT
  m.plant_code, m.lender_entity_id, m.lender_name, m.lender_normalized,
  CASE
    WHEN m.confidence_class = 'confirmed' THEN 'highly_likely'  -- was confirmed but no trusted URL → demote
    ELSE m.confidence_class
  END,
  m.new_evidence_type,
  m.evidence_summary,
  m.source_url,
  m.run_id
FROM moved m
ON CONFLICT (plant_code, lender_entity_id) DO NOTHING;

-- Delete the migrated rows from the citation-backed table.
DELETE FROM ucc_lender_links l
WHERE l.pitch_ready = false
  AND (
    l.source_url IS NULL
    OR NOT public.is_trusted_ucc_source(l.source_url)
    OR l.evidence_type NOT IN ('direct', 'direct_filing', 'county_record', 'edgar')
  );

-- ── 6. Provenance audit views (Phase A baseline) ─────────────────────────────

-- View: evidence-record breakdown by source_type and worker.
CREATE OR REPLACE VIEW ucc_evidence_provenance_summary AS
SELECT
  source_type,
  worker_name,
  count(*)                                                      AS evidence_count,
  count(*) FILTER (WHERE source_url IS NOT NULL)                AS with_source_url,
  count(*) FILTER (WHERE public.is_trusted_ucc_source(source_url)) AS with_trusted_url,
  count(DISTINCT plant_code)                                    AS distinct_plants,
  count(DISTINCT run_id)                                        AS distinct_runs,
  min(created_at)                                               AS first_seen,
  max(created_at)                                               AS last_seen
FROM ucc_evidence_records
GROUP BY source_type, worker_name
ORDER BY evidence_count DESC;

-- View: per-state scraper health based on actual evidence captured.
CREATE OR REPLACE VIEW ucc_state_scraper_health AS
WITH plant_state AS (
  SELECT plant_code, state FROM ucc_research_plants
)
SELECT
  ps.state,
  count(DISTINCT ps.plant_code) FILTER (WHERE er.id IS NOT NULL)                                  AS plants_with_evidence,
  count(DISTINCT ps.plant_code) FILTER (WHERE er.source_type = 'ucc_scrape')                      AS plants_with_ucc_hit,
  count(DISTINCT ps.plant_code) FILTER (WHERE er.source_type = 'perplexity')                      AS plants_with_llm_fallback_only,
  count(*) FILTER (WHERE er.source_type = 'ucc_scrape')                                           AS ucc_evidence_records,
  count(*) FILTER (WHERE er.source_type = 'perplexity')                                           AS llm_evidence_records,
  count(*) FILTER (WHERE er.source_type = 'ucc_scrape' AND public.is_trusted_ucc_source(er.source_url))
                                                                                                  AS ucc_with_trusted_url,
  max(er.created_at)                                                                              AS last_evidence_at
FROM plant_state ps
LEFT JOIN ucc_evidence_records er ON er.plant_code = ps.plant_code
GROUP BY ps.state
ORDER BY ps.state;

-- View: pitch-ready leads (the partner-facing list).
CREATE OR REPLACE VIEW ucc_pitch_ready_leads AS
SELECT
  l.id                AS lender_link_id,
  l.plant_code,
  rp.plant_name,
  rp.state,
  rp.capacity_mw,
  rp.sponsor_name,
  l.lender_entity_id,
  e.entity_name       AS lender_name,
  e.normalized_name   AS lender_normalized,
  l.confidence_class,
  l.evidence_type,
  l.evidence_summary,
  l.source_url,
  l.pitch_ready_by,
  l.pitch_ready_at,
  l.pitch_ready_note,
  l.updated_at
FROM ucc_lender_links l
LEFT JOIN ucc_research_plants rp ON rp.plant_code = l.plant_code
LEFT JOIN ucc_entities         e ON e.id          = l.lender_entity_id
WHERE l.pitch_ready = true;

GRANT SELECT ON ucc_evidence_provenance_summary TO anon, authenticated;
GRANT SELECT ON ucc_state_scraper_health        TO anon, authenticated;
GRANT SELECT ON ucc_pitch_ready_leads           TO anon, authenticated;
