/**
 * GenTrack — admin-trigger-workflow Edge Function (Deno)
 *
 * Server-side proxy for the Admin page's GitHub Actions controls.
 * Holds the GitHub PAT in the GITHUB_ADMIN_PAT platform secret so it
 * never ships to the browser bundle.
 *
 * NOTE: This function does NOT use _shared/auth.ts because callers are
 * end-user browsers, not other edge functions. Instead we verify the
 * caller's Supabase auth JWT and require profile.role = 'admin'.
 *
 * verify_jwt is left at its default (true) for this function — Supabase
 * gateway validates the user's anon JWT (not the leaked legacy service_role
 * one), and we then re-verify and check the admin role here.
 *
 * POST body:
 *   { action: 'trigger', ref?: string }   → POST workflow dispatch
 *   { action: 'status' }                  → GET latest workflow run
 *
 * Required secrets:
 *   GITHUB_ADMIN_PAT          — fine-grained PAT with actions:write on the repo
 *   GITHUB_REPO               — e.g. "jhreich2002/gentrack"
 *   GITHUB_WORKFLOW_FILE      — e.g. "monthly-update.yml"
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected (used to look up caller's role)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type':                 'application/json',
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

async function requireAdmin(req: Request): Promise<{ userId: string } | Response> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json(401, { error: 'missing_auth' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Resolve user from the bearer token (this is the end-user's Supabase auth JWT)
  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData?.user) return json(401, { error: 'invalid_session' });

  // Look up role
  const { data: profile, error: profErr } = await sb
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single();
  if (profErr || !profile) return json(403, { error: 'no_profile' });
  if (profile.role !== 'admin') return json(403, { error: 'not_admin' });

  return { userId: userData.user.id };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return json(405, { error: 'method_not_allowed' });

  const guard = await requireAdmin(req);
  if (guard instanceof Response) return guard;

  let body: { action?: string; ref?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }

  const pat      = Deno.env.get('GITHUB_ADMIN_PAT');
  const repo     = Deno.env.get('GITHUB_REPO')          ?? 'jhreich2002/gentrack';
  const workflow = Deno.env.get('GITHUB_WORKFLOW_FILE') ?? 'monthly-update.yml';
  if (!pat) return json(500, { error: 'pat_not_configured' });

  const ghHeaders = {
    'Authorization': `Bearer ${pat}`,
    'Accept':        'application/vnd.github+json',
    'Content-Type':  'application/json',
    'User-Agent':    'gentrack-admin-proxy',
  };

  if (body.action === 'status') {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1`;
    const r = await fetch(url, { headers: ghHeaders });
    if (!r.ok) return json(r.status, { error: 'github_error', detail: await r.text() });
    const data = await r.json();
    const run  = data.workflow_runs?.[0] ?? null;
    return json(200, { run });
  }

  if (body.action === 'trigger') {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
    const r = await fetch(url, {
      method:  'POST',
      headers: ghHeaders,
      body:    JSON.stringify({ ref: body.ref ?? 'main' }),
    });
    if (!r.ok) return json(r.status, { error: 'github_error', detail: await r.text() });
    return json(202, { ok: true });
  }

  return json(400, { error: 'unknown_action' });
});
