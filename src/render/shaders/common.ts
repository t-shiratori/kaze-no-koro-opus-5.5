// Shared GLSL snippets. Everything is in world space, meters, y up.

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbmValue(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) { s += a * valueNoise(p); p = m * p * 2.03; a *= 0.5; }
  return s;
}
// interleaved gradient noise for dithering ray marches
float ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
`;

export const ATMOSPHERE_GLSL = /* glsl */ `
const float R_GROUND = 6360.0;
const float R_ATMO = 6420.0;
const vec3 BETA_R = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const float H_R = 8.0;
const float BETA_M = 2.4e-3;
const float BETA_M_EXT = 2.7e-3;
const float H_M = 1.25;
const vec3 BETA_O = vec3(0.65e-3, 1.881e-3, 0.085e-3);

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(-1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
float phaseRayleigh(float mu) { return 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu); }
float phaseMie(float mu, float g) {
  float gg = g * g;
  return 3.0 / (8.0 * 3.14159265) * ((1.0 - gg) * (1.0 + mu * mu)) /
         ((2.0 + gg) * pow(max(1.0 + gg - 2.0 * g * mu, 1e-4), 1.5));
}
float phaseHG(float mu, float g) {
  float gg = g * g;
  return (1.0 - gg) / (4.0 * 3.14159265 * pow(max(1.0 + gg - 2.0 * g * mu, 1e-4), 1.5));
}
`;

/** Sky-view LUT lookup: direction -> radiance. */
export const SKY_LUT_GLSL = /* glsl */ `
uniform sampler2D uSkyLUT;
vec2 skyLutUv(vec3 d) {
  float az = atan(d.z, d.x);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963);
  return vec2(az / 6.2831853 + 0.5, v);
}
vec3 skyLut(vec3 d) { return texture(uSkyLUT, skyLutUv(d)).rgb; }
`;

/** Globals shared by many shaders. Keep the names in sync with Globals in globals.ts. */
export const GLOBALS_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;       // dominant light (sun or moon)
uniform vec3 uSunColor;     // dominant light radiance
uniform vec3 uTrueSunDir;
uniform vec3 uAmbZenith;
uniform vec3 uAmbHorizon;
uniform float uNight;
uniform vec2 uWind;         // m/s
uniform vec2 uCloudOffset;  // accumulated cloud drift (m)
uniform sampler2D uCloudShadow;
uniform vec3 uCloudShadowFrame; // xz center, size
uniform sampler2D uHeightMap;
uniform vec3 uHeightFrame;      // xz center, size

float cloudShadowAt(vec3 p) {
  // project point onto ground along the light, shadow map stores ground transmittance
  vec2 g = p.xz - uSunDir.xz * (p.y / max(uSunDir.y, 0.05));
  vec2 uv = (g - uCloudShadowFrame.xy) / uCloudShadowFrame.z + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
  return texture(uCloudShadow, uv).r;
}
float terrainHeightAt(vec2 xz) {
  vec2 uv = (xz - uHeightFrame.xy) / uHeightFrame.z + 0.5;
  uv.y = 1.0 - uv.y; // the height camera looks down with -z as its up vector
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return -60.0;
  return texture(uHeightMap, uv).r;
}
`;

/** Cloud density field. Requires NOISE_GLSL + GLOBALS_GLSL. */
export const CLOUD_FIELD_GLSL = /* glsl */ `
uniform sampler2D uWeather;
uniform highp sampler3D uNoise3D;
uniform float uCloudCover;   // global cloudiness bias [0,1]
uniform float uDeck;         // strength of the broken stratocumulus deck [0,1]
const float CLOUD_BOTTOM = 620.0;
const float CLOUD_TOP = 4600.0;

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

// x: coverage [0,1], y: regional cloudiness, z: rain, w: base altitude
vec4 cloudWeather(vec2 xz) {
  vec2 p = xz + uCloudOffset;
  vec4 region = textureLod(uWeather, p / 110000.0 + vec2(0.37, 0.11), 0.0);
  float evolve = 0.5 + 0.5 * sin(uTime * 0.006);
  float c1 = textureLod(uWeather, p / 21000.0, 0.0).r;
  float c2 = textureLod(uWeather, (p + vec2(7300.0, -2100.0)) / 16500.0 + vec2(0.5, 0.2), 0.0).r;
  float cov = mix(c1, c2, evolve * 0.6);
  float cloudiness = clamp(region.g * 0.9 + uCloudCover - 0.5, 0.04, 0.9);
  // absolute margin above the threshold: small margins make small clouds
  float c = max(cov - (1.0 - cloudiness), 0.0);
  float rain = smoothstep(0.56, 0.74, region.b) * smoothstep(0.12, 0.3, c) * smoothstep(0.4, 0.62, region.g);
  float base = 1050.0 + (region.a - 0.5) * 500.0;
  return vec4(c, region.g, rain, base);
}

// local cloud top above the base for a given coverage: fat towers where coverage peaks
float cloudTop(vec4 w) {
  return 60.0 + 2600.0 * (0.4 + 0.6 * w.y) * pow(min(w.x, 0.6), 0.65);
}

// A broken stratocumulus deck whose gaps let sunbeams through (light-shaft mood).
const float DECK_BASE = 900.0;
float deckShape(vec3 p) {
  if (uDeck <= 0.001 || p.y < DECK_BASE - 80.0 || p.y > DECK_BASE + 900.0) return 0.0;
  vec2 q = p.xz + uCloudOffset * 0.9;
  float c1 = textureLod(uWeather, q / 9800.0 + vec2(0.13, 0.61), 0.0).r;
  float c2 = textureLod(uWeather, q / 3600.0 + vec2(0.57, 0.19), 0.0).r;
  float cov = c1 * 0.8 + c2 * 0.2;
  float c = cov - mix(1.05, 0.24, uDeck);
  if (c <= 0.0) return 0.0;
  // gently undulating base, thicker where the deck is solid
  float bv = textureLod(uWeather, q / 5200.0 + vec2(0.31, 0.83), 0.0).r;
  float base = DECK_BASE + (bv - 0.5) * 90.0 - min(c, 0.3) * 60.0;
  float top = base + 60.0 + 900.0 * sqrt(min(c, 0.5));
  float hn = (p.y - base) / (top - base);
  if (hn < 0.0 || hn > 1.0) return 0.0;
  float body = smoothstep(0.0, 0.1, hn) * (1.0 - smoothstep(0.5, 1.0, hn));
  return smoothstep(0.0, 0.22, c) * body;
}

float cloudDensity(vec3 p, vec4 w, bool detail) {
  float dens = 0.0;
  float y = p.y - w.w;
  if (w.x > 0.0 && y > 0.0) {
    float top = cloudTop(w);
    float hn = y / top;
    if (hn < 1.0) {
      // rounded dome profile: flat base, bulging body, domed crown
      float body = smoothstep(0.0, 0.07, hn) * (1.0 - smoothstep(0.55, 1.0, hn));
      float cov = smoothstep(0.0, 0.14, w.x);
      dens = cov * body - (1.0 - body) * 0.05;
    }
  }
  dens = max(dens, deckShape(p));
  if (dens <= 0.0) return 0.0;
  vec3 q = vec3(p.x + uCloudOffset.x, p.y - uTime * 1.3, p.z + uCloudOffset.y);
  vec4 n = textureLod(uNoise3D, q / 1500.0, 0.0);
  float baseN = clamp(((n.r * 0.55 + n.g * 0.3 + n.b * 0.15) - 0.5) / 0.26, 0.0, 1.0);
  dens = remap(dens, (1.0 - baseN) * 0.66, 1.0, 0.0, 1.0);
  if (detail && dens > 0.0) {
    // two octaves of billows; the finer one is bent by the coarser so edges curl
    vec4 d = textureLod(uNoise3D, q / 300.0 + vec3(0.0, uTime * 0.002, 0.0), 0.0);
    vec4 d2 = textureLod(uNoise3D, q / 95.0 + d.gba * 0.35, 0.0);
    float dn = clamp(((d.g * 0.55 + d.b * 0.3 + d.a * 0.15) - 0.3) / 0.37, 0.0, 1.0);
    float dn2 = clamp((d2.g - 0.25) / 0.45, 0.0, 1.0);
    dn = mix(dn, dn2, 0.35);
    dens = remap(dens, dn * 0.42, 1.0, 0.0, 1.0);
  }
  // crisper, more solid bodies with a thin soft rim
  return clamp(dens * 2.2, 0.0, 1.0);
}
`;
