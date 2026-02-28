-- ============================================================
-- GenTrack — Plant Ownership & PPA table
-- Run once in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS plant_ownership (
  eia_site_code                          text        PRIMARY KEY,
  power_plant                            text,
  plant_key                              text,
  tech_type                              text,
  plant_operator                         text,
  plant_operator_instn_key               text,
  operator_ult_parent                    text,
  operator_ult_parent_instn_key          text,
  owner                                  text,
  oper_own                               numeric,    -- Operating ownership %
  owner_eia_utility_code                 text,
  ult_parent                             text,
  parent_eia_utility_code                text,
  own_status                             text,
  planned_own                            text,       -- Planned ownership
  largest_ppa_counterparty               text,
  largest_ppa_contracted_capacity        numeric,    -- MW
  largest_ppa_contracted_start_date      date,
  largest_ppa_contracted_expiration_date date,
  updated_at                             timestamptz NOT NULL DEFAULT now()
);

-- Allow anyone (including anon browser client) to read
ALTER TABLE plant_ownership ENABLE ROW LEVEL SECURITY;

CREATE POLICY "plant_ownership: public read"
  ON plant_ownership FOR SELECT
  USING (true);

-- Only service role can write (no insert/update/delete policy = blocked for non-service-role clients)

-- ── Run these if the table already exists (adds new columns) ─────────────
ALTER TABLE plant_ownership ADD COLUMN IF NOT EXISTS tech_type text;
ALTER TABLE plant_ownership ADD COLUMN IF NOT EXISTS plant_operator text;
ALTER TABLE plant_ownership ADD COLUMN IF NOT EXISTS operator_ult_parent_instn_key text;
