/**
 * GenTrack — lender-resolver Edge Function (Deno)
 *
 * Deterministic entity resolution: maps a raw lender name string to a
 * canonical lender id. No LLM — uses the normalize_lender_name() SQL
 * function plus pg_trgm fuzzy matching via the resolve_lender_name() RPC.
 *
 * When a high-confidence fuzzy match is found, the resolver optionally
 * persists the new alias so future calls are exact-hit.
 *
 * POST body:
 *   { raw_name: string, persist_alias?: boolean }
 *
 * Response:
 *   { canonical_id: string|null, canonical_name: string|null,
 *     confidence: number, match_type: 'alias'|'fuzzy'|'none' }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// Minimum trigram similarity score to auto-persist a new alias
const PERSIST_ALIAS_THRESHOLD = 0.65;

Deno.serve(async (req: Request) => {
  const denied = checkInternalAuth(req);
  if (denied) return denied;

  let body: { raw_name: string; persist_alias?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: CORS });
  }

  const { raw_name, persist_alias = true } = body;
  if (!raw_name || typeof raw_name !== 'string') {
    return new Response(JSON.stringify({ error: 'raw_name required' }), { status: 400, headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Call the SQL resolver function
  const { data, error } = await supabase.rpc('resolve_lender_name', { p_raw_name: raw_name });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS });
  }

  const result = Array.isArray(data) ? data[0] : data;
  const canonical_id: string | null  = result?.out_canonical_id ?? null;
  const confidence: number           = result?.out_confidence   ?? 0;
  const match_type: string           = result?.out_match_type   ?? 'none';

  let canonical_name: string | null = null;

  if (canonical_id) {
    // Fetch the canonical name for the response
    const { data: lc } = await supabase
      .from('lenders_canonical')
      .select('name')
      .eq('id', canonical_id)
      .single();
    canonical_name = lc?.name ?? null;

    // Persist a new alias when this was a fuzzy match with enough confidence
    if (
      persist_alias &&
      match_type === 'fuzzy' &&
      confidence >= PERSIST_ALIAS_THRESHOLD
    ) {
      const { data: normalized } = await supabase.rpc('normalize_lender_name', { p_name: raw_name });
      if (normalized) {
        await supabase.from('lender_aliases').insert({
          lender_id:  canonical_id,
          alias:      normalized,
          alias_raw:  raw_name,
          source:     'resolver',
          confidence,
        }).on('conflict', 'alias', 'do nothing' as never);
      }
    }
  }

  return new Response(
    JSON.stringify({ canonical_id, canonical_name, confidence, match_type }),
    { status: 200, headers: CORS },
  );
});
