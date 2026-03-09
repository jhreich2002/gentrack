"""Scrape actual publication dates for Palo Verde articles #5 and #6."""
import httpx
import re
import json

urls = [
    ("KAWC", "https://www.kawc.org/news/2025-02-05/arizona-utilities-collaborate-to-explore-nuclear-energy-for-future-needs"),
    ("NucNet", "https://www.nucnet.org/news/arizona-utilities-announced-joint-effort-to-add-more-nuclear-power-2-4-2025"),
]

for name, url in urls:
    print(f"\n=== {name} ===")
    try:
        r = httpx.get(url, follow_redirects=True, timeout=15)
    except Exception as e:
        print(f"  Error fetching: {e}")
        continue
    html = r.text

    # Meta tags
    for pat in [
        r'property="article:published_time"[^>]*content="([^"]+)"',
        r'content="([^"]+)"[^>]*property="article:published_time"',
        r'name="date"[^>]*content="([^"]+)"',
        r'name="pubdate"[^>]*content="([^"]+)"',
    ]:
        m = re.search(pat, html, re.I)
        if m:
            print(f"  Meta date: {m.group(1)}")
            break

    # JSON-LD
    for m in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            data = json.loads(m.group(1))
            items = [data] if isinstance(data, dict) else (data if isinstance(data, list) else [])
            for item in items:
                if isinstance(item, dict):
                    for k in ["datePublished", "dateCreated"]:
                        if k in item:
                            print(f"  JSON-LD {k}: {item[k]}")
        except:
            pass

    # URL date
    m = re.search(r"/(\d{4}-\d{2}-\d{2})/", url)
    if m:
        print(f"  URL date: {m.group(1)}")
    m2 = re.search(r"-(\d{1,2})-(\d{1,2})-(\d{4})$", url)
    if m2:
        print(f"  URL date parts: month={m2.group(1)} day={m2.group(2)} year={m2.group(3)}")

    # Visible text dates
    found = re.findall(r"(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}", html)
    if found:
        print(f"  Text dates: {found[:3]}")
