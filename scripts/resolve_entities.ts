/**
 * resolve_entities.ts
 *
 * Priority 1a — Entity resolver / canonical deduplication
 *
 * Scans all `ucc_entities` rows with entity_type = 'lender', clusters them
 * by normalised-token similarity, and writes canonical_entity_id assignments
 * so that variant rows ("JPMorgan Chase Bank" vs "JPMORGAN CHASE BANK, N.A.")
 * collapse onto a single canonical entity at review time.
 *
 * Algorithm:
 *   1. Fetch all lender entities.
 *   2. For each pair, compute token-overlap similarity on their normalized names.
 *   3. Union-Find to group connected entities (sim > SIMILARITY_THRESHOLD).
 *   4. In each group, elect the "most complete" name as canonical:
 *        - prefers the longest name that passes cleanLenderName()
 *        - falls back to the most-recently created entity in the group
 *   5. For every non-canonical entity in the group, set canonical_entity_id
 *      = canonical entity's id (if not already set correctly).
 *
 * Safe to re-run: only updates rows where canonical_entity_id needs to change.
 *
 * Usage:
 *   npx tsx scripts/resolve_entities.ts [--dry-run] [--threshold 0.7]
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

// Load .env manually (no dotenv dependency needed)
const _env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
function getEnv(key: string): string {
  const m = _env.match(new RegExp(key + '=(.+)'));
  return (m ? m[1].trim() : process.env[key] ?? '');
}

const SUPABASE_URL             = getEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── CLI args ──────────────────────────────────────────────────────────────────

function getArg(flag: string, def: string): string {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : def;
}

const DRY_RUN   = process.argv.includes('--dry-run');
const THRESHOLD = parseFloat(getArg('--threshold', '0.70'));

console.log(`Entity resolver — threshold=${THRESHOLD}${DRY_RUN ? ' [DRY RUN]' : ''}`);

// ── Name cleaning (mirrors ucc-edgar-worker / ucc-reviewer) ───────────────────

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
  if (name.length >= 3 && name.length <= 65 && /^[A-Z]/.test(name)) return name;

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

// Stricter check for use as a canonical entity name / cluster representative.
// Rejects multi-entity strings (contains " and " between financial terms, or
// leading boilerplate words like "Lenders", "LLC", "Agents" etc.).
const _MULTI_ENTITY_RE   = /\b(?:bank|capital|financial|securities|trust|corp|inc|ltd|plc|ag|sa)\b.+\s+and\s+.+\b(?:bank|capital|financial|securities|trust|corp|inc|ltd|plc|ag|sa)\b/i;
const _LEADING_GENERIC_RE = /^(?:Lenders|Agents|Borrowers?|LLC|L\.L\.C\.|Guarantors?|the\s+Lenders|Initial\s+Lenders)\b/i;
// Reject names whose first comma-segment is a short generic fragment
// e.g. "C Issuer, Union Bank..." or "LLC, ..." (window-slice artefacts)
const _FRAGMENT_PREFIX_RE = /^[A-Z]{1,3}\s+\w+,|^\w+\s+(?:Issuer|Agent|Agents|LLC|Inc)\s*,/;

function isPureEntityName(name: string): boolean {
  const clean = cleanLenderName(name);
  if (clean === null || clean.length > 50) return false;
  if (_MULTI_ENTITY_RE.test(clean)) return false;
  if (_LEADING_GENERIC_RE.test(clean)) return false;
  if (_FRAGMENT_PREFIX_RE.test(clean)) return false;
  // Require ≥2 meaningful tokens (prevents single-token false merges like "Bank PLC" ~ "U.S. Bank")
  const words = clean.split(/\s+/).filter(w => w.replace(/[.,]/g, '').length >= 3);
  return words.length >= 2;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|lp|inc|corp|co|ltd|na|n\.a\.|plc|as agent|as collateral agent)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Union-Find ────────────────────────────────────────────────────────────────

function makeUnionFind(n: number): { parent: number[]; find: (x: number) => number; union: (x: number, y: number) => void } {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(x: number, y: number): void {
    parent[find(x)] = find(y);
  }
  return { parent, find, union };
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface EntityRow {
  id:                  number;
  entity_name:         string;
  normalized_name:     string;
  canonical_entity_id: number | null;
  created_at:          string;
}

(async () => {
  // 1. Fetch all lender entities
  const { data: rows, error } = await supabase
    .from('ucc_entities')
    .select('id, entity_name, normalized_name, canonical_entity_id, created_at')
    .eq('entity_type', 'lender')
    .order('id');

  if (error || !rows) {
    console.error('Failed to fetch entities:', error?.message);
    process.exit(1);
  }

  const entities = rows as EntityRow[];
  console.log(`Loaded ${entities.length} lender entities`);

  // 2. Token sets for each entity — only compute for pure, single-institution names.
  // Dirty multi-entity captures are kept in the DB but never drive clustering
  // and never become canonical targets.
  const isClean: boolean[] = entities.map(e => isPureEntityName(e.entity_name));

  const tokenSets: (Set<string> | null)[] = entities.map((e, i) => {
    if (!isClean[i]) return null;
    return new Set(e.normalized_name.split(' ').filter(t => t.length > 2));
  });

  // 3. Union-Find clustering
  const uf = makeUnionFind(entities.length);
  let pairsEvaluated = 0;
  let pairsLinked    = 0;

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = tokenSets[i];
      const b = tokenSets[j];
      // Skip if either entity is dirty (non-clean names should not drive clustering)
      if (!a || !b) continue;
      // Require ≥2 meaningful tokens — prevents single-token false merges (e.g. "Bank PLC" ~ "U.S. Bank")
      if (a.size < 2 || b.size < 2) continue;
      pairsEvaluated++;
      const shared  = [...a].filter(t => b.has(t)).length;
      const sim     = shared / Math.max(a.size, b.size);
      if (sim >= THRESHOLD) {
        uf.union(i, j);
        pairsLinked++;
      }
    }
  }

  console.log(`Evaluated ${pairsEvaluated} pairs, found ${pairsLinked} above threshold=${THRESHOLD}`);

  // 4. Group entities by cluster root
  const clusters = new Map<number, number[]>(); // root → [indices]
  for (let i = 0; i < entities.length; i++) {
    const root = uf.find(i);
    const g    = clusters.get(root) ?? [];
    g.push(i);
    clusters.set(root, g);
  }

  // Only process clusters of 2+
  const multiClusters = [...clusters.values()].filter(g => g.length > 1);
  console.log(`${multiClusters.length} clusters with ≥2 members`);

  if (multiClusters.length === 0) {
    console.log('No entity merges needed. Done.');
    return;
  }

  // 5. For each cluster, elect a canonical entity
  const updates: Array<{ id: number; canonical_entity_id: number; old_canonical: number | null; old_name: string; canonical_name: string }> = [];

  for (const indices of multiClusters) {
    const members = indices.map(i => entities[i]);

    // Prefer: longest name that is a pure single-institution name
    // Tiebreak: most recently created
    const withClean = members
      .map(e => ({ e, clean: cleanLenderName(e.entity_name) }))
      .filter(x => x.clean !== null && isPureEntityName(x.e.entity_name))
      .sort((a, b) => {
        if (b.clean!.length !== a.clean!.length) return b.clean!.length - a.clean!.length;
        return new Date(b.e.created_at).getTime() - new Date(a.e.created_at).getTime();
      });

    // If no member has a clean name, skip this cluster entirely
    if (withClean.length === 0) continue;
    const canonicalEntry = withClean[0].e;

    const canonicalId = canonicalEntry.id;

    for (const member of members) {
      if (member.id === canonicalId) continue; // skip canonical itself
      if (member.canonical_entity_id === canonicalId) continue; // already set correctly

      updates.push({
        id:                  member.id,
        canonical_entity_id: canonicalId,
        old_canonical:       member.canonical_entity_id,
        old_name:            member.entity_name,
        canonical_name:      canonicalEntry.entity_name,
      });
    }
  }

  console.log(`\n${updates.length} canonical_entity_id assignment(s) needed:`);
  for (const u of updates) {
    console.log(`  [${u.id}] "${u.old_name}"  →  canonical [${u.canonical_entity_id}] "${u.canonical_name}"`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes written.');
    return;
  }

  // 6. Apply updates in batches of 50
  let applied = 0;
  const BATCH = 50;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    for (const u of batch) {
      const { error: upErr } = await supabase
        .from('ucc_entities')
        .update({ canonical_entity_id: u.canonical_entity_id })
        .eq('id', u.id);
      if (upErr) {
        console.error(`  Failed to update entity ${u.id}: ${upErr.message}`);
      } else {
        applied++;
      }
    }
  }

  console.log(`\nApplied ${applied}/${updates.length} canonical_entity_id assignments.`);
  console.log('Re-run ucc-reviewer on affected plants to merge candidates in ucc_lender_links.');
})();
