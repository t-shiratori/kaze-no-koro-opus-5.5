// Builds island meshes and scatters props. Runs inside a worker.

import { fbm2, rng, saturate, smoothstep } from "../../core/noise";
import { islandSample, partAt, type IslandSpec, type TerrainSample } from "./terrain";

export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export interface IslandBuild {
  id: string;
  hi: MeshArrays;
  lo: MeshArrays;
  /** x, y, z, scale, rotation, kind (0 umbrella pine, 1 cypress, 2 olive/shrub) */
  trees: Float32Array;
  /** x, y, z, rot, width, depth, height, roof (0 flat, 1 tiles, 2 bell tower) */
  houses: Float32Array;
  /** x, y, z, kind (0 window, 1 harbour lamp) */
  lights: Float32Array;
  lighthouse: number[] | null;
  tower: number[] | null;
  /** x, y, z, rot, length */
  pier: number[] | null;
  /** moored boats: x, z, rot */
  moorings: number[];
  /** gull colony spots near cliffs: x, y, z */
  cliffs: number[];
}

const srgb = (r: number, g: number, b: number): [number, number, number] => [
  Math.pow(r, 2.2),
  Math.pow(g, 2.2),
  Math.pow(b, 2.2),
];

const C = {
  limestone: srgb(0.84, 0.79, 0.68),
  ochre: srgb(0.7, 0.6, 0.47),
  darkRock: srgb(0.46, 0.44, 0.41),
  sand: srgb(0.93, 0.86, 0.7),
  wetSand: srgb(0.7, 0.63, 0.5),
  dryGrass: srgb(0.76, 0.67, 0.43),
  garrigue: srgb(0.56, 0.57, 0.38),
  maquis: srgb(0.3, 0.4, 0.19),
  forest: srgb(0.15, 0.27, 0.12),
  seabed: srgb(0.82, 0.76, 0.6),
};

function mix3(a: number[], b: number[], t: number, out: number[]) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

function halfSize(spec: IslandSpec): number {
  let e = 0;
  for (const p of spec.parts) {
    e = Math.max(e, Math.hypot(p.x, p.z) + p.radius * p.elong + Math.min(p.shelfWidth * 2.6, 900));
  }
  return e + 40;
}

function buildGrid(spec: IslandSpec, E: number, n: number, withColor: boolean): MeshArrays {
  const s: TerrainSample = { h: 0, veg: 0, cliff: 0, sd: 0 };
  const N = n + 1;
  const hs = new Float32Array(N * N);
  const veg = new Float32Array(N * N);
  const cliff = new Float32Array(N * N);
  const step = (2 * E) / n;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -E + i * step;
      const z = -E + j * step;
      islandSample(spec, x, z, s);
      // fade the border of the tile into deep water so no seams show in the shallows
      const edge = Math.max(Math.abs(x), Math.abs(z)) / E;
      const f = smoothstep(0.86, 1.0, edge);
      hs[j * N + i] = s.h * (1 - f) + -60 * f;
      veg[j * N + i] = s.veg;
      cliff[j * N + i] = s.cliff;
    }
  }
  const positions = new Float32Array(N * N * 3);
  const normals = new Float32Array(N * N * 3);
  const colors = new Float32Array(N * N * 3);
  const col = [0, 0, 0];
  const tmp = [0, 0, 0];
  const r = rng(spec.seed);
  const tint = 0.94 + r() * 0.1;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const x = -E + i * step;
      const z = -E + j * step;
      const h = hs[k];
      positions[k * 3] = x;
      positions[k * 3 + 1] = h;
      positions[k * 3 + 2] = z;
      const hl = hs[j * N + Math.max(i - 1, 0)];
      const hr = hs[j * N + Math.min(i + 1, n)];
      const hd = hs[Math.max(j - 1, 0) * N + i];
      const hu = hs[Math.min(j + 1, n) * N + i];
      let nx = hl - hr;
      let ny = 2 * step;
      let nz = hd - hu;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      normals[k * 3] = nx;
      normals[k * 3 + 1] = ny;
      normals[k * 3 + 2] = nz;
      if (!withColor) {
        colors[k * 3] = colors[k * 3 + 1] = colors[k * 3 + 2] = 0.5;
        continue;
      }
      // ---- material painting ----
      const n1 = fbm2(x * 0.004, z * 0.004, 3, spec.seed + 1) * 0.5 + 0.5;
      const n2 = fbm2(x * 0.03, z * 0.03, 3, spec.seed + 2) * 0.5 + 0.5;
      const part = partAt(spec, x, z);
      const rockBase =
        part.green < 0.05
          ? C.darkRock
          : mix3(C.limestone, C.ochre, smoothstep(0.35, 0.75, n1) * 0.7, tmp);
      const rock = [rockBase[0], rockBase[1], rockBase[2]];
      // subtle strata on cliffs
      const strata = 0.9 + 0.1 * Math.sin(h * 0.9 + n2 * 3);
      rock[0] *= strata;
      rock[1] *= strata;
      rock[2] *= strata;
      const steep = 1 - smoothstep(0.55, 0.8, ny);
      const n3 = fbm2(x * 0.011, z * 0.011, 3, spec.seed + 3) * 0.5 + 0.5;
      // higher ground is drier and rockier
      const alt = smoothstep(220, 600, h);
      const vegPot =
        veg[k] *
        smoothstep(1.2, 5 + n2 * 4, h) *
        (1 - steep) *
        (1 - cliff[k] * 0.9) *
        (1 - alt * 0.45);
      const lush = saturate(
        vegPot * (0.05 + n1 * 0.75 + n3 * 0.55) - smoothstep(0.55, 0.8, n3) * 0.25,
      );
      // vegetation mosaic: golden grass -> grey garrigue -> dark maquis -> pine forest
      mix3(C.dryGrass, C.garrigue, smoothstep(0.15, 0.35, lush), col);
      mix3(col, C.maquis, smoothstep(0.38, 0.62, lush), col);
      const forest = smoothstep(0.6, 0.8, lush * (0.55 + part.pines * 0.7) + (n3 - 0.5) * 0.3);
      mix3(col, C.forest, forest, col);
      // exposed rock where vegetation is thin
      const outcrop = smoothstep(0.66, 0.8, n2 * 0.6 + n3 * 0.4 + alt * 0.15) * 0.75;
      const rockAmt = saturate(
        Math.max(steep, cliff[k], outcrop, 1 - smoothstep(0.02, 0.25, vegPot + 0.05 * n2)),
      );
      mix3(col, rock, rockAmt, col);
      // beaches
      const beach =
        (1 - smoothstep(1.2 + n2 * 1.6, 3.2 + n2 * 2, h)) * (1 - steep) * (1 - cliff[k]);
      mix3(col, C.sand, saturate(beach * 1.2), col);
      if (h < 0.9) mix3(col, C.wetSand, smoothstep(0.9, -0.2, h) * 0.8, col);
      if (h < -0.2) mix3(col, C.seabed, smoothstep(-0.2, -3, h), col);
      // cavity darkening
      const lap = (hl + hr + hd + hu) * 0.25 - h;
      const ao = saturate(1 - Math.max(lap, 0) * 0.04);
      const v = (0.9 + n2 * 0.2) * ao * tint;
      colors[k * 3] = col[0] * v;
      colors[k * 3 + 1] = col[1] * v;
      colors[k * 3 + 2] = col[2] * v;
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let o = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      // alternate diagonal following the terrain for nicer silhouettes
      if (Math.abs(hs[a] - hs[d]) < Math.abs(hs[b] - hs[c])) {
        indices.set([a, c, d, a, d, b], o);
      } else {
        indices.set([a, c, b, b, c, d], o);
      }
      o += 6;
    }
  }
  return { positions, normals, colors, indices };
}

function slopeAt(spec: IslandSpec, x: number, z: number, s: TerrainSample): number {
  const e = 3;
  const hx = islandSample(spec, x + e, z, s).h - islandSample(spec, x - e, z, s).h;
  const hz = islandSample(spec, x, z + e, s).h - islandSample(spec, x, z - e, s).h;
  return Math.hypot(hx, hz) / (2 * e);
}

function downhill(spec: IslandSpec, x: number, z: number, s: TerrainSample): number {
  const e = 6;
  const hx = islandSample(spec, x + e, z, s).h - islandSample(spec, x - e, z, s).h;
  const hz = islandSample(spec, x, z + e, s).h - islandSample(spec, x, z - e, s).h;
  return Math.atan2(-hz, -hx);
}

export function buildIsland(spec: IslandSpec): IslandBuild {
  const E = halfSize(spec);
  const nHi = Math.max(48, Math.min(300, Math.round((2 * E) / Math.max(2.5, (2 * E) / 300))));
  const nLo = Math.max(16, Math.round(nHi / 4));
  const hi = buildGrid(spec, E, nHi, true);
  const lo = buildGrid(spec, E, nLo, true);

  const r = rng(spec.seed * 7 + 3);
  const s: TerrainSample = { h: 0, veg: 0, cliff: 0, sd: 0 };
  const trees: number[] = [];
  const houses: number[] = [];
  const lights: number[] = [];
  const moorings: number[] = [];
  const cliffs: number[] = [];

  // ---- trees ----
  let landArea = 0;
  for (const p of spec.parts) landArea += Math.PI * p.radius * p.radius * p.elong;
  const spacing = Math.max(6, Math.sqrt(landArea / 22000));
  const maxTrees = 22000;
  for (let z = -E; z < E && trees.length / 6 < maxTrees; z += spacing) {
    for (let x = -E; x < E; x += spacing) {
      const jx = x + (r() - 0.5) * spacing;
      const jz = z + (r() - 0.5) * spacing;
      islandSample(spec, jx, jz, s);
      if (s.h < 1.5 || s.cliff > 0.3) continue;
      const part = partAt(spec, jx, jz);
      const slope = slopeAt(spec, jx, jz, s);
      islandSample(spec, jx, jz, s);
      if (slope > 0.75) continue;
      const cluster = fbm2(jx * 0.0045, jz * 0.0045, 4, spec.seed + 40) * 0.5 + 0.5;
      // forests with clearings: dense inside clusters, a scattered few elsewhere
      const forestMask = smoothstep(0.44, 0.56, cluster);
      const dens =
        part.pines *
        s.veg *
        (forestMask * 0.95 + 0.03) *
        (1 - smoothstep(0.45, 0.8, slope)) *
        (1 - smoothstep(150, 400, s.h) * 0.8);
      const olive =
        s.veg * 0.12 * (1 - forestMask) * smoothstep(4, 40, s.h) * (1 - smoothstep(200, 350, s.h));
      const roll = r();
      if (roll < dens) {
        const cypress = r() < 0.08 ? 1 : 0;
        const sc = cypress ? 1.1 + r() * 0.6 : 1.2 + r() * 0.9;
        trees.push(jx, s.h - 0.4, jz, sc, r() * Math.PI * 2, cypress);
      } else if (roll < dens + olive) {
        trees.push(jx, s.h - 0.3, jz, 0.9 + r() * 0.7, r() * Math.PI * 2, 2);
      }
    }
  }

  // ---- cliffs where gulls like to circle ----
  for (let i = 0; i < 40 && cliffs.length < 9; i++) {
    const p = spec.parts[Math.floor(r() * spec.parts.length)];
    const a = r() * Math.PI * 2;
    const x = p.x + Math.cos(a) * p.radius * 0.95;
    const z = p.z + Math.sin(a) * p.radius * 0.95;
    islandSample(spec, x, z, s);
    if (s.cliff > 0.2 || (s.h > 15 && p.cliff > 15)) cliffs.push(x, Math.max(s.h, 10) + 20, z);
  }

  // ---- landmarks ----
  const highest = (cands: number, rad: number, cx = 0, cz = 0) => {
    let best = [0, -1e9, 0];
    for (let i = 0; i < cands; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * rad;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      islandSample(spec, x, z, s);
      if (s.h > best[1] && slopeAt(spec, x, z, s) < 0.45)
        best = [x, islandSample(spec, x, z, s).h, z];
    }
    return best;
  };

  let lighthouse: number[] | null = null;
  if (spec.lighthouse) {
    // on a headland: high point close to the coast
    let best: number[] | null = null;
    let bestScore = -1e9;
    for (let i = 0; i < 200; i++) {
      const p = spec.parts[Math.floor(r() * spec.parts.length)];
      const a = r() * Math.PI * 2;
      const d = p.radius * (0.55 + r() * 0.45);
      const x = p.x + Math.cos(a) * d * p.elong;
      const z = p.z + Math.sin(a) * d;
      islandSample(spec, x, z, s);
      if (s.h < 3) continue;
      const sd = s.sd;
      const score = s.h * 0.2 - Math.abs(sd + 25) * 0.3;
      if (score > bestScore && slopeAt(spec, x, z, s) < 0.5) {
        bestScore = score;
        best = [x, islandSample(spec, x, z, s).h, z];
      }
    }
    if (spec.type === "lighthouse")
      best = highest(120, spec.parts[0].radius * 0.6, spec.parts[0].x, spec.parts[0].z);
    lighthouse = best;
    if (lighthouse) lights.push(lighthouse[0], lighthouse[1] + 2, lighthouse[2], 1);
  }

  let tower: number[] | null = null;
  if (spec.tower) {
    const p = spec.parts[0];
    tower = highest(160, p.radius * 0.7, p.x, p.z);
  }

  // ---- village ----
  let pier: number[] | null = null;
  if (spec.village) {
    const p = spec.parts[0];
    let vx = 0;
    let vz = 0;
    if (p.bay) {
      vx = p.x + p.bay.x;
      vz = p.z + p.bay.z;
    } else {
      // gentlest stretch of coast
      let best = 1e9;
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        let d = p.radius;
        // walk inward until on land
        for (let k = 0; k < 30; k++) {
          const x = p.x + Math.cos(a) * d * p.elong;
          const z = p.z + Math.sin(a) * d;
          if (islandSample(spec, x, z, s).h > 1.5) break;
          d -= p.radius * 0.03;
        }
        const x = p.x + Math.cos(a) * d * p.elong;
        const z = p.z + Math.sin(a) * d;
        const sl = slopeAt(spec, x, z, s) + (islandSample(spec, x, z, s).cliff > 0.1 ? 2 : 0);
        if (sl < best) {
          best = sl;
          vx = x;
          vz = z;
        }
      }
    }
    // houses cling to the slope around the harbour
    const count = 16 + Math.floor(r() * 30);
    let placed = 0;
    let shoreX = vx;
    let shoreZ = vz;
    let shoreBest = 1e9;
    for (let tries = 0; tries < count * 30 && placed < count; tries++) {
      const a = r() * Math.PI * 2;
      const d = 30 + Math.pow(r(), 0.8) * (p.bay ? p.bay.r * 1.1 : 260);
      const x = vx + Math.cos(a) * d;
      const z = vz + Math.sin(a) * d;
      islandSample(spec, x, z, s);
      if (s.h < 2.2 || s.h > 75) continue;
      const sl = slopeAt(spec, x, z, s);
      if (sl > 0.9) continue;
      // keep houses apart
      let ok = true;
      for (let q = 0; q < houses.length; q += 8) {
        if (Math.hypot(houses[q] - x, houses[q + 2] - z) < 11) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      islandSample(spec, x, z, s);
      const rot = downhill(spec, x, z, s) + (r() - 0.5) * 0.4;
      const h0 = islandSample(spec, x, z, s).h;
      const w = 6 + r() * 5;
      const dd = 5 + r() * 4;
      const hh = 4.5 + Math.floor(r() * 2) * 3;
      const roof = placed === 3 ? 2 : r() < 0.55 ? 1 : 0;
      houses.push(x, h0, z, rot, w, dd, roof === 2 ? 16 : hh, roof);
      if (r() < 0.55) lights.push(x, h0 + 2.2, z, 0);
      placed++;
      if (h0 < shoreBest) {
        shoreBest = h0;
        shoreX = x;
        shoreZ = z;
      }
    }
    // pier: from lowest house towards the water
    const pa = downhill(spec, shoreX, shoreZ, s);
    let px = shoreX;
    let pz = shoreZ;
    for (let k = 0; k < 80; k++) {
      if (islandSample(spec, px, pz, s).h < 0.2) break;
      px += Math.cos(pa) * 3;
      pz += Math.sin(pa) * 3;
    }
    const len = 26 + r() * 30;
    pier = [px - Math.cos(pa) * 6, 1.1, pz - Math.sin(pa) * 6, pa, len];
    lights.push(px + Math.cos(pa) * len, 3.5, pz + Math.sin(pa) * len, 1);
    for (let m = 0; m < 2 + Math.floor(r() * 4); m++) {
      const along = 8 + r() * (len - 10);
      const side = r() < 0.5 ? -1 : 1;
      const mx = px + Math.cos(pa) * along + Math.cos(pa + Math.PI / 2) * side * 7;
      const mz = pz + Math.sin(pa) * along + Math.sin(pa + Math.PI / 2) * side * 7;
      if (islandSample(spec, mx, mz, s).h < -1.2) moorings.push(mx, mz, pa + (r() - 0.5) * 0.5);
    }
  }
  // a few lonely farmhouses on larger green islands
  if (spec.type === "greenMountain" || spec.type === "longIsland" || spec.type === "villageCove") {
    const n = 1 + Math.floor(r() * 5);
    for (let i = 0; i < n * 20; i++) {
      const p = spec.parts[0];
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * p.radius * 0.8;
      const x = p.x + Math.cos(a) * d * p.elong;
      const z = p.z + Math.sin(a) * d;
      islandSample(spec, x, z, s);
      if (s.h < 8 || slopeAt(spec, x, z, s) > 0.35) continue;
      const h0 = islandSample(spec, x, z, s).h;
      houses.push(x, h0, z, r() * Math.PI * 2, 7 + r() * 4, 5 + r() * 3, 4.5, r() < 0.7 ? 1 : 0);
      if (r() < 0.6) lights.push(x, h0 + 2.2, z, 0);
      if (houses.length / 8 > 80) break;
      if (r() < 1 / n) break;
    }
  }

  return {
    id: spec.id,
    hi,
    lo,
    trees: new Float32Array(trees),
    houses: new Float32Array(houses),
    lights: new Float32Array(lights),
    lighthouse,
    tower,
    pier,
    moorings,
    cliffs,
  };
}
