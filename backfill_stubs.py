"""
backfill_stubs.py

Re-enriches existing news_articles rows where pipeline='plant_news' that
still have hostname-only titles (no spaces, short) or null published_at.

For each stub:
  1. Fetches the URL to extract OG title, published_at, description
  2. Updates the row if we got better data
  3. Resets ranked_at=null so plant-news-rank will re-process it

Run:
  .venv/Scripts/python backfill_stubs.py [--dry-run]
"""

import os, re, sys, time, html
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
DRY_RUN      = "--dry-run" in sys.argv

USER_AGENT = "Mozilla/5.0 (compatible; Googlebot/2.1)"
TIMEOUT    = 6   # seconds per fetch
DELAY      = 0.4 # seconds between fetches

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def decode_entities(s: str) -> str:
    return html.unescape(s)


def fetch_metadata(url: str) -> dict:
    """Fetch a URL and extract OG title, published_at, description."""
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT, allow_redirects=True)
        if not r.ok:
            return {}
        text = r.text

        # Title
        og_title  = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"', text, re.I)
        tag_title = re.search(r'<title[^>]*>([^<]+)</title>', text, re.I)
        title = decode_entities((og_title or tag_title).group(1).strip()) if (og_title or tag_title) else None

        # Published date — try multiple patterns
        pub = (
            re.search(r'<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"', text, re.I) or
            re.search(r'<meta[^>]+name="publication_date"[^>]+content="([^"]+)"', text, re.I) or
            re.search(r'<time[^>]+datetime="([^"]+)"', text, re.I)
        )
        published_at = None
        if pub:
            try:
                from datetime import datetime, timezone
                raw = pub.group(1).strip()
                # Parse ISO-like strings; truncate to first 25 chars to handle microseconds
                dt = datetime.fromisoformat(raw[:25].rstrip("Z") + "+00:00")
                published_at = dt.isoformat()
            except Exception:
                pass

        # Description
        og_desc   = re.search(r'<meta[^>]+property="og:description"[^>]+content="([^"]+)"', text, re.I)
        meta_desc = re.search(r'<meta[^>]+name="description"[^>]+content="([^"]+)"', text, re.I)
        desc_raw  = (og_desc or meta_desc)
        description = decode_entities(desc_raw.group(1).strip())[:2000] if desc_raw else None

        return {
            "title":        title[:500] if title else None,
            "published_at": published_at,
            "description":  description,
        }
    except Exception as e:
        return {}


def is_stub(row: dict) -> bool:
    """Return True if this row looks like an un-enriched hostname stub."""
    title = row.get("title") or ""
    # A stub has no spaces (just a domain like "reuters.com") or very short title
    return " " not in title.strip() or row.get("published_at") is None


def main():
    print(f"{'[DRY RUN] ' if DRY_RUN else ''}Fetching plant_news stubs...")

    # Load all pipeline='plant_news' articles
    resp = sb.table("news_articles") \
        .select("id, url, title, published_at, pipeline") \
        .eq("pipeline", "plant_news") \
        .execute()

    rows = resp.data or []
    stubs = [r for r in rows if is_stub(r)]

    print(f"Total plant_news articles: {len(rows)}")
    print(f"Stubs needing enrichment:  {len(stubs)}")
    if not stubs:
        print("Nothing to do.")
        return

    enriched = 0
    failed   = 0

    for i, row in enumerate(stubs, 1):
        url   = row["url"]
        title = row.get("title") or ""
        try:
            hostname = __import__("urllib.parse", fromlist=["urlparse"]).urlparse(url).netloc.lstrip("www.")
        except Exception:
            hostname = url

        print(f"[{i}/{len(stubs)}] {hostname} — {url[:80]}")

        meta = fetch_metadata(url)
        if not meta.get("title") and not meta.get("published_at"):
            print(f"  SKIP No metadata retrieved (paywall or error)")
            failed += 1
            time.sleep(DELAY)
            continue

        new_title = meta.get("title") or title
        update = {
            "title":       new_title,
            "description": meta.get("description"),
            "published_at": meta.get("published_at"),
            "ranked_at":   None,  # reset so plant-news-rank reprocesses
        }
        print(f"  OK title: {new_title[:70]}")
        print(f"    date:  {meta.get('published_at') or 'not found'}")

        if not DRY_RUN:
            sb.table("news_articles").update(update).eq("id", row["id"]).execute()
            enriched += 1

        time.sleep(DELAY)

    print(f"\nDone. Enriched: {enriched}, Failed/paywalled: {failed}")
    if DRY_RUN:
        print("(Dry run — no changes written)")
    else:
        print(f"\nNext step: trigger plant-news-rank to re-rank the enriched articles.")
        print("  npx supabase@latest functions invoke plant-news-rank --body '{{\"batch\":true,\"limit\":30}}'")


if __name__ == "__main__":
    main()
