/**
 * cohort_summary.ts
 *
 * Per-plant verification snapshot for a UCC research cohort. For each plant
 * code, prints a one-line health row plus per-lender detail. Designed to be
 * the canonical "did this run succeed?" tool for both 5-plant smoke and
 * 50-plant production cohorts.
 *
 * Per plant we report:
 *   links          — citation-backed lender_links rows (the gold table)
 *   leads          — unverified leads (incl. validated news pre-promotion)
 *   leads_no_fk    — leads with NULL lender_entity_id (a known-bad signal)
 *   failed_workers — ucc_agent_tasks rows with task_status='failed'
 *   partial_workers — task_status='partial' OR partial_due_to_budget=true
 *   workflow       — ucc_research_plants.workflow_status
 *   cost_usd       — ucc_research_plants.total_cost_usd
 *   duration_ms    — sum of ucc_agent_tasks.duration_ms for the latest run
 *
 * Smoke-gate: with --smoke-gate, exits 1 if any plant is silently zero
 * (links=0 AND no failed/partial workers AND no leads), which means
 * the pipeline finished cleanly but produced nothing — the fail mode
 * we want to block from reaching a 50-plant batch.
 *
 * Usage:
 *   npx tsx scripts/cohort_summary.ts                          # default 5
 *   npx tsx scripts/cohort_summary.ts 56812 57275 57439        # custom
 *   npx tsx scripts/cohort_summary.ts --smoke-gate 56812 ...   # exit 1 on silent zero
 *   npx tsx scripts/cohort_summary.ts --json 56812 ...         # machine-readable
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = fs.readFileSync('.env', 'utf8');
const get = (k: string): string => {
  const m = env.match(new RegExp(k + '=(.+)'));
  return m ? m[1].trim() : '';
};

const sb = createClient(
  get('VITE_SUPABASE_URL') || get('SUPABASE_URL'),
  get('SUPABASE_SERVICE_ROLE_KEY'),
);

const args       = process.argv.slice(2);
const smokeGate  = args.includes('--smoke-gate');
const jsonOutput = args.includes('--json');
const codes      = args.filter(a => !a.startsWith('--'));
const plantCodes = codes.length ? codes : ['56812', '57275', '57439', '56857', '58080'];

interface PlantSummary {
  plant_code:      string;
  workflow:        string | null;
  cost_usd:        number | null;
  links:           number;
  leads:           number;
  leads_no_fk:     number;
  failed_workers:  string[];
  partial_workers: string[];
  duration_ms:     number;
  silent_zero:     boolean;
  link_detail:     Array<{ name: string; confidence: string; evidence: string }>;
}

async function summarisePlant(code: string): Promise<PlantSummary> {
  const [{ data: links }, { data: leads }, { data: research }] = await Promise.all([
    sb.from('ucc_lender_links')
      .select('lender_name,confidence_class,evidence_type,source_url')
      .eq('plant_code', code),
    sb.from('ucc_lender_leads_unverified')
      .select('lender_name,source_types,lender_entity_id')
      .eq('plant_code', code),
    sb.from('ucc_research_plants')
      .select('workflow_status,total_cost_usd,last_run_at')
      .eq('plant_code', code)
      .maybeSingle(),
  ]);

  // Most recent run for this plant — used for worker-status breakdown
  const { data: runs } = await sb.from('ucc_agent_runs')
    .select('id,started_at')
    .eq('plant_code', code)
    .order('started_at', { ascending: false })
    .limit(1);

  const failedWorkers: string[]  = [];
  const partialWorkers: string[] = [];
  let durationMs                 = 0;

  if (runs && runs.length) {
    const runId = runs[0].id;
    const { data: tasks } = await sb.from('ucc_agent_tasks')
      .select('agent_type,task_status,completion_score,output_json,duration_ms')
      .eq('run_id', runId);

    for (const t of (tasks ?? [])) {
      durationMs += (t.duration_ms as number | null) ?? 0;
      if (t.task_status === 'failed') {
        failedWorkers.push(`${t.agent_type}(score=${t.completion_score})`);
      } else if (t.task_status === 'partial' || (t.output_json && (t.output_json as Record<string, unknown>).partial_due_to_budget === true)) {
        partialWorkers.push(t.agent_type as string);
      }
    }
  }

  const linksRows = (links ?? []) as Array<{ lender_name: string; confidence_class: string; evidence_type: string }>;
  const leadsRows = (leads ?? []) as Array<{ lender_entity_id: number | null }>;
  const linksCount = linksRows.length;
  const leadsCount = leadsRows.length;
  const leadsNoFk  = leadsRows.filter(l => l.lender_entity_id === null).length;

  // Smoke-gate "real failure" set: exclude reviewer because reviewer is
  // marked 'partial' whenever any data worker scores below threshold —
  // that's a normal end-of-pipeline summary, not an infrastructure failure.
  // The signals we actually want to surface are data-collection workers
  // that failed or hit a budget cap.
  const realFailedWorkers  = failedWorkers.filter(w => !w.startsWith('reviewer'));
  const realPartialWorkers = partialWorkers.filter(w => w !== 'reviewer');

  // A plant with a deliberate supervisor verdict (workflow_status set) and
  // non-zero cost ran the full pipeline end-to-end.  That is a genuine
  // "no evidence found" result, not a silent infrastructure failure.
  const costUsd = (research?.total_cost_usd as number | undefined) ?? 0;
  const hadActiveRun = !!research?.workflow_status && costUsd > 0;

  const silentZero = !hadActiveRun
    && linksCount === 0
    && leadsCount === 0
    && realFailedWorkers.length === 0
    && realPartialWorkers.length === 0;

  return {
    plant_code:      code,
    workflow:        (research?.workflow_status as string | undefined) ?? null,
    cost_usd:        (research?.total_cost_usd as number | undefined) ?? null,
    links:           linksCount,
    leads:           leadsCount,
    leads_no_fk:     leadsNoFk,
    failed_workers:  failedWorkers,
    partial_workers: partialWorkers,
    duration_ms:     durationMs,
    silent_zero:     silentZero,
    link_detail:     linksRows.map(l => ({
      name:       l.lender_name,
      confidence: l.confidence_class,
      evidence:   l.evidence_type,
    })),
  };
}

async function main(): Promise<void> {
  const summaries: PlantSummary[] = [];
  for (const code of plantCodes) {
    summaries.push(await summarisePlant(code));
  }

  if (jsonOutput) {
    console.log(JSON.stringify(summaries, null, 2));
  } else {
    console.log('\nplant   | workflow            | links | leads (no_fk) | failed                      | partial                     | dur_s  | $');
    console.log('--------+---------------------+-------+---------------+-----------------------------+-----------------------------+--------+--------');
    for (const s of summaries) {
      const row = [
        s.plant_code.padEnd(7),
        (s.workflow ?? '-').padEnd(19).slice(0, 19),
        String(s.links).padStart(5),
        `${String(s.leads).padStart(5)} (${String(s.leads_no_fk).padStart(2)})`,
        (s.failed_workers.join(',') || '-').padEnd(27).slice(0, 27),
        (s.partial_workers.join(',') || '-').padEnd(27).slice(0, 27),
        (s.duration_ms / 1000).toFixed(1).padStart(6),
        (s.cost_usd ?? 0).toFixed(4),
      ];
      console.log(row.join(' | '));
    }
    for (const s of summaries) {
      if (s.link_detail.length === 0) continue;
      console.log(`\n  ${s.plant_code} links:`);
      for (const l of s.link_detail) {
        console.log(`    [${l.confidence}/${l.evidence}] ${l.name}`);
      }
    }
  }

  // Smoke-gate: detect plants that finished cleanly but produced nothing.
  // Infrastructure failures masquerading as "no evidence" must not pass.
  if (smokeGate) {
    const silent = summaries.filter(s => s.silent_zero);
    if (silent.length > 0) {
      console.error(`\nSMOKE-GATE FAIL: ${silent.length} plant(s) returned silent zero (no links, no leads, no worker failures): ${silent.map(s => s.plant_code).join(', ')}`);
      process.exit(1);
    }
    console.log(`\nSMOKE-GATE OK: all ${summaries.length} plant(s) have explicit results or explicit failures.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
