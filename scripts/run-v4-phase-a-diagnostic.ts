/**
 * GenTrack — Phase A Funnel Diagnostic
 *
 * Reads all lender pipeline sessions from the last 24h and produces a
 * complete funnel breakdown to diagnose why lenders aren't being surfaced.
 *
 * Outputs:
 *  A1. Drop-reason × source-agent matrix
 *  A2. Role-tag distribution on "silently-filtered" claims
 *      (dropped_reason=null but no corresponding lender_link)
 *  A3. Source-agent coverage per session
 *  A4. Session-level outcome rollup
 *  A5. Sample of claims with each failure mode (quotes + URLs)
 *  A6. Resolver post-mortem (canonical_resolution_failed names)
 *
 * Usage:
 *   npx tsx scripts/run-v4-phase-a-diagnostic.ts
 *   npx tsx scripts/run-v4-phase-a-diagnostic.ts --hours 48
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

// ── Env ───────────────────────────────────────────────────────────────────────

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, 'utf8');
  const map: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map[line.slice(0, eq).trim()] = value;
  }
  return map;
}

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const out = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out.set(key, next); i++; }
    else out.set(key, true);
  }
  return out;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClaimRow {
  id: number;
  session_id: string;
  source_agent: string;
  raw_lender_name: string | null;
  role_tag: string | null;
  confidence: number | null;
  dropped_reason: string | null;
  source_url: string | null;
  quote: string | null;
}

interface SessionRow {
  id: string;
  plant_id: string;
  status: string;
  completed_at: string | null;
}

interface LinkRow {
  id: number;
  primary_claim_id: number | null;
  plant_id: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// 'unknown' is included because Fix 2 expanded the reviewer to process unknown-role claims
// (confidence gate drops low-confidence ones; the rest flow through citation QA normally).
const DEBT_ROLE_TAGS = new Set(['debt_lender', 'admin_agent', 'collateral_agent', 'syndicate_member', 'unknown']);

function fmtPct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) { console.log('  (no data)'); return; }
  const cols = Object.keys(rows[0]);
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const sep = '+-' + widths.map(w => '-'.repeat(w)).join('-+-') + '-+';
  const row = (r: Record<string, unknown>) =>
    '| ' + cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join(' | ') + ' |';
  console.log(sep);
  console.log('| ' + cols.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |');
  console.log(sep);
  for (const r of rows) console.log(row(r));
  console.log(sep);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const hours = Number(args.get('hours') ?? 24);
  const sampleN = Number(args.get('sample') ?? 5);

  const envRoot = path.resolve(process.cwd(), '.env');
  const envLocal = path.resolve(process.cwd(), '.env.local');
  const localEnv = { ...parseEnvFile(envRoot), ...parseEnvFile(envLocal) };
  const get = (k: string) => process.env[k] ?? localEnv[k] ?? '';

  const supabaseUrl = get('SUPABASE_URL') || get('VITE_SUPABASE_URL');
  const serviceKey  = get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceKey) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env');
    process.exit(1);
  }

  const sb = createClient(supabaseUrl, serviceKey);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  console.log(`\n${'═'.repeat(72)}`);
  console.log(` GenTrack — Phase A Funnel Diagnostic`);
  console.log(` Window: last ${hours}h (since ${since.slice(0, 16)}Z)`);
  console.log(`${'═'.repeat(72)}\n`);

  // ── Fetch sessions ────────────────────────────────────────────────────────
  const { data: sessions, error: sessErr } = await sb
    .from('lender_research_sessions')
    .select('id, plant_id, status, completed_at')
    .gte('completed_at', since)
    .not('status', 'eq', 'running');

  if (sessErr) { console.error('Session fetch failed:', sessErr.message); process.exit(1); }
  const allSessions = (sessions ?? []) as SessionRow[];
  const sessionIds = allSessions.map(s => s.id);

  console.log(`A0. Session summary (n=${allSessions.length})`);
  const byStatus: Record<string, number> = {};
  for (const s of allSessions) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  printTable(
    Object.entries(byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([status, n]) => ({ status, sessions: n, pct: fmtPct(n, allSessions.length) }))
  );

  if (sessionIds.length === 0) {
    console.log('No sessions in window. Exiting.');
    process.exit(0);
  }

  // ── Fetch all claims ──────────────────────────────────────────────────────
  const { data: claims, error: claimErr } = await sb
    .from('lender_research_claims')
    .select('id, session_id, source_agent, raw_lender_name, role_tag, confidence, dropped_reason, source_url, quote')
    .in('session_id', sessionIds);

  if (claimErr) { console.error('Claim fetch failed:', claimErr.message); process.exit(1); }
  const allClaims = (claims ?? []) as ClaimRow[];
  console.log(`\nTotal claims: ${allClaims.length}`);

  // ── Fetch lender links (to find "silently filtered" claims) ───────────────
  const { data: links, error: linkErr } = await sb
    .from('lender_links')
    .select('id, primary_claim_id, plant_id')
    .in('plant_id', [...new Set(allSessions.map(s => s.plant_id))]);

  if (linkErr) { console.error('Link fetch failed:', linkErr.message); process.exit(1); }
  const linkedClaimIds = new Set((links ?? []).map((l: LinkRow) => l.primary_claim_id).filter(Boolean));

  // ── Fetch lender_link_evidence (evidence-contributing claims) ─────────────
  // A claim that contributed evidence to an existing link is not silently filtered;
  // it was processed by the reviewer but lost the primary_claim_id race to a higher-
  // confidence sibling.  Classify these as 'contributed_evidence' rather than
  // 'passed_qc_no_link' so the funnel numbers stay accurate.
  const linkIds = ((links ?? []) as Array<{ id?: number; primary_claim_id: number | null; plant_id: string }>)
    .map(l => l.id)
    .filter(Boolean) as number[];
  let evidenceClaimIds = new Set<number>();
  if (linkIds.length > 0) {
    const { data: evRows } = await sb
      .from('lender_link_evidence')
      .select('claim_id')
      .in('link_id', linkIds);
    evidenceClaimIds = new Set(
      ((evRows ?? []) as Array<{ claim_id: number }>).map(r => r.claim_id)
    );
  }

  // ── Classify every claim ──────────────────────────────────────────────────
  const classified = allClaims.map(c => {
    const hasUrl = !!(c.source_url && c.source_url.startsWith('http'));
    const hasQuote = !!(c.quote && c.quote.trim().length >= 10);
    const isDebtRole = DEBT_ROLE_TAGS.has(c.role_tag ?? '');
    const linkedAsLink = linkedClaimIds.has(c.id);
    const isEvidence = evidenceClaimIds.has(c.id);
    let fate: string;
    if (linkedAsLink) {
      fate = 'became_link';           // primary claim for a lender_link
    } else if (isEvidence) {
      fate = 'contributed_evidence';  // supporting evidence on an existing link (not primary)
    } else if (c.dropped_reason) {
      fate = `dropped:${c.dropped_reason}`;
    } else if (!isDebtRole) {
      // Non-debt role_tags (sponsor, tax_equity, etc.) are never sent to the reviewer.
      // 'unknown' IS included in DEBT_ROLE_TAGS since Fix 2, so this bucket should
      // shrink to ~0 for post-fix sessions.
      fate = 'silently_filtered:wrong_role_tag';
    } else if (!hasUrl) {
      fate = 'reviewer_would_drop:no_source_url';
    } else if (!hasQuote) {
      fate = 'reviewer_would_drop:no_quote';
    } else {
      // Passed all QA gates and went through reviewer, but neither became the primary
      // claim nor contributed evidence.  Likely: resolver created a new canonical entry
      // but the link already existed with a higher-confidence primary.
      fate = 'passed_qc_no_link';
    }
    return { ...c, hasUrl, hasQuote, isDebtRole, linkedAsLink, isEvidence, fate };
  });

  // ── A1. Drop-reason × source-agent matrix ─────────────────────────────────
  console.log(`\n${'─'.repeat(72)}`);
  console.log('A1. CLAIM FATE × SOURCE AGENT');
  console.log(`${'─'.repeat(72)}`);
  type MatrixKey = string;
  const matrix: Record<MatrixKey, number> = {};
  for (const c of classified) {
    const key = `${c.source_agent ?? 'unknown'}\t${c.fate}`;
    matrix[key] = (matrix[key] ?? 0) + 1;
  }
  const matrixRows: Record<string, unknown>[] = Object.entries(matrix)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => {
      const [source_agent, fate] = k.split('\t');
      return { source_agent, fate, n, pct: fmtPct(n, allClaims.length) };
    });
  printTable(matrixRows);

  // ── A2. Role-tag distribution on silently-filtered claims ─────────────────
  const silentlyFiltered = classified.filter(c => c.fate === 'silently_filtered:wrong_role_tag');
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`A2. ROLE-TAG DISTRIBUTION ON SILENTLY-FILTERED CLAIMS (n=${silentlyFiltered.length})`);
  console.log('    These claims survived synthesis but reviewer skipped them due to role_tag');
  console.log(`${'─'.repeat(72)}`);
  const byRole: Record<string, number> = {};
  for (const c of silentlyFiltered) byRole[c.role_tag ?? 'null'] = (byRole[c.role_tag ?? 'null'] ?? 0) + 1;
  printTable(
    Object.entries(byRole)
      .sort((a, b) => b[1] - a[1])
      .map(([role_tag, n]) => ({ role_tag, n, pct: fmtPct(n, silentlyFiltered.length) }))
  );

  // ── A3. Source-agent coverage per session (no-lender sessions only) ───────
  const noLenderSessions = allSessions.filter(s => s.status === 'no_lender_identifiable');
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`A3. SOURCE-AGENT COVERAGE — no_lender_identifiable sessions (n=${noLenderSessions.length})`);
  console.log(`${'─'.repeat(72)}`);
  type AgentCovRow = { session_id: string; plant_id: string; edgar: number; records: number; web: number; total: number; all_zero: string };
  const coverageRows: AgentCovRow[] = noLenderSessions.map(s => {
    const sc = allClaims.filter(c => c.session_id === s.id);
    const edgar   = sc.filter(c => c.source_agent === 'edgar').length;
    const records = sc.filter(c => c.source_agent === 'records').length;
    const web     = sc.filter(c => c.source_agent === 'web').length;
    return { session_id: s.id.slice(0, 8), plant_id: s.plant_id, edgar, records, web, total: sc.length, all_zero: edgar + records + web === 0 ? 'YES' : '' };
  }).sort((a, b) => a.total - b.total);
  printTable(coverageRows);

  // ── A4. Debt-role claim availability ─────────────────────────────────────
  const debtClaims = classified.filter(c => c.isDebtRole);
  const nonDebtClaims = classified.filter(c => !c.isDebtRole && !c.dropped_reason);
  const droppedInSynthesis = classified.filter(c => c.dropped_reason && !c.fate.startsWith('reviewer_would_drop') && c.fate !== 'became_link');
  const droppedInReviewer = classified.filter(c => c.fate.startsWith('reviewer_would_drop') || (c.dropped_reason && ['no_source_url','no_quote','canonical_resolution_failed'].includes(c.dropped_reason)));

  console.log(`\n${'─'.repeat(72)}`);
  console.log('A4. FUNNEL SUMMARY');
  console.log(`${'─'.repeat(72)}`);
  printTable([
    { stage: 'Total claims produced', n: allClaims.length, pct: '100%' },
    { stage: 'Became lender_link (primary claim)', n: classified.filter(c => c.linkedAsLink).length, pct: fmtPct(classified.filter(c => c.linkedAsLink).length, allClaims.length) },
    { stage: 'Contributed evidence (non-primary, link already existed)', n: classified.filter(c => c.fate === 'contributed_evidence').length, pct: fmtPct(classified.filter(c => c.fate === 'contributed_evidence').length, allClaims.length) },
    { stage: 'Dropped in synthesis (dropped_reason set by synthesis)', n: droppedInSynthesis.length, pct: fmtPct(droppedInSynthesis.length, allClaims.length) },
    { stage: 'Silently filtered (non-debt role_tag, reviewer never called)', n: silentlyFiltered.length, pct: fmtPct(silentlyFiltered.length, allClaims.length) },
    { stage: 'Dropped in reviewer (no_source_url / no_quote / unclassified_low_confidence / canonical_resolution_failed)', n: droppedInReviewer.length, pct: fmtPct(droppedInReviewer.length, allClaims.length) },
    { stage: 'Debt/unknown-role claims (eligible for reviewer)', n: debtClaims.length, pct: fmtPct(debtClaims.length, allClaims.length) },
  ]);

  // ── A5. Sample claims for each failure mode ───────────────────────────────
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`A5. SAMPLE CLAIMS BY FATE (up to ${sampleN} each)`);
  console.log(`${'─'.repeat(72)}`);

  const fateGroups: Record<string, typeof classified> = {};
  for (const c of classified) {
    fateGroups[c.fate] = fateGroups[c.fate] ?? [];
    fateGroups[c.fate].push(c);
  }

  for (const [fate, group] of Object.entries(fateGroups).sort()) {
    const sample = group.slice(0, sampleN);
    console.log(`\n  [${fate}] (${group.length} total)`);
    for (const c of sample) {
      console.log(`    agent=${c.source_agent} role=${c.role_tag ?? 'null'} conf=${c.confidence ?? '?'}`);
      console.log(`    lender: ${c.raw_lender_name ?? 'null'}`);
      console.log(`    url: ${c.source_url ? c.source_url.slice(0, 100) : 'NULL'}`);
      console.log(`    quote: ${c.quote ? c.quote.slice(0, 120).replace(/\n/g, ' ') : 'NULL'}`);
      console.log('');
    }
  }

  // ── A6. Resolver post-mortem ──────────────────────────────────────────────
  const cfFailed = classified.filter(c => c.dropped_reason === 'canonical_resolution_failed');
  if (cfFailed.length > 0) {
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`A6. CANONICAL_RESOLUTION_FAILED — top raw names (${cfFailed.length} total)`);
    console.log(`${'─'.repeat(72)}`);
    const nameCounts: Record<string, number> = {};
    for (const c of cfFailed) nameCounts[c.raw_lender_name ?? 'null'] = (nameCounts[c.raw_lender_name ?? 'null'] ?? 0) + 1;
    printTable(
      Object.entries(nameCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([raw_lender_name, n]) => ({ raw_lender_name, n }))
    );
  } else {
    console.log('\nA6. No canonical_resolution_failed claims in window.');
  }

  // ── A7. Silently-filtered debt-adjacent: what role_tags are close? ────────
  // These are claims synthesis tagged as non-debt but may actually be lenders
  const borderlineTags = silentlyFiltered.filter(c => ['tax_equity', 'sponsor', 'equity_investor', 'financier'].includes(c.role_tag ?? ''));
  if (borderlineTags.length > 0) {
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`A7. BORDERLINE ROLE TAGS (tax_equity / sponsor / equity_investor / financier) — ${borderlineTags.length} claims`);
    console.log('    These may include real lenders misclassified by synthesis. Sample:');
    console.log(`${'─'.repeat(72)}`);
    for (const c of borderlineTags.slice(0, sampleN)) {
      console.log(`    agent=${c.source_agent} role=${c.role_tag} conf=${c.confidence ?? '?'}`);
      console.log(`    lender: ${c.raw_lender_name}`);
      console.log(`    quote: ${c.quote ? c.quote.slice(0, 140).replace(/\n/g, ' ') : 'NULL'}`);
      console.log('');
    }
  }

  // ── Summary verdict ───────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  console.log(' VERDICT');
  console.log(`${'═'.repeat(72)}`);

  const totalDropped = allClaims.length - classified.filter(c => c.linkedAsLink).length;
  const pctSilent = totalDropped > 0 ? Math.round((silentlyFiltered.length / totalDropped) * 100) : 0;
  const pctSynthDrop = totalDropped > 0 ? Math.round((droppedInSynthesis.length / totalDropped) * 100) : 0;
  const pctRevDrop = totalDropped > 0 ? Math.round((droppedInReviewer.length / totalDropped) * 100) : 0;

  console.log(`\n  Of ${totalDropped} claims that did NOT become links:`);
  console.log(`    ${pctSilent}%  silently_filtered (wrong role_tag — reviewer never saw them)`);
  console.log(`    ${pctSynthDrop}%  dropped in synthesis`);
  console.log(`    ${pctRevDrop}%  dropped in reviewer (url/quote/canonical QA)`);
  console.log('');

  if (pctSilent >= 50) {
    console.log('  DOMINANT CAUSE: Synthesis still classifying most lender candidates with');
    console.log('  non-debt, non-unknown role_tags (sponsor, equity, etc.). Reviewer skips them.');
    console.log('  NOTE: unknown is now eligible (Fix 2). Remaining silently-filtered claims');
    console.log('  have explicit non-debt tags. Consider tuning synthesis classification prompt.');
  } else if (pctSynthDrop >= 40) {
    console.log('  DOMINANT CAUSE: Synthesis is dropping claims directly (dropped_by_synthesis).');
    console.log('  Recommended fix: tune synthesis prompt to be less aggressive about dropping.');
    console.log('  → Check A5 samples for synthesis-dropped claims to identify prompt issue.');
  } else if (pctRevDrop >= 40) {
    console.log('  DOMINANT CAUSE: Reviewer is dropping via citation QA (no_source_url, no_quote,');
    console.log('  or canonical_resolution_failed). User hypothesis was CORRECT.');
    console.log('  → Phase C (deep Sonar) recommended to supply clickable evidence URLs.');
  } else {
    console.log('  MIXED causes. Review A1-A5 tables above for guidance.');
  }

  console.log(`\n${'═'.repeat(72)}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
