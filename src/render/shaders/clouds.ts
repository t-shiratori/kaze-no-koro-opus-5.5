import {
  ATMOSPHERE_GLSL,
  CLOUD_FIELD_GLSL,
  GLOBALS_GLSL,
  NOISE_GLSL,
  SKY_LUT_GLSL,
} from "./common";

const HEADER = /* glsl */ `
precision highp float;
precision highp sampler3D;
${NOISE_GLSL}
${GLOBALS_GLSL}
${CLOUD_FIELD_GLSL}
`;

/** Top-down transmittance of light through the cloud layer, used for shadows and light shafts. */
export const CLOUD_SHADOW_FRAG = /* glsl */ `
${HEADER}
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 xz = uCloudShadowFrame.xy + (vUv - 0.5) * uCloudShadowFrame.z;
  vec3 L = uSunDir;
  float sy = max(L.y, 0.08);
  // march from the bottom of the cloud layers up towards the light
  float t0 = CLOUD_BOTTOM / sy;
  float t1 = min(CLOUD_TOP / sy, t0 + 9000.0);
  const int N = 30;
  float dt = (t1 - t0) / float(N);
  float od = 0.0;
  vec3 dir = vec3(L.x, sy, L.z);
  dir = normalize(dir);
  t0 = CLOUD_BOTTOM / dir.y; t1 = min(CLOUD_TOP / dir.y, t0 + 9000.0); dt = (t1 - t0) / float(N);
  for (int i = 0; i < N; i++) {
    vec3 p = vec3(xz.x, 0.0, xz.y) + dir * (t0 + (float(i) + 0.5) * dt);
    vec4 w = cloudWeather(p.xz);
    od += cloudDensity(p, w, false) * dt;
  }
  float T = exp(-od * 0.03);
  // light never fully disappears (skylight + multiple scattering)
  outColor = vec4(mix(0.1, 1.0, T), 0.0, 0.0, 1.0);
}
`;

/**
 * Half-resolution volumetric pass. Marches cumulus, rain curtains and sunlit haze.
 * out0: rgb in-scattered cloud light, a transmittance
 * out1: r sun visibility along the hazy part of the ray, g cloud depth (km), b scene depth (km),
 *       a in-scattered sunbeam light (multiplied by the sun colour in the composite)
 */
export const CLOUD_MARCH_FRAG = /* glsl */ `
${HEADER}
${ATMOSPHERE_GLSL}
${SKY_LUT_GLSL}
in vec2 vUv;
layout(location = 0) out vec4 outCloud;
layout(location = 1) out vec4 outAux;

uniform sampler2D uDepth;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uLogDepthFC; // log2(far + 1)
uniform float uFrame;
uniform vec2 uResolution;
uniform float uShaftHaze; // extra sunlit haze that makes beams visible (1/m at sea level)

float linearDepth(float d) { return exp2(d * uLogDepthFC) - 1.0; }

vec3 viewRay(vec2 uv) {
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 v = normalize(p.xyz / p.w);
  return normalize((uCamWorld * vec4(v, 0.0)).xyz);
}

float lightMarch(vec3 p, vec3 L, float jitter) {
  float od = 0.0;
  float st = 55.0;
  float t = -st * jitter;
  for (int i = 0; i < 6; i++) {
    t += st;
    vec3 q = p + L * t;
    vec4 w = cloudWeather(q.xz);
    od += cloudDensity(q, w, i < 2) * st;
    st *= 1.7;
  }
  return od;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec3 rd = viewRay(vUv);
  vec3 ro = uCamPos;

  // take the farthest depth of the 2x2 full-res block? use the center tap (bilateral upsample fixes edges)
  float d = texture(uDepth, vUv).r;
  float sceneDist = d >= 0.99999 ? 1e7 : linearDepth(d) / max(dot(rd, normalize((uCamWorld * vec4(0.0, 0.0, -1.0, 0.0)).xyz)), 1e-3);

  float jitter = fract(ign(px) + uFrame * 0.61803398875);
  vec3 L = uSunDir;
  float mu = dot(rd, L);
  // dual-lobe phase: bright silver lining toward the sun + soft back scattering
  float phase = mix(phaseHG(mu, 0.68), phaseHG(mu, -0.18), 0.38) * 4.0 * 3.14159;
  phase = max(phase, 0.55);

  vec3 sunC = uSunColor;
  vec3 ambTop = uAmbZenith * 1.25 + uAmbHorizon * 0.2;
  // flat bases: neutral grey, lifted a little by light bouncing off the sea
  vec3 ambBottom = uAmbHorizon * 0.55 + vec3(0.03, 0.05, 0.07) * length(uSunColor) * max(uSunDir.y, 0.0) * 0.14;
  // beams: strongly forward scattering haze
  float shaftPhase = mix(phaseHG(mu, 0.78), phaseHG(mu, 0.25), 0.45) * 4.0 * 3.14159;

  vec3 scat = vec3(0.0);
  float T = 1.0;
  float depthAcc = 0.0;
  float depthW = 0.0;

  // ---- 1. hazy air below the clouds: light shafts & rain curtains ----
  float sunVis = 1.0;
  float shaft = 0.0;
  {
    float tEnd = min(sceneDist, 26000.0);
    if (rd.y > 0.0) tEnd = min(tEnd, max((1500.0 - ro.y) / rd.y, 0.0));
    float wSum = 0.0, vSum = 0.0;
    float Th = 1.0;
    const int NA = 44;
    for (int i = 0; i < NA; i++) {
      float f = (float(i) + jitter) / float(NA);
      float t = tEnd * f * f;
      float dts = tEnd * (2.0 * f + 1.0 / float(NA)) / float(NA);
      vec3 p = ro + rd * t;
      if (p.y > 1600.0) break;
      float haze = exp(-max(p.y, 0.0) / 900.0);
      float wgt = haze * exp(-t / 9000.0);
      float sh = cloudShadowAt(p);
      vSum += sh * wgt;
      wSum += wgt;
      // sunbeams: haze lit only where the sun gets through the clouds
      // (skip the air right around the camera so it doesn't veil the whole view)
      float sigH = uShaftHaze * exp(-max(p.y, 0.0) / 850.0) * smoothstep(150.0, 900.0, t);
      float lit = smoothstep(0.35, 0.95, sh);
      lit *= lit;
      shaft += Th * sigH * dts * lit;
      Th *= exp(-sigH * dts);
      // rain: grey columns hanging under rainy clouds
      if (t > 1500.0) {
        vec4 w = cloudWeather(p.xz);
        if (w.z > 0.01 && w.x > 0.12 && p.y < w.w) {
          float streak = 0.8 + 0.2 * valueNoise(vec2((p.x + p.z) * 0.006, uTime * 0.05));
          float rho = w.z * streak * smoothstep(w.w + 30.0, w.w - 250.0, p.y) * 0.0008;
          float dtr = tEnd * (2.0 * f + 1.0 / float(NA)) / float(NA);
          float a = 1.0 - exp(-rho * dtr);
          vec3 rainCol = uAmbHorizon * 0.32 + uAmbZenith * 0.1 + sunC * 0.006 * sh;
          scat += T * a * rainCol;
          T *= 1.0 - a;
          depthAcc += t * a; depthW += a;
        }
      }
    }
    sunVis = wSum > 0.0 ? vSum / wSum : 1.0;
    shaft *= shaftPhase;
  }

  // ---- 2. cumulus layer ----
  vec2 slab;
  {
    float tb = (CLOUD_BOTTOM - ro.y) / rd.y;
    float tt = (CLOUD_TOP - ro.y) / rd.y;
    if (ro.y < CLOUD_BOTTOM) slab = rd.y > 0.0 ? vec2(tb, tt) : vec2(-1.0);
    else if (ro.y > CLOUD_TOP) slab = rd.y < 0.0 ? vec2(tt, tb) : vec2(-1.0);
    else slab = vec2(0.0, rd.y > 0.0 ? tt : tb);
    if (abs(rd.y) < 1e-4) slab = ro.y > CLOUD_BOTTOM && ro.y < CLOUD_TOP ? vec2(0.0, 1e6) : vec2(-1.0);
  }
  float maxDist = min(sceneDist, 60000.0);
  if (slab.y > 0.0 && slab.x < maxDist && T > 0.01) {
    float t = max(slab.x, 0.0);
    float tEnd = min(slab.y, maxDist);
    float step = clamp(t * 0.01, 10.0, 180.0);
    t += step * jitter;
    for (int i = 0; i < 110; i++) {
      if (t > tEnd || T < 0.012) break;
      vec3 p = ro + rd * t;
      step = clamp(t * 0.009, 10.0, 420.0);
      vec4 w = cloudWeather(p.xz);
      // quick reject using the cheap coverage-only shape
      float coarse = cloudDensity(p, w, false);
      if (coarse <= 0.0) { t += step * 1.6; continue; }
      float dens = cloudDensity(p, w, t < 9000.0);
      if (dens > 0.003) {
        float sigma = 0.03 * dens;
        float od = lightMarch(p, L, fract(jitter + float(i) * 0.618)) * 0.026;
        // multi-octave scattering approximation: deep shade inside, light still bleeds through
        float beer = exp(-od) + 0.35 * exp(-od * 0.25) + 0.12 * exp(-od * 0.07);
        // powder: with the sun behind the viewer, the crevices between billows darken
        float powder = clamp((1.0 - exp(-od * 1.8 - 0.1)) * 1.7, 0.0, 1.2);
        float pf = mix(1.0, powder, (0.5 - 0.5 * mu) * 0.6);
        float hFrac = p.y < w.w ? clamp((p.y - DECK_BASE) / 500.0, 0.0, 1.0) : clamp((p.y - w.w) / cloudTop(w), 0.0, 1.0);
        vec3 amb = mix(ambBottom, ambTop, pow(hFrac, 0.7)) * (0.5 + 0.5 * (1.0 - dens));
        // a heavy deck is dark underneath: little skylight reaches its base
        amb *= 1.0 - uDeck * 0.45 * (1.0 - hFrac);
        // light that has diffused deep into the cloud: keeps interiors luminous white-grey
        vec3 diffuse = sunC * max(L.y, 0.12) * 0.03 * exp(-od * 0.02);
        vec3 S = (sunC * beer * phase * pf * 0.1 + amb * 0.7 + diffuse) * sigma;
        float Ts = exp(-sigma * step);
        vec3 Sint = (S - S * Ts) / sigma;
        scat += T * Sint;
        depthAcc += t * T * (1.0 - Ts);
        depthW += T * (1.0 - Ts);
        T *= Ts;
      }
      t += step;
    }
  }

  // clouds right at the camera fade in so flying through them feels like mist, not a wall
  float cloudDepth = depthW > 0.0 ? depthAcc / depthW : 60000.0;
  outCloud = vec4(scat, T);
  outAux = vec4(sunVis, cloudDepth / 1000.0, min(sceneDist, 1e6) / 1000.0, shaft);
}
`;

/** Temporal accumulation of the half-res volumetrics with reprojection. */
export const CLOUD_TEMPORAL_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 outCloud;
layout(location = 1) out vec4 outAux;
uniform sampler2D uCurCloud;
uniform sampler2D uCurAux;
uniform sampler2D uHistCloud;
uniform sampler2D uHistAux;
uniform mat4 uPrevViewProj;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec2 uTexel;
uniform float uBlend;

vec3 viewRay(vec2 uv) {
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 v = normalize(p.xyz / p.w);
  return normalize((uCamWorld * vec4(v, 0.0)).xyz);
}

void main() {
  vec4 c = texture(uCurCloud, vUv);
  vec4 a = texture(uCurAux, vUv);
  // neighbourhood statistics for variance clipping
  vec4 m1 = c, m2 = c * c;
  vec4 amn = a, amx = a;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      vec2 o = vec2(i, j) * uTexel;
      vec4 s = texture(uCurCloud, vUv + o);
      vec4 sa = texture(uCurAux, vUv + o);
      m1 += s; m2 += s * s;
      amn = min(amn, sa); amx = max(amx, sa);
    }
  }
  m1 /= 9.0;
  vec4 sd = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
  vec4 mn = m1 - sd * 1.3 - 0.004, mx = m1 + sd * 1.3 + 0.004;
  float d = c.a < 0.98 ? a.g * 1000.0 : min(a.b * 1000.0, 30000.0);
  vec3 wp = uCamPos + viewRay(vUv) * d;
  vec4 pp = uPrevViewProj * vec4(wp, 1.0);
  vec2 puv = pp.xy / pp.w * 0.5 + 0.5;
  float valid = (pp.w > 0.0 && all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) ? 1.0 : 0.0;
  vec4 h = texture(uHistCloud, puv);
  vec4 ha = texture(uHistAux, puv);
  h = clamp(h, mn, mx);
  ha.rg = clamp(ha.rg, amn.rg - 0.05, amx.rg + 0.05);
  ha.a = clamp(ha.a, amn.a * 0.8, amx.a * 1.2 + 0.001);
  // large screen-space motion (fast turns, stutters): trust the new frame
  float motion = length((puv - vUv) / uTexel);
  float bl = uBlend * valid * (1.0 - smoothstep(3.0, 14.0, motion));
  outCloud = mix(c, h, bl);
  outAux = vec4(mix(a.rg, ha.rg, bl), a.b, mix(a.a, ha.a, bl));
}
`;
