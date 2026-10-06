import * as THREE from "three";
import { FullscreenPass } from "../render/fsq";
import { G } from "../render/globals";
import { NOISE3D_FRAG, WEATHER_FRAG } from "../render/shaders/noisegen";
import { clamp, smoothstep } from "../core/noise";

const WEATHER_SIZE = 512;
const NOISE3D_SIZE = 64;

/**
 * Generates the tileable cloud noise textures on the GPU once, and keeps a CPU copy of the
 * weather map so that the flight director / camera can "see" clouds too.
 */
export class Weather {
  readonly weatherRT: THREE.WebGLRenderTarget;
  readonly noiseRT: THREE.WebGL3DRenderTarget;
  private cpu: Uint8Array;

  constructor(renderer: THREE.WebGLRenderer) {
    this.weatherRT = new THREE.WebGLRenderTarget(WEATHER_SIZE, WEATHER_SIZE, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    });
    const wp = new FullscreenPass(WEATHER_FRAG, {});
    wp.render(renderer, this.weatherRT);
    this.cpu = new Uint8Array(WEATHER_SIZE * WEATHER_SIZE * 4);
    renderer.readRenderTargetPixels(this.weatherRT, 0, 0, WEATHER_SIZE, WEATHER_SIZE, this.cpu);

    this.noiseRT = new THREE.WebGL3DRenderTarget(NOISE3D_SIZE, NOISE3D_SIZE, NOISE3D_SIZE, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
    });
    const tex = this.noiseRT.texture;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const np = new FullscreenPass(NOISE3D_FRAG, { uSlice: { value: 0 } });
    for (let z = 0; z < NOISE3D_SIZE; z++) {
      np.uniforms.uSlice.value = (z + 0.5) / NOISE3D_SIZE;
      renderer.setRenderTarget(this.noiseRT, z);
      renderer.render(np.mesh, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    }
    renderer.setRenderTarget(null);
    wp.material.dispose();
    np.material.dispose();

    G.uWeather.value = this.weatherRT.texture;
    G.uNoise3D.value = tex;
  }

  /** Bilinear repeat sample of the CPU weather copy. uv in texture space (repeating). */
  private sample(u: number, v: number, ch: number): number {
    const s = WEATHER_SIZE;
    const x = u * s - 0.5;
    const y = v * s - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (xi: number, yi: number) => {
      const xx = ((xi % s) + s) % s;
      const yy = ((yi % s) + s) % s;
      return this.cpu[(yy * s + xx) * 4 + ch] / 255;
    };
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  }

  /** CPU mirror of cloudWeather() in GLSL: [coverage, regional, rain, base]. */
  weatherAt(x: number, z: number, out: number[] = [0, 0, 0, 0]): number[] {
    const px = x + G.uCloudOffset.value.x;
    const pz = z + G.uCloudOffset.value.y;
    const t = G.uTime.value;
    const rg = this.sample(px / 110000 + 0.37, pz / 110000 + 0.11, 1);
    const rb = this.sample(px / 110000 + 0.37, pz / 110000 + 0.11, 2);
    const ra = this.sample(px / 110000 + 0.37, pz / 110000 + 0.11, 3);
    const evolve = 0.5 + 0.5 * Math.sin(t * 0.006);
    const c1 = this.sample(px / 21000, pz / 21000, 0);
    const c2 = this.sample((px + 7300) / 16500 + 0.5, (pz - 2100) / 16500 + 0.2, 0);
    const cov = c1 + (c2 - c1) * evolve * 0.6;
    const cloudiness = clamp(rg * 0.9 + G.uCloudCover.value - 0.5, 0.04, 0.9);
    const c = Math.max(cov - (1 - cloudiness), 0);
    const rain = smoothstep(0.56, 0.74, rb) * smoothstep(0.12, 0.3, c) * smoothstep(0.4, 0.62, rg);
    out[0] = c;
    out[1] = rg;
    out[2] = rain;
    out[3] = 1050 + (ra - 0.5) * 500;
    return out;
  }

  private tmp = [0, 0, 0, 0];

  /** Rough cloud "presence" at a point, [0,1]. Good enough for steering decisions. */
  cloudinessAt(x: number, y: number, z: number): number {
    const w = this.weatherAt(x, z, this.tmp);
    let d = 0;
    const bv =
      (this.sample(
        (x + G.uCloudOffset.value.x) / 2400 + 0.23,
        (z + G.uCloudOffset.value.y) / 2400 + 0.71,
        1,
      ) -
        0.5) *
      140;
    const yy = y - (w[3] + bv - Math.min(w[0], 0.4) * 120);
    if (yy > 0 && w[0] > 0) {
      const top = 120 + 1250 * (0.5 + 0.5 * w[1]) * Math.sqrt(Math.min(w[0], 0.6));
      const hn = yy / top;
      if (hn < 1) {
        const body = smoothstep(0, 0.22, hn) * Math.sqrt(clamp(1 - hn * hn, 0, 1));
        d = smoothstep(0, 0.3, w[0]) * body;
      }
    }
    d = Math.max(d, this.deckAt(x, y, z));
    return clamp(d, 0, 1);
  }

  /** CPU mirror of deckShape() in GLSL (without noise erosion). */
  deckAt(x: number, y: number, z: number): number {
    const deck = G.uDeck.value;
    if (deck <= 0.001 || y < 700 || y > 1800) return 0;
    const qx = x + G.uCloudOffset.value.x * 0.9;
    const qz = z + G.uCloudOffset.value.y * 0.9;
    const c1 = this.sample(qx / 4200 + 0.13, qz / 4200 + 0.61, 1);
    const c2 = this.sample(qx / 1900 + 0.57, qz / 1900 + 0.19, 2);
    const c = c1 * 0.8 + c2 * 0.2 - (1.05 + (0.45 - 1.05) * deck);
    if (c <= 0) return 0;
    const bv = this.sample(qx / 5200 + 0.31, qz / 5200 + 0.83, 1);
    const lump = this.sample(qx / 1900 + 0.66, qz / 1900 + 0.08, 1);
    const base =
      900 +
      (bv - 0.5) * 120 -
      smoothstep(0.3, 0.8, lump) * smoothstep(0, 0.3, c) * 150 -
      Math.min(c, 0.3) * 60;
    const top = base + 80 + 900 * Math.sqrt(Math.min(c, 0.5));
    const hn = (y - base) / (top - base);
    if (hn < 0 || hn > 1) return 0;
    return smoothstep(0, 0.1, c) * smoothstep(0, 0.25, hn) * (1 - smoothstep(0.5, 1, hn));
  }
}
