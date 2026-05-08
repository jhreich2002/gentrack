-- ============================================================
-- Unified Lender Validation & Pursuit Workflow
--
-- Marries the legacy `plant_lenders` (EDGAR) pipeline and the UCC
-- pipeline (`ucc_lender_links`, `ucc_lender_leads_unverified`) into a
-- single human-validation surface.
--
--   1. SQL helper `public.normalize_lender_name(text)` matching the JS
--      normalizer used by `ucc-edgar-worker` / `ucc-supplement-worker`.
--   2. Schema additions on `ucc_lender_leads_unverified`:
--        evidence_type += 'edgar_loan' | 'manual'
--        lead_status, reviewed_by/at, reviewer_note, legacy_plant_lender_id
--   3. `ucc_research_plants.lender_resolution`.
--   4. New table `ucc_lender_pursuits` (HOT/WARM/COLD).
--   5. Views `v_lender_validation_queue`, `v_validated_lender_portfolio`.
--   6. Promotion function `try_promote_lender_to_validated`.
--   7. RPCs: validate / reject / manual / no-lender / set-tier.
--   8. One-shot backfill of `plant_lenders` -> `ucc_lender_leads_unverified`.
--   9. AFTER INSERT trigger on `plant_lenders` for continuous mirroring.
-- ============================================================

-- ── 1. normalize_lender_name() ───────────────────────────────────────────────
-- Mirrors the TS `normalizeName()` in `ucc-edgar-worker/index.ts`:
--   lowercase → strip common suffixes → keep [a-z0-9 ] → collapse spaces.
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
          '\m(llc|lp|inc|corp|co|ltd|na|n\.a\.|plc|as agent|as collateral agent)\M',
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

-- ── 2. ucc_lender_leads_unverified additions ─────────────────────────────────

-- 2a. Allow 'edgar_loan' and 'manual' evidence types.
ALTER TABLE public.ucc_lender_leads_unverified
  DROP CONSTRAINT IF EXISTS ucc_lender_leads_unverified_evidence_type_check;

ALTER TABLE public.ucc_lender_leads_unverified
  ADD CONSTRAINT ucc_lender_leads_unverified_evidence_type_check
  CHECK (evidence_type IN (
    'inferred',
    'sponsor_pattern',
    'web_scrape',
    'llm_inference',
    'news',
    'news_article',
    'doe_lpo',
    'ferc',
    'edgar_loan',
    'manual'
  ));

-- 2b. lead_status column drives queue membership. Existing rows default to
-- 'pending' so they appear in the To Validate queue. Already-approved rows
-- (human_approved=true) are mapped to 'validated'.
ALTER TABLE public.ucc_lender_leads_unverified
  ADD COLUMN IF NOT EXISTS lead_status text NOT NULL DEFAULT 'pending'
    CHECK (lead_status IN ('pending', 'validated', 'rejected', 'superseded')),
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewer_note text,
  ADD COLUMN IF NOT EXISTS legacy_plant_lender_id bigint;

-- One-time alignment for any pre-existing approvals from the old review queue.
UPDATE public.ucc_lender_leads_unverified
   SET lead_status = 'validated', reviewed_at = COALESCE(reviewed_at, updated_at, created_at)
 WHERE human_approved = true
   AND lead_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ullu_lead_status
  ON public.ucc_lender_leads_unverified (lead_status);

CREATE INDEX IF NOT EXISTS idx_ullu_lender_normalized
  ON public.ucc_lender_leads_unverified (lender_normalized);

CREATE INDEX IF NOT EXISTS idx_ullu_legacy_plant_lender
  ON public.ucc_lender_leads_unverified (legacy_plant_lender_id)
  WHERE legacy_plant_lender_id IS NOT NULL;

-- ── 3. ucc_research_plants.lender_resolution ─────────────────────────────────
ALTER TABLE public.ucc_research_plants
  ADD COLUMN IF NOT EXISTS lender_resolution text NOT NULL DEFAULT 'pending'
    CHECK (lender_resolution IN ('pending', 'validated', 'no_lender_identifiable', 'manual'));

CREATE INDEX IF NOT EXISTS idx_urp_lender_resolution
  ON public.ucc_research_plants (lender_resolution);

-- Plants that don't yet have a research row but have lender candidates need
-- one. Backfill at the end of this migration after legacy data is mirrored.

-- ── 4. ucc_lender_pursuits ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ucc_lender_pursuits (
  lender_normalized   text PRIMARY KEY,
  lender_name         text NOT NULL,
  tier                text CHECK (tier IN ('hot', 'warm', 'cold')),
  tier_set_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  tier_set_at         timestamptz,
  notes               text,
  promoted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ucc_lender_pursuits ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_lender_pursuits' AND policyname = 'ulp_public_read'
  ) THEN
    CREATE POLICY "ulp_public_read" ON public.ucc_lender_pursuits FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ucc_lender_pursuits' AND policyname = 'ulp_authenticated_write'
  ) THEN
    CREATE POLICY "ulp_authenticated_write" ON public.ucc_lender_pursuits
      FOR ALL USING (auth.role() IN ('authenticated', 'service_role'))
      WITH CHECK (auth.role() IN ('authenticated', 'service_role'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ulp_tier ON public.ucc_lender_pursuits (tier);
CREATE INDEX IF NOT EXISTS idx_ulp_promoted_at ON public.ucc_lender_pursuits (promoted_at DESC);

-- ── 5. Views ─────────────────────────────────────────────────────────────────

-- v_lender_validation_queue: per-lender pending aggregates joined to plants
-- so the To Validate tab can rank by curtailed-MW exposure and pending count.
CREATE OR REPLACE VIEW public.v_lender_validation_queue AS
SELECT
  l.lender_normalized,
  -- Pick a representative display name (most recent).
  (array_agg(l.lender_name ORDER BY l.created_at DESC NULLS LAST))[1] AS lender_name,
  COUNT(*) FILTER (WHERE l.lead_status = 'pending')                          AS pending_count,
  COUNT(DISTINCT l.plant_code) FILTER (WHERE l.lead_status = 'pending')      AS pending_plant_count,
  COUNT(DISTINCT l.plant_code) FILTER (
    WHERE l.lead_status = 'pending' AND p.is_likely_curtailed = true
  )                                                                          AS curtailed_plant_count,
  COALESCE(
    SUM(DISTINCT p.nameplate_capacity_mw) FILTER (
      WHERE l.lead_status = 'pending' AND p.is_likely_curtailed = true
    ),
    0
  )                                                                          AS curtailed_mw,
  MAX(l.updated_at)                                                          AS last_lead_at
FROM public.ucc_lender_leads_unverified l
LEFT JOIN public.plants p ON p.eia_plant_code = l.plant_code
WHERE l.lender_normalized IS NOT NULL
  AND l.lender_normalized <> ''
GROUP BY l.lender_normalized
HAVING COUNT(*) FILTER (WHERE l.lead_status = 'pending') > 0;

GRANT SELECT ON public.v_lender_validation_queue TO authenticated, anon;

-- v_validated_lender_portfolio: validated links per lender for the Validated
-- and Pursuits tabs.
CREATE OR REPLACE VIEW public.v_validated_lender_portfolio AS
SELECT
  ll.lender_normalized,
  (array_agg(ll.lender_name ORDER BY ll.created_at DESC NULLS LAST))[1] AS lender_name,
  COUNT(*)                                                              AS validated_plant_count,
  COUNT(*) FILTER (WHERE p.is_likely_curtailed = true)                  AS curtailed_plant_count,
  COALESCE(
    SUM(p.nameplate_capacity_mw) FILTER (WHERE p.is_likely_curtailed = true),
    0
  )                                                                     AS curtailed_mw,
  MAX(ll.updated_at)                                                    AS last_validated_at
FROM public.ucc_lender_links ll
LEFT JOIN public.plants p ON p.eia_plant_code = ll.plant_code
WHERE ll.lender_normalized IS NOT NULL
  AND ll.lender_normalized <> ''
GROUP BY ll.lender_normalized;

GRANT SELECT ON public.v_validated_lender_portfolio TO authenticated, anon;

-- ── 6. try_promote_lender_to_validated() ─────────────────────────────────────
-- A lender graduates to the Validated/Pursuits surface once every candidate
-- plant for that lender has been adjudicated AND at least one validated link
-- exists in `ucc_lender_links`.
CREATE OR REPLACE FUNCTION public.try_promote_lender_to_validated(p_lender_normalized text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pending  integer;
  v_links    integer;
  v_name     text;
BEGIN
  IF p_lender_normalized IS NULL OR p_lender_normalized = '' THEN
    RETURN false;
  END IF;

  SELECT COUNT(*) INTO v_pending
    FROM ucc_lender_leads_unverified
   WHERE lender_normalized = p_lender_normalized
     AND lead_status = 'pending';

  IF v_pending > 0 THEN
    RETURN false;
  END IF;

  SELECT COUNT(*) INTO v_links
    FROM ucc_lender_links
   WHERE lender_normalized = p_lender_normalized;

  IF v_links = 0 THEN
    RETURN false;
  END IF;

  SELECT lender_name INTO v_name
    FROM ucc_lender_links
   WHERE lender_normalized = p_lender_normalized
   ORDER BY created_at DESC
   LIMIT 1;

  INSERT INTO ucc_lender_pursuits (lender_normalized, lender_name, promoted_at)
  VALUES (p_lender_normalized, COALESCE(v_name, p_lender_normalized), now())
  ON CONFLICT (lender_normalized) DO UPDATE
    SET lender_name = EXCLUDED.lender_name,
        promoted_at = COALESCE(ucc_lender_pursuits.promoted_at, EXCLUDED.promoted_at),
        updated_at  = now();

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_promote_lender_to_validated(text) TO authenticated, service_role;

-- ── 7. RPCs ──────────────────────────────────────────────────────────────────

-- 7a. validate_lender_lead
CREATE OR REPLACE FUNCTION public.validate_lender_lead(
  p_lead_id bigint,
  p_note    text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead         ucc_lender_leads_unverified%ROWTYPE;
  v_user_id      uuid := auth.uid();
  v_user_email   text;
  v_link_id      bigint;
  v_action_id    bigint;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_lead FROM ucc_lender_leads_unverified WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id;
  END IF;

  IF v_lead.lead_status <> 'pending' THEN
    RAISE EXCEPTION 'Lead % already %', p_lead_id, v_lead.lead_status;
  END IF;

  -- Promote into ucc_lender_links. Use ON CONFLICT to no-op if a duplicate
  -- (plant_code, lender_normalized, evidence_type) already exists.
  INSERT INTO ucc_lender_links (
    plant_code, lender_entity_id, lender_name, lender_normalized,
    confidence_class, evidence_type, evidence_summary, source_url,
    human_approved, run_id
  )
  VALUES (
    v_lead.plant_code, v_lead.lender_entity_id, v_lead.lender_name, v_lead.lender_normalized,
    CASE WHEN v_lead.confidence_class IN ('confirmed','high_confidence','highly_likely','possible')
         THEN v_lead.confidence_class
         ELSE 'highly_likely' END,
    -- ucc_lender_links allows the broader evidence_type set defined in 20260424;
    -- map our extended values back to the closest accepted value.
    CASE
      WHEN v_lead.evidence_type IN ('direct_filing','county_record','edgar','sponsor_pattern','supplement')
        THEN v_lead.evidence_type
      WHEN v_lead.evidence_type = 'edgar_loan' THEN 'edgar'
      WHEN v_lead.evidence_type IN ('manual','inferred','llm_inference','web_scrape','news','news_article','doe_lpo','ferc')
        THEN 'supplement'
      ELSE 'supplement'
    END,
    COALESCE(v_lead.evidence_summary, ''),
    v_lead.source_url,
    true,
    v_lead.run_id
  )
  ON CONFLICT (plant_code, lender_normalized, evidence_type) DO UPDATE
    SET human_approved   = true,
        evidence_summary = COALESCE(EXCLUDED.evidence_summary, ucc_lender_links.evidence_summary),
        source_url       = COALESCE(EXCLUDED.source_url, ucc_lender_links.source_url),
        updated_at       = now()
  RETURNING id INTO v_link_id;

  -- Audit. ucc_review_actions stores email; capture it for display.
  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

  INSERT INTO ucc_review_actions (plant_code, lender_link_id, action, notes, reviewer_email)
  VALUES (v_lead.plant_code, v_link_id, 'approve', p_note, v_user_email)
  RETURNING id INTO v_action_id;

  -- Mark lead validated.
  UPDATE ucc_lender_leads_unverified
     SET lead_status   = 'validated',
         human_approved = true,
         reviewed_by   = v_user_id,
         reviewed_at   = now(),
         reviewer_note = p_note,
         updated_at    = now()
   WHERE id = p_lead_id;

  -- Update plant resolution if not already.
  UPDATE ucc_research_plants
     SET lender_resolution = CASE
                               WHEN lender_resolution IN ('no_lender_identifiable')
                                 THEN lender_resolution
                               ELSE 'validated'
                             END,
         updated_at = now()
   WHERE plant_code = v_lead.plant_code;

  -- Try promote.
  PERFORM try_promote_lender_to_validated(v_lead.lender_normalized);

  RETURN v_link_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_lender_lead(bigint, text) TO authenticated, service_role;

-- 7b. reject_lender_lead
CREATE OR REPLACE FUNCTION public.reject_lender_lead(
  p_lead_id bigint,
  p_reason  text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead       ucc_lender_leads_unverified%ROWTYPE;
  v_user_id    uuid := auth.uid();
  v_user_email text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_lead FROM ucc_lender_leads_unverified WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id;
  END IF;

  IF v_lead.lead_status <> 'pending' THEN
    RAISE EXCEPTION 'Lead % already %', p_lead_id, v_lead.lead_status;
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

  INSERT INTO ucc_review_actions (plant_code, lender_link_id, action, notes, reviewer_email)
  VALUES (v_lead.plant_code, NULL, 'reject', p_reason, v_user_email);

  UPDATE ucc_lender_leads_unverified
     SET lead_status   = 'rejected',
         reviewed_by   = v_user_id,
         reviewed_at   = now(),
         reviewer_note = p_reason,
         updated_at    = now()
   WHERE id = p_lead_id;

  PERFORM try_promote_lender_to_validated(v_lead.lender_normalized);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_lender_lead(bigint, text) TO authenticated, service_role;

-- 7c. add_manual_lender_link
CREATE OR REPLACE FUNCTION public.add_manual_lender_link(
  p_plant_code     text,
  p_lender_name    text,
  p_source_url     text,
  p_note           text,
  p_facility_type  text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_user_email  text;
  v_normalized  text;
  v_entity_id   bigint;
  v_link_id     bigint;
  v_summary     text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF coalesce(trim(p_lender_name), '') = '' THEN
    RAISE EXCEPTION 'Lender name required';
  END IF;
  IF coalesce(trim(p_source_url), '') = '' THEN
    RAISE EXCEPTION 'Source URL required';
  END IF;
  IF coalesce(length(trim(p_note)), 0) < 20 THEN
    RAISE EXCEPTION 'Justification note must be at least 20 characters';
  END IF;

  v_normalized := normalize_lender_name(p_lender_name);
  IF v_normalized = '' THEN
    RAISE EXCEPTION 'Lender name does not normalize to a valid token';
  END IF;

  -- Upsert lender entity. Match on (normalized_name, entity_type, jurisdiction).
  INSERT INTO ucc_entities (entity_name, entity_type, normalized_name, source, source_url)
  VALUES (p_lender_name, 'lender', v_normalized, 'manual', p_source_url)
  ON CONFLICT (normalized_name, entity_type, jurisdiction) DO UPDATE
    SET entity_name = EXCLUDED.entity_name
  RETURNING id INTO v_entity_id;

  IF v_entity_id IS NULL THEN
    SELECT id INTO v_entity_id
      FROM ucc_entities
     WHERE normalized_name = v_normalized AND entity_type = 'lender'
     LIMIT 1;
  END IF;

  v_summary := 'Manual entry by reviewer: ' || trim(p_note);
  IF p_facility_type IS NOT NULL THEN
    v_summary := v_summary || ' [facility=' || p_facility_type || ']';
  END IF;

  -- Insert into ucc_lender_links as a confirmed, human-approved manual link.
  INSERT INTO ucc_lender_links (
    plant_code, lender_entity_id, lender_name, lender_normalized,
    confidence_class, evidence_type, evidence_summary, source_url, human_approved
  )
  VALUES (
    p_plant_code, v_entity_id, p_lender_name, v_normalized,
    'confirmed', 'supplement', v_summary, p_source_url, true
  )
  ON CONFLICT (plant_code, lender_normalized, evidence_type) DO UPDATE
    SET human_approved   = true,
        evidence_summary = EXCLUDED.evidence_summary,
        source_url       = EXCLUDED.source_url,
        updated_at       = now()
  RETURNING id INTO v_link_id;

  -- Audit.
  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;
  INSERT INTO ucc_review_actions (plant_code, lender_link_id, action, notes, reviewer_email)
  VALUES (p_plant_code, v_link_id, 'approve', 'MANUAL: ' || trim(p_note), v_user_email);

  -- Supersede any pending leads for this plant — operator chose manual entry
  -- because they didn't trust the automated evidence.
  UPDATE ucc_lender_leads_unverified
     SET lead_status   = 'superseded',
         reviewed_by   = v_user_id,
         reviewed_at   = now(),
         reviewer_note = COALESCE(reviewer_note, '') || ' [superseded by manual entry]',
         updated_at    = now()
   WHERE plant_code = p_plant_code
     AND lead_status = 'pending';

  -- Mark plant resolution.
  INSERT INTO ucc_research_plants (plant_code, lender_resolution)
  VALUES (p_plant_code, 'manual')
  ON CONFLICT (plant_code) DO UPDATE
    SET lender_resolution = 'manual', updated_at = now();

  -- Promote (this lender) and any other lenders whose pending leads got superseded.
  PERFORM try_promote_lender_to_validated(v_normalized);
  PERFORM try_promote_lender_to_validated(ln)
    FROM (
      SELECT DISTINCT lender_normalized AS ln
        FROM ucc_lender_leads_unverified
       WHERE plant_code = p_plant_code
         AND lender_normalized IS NOT NULL
    ) s
   WHERE ln IS NOT NULL AND ln <> v_normalized;

  RETURN v_link_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_manual_lender_link(text, text, text, text, text) TO authenticated, service_role;

-- 7d. mark_no_lender_identifiable
CREATE OR REPLACE FUNCTION public.mark_no_lender_identifiable(
  p_plant_code text,
  p_note       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_user_email text;
  v_lender     text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

  INSERT INTO ucc_review_actions (plant_code, lender_link_id, action, notes, reviewer_email)
  VALUES (p_plant_code, NULL, 'reject', 'NO_LENDER_IDENTIFIABLE: ' || COALESCE(p_note, ''), v_user_email);

  UPDATE ucc_lender_leads_unverified
     SET lead_status   = 'superseded',
         reviewed_by   = v_user_id,
         reviewed_at   = now(),
         reviewer_note = COALESCE(p_note, 'no lender identifiable'),
         updated_at    = now()
   WHERE plant_code = p_plant_code
     AND lead_status = 'pending';

  INSERT INTO ucc_research_plants (plant_code, lender_resolution)
  VALUES (p_plant_code, 'no_lender_identifiable')
  ON CONFLICT (plant_code) DO UPDATE
    SET lender_resolution = 'no_lender_identifiable', updated_at = now();

  -- Promote any lenders affected by this plant.
  FOR v_lender IN
    SELECT DISTINCT lender_normalized
      FROM ucc_lender_leads_unverified
     WHERE plant_code = p_plant_code AND lender_normalized IS NOT NULL
  LOOP
    PERFORM try_promote_lender_to_validated(v_lender);
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_no_lender_identifiable(text, text) TO authenticated, service_role;

-- 7e. set_lender_pursuit_tier
CREATE OR REPLACE FUNCTION public.set_lender_pursuit_tier(
  p_lender_normalized text,
  p_tier              text,
  p_notes             text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_tier IS NOT NULL AND p_tier NOT IN ('hot','warm','cold') THEN
    RAISE EXCEPTION 'Invalid tier %', p_tier;
  END IF;

  UPDATE ucc_lender_pursuits
     SET tier        = p_tier,
         tier_set_by = v_user_id,
         tier_set_at = now(),
         notes       = COALESCE(p_notes, notes),
         updated_at  = now()
   WHERE lender_normalized = p_lender_normalized;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lender % is not in the validated pursuits list', p_lender_normalized;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_lender_pursuit_tier(text, text, text) TO authenticated, service_role;

-- ── 8. One-shot backfill: plant_lenders -> ucc_lender_leads_unverified ───────
-- Only high/medium confidence rows. Idempotent via legacy_plant_lender_id +
-- the existing UNIQUE (plant_code, lender_entity_id) which won't collide here
-- because lender_entity_id is NULL for legacy rows. Skip rows already mirrored.
INSERT INTO public.ucc_lender_leads_unverified (
  plant_code,
  lender_entity_id,
  lender_name,
  lender_normalized,
  confidence_class,
  evidence_type,
  evidence_summary,
  source_url,
  legacy_plant_lender_id,
  lead_status
)
SELECT
  pl.eia_plant_code,
  NULL,
  pl.lender_name,
  public.normalize_lender_name(pl.lender_name),
  CASE pl.confidence
    WHEN 'high'   THEN 'highly_likely'
    WHEN 'medium' THEN 'possible'
    ELSE 'possible'
  END,
  'edgar_loan',
  'Legacy ' || COALESCE(pl.source, 'lender_extract')
    || ' (' || COALESCE(pl.facility_type, 'unknown') || ')'
    || COALESCE(' — ' || NULLIF(pl.interest_rate_text, ''), '')
    || COALESCE(' — maturity ' || NULLIF(pl.maturity_text, ''), ''),
  pl.source_url,
  pl.id,
  'pending'
FROM public.plant_lenders pl
WHERE pl.confidence IN ('high', 'medium')
  AND public.normalize_lender_name(pl.lender_name) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.ucc_lender_leads_unverified u
     WHERE u.legacy_plant_lender_id = pl.id
  )
  -- Don't duplicate something already present from the UCC pipeline at the
  -- same (plant, lender) coordinates.
  AND NOT EXISTS (
    SELECT 1 FROM public.ucc_lender_leads_unverified u2
     WHERE u2.plant_code        = pl.eia_plant_code
       AND u2.lender_normalized = public.normalize_lender_name(pl.lender_name)
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.ucc_lender_links ll
     WHERE ll.plant_code        = pl.eia_plant_code
       AND ll.lender_normalized = public.normalize_lender_name(pl.lender_name)
  );

-- Ensure every plant referenced in unverified leads has a research_plants row
-- so `lender_resolution` is queryable for the To Validate tab.
INSERT INTO public.ucc_research_plants (plant_code, lender_resolution)
SELECT DISTINCT u.plant_code, 'pending'
  FROM public.ucc_lender_leads_unverified u
 WHERE u.plant_code IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.ucc_research_plants p WHERE p.plant_code = u.plant_code
   );

-- ── 9. AFTER INSERT trigger: continuous mirroring of plant_lenders ───────────
CREATE OR REPLACE FUNCTION public.mirror_plant_lender_to_unverified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm text;
BEGIN
  IF NEW.confidence NOT IN ('high', 'medium') THEN
    RETURN NEW;
  END IF;

  v_norm := normalize_lender_name(NEW.lender_name);
  IF v_norm = '' THEN
    RETURN NEW;
  END IF;

  -- Skip if a UCC link already covers this (plant, lender).
  IF EXISTS (
    SELECT 1 FROM ucc_lender_links
     WHERE plant_code = NEW.eia_plant_code AND lender_normalized = v_norm
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO ucc_lender_leads_unverified (
    plant_code, lender_entity_id, lender_name, lender_normalized,
    confidence_class, evidence_type, evidence_summary, source_url,
    legacy_plant_lender_id, lead_status
  )
  VALUES (
    NEW.eia_plant_code,
    NULL,
    NEW.lender_name,
    v_norm,
    CASE NEW.confidence WHEN 'high' THEN 'highly_likely' ELSE 'possible' END,
    'edgar_loan',
    'Legacy ' || COALESCE(NEW.source, 'lender_extract')
      || ' (' || COALESCE(NEW.facility_type, 'unknown') || ')'
      || COALESCE(' — ' || NULLIF(NEW.interest_rate_text, ''), '')
      || COALESCE(' — maturity ' || NULLIF(NEW.maturity_text, ''), ''),
    NEW.source_url,
    NEW.id,
    'pending'
  )
  ON CONFLICT (plant_code, lender_entity_id) DO NOTHING;

  -- Make sure the plant has a research row.
  INSERT INTO ucc_research_plants (plant_code, lender_resolution)
  VALUES (NEW.eia_plant_code, 'pending')
  ON CONFLICT (plant_code) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_plant_lender_to_unverified ON public.plant_lenders;
CREATE TRIGGER trg_mirror_plant_lender_to_unverified
  AFTER INSERT ON public.plant_lenders
  FOR EACH ROW
  EXECUTE FUNCTION public.mirror_plant_lender_to_unverified();
