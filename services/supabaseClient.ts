import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[GenTrack] Supabase env vars not set — will fall back to static data');
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');