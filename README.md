<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/15RqWZQiX9stTE6ygIlH7BNe18T-HIkjd

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## v5 Lender Pipeline Operations

Use these commands for the current sonar-based lender pipeline:

1. Ensure env values are present in `.env` or `.env.local`:
   - `SUPABASE_URL` (or `VITE_SUPABASE_URL`)
   - `SUPABASE_SECRET_KEY` (or `VITE_SUPABASE_SECRET_KEY`)
   - `VITE_SUPABASE_ANON_KEY` (optional, auth smoke only)
   - `INTERNAL_AUTH_TOKEN` (required for internal bearer auth smoke and direct function invocation)
2. Archive legacy v4 data (v4 tables have been dropped; this is a no-op but safe to run):
   - `npm run archive:lender:v4` (requires `SUPABASE_SECRET_KEY` in env)
3. Run v5 cohort tests after migrations and cohort setup:
   - `npm run test:lender:v5`
4. Run the production cohort with a budget cap:
   - `npm run run:lender:v5 -- --concurrency 3 --max-cost 50`

Notes:
- Legacy anon/service-role keys are disabled on Supabase projects using the new key model. Use secret keys for scripts.
- If local DB connectivity to the Supabase pooler is blocked, run migration SQL in Supabase SQL Editor.
- The deployed edge function path is `lender-research-sonar` and auth is enforced by admin JWT or `INTERNAL_AUTH_TOKEN`.
