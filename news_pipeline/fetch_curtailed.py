"""Run news fetch for 5 curtailed plants from the screenshot."""
import os
import logging

os.environ["GEMINI_API_KEY"] = "AIzaSyAHuOTjzEtp-ThNtq4_4olCp5Ppk26PsG8"
os.environ["SUPABASE_URL"] = "https://ohmmtplnaddrfuoowpuq.supabase.co"
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9obW10cGxuYWRkcmZ1b293cHVxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTkwMDU4NywiZXhwIjoyMDg3NDc2NTg3fQ.zlFMdTMcmVb0W9k8DC-IM6cieil5Wjc9NiGJ0VT2MEs"

logging.basicConfig(level=logging.INFO, format="%(message)s")

from news_pipeline.ingest import ingest_articles

plants = [
    {"eia_plant_code": "63100", "name": "Prairie Hill Wind Project", "state": "TX", "fuel_source": "Wind", "owner": "Engie North America"},
    {"eia_plant_code": "65678", "name": "Appaloosa Solar I", "state": "NM", "fuel_source": "Solar", "owner": "Greenbacker Renewable Energy Corporation"},
    {"eia_plant_code": "56621", "name": "Sleeping Bear LLC", "state": "TX", "fuel_source": "Wind", "owner": "NRG Energy Gas & Wind Holdings Inc"},
    {"eia_plant_code": "56836", "name": "T-Bone Wind (10) LLC", "state": "TX", "fuel_source": "Wind", "owner": "UPC Power Solutions"},
    {"eia_plant_code": "56835", "name": "Ribeye Wind (11) LLC", "state": "TX", "fuel_source": "Wind", "owner": "UPC Power Solutions"},
]

results = ingest_articles(plants, verify_urls=True, skip_existing=True)

print(f"\n{'='*80}")
print(f"TOTAL: {len(results)} new articles ingested across {len(plants)} plants")
print(f"{'='*80}")
for r in results:
    print(f"  [{r.plant_id}] {r.title}")
    print(f"    URL: {r.url}")
    print(f"    Date: {r.published_date or 'unknown'}")
    print()
