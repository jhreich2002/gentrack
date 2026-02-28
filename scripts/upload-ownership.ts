/**
 * Upload ownership/PPA data from a CSV file into the Supabase plant_ownership table.
 *
 * Usage:
 *   $env:SUPABASE_URL="https://ohmmtplnaddrfuoowpuq.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="<service_role_key>"
 *   npx tsx scripts/upload-ownership.ts path/to/ownership.csv
 *
 * The CSV must include these headers (column order does not matter):
 *   POWER_PLANT, PLANT_KEY, EIA_SITE_CODE, PLANT_OPERATOR_INSTN_KEY,
 *   OPERATOR_ULT_PARENT, OWNER, OPER_OWN, OWNER_EIA_UTILITY_CODE,
 *   ULT_PARENT, PARENT_EIA_UTILITY_CODE, OWN_STATUS, PLANNED_OWN,
 *   LARGEST_PPA_COUNTERPARTY, LARGEST_PPA_CONTRACTED_CAPACITY,
 *   LARGEST_PPA_CONTRACTED_START_DATE, LARGEST_PPA_CONTRACTED_EXPIRATION_DATE
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// ── Column mapping: CSV header → Supabase column ───────────────────────────
// If your CSV column names change in a future export, update only this map.
const COL_MAP: Record<string, string> = {
  POWER_PLANT:                            'power_plant',
  PLANT_KEY:                              'plant_key',
  EIA_SITE_CODE:                          'eia_site_code',
  TECH_TYPE:                              'tech_type',
  PLANT_OPERATOR:                         'plant_operator',
  PLANT_OPERATOR_INSTN_KEY:               'plant_operator_instn_key',
  OPERATOR_ULT_PARENT:                    'operator_ult_parent',
  OPERATOR_ULT_PARENT_INSTN_KEY:          'operator_ult_parent_instn_key',
  OWNER:                                  'owner',
  OPER_OWN:                               'oper_own',
  OWNER_EIA_UTILITY_CODE:                 'owner_eia_utility_code',
  ULT_PARENT:                             'ult_parent',
  PARENT_EIA_UTILITY_CODE:                'parent_eia_utility_code',
  OWN_STATUS:                             'own_status',
  PLANNED_OWN:                            'planned_own',
  LARGEST_PPA_COUNTERPARTY:               'largest_ppa_counterparty',
  LARGEST_PPA_CONTRACTED_CAPACITY:        'largest_ppa_contracted_capacity',
  LARGEST_PPA_CONTRACTED_START_DATE:      'largest_ppa_contracted_start_date',
  LARGEST_PPA_CONTRACTED_EXPIRATION_DATE: 'largest_ppa_contracted_expiration_date',
};

const NUMERIC_COLS = new Set(['oper_own', 'largest_ppa_contracted_capacity']);
const DATE_COLS    = new Set(['largest_ppa_contracted_start_date', 'largest_ppa_contracted_expiration_date']);
const BATCH_SIZE   = 500;

// ── CSV parser (handles quoted fields, Windows line endings, and junk header rows) ──
function parseCSV(content: string): Record<string, string>[] {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Find the actual header row — the first line that contains EIA_SITE_CODE
  const headerLineIdx = lines.findIndex(l =>
    l.toUpperCase().includes('EIA_SITE_CODE')
  );
  if (headerLineIdx === -1) throw new Error('Could not find a header row containing EIA_SITE_CODE');

  const headers = lines[headerLineIdx]
    .replace(/^\uFEFF/, '') // strip UTF-8 BOM if present
    .split(',')
    .map(h => h.trim().replace(/^"|"$/g, '').toUpperCase());

  console.log(`  Header row found on line ${headerLineIdx + 1}: ${headers.slice(0, 5).join(', ')}...`);

  return lines
    .slice(headerLineIdx + 1)
    .filter(l => l.trim() && !l.split(',').every(v => !v.trim())) // skip blank rows
    .map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
    });
}

// ── Map one CSV row to a Supabase row ───────────────────────────────────────
function toSupabaseRow(raw: Record<string, string>): Record<string, any> | null {
  const row: Record<string, any> = { updated_at: new Date().toISOString() };

  for (const [csvCol, dbCol] of Object.entries(COL_MAP)) {
    const val = raw[csvCol]?.trim() ?? '';

    if (!val) {
      row[dbCol] = null;
    } else if (NUMERIC_COLS.has(dbCol)) {
      const n = parseFloat(val.replace(/[%,\s]/g, ''));
      row[dbCol] = isNaN(n) ? null : n;
    } else if (DATE_COLS.has(dbCol)) {
      const d = new Date(val);
      const yr = d.getFullYear();
      row[dbCol] = isNaN(d.getTime()) || yr < 1900 || yr > 2100 ? null : d.toISOString().split('T')[0];
    } else {
      row[dbCol] = val;
    }
  }

  // Skip rows that have no EIA site code — they can't be joined to plants
  if (!row.eia_site_code) return null;
  return row;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: npx tsx scripts/upload-ownership.ts <path-to-csv>');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as environment variables');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const absPath  = path.resolve(csvPath);

  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(absPath, 'utf-8');
  const rawRows = parseCSV(content);
  console.log(`✓ Parsed ${rawRows.length} rows from ${path.basename(absPath)}`);

  const allRows  = rawRows.map(toSupabaseRow).filter(Boolean) as Record<string, any>[];
  const skipped  = rawRows.length - allRows.length;

  // Deduplicate by eia_site_code — keep last occurrence (most recent ownership record)
  const deduped  = new Map<string, Record<string, any>>();
  for (const row of allRows) deduped.set(row.eia_site_code, row);
  const rows = Array.from(deduped.values());
  const dupes = allRows.length - rows.length;

  console.log(`  Rows to upsert : ${rows.length}`);
  if (skipped > 0) console.log(`  Skipped (no EIA_SITE_CODE): ${skipped}`);
  if (dupes > 0)   console.log(`  Deduped (multiple rows per plant): ${dupes}`);

  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('plant_ownership')
      .upsert(batch, { onConflict: 'eia_site_code' });

    if (error) {
      console.error(`\nUpsert error on batch starting at row ${i}:`, error.message);
      process.exit(1);
    }

    upserted += batch.length;
    process.stdout.write(`\r  Uploading... ${upserted}/${rows.length}`);
  }

  console.log(`\n✓ Done — ${upserted} rows upserted to plant_ownership`);
}

main();
