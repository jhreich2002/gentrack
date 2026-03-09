"""
news_pipeline.ingest — Fetch articles via Gemini grounded search, deduplicate
by URL hash, run sentiment + entity extraction, then store to Supabase.

Environment variables (assumed already set):
    GEMINI_API_KEY
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Any

import httpx
from supabase import create_client, Client

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)

ARTICLES_PER_PLANT = 8          # request more; filter to verified subset
MAX_VERIFIED_PER_PLANT = 3
RATE_LIMIT_SECONDS = 1.5
HEAD_TIMEOUT_SECONDS = 8

BAD_DOMAINS = [
    "example.com",
    "vertexaisearch.cloud.google.com",
    "news.google.com/rss",
    "google.com/search",
    "govinfo.gov",
    "federalregister.gov",
]

NEWS_TABLE = "news_articles"

# ── Data classes ──────────────────────────────────────────────────────────────


@dataclass
class RawArticle:
    """A single article returned by the Gemini grounded search step."""

    title: str
    url: str
    source: str
    published_date: str
    description: str = ""
    full_text: str = ""


@dataclass
class EnrichedArticle:
    """Article after sentiment + entity enrichment, ready for storage."""

    title: str
    url: str
    url_hash: str
    source: str
    published_date: str
    description: str = ""
    full_text: str = ""
    plant_id: str = ""
    owner: str = ""
    lenders: list[str] = field(default_factory=list)
    lender_ids: list[str] = field(default_factory=list)
    sentiment: str = "neutral"
    sentiment_score: float = 0.5
    sentiment_reason: str = ""
    event_type: str = "none"
    importance: str = "medium"


# ── Helpers ───────────────────────────────────────────────────────────────────


def _url_hash(url: str) -> str:
    """Return a 32-char hex SHA-256 digest of the URL for dedup."""
    return hashlib.sha256(url.encode()).hexdigest()[:32]


def _is_bad_domain(url: str) -> bool:
    """Return True if *url* matches any entry in the BAD_DOMAINS blocklist."""
    return any(domain in url for domain in BAD_DOMAINS)


def _get_supabase() -> Client:
    """Build a Supabase client from environment variables."""
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _is_url_live(url: str, *, timeout: float = HEAD_TIMEOUT_SECONDS) -> bool:
    """Send a HEAD request; return True if the URL responds 2xx/3xx."""
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=timeout,
            headers={"User-Agent": "Mozilla/5.0 (compatible; GenTrack/1.0)"},
        ) as client:
            r = client.head(url)
            return 200 <= r.status_code < 400
    except Exception:
        return False


# ── Gemini grounded search ────────────────────────────────────────────────────


def _gemini_grounded_search(
    plant_name: str,
    state: str,
    fuel_type: str,
    owner: str,
    api_key: str,
) -> list[RawArticle]:
    """Call Gemini with google_search grounding to discover real articles.

    Returns up to *ARTICLES_PER_PLANT* candidate RawArticles extracted from
    both the LLM JSON response and the grounding metadata chunks.
    """

    prompt = (
        f'Find {ARTICLES_PER_PLANT} recent real news articles about '
        f'"{plant_name}" power plant in {state}. '
        f'This is a {fuel_type} power plant owned by {owner or "unknown"}.\n\n'
        "IMPORTANT: Only include articles from reputable news websites "
        "(e.g. Reuters, Bloomberg, Utility Dive, Power Engineering, "
        "local newspapers, AP News, ans.org). Each URL must be a direct "
        "link to an actual published article page — NOT a search page, "
        "government database, or directory listing.\n\n"
        "Return ONLY a JSON array with these exact fields for each article:\n"
        "- title: the article headline\n"
        "- url: the direct link to the article\n"
        "- source: the publication name\n"
        "- publishedAt: publication date in ISO format (YYYY-MM-DD)\n"
        "- description: 1-sentence summary\n\n"
        "Return JSON array only, no other text."
    )

    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {"temperature": 0.1},
    }

    # Retry up to 2 times with increasing timeout
    resp = None
    for attempt, t in enumerate([120, 180], 1):
        try:
            resp = httpx.post(
                f"{GEMINI_URL}?key={api_key}",
                json=body,
                timeout=t,
            )
            break
        except httpx.ReadTimeout:
            logger.warning("Gemini timeout (attempt %d, %ds) for %s", attempt, t, plant_name)
            if attempt == 2:
                logger.error("Gemini grounded search failed after retries for %s", plant_name)
                return []

    if resp is None or resp.status_code != 200:
        logger.error("Gemini HTTP %s: %s", getattr(resp, 'status_code', '?'), getattr(resp, 'text', '')[:300])
        return []

    data = resp.json()
    candidate = (data.get("candidates") or [{}])[0]
    text: str = (candidate.get("content", {}).get("parts") or [{}])[0].get("text", "")

    # Grounding metadata — Google's own verified URLs
    grounding_chunks = (
        candidate.get("groundingMetadata", {}).get("groundingChunks") or []
    )

    candidates: list[RawArticle] = []
    seen_urls: set[str] = set()

    # 1) Parse LLM JSON
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1:
        try:
            items = json.loads(text[start : end + 1])
            for item in items:
                url = str(item.get("url", "")).strip()
                if (
                    url
                    and url.startswith("http")
                    and not _is_bad_domain(url)
                    and url not in seen_urls
                ):
                    seen_urls.add(url)
                    candidates.append(
                        RawArticle(
                            title=str(item.get("title", "")).strip(),
                            url=url,
                            source=str(item.get("source", "Unknown")).strip(),
                            published_date=item.get(
                                "publishedAt",
                                "",
                            ),
                            description=str(item.get("description", "")).strip(),
                        )
                    )
        except json.JSONDecodeError:
            logger.warning("Failed to parse Gemini JSON for %s", plant_name)

    # 2) Merge grounding metadata URLs
    for chunk in grounding_chunks:
        web = chunk.get("web", {})
        uri = web.get("uri", "")
        title = web.get("title", "")
        if uri and not _is_bad_domain(uri) and uri not in seen_urls:
            seen_urls.add(uri)
            from urllib.parse import urlparse

            hostname = urlparse(uri).hostname or ""
            candidates.append(
                RawArticle(
                    title=title,
                    url=uri,
                    source=hostname.removeprefix("www."),
                    published_date="",
                )
            )

    return candidates


def _verify_urls(candidates: list[RawArticle]) -> list[RawArticle]:
    """HEAD-check each URL and keep the first *MAX_VERIFIED_PER_PLANT* that are live."""
    verified: list[RawArticle] = []
    for article in candidates:
        if len(verified) >= MAX_VERIFIED_PER_PLANT:
            break
        if _is_url_live(article.url):
            logger.debug("  ✓ LIVE  %s", article.url)
            verified.append(article)
        else:
            logger.debug("  ✗ DEAD  %s", article.url)
    return verified


# ── Deduplication ─────────────────────────────────────────────────────────────


def _existing_hashes(sb: Client, hashes: list[str]) -> set[str]:
    """Return the subset of *hashes* that already exist in the DB."""
    if not hashes:
        return set()
    resp = (
        sb.table(NEWS_TABLE)
        .select("external_id")
        .in_("external_id", hashes)
        .execute()
    )
    return {row["external_id"] for row in (resp.data or [])}


# ── Public API ────────────────────────────────────────────────────────────────


def ingest_articles(
    plants: list[dict[str, Any]],
    *,
    verify_urls: bool = True,
    skip_existing: bool = True,
) -> list[EnrichedArticle]:
    """Fetch, verify, enrich, deduplicate, and store articles for a list of plants.

    Each entry in *plants* should be a dict with at least:
        eia_plant_code, name, state, fuel_source, owner

    Workflow per plant:
        1. Gemini grounded search → candidate articles
        2. URL liveness verification (HEAD check)
        3. Deduplication against existing DB rows via URL hash
        4. Sentiment classification  (news_pipeline.sentiment)
        5. Entity extraction         (news_pipeline.entities)
        6. Upsert to Supabase news_articles table

    Returns the list of newly inserted EnrichedArticle objects.
    """

    from news_pipeline.sentiment import classify_sentiment
    from news_pipeline.entities import extract_entities

    api_key = os.environ["GEMINI_API_KEY"]
    sb = _get_supabase()

    all_new: list[EnrichedArticle] = []

    for plant in plants:
        plant_code = plant["eia_plant_code"]
        plant_name = plant["name"]
        state = plant.get("state", "")
        fuel = plant.get("fuel_source", "")
        owner = plant.get("owner", "")

        logger.info("📡 %s (%s, %s)", plant_name, state, fuel)

        # 1 — Discover articles via Gemini grounded search
        try:
            candidates = _gemini_grounded_search(plant_name, state, fuel, owner, api_key)
        except Exception as exc:
            logger.error("Grounded search failed for %s: %s", plant_name, exc)
            time.sleep(RATE_LIMIT_SECONDS)
            continue

        # 2 — Verify URLs are live
        if verify_urls:
            candidates = _verify_urls(candidates)

        if not candidates:
            logger.info("   → 0 verified articles")
            time.sleep(RATE_LIMIT_SECONDS)
            continue

        # 3 — Deduplicate against DB
        hashes = [_url_hash(a.url) for a in candidates]
        if skip_existing:
            existing = _existing_hashes(sb, hashes)
            pairs = [
                (a, h)
                for a, h in zip(candidates, hashes)
                if h not in existing
            ]
        else:
            pairs = list(zip(candidates, hashes))

        if not pairs:
            logger.info("   → all articles already in DB")
            time.sleep(RATE_LIMIT_SECONDS)
            continue

        # 4 / 5 — Enrich each new article
        enriched_batch: list[EnrichedArticle] = []
        for raw, h in pairs:
            # Sentiment
            sent = classify_sentiment(raw.title, raw.description or raw.full_text)

            # Entity extraction
            entities = extract_entities(
                text=raw.full_text or raw.description or raw.title,
                plant_name=plant_name,
                owner=owner,
            )

            enriched = EnrichedArticle(
                title=raw.title,
                url=raw.url,
                url_hash=h,
                source=raw.source,
                published_date=raw.published_date,
                description=raw.description,
                full_text=raw.full_text,
                plant_id=plant_code,
                owner=entities.get("owner", owner),
                lenders=entities.get("lenders", []),
                lender_ids=entities.get("lender_ids", []),
                sentiment=sent["sentiment"],
                sentiment_score=sent["score"],
                sentiment_reason=sent.get("reason", ""),
            )
            enriched_batch.append(enriched)

        # 6 — Upsert to Supabase
        rows = [
            {
                "external_id": ea.url_hash,
                "title": ea.title,
                "description": ea.description or None,
                "source_name": ea.source,
                "url": ea.url,
                "published_at": ea.published_date or None,
                "query_tag": f"grounded:{ea.plant_id}",
                "plant_codes": [ea.plant_id],
                "owner_names": [ea.owner] if ea.owner else [],
                "lenders": ea.lenders,
                "lender_ids": ea.lender_ids,
                "states": [state],
                "fuel_types": [fuel],
                "topics": [],
                "sentiment_label": ea.sentiment,
                "sentiment_score": ea.sentiment_score,
                "sentiment_reason": ea.sentiment_reason,
                "event_type": ea.event_type,
                "importance": ea.importance,
            }
            for ea in enriched_batch
        ]

        result = (
            sb.table(NEWS_TABLE)
            .upsert(rows, on_conflict="external_id", ignore_duplicates=True)
            .execute()
        )
        if hasattr(result, "error") and result.error:
            logger.error("Upsert error for %s: %s", plant_name, result.error)
        else:
            logger.info("   → %d new articles stored", len(enriched_batch))

        all_new.extend(enriched_batch)
        time.sleep(RATE_LIMIT_SECONDS)

    logger.info("✅ Ingest complete — %d new articles total", len(all_new))
    return all_new
