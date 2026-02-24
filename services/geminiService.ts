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

/**
 * Searches for recent news and operational updates for a specific power plant
 * using Gemini 2.0 Flash with Google Search grounding (live web search with citations).
 */
export const getPlantNews = async (plant: PowerPlant): Promise<NewsAnalysis> => {
  const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return {
      summary: "Gemini API key is not configured. Add GEMINI_API_KEY to your .env file.",
      items: []
    };
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `You are an expert energy analyst with access to live web search. Find recent news, operational updates, maintenance events, outages, or regulatory filings for the power plant "${plant.name}" (EIA plant code ${plant.eiaPlantCode}), owned by "${plant.owner}", located in ${plant.county ? `${plant.county} county, ` : ''}${plant.location.state}. It is a ${plant.nameplateCapacityMW} MW ${plant.fuelSource} facility. Write a 2-3 sentence factual summary of the most relevant recent developments from the past 12 months. Be specific and cite real events.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      }
    });

    const summary = response.text || "No recent information found for this plant.";

    // Extract grounding chunks (web sources cited by Gemini)
    const chunks: any[] = (response as any).candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const newsItems: NewsItem[] = chunks
      .filter((c: any) => c.web?.uri)
      .map((c: any) => {
        const url: string = c.web.uri;
        const title: string = c.web.title || url;
        let source = url;
        try { source = new URL(url).hostname.replace('www.', ''); } catch {}
        return { title, url, source };
      });

    return { summary, items: newsItems };

  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error("Gemini News Error:", msg);
    const isAuth = msg.includes('401') || msg.includes('403') || msg.includes('API_KEY');
    const isQuota = msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED');
    const friendlyMsg = isAuth
      ? 'Gemini API key is invalid or unauthorized. Check your GEMINI_API_KEY.'
      : isQuota
      ? 'Gemini API quota reached. Please try again in a moment.'
      : `Unable to fetch news: ${msg}`;
    return { summary: friendlyMsg, items: [] };
  }
};