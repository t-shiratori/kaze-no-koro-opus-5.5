import * as THREE from "three";
import { Spring, damp, dampAngle, wobble } from "../core/math";
import type { Weather } from "../env/weather";
import type { IslandManager } from "../world/islands/manager";
import type { Autopilot } from "./autopilot";
import { Cinema } from "./cinema";

export type CameraMode = "calm" | "cinema";

interface Shot {
  name: string;
  yaw: number; // 0 = behind the plane, + swings the camera to the plane's right
  elev: number; // radians above the plane
  dist: number;
  fov: number;
  lookAhead: number;
  lookUp: number;
  /** yaw drift in rad/s (slow orbit) */
  orbit?: number;
  /** keep the camera on the far side from the sun, looking into the light */
  faceSun?: boolean;
  duration: number;
}

/**
 * Cinematic camera. Chooses compositions from what is around the plane (islands,
 * clouds, sea) and eases between them so slowly that one hardly notices.
 */
export class Director {
  readonly camera: THREE.PerspectiveCamera;
  private shot: Shot;
  private timer = 0;
  private yaw = new Spring(0);
  private elev = new Spring(0.2);
  private dist = new Spring(36);
  private fov = new Spring(55);
  private lookAhead = new Spring(30);
  private lookUp = new Spring(3);
  private followYaw = 0;
  private followPitch = 0;
  private orbitAcc = 0;
  private time = 0;
  private lookTarget = new THREE.Vector3();
  private lookBias = new THREE.Vector3();
  private lookBiasTarget = new THREE.Vector3();

  // user interaction
  userYaw = 0;
  userElev = 0;
  userZoom = 1;
  private idle = 999;
  /** set by the world: sun direction and how strongly beams are on show (0..1) */
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  beamMood = 0;
  private wasInCloud = false;
  /** "calm": one slowly drifting follow camera; "cinema": cut between many angles */
  mode: CameraMode = "calm";
  readonly cinema: Cinema;
  /** photo mode: a free camera orbiting the frozen plane */
  photoActive = false;
  private photo = { yaw: 0, pitch: 0.1, dist: 36, fov: 55 };

  constructor(
    aspect: number,
    private pilot: Autopilot,
    private islands: IslandManager,
    private weather: Weather,
  ) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 1.0, 60000);
    this.shot = this.chase();
    this.followYaw = pilot.heading;
    this.cinema = new Cinema(pilot, islands);
  }

  /** Enter photo mode, starting from wherever the camera is right now. */
  enterPhoto() {
    const rel = this.camera.position.clone().sub(this.pilot.position);
    const d = Math.max(rel.length(), 8);
    this.photo.dist = Math.min(d, 400);
    this.photo.yaw = Math.atan2(rel.x, rel.z);
    this.photo.pitch = Math.asin(THREE.MathUtils.clamp(rel.y / d, -0.95, 0.95));
    this.photo.fov = this.camera.fov;
    this.photoActive = true;
  }

  exitPhoto() {
    this.photoActive = false;
    if (this.mode === "cinema") this.cinema.start();
  }

  photoOrbit(dx: number, dy: number) {
    this.photo.yaw -= dx * 0.006;
    this.photo.pitch = THREE.MathUtils.clamp(this.photo.pitch + dy * 0.005, -1.2, 1.45);
  }

  photoZoom(factor: number) {
    this.photo.dist = THREE.MathUtils.clamp(this.photo.dist * factor, 7, 600);
  }

  get photoFov(): number {
    return this.photo.fov;
  }

  set photoFov(v: number) {
    this.photo.fov = THREE.MathUtils.clamp(v, 10, 100);
  }

  private updatePhoto() {
    const p = this.pilot.position;
    const ph = this.photo;
    const cam = this.camera;
    cam.position.set(
      p.x + Math.sin(ph.yaw) * Math.cos(ph.pitch) * ph.dist,
      p.y + Math.sin(ph.pitch) * ph.dist,
      p.z + Math.cos(ph.yaw) * Math.cos(ph.pitch) * ph.dist,
    );
    const ground = Math.max(0, this.islands.heightAt(cam.position.x, cam.position.z));
    if (cam.position.y < ground + 1.5) cam.position.y = ground + 1.5;
    cam.up.set(0, 1, 0);
    cam.lookAt(p);
    if (Math.abs(cam.fov - ph.fov) > 0.01) {
      cam.fov = ph.fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  setMode(mode: CameraMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "cinema") this.cinema.start();
    else {
      // come back on a fresh calm composition
      this.followYaw = this.pilot.heading;
      this.shot = this.chase();
      this.timer = this.shot.duration;
      this.userYaw = this.userElev = 0;
      this.userZoom = 1;
    }
  }

  /** Choose a fresh composition soon (e.g. when the mood of the world changes). */
  refresh() {
    this.timer = Math.min(this.timer, 1.5);
  }

  touch() {
    this.idle = 0;
  }

  /** Development helper: hold a composition for a while. */
  holdShot(partial: Partial<Shot>, seconds = 60) {
    this.shot = { ...this.chase(), ...partial, duration: seconds };
    this.timer = seconds;
  }

  private chase(): Shot {
    return {
      name: "chase",
      yaw: (Math.random() - 0.5) * 0.35,
      elev: 0.16 + Math.random() * 0.08,
      dist: 34 + Math.random() * 8,
      fov: 55,
      lookAhead: 34,
      lookUp: 5,
      duration: 24 + Math.random() * 20,
    };
  }

  private pickShot() {
    const p = this.pilot.position;
    const fwd = this.pilot.forward;
    const r = Math.random();
    const side = Math.random() < 0.5 ? 1 : -1;

    // what's around?
    let islandSide = 0;
    let islandDist = Infinity;
    for (const isl of this.islands.near(p.x, p.z, 4500)) {
      const dx = isl.spec.x - p.x;
      const dz = isl.spec.z - p.z;
      const d = Math.hypot(dx, dz) - isl.spec.extent;
      const ahead = dx * fwd.x + dz * fwd.z;
      if (d < 2200 && ahead > -300 && d < islandDist) {
        islandDist = d;
        // + when the island is on the plane's left (+x side when heading +z)
        islandSide = Math.sign(fwd.z * dx - fwd.x * dz);
      }
    }
    let cloudAhead = 0;
    for (const d of [1500, 2500, 3500]) {
      cloudAhead = Math.max(
        cloudAhead,
        this.weather.cloudinessAt(p.x + fwd.x * d, p.y + 700, p.z + fwd.z * d),
      );
    }
    const low = p.y < 150;

    let s: Shot;
    if (this.beamMood > 0.5 && this.sunDir.y > 0.05 && Math.random() < 0.8) {
      // look into the light: beams fan down from the gaps onto the sea
      s = {
        name: "beams",
        yaw: 0,
        elev: -0.04 + Math.random() * 0.08,
        dist: 30 + Math.random() * 10,
        fov: 60,
        lookAhead: 0,
        lookUp: 8 + Math.random() * 5,
        faceSun: true,
        duration: 20 + Math.random() * 14,
      };
    } else if (islandSide !== 0 && r < 0.6) {
      // camera on the far side of the plane, looking across it at the island
      s = {
        name: "island",
        yaw: islandSide * (1.05 + Math.random() * 0.45),
        elev: 0.08 + Math.random() * 0.1,
        dist: 38 + Math.random() * 12,
        fov: 50,
        lookAhead: 10,
        lookUp: 2,
        duration: 16 + Math.random() * 10,
      };
    } else if (cloudAhead > 0.35 && r < 0.75) {
      s = {
        name: "clouds",
        yaw: side * (0.2 + Math.random() * 0.25),
        elev: -0.03,
        dist: 30,
        fov: 62,
        lookAhead: 90,
        lookUp: 38,
        duration: 14 + Math.random() * 8,
      };
    } else if (low && r < 0.7) {
      s = {
        name: "low",
        yaw: side * (0.15 + Math.random() * 0.35),
        elev: 0.05,
        dist: 30,
        fov: 62,
        lookAhead: 55,
        lookUp: -7,
        duration: 18 + Math.random() * 12,
      };
    } else {
      const q = Math.random();
      if (q < 0.5) s = this.chase();
      else if (q < 0.64)
        s = {
          name: "front",
          yaw: side * (2.35 + Math.random() * 0.35),
          elev: 0.1,
          dist: 40,
          fov: 50,
          lookAhead: -8,
          lookUp: 2,
          duration: 9 + Math.random() * 5,
        };
      else if (q < 0.82)
        s = {
          name: "high",
          yaw: side * (0.3 + Math.random() * 0.3),
          elev: 0.55 + Math.random() * 0.2,
          dist: 62 + Math.random() * 20,
          fov: 55,
          lookAhead: 70,
          lookUp: -10,
          duration: 14 + Math.random() * 10,
        };
      else
        s = {
          name: "orbit",
          yaw: side * 0.4,
          elev: 0.14,
          dist: 44,
          fov: 52,
          lookAhead: 12,
          lookUp: 3,
          orbit: side * 0.05,
          duration: 22,
        };
    }
    this.shot = s;
    this.timer = s.duration;
    this.orbitAcc = 0;
    this.lookBiasTarget.set(0, 0, 0);
  }

  get shotName(): string {
    return this.mode === "cinema" ? this.cinema.shotName : this.shot.name;
  }

  update(dt: number) {
    if (this.photoActive) {
      this.updatePhoto();
      return;
    }
    if (this.mode === "cinema") {
      this.cinema.sunDir.copy(this.sunDir);
      this.cinema.beamMood = this.beamMood;
      this.cinema.update(dt, this.camera);
      this.followYaw = this.pilot.heading;
      return;
    }
    this.time += dt;
    this.idle += dt;
    this.timer -= dt;
    // inside a cloud, come close so the plane stays visible in the mist
    const inCloud =
      this.pilot.inCloud > 0.12 || (this.pilot.visitingCloud && this.pilot.inCloud > 0.02);
    if (inCloud && !this.wasInCloud) {
      this.shot = {
        name: "cloud",
        yaw: (Math.random() - 0.5) * 0.5,
        elev: 0.1,
        dist: 22,
        fov: 62,
        lookAhead: 30,
        lookUp: 3,
        duration: 999,
      };
      this.timer = 999;
    } else if (!inCloud && this.wasInCloud) {
      this.timer = 5 + Math.random() * 4;
    }
    this.wasInCloud = inCloud;
    if (this.timer <= 0) this.pickShot();

    const pl = this.pilot;
    const s = this.shot;
    if (s.orbit) this.orbitAcc += s.orbit * dt;

    // user offsets relax back after a few seconds of no input
    if (this.idle > 4) {
      this.userYaw = damp(this.userYaw, 0, 0.35, dt);
      this.userElev = damp(this.userElev, 0, 0.35, dt);
      this.userZoom = damp(this.userZoom, 1, 0.25, dt);
    }

    const hl = 3.2; // spring half-life: slow, cinematic transitions
    const yaw = this.yaw.update(s.yaw + this.orbitAcc, hl, dt);
    const elev = this.elev.update(s.elev, hl, dt);
    const dist = this.dist.update(s.dist, hl, dt) * this.userZoom;
    const fov = this.fov.update(s.fov, hl, dt);
    const lookAhead = this.lookAhead.update(s.lookAhead, hl, dt);
    const lookUp = this.lookUp.update(s.lookUp, hl, dt);

    // follow the plane's heading with lag, so turns swing the view gracefully
    this.followYaw = dampAngle(this.followYaw, pl.heading, 1.1, dt);
    this.followPitch = damp(this.followPitch, pl.pitch, 0.8, dt);

    if (s.faceSun) {
      // camera opposite the sun, so we look toward it past the plane
      const sunAz = Math.atan2(this.sunDir.x, this.sunDir.z);
      s.yaw = dampAngle(s.yaw, sunAz - this.followYaw, 0.8, dt);
    }
    const a = this.followYaw + Math.PI + yaw + this.userYaw;
    const e = THREE.MathUtils.clamp(elev + this.userElev + this.followPitch * 0.3, -0.35, 1.3);
    const breathe = wobble(this.time * 0.13, 5) * 0.8;
    const cam = this.camera;
    cam.position.set(
      pl.position.x + Math.sin(a) * Math.cos(e) * (dist + breathe),
      pl.position.y + Math.sin(e) * dist + 1.5,
      pl.position.z + Math.cos(a) * Math.cos(e) * (dist + breathe),
    );
    // never dip into the sea or a hillside
    const ground = Math.max(0, this.islands.heightAt(cam.position.x, cam.position.z));
    if (cam.position.y < ground + 4) cam.position.y = ground + 4;

    const fwdX = Math.sin(this.followYaw);
    const fwdZ = Math.cos(this.followYaw);
    this.lookBias.lerp(this.lookBiasTarget, 1 - Math.exp(-dt * 0.5));
    this.lookTarget.set(
      pl.position.x + fwdX * lookAhead + this.lookBias.x,
      pl.position.y + lookUp + this.lookBias.y,
      pl.position.z + fwdZ * lookAhead + this.lookBias.z,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(this.lookTarget);
    // a hint of the plane's bank in the camera
    cam.rotateZ(pl.roll * 0.18);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}
