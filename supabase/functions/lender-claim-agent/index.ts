/**
 * GenTrack — lender-claim-agent (Phase 5, v2 pipeline)
 *
 * Per-plant agent that:
 *   1. Builds a query string from the plant's name + financing keywords.
 *   2. Embeds it via Gemini gemini-embedding-001 (768d, matches corpus).
 *   3. Hybrid-retrieves evidence chunks via search_lender_evidence
 *      (vector cosine, filtered to that plant_code).
 *   4. Sends the chunks + plant context to Gemini 2.5 Flash with a strict
 *      JSON response schema asking for (lender_name, role_tag, facility_type,
 *      confidence, evidence_chunk_ids[], snippet).
 *   5. Normalizes lender names via the SQL normalize_lender_name() helper.
 *   6. Inserts rows into lender_evidence_claims with pipeline_version='v2'.
 *   7. Calls auto_queue_lender_claims(plant_code) to promote claims that
 *      meet the corroboration threshold to ucc_lender_leads_unverified.
 *
 * Caller contract:
 *   POST { plant_code: string, run_id?: string }
 *   → { ok, plant_code, claims_extracted, promoted: [...] }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const GEMINI_EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const GEMINI_FLASH_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_MODEL = 'gemini-2.5-flash';

const RETRIEVAL_K = 12;        // chunks per plant query
const MIN_CHUNKS  = 2;          // skip plants with too little evidence

const ROLE_TAGS = [
  'debt_lender','collateral_agent','administrative_agent','trustee',
  'tax_equity_investor','sponsor','advisor','underwriter','unknown',
];
const FACILITY_TYPES = [
  'construction_loan','term_loan','revolver','tax_equity',
  'back_leverage','letter_of_credit','bond','other',
];

interface ChunkHit {
  chunk_id:    number;
  document_id: number;
  source_type: string;
  title:       string | null;
  url:         string | null;
  content:     string;
  similarity:  number;
}

interface ExtractedClaim {
  lender_name:        string;
  role_tag:           string;
  facility_type:      string | null;
  confidence:         number;
  evidence_chunk_ids: number[];
  snippet:            string;
}

async function embedQuery(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch(`${GEMINI_EMBED_URL}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
      outputDimensionality: 768,
    }),
  });
  if (!res.ok) throw new Error(`embed query: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.embedding.values;
}

async function extractClaims(
  plantName: string,
  chunks:    ChunkHit[],
  apiKey:    string,
): Promise<ExtractedClaim[]> {
  const evidenceBlock = chunks.map((c, i) =>
    `[chunk_id=${c.chunk_id}] (${c.source_type}) ${c.title ?? ''}\n${c.content}`
  ).join('\n---\n');

  const prompt = `You extract structured lender claims for a U.S. power plant.

Plant: ${plantName}

Below are evidence chunks retrieved by similarity. Extract every claim that
names a financial counterparty for THIS plant. For each claim, return:

  - lender_name: the institution as written
  - role_tag: one of ${ROLE_TAGS.join(', ')}
  - facility_type: one of ${FACILITY_TYPES.join(', ')} or null
  - confidence: 0.0–1.0 (be conservative; <0.6 if implicit)
  - evidence_chunk_ids: integer array of chunk_ids supporting THIS claim
  - snippet: ≤200 chars verbatim from the chunks

RULES:
- Only include counterparties EXPLICITLY tied to this plant or its sponsor
  in a project-finance context.
- Do NOT invent lenders. If unsure, omit.
- Do NOT include sponsors as lenders unless explicitly stated.
- Use role_tag='unknown' only if the role is named but not clarified.

EVIDENCE:
${evidenceBlock}

Return JSON: { "claims": [...] }`;

  const res = await fetch(`${GEMINI_FLASH_URL}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            claims: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                required: ['lender_name','role_tag','confidence','evidence_chunk_ids','snippet'],
                properties: {
                  lender_name:        { type: 'STRING' },
                  role_tag:           { type: 'STRING', enum: ROLE_TAGS },
                  facility_type:      { type: 'STRING', nullable: true, enum: FACILITY_TYPES },
                  confidence:         { type: 'NUMBER' },
                  evidence_chunk_ids: { type: 'ARRAY', items: { type: 'INTEGER' } },
                  snippet:            { type: 'STRING' },
                },
              },
            },
          },
          required: ['claims'],
        },
      },
    }),
  });

  if (!res.ok) throw new Error(`gemini extract: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"claims":[]}';
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.claims) ? parsed.claims : [];
  } catch (e) {
    console.error('claim parse failed:', e, text.slice(0, 200));
    return [];
  }
}

Deno.serve(async (req: Request) => {
  const denied = checkInternalAuth(req);
  if (denied) return denied;

  try {
    const { plant_code, run_id } = await req.json();
    if (!plant_code) {
      return new Response(JSON.stringify({ error: 'plant_code required' }), { status: 400 });
    }

    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const geminiApiKey   = Deno.env.get('GEMINI_API_KEY');
    if (!geminiApiKey) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not set' }), { status: 500 });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const agentRunId = run_id ?? crypto.randomUUID();

    // ── Plant context ─────────────────────────────────────────────────────
    const { data: plant, error: pErr } = await supabase
      .from('plants')
      .select('eia_plant_code, name, state')
      .eq('eia_plant_code', plant_code)
      .maybeSingle();
    if (pErr) throw new Error(`plant lookup: ${pErr.message}`);
    if (!plant) {
      return new Response(JSON.stringify({ error: 'plant not found' }), { status: 404 });
    }
    const plantName = `${(plant as any).name} (EIA ${plant_code}, ${(plant as any).state})`;

    // ── Embed query ───────────────────────────────────────────────────────
    const query = `${(plant as any).name} project finance lender debt construction loan tax equity`;
    const qVec  = await embedQuery(query, geminiApiKey);

    // ── Retrieve chunks ───────────────────────────────────────────────────
    const { data: hits, error: rErr } = await supabase.rpc('search_lender_evidence', {
      p_query_embedding:   `[${qVec.join(',')}]`,
      p_plant_code:        plant_code,
      p_lender_normalized: null,
      p_max_results:       RETRIEVAL_K,
    });
    if (rErr) throw new Error(`search_lender_evidence: ${rErr.message}`);

    const chunks = (hits ?? []) as ChunkHit[];
    if (chunks.length < MIN_CHUNKS) {
      return new Response(JSON.stringify({
        ok: true, plant_code, claims_extracted: 0, promoted: [],
        note: `only ${chunks.length} chunks retrieved (min ${MIN_CHUNKS})`,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ── Extract claims ────────────────────────────────────────────────────
    const claims = await extractClaims(plantName, chunks, geminiApiKey);
    console.log(`plant ${plant_code}: ${claims.length} claim(s) extracted`);

    // ── Insert with normalization ─────────────────────────────────────────
    let inserted = 0;
    for (const c of claims) {
      if (!c.lender_name || !ROLE_TAGS.includes(c.role_tag)) continue;

      const { data: normRows, error: nErr } = await supabase.rpc('normalize_lender_name', {
        p_name: c.lender_name,
      });
      if (nErr) { console.error('normalize:', nErr.message); continue; }
      const normalized = (normRows as unknown as string) ?? c.lender_name.toLowerCase();

      const validChunkIds = c.evidence_chunk_ids.filter(id =>
        chunks.some(ch => ch.chunk_id === id)
      );
      if (validChunkIds.length === 0) continue;

      const sourceUrl = chunks.find(ch => ch.chunk_id === validChunkIds[0])?.url ?? null;

      const { error: iErr } = await supabase.from('lender_evidence_claims').insert({
        plant_code,
        lender_name:        c.lender_name,
        lender_normalized:  normalized,
        role_tag:           c.role_tag,
        facility_type:      c.facility_type ?? null,
        confidence_score:   Math.max(0, Math.min(1, c.confidence)),
        evidence_chunk_ids: validChunkIds,
        evidence_snippet:   c.snippet?.slice(0, 500) ?? null,
        source_url:         sourceUrl,
        agent_model:        GEMINI_MODEL,
        agent_run_id:       agentRunId,
        pipeline_version:   'v2',
      });
      if (iErr) { console.error('claim insert:', iErr.message); continue; }
      inserted++;
    }

    // ── Auto-queue qualifying claims ──────────────────────────────────────
    const { data: queueRows, error: qErr } = await supabase.rpc('auto_queue_lender_claims', {
      p_plant_code: plant_code,
    });
    if (qErr) console.error('auto_queue:', qErr.message);

    return new Response(JSON.stringify({
      ok: true,
      plant_code,
      run_id: agentRunId,
      chunks_retrieved: chunks.length,
      claims_extracted: inserted,
      promoted: queueRows ?? [],
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('lender-claim-agent fatal:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
