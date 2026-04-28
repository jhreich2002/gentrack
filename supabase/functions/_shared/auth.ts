/**
 * Shared auth helper for GenTrack edge functions.
 *
 * Replaces Supabase's gateway-level JWT verification with a constant-time
 * compare against INTERNAL_AUTH_TOKEN. Required because the legacy HS256
 * service_role JWT was leaked and Supabase's "disable legacy API keys"
 * toggle does NOT propagate to the Edge Functions gateway. We therefore
 * set verify_jwt=false in config.toml and check the bearer token here.
 *
 * Token rotation: update the INTERNAL_AUTH_TOKEN platform secret via
 *   supabase secrets set INTERNAL_AUTH_TOKEN=<new value> --project-ref <ref>
 * then redeploy. Callers (scripts, pg_cron via Vault, inter-function calls)
 * read the same value.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Returns null if the request is authorized; otherwise returns a 401 Response.
 * Also handles CORS preflight (returns a 204 Response for OPTIONS).
 *
 * Usage at top of every handler:
 *   const denied = checkInternalAuth(req);
 *   if (denied) return denied;
 */
export function checkInternalAuth(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  const expected = Deno.env.get('INTERNAL_AUTH_TOKEN') ?? '';
  if (!expected) {
    return new Response(
      JSON.stringify({ error: 'server_misconfigured', detail: 'INTERNAL_AUTH_TOKEN not set' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
  const header = req.headers.get('Authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !timingSafeEqual(presented, expected)) {
    return new Response(
      JSON.stringify({ error: 'unauthorized' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
  return null;
}

/** Convenience: header object for outbound calls to other GenTrack functions. */
export function internalAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Authorization': `Bearer ${Deno.env.get('INTERNAL_AUTH_TOKEN') ?? ''}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}
