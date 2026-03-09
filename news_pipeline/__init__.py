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

from news_pipeline.ingest import ingest_articles
from news_pipeline.chunk import chunk_article
from news_pipeline.embed import embed_and_upsert
from news_pipeline.retrieve import retrieve_chunks, rag_answer
from news_pipeline.sentiment import classify_sentiment
from news_pipeline.entities import extract_entities

__all__ = [
    "ingest_articles",
    "chunk_article",
    "embed_and_upsert",
    "retrieve_chunks",
    "rag_answer",
    "classify_sentiment",
    "extract_entities",
]
