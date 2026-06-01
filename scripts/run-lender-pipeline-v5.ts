import { createClient } from '@supabase/supabase-js';

function requireAnyEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Missing required env vars: ${names.join(', ')}`);
}

function parseArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

async function main() {
  const supabaseUrl = requireAnyEnv(['SUPABASE_URL', 'VITE_SUPABASE_URL']);
  const serviceRole = requireAnyEnv([
    'SUPABASE_SECRET_KEY',
    'VITE_SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'VITE_SUPABASE_SERVICE_ROLE_KEY',
  ]);
  const internalAuthToken = requireAnyEnv(['INTERNAL_AUTH_TOKEN', 'VITE_INTERNAL_AUTH_TOKEN']);

  const concurrency = Number(parseArg('concurrency', '3'));
  const maxCost = Number(parseArg('max-cost', '50'));
  const force = parseArg('force', 'false') === 'true';

  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const plantsRes = await supabase
    .from('plants')
    .select('id, eia_plant_code, name')
    .eq('is_likely_curtailed', true)
    .order('nameplate_capacity_mw', { ascending: false });

  if (plantsRes.error) throw plantsRes.error;
  const plants = plantsRes.data ?? [];

  let totalCost = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < plants.length) {
      const idx = cursor++;
      const plant = plants[idx];
      if (totalCost >= maxCost) return;

      const invoked = await supabase.functions.invoke('lender-research-sonar', {
        body: { plant_id: plant.id, force },
        headers: { Authorization: `Bearer ${internalAuthToken}` },
      });

      if (invoked.error) {
        console.error(`[${idx + 1}/${plants.length}] ${plant.id}: ERROR ${invoked.error.message}`);
        continue;
      }

      const cost = Number((invoked.data as any)?.cost_usd ?? 0);
      totalCost += cost;
      console.log(`[${idx + 1}/${plants.length}] ${plant.id}: status=${(invoked.data as any)?.status ?? 'unknown'} cost=$${cost.toFixed(4)} cumulative=$${totalCost.toFixed(2)}`);

      if (totalCost >= maxCost) {
        console.warn(`Reached max-cost budget ($${maxCost.toFixed(2)}). Stopping.`);
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  console.log(`Done. plants=${plants.length} totalCost=$${totalCost.toFixed(2)}`);
}

main().catch((err) => {
  console.error('run-lender-pipeline-v5 failed:', err);
  process.exit(1);
});
