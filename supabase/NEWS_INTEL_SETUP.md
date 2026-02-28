# GenTrack News Intelligence — Setup Checklist

Run each step once to activate the nightly news pipeline.

## 1. Enable Postgres Extensions

In the **Supabase SQL Editor** (`ohmmtplnaddrfuoowpuq`), run these files in order:

```
scripts/001_enable_extensions.sql
scripts/002_news_articles.sql
scripts/003_plant_news_ratings.sql
scripts/004_semantic_search_rpc.sql
```

## 2. Get a NewsAPI.org key

Sign up free at https://newsapi.org — free tier gives 100 requests/day (plenty for ~40 nightly queries).

## 3. Deploy Edge Functions + set secrets

```powershell
# Install Supabase CLI if not already installed
npm install -g supabase

# Login
npx supabase login

# Set secrets (only needed once — stored securely in Supabase)
npx supabase secrets set NEWSAPI_KEY=<your_newsapi_key> --project-ref ohmmtplnaddrfuoowpuq
npx supabase secrets set GEMINI_API_KEY=<your_gemini_key>  --project-ref ohmmtplnaddrfuoowpuq

# Deploy all three Edge Functions
npx supabase functions deploy news-ingest      --project-ref ohmmtplnaddrfuoowpuq
npx supabase functions deploy embed-articles   --project-ref ohmmtplnaddrfuoowpuq
npx supabase functions deploy compute-ratings  --project-ref ohmmtplnaddrfuoowpuq
```

## 4. Schedule via pg_cron

Edit `scripts/005_cron_schedules.sql`:
- Replace `<SERVICE_ROLE_KEY>` with your actual service role JWT

Then run it in the Supabase SQL Editor.

## 5. Manual test run

In the Supabase Dashboard → Edge Functions, invoke each function once to verify:
1. `news-ingest` → check `news_articles` table for new rows
2. `embed-articles` → check `embedded_at` column is populated
3. `compute-ratings` → check `plant_news_ratings` table for rows

Then open any plant in GenTrack → News & Intelligence tab → Historical Intelligence section.

## IVFFlat index note

The ANN index in `002_news_articles.sql` requires training data.
After your first ingest run populates ≥500 rows, run:

```sql
REINDEX INDEX CONCURRENTLY idx_news_articles_embedding;
VACUUM ANALYZE news_articles;
```

## Cost summary

| Service | Usage | Cost |
|---|---|---|
| NewsAPI.org | ~40 req/day | Free (100/day limit) |
| Gemini text-embedding-004 | ~500 articles/day batched in 5 calls | Free (1,500 rpm limit) |
| Supabase Edge Functions | 3 functions × 1 call/day | Free (500K calls/month limit) |
| pgvector storage | ~50K articles × 768 floats ≈ 150 MB/year | Free (500 MB Supabase free tier) |
