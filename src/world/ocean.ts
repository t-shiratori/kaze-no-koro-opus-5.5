import * as THREE from "three";
import { rng } from "../core/noise";
import { FullscreenPass } from "../render/fsq";
import { G, globalsFor } from "../render/globals";
import {
  DETAIL_COMPONENTS,
  MAX_BOATS,
  MAX_WAVES,
  OCEAN_FRAG,
  OCEAN_VERT,
  WAVE_DETAIL_FRAG,
} from "../render/shaders/ocean";

export interface WakeSource {
  x: number;
  z: number;
  heading: number;
  speed: number;
  wakeLength: number;
  beam: number;
  strength: number;
}

function radialGrid(
  rings: number,
  segments: number,
  r0: number,
  rMax: number,
): THREE.BufferGeometry {
  // find growth factor g so that the outermost ring lands on rMax
  let lo = 1.0001;
  let hi = 1.2;
  for (let i = 0; i < 60; i++) {
    const g = (lo + hi) / 2;
    const r = (r0 * (Math.pow(g, rings) - 1)) / (g - 1);
    if (r > rMax) hi = g;
    else lo = g;
  }
  const g = (lo + hi) / 2;
  const pos: number[] = [0, 0, 0];
  for (let i = 1; i <= rings; i++) {
    const r = (r0 * (Math.pow(g, i) - 1)) / (g - 1);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let i = 0; i < rings - 1; i++) {
    const a0 = 1 + i * segments;
    const b0 = 1 + (i + 1) * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      idx.push(a0 + s, a0 + s1, b0 + s);
      idx.push(a0 + s1, b0 + s1, b0 + s);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rMax);
  return geo;
}

export class Ocean {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private detailRT: THREE.WebGLRenderTarget;
  private detailPass: FullscreenPass;

  constructor(renderer: THREE.WebGLRenderer) {
    // ---- animated ripple detail texture ----
    this.detailRT = new THREE.WebGLRenderTarget(256, 256, {
      type: THREE.HalfFloatType,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    });
    this.detailRT.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const r = rng(1234);
    const makeComps = (maxN: number, slope: number, spread: number) => {
      const arr: THREE.Vector4[] = [];
      while (arr.length < DETAIL_COMPONENTS) {
        const mag = 1 + Math.pow(r(), 1.3) * (maxN - 1);
        const ang = (r() - 0.5) * 2 * spread + (r() < 0.12 ? Math.PI : 0);
        const nx = Math.round(Math.cos(ang) * mag);
        const ny = Math.round(Math.sin(ang) * mag);
        if (nx === 0 && ny === 0) continue;
        const n = Math.hypot(nx, ny);
        const dirW = Math.pow(Math.max(Math.cos(Math.atan2(ny, nx)), 0.15), 2);
        arr.push(new THREE.Vector4(nx, ny, (slope * dirW) / Math.pow(n, 0.3), r() * Math.PI * 2));
      }
      return arr;
    };
    this.detailPass = new FullscreenPass(WAVE_DETAIL_FRAG, {
      uTime: G.uTime,
      uCompA: { value: makeComps(24, 0.06, 1.45) },
      uCompB: { value: makeComps(20, 0.05, 1.35) },
      uTile: { value: new THREE.Vector2(19, 97) },
    });

    // ---- gerstner swell ----
    const waves: THREE.Vector4[] = [];
    const q: number[] = [];
    const spec: [number, number, number, number][] = [
      // wavelength, amplitude, direction(rad), steepness
      [131, 0.45, 0.35, 0.28],
      [83, 0.3, 0.95, 0.26],
      [52, 0.17, -0.3, 0.24],
      [36, 0.1, 1.45, 0.2],
    ];
    for (const [len, amp, dir, st] of spec) {
      const k = (Math.PI * 2) / len;
      waves.push(new THREE.Vector4(Math.cos(dir), Math.sin(dir), k, amp));
      q.push(st / (k * amp * MAX_WAVES));
    }

    const boatA: THREE.Vector4[] = [];
    const boatB: THREE.Vector4[] = [];
    for (let i = 0; i < MAX_BOATS; i++) {
      boatA.push(new THREE.Vector4());
      boatB.push(new THREE.Vector4());
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
      side: THREE.DoubleSide,
      uniforms: {
        ...globalsFor(
          "uTime",
          "uSunDir",
          "uSunColor",
          "uTrueSunDir",
          "uAmbZenith",
          "uAmbHorizon",
          "uNight",
          "uWind",
          "uCloudOffset",
          "uCloudCover",
          "uDeck",
          "uCloudShadow",
          "uCloudShadowFrame",
          "uHeightMap",
          "uHeightFrame",
          "uSkyLUT",
          "uWeather",
          "uNoise3D",
        ),
        uWaves: { value: waves },
        uWaveQ: { value: q },
        uOceanCenter: { value: new THREE.Vector3() },
        uDetail: { value: this.detailRT.texture },
        uDetailTile: { value: new THREE.Vector2(19, 97) },
        uBoatA: { value: boatA },
        uBoatB: { value: boatB },
        uBoatCount: { value: 0 },
        uSunDisk: { value: new THREE.Color() },
      },
    });

    this.mesh = new THREE.Mesh(radialGrid(220, 360, 0.9, 42000), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(renderer: THREE.WebGLRenderer, camera: THREE.Camera, wakes: WakeSource[]) {
    this.detailPass.render(renderer, this.detailRT);
    const c = this.material.uniforms.uOceanCenter.value as THREE.Vector3;
    c.set(camera.position.x, 0, camera.position.z);
    const A = this.material.uniforms.uBoatA.value as THREE.Vector4[];
    const B = this.material.uniforms.uBoatB.value as THREE.Vector4[];
    // nearest wakes first
    const sorted = wakes
      .map((w) => ({ w, d: Math.hypot(w.x - c.x, w.z - c.z) }))
      .toSorted((a, b) => a.d - b.d)
      .slice(0, MAX_BOATS);
    sorted.forEach(({ w }, i) => {
      A[i].set(w.x, w.z, w.heading, w.speed);
      B[i].set(w.wakeLength, w.beam, w.strength, 0);
    });
    this.material.uniforms.uBoatCount.value = sorted.length;
  }
}
