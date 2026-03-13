-- Track which financing articles have been processed by lender-extract
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS lender_extracted_at timestamptz;

-- Index for fast unprocessed article lookup in lender-extract
CREATE INDEX IF NOT EXISTS idx_news_articles_lender_extracted
  ON news_articles (lender_extracted_at)
  WHERE pipeline = 'financing' AND asset_linkage_tier IN ('high', 'medium');
