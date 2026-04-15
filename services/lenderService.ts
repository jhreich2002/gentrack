/**
 * GenTrack — lenderService
 *
 * Fetches financing/lender articles from news_articles (pipeline = 'financing')
 * and generates AI financing summaries. Populated by the lender-ingest edge function.
 *
 * Also fetches Perplexity-sourced financing data from plant_financing_summary + plant_lenders.
 */

import { supabase } from './supabaseClient';
import type { FinancingDeal } from '../types';

export interface PlantFinancingSummary {
  summary:      string;
  citations:    { url: string; title: string; snippet: string }[];
  lendersFound: boolean;
  searchedAt:   string | null;
}

export interface PlantLenderRow {
  lenderName:          string;
  role:                string;
  facilityType:        string;
  confidence:          string;
  notes:               string | null;
  loanStatus:          'active' | 'matured' | 'refinanced' | 'unknown' | null;
  currencyConfidence:  number | null;
  currencyReasoning:   string | null;
  currencyCheckedAt:   string | null;
  currencySource:      string | null;
  maturityDate:        string | null;
  financialCloseDate:  string | null;
  refinancedAt:        string | null;
  // Agentic pipeline fields
  syndicateRole:       string | null;
  pitchAngle:          string | null;
  pitchAngleReasoning: string | null;
  pitchUrgencyScore:   number | null;
  sourceCount:         number | null;
}

export async function fetchPlantFinancingSummary(eiaPlantCode: string): Promise<{
  financing: PlantFinancingSummary | null;
  lenders:   PlantLenderRow[];
}> {
  const [summaryRes, lendersRes] = await Promise.all([
    supabase
      .from('plant_financing_summary')
      .select('summary, citations, lenders_found, searched_at')
      .eq('eia_plant_code', eiaPlantCode)
      .maybeSingle(),
    supabase
      .from('plant_lenders')
      .select(`
        lender_name, role, facility_type, confidence, notes,
        loan_status, currency_confidence, currency_reasoning,
        currency_checked_at, currency_source,
        maturity_date, financial_close_date, refinanced_at,
        syndicate_role, pitch_angle, pitch_angle_reasoning,
        pitch_urgency_score, source_count
      `)
      .eq('eia_plant_code', eiaPlantCode)
      .in('confidence', ['high', 'medium'])
      .order('loan_status', { ascending: true, nullsFirst: false })
      .order('confidence', { ascending: true }),
  ]);

  const row = summaryRes.data;
  const financing: PlantFinancingSummary | null = row ? {
    summary:      row.summary ?? '',
    citations:    Array.isArray(row.citations) ? row.citations : [],
    lendersFound: row.lenders_found ?? false,
    searchedAt:   row.searched_at ?? null,
  } : null;

  const lenders: PlantLenderRow[] = (lendersRes.data ?? []).map((r: Record<string, unknown>) => ({
    lenderName:          r.lender_name as string,
    role:                r.role as string,
    facilityType:        r.facility_type as string,
    confidence:          r.confidence as string,
    notes:               (r.notes as string | null) ?? null,
    loanStatus:          (r.loan_status as PlantLenderRow['loanStatus']) ?? null,
    currencyConfidence:  r.currency_confidence != null ? Number(r.currency_confidence) : null,
    currencyReasoning:   (r.currency_reasoning as string | null) ?? null,
    currencyCheckedAt:   (r.currency_checked_at as string | null) ?? null,
    currencySource:      (r.currency_source as string | null) ?? null,
    maturityDate:        (r.maturity_date as string | null) ?? null,
    financialCloseDate:  (r.financial_close_date as string | null) ?? null,
    refinancedAt:        (r.refinanced_at as string | null) ?? null,
    syndicateRole:       (r.syndicate_role as string | null) ?? null,
    pitchAngle:          (r.pitch_angle as string | null) ?? null,
    pitchAngleReasoning: (r.pitch_angle_reasoning as string | null) ?? null,
    pitchUrgencyScore:   r.pitch_urgency_score != null ? Number(r.pitch_urgency_score) : null,
    sourceCount:         r.source_count != null ? Number(r.source_count) : null,
  }));

  return { financing, lenders };
}

export async function fetchPlantFinancingArticles(eiaPlantCode: string): Promise<import('../types').NewsArticle[]> {
  const { data, error } = await supabase
    .from('news_articles')
    .select(`
      id, title, description, url, source_name,
      published_at, topics, sentiment_label, plant_codes,
      asset_linkage_tier, relevance_score, include_for_embedding,
      categories, tags, article_summary, ranked_at,
      event_type, impact_tags, fti_relevance_tags, importance, entity_company_names, lenders
    `)
    .eq('pipeline', 'financing')
    .contains('plant_codes', [eiaPlantCode])
    .or('asset_linkage_tier.neq.none,asset_linkage_tier.is.null')
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(50);

  if (error) {
    console.error('fetchPlantFinancingArticles error:', error.message);
    return [];
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id:                   row.id as string,
    title:                row.title as string,
    description:          row.description as string | null,
    url:                  row.url as string,
    sourceName:           row.source_name as string | null,
    publishedAt:          (row.published_at as string | null) ?? null,
    topics:               (row.topics as string[]) ?? [],
    sentimentLabel:       row.sentiment_label as 'positive' | 'negative' | 'neutral' | null,
    assetLinkageTier:     row.asset_linkage_tier as string | null,
    relevanceScore:       row.relevance_score as number | null,
    includeForEmbedding:  row.include_for_embedding as boolean | null,
    categories:           (row.categories as string[]) ?? [],
    tags:                 (row.tags as string[]) ?? [],
    articleSummary:        row.article_summary as string | null,
    eventType:            row.event_type as string | null,
    impactTags:           (row.impact_tags as string[]) ?? [],
    ftiRelevanceTags:     (row.fti_relevance_tags as string[]) ?? [],
    importance:           row.importance as 'low' | 'medium' | 'high' | null,
    entityCompanyNames:   (row.entity_company_names as string[]) ?? [],
    lenders:              (row.lenders as string[]) ?? [],
  }));
}

export async function fetchLenderCurrencyStatus(lenderName: string): Promise<{
  activePlants:   string[];
  maturedPlants:  string[];
  refinancedPlants: string[];
  unknownPlants:  string[];
  lastChecked:    string | null;
  avgConfidence:  number | null;
}> {
  const { data, error } = await supabase
    .from('plant_lenders')
    .select('eia_plant_code, loan_status, currency_confidence, currency_checked_at')
    .eq('lender_name', lenderName)
    .in('confidence', ['high', 'medium']);

  const empty = { activePlants: [], maturedPlants: [], refinancedPlants: [], unknownPlants: [], lastChecked: null, avgConfidence: null };
  if (error || !data) return empty;

  const rows = data as { eia_plant_code: string; loan_status: string | null; currency_confidence: number | null; currency_checked_at: string | null }[];
  const confidences = rows.map(r => r.currency_confidence).filter((c): c is number => c != null);
  const checkedDates = rows.map(r => r.currency_checked_at).filter((d): d is string => d != null).sort().reverse();

  return {
    activePlants:    rows.filter(r => r.loan_status === 'active').map(r => r.eia_plant_code),
    maturedPlants:   rows.filter(r => r.loan_status === 'matured').map(r => r.eia_plant_code),
    refinancedPlants: rows.filter(r => r.loan_status === 'refinanced').map(r => r.eia_plant_code),
    unknownPlants:   rows.filter(r => !r.loan_status || r.loan_status === 'unknown').map(r => r.eia_plant_code),
    lastChecked:     checkedDates[0] ?? null,
    avgConfidence:   confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
  };
}

export async function callFinancingSummarize(
  plant: { name: string; owner: string },
  articles: import('../types').NewsArticle[],
): Promise<{ summary: string | null; deals: FinancingDeal[] }> {
  const empty = { summary: null, deals: [] };
  // Vite `define` replaces the bare token `process.env.GEMINI_API_KEY` at build time.
  const apiKey = (
    (import.meta as Record<string, Record<string, string>>).env?.VITE_GEMINI_API_KEY
    ?? (import.meta as Record<string, Record<string, string>>).env?.GEMINI_API_KEY
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ?? (process as any).env.GEMINI_API_KEY
  ) || undefined;
  if (!apiKey) return empty;

  const topArticles = articles.slice(0, 10);
  const articleContext = topArticles
    .map((a, i) => {
      let entry = `[${i}] ${a.title}`;
      if (a.articleSummary) entry += `: ${a.articleSummary}`;
      else if (a.description) entry += `: ${a.description.slice(0, 200)}`;
      if (a.tags && a.tags.length > 0) entry += ` [${a.tags.join(', ')}]`;
      return entry;
    })
    .join('\n');

  const prompt = `Analyze the financing and lender exposure for the "${plant.name}" power plant (owner: ${
    plant.owner || 'unknown'
  }).\n\nFinancing-Related Articles (prefixed with [index]):\n${
    articleContext || 'No financing news found.'
  }\n\nReturn a JSON object with exactly two fields:\n1. "summary": 2–3 concise sentences summarizing known lenders or investors, financing events, tax equity structures, and any recent refinancing or credit changes. Be specific with names and dollar amounts. If data is limited, note what is known and acknowledge the gap.\n2. "deals": an array of financing deals extracted from the articles. Each deal has:\n   - "amount": dollar amount as a string (e.g. "$440M", "$200 million"). Use "undisclosed" if the amount is not mentioned.\n   - "type": the financing type (e.g. "Tax Equity", "Credit Facility", "Construction Loan", "Project Sale", "Refinancing", "Revenue Bond", "Bankruptcy Funding", "PPA"). Use the most specific label.\n   - "lender_investor": name of the lender, investor, or counterparty. Use "undisclosed" if not named.\n   - "source_index": the integer index [i] of the article this deal was extracted from.\n\nOnly include deals where a concrete financing event is described. Do not fabricate deals — if no deals are identifiable, return an empty array.`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
          },
        }),
      }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const parts: Record<string, unknown>[] = data?.candidates?.[0]?.content?.parts ?? [];
    const text = (parts.find(p => 'text' in p && !p.thought) as Record<string, string> | undefined)?.text ?? '';
    const parsed = JSON.parse(text);

    const summary: string | null = typeof parsed.summary === 'string' ? parsed.summary.trim() || null : null;
    const rawDeals: Array<{ amount?: string; type?: string; lender_investor?: string; source_index?: number }> = Array.isArray(parsed.deals) ? parsed.deals : [];

    const deals: FinancingDeal[] = rawDeals
      .filter(d => d.type || d.amount || d.lender_investor)
      .map(d => {
        const idx = typeof d.source_index === 'number' && d.source_index >= 0 && d.source_index < topArticles.length
          ? d.source_index : 0;
        return {
          amount:         d.amount ?? 'undisclosed',
          type:           d.type ?? 'Unknown',
          lenderInvestor: d.lender_investor ?? 'undisclosed',
          sourceTitle:    topArticles[idx].title,
          sourceUrl:      topArticles[idx].url,
        };
      });

    return { summary, deals };
  } catch (err) {
    console.error('callFinancingSummarize error:', err);
    return empty;
  }
}
