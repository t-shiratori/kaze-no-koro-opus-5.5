import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { patchWorldMaterial } from "../render/worldMaterial";

// Procedural low-poly props. Colours are baked as vertex colours (linear).

export function srgbColor(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

function paint(
  geo: THREE.BufferGeometry,
  color: THREE.Color,
  jitter = 0,
  seed = 1,
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    const v = 1 + (s / 2147483647 - 0.5) * jitter;
    c[i * 3] = color.r * v;
    c[i * 3 + 1] = color.g * v;
    c[i * 3 + 2] = color.b * v;
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  if (g.attributes.uv) g.deleteAttribute("uv");
  return g;
}

function blob(
  r: number,
  sx: number,
  sy: number,
  sz: number,
  detail: number,
  seed: number,
): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const n =
      1 +
      0.18 * Math.sin(x * 3.1 + seed) * Math.sin(y * 2.7 + seed * 2) * Math.sin(z * 2.3 + seed * 3);
    p.setXYZ(i, x * sx * n, y * sy * n, z * sz * n);
  }
  g.computeVertexNormals();
  return g;
}

// ---------------- trees ----------------

export function umbrellaPineGeometry(): THREE.BufferGeometry {
  const bark = srgbColor(0x5a4636);
  const needle = srgbColor(0x3d5a2c);
  const needleDark = srgbColor(0x2c4621);
  const trunk = new THREE.CylinderGeometry(0.18, 0.3, 7, 6, 3);
  trunk.translate(0, 3.5, 0);
  // gentle lean & curve
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    tp.setX(i, tp.getX(i) + Math.pow(y / 7, 2) * 0.9);
  }
  trunk.computeVertexNormals();
  const crown = blob(1, 4.4, 1.25, 4.0, 1, 1.3);
  crown.translate(0.9, 7.6, 0);
  const crown2 = blob(1, 2.6, 0.9, 2.4, 1, 2.1);
  crown2.translate(-0.6, 7.0, 1.4);
  const crown3 = blob(1, 2.2, 0.8, 2.3, 0, 4.7);
  crown3.translate(2.4, 7.2, -1.2);
  return mergeGeometries([
    paint(trunk, bark, 0.15, 3),
    paint(crown, needle, 0.25, 5),
    paint(crown2, needleDark, 0.2, 7),
    paint(crown3, needle, 0.2, 9),
  ])!;
}

export function cypressGeometry(): THREE.BufferGeometry {
  const green = srgbColor(0x2a3f22);
  const body = blob(1, 1.05, 5.2, 1.05, 1, 3.3);
  body.translate(0, 5.0, 0);
  const trunk = new THREE.CylinderGeometry(0.12, 0.18, 1.2, 5);
  trunk.translate(0, 0.6, 0);
  return mergeGeometries([paint(trunk, srgbColor(0x4d3c2e), 0.1, 2), paint(body, green, 0.25, 4)])!;
}

export function oliveGeometry(): THREE.BufferGeometry {
  const leaf = srgbColor(0x76825a);
  const trunk = new THREE.CylinderGeometry(0.2, 0.32, 1.6, 5);
  trunk.translate(0, 0.8, 0);
  const crown = blob(1, 2.1, 1.5, 2.0, 1, 6.1);
  crown.translate(0, 2.6, 0);
  return mergeGeometries([paint(trunk, srgbColor(0x5d5040), 0.1, 2), paint(crown, leaf, 0.3, 8)])!;
}

export function makeTreeMaterial(): THREE.MeshStandardMaterial {
  return patchWorldMaterial(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      flatShading: false,
    }),
    { sway: 0.11 },
  );
}

// ---------------- buildings ----------------

export function houseWallGeometry(): THREE.BufferGeometry {
  // unit box whose bottom goes 3 m below the anchor to sit on slopes
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

export function tileRoofGeometry(): THREE.BufferGeometry {
  // hip roof over a unit footprint
  const g = new THREE.ConeGeometry(0.75, 0.42, 4, 1);
  g.rotateY(Math.PI / 4);
  g.scale(1.02, 1, 1.02);
  g.translate(0, 0.21, 0);
  return g;
}

export function lighthouseGroup(): { group: THREE.Group; lamp: THREE.Object3D } {
  const group = new THREE.Group();
  const white = srgbColor(0xf1ede2);
  const red = srgbColor(0xa8372c);
  const dark = srgbColor(0x2d3134);
  const tower = new THREE.CylinderGeometry(1.5, 2.3, 17, 14, 4);
  tower.translate(0, 8.5, 0);
  const band = new THREE.CylinderGeometry(1.72, 1.8, 2.2, 14);
  band.translate(0, 11.5, 0);
  const gallery = new THREE.CylinderGeometry(2.4, 2.4, 0.35, 16);
  gallery.translate(0, 17.2, 0);
  const lantern = new THREE.CylinderGeometry(1.25, 1.25, 2.2, 10, 1, true);
  lantern.translate(0, 18.5, 0);
  const cap = new THREE.ConeGeometry(1.55, 1.5, 12);
  cap.translate(0, 20.3, 0);
  const house = new THREE.BoxGeometry(6, 4, 5);
  house.translate(5.5, 2, 0);
  const roof = new THREE.ConeGeometry(4.3, 1.8, 4);
  roof.rotateY(Math.PI / 4);
  roof.scale(1.05, 1, 0.85);
  roof.translate(5.5, 4.9, 0);
  const base = new THREE.CylinderGeometry(3.2, 3.6, 3, 12);
  base.translate(0, -1.2, 0);
  const geo = mergeGeometries([
    paint(tower, white, 0.04),
    paint(band, red, 0.05),
    paint(gallery, dark, 0.05),
    paint(cap, red, 0.05),
    paint(house, white, 0.05),
    paint(roof, srgbColor(0xb4583c), 0.08),
    paint(base, srgbColor(0xbdb4a0), 0.1),
  ])!;
  const mat = patchWorldMaterial(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }),
    { breakup: 0.06 },
  );
  group.add(new THREE.Mesh(geo, mat));
  const glass = new THREE.Mesh(
    lantern,
    new THREE.MeshStandardMaterial({
      color: 0x223038,
      roughness: 0.15,
      metalness: 0.4,
      emissive: new THREE.Color(1, 0.8, 0.5),
      emissiveIntensity: 0,
    }),
  );
  glass.name = "lantern";
  group.add(glass);
  const lamp = new THREE.Object3D();
  lamp.position.set(0, 18.5, 0);
  group.add(lamp);
  return { group, lamp };
}

export function towerGeometry(seed: number): THREE.BufferGeometry {
  const stone = srgbColor(0xb8a584);
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.CylinderGeometry(4.2, 5.0, 17, 16, 5);
  body.translate(0, 8.5, 0);
  // weathered surface
  const p = body.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + 0.03 * Math.sin(y * 2.1 + x) * Math.cos(z * 1.7 + seed);
    p.setXYZ(i, x * k, y, z * k);
  }
  body.computeVertexNormals();
  parts.push(paint(body, stone, 0.12, seed));
  const n = 12;
  for (let i = 0; i < n; i++) {
    if ((seed + i * 7) % 5 === 0) continue; // ruined, missing merlons
    const a = (i / n) * Math.PI * 2;
    const m = new THREE.BoxGeometry(1.6, 1.4 + ((seed + i) % 3) * 0.3, 1.0);
    m.rotateY(-a);
    m.translate(Math.cos(a) * 4.0, 17.7, Math.sin(a) * 4.0);
    parts.push(paint(m, stone, 0.15, seed + i));
  }
  const base = new THREE.CylinderGeometry(5.4, 6.2, 3, 16);
  base.translate(0, -1, 0);
  parts.push(paint(base, srgbColor(0xa39276), 0.15, seed + 3));
  return mergeGeometries(parts)!;
}

export function pierGeometry(length: number): THREE.BufferGeometry {
  const stone = srgbColor(0xc9bea6);
  const deck = new THREE.BoxGeometry(length, 1.6, 4.2);
  deck.translate(length / 2, 0, 0);
  const parts = [paint(deck, stone, 0.1)];
  const bollard = new THREE.CylinderGeometry(0.25, 0.3, 0.7, 6);
  for (let i = 4; i < length; i += 7) {
    const b = bollard.clone();
    b.translate(i, 1.1, 1.7);
    parts.push(paint(b, srgbColor(0x3a3a3a), 0.1));
  }
  const lampPost = new THREE.CylinderGeometry(0.08, 0.1, 3.2, 5);
  lampPost.translate(length - 1, 2.4, 0);
  parts.push(paint(lampPost, srgbColor(0x2a2a2a), 0));
  return mergeGeometries(parts)!;
}
