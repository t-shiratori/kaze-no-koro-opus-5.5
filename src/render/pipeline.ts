import * as THREE from "three";
import { FullscreenPass } from "./fsq";
import { G, globalsFor } from "./globals";
import { CLOUD_MARCH_FRAG, CLOUD_SHADOW_FRAG, CLOUD_TEMPORAL_FRAG } from "./shaders/clouds";
import {
  BLOOM_DOWN_FRAG,
  BLOOM_PREFILTER_FRAG,
  BLOOM_UP_FRAG,
  COMPOSITE_FRAG,
  FINAL_FRAG,
} from "./shaders/post";
import { SKY_LUT_FRAG } from "./shaders/sky";

const CLOUD_GLOBALS = [
  "uTime",
  "uSunDir",
  "uSunColor",
  "uTrueSunDir",
  "uAmbZenith",
  "uAmbHorizon",
  "uNight",
  "uWind",
  "uCloudOffset",
  "uCloudCover",
  "uDeck",
  "uShaftHaze",
  "uCloudShadow",
  "uCloudShadowFrame",
  "uHeightMap",
  "uHeightFrame",
  "uWeather",
  "uNoise3D",
] as const;

const BLOOM_LEVELS = 6;

function hdrTarget(w: number, h: number, opts: THREE.RenderTargetOptions = {}) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    ...opts,
  });
}

/**
 * The frame: sky LUT -> cloud shadows -> scene (HDR, MSAA) -> half-res volumetrics ->
 * composite with aerial perspective -> bloom -> filmic tone mapping.
 */
export class Pipeline {
  readonly skyLUT: THREE.WebGLRenderTarget;
  readonly cloudShadow: THREE.WebGLRenderTarget;
  private sceneRT!: THREE.WebGLRenderTarget;
  private cloudRT!: THREE.WebGLRenderTarget;
  private compRT!: THREE.WebGLRenderTarget;
  private history: THREE.WebGLRenderTarget[] = [];
  private historyIndex = 0;
  private prevViewProj = new THREE.Matrix4();
  private historyValid = false;
  private bloomDown: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];

  private skyPass: FullscreenPass;
  private shadowPass: FullscreenPass;
  private cloudPass: FullscreenPass;
  private compPass: FullscreenPass;
  private temporalPass: FullscreenPass;
  private prefilter: FullscreenPass;
  private down: FullscreenPass;
  private up: FullscreenPass;
  private final: FullscreenPass;

  width = 1;
  height = 1;
  private frame = 0;
  fogDensity = 1.1e-4;
  shaft = 1;
  bloomStrength = 0.06;
  saturation = 1.06;
  fade = 0;
  readonly gradeShadows = new THREE.Vector3(1, 1, 1);
  readonly gradeHighlights = new THREE.Vector3(1, 1, 1);

  constructor(private renderer: THREE.WebGLRenderer) {
    this.skyLUT = hdrTarget(256, 128, { wrapS: THREE.RepeatWrapping });
    this.cloudShadow = hdrTarget(1024, 1024);
    G.uSkyLUT.value = this.skyLUT.texture;
    G.uCloudShadow.value = this.cloudShadow.texture;

    this.skyPass = new FullscreenPass(SKY_LUT_FRAG, {
      uTrueSunDir: G.uTrueSunDir,
      uMoonDir: G.uMoonDir,
      uSunIntensity: { value: 22 },
      uMoonIntensity: { value: 0.12 },
      uSunTint: { value: new THREE.Color(1, 1, 1) },
    });
    this.shadowPass = new FullscreenPass(CLOUD_SHADOW_FRAG, globalsFor(...CLOUD_GLOBALS));
    this.cloudPass = new FullscreenPass(CLOUD_MARCH_FRAG, {
      ...globalsFor(...CLOUD_GLOBALS, "uSkyLUT"),
      uDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uLogDepthFC: { value: 1 },
      uFrame: { value: 0 },
      uResolution: { value: new THREE.Vector2() },
    });
    this.temporalPass = new FullscreenPass(CLOUD_TEMPORAL_FRAG, {
      uCurCloud: { value: null },
      uCurAux: { value: null },
      uHistCloud: { value: null },
      uHistAux: { value: null },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uTexel: { value: new THREE.Vector2() },
      uBlend: { value: 0.88 },
    });
    this.compPass = new FullscreenPass(COMPOSITE_FRAG, {
      ...globalsFor(...CLOUD_GLOBALS, "uSkyLUT"),
      uScene: { value: null },
      uDepth: { value: null },
      uCloud: { value: null },
      uCloudAux: { value: null },
      uCloudTexel: { value: new THREE.Vector2() },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uLogDepthFC: { value: 1 },
      uFogDensity: { value: 1e-4 },
      uShaft: { value: 1 },
    });
    this.prefilter = new FullscreenPass(BLOOM_PREFILTER_FRAG, {
      uSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uExposure: G.uExposure,
      uThreshold: { value: 1.1 },
    });
    this.down = new FullscreenPass(BLOOM_DOWN_FRAG, {
      uSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.up = new FullscreenPass(BLOOM_UP_FRAG, {
      uSrc: { value: null },
      uBase: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1 },
    });
    this.final = new FullscreenPass(FINAL_FRAG, {
      uHdr: { value: null },
      uBloom: { value: null },
      uExposure: G.uExposure,
      uBloomStrength: { value: 0.06 },
      uTime: G.uTime,
      uGradeShadows: { value: this.gradeShadows },
      uGradeHighlights: { value: this.gradeHighlights },
      uSaturation: { value: 1 },
      uFade: { value: 1 },
    });
  }

  setSize(w: number, h: number) {
    w = Math.max(2, Math.floor(w));
    h = Math.max(2, Math.floor(h));
    if (w === this.width && h === this.height && this.sceneRT) return;
    this.width = w;
    this.height = h;
    this.sceneRT?.dispose();
    this.cloudRT?.dispose();
    this.compRT?.dispose();
    for (const rt of this.history) rt.dispose();
    for (const rt of [...this.bloomDown, ...this.bloomUp]) rt.dispose();

    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.FloatType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = depth.magFilter = THREE.NearestFilter;
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthBuffer: true,
      depthTexture: depth,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const cw = Math.ceil(w / 2);
    const ch = Math.ceil(h / 2);
    this.cloudRT = new THREE.WebGLRenderTarget(cw, ch, {
      type: THREE.HalfFloatType,
      count: 2,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    for (const t of this.cloudRT.textures) {
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
    }
    this.history = [0, 1].map(
      () =>
        new THREE.WebGLRenderTarget(cw, ch, {
          type: THREE.HalfFloatType,
          count: 2,
          depthBuffer: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        }),
    );
    this.historyValid = false;
    this.compRT = hdrTarget(w, h);
    this.bloomDown = [];
    this.bloomUp = [];
    let bw = Math.ceil(w / 2);
    let bh = Math.ceil(h / 2);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.bloomDown.push(hdrTarget(bw, bh));
      this.bloomUp.push(hdrTarget(bw, bh));
      bw = Math.max(1, Math.ceil(bw / 2));
      bh = Math.max(1, Math.ceil(bh / 2));
    }
  }

  /** Per-frame environment prepasses (independent of the camera image). */
  renderEnvironment(camPos: THREE.Vector3, sunTint: THREE.Color) {
    const r = this.renderer;
    (this.skyPass.uniforms.uSunTint.value as THREE.Color).copy(sunTint);
    this.skyPass.render(r, this.skyLUT);
    // cloud shadow map follows the camera, snapped to texels to avoid shimmering
    const size = G.uCloudShadowFrame.value.z;
    const texel = size / 1024;
    G.uCloudShadowFrame.value.x = Math.round(camPos.x / texel) * texel;
    G.uCloudShadowFrame.value.y = Math.round(camPos.z / texel) * texel;
    this.shadowPass.render(r, this.cloudShadow);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const r = this.renderer;
    this.frame++;
    // 1. scene
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    r.render(scene, camera);

    const logFC = Math.log2(camera.far + 1);
    // 2. volumetrics (half res)
    const cu = this.cloudPass.uniforms;
    cu.uDepth.value = this.sceneRT.depthTexture;
    cu.uInvProj.value.copy(camera.projectionMatrixInverse);
    cu.uCamWorld.value.copy(camera.matrixWorld);
    cu.uCamPos.value.copy(camera.position);
    cu.uLogDepthFC.value = logFC;
    cu.uFrame.value = this.frame;
    cu.uResolution.value.set(this.cloudRT.width, this.cloudRT.height);
    this.cloudPass.render(r, this.cloudRT);

    // 2b. temporal accumulation
    const prev = this.history[this.historyIndex];
    this.historyIndex = 1 - this.historyIndex;
    const hist = this.history[this.historyIndex];
    const tu = this.temporalPass.uniforms;
    tu.uCurCloud.value = this.cloudRT.textures[0];
    tu.uCurAux.value = this.cloudRT.textures[1];
    tu.uHistCloud.value = prev.textures[0];
    tu.uHistAux.value = prev.textures[1];
    tu.uPrevViewProj.value.copy(this.prevViewProj);
    tu.uInvProj.value.copy(camera.projectionMatrixInverse);
    tu.uCamWorld.value.copy(camera.matrixWorld);
    tu.uCamPos.value.copy(camera.position);
    tu.uTexel.value.set(1 / this.cloudRT.width, 1 / this.cloudRT.height);
    tu.uBlend.value = this.historyValid ? 0.88 : 0;
    this.temporalPass.render(r, hist);
    this.historyValid = true;
    this.prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    // 3. composite
    const pu = this.compPass.uniforms;
    pu.uScene.value = this.sceneRT.texture;
    pu.uDepth.value = this.sceneRT.depthTexture;
    pu.uCloud.value = hist.textures[0];
    pu.uCloudAux.value = hist.textures[1];
    pu.uCloudTexel.value.set(1 / this.cloudRT.width, 1 / this.cloudRT.height);
    pu.uInvProj.value.copy(camera.projectionMatrixInverse);
    pu.uCamWorld.value.copy(camera.matrixWorld);
    pu.uCamPos.value.copy(camera.position);
    pu.uLogDepthFC.value = logFC;
    pu.uFogDensity.value = this.fogDensity;
    pu.uShaft.value = this.shaft;
    this.compPass.render(r, this.compRT);

    // 4. bloom
    this.prefilter.uniforms.uSrc.value = this.compRT.texture;
    this.prefilter.uniforms.uTexel.value.set(0.5 / this.width, 0.5 / this.height);
    this.prefilter.render(r, this.bloomDown[0]);
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      const src = this.bloomDown[i - 1];
      this.down.uniforms.uSrc.value = src.texture;
      this.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.down.render(r, this.bloomDown[i]);
    }
    let lower = this.bloomDown[BLOOM_LEVELS - 1];
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      this.up.uniforms.uSrc.value = lower.texture;
      this.up.uniforms.uBase.value = this.bloomDown[i].texture;
      this.up.uniforms.uTexel.value.set(1 / lower.width, 1 / lower.height);
      this.up.render(r, this.bloomUp[i]);
      lower = this.bloomUp[i];
    }

    // 5. final
    const fu = this.final.uniforms;
    fu.uHdr.value = this.compRT.texture;
    fu.uBloom.value = this.bloomUp[0].texture;
    fu.uBloomStrength.value = this.bloomStrength;
    fu.uSaturation.value = this.saturation;
    fu.uFade.value = this.fade;
    this.final.render(r, null);
  }
}
