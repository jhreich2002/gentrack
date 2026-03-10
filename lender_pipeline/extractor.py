"""
lender_pipeline.extractor — Gemini Flash lender extraction + validation.

One Gemini call per text chunk. Returns a list of validated lender rows.
Temperature 0 for maximum determinism on structured extraction.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

import httpx

log = logging.getLogger("lender_ingest.extractor")

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)
RATE_LIMIT_SECS = 1.0   # 1 req/sec — generous headroom for Gemini Flash

VALID_FACILITY_TYPES = {
    "term_loan", "revolver", "letter_of_credit", "bond", "tax_equity",
    "construction_loan", "bridge_loan", "mezzanine", "preferred_equity", "other",
}

# Generic placeholder names that indicate the LLM couldn't identify a real lender
GENERIC_LENDER_NAMES = {
    "the lenders", "lenders", "administrative agent", "agent", "the agent",
    "collateral agent", "trustee", "the trustee", "noteholders",
    "the banks", "banks", "the bank", "financial institutions",
}

# Maximum plausible single facility amount ($100B — larger means parsing error)
MAX_LOAN_AMOUNT = 100_000_000_000


# ── Prompt ────────────────────────────────────────────────────────────────────


def _build_prompt(chunk: str, plant: dict) -> str:
    return (
        "You are extracting structured financing data from SEC EDGAR filing text "
        "for a power plant intelligence application used by a consulting firm.\n\n"
        f"Plant context:\n"
        f"  Name:      {plant.get('name', 'Unknown')}\n"
        f"  Owner:     {plant.get('owner', 'Unknown')}\n"
        f"  State:     {plant.get('state', 'Unknown')}\n"
        f"  Fuel type: {plant.get('fuel_source', 'Unknown')}\n\n"
        "Extract ALL lender/financing relationships explicitly mentioned in the text below.\n"
        "For each lender or facility, return:\n"
        "  - lender_name: the exact named financial institution (NOT generic placeholders like "
        "'the Lenders' or 'Administrative Agent')\n"
        "  - facility_type: one of [term_loan, revolver, letter_of_credit, bond, tax_equity, "
        "construction_loan, bridge_loan, mezzanine, preferred_equity, other]\n"
        "  - loan_amount_usd: total amount in USD as a plain number, or null if not stated. "
        "Convert: '$350 million' → 350000000, '$1.2 billion' → 1200000000\n"
        "  - interest_rate_text: exact rate text as written (e.g. 'SOFR + 2.25%', '6.875% fixed'), "
        "or null\n"
        "  - maturity_text: exact maturity text as written, or null\n"
        "  - maturity_date: ISO date (YYYY-MM-DD) if parseable, else null\n"
        "  - confidence: 'high' if lender name + amount + rate all present; "
        "'medium' if some fields missing; 'low' if heavily inferred\n"
        "  - excerpt: the specific 1-3 sentences that directly support this extraction\n\n"
        "Rules:\n"
        "  - Only extract facilities directly related to the plant or its owner/operator\n"
        "  - Skip corporate parent revolvers unrelated to this plant's project finance\n"
        "  - Do NOT invent lender names — if the name is not explicitly stated, skip the row\n"
        "  - Return ONLY a JSON array. If no lender data is present, return []\n\n"
        "Example output:\n"
        '[{"lender_name":"JPMorgan Chase Bank, N.A.","facility_type":"term_loan",'
        '"loan_amount_usd":350000000,"interest_rate_text":"SOFR + 2.25%",'
        '"maturity_text":"December 15, 2028","maturity_date":"2028-12-15",'
        '"confidence":"high","excerpt":"The Company entered into a $350 million term loan '
        'with JPMorgan Chase Bank, N.A. bearing interest at SOFR plus 225 basis points."}]\n\n'
        f"Filing text:\n{chunk}"
    )


# ── Gemini call ───────────────────────────────────────────────────────────────


def _call_gemini(prompt: str, api_key: str) -> list[dict]:
    """Single Gemini Flash call. Returns parsed JSON list or [] on any error."""
    try:
        resp = httpx.post(
            f"{GEMINI_URL}?key={api_key}",
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.0, "maxOutputTokens": 2048},
            },
            timeout=60,
        )
        time.sleep(RATE_LIMIT_SECS)

        if resp.status_code != 200:
            log.warning("Gemini HTTP %d: %s", resp.status_code, resp.text[:300])
            return []

        data = resp.json()
        # Skip thinking parts (Gemini 2.5 Flash)
        raw = ""
        for part in (data.get("candidates") or [{}])[0].get("content", {}).get("parts", []):
            if "text" in part and not part.get("thought"):
                raw = part["text"]

        start = raw.find("[")
        end   = raw.rfind("]")
        if start == -1 or end == -1:
            return []

        return json.loads(raw[start:end + 1])

    except Exception as exc:
        log.warning("Gemini extraction error: %s", exc)
        return []


# ── Validation + normalization ────────────────────────────────────────────────


def _normalize_lender_name(name: str) -> str:
    """Clean up lender name: strip trailing punctuation, N.A., etc."""
    name = name.strip().rstrip(".,;:")
    # Remove trailing ", N.A." variations but keep "N.A." if it's not trailing
    name = re.sub(r",?\s+N\.?A\.?\s*$", "", name, flags=re.IGNORECASE).strip()
    return name


def _is_generic(name: str) -> bool:
    return name.lower().strip() in GENERIC_LENDER_NAMES


def _parse_amount(raw: Any) -> float | None:
    """Parse loan amount — handles LLM returning strings like '$350 million'."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if raw > 0 else None
    if isinstance(raw, str):
        raw = raw.replace(",", "").replace("$", "").lower().strip()
        mult = 1
        if "billion" in raw:
            mult = 1_000_000_000
            raw = raw.replace("billion", "").strip()
        elif "million" in raw:
            mult = 1_000_000
            raw = raw.replace("million", "").strip()
        try:
            return float(raw) * mult
        except ValueError:
            return None
    return None


def _detect_thousands_context(chunk: str) -> bool:
    """Return True if the chunk contains 'in thousands' — amounts need ×1000."""
    return bool(re.search(r"\bin thousands\b", chunk, re.IGNORECASE))


def validate_and_normalize(
    rows: list[dict],
    chunk: str,
    plant: dict,
    filing_url: str,
    accession_no: str,
    filing_type: str,
    filing_date: str,
) -> list[dict]:
    """
    Validate Gemini output rows and enrich with filing provenance.
    Returns only rows that pass all checks.
    """
    in_thousands = _detect_thousands_context(chunk)
    valid: list[dict] = []

    for row in rows:
        lender_name = str(row.get("lender_name") or "").strip()
        if not lender_name:
            continue
        lender_name = _normalize_lender_name(lender_name)
        if _is_generic(lender_name):
            log.debug("Skipping generic lender name: %s", lender_name)
            continue

        facility_type = str(row.get("facility_type") or "other").lower().strip()
        if facility_type not in VALID_FACILITY_TYPES:
            facility_type = "other"

        amount = _parse_amount(row.get("loan_amount_usd"))
        if amount and in_thousands:
            amount *= 1_000
        if amount and amount > MAX_LOAN_AMOUNT:
            log.debug("Implausible amount %.0f for %s — discarding", amount, lender_name)
            amount = None

        confidence = str(row.get("confidence") or "medium").lower()
        if confidence not in ("high", "medium", "low"):
            confidence = "medium"

        # Excerpt: cap at 600 chars
        excerpt = str(row.get("excerpt") or "")[:600] or None

        valid.append({
            "eia_plant_code":      plant["eia_plant_code"],
            "lender_name":         lender_name,
            "facility_type":       facility_type,
            "loan_amount_usd":     amount,
            "interest_rate_text":  row.get("interest_rate_text") or None,
            "maturity_date":       row.get("maturity_date") or None,
            "maturity_text":       row.get("maturity_text") or None,
            "filing_type":         filing_type,
            "filing_date":         filing_date,
            "filing_url":          filing_url,
            "accession_no":        accession_no,
            "excerpt_text":        excerpt,
            "confidence":          confidence,
        })

    return valid


# ── Public API ────────────────────────────────────────────────────────────────


def extract_lenders_from_chunk(
    chunk: str,
    plant: dict,
    api_key: str,
    filing_url: str,
    accession_no: str,
    filing_type: str,
    filing_date: str,
) -> list[dict]:
    """
    Run Gemini extraction on a single text chunk and return validated rows.

    Each returned dict maps directly to a `plant_lenders` table row
    (minus `id` and `extracted_at` which Supabase fills).
    """
    prompt = _build_prompt(chunk, plant)
    raw_rows = _call_gemini(prompt, api_key)
    if not raw_rows:
        return []

    return validate_and_normalize(
        raw_rows, chunk, plant, filing_url, accession_no, filing_type, filing_date
    )
