-- v5.5 follow-up: deduplicate lenders_canonical entries before lender research dashboard reflects current-gen filter.
-- Each row in lender_merge_pairs maps a loser lender_id to its canonical winner.
-- Logic per pair:
--   1. Insert winner-side alias rows for the loser's canonical_name (ON CONFLICT DO NOTHING)
--   2. Repoint lender_aliases.canonical_id from loser -> winner
--   3. Dedupe plant_lender_links: if (plant_id, winner) already exists, drop the loser-side row;
--      otherwise repoint plant_lender_links.lender_id from loser -> winner
--   4. Delete loser from lenders_canonical (CASCADE will clean any leftover refs)
-- Idempotent: re-running after losers are gone is a no-op.

BEGIN;

CREATE TEMP TABLE lender_merge_pairs (winner_id uuid, loser_id uuid) ON COMMIT DROP;

INSERT INTO lender_merge_pairs (winner_id, loser_id) VALUES
  -- 1. Banco Santander (incl. Santander Investment Securities subsidiary per user approval)
  ('57e00486-4b82-4bd2-ae46-f6ea0a25d98d', 'e5b30fd4-6738-484b-a1d3-542c90b9f0cf'),
  ('57e00486-4b82-4bd2-ae46-f6ea0a25d98d', '57ff7080-ada7-49e4-96ea-649e7ac84db4'),
  ('57e00486-4b82-4bd2-ae46-f6ea0a25d98d', '8671f023-789c-4f61-b5c3-b37b4552b68a'),
  -- 2. Crédit Agricole Corporate and Investment Bank
  ('537e6466-ad47-4178-a1cd-b181aea0be19', '0eea7035-8ca7-4884-91a2-f650d0d81779'),
  -- 3. KeyBank (incl. KeyBanc Capital Markets per user approval)
  ('99c2ba50-de2c-4c85-bf18-1ee9df79f1fb', 'd06ce03c-2ed6-4a6b-b130-9fd5ec588049'),
  ('99c2ba50-de2c-4c85-bf18-1ee9df79f1fb', 'e56ad48c-019d-432a-a978-9a50aaf80853'),
  -- 4. Mizuho Financial Group
  ('bd70a1ac-b286-4379-84ad-c71dce707712', '8a6677e2-0cc9-4fb7-8a62-269cbf55c476'),
  -- 5. Bayerische Landesbank (winner row will be renamed below)
  ('27831121-3351-4655-a87a-3c9d08499aed', '0fe30f80-c530-4dcb-a098-f1a99864479d'),
  -- 6. CoBank
  ('be5e400b-331a-4c73-9cf9-b539f2eabdba', '553196e0-6d80-4441-bbd1-037054fc8ecd'),
  ('be5e400b-331a-4c73-9cf9-b539f2eabdba', 'cb29734c-15dd-4d17-9fba-3f721a05c59b'),
  -- 7. Banco Bilbao Vizcaya Argentaria
  ('7ff2ef70-5860-457b-8c38-e69eab542e69', '7cb48c2f-b41d-486a-bec6-a6d0c2ee70cc'),
  ('7ff2ef70-5860-457b-8c38-e69eab542e69', '73d8380f-ba80-4a1c-9ce7-0c651c60609d'),
  ('7ff2ef70-5860-457b-8c38-e69eab542e69', 'd2d9c291-0854-4d62-96ae-642444f8f062'),
  -- 8. MUFG
  ('c35ef205-4576-4b6f-9d35-5a483ff90cb1', '449b6391-c148-44de-a30f-59acef5b68e8'),
  ('c35ef205-4576-4b6f-9d35-5a483ff90cb1', 'e6dc78b9-ba85-43af-a7c5-6dc64b94b64b'),
  ('c35ef205-4576-4b6f-9d35-5a483ff90cb1', 'eb45fb8a-12ca-4a1e-83ad-5da63bfb0107'),
  ('c35ef205-4576-4b6f-9d35-5a483ff90cb1', '02846faa-d249-4f4f-88ac-b638c35b736e'),
  -- 9. CIBC
  ('9cfdd905-3992-4a9d-8990-0f0d2580485b', '497df3ec-8a94-4a72-b476-1c8f6c578696'),
  ('9cfdd905-3992-4a9d-8990-0f0d2580485b', '2cab0b5f-85f2-4484-b1f2-c83dfb7c1c08'),
  -- 10. Citigroup (consolidates Citi, Citibank)
  ('b54940cc-9cdb-41d8-8bd3-169977a442bd', 'd1789a67-4cb0-428d-8fcb-65e27d870c8b'),
  ('b54940cc-9cdb-41d8-8bd3-169977a442bd', 'c2e22c60-07b1-47c5-a4bd-d8cb71cf6bd1'),
  -- 11. Helaba
  ('1a4e47db-fc45-4d9a-92fe-9b800a854aa7', '9a328213-b7ae-41f0-91bb-a44f3616f877'),
  ('1a4e47db-fc45-4d9a-92fe-9b800a854aa7', '9d45dc53-b1db-46c9-9ed3-1ac9c53b9db0'),
  -- 12. Nord/LB
  ('32c94dd5-5f25-4032-8ab4-2bb8135a8996', '00509c6e-330f-48a4-8838-12bdb0ee6ae4'),
  ('32c94dd5-5f25-4032-8ab4-2bb8135a8996', '291ee67d-40a1-4cb3-a7e2-c50fe4e4ca2d'),
  ('32c94dd5-5f25-4032-8ab4-2bb8135a8996', 'd8c58cfc-166a-4a75-99b5-9a1dc4f51ef4'),
  ('32c94dd5-5f25-4032-8ab4-2bb8135a8996', 'b984e6fa-dd31-4aba-a0be-fa0050eaa6fd'),
  -- 13. Banco Espirito Santo, S.A.
  ('1acd1e7f-f3ed-4a4c-b985-d189d54c74ec', 'd0e42d91-5933-474a-9aa3-0d3396083427'),
  -- 14. CaixaBank, S.A.
  ('c9d42daf-aed3-4564-a0be-95799ee42ad8', '41d40ba4-15fb-4ab9-a64c-1e49bfa66613'),
  -- 15. North American Development Bank
  ('d1f39db0-da3c-49a5-8de7-de69b0266e4d', '4db4ac09-cc1e-4f3d-b862-9bc24c36abc2'),
  -- 16. Zions Bancorporation NA
  ('ec87430e-1f1e-4c31-a467-75f1eedad1a2', 'e0ac246b-bf79-4231-bea8-6c1ac676b200'),
  -- 17. JPMorgan Chase (incl. J.P. Morgan Securities LLC per user approval)
  ('9a683fbc-fa17-4a2d-bce5-63eff3337137', '9a41cfe5-4b53-488f-ba6e-1bd7189471b8'),
  -- 18. Societe Generale (incl. SG Americas Securities, LLC per user approval)
  ('bd4e58d1-664c-4ef9-812f-e00416368269', 'e58f7a2f-5d7b-4612-a2ef-9596004f99f8'),
  -- 19. Bank of America (incl. Banc of America Securities LLC per user approval)
  ('08e18420-9889-48b0-b22b-6d8b7436c7be', 'cd184285-0da2-4ad8-9456-761307561fad'),
  -- 20. The Royal Bank of Scotland plc (incl. RBS Securities Inc. per user approval)
  ('664dc3f7-44b7-4043-a60e-f9f3ad8fd240', '1b385dfc-b620-477d-a6ce-ca0aa8dd0c8c');

-- Step 1: preserve loser names as aliases on the winner so future lookups still match.
INSERT INTO public.lender_aliases (alias, normalized_alias, canonical_id)
SELECT lc.canonical_name,
       lc.normalized_name,
       m.winner_id
FROM lender_merge_pairs m
JOIN public.lenders_canonical lc ON lc.id = m.loser_id
ON CONFLICT (alias) DO NOTHING;

-- Step 2a: drop loser-side aliases that would collide on (winner, normalized_alias).
DELETE FROM public.lender_aliases la
USING lender_merge_pairs m
WHERE la.canonical_id = m.loser_id
  AND EXISTS (
    SELECT 1 FROM public.lender_aliases la2
    WHERE la2.canonical_id = m.winner_id
      AND la2.normalized_alias = la.normalized_alias
  );

-- Step 2b: among multiple losers mapping to the same winner, keep only one alias per normalized_alias.
WITH ranked AS (
  SELECT la.alias,
         ROW_NUMBER() OVER (
           PARTITION BY m.winner_id, la.normalized_alias
           ORDER BY la.created_at ASC
         ) AS rn
  FROM public.lender_aliases la
  JOIN lender_merge_pairs m ON m.loser_id = la.canonical_id
)
DELETE FROM public.lender_aliases la
USING ranked r
WHERE la.alias = r.alias AND r.rn > 1;

-- Step 2c: repoint surviving loser-side aliases to the winner.
UPDATE public.lender_aliases la
SET canonical_id = m.winner_id
FROM lender_merge_pairs m
WHERE la.canonical_id = m.loser_id;

-- Step 3a: drop loser-side links where the winner already has a link for the same plant.
DELETE FROM public.plant_lender_links pll
USING lender_merge_pairs m
WHERE pll.lender_id = m.loser_id
  AND EXISTS (
    SELECT 1 FROM public.plant_lender_links pll2
    WHERE pll2.plant_id = pll.plant_id
      AND pll2.lender_id = m.winner_id
  );

-- Step 3b: among multiple losers mapping to the same winner for the same plant, keep only one link.
-- Preference: validated > pending > rejected, then oldest created_at.
WITH ranked AS (
  SELECT pll.id,
         ROW_NUMBER() OVER (
           PARTITION BY pll.plant_id, m.winner_id
           ORDER BY (pll.validated_at IS NOT NULL) DESC,
                    (pll.rejected_at IS NULL) DESC,
                    pll.created_at ASC
         ) AS rn
  FROM public.plant_lender_links pll
  JOIN lender_merge_pairs m ON m.loser_id = pll.lender_id
)
DELETE FROM public.plant_lender_links pll
USING ranked r
WHERE pll.id = r.id AND r.rn > 1;

-- Step 3c: repoint surviving loser-side links to the winner.
UPDATE public.plant_lender_links pll
SET lender_id = m.winner_id
FROM lender_merge_pairs m
WHERE pll.lender_id = m.loser_id;

-- Step 4: optional rename for #5 — replace branch-specific name with parent entity name.
UPDATE public.lenders_canonical
SET canonical_name = 'Bayerische Landesbank',
    normalized_name = public.normalize_lender_name('Bayerische Landesbank')
WHERE id = '27831121-3351-4655-a87a-3c9d08499aed';

-- Step 5: drop the now-orphaned canonical rows.
DELETE FROM public.lenders_canonical lc
USING lender_merge_pairs m
WHERE lc.id = m.loser_id;

COMMIT;
