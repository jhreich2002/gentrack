/**
 * purge_dirty_links.ts
 *
 * Finds and removes ucc_lender_links (and ucc_lender_leads_unverified) rows
 * whose entity name fails the P1 cleanLenderName() filter — i.e. dirty names
 * that were written by the old reviewer before P1 was deployed.
 *
 * Safety rules:
 *   - human_approved=true rows are NEVER deleted (regardless of name quality)
 *   - Dry-run by default — add --apply to actually delete
 *
 * Usage:
 *   npx tsx scripts/purge_dirty_links.ts              # preview only
 *   npx tsx scripts/purge_dirty_links.ts --apply      # delete dirty rows
 *   npx tsx scripts/purge_dirty_links.ts --apply --unverified  # also purge unverified table
 */

import fs   from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

// ── Env ───────────────────────────────────────────────────────────────────────

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1).trim();
    if (k && !process.env[k]) process.env[k] = v;
  }
}

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── CLI args ──────────────────────────────────────────────────────────────────

const args              = process.argv.slice(2);
const APPLY             = args.includes('--apply');
const INCLUDE_UNVERIFIED = args.includes('--unverified');

// ── cleanLenderName — exact copy from ucc-reviewer/index.ts ──────────────────

const _REJECT_NAME_RE  = /nothing contained|by and among|\bamong\b|lenders party thereto|the lenders listed|party hereto|hereby agree|pursuant to this|\bentered into\b|Company entered|the Company entered|we entered|signed a|is a party|as set forth|Credit Agreement|Loan Agreement|Note Purchase|Security Agreement|Indenture|Amendment No\.|\bAmendment\b.*\bAgreement\b/i;
const _ROLE_SUFFIX_RE  = /[,\s]+as\s+(?:(?:joint|lead|administrative|collateral|book(?:running)?|co-?)\s+)*(?:agent|arranger|lender|manager|trustee|bookrunner|borrower|obligor|guarantor)\b.*/i;
const _LEADING_PREP_RE = /^(?:with|by|from|and|the|each|any|a)\s+/i;
const _PURE_SUFFIX_RE  = /^(?:INC\.?|PLC\.?|Corp\.?|Corporation|LLC\.?|L\.L\.C\.?|N\.A\.?|Ltd\.?|Limited|LP|LLP)\s*[,;.]?\s*$/i;
const _FIN_ENTITY_RE   = /\b(?:Bank(?:\s+(?:N\.?A\.?|PLC|AG|SA|Corp\.?|Limited))?|N\.A\.|PLC|AG|LLC|L\.L\.C\.|LP|LLP|Inc\.?|Corp\.?|Ltd\.?|Limited|Capital(?:\s+(?:Group|Markets|Partners))?|Financial(?:\s+(?:Group|Corp))?|Securities(?:\s+LLC)?|Trust(?:\s+Company)?|Bancorp|Banque)\b/gi;

function cleanLenderName(raw: string): string | null {
  let name = raw.trim();

  if (/^[a-z]/.test(name)) {
    const sp = name.indexOf(' ');
    if (sp === -1) return null;
    name = name.slice(sp + 1).trim();
  }

  name = name.replace(_LEADING_PREP_RE, '').trim();
  if (/^[a-z]/.test(name)) return null;
  if (_REJECT_NAME_RE.test(name)) return null;

  name = name.replace(_ROLE_SUFFIX_RE, '').trim();
  name = name.replace(/[,;.\s]+$/, '').trim();

  if (_PURE_SUFFIX_RE.test(name)) return null;

  // 5c. Reject multi-entity strings where a complete company name (ending in a
  //     corporate suffix) is joined by " and " to another entity.
  const _MULTI_ENTITY_RE = /(?:Inc\.?|LLC|Ltd\.?|Limited|International|Corporation|Corp\.?|Company|Co\.?|Electric|Energy|Solar|Holdings|Group|Services|Power|N\.A\.?|PLC|AG|Agents|Issuers|Arrangers|Lenders|Participants|Borrowers)\s*(?:,\s+and\s+|\s+and\s+)[A-Z][A-Za-z\s\.&,]+/i;
  if (_MULTI_ENTITY_RE.test(name)) return null;

  if (name.length >= 3 && name.length <= 65 && /^[A-Z]/.test(name)) {
    return name;
  }

  const suffixHits = [...name.matchAll(new RegExp(_FIN_ENTITY_RE.source, 'gi'))];
  if (suffixHits.length === 0) return null;

  const last   = suffixHits[suffixHits.length - 1];
  const endPos = (last.index ?? 0) + last[0].length;

  const before = name.slice(0, last.index ?? 0);
  const parts  = before
    .split(/,\s*|\s+and\s+|\s*;\s*|\s+listed\s+|\s+named\s+|\s+therein\s*/)
    .filter(p => /[A-Z]/.test(p));
  const seg       = (parts[parts.length - 1] ?? '').trim();
  const candidate = (seg ? seg + ' ' : '') + name.slice(last.index ?? 0, endPos);
  const clean     = candidate.replace(/\s+/g, ' ').replace(/[,;.\s]+$/, '').trim();

  if (clean.length < 3 || clean.length > 80) return null;
  if (/^[^A-Z]/.test(clean))                 return null;
  if (_REJECT_NAME_RE.test(clean))            return null;

  return clean;
}

// ── Fetch and classify lender_links ──────────────────────────────────────────

interface LinkRow {
  id:             number;
  plant_code:     string;
  lender_entity_id: number;
  entity_name:    string;
  human_approved: boolean;
}

async function fetchDirtyLinks(): Promise<LinkRow[]> {
  const PAGE = 1000;
  const rows: LinkRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('ucc_lender_links')
      .select(`
        id, plant_code, lender_entity_id, human_approved,
        ucc_entities!lender_entity_id ( entity_name )
      `)
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`fetchDirtyLinks: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data as Record<string, unknown>[]) {
      const entity = (row.ucc_entities as Record<string, unknown>) ?? {};
      rows.push({
        id:               Number(row.id),
        plant_code:       String(row.plant_code ?? ''),
        lender_entity_id: Number(row.lender_entity_id),
        entity_name:      String(entity.entity_name ?? ''),
        human_approved:   Boolean(row.human_approved),
      });
    }

    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return rows;
}

interface UnverifiedRow {
  id:             number;
  plant_code:     string;
  lender_name:    string;
  human_approved: boolean;
}

async function fetchDirtyUnverified(): Promise<UnverifiedRow[]> {
  const PAGE = 1000;
  const rows: UnverifiedRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('ucc_lender_leads_unverified')
      .select('id, plant_code, lender_name, human_approved')
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`fetchDirtyUnverified: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data as Record<string, unknown>[]) {
      rows.push({
        id:             Number(row.id),
        plant_code:     String(row.plant_code ?? ''),
        lender_name:    String(row.lender_name ?? ''),
        human_approved: Boolean(row.human_approved),
      });
    }

    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (will delete)' : 'DRY RUN (preview only)'}`);
  console.log(`Tables: ucc_lender_links${INCLUDE_UNVERIFIED ? ' + ucc_lender_leads_unverified' : ''}\n`);

  // ── ucc_lender_links ──────────────────────────────────────────────────────
  console.log('Scanning ucc_lender_links…');
  const allLinks  = await fetchDirtyLinks();
  const dirtyLinks = allLinks.filter(r => {
    if (r.human_approved) return false;         // never touch approved rows
    return cleanLenderName(r.entity_name) === null;
  });

  const skippedApproved = allLinks.filter(r => r.human_approved && cleanLenderName(r.entity_name) === null);

  console.log(`  Total rows:            ${allLinks.length}`);
  console.log(`  Dirty (would delete):  ${dirtyLinks.length}`);
  console.log(`  Skipped (human_approved=true with dirty name): ${skippedApproved.length}`);

  if (dirtyLinks.length > 0) {
    console.log('\n  Sample dirty names (first 20):');
    const sample = [...new Set(dirtyLinks.map(r => r.entity_name))].slice(0, 20);
    for (const n of sample) console.log(`    • "${n}"`);
  }

  if (APPLY && dirtyLinks.length > 0) {
    const ids = dirtyLinks.map(r => r.id);
    // Delete in batches of 500 to avoid URL length limits
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const { error } = await supabase
        .from('ucc_lender_links')
        .delete()
        .in('id', batch);
      if (error) throw new Error(`delete ucc_lender_links: ${error.message}`);
      deleted += batch.length;
      console.log(`  Deleted ${deleted}/${ids.length}…`);
    }
    console.log(`  ✓ Deleted ${deleted} dirty lender_links rows.`);
  } else if (!APPLY && dirtyLinks.length > 0) {
    console.log('\n  (Pass --apply to delete these rows.)');
  }

  // ── ucc_lender_leads_unverified ───────────────────────────────────────────
  if (INCLUDE_UNVERIFIED) {
    console.log('\nScanning ucc_lender_leads_unverified…');
    const allUnverified  = await fetchDirtyUnverified();
    const dirtyUnverified = allUnverified.filter(r => {
      if (r.human_approved) return false;
      return cleanLenderName(r.lender_name) === null;
    });

    const skippedUv = allUnverified.filter(r => r.human_approved && cleanLenderName(r.lender_name) === null);

    console.log(`  Total rows:            ${allUnverified.length}`);
    console.log(`  Dirty (would delete):  ${dirtyUnverified.length}`);
    console.log(`  Skipped (human_approved=true with dirty name): ${skippedUv.length}`);

    if (dirtyUnverified.length > 0) {
      console.log('\n  Sample dirty names (first 20):');
      const sample = [...new Set(dirtyUnverified.map(r => r.lender_name))].slice(0, 20);
      for (const n of sample) console.log(`    • "${n}"`);
    }

    if (APPLY && dirtyUnverified.length > 0) {
      const ids = dirtyUnverified.map(r => r.id);
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500);
        const { error } = await supabase
          .from('ucc_lender_leads_unverified')
          .delete()
          .in('id', batch);
        if (error) throw new Error(`delete ucc_lender_leads_unverified: ${error.message}`);
        deleted += batch.length;
        console.log(`  Deleted ${deleted}/${ids.length}…`);
      }
      console.log(`  ✓ Deleted ${deleted} dirty unverified rows.`);
    } else if (!APPLY && dirtyUnverified.length > 0) {
      console.log('\n  (Pass --apply to delete these rows.)');
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
