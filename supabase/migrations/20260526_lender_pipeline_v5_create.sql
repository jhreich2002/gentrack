-- Lender Pipeline v5: sonar-only schema

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE public.lenders_canonical (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL UNIQUE,
  normalized_name text NOT NULL UNIQUE,
  is_tax_equity boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.lender_aliases (
  alias text PRIMARY KEY,
  normalized_alias text NOT NULL,
  canonical_id uuid NOT NULL REFERENCES public.lenders_canonical(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_id, normalized_alias)
);

CREATE INDEX idx_lender_aliases_normalized ON public.lender_aliases(normalized_alias);

CREATE TABLE public.plant_lender_research (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id text NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('complete', 'no_lender_identifiable', 'error')),
  prompt_version text NOT NULL,
  model text NOT NULL,
  cost_usd numeric(10, 5) NOT NULL DEFAULT 0,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_response jsonb,
  error_detail text,
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX idx_plant_lender_research_plant ON public.plant_lender_research(plant_id);
CREATE INDEX idx_plant_lender_research_completed ON public.plant_lender_research(completed_at DESC);

CREATE TABLE public.plant_lender_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id text NOT NULL REFERENCES public.plants(id) ON DELETE CASCADE,
  lender_id uuid NOT NULL REFERENCES public.lenders_canonical(id) ON DELETE CASCADE,
  role text,
  role_summary text,
  source_url text NOT NULL,
  evidence_quote text,
  inferred_from_sibling_plant_id text REFERENCES public.plants(id) ON DELETE SET NULL,
  sibling_fanout_flagged boolean NOT NULL DEFAULT false,
  research_id uuid NOT NULL REFERENCES public.plant_lender_research(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plant_id, lender_id)
);

CREATE INDEX idx_plant_lender_links_plant ON public.plant_lender_links(plant_id);
CREATE INDEX idx_plant_lender_links_lender ON public.plant_lender_links(lender_id);

CREATE OR REPLACE FUNCTION public.normalize_lender_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT trim(
    regexp_replace(
      trim(regexp_replace(
        regexp_replace(
          regexp_replace(
            lower(unaccent(coalesce(p_name, ''))),
            '[^a-z0-9\s]',
            ' ',
            'g'
          ),
          '\s+',
          ' ',
          'g'
        ),
        '\m(j\s*p\s*morgan(\s+chase)?)\M',
        'jpmorgan',
        'gi'
      )),
      '(?:\s+(llc|lp|inc|incorporated|corp|corporation|co|company|ltd|limited|na|n a|plc|ag|sa|bank|capital|holdings|group|partners|services|financial|usa|us|na branch|new york branch))+$',
      '',
      'gi'
    )
  );
$$;

DO $$
BEGIN
  ASSERT public.normalize_lender_name('JPMorgan Chase Bank, N.A.') = public.normalize_lender_name('JP Morgan Capital LLC'),
    'JP Morgan normalization mismatch';
END $$;

GRANT EXECUTE ON FUNCTION public.normalize_lender_name(text) TO authenticated, anon, service_role;

INSERT INTO public.lenders_canonical (canonical_name, normalized_name, is_tax_equity)
VALUES
  ('JPMorgan Chase', public.normalize_lender_name('JPMorgan Chase'), false),
  ('Bank of America', public.normalize_lender_name('Bank of America'), false),
  ('Wells Fargo', public.normalize_lender_name('Wells Fargo'), false),
  ('Citibank', public.normalize_lender_name('Citibank'), false),
  ('Goldman Sachs', public.normalize_lender_name('Goldman Sachs'), false),
  ('Morgan Stanley', public.normalize_lender_name('Morgan Stanley'), false),
  ('Barclays', public.normalize_lender_name('Barclays'), false),
  ('Deutsche Bank', public.normalize_lender_name('Deutsche Bank'), false),
  ('BNP Paribas', public.normalize_lender_name('BNP Paribas'), false),
  ('Societe Generale', public.normalize_lender_name('Societe Generale'), false),
  ('Credit Agricole', public.normalize_lender_name('Credit Agricole'), false),
  ('Natixis', public.normalize_lender_name('Natixis'), false),
  ('HSBC', public.normalize_lender_name('HSBC'), false),
  ('ING', public.normalize_lender_name('ING'), false),
  ('ABN AMRO', public.normalize_lender_name('ABN AMRO'), false),
  ('Rabobank', public.normalize_lender_name('Rabobank'), false),
  ('Santander', public.normalize_lender_name('Santander'), false),
  ('BBVA', public.normalize_lender_name('BBVA'), false),
  ('UniCredit', public.normalize_lender_name('UniCredit'), false),
  ('Intesa Sanpaolo', public.normalize_lender_name('Intesa Sanpaolo'), false),
  ('Mitsubishi UFJ Financial Group', public.normalize_lender_name('Mitsubishi UFJ Financial Group'), false),
  ('Sumitomo Mitsui Banking Corporation', public.normalize_lender_name('Sumitomo Mitsui Banking Corporation'), false),
  ('Mizuho Financial Group', public.normalize_lender_name('Mizuho Financial Group'), false),
  ('MUFG', public.normalize_lender_name('MUFG'), false),
  ('Sumitomo Mitsui', public.normalize_lender_name('Sumitomo Mitsui'), false),
  ('Mizuho', public.normalize_lender_name('Mizuho'), false),
  ('KeyBanc', public.normalize_lender_name('KeyBanc'), false),
  ('Regions Bank', public.normalize_lender_name('Regions Bank'), false),
  ('Truist', public.normalize_lender_name('Truist'), false),
  ('US Bancorp', public.normalize_lender_name('US Bancorp'), false),
  ('PNC Financial', public.normalize_lender_name('PNC Financial'), false),
  ('TD Bank', public.normalize_lender_name('TD Bank'), false),
  ('Royal Bank of Canada', public.normalize_lender_name('Royal Bank of Canada'), false),
  ('Scotiabank', public.normalize_lender_name('Scotiabank'), false),
  ('Bank of Montreal', public.normalize_lender_name('Bank of Montreal'), false),
  ('CIBC', public.normalize_lender_name('CIBC'), false),
  ('National Bank of Canada', public.normalize_lender_name('National Bank of Canada'), false),
  ('NordLB', public.normalize_lender_name('NordLB'), false),
  ('Nord/LB', public.normalize_lender_name('Nord/LB'), false),
  ('KfW', public.normalize_lender_name('KfW'), false),
  ('Helaba', public.normalize_lender_name('Helaba'), false),
  ('DekaBank', public.normalize_lender_name('DekaBank'), false),
  ('DZ Bank', public.normalize_lender_name('DZ Bank'), false),
  ('Commerzbank', public.normalize_lender_name('Commerzbank'), false),
  ('Raiffeisen', public.normalize_lender_name('Raiffeisen'), false),
  ('Credit Suisse', public.normalize_lender_name('Credit Suisse'), false),
  ('UBS', public.normalize_lender_name('UBS'), false),
  ('Macquarie', public.normalize_lender_name('Macquarie'), false),
  ('Westpac', public.normalize_lender_name('Westpac'), false),
  ('ANZ', public.normalize_lender_name('ANZ'), false),
  ('Commonwealth Bank of Australia', public.normalize_lender_name('Commonwealth Bank of Australia'), false),
  ('Korea Development Bank', public.normalize_lender_name('Korea Development Bank'), false),
  ('Export-Import Bank of Korea', public.normalize_lender_name('Export-Import Bank of Korea'), false),
  ('ICBC', public.normalize_lender_name('ICBC'), false),
  ('Bank of China', public.normalize_lender_name('Bank of China'), false),
  ('CoBank', public.normalize_lender_name('CoBank'), false),
  ('CIT Group', public.normalize_lender_name('CIT Group'), false),
  ('Silicon Valley Bank', public.normalize_lender_name('Silicon Valley Bank'), false),
  ('East West Bank', public.normalize_lender_name('East West Bank'), false),
  ('Pacific Western Bank', public.normalize_lender_name('Pacific Western Bank'), false),
  ('Fortis Capital', public.normalize_lender_name('Fortis Capital'), false),
  ('TIAA', public.normalize_lender_name('TIAA'), false),
  ('MetLife', public.normalize_lender_name('MetLife'), false),
  ('Prudential Financial', public.normalize_lender_name('Prudential Financial'), false),
  ('John Hancock', public.normalize_lender_name('John Hancock'), false),
  ('Sun Life', public.normalize_lender_name('Sun Life'), false),
  ('Manulife', public.normalize_lender_name('Manulife'), false),
  ('New York Life', public.normalize_lender_name('New York Life'), false),
  ('Principal Financial', public.normalize_lender_name('Principal Financial'), false),
  ('Nuveen', public.normalize_lender_name('Nuveen'), false),
  ('Aegon', public.normalize_lender_name('Aegon'), false),
  ('Allianz', public.normalize_lender_name('Allianz'), false),
  ('AXA', public.normalize_lender_name('AXA'), false),
  ('Zurich Insurance', public.normalize_lender_name('Zurich Insurance'), false),
  ('Aflac', public.normalize_lender_name('Aflac'), false),
  ('PGGM', public.normalize_lender_name('PGGM'), false),
  ('APG', public.normalize_lender_name('APG'), false),
  ('CDPQ', public.normalize_lender_name('CDPQ'), false),
  ('Ontario Teachers', public.normalize_lender_name('Ontario Teachers'), false),
  ('CPP Investments', public.normalize_lender_name('CPP Investments'), false),
  ('Monarch Private Capital', public.normalize_lender_name('Monarch Private Capital'), true),
  ('Raymond James', public.normalize_lender_name('Raymond James'), true),
  ('US Bancorp Community Development', public.normalize_lender_name('US Bancorp Community Development'), true),
  ('Wells Fargo Affordable Housing', public.normalize_lender_name('Wells Fargo Affordable Housing'), true),
  ('JPMorgan Tax Credit Capital', public.normalize_lender_name('JPMorgan Tax Credit Capital'), true)
ON CONFLICT DO NOTHING;

INSERT INTO public.lender_aliases (alias, normalized_alias, canonical_id)
SELECT
  lc.canonical_name,
  public.normalize_lender_name(lc.canonical_name),
  lc.id
FROM public.lenders_canonical lc
ON CONFLICT (alias) DO NOTHING;

CREATE VIEW public.v_plant_financing AS
SELECT
  pll.plant_id,
  lc.canonical_name AS lender_name,
  pll.role,
  pll.role_summary,
  pll.source_url,
  pll.evidence_quote,
  (pll.inferred_from_sibling_plant_id IS NOT NULL) AS inferred,
  pll.inferred_from_sibling_plant_id,
  plr.completed_at AS last_research_at,
  plr.status AS research_status
FROM public.plant_lender_links pll
JOIN public.lenders_canonical lc ON lc.id = pll.lender_id
JOIN public.plant_lender_research plr ON plr.id = pll.research_id
WHERE lc.is_tax_equity = false;

CREATE VIEW public.v_admin_plant_research_state AS
SELECT
  p.id AS plant_id,
  p.name AS plant_name,
  p.state,
  p.nameplate_capacity_mw,
  p.is_likely_curtailed,
  latest.completed_at AS last_research_at,
  latest.status AS last_status,
  COALESCE(link_counts.lender_count, 0)::integer AS lender_count,
  CASE
    WHEN latest.completed_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - latest.completed_at)) / 86400.0
  END AS days_since_research
FROM public.plants p
LEFT JOIN LATERAL (
  SELECT status, completed_at
  FROM public.plant_lender_research
  WHERE plant_id = p.id AND completed_at IS NOT NULL
  ORDER BY completed_at DESC
  LIMIT 1
) latest ON true
LEFT JOIN (
  SELECT plant_id, COUNT(*) AS lender_count
  FROM public.plant_lender_links
  GROUP BY plant_id
) link_counts ON link_counts.plant_id = p.id;

CREATE VIEW public.v_admin_cost_summary AS
SELECT
  date_trunc('month', requested_at) AS month,
  COUNT(*)::integer AS calls,
  COALESCE(SUM(cost_usd), 0)::numeric(12, 5) AS total_cost_usd
FROM public.plant_lender_research
GROUP BY 1;

CREATE OR REPLACE FUNCTION public.trigger_plant_research(
  p_plant_id text,
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_recent uuid;
BEGIN
  SELECT role INTO v_role
  FROM public.profiles
  WHERE id = auth.uid();

  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;

  IF NOT p_force THEN
    SELECT id INTO v_recent
    FROM public.plant_lender_research
    WHERE plant_id = p_plant_id
      AND completed_at > now() - interval '7 days'
    ORDER BY completed_at DESC
    LIMIT 1;

    IF v_recent IS NOT NULL THEN
      RETURN jsonb_build_object(
        'skipped', true,
        'reason', 'recent_research_exists',
        'research_id', v_recent
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'skipped', false,
    'plant_id', p_plant_id,
    'force', p_force
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.trigger_plant_research(text, boolean) TO authenticated;
