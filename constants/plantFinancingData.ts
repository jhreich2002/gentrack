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
  // Operator / Owner: Greenbacker Renewable Energy Company LLC
  // COD: ~2022  |  Research-based estimate — Greenbacker public filings + industry comps
  '65678': {
    overview:
      'Appaloosa Solar I is a 200 MW utility-scale solar PV facility located in Millard County, ' +
      'Utah, owned and operated by Greenbacker Renewable Energy Company LLC (Greenbacker). ' +
      'Greenbacker is a publicly registered non-traded vehicle (CIK 0001563922) focused on ' +
      'sustainable infrastructure; it aggregates project-level debt through portfolio-level ' +
      'credit facilities syndicated via KeyBank, CoBank, and other institutional lenders. ' +
      'Utah solar projects commissioned after August 2022 qualify for the 30% Investment Tax ' +
      'Credit (ITC) under the Inflation Reduction Act, which Greenbacker typically monetizes ' +
      'through an inverted lease or partnership-flip tax equity structure with a major bank. ' +
      'The facility features a long-term Power Purchase Agreement providing revenue certainty ' +
      'for debt service. Financing details below are research-based estimates derived from ' +
      'Greenbacker\'s publicly available credit agreements and comparable Utah solar transactions; ' +
      'confirm exact terms with the project lender.',
    totalCapex_m: 210,
    debtEquityRatio: '67/33',
    dataQuality: 'estimated',
    source: 'Research-based estimate — Greenbacker public filings + Utah solar market comps',
    facilities: [
      {
        amount_m: 122,
        instrument: 'Term Loan',
        creditMechanism: 'Senior Secured Debt',
        provider: 'KeyBank (lead) / CoBank (participant)',
        notes:
          'Est. 7-year tenor, SOFR + 175–200 bps. Greenbacker\'s portfolio credit facilities are confirmed syndicated by KeyBank and CoBank in public filings; Appaloosa-specific allocation estimated.',
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
  // Operator / Owner: Timbermill Wind (private)
  // COD: ~2023  |  Research-based estimate — NC wind market comps + IRA PTC data
  '67910': {
    overview:
      'Timbermill Wind, LLC is a 189 MW onshore wind energy facility located in North Carolina, ' +
      'operated by a private developer under the same name. As an onshore wind facility placed ' +
      'in service after January 1, 2022, the project qualifies for the Inflation Reduction Act\'s ' +
      'Production Tax Credit (PTC) at the full inflation-adjusted rate ($0.03/kWh in 2024), ' +
      'monetized via a tax equity partnership-flip with a major institutional investor. ' +
      'North Carolina wind projects of this scale are typically financed with a 12–15 year ' +
      'senior secured term loan from an infrastructure-focused lending syndicate, supplemented ' +
      'by a letter-of-credit facility to satisfy MISO/PJM interconnection security requirements. ' +
      'The project is expected to hold a long-term offtake agreement or hedge. Financing details ' +
      'below are research-based estimates derived from comparable North Carolina and Southeast ' +
      'US wind transactions; confirm exact terms with the project lender.',
    totalCapex_m: 308,
    debtEquityRatio: '70/30',
    dataQuality: 'estimated',
    source: 'Research-based estimate — NC wind market comps + IRA PTC transferability data',
    facilities: [
      {
        amount_m: 196,
        instrument: 'Term Loan',
        creditMechanism: 'Senior Secured Debt',
        provider: 'Investec / ING Capital (est. syndicate)',
        notes:
          'Est. 12-year tenor, SOFR + 200 bps. Investec and ING Capital are active lead arrangers in mid-size US onshore wind transactions with project sizes of 150–250 MW.',
      },
      {
        amount_m: 84,
        instrument: 'Tax Equity',
        creditMechanism: 'PTC (10-yr flip)',
        provider: 'Bank of America (est.)',
        notes:
          'Partnership-flip structure typical for PTC wind assets. Tax equity investor receives ~99% of PTCs until a target IRR flip, after which the developer retakes majority economics. 10-year PTC window from COD.',
      },
      {
        amount_m: 18,
        instrument: 'Letter of Credit Facility',
        creditMechanism: 'LC / Contingent Facility',
        provider: 'Wells Fargo (est.)',
        notes:
          'Interconnection security deposit and balance-of-plant warranty LC. Standard for NC onshore wind interconnecting into MISO or Duke Energy Carolinas territory.',
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
