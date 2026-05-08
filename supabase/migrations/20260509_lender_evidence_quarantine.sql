-- ============================================================
-- Phase 3: Historical data quarantine.
--
-- Background: ucc_lender_links and ucc_lender_leads_unverified contain
-- 600+ machine-generated rows from the v1 pipeline that include sentence
-- fragments, sponsors, project companies, and non-lender entities. These
-- rows pollute candidate generation and embeddings.
--
-- Strategy (locked plan): never delete; tag everything pre-rebuild as
-- pipeline_version='v1_legacy'. New rows produced by the v2 agentic
-- pipeline carry pipeline_version='v2'. A subsequent script
-- (scripts/quarantine_legacy_leads.ts) will set quarantined_at=now() on
-- obviously-bad unapproved v1 rows, and lead_status='superseded' on the
-- corresponding entries in ucc_lender_leads_unverified. Human-approved
-- rows are NEVER quarantined; they remain canonical evidence.
-- ============================================================

-- ── 1. Add pipeline_version + quarantined_at columns ─────────────────────────
ALTER TABLE public.ucc_lender_links
  ADD COLUMN IF NOT EXISTS pipeline_version text NOT NULL DEFAULT 'v1_legacy'
    CHECK (pipeline_version IN ('v1_legacy', 'v2')),
  ADD COLUMN IF NOT EXISTS quarantined_at   timestamptz,
  ADD COLUMN IF NOT EXISTS quarantine_reason text;

ALTER TABLE public.ucc_lender_leads_unverified
  ADD COLUMN IF NOT EXISTS pipeline_version text NOT NULL DEFAULT 'v1_legacy'
    CHECK (pipeline_version IN ('v1_legacy', 'v2')),
  ADD COLUMN IF NOT EXISTS quarantined_at   timestamptz,
  ADD COLUMN IF NOT EXISTS quarantine_reason text;

CREATE INDEX IF NOT EXISTS idx_ull_pipeline_version
  ON public.ucc_lender_links (pipeline_version);
CREATE INDEX IF NOT EXISTS idx_ull_quarantined_at
  ON public.ucc_lender_links (quarantined_at) WHERE quarantined_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ullu_pipeline_version
  ON public.ucc_lender_leads_unverified (pipeline_version);
CREATE INDEX IF NOT EXISTS idx_ullu_quarantined_at
  ON public.ucc_lender_leads_unverified (quarantined_at) WHERE quarantined_at IS NOT NULL;

-- ── 2. Validation queue view: hide quarantined and v1_legacy unapproved ──────
-- Refresh v_lender_validation_queue to skip quarantined leads. The v1_legacy
-- unapproved rows that survive quarantine (i.e. plausible but unverified) stay
-- in the queue; humans can validate or reject them as before. v2 rows
-- auto-surface here once produced.
-- DROP first because CREATE OR REPLACE cannot rename columns and the
-- 20260506 version uses last_lead_at; we keep that column name for
-- compatibility with the service layer.
DROP VIEW IF EXISTS public.v_lender_validation_queue;
CREATE VIEW public.v_lender_validation_queue AS
SELECT
  l.lender_normalized,
  (array_agg(l.lender_name ORDER BY l.created_at DESC NULLS LAST))[1]        AS lender_name,
  COUNT(*) FILTER (WHERE l.lead_status = 'pending')                          AS pending_count,
  COUNT(DISTINCT l.plant_code) FILTER (WHERE l.lead_status = 'pending')      AS pending_plant_count,
  COUNT(DISTINCT l.plant_code) FILTER (
    WHERE l.lead_status = 'pending' AND p.is_likely_curtailed = true
  )                                                                          AS curtailed_plant_count,
  COALESCE(
    SUM(p.nameplate_capacity_mw) FILTER (
      WHERE l.lead_status = 'pending' AND p.is_likely_curtailed = true
    ),
    0
  )                                                                          AS curtailed_mw,
  MAX(l.created_at)                                                          AS last_lead_at
FROM public.ucc_lender_leads_unverified l
LEFT JOIN public.plants p ON p.eia_plant_code = l.plant_code
WHERE l.lender_normalized IS NOT NULL
  AND l.lender_normalized <> ''
  AND l.quarantined_at IS NULL
GROUP BY l.lender_normalized
HAVING COUNT(*) FILTER (WHERE l.lead_status = 'pending') > 0;

GRANT SELECT ON public.v_lender_validation_queue TO authenticated, anon;

-- ── 3. Validated portfolio view: also hide quarantined ──────────────────────
-- (human_approved=true rows shouldn't get quarantined, but be defensive.)
-- Same column shape as 20260507_cleanup_validated_view.sql, just adds the
-- quarantined_at filter, so CREATE OR REPLACE is safe here. Use DROP+CREATE
-- only if the column list ever changes.
CREATE OR REPLACE VIEW public.v_validated_lender_portfolio AS
SELECT
  ll.lender_normalized,
  (array_agg(ll.lender_name ORDER BY ll.created_at DESC NULLS LAST))[1] AS lender_name,
  COUNT(*)                                                              AS validated_plant_count,
  COUNT(*) FILTER (WHERE p.is_likely_curtailed = true)                  AS curtailed_plant_count,
  COALESCE(
    SUM(p.nameplate_capacity_mw) FILTER (WHERE p.is_likely_curtailed = true),
    0
  )                                                                     AS curtailed_mw,
  MAX(ll.updated_at)                                                    AS last_validated_at
FROM public.ucc_lender_links ll
LEFT JOIN public.plants p ON p.eia_plant_code = ll.plant_code
WHERE ll.lender_normalized IS NOT NULL
  AND ll.lender_normalized <> ''
  AND ll.human_approved = true
  AND ll.quarantined_at IS NULL
GROUP BY ll.lender_normalized;

GRANT SELECT ON public.v_validated_lender_portfolio TO authenticated, anon;
