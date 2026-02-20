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
 * Searches for recent news and operational updates for a specific power plant using Google Search grounding.
 */
export const getPlantNews = async (plant: PowerPlant): Promise<NewsAnalysis> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const prompt = `Search for recent news, operational updates, maintenance reports, or curtailment issues related to the power plant: "${plant.name}" owned by "${plant.owner}" in the "${plant.region}" region. Provide a concise 2-3 sentence summary of the current situation.`;
  
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const summary = response.text || "No specific recent news summary found.";
    
    // Extract URLs from grounding metadata and format for display
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const newsItems: NewsItem[] = groundingChunks
      .filter(chunk => chunk.web)
      .map(chunk => ({
        title: chunk.web.title || "Source Reference",
        url: chunk.web.uri,
        source: new URL(chunk.web.uri).hostname.replace('www.', '')
      }));

    // Deduplicate by URL
    const uniqueItems = Array.from(new Map(newsItems.map(item => [item.url, item])).values());

    return {
      summary,
      items: uniqueItems
    };
  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error("Gemini News Error:", msg);
    // Surface quota/auth errors clearly
    const isQuota = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
    const isAuth = msg.includes('401') || msg.includes('API_KEY') || msg.includes('INVALID');
    const friendlyMsg = isQuota
      ? 'Gemini API quota exceeded. The free tier limit has been reached — please check your API key quota at https://aistudio.google.com/apikey or try again later.'
      : isAuth
      ? 'Gemini API key is invalid or not authorized. Please check your GEMINI_API_KEY in .env.local.'
      : `Unable to fetch news: ${msg}`;
    return {
      summary: friendlyMsg,
      items: []
    };
  }
};