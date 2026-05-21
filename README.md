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

## v4 Lender Pipeline Preflight

Before UI testing, run a backend readiness check:

1. Ensure env values are present in `.env` or `.env.local`:
   - `SUPABASE_URL` (or `VITE_SUPABASE_URL`)
   - `SUPABASE_SERVICE_ROLE_KEY` (or `VITE_SUPABASE_SERVICE_ROLE_KEY`)
   - `SUPABASE_ANON_KEY` (optional, for anon auth gate check)
   - `INTERNAL_AUTH_TOKEN` (or `VITE_INTERNAL_AUTH_TOKEN`, required for internal-token auth check)
2. Run the preflight script:
   - `npm run test:preflight:v4`
3. Optional flags:
   - `--skip-manual-check` to avoid write/cleanup smoke
   - `--skip-auth-check` to only run admin/manual checks
   - `--manual-plant-id <plant_id>` to target a specific plant for manual-link propagation

Notes:
- The script verifies admin profile presence (`profiles.role='admin'`), orchestrator auth boundaries, and manual source URL propagation into `v_plant_financing`.
- If `INTERNAL_AUTH_TOKEN` is missing locally, the auth-internal-token check will fail by design.
