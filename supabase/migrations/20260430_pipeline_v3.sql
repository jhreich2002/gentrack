-- Pipeline v3: practical confidence tiers + actionable partial status
--
-- Adds:
--   - workflow_status: confirmed_partial
--   - confidence_class: high_confidence
--
-- confirmed_partial means reviewer escalated but at least one actionable
-- lender candidate exists (confirmed or high_confidence).

-- 1) Expand workflow_status enum/check
ALTER TABLE ucc_research_plants
  DROP CONSTRAINT IF EXISTS ucc_research_plants_workflow_status_check;

ALTER TABLE ucc_research_plants
  ADD CONSTRAINT ucc_research_plants_workflow_status_check
  CHECK (workflow_status IN (
    'pending',
    'running',
    'complete',
    'confirmed_partial',
    'unresolved',
    'needs_review',
    'partial',
    'budget_exceeded'
  ));

-- 2) Expand confidence_class for verified links
ALTER TABLE ucc_lender_links
  DROP CONSTRAINT IF EXISTS ucc_lender_links_confidence_class_check;

ALTER TABLE ucc_lender_links
  ADD CONSTRAINT ucc_lender_links_confidence_class_check
  CHECK (confidence_class IN (
    'confirmed',
    'high_confidence',
    'highly_likely',
    'possible'
  ));

-- 3) Expand confidence_class for unverified leads
ALTER TABLE ucc_lender_leads_unverified
  DROP CONSTRAINT IF EXISTS ucc_lender_leads_unverified_confidence_class_check;

ALTER TABLE ucc_lender_leads_unverified
  ADD CONSTRAINT ucc_lender_leads_unverified_confidence_class_check
  CHECK (confidence_class IN (
    'high_confidence',
    'highly_likely',
    'possible'
  ));
