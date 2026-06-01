-- Lender Pipeline v5: remove v4 lender pipeline objects

-- Drop v4 views (safe if missing)
DROP VIEW IF EXISTS public.v_lender_validation_queue CASCADE;
DROP VIEW IF EXISTS public.v_validated_lender_portfolio CASCADE;
DROP VIEW IF EXISTS public.v_plant_research_state CASCADE;
DROP VIEW IF EXISTS public.v_plant_research_status CASCADE;
DROP VIEW IF EXISTS public.v_admin_research_costs CASCADE;
DROP VIEW IF EXISTS public.v_plant_financing CASCADE;

-- Drop v4/legacy RPCs by name regardless of signature drift
DO $$
DECLARE
  fn_name text;
  fn_sig text;
BEGIN
  FOREACH fn_name IN ARRAY ARRAY[
    'validate_lender_lead',
    'reject_lender_lead',
    'add_manual_lender_link',
    'mark_no_lender_identifiable',
    'set_lender_pursuit_tier',
    'validate_lender_link',
    'normalize_lender_name',
    'resolve_lender_name'
  ] LOOP
    FOR fn_sig IN
      SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = fn_name
    LOOP
      EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', fn_sig);
    END LOOP;
  END LOOP;
END $$;

-- Drop v4 tables
DROP TABLE IF EXISTS public.lender_link_evidence CASCADE;
DROP TABLE IF EXISTS public.lender_links CASCADE;
DROP TABLE IF EXISTS public.lender_research_claims CASCADE;
DROP TABLE IF EXISTS public.lender_research_sessions CASCADE;
DROP TABLE IF EXISTS public.lender_pursuits CASCADE;
DROP TABLE IF EXISTS public.plant_research_state CASCADE;
DROP TABLE IF EXISTS public.lender_aliases CASCADE;
DROP TABLE IF EXISTS public.lenders_canonical CASCADE;
