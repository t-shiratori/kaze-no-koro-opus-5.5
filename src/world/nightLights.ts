import * as THREE from "three";
import { G } from "../render/globals";

const MAX = 4096;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aColor;   // rgb, intensity
attribute float aSize;   // world size (m)
attribute float aPhase;  // blinking / flicker seed, <0 = steady
uniform float uNight;
uniform float uTime;
uniform float uPixelScale;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  float px = aSize * uPixelScale / max(dist, 1.0);
  float flick = 1.0;
  if (aPhase >= 0.0) flick = 0.85 + 0.15 * sin(uTime * 7.0 + aPhase * 30.0) * sin(uTime * 3.1 + aPhase * 11.0);
  // distant lights stay a pixel or two and dim slightly instead of vanishing
  float size = max(px, 2.2);
  float energy = px < 2.2 ? pow(px / 2.2, 0.6) : 1.0;
  vColor = aColor.rgb * aColor.a * flick * energy * uNight;
  gl_PointSize = size;
  if (uNight < 0.01) gl_PointSize = 0.0;
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float a = exp(-r * r * 4.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
  #include <logdepthbuf_fragment>
}
`;

export interface LightPoint {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  intensity: number;
  size: number;
  phase: number;
}

/**
 * All the tiny lights that bring the night alive: windows, harbour lamps, lighthouses,
 * ship navigation lights. Rebuilt each frame from registered providers (cheap).
 */
export class NightLights {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 4);
  private size = new Float32Array(MAX);
  private phase = new Float32Array(MAX);
  private providers = new Set<(emit: (p: LightPoint) => void) => void>();
  readonly material: THREE.ShaderMaterial;

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      "aColor",
      new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      "aSize",
      new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage),
    );
    geo.setAttribute(
      "aPhase",
      new THREE.BufferAttribute(this.phase, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uNight: G.uNight, uTime: G.uTime, uPixelScale: { value: 800 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  addProvider(fn: (emit: (p: LightPoint) => void) => void) {
    this.providers.add(fn);
    return () => this.providers.delete(fn);
  }

  update(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    this.material.uniforms.uPixelScale.value =
      viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    if (G.uNight.value < 0.01) {
      this.points.geometry.setDrawRange(0, 0);
      return;
    }
    let n = 0;
    const emit = (p: LightPoint) => {
      if (n >= MAX) return;
      this.pos[n * 3] = p.x;
      this.pos[n * 3 + 1] = p.y;
      this.pos[n * 3 + 2] = p.z;
      this.col[n * 4] = p.r;
      this.col[n * 4 + 1] = p.g;
      this.col[n * 4 + 2] = p.b;
      this.col[n * 4 + 3] = p.intensity;
      this.size[n] = p.size;
      this.phase[n] = p.phase;
      n++;
    };
    for (const fn of this.providers) fn(emit);
    const g = this.points.geometry;
    for (const k of ["position", "aColor", "aSize", "aPhase"]) {
      const attr = g.attributes[k] as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    g.setDrawRange(0, n);
  }
}
