-- ── ucc_research_queue view ───────────────────────────────────────────────────
--
-- Prioritized queue of curtailed plants for UCC lender research.
-- Orders by capacity DESC (largest plants first), then distress_score DESC.
-- Excludes plants already complete or currently running.
--
-- Used by:
--   - ucc-supervisor batch mode (prioritize_curtailed=true)
--   - scripts/run-ucc-calibration.ts  (informational — supervisor queries this)
--   - SELECT COUNT(*) FROM ucc_research_queue  (monitoring)
-- ─────────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS ucc_research_queue;

CREATE VIEW ucc_research_queue AS
SELECT
  p.eia_plant_code                                        AS plant_code,
  p.name                                                  AS plant_name,
  p.state,
  p.county,
  p.owner                                                 AS sponsor_name,
  p.nameplate_capacity_mw                                 AS capacity_mw,
  p.fuel_source                                           AS fuel_type,
  p.distress_score,
  p.curtailment_score,
  p.is_likely_curtailed,
  COALESCE(rp.workflow_status, 'pending')                 AS workflow_status,
  rp.last_run_at,
  rp.top_confidence,
  rp.lender_count,
  -- Priority score: capacity contributes 70%, distress 30% (both normalised 0–1)
  -- Plants without capacity data are deprioritised (score = 0)
  CASE
    WHEN p.nameplate_capacity_mw IS NULL THEN 0
    ELSE ROUND(
      COALESCE(p.nameplate_capacity_mw, 0) * 0.70
      + COALESCE(p.distress_score, 0)      * 0.30
    , 2)
  END                                                     AS priority_score
FROM plants p
LEFT JOIN ucc_research_plants rp ON rp.plant_code = p.eia_plant_code
WHERE
  p.is_likely_curtailed = true
  -- Exclude plants already processed or currently running.
  -- Only 'pending' (never attempted) plants appear in the queue.
  -- To re-process a plant, reset its workflow_status to 'pending' explicitly.
  AND COALESCE(rp.workflow_status, 'pending') = 'pending'
ORDER BY
  p.nameplate_capacity_mw DESC NULLS LAST,
  p.distress_score         DESC NULLS LAST;

-- Grant read access matching the existing RLS posture on ucc_research_plants
GRANT SELECT ON ucc_research_queue TO anon, authenticated, service_role;

-- Quick sanity check (comment out before committing if you prefer clean migrations)
-- SELECT plant_code, plant_name, state, capacity_mw, workflow_status FROM ucc_research_queue LIMIT 10;
