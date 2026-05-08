-- Patch for auto_queue_lender_claims:
-- PostgreSQL has no max(uuid). Replace MAX(agent_run_id) with array_agg ordered.
-- Apply via Supabase SQL Editor.

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
BEGIN
  FOR r IN
    SELECT
      c.lender_normalized,
      MAX(c.lender_name)                                          AS lender_name,
      MAX(c.confidence_score)                                     AS max_conf,
      MAX(c.evidence_snippet)                                     AS snippet,
      MAX(c.source_url)                                           AS url,
      (ARRAY_AGG(c.agent_run_id ORDER BY c.created_at DESC))[1]   AS run_id,
      ARRAY_AGG(DISTINCT chunk_id)                                AS all_chunks
    FROM public.lender_evidence_claims c
    CROSS JOIN LATERAL UNNEST(c.evidence_chunk_ids) AS chunk_id
    WHERE c.plant_code = p_plant_code
      AND c.status = 'extracted'
      AND c.role_tag IN ('debt_lender','collateral_agent','administrative_agent')
    GROUP BY c.lender_normalized
  LOOP
    SELECT COUNT(DISTINCT d.id)
      INTO v_doc_count
      FROM public.lender_evidence_chunks ch
      JOIN public.lender_evidence_documents d ON d.id = ch.document_id
     WHERE ch.id = ANY(r.all_chunks);

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
