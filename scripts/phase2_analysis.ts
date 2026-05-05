import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    const val = t.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const [{ data: links }, { data: leads }, { data: plants }] = await Promise.all([
    sb.from('ucc_lender_links').select('lender_name,confidence_class,evidence_type,role_tag,plant_code'),
    sb.from('ucc_lender_leads_unverified').select('lender_name,plant_code'),
    sb.from('ucc_research_plants').select('plant_code,workflow_status,lender_count,top_confidence'),
  ]);

  // Lender frequency: how many distinct plants each lender appears in
  const freq: Record<string, { plants: Set<string>; confidence: string; role_tag: string }> = {};
  for (const l of links ?? []) {
    if (!freq[l.lender_name]) freq[l.lender_name] = { plants: new Set(), confidence: l.confidence_class, role_tag: l.role_tag ?? 'unknown' };
    freq[l.lender_name].plants.add(l.plant_code);
  }
  const topLenders = Object.entries(freq)
    .sort((a, b) => b[1].plants.size - a[1].plants.size)
    .slice(0, 40)
    .map(([name, d]) => ({ name, plant_count: d.plants.size, confidence: d.confidence, role_tag: d.role_tag }));

  // Confidence breakdown
  const confCounts: Record<string, number> = {};
  for (const l of links ?? []) confCounts[l.confidence_class] = (confCounts[l.confidence_class] ?? 0) + 1;

  // Role tag breakdown
  const roleCounts: Record<string, number> = {};
  for (const l of links ?? []) roleCounts[l.role_tag ?? 'unknown'] = (roleCounts[l.role_tag ?? 'unknown'] ?? 0) + 1;

  // Workflow status breakdown
  const statusCounts: Record<string, number> = {};
  for (const p of plants ?? []) statusCounts[p.workflow_status] = (statusCounts[p.workflow_status] ?? 0) + 1;

  // Plants with 2+ lenders (strongest BD signals)
  const multiLender = (plants ?? []).filter(p => (p.lender_count ?? 0) >= 2).length;

  const result = {
    total_links: links?.length ?? 0,
    total_leads_unverified: leads?.length ?? 0,
    total_plants_researched: plants?.length ?? 0,
    plants_with_lender_evidence: (plants ?? []).filter(p => (p.lender_count ?? 0) >= 1).length,
    plants_with_multi_lender: multiLender,
    workflow_status_breakdown: statusCounts,
    confidence_breakdown: confCounts,
    role_tag_breakdown: roleCounts,
    top_lenders_by_plant_count: topLenders,
  };

  fs.writeFileSync('logs/phase2-analysis.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
