// scripts/quarantine_legacy_leads.ts
// Phase 3: tag obviously-bad v1_legacy lender rows so they stop polluting
// the validation queue and (later) the embedding corpus.
//
// Heuristics for "obviously bad" (intentionally conservative — when in doubt,
// leave it for a human):
//   - lender_normalized length > 60 chars (real lender names are short)
//   - word count > 6
//   - contains sentence punctuation: '. ' / ': ' / '; ' / ' - '
//   - matches non-lender markers: ' llc owner', ' sponsor', ' developer ',
//     'project company', 'parent of', 'subsidiary of', 'affiliate of',
//     'served as', 'announced that', ' said ', ' will '
//
// Behavior:
//   - ucc_lender_links: set quarantined_at=now() + quarantine_reason
//     ONLY where human_approved IS NOT TRUE (we never quarantine validated rows)
//   - ucc_lender_leads_unverified: set lead_status='superseded' and
//     quarantined_at=now() ONLY where lead_status='pending'
//
// Usage:
//   npx tsx scripts/quarantine_legacy_leads.ts            # dry-run
//   npx tsx scripts/quarantine_legacy_leads.ts --apply    # write
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

function loadEnv(): void {
  for (const f of ['.env', '.env.local']) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k && !process.env[k]) process.env[k] = v;
    }
  }
}
loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key);
const APPLY = process.argv.includes('--apply');

const NON_LENDER_MARKERS = [
  ' llc owner', ' sponsor', ' developer ', 'project company',
  'parent of', 'subsidiary of', 'affiliate of',
  'served as', 'announced that', ' said ', ' will ',
  ' partnership ', ' acquired ', ' acquired by',
];

function classify(name: string | null | undefined): { bad: boolean; reason: string | null } {
  if (!name) return { bad: false, reason: null };
  const n = name.trim();
  if (n.length === 0) return { bad: false, reason: null };
  if (n.length > 60)                                    return { bad: true, reason: 'name_too_long' };
  const wc = n.split(/\s+/).length;
  if (wc > 6)                                           return { bad: true, reason: 'word_count_gt_6' };
  if (/[.;:]\s/.test(n))                                return { bad: true, reason: 'sentence_punctuation' };
  if (/\s-\s/.test(n))                                  return { bad: true, reason: 'dash_separator' };
  const lower = ' ' + n.toLowerCase() + ' ';
  for (const m of NON_LENDER_MARKERS) {
    if (lower.includes(m)) return { bad: true, reason: 'non_lender_marker:' + m.trim() };
  }
  return { bad: false, reason: null };
}

async function fetchAll<T>(table: string, columns: string, filter: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(columns).range(from, from + PAGE - 1);
    q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log('');

  // ── ucc_lender_links ────────────────────────────────────────────────────
  const links = await fetchAll<any>(
    'ucc_lender_links',
    'id, lender_normalized, lender_name, human_approved, quarantined_at, pipeline_version',
    q => q.or('human_approved.is.null,human_approved.eq.false')
          .is('quarantined_at', null)
  );
  console.log(`ucc_lender_links scanned (unapproved, not quarantined): ${links.length}`);

  const linkBad = links
    .map(r => ({ row: r, c: classify(r.lender_normalized || r.lender_name) }))
    .filter(x => x.c.bad);
  const reasonCountsLinks: Record<string, number> = {};
  for (const x of linkBad) reasonCountsLinks[x.c.reason!] = (reasonCountsLinks[x.c.reason!] || 0) + 1;
  console.log(`  → flagged: ${linkBad.length}`);
  for (const [r, c] of Object.entries(reasonCountsLinks)) console.log(`     - ${r}: ${c}`);

  // ── ucc_lender_leads_unverified ─────────────────────────────────────────
  const leads = await fetchAll<any>(
    'ucc_lender_leads_unverified',
    'id, lender_normalized, lender_name, lead_status, quarantined_at, pipeline_version',
    q => q.eq('lead_status', 'pending').is('quarantined_at', null)
  );
  console.log(`\nucc_lender_leads_unverified scanned (pending, not quarantined): ${leads.length}`);

  const leadBad = leads
    .map(r => ({ row: r, c: classify(r.lender_normalized || r.lender_name) }))
    .filter(x => x.c.bad);
  const reasonCountsLeads: Record<string, number> = {};
  for (const x of leadBad) reasonCountsLeads[x.c.reason!] = (reasonCountsLeads[x.c.reason!] || 0) + 1;
  console.log(`  → flagged: ${leadBad.length}`);
  for (const [r, c] of Object.entries(reasonCountsLeads)) console.log(`     - ${r}: ${c}`);

  // ── Sample ──────────────────────────────────────────────────────────────
  console.log('\nSample of flagged ucc_lender_links names (first 10):');
  for (const x of linkBad.slice(0, 10)) {
    console.log(`   [${x.c.reason}] ${x.row.lender_normalized || x.row.lender_name}`);
  }

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with --apply to write changes.');
    return;
  }

  // ── Apply ───────────────────────────────────────────────────────────────
  const NOW = new Date().toISOString();
  const BATCH = 200;

  let updatedLinks = 0;
  for (let i = 0; i < linkBad.length; i += BATCH) {
    const chunk = linkBad.slice(i, i + BATCH);
    // Group by reason for fewer roundtrips
    const byReason: Record<string, number[]> = {};
    for (const x of chunk) (byReason[x.c.reason!] ||= []).push(x.row.id);
    for (const [reason, ids] of Object.entries(byReason)) {
      const { error } = await sb
        .from('ucc_lender_links')
        .update({ quarantined_at: NOW, quarantine_reason: reason })
        .in('id', ids);
      if (error) { console.error(`links update [${reason}]:`, error.message); continue; }
      updatedLinks += ids.length;
    }
  }
  console.log(`\nucc_lender_links quarantined: ${updatedLinks}`);

  let updatedLeads = 0;
  for (let i = 0; i < leadBad.length; i += BATCH) {
    const chunk = leadBad.slice(i, i + BATCH);
    const byReason: Record<string, number[]> = {};
    for (const x of chunk) (byReason[x.c.reason!] ||= []).push(x.row.id);
    for (const [reason, ids] of Object.entries(byReason)) {
      const { error } = await sb
        .from('ucc_lender_leads_unverified')
        .update({
          lead_status: 'superseded',
          quarantined_at: NOW,
          quarantine_reason: reason,
        })
        .in('id', ids);
      if (error) { console.error(`leads update [${reason}]:`, error.message); continue; }
      updatedLeads += ids.length;
    }
  }
  console.log(`ucc_lender_leads_unverified quarantined: ${updatedLeads}`);
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
