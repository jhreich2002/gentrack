BEGIN;

-- Allow manual claims written by the manual-link RPC.
ALTER TABLE public.lender_research_claims
  DROP CONSTRAINT IF EXISTS lender_research_claims_source_agent_check;

ALTER TABLE public.lender_research_claims
  ADD CONSTRAINT lender_research_claims_source_agent_check
  CHECK (source_agent IN ('edgar', 'records', 'web', 'manual'));

-- Persist manual evidence in the same claim/link model used by validated links.
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
  v_link_id        bigint;
  v_claim_id       bigint;
  v_session_id     uuid;
  v_res            record;
BEGIN
  SELECT * INTO v_res FROM public.resolve_lender_name(p_lender_name);
  v_canonical_id := v_res.out_canonical_id;

  -- If no match, create a new canonical entry.
  IF v_canonical_id IS NULL THEN
    INSERT INTO public.lenders_canonical (name)
    VALUES (p_lender_name)
    ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_canonical_id;

    INSERT INTO public.lender_aliases (lender_id, alias, alias_raw, source)
    VALUES (v_canonical_id, public.normalize_lender_name(p_lender_name), p_lender_name, 'manual')
    ON CONFLICT (alias) DO NOTHING;
  END IF;

  INSERT INTO public.lender_research_sessions (
    plant_id,
    status,
    trigger_type,
    budget_usd,
    cost_usd,
    budget_exceeded,
    started_at,
    completed_at
  )
  VALUES (
    p_plant_id,
    'complete',
    'manual',
    0,
    0,
    false,
    now(),
    now()
  )
  RETURNING id INTO v_session_id;

  INSERT INTO public.lender_research_claims (
    session_id,
    source_agent,
    raw_lender_name,
    canonical_lender_id,
    quote,
    source_url,
    source_type,
    evidence_date,
    loan_status,
    role_tag,
    confidence,
    dropped_reason
  )
  VALUES (
    v_session_id,
    'manual',
    p_lender_name,
    v_canonical_id,
    p_note,
    p_source_url,
    'manual',
    now()::date,
    'active',
    'debt_lender',
    1.0,
    NULL
  )
  RETURNING id INTO v_claim_id;

  INSERT INTO public.lender_links (
    plant_id,
    canonical_lender_id,
    validation_status,
    primary_claim_id,
    legacy_raw_name,
    validated_by,
    validated_at,
    reviewer_note
  )
  VALUES (
    p_plant_id,
    v_canonical_id,
    'manual',
    v_claim_id,
    p_lender_name,
    auth.uid(),
    now(),
    p_note
  )
  ON CONFLICT (plant_id, canonical_lender_id) DO UPDATE
    SET validation_status = 'manual',
        primary_claim_id = EXCLUDED.primary_claim_id,
        legacy_raw_name  = EXCLUDED.legacy_raw_name,
        validated_by     = auth.uid(),
        validated_at     = now(),
        reviewer_note    = EXCLUDED.reviewer_note
  RETURNING id INTO v_link_id;

  INSERT INTO public.lender_link_evidence (link_id, claim_id)
  VALUES (v_link_id, v_claim_id)
  ON CONFLICT (link_id, claim_id) DO NOTHING;

  INSERT INTO public.plant_research_state (
    plant_id,
    last_session_id,
    last_researched_at,
    status,
    validated_count,
    pending_count
  )
  VALUES (
    p_plant_id,
    v_session_id,
    now(),
    'complete',
    (
      SELECT count(*)
      FROM public.lender_links
      WHERE plant_id = p_plant_id
        AND validation_status IN ('validated', 'manual')
    ),
    (
      SELECT count(*)
      FROM public.lender_links
      WHERE plant_id = p_plant_id
        AND validation_status = 'pending'
    )
  )
  ON CONFLICT (plant_id) DO UPDATE
    SET last_session_id    = EXCLUDED.last_session_id,
        last_researched_at = EXCLUDED.last_researched_at,
        status             = EXCLUDED.status,
        validated_count    = EXCLUDED.validated_count,
        pending_count      = EXCLUDED.pending_count;

  RETURN v_link_id;
END;
$$;

COMMIT;
