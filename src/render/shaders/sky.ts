import { ATMOSPHERE_GLSL, GLOBALS_GLSL, NOISE_GLSL, SKY_LUT_GLSL } from "./common";

export const SKY_LUT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec3 uTrueSunDir;
uniform vec3 uMoonDir;
uniform float uSunIntensity;
uniform float uMoonIntensity;
uniform vec3 uSunTint;
${ATMOSPHERE_GLSL}

vec3 transmittanceTo(vec3 p, vec3 dir) {
  vec2 ta = raySphere(p, dir, R_ATMO);
  vec2 tg = raySphere(p, dir, R_GROUND);
  float tMax = ta.y;
  const int N = 8;
  float dt = tMax / float(N);
  vec3 od = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 q = p + dir * (float(i) + 0.5) * dt;
    float h = length(q) - R_GROUND;
    od += (BETA_R * exp(-h / H_R) + BETA_M_EXT * exp(-h / H_M) + BETA_O * max(0.0, 1.0 - abs(h - 25.0) / 15.0)) * dt;
  }
  vec3 t = exp(-od);
  // soft earth shadow instead of a hard cut, keeps twilight glowing
  if (tg.x > 0.0) {
    float dd = length(p + dir * dot(-p, dir));
    t *= smoothstep(R_GROUND - 12.0, R_GROUND + 1.0, dd);
  }
  return t;
}

vec3 scatter(vec3 ro, vec3 rd, vec3 L, float intensity) {
  vec2 ta = raySphere(ro, rd, R_ATMO);
  vec2 tg = raySphere(ro, rd, R_GROUND);
  float tMax = ta.y;
  if (tg.x > 0.0) tMax = min(tMax, tg.x);
  const int N = 24;
  float mu = dot(rd, L);
  float pR = phaseRayleigh(mu);
  float pM = phaseMie(mu, 0.78);
  vec3 sum = vec3(0.0);
  vec3 od = vec3(0.0);
  float prevT = 0.0;
  for (int i = 0; i < N; i++) {
    // quadratic step distribution: dense near the viewer
    float t0 = tMax * pow(float(i) / float(N), 2.0);
    float t1 = tMax * pow(float(i + 1) / float(N), 2.0);
    float dt = t1 - t0;
    float t = 0.5 * (t0 + t1);
    vec3 q = ro + rd * t;
    float h = max(length(q) - R_GROUND, 0.0);
    float dR = exp(-h / H_R);
    float dM = exp(-h / H_M);
    vec3 ext = BETA_R * dR + BETA_M_EXT * dM + BETA_O * max(0.0, 1.0 - abs(h - 25.0) / 15.0);
    vec3 Tv = exp(-(od + ext * dt * 0.5));
    vec3 Ts = transmittanceTo(q, L);
    vec3 s = BETA_R * dR * pR + BETA_M * dM * pM;
    // cheap multiple scattering: isotropic, sun-lit
    vec3 ms = (BETA_R * dR + BETA_M * dM) * 0.04 * (Ts * 0.7 + 0.3 * smoothstep(-0.2, 0.2, L.y));
    sum += Tv * (Ts * s + ms) * dt;
    od += ext * dt;
    prevT = t;
  }
  return sum * intensity;
}

void main() {
  float az = (vUv.x - 0.5) * 6.2831853;
  float vv = vUv.y * 2.0 - 1.0;
  float el = sign(vv) * vv * vv * 1.5707963;
  vec3 rd = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 ro = vec3(0.0, R_GROUND + 0.3, 0.0);
  vec3 col = scatter(ro, rd, uTrueSunDir, uSunIntensity) * uSunTint;
  if (uMoonDir.y > -0.15) {
    col += scatter(ro, rd, uMoonDir, uMoonIntensity) * vec3(0.55, 0.78, 1.25);
  }
  // deep blue night glow so the night is never black
  col += vec3(0.0026, 0.0048, 0.012) * (1.0 - 0.5 * max(rd.y, 0.0)) ;
  outColor = vec4(col, 1.0);
}
`;

/** Sky dome drawn at the far plane: LUT + sun disk + moon + stars. */
export const SKY_DOME_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  #include <logdepthbuf_vertex>
}
`;

export const SKY_DOME_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
${SKY_LUT_GLSL}
${GLOBALS_GLSL}
uniform vec3 uMoonDir;
uniform vec3 uSunDisk;
uniform vec3 uMoonColor;
varying vec3 vDir;

float starField(vec3 d) {
  // stars on a cube-ish grid in direction space
  vec3 a = abs(d);
  vec2 uv;
  float face;
  if (a.x > a.y && a.x > a.z) { uv = d.yz / a.x; face = sign(d.x); }
  else if (a.y > a.z) { uv = d.xz / a.y; face = 2.0 + sign(d.y); }
  else { uv = d.xy / a.z; face = 4.0 + sign(d.z); }
  float s = 0.0;
  for (int i = 0; i < 2; i++) {
    float sc = i == 0 ? 180.0 : 420.0;
    vec2 g = uv * sc + face * 13.1;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 h = hash22(id + float(i) * 7.3);
    vec2 off = (h - 0.5) * 0.7;
    float b = hash12(id * 1.7 + 3.1);
    float thr = i == 0 ? 0.965 : 0.93;
    if (b > thr) {
      float r = length(f - off);
      float tw = 0.75 + 0.25 * sin(uTime * (2.0 + h.x * 3.0) + h.y * 40.0);
      s += smoothstep(0.08, 0.0, r) * pow((b - thr) / (1.0 - thr), 2.0) * tw * (i == 0 ? 1.0 : 0.45);
    }
  }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  vec3 dd = d;
  dd.y = max(dd.y, -0.02);
  vec3 col = skyLut(normalize(dd));

  // sun disk with limb darkening and a warm corona
  float cs = dot(d, uTrueSunDir);
  float sunR = 0.99996;
  float disk = smoothstep(sunR - 0.00002, sunR + 0.000008, cs);
  col += uSunDisk * disk * 60.0;
  col += uSunDisk * pow(max(cs, 0.0), 900.0) * 0.6;

  // moon
  float cm = dot(d, uMoonDir);
  float moonDisk = smoothstep(0.99988, 0.99992, cm);
  if (moonDisk > 0.0) {
    vec3 t = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 b = cross(t, uMoonDir);
    vec2 mp = vec2(dot(d, t), dot(d, b)) / 0.0155;
    float maria = fbmValue(mp * 3.0 + 4.0);
    float shade = 0.75 + 0.35 * smoothstep(0.35, 0.65, maria);
    col += uMoonColor * moonDisk * shade * 5.0;
  }
  col += uMoonColor * pow(max(cm, 0.0), 1200.0) * 0.3 + uMoonColor * pow(max(cm, 0.0), 40.0) * 0.012;

  // stars fade in as the sky darkens and near the horizon haze
  float starVis = uNight * smoothstep(0.0, 0.25, d.y);
  if (starVis > 0.0) col += vec3(0.8, 0.85, 1.0) * starField(d) * starVis * 0.35;

  // below-horizon (only visible if ocean mesh is missing): continue horizon color
  gl_FragColor = vec4(col, 1.0);
  #include <logdepthbuf_fragment>
}
`;
