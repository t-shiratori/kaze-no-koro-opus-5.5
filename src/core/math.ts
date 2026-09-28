import * as THREE from "three";

/** Frame-rate independent exponential smoothing factor. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const d = wrapAngle(target - current);
  return current + d * (1 - Math.exp(-lambda * dt));
}

export function dampVec3(v: THREE.Vector3, target: THREE.Vector3, lambda: number, dt: number) {
  const k = 1 - Math.exp(-lambda * dt);
  v.x += (target.x - v.x) * k;
  v.y += (target.y - v.y) * k;
  v.z += (target.z - v.z) * k;
  return v;
}

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Critically damped spring, keeps velocity for silky camera motion. */
export class Spring {
  value: number;
  velocity = 0;
  constructor(v = 0) {
    this.value = v;
  }
  update(target: number, halfLife: number, dt: number): number {
    const omega = ((2 * Math.LN2) / Math.max(halfLife, 1e-4)) * 1.2;
    const x = this.value - target;
    const exp = Math.exp(-omega * dt);
    const temp = (this.velocity + omega * x) * dt;
    this.velocity = (this.velocity - omega * temp) * exp;
    this.value = target + (x + temp) * exp;
    return this.value;
  }
}

export class SpringVec3 {
  x: Spring;
  y: Spring;
  z: Spring;
  readonly out = new THREE.Vector3();
  constructor(v = new THREE.Vector3()) {
    this.x = new Spring(v.x);
    this.y = new Spring(v.y);
    this.z = new Spring(v.z);
  }
  set(v: THREE.Vector3) {
    this.x.value = v.x;
    this.y.value = v.y;
    this.z.value = v.z;
    this.x.velocity = this.y.velocity = this.z.velocity = 0;
  }
  update(t: THREE.Vector3, halfLife: number, dt: number): THREE.Vector3 {
    this.out.set(
      this.x.update(t.x, halfLife, dt),
      this.y.update(t.y, halfLife, dt),
      this.z.update(t.z, halfLife, dt),
    );
    return this.out;
  }
}

/** 1D smooth noise for wander behaviours (sum of incommensurate sines). */
export function wobble(t: number, seed = 0): number {
  return (
    Math.sin(t * 1.0 + seed * 1.7) * 0.5 +
    Math.sin(t * 2.31 + seed * 3.1) * 0.28 +
    Math.sin(t * 4.87 + seed * 5.3) * 0.14 +
    Math.sin(t * 9.73 + seed * 0.7) * 0.08
  );
}
