-- ============================================================
-- GenTrack — Enable required Postgres extensions
-- Run ONCE in Supabase SQL Editor (Dashboard → SQL Editor)
-- All three extensions are pre-installed on every Supabase project
-- ============================================================

-- pgvector: stores and searches 768-dim Gemini embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- pg_net: allows pg_cron to invoke Edge Functions via HTTP
CREATE EXTENSION IF NOT EXISTS pg_net;

-- pg_cron: schedules recurring SQL jobs (news ingest, embed, ratings)
CREATE EXTENSION IF NOT EXISTS pg_cron;
