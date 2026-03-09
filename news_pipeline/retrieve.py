"""
news_pipeline.retrieve — Query the vector store by plant_id, lender_id,
sentiment, or date range, and build grounded LLM answers (RAG).

The module provides two levels of API:
    retrieve_chunks()  — pure vector search with metadata filters
    rag_answer()       — full Retrieval-Augmented Generation pipeline

RAG flow:
    1. Filter vectors by plant_id / lender_id / sentiment / date range
    2. Embed the user query
    3. Retrieve top-k most similar chunks (cosine similarity via pgvector)
    4. Inject chunks into a system prompt that forbids hallucination
    5. Call the LLM and return the grounded answer

Environment variables (assumed already set):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    GEMINI_API_KEY
    OPENAI_API_KEY          (optional — used only when EMBEDDING_PROVIDER=openai)
    EMBEDDING_PROVIDER      (optional — "openai" or "gemini", default "openai")
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any

import httpx
from supabase import create_client, Client

from news_pipeline.embed import embed_texts

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

EMBEDDING_TABLE = "news_embeddings"
DEFAULT_TOP_K = 10
GEMINI_GEN_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)

RAG_SYSTEM_PROMPT = (
    "Answer only using the following news context. If the answer is not "
    "in the context, say you don't know. Do not use outside knowledge.\n\n"
    "### NEWS CONTEXT ###\n{context}\n### END CONTEXT ###"
)


# ── Data class ────────────────────────────────────────────────────────────────


@dataclass
class RetrievedChunk:
    """A chunk returned from the vector similarity search."""

    chunk_id: str
    chunk_text: str
    similarity: float
    article_url: str
    article_hash: str
    plant_id: str
    owner: str
    lenders: list[str] = field(default_factory=list)
    lender_ids: list[str] = field(default_factory=list)
    published_date: str = ""
    sentiment: str = "neutral"
    sentiment_score: float = 0.5
    title: str = ""
    source: str = ""


# ── Helpers ───────────────────────────────────────────────────────────────────


def _get_supabase() -> Client:
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


# ── Vector retrieval ─────────────────────────────────────────────────────────


def retrieve_chunks(
    query: str,
    *,
    plant_id: str | None = None,
    lender_id: str | None = None,
    sentiment: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    top_k: int = DEFAULT_TOP_K,
) -> list[RetrievedChunk]:
    """Search the vector store for chunks most similar to *query*.

    Supports optional metadata filters so callers can scope results to a
    specific plant, lender, sentiment, or date range before the similarity
    ranking is applied.

    Args:
        query:      Natural-language query text.
        plant_id:   Filter to chunks from this EIA plant code.
        lender_id:  Filter to chunks mentioning this lender ID.
        sentiment:  Filter by sentiment label (positive | negative | neutral).
        date_from:  ISO date string — only chunks published on or after this date.
        date_to:    ISO date string — only chunks published on or before this date.
        top_k:      Maximum number of chunks to return (default 10).

    Returns:
        A list of RetrievedChunk objects sorted by descending similarity.
    """
    # Embed the query
    vectors = embed_texts([query])
    if not vectors:
        logger.error("Failed to embed query")
        return []
    query_vec = vectors[0]

    sb = _get_supabase()

    # Build the RPC call — we use a Postgres function for cosine similarity.
    # If the RPC doesn't exist yet, fall back to a manual approach.
    try:
        return _rpc_search(sb, query_vec, plant_id, lender_id, sentiment, date_from, date_to, top_k)
    except Exception as e:
        logger.warning("RPC search failed (%s), falling back to client-side ranking", e)
        return _client_search(sb, query_vec, plant_id, lender_id, sentiment, date_from, date_to, top_k)


def _rpc_search(
    sb: Client,
    query_vec: list[float],
    plant_id: str | None,
    lender_id: str | None,
    sentiment: str | None,
    date_from: str | None,
    date_to: str | None,
    top_k: int,
) -> list[RetrievedChunk]:
    """Use the match_news_embeddings Postgres RPC for server-side cosine search."""
    params: dict[str, Any] = {
        "query_embedding": query_vec,
        "match_count": top_k,
    }
    if plant_id:
        params["filter_plant_id"] = plant_id
    if lender_id:
        params["filter_lender_id"] = lender_id
    if sentiment:
        params["filter_sentiment"] = sentiment
    if date_from:
        params["filter_date_from"] = date_from
    if date_to:
        params["filter_date_to"] = date_to

    resp = sb.rpc("match_news_embeddings", params).execute()

    results: list[RetrievedChunk] = []
    for row in resp.data or []:
        results.append(
            RetrievedChunk(
                chunk_id=row["chunk_id"],
                chunk_text=row["chunk_text"],
                similarity=row.get("similarity", 0.0),
                article_url=row.get("article_url", ""),
                article_hash=row.get("article_hash", ""),
                plant_id=row.get("plant_id", ""),
                owner=row.get("owner", ""),
                lenders=row.get("lenders", []),
                lender_ids=row.get("lender_ids", []),
                published_date=row.get("published_date", ""),
                sentiment=row.get("sentiment", "neutral"),
                sentiment_score=row.get("sentiment_score", 0.5),
                title=row.get("title", ""),
                source=row.get("source", ""),
            )
        )
    return results


def _client_search(
    sb: Client,
    query_vec: list[float],
    plant_id: str | None,
    lender_id: str | None,
    sentiment: str | None,
    date_from: str | None,
    date_to: str | None,
    top_k: int,
) -> list[RetrievedChunk]:
    """Fallback: fetch filtered rows and compute cosine similarity client-side."""
    q = sb.table(EMBEDDING_TABLE).select("*")

    if plant_id:
        q = q.eq("plant_id", plant_id)
    if sentiment:
        q = q.eq("sentiment", sentiment)
    if date_from:
        q = q.gte("published_date", date_from)
    if date_to:
        q = q.lte("published_date", date_to)

    # Supabase PostgREST doesn't natively support array-contains for lender_ids,
    # so we fetch broader and filter client-side.
    resp = q.limit(top_k * 5).execute()
    rows = resp.data or []

    if lender_id:
        rows = [r for r in rows if lender_id in (r.get("lender_ids") or [])]

    # Compute cosine similarity
    import math

    def _cosine(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(y * y for y in b))
        return dot / (na * nb) if na and nb else 0.0

    scored = []
    for row in rows:
        vec = row.get("embedding")
        if not vec:
            continue
        sim = _cosine(query_vec, vec)
        scored.append((sim, row))

    scored.sort(key=lambda x: x[0], reverse=True)

    results: list[RetrievedChunk] = []
    for sim, row in scored[:top_k]:
        results.append(
            RetrievedChunk(
                chunk_id=row.get("chunk_id", ""),
                chunk_text=row.get("chunk_text", ""),
                similarity=sim,
                article_url=row.get("article_url", ""),
                article_hash=row.get("article_hash", ""),
                plant_id=row.get("plant_id", ""),
                owner=row.get("owner", ""),
                lenders=row.get("lenders", []),
                lender_ids=row.get("lender_ids", []),
                published_date=row.get("published_date", ""),
                sentiment=row.get("sentiment", "neutral"),
                sentiment_score=row.get("sentiment_score", 0.5),
                title=row.get("title", ""),
                source=row.get("source", ""),
            )
        )
    return results


# ── RAG answer ───────────────────────────────────────────────────────────────


def rag_answer(
    question: str,
    *,
    plant_id: str | None = None,
    lender_id: str | None = None,
    sentiment: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    top_k: int = DEFAULT_TOP_K,
    system_prompt: str = RAG_SYSTEM_PROMPT,
) -> dict[str, Any]:
    """Answer a question using Retrieval-Augmented Generation.

    Fixes LLM hallucinations by grounding answers in retrieved news chunks:
        1. Filter + embed the user question
        2. Retrieve top-k most similar chunks
        3. Build a context block from the chunks
        4. Inject context into a strict system prompt
        5. Call Gemini with the grounded prompt
        6. Return the answer, retrieved chunks, and source URLs

    Args:
        question:       The user's natural-language question.
        plant_id:       Scope to a specific plant (EIA plant code).
        lender_id:      Scope to a specific lender.
        sentiment:      Filter by sentiment label.
        date_from:      ISO date lower bound.
        date_to:        ISO date upper bound.
        top_k:          Max chunks to retrieve (default 10).
        system_prompt:  Override the default RAG system prompt.

    Returns:
        A dict with keys: answer, sources (list of URLs), chunks (raw data).
    """

    # 1–3: Retrieve relevant chunks
    chunks = retrieve_chunks(
        question,
        plant_id=plant_id,
        lender_id=lender_id,
        sentiment=sentiment,
        date_from=date_from,
        date_to=date_to,
        top_k=top_k,
    )

    if not chunks:
        return {
            "answer": "I don't have enough news context to answer that question.",
            "sources": [],
            "chunks": [],
        }

    # Build context block
    context_parts: list[str] = []
    seen_urls: set[str] = set()
    for c in chunks:
        header = f"[{c.source} — {c.published_date}] {c.title}"
        context_parts.append(f"{header}\n{c.chunk_text}")
        if c.article_url:
            seen_urls.add(c.article_url)

    context_text = "\n\n---\n\n".join(context_parts)

    # 4: Build the grounded prompt
    filled_system = system_prompt.format(context=context_text)

    # 5: Call Gemini
    api_key = os.environ["GEMINI_API_KEY"]
    body = {
        "contents": [
            {"role": "user", "parts": [{"text": question}]},
        ],
        "systemInstruction": {"parts": [{"text": filled_system}]},
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
    }

    resp = httpx.post(
        f"{GEMINI_GEN_URL}?key={api_key}",
        json=body,
        timeout=60,
    )

    if resp.status_code != 200:
        logger.error("Gemini generation error: HTTP %s", resp.status_code)
        return {
            "answer": "Failed to generate an answer. Please try again.",
            "sources": list(seen_urls),
            "chunks": [c.__dict__ for c in chunks],
        }

    data = resp.json()
    answer_text = (
        (data.get("candidates") or [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
    )

    return {
        "answer": answer_text.strip(),
        "sources": sorted(seen_urls),
        "chunks": [
            {
                "chunk_id": c.chunk_id,
                "title": c.title,
                "source": c.source,
                "published_date": c.published_date,
                "similarity": round(c.similarity, 4),
                "sentiment": c.sentiment,
                "plant_id": c.plant_id,
                "article_url": c.article_url,
            }
            for c in chunks
        ],
    }


# ── Convenience query helpers ────────────────────────────────────────────────


def negative_news_for_plant(plant_id: str, *, top_k: int = 10) -> list[RetrievedChunk]:
    """All negative news for a specific plant_id."""
    return retrieve_chunks(
        f"negative news risks problems issues",
        plant_id=plant_id,
        sentiment="negative",
        top_k=top_k,
    )


def news_for_lender(lender_id: str, *, top_k: int = 20) -> list[RetrievedChunk]:
    """All news mentioning a specific lender across any plant."""
    return retrieve_chunks(
        f"lender financier bank credit",
        lender_id=lender_id,
        top_k=top_k,
    )


def lender_sentiment_summary(lender_id: str) -> dict[str, Any]:
    """Sentiment summary across a lender's entire portfolio of projects.

    Returns counts and lists of positive / negative / neutral chunks for the lender.
    """
    all_chunks = retrieve_chunks(
        "lender portfolio risk performance",
        lender_id=lender_id,
        top_k=50,
    )

    summary: dict[str, list[RetrievedChunk]] = {
        "positive": [],
        "negative": [],
        "neutral": [],
    }
    for c in all_chunks:
        bucket = c.sentiment if c.sentiment in summary else "neutral"
        summary[bucket].append(c)

    return {
        "lender_id": lender_id,
        "total_chunks": len(all_chunks),
        "positive_count": len(summary["positive"]),
        "negative_count": len(summary["negative"]),
        "neutral_count": len(summary["neutral"]),
        "negative_articles": sorted(
            {c.article_url for c in summary["negative"]}
        ),
        "positive_articles": sorted(
            {c.article_url for c in summary["positive"]}
        ),
    }


def recent_negative_for_owner(
    owner: str,
    *,
    date_from: str | None = None,
    top_k: int = 20,
) -> list[RetrievedChunk]:
    """Recent negative signals for a specific owner across all their plants."""
    return retrieve_chunks(
        f"negative risks problems {owner}",
        sentiment="negative",
        date_from=date_from,
        top_k=top_k,
    )
