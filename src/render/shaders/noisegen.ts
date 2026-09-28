// One-off GPU generators for tileable noise textures.

const TILE_NOISE = /* glsl */ `
vec3 hash33t(vec3 p) {
  p = fract(p * vec3(.1031, .1030, .0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float worley3(vec3 x, float period) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  float best = 9.0;
  for (int k = -1; k <= 1; k++)
  for (int j = -1; j <= 1; j++)
  for (int n = -1; n <= 1; n++) {
    vec3 c = vec3(n, j, k);
    vec3 cell = mod(i + c, period);
    vec3 o = hash33t(cell + 17.0);
    vec3 d = c + o - f;
    best = min(best, dot(d, d));
  }
  return sqrt(best);
}
float grad3(vec3 cell, vec3 f) {
  vec3 g = hash33t(cell * 1.37 + 5.0) * 2.0 - 1.0;
  return dot(normalize(g + 1e-4), f);
}
float perlin3(vec3 x, float period) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float r[8];
  for (int c = 0; c < 8; c++) {
    vec3 o = vec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    r[c] = grad3(mod(i + o, period), f - o);
  }
  return mix(mix(mix(r[0], r[1], u.x), mix(r[2], r[3], u.x), u.y),
             mix(mix(r[4], r[5], u.x), mix(r[6], r[7], u.x), u.y), u.z);
}
float worleyFbm3(vec3 p, float freq) {
  return (1.0 - worley3(p * freq, freq)) * 0.625 +
         (1.0 - worley3(p * freq * 2.0, freq * 2.0)) * 0.25 +
         (1.0 - worley3(p * freq * 4.0, freq * 4.0)) * 0.125;
}
float perlinFbm3(vec3 p, float freq) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 5; i++) {
    s += perlin3(p * freq, freq) * a;
    n += a; a *= 0.5; freq *= 2.0;
  }
  return s / n;
}
`;

export const NOISE3D_FRAG = /* glsl */ `
precision highp float;
uniform float uSlice;
in vec2 vUv;
out vec4 outColor;
${TILE_NOISE}
float remapN(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
void main() {
  vec3 p = vec3(vUv, uSlice);
  float pf = perlinFbm3(p, 4.0) * 0.5 + 0.5;
  float wf = worleyFbm3(p, 4.0);
  // Perlin-Worley: billowy but connected
  float pw = clamp(remapN(pf, 0.0, 1.0, wf, 1.0), 0.0, 1.0);
  float g = worleyFbm3(p, 8.0);
  float b = worleyFbm3(p, 16.0);
  float a = worleyFbm3(p, 32.0);
  outColor = vec4(pw, g, b, a);
}
`;

export const WEATHER_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
${TILE_NOISE}
float perlinFbm2(vec2 p, float freq, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += perlin3(vec3(p * freq, 0.5), freq) * a;
    n += a; a *= 0.5; freq *= 2.0;
  }
  return s / n;
}
float worley2(vec2 p, float freq) { return worley3(vec3(p * freq, 0.37), freq); }
void main() {
  vec2 p = vUv;
  // R: cumulus coverage - irregular clusters of lumpy cells of many sizes
  float cells = pow(clamp(1.0 - worley2(p, 13.0), 0.0, 1.0), 1.3);
  float small = pow(clamp(1.0 - worley2(p + 0.21, 29.0), 0.0, 1.0), 1.5);
  float fb = perlinFbm2(p, 5.0, 5) * 0.5 + 0.5;
  float cluster = smoothstep(0.3, 0.75, perlinFbm2(p + 0.47, 3.0, 3) * 0.5 + 0.5);
  float cov = clamp((fb * 0.62 + cells * 0.3 * (0.5 + cluster) + small * 0.14 - 0.08 - 0.28) / 0.34, 0.0, 1.0);
  // G: regional cloudiness, B: rain likelihood, A: fine puffs / gusts
  float region = clamp(perlinFbm2(p + 0.31, 3.0, 4) * 0.9 + 0.5, 0.0, 1.0);
  float rain = clamp(perlinFbm2(p + 0.77, 4.0, 3) * 1.1 + 0.5, 0.0, 1.0);
  float puffs = pow(clamp(1.0 - worley2(p + 0.5, 28.0), 0.0, 1.0), 2.0) * 0.8 +
                (perlinFbm2(p + 0.9, 16.0, 3) * 0.5 + 0.5) * 0.35;
  outColor = vec4(cov, region, rain, clamp(puffs, 0.0, 1.0));
}
`;
