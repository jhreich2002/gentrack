"""
news_pipeline.sentiment — Classify each article as positive, negative, or
neutral using an LLM prompt focused on financial and operational health signals.

Sentiment is scored on two axes:
    • label:  positive | negative | neutral
    • score:  confidence float 0.0 – 1.0

The classification is tuned for power-plant stakeholders — it weights project
health, financial risk, regulatory standing, operational performance, and
reputational signals rather than generic tone.

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

SENTIMENT_PROMPT = """\
Classify the sentiment of the following news article as it relates to the \
financial and operational health of the power plant or its stakeholders \
(owners, operators, lenders, regulators).

Focus on these dimensions when choosing the label:
  • Project health — capacity factor, outages, curtailment, maintenance
  • Financial risk — debt covenants, credit downgrades, cost overruns
  • Regulatory standing — permit issues, compliance, enforcement actions
  • Operational performance — safety events, efficiency, grid reliability
  • Reputational signals — public opposition, lawsuits, environmental incidents

Return ONLY valid JSON with no extra text:
{{"sentiment": "positive" | "negative" | "neutral", "score": 0.0-1.0, "reason": "one sentence"}}

ARTICLE TITLE: {title}
ARTICLE TEXT:
{text}
"""

# ── Fallback (rule-based) ────────────────────────────────────────────────────

_NEGATIVE_KEYWORDS = {
    "shutdown", "close", "closure", "accident", "leak", "spill", "fire",
    "explosion", "violation", "fine", "penalty", "lawsuit", "bankruptcy",
    "default", "downgrade", "curtailment", "outage", "delay", "overrun",
    "contamination", "recall", "investigation", "suspension", "hazard",
    "layoff",
}

_POSITIVE_KEYWORDS = {
    "expansion", "upgrade", "investment", "approval", "record", "milestone",
    "commission", "award", "growth", "efficiency", "renewable", "modernize",
    "partnership", "acquisition", "funding", "grant", "capacity addition",
    "repowering", "online", "energize",
}


def _rule_based_sentiment(text: str) -> dict[str, Any]:
    """Quick keyword-based fallback when the LLM call fails."""
    lower = text.lower()
    neg = sum(1 for kw in _NEGATIVE_KEYWORDS if kw in lower)
    pos = sum(1 for kw in _POSITIVE_KEYWORDS if kw in lower)

    if neg > pos:
        label = "negative"
        score = min(1.0, 0.5 + 0.1 * (neg - pos))
    elif pos > neg:
        label = "positive"
        score = min(1.0, 0.5 + 0.1 * (pos - neg))
    else:
        label = "neutral"
        score = 0.5

    return {"sentiment": label, "score": round(score, 2), "reason": "rule-based fallback"}


# ── LLM classification ──────────────────────────────────────────────────────


def classify_sentiment(
    title: str,
    text: str,
    *,
    max_text_chars: int = 6000,
) -> dict[str, Any]:
    """Classify the sentiment of an article using Gemini.

    Args:
        title:          Article headline.
        text:           Article body (or description).
        max_text_chars: Truncate article text to this many chars to stay under
                        token limits and reduce cost.

    Returns:
        A dict with keys: sentiment (str), score (float), reason (str).
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.warning("GEMINI_API_KEY not set — using rule-based sentiment")
        return _rule_based_sentiment(f"{title} {text}")

    truncated = text[:max_text_chars] if text else title
    prompt = SENTIMENT_PROMPT.format(title=title, text=truncated)

    try:
        resp = httpx.post(
            f"{GEMINI_URL}?key={api_key}",
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.0, "maxOutputTokens": 256},
            },
            timeout=60,
        )

        if resp.status_code != 200:
            logger.warning("Gemini sentiment HTTP %s — falling back", resp.status_code)
            return _rule_based_sentiment(f"{title} {text}")

        data = resp.json()
        # Gemini 2.5 Flash may return "thinking" parts before the text part.
        # Iterate through all parts and pick the last non-thought text part.
        parts = (
            (data.get("candidates") or [{}])[0]
            .get("content", {})
            .get("parts", [])
        )
        raw = ""
        for part in parts:
            if "text" in part and not part.get("thought"):
                raw = part["text"]

        # Strip markdown code fences if present
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
        cleaned = cleaned.strip()

        # Parse the JSON from the LLM response
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1:
            result = json.loads(cleaned[start : end + 1])
            label = str(result.get("sentiment", "neutral")).lower()
            if label not in ("positive", "negative", "neutral"):
                label = "neutral"
            return {
                "sentiment": label,
                "score": float(result.get("score", 0.5)),
                "reason": str(result.get("reason", "")),
            }

        logger.warning("Could not parse Gemini sentiment JSON — falling back")
        return _rule_based_sentiment(f"{title} {text}")

    except Exception as exc:
        logger.warning("Sentiment classification failed (%s) — falling back", exc)
        return _rule_based_sentiment(f"{title} {text}")


def classify_batch(
    articles: list[dict[str, str]],
) -> list[dict[str, Any]]:
    """Classify sentiment for a list of articles.

    Each dict should have keys 'title' and 'text'.
    Returns a list of sentiment result dicts in the same order.
    """
    return [
        classify_sentiment(a.get("title", ""), a.get("text", ""))
        for a in articles
    ]
