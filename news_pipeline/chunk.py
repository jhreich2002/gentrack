"""
news_pipeline.chunk — Split article text into ~500-token overlapping chunks
with plant-specific and lender-specific metadata attached to each chunk.

Each chunk carries forward all article-level metadata so the vector store
can filter by plant_id, lender_id, sentiment, etc. at query time.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any


# ── Config ────────────────────────────────────────────────────────────────────

TARGET_CHUNK_TOKENS = 500       # approximate target size per chunk
OVERLAP_TOKENS = 75             # overlap between consecutive chunks
CHARS_PER_TOKEN = 4             # rough English approximation


# ── Data class ────────────────────────────────────────────────────────────────


@dataclass
class ArticleChunk:
    """A single chunk of article text with full metadata for vector storage."""

    chunk_id: str                            # UUID
    chunk_index: int                         # 0-based position within article
    chunk_text: str                          # the actual text slice
    article_url: str
    article_hash: str                        # SHA-256 dedup key
    plant_id: str
    owner: str
    lenders: list[str] = field(default_factory=list)
    lender_ids: list[str] = field(default_factory=list)
    published_date: str = ""
    sentiment: str = "neutral"
    sentiment_score: float = 0.5
    source: str = ""
    title: str = ""

    def to_metadata(self) -> dict[str, Any]:
        """Return a dict suitable for storing alongside the embedding vector."""
        return {
            "chunk_id": self.chunk_id,
            "chunk_index": self.chunk_index,
            "article_url": self.article_url,
            "article_hash": self.article_hash,
            "plant_id": self.plant_id,
            "owner": self.owner,
            "lenders": self.lenders,
            "lender_ids": self.lender_ids,
            "published_date": self.published_date,
            "sentiment": self.sentiment,
            "sentiment_score": self.sentiment_score,
            "source": self.source,
            "title": self.title,
            "chunk_text": self.chunk_text,
        }


# ── Chunking logic ───────────────────────────────────────────────────────────


def _estimate_tokens(text: str) -> int:
    """Estimate token count from character length (English heuristic)."""
    return max(1, len(text) // CHARS_PER_TOKEN)


def _split_into_segments(
    text: str,
    target_tokens: int = TARGET_CHUNK_TOKENS,
    overlap_tokens: int = OVERLAP_TOKENS,
) -> list[str]:
    """Split *text* into overlapping segments of roughly *target_tokens* tokens.

    The splitter tries to break on sentence boundaries ('. ', '\\n') when
    possible to keep chunks semantically coherent.  If the entire text fits
    in a single chunk it is returned as-is.
    """
    target_chars = target_tokens * CHARS_PER_TOKEN
    overlap_chars = overlap_tokens * CHARS_PER_TOKEN

    if len(text) <= target_chars:
        return [text.strip()] if text.strip() else []

    segments: list[str] = []
    start = 0

    while start < len(text):
        end = start + target_chars

        if end >= len(text):
            # Last chunk — take everything remaining
            segment = text[start:].strip()
            if segment:
                segments.append(segment)
            break

        # Try to break on a sentence boundary within the last 20 % of the window
        search_start = max(start, end - target_chars // 5)
        best_break = -1

        for delimiter in [". ", ".\n", "\n\n", "\n", "; ", ", "]:
            idx = text.rfind(delimiter, search_start, end)
            if idx != -1:
                best_break = idx + len(delimiter)
                break

        if best_break <= start:
            # No good boundary — hard split at target
            best_break = end

        segment = text[start:best_break].strip()
        if segment:
            segments.append(segment)

        # Move forward, keeping overlap
        start = max(start + 1, best_break - overlap_chars)

    return segments


def chunk_article(
    text: str,
    *,
    article_url: str = "",
    article_hash: str = "",
    plant_id: str = "",
    owner: str = "",
    lenders: list[str] | None = None,
    lender_ids: list[str] | None = None,
    published_date: str = "",
    sentiment: str = "neutral",
    sentiment_score: float = 0.5,
    source: str = "",
    title: str = "",
    target_tokens: int = TARGET_CHUNK_TOKENS,
    overlap_tokens: int = OVERLAP_TOKENS,
) -> list[ArticleChunk]:
    """Split an article's text into overlapping chunks with metadata.

    Args:
        text:            Full article body (or description if body unavailable).
        article_url:     Original article URL.
        article_hash:    SHA-256 hash of the URL (dedup key).
        plant_id:        EIA plant code linking to generation/ownership data.
        owner:           Plant owner / operator name.
        lenders:         List of lender / financier names extracted from article.
        lender_ids:      Matched lender IDs from the known-lenders list.
        published_date:  ISO date string (YYYY-MM-DD).
        sentiment:       positive | negative | neutral.
        sentiment_score: Confidence float 0.0–1.0.
        source:          Publication name.
        title:           Article headline.
        target_tokens:   Approximate chunk size in tokens (default 500).
        overlap_tokens:  Overlap between chunks in tokens (default 75).

    Returns:
        A list of ArticleChunk objects, each with a unique chunk_id (UUID).
    """
    if not text or not text.strip():
        return []

    segments = _split_into_segments(text, target_tokens, overlap_tokens)
    lenders = lenders or []
    lender_ids = lender_ids or []

    chunks: list[ArticleChunk] = []
    for idx, segment in enumerate(segments):
        chunks.append(
            ArticleChunk(
                chunk_id=str(uuid.uuid4()),
                chunk_index=idx,
                chunk_text=segment,
                article_url=article_url,
                article_hash=article_hash,
                plant_id=plant_id,
                owner=owner,
                lenders=list(lenders),
                lender_ids=list(lender_ids),
                published_date=published_date,
                sentiment=sentiment,
                sentiment_score=sentiment_score,
                source=source,
                title=title,
            )
        )

    return chunks
