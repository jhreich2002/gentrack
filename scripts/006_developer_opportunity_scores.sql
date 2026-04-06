-- ============================================================
-- GenTrack — Developer Opportunity Scores (FTI lead scoring)
-- Creates a durable table used by compute-developer-opportunities.ts
-- ============================================================

create table if not exists public.developer_opportunity_scores (
  developer_id uuid primary key references public.developers(id) on delete cascade,
  developer_name text not null,
  model_version text not null default 'v1',

  opportunity_score numeric(5,2) not null default 0,
  distress_score numeric(5,2) not null default 0,
  complexity_score numeric(5,2) not null default 0,
  trigger_immediacy_score numeric(5,2) not null default 0,
  engagement_potential_score numeric(5,2) not null default 0,

  total_mw_at_risk numeric(12,2) not null default 0,
  asset_count integer not null default 0,
  mapped_asset_count integer not null default 0,
  high_risk_asset_count integer not null default 0,
  likely_curtailed_count integer not null default 0,
  maintenance_offline_count integer not null default 0,
  upcoming_cod_count integer not null default 0,

  coverage_rate numeric(6,4),
  verification_pct numeric(6,4),

  top_signals jsonb not null default '[]'::jsonb,
  recommended_service_lines jsonb not null default '[]'::jsonb,

  previous_opportunity_score numeric(5,2),
  weekly_delta_score numeric(6,2),

  computed_at timestamptz not null default now()
);

create table if not exists public.developer_opportunity_score_history (
  id bigserial primary key,
  developer_id uuid not null references public.developers(id) on delete cascade,
  developer_name text not null,
  model_version text not null default 'v1',
  opportunity_score numeric(5,2) not null,
  distress_score numeric(5,2) not null,
  complexity_score numeric(5,2) not null,
  trigger_immediacy_score numeric(5,2) not null,
  engagement_potential_score numeric(5,2) not null,
  weekly_delta_score numeric(6,2),
  top_signals jsonb not null default '[]'::jsonb,
  recommended_service_lines jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default now()
);

create index if not exists idx_dev_opportunity_score_desc
  on public.developer_opportunity_scores (opportunity_score desc);

create index if not exists idx_dev_opportunity_computed_at_desc
  on public.developer_opportunity_scores (computed_at desc);

create index if not exists idx_dev_opportunity_history_dev_time
  on public.developer_opportunity_score_history (developer_id, computed_at desc);
