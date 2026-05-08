-- ============================================================
-- Phase 4: Evidence corpus + embeddings for lender-claim retrieval.
--
-- Background: today retrieval is article-level (news_articles.embedding).
-- For lender claims we need finer-grained, source-agnostic evidence chunks
-- so the v2 agentic claim generator can cite the exact passage that names
-- a lender + role + plant. Sources include financing-tagged news,
-- UCC filings (ucc_filings.evidence_text), EDGAR docs, and manual notes.
--
-- Tables:
--   lender_evidence_documents — one row per ingested source doc
--   lender_evidence_chunks    — pre-chunked text with vector(768) embedding
--
-- The corpus is layered on top of (not a replacement for) news_articles.
-- Source rows are referenced by (source_type, source_id) — flexible string
-- key so we can mix tables without a single FK.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ── 1. lender_evidence_documents ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lender_evidence_documents (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type       text NOT NULL
    CHECK (source_type IN ('news_article','ucc_filing','edgar_filing','manual','press_release')),
  source_id         text NOT NULL,
  plant_code        text,
  lender_normalized text,
  title             text,
  url               text,
  published_at      timestamptz,
  pipeline_version  text NOT NULL DEFAULT 'v2'
    CHECK (pipeline_version IN ('v1_legacy','v2')),
  metadata          jsonb DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);

ALTER TABLE public.lender_evidence_documents ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'lender_evidence_documents' AND policyname = 'led_public_read'
  ) THEN
    CREATE POLICY "led_public_read" ON public.lender_evidence_documents FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'lender_evidence_documents' AND policyname = 'led_service_write'
  ) THEN
    CREATE POLICY "led_service_write" ON public.lender_evidence_documents FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_led_plant_code        ON public.lender_evidence_documents (plant_code);
CREATE INDEX IF NOT EXISTS idx_led_lender_normalized ON public.lender_evidence_documents (lender_normalized);
CREATE INDEX IF NOT EXISTS idx_led_source_type       ON public.lender_evidence_documents (source_type);
CREATE INDEX IF NOT EXISTS idx_led_published_at      ON public.lender_evidence_documents (published_at DESC);

-- ── 2. lender_evidence_chunks ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lender_evidence_chunks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id  bigint NOT NULL REFERENCES public.lender_evidence_documents(id) ON DELETE CASCADE,
  chunk_index  int    NOT NULL,
  content      text   NOT NULL,
  token_count  int,
  embedding    vector(768),
  embedded_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

ALTER TABLE public.lender_evidence_chunks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'lender_evidence_chunks' AND policyname = 'lec_public_read'
  ) THEN
    CREATE POLICY "lec_public_read" ON public.lender_evidence_chunks FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'lender_evidence_chunks' AND policyname = 'lec_service_write'
  ) THEN
    CREATE POLICY "lec_service_write" ON public.lender_evidence_chunks FOR ALL
      USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lec_document_id ON public.lender_evidence_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_lec_embedded_at ON public.lender_evidence_chunks (embedded_at);

-- HNSW cosine index over embeddings (partial: only embedded chunks)
CREATE INDEX IF NOT EXISTS lender_evidence_chunks_embedding_hnsw
  ON public.lender_evidence_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── 3. search_lender_evidence RPC ────────────────────────────────────────────
-- Hybrid retrieval: cosine similarity over chunks, optionally filtered by
-- plant_code or lender_normalized at the document level.
CREATE OR REPLACE FUNCTION public.search_lender_evidence(
  p_query_embedding   vector(768),
  p_plant_code        text   DEFAULT NULL,
  p_lender_normalized text   DEFAULT NULL,
  p_max_results       int    DEFAULT 20
)
RETURNS TABLE (
  chunk_id          bigint,
  document_id       bigint,
  source_type       text,
  source_id         text,
  plant_code        text,
  lender_normalized text,
  title             text,
  url               text,
  published_at      timestamptz,
  chunk_index       int,
  content           text,
  similarity        float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id            AS chunk_id,
    d.id            AS document_id,
    d.source_type,
    d.source_id,
    d.plant_code,
    d.lender_normalized,
    d.title,
    d.url,
    d.published_at,
    c.chunk_index,
    c.content,
    (1 - (c.embedding <=> p_query_embedding))::float AS similarity
  FROM public.lender_evidence_chunks c
  JOIN public.lender_evidence_documents d ON d.id = c.document_id
  WHERE c.embedding IS NOT NULL
    AND (p_plant_code IS NULL OR d.plant_code = p_plant_code)
    AND (p_lender_normalized IS NULL OR d.lender_normalized = p_lender_normalized)
  ORDER BY c.embedding <=> p_query_embedding
  LIMIT p_max_results;
$$;

GRANT EXECUTE ON FUNCTION public.search_lender_evidence(vector, text, text, int) TO authenticated, service_role, anon;
