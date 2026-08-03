/**
 * GenTrack — shared sub-region geometry constants
 *
 * Dependency-free module (no React, no imports from types.ts) so it can be
 * consumed by:
 *   • scripts/fetch-eia-data.ts       (assigning sub-regions at ingest time)
 *   • scripts/fix-subregions.ts        (audit/backfill of existing rows)
 *   • scripts/build-subregion-geojson.ts (clipping US-state polygons)
 *   • components/RegionalAnalysisDashboard.tsx (client-side sanity checks)
 *
 * ⚠ If you change a cutline or state mapping here, re-run
 * `npm run build:geojson` and re-run the sub-region audit so the map polygons
 * and the DB stay in sync.
 */

// ---------------------------------------------------------------------------
// Cutlines used to split single-state ISOs into coarse sub-regions.
// All cutlines are axis-aligned so they compose cleanly with @turf/bbox-clip.
// ---------------------------------------------------------------------------

/** CAISO (California) — lat cutlines. */
export const CAISO_CUTLINES = {
  /** Above this latitude → NP15 (northern California). */
  npZpBoundary: 36.0,
  /** Between npZpBoundary and this latitude → ZP26; below → SP15. */
  zpSpBoundary: 34.5,
} as const;

/** ERCOT (Texas) — lng + lat cutlines. */
export const ERCOT_CUTLINES = {
  /** Longitude cutoff west of which the plant is in West Texas / West zone. */
  westLng: -100,
  /** Latitude above which (in the eastern half) the plant is in the North zone. */
  northLat: 32.5,
  /** Latitude below which (in the eastern half) the plant is in the Coast zone. */
  coastLat: 29.5,
} as const;

/** NYISO (New York) — lat cutlines. */
export const NYISO_CUTLINES = {
  /** Above → Upstate. */
  upstateLat: 42.5,
  /** Between → Hudson Valley; below → NYC/Long Island. */
  hudsonLat: 41.0,
} as const;

// ---------------------------------------------------------------------------
// Sub-region label sets (kept in sync with constants.ts SUBREGIONS).
// This module is the source of truth for the ingestion pipeline; the
// TypeScript-enum-flavored SUBREGIONS in ../constants.ts references these.
// ---------------------------------------------------------------------------

export const SUBREGION_LABELS: Record<string, string[]> = {
  CAISO: ['NP15', 'SP15', 'ZP26'],
  ERCOT: ['West', 'North', 'South', 'Houston'],
  PJM: ['Mid-Atlantic', 'Western', 'Dominion'],
  MISO: ['North', 'East', 'Central', 'South'],
  NYISO: ['West/Upstate', 'Capital-Hudson', 'NYC/LI'],
  'ISO-NE': ['Northern NE', 'Southern NE', 'Massachusetts'],
  SPP: ['North', 'Central', 'South'],
  Northwest: ['WA/OR Coast', 'Inland PNW', 'Mountain'],
  Southwest: ['Arizona/Nevada', 'New Mexico', 'Colorado'],
  Southeast: ['Florida', 'Carolinas', 'Deep South'],
  Hawaii: ['Oahu', 'Maui', 'Big Island'],
  Alaska: ['Railbelt', 'Remote'],
};

// ---------------------------------------------------------------------------
// Per-ISO state → sub-region mapping.
//
// This is REGION-SCOPED (unlike the legacy flat STATE_TO_SUBREGION) so that a
// state that appears in multiple ISOs (via balancing-authority data upstream)
// resolves to a valid sub-region for whichever ISO the plant belongs to.
//
// Coverage rules:
//   • Multi-state ISOs list every member state.
//   • Single-state ISOs (CAISO, ERCOT, NYISO) rely on the cutlines above and
//     leave the state map empty — resolveSubRegion() short-circuits before it.
// ---------------------------------------------------------------------------

export const STATE_TO_SUBREGION_BY_REGION: Record<string, Record<string, string>> = {
  CAISO: {}, // uses CAISO_CUTLINES
  ERCOT: {}, // uses ERCOT_CUTLINES
  NYISO: {}, // uses NYISO_CUTLINES

  PJM: {
    PA: 'Mid-Atlantic', NJ: 'Mid-Atlantic', MD: 'Mid-Atlantic', DE: 'Mid-Atlantic', DC: 'Mid-Atlantic',
    OH: 'Western', WV: 'Western',
    VA: 'Dominion',
  },
  MISO: {
    MN: 'North', ND: 'North', SD: 'North',
    WI: 'East', MI: 'East',
    IL: 'Central', IN: 'Central', IA: 'Central',
    MO: 'South',
  },
  SPP: {
    // Defensive coverage in case upstream ever labels these states SPP.
    KS: 'North', NE: 'North', MT: 'North', ND: 'North', SD: 'North',
    OK: 'Central',
    AR: 'South', TX: 'South', NM: 'South', LA: 'South',
  },
  'ISO-NE': {
    ME: 'Northern NE', NH: 'Northern NE', VT: 'Northern NE',
    CT: 'Southern NE', RI: 'Southern NE',
    MA: 'Massachusetts',
  },

  // Non-ISO regions (kept for completeness; Regional Analysis excludes them).
  Northwest: {
    WA: 'WA/OR Coast', OR: 'WA/OR Coast',
    ID: 'Inland PNW',
    MT: 'Mountain', WY: 'Mountain',
  },
  Southwest: {
    AZ: 'Arizona/Nevada', NV: 'Arizona/Nevada',
    NM: 'New Mexico',
    CO: 'Colorado', UT: 'Colorado',
  },
  Southeast: {
    FL: 'Florida',
    SC: 'Carolinas', NC: 'Carolinas',
    GA: 'Deep South', AL: 'Deep South', MS: 'Deep South',
    TN: 'Deep South', KY: 'Deep South', LA: 'Deep South',
  },
  Hawaii: { HI: 'Oahu' },
  Alaska: { AK: 'Railbelt' },
};

// ---------------------------------------------------------------------------
// Resolver — the single canonical function for sub-region assignment.
// ---------------------------------------------------------------------------

/**
 * Resolve a sub-region label for a plant given its state, region, and coords.
 *
 * Order of resolution:
 *   1. Region-specific cutlines (CAISO / ERCOT / NYISO) when coords are known.
 *   2. Region-scoped state → sub-region lookup.
 *   3. First label in SUBREGION_LABELS[region] as a last-resort fallback.
 *   4. 'Unknown' when the region itself is unknown.
 */
export function resolveSubRegion(
  state: string,
  region: string,
  lat?: number,
  lng?: number,
): string {
  // 1. Coordinate-based rules for single-state ISOs.
  if (region === 'CAISO' && lat != null) {
    if (lat > CAISO_CUTLINES.npZpBoundary) return 'NP15';
    if (lat > CAISO_CUTLINES.zpSpBoundary) return 'ZP26';
    return 'SP15';
  }
  if (region === 'ERCOT' && lat != null && lng != null) {
    if (lng < ERCOT_CUTLINES.westLng) return 'West';
    if (lat > ERCOT_CUTLINES.northLat) return 'North';
    if (lat < ERCOT_CUTLINES.coastLat) return 'Houston';
    return 'South';
  }
  if (region === 'NYISO' && lat != null) {
    if (lat > NYISO_CUTLINES.upstateLat) return 'West/Upstate';
    if (lat > NYISO_CUTLINES.hudsonLat) return 'Capital-Hudson';
    return 'NYC/LI';
  }

  // 2. Region-scoped state lookup.
  const stateMap = STATE_TO_SUBREGION_BY_REGION[region];
  const fromState = stateMap ? stateMap[state] : undefined;
  if (fromState) return fromState;

  // 3. First label for the region (defensive).
  const labels = SUBREGION_LABELS[region];
  if (labels && labels.length > 0) return labels[0];

  // 4. Unknown region.
  return 'Unknown';
}

/**
 * Cheap validation: is `(region, subRegion)` a legal pair per SUBREGION_LABELS?
 * Used by the audit/backfill script.
 */
export function isValidSubRegionPair(region: string, subRegion: string): boolean {
  const labels = SUBREGION_LABELS[region];
  return !!labels && labels.includes(subRegion);
}
