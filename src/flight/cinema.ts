import * as THREE from "three";
import { damp, dampAngle, wobble } from "../core/math";
import type { IslandManager } from "../world/islands/manager";
import type { Autopilot } from "./autopilot";

type Kind =
  | "flyby"
  | "tele"
  | "track"
  | "front"
  | "lowSea"
  | "aerial"
  | "topdown"
  | "orbit"
  | "cockpit"
  | "wing"
  | "tail"
  | "island"
  | "sunward";

interface CineShot {
  kind: Kind;
  t: number;
  duration: number;
  side: number;
  /** world-space camera anchor for locked-off (tripod) shots */
  anchor: THREE.Vector3;
  fov: number;
  /** slow zoom over the shot: fov at the end */
  fovEnd: number;
  /** extra params per kind */
  a: number;
  b: number;
  /** how much hand-held drift this shot gets */
  shake: number;
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _v = new THREE.Vector3();
const LOCAL_UP = new THREE.Vector3(0, 1, 0);

/**
 * Film-style auto direction: picks varied angles, lenses and positions from the
 * situation around the plane, holds each for a few seconds and cuts between them.
 */
export class Cinema {
  private shot: CineShot | null = null;
  private history: Kind[] = [];
  private time = 0;
  private aim = new THREE.Vector3();
  private followYaw = 0;
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  beamMood = 0;
  /** called on every hard cut (the renderer drops stale temporal history) */
  onCut: (() => void) | null = null;

  constructor(
    private pilot: Autopilot,
    private islands: IslandManager,
  ) {}

  get shotName(): string {
    return this.shot ? `cine:${this.shot.kind}` : "cine";
  }

  /** Development helper: cut to a specific kind of shot now. */
  force(kind: Kind) {
    const shot = this.build(kind);
    if (shot) {
      this.shot = shot;
      this.aim.copy(this.pilot.position);
      this.onCut?.();
    }
  }

  /** Called when the mode is entered so the first frame is already a composed shot. */
  start() {
    this.shot = null;
    this.followYaw = this.pilot.heading;
  }

  // ---------------------------------------------------------------- helpers

  private ground(x: number, z: number) {
    return Math.max(0, this.islands.heightAt(x, z));
  }

  /** horizontal forward/right of the (lagged) flight direction */
  private basis(fwd: THREE.Vector3, right: THREE.Vector3, yaw = this.followYaw) {
    fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    // the plane's right is -x when heading +z
    right.set(-fwd.z, 0, fwd.x);
  }

  private planeLocal(x: number, y: number, z: number, out: THREE.Vector3) {
    return out.set(x, y, z).applyQuaternion(this.pilot.quaternion).add(this.pilot.position);
  }

  /** Is there terrain between the camera and the plane? */
  private occluded(cam: THREE.Vector3): boolean {
    const p = this.pilot.position;
    for (let i = 1; i < 10; i++) {
      const f = i / 10;
      const x = cam.x + (p.x - cam.x) * f;
      const y = cam.y + (p.y - cam.y) * f;
      const z = cam.z + (p.z - cam.z) * f;
      if (this.islands.heightAt(x, z) > y - 4) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- choosing

  private candidates(): [Kind, number][] {
    const p = this.pilot.position;
    const low = p.y < 220;
    const inCloud = this.pilot.inCloud > 0.1;
    if (inCloud) {
      return [
        ["cockpit", 3],
        ["track", 2],
        ["tail", 2],
        ["wing", 2],
      ];
    }
    const near = this.islands.near(p.x, p.z, 4000).length > 0;
    const list: [Kind, number][] = [
      ["flyby", 3],
      ["tele", 2],
      ["track", 2.2],
      ["front", 2],
      ["aerial", 1.4],
      ["topdown", 0.8],
      ["orbit", 1.4],
      ["cockpit", 1.6],
      ["wing", 1.2],
      ["tail", 1.2],
    ];
    if (low) list.push(["lowSea", 2.5]);
    if (near) list.push(["island", 3]);
    if (this.beamMood > 0.4 && this.sunDir.y > 0.04) list.push(["sunward", 4]);
    else if (this.sunDir.y > 0.02 && this.sunDir.y < 0.3) list.push(["sunward", 1.5]);
    return list;
  }

  private pick(): CineShot {
    const list = this.candidates().filter(([k]) => !this.history.includes(k));
    for (let tries = 0; tries < 8; tries++) {
      const total = list.reduce((s, [, w]) => s + w, 0);
      let r = Math.random() * total;
      let kind: Kind = list[0]?.[0] ?? "track";
      for (const [k, w] of list) {
        r -= w;
        if (r <= 0) {
          kind = k;
          break;
        }
      }
      const shot = this.build(kind);
      if (shot && this.validate(shot)) return shot;
      const i = list.findIndex(([k]) => k === kind);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) break;
    }
    return this.build("track")!;
  }

  private build(kind: Kind): CineShot | null {
    const pl = this.pilot;
    const p = pl.position;
    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    this.basis(fwd, right, pl.heading);
    const side = Math.random() < 0.5 ? 1 : -1;
    const s: CineShot = {
      kind,
      t: 0,
      duration: 6 + Math.random() * 4,
      side,
      anchor: new THREE.Vector3(),
      fov: 45,
      fovEnd: 45,
      a: 0,
      b: 0,
      shake: 0.6,
    };
    const v = pl.speed;
    switch (kind) {
      case "flyby": {
        // tripod ahead of the plane, slightly off its path: it roars past
        const d = 160 + Math.random() * 180;
        const lat = 18 + Math.random() * 30;
        s.anchor
          .copy(p)
          .addScaledVector(fwd, d)
          .addScaledVector(right, side * lat);
        s.anchor.y = p.y + (Math.random() - 0.35) * 30;
        s.anchor.y = Math.max(s.anchor.y, this.ground(s.anchor.x, s.anchor.z) + 4);
        s.duration = d / v + 2.5 + Math.random() * 1.5;
        s.fov = 36 + Math.random() * 10;
        s.fovEnd = s.fov + 6;
        s.shake = 0.35;
        break;
      }
      case "lowSea": {
        const d = 200 + Math.random() * 200;
        s.anchor
          .copy(p)
          .addScaledVector(fwd, d)
          .addScaledVector(right, side * (10 + Math.random() * 30));
        if (this.islands.heightAt(s.anchor.x, s.anchor.z) > -2) return null;
        s.anchor.y = 2.2;
        s.duration = d / v + 3;
        s.fov = 52;
        s.fovEnd = 48;
        s.shake = 0.5;
        break;
      }
      case "island": {
        const isl = this.islands.near(p.x, p.z, 4000)[0];
        if (!isl) return null;
        // where the plane will be in a few seconds; stand on the far side of its path
        // so the island fills the background
        const ahead = v * (5 + Math.random() * 3);
        const q = _q.copy(p).addScaledVector(fwd, ahead);
        const away = _v.set(q.x - isl.spec.x, 0, q.z - isl.spec.z);
        if (away.lengthSq() < 1) return null;
        away.normalize();
        s.anchor.copy(q).addScaledVector(away, 160 + Math.random() * 160);
        s.anchor.y = Math.max(
          p.y * (0.4 + Math.random() * 0.5),
          this.ground(s.anchor.x, s.anchor.z) + 8,
          10,
        );
        s.duration = 9 + Math.random() * 3;
        s.fov = 28 + Math.random() * 10;
        s.fovEnd = s.fov - 4;
        s.shake = 0.3;
        break;
      }
      case "tele":
        s.a = 200 + Math.random() * 140; // distance behind
        s.b = 20 + Math.random() * 40; // height
        s.fov = 11 + Math.random() * 5;
        s.fovEnd = s.fov * 0.9;
        s.shake = 0.25;
        break;
      case "track":
        s.a = 26 + Math.random() * 12;
        s.b = (Math.random() - 0.3) * 6;
        s.fov = 38 + Math.random() * 10;
        s.fovEnd = s.fov;
        s.shake = 0.8;
        break;
      case "front":
        s.a = 30 + Math.random() * 14;
        s.b = 2 + Math.random() * 8;
        s.fov = 40 + Math.random() * 8;
        s.fovEnd = s.fov;
        s.shake = 0.7;
        break;
      case "aerial":
        // high and behind, shallow enough that both the horizon and the plane are in frame
        s.a = 120 + Math.random() * 60;
        s.b = 30 + Math.random() * 30;
        s.fov = 50;
        s.fovEnd = 46;
        s.duration = 8 + Math.random() * 4;
        s.shake = 0.4;
        break;
      case "topdown":
        s.a = 70 + Math.random() * 50;
        s.fov = 42;
        s.fovEnd = 50;
        s.shake = 0.2;
        break;
      case "orbit":
        s.a = Math.random() * Math.PI * 2;
        s.b = side * (0.22 + Math.random() * 0.12);
        s.fov = 44;
        s.fovEnd = 44;
        s.duration = 9 + Math.random() * 4;
        s.shake = 0.5;
        break;
      case "cockpit":
        s.fov = 70;
        s.fovEnd = 70;
        s.duration = 8 + Math.random() * 4;
        s.shake = 1.2;
        break;
      case "wing":
        s.fov = 56;
        s.fovEnd = 56;
        s.shake = 0.6;
        break;
      case "tail":
        s.fov = 60;
        s.fovEnd = 60;
        s.shake = 0.8;
        break;
      case "sunward":
        s.a = 30 + Math.random() * 12;
        s.fov = 56;
        s.fovEnd = 52;
        s.duration = 9 + Math.random() * 4;
        s.shake = 0.5;
        break;
    }
    return s;
  }

  private validate(s: CineShot): boolean {
    const cam = new THREE.Vector3();
    const target = new THREE.Vector3();
    this.frame(s, cam, target, new THREE.Vector3(), 0);
    if (cam.y < this.ground(cam.x, cam.z) + 1.5) return false;
    return !this.occluded(cam);
  }

  // ---------------------------------------------------------------- framing

  /** Computes camera position, look target and up vector for a shot at its current time. */
  private frame(
    s: CineShot,
    cam: THREE.Vector3,
    target: THREE.Vector3,
    up: THREE.Vector3,
    dt: number,
  ) {
    const pl = this.pilot;
    const p = pl.position;
    const fwd = _p;
    const right = new THREE.Vector3();
    this.basis(fwd, right);
    up.copy(LOCAL_UP);
    const k = s.duration > 0 ? s.t / s.duration : 0;
    switch (s.kind) {
      case "flyby":
      case "lowSea":
      case "island":
        cam.copy(s.anchor);
        // the operator pans with a little lag, like a real fluid head
        if (dt > 0) {
          this.aim.x = damp(this.aim.x, p.x, 7, dt);
          this.aim.y = damp(this.aim.y, p.y, 7, dt);
          this.aim.z = damp(this.aim.z, p.z, 7, dt);
          target.copy(this.aim);
        } else target.copy(p);
        break;
      case "tele":
        cam
          .copy(p)
          .addScaledVector(fwd, -s.a)
          .addScaledVector(right, s.side * s.a * 0.15);
        cam.y = p.y + s.b;
        target.copy(p).addScaledVector(fwd, 8);
        break;
      case "track":
        // side-by-side, drifting slowly from slightly behind to slightly ahead
        cam
          .copy(p)
          .addScaledVector(right, s.side * s.a)
          .addScaledVector(fwd, -8 + 14 * k);
        cam.y = p.y + s.b;
        // aim a little ahead: leave room in front of the plane (it sits on the trailing third)
        target.copy(p).addScaledVector(fwd, s.a * 0.45);
        break;
      case "front":
        cam
          .copy(p)
          .addScaledVector(fwd, s.a)
          .addScaledVector(right, s.side * s.a * 0.45);
        cam.y = p.y + s.b;
        target.copy(p).addScaledVector(fwd, -4);
        break;
      case "aerial":
        cam
          .copy(p)
          .addScaledVector(fwd, -s.a * (1 - 0.3 * k))
          .addScaledVector(right, s.side * s.a * 0.35);
        cam.y = p.y + s.b;
        // look ahead so the horizon stays in frame and the plane sits low in it
        target.copy(p).addScaledVector(fwd, s.a * 0.7);
        break;
      case "topdown":
        cam.copy(p).addScaledVector(fwd, 6);
        cam.y = p.y + s.a * (1 + 0.25 * k);
        target.copy(p).addScaledVector(fwd, 6);
        // the plane points to the top of the frame
        up.copy(fwd);
        break;
      case "orbit": {
        const ang = s.a + s.b * s.t;
        cam.set(
          p.x + Math.sin(ang) * 26,
          p.y + 4 + Math.sin(s.t * 0.4) * 2,
          p.z + Math.cos(ang) * 26,
        );
        target.copy(p);
        break;
      }
      case "cockpit":
        // over the pilot's shoulder: the wing's leading edge just in frame above
        this.planeLocal(0.4, 1.58, -0.35, cam);
        this.planeLocal(0.0, 2.6, 80, target);
        up.copy(LOCAL_UP).applyQuaternion(pl.quaternion);
        break;
      case "wing":
        // out on the right wing tip, looking back along the wing at the hull
        this.planeLocal(-6.3, 2.75, -1.6, cam);
        this.planeLocal(0.0, 1.3, 2.5, target);
        up.copy(LOCAL_UP).applyQuaternion(pl.quaternion);
        break;
      case "tail":
        this.planeLocal(0.0, 2.9, -12.5, cam);
        this.planeLocal(0.0, 1.6, 40, target);
        up.copy(LOCAL_UP).lerp(_v.copy(LOCAL_UP).applyQuaternion(pl.quaternion), 0.5).normalize();
        break;
      case "sunward": {
        // stand down-sun of the plane so we look past it into the light
        const sx = this.sunDir.x;
        const sz = this.sunDir.z;
        const h = Math.hypot(sx, sz) || 1;
        cam.set(p.x - (sx / h) * s.a, p.y - 3, p.z - (sz / h) * s.a);
        cam.addScaledVector(right, s.side * 8);
        target.copy(p);
        target.y += 9;
        break;
      }
    }
    const g = this.ground(cam.x, cam.z) + (s.kind === "lowSea" ? 1.6 : 3);
    if (cam.y < g) cam.y = g;
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number, camera: THREE.PerspectiveCamera) {
    this.time += dt;
    this.followYaw = dampAngle(this.followYaw, this.pilot.heading, 2.2, dt);
    let cut = false;
    if (!this.shot || this.shot.t >= this.shot.duration) {
      this.shot = this.pick();
      this.history.push(this.shot.kind);
      if (this.history.length > 2) this.history.shift();
      this.aim.copy(this.pilot.position);
      cut = true;
    }
    const s = this.shot;
    s.t += dt;
    const cam = camera.position;
    const target = _q;
    const up = new THREE.Vector3();
    this.frame(s, cam, target, up, cut ? 0 : dt);

    camera.up.copy(up);
    camera.lookAt(target);
    // hand-held / fluid-head drift
    const sh = s.shake * 0.006;
    camera.rotateY(wobble(this.time * 0.9, 1) * sh);
    camera.rotateX(wobble(this.time * 0.8, 2) * sh * 0.8);
    if (s.kind === "cockpit") camera.rotateX(Math.sin(this.time * 31) * 0.0012);

    const k = Math.min(s.t / s.duration, 1);
    const fov = s.fov + (s.fovEnd - s.fov) * (k * k * (3 - 2 * k));
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    if (cut) this.onCut?.();
  }
}
