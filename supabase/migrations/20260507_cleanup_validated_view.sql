-- ============================================================
-- Cleanup: scope v_validated_lender_portfolio to human-approved links
-- and add force_promote_lender() for the "Promote Now" button.
--
-- Background: ucc_lender_links was used as the staging table for the
-- pre-validation pipeline and contains 600+ auto-generated rows with
-- human_approved=false (sentence fragments, parties, sponsors, etc.).
-- The new workflow only treats human_approved=true rows as validated.
-- ============================================================

-- ── 1. Validated portfolio view: human-approved only ─────────────────────────
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
  AND ll.human_approved = true
GROUP BY ll.lender_normalized;

GRANT SELECT ON public.v_validated_lender_portfolio TO authenticated, anon;

-- ── 2. force_promote_lender() ────────────────────────────────────────────────
-- Variant of try_promote_lender_to_validated that bypasses the "0 pending
-- leads" gate. Used by the Promote Now operator action when a lender has
-- enough validated links to take to market even though some plants are still
-- unresolved. Still requires ≥1 human-approved link in ucc_lender_links.
CREATE OR REPLACE FUNCTION public.force_promote_lender(p_lender_normalized text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_links   integer;
  v_name    text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_lender_normalized IS NULL OR p_lender_normalized = '' THEN
    RAISE EXCEPTION 'lender_normalized required';
  END IF;

  SELECT COUNT(*) INTO v_links
    FROM ucc_lender_links
   WHERE lender_normalized = p_lender_normalized
     AND human_approved = true;

  IF v_links = 0 THEN
    RAISE EXCEPTION 'Cannot promote %: no human-approved lender links exist yet', p_lender_normalized;
  END IF;

  SELECT lender_name INTO v_name
    FROM ucc_lender_links
   WHERE lender_normalized = p_lender_normalized
     AND human_approved = true
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

GRANT EXECUTE ON FUNCTION public.force_promote_lender(text) TO authenticated, service_role;
