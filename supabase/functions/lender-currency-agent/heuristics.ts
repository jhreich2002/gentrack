/**
 * GenTrack — Lender Currency Heuristic Pre-Scorer
 *
 * Pure deterministic logic for classifying loan currency (active/matured/refinanced/unknown)
 * without any API calls. Imported by both the edge function and the backfill script.
 *
 * Rules are applied in order; first match wins.
 * Expected coverage: ~50% of lender rows classified without API cost.
 */

export type LoanStatus = 'active' | 'matured' | 'refinanced' | 'unknown';

export interface HeuristicInput {
  /** EIA COD string e.g. '2017-06' or '2017', or null if unknown */
  cod: string | null;
  /** plant_lenders.facility_type */
  facility_type: string;
  /** plant_lenders.maturity_text — free-text field like "2031", "June 2028", "7 years" */
  maturity_text: string | null;
  /** plant_lenders.loan_amount_usd — not used in logic but available */
  loan_amount_usd: number | null;
  /** Timestamp of the source article (plant_lenders.article_published_at) */
  article_published_at: string | null;
  /** plant_lenders.source */
  source: string;
}

export interface HeuristicResult {
  loan_status: LoanStatus;
  /** 0–100 confidence score */
  confidence: number;
  reasoning: string;
  /** true → send to LLM agent for deeper analysis */
  is_ambiguous: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();

/** Extract a 4-digit year from free-text strings like "June 2031", "2031-06", "FY2031" */
function extractYear(text: string): number | null {
  const match = text.match(/\b(20\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/** Parse COD string ('2017-06' or '2017') → integer year, or null */
function parseCodYear(cod: string | null): number | null {
  if (!cod) return null;
  const match = cod.match(/^(20\d{2})/);
  return match ? parseInt(match[1], 10) : null;
}

/** Years since COD. Returns null if COD is unknown. */
function codAgeYears(cod: string | null): number | null {
  const year = parseCodYear(cod);
  if (year === null) return null;
  return CURRENT_YEAR - year;
}

// ── Rule application ──────────────────────────────────────────────────────────

/**
 * Score a single lender row with deterministic heuristics.
 * Rules are applied in priority order; first match returns.
 */
export function scoreHeuristic(input: HeuristicInput): HeuristicResult {
  const { facility_type, maturity_text, cod, article_published_at } = input;
  const codAge = codAgeYears(cod);

  // ── Rule 1: Explicit maturity year in maturity_text ──────────────────────
  if (maturity_text) {
    const matYear = extractYear(maturity_text);
    if (matYear !== null) {
      if (matYear < CURRENT_YEAR - 1) {
        return {
          loan_status: 'matured',
          confidence: 85,
          reasoning: `maturity_text "${maturity_text}" indicates maturity year ${matYear}, which is in the past.`,
          is_ambiguous: false,
        };
      }
      if (matYear > CURRENT_YEAR + 1) {
        return {
          loan_status: 'active',
          confidence: 80,
          reasoning: `maturity_text "${maturity_text}" indicates maturity year ${matYear}, which is in the future.`,
          is_ambiguous: false,
        };
      }
      // Current year ±1 — too close to call
      return {
        loan_status: 'unknown',
        confidence: 40,
        reasoning: `maturity_text "${maturity_text}" indicates maturity around ${matYear}, which is near-term. Requires verification.`,
        is_ambiguous: true,
      };
    }

    // maturity_text exists but no year found — still slightly informative
    // (e.g. "7 years" — keep ambiguous but note it)
    // Fall through to facility-type rules
  }

  // ── Rule 2: Bridge loans — always short-term (<2 years from financial close) ─
  if (facility_type === 'bridge_loan') {
    if (codAge !== null && codAge > 2) {
      return {
        loan_status: 'matured',
        confidence: 90,
        reasoning: `Bridge loan on a plant with COD ${cod} (${codAge} years ago). Bridge loans mature within 1-2 years of financial close.`,
        is_ambiguous: false,
      };
    }
    if (codAge !== null && codAge <= 2) {
      return {
        loan_status: 'active',
        confidence: 80,
        reasoning: `Bridge loan on a plant with COD ${cod} (${codAge} years ago). Bridge loans are typically still active within 2 years.`,
        is_ambiguous: false,
      };
    }
    // No COD — ambiguous
    return {
      loan_status: 'unknown',
      confidence: 30,
      reasoning: `Bridge loan but COD unknown. Bridge loans mature within 2 years; cannot determine without COD.`,
      is_ambiguous: true,
    };
  }

  // ── Rule 3: Construction loans — convert or mature within 3-4 years of COD ─
  if (facility_type === 'construction_loan') {
    if (codAge !== null && codAge > 4) {
      return {
        loan_status: 'matured',
        confidence: 75,
        reasoning: `Construction loan on a plant with COD ${cod} (${codAge} years ago). Construction loans typically mature or convert to term loans within 2-3 years of COD.`,
        is_ambiguous: false,
      };
    }
    if (codAge !== null && codAge <= 2) {
      return {
        loan_status: 'active',
        confidence: 80,
        reasoning: `Construction loan on a plant with COD ${cod} (${codAge} years ago). Construction loan likely still active or recently converted.`,
        is_ambiguous: false,
      };
    }
    if (codAge !== null) {
      // 2-4 years: may have converted to term loan — ambiguous
      return {
        loan_status: 'unknown',
        confidence: 35,
        reasoning: `Construction loan on a plant with COD ${cod} (${codAge} years ago). May have converted to a term loan. Requires verification.`,
        is_ambiguous: true,
      };
    }
    return {
      loan_status: 'unknown',
      confidence: 25,
      reasoning: `Construction loan but COD unknown. Cannot estimate status without COD.`,
      is_ambiguous: true,
    };
  }

  // ── Rule 4: Standard term loans and revolving credit — typical 7-year term ─
  if (facility_type === 'term_loan' || facility_type === 'revolving_credit') {
    if (codAge !== null && codAge > 9) {
      return {
        loan_status: 'matured',
        confidence: 70,
        reasoning: `${facility_type} on a plant with COD ${cod} (${codAge} years ago). Standard project finance term loans have 7-year terms; this plant is beyond 9 years and the loan has likely matured or been refinanced.`,
        is_ambiguous: false,
      };
    }
    if (codAge !== null && codAge < 5) {
      return {
        loan_status: 'active',
        confidence: 65,
        reasoning: `${facility_type} on a plant with COD ${cod} (${codAge} years ago). Well within typical 7-year term.`,
        is_ambiguous: false,
      };
    }
    if (codAge !== null) {
      // 5-9 years: peak refinancing window
      return {
        loan_status: 'unknown',
        confidence: 35,
        reasoning: `${facility_type} on a plant with COD ${cod} (${codAge} years ago). Within the 5-9 year refinancing window — loan may be active, matured, or refinanced. Requires verification.`,
        is_ambiguous: true,
      };
    }
    // No COD
    return {
      loan_status: 'unknown',
      confidence: 20,
      reasoning: `${facility_type} but COD unknown. Cannot estimate loan age without COD.`,
      is_ambiguous: true,
    };
  }

  // ── Rule 5: Tax equity — long-duration, flip typically at year 5 but relationship persists ─
  if (facility_type === 'tax_equity') {
    return {
      loan_status: 'unknown',
      confidence: 30,
      reasoning: `Tax equity investment. Flip at year 5 is common but investor relationship often persists beyond flip. Requires verification.`,
      is_ambiguous: true,
    };
  }

  // ── Rule 6: Letter of credit — typically short-term (1-3 years), renewable ─
  if (facility_type === 'letter_of_credit') {
    if (codAge !== null && codAge > 5) {
      return {
        loan_status: 'unknown',
        confidence: 40,
        reasoning: `Letter of credit on a plant with COD ${cod} (${codAge} years ago). LCs are short-term but often renewed; status is uncertain.`,
        is_ambiguous: true,
      };
    }
    return {
      loan_status: 'unknown',
      confidence: 35,
      reasoning: `Letter of credit. Typically short-term but renewable; cannot classify without external evidence.`,
      is_ambiguous: true,
    };
  }

  // ── Rule 7: Very old article with no other signals ────────────────────────
  if (article_published_at) {
    const articleYear = new Date(article_published_at).getFullYear();
    if (CURRENT_YEAR - articleYear > 10) {
      return {
        loan_status: 'unknown',
        confidence: 15,
        reasoning: `Source article is ${CURRENT_YEAR - articleYear} years old and no maturity text or COD available. Highly uncertain.`,
        is_ambiguous: true,
      };
    }
  }

  // ── Default: insufficient signals ────────────────────────────────────────
  return {
    loan_status: 'unknown',
    confidence: 20,
    reasoning: `Insufficient heuristic signals (facility_type: ${facility_type}, COD: ${cod ?? 'unknown'}, maturity_text: ${maturity_text ?? 'none'}).`,
    is_ambiguous: true,
  };
}
