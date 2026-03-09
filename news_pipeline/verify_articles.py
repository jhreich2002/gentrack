"""Dump raw DB fields for Palo Verde articles to verify title/url/date alignment."""
import httpx
import sys

KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"
BASE = "https://ohmmtplnaddrfuoowpuq.supabase.co/rest/v1/news_articles"

plant_id = sys.argv[1] if len(sys.argv) > 1 else "6008"

r = httpx.get(
    BASE,
    headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
    params={
        "plant_codes": f'cs.{{"{plant_id}"}}',
        "select": "id,title,url,published_at,description",
        "order": "published_at.desc.nullsfirst",
    },
)

articles = r.json()

# Now verify each: fetch the real page title
for i, a in enumerate(articles):
    print(f"#{i+1}")
    print(f"  DB TITLE: {a['title']}")
    print(f"  DB URL:   {a['url']}")
    print(f"  DB DATE:  {a['published_at']}")
    print(f"  DB DESC:  {(a.get('description') or '')[:150]}")

    # Fetch the actual page to check if title matches
    try:
        page = httpx.get(a["url"], follow_redirects=True, timeout=10,
                         headers={"User-Agent": "Mozilla/5.0 (compatible; GenTrack/1.0)"})
        if 200 <= page.status_code < 400:
            import re
            # Extract <title> tag
            m = re.search(r"<title[^>]*>(.*?)</title>", page.text, re.S | re.I)
            page_title = m.group(1).strip() if m else "NO <title> FOUND"
            # Extract article:published_time meta
            m2 = re.search(r'property="article:published_time"[^>]*content="([^"]+)"', page.text, re.I)
            if not m2:
                m2 = re.search(r'content="([^"]+)"[^>]*property="article:published_time"', page.text, re.I)
            real_date = m2.group(1) if m2 else None

            print(f"  REAL TITLE: {page_title[:120]}")
            if real_date:
                print(f"  REAL DATE:  {real_date}")
            
            # Check mismatch
            db_title_lower = a["title"].lower()
            page_title_lower = page_title.lower()
            # Simple word overlap check
            db_words = set(db_title_lower.split())
            page_words = set(page_title_lower.split())
            if db_words and page_words:
                overlap = len(db_words & page_words) / len(db_words)
                if overlap < 0.5:
                    print(f"  ⚠️  TITLE MISMATCH (only {overlap:.0%} word overlap)")
        else:
            print(f"  HTTP {page.status_code}")
    except Exception as e:
        print(f"  FETCH ERROR: {e}")
    print()
