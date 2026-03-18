/**
 * GenTrack — refresh-entity-stats Edge Function
 *
 * Runs nightly after compute-ratings (chained) or on-demand.
 * Aggregates plant_lenders (high/medium confidence only) into:
 *   - lender_stats   (one row per lender name, non-tax-equity facilities)
 *   - tax_equity_stats (one row per investor, facility_type = 'tax_equity')
 *
 * Also writes distress_score to:
 *   - plants          (curtailment_score × 0.6 + news_risk_score × 0.4)
 *   - company_stats   (avg portfolio plant distress × 0.6 + bad-news-pct × 0.4)
 *
 * Entity news matched via bidirectional substring against entity_company_names[].
 *
 * Required secrets (auto-injected):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const NEWS_LOOKBACK_DAYS = 90;
const PAGE_SIZE          = 1000;
const UPSERT_BATCH       = 100;

const IMPORTANCE_WEIGHT: Record<string, number> = { high: 30, medium: 10, low: 3 };

// ── Paginated fetch ────────────────────────────────────────────────────────────
async function fetchAll<T = Record<string, unknown>>(
  sb: ReturnType<typeof createClient>,
  table: string,
  select: string,
  filters?: (q: any) => any,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    let q = sb.from(table).select(select).range(offset, offset + PAGE_SIZE - 1);
    if (filters) q = filters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch: ${error.message}`);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

// ── Bidirectional substring match (case-insensitive) ─────────────────────────
// Returns true if entityName appears in any of the article's company names,
// or if any company name is a substring of entityName.
function entityMatchesNames(entityName: string, companyNames: string[]): boolean {
  const eName = entityName.toLowerCase();
  for (const n of companyNames) {
    const cn = n.toLowerCase();
    if (cn.includes(eName) || eName.includes(cn)) return true;
  }
  return false;
}

// ── Upsert in batches ─────────────────────────────────────────────────────────
async function upsertBatch(
  sb: ReturnType<typeof createClient>,
  table: string,
  rows: Record<string, unknown>[],
  conflictCol: string,
): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    const { error } = await sb.from(table).upsert(batch, { onConflict: conflictCol });
    if (error) throw new Error(`${table} upsert batch: ${error.message}`);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb          = createClient(supabaseUrl, serviceKey);
  const now         = new Date().toISOString();

  try {
    // ── 1. Load plants (CF, curtailment, ISO) ─────────────────────────────────
    const plantRows = await fetchAll<{
      eia_plant_code: string;
      ttm_avg_factor: number | null;
      curtailment_score: number | null;
      is_likely_curtailed: boolean;
      nameplate_capacity_mw: number | null;
      region: string | null;
    }>(sb, 'plants',
      'eia_plant_code, ttm_avg_factor, curtailment_score, is_likely_curtailed, nameplate_capacity_mw, region'
    );
    console.log(`Loaded ${plantRows.length} plants`);

    const plantByCode = new Map<string, typeof plantRows[0]>();
    for (const p of plantRows) plantByCode.set(p.eia_plant_code, p);

    // ── 2. Load plant_news_ratings (news_risk_score) ──────────────────────────
    const ratingRows = await fetchAll<{
      eia_plant_code: string;
      news_risk_score: number | null;
    }>(sb, 'plant_news_ratings', 'eia_plant_code, news_risk_score');

    const ratingByCode = new Map<string, number>();
    for (const r of ratingRows) {
      if (r.news_risk_score != null) ratingByCode.set(r.eia_plant_code, r.news_risk_score);
    }
    console.log(`Loaded ${ratingRows.length} plant ratings`);

    // ── 3a. Load plant_financing_summary (lenders_found) ─────────────────────
    const financingRows = await fetchAll<{
      eia_plant_code: string;
      lenders_found: boolean;
    }>(sb, 'plant_financing_summary', 'eia_plant_code, lenders_found');

    const lendersFoundSet = new Set<string>(
      financingRows.filter(r => r.lenders_found).map(r => r.eia_plant_code)
    );
    console.log(`Loaded ${lendersFoundSet.size} plants with confirmed lenders`);

    // ── 3b. Load plant_news_state summaries (Perplexity prose) ───────────────
    const summaryRows = await fetchAll<{
      eia_plant_code: string;
      summary_text: string | null;
    }>(sb, 'plant_news_state', 'eia_plant_code, summary_text',
      (q: any) => q.not('summary_text', 'is', null)
    );

    const NEG_TERMS = [
      'curtailment','curtailed','curtailing','shutdown','shut down','shutting down',
      'offline','taken offline','bankrupt','bankruptcy','default','defaulted',
      'distress','financial distress','grid congestion','grid constraint',
      'output reduction','reduced output','struggling','financial loss',
      'halted','suspended operations','decommission','decommissioned',
      'foreclosure','receivership','write-down','impairment',
    ];
    const POS_TERMS = [
      'fully operational','record output','record generation','expanding',
      'upgraded','refinanced','new ppa','long-term contract','repowered',
    ];

    function scoreSummary(text: string): number {
      const lower = text.toLowerCase();
      let score = 0;
      for (const t of NEG_TERMS) if (lower.includes(t)) score += 4;
      for (const t of POS_TERMS) if (lower.includes(t)) score -= 3;
      return Math.max(0, Math.min(25, score));
    }

    const summaryRiskByCode = new Map<string, number>();
    for (const r of summaryRows) {
      if (r.summary_text) summaryRiskByCode.set(r.eia_plant_code, scoreSummary(r.summary_text));
    }
    console.log(`Loaded ${summaryRows.length} Perplexity news summaries for scoring`);

    // ── 3c. Compute plant distress scores and upsert ──────────────────────────
    const plantDistress = new Map<string, number>();
    const plantDistressUpdates: { eia_plant_code: string; distress_score: number; pursuit_status: string | null }[] = [];

    for (const p of plantRows) {
      const curtailment  = p.curtailment_score ?? 0;
      const newsRisk     = ratingByCode.get(p.eia_plant_code) ?? 0;
      const summaryRisk  = summaryRiskByCode.get(p.eia_plant_code);
      const lendersFound = lendersFoundSet.has(p.eia_plant_code);

      // Base: curtailment × 0.6 + news_risk × 0.4
      // If a Perplexity summary exists, blend it in (replacing some of the news weight)
      // to incorporate all news sources: curtailment × 0.5 + rssNews × 0.3 + summaryRisk × 0.2
      const base = summaryRisk != null
        ? curtailment * 0.5 + newsRisk * 0.3 + summaryRisk * 0.2
        : curtailment * 0.6 + newsRisk * 0.4;

      // Lender bonus: +15 if confirmed lenders (plant is actionable)
      const bonus   = lendersFound ? 15 : 0;
      const distress = parseFloat(Math.min(100, base + bonus).toFixed(2));

      // pursuit_status assignment
      let pursuitStatus: string | null = null;
      if (p.is_likely_curtailed && lendersFound) {
        pursuitStatus = distress >= 70 ? 'active' : distress >= 40 ? 'watch' : 'skip';
      }

      plantDistress.set(p.eia_plant_code, distress);
      plantDistressUpdates.push({
        eia_plant_code: p.eia_plant_code,
        distress_score: distress,
        pursuit_status: pursuitStatus,
      });
    }

    // Upsert plant distress scores in batches
    for (let i = 0; i < plantDistressUpdates.length; i += UPSERT_BATCH) {
      const batch = plantDistressUpdates.slice(i, i + UPSERT_BATCH);
      const { error } = await sb
        .from('plants')
        .upsert(batch, { onConflict: 'eia_plant_code' });
      if (error) console.error(`plant distress upsert error: ${error.message}`);
    }
    console.log(`Updated distress_score for ${plantDistressUpdates.length} plants (${lendersFoundSet.size} with lender bonus)`);

    // ── 4. Compute regional benchmark CF (avg by region) ─────────────────────
    const regionCfSum   = new Map<string, number>();
    const regionCfCount = new Map<string, number>();
    for (const p of plantRows) {
      if (p.region && p.ttm_avg_factor != null) {
        regionCfSum.set(p.region, (regionCfSum.get(p.region) ?? 0) + p.ttm_avg_factor);
        regionCfCount.set(p.region, (regionCfCount.get(p.region) ?? 0) + 1);
      }
    }
    const regionAvgCf = new Map<string, number>();
    for (const [rto, sum] of regionCfSum) {
      regionAvgCf.set(rto, sum / (regionCfCount.get(rto) ?? 1));
    }

    // ── 5. Load plant_lenders (high/medium confidence) ────────────────────────
    const lenderRows = await fetchAll<{
      eia_plant_code: string;
      lender_name: string;
      facility_type: string;
      loan_amount_usd: number | null;
    }>(sb, 'plant_lenders',
      'eia_plant_code, lender_name, facility_type, loan_amount_usd',
      (q: any) => q.in('confidence', ['high', 'medium'])
    );
    console.log(`Loaded ${lenderRows.length} plant_lenders rows (high/medium confidence)`);

    // ── 6. Aggregate lender_stats and tax_equity_stats ────────────────────────
    interface EntityAgg {
      plantCodes:    Set<string>;
      facilityTypes: Set<string>;
      totalAmount:   number;
      cfSum:         number;
      cfCount:       number;
      curtailedCount: number;
      distressSum:   number;
      distressCount: number;
      isoSet:        Set<string>;
    }

    const lenderMap   = new Map<string, EntityAgg>();
    const taxEquityMap = new Map<string, EntityAgg>();

    const initAgg = (): EntityAgg => ({
      plantCodes: new Set(), facilityTypes: new Set(),
      totalAmount: 0, cfSum: 0, cfCount: 0,
      curtailedCount: 0, distressSum: 0, distressCount: 0, isoSet: new Set(),
    });

    for (const row of lenderRows) {
      if (!row.lender_name) continue;
      const isTaxEquity = row.facility_type === 'tax_equity';
      const map = isTaxEquity ? taxEquityMap : lenderMap;

      if (!map.has(row.lender_name)) map.set(row.lender_name, initAgg());
      const agg = map.get(row.lender_name)!;

      agg.plantCodes.add(row.eia_plant_code);
      agg.facilityTypes.add(row.facility_type);
      if (row.loan_amount_usd) agg.totalAmount += row.loan_amount_usd;

      const plant = plantByCode.get(row.eia_plant_code);
      if (plant) {
        if (plant.ttm_avg_factor != null) { agg.cfSum += plant.ttm_avg_factor; agg.cfCount++; }
        if (plant.is_likely_curtailed) agg.curtailedCount++;
        if (plant.region) agg.isoSet.add(plant.region);
      }
      const distress = plantDistress.get(row.eia_plant_code);
      if (distress != null) { agg.distressSum += distress; agg.distressCount++; }
    }

    // ── 7. Load recent news for entity matching ───────────────────────────────
    const cutoff = new Date(Date.now() - NEWS_LOOKBACK_DAYS * 864e5).toISOString();

    const articleRows = await fetchAll<{
      entity_company_names: string[];
      sentiment_label: string | null;
      event_type: string | null;
      fti_relevance_tags: string[];
      importance: string | null;
      published_at: string;
    }>(sb, 'news_articles',
      'entity_company_names, sentiment_label, event_type, fti_relevance_tags, importance, published_at',
      (q: any) => q.gte('published_at', cutoff).not('entity_company_names', 'eq', '{}')
    );
    console.log(`Loaded ${articleRows.length} articles for entity news matching`);

    // ── 8. Match news to each entity ──────────────────────────────────────────
    interface EntityNews {
      posCount:        number;
      negCount:        number;
      totalCount:      number;
      relevanceScores: Record<string, number>;
      lastNewsDate:    string | null;
    }

    const matchEntityNews = (entityName: string): EntityNews => {
      const result: EntityNews = {
        posCount: 0, negCount: 0, totalCount: 0,
        relevanceScores: {}, lastNewsDate: null,
      };
      for (const art of articleRows) {
        const companies: string[] = art.entity_company_names ?? [];
        if (!entityMatchesNames(entityName, companies)) continue;

        result.totalCount++;
        if (art.sentiment_label === 'positive') result.posCount++;
        if (art.sentiment_label === 'negative') result.negCount++;

        const weight = IMPORTANCE_WEIGHT[art.importance ?? 'low'] ?? IMPORTANCE_WEIGHT.low;
        for (const tag of (art.fti_relevance_tags ?? [])) {
          result.relevanceScores[tag] = (result.relevanceScores[tag] ?? 0) + weight;
        }

        if (!result.lastNewsDate || art.published_at > result.lastNewsDate) {
          result.lastNewsDate = art.published_at;
        }
      }
      return result;
    };

    // ── 9. Build and upsert lender_stats ─────────────────────────────────────
    const lenderUpserts: Record<string, unknown>[] = [];

    for (const [name, agg] of lenderMap) {
      const news = matchEntityNews(name);
      const newsSentimentScore = news.totalCount > 0
        ? parseFloat((news.posCount / news.totalCount * 100).toFixed(2))
        : null;

      const avgPlantDistress = agg.distressCount > 0
        ? agg.distressSum / agg.distressCount
        : null;
      const distressScore = avgPlantDistress != null
        ? parseFloat((
            avgPlantDistress * 0.6 +
            (100 - (newsSentimentScore ?? 50)) * 0.4
          ).toFixed(2))
        : null;

      lenderUpserts.push({
        lender_name:          name,
        asset_count:          agg.plantCodes.size,
        total_exposure_usd:   agg.totalAmount > 0 ? agg.totalAmount : null,
        plant_codes:          [...agg.plantCodes],
        facility_types:       [...agg.facilityTypes],
        avg_plant_cf:         agg.cfCount > 0
          ? parseFloat((agg.cfSum / agg.cfCount).toFixed(4))
          : null,
        pct_curtailed:        agg.plantCodes.size > 0
          ? parseFloat((agg.curtailedCount / agg.plantCodes.size * 100).toFixed(2))
          : 0,
        news_sentiment_score: newsSentimentScore,
        distress_score:       distressScore,
        relevance_scores:     news.relevanceScores,
        last_news_date:       news.lastNewsDate,
        computed_at:          now,
      });
    }

    await upsertBatch(sb, 'lender_stats', lenderUpserts, 'lender_name');
    console.log(`Upserted ${lenderUpserts.length} lender_stats rows`);

    // ── 10. Build and upsert tax_equity_stats ─────────────────────────────────
    const taxEquityUpserts: Record<string, unknown>[] = [];

    for (const [name, agg] of taxEquityMap) {
      const news = matchEntityNews(name);
      const newsSentimentScore = news.totalCount > 0
        ? parseFloat((news.posCount / news.totalCount * 100).toFixed(2))
        : null;

      // Weighted regional benchmark CF for this investor's portfolio
      let benchmarkSum = 0;
      let benchmarkMw  = 0;
      for (const code of agg.plantCodes) {
        const plant = plantByCode.get(code);
        if (!plant?.region) continue;
        const regional = regionAvgCf.get(plant.region);
        if (regional == null) continue;
        const mw = plant.nameplate_capacity_mw ?? 0;
        benchmarkSum += regional * mw;
        benchmarkMw  += mw;
      }
      const portfolioBenchmarkCf = benchmarkMw > 0
        ? parseFloat((benchmarkSum / benchmarkMw).toFixed(4))
        : null;

      const avgPlantDistress = agg.distressCount > 0
        ? agg.distressSum / agg.distressCount
        : null;
      const distressScore = avgPlantDistress != null
        ? parseFloat((
            avgPlantDistress * 0.6 +
            (100 - (newsSentimentScore ?? 50)) * 0.4
          ).toFixed(2))
        : null;

      taxEquityUpserts.push({
        investor_name:           name,
        asset_count:             agg.plantCodes.size,
        total_committed_usd:     agg.totalAmount > 0 ? agg.totalAmount : null,
        plant_codes:             [...agg.plantCodes],
        portfolio_avg_cf:        agg.cfCount > 0
          ? parseFloat((agg.cfSum / agg.cfCount).toFixed(4))
          : null,
        portfolio_benchmark_cf:  portfolioBenchmarkCf,
        pct_curtailed:           agg.plantCodes.size > 0
          ? parseFloat((agg.curtailedCount / agg.plantCodes.size * 100).toFixed(2))
          : 0,
        news_sentiment_score:    newsSentimentScore,
        distress_score:          distressScore,
        relevance_scores:        news.relevanceScores,
        last_news_date:          news.lastNewsDate,
        computed_at:             now,
      });
    }

    await upsertBatch(sb, 'tax_equity_stats', taxEquityUpserts, 'investor_name');
    console.log(`Upserted ${taxEquityUpserts.length} tax_equity_stats rows`);

    // ── 11. Update company_stats distress_score ───────────────────────────────
    // Load ownership to map company → plant codes
    const ownershipRows = await fetchAll<{ eia_site_code: string; ult_parent: string }>(
      sb, 'plant_ownership', 'eia_site_code, ult_parent',
      (q: any) => q.not('ult_parent', 'is', null)
    );

    const parentToPlants = new Map<string, string[]>();
    for (const row of ownershipRows) {
      const code = String(row.eia_site_code ?? '').trim();
      const parent = String(row.ult_parent ?? '').trim();
      if (!code || !parent) continue;
      if (!parentToPlants.has(parent)) parentToPlants.set(parent, []);
      parentToPlants.get(parent)!.push(code);
    }

    // Load existing company_stats for news signals
    const companyRows = await fetchAll<{
      ult_parent_name: string;
      relevance_scores: Record<string, number> | null;
    }>(sb, 'company_stats', 'ult_parent_name, relevance_scores');

    const companyDistressUpdates: { ult_parent_name: string; distress_score: number }[] = [];

    for (const company of companyRows) {
      const plantCodes = parentToPlants.get(company.ult_parent_name) ?? [];
      if (!plantCodes.length) continue;

      let distSum = 0;
      let distCount = 0;
      for (const code of plantCodes) {
        const d = plantDistress.get(code);
        if (d != null) { distSum += d; distCount++; }
      }
      if (!distCount) continue;

      const avgPlantDistress = distSum / distCount;

      // Use news signals to estimate entity news sentiment
      const news = matchEntityNews(company.ult_parent_name);
      const newsSentimentScore = news.totalCount > 0
        ? news.posCount / news.totalCount * 100
        : 50; // neutral default

      const distressScore = parseFloat((
        avgPlantDistress * 0.6 +
        (100 - newsSentimentScore) * 0.4
      ).toFixed(2));

      companyDistressUpdates.push({
        ult_parent_name: company.ult_parent_name,
        distress_score: distressScore,
      });
    }

    await upsertBatch(sb, 'company_stats', companyDistressUpdates, 'ult_parent_name');
    console.log(`Updated distress_score for ${companyDistressUpdates.length} companies`);

    const result = {
      ok: true,
      plantsUpdated:      plantDistressUpdates.length,
      lendersUpserted:    lenderUpserts.length,
      taxEquityUpserted:  taxEquityUpserts.length,
      companiesUpdated:   companyDistressUpdates.length,
      computedAt:         now,
    };
    console.log('refresh-entity-stats complete:', result);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[refresh-entity-stats] Error:', msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
