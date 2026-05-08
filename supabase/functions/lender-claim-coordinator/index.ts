/**
 * GenTrack — lender-claim-coordinator (Phase 5)
 *
 * Batch orchestrator that fans out lender-claim-agent calls across a
 * cohort of plants. Designed for cron + ad-hoc invocation.
 *
 * Selection (default): plants that have evidence in lender_evidence_documents
 * but no extracted v2 claim yet. Override by passing { plant_codes: [...] }.
 *
 * Concurrency is intentionally low (Gemini rate limit + Edge Function
 * subrequest budget). Use multiple coordinator runs for large cohorts.
 *
 * Caller contract:
 *   POST {} | { plant_codes?: string[], limit?: number, concurrency?: number }
 *   → { ok, dispatched, results: [...] }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const DEFAULT_LIMIT       = 25;
const DEFAULT_CONCURRENCY = 3;

Deno.serve(async (req: Request) => {
  const denied = checkInternalAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const explicit:    string[] = Array.isArray(body.plant_codes) ? body.plant_codes : [];
    const limit:       number   = Number(body.limit ?? DEFAULT_LIMIT);
    const concurrency: number   = Number(body.concurrency ?? DEFAULT_CONCURRENCY);

    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const internalToken  = Deno.env.get('INTERNAL_AUTH_TOKEN')!;
    const supabase       = createClient(supabaseUrl, serviceRoleKey);

    // ── Build plant cohort ────────────────────────────────────────────────
    let plants: string[] = explicit;
    if (plants.length === 0) {
      // Plants with evidence but no v2 claim yet.
      const { data, error } = await supabase
        .from('lender_evidence_documents')
        .select('plant_code')
        .not('plant_code', 'is', null)
        .limit(1000);
      if (error) throw new Error(`evidence plant scan: ${error.message}`);
      const candidates = Array.from(new Set(((data ?? []) as any[]).map(r => r.plant_code as string)));

      const { data: existing } = await supabase
        .from('lender_evidence_claims')
        .select('plant_code')
        .eq('pipeline_version', 'v2')
        .in('plant_code', candidates);
      const seen = new Set(((existing ?? []) as any[]).map(r => r.plant_code as string));

      plants = candidates.filter(p => !seen.has(p)).slice(0, limit);
    } else {
      plants = plants.slice(0, limit);
    }

    if (plants.length === 0) {
      return new Response(JSON.stringify({ ok: true, dispatched: 0, results: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const runId = crypto.randomUUID();
    console.log(`coordinator: dispatching ${plants.length} plant(s), concurrency=${concurrency}, run=${runId}`);

    const results: any[] = [];
    const queue = [...plants];
    const inFlight: Promise<void>[] = [];

    async function worker() {
      while (queue.length > 0) {
        const code = queue.shift();
        if (!code) return;
        try {
          const r = await fetch(`${supabaseUrl}/functions/v1/lender-claim-agent`, {
            method: 'POST',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${internalToken}`,
            },
            body: JSON.stringify({ plant_code: code, run_id: runId }),
          });
          const j = await r.json().catch(() => ({}));
          results.push({ plant_code: code, status: r.status, ...j });
        } catch (e) {
          results.push({ plant_code: code, error: String(e) });
        }
      }
    }

    for (let i = 0; i < Math.min(concurrency, plants.length); i++) {
      inFlight.push(worker());
    }
    await Promise.all(inFlight);

    return new Response(JSON.stringify({
      ok: true,
      run_id: runId,
      dispatched: plants.length,
      results,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('lender-claim-coordinator fatal:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
