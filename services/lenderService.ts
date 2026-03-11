/**
 * GenTrack — lenderService
 *
 * Fetches financing/lender articles from news_articles (pipeline = 'financing')
 * and generates AI financing summaries. Populated by the lender-ingest edge function.
 */

import { supabase } from './supabaseClient';

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

export async function callFinancingSummarize(
  plant: { name: string; owner: string },
  articles: import('../types').NewsArticle[],
): Promise<string | null> {
  const apiKey = (import.meta as Record<string, Record<string, string>>).env?.VITE_GEMINI_API_KEY
             ?? (import.meta as Record<string, Record<string, string>>).env?.GEMINI_API_KEY;
  if (!apiKey) return null;

  const articleContext = articles
    .slice(0, 10)
    .map(a => {
      let entry = `- ${a.title}`;
      if (a.articleSummary) entry += `: ${a.articleSummary}`;
      else if (a.description) entry += `: ${a.description.slice(0, 200)}`;
      if (a.tags && a.tags.length > 0) entry += ` [${a.tags.join(', ')}]`;
      return entry;
    })
    .join('\n');

  const prompt = `Synthesize the financing and lender exposure for the "${plant.name}" power plant (owner: ${
    plant.owner || 'unknown'
  }).\n\nFinancing-Related Articles:\n${
    articleContext || 'No financing news found.'
  }\n\nIn 2–3 concise sentences, summarize: known lenders or investors, financing events, tax equity structures, and any recent refinancing or credit changes. Be specific with names and numbers. If data is limited, note what is known and acknowledge the gap.`;

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
