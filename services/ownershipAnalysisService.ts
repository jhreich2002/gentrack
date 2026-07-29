/**
 * GenTrack — ownershipAnalysisService
 *
 * Powers the "Owner Analysis" tab. Loads the full `plant_ownership` table
 * joined with the operational stats we need from `plants`, then aggregates
 * client-side by a user-selected role (owner / ult_parent / plant_operator
 * / operator_ult_parent). Aggregation is pure so switching the role toggle
 * never re-hits the network.
 */

import { supabase } from './supabaseClient';

export type OwnershipRole =
  | 'owner'
  | 'ult_parent'
  | 'plant_operator'
  | 'operator_ult_parent';

export const OWNERSHIP_ROLE_LABEL: Record<OwnershipRole, string> = {
  owner:               'Owner',
  ult_parent:          'Ultimate Parent',
  plant_operator:      'Operator',
  operator_ult_parent: 'Operator Ult Parent',
};

export interface OwnershipAsset {
  eiaPlantCode:      string;
  plantName:         string;
  state:             string | null;
  region:            string | null;
  techType:          string | null;
  nameplateMw:       number;
  ttmAvgFactor:      number;
  ownershipPct:      number | null;
  owner:             string | null;
  ultParent:         string | null;
  plantOperator:     string | null;
  operatorUltParent: string | null;
}

export interface OwnershipEntitySummary {
  name:           string;
  assetCount:     number;
  totalMW:        number;
  topTech:        string | null;
  topState:       string | null;
  techBreakdown:  Record<string, number>;
  stateBreakdown: Record<string, number>;
}

// ── Fetch the full ownership + plant join in pages ──────────────────────────
// `plant_ownership` can exceed Supabase's default 1000-row cap, so we page
// explicitly and merge with the `plants` metadata we need for the asset table.

const PAGE_SIZE = 1000;

export async function fetchOwnershipAssets(): Promise<OwnershipAsset[]> {
  // 1. Page through plant_ownership
  const ownershipRows: Array<Record<string, any>> = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('plant_ownership')
      .select(
        'eia_site_code, power_plant, tech_type, oper_own, owner, ult_parent, plant_operator, operator_ult_parent'
      )
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error('fetchOwnershipAssets ownership error:', error.message);
      return [];
    }
    if (!data || data.length === 0) break;
    ownershipRows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }

  if (ownershipRows.length === 0) return [];

  // 2. Fetch matching plants metadata in chunks (`.in()` has a URL length cap)
  const codes = Array.from(
    new Set(ownershipRows.map(r => r.eia_site_code).filter(Boolean))
  );

  const CHUNK = 500;
  const plantMap = new Map<string, Record<string, any>>();
  for (let i = 0; i < codes.length; i += CHUNK) {
    const slice = codes.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('plants')
      .select('eia_plant_code, name, state, region, nameplate_capacity_mw, ttm_avg_factor')
      .in('eia_plant_code', slice);

    if (error) {
      console.error('fetchOwnershipAssets plants error:', error.message);
      continue;
    }
    for (const p of data ?? []) plantMap.set(p.eia_plant_code, p);
  }

  // 3. Merge
  return ownershipRows.map(o => {
    const p = plantMap.get(o.eia_site_code) ?? {};
    return {
      eiaPlantCode:      o.eia_site_code,
      plantName:         (p.name as string) ?? o.power_plant ?? o.eia_site_code,
      state:             (p.state as string) ?? null,
      region:            (p.region as string) ?? null,
      techType:          (o.tech_type as string) ?? null,
      nameplateMw:       Number(p.nameplate_capacity_mw) || 0,
      ttmAvgFactor:      Number(p.ttm_avg_factor) || 0,
      ownershipPct:      o.oper_own != null ? Number(o.oper_own) : null,
      owner:             o.owner ?? null,
      ultParent:         o.ult_parent ?? null,
      plantOperator:     o.plant_operator ?? null,
      operatorUltParent: o.operator_ult_parent ?? null,
    } as OwnershipAsset;
  });
}

// ── Client-side aggregation ─────────────────────────────────────────────────

/**
 * Group the raw asset rows by the selected ownership role.
 * Rows where the role field is null/empty are excluded from the entity list.
 * Returned entities are sorted by total MW (desc).
 */
export function aggregateByRole(
  assets: OwnershipAsset[],
  role: OwnershipRole
): OwnershipEntitySummary[] {
  const key: Record<OwnershipRole, keyof OwnershipAsset> = {
    owner:               'owner',
    ult_parent:          'ultParent',
    plant_operator:      'plantOperator',
    operator_ult_parent: 'operatorUltParent',
  };
  const field = key[role];

  const groups = new Map<string, OwnershipEntitySummary>();
  for (const a of assets) {
    const raw = a[field];
    if (!raw || typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name) continue;

    let g = groups.get(name);
    if (!g) {
      g = {
        name,
        assetCount:     0,
        totalMW:        0,
        topTech:        null,
        topState:       null,
        techBreakdown:  {},
        stateBreakdown: {},
      };
      groups.set(name, g);
    }
    g.assetCount += 1;
    g.totalMW += a.nameplateMw || 0;

    if (a.techType) {
      g.techBreakdown[a.techType] = (g.techBreakdown[a.techType] || 0) + 1;
    }
    if (a.state) {
      g.stateBreakdown[a.state] = (g.stateBreakdown[a.state] || 0) + 1;
    }
  }

  // Resolve topTech / topState
  for (const g of groups.values()) {
    const techEntries = Object.entries(g.techBreakdown).sort((a, b) => b[1] - a[1]);
    const stateEntries = Object.entries(g.stateBreakdown).sort((a, b) => b[1] - a[1]);
    g.topTech  = techEntries[0]?.[0] ?? null;
    g.topState = stateEntries[0]?.[0] ?? null;
  }

  return [...groups.values()].sort((a, b) => b.totalMW - a.totalMW);
}

/**
 * Filter the raw asset rows to those whose role field matches the given
 * entity name exactly. Used to render the asset list on the right side.
 */
export function assetsForEntity(
  assets: OwnershipAsset[],
  role: OwnershipRole,
  entityName: string
): OwnershipAsset[] {
  const key: Record<OwnershipRole, keyof OwnershipAsset> = {
    owner:               'owner',
    ult_parent:          'ultParent',
    plant_operator:      'plantOperator',
    operator_ult_parent: 'operatorUltParent',
  };
  const field = key[role];
  return assets.filter(a => a[field] === entityName);
}
