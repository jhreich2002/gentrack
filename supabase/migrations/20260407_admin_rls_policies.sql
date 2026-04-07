-- ============================================================
-- Admin-only access policies for admin dashboard data
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin_user() TO authenticated;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles' AND policyname = 'profiles_admin_read_all'
  ) THEN
    CREATE POLICY profiles_admin_read_all
      ON profiles FOR SELECT
      USING (public.is_admin_user());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'profiles' AND policyname = 'profiles_admin_update_all'
  ) THEN
    CREATE POLICY profiles_admin_update_all
      ON profiles FOR UPDATE
      USING (public.is_admin_user())
      WITH CHECK (public.is_admin_user());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_activity_events' AND policyname = 'user_activity_events_admin_read'
  ) THEN
    CREATE POLICY user_activity_events_admin_read
      ON user_activity_events FOR SELECT
      USING (public.is_admin_user());
  END IF;
END $$;