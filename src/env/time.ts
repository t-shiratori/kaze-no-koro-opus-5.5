import * as THREE from "three";
import { smoothstep } from "../core/noise";

export type TimeMode = "auto" | "morning" | "noon" | "rays" | "evening" | "night";

export const TIME_PRESETS: Record<Exclude<TimeMode, "auto">, number> = {
  morning: 7.1,
  noon: 12.6,
  // a low morning sun behind a broken cloud deck: beams fall onto the sea
  rays: 7.7,
  evening: 17.62,
  night: 23.2,
};

const MAX_SUN_ELEVATION = THREE.MathUtils.degToRad(64);
const MAX_MOON_ELEVATION = THREE.MathUtils.degToRad(36);

/**
 * Time of day. In auto mode time flows continuously, lingering around golden hour
 * and hurrying a little through the deep night.
 */
export class TimeOfDay {
  hours: number;
  mode: TimeMode = "auto";
  private target: number | null = null;

  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();

  constructor(startHours = 9.2) {
    this.hours = startHours;
    this.computeDirections();
  }

  setMode(mode: TimeMode) {
    this.mode = mode;
    this.target = mode === "auto" ? null : TIME_PRESETS[mode];
  }

  /** Seconds of real time per in-world hour, depending on the moment of the day. */
  private secondsPerHour(h: number): number {
    const golden = Math.max(
      Math.exp(-Math.pow((h - 17.4) / 1.1, 2)),
      Math.exp(-Math.pow((h - 6.6) / 0.9, 2)),
    );
    const night = h > 20.2 || h < 4.6 ? 1 : 0;
    return 46 * (1 + golden * 0.9) * (night ? 0.55 : 1);
  }

  update(dt: number) {
    if (this.target !== null) {
      // travel forward in time towards the chosen moment, quickly but visibly
      let d = this.target - this.hours;
      if (d < 0) d += 24;
      if (d > 0.002) {
        const step = Math.min(d, Math.max(0.25, d * 1.6) * dt);
        this.hours = (this.hours + step) % 24;
      } else {
        this.hours = this.target;
      }
    } else {
      this.hours = (this.hours + dt / this.secondsPerHour(this.hours)) % 24;
    }
    this.computeDirections();
  }

  private computeDirections() {
    const th = ((this.hours - 6) / 12) * Math.PI;
    const se = MAX_SUN_ELEVATION;
    // +x east, +z south-ish, y up
    this.sunDir
      .set(Math.cos(th), Math.sin(th) * Math.sin(se), Math.sin(th) * Math.cos(se))
      .normalize();
    // the moon rises in the early evening and stays low enough to lay a path on the sea
    let mh = this.hours - 19.3;
    if (mh < -6) mh += 24;
    const mth = (mh / 12) * Math.PI;
    const me = MAX_MOON_ELEVATION;
    this.moonDir
      .set(Math.cos(mth), Math.sin(mth) * Math.sin(me) + 0.02, Math.sin(mth) * Math.cos(me) + 0.15)
      .normalize();
  }

  /** 0 in daylight, 1 in full night. */
  get night(): number {
    return 1 - smoothstep(-0.2, 0.02, this.sunDir.y);
  }
}
