/**
 * GenTrack — lender-reviewer (v4) Edge Function (Deno)
 *
 * Citation QA gate. Runs after synthesis. For each surviving claim:
 *   1. Requires a non-empty source_url that starts with http.
 *   2. Requires a non-empty quote (evidence snippet).
 *   3. Calls the lender-resolver to assign a canonical_lender_id.
 *   4. Creates or updates a lender_links row (validation_status='pending').
 *   5. Links the primary claim via lender_link_evidence.
 *
 * Only claims that pass QA become lender_links and appear in the
 * To Validate queue.
 *
 * POST body:
 *   { session_id, plant_id }
 *
 * Response:
 *   { ok, links_created, links_updated, claims_dropped, cost_usd }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalAuth, internalAuthHeaders } from '../_shared/auth.ts';

const TIMEOUT_MS = 15_000;
const RESOLVER_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/lender-resolver`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [REVIEWER:${tag}] ${msg}`);
}

// ── Source-URL relevance check ───────────────────────────────────────────────────
// Catches Gemini hallucinations where a plausible-looking lender claim cites
// a totally unrelated source URL (e.g. Glacier Hills wind → Wisconsin wood
// energy grants page). Authoritative regulatory domains pass automatically;
// other domains must contain at least one significant plant-name token in
// the hostname or path.
const AUTHORITATIVE_DOMAIN = /\b(sec|ferc|doe|energy|eia|whitehouse|state|treasury)\.gov\b/i;
const NAME_STOPWORDS = new Set([
  'wind','solar','farm','park','energy','project','plant','llc','inc','corp',
  'company','center','facility','phase','hybrid','renewable','renewables',
  'power','generation','station','holdings','holding','partners','partnership',
]);

function plantNameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(t => t.length >= 4 && !NAME_STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function urlRelevantToPlant(url: string, tokens: string[]): boolean {
  if (AUTHORITATIVE_DOMAIN.test(url)) return true;
  if (tokens.length === 0) return true;  // can't gate without tokens
  const haystack = url.toLowerCase();
  return tokens.some(t => haystack.includes(t));
}

interface Claim {
  id:                  number;
  raw_lender_name:     string;
  canonical_lender_id: string | null;
  quote:               string | null;
  source_url:          string | null;
  source_type:         string;
  evidence_date:       string | null;
  loan_status:         string;
  role_tag:            string;
  confidence:          number;
}

async function resolveLender(
  rawName:  string,
  authHdrs: Record<string, string>,
): Promise<{ canonical_id: string | null; canonical_name: string | null; confidence: number }> {
  try {
    const resp = await fetch(RESOLVER_URL, {
      method:  'POST',
      headers: { ...authHdrs, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ raw_name: rawName, persist_alias: true }),
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return { canonical_id: null, canonical_name: null, confidence: 0 };
    const data = await resp.json();
    return {
      canonical_id:   data.canonical_id   ?? null,
      canonical_name: data.canonical_name ?? null,
      confidence:     data.confidence     ?? 0,
    };
  } catch {
    return { canonical_id: null, canonical_name: null, confidence: 0 };
  }
}

Deno.serve(async (req: Request) => {
  const denied = checkInternalAuth(req);
  if (denied) return denied;

  let body: { session_id: string; plant_id: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: CORS });
  }

  const { session_id, plant_id } = body;
  if (!session_id || !plant_id) {
    return new Response(JSON.stringify({ error: 'session_id and plant_id required' }), { status: 400, headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const authHdrs = internalAuthHeaders();

  // Fetch plant name once for the URL-relevance check.
  const { data: plantRow } = await supabase
    .from('plants')
    .select('name')
    .eq('id', plant_id)
    .single();
  const plantName = (plantRow as { name?: string } | null)?.name ?? '';
  const nameTokens = plantNameTokens(plantName);
  log('INFO', `plant="${plantName}" tokens=[${nameTokens.join(',')}]`);

  // Fetch surviving claims (not dropped, valid role_tag).
  // 'unknown' is included so claims that synthesis left unclassified (but did
  // not drop) are still evaluated — low-confidence unknowns are dropped below
  // with an explicit dropped_reason rather than silently discarded.
  const { data: claims, error: fetchErr } = await supabase
    .from('lender_research_claims')
    .select('id, raw_lender_name, canonical_lender_id, quote, source_url, source_type, evidence_date, loan_status, role_tag, confidence')
    .eq('session_id', session_id)
    .is('dropped_reason', null)
    .in('role_tag', ['debt_lender', 'admin_agent', 'collateral_agent', 'syndicate_member', 'unknown'])
    .order('confidence', { ascending: false });

  if (fetchErr) {
    return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500, headers: CORS });
  }

  if (!claims || claims.length === 0) {
    log('INFO', `No surviving claims for session ${session_id}`);
    return new Response(
      JSON.stringify({ ok: true, links_created: 0, links_updated: 0, claims_dropped: 0, cost_usd: 0 }),
      { status: 200, headers: CORS },
    );
  }

  log('INFO', `Reviewing ${claims.length} surviving claims`);

  let linksCreated = 0;
  let linksUpdated = 0;
  let droppedCount = 0;

  for (const claim of claims as Claim[]) {
    // ── Universal confidence gate ──────────────────────────────────────────
    // All claims regardless of role must meet a minimum confidence threshold.
    // 0.70 is the validated cut-off from the cohort audit: below this, quotes
    // are overwhelmingly SEC table-of-contents fragments, not real evidence.
    const MIN_CONFIDENCE = 0.70;
    if ((claim.confidence ?? 0) < MIN_CONFIDENCE) {
      await supabase
        .from('lender_research_claims')
        .update({ dropped_reason: 'low_confidence' })
        .eq('id', claim.id);
      droppedCount++;
      continue;
    }

    // ── Citation QA ────────────────────────────────────────────────────────
    if (!claim.source_url || !claim.source_url.startsWith('http')) {
      await supabase
        .from('lender_research_claims')
        .update({ dropped_reason: 'no_source_url' })
        .eq('id', claim.id);
      droppedCount++;
      continue;
    }

    // ── Source-URL relevance gate ──────────────────────────────────────────
    // Reject claims whose source URL has no token overlap with the plant name
    // (and isn't an authoritative regulatory domain). Catches LLM-fabricated
    // citations against unrelated pages.
    if (!urlRelevantToPlant(claim.source_url, nameTokens)) {
      await supabase
        .from('lender_research_claims')
        .update({ dropped_reason: 'irrelevant_source_url' })
        .eq('id', claim.id);
      droppedCount++;
      continue;
    }

    if (!claim.quote || claim.quote.trim().length < 10) {
      await supabase
        .from('lender_research_claims')
        .update({ dropped_reason: 'no_quote' })
        .eq('id', claim.id);
      droppedCount++;
      continue;
    }

    // ── Quote-quality heuristic ────────────────────────────────────────────
    // Reject quotes that are clearly SEC table-of-contents fragments or HTML
    // entity soup — they contain no actual lender-evidence language.
    // A real lender quote must contain at least one financing keyword.
    const LENDER_KEYWORDS = /\b(agent|arranger|lender|loan|facility|underwriter|financing|financed|credit|debt|equity|tranche|revolver|commitment|borrower|collateral|guaranty)\b/i;
    const HTML_JUNK       = /&#\d+;/;  // e.g. &#160; non-breaking spaces
    const quote = claim.quote.trim();
    if (!LENDER_KEYWORDS.test(quote) || HTML_JUNK.test(quote)) {
      await supabase
        .from('lender_research_claims')
        .update({ dropped_reason: 'junk_quote' })
        .eq('id', claim.id);
      droppedCount++;
      continue;
    }

    // ── Entity resolution ──────────────────────────────────────────────────
    let canonicalId = claim.canonical_lender_id;

    if (!canonicalId) {
      const resolved = await resolveLender(claim.raw_lender_name, authHdrs);
      canonicalId = resolved.canonical_id;

      if (canonicalId) {
        // Persist resolved canonical_id on the claim
        await supabase
          .from('lender_research_claims')
          .update({ canonical_lender_id: canonicalId })
          .eq('id', claim.id);
      } else {
        // No canonical match — create a new lender entry for human review
        const { data: newLender } = await supabase
          .from('lenders_canonical')
          .insert({ name: claim.raw_lender_name })
          .select('id')
          .single();

        if (newLender?.id) {
          canonicalId = newLender.id;

          // Seed an alias
          const { data: normalized } = await supabase.rpc('normalize_lender_name', { p_name: claim.raw_lender_name });
          if (normalized) {
            await supabase.from('lender_aliases').upsert({
              lender_id:  canonicalId,
              alias:      normalized,
              alias_raw:  claim.raw_lender_name,
              source:     'resolver',
              confidence: 0.5,
            }, { onConflict: 'alias', ignoreDuplicates: true });
          }

          await supabase
            .from('lender_research_claims')
            .update({ canonical_lender_id: canonicalId })
            .eq('id', claim.id);
        }
      }
    }

    if (!canonicalId) {
      await supabase
        .from('lender_research_claims')
        .update({ dropped_reason: 'canonical_resolution_failed' })
        .eq('id', claim.id);
      droppedCount++;
      continue;
    }

    // ── Upsert lender_links ───────────────────────────────────────────────
    const { data: existing } = await supabase
      .from('lender_links')
      .select('id, primary_claim_id, confidence')
      .eq('plant_id', plant_id)
      .eq('canonical_lender_id', canonicalId)
      .single();

    if (existing) {
      // Update primary_claim_id only if this claim has higher confidence
      if (!existing.primary_claim_id || (claim.confidence > ((existing as Record<string, number>).confidence ?? 0))) {
        await supabase
          .from('lender_links')
          .update({ primary_claim_id: claim.id })
          .eq('id', existing.id);
      }
      // Attach this claim as supporting evidence
      await supabase.from('lender_link_evidence').upsert({
        link_id:  existing.id,
        claim_id: claim.id,
      }, { onConflict: 'link_id,claim_id', ignoreDuplicates: true });
      linksUpdated++;
    } else {
      const { data: newLink, error: insertErr } = await supabase
        .from('lender_links')
        .insert({
          plant_id:            plant_id,
          canonical_lender_id: canonicalId,
          validation_status:   'pending',
          primary_claim_id:    claim.id,
        })
        .select('id')
        .single();

      if (!insertErr && newLink) {
        await supabase.from('lender_link_evidence').upsert({
          link_id:  newLink.id,
          claim_id: claim.id,
        }, { onConflict: 'link_id,claim_id', ignoreDuplicates: true });
        linksCreated++;
      } else if (insertErr) {
        log('LINK_ERR', insertErr.message);
      }
    }
  }

  log('DONE', `links_created=${linksCreated} links_updated=${linksUpdated} dropped=${droppedCount}`);

  return new Response(
    JSON.stringify({
      ok:           true,
      links_created: linksCreated,
      links_updated: linksUpdated,
      claims_dropped: droppedCount,
      cost_usd:     0,
    }),
    { status: 200, headers: CORS },
  );
});
