/**
 * GenTrack — compute-ratings Edge Function
 *
 * Runs nightly (09:30 UTC via pg_cron, after embed-articles).
 * For every EIA plant code that appears in news_articles, computes
 * article counts and a composite risk score across 30/90/365-day
 * windows, then upserts into plant_news_ratings.
 *
 * Risk score formula (capped at 100):
 *   outage_30d × 12  + negative_30d × 4
 * + outage_90d × 4   + negative_90d × 1.5
 * + outage_365d × 1  + negative_365d × 0.5
 *
 * Required secrets:
 *   SUPABASE_URL              — auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY — auto-injected
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const UPSERT_BATCH = 200;

interface ArticleRow {
  id: string;
  plant_codes: string[];
  published_at: string;
  sentiment_label: string | null;
  topics: string[];
}

Deno.serve(async (_req) => {
  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase       = createClient(supabaseUrl, serviceRoleKey);

    const now365 = new Date(Date.now() - 365 * 86400 * 1000).toISOString();

    // ── Fetch all articles from the past year ─────────────────────────────
    // We aggregate in-process to avoid per-plant SQL queries for 6,000 plants.
    const { data: rows, error: fetchErr } = await supabase
      .from('news_articles')
      .select('id, plant_codes, published_at, sentiment_label, topics')
      .gte('published_at', now365)
      .not('plant_codes', 'eq', '{}');

    if (fetchErr) {
      return new Response(JSON.stringify({ error: fetchErr.message }), { status: 500 });
    }

    const articles: ArticleRow[] = rows ?? [];
    console.log(`Loaded ${articles.length} articles for rating computation`);

    // ── Aggregate counts per plant ────────────────────────────────────────
    const now = Date.now();
    const ms30  = 30  * 86400 * 1000;
    const ms90  = 90  * 86400 * 1000;
    const ms365 = 365 * 86400 * 1000;

    interface PlantStats {
      articles_30d:  number; negative_30d:  number; outage_30d:  number;
      articles_90d:  number; negative_90d:  number; outage_90d:  number;
      articles_365d: number; negative_365d: number; outage_365d: number;
      top_neg_ids:   Array<{ id: string; published_at: number }>;
    }

    const plantMap = new Map<string, PlantStats>();

    const getOrCreate = (code: string): PlantStats => {
      if (!plantMap.has(code)) {
        plantMap.set(code, {
          articles_30d: 0, negative_30d: 0, outage_30d: 0,
          articles_90d: 0, negative_90d: 0, outage_90d: 0,
          articles_365d: 0, negative_365d: 0, outage_365d: 0,
          top_neg_ids: [],
        });
      }
      return plantMap.get(code)!;
    };

    for (const a of articles) {
      const pubMs  = new Date(a.published_at).getTime();
      const age    = now - pubMs;
      const isNeg  = a.sentiment_label === 'negative';
      const isOut  = Array.isArray(a.topics) && a.topics.includes('outage');
      const isImpactful = isNeg || isOut;

      for (const code of (a.plant_codes ?? [])) {
        const s = getOrCreate(code);

        if (age <= ms365) {
          s.articles_365d++;
          if (isNeg) s.negative_365d++;
          if (isOut) s.outage_365d++;
          if (isImpactful) s.top_neg_ids.push({ id: a.id, published_at: pubMs });
        }
        if (age <= ms90) {
          s.articles_90d++;
          if (isNeg) s.negative_90d++;
          if (isOut) s.outage_90d++;
        }
        if (age <= ms30) {
          s.articles_30d++;
          if (isNeg) s.negative_30d++;
          if (isOut) s.outage_30d++;
        }
      }
    }

    // ── Build upsert rows ─────────────────────────────────────────────────
    const computedAt = new Date().toISOString();
    const upsertRows: Record<string, unknown>[] = [];

    for (const [code, s] of plantMap) {
      const raw =
        s.outage_30d  * 12 + s.negative_30d  * 4 +
        s.outage_90d  * 4  + s.negative_90d  * 1.5 +
        s.outage_365d * 1  + s.negative_365d * 0.5;

      const news_risk_score = Math.min(100, Math.round(raw * 100) / 100);

      // Top 5 most impactful articles (most recent)
      const top_article_ids = s.top_neg_ids
        .sort((a, b) => b.published_at - a.published_at)
        .slice(0, 5)
        .map(x => x.id);

      upsertRows.push({
        eia_plant_code: code,
        articles_30d:   s.articles_30d,  negative_30d:  s.negative_30d,  outage_30d:  s.outage_30d,
        articles_90d:   s.articles_90d,  negative_90d:  s.negative_90d,  outage_90d:  s.outage_90d,
        articles_365d:  s.articles_365d, negative_365d: s.negative_365d, outage_365d: s.outage_365d,
        news_risk_score,
        top_article_ids,
        computed_at: computedAt,
      });
    }

    console.log(`Upserting ratings for ${upsertRows.length} plants`);

    // ── Upsert in batches ─────────────────────────────────────────────────
    let upserted = 0;
    let errors   = 0;

    for (let i = 0; i < upsertRows.length; i += UPSERT_BATCH) {
      const batch = upsertRows.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from('plant_news_ratings')
        .upsert(batch, { onConflict: 'eia_plant_code' });

      if (error) {
        console.error(`Rating upsert batch error at row ${i}:`, error.message);
        errors++;
      } else {
        upserted += batch.length;
      }
    }

    const result = { ok: true, plantsRated: upserted, errors };
    console.log('compute-ratings complete:', result);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('compute-ratings fatal error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
