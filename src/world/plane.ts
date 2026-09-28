import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { patchWorldMaterial } from "../render/worldMaterial";
import { srgbColor } from "./props";

// A small, well-used 1930s flying boat. Local frame: +z forward, +y up, wings along x.

interface Section {
  z: number;
  w: number; // half width
  top: number;
  bot: number; // keel
  chine: number; // chine height
}

function loftHull(sections: Section[], ringRes = 14): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const ring = ringRes;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    for (let k = 0; k <= ring; k++) {
      const a = (k / ring) * Math.PI * 2; // 0 = top, going to the right
      const sx = Math.sin(a);
      const cy = Math.cos(a);
      let x: number;
      let y: number;
      if (cy >= 0) {
        // rounded deck: super-ellipse
        x = Math.sign(sx) * Math.pow(Math.abs(sx), 0.7) * s.w;
        y = s.chine + Math.pow(cy, 0.8) * (s.top - s.chine);
      } else {
        // V bottom from chine to keel
        const t = -cy;
        x = Math.sign(sx) * s.w * (1 - Math.pow(t, 1.6));
        y = s.chine + (s.bot - s.chine) * Math.pow(t, 1.2);
      }
      pos.push(x, y, s.z);
      uv.push(k / ring, i / (sections.length - 1));
    }
  }
  const stride = ring + 1;
  for (let i = 0; i < sections.length - 1; i++) {
    for (let k = 0; k < ring; k++) {
      const a = i * stride + k;
      const b = a + stride;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // caps
  const capAt = (i: number, flip: boolean) => {
    const c = pos.length / 3;
    const s = sections[i];
    pos.push(0, (s.top + s.bot) / 2, s.z);
    uv.push(0.5, i / (sections.length - 1));
    for (let k = 0; k < ring; k++) {
      const a = i * stride + k;
      if (flip) idx.push(c, a + 1, a);
      else idx.push(c, a, a + 1);
    }
  };
  capAt(0, true);
  capAt(sections.length - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Wing/tail surface along x with a simple symmetric airfoil and rounded tips. */
function wingGeometry(
  span: number,
  chord: number,
  thick: number,
  opts: { dihedral?: number; sweep?: number; tipRound?: number } = {},
): THREE.BufferGeometry {
  const ns = 36;
  const nc = 12;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const dih = opts.dihedral ?? 0;
  const tipRound = opts.tipRound ?? 0.12;
  const half = span / 2;
  for (let i = 0; i <= ns; i++) {
    const u = i / ns;
    const x = (u - 0.5) * span;
    const ax = Math.abs(x) / half;
    // elliptic rounding at the tips
    const tip =
      ax > 1 - tipRound
        ? Math.sqrt(Math.max(0, 1 - Math.pow((ax - (1 - tipRound)) / tipRound, 2)))
        : 1;
    const c = chord * Math.max(tip, 0.04);
    const le = chord * 0.35 - (chord - c) * 0.25 - (opts.sweep ?? 0) * Math.abs(x);
    const yOff = Math.abs(x) * Math.tan(dih);
    for (let j = 0; j <= nc * 2; j++) {
      // around the airfoil: upper surface LE->TE, lower TE->LE
      const upper = j <= nc;
      const t = upper ? j / nc : 2 - j / nc; // 0 LE .. 1 TE
      const yt =
        5 *
        thick *
        (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4);
      const camber = 0.03 * c * Math.sin(Math.PI * t);
      const y = yOff + camber + (upper ? yt : -yt * 0.6) * c * tip;
      const z = le - t * c;
      pos.push(x, y, z);
      uv.push(u, upper ? t * 0.5 : 0.5 + t * 0.5);
    }
  }
  const stride = nc * 2 + 1;
  for (let i = 0; i < ns; i++) {
    for (let j = 0; j < nc * 2; j++) {
      const a = i * stride + j;
      const b = a + stride;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function strut(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 6);
  // streamlined: flatten
  g.scale(1, 1, 2.2);
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

function canvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  draw(ctx);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function speckle(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  n: number,
  alpha: number,
  dark = true,
) {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = 2 + Math.random() * 18;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const c = dark ? "40,30,20" : "255,250,240";
    g.addColorStop(0, `rgba(${c},${alpha * Math.random()})`);
    g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

export interface PlaneModel {
  group: THREE.Group;
  prop: THREE.Object3D;
  propDisc: THREE.Mesh;
  rudder: THREE.Object3D;
  elevator: THREE.Object3D;
  aileronL: THREE.Object3D;
  aileronR: THREE.Object3D;
  materials: THREE.Material[];
}

export function buildPlane(): PlaneModel {
  const group = new THREE.Group();

  // ---------- textures ----------
  const wingTex = canvasTexture(1024, 256, (ctx) => {
    ctx.fillStyle = "#e9dfc6";
    ctx.fillRect(0, 0, 1024, 256);
    // fabric ribs along the span
    for (let i = 0; i < 1024; i += 26) {
      ctx.fillStyle = "rgba(120,100,70,0.10)";
      ctx.fillRect(i, 0, 3, 256);
      ctx.fillStyle = "rgba(255,255,245,0.12)";
      ctx.fillRect(i + 3, 0, 2, 256);
    }
    // leading edge wear & trailing edge grime
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "rgba(90,70,50,0.18)");
    g.addColorStop(0.08, "rgba(0,0,0,0)");
    g.addColorStop(0.45, "rgba(0,0,0,0)");
    g.addColorStop(0.5, "rgba(70,55,40,0.2)");
    g.addColorStop(0.55, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(90,70,50,0.16)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 256);
    speckle(ctx, 1024, 256, 90, 0.08);
    // red wing tips
    ctx.fillStyle = "#a33a2e";
    ctx.fillRect(0, 0, 60, 256);
    ctx.fillRect(964, 0, 60, 256);
    // oil streaks behind the engine on the upper surface
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = `rgba(40,30,20,${0.05 + Math.random() * 0.05})`;
      ctx.fillRect(470 + i * 14, 40, 5, 90);
    }
  });
  const hullTex = canvasTexture(1024, 512, (ctx) => {
    ctx.fillStyle = "#b24a3a";
    ctx.fillRect(0, 0, 1024, 512);
    // boot topping: bottom of the boat hull (uv.x around 0.25..0.75 is the bottom)
    ctx.fillStyle = "#2f3a3c";
    ctx.fillRect(310, 0, 404, 512);
    ctx.fillStyle = "#e8e0cc";
    ctx.fillRect(290, 0, 20, 512);
    ctx.fillRect(714, 0, 20, 512);
    // panel lines & rivets
    for (let y = 0; y < 512; y += 38) {
      ctx.fillStyle = "rgba(40,20,15,0.25)";
      ctx.fillRect(0, y, 1024, 2);
      for (let x = 0; x < 1024; x += 12) {
        ctx.fillStyle = "rgba(255,230,210,0.12)";
        ctx.fillRect(x, y + 5, 2, 2);
      }
    }
    speckle(ctx, 1024, 512, 160, 0.12);
    speckle(ctx, 1024, 512, 80, 0.08, false);
    // sun-faded top
    const g = ctx.createLinearGradient(0, 0, 1024, 0);
    g.addColorStop(0, "rgba(255,230,200,0.18)");
    g.addColorStop(0.15, "rgba(255,230,200,0)");
    g.addColorStop(0.85, "rgba(255,230,200,0)");
    g.addColorStop(1, "rgba(255,230,200,0.18)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 512);
    // registration on both flanks
    ctx.save();
    ctx.fillStyle = "rgba(245,238,220,0.9)";
    ctx.font = "bold 34px Georgia, serif";
    for (const x of [175, 849]) {
      ctx.save();
      ctx.translate(x, 250);
      ctx.rotate(x < 500 ? Math.PI / 2 : -Math.PI / 2);
      ctx.fillText("I - M A R E", -80, 12);
      ctx.restore();
    }
    ctx.restore();
  });
  const tailTex = canvasTexture(256, 256, (ctx) => {
    // italian-ish rudder stripes
    ctx.fillStyle = "#3d7a4e";
    ctx.fillRect(0, 0, 256, 86);
    ctx.fillStyle = "#efe9dc";
    ctx.fillRect(0, 86, 256, 86);
    ctx.fillStyle = "#b03a2e";
    ctx.fillRect(0, 172, 256, 84);
    speckle(ctx, 256, 256, 30, 0.1);
  });

  const hullMat = patchWorldMaterial(
    new THREE.MeshStandardMaterial({ map: hullTex, roughness: 0.55, metalness: 0.15 }),
    {},
  );
  const wingMat = patchWorldMaterial(
    new THREE.MeshStandardMaterial({
      map: wingTex,
      roughness: 0.62,
      metalness: 0.05,
      side: THREE.DoubleSide,
    }),
    {},
  );
  const metalMat = patchWorldMaterial(
    new THREE.MeshStandardMaterial({
      color: srgbColor(0xb8b8b2),
      roughness: 0.32,
      metalness: 0.85,
    }),
    {},
  );
  const darkMat = patchWorldMaterial(
    new THREE.MeshStandardMaterial({ color: srgbColor(0x2b2b2b), roughness: 0.6, metalness: 0.3 }),
    {},
  );
  const tailMat = patchWorldMaterial(
    new THREE.MeshStandardMaterial({ map: tailTex, roughness: 0.6, side: THREE.DoubleSide }),
    {},
  );
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x9fb8c0,
    roughness: 0.05,
    metalness: 0.2,
    transparent: true,
    opacity: 0.35,
  });
  const materials = [hullMat, wingMat, metalMat, darkMat, tailMat, glassMat];

  // ---------- hull ----------
  const hull = loftHull([
    { z: 4.3, w: 0.08, top: 0.15, bot: 0.05, chine: 0.1 },
    { z: 4.0, w: 0.38, top: 0.42, bot: -0.35, chine: 0.0 },
    { z: 3.3, w: 0.6, top: 0.6, bot: -0.72, chine: -0.25 },
    { z: 2.2, w: 0.7, top: 0.68, bot: -0.86, chine: -0.35 },
    { z: 0.8, w: 0.72, top: 0.7, bot: -0.88, chine: -0.36 },
    { z: -0.35, w: 0.7, top: 0.68, bot: -0.86, chine: -0.35 },
    { z: -0.4, w: 0.68, top: 0.68, bot: -0.58, chine: -0.3 },
    { z: -1.8, w: 0.56, top: 0.62, bot: -0.42, chine: -0.2 },
    { z: -3.4, w: 0.36, top: 0.54, bot: -0.08, chine: 0.02 },
    { z: -5.0, w: 0.18, top: 0.5, bot: 0.22, chine: 0.28 },
    { z: -5.9, w: 0.06, top: 0.46, bot: 0.36, chine: 0.4 },
  ]);
  const hullMesh = new THREE.Mesh(hull, hullMat);
  group.add(hullMesh);

  // cockpit coaming & windscreen
  const coaming = new THREE.TorusGeometry(0.42, 0.06, 6, 16);
  coaming.rotateX(Math.PI / 2);
  coaming.scale(1, 1, 1.6);
  coaming.translate(0, 0.7, 1.1);
  const seat = new THREE.CylinderGeometry(0.4, 0.4, 0.1, 16);
  seat.scale(1, 1, 1.6);
  seat.translate(0, 0.66, 1.1);
  group.add(new THREE.Mesh(mergeGeometries([coaming, seat])!, darkMat));
  const screen = new THREE.PlaneGeometry(0.8, 0.32);
  screen.rotateX(-0.5);
  screen.translate(0, 0.86, 1.82);
  group.add(new THREE.Mesh(screen, glassMat));
  // pilot's head
  const head = new THREE.SphereGeometry(0.13, 10, 8);
  head.translate(0, 0.98, 1.0);
  const scarf = new THREE.CylinderGeometry(0.1, 0.14, 0.15, 8);
  scarf.translate(0, 0.83, 1.0);
  group.add(new THREE.Mesh(head, darkMat));
  group.add(
    new THREE.Mesh(
      scarf,
      patchWorldMaterial(
        new THREE.MeshStandardMaterial({ color: srgbColor(0xe9e4d6), roughness: 0.9 }),
        {},
      ),
    ),
  );

  // ---------- wing (parasol) ----------
  const wingY = 2.05;
  const wing = wingGeometry(13.6, 1.95, 0.14, {
    dihedral: THREE.MathUtils.degToRad(1.8),
    tipRound: 0.1,
  });
  wing.translate(0, wingY, 0.35);
  group.add(new THREE.Mesh(wing, wingMat));
  // ailerons as separate hinged pieces
  const makeAileron = (side: number) => {
    const pivot = new THREE.Object3D();
    const g = wingGeometry(3.0, 0.42, 0.1, { tipRound: 0 });
    g.translate(0, 0, 0.14);
    const m = new THREE.Mesh(g, wingMat);
    pivot.add(m);
    pivot.position.set(
      side * 4.6,
      wingY + 0.16 + 4.6 * Math.tan(THREE.MathUtils.degToRad(1.8)),
      0.35 - 1.95 * 0.65 - 0.06,
    );
    group.add(pivot);
    return pivot;
  };
  const aileronL = makeAileron(1);
  const aileronR = makeAileron(-1);

  // struts: hull -> wing
  const strutGeo: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    strutGeo.push(
      strut(
        new THREE.Vector3(s * 0.55, 0.55, 1.0),
        new THREE.Vector3(s * 2.6, wingY + 0.02, 0.6),
        0.045,
      ),
    );
    strutGeo.push(
      strut(
        new THREE.Vector3(s * 0.55, 0.5, -0.4),
        new THREE.Vector3(s * 2.6, wingY + 0.02, -0.7),
        0.045,
      ),
    );
    strutGeo.push(
      strut(new THREE.Vector3(s * 0.3, 0.68, 0.4), new THREE.Vector3(s * 0.45, wingY, 0.2), 0.04),
    );
    // wing tip floats
    strutGeo.push(
      strut(
        new THREE.Vector3(s * 5.1, wingY + 0.12, 0.2),
        new THREE.Vector3(s * 5.1, 0.35, 0.2),
        0.035,
      ),
    );
    strutGeo.push(
      strut(
        new THREE.Vector3(s * 5.1, wingY + 0.12, -0.5),
        new THREE.Vector3(s * 5.1, 0.45, 0.0),
        0.03,
      ),
    );
  }
  group.add(new THREE.Mesh(mergeGeometries(strutGeo)!, darkMat));
  for (const s of [-1, 1]) {
    const f = loftHull(
      [
        { z: 1.1, w: 0.04, top: 0.05, bot: 0.0, chine: 0.02 },
        { z: 0.8, w: 0.2, top: 0.16, bot: -0.14, chine: -0.02 },
        { z: 0.0, w: 0.24, top: 0.2, bot: -0.2, chine: -0.04 },
        { z: -0.7, w: 0.08, top: 0.12, bot: 0.02, chine: 0.06 },
      ],
      10,
    );
    f.translate(s * 5.1, 0.2, 0.1);
    group.add(new THREE.Mesh(f, hullMat));
  }

  // ---------- engine above the wing ----------
  const nacellePts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const r =
      0.42 *
      Math.pow(Math.sin(Math.PI * Math.min(t * 1.25, 1) * 0.5 + 0.2), 0.8) *
      (1 - Math.pow(t, 3) * 0.75);
    nacellePts.push(new THREE.Vector2(Math.max(r, 0.02), (0.5 - t) * 2.6));
  }
  const nacelle = new THREE.LatheGeometry(nacellePts, 18);
  nacelle.rotateX(Math.PI / 2);
  nacelle.translate(0, wingY + 0.78, 1.0);
  group.add(new THREE.Mesh(nacelle, metalMat));
  const cowlRing = new THREE.TorusGeometry(0.4, 0.05, 6, 20);
  cowlRing.translate(0, wingY + 0.78, 2.2);
  const pylon: THREE.BufferGeometry[] = [cowlRing];
  for (const s of [-1, 1]) {
    pylon.push(
      strut(
        new THREE.Vector3(s * 0.25, wingY + 0.12, 1.2),
        new THREE.Vector3(s * 0.12, wingY + 0.5, 1.4),
        0.04,
      ),
    );
    pylon.push(
      strut(
        new THREE.Vector3(s * 0.25, wingY + 0.12, -0.2),
        new THREE.Vector3(s * 0.12, wingY + 0.5, 0.3),
        0.04,
      ),
    );
  }
  // exhaust stubs
  for (let i = 0; i < 3; i++) {
    const e = new THREE.CylinderGeometry(0.035, 0.045, 0.22, 6);
    e.rotateZ(Math.PI / 2);
    e.translate(0.44, wingY + 0.7, 1.6 - i * 0.28);
    pylon.push(e);
  }
  group.add(
    new THREE.Mesh(
      mergeGeometries(
        pylon
          .map((g) => (g.index ? g.toNonIndexed() : g))
          .map((g) => {
            if (g.attributes.uv) g.deleteAttribute("uv");
            return g;
          }),
      )!,
      darkMat,
    ),
  );

  // propeller
  const prop = new THREE.Object3D();
  prop.position.set(0, wingY + 0.78, 2.36);
  const spinner = new THREE.ConeGeometry(0.16, 0.42, 14);
  spinner.rotateX(Math.PI / 2);
  spinner.translate(0, 0, 0.12);
  prop.add(new THREE.Mesh(spinner, metalMat));
  for (let b = 0; b < 2; b++) {
    const blade = new THREE.BoxGeometry(0.13, 1.18, 0.035);
    blade.translate(0, 0.62, 0);
    const p = blade.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const taper = 1 - Math.pow(y / 1.25, 3) * 0.55;
      p.setX(i, p.getX(i) * taper);
    }
    blade.computeVertexNormals();
    blade.rotateY(0.35);
    blade.rotateZ(b * Math.PI);
    prop.add(new THREE.Mesh(blade, darkMat));
  }
  group.add(prop);
  const discMat = new THREE.MeshBasicMaterial({
    color: 0x333333,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const propDisc = new THREE.Mesh(new THREE.CircleGeometry(1.24, 40), discMat);
  propDisc.position.copy(prop.position).add(new THREE.Vector3(0, 0, 0.02));
  group.add(propDisc);

  // ---------- tail ----------
  const fin = new THREE.Shape();
  fin.moveTo(0, 0);
  fin.lineTo(-1.45, 0);
  fin.quadraticCurveTo(-1.5, 1.2, -1.2, 1.55);
  fin.lineTo(-0.8, 1.6);
  fin.quadraticCurveTo(-0.3, 0.8, 0, 0);
  const finGeo = new THREE.ExtrudeGeometry(fin, {
    depth: 0.07,
    bevelEnabled: true,
    bevelSize: 0.02,
    bevelThickness: 0.02,
    bevelSegments: 1,
  });
  finGeo.rotateY(Math.PI / 2);
  finGeo.translate(-0.035, 0.45, -4.2);
  group.add(new THREE.Mesh(finGeo, hullMat));
  // rudder with stripes
  const rudder = new THREE.Object3D();
  rudder.position.set(0, 0.45, -5.62);
  const rud = new THREE.Shape();
  rud.moveTo(0, 0);
  rud.lineTo(0, 1.58);
  rud.quadraticCurveTo(-0.55, 1.4, -0.62, 0.7);
  rud.quadraticCurveTo(-0.6, 0.15, 0, 0);
  const rudGeo = new THREE.ExtrudeGeometry(rud, { depth: 0.05, bevelEnabled: false });
  // uv from shape coords -> map stripes vertically
  const ruv = rudGeo.attributes.uv;
  for (let i = 0; i < ruv.count; i++) ruv.setXY(i, ruv.getX(i) + 0.6, 1 - ruv.getY(i) / 1.6);
  rudGeo.rotateY(Math.PI / 2);
  rudGeo.translate(-0.025, 0, 0);
  rudder.add(new THREE.Mesh(rudGeo, tailMat));
  group.add(rudder);
  // stabiliser on top of the fin
  const stab = wingGeometry(4.2, 1.0, 0.1, { tipRound: 0.25 });
  stab.translate(0, 1.6, -4.55);
  group.add(new THREE.Mesh(stab, wingMat));
  const elevator = new THREE.Object3D();
  elevator.position.set(0, 1.6, -5.2);
  const elev = wingGeometry(3.6, 0.42, 0.08, { tipRound: 0.2 });
  elev.translate(0, 0, 0.1);
  elevator.add(new THREE.Mesh(elev, wingMat));
  group.add(elevator);
  const tailStruts = [
    strut(new THREE.Vector3(1.4, 1.58, -4.6), new THREE.Vector3(0.1, 0.6, -4.4), 0.025),
    strut(new THREE.Vector3(-1.4, 1.58, -4.6), new THREE.Vector3(-0.1, 0.6, -4.4), 0.025),
  ];
  group.add(new THREE.Mesh(mergeGeometries(tailStruts)!, darkMat));

  group.traverse((o) => {
    if (o instanceof THREE.Mesh && o !== propDisc && o.material !== glassMat) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  return { group, prop, propDisc, rudder, elevator, aileronL, aileronR, materials };
}
