/**
 * apply-migrations.ts
 *
 * Applies specific SQL migration files directly via the Supabase SQL REST API.
 * Use when supabase db push --include-all fails due to migration history conflicts.
 *
 * Usage:
 *   npx tsx scripts/apply-migrations.ts 20260429_pipeline_v2 20260429_ucc_research_queue
 */

import fs   from 'fs';
import path from 'path';

function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
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
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

const migrationNames = process.argv.slice(2);
if (!migrationNames.length) {
  console.error('Usage: npx tsx scripts/apply-migrations.ts <migration-name-without-sql> ...');
  process.exit(1);
}

async function executeSql(sql: string): Promise<void> {
  // Use the pg REST endpoint exposed by Supabase for direct SQL execution
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/exec_sql`;

  // Try the Management API approach — POST to the SQL endpoint
  const mgmtUrl = SUPABASE_URL.replace('https://', 'https://api.supabase.com/v1/projects/')
    .replace('.supabase.co', '') + '/database/query';

  // Fall back to executing via a small edge function if available,
  // otherwise use the Supabase anon/service SQL REST approach
  const restUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/`;

  // The most reliable method for direct SQL with service role: POST to /rpc
  // using a custom SQL execution function, or POST to the Postgres REST directly.
  // Supabase exposes /pg endpoint on newer projects; use raw fetch with service key.
  const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'apikey':        SERVICE_KEY,
    },
    body: JSON.stringify({ query: sql }),
  });

  if (resp.ok) return;

  const body = await resp.text();
  // exec_sql RPC may not exist — use the Supabase Management API instead
  if (resp.status === 404 || body.includes('Could not find')) {
    throw new Error('exec_sql RPC not found — apply SQL via Supabase dashboard SQL editor');
  }
  throw new Error(`SQL execution failed ${resp.status}: ${body.slice(0, 500)}`);
}

async function run(): Promise<void> {
  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');

  for (const name of migrationNames) {
    // Accept with or without .sql extension
    const filename = name.endsWith('.sql') ? name : `${name}.sql`;

    // Find the file (may have a date prefix)
    const allFiles = fs.readdirSync(migrationsDir);
    const match    = allFiles.find(f => f === filename || f.endsWith(`_${filename}`) || f.endsWith(`/${filename}`));

    if (!match) {
      // Try partial match
      const partial = allFiles.find(f => f.includes(name.replace('.sql', '')));
      if (!partial) {
        console.error(`✗ Migration not found: ${filename}`);
        process.exit(1);
      }
      console.log(`  Matched: ${partial}`);
    }

    const file = path.join(migrationsDir, match ?? allFiles.find(f => f.includes(name.replace('.sql', '')))!);
    const sql  = fs.readFileSync(file, 'utf8');

    console.log(`Applying ${path.basename(file)}...`);
    try {
      await executeSql(sql);
      console.log(`  ✓ Applied`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('dashboard')) {
        // Print the SQL for manual application
        console.log(`\n  ⚠  Could not apply automatically. Copy-paste this SQL into the Supabase SQL editor:\n`);
        console.log('─'.repeat(60));
        console.log(sql);
        console.log('─'.repeat(60));
      } else {
        console.error(`  ✗ Error: ${msg}`);
        process.exit(1);
      }
    }
  }
}

run().catch(err => { console.error(err); process.exit(1); });
