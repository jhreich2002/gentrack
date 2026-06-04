-- ============================================================
-- lender_validated_digest
-- Cached per-lender senior-manager engagement digest.
-- Populated by the lender-validated-digest Edge Function.
--
-- CF math: portfolio_cf_t = Σ(mwh_t) / (Σ(MW_t) × hours_t) × 100
--   where MW_t and mwh_t only include plants with non-null mwh for month t.
-- Blended regional: Σ(plant_MW × region_avg_factor_t) / Σ(plant_MW) × 100
--   using get_regional_trend(region, fuel) — avg_factor is in 0..1.
-- ============================================================

-- ── 1. Main cache table ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS lender_validated_digest (
  lender_id           uuid          NOT NULL REFERENCES lenders_canonical(id) ON DELETE CASCADE,
  -- Portfolio KPIs (jsonb so the schema can evolve without migrations)
  -- Expected keys: total_mw, plant_count, weighted_ttm_cf, blended_regional_cf,
  --                cf_delta_pp, avg_news_risk, avg_distress_score, active_loan_count,
  --                curtailed_count
  -- Also stores per-plant snapshot: plants[] array used by frontend service
  kpis                jsonb         NOT NULL DEFAULT '{}',
  -- 24-month MW-weighted CF series
  -- Array of { month: "YYYY-MM", portfolio_cf: number|null, blended_regional_cf: number|null }
  cf_series           jsonb         NOT NULL DEFAULT '[]',
  -- Gemini narrative (two sections returned from a single structured call)
  ai_engagement_thesis  text        NULL,
  ai_portfolio_health   text        NULL,
  ai_pitch_bullets      jsonb       NOT NULL DEFAULT '[]',  -- string[]
  ai_risk_bullets       jsonb       NOT NULL DEFAULT '[]',  -- string[]
  -- Metadata
  plant_count         integer       NOT NULL DEFAULT 0,
  total_mw            numeric(12,2) NOT NULL DEFAULT 0,
  cost_usd            numeric(10,6) NULL,
  model_used          text          NULL,
  generated_at        timestamptz   NOT NULL DEFAULT now(),
  generated_by        uuid          NULL REFERENCES auth.users(id) ON DELETE SET NULL,

  PRIMARY KEY (lender_id)
);

-- Allow fast staleness queries
CREATE INDEX IF NOT EXISTS lender_validated_digest_generated_at_idx
  ON lender_validated_digest (generated_at DESC);

-- RLS
ALTER TABLE lender_validated_digest ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read
CREATE POLICY "authenticated_read_digest"
  ON lender_validated_digest FOR SELECT
  TO authenticated
  USING (true);

-- Only service-role / SECURITY DEFINER functions can write
-- (no direct client INSERT/UPDATE/DELETE)

-- ── 2. Cooldown gate RPC ─────────────────────────────────────
-- Returns { proceed: true } or { skipped: true, reason: text }.
-- Mirrors trigger_plant_research pattern.

CREATE OR REPLACE FUNCTION trigger_lender_validated_digest(
  p_lender_id uuid,
  p_force     boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role      text;
  v_last_run  timestamptz;
  v_age_h     numeric;
BEGIN
  -- Admin-only gate (mirror trigger_plant_research)
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;

  SELECT generated_at
    INTO v_last_run
    FROM lender_validated_digest
   WHERE lender_id = p_lender_id;

  IF v_last_run IS NOT NULL AND NOT p_force THEN
    v_age_h := EXTRACT(EPOCH FROM (now() - v_last_run)) / 3600.0;
    IF v_age_h < 1 THEN
      RETURN jsonb_build_object(
        'skipped', true,
        'reason',  'recent_run',
        'age_minutes', ROUND(v_age_h * 60)
      );
    END IF;
  END IF;

  RETURN jsonb_build_object('proceed', true);
END;
$$;

GRANT EXECUTE ON FUNCTION trigger_lender_validated_digest(uuid, boolean)
  TO authenticated;

-- ── 3. Fetch RPC ─────────────────────────────────────────────
-- Returns the cached digest row joined with lender name + pursuit label.
-- plants snapshot is embedded in kpis.plants[] by the Edge Function.

CREATE OR REPLACE FUNCTION get_lender_validated_digest(p_lender_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row           lender_validated_digest%ROWTYPE;
  v_lender_name   text;
  v_pursuit_label text;
BEGIN
  SELECT * INTO v_row FROM lender_validated_digest WHERE lender_id = p_lender_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- canonical_name and pursuit_label both live on lenders_canonical (no separate table)
  SELECT canonical_name, pursuit_label
    INTO v_lender_name, v_pursuit_label
    FROM lenders_canonical
   WHERE id = p_lender_id;

  RETURN jsonb_build_object(
    'lender_id',             v_row.lender_id,
    'lender_name',           v_lender_name,
    'pursuit_label',         v_pursuit_label,
    'kpis',                  v_row.kpis,
    'cf_series',             v_row.cf_series,
    'ai_engagement_thesis',  v_row.ai_engagement_thesis,
    'ai_portfolio_health',   v_row.ai_portfolio_health,
    'ai_pitch_bullets',      v_row.ai_pitch_bullets,
    'ai_risk_bullets',       v_row.ai_risk_bullets,
    'plant_count',           v_row.plant_count,
    'total_mw',              v_row.total_mw,
    'cost_usd',              v_row.cost_usd,
    'model_used',            v_row.model_used,
    'generated_at',          v_row.generated_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_lender_validated_digest(uuid)
  TO authenticated;

-- ── 4. Admin list view ───────────────────────────────────────
-- Used by AdminPage "Validated Lender Digests" panel.
-- lenders_canonical.id is uuid; v_lender_validated_portfolio.lender_id is uuid — no cast needed.

CREATE OR REPLACE VIEW v_admin_lender_digest_state AS
SELECT
  lc.id                                          AS lender_id,
  lc.canonical_name                              AS lender_name,
  vp.distinct_validated_plant_count              AS validated_plant_count,
  vp.pursuit_label,
  d.generated_at                                 AS last_digest_at,
  d.cost_usd                                     AS last_digest_cost_usd,
  d.model_used,
  d.plant_count                                  AS digest_plant_count,
  CASE
    WHEN d.generated_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - d.generated_at)) / 86400.0
  END                                            AS digest_age_days,
  CASE
    WHEN d.generated_at IS NULL THEN true
    WHEN EXTRACT(EPOCH FROM (now() - d.generated_at)) / 86400.0 > 7 THEN true
    ELSE false
  END                                            AS is_stale
FROM lenders_canonical lc
JOIN v_lender_validated_portfolio vp ON vp.lender_id = lc.id
LEFT JOIN lender_validated_digest d ON d.lender_id = lc.id
WHERE vp.distinct_validated_plant_count > 0
ORDER BY vp.distinct_validated_plant_count DESC;

GRANT SELECT ON v_admin_lender_digest_state TO authenticated;
