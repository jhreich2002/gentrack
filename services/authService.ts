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

export type ActivityEventType = 'app_open' | 'view_change' | 'filter_search' | 'watchlist_toggle';

export interface AdminDailyActivityRow {
  day: string;
  active_users: number;
  action_count: number;
  app_open_count: number;
}

export interface AdminUserDailyActivityRow {
  day: string;
  user_id: string;
  email: string;
  action_count: number;
  app_open_count: number;
  last_seen_at: string;
}

export interface AdminMonthlyCostLine {
  month_start: string;
  service_name: string;
  cost_type: 'variable' | 'fixed';
  amount_usd: number;
}

export interface AdminMonthlyCostTotal {
  month_start: string;
  total_usd: number;
}

export interface AdminCostForecastPoint {
  month_start: string;
  projected_total_usd: number;
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

export function onAuthStateChange(callback: (session: any, event?: string) => void) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    callback(session, event);
  });
  return subscription;
}

export async function trackUserActivityEvent(
  userId: string,
  eventType: ActivityEventType,
  eventName: string,
  eventMetadata?: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from('user_activity_events')
    .insert({
      user_id: userId,
      event_type: eventType,
      event_name: eventName,
      event_metadata: eventMetadata ?? {},
    });
  if (error) throw error;
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
// Admin operations (authenticated admin user + RLS)
// -------------------------------------------------------

export async function fetchAllUsers(): Promise<AdminUserRow[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, role, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    created_at: row.created_at,
    last_sign_in_at: null,
  })) as AdminUserRow[];
}

export async function setUserRole(userId: string, role: UserRole): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', userId);
  if (error) throw error;
}

// -------------------------------------------------------
// Data health (admin)
// -------------------------------------------------------

export async function fetchDataHealth() {
  const [plantRes, genRes] = await Promise.allSettled([
    supabase.from('plants').select('fuel_source, last_updated', { count: 'exact', head: false }),
    supabase.from('monthly_generation').select('id', { count: 'exact', head: true }),
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

export async function fetchAdminUserActivity(monthStart: string): Promise<{
  daily: AdminDailyActivityRow[];
  users: AdminUserDailyActivityRow[];
}> {
  const start = new Date(`${monthStart}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const endIso = end.toISOString().slice(0, 10);

  const [{ data: dailyData, error: dailyError }, { data: userData, error: userError }] = await Promise.all([
    supabase
      .from('admin_user_activity_daily')
      .select('*')
      .gte('day', monthStart)
      .lt('day', endIso)
      .order('day', { ascending: true }),
    supabase
      .from('admin_user_activity_user_daily')
      .select('*')
      .gte('day', monthStart)
      .lt('day', endIso)
      .order('day', { ascending: false })
      .order('action_count', { ascending: false }),
  ]);

  if (dailyError) throw dailyError;
  if (userError) throw userError;

  return {
    daily: (dailyData ?? []) as AdminDailyActivityRow[],
    users: (userData ?? []) as AdminUserDailyActivityRow[],
  };
}

export async function fetchAdminMonthlyCosts(): Promise<{
  lines: AdminMonthlyCostLine[];
  totals: AdminMonthlyCostTotal[];
  forecast: AdminCostForecastPoint[];
}> {
  const [{ data: linesData, error: linesError }, { data: totalsData, error: totalsError }] = await Promise.all([
    supabase
      .from('admin_platform_cost_monthly_lines')
      .select('*')
      .order('month_start', { ascending: true })
      .order('amount_usd', { ascending: false }),
    supabase
      .from('admin_platform_cost_monthly_totals')
      .select('*')
      .order('month_start', { ascending: true }),
  ]);

  if (linesError) throw linesError;
  if (totalsError) throw totalsError;

  return {
    lines: (linesData ?? []) as AdminMonthlyCostLine[],
    totals: (totalsData ?? []) as AdminMonthlyCostTotal[],
    forecast: [],
  };
}
