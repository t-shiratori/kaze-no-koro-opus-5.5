// Island archetypes and their height functions. Pure functions shared by the main thread
// (steering / placement queries) and the mesh-building worker.

import { fbm2, hash2i, perlin2, ridged2, rng, saturate, smoothstep } from "../../core/noise";

export type IslandType =
  | "reef"
  | "whiteCliff"
  | "greenMountain"
  | "longIsland"
  | "archipelago"
  | "villageCove"
  | "lighthouse"
  | "tower"
  | "pine"
  | "sandy";

export interface IslandPart {
  x: number; // local offset from island center
  z: number;
  radius: number;
  elong: number;
  rot: number;
  peak: number;
  profile: number; // exponent of the mountain profile
  cliff: number; // coastal cliff height
  cliffWidth: number;
  plateau: number; // 0..1 how flat-topped
  shelfWidth: number;
  shelfDepth: number;
  lagoon: number; // extra shallow shelf (sandy islands)
  rough: number;
  seed: number;
  /** vegetation: 0 bare rock .. 1 lush */
  green: number;
  pines: number;
  /** optional bay carved out of the part */
  bay?: { x: number; z: number; r: number };
}

export interface IslandSpec {
  id: string;
  type: IslandType;
  x: number;
  z: number;
  /** radius that bounds all land (m) */
  extent: number;
  seed: number;
  parts: IslandPart[];
  village: boolean;
  lighthouse: boolean;
  tower: boolean;
}

export const CELL_SIZE = 3200;

const TYPE_TABLE: [IslandType, number][] = [
  ["reef", 1.2],
  ["whiteCliff", 1.0],
  ["greenMountain", 1.1],
  ["longIsland", 0.9],
  ["archipelago", 1.0],
  ["villageCove", 1.0],
  ["lighthouse", 0.9],
  ["tower", 0.7],
  ["pine", 1.0],
  ["sandy", 0.9],
];

function pickType(r: number): IslandType {
  const total = TYPE_TABLE.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [t, w] of TYPE_TABLE) {
    acc += w / total;
    if (r <= acc) return t;
  }
  return "pine";
}

function part(p: Partial<IslandPart> & { radius: number; seed: number }): IslandPart {
  return {
    x: 0,
    z: 0,
    elong: 1,
    rot: 0,
    peak: 40,
    profile: 1.2,
    cliff: 6,
    cliffWidth: 10,
    plateau: 0,
    shelfWidth: 90,
    shelfDepth: 35,
    lagoon: 0,
    rough: 0.35,
    green: 0.6,
    pines: 0.3,
    ...p,
  };
}

/** Deterministic island (or none) for a world cell. */
export function islandForCell(cx: number, cz: number): IslandSpec | null {
  const h = hash2i(cx, cz, 7);
  // regional density: some sea areas are open water, some are busy archipelagos
  const region = perlin2(cx * 0.23 + 3.1, cz * 0.23 - 1.7, 99) * 0.5 + 0.5;
  const density = 0.38 + region * 0.5;
  if (cx === 0 && cz === 0) return null; // keep the start clear
  if (h > density) return null;
  const r = rng(Math.floor(hash2i(cx, cz, 11) * 2 ** 31));
  const type = pickType(r());
  const margin = 1500;
  const x = cx * CELL_SIZE + CELL_SIZE / 2 + (r() - 0.5) * (CELL_SIZE - margin);
  const z = cz * CELL_SIZE + CELL_SIZE / 2 + (r() - 0.5) * (CELL_SIZE - margin);
  const seed = Math.floor(r() * 100000);
  const spec: IslandSpec = {
    id: `${cx},${cz}`,
    type,
    x,
    z,
    extent: 0,
    seed,
    parts: [],
    village: false,
    lighthouse: false,
    tower: false,
  };
  const rot = r() * Math.PI * 2;
  switch (type) {
    case "reef": {
      const n = 1 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        spec.parts.push(
          part({
            x: (r() - 0.5) * 160,
            z: (r() - 0.5) * 160,
            radius: 18 + r() * 45,
            elong: 1 + r() * 0.8,
            rot: r() * 6,
            peak: 3 + r() * 9,
            profile: 0.7,
            cliff: 2,
            cliffWidth: 4,
            shelfWidth: 70,
            shelfDepth: 18,
            rough: 0.7,
            green: 0,
            pines: 0,
            seed: seed + i,
          }),
        );
      }
      break;
    }
    case "whiteCliff": {
      spec.parts.push(
        part({
          radius: 260 + r() * 320,
          elong: 1 + r() * 0.9,
          rot,
          peak: 45 + r() * 80,
          profile: 0.5,
          cliff: 60 + r() * 80,
          cliffWidth: 7,
          plateau: 0.8,
          shelfWidth: 45,
          shelfDepth: 45,
          rough: 0.3,
          green: 0.55,
          pines: 0.1,
          seed,
        }),
      );
      spec.lighthouse = r() < 0.3;
      break;
    }
    case "greenMountain": {
      spec.parts.push(
        part({
          radius: 700 + r() * 650,
          elong: 1 + r() * 0.6,
          rot,
          peak: 330 + r() * 330,
          profile: 1.6,
          cliff: 8 + r() * 30,
          cliffWidth: 16,
          shelfWidth: 260 + r() * 160,
          shelfDepth: 50,
          rough: 0.45,
          green: 0.85,
          pines: 0.55,
          seed,
        }),
      );
      spec.village = r() < 0.55;
      spec.tower = r() < 0.25;
      break;
    }
    case "longIsland": {
      spec.parts.push(
        part({
          radius: 420 + r() * 420,
          elong: 3 + r() * 2.2,
          rot,
          peak: 70 + r() * 160,
          profile: 1.0,
          cliff: 8 + r() * 30,
          cliffWidth: 10,
          shelfWidth: 180,
          shelfDepth: 30,
          rough: 0.4,
          green: 0.7,
          pines: 0.6,
          seed,
        }),
      );
      spec.lighthouse = r() < 0.35;
      break;
    }
    case "archipelago": {
      const n = 4 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2;
        const d = 120 + r() * 700;
        const big = r();
        spec.parts.push(
          part({
            x: Math.cos(a) * d,
            z: Math.sin(a) * d,
            radius: 50 + big * big * 260,
            elong: 1 + r() * 1.5,
            rot: r() * 6,
            peak: 10 + big * 70,
            profile: 0.9 + r() * 0.5,
            cliff: 4 + r() * 16,
            cliffWidth: 8,
            shelfWidth: 160 + r() * 120,
            shelfDepth: 16,
            lagoon: r() < 0.5 ? 0.6 : 0,
            rough: 0.5,
            green: 0.35 + r() * 0.5,
            pines: r() * 0.7,
            seed: seed + i * 13,
          }),
        );
      }
      spec.lighthouse = r() < 0.3;
      break;
    }
    case "villageCove": {
      const R = 420 + r() * 380;
      const ba = r() * Math.PI * 2;
      spec.parts.push(
        part({
          radius: R,
          elong: 1 + r() * 0.5,
          rot,
          peak: 150 + r() * 170,
          profile: 1.3,
          cliff: 10 + r() * 15,
          cliffWidth: 14,
          shelfWidth: 200,
          shelfDepth: 35,
          rough: 0.4,
          green: 0.65,
          pines: 0.35,
          seed,
          bay: {
            x: Math.cos(ba) * R * 0.85,
            z: Math.sin(ba) * R * 0.85,
            r: R * (0.32 + r() * 0.12),
          },
        }),
      );
      spec.village = true;
      spec.lighthouse = r() < 0.4;
      break;
    }
    case "lighthouse": {
      spec.parts.push(
        part({
          radius: 55 + r() * 80,
          elong: 1 + r() * 0.6,
          rot,
          peak: 12 + r() * 16,
          profile: 0.6,
          cliff: 8,
          cliffWidth: 6,
          shelfWidth: 60,
          shelfDepth: 30,
          rough: 0.6,
          green: 0.15,
          pines: 0,
          seed,
        }),
      );
      spec.lighthouse = true;
      break;
    }
    case "tower": {
      spec.parts.push(
        part({
          radius: 150 + r() * 200,
          elong: 1 + r() * 0.7,
          rot,
          peak: 30 + r() * 45,
          profile: 1.0,
          cliff: 10 + r() * 12,
          cliffWidth: 8,
          shelfWidth: 80,
          shelfDepth: 30,
          rough: 0.45,
          green: 0.4,
          pines: 0.08,
          seed,
        }),
      );
      spec.tower = true;
      break;
    }
    case "pine": {
      spec.parts.push(
        part({
          radius: 200 + r() * 280,
          elong: 1 + r() * 0.9,
          rot,
          peak: 25 + r() * 40,
          profile: 0.8,
          cliff: 3 + r() * 6,
          cliffWidth: 8,
          shelfWidth: 170,
          shelfDepth: 25,
          rough: 0.35,
          green: 0.9,
          pines: 1,
          seed,
        }),
      );
      break;
    }
    case "sandy": {
      spec.parts.push(
        part({
          radius: 150 + r() * 260,
          elong: 1 + r() * 1.4,
          rot,
          peak: 4 + r() * 10,
          profile: 0.8,
          cliff: 0,
          cliffWidth: 10,
          shelfWidth: 320 + r() * 220,
          shelfDepth: 10,
          lagoon: 1,
          rough: 0.25,
          green: 0.45,
          pines: 0.35,
          seed,
        }),
      );
      break;
    }
  }
  let ext = 0;
  for (const p of spec.parts) ext = Math.max(ext, Math.hypot(p.x, p.z) + p.radius * p.elong);
  spec.extent = ext;
  return spec;
}

export interface TerrainSample {
  h: number;
  /** 0 = land/cliff rock, 1 = vegetation potential */
  veg: number;
  /** how cliff-like (0..1) */
  cliff: number;
  /** signed distance to coast (m), negative inland */
  sd: number;
}

function partHeight(p: IslandPart, lx: number, lz: number, out: TerrainSample): TerrainSample {
  let x = lx - p.x;
  let z = lz - p.z;
  const c = Math.cos(-p.rot);
  const s = Math.sin(-p.rot);
  const rx = x * c - z * s;
  const rz = x * s + z * c;
  x = rx;
  z = rz;
  const R = p.radius;
  // domain-warped normalized radius
  const wf = 1.6 / R;
  const warp =
    fbm2(x * wf, z * wf, 4, p.seed) * 0.32 + fbm2(x * wf * 3.1, z * wf * 3.1, 3, p.seed + 5) * 0.1;
  const rn = Math.hypot(x / (R * p.elong), z / R) + warp * p.rough * 1.4;
  let sd = (rn - 1) * R;
  if (p.bay) {
    const bx = lx - p.x - p.bay.x;
    const bz = lz - p.z - p.bay.z;
    const bd = Math.hypot(bx, bz) - p.bay.r + fbm2(bx * 0.01, bz * 0.01, 2, p.seed + 9) * 25;
    // carve: coast is where either outside island or inside bay
    sd = Math.max(sd, -bd);
  }
  const inland = saturate(-sd / (R * 0.9));
  let h: number;
  let cliffAmt = 0;
  if (sd <= 0) {
    // mountain body
    let body = Math.pow(inland, p.profile);
    if (p.plateau > 0) {
      const flat = smoothstep(0, 0.18, inland);
      body = body * (1 - p.plateau) + flat * p.plateau * (0.85 + 0.15 * inland);
    }
    const ridges = ridged2((x * 1.3) / R + 3, (z * 1.3) / R, 5, p.seed + 3);
    const bumps = fbm2((x * 4) / R, (z * 4) / R, 4, p.seed + 7);
    const rug = 1 - p.plateau * 0.8;
    let land =
      p.peak * body * (0.65 + ridges * 0.55 * rug + 0.2 * (1 - rug)) +
      p.peak * 0.08 * bumps * inland * rug;
    // coastal cliff: a quick rise right behind the shoreline, broken up by coves
    const coveNoise = fbm2((x * 2.2) / R + 11, (z * 2.2) / R, 3, p.seed + 21);
    const cliffH = p.cliff * smoothstep(-0.25, 0.2, coveNoise);
    const rise = smoothstep(0, p.cliffWidth, -sd);
    land += cliffH * rise;
    cliffAmt =
      cliffH > 4
        ? (1 - smoothstep(p.cliffWidth * 0.6, p.cliffWidth * 2, -sd)) * smoothstep(4, 20, cliffH)
        : 0;
    h = land + 0.4;
  } else {
    // underwater shelf
    const shelf = p.shelfDepth * (1 - Math.exp(-sd / p.shelfWidth));
    let depth = 0.4 + shelf;
    if (p.lagoon > 0) {
      const lag =
        1.2 +
        3.5 * smoothstep(0, p.shelfWidth * 0.9, sd) +
        fbm2(x * 0.01, z * 0.01, 3, p.seed + 31) * 1.5;
      const beyond = smoothstep(p.shelfWidth * 0.7, p.shelfWidth * 1.6, sd);
      depth =
        depth * (1 - p.lagoon) +
        p.lagoon *
          (lag * (1 - beyond) +
            (lag + 45 * (1 - Math.exp(-(sd - p.shelfWidth * 0.7) / 150))) * beyond);
    }
    // cliffs drop straight into deeper water
    if (p.cliff > 30) depth += (p.cliff - 30) * 0.4 * smoothstep(0, 25, sd) * (1 - p.lagoon);
    h = -depth;
  }
  out.h = h;
  out.sd = sd;
  out.cliff = cliffAmt;
  out.veg = p.green;
  return out;
}

const tmp: TerrainSample = { h: 0, veg: 0, cliff: 0, sd: 0 };

/** Height of the island terrain at local coordinates (combined parts, max). */
export function islandSample(
  spec: IslandSpec,
  lx: number,
  lz: number,
  out: TerrainSample,
): TerrainSample {
  out.h = -200;
  out.veg = 0;
  out.cliff = 0;
  out.sd = 1e9;
  for (const p of spec.parts) {
    const dx = lx - p.x;
    const dz = lz - p.z;
    const lim = p.radius * p.elong + p.shelfWidth * 4 + 200;
    if (dx * dx + dz * dz > lim * lim) continue;
    partHeight(p, lx, lz, tmp);
    if (tmp.h > out.h) {
      out.h = tmp.h;
      out.veg = tmp.veg;
      out.cliff = tmp.cliff;
    }
    out.sd = Math.min(out.sd, tmp.sd);
  }
  if (out.h < -200) out.h = -200;
  return out;
}

/** Which part a point most belongs to (for pines density etc.). */
export function partAt(spec: IslandSpec, lx: number, lz: number): IslandPart {
  let best = spec.parts[0];
  let bd = Infinity;
  for (const p of spec.parts) {
    const d = Math.hypot(lx - p.x, lz - p.z) / p.radius;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
