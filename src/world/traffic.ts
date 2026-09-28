import * as THREE from "three";
import { buildPlane } from "./plane";
import type { NightLights } from "./nightLights";

/** Every few minutes another aircraft crosses far away: someone else is travelling too. */
export class AirTraffic {
  readonly group = new THREE.Group();
  private model = buildPlane();
  private active = false;
  private timer = 70 + Math.random() * 60;
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private life = 0;

  constructor(lights: NightLights) {
    this.model.group.scale.setScalar(1.0);
    this.model.group.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    this.group.add(this.model.group);
    this.group.visible = false;
    lights.addProvider((emit) => {
      if (!this.active) return;
      const blink = Math.sin(performance.now() * 0.006) > 0.7 ? 14 : 0;
      emit({
        x: this.pos.x,
        y: this.pos.y + 2.2,
        z: this.pos.z,
        r: 1,
        g: 0.2,
        b: 0.15,
        intensity: 4 + blink,
        size: 2,
        phase: -1,
      });
    });
  }

  update(dt: number, focus: THREE.Vector3, forward: THREE.Vector3) {
    if (!this.active) {
      this.timer -= dt;
      if (this.timer > 0) return;
      // appear ahead, off to one side, crossing the view
      const side = Math.random() < 0.5 ? -1 : 1;
      const right = new THREE.Vector3(-forward.z, 0, forward.x).normalize();
      const dist = 1600 + Math.random() * 2200;
      this.pos
        .copy(focus)
        .addScaledVector(forward, dist)
        .addScaledVector(right, side * dist * 0.9);
      this.pos.y = Math.max(160, focus.y + (Math.random() - 0.3) * 300);
      this.vel
        .copy(right)
        .multiplyScalar(-side)
        .addScaledVector(forward, (Math.random() - 0.5) * 0.8)
        .normalize()
        .multiplyScalar(48);
      this.active = true;
      this.life = 0;
      this.group.visible = true;
    }
    this.life += dt;
    this.pos.addScaledVector(this.vel, dt);
    const g = this.model.group;
    g.position.copy(this.pos);
    g.rotation.set(0, Math.atan2(this.vel.x, this.vel.z), Math.sin(this.life * 0.3) * 0.05, "YXZ");
    this.model.prop.rotation.z += dt * 60;
    if (this.life > 110 || this.pos.distanceTo(focus) > 9000) {
      this.active = false;
      this.group.visible = false;
      this.timer = 150 + Math.random() * 150;
    }
  }
}
