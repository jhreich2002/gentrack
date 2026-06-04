import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? process.env.VITE_SUPABASE_SECRET_KEY ?? '';

if (!url || !key) { console.error('Missing SUPABASE_URL or key'); process.exit(1); }

const sb = createClient(url, key, { auth: { persistSession: false } });

async function run() {
  // 1. plant_lender_links new columns
  const { data: pllCols } = await sb.from('information_schema.columns' as any)
    .select('column_name')
    .eq('table_name', 'plant_lender_links')
    .in('column_name', ['validated_at','rejected_at','rejection_reason','is_manual','manual_note']);
  console.log('plant_lender_links new cols:', pllCols?.map((r: any) => r.column_name).sort());

  // 2. lenders_canonical new columns
  const { data: lcCols } = await sb.from('information_schema.columns' as any)
    .select('column_name')
    .eq('table_name', 'lenders_canonical')
    .in('column_name', ['pursuit_label','pursuit_set_at']);
  console.log('lenders_canonical new cols:', lcCols?.map((r: any) => r.column_name).sort());

  // 3. v_lender_validation_queue
  const { data: queue, error: qe } = await sb.from('v_lender_validation_queue').select('*').limit(3);
  console.log('v_lender_validation_queue sample:', queue?.length ?? 0, 'rows', qe?.message ?? '');

  // 4. v_lender_validated_portfolio
  const { data: portfolio, error: pe } = await sb.from('v_lender_validated_portfolio').select('*').limit(3);
  console.log('v_lender_validated_portfolio:', portfolio?.length ?? 0, 'rows', pe?.message ?? '');

  // 5. v_lender_plant_summary
  const { data: summary, error: se } = await sb.from('v_lender_plant_summary').select('*').limit(3);
  console.log('v_lender_plant_summary sample:', summary?.length ?? 0, 'rows', se?.message ?? '');
  if (summary?.[0]) console.log('  sample row validation_state:', (summary[0] as any).validation_state);

  // 6. Queue count (should be ~all lenders with links)
  const { count: qCount } = await sb.from('v_lender_validation_queue').select('*', { count: 'exact', head: true });
  console.log('Total lenders in validation queue:', qCount);
}

run().catch(console.error);
