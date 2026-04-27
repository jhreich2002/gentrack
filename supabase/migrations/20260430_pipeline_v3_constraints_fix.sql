-- Pipeline v3 follow-up: align remaining constraints with new statuses.

-- 1) ucc_agent_runs.supervisor_status must allow confirmed_partial
ALTER TABLE ucc_agent_runs
  DROP CONSTRAINT IF EXISTS ucc_agent_runs_supervisor_status_check;

ALTER TABLE ucc_agent_runs
  ADD CONSTRAINT ucc_agent_runs_supervisor_status_check
  CHECK (supervisor_status IN (
    'running',
    'complete',
    'confirmed_partial',
    'unresolved',
    'needs_review',
    'failed',
    'budget_exceeded'
  ));

-- 2) ucc_research_plants.top_confidence must allow high_confidence
ALTER TABLE ucc_research_plants
  DROP CONSTRAINT IF EXISTS ucc_research_plants_top_confidence_check;

ALTER TABLE ucc_research_plants
  ADD CONSTRAINT ucc_research_plants_top_confidence_check
  CHECK (
    top_confidence IS NULL OR
    top_confidence IN ('confirmed', 'high_confidence', 'highly_likely', 'possible')
  );
