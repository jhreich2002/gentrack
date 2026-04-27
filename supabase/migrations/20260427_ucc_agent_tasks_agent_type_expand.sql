-- Pipeline v4 fix: extend ucc_agent_tasks.agent_type to include workers
-- introduced after the original schema (DOE LPO, FERC, news fallback).
-- Without this, supervisor's recordTask() inserts for these agent types are
-- silently rejected by the CHECK constraint, breaking observability.

ALTER TABLE ucc_agent_tasks
  DROP CONSTRAINT IF EXISTS ucc_agent_tasks_agent_type_check;

ALTER TABLE ucc_agent_tasks
  ADD CONSTRAINT ucc_agent_tasks_agent_type_check
  CHECK (agent_type IN (
    'entity_worker',
    'ucc_records_worker',
    'county_worker',
    'edgar_worker',
    'supplement_worker',
    'reviewer',
    'doe_lpo_worker',
    'ferc_worker',
    'news_fallback_worker'
  ));
