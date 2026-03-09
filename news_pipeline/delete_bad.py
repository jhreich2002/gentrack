"""Delete Palo Verde articles with hallucinated URLs."""
import httpx

KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"
BASE = "https://ohmmtplnaddrfuoowpuq.supabase.co/rest/v1/news_articles"
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

# Bad URLs where the page title doesn't match Gemini's claimed title
bad_urls = [
    "https://www.ans.org/news/article-6059/arizonautilitiesteamuptoexplorenewnuclearsites/",
    "https://www.ans.org/news/article-6065/arizonautilitiesexplorenuclearexpansion/",
    "https://www.ans.org/news/article-5309/framatometoinstallnewpipelineratusplant/",
    "https://www.ans.org/news/article-5452/workshop-hints-at-robust-support-for-nuclear-expansion-in-arizona/",
]

for url in bad_urls:
    r = httpx.delete(f"{BASE}?url=eq.{url}", headers=H)
    print(f"Delete {url.split('/')[-2][:40]}: HTTP {r.status_code}")

print("\nDone")
