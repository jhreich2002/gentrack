-- ============================================================
-- GenTrack — Plant Ownership & PPA table
-- Run once in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS plant_ownership (
  eia_site_code                          text        PRIMARY KEY,
  power_plant                            text,
  plant_key                              text,
  plant_operator_instn_key               text,
  operator_ult_parent                    text,
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
