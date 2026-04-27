/**
 * GenTrack — ucc-test-runner Edge Function (Deno)
 *
 * Evaluates the UCC lender research pipeline against a ground-truth benchmark.
 * Designed to run after the pipeline has processed a set of known plants so
 * we can measure precision and recall before surfacing results for outreach.
 *
 * Release gate: confirmed_precision ≥ 80% on the test dataset.
 *
 * POST body:
 *   { run_ids?: string[], plant_codes?: string[] }
 *   (omit both to run against all ucc_test_cases)
 *
 * Returns:
 *   { precision, recall, false_positive_rate, llm_fallback_rate,
 *     source_trace_completeness, human_review_rate, test_results[] }
 *
 * Required secrets:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

interface TestCase {
  id:                   number;
  plant_code:           string;
  expected_lender:      string;
  expected_confidence:  string;
  benchmark_status:     string;
  ground_truth_source:  string | null;
}

interface TestResult {
  test_case_id:     number;
  plant_code:       string;
  expected_lender:  string;
  benchmark_set:    'gold_external' | 'seeded_internal';
  found:            boolean;
  found_confidence: string | null;
  matched_name:     string | null;
  passed:           boolean;
  precision_flag:   boolean;
  recall_flag:      boolean;
  notes:            string;
}

interface SetMetrics {
  total:               number;
  true_positives:      number;
  false_positives:     number;
  false_negatives:     number;
  precision:           number;
  recall:              number;
}

interface EvalMetrics {
  confirmed_precision:      number;
  confirmed_recall:         number;
  false_positive_rate:      number;
  llm_fallback_rate:        number;
  source_trace_completeness:number;
  human_review_rate:        number;
  total_test_cases:         number;
  passed:                   number;
  failed:                   number;
  release_gate_passed:      boolean;
  release_gate_basis:       'gold_external' | 'seeded_internal' | 'none';
  by_benchmark_set:         { gold_external: SetMetrics; seeded_internal: SetMetrics };
  test_results:             TestResult[];
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|lp|inc|corp|co|ltd|na|n\.a\.|plc|bank|national|association|trust|capital|financial)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyMatch(expected: string, actual: string): boolean {
  const a = normalizeName(expected);
  const b = normalizeName(actual);
  if (a === b) return true;

  // Check if key tokens overlap (≥ 60% of expected tokens present in actual)
  const tokensA = a.split(' ').filter(t => t.length > 2);
  const tokensB = b.split(' ').filter(t => t.length > 2);
  if (!tokensA.length) return false;
  const matched = tokensA.filter(t => tokensB.some(b2 => b2.includes(t) || t.includes(b2)));
  return matched.length / tokensA.length >= 0.6;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 });

  try {
    const { run_ids, plant_codes }: {
      run_ids?:     string[];
      plant_codes?: string[];
    } = await req.json().catch(() => ({}));

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Load test cases ────────────────────────────────────────────────
    let caseQuery = supabase
      .from('ucc_test_cases')
      .select('id, plant_code, expected_lender, expected_confidence, benchmark_status, ground_truth_source')
      .eq('benchmark_status', 'active');

    if (plant_codes?.length) {
      caseQuery = caseQuery.in('plant_code', plant_codes);
    }

    const { data: cases, error: casesErr } = await caseQuery;
    if (casesErr) throw casesErr;
    if (!cases?.length) {
      return new Response(JSON.stringify({ error: 'No test cases found' }), { status: 404, headers: CORS });
    }

    const testCases: TestCase[] = cases as TestCase[];
    const testPlantCodes = [...new Set(testCases.map(c => c.plant_code))];

    // ── Load pipeline results for test plants ──────────────────────────
    let linksQuery = supabase
      .from('ucc_lender_links')
      .select(`
        plant_code, confidence_class, evidence_type, source_url,
        ucc_entities!lender_entity_id (entity_name, normalized_name)
      `)
      .in('plant_code', testPlantCodes);

    if (run_ids?.length) {
      linksQuery = linksQuery.in('run_id', run_ids);
    }

    const { data: links } = await linksQuery;

    // Load agent tasks for llm_fallback_rate and review rate
    const { data: tasks } = await supabase
      .from('ucc_agent_tasks')
      .select('plant_code, llm_fallback_used, task_status')
      .in('plant_code', testPlantCodes);

    // ── Build lookup: plant_code → lender links ────────────────────────
    const linksByPlant = new Map<string, Array<{ lender_name: string; confidence_class: string; source_url: string | null }>>();
    for (const link of (links ?? []) as Array<Record<string, unknown>>) {
      const entity = (link.ucc_entities as Record<string, unknown>) ?? {};
      const pc     = String(link.plant_code ?? '');
      const existing = linksByPlant.get(pc) ?? [];
      existing.push({
        lender_name:      String(entity.entity_name ?? ''),
        confidence_class: String(link.confidence_class ?? ''),
        source_url:       link.source_url ? String(link.source_url) : null,
      });
      linksByPlant.set(pc, existing);
    }

    // ── Evaluate each test case ────────────────────────────────────────
    const results: TestResult[] = [];
    let truePositives  = 0;
    let falsePositives = 0;
    let falseNegatives = 0;

    // Per-set tallies for the split metrics
    const setTally: Record<'gold_external' | 'seeded_internal', { tp: number; fp: number; fn: number; total: number }> = {
      gold_external:   { tp: 0, fp: 0, fn: 0, total: 0 },
      seeded_internal: { tp: 0, fp: 0, fn: 0, total: 0 },
    };

    for (const tc of testCases) {
      // Anything seeded from the existing plant_lenders pipeline is self-referential.
      // Everything else is treated as a curated external/gold case.
      const benchmarkSet: 'gold_external' | 'seeded_internal' =
        (tc.ground_truth_source ?? '') === 'plant_lenders' ? 'seeded_internal' : 'gold_external';
      setTally[benchmarkSet].total++;

      const plantLinks = linksByPlant.get(tc.plant_code) ?? [];
      const match = plantLinks.find(l => fuzzyMatch(tc.expected_lender, l.lender_name));

      const found           = !!match;
      const foundConfidence = match?.confidence_class ?? null;
      const hasSourceUrl    = match?.source_url ? true : false;

      // Precision flag: we found something, but was it correct?
      // Recall flag: ground truth says there's a lender here, did we find it?
      const precisionFlag = found; // found = true means we made a claim
      const recallFlag    = found; // found = true means we recalled the expected lender

      const passed = found && (
        tc.expected_confidence === 'confirmed' ? foundConfidence === 'confirmed'
        : tc.expected_confidence === 'highly_likely' ? ['confirmed', 'highly_likely'].includes(foundConfidence ?? '')
        : true // possible — any match passes
      );

      if (found && passed)  { truePositives++;  setTally[benchmarkSet].tp++; }
      if (found && !passed) { falsePositives++; setTally[benchmarkSet].fp++; }
      if (!found)           { falseNegatives++; setTally[benchmarkSet].fn++; }

      const notes: string[] = [];
      if (!found) notes.push(`Expected "${tc.expected_lender}" — not found in pipeline output`);
      else if (!passed) notes.push(`Found "${match!.lender_name}" but confidence ${foundConfidence} < expected ${tc.expected_confidence}`);
      if (found && !hasSourceUrl) notes.push('No source URL for confirmed claim');

      results.push({
        test_case_id:     tc.id,
        plant_code:       tc.plant_code,
        expected_lender:  tc.expected_lender,
        benchmark_set:    benchmarkSet,
        found,
        found_confidence: foundConfidence,
        matched_name:     match?.lender_name ?? null,
        passed,
        precision_flag:   precisionFlag,
        recall_flag:      recallFlag,
        notes:            notes.join('; '),
      });

      // Write result to DB
      await supabase.from('ucc_test_results').upsert({
        test_case_id:   tc.id,
        run_id:         run_ids?.[0] ?? null,
        passed,
        precision_flag: precisionFlag,
        recall_flag:    recallFlag,
        notes:          notes.join('; '),
      }, { onConflict: 'test_case_id,run_id', ignoreDuplicates: false });
    }

    // ── Compute metrics ────────────────────────────────────────────────
    const total = testCases.length;

    const confirmedPrecision =
      truePositives + falsePositives > 0
        ? truePositives / (truePositives + falsePositives)
        : 0;

    const confirmedRecall =
      truePositives + falseNegatives > 0
        ? truePositives / (truePositives + falseNegatives)
        : 0;

    const falsePosRate = falsePositives / Math.max(total, 1);

    // LLM fallback rate: % of plant-worker combinations where LLM was used
    const taskArr = (tasks ?? []) as Array<{ llm_fallback_used: boolean; task_status: string }>;
    const llmFallbackRate = taskArr.length > 0
      ? taskArr.filter(t => t.llm_fallback_used).length / taskArr.length
      : 0;

    // Source trace completeness: % of confirmed claims that have a source URL
    const confirmedLinks = (links ?? []).filter((l: Record<string, unknown>) => l.confidence_class === 'confirmed');
    const sourceTraceCompleteness = confirmedLinks.length > 0
      ? confirmedLinks.filter((l: Record<string, unknown>) => l.source_url).length / confirmedLinks.length
      : 1;

    // Human review rate: % of plants that were escalated to review
    const { data: reviewPlants } = await supabase
      .from('ucc_research_plants')
      .select('workflow_status')
      .in('plant_code', testPlantCodes);

    const humanReviewRate = (reviewPlants ?? []).length > 0
      ? (reviewPlants ?? []).filter((p: Record<string, unknown>) => p.workflow_status === 'needs_review').length / (reviewPlants ?? []).length
      : 0;

    const releaseGatePassed = confirmedPrecision >= 0.80;

    // Compute split metrics & decide release gate basis.
    // Prefer the external/gold set when it has cases; fall back to seeded.
    const buildSet = (t: { tp: number; fp: number; fn: number; total: number }): SetMetrics => ({
      total:           t.total,
      true_positives:  t.tp,
      false_positives: t.fp,
      false_negatives: t.fn,
      precision: t.tp + t.fp > 0 ? Math.round((t.tp / (t.tp + t.fp)) * 1000) / 10 : 0,
      recall:    t.tp + t.fn > 0 ? Math.round((t.tp / (t.tp + t.fn)) * 1000) / 10 : 0,
    });
    const setExternal = buildSet(setTally.gold_external);
    const setSeeded   = buildSet(setTally.seeded_internal);

    let gateBasis: 'gold_external' | 'seeded_internal' | 'none' = 'none';
    let gatePassed = releaseGatePassed;
    if (setTally.gold_external.total > 0) {
      gateBasis  = 'gold_external';
      gatePassed = setExternal.precision >= 80;
    } else if (setTally.seeded_internal.total > 0) {
      gateBasis  = 'seeded_internal';
      gatePassed = setSeeded.precision >= 80;
    }

    const metrics: EvalMetrics = {
      confirmed_precision:       Math.round(confirmedPrecision * 1000) / 10,
      confirmed_recall:          Math.round(confirmedRecall    * 1000) / 10,
      false_positive_rate:       Math.round(falsePosRate       * 1000) / 10,
      llm_fallback_rate:         Math.round(llmFallbackRate    * 1000) / 10,
      source_trace_completeness: Math.round(sourceTraceCompleteness * 1000) / 10,
      human_review_rate:         Math.round(humanReviewRate    * 1000) / 10,
      total_test_cases:          total,
      passed:                    results.filter(r => r.passed).length,
      failed:                    results.filter(r => !r.passed).length,
      release_gate_passed:       gatePassed,
      release_gate_basis:        gateBasis,
      by_benchmark_set:          { gold_external: setExternal, seeded_internal: setSeeded },
      test_results:              results,
    };

    console.log(`[TEST] precision=${metrics.confirmed_precision}% basis=${gateBasis} ext=${setExternal.precision}% int=${setSeeded.precision}% gate=${gatePassed}`);

    return new Response(JSON.stringify(metrics), { headers: CORS });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: CORS });
  }
});
