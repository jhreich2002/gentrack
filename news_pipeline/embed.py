"""
news_pipeline.embed — Embed article chunks and upsert to Supabase pgvector.

Supports two embedding backends (selected via EMBEDDING_PROVIDER env var):
    • "openai"  — text-embedding-3-small  (1536 dims, default)
    • "gemini"  — models/text-embedding-004 (768 dims)

Before embedding, each chunk is checked against the vector store by its
article_hash + chunk_index to skip duplicates — the embedding DB is
cumulative and grows over time as new articles come in.

Environment variables (assumed already set):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    OPENAI_API_KEY          (if using OpenAI embeddings)
    GEMINI_API_KEY          (if using Gemini embeddings)
    EMBEDDING_PROVIDER      (optional — "openai" or "gemini", default "openai")
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx
from supabase import create_client, Client

from news_pipeline.chunk import ArticleChunk

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

EMBEDDING_TABLE = "news_embeddings"    # pgvector table name
UPSERT_BATCH_SIZE = 50
RATE_LIMIT_SECONDS = 0.25              # pause between embedding API calls

# OpenAI
OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings"
OPENAI_MODEL = "text-embedding-3-small"
OPENAI_DIMS = 1536

# Gemini
GEMINI_EMBED_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-embedding-001:embedContent"
)
GEMINI_DIMS = 3072


# ── Helpers ───────────────────────────────────────────────────────────────────


def _get_supabase() -> Client:
    """Build a Supabase client from environment variables."""
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


def _provider() -> str:
    """Return the active embedding provider (openai | gemini)."""
    return os.environ.get("EMBEDDING_PROVIDER", "openai").lower()


# ── Embedding backends ───────────────────────────────────────────────────────


def _embed_openai(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts using OpenAI text-embedding-3-small.

    Returns one 1536-dim vector per input text.
    """
    api_key = os.environ["OPENAI_API_KEY"]
    resp = httpx.post(
        OPENAI_EMBED_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        json={"input": texts, "model": OPENAI_MODEL},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    # Sort by index to preserve ordering
    items = sorted(data["data"], key=lambda x: x["index"])
    return [item["embedding"] for item in items]


def _embed_gemini(texts: list[str]) -> list[list[float]]:
    """Embed texts one-at-a-time using Gemini text-embedding-004.

    Gemini's embedContent endpoint takes a single text per call, so we
    loop and rate-limit.  Returns one 768-dim vector per input text.
    """
    api_key = os.environ["GEMINI_API_KEY"]
    vectors: list[list[float]] = []

    for text in texts:
        resp = httpx.post(
            f"{GEMINI_EMBED_URL}?key={api_key}",
            json={"content": {"parts": [{"text": text}]}},
            timeout=30,
        )
        resp.raise_for_status()
        embedding = resp.json()["embedding"]["values"]
        vectors.append(embedding)
        time.sleep(RATE_LIMIT_SECONDS)

    return vectors


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a list of texts using the configured provider.

    Returns one vector per input text.
    """
    if not texts:
        return []

    provider = _provider()
    if provider == "gemini":
        return _embed_gemini(texts)
    else:
        return _embed_openai(texts)


# ── Dedup check ──────────────────────────────────────────────────────────────


def _existing_chunk_keys(sb: Client, keys: list[str]) -> set[str]:
    """Return the subset of composite keys (article_hash:chunk_index) already stored."""
    if not keys:
        return set()
    resp = (
        sb.table(EMBEDDING_TABLE)
        .select("chunk_id")
        .in_("chunk_id", keys)
        .execute()
    )
    return {row["chunk_id"] for row in (resp.data or [])}


# ── Public API ───────────────────────────────────────────────────────────────


def embed_and_upsert(
    chunks: list[ArticleChunk],
    *,
    skip_existing: bool = True,
    batch_size: int = UPSERT_BATCH_SIZE,
) -> int:
    """Embed a list of ArticleChunks and upsert to the vector DB.

    Deduplicates by chunk_id before embedding so we never re-embed the same
    chunk twice.  The embedding DB is cumulative — only new chunks are added.

    Args:
        chunks:         List of ArticleChunk objects (from chunk.py).
        skip_existing:  If True, check the DB and skip chunks that already exist.
        batch_size:     Number of rows per Supabase upsert call.

    Returns:
        The count of newly inserted chunks.
    """
    if not chunks:
        return 0

    sb = _get_supabase()

    # ── Deduplicate ──────────────────────────────────────────────────────
    if skip_existing:
        all_ids = [c.chunk_id for c in chunks]
        existing = _existing_chunk_keys(sb, all_ids)
        new_chunks = [c for c in chunks if c.chunk_id not in existing]
    else:
        new_chunks = list(chunks)

    if not new_chunks:
        logger.info("All %d chunks already exist — nothing to embed.", len(chunks))
        return 0

    logger.info(
        "Embedding %d new chunks (%d skipped as duplicates)",
        len(new_chunks),
        len(chunks) - len(new_chunks),
    )

    # ── Embed ───────────────────────────────────────────────────────────
    texts = [c.chunk_text for c in new_chunks]
    vectors = embed_texts(texts)

    if len(vectors) != len(new_chunks):
        logger.error(
            "Embedding count mismatch: %d texts → %d vectors",
            len(texts),
            len(vectors),
        )
        return 0

    # ── Upsert in batches ───────────────────────────────────────────────
    inserted = 0
    for i in range(0, len(new_chunks), batch_size):
        batch_chunks = new_chunks[i : i + batch_size]
        batch_vectors = vectors[i : i + batch_size]

        rows = []
        for chunk, vec in zip(batch_chunks, batch_vectors):
            meta = chunk.to_metadata()
            rows.append(
                {
                    "chunk_id": chunk.chunk_id,
                    "article_hash": chunk.article_hash,
                    "article_url": chunk.article_url,
                    "plant_id": chunk.plant_id,
                    "owner": chunk.owner,
                    "lenders": chunk.lenders,
                    "lender_ids": chunk.lender_ids,
                    "published_date": chunk.published_date,
                    "sentiment": chunk.sentiment,
                    "sentiment_score": chunk.sentiment_score,
                    "chunk_text": chunk.chunk_text,
                    "chunk_index": chunk.chunk_index,
                    "title": chunk.title,
                    "source": chunk.source,
                    "embedding": vec,
                }
            )

        result = (
            sb.table(EMBEDDING_TABLE)
            .upsert(rows, on_conflict="chunk_id", ignore_duplicates=True)
            .execute()
        )

        if hasattr(result, "error") and result.error:
            logger.error("Upsert batch error: %s", result.error)
        else:
            inserted += len(batch_chunks)
            logger.debug("Upserted batch %d–%d", i, i + len(batch_chunks))

    logger.info("✅ Embedded and stored %d new chunks", inserted)
    return inserted
