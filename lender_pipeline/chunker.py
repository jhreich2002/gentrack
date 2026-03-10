"""
lender_pipeline.chunker — HTML strip + keyword-guided text chunking.

Fetches an EDGAR filing document, strips HTML markup, then extracts
3000-character windows around credit-agreement keywords rather than
sending the full document to the LLM (which could be 20MB).

Chunk budget: 15 chunks per document max (keeps Gemini costs negligible).
"""

from __future__ import annotations

import logging
import re

import httpx
from bs4 import BeautifulSoup

log = logging.getLogger("lender_ingest.chunker")

# ── Constants ─────────────────────────────────────────────────────────────────

MAX_DOC_BYTES  = 20 * 1024 * 1024   # 20 MB download cap
WINDOW_CHARS   = 3_000               # chars on each side of keyword hit
MERGE_OVERLAP  = 500                 # merge two windows if they overlap by this much
MAX_CHUNKS     = 15                  # per document
# For 8-K exhibits (actual credit agreements), also include the opening section
# where parties, amounts, and definitions are listed
EXHIBIT_HEAD   = 20_000             # chars from the start of the document

KEYWORDS = [
    "credit agreement",
    "term loan",
    "revolving credit",
    "revolver",
    "senior secured",
    "senior unsecured",
    "tax equity",
    "construction loan",
    "bridge loan",
    "mezzanine",
    "preferred equity",
    "project finance",
    "lender",
    "administrative agent",
    "interest rate",
    "maturity date",
    "sofr",
    "libor",
    "basis points",
    "debt service",
    "credit facility",
    "loan agreement",
    "note purchase",
    "indenture",
    "debt covenant",
]


# ── HTML fetch + strip ────────────────────────────────────────────────────────


def fetch_and_strip(url: str, client: httpx.Client) -> str:
    """
    Download a filing document (capped at MAX_DOC_BYTES) and strip HTML.
    Returns plain text. Returns empty string on any error.
    """
    try:
        with client.stream("GET", url, timeout=60) as resp:
            if resp.status_code != 200:
                log.warning("Document fetch HTTP %d: %s", resp.status_code, url)
                return ""

            content_type = resp.headers.get("content-type", "")
            chunks: list[bytes] = []
            total = 0
            for chunk in resp.iter_bytes(chunk_size=65_536):
                chunks.append(chunk)
                total += len(chunk)
                if total >= MAX_DOC_BYTES:
                    log.debug("Capped download at %d MB: %s", MAX_DOC_BYTES // 1024 // 1024, url)
                    break
            raw = b"".join(chunks)

    except Exception as exc:
        log.warning("Document fetch error (%s): %s", url, exc)
        return ""

    # Strip HTML if applicable
    if "html" in content_type or raw[:200].lower().strip().startswith(b"<"):
        try:
            soup = BeautifulSoup(raw, "html.parser")
            # Remove script/style noise
            for tag in soup(["script", "style", "head"]):
                tag.decompose()
            text = soup.get_text(separator=" ", strip=True)
        except Exception as exc:
            log.warning("HTML parse error: %s", exc)
            text = raw.decode("utf-8", errors="replace")
    else:
        text = raw.decode("utf-8", errors="replace")

    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ── Keyword-guided chunking ───────────────────────────────────────────────────


def _find_keyword_positions(text: str) -> list[int]:
    """Return all start positions where any keyword appears (case-insensitive)."""
    text_lower = text.lower()
    positions: list[int] = []
    for kw in KEYWORDS:
        start = 0
        while True:
            idx = text_lower.find(kw, start)
            if idx == -1:
                break
            positions.append(idx)
            start = idx + len(kw)
    return sorted(set(positions))


def _positions_to_windows(text: str, positions: list[int]) -> list[tuple[int, int]]:
    """Convert keyword positions to (start, end) character windows."""
    half = WINDOW_CHARS // 2
    windows: list[tuple[int, int]] = []
    for pos in positions:
        start = max(0, pos - half)
        end   = min(len(text), pos + half)
        windows.append((start, end))
    return windows


def _merge_windows(windows: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Merge overlapping or nearly-overlapping windows."""
    if not windows:
        return []
    merged = [windows[0]]
    for start, end in windows[1:]:
        prev_start, prev_end = merged[-1]
        if start <= prev_end + MERGE_OVERLAP:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _score_window(text: str, start: int, end: int) -> int:
    """Score a window by keyword density (used to rank when >MAX_CHUNKS)."""
    snippet = text[start:end].lower()
    return sum(snippet.count(kw) for kw in KEYWORDS)


def extract_chunks(
    text: str,
    is_exhibit: bool = False,
) -> list[str]:
    """
    Extract up to MAX_CHUNKS text windows from a document.

    For 8-K credit agreement exhibits, also includes the opening EXHIBIT_HEAD
    characters (lenders and amounts are always defined near the top).

    Returns a list of text strings ready to send to Gemini.
    """
    if not text:
        return []

    positions = _find_keyword_positions(text)
    if not positions:
        # No keywords found — if it's an exhibit, still return the header
        if is_exhibit:
            return [text[:EXHIBIT_HEAD]]
        return []

    windows = _positions_to_windows(text, positions)
    windows = _merge_windows(windows)

    # If exhibit: prepend the opening section as its own window
    if is_exhibit:
        head_end = min(EXHIBIT_HEAD, len(text))
        windows = [(0, head_end)] + windows

    # If too many windows, rank by keyword density
    if len(windows) > MAX_CHUNKS:
        scored = sorted(windows, key=lambda w: _score_window(text, w[0], w[1]), reverse=True)
        windows = sorted(scored[:MAX_CHUNKS], key=lambda w: w[0])

    chunks = [text[start:end].strip() for start, end in windows]
    log.debug("Extracted %d chunks from %d keyword positions", len(chunks), len(positions))
    return chunks
