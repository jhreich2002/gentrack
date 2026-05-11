// scripts/enrich_missing_lead_urls.ts
// Backfill source_url for pending lender leads that currently have no URL.
// Strategy:
// 1) Try lender_evidence_documents for same plant with URL and lender hint in title.
// 2) Try news_articles where plant_codes contains plant and title/description mention lender.
//
// Usage:
//   npx tsx scripts/enrich_missing_lead_urls.ts            # dry-run
//   npx tsx scripts/enrich_missing_lead_urls.ts --apply    # write updates

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (k && !process.env[k]) process.env[k] = v;
  }
}

function lenderNeedles(input: string): string[] {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(bank|na|n a|llc|inc|corp|co|ltd|plc|capital|markets|financial|group|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = base.split(' ').filter(Boolean);
  const out: string[] = [];
  if (base.length >= 4) out.push(base);
  if (words.length >= 2) out.push(words.slice(0, 2).join(' '));
  if (words.length >= 1) out.push(words[0]);
  return [...new Set(out)].filter(s => s.length >= 4);
}

async function main() {
  loadEnv();
  const APPLY = process.argv.includes('--apply');

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  const sb = createClient(url, key);

  const { data: leads, error } = await sb
    .from('ucc_lender_leads_unverified')
    .select('id, plant_code, lender_name, lender_normalized, evidence_type, source_url, lead_status, quarantined_at')
    .eq('lead_status', 'pending')
    .is('quarantined_at', null)
    .is('source_url', null)
    .limit(5000);
  if (error) throw error;

  const rows = leads ?? [];
  console.log(`missing pending leads: ${rows.length}`);

  let resolved = 0;
  let updated = 0;

  for (const r of rows as any[]) {
    const id = Number(r.id);
    const plantCode = String(r.plant_code ?? '');
    const lenderName = String(r.lender_name ?? r.lender_normalized ?? '').trim();
    if (!plantCode || !lenderName) continue;

    const needles = lenderNeedles(lenderName);
    let picked: string | null = null;

    // 1) Search evidence docs for the plant with URL and lender hint in title.
    const { data: docs } = await sb
      .from('lender_evidence_documents')
      .select('url, title, published_at, created_at')
      .eq('plant_code', plantCode)
      .not('url', 'is', null)
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(60);

    for (const d of (docs ?? []) as any[]) {
      const hay = `${String(d.title ?? '').toLowerCase()}`;
      if (needles.some(n => hay.includes(n))) {
        picked = String(d.url);
        break;
      }
    }

    // 2) Search news_articles directly if not found.
    if (!picked) {
      const { data: news } = await sb
        .from('news_articles')
        .select('url, title, description, published_at')
        .contains('plant_codes', [plantCode])
        .not('url', 'is', null)
        .order('published_at', { ascending: false, nullsFirst: false })
        .limit(100);

      for (const n of (news ?? []) as any[]) {
        const hay = `${String(n.title ?? '').toLowerCase()} ${String(n.description ?? '').toLowerCase()}`;
        if (needles.some(s => hay.includes(s))) {
          picked = String(n.url);
          break;
        }
      }
    }

    if (picked) {
      resolved++;
      if (APPLY) {
        const { error: upErr } = await sb
          .from('ucc_lender_leads_unverified')
          .update({ source_url: picked })
          .eq('id', id);
        if (!upErr) updated++;
      }
    }
  }

  console.log(`resolved candidates: ${resolved}`);
  console.log(`updated rows: ${updated}${APPLY ? '' : ' (dry-run)'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
