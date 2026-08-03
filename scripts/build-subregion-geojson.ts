/**
 * scripts/build-subregion-geojson.ts
 *
 * Generates `public/data/subregions.geojson` for the Regional Analysis map.
 *
 * Input:
 *   scripts/data/us-states.geojson  (downloaded on demand; committed after first run)
 *
 * Output:
 *   public/data/subregions.geojson  (FeatureCollection<MultiPolygon>)
 *
 * Approach:
 *   • Multi-state ISOs (PJM, MISO, SPP, ISO-NE) → each sub-region is a
 *     MultiPolygon UNION of member-state polygons (no clipping needed —
 *     internal borders are hidden by the fill styling on the map).
 *   • Single-state ISOs (CAISO, ERCOT, NYISO) → the state polygon is clipped
 *     into sub-region pieces along the axis-aligned cutlines in
 *     `constants/subregionGeometry.ts`. Uses a small inline
 *     Sutherland–Hodgman clipper (no runtime dependencies added).
 *
 * Run:
 *   npx tsx scripts/build-subregion-geojson.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CAISO_CUTLINES,
  ERCOT_CUTLINES,
  NYISO_CUTLINES,
  STATE_TO_SUBREGION_BY_REGION,
} from '../constants/subregionGeometry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN_PATH = path.resolve(__dirname, 'data', 'us-states.geojson');
const OUT_PATH = path.resolve(__dirname, '..', 'public', 'data', 'subregions.geojson');
const US_STATES_URL =
  'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json';

// ─── GeoJSON types (minimal) ────────────────────────────────────────────────
type Ring = [number, number][];
type Polygon = Ring[]; // [outerRing, ...holes]
interface Feature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry:
    | { type: 'Polygon'; coordinates: Polygon }
    | { type: 'MultiPolygon'; coordinates: Polygon[] };
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

// ─── Fetch us-states.geojson (cache to disk) ────────────────────────────────
async function ensureStatesFile(): Promise<void> {
  if (fs.existsSync(IN_PATH)) return;
  console.log(`Downloading US states GeoJSON from:\n  ${US_STATES_URL}`);
  fs.mkdirSync(path.dirname(IN_PATH), { recursive: true });
  const res = await fetch(US_STATES_URL);
  if (!res.ok) throw new Error(`Failed to fetch us-states.geojson: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(IN_PATH, buf);
  console.log(`  Saved to ${IN_PATH} (${(buf.length / 1024).toFixed(1)} KB)`);
}

// ─── Sutherland–Hodgman clip against axis-aligned half-planes ───────────────
type HalfPlane =
  | { axis: 'x'; op: '<' | '>'; value: number } // lng bound
  | { axis: 'y'; op: '<' | '>'; value: number }; // lat bound

function insideHP(pt: [number, number], hp: HalfPlane): boolean {
  const v = hp.axis === 'x' ? pt[0] : pt[1];
  return hp.op === '<' ? v < hp.value : v > hp.value;
}

function intersectHP(a: [number, number], b: [number, number], hp: HalfPlane): [number, number] {
  const [ax, ay] = a;
  const [bx, by] = b;
  if (hp.axis === 'x') {
    const t = (hp.value - ax) / (bx - ax);
    return [hp.value, ay + t * (by - ay)];
  }
  const t = (hp.value - ay) / (by - ay);
  return [ax + t * (bx - ax), hp.value];
}

function clipRing(ring: Ring, hp: HalfPlane): Ring {
  if (ring.length === 0) return [];
  const out: Ring = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const cur = ring[i];
    const nxt = ring[(i + 1) % n];
    const curIn = insideHP(cur, hp);
    const nxtIn = insideHP(nxt, hp);
    if (curIn) {
      out.push(cur);
      if (!nxtIn) out.push(intersectHP(cur, nxt, hp));
    } else if (nxtIn) {
      out.push(intersectHP(cur, nxt, hp));
    }
  }
  return out;
}

function clipPolygon(poly: Polygon, halfPlanes: HalfPlane[]): Polygon | null {
  // Only clip the outer ring; holes rarely matter for coarse ISO shading and
  // this is a build-time approximation, not authoritative geography.
  let ring = poly[0];
  for (const hp of halfPlanes) {
    ring = clipRing(ring, hp);
    if (ring.length < 3) return null;
  }
  return [ring];
}

function clipMultiPolygon(mp: Polygon[], halfPlanes: HalfPlane[]): Polygon[] {
  const out: Polygon[] = [];
  for (const p of mp) {
    const c = clipPolygon(p, halfPlanes);
    if (c) out.push(c);
  }
  return out;
}

// Normalize any geometry to MultiPolygon coordinates.
function toMultiPolygonCoords(geom: Feature['geometry']): Polygon[] {
  if (geom.type === 'Polygon') return [geom.coordinates];
  return geom.coordinates;
}

// ─── State index ────────────────────────────────────────────────────────────
const STATE_NAME_TO_ABBR: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI',
  Wyoming: 'WY',
};

function indexStates(fc: FeatureCollection): Map<string, Feature> {
  const idx = new Map<string, Feature>();
  for (const f of fc.features) {
    const nameField = (f.properties?.name ?? f.properties?.NAME ?? f.properties?.STATE_NAME) as string | undefined;
    if (!nameField) continue;
    const abbr = STATE_NAME_TO_ABBR[nameField];
    if (!abbr) continue;
    idx.set(abbr, f);
  }
  return idx;
}

// ─── Sub-region feature builders ────────────────────────────────────────────
interface SubregionFeatureSpec {
  region: string;
  subRegion: string;
  states: string[];
  clip?: HalfPlane[]; // applied to the (single) state polygon after concat
}

// Multi-state ISO plans: each sub-region is the union of member-state polygons.
function multiStateSpecs(): SubregionFeatureSpec[] {
  const specs: SubregionFeatureSpec[] = [];
  for (const region of ['PJM', 'MISO', 'SPP', 'ISO-NE']) {
    const stateMap = STATE_TO_SUBREGION_BY_REGION[region] ?? {};
    const bySub: Record<string, string[]> = {};
    for (const [state, sub] of Object.entries(stateMap)) {
      (bySub[sub] ??= []).push(state);
    }
    for (const [sub, states] of Object.entries(bySub)) {
      specs.push({ region, subRegion: sub, states });
    }
  }
  return specs;
}

// Single-state ISO plans: state polygon clipped by axis-aligned cutlines.
function singleStateSpecs(): SubregionFeatureSpec[] {
  const specs: SubregionFeatureSpec[] = [];

  // CAISO (CA)
  specs.push({
    region: 'CAISO', subRegion: 'NP15', states: ['CA'],
    clip: [{ axis: 'y', op: '>', value: CAISO_CUTLINES.npZpBoundary }],
  });
  specs.push({
    region: 'CAISO', subRegion: 'ZP26', states: ['CA'],
    clip: [
      { axis: 'y', op: '<', value: CAISO_CUTLINES.npZpBoundary },
      { axis: 'y', op: '>', value: CAISO_CUTLINES.zpSpBoundary },
    ],
  });
  specs.push({
    region: 'CAISO', subRegion: 'SP15', states: ['CA'],
    clip: [{ axis: 'y', op: '<', value: CAISO_CUTLINES.zpSpBoundary }],
  });

  // ERCOT (TX) — 4 zones
  specs.push({
    region: 'ERCOT', subRegion: 'West', states: ['TX'],
    clip: [{ axis: 'x', op: '<', value: ERCOT_CUTLINES.westLng }],
  });
  specs.push({
    region: 'ERCOT', subRegion: 'North', states: ['TX'],
    clip: [
      { axis: 'x', op: '>', value: ERCOT_CUTLINES.westLng },
      { axis: 'y', op: '>', value: ERCOT_CUTLINES.northLat },
    ],
  });
  specs.push({
    region: 'ERCOT', subRegion: 'Houston', states: ['TX'],
    clip: [
      { axis: 'x', op: '>', value: ERCOT_CUTLINES.westLng },
      { axis: 'y', op: '<', value: ERCOT_CUTLINES.coastLat },
    ],
  });
  specs.push({
    region: 'ERCOT', subRegion: 'South', states: ['TX'],
    clip: [
      { axis: 'x', op: '>', value: ERCOT_CUTLINES.westLng },
      { axis: 'y', op: '<', value: ERCOT_CUTLINES.northLat },
      { axis: 'y', op: '>', value: ERCOT_CUTLINES.coastLat },
    ],
  });

  // NYISO (NY)
  specs.push({
    region: 'NYISO', subRegion: 'West/Upstate', states: ['NY'],
    clip: [{ axis: 'y', op: '>', value: NYISO_CUTLINES.upstateLat }],
  });
  specs.push({
    region: 'NYISO', subRegion: 'Capital-Hudson', states: ['NY'],
    clip: [
      { axis: 'y', op: '<', value: NYISO_CUTLINES.upstateLat },
      { axis: 'y', op: '>', value: NYISO_CUTLINES.hudsonLat },
    ],
  });
  specs.push({
    region: 'NYISO', subRegion: 'NYC/LI', states: ['NY'],
    clip: [{ axis: 'y', op: '<', value: NYISO_CUTLINES.hudsonLat }],
  });

  return specs;
}

function buildFeatureFromSpec(spec: SubregionFeatureSpec, stateIdx: Map<string, Feature>): Feature | null {
  const polys: Polygon[] = [];
  for (const abbr of spec.states) {
    const f = stateIdx.get(abbr);
    if (!f) {
      console.warn(`  ⚠ state ${abbr} not found in us-states.geojson`);
      continue;
    }
    let coords = toMultiPolygonCoords(f.geometry);
    if (spec.clip && spec.clip.length > 0) {
      coords = clipMultiPolygon(coords, spec.clip);
    }
    polys.push(...coords);
  }
  if (polys.length === 0) return null;
  return {
    type: 'Feature',
    properties: { region: spec.region, subRegion: spec.subRegion },
    geometry: { type: 'MultiPolygon', coordinates: polys },
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  await ensureStatesFile();
  console.log(`Reading ${IN_PATH}`);
  const raw = JSON.parse(fs.readFileSync(IN_PATH, 'utf-8')) as FeatureCollection;
  const stateIdx = indexStates(raw);
  console.log(`  indexed ${stateIdx.size} states`);

  const specs = [...multiStateSpecs(), ...singleStateSpecs()];
  const features: Feature[] = [];
  for (const spec of specs) {
    const f = buildFeatureFromSpec(spec, stateIdx);
    if (f) features.push(f);
    else console.warn(`  ⚠ empty feature: ${spec.region} / ${spec.subRegion}`);
  }

  const out: FeatureCollection = { type: 'FeatureCollection', features };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  const size = fs.statSync(OUT_PATH).size;
  console.log(`\n✓ Wrote ${features.length} sub-region features to`);
  console.log(`  ${OUT_PATH}  (${(size / 1024).toFixed(1)} KB)`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
