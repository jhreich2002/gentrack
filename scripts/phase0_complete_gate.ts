/**
 * phase0_complete_gate.ts
 *
 * Diagnostic for the `workflow_status='complete'` gate. For each verified
 * plant code, pulls the latest ucc_agent_run + all its tasks, then computes
 * the same 6 acceptance criteria the supervisor uses (see ucc-supervisor
 * /index.ts:386-441). Output makes it obvious WHICH criterion is blocking
 * each plant and whether reviewer escalated.
 *
 * Output:
 *   - stdout table (one row per plant, one block per worker)
 *   - logs/phase0-complete-gate-<date>.json (machine-readable)
 *
 * Usage:
 *   npx tsx scripts/phase0_complete_gate.ts
 *   npx tsx scripts/phase0_complete_gate.ts 56812 57275
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const env = fs.readFileSync('.env', 'utf8');
const get = (k: string): string => {
  const m = env.match(new RegExp('^' + k + '=(.+)$', 'm'));
  return m ? m[1].trim() : '';
};

const sb = createClient(
  get('VITE_SUPABASE_URL') || get('SUPABASE_URL'),
  get('SUPABASE_SERVICE_ROLE_KEY'),
);

const args  = process.argv.slice(2);
const codes = args.length ? args : ['56812', '57275', '57439', '56857', '58080'];

interface TaskInfo {
  agent_type:           string;
  task_status:          string | null;
  completion_score:     number | null;
  duration_ms:          number | null;
  evidence_found:       boolean | null;
  partial_due_to_budget: boolean | null;
  retry_recommendation: string | null;
  escalate_to_review:   boolean | null;
  structured_count:     number;
}

interface PlantDiag {
  plant_code:      string;
  workflow_status: string | null;
  total_cost_usd:  number | null;
  lender_count:    number | null;
  top_confidence:  string | null;
  links:           number;
  leads:           number;
  run_id:          string | null;
  started_at:      string | null;
  tasks:           TaskInfo[];
  criteria: {
    sponsor_confirmed:           boolean;
    spv_alias_found:             boolean;
    ucc_or_county_searched:      boolean;
    edgar_completed:             boolean;
    reviewer_ran:                boolean;
    confirmed_claims_have_urls:  boolean;
  };
  reviewer_escalated:        boolean;
  reviewer_escalation_reason: string | null;
  any_partial_due_to_budget: boolean;
  workers_with_retry_rec:    string[];
  blocker_class:             string;
  blocker_detail:            string;
}

async function diagnose(code: string): Promise<PlantDiag> {
  const [{ data: research }, { data: links }, { data: leads }] = await Promise.all([
    sb.from('ucc_research_plants')
      .select('workflow_status,total_cost_usd,lender_count,top_confidence')
      .eq('plant_code', code)
      .maybeSingle(),
    sb.from('ucc_lender_links')
      .select('lender_name,confidence_class,evidence_type,source_url')
      .eq('plant_code', code),
    sb.from('ucc_lender_leads_unverified')
      .select('lender_name,lender_entity_id')
      .eq('plant_code', code),
  ]);

  const { data: runs } = await sb.from('ucc_agent_runs')
    .select('id,started_at')
    .eq('plant_code', code)
    .order('started_at', { ascending: false })
    .limit(1);

  const runId = runs?.[0]?.id ?? null;
  const tasks: TaskInfo[] = [];
  let entityScore = 0;
  let spvAliasCount = 0;
  let uccScore = 0, countyScore = 0, edgarScore = 0, reviewerScore = 0;
  let reviewerEscalated = false;
  let reviewerReason: string | null = null;
  let anyPartialBudget = false;
  const retryWorkers: string[] = [];
  let confirmedClaimsHaveUrls = true;

  if (runId) {
    const { data: taskRows } = await sb.from('ucc_agent_tasks')
      .select('agent_type,task_status,completion_score,duration_ms,output_json')
      .eq('run_id', runId);

    for (const t of (taskRows ?? [])) {
      const out = (t.output_json ?? {}) as Record<string, unknown>;
      const evidenceFound       = (out.evidence_found as boolean) ?? null;
      const partialDueToBudget  = (out.partial_due_to_budget as boolean) ?? null;
      const retryRec            = (out.retry_recommendation as string) ?? null;
      const escalate            = (out.escalate_to_review as boolean) ?? null;
      const structured          = (out.structured_results as unknown[]) ?? [];

      tasks.push({
        agent_type:            t.agent_type as string,
        task_status:           t.task_status as string | null,
        completion_score:      t.completion_score as number | null,
        duration_ms:           t.duration_ms as number | null,
        evidence_found:        evidenceFound,
        partial_due_to_budget: partialDueToBudget,
        retry_recommendation:  retryRec,
        escalate_to_review:    escalate,
        structured_count:      Array.isArray(structured) ? structured.length : 0,
      });

      if (partialDueToBudget) anyPartialBudget = true;
      if (retryRec)           retryWorkers.push(t.agent_type as string);

      // agent_type is stored short-form per AGENT_TYPE_MAP in supervisor:
      //   ucc-entity-worker -> entity_worker, etc. Use the latest attempt
      //   for each worker (rows are appended per attempt).
      switch (t.agent_type) {
        case 'entity_worker':
          entityScore = Math.max(entityScore, (t.completion_score as number) ?? 0);
          {
            const aliases = out.spv_aliases as unknown[] | undefined;
            if (Array.isArray(aliases) && aliases.length > spvAliasCount) {
              spvAliasCount = aliases.length;
            }
            // some workers nest aliases under structured_results
            const struct = out.structured_results as unknown[] | undefined;
            if (Array.isArray(struct) && struct.length > spvAliasCount) {
              spvAliasCount = Math.max(spvAliasCount, struct.length);
            }
          }
          break;
        case 'ucc_records_worker':
          uccScore = Math.max(uccScore, (t.completion_score as number) ?? 0);
          break;
        case 'county_worker':
          countyScore = Math.max(countyScore, (t.completion_score as number) ?? 0);
          break;
        case 'edgar_worker':
          edgarScore = Math.max(edgarScore, (t.completion_score as number) ?? 0);
          break;
        case 'reviewer':
          reviewerScore = (t.completion_score as number) ?? 0;
          reviewerEscalated = !!escalate;
          reviewerReason = (out.escalation_reason as string) ?? null;
          for (const c of structured) {
            const cand = c as Record<string, unknown>;
            if (cand.confidence_class === 'confirmed' && !cand.source_url) {
              confirmedClaimsHaveUrls = false;
            }
          }
          break;
      }
    }
  }

  const criteria = {
    sponsor_confirmed:           entityScore >= 60,
    spv_alias_found:             spvAliasCount >= 1,
    ucc_or_county_searched:      uccScore > 0 || countyScore > 0,
    edgar_completed:             edgarScore > 0,
    reviewer_ran:                reviewerScore > 0,
    confirmed_claims_have_urls:  confirmedClaimsHaveUrls,
  };

  // Classify the blocker.
  // Class A — reviewer escalated AND it was driven by a partial_due_to_budget
  //           on a worker that the reviewer itself overrode (gate too strict)
  // Class B — a real acceptance criterion fails (genuine evidence gap)
  // Class C — gate-logic edge case: criteria met, reviewer escalated WITHOUT
  //           partial budget signal (reviewer being conservative)
  // Class D — already complete (sanity check)
  // Class E — lender_count 0 path
  const unmet = Object.entries(criteria).filter(([, v]) => !v).map(([k]) => k);
  const lenderCount = (research?.lender_count as number) ?? 0;
  let blockerClass: string;
  let blockerDetail: string;

  if (research?.workflow_status === 'complete') {
    blockerClass = 'D_already_complete';
    blockerDetail = 'no blocker';
  } else if (unmet.length > 0) {
    blockerClass = 'B_unmet_criterion';
    blockerDetail = `unmet: ${unmet.join(', ')}`;
  } else if (lenderCount === 0) {
    blockerClass = 'E_zero_lenders';
    blockerDetail = 'criteria met but reviewer returned 0 lender candidates';
  } else if (reviewerEscalated && anyPartialBudget) {
    blockerClass = 'A_reviewer_escalated_on_budget_partial';
    blockerDetail = `reviewer escalated; partial_due_to_budget on: ${
      tasks.filter(t => t.partial_due_to_budget).map(t => t.agent_type).join(', ')
    }; reviewer_reason="${reviewerReason ?? ''}"`;
  } else if (reviewerEscalated) {
    blockerClass = 'C_reviewer_escalated_no_budget';
    blockerDetail = `reviewer escalated without budget signal; reason="${reviewerReason ?? ''}"`;
  } else {
    blockerClass = 'unknown';
    blockerDetail = `wf=${research?.workflow_status}, criteria all met, lenderCount=${lenderCount}`;
  }

  return {
    plant_code:                  code,
    workflow_status:             (research?.workflow_status as string) ?? null,
    total_cost_usd:              (research?.total_cost_usd as number) ?? null,
    lender_count:                lenderCount,
    top_confidence:              (research?.top_confidence as string) ?? null,
    links:                       (links ?? []).length,
    leads:                       (leads ?? []).length,
    run_id:                      runId,
    started_at:                  runs?.[0]?.started_at ?? null,
    tasks,
    criteria,
    reviewer_escalated:          reviewerEscalated,
    reviewer_escalation_reason:  reviewerReason,
    any_partial_due_to_budget:   anyPartialBudget,
    workers_with_retry_rec:      retryWorkers,
    blocker_class:               blockerClass,
    blocker_detail:              blockerDetail,
  };
}

function fmtCriteria(c: PlantDiag['criteria']): string {
  return Object.entries(c).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join('  ');
}

async function main(): Promise<void> {
  const diagnostics: PlantDiag[] = [];
  for (const code of codes) {
    diagnostics.push(await diagnose(code));
  }

  // ── Top-line table ──────────────────────────────────────────────────
  console.log('\nplant   | workflow            | links | leads | lend# | top_conf       | esc | budg | blocker_class');
  console.log('--------+---------------------+-------+-------+-------+----------------+-----+------+------------------------------------');
  for (const d of diagnostics) {
    console.log([
      d.plant_code.padEnd(7),
      (d.workflow_status ?? '-').padEnd(19).slice(0, 19),
      String(d.links).padStart(5),
      String(d.leads).padStart(5),
      String(d.lender_count ?? 0).padStart(5),
      (d.top_confidence ?? '-').padEnd(14).slice(0, 14),
      (d.reviewer_escalated ? 'Y' : 'n').padStart(3),
      (d.any_partial_due_to_budget ? 'Y' : 'n').padStart(4),
      d.blocker_class,
    ].join(' | '));
  }

  // ── Per-plant detail ────────────────────────────────────────────────
  for (const d of diagnostics) {
    console.log(`\n── ${d.plant_code}  [${d.blocker_class}] ──`);
    console.log(`  ${d.blocker_detail}`);
    console.log(`  criteria: ${fmtCriteria(d.criteria)}`);
    console.log(`  workers (${d.tasks.length}):`);
    for (const t of d.tasks) {
      const flags: string[] = [];
      if (t.partial_due_to_budget) flags.push('PARTIAL_BUDGET');
      if (t.retry_recommendation)  flags.push(`retry=${t.retry_recommendation}`);
      if (t.escalate_to_review)    flags.push('ESCALATE');
      if (t.evidence_found === false) flags.push('no_evidence');
      console.log(`    ${(t.agent_type ?? '?').padEnd(28)} status=${(t.task_status ?? '?').padEnd(8)} score=${String(t.completion_score ?? 0).padStart(3)} struct=${String(t.structured_count).padStart(2)} dur=${String(t.duration_ms ?? 0).padStart(6)}ms${flags.length ? '  [' + flags.join(', ') + ']' : ''}`);
    }
  }

  // ── Roll-up ─────────────────────────────────────────────────────────
  const byClass: Record<string, string[]> = {};
  for (const d of diagnostics) {
    (byClass[d.blocker_class] ??= []).push(d.plant_code);
  }
  console.log('\n── Blocker-class roll-up ──');
  for (const [cls, plants] of Object.entries(byClass)) {
    console.log(`  ${cls}: ${plants.length} plant(s) — ${plants.join(', ')}`);
  }

  // ── Write JSON artifact ─────────────────────────────────────────────
  const outDir  = path.join(process.cwd(), 'logs');
  fs.mkdirSync(outDir, { recursive: true });
  const date    = new Date().toISOString().slice(0, 10);
  const outPath = path.join(outDir, `phase0-complete-gate-${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    plant_codes:  codes,
    diagnostics,
    by_class:     byClass,
  }, null, 2));
  console.log(`\nWritten: ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
