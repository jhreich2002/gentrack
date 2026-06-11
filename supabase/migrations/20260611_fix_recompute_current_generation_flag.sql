-- Fix recompute_current_generation_flag: Supabase platform blocks UPDATE
-- without a WHERE clause for safety. Add a trivially-true predicate so the
-- statement is accepted while still updating every row.

CREATE OR REPLACE FUNCTION public.recompute_current_generation_flag()
RETURNS void LANGUAGE sql AS $$
  UPDATE public.plants p
  SET has_current_generation_data = COALESCE(
    (
      SELECT MAX(g.month) >= (SELECT MAX(month) FROM monthly_generation)
      FROM monthly_generation g
      WHERE g.plant_id = p.id
        AND g.mwh IS NOT NULL
    ),
    false
  )
  WHERE p.id IS NOT NULL
$$;

GRANT EXECUTE ON FUNCTION public.recompute_current_generation_flag()
  TO anon, authenticated, service_role;