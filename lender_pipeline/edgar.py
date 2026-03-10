"""
lender_pipeline.edgar — SEC EDGAR API client.

Handles:
  - CIK resolution: owner name → list of (cik, entity_name) candidates
  - Submissions fetch: CIK → filtered list of unprocessed filings
  - Filing index fetch: accession number → list of target documents

SEC fair use policy: identify your application via User-Agent, stay under 10 req/sec.
No API key required.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field

import httpx
from rapidfuzz import fuzz

log = logging.getLogger("lender_ingest.edgar")

# ── Constants ─────────────────────────────────────────────────────────────────

USER_AGENT = "GenTrack Power Intelligence research@gentrack.io"
RATE_LIMIT_SECS = 0.12   # stay well under 10 req/sec
MIN_FUZZY_SCORE = 72      # rapidfuzz ratio threshold for name matching
FILINGS_START   = "2020-01-01"
PRIORITY_FORMS  = {"10-K", "8-K"}

EDGAR_SEARCH_URL  = "https://efts.sec.gov/LATEST/search-index"
EDGAR_SUBMIT_URL  = "https://data.sec.gov/submissions/CIK{cik}.json"
EDGAR_INDEX_URL   = (
    "https://www.sec.gov/Archives/edgar/data/{cik}/{accno_nodash}/{accno_dash}-index.json"
)
EDGAR_DOC_BASE    = "https://www.sec.gov/Archives/edgar/data/{cik}/{accno_nodash}/"

# ── Data classes ──────────────────────────────────────────────────────────────


@dataclass
class CIKCandidate:
    cik: str
    entity_name: str
    score: float   # rapidfuzz ratio 0-100


@dataclass
class FilingInfo:
    accession_no: str      # with dashes: "0001234567-23-000123"
    form_type: str
    filing_date: str       # ISO date string
    cik: str
    owner_name: str
    primary_document: str  # filename of primary doc from submissions JSON
    items: str             # 8-K item codes, e.g. "1.01,9.01"


@dataclass
class FilingDocument:
    filename: str
    doc_type: str        # "10-K", "EX-10.1", etc.
    description: str
    url: str


# ── HTTP client ───────────────────────────────────────────────────────────────


def _get_client() -> httpx.Client:
    return httpx.Client(
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=30,
        follow_redirects=True,
    )


def _sleep():
    time.sleep(RATE_LIMIT_SECS)


# ── CIK resolution ────────────────────────────────────────────────────────────


def _extract_cik_from_url(url: str) -> str | None:
    """Extract numeric CIK from an EDGAR filing URL."""
    # URLs look like: /Archives/edgar/data/1234567/...
    m = re.search(r"/edgar/data/(\d+)/", url)
    if m:
        return m.group(1)
    # Also try the entity path in search results
    m = re.search(r"CIK=?(\d{7,10})", url, re.IGNORECASE)
    return m.group(1) if m else None


def resolve_cik(
    owner_name: str,
    client: httpx.Client,
    cache: dict[str, str | None],
) -> str | None:
    """
    Resolve a plant owner name to a SEC CIK.

    Returns the CIK string (without leading zeros) or None if not found.
    Results are cached in `cache` keyed by owner_name.
    """
    if owner_name in cache:
        return cache[owner_name]

    candidates: list[CIKCandidate] = []

    # Try two queries: quoted exact phrase, then unquoted for subsidiaries
    for quoted in (True, False):
        q = f'"{owner_name}"' if quoted else owner_name
        try:
            resp = client.get(
                EDGAR_SEARCH_URL,
                params={
                    "q":         q,
                    "forms":     "10-K,8-K",
                    "dateRange": "custom",
                    "startdt":   FILINGS_START,
                    "enddt":     "2026-12-31",
                },
            )
            _sleep()
            if resp.status_code != 200:
                log.warning("EDGAR search HTTP %d for %s", resp.status_code, owner_name)
                continue

            hits = resp.json().get("hits", {}).get("hits", [])
            for hit in hits[:20]:
                src = hit.get("_source", {})

                # EDGAR EFTS response uses 'ciks' (list) and 'display_names' (list)
                # display_names look like: "PORTLAND GENERAL ELECTRIC CO /OR/  (POR)  (CIK 0000784977)"
                ciks_list    = src.get("ciks") or []
                display_list = src.get("display_names") or []

                if not ciks_list or not display_list:
                    continue

                cik         = str(int(ciks_list[0]))   # strip leading zeros
                display     = display_list[0]

                # Extract clean entity name from display string (before the ticker/CIK suffix)
                entity_name = re.split(r"\s{2,}|\(CIK", display)[0].strip()

                score = fuzz.ratio(owner_name.lower(), entity_name.lower())
                candidates.append(CIKCandidate(cik=cik, entity_name=entity_name, score=score))

        except Exception as exc:
            log.warning("EDGAR search error for %s: %s", owner_name, exc)

    if not candidates:
        log.info("No EDGAR candidates for: %s", owner_name)
        cache[owner_name] = None
        return None

    # Sort by score, take best match above threshold
    candidates.sort(key=lambda c: c.score, reverse=True)
    best = candidates[0]

    if best.score < MIN_FUZZY_SCORE:
        log.info(
            "Best EDGAR match for '%s' is '%s' (score=%.0f) — below threshold, skipping",
            owner_name, best.entity_name, best.score,
        )
        cache[owner_name] = None
        return None

    log.info(
        "Resolved '%s' → CIK %s ('%s', score=%.0f)",
        owner_name, best.cik, best.entity_name, best.score,
    )
    cache[owner_name] = best.cik
    return best.cik


# ── Submissions ───────────────────────────────────────────────────────────────


def get_filings(
    cik: str,
    owner_name: str,
    seen_accession_nos: set[str],
    client: httpx.Client,
    forms: set[str] | None = None,
) -> list[FilingInfo]:
    """
    Fetch the submission history for a CIK and return filings not yet processed.

    Args:
        cik: numeric CIK (no leading zeros required — padded internally)
        owner_name: stored in FilingInfo for DB insertion
        seen_accession_nos: set of accession numbers already in edgar_filings_seen
        forms: set of form types to include; defaults to PRIORITY_FORMS
    """
    if forms is None:
        forms = PRIORITY_FORMS

    cik_padded = cik.zfill(10)
    url = EDGAR_SUBMIT_URL.format(cik=cik_padded)

    try:
        resp = client.get(url)
        _sleep()
        if resp.status_code != 200:
            log.warning("Submissions HTTP %d for CIK %s", resp.status_code, cik)
            return []
        data = resp.json()
    except Exception as exc:
        log.warning("Submissions fetch error for CIK %s: %s", cik, exc)
        return []

    recent = data.get("filings", {}).get("recent", {})
    form_list     = recent.get("form", [])
    date_list     = recent.get("filingDate", [])
    accno_list    = recent.get("accessionNumber", [])
    primary_list  = recent.get("primaryDocument", [])
    items_list    = recent.get("items", [])

    results: list[FilingInfo] = []
    for i, (form, date, accno) in enumerate(zip(form_list, date_list, accno_list)):
        if form not in forms:
            continue
        if date < FILINGS_START:
            continue
        # Normalize accession number: "0001234567-23-000123" (with dashes)
        accno_dash = accno if "-" in accno else (
            f"{accno[:10]}-{accno[10:12]}-{accno[12:]}"
        )
        if accno_dash in seen_accession_nos:
            continue

        # For 8-K: only include if item 1.01 (Entry into Material Definitive Agreement)
        items = items_list[i] if i < len(items_list) else ""
        if form == "8-K" and "1.01" not in str(items):
            continue

        results.append(FilingInfo(
            accession_no=accno_dash,
            form_type=form,
            filing_date=date,
            cik=cik,
            owner_name=owner_name,
            primary_document=primary_list[i] if i < len(primary_list) else "",
            items=str(items),
        ))

    # Prioritize 10-K over 8-K, then most recent first
    results.sort(key=lambda f: (f.form_type != "10-K", f.filing_date), reverse=False)
    results.sort(key=lambda f: f.filing_date, reverse=True)
    log.info("CIK %s: %d unprocessed filings (%s)", cik, len(results), owner_name)
    return results


# ── Filing documents ──────────────────────────────────────────────────────────


def get_filing_documents(
    filing: FilingInfo,
    client: httpx.Client,
) -> list[FilingDocument]:
    """
    Build the list of target documents for a filing.

    Uses primaryDocument from the submissions JSON directly (no separate index fetch
    needed — the EDGAR -index.json endpoint is unreliable/missing for many filers).

    For 10-K: returns the primary document.
    For 8-K with item 1.01: returns the primary document (which is typically the
    8-K body referencing the credit agreement, or is the exhibit itself).
    """
    if not filing.primary_document:
        log.debug("No primary document for %s", filing.accession_no)
        return []

    accno_nodash = filing.accession_no.replace("-", "")
    base_url = EDGAR_DOC_BASE.format(cik=filing.cik, accno_nodash=accno_nodash)
    doc_url  = base_url + filing.primary_document

    return [FilingDocument(
        filename=filing.primary_document,
        doc_type=filing.form_type,
        description="",
        url=doc_url,
    )]
