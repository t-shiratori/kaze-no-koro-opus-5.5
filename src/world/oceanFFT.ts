import * as THREE from "three";
import { rng } from "../core/noise";
import { FullscreenPass } from "../render/fsq";
import { G } from "../render/globals";

// Tessendorf-style FFT ocean: a wind-wave spectrum is evolved in time and turned into
// slope maps with an inverse FFT on the GPU, every frame. Three cascades of different,
// incommensurate sizes cover long wind waves down to small ripples, so no single
// repeating tile is ever visible.

const N = 256;
const LOG2N = 8;

export interface Cascade {
  /** tile size in metres */
  size: number;
  /** wavelength band (m) carried by this cascade */
  lambdaMin: number;
  lambdaMax: number;
  /** target RMS slope of this band */
  slope: number;
}

export const CASCADES: Cascade[] = [
  { size: 71.3, lambdaMin: 5.2, lambdaMax: 34, slope: 0.075 },
  { size: 13.7, lambdaMin: 0.95, lambdaMax: 5.2, slope: 0.07 },
  { size: 3.31, lambdaMin: 0.12, lambdaMax: 0.95, slope: 0.05 },
];

const SPECTRUM_FRAG = /* glsl */ `
precision highp float;
out vec4 outColor;
uniform sampler2D uH0A;
uniform sampler2D uH0B;
uniform float uTime;
uniform float uSizeA;
uniform float uSizeB;
const float PI = 3.14159265;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
// Both slope fields are real, so they share one complex signal: sx + i*sz.
vec2 slopeSpectrum(sampler2D h0tex, float size, vec2 nm, ivec2 texel) {
  vec2 k = 2.0 * PI * nm / size;
  float w = sqrt(9.81 * max(length(k), 1e-6));
  vec4 h0 = texelFetch(h0tex, texel, 0);
  vec2 e = vec2(cos(w * uTime), sin(w * uTime));
  // h(k,t) = h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}  (keeps the field real)
  vec2 h = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
  vec2 sx = cmul(vec2(0.0, k.x), h);
  vec2 sz = cmul(vec2(0.0, k.y), h);
  return sx + cmul(vec2(0.0, 1.0), sz);
}
void main() {
  vec2 c = gl_FragCoord.xy - 0.5;
  vec2 nm = vec2(c.x < ${N / 2}.0 ? c.x : c.x - ${N}.0, c.y < ${N / 2}.0 ? c.y : c.y - ${N}.0);
  ivec2 t = ivec2(c);
  // two cascades per transform: one in .xy, one in .zw
  outColor = vec4(slopeSpectrum(uH0A, uSizeA, nm, t), slopeSpectrum(uH0B, uSizeB, nm, t));
}
`;

// One radix-2 Stockham stage of the inverse transform, along x or y.
const BUTTERFLY_FRAG = /* glsl */ `
precision highp float;
out vec4 outColor;
uniform sampler2D uSrc;
uniform float uSub;
uniform int uHoriz;
const float PI = 3.14159265;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main() {
  vec2 c = gl_FragCoord.xy - 0.5;
  float index = uHoriz == 1 ? c.x : c.y;
  float evenIndex = floor(index / uSub) * (uSub * 0.5) + mod(index, uSub * 0.5);
  ivec2 ie = uHoriz == 1 ? ivec2(int(evenIndex), int(c.y)) : ivec2(int(c.x), int(evenIndex));
  ivec2 io = uHoriz == 1 ? ivec2(int(evenIndex) + ${N / 2}, int(c.y)) : ivec2(int(c.x), int(evenIndex) + ${N / 2});
  vec4 even = texelFetch(uSrc, ie, 0);
  vec4 odd = texelFetch(uSrc, io, 0);
  float a = 2.0 * PI * index / uSub;
  vec2 tw = vec2(cos(a), sin(a));
  outColor = vec4(even.xy + cmul(tw, odd.xy), even.zw + cmul(tw, odd.zw));
}
`;

// Real parts are the slopes; written to a filterable, mipmapped texture.
const RESOLVE_FRAG = /* glsl */ `
precision highp float;
out vec4 outColor;
uniform sampler2D uSrc;
uniform int uHalf;
void main() {
  vec4 v = texelFetch(uSrc, ivec2(gl_FragCoord.xy - 0.5), 0);
  // real part = dh/dx, imaginary part = dh/dz
  outColor = vec4(uHalf == 0 ? v.xy : v.zw, 0.0, 1.0);
}
`;

function gaussian(r: () => number): number {
  const u = Math.max(r(), 1e-9);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Initial spectrum h0(k) for one cascade: a Phillips-like wind sea with directional spread. */
function initialSpectrum(c: Cascade, seed: number): Float32Array {
  const r = rng(seed);
  const wind = 8.5; // m/s
  const Lw = (wind * wind) / 9.81; // largest wave from this wind
  const kMin = (2 * Math.PI) / c.lambdaMax;
  const kMax = (2 * Math.PI) / c.lambdaMin;
  const re = new Float32Array(N * N);
  const im = new Float32Array(N * N);
  let slopeVar = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const n = i < N / 2 ? i : i - N;
      const m = j < N / 2 ? j : j - N;
      const kx = (2 * Math.PI * n) / c.size;
      const kz = (2 * Math.PI * m) / c.size;
      const k = Math.hypot(kx, kz);
      let p = 0;
      if (k >= kMin && k < kMax) {
        // wind along +x; a little energy also travels across and against it
        const cosT = kx / k;
        const spread = Math.pow(Math.abs(cosT), 2) * (cosT < 0 ? 0.25 : 1) + 0.04;
        p =
          (Math.exp(-1 / Math.pow(k * Lw, 2)) / k ** 4) * spread * Math.exp(-Math.pow(k * 0.02, 2));
      }
      const a = Math.sqrt(p / 2);
      const idx = j * N + i;
      re[idx] = gaussian(r) * a;
      im[idx] = gaussian(r) * a;
      slopeVar += 2 * k * k * (re[idx] ** 2 + im[idx] ** 2);
    }
  }
  const scale = slopeVar > 0 ? c.slope / Math.sqrt(slopeVar) : 0;
  const data = new Float32Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const mi = (N - i) % N;
      const mj = (N - j) % N;
      const midx = mj * N + mi;
      data[idx * 4] = re[idx] * scale;
      data[idx * 4 + 1] = im[idx] * scale;
      // conj(h0(-k))
      data[idx * 4 + 2] = re[midx] * scale;
      data[idx * 4 + 3] = -im[midx] * scale;
    }
  }
  return data;
}

function floatTarget() {
  return new THREE.WebGLRenderTarget(N, N, {
    type: THREE.FloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: false,
  });
}

export class OceanFFT {
  /** filterable slope maps, one per cascade: rg = (dh/dx, dh/dz) */
  readonly slopes: THREE.Texture[] = [];
  private h0: THREE.DataTexture[] = [];
  private outRT: THREE.WebGLRenderTarget[] = [];
  private ping = floatTarget();
  private pong = floatTarget();
  private spectrum: FullscreenPass;
  private butterfly: FullscreenPass;
  private resolve: FullscreenPass;

  constructor(renderer: THREE.WebGLRenderer) {
    this.spectrum = new FullscreenPass(SPECTRUM_FRAG, {
      uH0A: { value: null },
      uH0B: { value: null },
      uTime: G.uTime,
      uSizeA: { value: 1 },
      uSizeB: { value: 1 },
    });
    this.butterfly = new FullscreenPass(BUTTERFLY_FRAG, {
      uSrc: { value: null },
      uSub: { value: 2 },
      uHoriz: { value: 1 },
    });
    this.resolve = new FullscreenPass(RESOLVE_FRAG, { uSrc: { value: null }, uHalf: { value: 0 } });
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    CASCADES.forEach((c, i) => {
      const tex = new THREE.DataTexture(
        initialSpectrum(c, 101 + i * 37),
        N,
        N,
        THREE.RGBAFormat,
        THREE.FloatType,
      );
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      this.h0.push(tex);
      const out = new THREE.WebGLRenderTarget(N, N, {
        type: THREE.HalfFloatType,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
        depthBuffer: false,
      });
      out.texture.anisotropy = aniso;
      this.outRT.push(out);
      this.slopes.push(out.texture);
    });
  }

  update(renderer: THREE.WebGLRenderer) {
    // cascades go through the transform in pairs
    for (let c = 0; c < CASCADES.length; c += 2) {
      const b = Math.min(c + 1, CASCADES.length - 1);
      const su = this.spectrum.uniforms;
      su.uH0A.value = this.h0[c];
      su.uH0B.value = this.h0[b];
      su.uSizeA.value = CASCADES[c].size;
      su.uSizeB.value = CASCADES[b].size;
      this.spectrum.render(renderer, this.ping);
      let src = this.ping;
      let dst = this.pong;
      for (const horiz of [1, 0]) {
        for (let s = 1; s <= LOG2N; s++) {
          const bu = this.butterfly.uniforms;
          bu.uSrc.value = src.texture;
          bu.uSub.value = 1 << s;
          bu.uHoriz.value = horiz;
          this.butterfly.render(renderer, dst);
          [src, dst] = [dst, src];
        }
      }
      this.resolve.uniforms.uSrc.value = src.texture;
      this.resolve.uniforms.uHalf.value = 0;
      this.resolve.render(renderer, this.outRT[c]);
      if (b !== c) {
        this.resolve.uniforms.uHalf.value = 1;
        this.resolve.render(renderer, this.outRT[b]);
      }
    }
  }
}
