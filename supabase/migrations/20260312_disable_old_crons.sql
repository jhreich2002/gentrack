-- ============================================================
-- Disable old news ingestion cron jobs
-- Old pipeline replaced by: ingest-plant-news.ts → plant-news-rank → embed-articles
-- ============================================================

-- Old tiered MW-based jobs (if still present)
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname IN ('news-ingest-tier1', 'news-ingest-tier2');

-- Curtailment-based jobs
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname IN ('news-ingest-curtailed-t1', 'news-ingest-curtailed-t2');

-- Sector news ingest jobs
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname LIKE 'sector-news-ingest%';

-- Day 3 nightly news-ingest (if scheduled separately)
SELECT cron.unschedule(jobid)
FROM cron.job WHERE jobname = 'news-ingest-nightly';
