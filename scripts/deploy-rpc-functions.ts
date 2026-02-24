/**
 * Deploys the Supabase RPC functions needed for regional trend lines.
 * Usage:
 *   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."  # Your personal access token
 *   npx tsx scripts/deploy-rpc-functions.ts
 *
 * Get your personal access token at: https://supabase.com/dashboard/account/tokens
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROJECT_REF = 'ohmmtplnaddrfuoowpuq';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  // Fall back to trying with the service role key via the Supabase SQL API
  console.log('\nINFO: SUPABASE_ACCESS_TOKEN not set.');
  console.log('Please run the SQL manually in the Supabase dashboard:');
  console.log(`  https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new`);
  console.log('\nCopy the contents of: scripts/create-rpc-functions.sql');
  process.exit(0);
}

const sqlPath = join(__dirname, 'create-rpc-functions.sql');
const sql = readFileSync(sqlPath, 'utf-8');

async function deploy() {
  console.log('Deploying RPC functions to Supabase...');

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('❌ Failed:', res.status, JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log('✅ RPC functions deployed successfully!');
  console.log('   • get_regional_trend(region, fuel_source)');
  console.log('   • get_subregional_trend(region, sub_region, fuel_source)');
}

deploy().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
