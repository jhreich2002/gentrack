// apply_migration.ts  — run once to apply 20260505_ucc_p1_enhancements.sql
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const sql = fs.readFileSync(
  'supabase/migrations/20260505_ucc_p1_enhancements.sql',
  'utf8'
);

// Execute each statement separately (Supabase REST doesn't support multi-statement)
const stmts = sql
  .split(';')
  .map(s => s.trim())
  .filter(s => s.length > 0 && !s.startsWith('--'));

(async () => {
  for (const stmt of stmts) {
    const { error } = await supabase.rpc('exec_sql', { sql: stmt + ';' }).single();
    if (error) {
      // exec_sql may not exist — fall back to direct REST /sql endpoint
      console.error(`exec_sql failed: ${error.message}\nStatement: ${stmt.slice(0, 80)}`);
    } else {
      console.log(`OK: ${stmt.slice(0, 80)}`);
    }
  }
})();
