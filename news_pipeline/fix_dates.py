"""
Fix article dates and remove duplicates.

1. Delete duplicate "Workshop hints..." articles (keep only 1)
2. Scrape each article's actual page to extract the real publication date
3. Update the DB with correct dates
"""

import os
import re
import time
import logging
from urllib.parse import urlparse

import httpx
from supabase import create_client

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

os.environ.setdefault("SUPABASE_URL", "https://ohmmtplnaddrfuoowpuq.supabase.co")
os.environ.setdefault(
    "SUPABASE_SERVICE_ROLE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs",
)

sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

# Common date patterns found in article HTML
DATE_PATTERNS = [
    # ISO dates in meta tags: 2024-07-17, 2024-07-17T12:00:00
    r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})',
    r'"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2})',
    r'property="article:published_time"\s+content="(\d{4}-\d{2}-\d{2})',
    r'name="pubdate"\s+content="(\d{4}-\d{2}-\d{2})',
    r'name="date"\s+content="(\d{4}-\d{2}-\d{2})',
    r'name="DC\.date"\s+content="(\d{4}-\d{2}-\d{2})',
    r'itemprop="datePublished"\s+content="(\d{4}-\d{2}-\d{2})',
    r'itemprop="datePublished"[^>]*datetime="(\d{4}-\d{2}-\d{2})',
    r'datetime="(\d{4}-\d{2}-\d{2})',
    # URL-embedded dates: /2024/07/17/ or /2025-02-05/
    r'/(\d{4})/(\d{2})/(\d{2})/',
    r'/(\d{4}-\d{2}-\d{2})/',
]

MONTH_NAMES = {
    "january": "01", "february": "02", "march": "03", "april": "04",
    "may": "05", "june": "06", "july": "07", "august": "08",
    "september": "09", "october": "10", "november": "11", "december": "12",
    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
    "jun": "06", "jul": "07", "aug": "08", "sep": "09",
    "oct": "10", "nov": "11", "dec": "12",
}

# Text date patterns: "February 5, 2025" or "March 2, 2026"
TEXT_DATE_RE = re.compile(
    r'(?:published|posted|date|updated).*?'
    r'(' + '|'.join(MONTH_NAMES.keys()) + r')\w*\s+(\d{1,2}),?\s+(\d{4})',
    re.IGNORECASE,
)
STANDALONE_DATE_RE = re.compile(
    r'\b(' + '|'.join(MONTH_NAMES.keys()) + r')\w*\s+(\d{1,2}),?\s+(\d{4})\b',
    re.IGNORECASE,
)


def extract_date_from_url(url: str) -> str | None:
    """Try to extract a date from the URL path itself."""
    # /2024/07/17/
    m = re.search(r'/(\d{4})/(\d{2})/(\d{2})/', url)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    # /2025-02-05/
    m = re.search(r'/(\d{4}-\d{2}-\d{2})/', url)
    if m:
        return m.group(1)
    # date in slug: -2-4-2025 (month-day-year at end)
    m = re.search(r'-(\d{1,2})-(\d{1,2})-(\d{4})$', urlparse(url).path)
    if m:
        month = m.group(1).zfill(2)
        day = m.group(2).zfill(2)
        return f"{m.group(3)}-{month}-{day}"
    return None


def extract_date_from_html(html: str) -> str | None:
    """Scrape a date from structured data / meta tags / visible text."""
    # 1. JSON-LD / meta tags
    for pattern in DATE_PATTERNS[:8]:
        m = re.search(pattern, html, re.IGNORECASE)
        if m:
            return m.group(1)

    # 2. datetime attributes
    m = re.search(r'datetime="(\d{4}-\d{2}-\d{2})', html)
    if m:
        return m.group(1)

    # 3. Text dates near "published" / "posted" / "date"
    m = TEXT_DATE_RE.search(html[:5000])
    if m:
        month_name = m.group(1).lower()[:3]
        month_num = MONTH_NAMES.get(month_name)
        if month_num:
            day = m.group(2).zfill(2)
            return f"{m.group(3)}-{month_num}-{day}"

    # 4. Standalone text date in first 3000 chars of visible content
    m = STANDALONE_DATE_RE.search(html[:3000])
    if m:
        month_name = m.group(1).lower()[:3]
        month_num = MONTH_NAMES.get(month_name)
        if month_num:
            day = m.group(2).zfill(2)
            return f"{m.group(3)}-{month_num}-{day}"

    return None


def scrape_real_date(url: str) -> str | None:
    """Fetch the article page and extract the real publication date."""
    # Try URL first
    url_date = extract_date_from_url(url)
    if url_date:
        return url_date

    # Scrape the page
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=15,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
        ) as c:
            r = c.get(url)
            if r.status_code >= 400:
                return None
            return extract_date_from_html(r.text)
    except Exception as e:
        log.warning("  Failed to scrape %s: %s", url[:60], e)
        return None


def main():
    # ── Step 1: Remove duplicates ──
    log.info("🔍 Step 1: Finding duplicate articles...\n")

    resp = sb.table("news_articles").select("id,title,url,published_at,plant_codes").execute()
    articles = resp.data or []

    # Group by title
    by_title: dict[str, list] = {}
    for a in articles:
        t = a["title"]
        by_title.setdefault(t, []).append(a)

    dupes_deleted = 0
    for title, group in by_title.items():
        if len(group) > 1:
            log.info("  DUPLICATE: \"%s\" (%d copies)", title[:60], len(group))
            # Keep the first, delete the rest
            for a in group[1:]:
                sb.table("news_articles").delete().eq("id", a["id"]).execute()
                log.info("    DELETED id=%s url=%s", a["id"], a["url"][:60])
                dupes_deleted += 1

    log.info("\n  Deleted %d duplicates\n", dupes_deleted)

    # ── Step 2: Scrape real dates ──
    log.info("📅 Step 2: Scraping real publication dates from article pages...\n")

    # Re-fetch after dedup
    resp = sb.table("news_articles").select("id,title,url,published_at").execute()
    articles = resp.data or []

    updated = 0
    for a in articles:
        url = a["url"]
        stored_date = a["published_at"][:10] if a.get("published_at") else ""
        title = a["title"][:60]

        real_date = scrape_real_date(url)

        if real_date and real_date != stored_date:
            log.info("  ✓ %s", title)
            log.info("    STORED: %s → REAL: %s  ← UPDATING", stored_date, real_date)
            sb.table("news_articles").update(
                {"published_at": f"{real_date}T00:00:00+00:00"}
            ).eq("id", a["id"]).execute()
            updated += 1
        elif real_date and real_date == stored_date:
            log.info("  ✓ %s — date correct (%s)", title, stored_date)
        else:
            log.info("  ? %s — could not scrape date (keeping %s)", title, stored_date)

        time.sleep(0.5)

    log.info("\n✅ Done! Deleted %d duplicates, updated %d dates", dupes_deleted, updated)

    # Final state
    resp = sb.table("news_articles").select("title,published_at,url,plant_codes").order("published_at").execute()
    log.info("\n📊 Final article list:\n")
    for a in resp.data or []:
        codes = ",".join(a.get("plant_codes", []))
        log.info("  [%s] %s — %s", a["published_at"][:10], a["title"][:55], codes)


if __name__ == "__main__":
    main()
