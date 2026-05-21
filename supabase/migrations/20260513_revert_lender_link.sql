-- ── revert_lender_link ────────────────────────────────────────────────────────
-- Resets a lender_link back to 'pending' so an analyst can re-evaluate.
-- Mirrors the pattern of validate_lender_link / reject_lender_link.

CREATE OR REPLACE FUNCTION public.revert_lender_link(
  p_link_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.lender_links
  SET    validation_status = 'pending',
         validated_by      = NULL,
         validated_at      = NULL,
         reviewer_note     = NULL
  WHERE  id = p_link_id;

  -- Keep plant_research_state counts in sync
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

GRANT EXECUTE ON FUNCTION public.revert_lender_link(bigint) TO authenticated, service_role;
