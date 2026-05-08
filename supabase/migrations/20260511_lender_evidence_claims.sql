-- ============================================================
-- Phase 5: Agentic candidate generation — claim staging.
--
-- Background: the v2 claim agent extracts candidate (plant, lender, role,
-- facility_type) tuples from retrieved evidence chunks. Each extraction
-- becomes a row in lender_evidence_claims with citations. A claim is
-- auto-promoted to ucc_lender_leads_unverified (the human queue) ONLY
-- when corroboration thresholds are met — see auto_queue_lender_claims().
--
-- Locked promotion threshold:
--   ≥2 distinct corroborating documents,  OR
--   ≥1 high-quality press release / EDGAR exhibit with role='debt_lender'
--   and confidence_score >= 0.75.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.lender_evidence_claims (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plant_code          text NOT NULL,
  lender_name         text NOT NULL,
  lender_normalized   text NOT NULL,
  role_tag            text NOT NULL
    CHECK (role_tag IN (
      'debt_lender','collateral_agent','administrative_agent','trustee',
      'tax_equity_investor','sponsor','advisor','underwriter','unknown'
    )),
  facility_type       text
    CHECK (facility_type IS NULL OR facility_type IN (
      'construction_loan','term_loan','revolver','tax_equity',
      'back_leverage','letter_of_credit','bond','other'
    )),
  status              text NOT NULL DEFAULT 'extracted'
    CHECK (status IN ('extracted','queued','superseded','duplicate')),
  confidence_score    real NOT NULL DEFAULT 0.0,
  evidence_chunk_ids  bigint[] NOT NULL DEFAULT '{}',
  evidence_snippet    text,
  source_url          text,
  agent_model         text,
  agent_run_id        uuid,
  pipeline_version    text NOT NULL DEFAULT 'v2'
    CHECK (pipeline_version IN ('v1_legacy','v2')),
  promoted_lead_id    bigint REFERENCES public.ucc_lender_leads_unverified(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.lender_evidence_claims ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'lender_evidence_claims' AND policyname = 'lec_claims_public_read'
  ) THEN
    CREATE POLICY "lec_claims_public_read" ON public.lender_evidence_claims FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'lender_evidence_claims' AND policyname = 'lec_claims_service_write'
  ) THEN
    CREATE POLICY "lec_claims_service_write" ON public.lender_evidence_claims FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lec_claims_plant_lender
  ON public.lender_evidence_claims (plant_code, lender_normalized);
CREATE INDEX IF NOT EXISTS idx_lec_claims_status
  ON public.lender_evidence_claims (status);
CREATE INDEX IF NOT EXISTS idx_lec_claims_role_tag
  ON public.lender_evidence_claims (role_tag);
CREATE INDEX IF NOT EXISTS idx_lec_claims_pipeline_version
  ON public.lender_evidence_claims (pipeline_version);

-- ── auto_queue_lender_claims() ───────────────────────────────────────────────
-- Inspects extracted claims for a plant and promotes qualifying ones to
-- ucc_lender_leads_unverified (the human review queue). Idempotent:
-- if a (plant_code, lender_normalized) lead already exists in the queue
-- (regardless of status) we do not duplicate it; we only update the
-- claim row's promoted_lead_id reference.
--
-- Thresholds:
--   - ≥2 distinct documents corroborating the same (plant, lender) pair, OR
--   - ≥1 EDGAR/press_release evidence with role_tag='debt_lender'
--     and confidence_score >= 0.75
CREATE OR REPLACE FUNCTION public.auto_queue_lender_claims(p_plant_code text)
RETURNS TABLE (lender_normalized text, promoted boolean, lead_id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_doc_count    integer;
  v_press_count  integer;
  v_qualifies    boolean;
  v_existing_id  bigint;
  v_new_id       bigint;
  v_lender_name  text;
  v_summary      text;
  v_url          text;
  v_run_id       uuid;
BEGIN
  FOR r IN
    SELECT
      c.lender_normalized,
      MAX(c.lender_name)            AS lender_name,
      MAX(c.confidence_score)       AS max_conf,
      MAX(c.evidence_snippet)       AS snippet,
      MAX(c.source_url)             AS url,
      (ARRAY_AGG(c.agent_run_id ORDER BY c.created_at DESC))[1] AS run_id,
      ARRAY_AGG(DISTINCT chunk_id)  AS all_chunks
    FROM public.lender_evidence_claims c
    CROSS JOIN LATERAL UNNEST(c.evidence_chunk_ids) AS chunk_id
    WHERE c.plant_code = p_plant_code
      AND c.status = 'extracted'
      AND c.role_tag IN ('debt_lender','collateral_agent','administrative_agent')
    GROUP BY c.lender_normalized
  LOOP
    -- Count distinct source documents across all evidence chunks
    SELECT COUNT(DISTINCT d.id)
      INTO v_doc_count
      FROM public.lender_evidence_chunks ch
      JOIN public.lender_evidence_documents d ON d.id = ch.document_id
     WHERE ch.id = ANY(r.all_chunks);

    -- Count high-quality press / edgar with strong claim
    SELECT COUNT(*)
      INTO v_press_count
      FROM public.lender_evidence_claims c
      JOIN LATERAL UNNEST(c.evidence_chunk_ids) AS cid ON true
      JOIN public.lender_evidence_chunks ch ON ch.id = cid
      JOIN public.lender_evidence_documents d ON d.id = ch.document_id
     WHERE c.plant_code = p_plant_code
       AND c.lender_normalized = r.lender_normalized
       AND c.role_tag = 'debt_lender'
       AND c.confidence_score >= 0.75
       AND d.source_type IN ('press_release','edgar_filing','ucc_filing');

    v_qualifies := (v_doc_count >= 2) OR (v_press_count >= 1);

    IF NOT v_qualifies THEN
      lender_normalized := r.lender_normalized;
      promoted          := false;
      lead_id           := NULL;
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Idempotency: if a row already exists for this (plant, lender), reuse it
    SELECT id INTO v_existing_id
      FROM public.ucc_lender_leads_unverified
     WHERE plant_code = p_plant_code
       AND lender_normalized = r.lender_normalized
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      UPDATE public.lender_evidence_claims
         SET status = 'queued', promoted_lead_id = v_existing_id, updated_at = now()
       WHERE plant_code = p_plant_code
         AND lender_normalized = r.lender_normalized
         AND status = 'extracted';
      lender_normalized := r.lender_normalized;
      promoted          := false;
      lead_id           := v_existing_id;
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- Insert new lead
    INSERT INTO public.ucc_lender_leads_unverified (
      plant_code, lender_name, lender_normalized,
      confidence_class, evidence_type, evidence_summary, source_url,
      llm_model, run_id, pipeline_version
    ) VALUES (
      p_plant_code,
      r.lender_name,
      r.lender_normalized,
      CASE WHEN r.max_conf >= 0.85 THEN 'highly_likely' ELSE 'possible' END,
      'llm_inference',
      r.snippet,
      r.url,
      'lender-claim-agent',
      r.run_id,
      'v2'
    )
    RETURNING id INTO v_new_id;

    UPDATE public.lender_evidence_claims
       SET status = 'queued', promoted_lead_id = v_new_id, updated_at = now()
     WHERE plant_code = p_plant_code
       AND lender_normalized = r.lender_normalized
       AND status = 'extracted';

    lender_normalized := r.lender_normalized;
    promoted          := true;
    lead_id           := v_new_id;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_queue_lender_claims(text) TO authenticated, service_role;
