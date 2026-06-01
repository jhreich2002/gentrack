/**
 * news-coverage-calibration.ts
 *
 * Tests whether GDELT DOC 2.0 API and Google News RSS can find
 * financing/lender news articles for our top plants (by MW).
 *
 * No API key required — both are free, open endpoints.
 * Run: npx tsx scripts/news-coverage-calibration.ts
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

// Read .env / .env.local the same way other scripts do
function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, 'utf8');
  const map: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}
const cwd = process.cwd();
const env = { ...parseEnvFile(path.join(cwd, '.env')), ...parseEnvFile(path.join(cwd, '.env.local')) };
const SUPABASE_URL = env['SUPABASE_URL'] ?? env['VITE_SUPABASE_URL'] ?? '';
const SERVICE_KEY  = env['SUPABASE_SERVICE_ROLE_KEY'] ?? env['VITE_SUPABASE_SERVICE_ROLE_KEY'] ?? '';
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Missing SUPABASE_URL / SERVICE_ROLE_KEY in .env'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const FINANCING_KEYWORDS = [
  'loan', 'lender', 'financing', 'financed', 'credit facility',
  'term loan', 'construction loan', 'debt', 'arranged by',
  'administrative agent', 'admin agent', 'refinanc', 'mortgage',
  'syndicate', 'co-arranger', 'project finance', 'borrower',
  'revolving credit', 'bridge loan',
];

const PLANT_COUNT = 50;
const DELAY_MS    = 2000; // be polite to free APIs

interface Article {
  title:    string;
  url:      string;
  date:     string;
  source:   string;
  snippet:  string;
  hasFinancingKw: boolean;
}

interface PlantResult {
  plant_name:      string;
  eia_code:        string;
  state:           string;
  capacity_mw:     number;
  fuel_source:     string;
  owner:           string;
  gdelt_total:     number;
  gnews_total:     number;
  gdelt_hits:      number; // articles with financing keyword
  gnews_hits:      number;
  any_hit:         boolean;
  top_articles:    Article[];
}

function hasKw(text: string): boolean {
  const t = text.toLowerCase();
  return FINANCING_KEYWORDS.some(k => t.includes(k));
}

async function searchGdelt(plantName: string): Promise<Article[]> {
  try {
    const q   = encodeURIComponent(`"${plantName}" (loan OR lender OR financing OR "credit facility" OR "term loan")`);
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=ArtList&format=json&maxrecords=25&sort=DateDesc`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return ((data.articles ?? []) as any[]).map((a: any): Article => ({
      title:          a.title   ?? '',
      url:            a.url     ?? '',
      date:           a.seendate ?? '',
      source:         a.domain  ?? '',
      snippet:        '',
      hasFinancingKw: hasKw(a.title ?? ''),
    }));
  } catch {
    return [];
  }
}

async function searchGoogleNews(plantName: string): Promise<Article[]> {
  try {
    const q   = encodeURIComponent(`"${plantName}" financing OR lender OR loan`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const xml     = await res.text();
    const items: Article[] = [];
    const itemRe  = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null && items.length < 15) {
      const chunk   = m[1];
      const title   = chunk.match(/<title><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1]
                   ?? chunk.match(/<title>([\s\S]*?)<\/title>/)?.[1]
                   ?? '';
      const rawLink = chunk.match(/<link\/>([\s\S]*?)<\/item>/)?.[1]?.trim()
                   ?? chunk.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim()
                   ?? '';
      const pubDate = chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '';
      const desc    = chunk.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ?? '';
      items.push({
        title:          title.trim(),
        url:            rawLink,
        date:           pubDate,
        source:         'google-news',
        snippet:        desc.replace(/<[^>]+>/g, '').slice(0, 200),
        hasFinancingKw: hasKw(title + ' ' + desc),
      });
    }
    return items;
  } catch {
    return [];
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  // ── Fetch plants ──────────────────────────────────────────────────────────
  console.log(`Fetching top ${PLANT_COUNT} plants by capacity…`);
  const { data: plants, error } = await supabase
    .from('plants')
    .select('id, eia_plant_code, name, state, nameplate_capacity_mw, fuel_source, owner')
    .in('fuel_source', ['Wind', 'Solar'])          // most project-finance coverage
    .gte('nameplate_capacity_mw', 50)
    .order('nameplate_capacity_mw', { ascending: false })
    .limit(PLANT_COUNT);

  if (error || !plants?.length) {
    console.error('Failed to fetch plants:', error);
    process.exit(1);
  }

  console.log(`Running calibration on ${plants.length} plants…\n`);

  const results: PlantResult[] = [];
  let hitCount = 0;

  for (let i = 0; i < plants.length; i++) {
    const p = plants[i];
    process.stdout.write(`[${String(i + 1).padStart(2)}/${plants.length}] ${p.name} (${p.nameplate_capacity_mw} MW, ${p.state})… `);

    const [gdelt, gnews] = await Promise.all([
      searchGdelt(p.name),
      searchGoogleNews(p.name),
    ]);

    const gdeltHits = gdelt.filter(a => a.hasFinancingKw).length;
    const gnewsHits = gnews.filter(a => a.hasFinancingKw).length;
    const anyHit    = gdeltHits > 0 || gnewsHits > 0;
    if (anyHit) hitCount++;

    // Collect up to 5 articles that have financing keywords, then fill with others
    const topArticles = [
      ...gdelt.filter(a => a.hasFinancingKw).map(a => ({ ...a, _src: 'GDELT' })),
      ...gnews.filter(a => a.hasFinancingKw).map(a => ({ ...a, _src: 'GNews' })),
      ...gdelt.filter(a => !a.hasFinancingKw).slice(0, 2).map(a => ({ ...a, _src: 'GDELT' })),
      ...gnews.filter(a => !a.hasFinancingKw).slice(0, 2).map(a => ({ ...a, _src: 'GNews' })),
    ].slice(0, 5) as Article[];

    const marker = anyHit ? '✓ HIT' : '— miss';
    console.log(`GDELT:${gdelt.length}(${gdeltHits}✓) GNews:${gnews.length}(${gnewsHits}✓) ${marker}`);

    if (anyHit) {
      const best = topArticles[0];
      console.log(`         → ${best.title.slice(0, 80)}`);
      console.log(`         → ${best.url.slice(0, 100)}`);
    }

    results.push({
      plant_name:  p.name,
      eia_code:    p.eia_plant_code,
      state:       p.state,
      capacity_mw: p.nameplate_capacity_mw,
      fuel_source: p.fuel_source,
      owner:       p.owner,
      gdelt_total: gdelt.length,
      gnews_total: gnews.length,
      gdelt_hits:  gdeltHits,
      gnews_hits:  gnewsHits,
      any_hit:     anyHit,
      top_articles: topArticles,
    });

    await sleep(DELAY_MS);
  }

  // ── Write CSV ─────────────────────────────────────────────────────────────
  const dateStr  = new Date().toISOString().slice(0, 10);
  const csvPath  = path.join('logs', `news-calibration-${dateStr}.csv`);
  const jsonPath = path.join('logs', `news-calibration-${dateStr}.json`);

  const csvHeader = 'plant_name,eia_code,state,capacity_mw,fuel_source,owner,gdelt_total,gnews_total,gdelt_hits,gnews_hits,any_hit,top_article_title,top_article_url,top_article_date,top_article_source';
  const csvRows = results.map(r => {
    const t = r.top_articles[0];
    return [
      `"${r.plant_name.replace(/"/g, '""')}"`,
      r.eia_code,
      r.state,
      r.capacity_mw,
      r.fuel_source,
      `"${r.owner.replace(/"/g, '""')}"`,
      r.gdelt_total,
      r.gnews_total,
      r.gdelt_hits,
      r.gnews_hits,
      r.any_hit ? 'YES' : 'NO',
      `"${(t?.title ?? '').replace(/"/g, '""')}"`,
      `"${(t?.url ?? '')}"`,
      `"${(t?.date ?? '')}"`,
      `"${(t?.source ?? '')}"`,
    ].join(',');
  });

  fs.writeFileSync(csvPath,  [csvHeader, ...csvRows].join('\n'));
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  // ── Summary ───────────────────────────────────────────────────────────────
  const recallPct = Math.round((hitCount / results.length) * 100);
  console.log('\n══════════════════════════════════════════');
  console.log(`  CALIBRATION RESULTS`);
  console.log(`══════════════════════════════════════════`);
  console.log(`  Plants tested:              ${results.length}`);
  console.log(`  Had financing article hit:  ${hitCount} / ${results.length} (${recallPct}%)`);
  console.log();

  const hits = results.filter(r => r.any_hit);
  if (hits.length) {
    console.log('  TOP HITS (first 15):');
    hits.slice(0, 15).forEach(r => {
      const best = r.top_articles[0];
      console.log(`\n  ✓ ${r.plant_name} (${r.state}, ${r.capacity_mw} MW, ${r.fuel_source})`);
      console.log(`    Owner: ${r.owner}`);
      if (best) {
        console.log(`    Title: ${best.title.slice(0, 90)}`);
        console.log(`    URL:   ${best.url}`);
        console.log(`    Date:  ${best.date}`);
      }
    });
  }

  const misses = results.filter(r => !r.any_hit);
  if (misses.length) {
    console.log(`\n  MISSES (${misses.length} plants — no financing articles found):`);
    misses.forEach(r => console.log(`    ✗ ${r.plant_name} (${r.state}, ${r.capacity_mw} MW)`));
  }

  console.log();
  console.log(`  CSV:  ${csvPath}`);
  console.log(`  JSON: ${jsonPath}`);
  console.log();

  if (recallPct >= 70) {
    console.log('  VERDICT: ✅ STRONG COVERAGE — Subscribe to NewsAPI.ai with confidence.');
  } else if (recallPct >= 40) {
    console.log('  VERDICT: ⚠️  PARTIAL COVERAGE — NewsAPI.ai worth trying; expect manual entry for ~half of plants.');
  } else {
    console.log('  VERDICT: ❌ WEAK COVERAGE — News articles may not exist for these deals; reconsider approach.');
  }
  console.log('══════════════════════════════════════════\n');
}

main().catch(err => { console.error(err); process.exit(1); });
