-- v5.6: SECURITY DEFINER RPCs for lender validation workflow.
-- Background: plant_lender_links and lenders_canonical have RLS enabled with NO policies,
-- so client-side UPDATE via PostgREST silently affects 0 rows. The Validate / Mark wrong /
-- pursuit-label buttons in the Lender Research dashboard relied on direct UPDATE, which
-- failed silently for both anon and authenticated roles.
--
-- This migration introduces three SECURITY DEFINER RPCs that callers can invoke without
-- needing direct UPDATE rights, matching the existing add_manual_lender_link pattern.

CREATE OR REPLACE FUNCTION public.validate_lender_link(p_link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.plant_lender_links
  SET validated_at = now(),
      rejected_at = NULL,
      rejection_reason = NULL
  WHERE id = p_link_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lender link % not found', p_link_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_lender_link(p_link_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.plant_lender_links
  SET rejected_at = now(),
      validated_at = NULL,
      rejection_reason = NULLIF(trim(coalesce(p_reason, '')), '')
  WHERE id = p_link_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lender link % not found', p_link_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_lender_pursuit(p_lender_id uuid, p_label text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_label IS NOT NULL AND p_label NOT IN ('hot','warm','cold') THEN
    RAISE EXCEPTION 'invalid pursuit label %, must be hot/warm/cold or null', p_label;
  END IF;

  UPDATE public.lenders_canonical
  SET pursuit_label = p_label,
      pursuit_set_at = CASE WHEN p_label IS NULL THEN NULL ELSE now() END
  WHERE id = p_lender_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lender % not found', p_lender_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_lender_link(uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.reject_lender_link(uuid, text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.set_lender_pursuit(uuid, text) TO authenticated, anon;
