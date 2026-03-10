/**
 * GenTrack — lenderService
 *
 * Fetches structured lender/financing rows from the plant_lenders table.
 * Populated by the lender_pipeline Python script (SEC EDGAR extraction).
 */

import { supabase } from './supabaseClient';

export interface PlantLender {
  id: string;
  eia_plant_code: string;
  lender_name: string;
  facility_type: string;
  loan_amount_usd: number | null;
  interest_rate_text: string | null;
  maturity_date: string | null;
  maturity_text: string | null;
  filing_type: string;
  filing_date: string;
  filing_url: string;
  accession_no: string;
  excerpt_text: string | null;
  confidence: 'high' | 'medium' | 'low';
  extracted_at: string;
}

export async function fetchPlantFinancingNews(eiaPlantCode: string): Promise<import('../types').NewsArticle[]> {
  const { data, error } = await supabase
    .from('news_articles')
    .select(`
      id, title, description, url, source_name,
      published_at, topics, sentiment_label, plant_codes,
      event_type, impact_tags, fti_relevance_tags, importance, entity_company_names, lenders
    `)
    .eq('query_tag', `finance:${eiaPlantCode}`)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(20);

  if (error) {
    console.error('fetchPlantFinancingNews error:', error.message);
    return [];
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id:                 row.id as string,
    title:              row.title as string,
    description:        row.description as string | null,
    url:                row.url as string,
    sourceName:         row.source_name as string | null,
    publishedAt:        (row.published_at as string | null) ?? null,
    topics:             (row.topics as string[]) ?? [],
    sentimentLabel:     row.sentiment_label as 'positive' | 'negative' | 'neutral' | null,
    eventType:          row.event_type as string | null,
    impactTags:         (row.impact_tags as string[]) ?? [],
    ftiRelevanceTags:   (row.fti_relevance_tags as string[]) ?? [],
    importance:         row.importance as 'low' | 'medium' | 'high' | null,
    entityCompanyNames: (row.entity_company_names as string[]) ?? [],
    lenders:            (row.lenders as string[]) ?? [],
  }));
}

export async function callFinancingSummarize(
  plant: { name: string; owner: string },
  secLenders: PlantLender[],
  generalArticles: import('../types').NewsArticle[],
  financingArticles: import('../types').NewsArticle[],
): Promise<string | null> {
  const apiKey = (import.meta as Record<string, Record<string, string>>).env?.VITE_GEMINI_API_KEY
             ?? (import.meta as Record<string, Record<string, string>>).env?.GEMINI_API_KEY;
  if (!apiKey) return null;

  const secContext = secLenders.length > 0
    ? secLenders.map(l =>
        `- ${l.lender_name} (${l.facility_type.replace(/_/g, ' ')}, ${
          l.loan_amount_usd ? `$${(l.loan_amount_usd / 1e6).toFixed(0)}M` : 'amount unknown'
        }, ${l.filing_date.slice(0, 7)})`
      ).join('\n')
    : 'No SEC filing data available.';

  const articleContext = [...generalArticles, ...financingArticles]
    .slice(0, 8)
    .map(a => `- ${a.title}${a.description ? ': ' + a.description.slice(0, 150) : ''}`)
    .join('\n');

  const prompt = `Synthesize the financing and lender exposure for the "${plant.name}" power plant (owner: ${
    plant.owner || 'unknown'
  }).\n\nSEC Filing Data:\n${secContext}\n\nRelevant News Articles:\n${
    articleContext || 'No financing news found.'
  }\n\nIn 2–3 concise sentences, summarize: known lenders or investors, facility types and amounts where available, and any recent financing events or risks. Be specific with names and numbers. If data is limited, note what is known and acknowledge the gap.`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
        }),
      }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const parts: Record<string, unknown>[] = data?.candidates?.[0]?.content?.parts ?? [];
    const text = (parts.find(p => 'text' in p && !p.thought) as Record<string, string> | undefined)?.text ?? '';
    return text.trim() || null;
  } catch (err) {
    console.error('callFinancingSummarize error:', err);
    return null;
  }
}

export async function fetchPlantLenders(eiaPlantCode: string): Promise<PlantLender[]> {
  const { data, error } = await supabase
    .from('plant_lenders')
    .select('*')
    .eq('eia_plant_code', eiaPlantCode)
    .order('filing_date', { ascending: false });

  if (error) {
    console.error('fetchPlantLenders error:', error);
    return [];
  }
  return (data ?? []) as PlantLender[];
}
