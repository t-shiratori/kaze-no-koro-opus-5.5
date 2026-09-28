import * as THREE from "three";
import { G, globalsFor } from "../render/globals";
import { GLOBALS_GLSL } from "../render/shaders/common";
import type { IslandManager } from "./islands/manager";

const MAX_BIRDS = 420;

type Mode = "colony" | "cross" | "glide" | "skim";

interface Bird {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mode: Mode;
  flock: Flock;
  offset: THREE.Vector3;
  phase: number;
  flapRate: number;
  flap: number;
  flapTarget: number;
  flapTimer: number;
  bank: number;
  slot: number;
}

interface Flock {
  mode: Mode;
  center: THREE.Vector3;
  vel: THREE.Vector3;
  radius: number;
  angSpeed: number;
  age: number;
  life: number;
  key?: string;
  birds: Bird[];
}

function gullGeometry(): THREE.BufferGeometry {
  // x forward, y up, z to the right. aSeg: 0 body, 1 inner wing, 2 outer wing
  const pos: number[] = [];
  const seg: number[] = [];
  const col: number[] = [];
  const white = [0.92, 0.92, 0.9];
  const grey = [0.55, 0.58, 0.62];
  const tip = [0.08, 0.08, 0.09];
  const tri = (a: number[], b: number[], c: number[], s: number, cc: number[]) => {
    pos.push(...a, ...b, ...c);
    seg.push(s, s, s);
    col.push(...cc, ...cc, ...cc);
  };
  // body: a slim double pyramid
  const nose = [0.32, 0.0, 0];
  const tail = [-0.36, 0.02, 0];
  const top = [0.02, 0.07, 0];
  const bot = [0.02, -0.06, 0];
  const l = [0.02, 0, -0.07];
  const r = [0.02, 0, 0.07];
  for (const [a, b] of [
    [top, r],
    [r, bot],
    [bot, l],
    [l, top],
  ]) {
    tri(nose, a, b, 0, white);
    tri(tail, b, a, 0, white);
  }
  // tail fan
  tri([-0.3, 0.02, 0], [-0.46, 0.02, 0.09], [-0.46, 0.02, -0.09], 0, white);
  for (const s of [-1, 1]) {
    // inner wing (leading edge swept slightly forward)
    const a = [0.1, 0.01, 0.05 * s];
    const b = [-0.1, 0.01, 0.05 * s];
    const c = [0.06, 0.0, 0.36 * s];
    const d = [-0.12, 0.0, 0.36 * s];
    tri(a, c, b, 1, grey);
    tri(b, c, d, 1, grey);
    // outer wing, swept back, dark tip
    const e = [-0.02, 0.0, 0.7 * s];
    const f = [-0.16, 0.0, 0.62 * s];
    tri(c, e, d, 2, grey);
    tri(d, e, f, 2, tip);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aSeg", new THREE.Float32BufferAttribute(seg, 1));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSeg;
attribute vec3 color;
attribute vec3 aAnim; // flap phase, flap amplitude, glide dihedral
varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  vec3 p = position;
  float side = sign(p.z);
  float span = abs(p.z);
  float a1 = sin(aAnim.x) * aAnim.y + aAnim.z;
  float a2 = sin(aAnim.x - 0.9) * aAnim.y * 0.7 - aAnim.z * 0.5;
  if (aSeg > 0.5) {
    float s1 = min(span, 0.36);
    float y = s1 * sin(a1);
    float z = s1 * cos(a1);
    if (aSeg > 1.5) {
      float s2 = span - 0.36;
      y += s2 * sin(a1 + a2);
      z += s2 * cos(a1 + a2);
    }
    p.y += y;
    p.z = side * z;
  }
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix * instanceMatrix) * vec3(0.0, 1.0, 0.0));
  vColor = color;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLOBALS_GLSL}
varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(vNormalW);
  float wrap = abs(dot(n, uSunDir)) * 0.7 + 0.3;
  float sh = cloudShadowAt(vWorld);
  vec3 c = vColor * (uSunColor * wrap * sh * 0.1 + uAmbZenith * 0.9 + uAmbHorizon * 0.3);
  gl_FragColor = vec4(c, 1.0);
  #include <logdepthbuf_fragment>
}
`;

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

export class Birds {
  readonly mesh: THREE.InstancedMesh;
  private anim: THREE.InstancedBufferAttribute;
  private flocks: Flock[] = [];
  private freeSlots: number[] = [];
  private nextCrossing = 8;
  private nextGlider = 15;

  constructor(private islands: IslandManager) {
    const geo = gullGeometry();
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BIRDS * 3), 3);
    this.anim.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aAnim", this.anim);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: globalsFor(
        "uTime",
        "uSunDir",
        "uSunColor",
        "uTrueSunDir",
        "uAmbZenith",
        "uAmbHorizon",
        "uNight",
        "uWind",
        "uCloudOffset",
        "uCloudShadow",
        "uCloudShadowFrame",
        "uHeightMap",
        "uHeightFrame",
      ),
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_BIRDS);
    this.mesh.frustumCulled = false;
    this.mesh.count = MAX_BIRDS;
    for (let i = MAX_BIRDS - 1; i >= 0; i--) this.freeSlots.push(i);
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_BIRDS; i++) this.mesh.setMatrixAt(i, _m);
  }

  private makeFlock(
    mode: Mode,
    center: THREE.Vector3,
    vel: THREE.Vector3,
    n: number,
    radius: number,
    life: number,
    key?: string,
  ) {
    const flock: Flock = {
      mode,
      center: center.clone(),
      vel: vel.clone(),
      radius,
      angSpeed: 0,
      age: 0,
      life,
      key,
      birds: [],
    };
    flock.angSpeed = (Math.random() < 0.5 ? -1 : 1) * (0.1 + Math.random() * 0.12);
    for (let i = 0; i < n && this.freeSlots.length > 0; i++) {
      const slot = this.freeSlots.pop()!;
      let offset: THREE.Vector3;
      if (mode === "cross") {
        // loose V / skein
        const row = Math.floor((i + 1) / 2);
        const side = i % 2 === 0 ? 1 : -1;
        offset = new THREE.Vector3(
          -row * 4.5 + (Math.random() - 0.5) * 3,
          (Math.random() - 0.5) * 4,
          side * row * 3.8 + (Math.random() - 0.5) * 3,
        );
      } else {
        offset = new THREE.Vector3(
          Math.random() * Math.PI * 2,
          (Math.random() - 0.5) * 30,
          0.6 + Math.random() * 0.8,
        );
      }
      const b: Bird = {
        pos: center
          .clone()
          .add(
            _v.set(
              (Math.random() - 0.5) * 20,
              (Math.random() - 0.5) * 8,
              (Math.random() - 0.5) * 20,
            ),
          ),
        vel: vel.clone().add(_v.set(Math.random() - 0.5, 0, Math.random() - 0.5)),
        mode,
        flock,
        offset,
        phase: Math.random() * 10,
        flapRate: 7 + Math.random() * 2.5,
        flap: 0.5,
        flapTarget: 0.6,
        flapTimer: Math.random() * 3,
        bank: 0,
        slot,
      };
      if (mode === "cross")
        b.pos
          .copy(center)
          .add(
            _v.copy(offset).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -Math.atan2(vel.z, vel.x)),
          );
      flock.birds.push(b);
    }
    this.flocks.push(flock);
    return flock;
  }

  private removeFlock(f: Flock) {
    for (const b of f.birds) {
      _m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(b.slot, _m);
      this.freeSlots.push(b.slot);
    }
    this.flocks.splice(this.flocks.indexOf(f), 1);
  }

  update(dt: number, planePos: THREE.Vector3, planeFwd: THREE.Vector3, planeSpeed: number) {
    const t = G.uTime.value;
    const wind = G.uWind.value;

    // ---- colonies at nearby cliffs ----
    const wantKeys = new Set<string>();
    for (const isl of this.islands.near(planePos.x, planePos.z, 4200)) {
      const b = isl.build;
      if (!b) continue;
      for (let i = 0; i < b.cliffs.length && i < 9; i += 3) {
        const key = `${isl.spec.id}:${i}`;
        wantKeys.add(key);
        if (!this.flocks.some((f) => f.key === key)) {
          const c = new THREE.Vector3(
            b.cliffs[i] + isl.spec.x,
            b.cliffs[i + 1] + 15,
            b.cliffs[i + 2] + isl.spec.z,
          );
          this.makeFlock(
            "colony",
            c,
            new THREE.Vector3(),
            4 + Math.floor(Math.random() * 8),
            45 + Math.random() * 70,
            1e9,
            key,
          );
        }
      }
    }
    for (const f of this.flocks.slice()) if (f.key && !wantKeys.has(f.key)) this.removeFlock(f);

    // ---- a flock crossing ahead of the plane: a small, memorable event ----
    this.nextCrossing -= dt;
    if (this.nextCrossing <= 0 && this.freeSlots.length > 20) {
      this.nextCrossing = 12 + Math.random() * 18;
      const side = Math.random() < 0.5 ? -1 : 1;
      const right = new THREE.Vector3(-planeFwd.z, 0, planeFwd.x).normalize();
      const birdSpeed = 12 + Math.random() * 4;
      const lateral = 220 + Math.random() * 160;
      const tCross = lateral / birdSpeed;
      const ahead = planeSpeed * tCross + 40 + Math.random() * 90;
      const c = planePos
        .clone()
        .addScaledVector(planeFwd, ahead)
        .addScaledVector(right, side * lateral);
      c.y = Math.max(planePos.y + (Math.random() - 0.4) * 25, 12);
      const vel = right
        .clone()
        .multiplyScalar(-side * birdSpeed)
        .addScaledVector(planeFwd, (Math.random() - 0.5) * 4);
      const low = planePos.y < 140 && Math.random() < 0.5;
      if (low) c.y = 6 + Math.random() * 6;
      this.makeFlock(
        low ? "skim" : "cross",
        c,
        vel,
        // now and then a big flock
        Math.random() < 0.2
          ? 24 + Math.floor(Math.random() * 16)
          : 9 + Math.floor(Math.random() * 12),
        0,
        tCross * 2.4 + 20,
      );
    }

    // ---- a lone bird soaring somewhere ----
    this.nextGlider -= dt;
    if (this.nextGlider <= 0 && this.freeSlots.length > 5) {
      this.nextGlider = 20 + Math.random() * 30;
      const a = Math.atan2(planeFwd.z, planeFwd.x) + (Math.random() - 0.5) * 1.6;
      const d = 350 + Math.random() * 700;
      const c = new THREE.Vector3(
        planePos.x + Math.cos(a) * d,
        Math.max(40, planePos.y + (Math.random() - 0.5) * 120),
        planePos.z + Math.sin(a) * d,
      );
      this.makeFlock(
        "glide",
        c,
        new THREE.Vector3(wind.x * 0.5, 0.6, wind.y * 0.5),
        1 + (Math.random() < 0.3 ? 1 : 0),
        60 + Math.random() * 60,
        90,
      );
    }

    // ---- simulate ----
    for (const f of this.flocks.slice()) {
      f.age += dt;
      f.center.addScaledVector(f.vel, dt);
      if (f.mode === "skim" && f.age > 6) f.vel.y = Math.min(f.vel.y + dt * 0.8, 4.5); // ride the updraft
      if (f.age > f.life || f.center.distanceTo(planePos) > 6000) {
        this.removeFlock(f);
        continue;
      }
      for (const b of f.birds) {
        // desired position
        if (f.mode === "colony" || f.mode === "glide") {
          const ang = t * f.angSpeed * b.offset.z + b.offset.x;
          _t.set(
            f.center.x + Math.cos(ang) * f.radius * b.offset.z,
            f.center.y + b.offset.y + Math.sin(t * 0.3 + b.offset.x) * 10,
            f.center.z + Math.sin(ang) * f.radius * b.offset.z,
          );
        } else {
          const yaw = Math.atan2(f.vel.z, f.vel.x);
          _t.copy(b.offset).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -yaw).add(f.center);
          _t.y += Math.sin(t * 0.8 + b.phase) * 1.5;
        }
        // steer toward it with a speed limit: smooth, curving flight
        _v.copy(_t).sub(b.pos);
        const desiredSpeed = f.mode === "colony" ? 9 : f.mode === "glide" ? 8 : f.vel.length();
        _v.multiplyScalar(0.6).add(
          f.mode === "cross" || f.mode === "skim" ? f.vel : _s.set(0, 0, 0),
        );
        if (_v.length() > desiredSpeed * 1.4) _v.setLength(desiredSpeed * 1.4);
        const prevVel = b.vel.clone();
        b.vel.lerp(_v, 1 - Math.exp(-dt * 1.4));
        if (b.vel.lengthSq() < 16) b.vel.setLength(4);
        _v.set(wind.x * 0.25, 0, wind.y * 0.25);
        b.pos.addScaledVector(b.vel, dt).addScaledVector(_v, dt);
        if (b.pos.y < 3) b.pos.y = 3;

        // flapping: bursts of flaps between glides; climbing needs more work
        b.flapTimer -= dt;
        if (b.flapTimer <= 0) {
          const climbing = b.vel.y > 1;
          b.flapTarget = f.mode === "glide" ? 0 : climbing || Math.random() < 0.45 ? 0.75 : 0.0;
          b.flapTimer = 0.8 + Math.random() * 2.5;
        }
        b.flap += (b.flapTarget - b.flap) * (1 - Math.exp(-dt * 3));
        b.phase += dt * b.flapRate * (0.3 + b.flap);
        // bank into turns
        const turn =
          new THREE.Vector3().crossVectors(prevVel, b.vel).y /
          Math.max(dt, 1e-3) /
          Math.max(b.vel.lengthSq(), 1);
        b.bank += (THREE.MathUtils.clamp(-turn * 6, -0.9, 0.9) - b.bank) * (1 - Math.exp(-dt * 3));

        const yaw = Math.atan2(b.vel.z, b.vel.x);
        const pitch = Math.atan2(b.vel.y, Math.hypot(b.vel.x, b.vel.z));
        _e.set(b.bank, -yaw, pitch, "YZX");
        _q.setFromEuler(_e);
        const sc = 2.1;
        _m.compose(b.pos, _q, _s.set(sc, sc, sc));
        this.mesh.setMatrixAt(b.slot, _m);
        this.anim.setXYZ(b.slot, b.phase, b.flap * 0.75, b.flap < 0.2 ? 0.08 : 0.02);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.anim.needsUpdate = true;
  }
}
