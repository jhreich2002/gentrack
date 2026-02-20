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
 * using Perplexity's sonar model (live web search with citations).
 */
export const getPlantNews = async (plant: PowerPlant): Promise<NewsAnalysis> => {
  const apiKey = process.env.PERPLEXITY_API_KEY;

  if (!apiKey) {
    return {
      summary: "Perplexity API key is not configured. Add PERPLEXITY_API_KEY to your .env.local file.",
      items: []
    };
  }

  const prompt = `Find recent news, operational updates, maintenance events, outages, or regulatory filings for the power plant "${plant.name}" (EIA plant code ${plant.eiaPlantCode}), owned by "${plant.owner}", located in ${plant.county ? `${plant.county} county, ` : ''}${plant.location.state}. Write a 2-3 sentence summary of the most relevant recent developments. Be specific and factual.`;

  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'You are an expert energy analyst. Provide concise, factual summaries about power plant operations, maintenance, and news. Focus on recent events from the past 12 months.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2,
        return_citations: true,
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content || "No recent information found for this plant.";

    // Perplexity returns citations as an array of URL strings
    const citationUrls: string[] = data.citations || [];
    const newsItems: NewsItem[] = citationUrls.map(url => {
      let host = url;
      try { host = new URL(url).hostname.replace('www.', ''); } catch {}
      return { title: host, url, source: host };
    });

    return { summary, items: newsItems };

  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error("Perplexity News Error:", msg);
    const isAuth = msg.includes('401') || msg.includes('403');
    const isQuota = msg.includes('429') || msg.includes('quota') || msg.includes('rate');
    const friendlyMsg = isAuth
      ? 'Perplexity API key is invalid or unauthorized. Check your PERPLEXITY_API_KEY.'
      : isQuota
      ? 'Perplexity API rate limit reached. Please try again in a moment.'
      : `Unable to fetch news: ${msg}`;
    return { summary: friendlyMsg, items: [] };
  }
};