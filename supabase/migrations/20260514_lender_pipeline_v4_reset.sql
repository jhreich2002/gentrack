-- ============================================================
-- Lender Pipeline v4 — Nuclear Reset
--
-- Tears down all v1/v2/v3 lender pipeline objects and replaces
-- them with a clean, unified schema. Human-validated rows are
-- archived before demolition and replayed after table creation.
--
-- Apply via Supabase SQL Editor (not CLI db push — see migration
-- tracking note in repo memory).
-- ============================================================

-- ── 0. Archive human-validated rows before we drop anything ──────────────────
-- Rows where a consultant actually clicked "Validate". The resolver replays
-- these into v4 lender_links after the new tables exist.
--
-- Defensive: tables/columns differ across environments. Build the archive
-- table with an explicit schema, then conditionally INSERT from each legacy
-- source only if the table + required columns exist.

DROP TABLE IF EXISTS public._archive_v3_validated_lenders;

CREATE TABLE public._archive_v3_validated_lenders (
  raw_lender_name      text,
  lender_normalized    text,
  plant_code           text,
  source_url           text,
  evidence_summary     text,
  evidence_type        text,
  evidence_created_at  timestamptz,
  validated_at         timestamptz,
  validated_by_email   text
);

-- Inline fallback for normalize_lender_name (the legacy fn may have been
-- dropped already; the v4 version is created later in this migration).
DO $outer$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='normalize_lender_name'
  ) THEN
    EXECUTE $f$
      CREATE FUNCTION public.normalize_lender_name(p_name text)
      RETURNS text LANGUAGE sql IMMUTABLE AS $body$
        SELECT lower(regexp_replace(coalesce(p_name,''), '\s+', ' ', 'g'))
      $body$;
    $f$;
  END IF;
END
$outer$;

-- Source A: ucc_lender_links — the canonical "human approved" rows in v3.
DO $outer$
BEGIN
  IF to_regclass('public.ucc_lender_links') IS NOT NULL THEN
    EXECUTE $f$
      INSERT INTO public._archive_v3_validated_lenders
        (raw_lender_name, lender_normalized, plant_code, source_url,
         evidence_summary, evidence_type, evidence_created_at,
         validated_at, validated_by_email)
      SELECT
        ull.lender_name,
        public.normalize_lender_name(ull.lender_name),
        ull.plant_code,
        ull.source_url,
        ull.evidence_summary,
        ull.evidence_type,
        ull.created_at,
        coalesce(
          (SELECT max(ra.timestamp) FROM public.ucc_review_actions ra
            WHERE ra.lender_link_id = ull.id AND ra.action = 'approve'),
          ull.updated_at
        ),
        (SELECT ra.reviewer_email FROM public.ucc_review_actions ra
           WHERE ra.lender_link_id = ull.id AND ra.action = 'approve'
           ORDER BY ra.timestamp DESC LIMIT 1)
      FROM public.ucc_lender_links ull
      WHERE ull.human_approved = true
        AND ull.lender_name IS NOT NULL
    $f$;
  END IF;
END
$outer$;

-- Source B: legacy plant_lenders rows (only if table + human_approved exist).
DO $outer$
BEGIN
  IF to_regclass('public.plant_lenders') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='plant_lenders'
          AND column_name='human_approved'
     )
  THEN
    EXECUTE $f$
      INSERT INTO public._archive_v3_validated_lenders
        (raw_lender_name, lender_normalized, plant_code, source_url,
         evidence_summary, evidence_type, evidence_created_at,
         validated_at, validated_by_email)
      SELECT
        pl.lender_name,
        public.normalize_lender_name(pl.lender_name),
        pl.eia_plant_code,
        pl.filing_url,
        pl.excerpt_text,
        'edgar_loan',
        pl.extracted_at,
        pl.extracted_at,
        NULL
      FROM public.plant_lenders pl
      WHERE pl.human_approved = true
        AND pl.lender_name IS NOT NULL
    $f$;
  END IF;
END
$outer$;

-- ── 1. Drop v1 / v2 / v3 lender objects (CASCADE takes views/triggers) ────────

-- Cron jobs (use cron.unschedule — DELETE FROM cron.job requires superuser).
-- Wrapped in a DO block so missing jobs don't abort the migration.
DO $outer$
DECLARE
  j text;
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    FOREACH j IN ARRAY ARRAY[
      'lender-ingest-hourly',
      'lender-currency-refresh',
      'lender-currency-daily',
      'lender-ingest-cron',
      'ucc-supervisor-cron',
      'lender-trigger-monitor'
    ]
    LOOP
      BEGIN
        PERFORM cron.unschedule(j);
      EXCEPTION WHEN OTHERS THEN
        -- Job didn't exist or no permission; ignore.
        NULL;
      END;
    END LOOP;
  END IF;
END
$outer$;

-- RPCs
DROP FUNCTION IF EXISTS public.validate_lender_lead(bigint, text)           CASCADE;
DROP FUNCTION IF EXISTS public.reject_lender_lead(bigint, text)             CASCADE;
DROP FUNCTION IF EXISTS public.add_manual_lender_link(text, text, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.mark_no_lender_identifiable(text, text)      CASCADE;
DROP FUNCTION IF EXISTS public.set_lender_pursuit_tier(text, text, text)    CASCADE;
DROP FUNCTION IF EXISTS public.auto_queue_lender_claims(text)               CASCADE;
DROP FUNCTION IF EXISTS public.normalize_lender_name(text)                  CASCADE;
DROP FUNCTION IF EXISTS public.try_promote_lender_to_validated()            CASCADE;
DROP FUNCTION IF EXISTS public.search_lender_evidence(vector, text, integer) CASCADE;
DROP FUNCTION IF EXISTS public.get_lender_validation_queue(integer, boolean) CASCADE;

-- Views
DROP VIEW IF EXISTS public.v_lender_validation_queue      CASCADE;
DROP VIEW IF EXISTS public.v_validated_lender_portfolio    CASCADE;
DROP VIEW IF EXISTS public.v_lender_pursuit_board          CASCADE;
DROP VIEW IF EXISTS public.v_plant_research_status         CASCADE;
DROP VIEW IF EXISTS public.v_admin_research_costs          CASCADE;
DROP VIEW IF EXISTS public.v_pitch_ready_plants            CASCADE;

-- Triggers
DROP TRIGGER IF EXISTS trg_mirror_plant_lender_to_unverified ON public.plant_lenders;
DROP TRIGGER IF EXISTS trg_claims_updated_at                 ON public.lender_evidence_claims;
DROP TRIGGER IF EXISTS trg_update_leads_updated_at           ON public.ucc_lender_leads_unverified;

-- v2 tables (corpus + claims)
DROP TABLE IF EXISTS public.lender_evidence_claims     CASCADE;
DROP TABLE IF EXISTS public.lender_evidence_chunks     CASCADE;
DROP TABLE IF EXISTS public.lender_evidence_documents  CASCADE;
DROP TABLE IF EXISTS public.lender_evidence_quarantine CASCADE;

-- UCC core tables
DROP TABLE IF EXISTS public.ucc_lender_pursuits        CASCADE;
DROP TABLE IF EXISTS public.ucc_lender_links           CASCADE;
DROP TABLE IF EXISTS public.ucc_lender_leads_unverified CASCADE;
DROP TABLE IF EXISTS public.ucc_review_actions         CASCADE;
DROP TABLE IF EXISTS public.ucc_agent_tasks            CASCADE;
DROP TABLE IF EXISTS public.ucc_agent_runs             CASCADE;
DROP TABLE IF EXISTS public.ucc_entities               CASCADE;
DROP TABLE IF EXISTS public.ucc_research_plants        CASCADE;

-- Legacy EDGAR tables
DROP TABLE IF EXISTS public.plant_lenders              CASCADE;

-- ── 2. pg_trgm extension (needed for fuzzy alias matching) ────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 3. lenders_canonical ─────────────────────────────────────────────────────
-- Master list of distinct lender institutions. All evidence FKs point here.
-- Parent-child allows "JPMorgan Chase Bank N.A." → parent "JPMorgan".

CREATE TABLE public.lenders_canonical (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  parent_id   uuid REFERENCES public.lenders_canonical(id) ON DELETE SET NULL,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.lenders_canonical ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lc_public_read"   ON public.lenders_canonical FOR SELECT USING (true);
CREATE POLICY "lc_service_write" ON public.lenders_canonical FOR ALL USING (auth.role() = 'service_role');

-- Seed known parent institutions
INSERT INTO public.lenders_canonical (name) VALUES
  ('JPMorgan Chase'),
  ('Bank of America'),
  ('Wells Fargo'),
  ('Citibank'),
  ('Goldman Sachs'),
  ('Morgan Stanley'),
  ('Barclays'),
  ('Deutsche Bank'),
  ('BNP Paribas'),
  ('Société Générale'),
  ('Crédit Agricole'),
  ('Natixis'),
  ('HSBC'),
  ('ING'),
  ('ABN AMRO'),
  ('Rabobank'),
  ('Santander'),
  ('BBVA'),
  ('UniCredit'),
  ('Intesa Sanpaolo'),
  ('Mitsubishi UFJ Financial Group'),
  ('Sumitomo Mitsui Banking Corporation'),
  ('Mizuho Financial Group'),
  ('MUFG'),
  ('Sumitomo Mitsui'),
  ('Mizuho'),
  ('KeyBanc'),
  ('Regions Bank'),
  ('Truist'),
  ('US Bancorp'),
  ('PNC Financial'),
  ('TD Bank'),
  ('Royal Bank of Canada'),
  ('Scotiabank'),
  ('Bank of Montreal'),
  ('CIBC'),
  ('National Bank of Canada'),
  ('NordLB'),
  ('Nord/LB'),
  ('KfW'),
  ('Helaba'),
  ('DekaBank'),
  ('DZ Bank'),
  ('Commerzbank'),
  ('Raiffeisen'),
  ('Credit Suisse'),
  ('UBS'),
  ('Macquarie'),
  ('Westpac'),
  ('ANZ'),
  ('Commonwealth Bank of Australia'),
  ('Korea Development Bank'),
  ('Export-Import Bank of Korea'),
  ('ICBC'),
  ('Bank of China'),
  ('CoBank'),
  ('CIT Group'),
  ('Silicon Valley Bank'),
  ('East West Bank'),
  ('Pacific Western Bank'),
  ('Fortis Capital'),
  ('TIAA'),
  ('MetLife'),
  ('Prudential Financial'),
  ('John Hancock'),
  ('Sun Life'),
  ('Manulife'),
  ('New York Life'),
  ('Principal Financial'),
  ('Nuveen'),
  ('Aegon'),
  ('Allianz'),
  ('AXA'),
  ('Zurich Insurance'),
  ('Aflac'),
  ('PGGM'),
  ('APG'),
  ('CDPQ'),
  ('Ontario Teachers'),
  ('CPP Investments');

-- ── 4. lender_aliases ────────────────────────────────────────────────────────
-- Every known variant name that maps to a canonical lender.
-- The resolver inserts new aliases when it makes a high-confidence match.

CREATE TABLE public.lender_aliases (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lender_id     uuid NOT NULL REFERENCES public.lenders_canonical(id) ON DELETE CASCADE,
  alias         text NOT NULL UNIQUE,           -- normalized form
  alias_raw     text,                           -- original un-normalized text
  source        text NOT NULL DEFAULT 'seed'
    CHECK (source IN ('seed','resolver','manual')),
  confidence    real NOT NULL DEFAULT 1.0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.lender_aliases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "la_public_read"   ON public.lender_aliases FOR SELECT USING (true);
CREATE POLICY "la_service_write" ON public.lender_aliases FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX idx_la_alias     ON public.lender_aliases USING gin(alias gin_trgm_ops);
CREATE INDEX idx_la_lender_id ON public.lender_aliases (lender_id);

-- Seed canonical name aliases (normalized = lowercase, stripped of common suffixes)
INSERT INTO public.lender_aliases (lender_id, alias, alias_raw, source)
SELECT lc.id, lower(regexp_replace(lc.name, '\s+', ' ', 'g')), lc.name, 'seed'
FROM public.lenders_canonical lc;

-- ── 5. lender_research_sessions ──────────────────────────────────────────────
-- One row per admin-triggered research run for a plant.

CREATE TABLE public.lender_research_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id        text NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','complete','budget_exceeded','failed','no_lender_identifiable')),
  trigger_type    text NOT NULL DEFAULT 'initial'
    CHECK (trigger_type IN ('initial','refresh','manual')),
  budget_usd      numeric NOT NULL DEFAULT 0.25,
  cost_usd        numeric NOT NULL DEFAULT 0,
  budget_exceeded boolean NOT NULL DEFAULT false,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  error_detail    text
);

ALTER TABLE public.lender_research_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lrs_public_read"   ON public.lender_research_sessions FOR SELECT USING (true);
CREATE POLICY "lrs_service_write" ON public.lender_research_sessions FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX idx_lrs_plant_id    ON public.lender_research_sessions (plant_id);
CREATE INDEX idx_lrs_status      ON public.lender_research_sessions (status);
CREATE INDEX idx_lrs_started_at  ON public.lender_research_sessions (started_at DESC);

-- ── 6. lender_research_claims ────────────────────────────────────────────────
-- Raw claims emitted by source workers; enriched by the synthesis agent.

CREATE TABLE public.lender_research_claims (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id          uuid NOT NULL REFERENCES public.lender_research_sessions(id) ON DELETE CASCADE,
  source_agent        text NOT NULL
    CHECK (source_agent IN ('edgar','records','web')),
  raw_lender_name     text NOT NULL,
  canonical_lender_id uuid REFERENCES public.lenders_canonical(id) ON DELETE SET NULL,
  quote               text,
  source_url          text,
  source_type         text NOT NULL DEFAULT 'unknown'
    CHECK (source_type IN ('edgar_filing','ucc_filing','county_record','news_article','press_release','web_page','manual')),
  evidence_date       date,
  loan_status         text NOT NULL DEFAULT 'unknown'
    CHECK (loan_status IN ('active','matured','refinanced','unknown')),
  role_tag            text NOT NULL DEFAULT 'unknown'
    CHECK (role_tag IN ('debt_lender','admin_agent','collateral_agent','syndicate_member','unknown')),
  confidence          real NOT NULL DEFAULT 0.0,
  dropped_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.lender_research_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lrc_public_read"   ON public.lender_research_claims FOR SELECT USING (true);
CREATE POLICY "lrc_service_write" ON public.lender_research_claims FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX idx_lrc_session_id          ON public.lender_research_claims (session_id);
CREATE INDEX idx_lrc_canonical_lender_id ON public.lender_research_claims (canonical_lender_id);
CREATE INDEX idx_lrc_role_tag            ON public.lender_research_claims (role_tag);
CREATE INDEX idx_lrc_loan_status         ON public.lender_research_claims (loan_status);

-- ── 7. lender_links ──────────────────────────────────────────────────────────
-- One row per validated/pending plant ↔ canonical lender pair.
-- This is the single source of truth for both the validation UI and the
-- plant Financing tab.

CREATE TABLE public.lender_links (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_id            text NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  canonical_lender_id uuid NOT NULL REFERENCES public.lenders_canonical(id) ON DELETE CASCADE,
  validation_status   text NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending','validated','rejected','manual','no_lender_identifiable')),
  primary_claim_id    bigint REFERENCES public.lender_research_claims(id) ON DELETE SET NULL,
  legacy_raw_name     text,     -- preserved when replaying archived validated rows
  validated_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  validated_at        timestamptz,
  reviewer_note       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plant_id, canonical_lender_id)
);

ALTER TABLE public.lender_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ll_public_read"   ON public.lender_links FOR SELECT USING (true);
CREATE POLICY "ll_service_write" ON public.lender_links FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX idx_ll_plant_id            ON public.lender_links (plant_id);
CREATE INDEX idx_ll_canonical_lender_id ON public.lender_links (canonical_lender_id);
CREATE INDEX idx_ll_validation_status   ON public.lender_links (validation_status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public._set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_ll_updated_at
  BEFORE UPDATE ON public.lender_links
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

-- ── 8. lender_link_evidence ──────────────────────────────────────────────────
-- Many-to-many: a validated link can be backed by multiple claims.

CREATE TABLE public.lender_link_evidence (
  link_id  bigint NOT NULL REFERENCES public.lender_links(id) ON DELETE CASCADE,
  claim_id bigint NOT NULL REFERENCES public.lender_research_claims(id) ON DELETE CASCADE,
  PRIMARY KEY (link_id, claim_id)
);

ALTER TABLE public.lender_link_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lle_public_read"   ON public.lender_link_evidence FOR SELECT USING (true);
CREATE POLICY "lle_service_write" ON public.lender_link_evidence FOR ALL USING (auth.role() = 'service_role');

-- ── 9. lender_pursuits ───────────────────────────────────────────────────────
-- One row per canonical lender that has been classified by a consultant.

CREATE TABLE public.lender_pursuits (
  canonical_lender_id uuid PRIMARY KEY REFERENCES public.lenders_canonical(id) ON DELETE CASCADE,
  tier                text NOT NULL CHECK (tier IN ('hot','warm','cold')),
  classified_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  classified_at       timestamptz NOT NULL DEFAULT now(),
  notes               text
);

ALTER TABLE public.lender_pursuits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lp_public_read"   ON public.lender_pursuits FOR SELECT USING (true);
CREATE POLICY "lp_service_write" ON public.lender_pursuits FOR ALL USING (auth.role() = 'service_role');

-- ── 10. plant_research_state ─────────────────────────────────────────────────
-- Summary row per plant — drives the admin panel and the Research button.

CREATE TABLE public.plant_research_state (
  plant_id           text PRIMARY KEY REFERENCES public.plants(id) ON DELETE CASCADE,
  last_session_id    uuid REFERENCES public.lender_research_sessions(id) ON DELETE SET NULL,
  last_researched_at timestamptz,
  status             text NOT NULL DEFAULT 'never'
    CHECK (status IN ('never','in_progress','complete','budget_exceeded','failed','no_lender_identifiable')),
  validated_count    integer NOT NULL DEFAULT 0,
  pending_count      integer NOT NULL DEFAULT 0
);

ALTER TABLE public.plant_research_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prs_public_read"   ON public.plant_research_state FOR SELECT USING (true);
CREATE POLICY "prs_service_write" ON public.plant_research_state FOR ALL USING (auth.role() = 'service_role');

-- ── 11. normalize_lender_name() ──────────────────────────────────────────────
-- Canonical normalization used by the resolver and seed-alias generation.
-- Lowercase → strip suffixes/roles → keep alphanum + spaces → collapse.

CREATE OR REPLACE FUNCTION public.normalize_lender_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(coalesce(p_name, '')),
          '\m(llc|lp|inc|corp|co|ltd|na|n\.a\.|plc|ag|as agent|as administrative agent|as collateral agent|as syndication agent|as documentation agent|as joint lead arranger|as lead arranger)\M',
          '',
          'g'
        ),
        '[^a-z0-9\s]',
        '',
        'g'
      ),
      '\s+',
      ' ',
      'g'
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.normalize_lender_name(text) TO authenticated, anon, service_role;

-- ── 12. resolve_lender_name() ────────────────────────────────────────────────
-- Deterministic resolver: exact alias match → trigram fuzzy → null.
-- Returns canonical lender id and match confidence.
-- Used by lender-resolver edge function and by v4 RPCs.

CREATE OR REPLACE FUNCTION public.resolve_lender_name(
  p_raw_name  text,
  OUT out_canonical_id  uuid,
  OUT out_confidence    real,
  OUT out_match_type    text   -- 'exact'|'alias'|'fuzzy'|'none'
)
RETURNS record
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_normalized text;
  v_best_id    uuid;
  v_best_sim   real;
BEGIN
  v_normalized := public.normalize_lender_name(p_raw_name);

  -- 1. Exact alias hit
  SELECT lender_id INTO v_best_id
  FROM   public.lender_aliases
  WHERE  alias = v_normalized
  LIMIT  1;

  IF v_best_id IS NOT NULL THEN
    out_canonical_id := v_best_id;
    out_confidence   := 1.0;
    out_match_type   := 'alias';
    RETURN;
  END IF;

  -- 2. Trigram fuzzy against aliases (threshold 0.4)
  SELECT lender_id, similarity(alias, v_normalized)
  INTO   v_best_id, v_best_sim
  FROM   public.lender_aliases
  WHERE  alias % v_normalized
  ORDER  BY similarity(alias, v_normalized) DESC
  LIMIT  1;

  IF v_best_id IS NOT NULL AND v_best_sim >= 0.4 THEN
    out_canonical_id := v_best_id;
    out_confidence   := v_best_sim;
    out_match_type   := 'fuzzy';
    RETURN;
  END IF;

  -- 3. No match
  out_canonical_id := NULL;
  out_confidence   := 0.0;
  out_match_type   := 'none';
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_lender_name(text) TO authenticated, anon, service_role;

-- ── 13. v4 RPCs ──────────────────────────────────────────────────────────────

-- 13a. validate_lender_link
CREATE OR REPLACE FUNCTION public.validate_lender_link(
  p_link_id     bigint,
  p_note        text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.lender_links
  SET    validation_status = 'validated',
         validated_by      = auth.uid(),
         validated_at      = now(),
         reviewer_note     = p_note
  WHERE  id = p_link_id;

  -- Reflect in plant_research_state counts
  UPDATE public.plant_research_state prs
  SET    validated_count = (
           SELECT count(*) FROM public.lender_links
           WHERE plant_id = prs.plant_id AND validation_status = 'validated'
         ),
         pending_count = (
           SELECT count(*) FROM public.lender_links
           WHERE plant_id = prs.plant_id AND validation_status = 'pending'
         )
  WHERE  prs.plant_id = (SELECT plant_id FROM public.lender_links WHERE id = p_link_id);
END;
$$;

-- 13b. reject_lender_link
CREATE OR REPLACE FUNCTION public.reject_lender_link(
  p_link_id bigint,
  p_note    text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.lender_links
  SET    validation_status = 'rejected',
         validated_by      = auth.uid(),
         validated_at      = now(),
         reviewer_note     = p_note
  WHERE  id = p_link_id;

  UPDATE public.plant_research_state prs
  SET    pending_count = (
           SELECT count(*) FROM public.lender_links
           WHERE plant_id = prs.plant_id AND validation_status = 'pending'
         )
  WHERE  prs.plant_id = (SELECT plant_id FROM public.lender_links WHERE id = p_link_id);
END;
$$;

-- 13c. add_manual_lender_link
CREATE OR REPLACE FUNCTION public.add_manual_lender_link(
  p_plant_id       text,
  p_lender_name    text,
  p_source_url     text DEFAULT NULL,
  p_note           text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_canonical_id   uuid;
  v_confidence     real;
  v_match_type     text;
  v_link_id        bigint;
  v_res            record;
BEGIN
  SELECT * INTO v_res FROM public.resolve_lender_name(p_lender_name);
  v_canonical_id := v_res.out_canonical_id;
  v_confidence   := v_res.out_confidence;
  v_match_type   := v_res.out_match_type;

  -- If no match, create a new canonical entry
  IF v_canonical_id IS NULL THEN
    INSERT INTO public.lenders_canonical (name)
    VALUES (p_lender_name)
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_canonical_id;

    INSERT INTO public.lender_aliases (lender_id, alias, alias_raw, source)
    VALUES (v_canonical_id, public.normalize_lender_name(p_lender_name), p_lender_name, 'manual')
    ON CONFLICT (alias) DO NOTHING;
  END IF;

  INSERT INTO public.lender_links
    (plant_id, canonical_lender_id, validation_status, legacy_raw_name, validated_by, validated_at, reviewer_note)
  VALUES
    (p_plant_id, v_canonical_id, 'manual', p_lender_name, auth.uid(), now(), p_note)
  ON CONFLICT (plant_id, canonical_lender_id) DO UPDATE
    SET validation_status = 'manual',
        validated_by      = auth.uid(),
        validated_at      = now(),
        reviewer_note     = p_note
  RETURNING id INTO v_link_id;

  RETURN v_link_id;
END;
$$;

-- 13d. mark_plant_no_lender
CREATE OR REPLACE FUNCTION public.mark_plant_no_lender(
  p_plant_id text,
  p_note     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Reject all pending links for this plant
  UPDATE public.lender_links
  SET    validation_status = 'no_lender_identifiable',
         validated_by      = auth.uid(),
         validated_at      = now(),
         reviewer_note     = coalesce(p_note, 'No lender identifiable')
  WHERE  plant_id = p_plant_id
    AND  validation_status = 'pending';

  UPDATE public.plant_research_state
  SET    status        = 'no_lender_identifiable',
         pending_count = 0
  WHERE  plant_id = p_plant_id;
END;
$$;

-- 13e. set_lender_pursuit_tier
CREATE OR REPLACE FUNCTION public.set_lender_pursuit_tier(
  p_canonical_lender_id uuid,
  p_tier                text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_tier NOT IN ('hot','warm','cold') THEN
    RAISE EXCEPTION 'tier must be hot, warm, or cold';
  END IF;

  INSERT INTO public.lender_pursuits (canonical_lender_id, tier, classified_by, classified_at)
  VALUES (p_canonical_lender_id, p_tier, auth.uid(), now())
  ON CONFLICT (canonical_lender_id) DO UPDATE
    SET tier           = EXCLUDED.tier,
        classified_by  = EXCLUDED.classified_by,
        classified_at  = EXCLUDED.classified_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_lender_link(bigint, text)                      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_lender_link(bigint, text)                        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_manual_lender_link(text, text, text, text)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_plant_no_lender(text, text)                        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_lender_pursuit_tier(uuid, text)                     TO authenticated, service_role;

-- ── 14. Views ────────────────────────────────────────────────────────────────

-- 14a. v_lender_validation_queue
-- What the To Validate tab shows: pending links grouped by canonical lender,
-- enriched with plant curtailment context.
DROP VIEW IF EXISTS public.v_lender_validation_queue;
CREATE VIEW public.v_lender_validation_queue AS
SELECT
  lc.id                                      AS canonical_lender_id,
  lc.name                                    AS lender_name,
  count(ll.id)                               AS pending_count,
  count(DISTINCT ll.plant_id)                AS pending_plant_count,
  count(DISTINCT ll.plant_id)
    FILTER (WHERE p.is_likely_curtailed)     AS curtailed_plant_count,
  coalesce(sum(p.nameplate_capacity_mw)
    FILTER (WHERE p.is_likely_curtailed), 0) AS curtailed_mw,
  max(ll.created_at)                         AS last_lead_at
FROM      public.lender_links               ll
JOIN      public.lenders_canonical          lc ON lc.id = ll.canonical_lender_id
JOIN      public.plants                     p  ON p.id  = ll.plant_id
WHERE     ll.validation_status = 'pending'
GROUP BY  lc.id, lc.name;

-- 14b. v_validated_lender_portfolio
-- Validated tab: one row per canonical lender with their confirmed plant list.
DROP VIEW IF EXISTS public.v_validated_lender_portfolio;
CREATE VIEW public.v_validated_lender_portfolio AS
SELECT
  lc.id                                      AS canonical_lender_id,
  lc.name                                    AS lender_name,
  lp.tier,
  count(ll.id)                               AS validated_plant_count,
  coalesce(sum(p.nameplate_capacity_mw), 0)    AS total_curtailed_mw,
  array_agg(DISTINCT p.name ORDER BY p.name) AS plant_names,
  max(ll.validated_at)                       AS last_validated_at
FROM      public.lender_links               ll
JOIN      public.lenders_canonical          lc ON lc.id  = ll.canonical_lender_id
JOIN      public.plants                     p  ON p.id   = ll.plant_id
LEFT JOIN public.lender_pursuits            lp ON lp.canonical_lender_id = lc.id
WHERE     ll.validation_status IN ('validated','manual')
GROUP BY  lc.id, lc.name, lp.tier;

-- 14c. v_lender_pursuit_board
-- Pursuits tab: tier-ordered lenders with their plant context.
DROP VIEW IF EXISTS public.v_lender_pursuit_board;
CREATE VIEW public.v_lender_pursuit_board AS
SELECT
  lc.id                                      AS canonical_lender_id,
  lc.name                                    AS lender_name,
  lp.tier,
  lp.classified_at,
  count(ll.id)                               AS validated_plant_count,
  coalesce(sum(p.nameplate_capacity_mw), 0)    AS total_curtailed_mw,
  array_agg(DISTINCT p.name ORDER BY p.name) AS plant_names
FROM      public.lender_pursuits             lp
JOIN      public.lenders_canonical           lc ON lc.id  = lp.canonical_lender_id
JOIN      public.lender_links                ll ON ll.canonical_lender_id = lc.id
                                                AND ll.validation_status IN ('validated','manual')
JOIN      public.plants                      p  ON p.id   = ll.plant_id
GROUP BY  lc.id, lc.name, lp.tier, lp.classified_at
ORDER BY  CASE lp.tier WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 ELSE 3 END;

-- 14d. v_plant_research_state
-- Admin panel: per-plant research status and cost.
DROP VIEW IF EXISTS public.v_plant_research_state;
CREATE VIEW public.v_plant_research_state AS
SELECT
  p.id                                       AS plant_id,
  p.name                                     AS plant_name,
  p.state,
  p.nameplate_capacity_mw,
  p.is_likely_curtailed,
  coalesce(prs.status, 'never')              AS research_status,
  prs.last_researched_at,
  prs.validated_count,
  prs.pending_count,
  s.cost_usd                                 AS last_session_cost_usd,
  s.budget_exceeded                          AS budget_exceeded
FROM      public.plants                      p
LEFT JOIN public.plant_research_state        prs ON prs.plant_id        = p.id
LEFT JOIN public.lender_research_sessions    s   ON s.id                = prs.last_session_id;

-- 14e. v_admin_research_costs
-- Cost dashboard (admin-only; no PII).
DROP VIEW IF EXISTS public.v_admin_research_costs;
CREATE VIEW public.v_admin_research_costs AS
SELECT
  date_trunc('month', started_at)            AS month,
  count(*)                                   AS sessions,
  sum(cost_usd)                              AS total_cost_usd,
  avg(cost_usd)                              AS avg_cost_usd,
  count(*) FILTER (WHERE budget_exceeded)    AS budget_exceeded_count
FROM public.lender_research_sessions
GROUP BY 1
ORDER BY 1 DESC;

-- 14f. v_plant_financing — the single source shown in the plant Financing tab
DROP VIEW IF EXISTS public.v_plant_financing;
CREATE VIEW public.v_plant_financing AS
SELECT
  ll.plant_id,
  lc.name                                    AS lender_name,
  lc.id                                      AS canonical_lender_id,
  ll.validation_status,
  ll.validated_at,
  -- Best supporting evidence
  lrc.source_url,
  lrc.quote                                  AS evidence_quote,
  lrc.source_type,
  lrc.evidence_date,
  lrc.loan_status,
  lrc.role_tag,
  lrc.confidence
FROM      public.lender_links                ll
JOIN      public.lenders_canonical           lc  ON lc.id  = ll.canonical_lender_id
LEFT JOIN public.lender_research_claims      lrc ON lrc.id = ll.primary_claim_id
WHERE     ll.validation_status IN ('validated','manual');

-- ── 15. Replay archived validated rows ───────────────────────────────────────
-- Insert into lender_links as 'validated' (where resolver matches) or
-- 'manual' (where it does not). plant_research_state is also seeded.

DO $$
DECLARE
  r           record;
  v_res       record;
  v_can_id    uuid;
  v_plant_id  text;
BEGIN
  FOR r IN SELECT DISTINCT ON (plant_code, lender_normalized)
               plant_code, raw_lender_name, lender_normalized,
               source_url, evidence_type, validated_at, validated_by_email
           FROM public._archive_v3_validated_lenders
           ORDER BY plant_code, lender_normalized, validated_at DESC
  LOOP
    -- Find the plant.id from the EIA plant code
    SELECT id INTO v_plant_id FROM public.plants WHERE eia_plant_code = r.plant_code LIMIT 1;
    IF v_plant_id IS NULL THEN CONTINUE; END IF;

    SELECT * INTO v_res FROM public.resolve_lender_name(r.raw_lender_name);
    v_can_id := v_res.out_canonical_id;

    -- If no canonical match, create a new entry to preserve the human work
    IF v_can_id IS NULL THEN
      INSERT INTO public.lenders_canonical (name)
      VALUES (r.raw_lender_name)
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id INTO v_can_id;

      INSERT INTO public.lender_aliases (lender_id, alias, alias_raw, source)
      VALUES (v_can_id, r.lender_normalized, r.raw_lender_name, 'manual')
      ON CONFLICT (alias) DO NOTHING;
    END IF;

    -- Upsert the validated link
    INSERT INTO public.lender_links
      (plant_id, canonical_lender_id, validation_status, legacy_raw_name, validated_at)
    VALUES
      (v_plant_id, v_can_id,
       CASE WHEN v_res.out_match_type = 'none' THEN 'manual' ELSE 'validated' END,
       r.raw_lender_name, r.validated_at)
    ON CONFLICT (plant_id, canonical_lender_id) DO UPDATE
      SET validation_status = EXCLUDED.validation_status,
          legacy_raw_name   = EXCLUDED.legacy_raw_name,
          validated_at      = EXCLUDED.validated_at;

    -- Seed plant_research_state
    INSERT INTO public.plant_research_state (plant_id, last_researched_at, status)
    VALUES (v_plant_id, r.validated_at, 'complete')
    ON CONFLICT (plant_id) DO UPDATE
      SET last_researched_at = GREATEST(plant_research_state.last_researched_at, EXCLUDED.last_researched_at),
          status             = 'complete';
  END LOOP;
END;
$$;

-- Refresh counts on plant_research_state for replayed rows
UPDATE public.plant_research_state prs
SET    validated_count = (
         SELECT count(*) FROM public.lender_links
         WHERE plant_id = prs.plant_id AND validation_status IN ('validated','manual')
       ),
       pending_count = (
         SELECT count(*) FROM public.lender_links
         WHERE plant_id = prs.plant_id AND validation_status = 'pending'
       );
