import {
  ATMOSPHERE_GLSL,
  CLOUD_FIELD_GLSL,
  GLOBALS_GLSL,
  NOISE_GLSL,
  SKY_LUT_GLSL,
} from "./common";

export const MAX_WAVES = 4;
export const MAX_BOATS = 16;

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
uniform sampler2D uFFT0;
uniform sampler2D uFFT1;
uniform sampler2D uFFT2;
uniform vec3 uFFTSize;
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

  // ---- wind waves & ripples from the FFT cascades, in the wind's frame ----
  // each cascade fades out once a pixel covers more than a few of its smallest waves;
  // mipmaps average the rest, so nothing sub-pixel turns into crunchy noise
  vec2 q = rot(P.xz, -windA);
  float fp = length(fwidth(P.xz));
  vec2 s0 = texture(uFFT0, q / uFFTSize.x).xy;
  vec2 s1 = rot(texture(uFFT1, rot(q, 0.61) / uFFTSize.y + 0.37).xy, -0.61);
  vec2 s2 = rot(texture(uFFT2, rot(q, -0.83) / uFFTSize.z + 0.71).xy, 0.83);
  float f0 = 1.0 - smoothstep(1.5, 6.0, fp);
  float f1 = 1.0 - smoothstep(0.3, 1.2, fp);
  float f2 = 1.0 - smoothstep(0.06, 0.25, fp);
  float fadeFine = f1;
  vec2 slope = (s0 * f0 * mix(0.85, 1.15, gust) + (s1 * f1 + s2 * f2) * mix(0.6, 1.3, gust));
  slope = rot(slope, windA);
  float shallowCalm = smoothstep(0.0, 6.0, vDepth);
  slope *= mix(0.35, 1.0, shallowCalm);
  vec3 Ns = swellNormal(P.xz, dist, smoothstep(0.0, 14.0, vDepth));
  vec3 N = normalize(Ns + vec3(-slope.x, 0.0, -slope.y));
  // specular anti-aliasing: where the normal changes a lot within one pixel, the pixel
  // really sees a blur of many facets - widen the highlight and soften the reflection
  vec3 dNx = dFdx(N);
  vec3 dNy = dFdy(N);
  float nVar = dot(dNx, dNx) + dot(dNy, dNy);
  float aa = clamp(nVar * 2.0, 0.0, 1.0);
  // roughness grows with distance: unresolved ripples blur into a broad glitter path
  float rough = mix(0.06, 0.22, smoothstep(80.0, 9000.0, dist)) * mix(0.85, 1.15, gust);
  rough = sqrt(rough * rough + min(nVar * 1.5, 0.12));
  // reflections use a normal pulled toward the smooth swell where ripples are unresolved
  vec3 Nr = normalize(mix(N, Ns, aa * 0.7));

  // ---- terrain & shallows ----
  float ground = terrainHeightAt(P.xz);
  float depth = max(P.y - ground, 0.0);

  // ---- lighting terms ----
  float shadow = cloudShadowAt(P);
  float NdotV = max(dot(Nr, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  fres = min(fres, 0.85);

  vec3 R = reflect(-V, Nr);
  R.y = abs(R.y) + 0.002;
  vec3 sky = skyLut(normalize(R));
  // reflected clouds: sample coverage where the reflected ray meets the cloud layer
  {
    // clouds are big and the ripples blur their image: reflect off the smooth swell only
    vec3 Rc = reflect(-V, Ns);
    Rc.y = abs(Rc.y) + 0.002;
    float tc = (1300.0 - P.y) / max(Rc.y, 0.03);
    vec3 cp = P + Rc * min(tc, 45000.0);
    // filtered (mipmapped) coverage: neighbouring pixels reflect far-apart sky points,
    // so a sharp lookup would sparkle into noise
    vec2 cq = (cp.xz + uCloudOffset) / 21000.0;
    float covRaw = texture(uWeather, cq).r;
    float cloudiness = clamp(texture(uWeather, (cp.xz + uCloudOffset) / 110000.0 + vec2(0.37, 0.11)).g * 0.9 + uCloudCover - 0.5, 0.04, 0.9);
    float cov = smoothstep(0.0, 0.25, covRaw - (1.0 - cloudiness)) * (1.0 - smoothstep(20000.0, 45000.0, tc));
    cov *= 1.0 - aa * 0.5;
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
  // keep single-pixel fireflies in check
  spec = min(spec, 40.0);
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
