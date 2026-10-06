import * as THREE from "three";
import { damp } from "./core/math";
import { computeLighting, createLightingState } from "./env/atmosphere";
import { TimeOfDay } from "./env/time";
import { Weather } from "./env/weather";
import { Autopilot } from "./flight/autopilot";
import { Director } from "./flight/director";
import { G, globalsFor } from "./render/globals";
import { Pipeline } from "./render/pipeline";
import { SKY_DOME_FRAG, SKY_DOME_VERT } from "./render/shaders/sky";
import { UI } from "./ui/ui";
import { Birds } from "./world/birds";
import { BoatTraffic } from "./world/boats";
import { IslandManager } from "./world/islands/manager";
import { NightLights } from "./world/nightLights";
import { Ocean } from "./world/ocean";
import { buildPlane } from "./world/plane";
import { AirTraffic } from "./world/traffic";

function start() {
  const canvas = document.createElement("canvas");
  document.body.prepend(canvas);
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      logarithmicDepthBuffer: true,
      powerPreference: "high-performance",
      stencil: false,
    });
  } catch {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="nogl">WebGL2 が利用できないため、この景色を表示できません。</div>`,
    );
    return;
  }
  renderer.autoClear = false;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x000000, 1);

  const time = new TimeOfDay(8.6 + Math.random() * 2.5);
  const lighting = createLightingState();
  const weather = new Weather(renderer);
  const pipeline = new Pipeline(renderer);
  const lights = new NightLights();
  const islands = new IslandManager(lights);
  const ocean = new Ocean(renderer);
  const boats = new BoatTraffic(islands, lights);
  const birds = new Birds(islands);
  const traffic = new AirTraffic(lights);
  const pilot = new Autopilot(islands, weather);
  const director = new Director(window.innerWidth / window.innerHeight, pilot, islands, weather);
  const camera = director.camera;

  // ---- scene ----
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(40000, 48, 24),
    new THREE.ShaderMaterial({
      vertexShader: SKY_DOME_VERT,
      fragmentShader: SKY_DOME_FRAG,
      uniforms: {
        ...globalsFor(
          "uTime",
          "uSunDir",
          "uSunColor",
          "uTrueSunDir",
          "uAmbZenith",
          "uAmbHorizon",
          "uNight",
          "uWind",
          "uCloudOffset",
          "uCloudShadow",
          "uCloudShadowFrame",
          "uHeightMap",
          "uHeightFrame",
          "uSkyLUT",
        ),
        uMoonDir: G.uMoonDir,
        uCirrus: G.uCirrus,
        uSunDisk: { value: new THREE.Color() },
        uMoonColor: { value: new THREE.Color() },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    }),
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  scene.add(sky);
  scene.add(ocean.mesh, islands.group, boats.group, birds.mesh, traffic.group, lights.points);

  const plane = buildPlane();
  scene.add(plane.group);

  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -11;
  sc.right = 11;
  sc.top = 11;
  sc.bottom = -11;
  sc.near = 1;
  sc.far = 80;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 1);
  scene.add(hemi);

  // image based ambient light: the sky above and a dark sea below, refreshed now and then
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(sky.geometry, sky.material));
  const envSeaMat = new THREE.MeshBasicMaterial({ color: 0x0a2233 });
  const envSea = new THREE.Mesh(
    new THREE.CircleGeometry(38000, 32).rotateX(-Math.PI / 2),
    envSeaMat,
  );
  envSea.position.y = -60;
  envScene.add(envSea);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT: THREE.WebGLRenderTarget | null = null;
  let envTimer = 0;

  const ui = new UI(time, director);
  // a hard cut must not smear the previous shot's clouds into the new one
  director.cinema.onCut = () => pipeline.resetHistory();

  // ---- interaction: drag to look around, wheel to zoom; it drifts back by itself ----
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    director.touch();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    director.userYaw -= (e.clientX - lastX) * 0.005;
    director.userElev = THREE.MathUtils.clamp(
      director.userElev + (e.clientY - lastY) * 0.004,
      -0.5,
      1.1,
    );
    lastX = e.clientX;
    lastY = e.clientY;
    director.touch();
  });
  canvas.addEventListener("pointerup", () => (dragging = false));
  canvas.addEventListener(
    "wheel",
    (e) => {
      director.userZoom = THREE.MathUtils.clamp(
        director.userZoom * Math.exp(e.deltaY * 0.001),
        0.5,
        3,
      );
      director.touch();
    },
    { passive: true },
  );

  // ---- sizing & adaptive resolution ----
  let renderScale = 1;
  const maxDpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setPixelRatio(maxDpr * renderScale);
    renderer.setSize(w, h, false);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    pipeline.setSize(canvas.width, canvas.height);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  // warm up the world around the start point before revealing it
  islands.update(pilot.position, renderer);

  const timer = new THREE.Timer();
  timer.connect(document);
  let elapsed = 0;
  let frameAvg = 16;
  let scaleCooldown = 3;
  let revealed = false;
  let fade = 0;
  const veil = document.getElementById("veil");
  const params = new URLSearchParams(location.search);
  const instant = params.has("instant");
  if (params.has("t")) time.hours = Number(params.get("t"));
  const tmpV = new THREE.Vector3();
  const tmpC = new THREE.Color();
  let lastRays = false;

  const frame = () => {
    timer.update();
    // (dev tooling may run the page hidden at ~1 fps: allow bigger steps there)
    const rawDt = Math.min(timer.getDelta(), import.meta.env.DEV && document.hidden ? 0.6 : 0.1);
    const dt = rawDt;
    elapsed += dt;
    G.uTime.value = elapsed;

    // ---- world clock, light & wind ----
    time.update(dt);
    computeLighting(time.sunDir, time.moonDir, lighting);
    G.uTrueSunDir.value.copy(time.sunDir);
    G.uMoonDir.value.copy(time.moonDir);
    G.uSunDir.value.copy(lighting.mainDir);
    G.uSunColor.value.copy(lighting.mainColor);
    // weather mood: a broken cloud deck arrives for the light-shaft mode, and now and
    // then on its own while the day drifts by
    const rays = time.mode === "rays";
    const autoDeck = THREE.MathUtils.smoothstep(Math.sin(elapsed * 0.0042 - 1.9), 0.72, 0.97) * 0.8;
    G.uDeck.value = damp(G.uDeck.value, rays ? 1 : autoDeck, rays ? 0.35 : 0.15, dt);
    const deck = G.uDeck.value * (1 - time.night * 0.6);
    // under a cloud deck the skylight is softer and greyer
    G.uAmbZenith.value.copy(lighting.skyZenith).multiplyScalar(1 - deck * 0.45);
    G.uAmbHorizon.value.copy(lighting.skyHorizon).multiplyScalar(1 - deck * 0.3);
    G.uNight.value = time.night;
    G.uExposure.value = damp(G.uExposure.value, lighting.exposure, 1.2, dt);
    const windA = 0.6 + Math.sin(elapsed * 0.0041) * 0.7 + Math.sin(elapsed * 0.0107) * 0.25;
    const windS = 6.5 + Math.sin(elapsed * 0.013 + 1) * 2.5;
    G.uWind.value.set(Math.cos(windA) * windS, Math.sin(windA) * windS);
    G.uCloudOffset.value.addScaledVector(G.uWind.value, dt * 1.6);
    G.uCloudCover.value =
      0.5 +
      Math.sin(elapsed * 0.0023 + 2) * 0.09 +
      Math.sin(elapsed * 0.0071) * 0.05 -
      G.uDeck.value * 0.12;

    // high cirrus comes and goes over tens of minutes
    G.uCirrus.value =
      THREE.MathUtils.clamp(0.45 + 0.45 * Math.sin(elapsed * 0.0017 + 0.4), 0, 1) *
      (1 - G.uDeck.value);
    const skyUniforms = (sky.material as THREE.ShaderMaterial).uniforms;
    (skyUniforms.uSunDisk.value as THREE.Color).copy(lighting.sunColor).multiplyScalar(1 / 22);
    (skyUniforms.uMoonColor.value as THREE.Color)
      .setRGB(0.9, 0.95, 1.05)
      .multiplyScalar(0.25 * THREE.MathUtils.smoothstep(time.moonDir.y, -0.05, 0.05));

    // morning mist, clear noon, golden haze at dusk
    const h = time.hours;
    const morning = Math.exp(-Math.pow((h - 7) / 1.6, 2));
    const dusk = Math.exp(-Math.pow((h - 18) / 1.5, 2));
    pipeline.fogDensity =
      (0.62e-4 + morning * 0.9e-4 + dusk * 0.35e-4 + time.night * 0.3e-4) * (1 - deck * 0.35);
    G.uShaftHaze.value = (0.4e-4 + morning * 0.4e-4 + deck * 5.5e-4) * (1 - time.night * 0.7);
    // light shafts are an occasional gift, not a constant effect
    const shaftWave = 0.5 + 0.5 * Math.sin(elapsed * 0.011 + 1.3) * Math.sin(elapsed * 0.0047);
    pipeline.shaft = 0.6 + 0.8 * Math.pow(shaftWave, 2) + deck * 0.6;
    pipeline.bloomStrength = 0.05 + time.night * 0.05;
    pipeline.saturation = 1.08 - time.night * 0.2;
    pipeline.gradeShadows.set(0.97 + dusk * 0.02, 0.99, 1.03 + time.night * 0.05);
    pipeline.gradeHighlights.set(1.02 + dusk * 0.04, 1.0, 0.98 - dusk * 0.03);

    // ---- flight & camera ----
    pilot.update(dt);
    plane.group.position.copy(pilot.position);
    plane.group.quaternion.copy(pilot.quaternion);
    plane.prop.rotation.z += dt * 55;
    plane.propDisc.visible = true;
    plane.rudder.rotation.y = -pilot.turnRate * 2.5;
    plane.elevator.rotation.x = -pilot.verticalSpeed * 0.02;
    plane.aileronL.rotation.x = pilot.turnRate * 3;
    plane.aileronR.rotation.x = -pilot.turnRate * 3;
    director.sunDir.copy(time.sunDir);
    director.beamMood = G.uDeck.value * (1 - time.night);
    pilot.lowCeiling = G.uDeck.value > 0.4;
    if (rays !== lastRays) {
      lastRays = rays;
      if (rays) director.refresh();
    }
    director.update(dt);

    // ---- the living world ----
    islands.update(pilot.position, renderer);
    boats.update(dt, pilot.position, pilot.forward);
    birds.update(dt, pilot.position, pilot.forward, pilot.speed);
    traffic.update(dt, pilot.position, pilot.forward);
    lights.update(camera, canvas.height);

    // ---- lights for built-in materials ----
    sun.color.copy(lighting.mainColor).multiplyScalar(1 / 22);
    sun.intensity = 22 * 0.3;
    tmpV.copy(lighting.mainDir).multiplyScalar(40);
    sun.position.copy(pilot.position).add(tmpV);
    sun.target.position.copy(pilot.position);
    sun.target.updateMatrixWorld();
    hemi.color.copy(lighting.skyZenith).multiplyScalar(0.6);
    hemi.groundColor.copy(lighting.skyHorizon).multiplyScalar(0.2);
    hemi.intensity = 1;

    sky.position.copy(camera.position);

    // ---- render ----
    pipeline.renderEnvironment(camera.position, lighting.sunTint);
    envTimer -= dt;
    if (envTimer <= 0) {
      envTimer = time.mode === "auto" ? 2 : 0.4;
      envSeaMat.color
        .copy(lighting.skyHorizon)
        .multiplyScalar(0.18)
        .add(
          tmpC
            .setRGB(0.004, 0.03, 0.085)
            .multiplyScalar(lighting.mainColor.g * Math.max(lighting.mainDir.y, 0) * 0.12),
        );
      const next = pmrem.fromScene(envScene, 0, 1, 60000);
      envRT?.dispose();
      envRT = next;
      scene.environment = envRT.texture;
      scene.environmentIntensity = 1;
    }
    ocean.update(renderer, camera, boats.wakes);
    if (!revealed && ((islands.loading === 0 && elapsed > 1.2) || instant)) {
      revealed = true;
      veil?.classList.add("gone");
    }
    if (revealed) fade = instant ? 1 : Math.min(1, fade + dt / 3);
    pipeline.fade = fade;
    pipeline.render(scene, camera);
    ui.update();

    // ---- adaptive resolution ----
    frameAvg = frameAvg * 0.95 + rawDt * 1000 * 0.05;
    scaleCooldown -= dt;
    if (scaleCooldown <= 0 && revealed) {
      if (frameAvg > 21 && renderScale > 0.55) {
        renderScale = Math.max(0.55, renderScale - 0.1);
        resize();
        scaleCooldown = 2.5;
      } else if (frameAvg < 13 && renderScale < 1) {
        renderScale = Math.min(1, renderScale + 0.05);
        resize();
        scaleCooldown = 4;
      }
    }
    schedule();
  };
  // in development keep the world ticking even when the tab is hidden (for tooling)
  let rafId = 0;
  let timeoutId = 0;
  const tick = () => {
    cancelAnimationFrame(rafId);
    clearTimeout(timeoutId);
    frame();
  };
  const schedule = () => {
    rafId = requestAnimationFrame(tick);
    if (import.meta.env.DEV) timeoutId = window.setTimeout(tick, 60);
  };
  schedule();

  // debug handle for development
  if (import.meta.env.DEV)
    (window as unknown as { __world: unknown }).__world = {
      time,
      pilot,
      director,
      islands,
      pipeline,
      weather,
      renderer,
      boats,
      ocean,
      birds,
      traffic,
    };
}

start();
