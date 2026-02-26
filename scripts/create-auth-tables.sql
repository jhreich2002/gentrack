-- ============================================================
-- GenTrack — Auth tables, RLS, and trigger
-- Run once in Supabase SQL Editor
-- ============================================================

-- 1. profiles table (one row per user, mirrors auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      text NOT NULL,
  role       text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Users can read/update only their own profile
CREATE POLICY "profiles: own read"   ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles: own update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- 2. watchlist table (plant IDs saved per user)
CREATE TABLE IF NOT EXISTS watchlist (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plant_id   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, plant_id)
);

ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "watchlist: own read"   ON watchlist FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "watchlist: own insert" ON watchlist FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "watchlist: own delete" ON watchlist FOR DELETE USING (auth.uid() = user_id);

-- 3. Admin view over profiles + auth.users (service role only)
CREATE OR REPLACE VIEW admin_user_list AS
  SELECT
    u.id,
    u.email,
    p.role,
    u.created_at,
    u.last_sign_in_at
  FROM auth.users u
  LEFT JOIN profiles p ON p.id = u.id
  ORDER BY u.created_at DESC;

-- 4. Trigger: auto-create a profiles row on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (NEW.id, NEW.email, 'user')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
