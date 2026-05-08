/**
 * GenTrack — lender-chat (Phase 6)
 *
 * RAG-grounded Q&A over the lender evidence corpus + validated graph.
 *
 * Caller contract:
 *   POST {
 *     scope:              'plant' | 'lender' | 'global',
 *     plant_code?:        string,        // required when scope='plant'
 *     lender_normalized?: string,        // required when scope='lender'
 *     question:           string,
 *   }
 *   → { ok, answer, citations: [{ document_id, source_type, title, url, snippet, similarity }],
 *       structured: { validated: [...], pending: [...] } }
 *
 * Hard rule: refuse to answer if zero retrieved citations. We do not let the
 * model invent lenders.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const GEMINI_EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const GEMINI_FLASH_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const RETRIEVAL_K = 12;
const MAX_QUESTION_LEN = 1000;

interface ChunkHit {
  chunk_id:          number;
  document_id:       number;
  source_type:       string;
  source_id:         string;
  plant_code:        string | null;
  lender_normalized: string | null;
  title:             string | null;
  url:               string | null;
  published_at:      string | null;
  chunk_index:       number;
  content:           string;
  similarity:        number;
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

async function answer(
  question:    string,
  scopeLine:   string,
  hits:        ChunkHit[],
  validated:   any[],
  pending:     any[],
  apiKey:      string,
): Promise<string> {
  const evidenceBlock = hits.map((h, i) =>
    `[${i + 1}] (${h.source_type}, ${h.published_at ?? 'undated'}) ${h.title ?? ''}\n${h.content}`
  ).join('\n---\n');

  const validatedBlock = validated.length === 0 ? '(none)' :
    validated.map(v => `- ${v.lender_name} → plant ${v.plant_code} (validated, ${v.evidence_type})`).join('\n');
  const pendingBlock = pending.length === 0 ? '(none)' :
    pending.map(p => `- ${p.lender_name} → plant ${p.plant_code} (pending review, ${p.confidence_class})`).join('\n');

  const prompt = `You answer questions about U.S. power plant project finance using ONLY the
evidence and structured data provided. ${scopeLine}

USER QUESTION:
${question}

VALIDATED LENDER LINKS (human-approved):
${validatedBlock}

PENDING LENDER LEADS (not yet validated):
${pendingBlock}

EVIDENCE CHUNKS:
${evidenceBlock}

RULES:
- Cite evidence with bracketed numbers like [1], [3] matching the chunks above.
- Distinguish "validated" vs "pending review" claims explicitly.
- If the evidence does not support an answer, say so. Do not invent lenders or roles.
- Keep the answer concise (≤6 sentences) unless the user asks for detail.
- Never fabricate a citation index.`;

  const res = await fetch(`${GEMINI_FLASH_URL}?key=${apiKey}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 },
    }),
  });
  if (!res.ok) throw new Error(`gemini answer: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

Deno.serve(async (req: Request) => {
  const denied = checkInternalAuth(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const scope: 'plant' | 'lender' | 'global' = body.scope;
    const plantCode: string | null = body.plant_code ?? null;
    const lenderNormalized: string | null = body.lender_normalized ?? null;
    const question: string = String(body.question ?? '').trim();

    if (!['plant', 'lender', 'global'].includes(scope)) {
      return new Response(JSON.stringify({ error: 'invalid scope' }), { status: 400 });
    }
    if (scope === 'plant' && !plantCode) {
      return new Response(JSON.stringify({ error: 'plant_code required for scope=plant' }), { status: 400 });
    }
    if (scope === 'lender' && !lenderNormalized) {
      return new Response(JSON.stringify({ error: 'lender_normalized required for scope=lender' }), { status: 400 });
    }
    if (!question || question.length > MAX_QUESTION_LEN) {
      return new Response(JSON.stringify({ error: 'question required (≤1000 chars)' }), { status: 400 });
    }

    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const geminiApiKey   = Deno.env.get('GEMINI_API_KEY');
    if (!geminiApiKey) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not set' }), { status: 500 });
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── Embed + retrieve ─────────────────────────────────────────────────
    const qVec = await embedQuery(question, geminiApiKey);
    const { data: hitsRaw, error: rErr } = await supabase.rpc('search_lender_evidence', {
      p_query_embedding:   `[${qVec.join(',')}]`,
      p_plant_code:        scope === 'plant'  ? plantCode        : null,
      p_lender_normalized: scope === 'lender' ? lenderNormalized : null,
      p_max_results:       RETRIEVAL_K,
    });
    if (rErr) throw new Error(`search_lender_evidence: ${rErr.message}`);
    const hits = (hitsRaw ?? []) as ChunkHit[];

    // ── Structured side: validated + pending ─────────────────────────────
    let validated: any[] = [];
    let pending:   any[] = [];

    const lll = supabase.from('ucc_lender_links')
      .select('lender_name, lender_normalized, plant_code, evidence_type, confidence_class')
      .eq('human_approved', true)
      .is('quarantined_at', null);
    const lllu = supabase.from('ucc_lender_leads_unverified')
      .select('lender_name, lender_normalized, plant_code, confidence_class, evidence_type, lead_status')
      .eq('lead_status', 'pending')
      .is('quarantined_at', null);

    let qV = lll;
    let qP = lllu;
    if (scope === 'plant') {
      qV = qV.eq('plant_code', plantCode!);
      qP = qP.eq('plant_code', plantCode!);
    } else if (scope === 'lender') {
      qV = qV.eq('lender_normalized', lenderNormalized!);
      qP = qP.eq('lender_normalized', lenderNormalized!);
    }

    const [{ data: vRows }, { data: pRows }] = await Promise.all([qV.limit(50), qP.limit(50)]);
    validated = vRows ?? [];
    pending   = pRows ?? [];

    // ── Refusal path: no citations ───────────────────────────────────────
    if (hits.length === 0 && validated.length === 0 && pending.length === 0) {
      return new Response(JSON.stringify({
        ok: true,
        answer: 'I do not have any evidence on file to answer that question. Add citations to the lender evidence corpus first.',
        citations: [],
        structured: { validated: [], pending: [] },
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ── Compose scope line for the prompt ────────────────────────────────
    let scopeLine = '';
    if (scope === 'plant')  scopeLine = `Scope: a single plant (EIA code ${plantCode}).`;
    if (scope === 'lender') scopeLine = `Scope: a single lender (normalized: ${lenderNormalized}).`;
    if (scope === 'global') scopeLine = 'Scope: global — answer using any evidence retrieved.';

    const text = await answer(question, scopeLine, hits, validated, pending, geminiApiKey);

    const citations = hits.map((h, i) => ({
      index:        i + 1,
      chunk_id:     h.chunk_id,
      document_id:  h.document_id,
      source_type:  h.source_type,
      title:        h.title,
      url:          h.url,
      published_at: h.published_at,
      snippet:      h.content.slice(0, 240),
      similarity:   h.similarity,
    }));

    return new Response(JSON.stringify({
      ok: true,
      answer: text,
      citations,
      structured: { validated, pending },
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('lender-chat fatal:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
