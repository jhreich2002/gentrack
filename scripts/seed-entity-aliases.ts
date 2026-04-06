/**
 * seed-entity-aliases.ts
 *
 * Seeds the entity_aliases and entity_blocklist tables with known mappings,
 * then invokes the normalize-entities edge function for Gemini auto-detection.
 *
 * Run:
 *   npx tsx scripts/seed-entity-aliases.ts
 *   npx tsx scripts/seed-entity-aliases.ts --skip-gemini   (seed only, no auto-detect)
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const SKIP_GEMINI = process.argv.includes('--skip-gemini');

// ── Known alias seeds ─────────────────────────────────────────────────────────
// Each entry: { alias_name, canonical_name, entity_type }
// These are manually verified mappings that should always be present.

const ALIAS_SEEDS: { alias_name: string; canonical_name: string; entity_type: string }[] = [
  // Developer aliases
  { alias_name: 'Cypress Creek', canonical_name: 'Cypress Creek Renewables', entity_type: 'developer' },
  { alias_name: 'Cypress Creek Solutions', canonical_name: 'Cypress Creek Renewables', entity_type: 'developer' },
  { alias_name: 'Cypress Creek Renewables LLC', canonical_name: 'Cypress Creek Renewables', entity_type: 'developer' },
  { alias_name: 'CCR', canonical_name: 'Cypress Creek Renewables', entity_type: 'developer' },

  // Common lender aliases
  { alias_name: 'JP Morgan', canonical_name: 'JPMorgan Chase', entity_type: 'lender' },
  { alias_name: 'JPMorgan', canonical_name: 'JPMorgan Chase', entity_type: 'lender' },
  { alias_name: 'JPMorgan Chase & Co.', canonical_name: 'JPMorgan Chase', entity_type: 'lender' },
  { alias_name: 'JPMorgan Chase & Co', canonical_name: 'JPMorgan Chase', entity_type: 'lender' },
  { alias_name: 'JPMC', canonical_name: 'JPMorgan Chase', entity_type: 'lender' },
  { alias_name: 'JP Morgan Chase', canonical_name: 'JPMorgan Chase', entity_type: 'lender' },
  { alias_name: 'Bank of America Merrill Lynch', canonical_name: 'Bank of America', entity_type: 'lender' },
  { alias_name: 'BofA Securities', canonical_name: 'Bank of America', entity_type: 'lender' },
  { alias_name: 'BofA', canonical_name: 'Bank of America', entity_type: 'lender' },
  { alias_name: 'Goldman Sachs & Co.', canonical_name: 'Goldman Sachs', entity_type: 'lender' },
  { alias_name: 'Goldman, Sachs & Co.', canonical_name: 'Goldman Sachs', entity_type: 'lender' },
  { alias_name: 'GS', canonical_name: 'Goldman Sachs', entity_type: 'lender' },
  { alias_name: 'Morgan Stanley & Co.', canonical_name: 'Morgan Stanley', entity_type: 'lender' },
  { alias_name: 'Citi', canonical_name: 'Citibank', entity_type: 'lender' },
  { alias_name: 'Citigroup', canonical_name: 'Citibank', entity_type: 'lender' },
  { alias_name: 'Citibank N.A.', canonical_name: 'Citibank', entity_type: 'lender' },
  { alias_name: 'Wells Fargo & Company', canonical_name: 'Wells Fargo', entity_type: 'lender' },
  { alias_name: 'Wells Fargo Bank', canonical_name: 'Wells Fargo', entity_type: 'lender' },
  { alias_name: 'Wells Fargo Bank, N.A.', canonical_name: 'Wells Fargo', entity_type: 'lender' },
  { alias_name: 'US Bancorp', canonical_name: 'U.S. Bank', entity_type: 'lender' },
  { alias_name: 'U.S. Bancorp', canonical_name: 'U.S. Bank', entity_type: 'lender' },
  { alias_name: 'US Bank', canonical_name: 'U.S. Bank', entity_type: 'lender' },
  { alias_name: 'MUFG Bank', canonical_name: 'MUFG', entity_type: 'lender' },
  { alias_name: 'Mitsubishi UFJ Financial Group', canonical_name: 'MUFG', entity_type: 'lender' },
  { alias_name: 'SMBC', canonical_name: 'Sumitomo Mitsui Banking Corporation', entity_type: 'lender' },
  { alias_name: 'Sumitomo Mitsui', canonical_name: 'Sumitomo Mitsui Banking Corporation', entity_type: 'lender' },
  { alias_name: 'Credit Agricole CIB', canonical_name: 'Credit Agricole', entity_type: 'lender' },
  { alias_name: 'Crédit Agricole', canonical_name: 'Credit Agricole', entity_type: 'lender' },
  { alias_name: 'CoBank ACB', canonical_name: 'CoBank', entity_type: 'lender' },
  { alias_name: 'KeyBank National Association', canonical_name: 'KeyBank', entity_type: 'lender' },
  { alias_name: 'KeyBanc Capital Markets', canonical_name: 'KeyBank', entity_type: 'lender' },
  { alias_name: 'Rabobank', canonical_name: 'Rabobank', entity_type: 'lender' },
  { alias_name: 'Coöperatieve Rabobank', canonical_name: 'Rabobank', entity_type: 'lender' },
  { alias_name: 'ING Bank', canonical_name: 'ING', entity_type: 'lender' },
  { alias_name: 'ING Capital', canonical_name: 'ING', entity_type: 'lender' },
  { alias_name: 'NordLB', canonical_name: 'Nord/LB', entity_type: 'lender' },
  { alias_name: 'Norddeutsche Landesbank', canonical_name: 'Nord/LB', entity_type: 'lender' },

  // Common tax equity aliases
  { alias_name: 'JP Morgan', canonical_name: 'JPMorgan Chase', entity_type: 'tax_equity' },
  { alias_name: 'JPMorgan', canonical_name: 'JPMorgan Chase', entity_type: 'tax_equity' },
  { alias_name: 'JPMorgan Chase & Co.', canonical_name: 'JPMorgan Chase', entity_type: 'tax_equity' },
  { alias_name: 'US Bancorp', canonical_name: 'U.S. Bank', entity_type: 'tax_equity' },
  { alias_name: 'US Bank', canonical_name: 'U.S. Bank', entity_type: 'tax_equity' },
  { alias_name: 'U.S. Bancorp', canonical_name: 'U.S. Bank', entity_type: 'tax_equity' },
  { alias_name: 'Goldman Sachs & Co.', canonical_name: 'Goldman Sachs', entity_type: 'tax_equity' },
  { alias_name: 'GS', canonical_name: 'Goldman Sachs', entity_type: 'tax_equity' },
  { alias_name: 'Bank of America Merrill Lynch', canonical_name: 'Bank of America', entity_type: 'tax_equity' },
  { alias_name: 'BofA', canonical_name: 'Bank of America', entity_type: 'tax_equity' },
  { alias_name: 'Wells Fargo & Company', canonical_name: 'Wells Fargo', entity_type: 'tax_equity' },
  { alias_name: 'Wells Fargo Bank', canonical_name: 'Wells Fargo', entity_type: 'tax_equity' },

  // Company aliases (for company_stats news matching)
  { alias_name: 'NextEra Energy, Inc.', canonical_name: 'NextEra Energy', entity_type: 'company' },
  { alias_name: 'NextEra Energy Resources', canonical_name: 'NextEra Energy', entity_type: 'company' },
  { alias_name: 'NextEra Energy Resources, LLC', canonical_name: 'NextEra Energy', entity_type: 'company' },
  { alias_name: 'Duke Energy Corporation', canonical_name: 'Duke Energy', entity_type: 'company' },
  { alias_name: 'Berkshire Hathaway Energy Company', canonical_name: 'Berkshire Hathaway Energy', entity_type: 'company' },
  { alias_name: 'BHE Renewables', canonical_name: 'Berkshire Hathaway Energy', entity_type: 'company' },
  { alias_name: 'AES Corp.', canonical_name: 'AES Corporation', entity_type: 'company' },
  { alias_name: 'AES Corp', canonical_name: 'AES Corporation', entity_type: 'company' },
  { alias_name: 'Enel Green Power', canonical_name: 'Enel', entity_type: 'company' },
  { alias_name: 'Enel Green Power North America', canonical_name: 'Enel', entity_type: 'company' },
  { alias_name: 'Brookfield Renewable Partners', canonical_name: 'Brookfield Renewable', entity_type: 'company' },
  { alias_name: 'Brookfield Renewable Energy Partners', canonical_name: 'Brookfield Renewable', entity_type: 'company' },
];

// ── Known blocklist seeds ─────────────────────────────────────────────────────
// Junk / generic names that should never appear as entity entries.

const BLOCKLIST_SEEDS: { name: string; entity_type: string; reason: string }[] = [
  // Lender junk
  { name: 'consortium of banks', entity_type: 'lender', reason: 'Generic descriptor, not a named institution' },
  { name: 'a consortium of banks', entity_type: 'lender', reason: 'Generic descriptor' },
  { name: 'a group of lenders', entity_type: 'lender', reason: 'Generic descriptor' },
  { name: 'multiple lenders', entity_type: 'lender', reason: 'Generic descriptor' },
  { name: 'various banks', entity_type: 'lender', reason: 'Generic descriptor' },
  { name: 'undisclosed', entity_type: 'lender', reason: 'Placeholder, not a named institution' },
  { name: 'undisclosed lender', entity_type: 'lender', reason: 'Placeholder' },
  { name: 'undisclosed bank', entity_type: 'lender', reason: 'Placeholder' },
  { name: 'unknown', entity_type: 'lender', reason: 'Placeholder' },
  { name: 'unknown lender', entity_type: 'lender', reason: 'Placeholder' },
  { name: 'the lender', entity_type: 'lender', reason: 'Generic reference' },
  { name: 'the bank', entity_type: 'lender', reason: 'Generic reference' },
  { name: 'project lender', entity_type: 'lender', reason: 'Generic reference' },
  { name: 'bank', entity_type: 'lender', reason: 'Generic reference' },
  { name: 'financial institution', entity_type: 'lender', reason: 'Generic reference' },
  { name: 'N/A', entity_type: 'lender', reason: 'Placeholder' },
  { name: 'TBD', entity_type: 'lender', reason: 'Placeholder' },
  { name: 'not disclosed', entity_type: 'lender', reason: 'Placeholder' },

  // Tax equity junk
  { name: 'consortium of banks', entity_type: 'tax_equity', reason: 'Generic descriptor' },
  { name: 'undisclosed', entity_type: 'tax_equity', reason: 'Placeholder' },
  { name: 'undisclosed investor', entity_type: 'tax_equity', reason: 'Placeholder' },
  { name: 'unknown', entity_type: 'tax_equity', reason: 'Placeholder' },
  { name: 'unknown investor', entity_type: 'tax_equity', reason: 'Placeholder' },
  { name: 'the investor', entity_type: 'tax_equity', reason: 'Generic reference' },
  { name: 'tax equity investor', entity_type: 'tax_equity', reason: 'Generic reference, not a named institution' },
  { name: 'project sponsor', entity_type: 'tax_equity', reason: 'Generic reference' },
  { name: 'multiple investors', entity_type: 'tax_equity', reason: 'Generic descriptor' },
  { name: 'various investors', entity_type: 'tax_equity', reason: 'Generic descriptor' },
  { name: 'N/A', entity_type: 'tax_equity', reason: 'Placeholder' },
  { name: 'TBD', entity_type: 'tax_equity', reason: 'Placeholder' },

  // Developer junk
  { name: 'unknown', entity_type: 'developer', reason: 'Placeholder' },
  { name: 'N/A', entity_type: 'developer', reason: 'Placeholder' },
  { name: 'TBD', entity_type: 'developer', reason: 'Placeholder' },
  { name: 'undisclosed', entity_type: 'developer', reason: 'Placeholder' },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Seeding Entity Aliases & Blocklist ===\n');

  // Upsert alias seeds
  console.log(`Upserting ${ALIAS_SEEDS.length} alias seeds...`);
  const aliasRows = ALIAS_SEEDS.map(a => ({
    alias_name:     a.alias_name,
    canonical_name: a.canonical_name,
    entity_type:    a.entity_type,
    confidence:     'high' as const,
    source:         'seed_script',
  }));

  const { error: aliasErr } = await sb
    .from('entity_aliases')
    .upsert(aliasRows, { onConflict: 'alias_name,entity_type' });

  if (aliasErr) {
    console.error('❌ Alias upsert error:', aliasErr.message);
  } else {
    console.log(`✅ Upserted ${aliasRows.length} alias seeds`);
  }

  // Upsert blocklist seeds
  console.log(`\nUpserting ${BLOCKLIST_SEEDS.length} blocklist seeds...`);
  const blockRows = BLOCKLIST_SEEDS.map(b => ({
    name:        b.name,
    entity_type: b.entity_type,
    reason:      b.reason,
  }));

  const { error: blockErr } = await sb
    .from('entity_blocklist')
    .upsert(blockRows, { onConflict: 'name,entity_type' });

  if (blockErr) {
    console.error('❌ Blocklist upsert error:', blockErr.message);
  } else {
    console.log(`✅ Upserted ${blockRows.length} blocklist seeds`);
  }

  // Update developers.aliases for Cypress Creek
  console.log('\nUpdating developers.aliases for Cypress Creek...');
  const { data: ccDev } = await sb
    .from('developers')
    .select('id, aliases')
    .ilike('name', '%Cypress Creek Renewables%')
    .maybeSingle();

  if (ccDev) {
    const currentAliases: string[] = ccDev.aliases ?? [];
    const ccAliases = ALIAS_SEEDS
      .filter(a => a.entity_type === 'developer' && a.canonical_name === 'Cypress Creek Renewables')
      .map(a => a.alias_name);
    const merged = [...new Set([...currentAliases, ...ccAliases])];
    await sb.from('developers').update({ aliases: merged }).eq('id', ccDev.id);
    console.log(`✅ Developer aliases: [${merged.join(', ')}]`);
  } else {
    console.log('⚠️  No Cypress Creek Renewables developer found in DB');
  }

  // Invoke normalize-entities for Gemini auto-detection
  if (!SKIP_GEMINI) {
    console.log('\n=== Invoking normalize-entities (Gemini auto-detect) ===');
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/normalize-entities`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({ dry_run: false }),
      });
      const result = await resp.json();
      console.log('normalize-entities result:', JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('❌ Failed to invoke normalize-entities:', err);
    }
  } else {
    console.log('\n⏭️  Skipping Gemini auto-detect (--skip-gemini)');
  }

  // Summary
  console.log('\n=== Verification ===');
  const { count: aliasCount } = await sb.from('entity_aliases').select('*', { count: 'exact', head: true });
  const { count: blockCount } = await sb.from('entity_blocklist').select('*', { count: 'exact', head: true });
  console.log(`Total entity_aliases:   ${aliasCount}`);
  console.log(`Total entity_blocklist: ${blockCount}`);
  console.log('\nDone ✅');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
