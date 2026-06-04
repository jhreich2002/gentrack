// Diagnostic-only edge function to query DB state for debugging.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const internalToken = Deno.env.get("INTERNAL_AUTH_TOKEN") ?? "";
  if (!internalToken || token !== internalToken) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: CORS });
  }
  const dbUrl = Deno.env.get("SUPABASE_DB_URL")!;
  const sql = postgres(dbUrl, { max: 1 });
  try {
    const rls = await sql`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('plant_lender_links','lenders_canonical')`;
    const policies = await sql`
      SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies WHERE schemaname='public' AND tablename IN ('plant_lender_links','lenders_canonical')`;
    const grants = await sql`
      SELECT grantee, table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name IN ('plant_lender_links','lenders_canonical')
        AND grantee IN ('anon','authenticated','service_role')
      ORDER BY table_name, grantee, privilege_type`;
    return new Response(JSON.stringify({ rls, policies, grants }, null, 2), { status: 200, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS });
  } finally {
    await sql.end();
  }
});
