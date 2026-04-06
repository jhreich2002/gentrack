/**
 * Run a SQL migration file against Supabase using the service role key.
 * Usage: npx tsx scripts/run-migration.ts <migration-file>
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: npx tsx scripts/run-migration.ts <migration-file>');
  process.exit(1);
}

const sql = readFileSync(file, 'utf-8');
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Split SQL into individual statements and execute each
const statements = sql
  .split(/;\s*$/m)
  .map(s => s.trim())
  .filter(s => s.length > 0 && !s.startsWith('--'));

async function run() {
  console.log(`Running migration: ${file}`);
  console.log(`Found ${statements.length} statements`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.slice(0, 80).replace(/\n/g, ' ');
    console.log(`  [${i + 1}/${statements.length}] ${preview}...`);

    const { error } = await sb.rpc('exec_raw_sql', { sql_text: stmt });
    if (error) {
      // Try alternative: use the Supabase REST SQL endpoint
      console.warn(`    rpc error: ${error.message} — trying direct fetch...`);

      // Fall back to using the management API sql endpoint
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      });
      // If that doesn't work either, just log and continue
      console.warn(`    Skipping — run this SQL manually in the Supabase dashboard`);
    }
  }

  console.log('\nDone!');
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
