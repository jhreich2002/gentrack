/**
 * GenTrack — company-stats-refresh Edge Function
 *
 * Runs nightly at 06:30 UTC (30 min after news-ingest completes) via pg_cron.
 * Full-refresh of the company_stats table for every known ult_parent.
 *
 * Steps:
 *   1. Load all plant_ownership rows to build ult_parent → plant_code mapping
 *   2. Load all plants rows for nameplate_capacity_mw, fuel_source, state, ttm_avg_factor
 *   3. Join in-memory → compute total_mw, plant_count, avg_cf, tech_breakdown, state_breakdown
 *   4. Load news_articles (last 90 days) with entity_company_names populated
 *   5. Compute event_counts and relevance_scores per company
 *   6. Upsert complete company_stats rows
 *
 * Required secrets (auto-injected by Supabase runtime):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkInternalAuth } from '../_shared/auth.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const NEWS_LOOKBACK_DAYS = 90;
const IMPORTANCE_WEIGHT: Record<string, number> = {
  high:   30,
  medium: 10,
  low:     3,
};
const UPSERT_BATCH = 100; // rows per company_stats upsert
const PAGE_SIZE    = 1000; // rows per paginated fetch

// ── Paginated fetch helper (Supabase default cap = 1000 rows) ─────────────────
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

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const __authDenied = checkInternalAuth(req);
  if (__authDenied) return __authDenied;
  // Allow CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const supabaseUrl  = Deno.env.get('SUPABASE_URL')!;
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb           = createClient(supabaseUrl, serviceKey);

  let companiesComputed  = 0;
  let articlesLinked     = 0;

  try {
    // ── 1. Load plant_ownership (eia_site_code ↔ ult_parent) ─────────────────
    const ownershipRows = await fetchAll(sb, 'plant_ownership', 'eia_site_code, ult_parent',
      (q: any) => q.not('ult_parent', 'is', null)
    );
    console.log(`  Loaded ${ownershipRows.length} ownership rows`);

    // Build bi-directional maps
    const sitesToParent = new Map<string, string>(); // eia_site_code → ult_parent
    const parentToSites = new Map<string, Set<string>>(); // ult_parent → Set<eia_site_code>

    for (const row of ownershipRows ?? []) {
      const code   = String(row.eia_site_code ?? '').trim();
      const parent = String(row.ult_parent ?? '').trim();
      if (!code || !parent) continue;
      // Skip junk ult_parent values: purely numeric, "NA", single-word placeholders
      if (/^\d+\.?\d*$/.test(parent) || parent === 'NA' || parent.length < 3) continue;
      sitesToParent.set(code, parent);
      if (!parentToSites.has(parent)) parentToSites.set(parent, new Set());
      parentToSites.get(parent)!.add(code);
    }

    // ── 2. Load plants (nameplate MW, fuel_source, state, ttm_avg_factor) ────
    const plantRows = await fetchAll(sb, 'plants',
      'eia_plant_code, nameplate_capacity_mw, fuel_source, state, ttm_avg_factor'
    );
    console.log(`  Loaded ${plantRows.length} plant rows`);

    // eia_plant_code → plant info
    const plantsByCode = new Map<string, {
      mw: number;
      fuel: string;
      state: string;
      ttmCf: number | null;
    }>();
    for (const p of plantRows ?? []) {
      plantsByCode.set(String(p.eia_plant_code ?? ''), {
        mw:    Number(p.nameplate_capacity_mw) || 0,
        fuel:  String(p.fuel_source ?? 'Unknown'),
        state: String(p.state ?? ''),
        ttmCf: p.ttm_avg_factor != null ? Number(p.ttm_avg_factor) : null,
      });
    }

    // ── 3. Aggregate portfolio stats per ult_parent ───────────────────────────
    interface PortfolioStats {
      totalMw:       number;
      plantCount:    number;
      cfSum:         number;
      cfCount:       number;
      techBreakdown: Record<string, number>;
      stateBreakdown: Record<string, number>;
    }

    const portfolioMap = new Map<string, PortfolioStats>();

    for (const [parent, sites] of parentToSites) {
      const ps: PortfolioStats = {
        totalMw: 0, plantCount: 0, cfSum: 0, cfCount: 0,
        techBreakdown: {}, stateBreakdown: {},
      };
      for (const code of sites) {
        const pi = plantsByCode.get(code);
        if (!pi) continue;
        ps.plantCount++;
        ps.totalMw += pi.mw;
        if (pi.ttmCf !== null) { ps.cfSum += pi.ttmCf; ps.cfCount++; }
        ps.techBreakdown[pi.fuel] = (ps.techBreakdown[pi.fuel] ?? 0) + pi.mw;
        if (pi.state) ps.stateBreakdown[pi.state] = (ps.stateBreakdown[pi.state] ?? 0) + pi.mw;
      }
      if (ps.plantCount > 0) portfolioMap.set(parent, ps);
    }

    // ── 4. Load recent news articles ─────────────────────────────────────────
    const cutoff = new Date(Date.now() - NEWS_LOOKBACK_DAYS * 864e5).toISOString();

    const articleRows = await fetchAll(sb, 'news_articles',
      'entity_company_names, event_type, fti_relevance_tags, importance',
      (q: any) => q.gte('published_at', cutoff).not('entity_company_names', 'is', null)
    );
    console.log(`  Loaded ${articleRows.length} recent articles`);

    // ── 5. Aggregate news signals per company ─────────────────────────────────
    interface NewsSignals {
      eventCounts:     Record<string, number>;
      relevanceScores: Record<string, number>;
    }

    const newsMap = new Map<string, NewsSignals>();

    const ensureNews = (name: string): NewsSignals => {
      if (!newsMap.has(name)) newsMap.set(name, { eventCounts: {}, relevanceScores: {} });
      return newsMap.get(name)!;
    };

    for (const art of articleRows ?? []) {
      const companies: string[] = art.entity_company_names ?? [];
      if (!companies.length) continue;

      const eventType: string | null = art.event_type ?? null;
      const ftiTags:   string[]      = art.fti_relevance_tags ?? [];
      const importance: string       = art.importance ?? 'low';
      const weight = IMPORTANCE_WEIGHT[importance] ?? IMPORTANCE_WEIGHT.low;

      for (const company of companies) {
        const ns = ensureNews(company);
        if (eventType && eventType !== 'none') {
          ns.eventCounts[eventType] = (ns.eventCounts[eventType] ?? 0) + 1;
        }
        for (const tag of ftiTags) {
          ns.relevanceScores[tag] = (ns.relevanceScores[tag] ?? 0) + weight;
        }
        articlesLinked++;
      }
    }

    // ── 6. Build upsert rows ──────────────────────────────────────────────────
    const now = new Date().toISOString();
    const allParents = new Set([...portfolioMap.keys(), ...newsMap.keys()]);
    const upsertRows: Record<string, unknown>[] = [];

    for (const parent of allParents) {
      const ps  = portfolioMap.get(parent);
      const ns  = newsMap.get(parent);

      upsertRows.push({
        ult_parent_name:   parent,
        total_mw:          ps ? Math.round(ps.totalMw) : 0,
        plant_count:       ps?.plantCount ?? 0,
        avg_cf:            ps && ps.cfCount > 0 ? parseFloat((ps.cfSum / ps.cfCount).toFixed(4)) : 0,
        tech_breakdown:    ps?.techBreakdown ?? {},
        state_breakdown:   ps?.stateBreakdown ?? {},
        event_counts:      ns?.eventCounts ?? {},
        relevance_scores:  ns?.relevanceScores ?? {},
        computed_at:       now,
      });
    }

    // Upsert in batches
    for (let i = 0; i < upsertRows.length; i += UPSERT_BATCH) {
      const batch = upsertRows.slice(i, i + UPSERT_BATCH);
      const { error } = await sb
        .from('company_stats')
        .upsert(batch, { onConflict: 'ult_parent_name' });
      if (error) throw new Error(`company_stats upsert: ${error.message}`);
    }

    companiesComputed = upsertRows.length;

    return new Response(JSON.stringify({
      ok: true,
      companiesComputed,
      articlesLinked,
      computedAt: now,
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[company-stats-refresh] Error:', msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
