import { supabase } from './supabaseClient';
import type {
  LenderValidatedDigest,
  LenderDigestKpis,
  LenderDigestCfPoint,
  DigestPlantRow,
  AdminLenderDigestRow,
  DigestTriggerResult,
} from '../types';

// ────────────────────────────────────────────────────────────────────────────
// fetchLenderValidatedDigest
// Calls the get_lender_validated_digest RPC, maps snake_case → camelCase,
// fetches articles overlapping validated plant EIA codes.
// Returns null if no digest has been generated yet.
// ────────────────────────────────────────────────────────────────────────────

export async function fetchLenderValidatedDigest(lenderId: string): Promise<{
  digest: LenderValidatedDigest;
  plants: DigestPlantRow[];
  articles: any[];
} | null> {
  const { data: raw, error } = await supabase.rpc('get_lender_validated_digest', {
    p_lender_id: lenderId,
  });

  if (error) throw new Error(error.message);
  if (!raw) return null;

  const r = raw as Record<string, unknown>;
  const kpisRaw = (r.kpis ?? {}) as Record<string, unknown>;

  // Per-plant snapshot stored inside kpis.plants[]
  const plantsRaw: any[] = Array.isArray(kpisRaw.plants) ? kpisRaw.plants : [];

  const plants: DigestPlantRow[] = plantsRaw.map((p: Record<string, unknown>) => ({
    plantId:              String(p.plantId ?? p.plant_id ?? ''),
    eiaPlantCode:         String(p.eiaPlantCode ?? p.eia_plant_code ?? ''),
    plantName:            String(p.plantName ?? p.plant_name ?? ''),
    state:                p.state ? String(p.state) : null,
    fuelSource:           String(p.fuelSource ?? p.fuel_source ?? ''),
    nameplateMw:          p.nameplateMw != null ? Number(p.nameplateMw) : (p.nameplate_mw != null ? Number(p.nameplate_mw) : null),
    role:                 p.role ? String(p.role) : null,
    cod:                  p.cod ? String(p.cod) : null,
    ttmCf:                p.ttmCf != null ? Number(p.ttmCf) : (p.ttm_cf != null ? Number(p.ttm_cf) : null),
    regionalCf:           p.regionalCf != null ? Number(p.regionalCf) : (p.regional_cf != null ? Number(p.regional_cf) : null),
    cfDeltaPp:            p.cfDeltaPp != null ? Number(p.cfDeltaPp) : (p.cf_delta_pp != null ? Number(p.cf_delta_pp) : null),
    newsRiskScore:        p.newsRiskScore != null ? Number(p.newsRiskScore) : null,
    distressScore:        p.distressScore != null ? Number(p.distressScore) : (p.distress_score != null ? Number(p.distress_score) : null),
    validatedAt:          p.validatedAt ? String(p.validatedAt) : (p.validated_at ? String(p.validated_at) : null),
    lat:                  p.lat != null ? Number(p.lat) : null,
    lng:                  p.lng != null ? Number(p.lng) : null,
    // Outreach priority (may be absent in older cached digests → keep optional)
    evidenceArticleDate:  p.evidenceArticleDate ? String(p.evidenceArticleDate) : null,
    evidenceAgeYears:     p.evidenceAgeYears != null ? Number(p.evidenceAgeYears) : null,
    expectedTenorYears:   p.expectedTenorYears != null ? Number(p.expectedTenorYears) : null,
    loanLikelyActivePct:  p.loanLikelyActivePct != null ? Number(p.loanLikelyActivePct) : null,
    recentNewsCount:      p.recentNewsCount != null ? Number(p.recentNewsCount) : null,
    priorityScore:        p.priorityScore != null ? Number(p.priorityScore) : null,
    priorityBand:         p.priorityBand ? String(p.priorityBand) as any : null,
    aiPriorityBand:       p.aiPriorityBand ? String(p.aiPriorityBand) as any : null,
    aiPriorityReason:     p.aiPriorityReason ? String(p.aiPriorityReason) : null,
  }));

  const kpis: LenderDigestKpis = {
    totalMw:              kpisRaw.totalMw != null ? Number(kpisRaw.totalMw) : 0,
    plantCount:           kpisRaw.plantCount != null ? Number(kpisRaw.plantCount) : 0,
    weightedTtmCf:        kpisRaw.weightedTtmCf != null ? Number(kpisRaw.weightedTtmCf) : null,
    blendedRegionalTtmCf: kpisRaw.blendedRegionalTtmCf != null ? Number(kpisRaw.blendedRegionalTtmCf) : null,
    cfDeltaPp:            kpisRaw.cfDeltaPp != null ? Number(kpisRaw.cfDeltaPp) : null,
    avgNewsRisk:          kpisRaw.avgNewsRisk != null ? Number(kpisRaw.avgNewsRisk) : null,
    avgDistressScore:     kpisRaw.avgDistressScore != null ? Number(kpisRaw.avgDistressScore) : null,
    activeLoanCount:      kpisRaw.activeLoanCount != null ? Number(kpisRaw.activeLoanCount) : 0,
    curtailedCount:       kpisRaw.curtailedCount != null ? Number(kpisRaw.curtailedCount) : 0,
  };

  const cfSeries: LenderDigestCfPoint[] = Array.isArray(r.cf_series)
    ? (r.cf_series as any[]).map((row: Record<string, unknown>) => ({
        month:              String(row.month),
        portfolioCf:        row.portfolio_cf != null ? Number(row.portfolio_cf) : null,
        blendedRegionalCf:  row.blended_regional_cf != null ? Number(row.blended_regional_cf) : null,
      }))
    : [];

  const digest: LenderValidatedDigest = {
    lenderId:             String(r.lender_id ?? lenderId),
    lenderName:           String(r.lender_name ?? ''),
    pursuitLabel:         r.pursuit_label ? String(r.pursuit_label) as any : null,
    kpis,
    cfSeries,
    aiEngagementThesis:   r.ai_engagement_thesis ? String(r.ai_engagement_thesis) : null,
    aiPortfolioHealth:    r.ai_portfolio_health ? String(r.ai_portfolio_health) : null,
    aiPitchBullets:       Array.isArray(r.ai_pitch_bullets) ? (r.ai_pitch_bullets as any[]).map(String) : [],
    aiRiskBullets:        Array.isArray(r.ai_risk_bullets)  ? (r.ai_risk_bullets  as any[]).map(String) : [],
    plantCount:           r.plant_count != null ? Number(r.plant_count) : 0,
    totalMw:              r.total_mw    != null ? Number(r.total_mw)    : 0,
    costUsd:              r.cost_usd    != null ? Number(r.cost_usd)    : null,
    modelUsed:            r.model_used  ? String(r.model_used) : null,
    generatedAt:          r.generated_at ? String(r.generated_at) : null,
  };

  // Fetch articles whose plant_codes overlap the validated EIA codes
  const eiaCodes = plants.map((p) => p.eiaPlantCode).filter(Boolean);
  let articles: any[] = [];
  if (eiaCodes.length > 0) {
    const { data: artData } = await supabase
      .from('news_articles')
      .select('id, title, description, published_at, sentiment_label, relevance_score, entity_company_names, lenders, article_summary, plant_codes')
      .overlaps('plant_codes', eiaCodes)
      .order('relevance_score', { ascending: false, nullsFirst: false })
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(25);
    articles = (artData ?? []) as any[];
  }

  return { digest, plants, articles };
}

// ────────────────────────────────────────────────────────────────────────────
// triggerLenderValidatedDigest
// Gate RPC → if proceed → Edge Function invocation.
// Mirrors triggerPlantResearch in lenderResearchService.ts exactly.
// ────────────────────────────────────────────────────────────────────────────

export async function triggerLenderValidatedDigest(
  lenderId: string,
  force: boolean,
): Promise<DigestTriggerResult> {
  const gate = await supabase.rpc('trigger_lender_validated_digest', {
    p_lender_id: lenderId,
    p_force: force,
  });

  if (gate.error) {
    return { ok: false, error: gate.error.message };
  }

  const gateData = (gate.data ?? {}) as Record<string, unknown>;
  if (gateData.skipped === true) {
    return {
      ok: true,
      skipped: true,
      reason: String(gateData.reason ?? 'recent_run'),
    };
  }

  const invoked = await supabase.functions.invoke('lender-validated-digest', {
    body: { lender_id: lenderId, force },
  });

  if (invoked.error || !invoked.data) {
    return { ok: false, error: invoked.error?.message ?? 'Function invocation failed' };
  }

  const out = invoked.data as Record<string, unknown>;
  if (!out.ok) {
    return { ok: false, error: String(out.error ?? 'Unknown error') };
  }

  return {
    ok: true,
    skipped: false,
    plantCount: out.plant_count != null ? Number(out.plant_count) : undefined,
    totalMw:    out.total_mw    != null ? Number(out.total_mw)    : undefined,
    costUsd:    out.cost_usd    != null ? Number(out.cost_usd)    : undefined,
    modelUsed:  out.model_used  ? String(out.model_used) : undefined,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// fetchAdminLenderDigestList
// Queries v_admin_lender_digest_state; optional client-side name filter.
// ────────────────────────────────────────────────────────────────────────────

export async function fetchAdminLenderDigestList(search?: string): Promise<AdminLenderDigestRow[]> {
  const { data, error } = await supabase
    .from('v_admin_lender_digest_state')
    .select('*')
    .order('validated_plant_count', { ascending: false, nullsFirst: false });

  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as any[]);

  const lower = search ? search.toLowerCase().trim() : '';

  return rows
    .filter((r: any) => !lower || String(r.lender_name ?? '').toLowerCase().includes(lower))
    .map((r: any): AdminLenderDigestRow => ({
      lenderId:           String(r.lender_id),
      lenderName:         String(r.lender_name ?? ''),
      validatedPlantCount: r.validated_plant_count != null ? Number(r.validated_plant_count) : 0,
      pursuitLabel:       r.pursuit_label ? String(r.pursuit_label) as any : null,
      lastDigestAt:       r.last_digest_at ? String(r.last_digest_at) : null,
      lastDigestCostUsd:  r.last_digest_cost_usd != null ? Number(r.last_digest_cost_usd) : null,
      modelUsed:          r.model_used ? String(r.model_used) : null,
      digestPlantCount:   r.digest_plant_count != null ? Number(r.digest_plant_count) : null,
      digestAgeDays:      r.digest_age_days != null ? Number(r.digest_age_days) : null,
      isStale:            Boolean(r.is_stale),
    }));
}
