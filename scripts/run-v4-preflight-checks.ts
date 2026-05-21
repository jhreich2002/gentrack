import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

type ArgValue = string | boolean;
type CheckStatus = 'pass' | 'fail' | 'warn';

interface CheckResult {
  check: string;
  status: CheckStatus;
  detail: string;
}

interface OrchestratorResponse {
  status: number;
  text: string;
}

function parseArgs(argv: string[]): Map<string, ArgValue> {
  const out = new Map<string, ArgValue>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out.set(key, next);
      i += 1;
      continue;
    }
    out.set(key, true);
  }
  return out;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function envValue(key: string, envMap: Record<string, string>): string {
  return process.env[key] ?? envMap[key] ?? '';
}

function asBoolean(value: ArgValue | undefined): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase());
}

function addResult(results: CheckResult[], check: string, status: CheckStatus, detail: string): void {
  results.push({ check, status, detail });
  const icon = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'WARN';
  console.log(`[${icon}] ${check}: ${detail}`);
}

async function callOrchestrator(
  orchestratorUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<OrchestratorResponse> {
  const response = await fetch(orchestratorUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.get('help')) {
    console.log([
      'Usage: npx tsx scripts/run-v4-preflight-checks.ts [options]',
      '',
      'Options:',
      '  --manual-plant-id EIA-6152     Plant ID used for manual-link smoke test',
      '  --manual-lender-name Citibank  Lender name used for manual-link smoke test',
      '  --internal-token <token>       Override INTERNAL_AUTH_TOKEN from env',
      '  --skip-admin-check             Skip profiles.role admin count check',
      '  --skip-auth-check              Skip orchestrator auth boundary checks',
      '  --skip-manual-check            Skip manual evidence propagation check',
      '',
      'Environment:',
      '  SUPABASE_URL or VITE_SUPABASE_URL',
      '  SUPABASE_SERVICE_ROLE_KEY or VITE_SUPABASE_SERVICE_ROLE_KEY',
      '  SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY (optional for anon auth check)',
      '  INTERNAL_AUTH_TOKEN or VITE_INTERNAL_AUTH_TOKEN (required for internal auth check)',
    ].join('\n'));
    return;
  }

  const cwd = process.cwd();
  const mergedEnv = {
    ...parseEnvFile(path.join(cwd, '.env')),
    ...parseEnvFile(path.join(cwd, '.env.local')),
  };

  const supabaseUrl = envValue('SUPABASE_URL', mergedEnv) || envValue('VITE_SUPABASE_URL', mergedEnv);
  const serviceRoleKey = envValue('SUPABASE_SERVICE_ROLE_KEY', mergedEnv) || envValue('VITE_SUPABASE_SERVICE_ROLE_KEY', mergedEnv);
  const anonKey = envValue('SUPABASE_ANON_KEY', mergedEnv) || envValue('VITE_SUPABASE_ANON_KEY', mergedEnv);
  const internalToken = (typeof args.get('internal-token') === 'string' ? String(args.get('internal-token')) : '')
    || envValue('INTERNAL_AUTH_TOKEN', mergedEnv)
    || envValue('VITE_INTERNAL_AUTH_TOKEN', mergedEnv);

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in .env/.env.local.');
  }

  const sb = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const skipAdminCheck = asBoolean(args.get('skip-admin-check'));
  const skipAuthCheck = asBoolean(args.get('skip-auth-check'));
  const skipManualCheck = asBoolean(args.get('skip-manual-check'));

  const results: CheckResult[] = [];
  const orchestratorUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/lender-research-orchestrator`;
  const fakePlantId = `EIA-PREFLIGHT-${Date.now()}`;

  if (!skipAdminCheck) {
    const { count, error } = await sb
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin');

    if (error) {
      addResult(results, 'admin-profile-check', 'fail', `Query failed: ${error.message}`);
    } else if ((count ?? 0) > 0) {
      addResult(results, 'admin-profile-check', 'pass', `Found ${count} admin profile(s).`);
    } else {
      addResult(results, 'admin-profile-check', 'fail', 'No admin profiles found. Set profiles.role = admin before browser testing.');
    }
  }

  if (!skipAuthCheck) {
    const noAuth = await callOrchestrator(orchestratorUrl, { plant_id: fakePlantId, budget_usd: 0.1, trigger: 'manual' });
    if (noAuth.status === 401) {
      addResult(results, 'auth-no-bearer', 'pass', 'Received 401 as expected.');
    } else {
      addResult(results, 'auth-no-bearer', 'fail', `Expected 401, got ${noAuth.status}. Body: ${noAuth.text.slice(0, 180)}`);
    }

    if (anonKey) {
      const anon = await callOrchestrator(
        orchestratorUrl,
        { plant_id: fakePlantId, budget_usd: 0.1, trigger: 'manual' },
        {
          Authorization: `Bearer ${anonKey}`,
          apikey: anonKey,
        },
      );

      if (anon.status === 401) {
        addResult(results, 'auth-anon-bearer', 'pass', 'Received 401 as expected.');
      } else {
        addResult(results, 'auth-anon-bearer', 'fail', `Expected 401, got ${anon.status}. Body: ${anon.text.slice(0, 180)}`);
      }
    } else {
      addResult(results, 'auth-anon-bearer', 'warn', 'SUPABASE_ANON_KEY not found; skipped anon bearer check.');
    }

    if (internalToken) {
      const internal = await callOrchestrator(
        orchestratorUrl,
        { plant_id: fakePlantId, budget_usd: 0.1, trigger: 'manual' },
        {
          Authorization: `Bearer ${internalToken}`,
        },
      );

      if (internal.status === 404) {
        addResult(results, 'auth-internal-token', 'pass', 'Received 404 plant-not-found; auth path passed.');
      } else if (internal.status === 401) {
        addResult(results, 'auth-internal-token', 'fail', `Received 401; INTERNAL_AUTH_TOKEN appears invalid. Body: ${internal.text.slice(0, 180)}`);
      } else {
        addResult(results, 'auth-internal-token', 'fail', `Expected 404 for fake plant, got ${internal.status}. Body: ${internal.text.slice(0, 180)}`);
      }
    } else {
      addResult(results, 'auth-internal-token', 'fail', 'Missing INTERNAL_AUTH_TOKEN; cannot validate internal auth path.');
    }
  }

  if (!skipManualCheck) {
    const manualPlantId = typeof args.get('manual-plant-id') === 'string' ? String(args.get('manual-plant-id')) : 'EIA-6152';
    const runId = `preflight-manual-${Date.now()}`;
    const manualLenderName = typeof args.get('manual-lender-name') === 'string'
      ? String(args.get('manual-lender-name'))
      : `Preflight Test Lender ${runId}`;
    const note = runId;
    const sourceUrl = `https://example.com/${runId}`;

    const { data: linkIdRaw, error: addError } = await sb.rpc('add_manual_lender_link', {
      p_plant_id: manualPlantId,
      p_lender_name: manualLenderName,
      p_source_url: sourceUrl,
      p_note: note,
    });

    if (addError) {
      addResult(results, 'manual-rpc-insert', 'fail', `add_manual_lender_link failed: ${addError.message}`);
    } else {
      const linkId = Number(linkIdRaw);
      if (!Number.isFinite(linkId)) {
        addResult(results, 'manual-rpc-insert', 'fail', `Unexpected link id: ${String(linkIdRaw)}`);
      } else {
        addResult(results, 'manual-rpc-insert', 'pass', `Manual link created with link_id=${linkId}.`);

        const { data: financingRows, error: financingError } = await sb
          .from('v_plant_financing')
          .select('plant_id, lender_name, validation_status, source_url')
          .eq('plant_id', manualPlantId)
          .eq('lender_name', manualLenderName)
          .eq('validation_status', 'manual')
          .eq('source_url', sourceUrl);

        if (financingError) {
          addResult(results, 'manual-url-propagation', 'fail', `v_plant_financing query failed: ${financingError.message}`);
        } else if ((financingRows ?? []).length > 0) {
          addResult(results, 'manual-url-propagation', 'pass', 'source_url propagated to v_plant_financing.');
        } else {
          addResult(results, 'manual-url-propagation', 'fail', 'No matching financing row found with inserted source_url.');
        }

        let claimId: number | null = null;
        let sessionId: string | null = null;

        const { data: linkRow, error: linkError } = await sb
          .from('lender_links')
          .select('id, primary_claim_id')
          .eq('id', linkId)
          .maybeSingle();

        if (linkError) {
          addResult(results, 'manual-cleanup', 'warn', `Failed to load created link for cleanup: ${linkError.message}`);
        } else {
          claimId = linkRow?.primary_claim_id ? Number(linkRow.primary_claim_id) : null;
          if (claimId) {
            const { data: claimRow, error: claimError } = await sb
              .from('lender_research_claims')
              .select('id, session_id')
              .eq('id', claimId)
              .maybeSingle();

            if (claimError) {
              addResult(results, 'manual-cleanup', 'warn', `Failed to load claim for cleanup: ${claimError.message}`);
            } else {
              sessionId = claimRow?.session_id ? String(claimRow.session_id) : null;
            }
          }

          const cleanupErrors: string[] = [];

          if (claimId) {
            const { error } = await sb.from('lender_link_evidence').delete().eq('claim_id', claimId);
            if (error) cleanupErrors.push(`lender_link_evidence: ${error.message}`);
          }

          {
            const { error } = await sb.from('lender_links').delete().eq('id', linkId);
            if (error) cleanupErrors.push(`lender_links: ${error.message}`);
          }

          if (claimId) {
            const { error } = await sb.from('lender_research_claims').delete().eq('id', claimId);
            if (error) cleanupErrors.push(`lender_research_claims: ${error.message}`);
          }

          if (sessionId) {
            const { count, error: countError } = await sb
              .from('lender_research_claims')
              .select('id', { count: 'exact', head: true })
              .eq('session_id', sessionId);

            if (countError) {
              cleanupErrors.push(`session claim count: ${countError.message}`);
            } else if ((count ?? 0) === 0) {
              const { error } = await sb.from('lender_research_sessions').delete().eq('id', sessionId);
              if (error) cleanupErrors.push(`lender_research_sessions: ${error.message}`);
            }
          }

          if (cleanupErrors.length > 0) {
            addResult(results, 'manual-cleanup', 'warn', cleanupErrors.join(' | '));
          } else {
            addResult(results, 'manual-cleanup', 'pass', 'Temporary link/claim/session artifacts cleaned up.');
          }

          // Best-effort cleanup for test-only lender records created by default run.
          if (typeof args.get('manual-lender-name') !== 'string') {
            const { data: canonicalRow, error: canonicalLookupError } = await sb
              .from('lenders_canonical')
              .select('id')
              .eq('name', manualLenderName)
              .maybeSingle();

            if (!canonicalLookupError && canonicalRow?.id) {
              const canonicalId = String(canonicalRow.id);
              const [{ count: linkCount, error: linkCountError }, { count: claimCount, error: claimCountError }] = await Promise.all([
                sb
                  .from('lender_links')
                  .select('id', { count: 'exact', head: true })
                  .eq('canonical_lender_id', canonicalId),
                sb
                  .from('lender_research_claims')
                  .select('id', { count: 'exact', head: true })
                  .eq('canonical_lender_id', canonicalId),
              ]);

              if (!linkCountError && !claimCountError && (linkCount ?? 0) === 0 && (claimCount ?? 0) === 0) {
                const { error: aliasDeleteError } = await sb
                  .from('lender_aliases')
                  .delete()
                  .eq('lender_id', canonicalId)
                  .eq('source', 'manual');

                const { error: lenderDeleteError } = await sb
                  .from('lenders_canonical')
                  .delete()
                  .eq('id', canonicalId)
                  .eq('name', manualLenderName);

                if (aliasDeleteError || lenderDeleteError) {
                  addResult(
                    results,
                    'manual-canonical-cleanup',
                    'warn',
                    [aliasDeleteError?.message, lenderDeleteError?.message].filter(Boolean).join(' | '),
                  );
                } else {
                  addResult(results, 'manual-canonical-cleanup', 'pass', 'Deleted temporary manual lender alias/canonical rows.');
                }
              }
            }
          }
        }
      }
    }
  }

  const failed = results.filter(r => r.status === 'fail').length;
  const warned = results.filter(r => r.status === 'warn').length;
  const passed = results.filter(r => r.status === 'pass').length;

  console.log('\nSummary');
  console.table(results);
  console.log(`Passed: ${passed}  Failed: ${failed}  Warned: ${warned}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`Fatal preflight error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
