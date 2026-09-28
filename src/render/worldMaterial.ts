import * as THREE from "three";
import { G } from "./globals";

export interface PatchOptions {
  /** trees & grass bend in the shared wind */
  sway?: number;
  /** subtle world-space colour breakup for large surfaces */
  breakup?: number;
  /** procedural windows (white-washed houses) */
  windows?: boolean;
  /** receive cloud shadows (default true) */
  cloudShadow?: boolean;
}

const VERT_HEAD = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
varying vec3 vCSWorld;
varying vec3 vCSNormalW;
`;

const FRAG_HEAD = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform float uNight;
uniform sampler2D uCloudShadow;
uniform vec3 uCloudShadowFrame;
varying vec3 vCSWorld;
varying vec3 vCSNormalW;
float csHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float csNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(csHash(i), csHash(i + vec2(1, 0)), u.x), mix(csHash(i + vec2(0, 1)), csHash(i + vec2(1, 1)), u.x), u.y);
}
float cloudShadowAtW(vec3 p) {
  vec2 g = p.xz - uSunDir.xz * (p.y / max(uSunDir.y, 0.05));
  vec2 uv = (g - uCloudShadowFrame.xy) / uCloudShadowFrame.z + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
  return texture2D(uCloudShadow, uv).r;
}
`;

/** Injects the world's shared light behaviour into a built-in three.js material. */
export function patchWorldMaterial<T extends THREE.Material>(mat: T, opts: PatchOptions = {}): T {
  const sway = opts.sway ?? 0;
  const breakup = opts.breakup ?? 0;
  const shadow = opts.cloudShadow ?? true;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = G.uTime;
    shader.uniforms.uWind = G.uWind;
    shader.uniforms.uSunDir = G.uSunDir;
    shader.uniforms.uNight = G.uNight;
    shader.uniforms.uCloudShadow = G.uCloudShadow;
    shader.uniforms.uCloudShadowFrame = G.uCloudShadowFrame;

    shader.vertexShader = VERT_HEAD + shader.vertexShader;
    if (sway > 0) {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        {
          vec3 anchor = vec3(0.0);
          #ifdef USE_INSTANCING
            anchor = instanceMatrix[3].xyz;
          #endif
          float bend = max(transformed.y, 0.0) * ${sway.toFixed(4)};
          float gust = sin(uTime * 1.3 + anchor.x * 0.05 + anchor.z * 0.04) * 0.6 + sin(uTime * 2.9 + anchor.z * 0.11) * 0.3;
          vec3 lw = vec3(uWind.x, 0.0, uWind.y);
          #ifdef USE_INSTANCING
            lw = transpose(mat3(instanceMatrix)) * lw / max(dot(instanceMatrix[0].xyz, instanceMatrix[0].xyz), 1e-4);
          #endif
          transformed.xz += lw.xz * 0.02 * (0.75 + gust * 0.45) * bend * bend;
        }`,
      );
    }
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      /* glsl */ `#include <project_vertex>
      {
        vec4 csw = vec4(transformed, 1.0);
        vec3 csn = objectNormal;
        #ifdef USE_INSTANCING
          csw = instanceMatrix * csw;
          csn = mat3(instanceMatrix) * csn;
        #endif
        vCSWorld = (modelMatrix * csw).xyz;
        vCSNormalW = normalize(mat3(modelMatrix) * csn);
      }`,
    );

    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader;
    if (shadow) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "getDirectionalLightInfo( directionalLight, directLight );",
        "getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= cloudShadowAtW(vCSWorld);",
      );
    }
    let colorMod = "";
    if (breakup > 0) {
      colorMod += /* glsl */ `
      {
        float nb = csNoise(vCSWorld.xz * 0.045) * 0.6 + csNoise(vCSWorld.xz * 0.21) * 0.4;
        diffuseColor.rgb *= mix(1.0 - ${breakup.toFixed(3)}, 1.0 + ${breakup.toFixed(3)}, nb);
      }`;
    }
    if (opts.windows) {
      colorMod += /* glsl */ `
      {
        vec3 nw = vCSNormalW;
        float vertical = 1.0 - abs(nw.y);
        vec2 fp = abs(nw.x) > abs(nw.z) ? vec2(vCSWorld.z, vCSWorld.y) : vec2(vCSWorld.x, vCSWorld.y);
        vec2 cell = vec2(fp.x / 3.2, (fp.y - 0.8) / 3.0);
        vec2 f = fract(cell);
        float win = step(0.36, f.x) * step(f.x, 0.64) * step(0.35, f.y) * step(f.y, 0.75) * vertical;
        float lit = step(0.62, csHash(floor(cell) + floor(vCSWorld.xz * 0.05)));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.05, 0.045), win * 0.85);
        vWinGlow = win * lit;
      }`;
      shader.fragmentShader = shader.fragmentShader.replace(
        "void main() {",
        "float vWinGlow = 0.0;\nvoid main() {",
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vec3(1.0, 0.62, 0.28) * vWinGlow * uNight * 0.9;",
      );
    }
    if (colorMod) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        "#include <color_fragment>\n" + colorMod,
      );
    }
  };
  mat.customProgramCacheKey = () =>
    `world-${sway}-${breakup}-${opts.windows ? 1 : 0}-${shadow ? 1 : 0}`;
  return mat;
}
