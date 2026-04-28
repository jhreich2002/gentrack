/**
 * GenTrack — normalize-entities Edge Function
 *
 * Runs nightly BEFORE refresh-entity-stats.
 * Uses Gemini Flash to detect duplicate entity names and junk entries,
 * then upserts results into entity_aliases and entity_blocklist.
 *
 * POST body:
 *   {}                    — full run across all entity types
 *   { dry_run?: boolean } — if true, return proposed changes without writing
 *
 * Required secrets:
 *   GEMINI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

const GEMINI_URL   = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const BATCH_SIZE   = 150;  // max names per Gemini call to stay within context

// ── Types ─────────────────────────────────────────────────────────────────────

interface AliasGroup {
  canonical: string;
  aliases:   string[];
}

interface BlocklistEntry {
  name:   string;
  reason: string;
}

interface NormalizationResult {
  groups:    AliasGroup[];
  blocklist: BlocklistEntry[];
}

// ── Gemini call ───────────────────────────────────────────────────────────────

async function callGeminiNormalize(
  geminiKey: string,
  entityType: string,
  names: string[],
): Promise<NormalizationResult> {
  const prompt = buildNormalizationPrompt(entityType, names);

  const resp = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${text.slice(0, 300)}`);
  }

  const json = await resp.json();
  const raw  = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

  try {
    const parsed = JSON.parse(raw);
    return {
      groups:    Array.isArray(parsed.groups)    ? parsed.groups    : [],
      blocklist: Array.isArray(parsed.blocklist) ? parsed.blocklist : [],
    };
  } catch {
    console.error('Failed to parse Gemini response:', raw.slice(0, 500));
    return { groups: [], blocklist: [] };
  }
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildNormalizationPrompt(entityType: string, names: string[]): string {
  const typeLabel = entityType === 'tax_equity' ? 'tax equity investor' : entityType;

  return `You are a financial entity normalization assistant. You are given a list of ${typeLabel} names extracted from news articles and financial filings about US power plant financing.

TASK 1 — GROUP DUPLICATES:
Identify names that refer to the SAME real-world entity and group them. Choose the most standard/recognizable form as the "canonical" name. Common patterns to catch:
- Same company with/without legal suffix: "NextEra Energy" vs "NextEra Energy, Inc." vs "NextEra Energy Resources, LLC"
- Abbreviations vs full names: "JPMC" vs "JPMorgan Chase"
- Slight spelling variations: "Goldman Sachs" vs "Goldman, Sachs & Co."
- Parent-subsidiary where the names clearly overlap: "Bank of America" vs "BofA Securities"
- Same entity with extra descriptors: "Cypress Creek" vs "Cypress Creek Renewables" vs "Cypress Creek Solutions"

Do NOT group entities that are genuinely different companies even if names are similar.

TASK 2 — IDENTIFY JUNK ENTRIES:
Identify names that are NOT real named institutions/companies. These include:
- Generic descriptions: "consortium of banks", "a group of lenders", "undisclosed investor", "various banks"
- Placeholder text: "unknown", "TBD", "N/A", "multiple lenders"
- Overly generic: "the lender", "project sponsor", "the investor", "bank", "financial institution"

INPUT NAMES (${entityType}):
${JSON.stringify(names)}

OUTPUT — return ONLY valid JSON, no markdown:
{
  "groups": [
    {
      "canonical": "JPMorgan Chase",
      "aliases": ["JPMC", "JP Morgan", "JPMorgan Chase & Co."]
    }
  ],
  "blocklist": [
    {
      "name": "consortium of banks",
      "reason": "Generic descriptor, not a named institution"
    }
  ]
}

RULES:
- Only output groups with 2+ names (canonical + at least 1 alias)
- The canonical name should NOT appear in its own aliases array
- If all names appear to be unique valid entities, return empty groups array
- Be conservative — only group names you are CONFIDENT refer to the same entity
- For the blocklist, only include clear junk entries, not ambiguous ones`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const __authDenied = checkInternalAuth(req);
  if (__authDenied) return __authDenied;
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const geminiKey   = Deno.env.get('GEMINI_API_KEY')!;
  const sb          = createClient(supabaseUrl, serviceKey);

  let dryRun = false;
  try {
    const body = await req.json().catch(() => ({}));
    dryRun = body.dry_run === true;
  } catch { /* empty body is fine */ }

  try {
    // ── 1. Load existing aliases and blocklist to skip known names ───────────
    const { data: existingAliases } = await sb
      .from('entity_aliases')
      .select('alias_name, entity_type');
    const knownAliases = new Set(
      (existingAliases ?? []).map(r => `${r.entity_type}:${r.alias_name.toLowerCase()}`)
    );

    const { data: existingBlocklist } = await sb
      .from('entity_blocklist')
      .select('name, entity_type');
    const knownBlocked = new Set(
      (existingBlocklist ?? []).map(r => `${r.entity_type}:${r.name.toLowerCase()}`)
    );

    console.log(`Existing: ${knownAliases.size} aliases, ${knownBlocked.size} blocklist entries`);

    // ── 2. Load distinct entity names per type ──────────────────────────────

    // Lenders: non-tax-equity from plant_lenders
    const { data: lenderNameRows } = await sb
      .from('plant_lenders')
      .select('lender_name, facility_type');
    const lenderNames = new Set<string>();
    const taxEquityNames = new Set<string>();
    for (const row of (lenderNameRows ?? [])) {
      if (!row.lender_name) continue;
      if (row.facility_type === 'tax_equity') {
        taxEquityNames.add(row.lender_name);
      } else {
        lenderNames.add(row.lender_name);
      }
    }

    // Developers
    const { data: devRows } = await sb.from('developers').select('name');
    const developerNames = new Set<string>((devRows ?? []).map(r => r.name).filter(Boolean));

    console.log(`Distinct names — lenders: ${lenderNames.size}, tax_equity: ${taxEquityNames.size}, developers: ${developerNames.size}`);

    // ── 3. Process each entity type through Gemini ──────────────────────────
    const allNewAliases:    { alias_name: string; canonical_name: string; entity_type: string }[] = [];
    const allNewBlocklist:  { name: string; entity_type: string; reason: string }[] = [];

    const entityBatches: { type: string; names: string[] }[] = [
      { type: 'lender',     names: [...lenderNames] },
      { type: 'tax_equity', names: [...taxEquityNames] },
      { type: 'developer',  names: [...developerNames] },
    ];

    for (const { type, names } of entityBatches) {
      if (names.length < 2) {
        console.log(`Skipping ${type}: only ${names.length} names`);
        continue;
      }

      // Process in batches to stay within Gemini context limits
      for (let i = 0; i < names.length; i += BATCH_SIZE) {
        const batch = names.slice(i, i + BATCH_SIZE);
        console.log(`Processing ${type} batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} names`);

        const result = await callGeminiNormalize(geminiKey, type, batch);

        // Collect new aliases (skip already-known ones)
        for (const group of result.groups) {
          for (const alias of group.aliases) {
            const key = `${type}:${alias.toLowerCase()}`;
            if (!knownAliases.has(key) && alias.toLowerCase() !== group.canonical.toLowerCase()) {
              allNewAliases.push({
                alias_name:     alias,
                canonical_name: group.canonical,
                entity_type:    type,
              });
              knownAliases.add(key);  // prevent duplicates within this run
            }
          }
        }

        // Collect new blocklist entries (skip already-known ones)
        for (const entry of result.blocklist) {
          const key = `${type}:${entry.name.toLowerCase()}`;
          if (!knownBlocked.has(key)) {
            allNewBlocklist.push({
              name:        entry.name,
              entity_type: type,
              reason:      entry.reason,
            });
            knownBlocked.add(key);
          }
        }

        // Rate limit between batches
        if (i + BATCH_SIZE < names.length) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    console.log(`Discovered: ${allNewAliases.length} new aliases, ${allNewBlocklist.length} new blocklist entries`);

    if (dryRun) {
      return new Response(JSON.stringify({
        ok: true,
        dry_run: true,
        proposed_aliases:   allNewAliases,
        proposed_blocklist: allNewBlocklist,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ── 4. Upsert new aliases ───────────────────────────────────────────────
    if (allNewAliases.length > 0) {
      const aliasRows = allNewAliases.map(a => ({
        alias_name:     a.alias_name,
        canonical_name: a.canonical_name,
        entity_type:    a.entity_type,
        confidence:     'auto',
        source:         'gemini_auto',
      }));

      const { error } = await sb
        .from('entity_aliases')
        .upsert(aliasRows, { onConflict: 'alias_name,entity_type' });
      if (error) console.error(`alias upsert error: ${error.message}`);
      else console.log(`Upserted ${aliasRows.length} aliases`);
    }

    // ── 5. Upsert new blocklist entries ─────────────────────────────────────
    if (allNewBlocklist.length > 0) {
      const blockRows = allNewBlocklist.map(b => ({
        name:        b.name,
        entity_type: b.entity_type,
        reason:      b.reason,
      }));

      const { error } = await sb
        .from('entity_blocklist')
        .upsert(blockRows, { onConflict: 'name,entity_type' });
      if (error) console.error(`blocklist upsert error: ${error.message}`);
      else console.log(`Upserted ${blockRows.length} blocklist entries`);
    }

    // ── 6. Update developers.aliases column for developer groups ────────────
    const devAliasGroups = allNewAliases.filter(a => a.entity_type === 'developer');
    if (devAliasGroups.length > 0) {
      // Group by canonical name
      const byCanonical = new Map<string, string[]>();
      for (const a of devAliasGroups) {
        if (!byCanonical.has(a.canonical_name)) byCanonical.set(a.canonical_name, []);
        byCanonical.get(a.canonical_name)!.push(a.alias_name);
      }

      for (const [canonical, aliases] of byCanonical) {
        // Fetch current aliases array
        const { data: dev } = await sb
          .from('developers')
          .select('id, aliases')
          .ilike('name', canonical)
          .maybeSingle();

        if (dev) {
          const currentAliases: string[] = dev.aliases ?? [];
          const merged = [...new Set([...currentAliases, ...aliases])];
          await sb
            .from('developers')
            .update({ aliases: merged })
            .eq('id', dev.id);
          console.log(`Updated developer "${canonical}" aliases: ${merged.join(', ')}`);
        }
      }
    }

    const result = {
      ok: true,
      new_aliases:   allNewAliases.length,
      new_blocklist: allNewBlocklist.length,
      dev_aliases_updated: devAliasGroups.length,
    };
    console.log('normalize-entities complete:', result);

    // ── Chain to refresh-entity-stats ──────────────────────────────────────
    try {
      const fnUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/refresh-entity-stats`;
      fetch(fnUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('INTERNAL_AUTH_TOKEN')}`,
        },
        body: '{}',
      });
      console.log('Chained refresh-entity-stats');
    } catch (chainErr) {
      console.warn('Chain to refresh-entity-stats failed (non-fatal):', chainErr);
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('normalize-entities error:', msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
