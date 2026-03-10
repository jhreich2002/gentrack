"""
news_pipeline.ingest — Local dev/test tool for the news ingest pipeline.

Mirrors the logic in supabase/functions/news-ingest/index.ts so the pipeline
can be tested locally before deploying the edge function.

Usage:
    python news_pipeline/ingest.py              # process tier 1 plants (>100 MW)
    python news_pipeline/ingest.py --tier 2     # process tier 2 plants (<=100 MW)
    python news_pipeline/ingest.py --limit 3    # process only 3 plants (for testing)
    python news_pipeline/ingest.py --dry-run    # fetch articles but do not upsert

Environment variables required:
    TAVILY_API_KEY
    GEMINI_API_KEY
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import pprint
import sys
import time
from datetime import datetime, timedelta, timezone

import httpx
from supabase import create_client, Client

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("news_ingest")

# ── Config ────────────────────────────────────────────────────────────────────

TIER_1_SIZE       = 100   # top curtailed plants >100 MW
TIER_2_SIZE       = 200   # smaller curtailed plants <=100 MW
ARTICLES_PER_PLANT = 5
CLASSIFY_BATCH    = 20
RATE_LIMIT_SECS   = 0.5

TAVILY_URL = "https://api.tavily.com/search"
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)

# ── Helpers ───────────────────────────────────────────────────────────────────


def _url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:32]


def _get_supabase() -> Client:
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


# ── Plant selection ───────────────────────────────────────────────────────────


def load_curtailed_plants(sb: Client, tier: int, limit: int | None = None) -> list[dict]:
    """Query Supabase for actively curtailed plants with consistent generation.

    Tier 1: curtailed plants >100 MW (daily monitoring)
    Tier 2: curtailed plants <=100 MW (Mon/Thu monitoring)

    Excluded:
    - is_maintenance_offline = true  (explained outage, not a consulting lead)
    - trailing_zero_months > 0       (spotty data, unreliable signal)
    """
    size = limit or (TIER_1_SIZE if tier == 1 else TIER_2_SIZE)

    q = (
        sb.table("plants")
        .select(
            "eia_plant_code, name, owner, state, fuel_source, "
            "curtailment_score, nameplate_capacity_mw, is_maintenance_offline"
        )
        .eq("is_likely_curtailed", True)
        .eq("is_maintenance_offline", False)
        .eq("trailing_zero_months", 0)
        .neq("eia_plant_code", "99999")
        .order("curtailment_score", desc=True)
        .order("nameplate_capacity_mw", desc=True)
    )

    if tier == 1:
        q = q.gt("nameplate_capacity_mw", 100)
    else:
        q = q.lte("nameplate_capacity_mw", 100)

    resp = q.limit(size).execute()
    plants = resp.data or []
    log.info("Loaded %d tier-%d curtailed plants", len(plants), tier)
    return plants


# ── Tavily search ─────────────────────────────────────────────────────────────


def search_tavily(plant: dict, api_key: str) -> list[dict]:
    """Search Tavily for news articles about the plant.

    Two queries per plant:
    1. General curtailment/regulatory/financial news
    2. Financing/lender-specific news (for consulting firm lender intelligence)
    """
    queries = [
        f'"{plant["name"]}" {plant["state"]} power plant curtailment regulatory financial',
        f'"{plant["name"]}" {plant["state"]} power plant financing lender loan',
    ]

    seen_urls: set[str] = set()
    results: list[dict] = []

    for query in queries:
        if len(results) >= ARTICLES_PER_PLANT:
            break
        try:
            resp = httpx.post(
                TAVILY_URL,
                json={
                    "api_key":        api_key,
                    "query":          query,
                    "search_depth":   "basic",
                    "max_results":    ARTICLES_PER_PLANT,
                    "include_answer": False,
                },
                timeout=30,
            )
            if resp.status_code != 200:
                log.warning("Tavily HTTP %d for %s", resp.status_code, plant["name"])
                continue

            for r in resp.json().get("results", []):
                url = (r.get("url") or "").strip()
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                results.append({
                    "title":          (r.get("title") or "").strip(),
                    "url":            url,
                    "content":        (r.get("content") or "").strip(),
                    "published_date": r.get("published_date"),
                    "score":          r.get("score", 0),
                })
        except Exception as exc:
            log.warning("Tavily error for %s: %s", plant["name"], exc)

    return results


def search_tavily_finance(plant: dict, api_key: str) -> list[dict]:
    """Finance-focused Tavily search for lender/financing intelligence.

    Uses queries targeting credit facilities, tax equity, bonds, and PPA
    to surface articles specifically relevant to the plant's capital structure.
    Stored separately with query_tag = 'finance:{plant_code}'.
    """
    owner = plant.get("owner", "")
    queries = [
        f'"{plant["name"]}" {plant["state"]} financing lender "credit facility" OR "tax equity" OR bond',
        f'"{plant["name"]}" OR "{owner}" power plant "project finance" OR "power purchase agreement" OR refinancing',
    ]

    seen_urls: set[str] = set()
    results: list[dict] = []

    for query in queries:
        if len(results) >= ARTICLES_PER_PLANT:
            break
        try:
            resp = httpx.post(
                TAVILY_URL,
                json={
                    "api_key":        api_key,
                    "query":          query,
                    "search_depth":   "basic",
                    "max_results":    ARTICLES_PER_PLANT,
                    "include_answer": False,
                },
                timeout=30,
            )
            if resp.status_code != 200:
                log.warning("Tavily finance HTTP %d for %s", resp.status_code, plant["name"])
                continue

            for r in resp.json().get("results", []):
                url = (r.get("url") or "").strip()
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                results.append({
                    "title":          (r.get("title") or "").strip(),
                    "url":            url,
                    "content":        (r.get("content") or "").strip(),
                    "published_date": r.get("published_date"),
                    "score":          r.get("score", 0),
                })
        except Exception as exc:
            log.warning("Tavily finance error for %s: %s", plant["name"], exc)

    return results


# ── Gemini batch classification ───────────────────────────────────────────────


def _default_classification() -> dict:
    return {
        "sentiment_label":      "neutral",
        "sentiment_score":      0.5,
        "event_type":           "other",
        "importance":           "medium",
        "impact_tags":          [],
        "entity_company_names": [],
    }


def classify_and_extract_batch(articles: list[dict], api_key: str) -> list[dict]:
    """Single Gemini Flash call to classify sentiment and extract entities for a batch.

    Extracts: sentiment, event_type, importance, impact_tags, entity_company_names.
    Falls back to neutral defaults on any error.
    """
    if not articles:
        return []

    article_list = "\n\n".join(
        f"[{i}] Title: {a['title']}\nContent: {a['content'][:400]}"
        for i, a in enumerate(articles)
    )

    prompt = (
        "You are helping a power plant consulting firm assess business intelligence "
        "from news articles about curtailed power plants. Consulting opportunities "
        "include: operational improvement, regulatory advisory, financial restructuring, "
        "and lender engagement.\n\n"
        "Classify each article and extract key entities. For each article return:\n"
        '- sentiment: "positive" | "negative" | "neutral" (from the plant owner/lender perspective)\n'
        "- sentiment_score: 0.0-1.0 confidence\n"
        '- event_type: one of "curtailment" | "regulatory" | "financial" | "operational" | '
        '"construction" | "weather" | "grid" | "other"\n'
        '- importance: "high" | "medium" | "low" (to a consulting firm prospecting this plant)\n'
        '- impact_tags: array from ["curtailment", "grid-congestion", "ppa-issue", '
        '"debt-covenant", "refinancing", "lender-mention", "regulatory-action", '
        '"permit-issue", "outage", "capacity-reduction", "financial-distress", "ownership-change"]\n'
        "- entity_company_names: array of company names mentioned "
        "(owners, operators, lenders, financiers, regulators)\n\n"
        "Return ONLY a JSON array, no other text:\n"
        '[{"index":0,"sentiment":"negative","sentiment_score":0.8,"event_type":"regulatory",'
        '"importance":"high","impact_tags":["regulatory-action"],"entity_company_names":["NextEra Energy"]}, ...]\n\n'
        f"Articles to classify:\n{article_list}"
    )

    try:
        resp = httpx.post(
            f"{GEMINI_URL}?key={api_key}",
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.0, "maxOutputTokens": 2048},
            },
            timeout=60,
        )
        if resp.status_code != 200:
            log.warning("Gemini classification HTTP %d", resp.status_code)
            return [dict(a, **_default_classification()) for a in articles]

        data = resp.json()
        # Skip thinking parts (Gemini 2.5 Flash)
        raw = ""
        for part in (data.get("candidates") or [{}])[0].get("content", {}).get("parts", []):
            if "text" in part and not part.get("thought"):
                raw = part["text"]

        start = raw.find("[")
        end   = raw.rfind("]")
        if start == -1 or end == -1:
            log.warning("Gemini returned no JSON array — using defaults")
            return [dict(a, **_default_classification()) for a in articles]

        parsed: list[dict] = json.loads(raw[start:end + 1])
        classified = []
        for i, a in enumerate(articles):
            c = next((p for p in parsed if p.get("index") == i), None)
            if not c:
                classified.append(dict(a, **_default_classification()))
                continue
            classified.append({
                **a,
                "sentiment_label":      c.get("sentiment", "neutral"),
                "sentiment_score":      float(c.get("sentiment_score", 0.5)),
                "event_type":           c.get("event_type", "other"),
                "importance":           c.get("importance", "medium"),
                "impact_tags":          c.get("impact_tags") or [],
                "entity_company_names": c.get("entity_company_names") or [],
            })
        return classified

    except Exception as exc:
        log.warning("Gemini classification error: %s", exc)
        return [dict(a, **_default_classification()) for a in articles]


# ── DB helpers ────────────────────────────────────────────────────────────────


def load_existing_urls(sb: Client, days: int = 90) -> set[str]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    resp = (
        sb.table("news_articles")
        .select("url")
        .gte("created_at", cutoff)
        .execute()
    )
    return {r["url"] for r in (resp.data or [])}


def upsert_articles(
    sb: Client,
    articles: list[dict],
    batch_size: int = 50,
    *,
    query_tag_prefix: str = "curtailed",
    extra_topics: list[str] | None = None,
    set_lenders: bool = False,
) -> int:
    rows = []
    for a in articles:
        try:
            source = a["url"].split("/")[2].removeprefix("www.")
        except Exception:
            source = ""

        row: dict = {
            "external_id":          a["url_hash"],
            "title":                a["title"],
            "description":          a["content"] or None,
            "content":              None,
            "source_name":          source,
            "url":                  a["url"],
            "published_at":         a.get("published_date"),
            "query_tag":            f"{query_tag_prefix}:{a['plant_code']}",
            "plant_codes":          [a["plant_code"]],
            "owner_names":          [a["owner"]] if a.get("owner") else [],
            "states":               [a["state"]] if a.get("state") else [],
            "fuel_types":           [a["fuel_type"]] if a.get("fuel_type") else [],
            "topics":               list(extra_topics) if extra_topics else [],
            "sentiment_label":      a["sentiment_label"],
            "sentiment_score":      a["sentiment_score"],
            "event_type":           a["event_type"],
            "importance":           a["importance"],
            "impact_tags":          a["impact_tags"],
            "fti_relevance_tags":   [],
            "entity_company_names": a["entity_company_names"],
            "llm_classified_at":    datetime.now(timezone.utc).isoformat(),
        }
        if set_lenders:
            row["lenders"] = a.get("entity_company_names") or []
        rows.append(row)

    inserted = 0
    for i in range(0, len(rows), batch_size):
        result = (
            sb.table("news_articles")
            .upsert(rows[i:i + batch_size], on_conflict="external_id", ignore_duplicates=True)
            .execute()
        )
        if hasattr(result, "error") and result.error:
            log.error("Upsert error at %d: %s", i, result.error)
        else:
            inserted += len(rows[i:i + batch_size])

    return inserted


# ── Financing pipeline ────────────────────────────────────────────────────────


def ingest_financing_articles(
    plants: list[dict],
    sb: Client,
    tavily_key: str,
    gemini_key: str,
    existing_urls: set[str],
    *,
    dry_run: bool = False,
) -> int:
    """Fetch, classify, and store financing-focused articles for each plant.

    Uses finance-specific Tavily search queries and stores results with
    query_tag = 'finance:{plant_code}' and topics = ['financing'].
    entity_company_names (lenders, financiers) are also written to the
    lenders column for direct frontend consumption.
    """
    staged: list[dict] = []

    for plant in plants:
        articles = search_tavily_finance(plant, tavily_key)
        new_count = 0
        for a in articles:
            if a["url"] in existing_urls:
                continue
            existing_urls.add(a["url"])
            staged.append({
                **a,
                "plant_code": plant["eia_plant_code"],
                "owner":      plant.get("owner", ""),
                "state":      plant.get("state", ""),
                "fuel_type":  plant.get("fuel_source", ""),
                "url_hash":   _url_hash(a["url"]),
            })
            new_count += 1
        log.info("  [finance] %-44s → %d new articles", plant["name"][:44], new_count)
        time.sleep(RATE_LIMIT_SECS)

    log.info("Total new financing articles to classify: %d", len(staged))
    if not staged:
        log.info("No new financing articles to store")
        return 0

    # Classify with same batch LLM call
    classified: list[dict] = []
    for i in range(0, len(staged), CLASSIFY_BATCH):
        batch = staged[i:i + CLASSIFY_BATCH]
        log.info("Classifying financing batch %d-%d ...", i, i + len(batch))
        results = classify_and_extract_batch(batch, gemini_key)
        classified.extend(results)
        if i + CLASSIFY_BATCH < len(staged):
            time.sleep(1)

    if dry_run:
        log.info("DRY RUN — skipping financing upsert. Sample article:")
        if classified:
            pprint.pprint(classified[0])
        return 0

    inserted = upsert_articles(
        sb,
        classified,
        query_tag_prefix="finance",
        extra_topics=["financing"],
        set_lenders=True,
    )
    log.info("Inserted %d financing articles", inserted)
    return inserted


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="News ingest pipeline (local dev tool)")
    parser.add_argument("--tier",       type=int, default=1, choices=[1, 2])
    parser.add_argument("--limit",      type=int, default=None, help="Max plants to process")
    parser.add_argument("--dry-run",    action="store_true", help="Fetch but do not upsert")
    parser.add_argument("--financing",  action="store_true", help="Also run finance-focused ingest")
    parser.add_argument("--only-financing", action="store_true",
                        help="Run ONLY the finance ingest (skip general curtailment articles)")
    args = parser.parse_args()

    required = ["TAVILY_API_KEY", "GEMINI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
    missing = [v for v in required if not os.environ.get(v)]
    if missing:
        log.error("Missing env vars: %s", ", ".join(missing))
        sys.exit(1)

    tavily_key = os.environ["TAVILY_API_KEY"]
    gemini_key = os.environ["GEMINI_API_KEY"]
    sb         = _get_supabase()

    # 1 — Load plants
    plants = load_curtailed_plants(sb, args.tier, limit=args.limit)
    if not plants:
        log.info("No curtailed plants found for tier %d — nothing to do", args.tier)
        return

    # 2 — Load existing URLs (shared dedup pool across both pipelines)
    existing_urls = load_existing_urls(sb)
    log.info("Loaded %d existing article URLs for dedup", len(existing_urls))

    if not args.only_financing:
        # 3 — Fetch general articles via Tavily
        staged: list[dict] = []
        for plant in plants:
            articles = search_tavily(plant, tavily_key)
            new_count = 0
            for a in articles:
                if a["url"] in existing_urls:
                    continue
                existing_urls.add(a["url"])
                staged.append({
                    **a,
                    "plant_code": plant["eia_plant_code"],
                    "owner":      plant.get("owner", ""),
                    "state":      plant.get("state", ""),
                    "fuel_type":  plant.get("fuel_source", ""),
                    "url_hash":   _url_hash(a["url"]),
                })
                new_count += 1
            log.info("  %-50s → %d new articles", plant["name"][:50], new_count)
            time.sleep(RATE_LIMIT_SECS)

        log.info("Total new articles to classify: %d", len(staged))
        if staged:
            # 4 — Classify in batches
            classified: list[dict] = []
            for i in range(0, len(staged), CLASSIFY_BATCH):
                batch = staged[i:i + CLASSIFY_BATCH]
                log.info("Classifying batch %d-%d ...", i, i + len(batch))
                results = classify_and_extract_batch(batch, gemini_key)
                classified.extend(results)
                if i + CLASSIFY_BATCH < len(staged):
                    time.sleep(1)

            # 5 — Upsert (or dry-run preview)
            if args.dry_run:
                log.info("DRY RUN — skipping upsert. Sample article:")
                if classified:
                    pprint.pprint(classified[0])
            else:
                inserted = upsert_articles(sb, classified)
                log.info("Inserted %d articles", inserted)
        else:
            log.info("Nothing new to store")

    # 6 — Optional financing pipeline
    if args.financing or args.only_financing:
        log.info("--- Running financing-focused ingest ---")
        ingest_financing_articles(
            plants, sb, tavily_key, gemini_key, existing_urls, dry_run=args.dry_run
        )


if __name__ == "__main__":
    main()
