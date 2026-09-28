import * as THREE from "three";
import { damp, wrapAngle, wobble } from "../core/math";
import type { Weather } from "../env/weather";
import type { IslandManager } from "../world/islands/manager";
import { G } from "../render/globals";

type Band = "low" | "mid" | "high";

interface Waypoint {
  x: number;
  z: number;
  /** island we are sightseeing, if any */
  islandId: string | null;
  side: number;
}

/**
 * A calm, curious pilot. Picks islands to pass alongside, varies altitude between
 * wave-skimming and cloud-base cruising, and never hurries.
 */
export class Autopilot {
  readonly position = new THREE.Vector3(0, 220, 0);
  readonly quaternion = new THREE.Quaternion();
  readonly forward = new THREE.Vector3(0, 0, 1);
  heading = 0.6; // forward = (sin h, 0, cos h)
  pitch = 0;
  roll = 0;
  speed = 52;
  turnRate = 0;
  verticalSpeed = 0;

  private waypoint: Waypoint | null = null;
  private visited: string[] = [];
  private band: Band = "mid";
  private bandAlt = 260;
  private bandTimer = 50;
  private gust = { t: 0, dur: 0, roll: 0, pitch: 0, next: 18 };
  private time = 0;
  private seed = Math.random() * 100;
  private terrainAhead = -60;
  private probeTimer = 0;
  /** a planned passage through a cloud: where and at which altitude */
  private cloudVisit: { alt: number; timer: number } | null = null;
  private nextCloudVisit = 45 + Math.random() * 40;
  private cloudHere = 0;
  /** set by the world when a cloud deck hangs low: stay below it to watch the beams */
  lowCeiling = false;

  constructor(
    private islands: IslandManager,
    private weather: Weather,
  ) {}

  get currentIsland(): string | null {
    return this.waypoint?.islandId ?? null;
  }

  get altitudeBand(): Band {
    return this.band;
  }

  /** 0..1, how deep in cloud the plane currently is */
  get inCloud(): number {
    return this.cloudHere;
  }

  get visitingCloud(): boolean {
    return this.cloudVisit !== null;
  }

  /** Look for a cloud ahead worth flying through; returns true if one was chosen. */
  private planCloudVisit(): boolean {
    const p = this.position;
    const tmp = [0, 0, 0, 0];
    let best: { x: number; z: number; alt: number; score: number } | null = null;
    for (let d = 1600; d <= 8000; d += 400) {
      for (let a = -0.6; a <= 0.61; a += 0.2) {
        const h = this.heading + a;
        const x = p.x + Math.sin(h) * d;
        const z = p.z + Math.cos(h) * d;
        const w = this.weather.weatherAt(x, z, tmp);
        for (const alt of [w[3] + 160, w[3] + 320, 1080]) {
          const c = this.weather.cloudinessAt(x, alt, z);
          if (c < 0.45 || this.islands.heightAt(x, z) > alt - 200) continue;
          // there must be room to climb (or descend) to it at a gentle rate
          const need = (Math.abs(alt - p.y) / 7) * this.speed * 1.1;
          if (d < need) continue;
          const score = c - d / 12000 - Math.abs(a) * 0.4;
          if (!best || score > best.score) best = { x, z, alt, score };
        }
      }
    }
    if (!best) {
      // nothing reachable: start climbing so the next look finds something
      if (this.band !== "high" && !this.lowCeiling) {
        this.band = "high";
        this.bandAlt = 800 + Math.random() * 250;
        this.bandTimer = 60;
      }
      return false;
    }
    // aim through the cloud and out the other side
    const h = Math.atan2(best.x - p.x, best.z - p.z);
    this.waypoint = {
      x: best.x + Math.sin(h) * 1800,
      z: best.z + Math.cos(h) * 1800,
      islandId: null,
      side: 0,
    };
    const dist = Math.hypot(best.x - p.x, best.z - p.z) + 1800;
    this.cloudVisit = { alt: best.alt, timer: dist / this.speed + 12 };
    return true;
  }

  private chooseWaypoint() {
    const p = this.position;
    const fwdA = Math.atan2(this.forward.x, this.forward.z);
    const cands = this.islands.near(p.x, p.z, 8500);
    let best: Waypoint | null = null;
    let bestScore = -Infinity;
    for (const isl of cands) {
      const s = isl.spec;
      const dx = s.x - p.x;
      const dz = s.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < s.extent + 600) continue;
      const bearing = Math.atan2(dx, dz);
      const off = Math.abs(wrapAngle(bearing - fwdA));
      if (off > 1.25) continue;
      const interest: Record<string, number> = {
        greenMountain: 1.2,
        villageCove: 1.3,
        whiteCliff: 1.2,
        lighthouse: 1.0,
        archipelago: 1.25,
        sandy: 1.15,
        tower: 1.0,
        pine: 0.9,
        longIsland: 1.0,
        reef: 0.6,
      };
      let score =
        interest[s.type] * 2 - off * 1.4 - Math.abs(d - 3500) / 3000 + Math.random() * 0.8;
      if (this.visited.includes(s.id)) score -= 3;
      if (score > bestScore) {
        bestScore = score;
        // pass alongside the coast, on the side that needs the least turning
        const toIsl = new THREE.Vector2(dx, dz).normalize();
        const perp = new THREE.Vector2(-toIsl.y, toIsl.x);
        const cross = Math.sin(wrapAngle(bearing - fwdA));
        const side = cross > 0 ? -1 : 1;
        const passDist = s.extent * 0.75 + 220 + Math.random() * 380;
        // archipelagos and shallow islands can be flown over
        const over =
          (s.type === "archipelago" || s.type === "sandy" || s.type === "reef") &&
          Math.random() < 0.45;
        const off2 = over ? (Math.random() - 0.5) * s.extent * 0.6 : passDist * side;
        best = { x: s.x + perp.x * off2, z: s.z + perp.y * off2, islandId: s.id, side };
      }
    }
    if (!best) {
      const a = fwdA + (Math.random() - 0.5) * 1.2;
      best = { x: p.x + Math.sin(a) * 4000, z: p.z + Math.cos(a) * 4000, islandId: null, side: 0 };
    }
    if (best.islandId) {
      this.visited.push(best.islandId);
      if (this.visited.length > 12) this.visited.shift();
    }
    this.waypoint = best;
  }

  private pickBand() {
    const r = Math.random();
    const prev = this.band;
    this.band = r < 0.34 ? "low" : r < 0.72 ? "mid" : "high";
    if (this.band === prev && Math.random() < 0.5) this.band = prev === "mid" ? "low" : "mid";
    this.bandAlt =
      this.band === "low"
        ? 45 + Math.random() * 70
        : this.band === "mid"
          ? 170 + Math.random() * 300
          : this.lowCeiling
            ? 380 + Math.random() * 260
            : 640 + Math.random() * 520;
    this.bandTimer = this.band === "high" ? 35 + Math.random() * 35 : 45 + Math.random() * 55;
  }

  update(dt: number) {
    this.time += dt;
    const p = this.position;

    // ---- navigation ----
    if (!this.waypoint) this.chooseWaypoint();
    const wp = this.waypoint!;
    const dx = wp.x - p.x;
    const dz = wp.z - p.z;
    const dist = Math.hypot(dx, dz);
    let desired = Math.atan2(dx, dz);
    const behind = Math.abs(wrapAngle(desired - this.heading)) > 1.9;
    if (dist < 350 || (behind && dist < 2500)) {
      this.chooseWaypoint();
      desired = this.heading;
    }
    // gentle meander so straight legs never feel robotic
    if (!this.cloudVisit) desired += wobble(this.time * 0.05, this.seed) * 0.25;

    // ---- terrain awareness ----
    this.probeTimer -= dt;
    if (this.probeTimer <= 0) {
      this.probeTimer = 0.25;
      let maxH = -60;
      let leftH = -60;
      let rightH = -60;
      for (const d of [150, 350, 650, 1000, 1500]) {
        for (const [a, which] of [
          [0, 0],
          [0.35, 1],
          [-0.35, 2],
        ] as const) {
          const h = this.islands.heightAt(
            p.x + Math.sin(this.heading + a) * d,
            p.z + Math.cos(this.heading + a) * d,
          );
          if (which === 0) maxH = Math.max(maxH, h);
          if (which === 1) leftH = Math.max(leftH, h);
          if (which === 2) rightH = Math.max(rightH, h);
        }
      }
      maxH = Math.max(maxH, this.islands.heightAt(p.x, p.z));
      this.terrainAhead = maxH;
      // if the hill ahead is taller than we can comfortably climb, steer around it
      if (maxH + 60 > p.y + 120) {
        const dir = leftH < rightH ? 1 : -1;
        this.waypoint = {
          x: p.x + Math.sin(this.heading + dir * 0.9) * 1500,
          z: p.z + Math.cos(this.heading + dir * 0.9) * 1500,
          islandId: wp.islandId,
          side: wp.side,
        };
      }
    }

    // ---- clouds: now and then, fly right into one ----
    this.cloudHere = this.weather.cloudinessAt(p.x, p.y, p.z);
    this.nextCloudVisit -= dt;
    if (this.nextCloudVisit <= 0 && !this.cloudVisit) {
      this.nextCloudVisit = this.planCloudVisit() ? 110 + Math.random() * 110 : 20;
    }
    if (this.cloudVisit) {
      this.cloudVisit.timer -= dt;
      if (this.cloudVisit.timer <= 0) {
        this.cloudVisit = null;
        this.pickBand();
      }
    }

    // ---- altitude ----
    this.bandTimer -= dt;
    if (this.bandTimer <= 0 && !this.cloudVisit) this.pickBand();
    let targetAlt =
      this.bandAlt + wobble(this.time * 0.03, this.seed + 3) * (this.band === "low" ? 12 : 60);
    if (this.cloudVisit) targetAlt = this.cloudVisit.alt;
    targetAlt = Math.max(targetAlt, this.terrainAhead + (this.band === "low" ? 45 : 80), 28);
    const altErr = targetAlt - p.y;
    const maxVs = this.cloudVisit ? 7 : this.band === "high" || altErr > 0 ? 5.5 : 4.5;
    const vsTarget = THREE.MathUtils.clamp(altErr * 0.05, -maxVs, maxVs);
    this.verticalSpeed = damp(this.verticalSpeed, vsTarget, 0.5, dt);

    // ---- turning: coordinated, unhurried ----
    const err = wrapAngle(desired - this.heading);
    const targetRate = THREE.MathUtils.clamp(err * 0.18, -0.075, 0.075);
    this.turnRate = damp(this.turnRate, targetRate, 0.7, dt);
    this.heading = wrapAngle(this.heading + this.turnRate * dt);

    // ---- air: gusts & turbulence from the shared wind ----
    const wind = G.uWind.value;
    const g = this.gust;
    g.next -= dt;
    if (g.next <= 0 && g.dur <= 0) {
      g.dur = 2.5 + Math.random() * 2.5;
      g.t = 0;
      g.roll = (Math.random() - 0.5) * 0.18;
      g.pitch = (Math.random() - 0.5) * 0.05;
      g.next = 15 + Math.random() * 35;
    }
    let gRoll = 0;
    let gPitch = 0;
    if (g.dur > 0) {
      g.t += dt;
      const k = Math.sin(Math.PI * Math.min(g.t / g.dur, 1));
      gRoll = g.roll * k * k;
      gPitch = g.pitch * k;
      if (g.t >= g.dur) g.dur = 0;
    }
    const cloud = this.weather.cloudinessAt(p.x, p.y, p.z);
    const lowTurb = p.y < 120 ? 0.4 : 0;
    const turb = 0.3 + Math.hypot(wind.x, wind.y) * 0.03 + cloud * 1.5 + lowTurb;
    const tRoll = wobble(this.time * 0.9, this.seed + 7) * 0.012 * turb;
    const tPitch = wobble(this.time * 1.1, this.seed + 11) * 0.006 * turb;
    const tHeave = wobble(this.time * 0.7, this.seed + 13) * 0.35 * turb;

    const bankTarget = Math.atan((this.speed * this.turnRate) / 9.81);
    this.roll = damp(this.roll, bankTarget + gRoll + tRoll, 1.6, dt);
    this.pitch = damp(
      this.pitch,
      Math.atan2(this.verticalSpeed, this.speed) + gPitch + tPitch + 0.02,
      1.4,
      dt,
    );
    this.speed = damp(
      this.speed,
      50 + wobble(this.time * 0.02, this.seed + 17) * 4 - this.verticalSpeed * 0.8,
      0.3,
      dt,
    );

    // ---- integrate ----
    this.forward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    p.x += this.forward.x * this.speed * dt + wind.x * 0.15 * dt;
    p.z += this.forward.z * this.speed * dt + wind.y * 0.15 * dt;
    p.y += this.verticalSpeed * dt + tHeave * dt;
    // hard safety floor
    const ground = this.islands.heightAt(p.x, p.z);
    if (p.y < Math.max(ground, 0) + 18) p.y = damp(p.y, Math.max(ground, 0) + 18, 4, dt);

    const e = new THREE.Euler(-this.pitch, this.heading, -this.roll, "YXZ");
    this.quaternion.setFromEuler(e);
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
  }
}
