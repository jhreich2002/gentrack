"""List articles for a given plant ID."""
import sys
import httpx

SUPABASE_URL = "https://ohmmtplnaddrfuoowpuq.supabase.co"
KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"

plant_id = sys.argv[1] if len(sys.argv) > 1 else "6008"

r = httpx.get(
    f"{SUPABASE_URL}/rest/v1/news_articles",
    headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"},
    params={
        "plant_codes": f"cs.{{\"{plant_id}\"}}",
        "select": "id,title,url,published_at,sentiment_label,description",
        "order": "published_at.desc.nullsfirst",
    },
)

arts = r.json()
for i, a in enumerate(arts):
    date = a.get("published_at") or "unknown"
    sentiment = a.get("sentiment_label", "N/A")
    desc = (a.get("description") or "")[:250]
    print(f"#{i+1}  {a['title']}")
    print(f"    Date: {date}  |  Sentiment: {sentiment}")
    print(f"    URL: {a['url']}")
    print(f"    Summary: {desc}")
    print("-" * 90)

print(f"\nTotal: {len(arts)} articles for plant {plant_id}")
