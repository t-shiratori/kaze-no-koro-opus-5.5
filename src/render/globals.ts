import * as THREE from "three";

/**
 * Uniforms shared (by reference) across every custom shader in the world, so that
 * light, wind, clouds and time stay coherent everywhere.
 */
export const G = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 1, 1) },
  uTrueSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
  uAmbZenith: { value: new THREE.Color(0.2, 0.3, 0.5) },
  uAmbHorizon: { value: new THREE.Color(0.3, 0.35, 0.45) },
  uNight: { value: 0 },
  uWind: { value: new THREE.Vector2(6, 2) },
  uCloudOffset: { value: new THREE.Vector2(0, 0) },
  uCloudCover: { value: 0.5 },
  uDeck: { value: 0 },
  uCirrus: { value: 0.5 },
  uShaftHaze: { value: 0.00004 },
  uCloudShadow: { value: null as THREE.Texture | null },
  uCloudShadowFrame: { value: new THREE.Vector3(0, 0, 24000) },
  uHeightMap: { value: null as THREE.Texture | null },
  uHeightFrame: { value: new THREE.Vector3(0, 0, 12000) },
  uSkyLUT: { value: null as THREE.Texture | null },
  uWeather: { value: null as THREE.Texture | null },
  uNoise3D: { value: null as THREE.Texture | null },
  uExposure: { value: 1 },
};

export type GlobalUniforms = typeof G;

/** Pick a subset of the globals (still shared by reference). */
export function globalsFor(...names: (keyof GlobalUniforms)[]): Record<string, THREE.IUniform> {
  const out: Record<string, THREE.IUniform> = {};
  for (const n of names) out[n] = G[n];
  return out;
}

export function allGlobals(): Record<string, THREE.IUniform> {
  return { ...G };
}
