import { GoogleGenAI, Type } from "@google/genai";
import { PowerPlant, CapacityFactorStats, AnalysisResult, NewsAnalysis, NewsItem } from "../types";

/**
 * Analyzes US power generation data using Gemini AI.
 * Identifies curtailment patterns and provides professional insights.
 */
export const getGeminiInsights = async (
  filteredPlants: PowerPlant[], 
  statsMap: Record<string, CapacityFactorStats>
): Promise<AnalysisResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const topCurtailed = filteredPlants
    .map(p => ({ 
      name: p.name, 
      region: p.region, 
      fuel: p.fuelSource, 
      ttm: statsMap[p.id]?.ttmAverage,
      score: statsMap[p.id]?.curtailmentScore
    }))
    .filter(p => (statsMap[filteredPlants.find(fp => fp.name === p.name)!.id]?.isLikelyCurtailed))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const prompt = `
    Analyze the following US power generation data summary. 
    Total plants analyzed: ${filteredPlants.length}.
    Key concern: Capacity Factor vs Nameplate Capacity (Curtailment).
    
    Curtailed Plants identified by algorithm:
    ${JSON.stringify(topCurtailed, null, 2)}
    
    Task:
    1. Provide a professional summary of current grid reliability for these regions.
    2. Identify potential reasons for curtailment in these regions (e.g., transmission bottlenecks, negative pricing, seasonal variation).
    3. Give actionable recommendations for grid operators or investors.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING, description: "Professional summary of grid reliability." },
            outliers: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING },
              description: "List of anomalous plants and their likely reasons for underperformance."
            },
            recommendations: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING },
              description: "Actionable steps for grid operators or investors."
            }
          },
          required: ["summary", "outliers", "recommendations"]
        }
      },
    });

    const text = response.text;
    if (!text) throw new Error("Empty response from AI");
    return JSON.parse(text) as AnalysisResult;
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return {
      summary: "Could not generate AI insights at this time. Please check your connectivity.",
      outliers: [],
      recommendations: ["Check manual capacity factor trends below."]
    };
  }
};

const NEWS_CACHE_PREFIX = 'gentrack_news_';

function getCachedNews(plantId: string): NewsAnalysis | null {
  try {
    const raw = sessionStorage.getItem(NEWS_CACHE_PREFIX + plantId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setCachedNews(plantId: string, data: NewsAnalysis): void {
  try { sessionStorage.setItem(NEWS_CACHE_PREFIX + plantId, JSON.stringify(data)); } catch {}
}

async function callGeminiNews(ai: GoogleGenAI, prompt: string, useGrounding: boolean): Promise<{ summary: string; items: NewsItem[] }> {
  const config: any = useGrounding ? { tools: [{ googleSearch: {} }] } : {};
  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
    config,
  });

  const summary = response.text || 'No recent information found for this plant.';
  const chunks: any[] = useGrounding
    ? ((response as any).candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
    : [];
  const items: NewsItem[] = chunks
    .filter((c: any) => c.web?.uri)
    .map((c: any) => {
      const url: string = c.web.uri;
      const title: string = c.web.title || url;
      let source = url;
      try { source = new URL(url).hostname.replace('www.', ''); } catch {}
      return { title, url, source };
    });

  return { summary, items };
}

/**
 * Searches for recent news and operational updates for a specific power plant
 * using Gemini 2.0 Flash with Google Search grounding (live web search with citations).
 * Results are cached in sessionStorage to avoid redundant API calls.
 */
export const getPlantNews = async (plant: PowerPlant): Promise<NewsAnalysis> => {
  // Return cached result immediately if available
  const cached = getCachedNews(plant.id);
  if (cached) return cached;

  const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      summary: 'Gemini API key is not configured. Add GEMINI_API_KEY to your .env file.',
      items: []
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `You are an expert energy analyst. Summarize recent news, operational updates, maintenance events, outages, or regulatory filings for the power plant "${plant.name}" (EIA plant code ${plant.eiaPlantCode}), owned by "${plant.owner}", located in ${plant.county ? `${plant.county} county, ` : ''}${plant.location.state}. It is a ${plant.nameplateCapacityMW} MW ${plant.fuelSource} facility. Write 2-3 sentences covering the most relevant developments from the past 12 months. Be specific and factual.`;

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  // Attempt 1: grounded search
  // Attempt 2 (on quota error): grounded search after 3s backoff
  // Attempt 3 (on quota error): plain Gemini without grounding
  for (let attempt = 0; attempt < 3; attempt++) {
    const useGrounding = attempt < 2;
    try {
      if (attempt === 1) await delay(3000);
      const result = await callGeminiNews(ai, prompt, useGrounding);
      const newsAnalysis: NewsAnalysis = { summary: result.summary, items: result.items };
      setCachedNews(plant.id, newsAnalysis);
      return newsAnalysis;
    } catch (error: any) {
      const msg: string = error?.message || String(error);
      const isQuota = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
      const isAuth  = msg.includes('401') || msg.includes('403') || msg.includes('API_KEY');
      console.warn(`Gemini News attempt ${attempt + 1} failed:`, msg);

      if (isAuth) {
        return { summary: 'Gemini API key is invalid or unauthorized. Check your GEMINI_API_KEY.', items: [] };
      }
      if (!isQuota || attempt === 2) {
        return { summary: `Unable to fetch news: ${msg}`, items: [] };
      }
      // isQuota && attempt < 2 → loop continues with backoff/fallback
    }
  }

  return { summary: 'Unable to fetch news after multiple attempts. Please try again later.', items: [] };
};