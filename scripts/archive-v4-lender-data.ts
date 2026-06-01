import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

function requireAnyEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Missing required env vars: ${names.join(', ')}`);
}

function csvEscape(value: unknown): string {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const out = [headers.join(',')];
  for (const row of rows) {
    out.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return `${out.join('\n')}\n`;
}

async function exportQuery(
  supabase: ReturnType<typeof createClient>,
  filename: string,
  table: string,
  selectExpr = '*',
  filter?: (query: any) => any,
  outDir?: string,
) {
  let query = supabase.from(table).select(selectExpr);
  if (filter) query = filter(query);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];
  await fs.writeFile(path.join(outDir!, filename), toCsv(rows), 'utf8');
  console.log(`${filename}: ${rows.length} rows`);
}

async function main() {
  const supabaseUrl = requireAnyEnv(['SUPABASE_URL', 'VITE_SUPABASE_URL']);
  const serviceRole = requireAnyEnv([
    'SUPABASE_SECRET_KEY',
    'VITE_SUPABASE_SECRET_KEY',
    'VITE_SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outDir = path.join(process.cwd(), 'data', `v4-archive-${stamp}`);
  await fs.mkdir(outDir, { recursive: true });

  await exportQuery(supabase, 'validated_links.csv', 'lender_links', '*', (q) => q.eq('lead_status', 'validated'), outDir);
  await exportQuery(supabase, 'pursuits.csv', 'lender_pursuits', '*', undefined, outDir);
  await exportQuery(supabase, 'manual_claims.csv', 'lender_research_claims', '*', (q) => q.eq('source_agent', 'manual'), outDir);
  await exportQuery(supabase, 'canonical_seed.csv', 'lenders_canonical', 'id, canonical_name, normalized_name', undefined, outDir);

  console.log(`Archive complete: ${outDir}`);
}

main().catch((err) => {
  console.error('archive-v4-lender-data failed:', err);
  process.exit(1);
});
