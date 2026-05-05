-- Adds role_tag to ucc_lender_links and ucc_lender_leads_unverified.
-- Values: debt_lender | tax_equity | offtaker | utility_counterparty | gov_loan_guarantee | unknown
-- Allows the Leads tab (and pitch-packet export) to filter out offtakers/utilities
-- and display debt vs tax-equity separately.

ALTER TABLE public.ucc_lender_links
  ADD COLUMN IF NOT EXISTS role_tag TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE public.ucc_lender_leads_unverified
  ADD COLUMN IF NOT EXISTS role_tag TEXT NOT NULL DEFAULT 'unknown';

-- Backfill existing rows: anything with a DOE LPO source_url is a gov guarantee
UPDATE public.ucc_lender_links
SET role_tag = 'gov_loan_guarantee'
WHERE role_tag = 'unknown'
  AND source_url ILIKE '%lpo.energy.gov%';

-- Backfill: rows where the evidence_summary mentions tax equity
UPDATE public.ucc_lender_links
SET role_tag = 'tax_equity'
WHERE role_tag = 'unknown'
  AND evidence_summary ILIKE '%tax equity%';

COMMENT ON COLUMN public.ucc_lender_links.role_tag IS
  'Functional role of the lender/investor: debt_lender, tax_equity, offtaker, utility_counterparty, gov_loan_guarantee, unknown';

COMMENT ON COLUMN public.ucc_lender_leads_unverified.role_tag IS
  'Functional role of the lender/investor: debt_lender, tax_equity, offtaker, utility_counterparty, gov_loan_guarantee, unknown';
