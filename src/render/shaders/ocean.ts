import {
  ATMOSPHERE_GLSL,
  CLOUD_FIELD_GLSL,
  GLOBALS_GLSL,
  NOISE_GLSL,
  SKY_LUT_GLSL,
} from "./common";

export const MAX_WAVES = 4;
export const MAX_BOATS = 16;
export const DETAIL_COMPONENTS = 64;

/** Animated, tileable ripple slopes: rg = fine layer, ba = coarse layer. */
export const WAVE_DETAIL_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uTime;
uniform vec4 uCompA[${DETAIL_COMPONENTS}]; // nx, ny, slopeAmp, phase
uniform vec4 uCompB[${DETAIL_COMPONENTS}];
uniform vec2 uTile; // tile sizes (m) of layer A and B
vec2 layer(vec4 comps[${DETAIL_COMPONENTS}], float tile) {
  vec2 s = vec2(0.0);
  for (int i = 0; i < ${DETAIL_COMPONENTS}; i++) {
    vec4 c = comps[i];
    vec2 k = c.xy * 6.2831853 / tile;
    float kl = length(k);
    float w = sqrt(9.81 * kl);
    float ph = dot(c.xy, vUv) * 6.2831853 - w * uTime + c.w;
    s += -c.z * sin(ph) * (k / kl);
  }
  return s;
}
void main() {
  outColor = vec4(layer(uCompA, uTile.x), layer(uCompB, uTile.y));
}
`;

const OCEAN_COMMON = /* glsl */ `
uniform vec4 uWaves[${MAX_WAVES}];  // dir.xy, k, amplitude
uniform float uWaveQ[${MAX_WAVES}];
uniform vec3 uOceanCenter;
`;

export const OCEAN_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${GLOBALS_GLSL}
${OCEAN_COMMON}
varying vec3 vWorld;
varying vec3 vGNormal;
varying float vCrest;
varying float vDepth;

void main() {
  vec3 wp = vec3(position.x + uOceanCenter.x, 0.0, position.z + uOceanCenter.z);
  float dist = length(position.xz);
  float ground = terrainHeightAt(wp.xz);
  float depth = -ground;
  float shallow = smoothstep(0.0, 14.0, depth);
  vec3 disp = vec3(0.0);
  vec3 dx = vec3(1.0, 0.0, 0.0);
  vec3 dz = vec3(0.0, 0.0, 1.0);
  float crest = 0.0;
  for (int i = 0; i < ${MAX_WAVES}; i++) {
    vec4 w = uWaves[i];
    float k = w.z;
    float lambda = 6.2831853 / k;
    float fade = 1.0 - smoothstep(lambda * 25.0, lambda * 70.0, dist);
    float A = w.w * fade * mix(0.25, 1.0, shallow);
    if (A <= 0.0) continue;
    vec2 d = w.xy;
    float om = sqrt(9.81 * k);
    float ph = k * dot(d, wp.xz) - om * uTime + float(i) * 1.7;
    float c = cos(ph), s = sin(ph);
    float Q = uWaveQ[i];
    disp.x += Q * A * d.x * c;
    disp.z += Q * A * d.y * c;
    disp.y += A * s;
    float WA = k * A;
    dx += vec3(-Q * d.x * d.x * WA * s, d.x * WA * c, -Q * d.x * d.y * WA * s);
    dz += vec3(-Q * d.x * d.y * WA * s, d.y * WA * c, -Q * d.y * d.y * WA * s);
    crest += s * A;
  }
  wp += disp;
  vWorld = wp;
  vGNormal = normalize(cross(dz, dx));
  vCrest = crest;
  vDepth = depth;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export const OCEAN_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
precision highp sampler3D;
${NOISE_GLSL}
${ATMOSPHERE_GLSL}
${SKY_LUT_GLSL}
${GLOBALS_GLSL}
${CLOUD_FIELD_GLSL}
${OCEAN_COMMON}
uniform sampler2D uDetail;
uniform vec2 uDetailTile;
uniform vec4 uBoatA[${MAX_BOATS}]; // x, z, heading, speed
uniform vec4 uBoatB[${MAX_BOATS}]; // wake length, beam, strength, _
uniform int uBoatCount;
uniform vec3 uSunDisk;
varying vec3 vWorld;
varying vec3 vGNormal;
varying float vCrest;
varying float vDepth;

vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }

float wakeFoam(vec2 p, out float calm) {
  float foam = 0.0;
  calm = 0.0;
  for (int i = 0; i < ${MAX_BOATS}; i++) {
    if (i >= uBoatCount) break;
    vec4 a = uBoatA[i];
    vec4 b = uBoatB[i];
    vec2 fwd = vec2(cos(a.z), sin(a.z));
    vec2 rel = p - a.xy;
    float along = -dot(rel, fwd);        // distance behind the boat
    float lat = dot(rel, vec2(-fwd.y, fwd.x));
    float beam = b.y;
    if (along < -beam * 3.0 || along > b.x || abs(lat) > along * 0.4 + beam * 3.0) continue;
    float age = max(along, 0.0) / b.x;
    float decay = pow(1.0 - age, 2.2);
    // turbulent centre trail
    float w = beam * (0.6 + along * 0.015);
    float centre = exp(-pow(lat / w, 2.0)) * decay;
    float n = valueNoise(vec2(along * 0.12, lat * 0.3) + a.xy * 0.01);
    foam += centre * (0.4 + 0.55 * n) * b.z;
    calm += centre;
    // kelvin arms: shorter lived, broken up
    float armLife = max(1.0 - along / (b.x * 0.45), 0.0);
    float arm = abs(abs(lat) - (along * 0.34 + beam * 0.5));
    float aw = 0.9 + along * 0.018;
    float kel = exp(-pow(arm / aw, 2.0)) * pow(armLife, 1.5) * smoothstep(0.0, beam * 2.0, along);
    float breakup = valueNoise(vec2(along * 0.07, abs(lat) * 0.05) + a.xy * 0.013 + uTime * 0.05);
    foam += kel * (0.12 + 0.3 * breakup) * b.z;
    // bow spray
    float bow = exp(-pow(length(rel + fwd * beam * 2.2) / (beam * 1.2), 2.0));
    foam += bow * 0.8 * b.z;
  }
  return clamp(foam, 0.0, 1.0);
}

vec3 swellNormal(vec2 xz, float dist, float shallow) {
  vec3 n = vec3(0.0, 1.0, 0.0);
  for (int i = 0; i < ${MAX_WAVES}; i++) {
    vec4 w = uWaves[i];
    float k = w.z;
    float lambda = 6.2831853 / k;
    float fade = 1.0 - smoothstep(lambda * 25.0, lambda * 90.0, dist);
    float A = w.w * fade * mix(0.25, 1.0, shallow);
    float om = sqrt(9.81 * k);
    float ph = k * dot(w.xy, xz) - om * uTime + float(i) * 1.7;
    n.xz -= w.xy * k * A * cos(ph);
  }
  return normalize(n);
}

void main() {
  vec3 P = vWorld;
  vec3 V = normalize(cameraPosition - P);
  float dist = length(cameraPosition - P);
  vec3 L = uSunDir;

  // ---- wind gusts (cat's paws): patches of stronger ripples drifting downwind ----
  float windA = atan(uWind.y, uWind.x);
  vec2 wdir = normalize(uWind + 1e-4);
  vec2 gp = P.xz - uWind * uTime * 1.4;
  float gust = fbmValue(rot(gp, -windA) * vec2(0.0022, 0.0045) + 3.7);
  gust = smoothstep(0.3, 0.75, gust);
  float rippleStrength = mix(0.55, 1.35, gust);

  // ---- detail normal from animated ripple textures, rotated into wind frame ----
  vec2 q = rot(P.xz, -windA);
  vec4 d1 = texture(uDetail, q / uDetailTile.x);
  vec4 d2 = texture(uDetail, q / uDetailTile.y + 0.37);
  vec4 d3 = texture(uDetail, rot(q, 0.9) / (uDetailTile.x * 0.31) + 0.61);
  vec4 d5 = texture(uDetail, rot(q, 2.1) / (uDetailTile.x * 1.73) + 0.29);
  float fadeFine = 1.0 - smoothstep(40.0, 600.0, dist);
  float fadeMid = 1.0 - smoothstep(300.0, 4000.0, dist);
  // break up tiling with slow, large-scale variation between layers
  float mixA = valueNoise(P.xz * 0.004 + 1.3);
  float mixB = valueNoise(P.xz * 0.0017 - 4.1);
  vec2 slope = (mix(d1.xy, d5.xy, mixA) * rippleStrength + d3.xy * 0.5 * rippleStrength) * fadeFine
             + mix(d2.zw, d5.zw * 0.8, mixB * 0.6) * fadeMid * mix(0.8, 1.15, gust);
  slope = rot(slope, windA);
  float shallowCalm = smoothstep(0.0, 6.0, vDepth);
  slope *= mix(0.35, 1.0, shallowCalm);
  vec3 N = normalize(swellNormal(P.xz, dist, smoothstep(0.0, 14.0, vDepth)) + vec3(-slope.x, 0.0, -slope.y));
  // roughness grows with distance: unresolved ripples blur into a broad glitter path
  float rough = mix(0.035, 0.22, smoothstep(80.0, 9000.0, dist)) * mix(0.8, 1.2, gust);

  // ---- terrain & shallows ----
  float ground = terrainHeightAt(P.xz);
  float depth = max(P.y - ground, 0.0);

  // ---- lighting terms ----
  float shadow = cloudShadowAt(P);
  float NdotV = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  fres = min(fres, 0.85);

  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.002;
  vec3 sky = skyLut(normalize(R));
  // reflected clouds: sample coverage where the reflected ray meets the cloud layer
  {
    float tc = (1300.0 - P.y) / max(R.y, 0.03);
    vec3 cp = P + R * min(tc, 45000.0);
    vec4 w = cloudWeather(cp.xz);
    float cov = smoothstep(0.01, 0.2, w.x) * (1.0 - smoothstep(20000.0, 45000.0, tc));
    vec3 cloudCol = uAmbZenith * 1.3 + uSunColor * 0.075 * (0.4 + 0.6 * max(uSunDir.y, 0.0));
    sky = mix(sky, cloudCol, cov * 0.8);
  }

  // specular sun/moon (GGX), glitter comes from the ripple normals
  vec3 H = normalize(L + V);
  float NdotH = max(dot(N, H), 0.0);
  float NdotL = max(dot(N, L), 0.0);
  float a2 = rough * rough;
  float dn = NdotH * NdotH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dn * dn);
  float spec = D * fres / max(4.0 * NdotV + 0.05, 0.05) * NdotL;
  // sparkling glints near the camera
  vec2 gcell = floor(P.xz * 1.6);
  float gl = step(0.985, hash12(gcell + floor(uTime * 6.0))) * fadeFine;
  spec += gl * pow(NdotH, 900.0) * 30.0;
  vec3 specCol = uSunColor * spec * shadow * 0.9;

  // ---- water body: deep navy, turning emerald where sunlight pours in ----
  float sunIn = max(L.y, 0.0);
  float lit = shadow * sunIn;
  vec3 deepA = vec3(0.0025, 0.012, 0.05);
  vec3 deepB = vec3(0.004, 0.032, 0.088);
  vec3 body = mix(deepA, deepB, smoothstep(0.2, 0.8, shadow));
  vec3 bodyLight = uSunColor * lit * 0.11 + uAmbZenith * 0.55;
  vec3 water = body * bodyLight;
  // subsurface on wave faces seen against the light
  float sss = pow(max(dot(V, -L + vec3(0.0, 0.25, 0.0)), 0.0), 3.0) * max(vCrest + 0.4, 0.0);
  water += vec3(0.02, 0.12, 0.1) * uSunColor * sss * shadow * 0.05;

  // shallows: seabed seen through clear water
  if (depth < 60.0) {
    vec3 absorb = vec3(0.38, 0.068, 0.03);
    vec3 tr = exp(-absorb * depth * 1.1);
    vec3 sand = vec3(0.86, 0.8, 0.64);
    // dark meadows of sea grass scattered over the sandy bottom
    float seaGrass = smoothstep(0.5, 0.68, fbmValue(P.xz * 0.009 + 7.0)) * smoothstep(2.5, 7.0, depth);
    sand = mix(sand, vec3(0.12, 0.2, 0.12), seaGrass * 0.75);
    // caustics dance only in the shallowest, nearby water
    vec2 cq = P.xz * 0.32;
    float c1 = valueNoise(cq + uTime * 0.45);
    float c2 = valueNoise(cq * 1.3 - uTime * 0.38 + 5.0);
    float caus = pow(1.0 - abs(c1 - c2), 8.0) * smoothstep(7.0, 0.5, depth) * (1.0 - smoothstep(120.0, 600.0, dist));
    vec3 bedLight = uSunColor * lit * (0.1 + caus * 0.05) + uAmbZenith * 0.5;
    vec3 bed = sand * bedLight * tr;
    water = bed + water * (1.0 - tr.g);
  }

  vec3 col = mix(water, sky, fres) + specCol;

  // ---- foam: shoreline, wakes, occasional whitecaps ----
  float shoreFoam = 0.0;
  if (depth < 4.0) {
    float band = sin(depth * 3.2 - uTime * 1.6 + fbmValue(P.xz * 0.05) * 6.0) * 0.5 + 0.5;
    float n = fbmValue(P.xz * 0.35 + uTime * 0.1);
    shoreFoam = smoothstep(1.8, 0.0, depth) * (0.4 + 0.6 * n);
    shoreFoam += smoothstep(4.0, 0.5, depth) * smoothstep(0.75, 1.0, band) * n * 0.8;
  }
  float calm;
  float wake = wakeFoam(P.xz, calm);
  float capN = valueNoise(P.xz * 0.28 + vec2(uTime * 0.4, 0.0)) * valueNoise(P.xz * 0.061 - uTime * 0.05);
  float caps = smoothstep(0.42, 0.7, capN) * smoothstep(0.55, 1.0, gust) * smoothstep(0.0, 0.5, vCrest) * 0.55 * fadeFine;
  float foam = clamp(shoreFoam + wake + caps, 0.0, 1.0);
  vec3 foamCol = (uSunColor * max(uSunDir.y, 0.0) * shadow * 0.12 + uAmbZenith * 0.95) * 0.85;
  col = mix(col, foamCol, foam * 0.9);

  gl_FragColor = vec4(col, 1.0);
  #include <logdepthbuf_fragment>
}
`;
