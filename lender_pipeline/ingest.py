"""
lender_pipeline.ingest — SEC EDGAR lender extraction pipeline.

Queries curtailed plants from Supabase, resolves their owners to SEC CIK numbers,
fetches 10-K and 8-K filings, extracts lender/financing data via Gemini Flash,
and upserts structured rows to the plant_lenders table.

Usage:
    python lender_pipeline/ingest.py               # all curtailed plants
    python lender_pipeline/ingest.py --limit 5     # test on 5 plants
    python lender_pipeline/ingest.py --plant 56789 # single EIA plant code
    python lender_pipeline/ingest.py --dry-run     # fetch + extract, skip upsert
    python lender_pipeline/ingest.py --reprocess   # ignore edgar_filings_seen cache
    python lender_pipeline/ingest.py --forms 10-K  # only 10-K filings

Environment variables required:
    GEMINI_API_KEY
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
"""

from __future__ import annotations

import argparse
import logging
import os
import pprint
import sys
from datetime import datetime, timezone

import httpx
from supabase import create_client, Client

from lender_pipeline.edgar import (
    resolve_cik,
    get_filings,
    get_filing_documents,
    _get_client as _edgar_client,
)
from lender_pipeline.chunker import fetch_and_strip, extract_chunks
from lender_pipeline.extractor import extract_lenders_from_chunk

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("lender_ingest")

# ── Config ────────────────────────────────────────────────────────────────────

MAX_FILINGS_PER_COMPANY = 5   # cap filings processed per CIK per run
MAX_DOCS_PER_FILING     = 3   # cap documents per filing (8-K can have many exhibits)


# ── Supabase helpers ──────────────────────────────────────────────────────────


def _get_supabase() -> Client:
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


def load_curtailed_plants(
    sb: Client,
    limit: int | None = None,
    plant_code: str | None = None,
) -> list[dict]:
    """Load curtailed plants with clean data — same criteria as news ingest."""
    q = (
        sb.table("plants")
        .select("eia_plant_code, name, owner, state, fuel_source, nameplate_capacity_mw")
        .eq("is_likely_curtailed", True)
        .eq("is_maintenance_offline", False)
        .eq("trailing_zero_months", 0)
        .neq("eia_plant_code", "99999")
        .not_.is_("owner", "null")
        .order("nameplate_capacity_mw", desc=True)
    )
    if plant_code:
        q = sb.table("plants").select(
            "eia_plant_code, name, owner, state, fuel_source, nameplate_capacity_mw"
        ).eq("eia_plant_code", plant_code)

    resp = q.limit(limit or 10_000).execute()
    plants = resp.data or []
    log.info("Loaded %d curtailed plants", len(plants))
    return plants


def load_seen_accession_nos(sb: Client) -> set[str]:
    """Load all accession numbers already processed (dedup cache)."""
    resp = sb.table("edgar_filings_seen").select("accession_no").execute()
    return {r["accession_no"] for r in (resp.data or [])}


def mark_filing_seen(
    sb: Client,
    accession_no: str,
    cik: str,
    form_type: str,
    filing_date: str,
    owner_name: str,
    extraction_count: int,
    dry_run: bool,
) -> None:
    if dry_run:
        return
    sb.table("edgar_filings_seen").upsert(
        {
            "accession_no":     accession_no,
            "cik":              cik,
            "form_type":        form_type,
            "filing_date":      filing_date,
            "owner_name":       owner_name,
            "processed_at":     datetime.now(timezone.utc).isoformat(),
            "extraction_count": extraction_count,
        },
        on_conflict="accession_no",
    ).execute()


def upsert_lenders(sb: Client, rows: list[dict]) -> int:
    """Upsert lender rows; returns count of rows attempted."""
    if not rows:
        return 0
    batch_size = 50
    total = 0
    for i in range(0, len(rows), batch_size):
        result = (
            sb.table("plant_lenders")
            .upsert(
                rows[i:i + batch_size],
                on_conflict="eia_plant_code,lender_name,facility_type,accession_no",
                ignore_duplicates=True,
            )
            .execute()
        )
        if hasattr(result, "error") and result.error:
            log.error("Upsert error at batch %d: %s", i, result.error)
        else:
            total += len(rows[i:i + batch_size])
    return total


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="EDGAR lender extraction pipeline")
    parser.add_argument("--limit",     type=int,   default=None, help="Max plants to process")
    parser.add_argument("--plant",     type=str,   default=None, help="Single EIA plant code")
    parser.add_argument("--dry-run",   action="store_true",      help="Skip upsert")
    parser.add_argument("--reprocess", action="store_true",      help="Ignore edgar_filings_seen cache")
    parser.add_argument("--forms",     type=str,   default=None, help="Comma-separated form types e.g. 10-K,8-K")
    args = parser.parse_args()

    required = ["GEMINI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
    missing = [v for v in required if not os.environ.get(v)]
    if missing:
        log.error("Missing env vars: %s", ", ".join(missing))
        sys.exit(1)

    gemini_key = os.environ["GEMINI_API_KEY"]
    sb         = _get_supabase()

    # Parse form filter
    forms_filter: set[str] | None = None
    if args.forms:
        forms_filter = {f.strip().upper() for f in args.forms.split(",")}

    # 1 — Load plants
    plants = load_curtailed_plants(sb, limit=args.limit, plant_code=args.plant)
    if not plants:
        log.info("No plants found — nothing to do")
        return

    # 2 — Load dedup cache
    seen_accession_nos: set[str] = set()
    if not args.reprocess:
        seen_accession_nos = load_seen_accession_nos(sb)
        log.info("Loaded %d seen accession numbers", len(seen_accession_nos))

    # 3 — Resolve unique owners → CIKs (cached across plants)
    cik_cache: dict[str, str | None] = {}
    all_rows: list[dict] = []
    total_filings = 0
    total_chunks  = 0

    with _edgar_client() as edgar_client, httpx.Client(
        headers={"User-Agent": "GenTrack Power Intelligence research@gentrack.io"},
        timeout=60,
        follow_redirects=True,
    ) as doc_client:

        # Group plants by owner to avoid redundant CIK lookups
        owner_to_plants: dict[str, list[dict]] = {}
        for plant in plants:
            owner = (plant.get("owner") or "").strip()
            if not owner:
                continue
            owner_to_plants.setdefault(owner, []).append(plant)

        for owner_name, owner_plants in owner_to_plants.items():
            # Resolve CIK
            cik = resolve_cik(owner_name, edgar_client, cik_cache)
            if not cik:
                log.info("No EDGAR CIK for owner: %s — skipping", owner_name)
                continue

            # Fetch unprocessed filings for this CIK
            filings = get_filings(
                cik, owner_name, seen_accession_nos, edgar_client, forms=forms_filter
            )
            filings = filings[:MAX_FILINGS_PER_COMPANY]

            for filing in filings:
                log.info(
                    "  %s %s (%s) items=%s — %s",
                    filing.form_type, filing.accession_no, filing.filing_date,
                    filing.items, owner_name,
                )
                docs = get_filing_documents(filing, edgar_client)
                docs = docs[:MAX_DOCS_PER_FILING]

                filing_rows: list[dict] = []

                for doc in docs:
                    is_exhibit = doc.doc_type.upper().startswith("EX-")
                    text = fetch_and_strip(doc.url, doc_client)
                    if not text:
                        continue

                    chunks = extract_chunks(text, is_exhibit=is_exhibit)
                    total_chunks += len(chunks)
                    log.info(
                        "    %s: %d chunks from %d chars",
                        doc.doc_type, len(chunks), len(text),
                    )

                    for chunk in chunks:
                        for plant in owner_plants:
                            rows = extract_lenders_from_chunk(
                                chunk=chunk,
                                plant=plant,
                                api_key=gemini_key,
                                filing_url=doc.url,
                                accession_no=filing.accession_no,
                                filing_type=filing.form_type,
                                filing_date=filing.filing_date,
                            )
                            filing_rows.extend(rows)

                # Mark filing as seen (even if zero rows extracted)
                seen_accession_nos.add(filing.accession_no)
                mark_filing_seen(
                    sb,
                    accession_no=filing.accession_no,
                    cik=cik,
                    form_type=filing.form_type,
                    filing_date=filing.filing_date,
                    owner_name=owner_name,
                    extraction_count=len(filing_rows),
                    dry_run=args.dry_run,
                )
                all_rows.extend(filing_rows)
                total_filings += 1

                log.info(
                    "  Filing %s → %d lender rows",
                    filing.accession_no, len(filing_rows),
                )

    log.info(
        "Done. Filings processed: %d | Chunks analyzed: %d | Lender rows: %d",
        total_filings, total_chunks, len(all_rows),
    )

    # 4 — Upsert or dry-run preview
    if args.dry_run:
        log.info("DRY RUN — skipping upsert. Sample rows:")
        for row in all_rows[:3]:
            pprint.pprint(row)
    else:
        inserted = upsert_lenders(sb, all_rows)
        log.info("Upserted %d lender rows", inserted)


if __name__ == "__main__":
    main()
