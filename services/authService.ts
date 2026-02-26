import { createClient } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';

// -------------------------------------------------------
// Types
// -------------------------------------------------------
export type UserRole = 'user' | 'admin' | 'blocked';

export interface UserProfile {
  id: string;
  email: string;
  role: UserRole;
  created_at: string;
}

export interface AdminUserRow {
  id: string;
  email: string;
  role: UserRole;
  created_at: string;
  last_sign_in_at: string | null;
}

// -------------------------------------------------------
// Regular auth operations (anon key)
// -------------------------------------------------------

export async function signUp(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthStateChange(callback: (session: any) => void) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return subscription;
}

export async function getProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, role, created_at')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data as UserProfile;
}

// -------------------------------------------------------
// Watchlist operations (anon key, RLS-protected)
// -------------------------------------------------------

export async function fetchWatchlist(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('watchlist')
    .select('plant_id')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []).map((r: any) => r.plant_id as string);
}

export async function addToWatchlist(userId: string, plantId: string): Promise<void> {
  const { error } = await supabase
    .from('watchlist')
    .upsert({ user_id: userId, plant_id: plantId }, { onConflict: 'user_id,plant_id' });
  if (error) throw error;
}

export async function removeFromWatchlist(userId: string, plantId: string): Promise<void> {
  const { error } = await supabase
    .from('watchlist')
    .delete()
    .eq('user_id', userId)
    .eq('plant_id', plantId);
  if (error) throw error;
}

// -------------------------------------------------------
// Admin operations (service role key — admin only)
// -------------------------------------------------------

function getAdminClient() {
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  const serviceKey = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY as string;
  if (!url || !serviceKey) throw new Error('Admin credentials not available');
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

export async function fetchAllUsers(): Promise<AdminUserRow[]> {
  const admin = getAdminClient();
  const { data, error } = await admin.from('admin_user_list').select('*');
  if (error) throw error;
  return (data ?? []) as AdminUserRow[];
}

export async function setUserRole(userId: string, role: UserRole): Promise<void> {
  const admin = getAdminClient();
  const { error } = await admin
    .from('profiles')
    .update({ role })
    .eq('id', userId);
  if (error) throw error;
}

// -------------------------------------------------------
// Data health (admin)
// -------------------------------------------------------

export async function fetchDataHealth() {
  const admin = getAdminClient();
  const [plantRes, genRes] = await Promise.allSettled([
    admin.from('plants').select('fuel_source, last_updated', { count: 'exact', head: false }),
    admin.from('monthly_generation').select('id', { count: 'exact', head: true }),
  ]);

  const plants = plantRes.status === 'fulfilled' ? (plantRes.value.data ?? []) : [];
  const genCount = genRes.status === 'fulfilled' ? (genRes.value.count ?? 0) : 0;
  const lastUpdated = plants.length > 0
    ? (plants as any[]).reduce((a: string, b: any) => b.last_updated > a ? b.last_updated : a, '')
    : null;

  const fuelBreakdown = (plants as any[]).reduce((acc: Record<string, number>, p: any) => {
    acc[p.fuel_source] = (acc[p.fuel_source] ?? 0) + 1;
    return acc;
  }, {});

  return {
    plantCount: plants.length,
    genRowCount: genCount,
    lastUpdated,
    fuelBreakdown,
  };
}
