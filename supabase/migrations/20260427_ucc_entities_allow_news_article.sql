-- Allow 'news_article' as a valid ucc_entities.source so the news fallback
-- worker and the reviewer's ensureEntityId helper can persist lender entities
-- discovered via validated news articles.

ALTER TABLE ucc_entities DROP CONSTRAINT IF EXISTS ucc_entities_source_check;
ALTER TABLE ucc_entities
  ADD CONSTRAINT ucc_entities_source_check
  CHECK (source IN (
    'opencorporates', 'sos_scrape', 'ucc_filing', 'county_record', 'county_scrape',
    'edgar', 'perplexity', 'algorithmic', 'web_scrape', 'sponsor_history',
    'supplement_worker', 'sponsor_pattern', 'news_article'
  ));
