// TEMPORARY — one-time migration runner for v5.4 lender validation workflow.
// Re-deployed as needed; safe to leave deployed (auth-gated by INTERNAL_AUTH_TOKEN).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

const MIGRATION_SQL = `
ALTER TABLE public.plant_lender_links
  ADD COLUMN IF NOT EXISTS validated_at     timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_at      timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS is_manual        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_note      text;

ALTER TABLE public.plant_lender_links
  DROP CONSTRAINT IF EXISTS chk_pll_not_both_validated_rejected;

ALTER TABLE public.plant_lender_links
  ADD CONSTRAINT chk_pll_not_both_validated_rejected
    CHECK (validated_at IS NULL OR rejected_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_pll_validation_state
  ON public.plant_lender_links(lender_id, validated_at, rejected_at);

ALTER TABLE public.lenders_canonical
  ADD COLUMN IF NOT EXISTS pursuit_label  text CHECK (pursuit_label IN ('hot','warm','cold')),
  ADD COLUMN IF NOT EXISTS pursuit_set_at timestamptz;

DROP VIEW IF EXISTS public.v_plant_financing CASCADE;
CREATE VIEW public.v_plant_financing AS
WITH latest_research AS (
  SELECT DISTINCT ON (plant_id)
    id AS research_id,
    plant_id,
    completed_at,
    status
  FROM public.plant_lender_research
  WHERE completed_at IS NOT NULL
  ORDER BY plant_id, completed_at DESC
)
SELECT
  pll.plant_id,
  lc.canonical_name AS lender_name,
  pll.role,
  pll.role_summary,
  pll.source_url,
  pll.evidence_quote,
  (pll.inferred_from_sibling_plant_id IS NOT NULL) AS inferred,
  pll.inferred_from_sibling_plant_id,
  pll.is_manual,
  pll.validated_at,
  pll.rejected_at,
  lr.completed_at AS last_research_at,
  lr.status AS research_status
FROM latest_research lr
JOIN public.plant_lender_links pll ON pll.research_id = lr.research_id
JOIN public.lenders_canonical lc ON lc.id = pll.lender_id
WHERE lc.is_tax_equity = false
  AND pll.rejected_at IS NULL;

DROP VIEW IF EXISTS public.v_admin_plant_research_state CASCADE;
CREATE VIEW public.v_admin_plant_research_state AS
WITH latest_research AS (
  SELECT DISTINCT ON (plant_id)
    id, plant_id, status, completed_at
  FROM public.plant_lender_research
  WHERE completed_at IS NOT NULL
  ORDER BY plant_id, completed_at DESC
)
SELECT
  p.id AS plant_id,
  p.name AS plant_name,
  p.state,
  p.nameplate_capacity_mw,
  p.is_likely_curtailed,
  lr.completed_at AS last_research_at,
  lr.status AS last_status,
  COALESCE(COUNT(pll.id) FILTER (WHERE pll.rejected_at IS NULL), 0)::integer AS lender_count,
  CASE
    WHEN lr.completed_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - lr.completed_at)) / 86400.0
  END AS days_since_research
FROM public.plants p
LEFT JOIN latest_research lr ON lr.plant_id = p.id
LEFT JOIN public.plant_lender_links pll ON pll.research_id = lr.id
GROUP BY p.id, p.name, p.state, p.nameplate_capacity_mw, p.is_likely_curtailed, lr.completed_at, lr.status;

CREATE OR REPLACE VIEW public.v_lender_validation_queue AS
SELECT
  lc.id                                                                                   AS lender_id,
  lc.canonical_name                                                                       AS lender_name,
  COUNT(*) FILTER (WHERE pll.validated_at IS NULL AND pll.rejected_at IS NULL)::integer   AS pending_count,
  COUNT(*) FILTER (WHERE pll.validated_at IS NOT NULL)::integer                           AS validated_count,
  COUNT(*) FILTER (WHERE pll.rejected_at  IS NOT NULL)::integer                           AS rejected_count,
  COUNT(DISTINCT pll.plant_id)::integer                                                   AS distinct_plant_count,
  MAX(pll.created_at)                                                                     AS most_recent_link_at
FROM public.lenders_canonical lc
JOIN public.plant_lender_links pll ON pll.lender_id = lc.id
WHERE lc.is_tax_equity = false
GROUP BY lc.id, lc.canonical_name
HAVING COUNT(*) FILTER (WHERE pll.validated_at IS NULL AND pll.rejected_at IS NULL) > 0;

CREATE OR REPLACE VIEW public.v_lender_validated_portfolio AS
SELECT
  lc.id                                                                                        AS lender_id,
  lc.canonical_name                                                                            AS lender_name,
  lc.pursuit_label,
  lc.pursuit_set_at,
  COUNT(*) FILTER (WHERE pll.validated_at IS NOT NULL)::integer                               AS validated_count,
  COUNT(DISTINCT pll.plant_id) FILTER (WHERE pll.validated_at IS NOT NULL)::integer           AS distinct_validated_plant_count,
  MAX(pll.validated_at)                                                                        AS most_recent_validation_at
FROM public.lenders_canonical lc
JOIN public.plant_lender_links pll ON pll.lender_id = lc.id
WHERE lc.is_tax_equity = false
GROUP BY lc.id, lc.canonical_name, lc.pursuit_label, lc.pursuit_set_at
HAVING COUNT(*) FILTER (WHERE pll.validated_at IS NOT NULL) > 0;

CREATE OR REPLACE VIEW public.v_lender_plant_summary AS
SELECT
  pll.id                                                    AS link_id,
  pll.lender_id,
  pll.plant_id,
  p.name                                                    AS plant_name,
  p.state,
  p.nameplate_capacity_mw,
  pll.role,
  pll.role_summary,
  pll.source_url,
  pll.evidence_quote,
  pll.is_manual,
  pll.manual_note,
  pll.validated_at,
  pll.rejected_at,
  pll.rejection_reason,
  pll.created_at,
  plr.completed_at                                          AS last_research_at,
  CASE
    WHEN pll.validated_at IS NOT NULL THEN 'validated'
    WHEN pll.rejected_at  IS NOT NULL THEN 'rejected'
    ELSE 'pending'
  END                                                       AS validation_state
FROM public.plant_lender_links pll
JOIN public.plants p ON p.id = pll.plant_id
LEFT JOIN public.plant_lender_research plr ON plr.id = pll.research_id;

CREATE OR REPLACE FUNCTION public.add_manual_lender_link(
  p_plant_id       text,
  p_lender_name    text,
  p_role           text,
  p_source_url     text,
  p_evidence_quote text,
  p_manual_note    text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_normalized  text;
  v_lender_id   uuid;
  v_link_id     uuid;
  v_research_id uuid;
BEGIN
  IF p_lender_name IS NULL OR length(trim(p_lender_name)) = 0 THEN
    RAISE EXCEPTION 'p_lender_name is required';
  END IF;
  IF p_source_url IS NULL OR length(trim(p_source_url)) = 0 THEN
    RAISE EXCEPTION 'p_source_url is required';
  END IF;

  v_normalized := public.normalize_lender_name(p_lender_name);

  SELECT id INTO v_lender_id
    FROM public.lenders_canonical
   WHERE normalized_name = v_normalized
   LIMIT 1;

  IF v_lender_id IS NULL THEN
    SELECT canonical_id INTO v_lender_id
      FROM public.lender_aliases
     WHERE normalized_alias = v_normalized
     LIMIT 1;
  END IF;

  IF v_lender_id IS NULL THEN
    INSERT INTO public.lenders_canonical (canonical_name, normalized_name, is_tax_equity)
    VALUES (trim(p_lender_name), v_normalized, false)
    RETURNING id INTO v_lender_id;
  END IF;

  INSERT INTO public.plant_lender_research (
    plant_id, status, prompt_version, model, cost_usd,
    requested_by, completed_at
  ) VALUES (
    p_plant_id, 'complete', 'manual-entry', 'manual', 0,
    NULL, now()
  ) RETURNING id INTO v_research_id;

  INSERT INTO public.plant_lender_links (
    plant_id, lender_id, role, role_summary, source_url, evidence_quote,
    research_id, is_manual, manual_note,
    validated_at, rejected_at, rejection_reason
  ) VALUES (
    p_plant_id, v_lender_id, p_role, NULL, p_source_url, p_evidence_quote,
    v_research_id, true, p_manual_note,
    now(), NULL, NULL
  )
  ON CONFLICT (plant_id, lender_id) DO UPDATE SET
    role             = EXCLUDED.role,
    source_url       = EXCLUDED.source_url,
    evidence_quote   = EXCLUDED.evidence_quote,
    research_id      = EXCLUDED.research_id,
    is_manual        = true,
    manual_note      = EXCLUDED.manual_note,
    validated_at     = now(),
    rejected_at      = NULL,
    rejection_reason = NULL
  RETURNING id INTO v_link_id;

  RETURN v_link_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_manual_lender_link(text, text, text, text, text, text)
  TO anon, authenticated, service_role;
`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const internalToken = Deno.env.get("INTERNAL_AUTH_TOKEN") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const validToken = internalToken || serviceKey;
  if (!validToken || token !== validToken) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: CORS });
  }

  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) {
    return new Response(JSON.stringify({ error: "SUPABASE_DB_URL not available" }), { status: 500, headers: CORS });
  }

  try {
    const sql = postgres(dbUrl);
    await sql.unsafe(MIGRATION_SQL);
    await sql.end();
    return new Response(JSON.stringify({ ok: true, message: "Migration applied: v5.4 lender validation workflow" }), { status: 200, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS });
  }
});
