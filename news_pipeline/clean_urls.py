"""
Verify all article URLs in the database.
Delete articles with broken/dead URLs, then re-fetch for affected plants.
"""

import os
import sys
import time
import logging

import httpx
from supabase import create_client

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

os.environ.setdefault("SUPABASE_URL", "https://ohmmtplnaddrfuoowpuq.supabase.co")
os.environ.setdefault(
    "SUPABASE_SERVICE_ROLE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs",
)
os.environ.setdefault("GEMINI_API_KEY", "AIzaSyAHuOTjzEtp-ThNtq4_4olCp5Ppk26PsG8")

sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def verify_url(url: str) -> bool:
    """GET the URL and check it returns real content (not 404 / homepage redirect)."""
    BAD = ["example.com", "google.com/search", "vertexaisearch"]
    if any(d in url for d in BAD):
        return False
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=12,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
        ) as c:
            r = c.get(url)
            if r.status_code >= 400:
                return False
            # Check if redirected to homepage
            from urllib.parse import urlparse
            path = urlparse(str(r.url)).path
            if path in ("", "/"):
                return False
            # Check for soft 404 in body
            body = r.text[:2000].lower()
            if "page not found" in body or "404" in body[:500]:
                return False
            return True
    except Exception:
        return False


def main():
    # Step 1: Fetch all articles
    log.info("🔍 Fetching all articles from DB...")
    resp = sb.table("news_articles").select("id,title,url,plant_codes,published_at").execute()
    articles = resp.data or []
    log.info("   Found %d articles\n", len(articles))

    good = []
    bad = []

    for i, a in enumerate(articles):
        url = a.get("url", "")
        title = a.get("title", "")[:60]
        ok = verify_url(url)
        if ok:
            good.append(a)
            log.info("  ✓ OK   %s", title)
        else:
            bad.append(a)
            log.info("  ✗ BAD  %s  →  %s", title, url[:80])
        time.sleep(0.3)

    log.info("\n📊 Results: %d good, %d bad\n", len(good), len(bad))

    # Step 2: Delete bad articles
    if bad:
        for a in bad:
            sb.table("news_articles").delete().eq("id", a["id"]).execute()
            log.info("   DELETED: %s", a.get("title", "")[:60])
        log.info("\n   🗑️  Deleted %d broken articles\n", len(bad))

    # Step 3: Identify plants that need re-fetch
    affected_codes = set()
    for a in bad:
        for code in a.get("plant_codes", []):
            affected_codes.add(code)

    if not affected_codes:
        log.info("✅ All articles verified! No re-fetch needed.")
        return

    log.info("📡 Re-fetching news for %d affected plants: %s\n", len(affected_codes), affected_codes)

    # Step 4: Re-fetch using the existing pipeline
    from news_pipeline.ingest import ingest_articles

    # Build plant info for affected codes
    plants_to_refetch = []
    for code in affected_codes:
        resp = sb.table("plants").select("eia_plant_code,name,state,fuel_source,owner").eq("eia_plant_code", code).execute()
        if resp.data:
            row = resp.data[0]
            plants_to_refetch.append({
                "eia_plant_code": row["eia_plant_code"],
                "name": row["name"],
                "state": row["state"],
                "fuel_source": row["fuel_source"],
                "owner": row["owner"],
            })

    if plants_to_refetch:
        new_articles = ingest_articles(plants_to_refetch, verify_urls=True, skip_existing=True)
        log.info("\n✅ Re-fetched %d new verified articles", len(new_articles))
        for a in new_articles:
            log.info("   • %s  →  %s", a.title[:60], a.url[:80])
    else:
        log.info("   No plant info found for affected codes")

    # Final count
    final = sb.table("news_articles").select("id", count="exact").execute()
    log.info("\n📊 Final article count: %d", final.count or 0)


if __name__ == "__main__":
    main()
