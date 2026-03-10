/**
 * Static financing capital-structure seed data for select plants.
 * Keyed by EIA plant code (eia_plant_code string, e.g. "63883").
 *
 * Data quality levels:
 *   "confirmed" — sourced directly from a named public SEC/regulatory filing
 *   "estimated" — researched industry comparable; confirm with lender directly
 */

export interface FinancingFacility {
  amount_m: number;       // $ millions
  instrument: string;     // e.g. "Term Loan", "Tax Equity", "Letter of Credit"
  creditMechanism: string; // e.g. "Senior Secured Debt", "PTC (10-yr)", "ITC Transfer (30%)"
  provider: string;       // bank / investor name(s)
  notes: string;
}

export interface PlantFinancingSeed {
  overview: string;
  totalCapex_m: number;
  debtEquityRatio: string; // e.g. "68/32"
  dataQuality: 'confirmed' | 'estimated';
  source: string;          // citation label shown to user
  sourceUrl?: string;      // optional deep link to filing
  facilities: FinancingFacility[];
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

export const PLANT_FINANCING_SEED: Record<string, PlantFinancingSeed> = {

  // ─── Samson Solar Energy III LLC (EIA-63883) ────────────────────────────
  // 250 MW solar PV, Texas (Hunt / Fannin county area, ERCOT)
  // EIA entity: Samson Solar Energy III LLC (distinct from WEC's "Samson I" / Samson Solar Energy LLC)
  // No confirmed public SEC filings identified for this specific SPV — research-based estimate
  '63883': {
    overview:
      'Samson Solar Energy III LLC (EIA-63883) is a 250 MW utility-scale solar PV facility in ' +
      'Texas operating within the ERCOT grid. Note: this entity is distinct from "Samson Solar ' +
      'Energy LLC" (WEC Energy Group\'s "Samson I"), which is a separately owned and financed ' +
      '250 MW Texas solar project. No public SEC filings have been identified that disclose ' +
      'project-level financing specifically for Samson Solar Energy III LLC. The structure below ' +
      'is estimated based on comparable 250 MW Texas solar transactions executed in 2022–2024. ' +
      'Texas utility-scale solar projects of this size typically use a construction-to-term loan ' +
      'syndicated by infrastructure lenders, paired with tax equity monetizing the 30% ITC (or ' +
      'electively the PTC) under the Inflation Reduction Act, and a long-term PPA with an ERCOT ' +
      'load-serving entity or C&I offtaker for debt-service coverage. Confirm all terms with the ' +
      'project developer or lender directly.',
    totalCapex_m: 270,
    debtEquityRatio: '68/32',
    dataQuality: 'estimated',
    source: 'Research-based estimate — Texas solar market comparables (2022–2024)',
    facilities: [
      {
        amount_m: 160,
        instrument: 'Construction-to-Term Loan',
        creditMechanism: 'Senior Secured Debt',
        provider: 'Infrastructure lending syndicate (est.)',
        notes:
          'Est. 18-month construction period converting to 15-year term loan. SOFR + 175–225 bps typical for ERCOT solar at this scale. Texas projects often use Rabobank, KeyBank, CIT, or similar ag/infrastructure lenders.',
      },
      {
        amount_m: 68,
        instrument: 'Tax Equity',
        creditMechanism: 'ITC Transfer (30%)',
        provider: 'Institutional tax equity investor (est.)',
        notes:
          '30% ITC on ~$270M CAPEX ≈ $81M gross credit; tax equity typically covers ~80–85% of credit value. Direct-pay or partnership-flip structure. Post-IRA transferability allows cash sale to third-party buyer in lieu of traditional flip.',
      },
      {
        amount_m: 42,
        instrument: 'Sponsor Equity',
        creditMechanism: 'Equity',
        provider: 'Project developer / owner (est.)',
        notes:
          'Residual sponsor equity after debt and tax equity. Developer identity not confirmed in public EIA filings for this specific SPV.',
      },
    ],
  },

  // ─── Appaloosa Solar I (EIA-65678) ──────────────────────────────────────
  // 200 MW solar PV, Millard County, Utah
  // EIA operator / owner: Greenbacker Renewable Energy Company LLC
  // Appaloosa Solar I is a project-level SPV; no SEC filings found for this specific entity
  // Research-based estimate — Greenbacker portfolio-level filings + Utah solar market comps
  '65678': {
    overview:
      'Appaloosa Solar I (EIA-65678) is a 200 MW utility-scale solar PV facility located in ' +
      'Millard County, Utah. The EIA identifies the operator/owner as Greenbacker Renewable ' +
      'Energy Company LLC (CIK 0001563922), a publicly registered non-traded sustainable ' +
      'infrastructure vehicle. No public SEC filings have been identified that disclose ' +
      'project-level financing specifically for the Appaloosa Solar I SPV. Greenbacker holds ' +
      'its assets through individual project entities and finances them through a combination ' +
      'of a portfolio-level revolving credit facility (led by KeyBank and CoBank at the ' +
      'Greenbacker entity level, per Greenbacker\'s own public filings) and project-specific ' +
      'term debt. Whether Appaloosa Solar I carries standalone project debt or draws on the ' +
      'portfolio facility is not confirmed in public disclosures. Utah solar projects ' +
      'commissioned after August 2022 qualify for the 30% ITC under the IRA. All facility ' +
      'details below are estimates based on Greenbacker\'s disclosed financing approach and ' +
      'comparable Utah solar transactions; confirm exact terms with the project lender.',
    totalCapex_m: 210,
    debtEquityRatio: '67/33',
    dataQuality: 'estimated',
    source: 'Research-based estimate — Greenbacker public filings + Utah solar market comps',
    facilities: [
      {
        amount_m: 122,
        instrument: 'Term Loan',
        creditMechanism: 'Senior Secured Debt',
        provider: 'KeyBank / CoBank (portfolio-level, est. for this SPV)',
        notes:
          'KeyBank and CoBank are confirmed lead arrangers on Greenbacker\'s entity-level revolving ' +
          'credit facility per Greenbacker public filings — but that facility operates at the ' +
          'Greenbacker parent level, not specifically for Appaloosa Solar I. Project-level term ' +
          'debt for this SPV, if any, is not confirmed in public disclosures. Est. 7-year tenor, ' +
          'SOFR + 175–200 bps based on Greenbacker comparable asset financings.',
      },
      {
        amount_m: 52,
        instrument: 'Tax Equity',
        creditMechanism: 'ITC Transfer (30%)',
        provider: 'Institutional bank / tax equity investor',
        notes:
          'ITC on 200 MW Utah solar at ~$1.05/W DC cost ≈ $63M gross credit at 30%; typical tax equity covers ~80% of credit value. Inverted lease or partnership-flip structure typical for Greenbacker assets.',
      },
      {
        amount_m: 36,
        instrument: 'Sponsor Equity',
        creditMechanism: 'Equity',
        provider: 'Greenbacker Renewable Energy Company LLC',
        notes:
          'NAV-backed equity contribution from Greenbacker\'s investor-capital base. Represents residual after debt and tax equity.',
      },
    ],
  },

  // ─── Timbermill Wind, LLC (EIA-67910) ───────────────────────────────────
  // 189 MW onshore wind, North Carolina
  // EIA operator / owner: Timbermill Wind (private entity, no SEC filings found)
  // No confirmed public filings for this specific SPV — research-based estimate
  '67910': {
    overview:
      'Timbermill Wind, LLC (EIA-67910) is a 189 MW onshore wind energy facility located in ' +
      'North Carolina. The EIA identifies the operator as Timbermill Wind, a private entity. ' +
      'No public SEC filings have been identified that disclose project-level financing ' +
      'specifically for Timbermill Wind, LLC. All lender names and facility amounts below are ' +
      'pure market-comparable estimates based on similar North Carolina and Southeast US onshore ' +
      'wind transactions of 150–250 MW scale executed in 2022–2024 — they do not reflect any ' +
      'confirmed disclosure for this project. As an onshore wind facility placed in service ' +
      'after January 1, 2022, the project qualifies for the Inflation Reduction Act\'s ' +
      'Production Tax Credit (PTC). A tax equity partnership-flip and senior secured term loan ' +
      'are standard for PTC-eligible wind assets of this size. Confirm all terms with the ' +
      'project developer or lender directly.',
    totalCapex_m: 308,
    debtEquityRatio: '70/30',
    dataQuality: 'estimated',
    source: 'Research-based estimate — NC wind market comps + IRA PTC transferability data',
    facilities: [
      {
        amount_m: 196,
        instrument: 'Term Loan',
        creditMechanism: 'Senior Secured Debt',
        provider: 'Wind infrastructure lender syndicate (est. — not confirmed for this project)',
        notes:
          'Investec and ING Capital are cited only as examples of active lead arrangers in comparable ' +
          'US onshore wind deals; neither has been confirmed as a lender to Timbermill Wind LLC ' +
          'in any public filing. Est. 12-year tenor, SOFR + 200 bps based on NC wind comps.',
      },
      {
        amount_m: 84,
        instrument: 'Tax Equity',
        creditMechanism: 'PTC (10-yr flip)',
        provider: 'Institutional tax equity investor (est. — not confirmed for this project)',
        notes:
          'Bank of America is cited as an example of a major PTC tax equity provider active in ' +
          'this market segment; it has not been confirmed as an investor in Timbermill Wind LLC. ' +
          'Partnership-flip structure typical for PTC wind assets; ~99% tax benefits to investor ' +
          'until target IRR, then flip to developer majority.',
      },
      {
        amount_m: 18,
        instrument: 'Letter of Credit Facility',
        creditMechanism: 'LC / Contingent Facility',
        provider: 'Lender syndicate member (est. — not confirmed for this project)',
        notes:
          'Wells Fargo is cited as a typical LC provider for NC wind interconnection security; ' +
          'not confirmed for this project. Standard for wind projects interconnecting into ' +
          'Duke Energy Carolinas or MISO territory.',
      },
      {
        amount_m: 10,
        instrument: 'Sponsor Equity',
        creditMechanism: 'Equity',
        provider: 'Timbermill Wind LLC (private developer)',
        notes:
          'Residual sponsor equity after project-level financing. Held by private developer entity; ownership structure not disclosed in public filings.',
      },
    ],
  },
};
