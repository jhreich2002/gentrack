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
import re
import time
from dataclasses import dataclass, field, asdict
from typing import Any
from urllib.parse import urlparse

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
MAX_VERIFIED_PER_PLANT = 5      # keep more; dedup + relevance will prune
RATE_LIMIT_SECONDS = 1.5
HEAD_TIMEOUT_SECONDS = 8
DUPE_TITLE_THRESHOLD = 0.70     # word-overlap ratio to flag near-duplicates
TITLE_MATCH_THRESHOLD = 0.25    # min word overlap between claimed & real title

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


# ── Date scraping ─────────────────────────────────────────────────────────────


def _scrape_date_from_html(url: str, html: str) -> str | None:
    """Extract a publication date from article HTML using multiple strategies.

    Returns an ISO date string (YYYY-MM-DD) or None.
    Strategies (in priority order):
      1. <meta property="article:published_time"> tag
      2. JSON-LD datePublished
      3. Date embedded in the URL path (e.g. /2025-02-05/ or /2025/02/05/)
      4. Visible text dates near the top of the page
    """
    date_str: str | None = None

    # 1 — Meta tags
    for pat in [
        r'property="article:published_time"[^>]*content="([^"]+)"',
        r'content="([^"]+)"[^>]*property="article:published_time"',
        r'name="date"[^>]*content="([^"]+)"',
        r'name="pubdate"[^>]*content="([^"]+)"',
        r'name="publish-date"[^>]*content="([^"]+)"',
    ]:
        m = re.search(pat, html, re.I)
        if m:
            date_str = m.group(1)
            break

    # 2 — JSON-LD
    if not date_str:
        for m in re.finditer(
            r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
            html, re.S,
        ):
            try:
                data = json.loads(m.group(1))
                items = [data] if isinstance(data, dict) else (
                    data if isinstance(data, list) else []
                )
                for item in items:
                    if isinstance(item, dict) and "datePublished" in item:
                        date_str = str(item["datePublished"])
                        break
                if date_str:
                    break
            except (json.JSONDecodeError, ValueError):
                pass

    # 3 — URL path date
    if not date_str:
        m = re.search(r"/(\d{4})[-/](\d{2})[-/](\d{2})/?", url)
        if m:
            date_str = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"

    # Normalize to YYYY-MM-DD
    if date_str:
        m = re.match(r"(\d{4}-\d{2}-\d{2})", date_str)
        if m:
            return m.group(1)
    return None


def _fetch_article_html(url: str, *, timeout: float = 12) -> str | None:
    """GET the article page and return its HTML, or None on failure."""
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=timeout,
            headers={"User-Agent": "Mozilla/5.0 (compatible; GenTrack/1.0)"},
        ) as client:
            r = client.get(url)
            if 200 <= r.status_code < 400:
                return r.text
    except Exception:
        pass
    return None


# ── Relevance check ───────────────────────────────────────────────────────────


def _is_article_relevant(
    title: str,
    description: str,
    plant_name: str,
    owner: str,
) -> bool:
    """Return True if the article appears to be *about* the plant, not just
    mentioning it tangentially.

    Checks that the plant name (or a significant word from it) appears in
    the article title or description.  A generic article about the industry
    that merely lists the plant in passing will be rejected.
    """
    combined = f"{title} {description}".lower()
    plant_lower = plant_name.lower()

    # Direct plant name match
    if plant_lower in combined:
        return True

    # Try significant words from the plant name (skip generic words)
    skip = {
        "power", "plant", "station", "generating", "generation", "energy",
        "solar", "wind", "farm", "facility", "center", "the", "of", "and",
        "llc", "inc", "co", "project", "electric", "nuclear",
    }
    significant = [
        w for w in plant_lower.split() if w not in skip and len(w) > 2
    ]
    if significant:
        # At least one significant word from the plant name must appear
        return any(word in combined for word in significant)

    # Owner name match as fallback
    if owner and owner.lower() in combined:
        return True

    return False


# ── Title verification ────────────────────────────────────────────────────────


def _extract_page_title(html: str) -> str | None:
    """Extract the <title> tag content from HTML."""
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    if m:
        import html as html_mod
        return html_mod.unescape(m.group(1)).strip()
    return None


def _titles_match(
    claimed_title: str,
    page_title: str,
    threshold: float = TITLE_MATCH_THRESHOLD,
) -> bool:
    """Return True if the claimed title shares enough words with the actual
    page title.  This catches hallucinated URLs where the page content is
    completely different from what Gemini reported."""
    claimed_words = _word_set(claimed_title)
    page_words = _word_set(page_title)
    if not claimed_words or not page_words:
        return True  # can't verify — give benefit of doubt
    overlap = len(claimed_words & page_words)
    # At least threshold of the claimed title's words should appear
    return overlap / len(claimed_words) >= threshold


# ── Near-duplicate detection ──────────────────────────────────────────────────


def _word_set(text: str) -> set[str]:
    """Return the set of lowercase alpha-numeric words in *text*."""
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def _is_near_duplicate(
    title: str,
    existing_titles: list[str],
    threshold: float = DUPE_TITLE_THRESHOLD,
) -> bool:
    """Return True if *title* shares ≥threshold word overlap with any
    existing title (Jaccard similarity on word sets)."""
    words_new = _word_set(title)
    if not words_new:
        return False
    for existing in existing_titles:
        words_old = _word_set(existing)
        if not words_old:
            continue
        intersection = words_new & words_old
        union = words_new | words_old
        if len(intersection) / len(union) >= threshold:
            return True
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
        f'Find {ARTICLES_PER_PLANT} recent real news articles specifically about '
        f'the "{plant_name}" power plant in {state}. '
        f'This is a {fuel_type} power plant owned by {owner or "unknown"}.\n\n'
        "CRITICAL RULES:\n"
        "1. Every article MUST be specifically about this plant — not just "
        "mentioning it in passing or listing it among many facilities.\n"
        "2. Only include articles from reputable news websites "
        "(e.g. Reuters, Bloomberg, Utility Dive, Power Engineering, "
        "local newspapers, AP News, ans.org).\n"
        "3. Each URL must be a direct link to an actual published article "
        "page — NOT a search page, government database, or directory.\n"
        "4. Do NOT include duplicate or near-duplicate articles covering "
        "the same story from the same source.\n\n"
        "Return ONLY a JSON array with these exact fields for each article:\n"
        "- title: the article headline\n"
        "- url: the direct link to the article\n"
        "- source: the publication name\n"
        "- publishedAt: publication date in ISO format (YYYY-MM-DD) — "
        "leave empty string if uncertain\n"
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


def _verify_and_scrape(
    candidates: list[RawArticle],
    plant_name: str,
    owner: str,
) -> list[RawArticle]:
    """GET each URL, verify it's live, scrape real dates, check relevance,
    remove near-duplicates, and keep up to *MAX_VERIFIED_PER_PLANT*."""
    verified: list[RawArticle] = []
    kept_titles: list[str] = []

    for article in candidates:
        if len(verified) >= MAX_VERIFIED_PER_PLANT:
            break

        # Fetch the full page (also proves liveness)
        html = _fetch_article_html(article.url)
        if html is None:
            logger.debug("  ✗ DEAD  %s", article.url)
            continue
        logger.debug("  ✓ LIVE  %s", article.url)

        # Title verification — reject hallucinated URLs
        page_title = _extract_page_title(html)
        if page_title and not _titles_match(article.title, page_title):
            logger.info(
                "  ✗ TITLE MISMATCH — claimed: '%s' | actual: '%s'",
                article.title[:80], page_title[:80],
            )
            continue

        # If page title is available, use it instead of Gemini's claimed title
        # (the real title is more accurate)
        if page_title:
            # Clean common suffixes like " -- ANS / Nuclear Newswire"
            clean_title = re.split(r"\s*[|–—]\s*", page_title)[0].strip()
            if clean_title and len(clean_title) > 10:
                article.title = clean_title

        # Relevance check — must be *about* the plant
        desc_text = article.description or ""
        if not _is_article_relevant(article.title, desc_text, plant_name, owner):
            # Also check if plant name is in the HTML body
            if plant_name.lower() not in html.lower():
                logger.info("  ✗ IRRELEVANT  %s", article.title)
                continue

        # Near-duplicate check
        if _is_near_duplicate(article.title, kept_titles):
            logger.info("  ✗ NEAR-DUPE  %s", article.title)
            continue

        # Scrape real date from the HTML (prefer over Gemini-generated dates)
        scraped_date = _scrape_date_from_html(article.url, html)
        if scraped_date:
            if article.published_date and article.published_date != scraped_date:
                logger.info(
                    "  📅 Date corrected: %s → %s for %s",
                    article.published_date, scraped_date, article.title[:60],
                )
            article.published_date = scraped_date
        elif not article.published_date:
            # No scraped date and no LLM date — leave empty (will become NULL)
            logger.debug("  📅 No date found for %s", article.title[:60])

        verified.append(article)
        kept_titles.append(article.title)

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

        # 2 — Verify URLs, scrape dates, filter relevance & near-dupes
        if verify_urls:
            candidates = _verify_and_scrape(candidates, plant_name, owner)

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
