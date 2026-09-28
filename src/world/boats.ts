import * as THREE from "three";
import { wrapAngle } from "../core/math";
import { G } from "../render/globals";
import { makeBoatMesh, type BoatKind, type BoatModel } from "./boatModels";
import type { IslandManager } from "./islands/manager";
import type { NightLights } from "./nightLights";
import type { WakeSource } from "./ocean";

interface Boat {
  model: BoatModel;
  kind: BoatKind;
  x: number;
  z: number;
  heading: number;
  targetHeading: number;
  speed: number;
  wake: WakeSource;
  phase: number;
  steerTimer: number;
}

const SPEEDS: Record<BoatKind, [number, number]> = {
  sail: [3, 5.5],
  fishing: [2.5, 4.5],
  cargo: [6, 8],
  ferry: [8, 11],
};

const TARGET_COUNT = 11;
const DESPAWN = 15000;

export class BoatTraffic {
  readonly group = new THREE.Group();
  readonly boats: Boat[] = [];
  private seed = 1;

  constructor(
    private islands: IslandManager,
    lights: NightLights,
  ) {
    lights.addProvider((emit) => {
      for (const b of this.boats) {
        const L = b.model.userData.lights;
        const c = Math.cos(b.heading);
        const s = Math.sin(b.heading);
        for (let i = 0; i < L.length; i += 6) {
          const lx = L[i];
          const lz = L[i + 2];
          emit({
            x: b.x + lx * c - lz * s,
            y: L[i + 1] + b.model.position.y,
            z: b.z + lx * s + lz * c,
            r: L[i + 3],
            g: L[i + 4],
            b: L[i + 5],
            intensity: 7,
            size: b.kind === "cargo" || b.kind === "ferry" ? 2.2 : 1.5,
            phase: -1,
          });
        }
      }
    });
  }

  private isWater(x: number, z: number, margin = -6): boolean {
    return this.islands.heightAt(x, z) < margin;
  }

  private spawn(focus: THREE.Vector3, forward: THREE.Vector3, initial: boolean) {
    const r = () => {
      this.seed = (this.seed * 16807) % 2147483647;
      return this.seed / 2147483647;
    };
    for (let attempt = 0; attempt < 20; attempt++) {
      // prefer the sea ahead of the plane so encounters actually happen
      const ahead = r() < 0.65;
      const baseA = Math.atan2(forward.z, forward.x);
      const a = ahead ? baseA + (r() - 0.5) * 1.6 : r() * Math.PI * 2;
      const d = initial ? 900 + r() * 9000 : 6000 + r() * 6000;
      const x = focus.x + Math.cos(a) * d;
      const z = focus.z + Math.sin(a) * d;
      if (!this.isWater(x, z, -10)) continue;
      const roll = r();
      const kind: BoatKind =
        roll < 0.4 ? "sail" : roll < 0.68 ? "fishing" : roll < 0.85 ? "ferry" : "cargo";
      const model = makeBoatMesh(kind, Math.floor(r() * 1e6));
      const [s0, s1] = SPEEDS[kind];
      const speed = s0 + r() * (s1 - s0);
      const heading = r() * Math.PI * 2;
      const len = model.userData.length;
      const boat: Boat = {
        model,
        kind,
        x,
        z,
        heading,
        targetHeading: heading,
        speed,
        phase: r() * 10,
        steerTimer: 0,
        wake: {
          x,
          z,
          heading,
          speed,
          wakeLength: Math.min(650, speed * 45 + len * 2),
          beam: model.userData.beam * 0.9,
          strength: kind === "sail" ? 0.55 : kind === "fishing" ? 0.75 : 1,
        },
      };
      this.boats.push(boat);
      this.group.add(model);
      return;
    }
  }

  update(dt: number, focus: THREE.Vector3, forward: THREE.Vector3) {
    // population control
    for (let i = this.boats.length - 1; i >= 0; i--) {
      const b = this.boats[i];
      if (Math.hypot(b.x - focus.x, b.z - focus.z) > DESPAWN) {
        this.group.remove(b.model);
        this.boats.splice(i, 1);
      }
    }
    const initial = this.boats.length === 0;
    let spawnBudget = initial ? TARGET_COUNT : 1;
    while (this.boats.length < TARGET_COUNT && spawnBudget-- > 0)
      this.spawn(focus, forward, initial);

    const t = G.uTime.value;
    const wind = G.uWind.value;
    const windA = Math.atan2(wind.y, wind.x);
    for (const b of this.boats) {
      // steer around land: probe ahead and to the sides
      b.steerTimer -= dt;
      if (b.steerTimer <= 0) {
        b.steerTimer = 1.5;
        const probe = Math.max(220, b.model.userData.length * 4);
        const px = b.x + Math.cos(b.heading) * probe;
        const pz = b.z + Math.sin(b.heading) * probe;
        if (!this.isWater(px, pz)) {
          const left = this.isWater(
            b.x + Math.cos(b.heading + 0.7) * probe,
            b.z + Math.sin(b.heading + 0.7) * probe,
          );
          const right = this.isWater(
            b.x + Math.cos(b.heading - 0.7) * probe,
            b.z + Math.sin(b.heading - 0.7) * probe,
          );
          b.targetHeading = b.heading + (left && !right ? 0.9 : !left && right ? -0.9 : 1.6);
        } else if (Math.random() < 0.02) {
          b.targetHeading = b.heading + (Math.random() - 0.5) * 0.6;
        }
      }
      const turn = wrapAngle(b.targetHeading - b.heading);
      const maxTurn = (b.kind === "cargo" ? 0.03 : 0.08) * dt;
      b.heading += THREE.MathUtils.clamp(turn, -maxTurn, maxTurn);
      b.x += Math.cos(b.heading) * b.speed * dt;
      b.z += Math.sin(b.heading) * b.speed * dt;

      const m = b.model;
      const size = m.userData.length;
      const bob = Math.sin(t * (6 / Math.sqrt(size)) + b.phase);
      m.position.set(b.x, bob * 0.3 * Math.min(1, 12 / size) - 0.15, b.z);
      let heel = Math.sin(t * 0.7 + b.phase) * 0.02 * Math.min(1, 15 / size);
      if (b.kind === "sail" && m.userData.sail) {
        const rel = wrapAngle(windA - b.heading);
        heel += -Math.sign(rel) * 0.14 * Math.min(1, Math.abs(Math.sin(rel)) + 0.3);
        m.userData.sail.rotation.y = THREE.MathUtils.clamp(-rel * 0.5, -1.1, 1.1);
      }
      m.rotation.set(heel, -b.heading, Math.sin(t * 0.9 + b.phase) * 0.015, "YXZ");
      b.wake.x = b.x;
      b.wake.z = b.z;
      b.wake.heading = b.heading;
      b.wake.speed = b.speed;
    }
  }

  get wakes(): WakeSource[] {
    return this.boats.map((b) => b.wake);
  }
}
