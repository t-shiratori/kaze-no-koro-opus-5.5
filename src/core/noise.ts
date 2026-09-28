// Deterministic CPU-side noise used for island generation, weather and gameplay queries.

export function hash2i(x: number, y: number, seed = 0): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hash3i(x: number, y: number, z: number, seed = 0): number {
  return hash2i(x ^ Math.imul(z | 0, 0x61c88647), y + Math.imul(z | 0, 0x2545f491), seed);
}

/** Small, fast seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function grad2(ix: number, iy: number, seed: number, x: number, y: number): number {
  const a = hash2i(ix, iy, seed) * Math.PI * 2;
  return Math.cos(a) * x + Math.sin(a) * y;
}

/** Gradient noise in roughly [-1, 1]. */
export function perlin2(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fade(fx);
  const v = fade(fy);
  const a = grad2(ix, iy, seed, fx, fy);
  const b = grad2(ix + 1, iy, seed, fx - 1, fy);
  const c = grad2(ix, iy + 1, seed, fx, fy - 1);
  const d = grad2(ix + 1, iy + 1, seed, fx - 1, fy - 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.41;
}

export function fbm2(
  x: number,
  y: number,
  octaves: number,
  seed = 0,
  lacunarity = 2.03,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += perlin2(x, y, seed + i * 17) * amp;
    norm += amp;
    amp *= gain;
    const nx = x * 0.8 - y * 0.6;
    y = (x * 0.6 + y * 0.8) * lacunarity;
    x = nx * lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal, [0,1]. */
export function ridged2(x: number, y: number, octaves: number, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(perlin2(x, y, seed + i * 31));
    n *= n;
    sum += n * amp * prev;
    norm += amp;
    prev = n;
    amp *= 0.5;
    const nx = x * 0.8 - y * 0.6;
    y = (x * 0.6 + y * 0.8) * 2.1;
    x = nx * 2.1;
  }
  return sum / norm;
}

/** Periodic 2D value/perlin noise for tileable textures. */
export function perlin2Periodic(x: number, y: number, period: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fade(fx);
  const v = fade(fy);
  const w = (i: number) => ((i % period) + period) % period;
  const a = grad2(w(ix), w(iy), seed, fx, fy);
  const b = grad2(w(ix + 1), w(iy), seed, fx - 1, fy);
  const c = grad2(w(ix), w(iy + 1), seed, fx, fy - 1);
  const d = grad2(w(ix + 1), w(iy + 1), seed, fx - 1, fy - 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.41;
}

/** Tileable Worley (F1) noise in 2D, returns distance in [0, ~1]. */
export function worley2Periodic(x: number, y: number, period: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i;
      const cy = iy + j;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      const px = cx + hash2i(wx, wy, seed);
      const py = cy + hash2i(wx, wy, seed + 101);
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** Tileable Worley (F1) noise in 3D. */
export function worley3Periodic(x: number, y: number, z: number, period: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  let best = 9;
  for (let k = -1; k <= 1; k++) {
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = ix + i;
        const cy = iy + j;
        const cz = iz + k;
        const wx = ((cx % period) + period) % period;
        const wy = ((cy % period) + period) % period;
        const wz = ((cz % period) + period) % period;
        const dx = cx + hash3i(wx, wy, wz, seed) - x;
        const dy = cy + hash3i(wx, wy, wz, seed + 7) - y;
        const dz = cz + hash3i(wx, wy, wz, seed + 13) - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
    }
  }
  return Math.sqrt(best);
}

function grad3(ix: number, iy: number, iz: number, seed: number, x: number, y: number, z: number) {
  const h = hash3i(ix, iy, iz, seed);
  const th = h * Math.PI * 2;
  const cz = hash3i(ix, iy, iz, seed + 3) * 2 - 1;
  const s = Math.sqrt(1 - cz * cz);
  return Math.cos(th) * s * x + Math.sin(th) * s * y + cz * z;
}

export function perlin3Periodic(x: number, y: number, z: number, period: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const p = (i: number) => ((i % period) + period) % period;
  const g = (a: number, b: number, c: number) =>
    grad3(p(ix + a), p(iy + b), p(iz + c), seed, fx - a, fy - b, fz - c);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const x00 = lerp(g(0, 0, 0), g(1, 0, 0), u);
  const x10 = lerp(g(0, 1, 0), g(1, 1, 0), u);
  const x01 = lerp(g(0, 0, 1), g(1, 0, 1), u);
  const x11 = lerp(g(0, 1, 1), g(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 1.2;
}

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const saturate = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
