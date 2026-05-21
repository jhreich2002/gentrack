-- ============================================================
-- v4 patch: re-seed lender_aliases through normalize_lender_name()
--           and add common short-form variants.
--
-- Symptom this fixes: resolve_lender_name('JPMorgan Chase Bank, N.A.')
-- returned NULL because the seed inserted lowercased canonical
-- names (e.g. "jpmorgan chase") rather than the normalized form
-- the resolver compares against (e.g. "jpmorgan chase bank" after
-- suffix stripping).
--
-- Apply via Supabase SQL Editor.
-- ============================================================

-- 1. Wipe ALL seed-source aliases (keep manual + resolver-learned).
DELETE FROM public.lender_aliases WHERE source = 'seed';

-- 2. Re-seed canonical names through normalize_lender_name() so the
--    stored alias matches what the resolver computes for an input.
INSERT INTO public.lender_aliases (lender_id, alias, alias_raw, source)
SELECT lc.id, public.normalize_lender_name(lc.name), lc.name, 'seed'
FROM   public.lenders_canonical lc
ON CONFLICT (alias) DO NOTHING;

-- 3. Add common short-form / variant aliases that real evidence uses.
--    Each row: (canonical name, variant raw text). Normalized at insert.
WITH variants(canonical_name, variant) AS (
  VALUES
    -- JPMorgan family
    ('JPMorgan Chase', 'JPMorgan Chase Bank, N.A.'),
    ('JPMorgan Chase', 'JPMorgan Chase Bank'),
    ('JPMorgan Chase', 'JPMorgan'),
    ('JPMorgan Chase', 'JP Morgan'),
    ('JPMorgan Chase', 'JP Morgan Chase'),
    ('JPMorgan Chase', 'JPM'),
    ('JPMorgan Chase', 'Chase Bank'),
    -- Bank of America
    ('Bank of America', 'Bank of America, N.A.'),
    ('Bank of America', 'BofA'),
    ('Bank of America', 'BAML'),
    ('Bank of America', 'Merrill Lynch'),
    -- Wells Fargo
    ('Wells Fargo', 'Wells Fargo Bank, N.A.'),
    ('Wells Fargo', 'Wells Fargo Bank'),
    ('Wells Fargo', 'WFB'),
    -- Citi
    ('Citibank', 'Citibank, N.A.'),
    ('Citibank', 'Citi'),
    ('Citibank', 'Citigroup'),
    -- Goldman / MS
    ('Goldman Sachs', 'Goldman Sachs Bank USA'),
    ('Goldman Sachs', 'GS'),
    ('Morgan Stanley', 'Morgan Stanley Bank, N.A.'),
    ('Morgan Stanley', 'MS'),
    -- European majors
    ('BNP Paribas', 'BNP'),
    ('Société Générale', 'SocGen'),
    ('Société Générale', 'Societe Generale'),
    ('Crédit Agricole', 'Credit Agricole'),
    ('Crédit Agricole', 'CACIB'),
    ('Crédit Agricole', 'Credit Agricole CIB'),
    ('Deutsche Bank', 'Deutsche Bank AG'),
    ('Deutsche Bank', 'DB'),
    ('Barclays', 'Barclays Bank PLC'),
    ('HSBC', 'HSBC Bank USA'),
    ('HSBC', 'HSBC Holdings'),
    ('ING', 'ING Bank'),
    ('ING', 'ING Capital'),
    ('Santander', 'Banco Santander'),
    ('Santander', 'Santander Bank'),
    ('Natixis', 'Natixis New York Branch'),
    -- Japanese megabanks
    ('MUFG', 'MUFG Bank'),
    ('MUFG', 'MUFG Bank, Ltd.'),
    ('MUFG', 'Mitsubishi UFJ'),
    ('MUFG', 'Bank of Tokyo-Mitsubishi UFJ'),
    ('MUFG', 'BTMU'),
    ('Mitsubishi UFJ Financial Group', 'MUFG Bank'),
    ('Sumitomo Mitsui', 'SMBC'),
    ('Sumitomo Mitsui', 'Sumitomo Mitsui Banking Corp'),
    ('Sumitomo Mitsui Banking Corporation', 'SMBC'),
    ('Mizuho', 'Mizuho Bank'),
    ('Mizuho', 'Mizuho Bank, Ltd.'),
    ('Mizuho Financial Group', 'Mizuho Bank'),
    -- Canadian
    ('Royal Bank of Canada', 'RBC'),
    ('Royal Bank of Canada', 'RBC Capital Markets'),
    ('Bank of Montreal', 'BMO'),
    ('Bank of Montreal', 'BMO Capital Markets'),
    ('CIBC', 'Canadian Imperial Bank of Commerce'),
    ('Scotiabank', 'Bank of Nova Scotia'),
    ('Scotiabank', 'BNS'),
    ('TD Bank', 'Toronto-Dominion Bank'),
    ('TD Bank', 'TD Securities'),
    -- US regionals
    ('US Bancorp', 'U.S. Bank'),
    ('US Bancorp', 'US Bank'),
    ('US Bancorp', 'U.S. Bank National Association'),
    ('PNC Financial', 'PNC Bank'),
    ('PNC Financial', 'PNC Bank, N.A.'),
    ('KeyBanc', 'KeyBank'),
    ('KeyBanc', 'KeyBank National Association'),
    ('Truist', 'Truist Bank'),
    ('Truist', 'BB&T'),
    ('Truist', 'SunTrust'),
    ('Regions Bank', 'Regions Financial'),
    -- Insurance / asset managers
    ('MetLife', 'Metropolitan Life Insurance'),
    ('MetLife', 'MetLife Investment Management'),
    ('Prudential Financial', 'Prudential'),
    ('Prudential Financial', 'PGIM'),
    ('TIAA', 'TIAA-CREF'),
    ('TIAA', 'Nuveen'),
    ('John Hancock', 'John Hancock Life Insurance'),
    ('Manulife', 'Manulife Financial'),
    ('New York Life', 'NYL Investors'),
    ('Allianz', 'Allianz Global Investors'),
    ('Allianz', 'AllianzGI'),
    -- Specialty
    ('CoBank', 'CoBank, ACB'),
    ('Macquarie', 'Macquarie Bank'),
    ('Macquarie', 'Macquarie Capital'),
    ('NordLB', 'Norddeutsche Landesbank'),
    ('Nord/LB', 'NordLB'),
    -- Chinese
    ('ICBC', 'Industrial and Commercial Bank of China'),
    ('Bank of China', 'BOC')
)
INSERT INTO public.lender_aliases (lender_id, alias, alias_raw, source)
SELECT
  lc.id,
  public.normalize_lender_name(v.variant),
  v.variant,
  'seed'
FROM   variants v
JOIN   public.lenders_canonical lc ON lc.name = v.canonical_name
WHERE  public.normalize_lender_name(v.variant) <> ''
ON CONFLICT (alias) DO NOTHING;

-- ── Smoke tests ──────────────────────────────────────────────────────────────
-- Each should return a non-NULL canonical id.

SELECT 'jpmorgan chase bank na' AS test, * FROM public.resolve_lender_name('JPMorgan Chase Bank, N.A.');
SELECT 'jp morgan'              AS test, * FROM public.resolve_lender_name('JP Morgan');
SELECT 'mufg bank ltd'          AS test, * FROM public.resolve_lender_name('MUFG Bank, Ltd.');
SELECT 'smbc'                   AS test, * FROM public.resolve_lender_name('SMBC');
SELECT 'us bank na'             AS test, * FROM public.resolve_lender_name('U.S. Bank National Association');
SELECT 'rbc capital markets'    AS test, * FROM public.resolve_lender_name('RBC Capital Markets');
SELECT 'societe generale'       AS test, * FROM public.resolve_lender_name('Societe Generale');

-- Inspect what got seeded for the JPMorgan family
SELECT la.alias, la.alias_raw, la.source, lc.name AS canonical
FROM   public.lender_aliases la
JOIN   public.lenders_canonical lc ON lc.id = la.lender_id
WHERE  lc.name IN ('JPMorgan Chase','MUFG','Sumitomo Mitsui','US Bancorp')
ORDER  BY lc.name, la.alias;
