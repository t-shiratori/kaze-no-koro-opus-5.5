import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { patchWorldMaterial } from "../render/worldMaterial";
import { srgbColor } from "./props";

export type BoatKind = "sail" | "fishing" | "cargo" | "ferry";

/** Hull lofted from cross sections; +x is forward, y up. */
function hullGeometry(
  len: number,
  beam: number,
  depth: number,
  freeboard: number,
  bluntStern = 0.8,
): THREE.BufferGeometry {
  const secs = 14;
  const ring = 7;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= secs; i++) {
    const s = i / secs; // 0 stern .. 1 bow
    const x = (s - 0.5) * len;
    let w = beam / 2;
    if (s > 0.55) w *= Math.sqrt(Math.max(0, 1 - Math.pow((s - 0.55) / 0.45, 2)));
    if (s < 0.12) w *= bluntStern + (1 - bluntStern) * (s / 0.12);
    const sheer = freeboard + Math.pow(Math.max(s - 0.6, 0) / 0.4, 2) * freeboard * 0.6;
    const keel = -depth * (s > 0.85 ? 1 - ((s - 0.85) / 0.15) * 0.7 : 1);
    // cross section: deck edge -> bilge -> keel -> bilge -> deck edge
    const pts: [number, number][] = [
      [-w, sheer],
      [-w * 0.98, 0],
      [-w * 0.8, keel * 0.6],
      [0, keel],
      [w * 0.8, keel * 0.6],
      [w * 0.98, 0],
      [w, sheer],
    ];
    for (const [z, y] of pts) pos.push(x, y, z);
  }
  for (let i = 0; i < secs; i++) {
    for (let k = 0; k < ring - 1; k++) {
      const a = i * ring + k;
      const b = a + ring;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  // deck
  const deckStart = pos.length / 3;
  for (let i = 0; i <= secs; i++) {
    pos.push(pos[i * ring * 3], pos[i * ring * 3 + 1] - 0.05, pos[i * ring * 3 + 2]);
    pos.push(
      pos[(i * ring + ring - 1) * 3],
      pos[(i * ring + ring - 1) * 3 + 1] - 0.05,
      pos[(i * ring + ring - 1) * 3 + 2],
    );
  }
  for (let i = 0; i < secs; i++) {
    const a = deckStart + i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  // transom
  idx.push(0, ring - 1, 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  return ng;
}

function colorize(
  g: THREE.BufferGeometry,
  fn: (y: number, x: number, z: number) => THREE.Color,
): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const p = geo.attributes.position;
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const col = fn(p.getY(i), p.getX(i), p.getZ(i));
    c[i * 3] = col.r;
    c[i * 3 + 1] = col.g;
    c[i * 3 + 2] = col.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (geo.attributes.uv) geo.deleteAttribute("uv");
  return geo;
}

const solid = (hex: number) => {
  const c = srgbColor(hex);
  return () => c;
};

function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colorize(g, solid(hex));
}

let boatMat: THREE.MeshStandardMaterial | null = null;
let sailMat: THREE.MeshStandardMaterial | null = null;

function materials() {
  if (!boatMat) {
    boatMat = patchWorldMaterial(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.6,
        metalness: 0.05,
        side: THREE.DoubleSide,
      }),
      {},
    );
    sailMat = patchWorldMaterial(
      new THREE.MeshStandardMaterial({
        color: srgbColor(0xf5f1e6),
        roughness: 0.85,
        side: THREE.DoubleSide,
      }),
      {},
    );
  }
  return { boatMat: boatMat!, sailMat: sailMat! };
}

export interface BoatModel extends THREE.Group {
  userData: {
    kind: BoatKind;
    length: number;
    beam: number;
    /** local-space nav lights: x, y, z, r, g, b */
    lights: number[];
    sail?: THREE.Object3D;
    bob?: number;
  };
}

export function makeBoatMesh(kind: BoatKind, seed: number): BoatModel {
  const { boatMat, sailMat } = materials();
  const g = new THREE.Group() as BoatModel;
  const rand = (k: number) => {
    const x = Math.sin(seed * 91.7 + k * 17.3) * 43758.5453;
    return x - Math.floor(x);
  };
  const lights: number[] = [];
  let length = 10;
  let beam = 3;
  if (kind === "sail") {
    length = 9 + rand(1) * 5;
    beam = length * 0.32;
    const hullCol = rand(2) < 0.7 ? 0xf2efe8 : 0x1f3552;
    const hull = colorize(hullGeometry(length, beam, 1.1, 1.0, 0.7), (y) =>
      srgbColor(y < 0.15 ? 0x7a2a22 : y > 0.9 ? 0xc9b48f : hullCol),
    );
    const cabin = box(length * 0.3, 0.7, beam * 0.55, -length * 0.05, 1.3, 0, 0xe9e4d8);
    const mast = new THREE.CylinderGeometry(0.07, 0.09, length * 1.35, 5);
    mast.translate(length * 0.08, 1 + length * 0.675, 0);
    g.add(
      new THREE.Mesh(mergeGeometries([hull, cabin, colorize(mast, solid(0xd8d8d8))])!, boatMat),
    );
    // sails as a separate object that can be trimmed to the wind
    const sail = new THREE.Group();
    const main = new THREE.BufferGeometry();
    const mh = length * 1.25;
    main.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 1.4, 0, 0, 1.4 + mh, 0, -length * 0.45, 1.5, 0], 3),
    );
    main.computeVertexNormals();
    const jib = new THREE.BufferGeometry();
    jib.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [0.1, 1.3 + mh * 0.85, 0, length * 0.46, 1.3, 0, 0.1, 1.4, 0],
        3,
      ),
    );
    jib.computeVertexNormals();
    sail.add(new THREE.Mesh(main, sailMat), new THREE.Mesh(jib, sailMat));
    sail.position.x = length * 0.08;
    g.add(sail);
    g.userData.sail = sail;
    lights.push(0, 1.4 + mh, 0, 1, 1, 0.9);
  } else if (kind === "fishing") {
    length = 7 + rand(1) * 5;
    beam = length * 0.34;
    const cols = [0x2f5d8a, 0x3f7f6a, 0xb54a2f, 0xe8e2d4, 0x2e6fa8];
    const hc = cols[Math.floor(rand(3) * cols.length)];
    const hull = colorize(hullGeometry(length, beam, 0.9, 0.9, 0.85), (y) =>
      srgbColor(y < 0.1 ? 0x5a221c : y > 0.75 ? 0xf0ebe0 : hc),
    );
    const cabin = box(length * 0.22, 1.5, beam * 0.6, -length * 0.12, 1.6, 0, 0xf2eee6);
    const roof = box(length * 0.26, 0.12, beam * 0.7, -length * 0.12, 2.4, 0, 0x5b6770);
    const mast = new THREE.CylinderGeometry(0.06, 0.07, 3.5, 5);
    mast.translate(length * 0.2, 2.6, 0);
    g.add(
      new THREE.Mesh(
        mergeGeometries([hull, cabin, roof, colorize(mast, solid(0x3a3a3a))])!,
        boatMat,
      ),
    );
    lights.push(length * 0.2, 4.4, 0, 1, 1, 0.9);
    lights.push(-length * 0.12, 2.6, beam * 0.35, 0.1, 1, 0.2);
    lights.push(-length * 0.12, 2.6, -beam * 0.35, 1, 0.1, 0.1);
  } else if (kind === "cargo") {
    length = 85 + rand(1) * 40;
    beam = length * 0.15;
    const hc = rand(2) < 0.5 ? 0x7c2b24 : 0x273442;
    const hull = colorize(hullGeometry(length, beam, 6, 6, 0.95), (y) =>
      srgbColor(y < 0.5 ? 0x6d2420 : y > 5.4 ? 0x1f1f1f : hc),
    );
    const parts = [hull];
    // superstructure aft
    parts.push(box(length * 0.1, 9, beam * 0.8, -length * 0.38, 10, 0, 0xefeae0));
    parts.push(box(length * 0.12, 1.2, beam * 0.9, -length * 0.38, 15, 0, 0xe3ddd0));
    parts.push(box(3, 6, 3, -length * 0.42, 17, 0, 0x2d2d2d));
    // containers
    const ccols = [0xa6402e, 0x2f5f8a, 0x3f7a4f, 0xc9a24a, 0x8a8a8a, 0xb86b2a];
    for (let i = 0; i < 6; i++) {
      for (let k = -1; k <= 1; k++) {
        if (rand(10 + i * 3 + k) < 0.2) continue;
        const h = 2.6 * (1 + Math.floor(rand(30 + i + k) * 2));
        parts.push(
          box(
            length * 0.085,
            h,
            beam * 0.28,
            -length * 0.22 + i * length * 0.1,
            6 + h / 2,
            k * beam * 0.3,
            ccols[Math.floor(rand(50 + i * 5 + k) * ccols.length)],
          ),
        );
      }
    }
    g.add(new THREE.Mesh(mergeGeometries(parts)!, boatMat));
    lights.push(length * 0.45, 12, 0, 1, 1, 0.9);
    lights.push(-length * 0.4, 21, 0, 1, 1, 0.9);
    lights.push(-length * 0.36, 15, beam * 0.5, 0.1, 1, 0.2);
    lights.push(-length * 0.36, 15, -beam * 0.5, 1, 0.1, 0.1);
    for (let i = 0; i < 6; i++)
      lights.push(-length * 0.34, 8 + (i % 3) * 2.5, (i < 3 ? 1 : -1) * beam * 0.41, 1, 0.8, 0.5);
  } else {
    length = 60 + rand(1) * 30;
    beam = length * 0.18;
    const hull = colorize(hullGeometry(length, beam, 3.5, 4.5, 0.95), (y) =>
      srgbColor(y < 0.4 ? 0x2a3a5a : y > 2.6 && y < 3.4 ? 0x1f5fa8 : 0xf4f2ec),
    );
    const parts = [hull];
    parts.push(box(length * 0.62, 3.2, beam * 0.92, -length * 0.06, 6.1, 0, 0xf4f2ec));
    parts.push(box(length * 0.62, 0.9, beam * 0.93, -length * 0.06, 6.3, 0, 0x2a3440));
    parts.push(box(length * 0.4, 2.8, beam * 0.8, -length * 0.02, 9.1, 0, 0xf4f2ec));
    parts.push(box(length * 0.4, 0.8, beam * 0.81, -length * 0.02, 9.3, 0, 0x2a3440));
    parts.push(box(length * 0.08, 5, beam * 0.3, -length * 0.18, 13, 0, 0xf4f2ec));
    parts.push(box(length * 0.081, 1.2, beam * 0.31, -length * 0.18, 15, 0, 0x1f5fa8));
    g.add(new THREE.Mesh(mergeGeometries(parts)!, boatMat));
    lights.push(length * 0.1, 17, 0, 1, 1, 0.9);
    for (let i = 0; i < 14; i++) {
      const x = -length * 0.34 + (i % 7) * length * 0.09;
      lights.push(x, 6.3 + (i < 7 ? 0 : 3), (i % 2 ? 1 : -1) * beam * 0.47, 1, 0.82, 0.55);
    }
  }
  g.userData = { kind, length, beam, lights };
  return g;
}
