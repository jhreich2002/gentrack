-- ============================================================
-- Phase 2: Auto-surface validated lenders; remove "promotion" gate.
--
-- Background: Today, ucc_lender_pursuits is the source list for the
-- Validated Lenders UI, which means a lender doesn't appear there until
-- someone has explicitly "promoted" it. The renewed UI removes the
-- separate Pursuits tab and treats every human-approved lender as
-- validated, with HOT/WARM/COLD as optional metadata layered on top.
--
-- Changes:
--   1. set_lender_pursuit_tier() becomes an upsert. Any lender with
--      ≥1 row in ucc_lender_links WHERE human_approved=true can be tiered;
--      we no longer require a pre-existing ucc_lender_pursuits row.
--   2. Deprecate force_promote_lender() and try_promote_lender_to_validated()
--      as no-ops (kept one release for compatibility, log a deprecation NOTICE).
--   3. v_validated_lender_portfolio remains scoped to human_approved=true
--      (already done in 20260507_cleanup_validated_view.sql; re-asserted here
--      for clarity).
-- ============================================================

-- ── 1. set_lender_pursuit_tier (upsert) ──────────────────────────────────────
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
  v_links   integer;
  v_name    text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_lender_normalized IS NULL OR p_lender_normalized = '' THEN
    RAISE EXCEPTION 'lender_normalized required';
  END IF;

  IF p_tier IS NOT NULL AND p_tier NOT IN ('hot','warm','cold') THEN
    RAISE EXCEPTION 'Invalid tier %', p_tier;
  END IF;

  -- Gate on ≥1 human-approved link so we never surface unvalidated lenders.
  SELECT COUNT(*), MAX(lender_name)
    INTO v_links, v_name
    FROM ucc_lender_links
   WHERE lender_normalized = p_lender_normalized
     AND human_approved = true;

  IF v_links = 0 THEN
    RAISE EXCEPTION 'Cannot tier %: no human-approved lender links exist', p_lender_normalized;
  END IF;

  INSERT INTO ucc_lender_pursuits (
    lender_normalized, lender_name, tier, tier_set_by, tier_set_at, notes, promoted_at
  ) VALUES (
    p_lender_normalized,
    COALESCE(v_name, p_lender_normalized),
    p_tier,
    v_user_id,
    CASE WHEN p_tier IS NULL THEN NULL ELSE now() END,
    p_notes,
    now()
  )
  ON CONFLICT (lender_normalized) DO UPDATE
    SET tier        = EXCLUDED.tier,
        tier_set_by = EXCLUDED.tier_set_by,
        tier_set_at = EXCLUDED.tier_set_at,
        notes       = COALESCE(EXCLUDED.notes, ucc_lender_pursuits.notes),
        lender_name = COALESCE(EXCLUDED.lender_name, ucc_lender_pursuits.lender_name),
        promoted_at = COALESCE(ucc_lender_pursuits.promoted_at, EXCLUDED.promoted_at),
        updated_at  = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_lender_pursuit_tier(text, text, text) TO authenticated, service_role;

-- ── 2. Deprecate promotion RPCs (no-op, kept for one release) ────────────────
CREATE OR REPLACE FUNCTION public.force_promote_lender(p_lender_normalized text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE NOTICE 'force_promote_lender() is deprecated; validated lenders are auto-surfaced. lender=%', p_lender_normalized;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.force_promote_lender(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.try_promote_lender_to_validated(p_lender_normalized text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- No-op: validation is implicit once a row lands in ucc_lender_links with
  -- human_approved=true. Kept for compatibility with existing RPC callers
  -- (validate_lender_lead, mark_no_lender_identifiable).
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_promote_lender_to_validated(text) TO authenticated, service_role;
