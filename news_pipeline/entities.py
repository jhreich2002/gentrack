"""
news_pipeline.entities — Extract plant names, owners, and lender/financier
mentions from article text using spaCy NER + a focused Gemini LLM extraction
prompt for financial-context entities that NER alone would miss.

The two-pass approach:
    Pass 1 — spaCy NER:    Extract ORG + GPE entities as candidates.
    Pass 2 — Gemini LLM:   From the candidate list + raw text, identify which
                           entities are lenders, financiers, bond issuers,
                           credit facility providers, or debt backers.

Environment variables (assumed already set):
    GEMINI_API_KEY
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)

# Financial-role keywords that signal a lender/financier mention
_LENDER_SIGNAL_WORDS = {
    "lender", "lenders", "financer", "financier", "financiers",
    "debt provider", "credit facility", "credit facilities",
    "bond issuer", "bondholder", "bondholders", "underwriter",
    "syndicate", "syndicated", "loan", "revolving credit",
    "term loan", "project finance", "debt", "financing",
    "bank", "fund", "capital", "mortgage",
}

LENDER_EXTRACTION_PROMPT = """\
You are analyzing a news article about a power plant. Extract any entities that \
serve a financial backer role — lenders, financiers, banks, bond issuers, \
credit facility providers, debt providers, underwriters, or investors.

Also confirm the plant owner if mentioned.

Return ONLY valid JSON with no extra text:
{{
  "owner": "name or null",
  "lenders": ["name1", "name2"],
  "lender_context": ["one-sentence explanation of each lender's role"]
}}

Known plant name: {plant_name}
Known owner: {owner}

ARTICLE TEXT:
{text}
"""


# ── spaCy NER (lazy-loaded) ──────────────────────────────────────────────────

_nlp = None


def _get_nlp():
    """Lazy-load the spaCy English model.

    Falls back to the small model (en_core_web_sm) if the medium one isn't
    installed.  If no spaCy model is available, returns None and the pipeline
    gracefully degrades to LLM-only extraction.
    """
    global _nlp
    if _nlp is not None:
        return _nlp

    try:
        import spacy

        for model in ("en_core_web_md", "en_core_web_sm"):
            try:
                _nlp = spacy.load(model)
                logger.info("Loaded spaCy model: %s", model)
                return _nlp
            except OSError:
                continue

        logger.warning(
            "No spaCy English model found. Install one with: "
            "python -m spacy download en_core_web_sm"
        )
    except ImportError:
        logger.warning("spaCy not installed — entity extraction will use LLM only")

    return None


def _spacy_extract_orgs(text: str) -> list[str]:
    """Extract ORG entities from text using spaCy NER.

    Returns deduplicated list of organization names.
    """
    nlp = _get_nlp()
    if nlp is None:
        return []

    # Limit text length to keep spaCy fast
    doc = nlp(text[:10_000])
    orgs: set[str] = set()
    for ent in doc.ents:
        if ent.label_ in ("ORG", "GPE"):
            name = ent.text.strip()
            if len(name) > 2:
                orgs.add(name)
    return sorted(orgs)


# ── LLM extraction ──────────────────────────────────────────────────────────


def _llm_extract_lenders(
    text: str,
    plant_name: str,
    owner: str,
) -> dict[str, Any]:
    """Call Gemini to identify lender / financier entities in context.

    Returns a dict with keys: owner (str|None), lenders (list[str]).
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.warning("GEMINI_API_KEY not set — skipping LLM entity extraction")
        return {"owner": owner or None, "lenders": []}

    truncated = text[:6000]
    prompt = LENDER_EXTRACTION_PROMPT.format(
        plant_name=plant_name,
        owner=owner or "unknown",
        text=truncated,
    )

    try:
        resp = httpx.post(
            f"{GEMINI_URL}?key={api_key}",
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.0, "maxOutputTokens": 512},
            },
            timeout=60,
        )

        if resp.status_code != 200:
            logger.warning("Gemini entity extraction HTTP %s", resp.status_code)
            return {"owner": owner or None, "lenders": []}

        data = resp.json()
        raw = (
            (data.get("candidates") or [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )

        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1:
            result = json.loads(raw[start : end + 1])
            return {
                "owner": result.get("owner") or owner or None,
                "lenders": [
                    str(l).strip()
                    for l in result.get("lenders", [])
                    if l and str(l).strip()
                ],
            }

        return {"owner": owner or None, "lenders": []}

    except Exception as exc:
        logger.warning("LLM entity extraction failed: %s", exc)
        return {"owner": owner or None, "lenders": []}


# ── Lender ID matching ──────────────────────────────────────────────────────


def _match_lender_ids(
    lender_names: list[str],
    known_lenders: dict[str, str] | None = None,
) -> list[str]:
    """Match extracted lender names against a known-lenders lookup.

    Args:
        lender_names:   Names extracted from the article.
        known_lenders:  Optional dict mapping lowercased lender name → lender_id.
                        If None, no matching is attempted.

    Returns:
        List of matched lender IDs (may be shorter than lender_names).
    """
    if not known_lenders or not lender_names:
        return []

    matched: list[str] = []
    for name in lender_names:
        lower = name.lower().strip()
        # Exact match
        if lower in known_lenders:
            matched.append(known_lenders[lower])
            continue
        # Substring match (e.g. "JPMorgan Chase" matches "jpmorgan")
        for known_name, lid in known_lenders.items():
            if known_name in lower or lower in known_name:
                matched.append(lid)
                break

    return matched


# ── Rule-based lender detection (fast pre-filter) ────────────────────────────


def _rule_based_lender_hints(text: str, orgs: list[str]) -> list[str]:
    """Return ORG entities that appear near financial-role keywords.

    This is a cheap heuristic to narrow the candidate list before sending
    to the LLM.
    """
    lower = text.lower()
    hints: list[str] = []

    for org in orgs:
        # Check if the org name appears near a lender signal word
        org_lower = org.lower()
        idx = lower.find(org_lower)
        if idx == -1:
            continue
        # Look at a ±200 char window around the mention
        window = lower[max(0, idx - 200) : idx + len(org_lower) + 200]
        if any(signal in window for signal in _LENDER_SIGNAL_WORDS):
            hints.append(org)

    return hints


# ── Public API ───────────────────────────────────────────────────────────────


def extract_entities(
    text: str,
    *,
    plant_name: str = "",
    owner: str = "",
    known_lenders: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Extract plant owner, lender, and financier entities from article text.

    Two-pass approach:
        1. spaCy NER to surface ORG candidates
        2. Gemini LLM to identify which orgs are lenders/financiers

    Matched lender names are cross-referenced against *known_lenders*
    (a dict of lowercased_name → lender_id) to populate lender_ids.

    Args:
        text:           Full article text (or description).
        plant_name:     The power plant name (used as context for the LLM).
        owner:          Known plant owner name.
        known_lenders:  Optional lookup dict for lender ID matching.

    Returns:
        A dict with keys:
            owner       (str)       — confirmed or extracted owner name
            lenders     (list[str]) — lender/financier names
            lender_ids  (list[str]) — matched lender IDs
            orgs        (list[str]) — all ORG entities from spaCy NER
    """
    if not text or not text.strip():
        return {
            "owner": owner or None,
            "lenders": [],
            "lender_ids": [],
            "orgs": [],
        }

    # Pass 1: spaCy NER
    orgs = _spacy_extract_orgs(text)

    # Pass 2: LLM extraction (identifies lenders from context)
    llm_result = _llm_extract_lenders(text, plant_name, owner)

    extracted_owner = llm_result.get("owner") or owner
    lenders = llm_result.get("lenders", [])

    # Also fold in any rule-based hints from NER orgs that appeared
    # near financial keywords — the LLM may have missed some
    rule_hints = _rule_based_lender_hints(text, orgs)
    for hint in rule_hints:
        if hint not in lenders:
            lenders.append(hint)

    # Match against known lenders
    lender_ids = _match_lender_ids(lenders, known_lenders)

    return {
        "owner": extracted_owner,
        "lenders": lenders,
        "lender_ids": lender_ids,
        "orgs": orgs,
    }
