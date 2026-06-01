import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkInternalOrAdminAuth } from '../_shared/auth.ts';

const PROMPT_VERSION = 'sonar-v5.3';
const MODEL = 'sonar-pro';
const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
const COST_CAP_USD = 0.10;
const RECENT_RESEARCH_DAYS = 7;
const MAX_SIBLINGS = 20;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

type RequestBody = {
  plant_id?: string;
  force?: boolean;
};

type SonarLender = {
  name?: string;
  role?: string | null;
  role_summary?: string | null;
  source_url?: string;
  evidence_quote?: string | null;
  applies_to_sister_units?: boolean;
};

function parseJwtSub(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = JSON.parse(atob(parts[1]));
    return typeof json.sub === 'string' ? json.sub : null;
  } catch {
    return null;
  }
}

function sanitizeNameToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOwner(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function nameRootToken(name: string): string {
  const removals = new Set([
    'unit', 'phase', 'block', 'north', 'south', 'east', 'west',
    'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
  ]);

  const words = sanitizeNameToken(name).split(' ').filter(Boolean);
  while (words.length > 0 && removals.has(words[words.length - 1])) {
    words.pop();
  }
  return words.slice(0, 3).join(' ');
}

function isValidSourceUrl(url: string | undefined): url is string {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

function estimateCostUsd(usage: Record<string, unknown> | null): number {
  if (!usage) return 0;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return 0;
  return (prompt * 3 + completion * 15) / 1_000_000;
}

function toJson(v: unknown): string {
  return JSON.stringify(v ?? {});
}

function systemPrompt(): string {
  return [
    'You are a project-finance research analyst. Identify DEBT lenders only for a US power plant.',
    'Return only named third-party commercial or institutional debt providers (commercial banks, investment banks, insurance-company private placement lenders, credit funds, or named syndicate members).',
    'Exclude tax-equity investors, sponsors, owners, operators, offtakers, EPC contractors, guarantors, and hedge counterparties.',
    'Exclude government agencies, sovereign entities, public programs, and loan guarantors. Do NOT list as lenders: U.S. Department of Energy, DOE Loan Programs Office, USDA, U.S. Treasury, Ex-Im Bank, OPIC, DFC, state energy offices, state green banks, or any federal/state agency. A DOE loan guarantee is NOT a lender.',
    'Exclude project-finance special-purpose vehicles (SPVs) and borrower entities. Do NOT list as lenders any entity whose name contains the project name plus words like Finance, Funding, Holdings, Holdco, LLC, LP, or Inc. when the entity is the borrower or issuer rather than a lender.',
    'Exclude generic or unlabeled categories. Do NOT list: Other Debt, Senior Debt, Term Loan, Project Finance, Construction Loan, Bank Debt, or similar category labels.',
    'If a bond was issued, list named underwriters or initial purchasers only when the source clearly states they purchased or placed the debt; otherwise do not list bond underwriters.',
    'If no credible source identifies a specific named lender, return lenders: []. Do not infer or guess. Never invent lenders.',
    'Every lender entry MUST include a source_url that directly supports the lender claim.',
    'If a source states financing applies to multiple units or phases of the same project, set applies_to_sister_units=true for that lender.',
    'If role is not explicitly stated in the source, set role to null. role_summary should be 1-2 sentences quoting or paraphrasing the source description of the lender role.',
  ].join(' ');
}

function userPrompt(plant: Record<string, unknown>, siblings: Array<Record<string, unknown>>): string {
  const siblingLines = siblings.length
    ? siblings.map((s) => `- ${String(s.name ?? '')} (${String(s.nameplate_capacity_mw ?? 'n/a')} MW)`).join('\n')
    : '- none identified';

  return [
    'Identify all DEBT lenders for this US power plant:',
    `- Plant name: ${String(plant.name ?? '')}`,
    `- Owner: ${String(plant.owner ?? '')}`,
    `- Location: ${String(plant.county ?? '')} County, ${String(plant.state ?? '')}`,
    `- Commercial Operation Date: ${String(plant.cod ?? '')}`,
    `- Nameplate capacity: ${String(plant.nameplate_capacity_mw ?? '')} MW`,
    '',
    'Sister units in the same project:',
    siblingLines,
    '',
    'Prefer sources that explicitly name lender institutions (credit agreements, project finance announcements, lender quote blocks, or SEC filings).',
    'Return JSON matching the schema. Preserve lender naming exactly as found in source text.',
  ].join('\n');
}

async function resolveCanonical(
  supabase: ReturnType<typeof createClient>,
  rawName: string,
): Promise<{ canonicalId: string | null; isTaxEquity: boolean }> {
  const { data: normalizedData } = await supabase.rpc('normalize_lender_name', { p_name: rawName });
  const normalized = typeof normalizedData === 'string' ? normalizedData : sanitizeNameToken(rawName);
  if (!normalized) return { canonicalId: null, isTaxEquity: false };

  const aliasRes = await supabase
    .from('lender_aliases')
    .select('canonical_id')
    .eq('normalized_alias', normalized)
    .limit(1)
    .maybeSingle();

  let canonicalId = aliasRes.data?.canonical_id ? String(aliasRes.data.canonical_id) : null;

  if (!canonicalId) {
    const canonicalRes = await supabase
      .from('lenders_canonical')
      .select('id')
      .eq('normalized_name', normalized)
      .limit(1)
      .maybeSingle();

    if (canonicalRes.data?.id) {
      canonicalId = String(canonicalRes.data.id);
      await supabase
        .from('lender_aliases')
        .upsert({ alias: rawName, normalized_alias: normalized, canonical_id: canonicalId }, { onConflict: 'alias' });
    }
  }

  if (!canonicalId) {
    const inserted = await supabase
      .from('lenders_canonical')
      .insert({ canonical_name: rawName, normalized_name: normalized, is_tax_equity: false })
      .select('id')
      .single();

    if (inserted.error || !inserted.data?.id) {
      return { canonicalId: null, isTaxEquity: false };
    }

    canonicalId = String(inserted.data.id);
    await supabase
      .from('lender_aliases')
      .upsert({ alias: rawName, normalized_alias: normalized, canonical_id: canonicalId }, { onConflict: 'alias' });
  }

  const canonical = await supabase
    .from('lenders_canonical')
    .select('is_tax_equity')
    .eq('id', canonicalId)
    .single();

  return {
    canonicalId,
    isTaxEquity: Boolean(canonical.data?.is_tax_equity),
  };
}

Deno.serve(async (req: Request) => {
  const denied = await checkInternalOrAdminAuth(req);
  if (denied) return denied;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers: CORS });
  }

  const plantId = typeof body.plant_id === 'string' ? body.plant_id : '';
  const force = Boolean(body.force);
  if (!plantId) {
    return new Response(JSON.stringify({ error: 'plant_id is required' }), { status: 400, headers: CORS });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const perplexityKey = Deno.env.get('PERPLEXITY_API_KEY') ?? '';

  if (!supabaseUrl || !serviceRole || !perplexityKey) {
    return new Response(JSON.stringify({ error: 'server_misconfigured' }), { status: 500, headers: CORS });
  }

  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const requestedBy = (() => {
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    return parseJwtSub(token);
  })();

  const plantRes = await supabase
    .from('plants')
    .select('id, name, state, county, owner, operator_id, cod, nameplate_capacity_mw')
    .eq('id', plantId)
    .single();

  if (plantRes.error || !plantRes.data) {
    return new Response(JSON.stringify({ error: `Plant ${plantId} not found` }), { status: 404, headers: CORS });
  }

  if (!force) {
    const recent = await supabase
      .from('plant_lender_research')
      .select('id, completed_at')
      .eq('plant_id', plantId)
      .not('status', 'eq', 'error')
      .gte('completed_at', new Date(Date.now() - RECENT_RESEARCH_DAYS * 24 * 60 * 60 * 1000).toISOString())
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recent.data?.id) {
      return new Response(JSON.stringify({ skipped: true, research_id: recent.data.id }), { status: 200, headers: CORS });
    }
  }

  const root = nameRootToken(String(plantRes.data.name ?? ''));
  const ownerNormalized = normalizeOwner(String(plantRes.data.owner ?? ''));

  let siblings: Array<Record<string, unknown>> = [];
  if (ownerNormalized && root) {
    const sibRes = await supabase
      .from('plants')
      .select('id, name, owner, nameplate_capacity_mw')
      .neq('id', plantId)
      .not('owner', 'is', null)
      .limit(1000);

    siblings = (sibRes.data ?? [])
      .filter((row) => normalizeOwner(String((row as any).owner ?? '')) === ownerNormalized)
      .filter((row) => nameRootToken(String((row as any).name ?? '')) === root)
      .slice(0, MAX_SIBLINGS) as Array<Record<string, unknown>>;
  }

  const callBody = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(plantRes.data as Record<string, unknown>, siblings) },
    ],
    return_citations: true,
    response_format: {
      type: 'json_schema',
      json_schema: {
        schema: {
          type: 'object',
          required: ['lenders'],
          properties: {
            lenders: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'source_url'],
                properties: {
                  name: { type: 'string' },
                  role: { type: ['string', 'null'] },
                  role_summary: { type: ['string', 'null'] },
                  source_url: { type: 'string', format: 'uri' },
                  evidence_quote: { type: ['string', 'null'] },
                  applies_to_sister_units: { type: 'boolean', default: false },
                },
              },
            },
          },
        },
      },
    },
  };

  let rawResponse: Record<string, unknown> | null = null;
  let parsedLenders: SonarLender[] = [];
  let costUsd = 0;

  try {
    const resp = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${perplexityKey}`,
      },
      body: JSON.stringify(callBody),
    });

    rawResponse = await resp.json();

    if (!resp.ok) {
      await supabase.from('plant_lender_research').insert({
        plant_id: plantId,
        status: 'error',
        prompt_version: PROMPT_VERSION,
        model: MODEL,
        cost_usd: 0,
        citations: [],
        raw_response: rawResponse,
        error_detail: `perplexity_http_${resp.status}`,
        requested_by: requestedBy,
        completed_at: new Date().toISOString(),
      });

      return new Response(JSON.stringify({ error: `Perplexity HTTP ${resp.status}` }), { status: 200, headers: CORS });
    }

    const usage = (rawResponse?.usage as Record<string, unknown> | undefined) ?? null;
    costUsd = estimateCostUsd(usage);

    const content = (rawResponse?.choices as any[])?.[0]?.message?.content;
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    parsedLenders = Array.isArray(parsed?.lenders) ? parsed.lenders as SonarLender[] : [];
  } catch (e) {
    await supabase.from('plant_lender_research').insert({
      plant_id: plantId,
      status: 'error',
      prompt_version: PROMPT_VERSION,
      model: MODEL,
      cost_usd: costUsd,
      citations: [],
      raw_response: rawResponse,
      error_detail: String(e),
      requested_by: requestedBy,
      completed_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ error: String(e) }), { status: 200, headers: CORS });
  }

  if (costUsd > COST_CAP_USD) {
    const capped = await supabase
      .from('plant_lender_research')
      .insert({
        plant_id: plantId,
        status: 'error',
        prompt_version: PROMPT_VERSION,
        model: MODEL,
        cost_usd: costUsd,
        citations: rawResponse?.citations ?? [],
        raw_response: rawResponse,
        error_detail: 'cost_cap_exceeded',
        requested_by: requestedBy,
        completed_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    return new Response(JSON.stringify({
      research_id: capped.data?.id ?? null,
      status: 'error',
      cost_usd: costUsd,
      error_detail: 'cost_cap_exceeded',
    }), { status: 200, headers: CORS });
  }

  const initialStatus = parsedLenders.length > 0 ? 'complete' : 'no_lender_identifiable';
  const researchRes = await supabase
    .from('plant_lender_research')
    .insert({
      plant_id: plantId,
      status: initialStatus,
      prompt_version: PROMPT_VERSION,
      model: MODEL,
      cost_usd: costUsd,
      citations: rawResponse?.citations ?? [],
      raw_response: rawResponse,
      requested_by: requestedBy,
      completed_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (researchRes.error || !researchRes.data?.id) {
    return new Response(JSON.stringify({ error: researchRes.error?.message ?? 'failed_to_insert_research' }), {
      status: 500,
      headers: CORS,
    });
  }

  const researchId = String(researchRes.data.id);
  let inserted = 0;
  const touchedSiblings = new Set<string>();

  // Delete stale direct links for this plant before inserting fresh ones.
  // Without this, re-runs accumulate links from all historical research runs,
  // causing outdated lenders to appear in the Financing tab.
  await supabase.from('plant_lender_links').delete()
    .eq('plant_id', plantId)
    .is('inferred_from_sibling_plant_id', null);
  // Also clean up any old sibling-fanout links where this plant was the source.
  await supabase.from('plant_lender_links').delete()
    .eq('inferred_from_sibling_plant_id', plantId);

  for (const lender of parsedLenders) {
    const lenderName = (lender.name ?? '').trim();
    if (!lenderName || !isValidSourceUrl(lender.source_url)) continue;

    const resolved = await resolveCanonical(supabase, lenderName);
    if (!resolved.canonicalId || resolved.isTaxEquity) continue;

    const baseRow = {
      plant_id: plantId,
      lender_id: resolved.canonicalId,
      role: lender.role ?? null,
      role_summary: lender.role_summary ?? null,
      source_url: lender.source_url,
      evidence_quote: lender.evidence_quote ?? null,
      research_id: researchId,
      inferred_from_sibling_plant_id: null,
      sibling_fanout_flagged: false,
    };

    const insertRes = await supabase
      .from('plant_lender_links')
      .insert(baseRow);

    if (!insertRes.error) inserted++;

    if (lender.applies_to_sister_units) {
      for (const sibling of siblings) {
        const siblingId = String((sibling as any).id ?? '');
        if (!siblingId) continue;
        touchedSiblings.add(siblingId);

        await supabase
          .from('plant_lender_links')
          .insert({
            ...baseRow,
            plant_id: siblingId,
            inferred_from_sibling_plant_id: plantId,
            sibling_fanout_flagged: true,
          });
      }
    }
  }

  const finalStatus = inserted > 0 ? 'complete' : 'no_lender_identifiable';
  if (finalStatus !== initialStatus) {
    await supabase
      .from('plant_lender_research')
      .update({ status: finalStatus })
      .eq('id', researchId);
  }

  return new Response(JSON.stringify({
    research_id: researchId,
    status: finalStatus,
    cost_usd: Number(costUsd.toFixed(5)),
    lenders_inserted: inserted,
    siblings_fanned_out_to: touchedSiblings.size,
    error_detail: null,
    debug_prompt: toJson(callBody),
  }), { status: 200, headers: CORS });
});
