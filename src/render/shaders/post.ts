import { ATMOSPHERE_GLSL, GLOBALS_GLSL, NOISE_GLSL, SKY_LUT_GLSL } from "./common";

/** Scene + aerial perspective + clouds, all in HDR. */
export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
${NOISE_GLSL}
${ATMOSPHERE_GLSL}
${SKY_LUT_GLSL}
${GLOBALS_GLSL}
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform sampler2D uCloud;
uniform sampler2D uCloudAux;
uniform vec2 uCloudTexel;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uLogDepthFC;
uniform float uFogDensity;
uniform float uShaft;
uniform float uDeck;

float linearDepth(float d) { return exp2(d * uLogDepthFC) - 1.0; }
vec3 viewRay(vec2 uv) {
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 v = normalize(p.xyz / p.w);
  return normalize((uCamWorld * vec4(v, 0.0)).xyz);
}

// optical depth of an exponential height fog along a ray
float fogOD(vec3 ro, vec3 rd, float d, float H) {
  float a = exp(-max(ro.y, 0.0) / H);
  float k = rd.y / H;
  if (abs(k) < 1e-5) return a * d;
  return a * (1.0 - exp(-k * d)) / k;
}

void main() {
  vec3 rd = viewRay(vUv);
  vec3 camFwd = normalize((uCamWorld * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
  float draw = texture(uDepth, vUv).r;
  bool sky = draw >= 0.99999;
  float dist = sky ? 1e6 : linearDepth(draw) / max(dot(rd, camFwd), 1e-3);
  float distKm = dist / 1000.0;

  // ---- depth-aware upsampling of the half-res volumetrics ----
  vec2 base = vUv / uCloudTexel - 0.5;
  vec2 f = fract(base);
  vec2 c0 = (floor(base) + 0.5) * uCloudTexel;
  vec4 cl = vec4(0.0);
  vec4 ax = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 uv = c0 + vec2(i, j) * uCloudTexel;
      vec4 a = texture(uCloudAux, uv);
      float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
      float dd = abs(a.b - min(distKm, 1000.0)) / max(min(distKm, 1000.0), 0.05);
      float w = bw * (1.0 / (1e-3 + dd * 8.0)) + 1e-5;
      cl += texture(uCloud, uv) * w;
      ax += a * w;
      wsum += w;
    }
  }
  cl /= wsum;
  ax /= wsum;
  float sunVis = ax.r;
  float cloudDist = ax.g * 1000.0;

  vec3 L = uSunDir;
  float mu = dot(rd, L);
  // fog colour: the horizon sky in this direction, plus sunlit haze shafts
  vec3 hd = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.35 + 0.015, rd.z));
  // under a cloud deck the air is lit by grey cloud light, not the open sky
  vec3 fogAmb = skyLut(hd) * 0.92 * (1.0 - uDeck * 0.6);
  vec3 sunHaze = uSunColor * (phaseHG(mu, 0.8) * 0.35 + 0.03) * 0.25;
  // sharpen the averaged visibility so shafts read as distinct beams
  float sv = smoothstep(0.28, 0.8, sunVis);
  vec3 fogCol = fogAmb + sunHaze * mix(0.15 * (1.0 - uDeck * 0.8), 1.0, sv);

  const float H = 1100.0;
  vec3 ext = vec3(0.85, 0.95, 1.12) * uFogDensity;
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 sceneF = scene;
  if (!sky) {
    float od = fogOD(uCamPos, rd, dist, H);
    vec3 T = exp(-ext * od);
    sceneF = scene * T + fogCol * (1.0 - T);
  }

  // clouds, fogged at their own depth
  vec3 Tc = exp(-ext * fogOD(uCamPos, rd, cloudDist, H * 1.6));
  vec3 cloudF = cl.rgb * Tc + (1.0 - cl.a) * fogCol * (1.0 - Tc);
  vec3 col = sceneF * cl.a + cloudF;

  // sunbeams through gaps in the clouds (integrated in the volumetric pass)
  float beam = ax.a * uShaft;
  col += uSunColor * 0.045 * beam / (1.0 + beam * 0.025);

  outColor = vec4(max(col, 0.0), 1.0);
}
`;

export const BLOOM_PREFILTER_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uExposure;
uniform float uThreshold;
void main() {
  vec3 c = vec3(0.0);
  c += texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25 * uExposure;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + 0.5, 0.0, 1.0);
  soft = soft * soft * 0.5;
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  outColor = vec4(min(c * contrib, vec3(60.0)), 1.0);
}
`;

export const BLOOM_DOWN_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec3 a = texture(uSrc, vUv + uTexel * vec2(-2.0, 2.0)).rgb;
  vec3 b = texture(uSrc, vUv + uTexel * vec2(0.0, 2.0)).rgb;
  vec3 c = texture(uSrc, vUv + uTexel * vec2(2.0, 2.0)).rgb;
  vec3 d = texture(uSrc, vUv + uTexel * vec2(-2.0, 0.0)).rgb;
  vec3 e = texture(uSrc, vUv).rgb;
  vec3 f = texture(uSrc, vUv + uTexel * vec2(2.0, 0.0)).rgb;
  vec3 g = texture(uSrc, vUv + uTexel * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uSrc, vUv + uTexel * vec2(0.0, -2.0)).rgb;
  vec3 i = texture(uSrc, vUv + uTexel * vec2(2.0, -2.0)).rgb;
  vec3 j = texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  vec3 k = texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  vec3 l = texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  outColor = vec4(o, 1.0);
}
`;

export const BLOOM_UP_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;   // lower (smaller) level
uniform sampler2D uBase;  // current level
uniform vec2 uTexel;      // texel of uSrc
uniform float uRadius;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture(uSrc, vUv + vec2(-t.x, t.y)).rgb + texture(uSrc, vUv + vec2(0.0, t.y)).rgb * 2.0 +
           texture(uSrc, vUv + vec2(t.x, t.y)).rgb + texture(uSrc, vUv + vec2(-t.x, 0.0)).rgb * 2.0 +
           texture(uSrc, vUv).rgb * 4.0 + texture(uSrc, vUv + vec2(t.x, 0.0)).rgb * 2.0 +
           texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(0.0, -t.y)).rgb * 2.0 +
           texture(uSrc, vUv + vec2(t.x, -t.y)).rgb;
  outColor = vec4(texture(uBase, vUv).rgb + s / 16.0, 1.0);
}
`;

/** Exposure, bloom, filmic tone curve, gentle grading, vignette, dithering. */
export const FINAL_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uTime;
uniform vec3 uGradeShadows;
uniform vec3 uGradeHighlights;
uniform float uSaturation;
uniform float uFade;

// ACES fitted (Stephen Hill)
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) {
  const mat3 ACESIn = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 ACESOut = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = ACESIn * c;
  c = RRTAndODTFit(c);
  return clamp(ACESOut * c, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 hdr = texture(uHdr, vUv).rgb * uExposure;
  vec3 bloom = texture(uBloom, vUv).rgb;
  hdr += bloom * uBloomStrength;
  vec3 c = aces(hdr * 1.1);
  // grading: tint shadows and highlights separately
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(uGradeShadows, uGradeHighlights, smoothstep(0.05, 0.8, l));
  c = mix(vec3(l), c, uSaturation);
  // vignette
  vec2 q = vUv - 0.5;
  float vig = 1.0 - dot(q, q) * 0.55;
  c *= vig;
  c = toSRGB(clamp(c, 0.0, 1.0));
  c = mix(vec3(0.0), c, uFade);
  // dithering / very soft film grain
  c += (hash(vUv * 1000.0 + fract(uTime) * 91.0) - 0.5) / 255.0 * 1.5;
  outColor = vec4(c, 1.0);
}
`;
