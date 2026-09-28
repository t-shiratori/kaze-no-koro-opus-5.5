import * as THREE from "three";

// A small single-scattering atmosphere model evaluated on the CPU for a handful of
// directions per frame. The GPU sky-view LUT (shaders/sky.ts) uses the same constants.

export const ATMO = {
  groundRadius: 6360,
  atmoRadius: 6420,
  rayleigh: [5.802e-3, 13.558e-3, 33.1e-3] as const,
  rayleighH: 8.0,
  mie: 2.4e-3,
  mieExt: 2.7e-3,
  mieH: 1.25,
  ozone: [0.65e-3, 1.881e-3, 0.085e-3] as const,
  sunIntensity: 22,
  moonIntensity: 0.075,
};

function raySphere(ro: THREE.Vector3, rd: THREE.Vector3, r: number): number {
  const b = ro.dot(rd);
  const c = ro.lengthSq() - r * r;
  const d = b * b - c;
  if (d < 0) return -1;
  return -b + Math.sqrt(d);
}

const _p = new THREE.Vector3();
const _o = new THREE.Vector3();

/** Transmittance from a point at altitude `altKm` towards direction `dir`. */
export function transmittance(altKm: number, dir: THREE.Vector3, out: THREE.Color): THREE.Color {
  _o.set(0, ATMO.groundRadius + altKm, 0);
  const tMax = raySphere(_o, dir, ATMO.atmoRadius);
  // ground hit -> sun hidden, but soften with a small angular band for twilight glow
  const b = _o.dot(dir);
  const c = _o.lengthSq() - ATMO.groundRadius * ATMO.groundRadius;
  const hitsGround = b < 0 && b * b - c > 0;
  const steps = 24;
  const dt = tMax / steps;
  let odR = 0;
  let odM = 0;
  let odO = 0;
  for (let i = 0; i < steps; i++) {
    _p.copy(dir)
      .multiplyScalar((i + 0.5) * dt)
      .add(_o);
    const h = _p.length() - ATMO.groundRadius;
    odR += Math.exp(-h / ATMO.rayleighH) * dt;
    odM += Math.exp(-h / ATMO.mieH) * dt;
    odO += Math.max(0, 1 - Math.abs(h - 25) / 15) * dt;
  }
  const t = (k: number) =>
    Math.exp(-(ATMO.rayleigh[k] * odR + ATMO.mieExt * odM + ATMO.ozone[k] * odO));
  out.setRGB(t(0), t(1), t(2));
  if (hitsGround) {
    const depth = Math.sqrt(Math.max(0, b * b - c));
    out.multiplyScalar(Math.exp(-depth * 0.6));
  }
  return out;
}

const _sun = new THREE.Color();
const _tv = new THREE.Color();
const _ts = new THREE.Color();
const _q = new THREE.Vector3();
const _o2 = new THREE.Vector3();

/** Single scattered sky radiance seen from altitude `altKm` towards `dir` (cheap, for ambient). */
export function skyRadiance(
  altKm: number,
  dir: THREE.Vector3,
  lightDir: THREE.Vector3,
  intensity: number,
  out: THREE.Color,
): THREE.Color {
  _o2.set(0, ATMO.groundRadius + altKm, 0);
  const tMax = raySphere(_o2, dir, ATMO.atmoRadius);
  const steps = 10;
  const dt = tMax / steps;
  const mu = dir.dot(lightDir);
  const pr = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = 0.76;
  const pm =
    ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) /
    ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));
  let r = 0;
  let gg = 0;
  let bb = 0;
  let odR = 0;
  let odM = 0;
  for (let i = 0; i < steps; i++) {
    _q.copy(dir)
      .multiplyScalar((i + 0.5) * dt)
      .add(_o2);
    const h = _q.length() - ATMO.groundRadius;
    const dR = Math.exp(-h / ATMO.rayleighH);
    const dM = Math.exp(-h / ATMO.mieH);
    odR += dR * dt * 0.5;
    odM += dM * dt * 0.5;
    _tv.setRGB(
      Math.exp(-(ATMO.rayleigh[0] * odR + ATMO.mieExt * odM)),
      Math.exp(-(ATMO.rayleigh[1] * odR + ATMO.mieExt * odM)),
      Math.exp(-(ATMO.rayleigh[2] * odR + ATMO.mieExt * odM)),
    );
    transmittance(h, lightDir, _ts);
    for (let k = 0; k < 3; k++) {
      const s = (ATMO.rayleigh[k] * dR * (pr + 0.02) + ATMO.mie * dM * pm) * dt;
      const v = s * (k === 0 ? _tv.r * _ts.r : k === 1 ? _tv.g * _ts.g : _tv.b * _ts.b);
      if (k === 0) r += v;
      else if (k === 1) gg += v;
      else bb += v;
    }
    odR += dR * dt * 0.5;
    odM += dM * dt * 0.5;
  }
  return out.setRGB(r * intensity, gg * intensity, bb * intensity);
}

export interface LightingState {
  /** direction of the dominant light (sun, or moon at night) */
  mainDir: THREE.Vector3;
  /** radiance-scaled color of the dominant light arriving at sea level */
  mainColor: THREE.Color;
  /** sky irradiance approximations */
  skyZenith: THREE.Color;
  skyHorizon: THREE.Color;
  /** sun color alone, used for sun disk & glints */
  sunColor: THREE.Color;
  moonColor: THREE.Color;
  /** artistic warmth applied to low sunlight (golden hour) */
  sunTint: THREE.Color;
  exposure: number;
}

/** A little more gold than physics gives, as the sun nears the horizon. */
export function sunTint(y: number, out: THREE.Color): THREE.Color {
  const k = THREE.MathUtils.smoothstep(y, 0.02, 0.38);
  return out.setRGB(1.0, 0.8 + 0.2 * k, 0.58 + 0.42 * k);
}

const _dir = new THREE.Vector3();
const _c = new THREE.Color();

export function computeLighting(sunDir: THREE.Vector3, moonDir: THREE.Vector3, st: LightingState) {
  transmittance(0.2, sunDir, _sun);
  sunTint(sunDir.y, st.sunTint);
  st.sunColor.copy(_sun).multiply(st.sunTint).multiplyScalar(ATMO.sunIntensity);
  const moonT = transmittance(0.2, moonDir, new THREE.Color());
  st.moonColor
    .setRGB(0.62, 0.74, 1.0)
    .multiply(moonT)
    .multiplyScalar(ATMO.moonIntensity * 1.6 * THREE.MathUtils.smoothstep(moonDir.y, -0.05, 0.1));

  const sunVis = THREE.MathUtils.smoothstep(sunDir.y, -0.04, 0.05);
  // crossfade the main light between sun and moon
  if (sunDir.y > -0.02) {
    st.mainDir.copy(sunDir);
    if (st.mainDir.y < 0.02) st.mainDir.y = 0.02;
    st.mainDir.normalize();
    st.mainColor.copy(st.sunColor).multiplyScalar(sunVis);
    const moonMix = 1 - sunVis;
    if (moonMix > 0) st.mainColor.add(_c.copy(st.moonColor).multiplyScalar(moonMix));
  } else {
    st.mainDir.copy(moonDir);
    if (st.mainDir.y < 0.05) st.mainDir.y = 0.05;
    st.mainDir.normalize();
    st.mainColor.copy(st.moonColor);
  }

  // ambient: sample sky in a few directions (sun + moon contributions)
  st.skyZenith.setRGB(0, 0, 0);
  st.skyHorizon.setRGB(0, 0, 0);
  const acc = (target: THREE.Color, d: THREE.Vector3, w: number) => {
    skyRadiance(0.3, d, sunDir, ATMO.sunIntensity, _c);
    target.add(_c.multiplyScalar(w));
    if (moonDir.y > -0.1) {
      skyRadiance(0.3, d, moonDir, ATMO.moonIntensity * 1.6, _c);
      _c.r *= 0.7;
      _c.g *= 0.85;
      target.add(_c.multiplyScalar(w));
    }
  };
  acc(st.skyZenith, _dir.set(0, 1, 0), 0.5);
  acc(st.skyZenith, _dir.set(0.5, 0.7, 0.5).normalize(), 0.25);
  acc(st.skyZenith, _dir.set(-0.5, 0.7, -0.5).normalize(), 0.25);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    acc(st.skyHorizon, _dir.set(Math.cos(a), 0.08, Math.sin(a)).normalize(), 0.25);
  }
  // night floor: never pitch black, a deep blue glow
  const nightFloor = new THREE.Color(0.0045, 0.008, 0.02);
  st.skyZenith.add(nightFloor);
  st.skyHorizon.add(nightFloor);

  // exposure: map the brightness of the scene to a pleasant range; night is kept darker
  const lum = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  const sceneLum =
    lum(st.mainColor) * Math.max(0.15, st.mainDir.y) * 0.35 + lum(st.skyZenith) * 3.0;
  st.exposure = THREE.MathUtils.clamp(1.38 / Math.pow(sceneLum, 0.5), 0.05, 12);
}

export function createLightingState(): LightingState {
  return {
    mainDir: new THREE.Vector3(0, 1, 0),
    mainColor: new THREE.Color(),
    skyZenith: new THREE.Color(),
    skyHorizon: new THREE.Color(),
    sunColor: new THREE.Color(),
    moonColor: new THREE.Color(),
    sunTint: new THREE.Color(1, 1, 1),
    exposure: 1,
  };
}
