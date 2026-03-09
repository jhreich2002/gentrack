"""
Test runner: exercises the full news_pipeline on a handful of well-known plants
to validate ingest → sentiment → entities → chunk → embed → retrieve → RAG.

Usage:
    .venv\\Scripts\\python news_pipeline/run_test.py
"""

import json
import logging
import os
import sys

# ── Ensure the repo root is on sys.path ──────────────────────────────────────
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from news_pipeline.ingest import ingest_articles, _url_hash
from news_pipeline.chunk import chunk_article
from news_pipeline.embed import embed_and_upsert
from news_pipeline.retrieve import retrieve_chunks, rag_answer
from news_pipeline.sentiment import classify_sentiment
from news_pipeline.entities import extract_entities

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("test_runner")

# ── Test plants (large, well-known, high news coverage) ──────────────────────

TEST_PLANTS = [
    {
        "eia_plant_code": "6008",
        "name": "Palo Verde",
        "state": "AZ",
        "fuel_source": "Nuclear",
        "owner": "Arizona Public Service",
    },
    {
        "eia_plant_code": "3161",
        "name": "Vogtle",
        "state": "GA",
        "fuel_source": "Nuclear",
        "owner": "Georgia Power",
    },
    {
        "eia_plant_code": "56564",
        "name": "Traverse Wind Energy Center",
        "state": "OK",
        "fuel_source": "Wind",
        "owner": "AEP Oklahoma Transmission Company",
    },
]


def main() -> None:
    # Verify env vars
    required = ["GEMINI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
    missing = [v for v in required if not os.environ.get(v)]
    if missing:
        log.error("Missing env vars: %s", ", ".join(missing))
        sys.exit(1)

    # ── Step 1: Ingest ───────────────────────────────────────────────────
    log.info("=" * 60)
    log.info("STEP 1 — INGEST (Gemini grounded search + URL verification)")
    log.info("=" * 60)

    articles = ingest_articles(TEST_PLANTS, verify_urls=True, skip_existing=True)
    log.info("Ingest returned %d new articles\n", len(articles))

    if not articles:
        log.warning("No new articles found — they may already exist in the DB.")
        log.info("Continuing with dummy data for chunk/embed/retrieve validation...\n")
        # Use a synthetic article so we can still test the rest of the pipeline
        articles = [
            type("EA", (), {
                "title": "Vogtle Unit 4 reaches full power for first time",
                "url": "https://www.reuters.com/business/energy/vogtle-unit4-full-power-2025-04-01/",
                "url_hash": _url_hash("https://www.reuters.com/business/energy/vogtle-unit4-full-power-2025-04-01/"),
                "source": "Reuters",
                "published_date": "2025-04-01",
                "description": "Georgia Power announced that Vogtle Unit 4 has reached 100% capacity for the first time, marking a milestone for the $35 billion nuclear expansion project. The unit began commercial operations in early 2024 after years of delays and cost overruns. Southern Company CEO said the project demonstrates the viability of new nuclear construction in the US.",
                "full_text": "Georgia Power announced that Vogtle Unit 4 has reached 100% capacity for the first time. The unit is part of the Vogtle expansion project, which added two AP1000 reactors to the existing plant near Waynesboro, Georgia. The project faced significant cost overruns and schedule delays, with total costs reaching approximately $35 billion. Despite the challenges, Georgia Power and parent company Southern Company have emphasized the importance of the new nuclear capacity for the state's clean energy portfolio. Lenders including JPMorgan Chase and Bank of America provided financing for the project through a combination of loan guarantees and direct lending facilities.",
                "plant_id": "3161",
                "owner": "Georgia Power",
                "lenders": ["JPMorgan Chase", "Bank of America"],
                "lender_ids": [],
                "sentiment": "positive",
                "sentiment_score": 0.85,
                "sentiment_reason": "Milestone achievement for nuclear plant",
            })()
        ]

    # ── Step 2: Sentiment (standalone test) ──────────────────────────────
    log.info("=" * 60)
    log.info("STEP 2 — SENTIMENT CLASSIFICATION (standalone test)")
    log.info("=" * 60)

    test_texts = [
        ("Plant X shuts down after safety violation", "Regulators ordered an emergency shutdown after repeated safety violations were found."),
        ("New solar farm exceeds capacity targets", "The 500MW solar installation generated 15% above projected output in its first quarter."),
        ("Routine maintenance scheduled for reactor", "The plant will undergo a planned refueling outage lasting approximately 30 days."),
    ]
    for title, text in test_texts:
        result = classify_sentiment(title, text)
        log.info("  %-10s (%.2f) — %s | %s", result["sentiment"], result["score"], title, result.get("reason", ""))
    print()

    # ── Step 3: Entity extraction (standalone test) ──────────────────────
    log.info("=" * 60)
    log.info("STEP 3 — ENTITY EXTRACTION (standalone test)")
    log.info("=" * 60)

    sample_text = (
        "Southern Company's Vogtle nuclear plant received a $3.7 billion loan guarantee "
        "from the U.S. Department of Energy. JPMorgan Chase and Goldman Sachs served as "
        "underwriters for the bond issuance. Bank of America provided a revolving credit "
        "facility to Georgia Power for the project."
    )
    entities = extract_entities(
        sample_text, plant_name="Vogtle", owner="Georgia Power"
    )
    log.info("  Owner:   %s", entities["owner"])
    log.info("  Lenders: %s", entities["lenders"])
    log.info("  Orgs:    %s", entities["orgs"])
    print()

    # ── Step 4: Chunk ────────────────────────────────────────────────────
    log.info("=" * 60)
    log.info("STEP 4 — CHUNKING")
    log.info("=" * 60)

    all_chunks = []
    for art in articles:
        text = getattr(art, "full_text", "") or getattr(art, "description", "")
        chunks = chunk_article(
            text,
            article_url=art.url,
            article_hash=art.url_hash,
            plant_id=art.plant_id,
            owner=art.owner,
            lenders=art.lenders,
            lender_ids=getattr(art, "lender_ids", []),
            published_date=art.published_date,
            sentiment=art.sentiment,
            sentiment_score=art.sentiment_score,
            source=art.source,
            title=art.title,
        )
        log.info("  %s → %d chunks", art.title[:50], len(chunks))
        all_chunks.extend(chunks)

    log.info("Total chunks: %d\n", len(all_chunks))

    # ── Step 5: Embed & upsert ───────────────────────────────────────────
    log.info("=" * 60)
    log.info("STEP 5 — EMBED & UPSERT TO VECTOR DB")
    log.info("=" * 60)

    inserted = embed_and_upsert(all_chunks, skip_existing=True)
    log.info("Inserted %d chunks into news_embeddings\n", inserted)

    # ── Step 6: Retrieve ─────────────────────────────────────────────────
    log.info("=" * 60)
    log.info("STEP 6 — VECTOR RETRIEVAL")
    log.info("=" * 60)

    test_query = "What is the status of the Vogtle nuclear expansion project?"
    results = retrieve_chunks(test_query, plant_id="3161", top_k=5)
    log.info("  Query: %s", test_query)
    log.info("  Results: %d chunks", len(results))
    for r in results[:3]:
        log.info("    [%.3f] %s — %s", r.similarity, r.title[:40], r.chunk_text[:80])
    print()

    # ── Step 7: RAG answer ───────────────────────────────────────────────
    log.info("=" * 60)
    log.info("STEP 7 — RAG ANSWER (grounded generation)")
    log.info("=" * 60)

    rag = rag_answer(
        "What are the latest developments at Vogtle nuclear plant?",
        plant_id="3161",
        top_k=5,
    )
    log.info("  Answer:\n    %s", rag["answer"][:500])
    log.info("  Sources: %s", rag["sources"])
    log.info("  Chunks used: %d", len(rag["chunks"]))

    log.info("\n" + "=" * 60)
    log.info("✅  ALL STEPS COMPLETE")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
