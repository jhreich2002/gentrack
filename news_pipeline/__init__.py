"""
news_pipeline — Additive news ingest, embedding, and RAG retrieval module
for the US Power Generation Capacity Factor Tracker (GenTrack).

Modules:
    ingest      Fetch articles via Gemini grounded search, deduplicate by URL hash.
    chunk       Split article text into ~500-token overlapping chunks.
    embed       Embed chunks with OpenAI / Gemini and upsert to Supabase pgvector.
    retrieve    Query the vector store by plant_id, lender_id, sentiment, or date.
    sentiment   Classify each article as positive / negative / neutral via LLM.
    entities    Extract plant names, owners, and lender/financier mentions.
"""

from news_pipeline.ingest import upsert_articles
from news_pipeline.sentiment import classify_sentiment

__all__ = [
    "upsert_articles",
    "classify_sentiment",
]
