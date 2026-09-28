import * as THREE from "three";
import { G } from "../../render/globals";
import { patchWorldMaterial } from "../../render/worldMaterial";
import type { NightLights } from "../nightLights";
import {
  cypressGeometry,
  houseWallGeometry,
  lighthouseGroup,
  makeTreeMaterial,
  oliveGeometry,
  pierGeometry,
  srgbColor,
  tileRoofGeometry,
  towerGeometry,
  umbrellaPineGeometry,
} from "../props";
import { makeBoatMesh } from "../boatModels";
import type { IslandBuild, MeshArrays } from "./builder";
import {
  CELL_SIZE,
  islandForCell,
  islandSample,
  type IslandSpec,
  type TerrainSample,
} from "./terrain";

const VIEW_RADIUS = 19000;
const PROP_IN = 6500;
const PROP_OUT = 8000;
const LOD_SWITCH = 3800;
const HEIGHTMAP_SIZE = 14000;
const HEIGHTMAP_RES = 1536;

export interface Island {
  spec: IslandSpec;
  build: IslandBuild | null;
  lod: THREE.LOD | null;
  props: THREE.Group | null;
  heightProxy: THREE.Mesh | null;
  beams: THREE.Mesh[];
  lamp: THREE.Vector3 | null;
}

// ---- shared resources ----
let terrainMat: THREE.MeshStandardMaterial | null = null;
let heightMat: THREE.ShaderMaterial | null = null;
const shared: {
  pine?: THREE.BufferGeometry;
  cypress?: THREE.BufferGeometry;
  olive?: THREE.BufferGeometry;
  treeMat?: THREE.Material;
  wall?: THREE.BufferGeometry;
  roof?: THREE.BufferGeometry;
  wallMat?: THREE.Material;
  roofMat?: THREE.Material;
  stoneMat?: THREE.Material;
  beamGeo?: THREE.BufferGeometry;
  beamMat?: THREE.ShaderMaterial;
} = {};

function ensureShared() {
  if (shared.pine) return;
  shared.pine = umbrellaPineGeometry();
  shared.cypress = cypressGeometry();
  shared.olive = oliveGeometry();
  shared.treeMat = makeTreeMaterial();
  shared.wall = houseWallGeometry();
  shared.roof = tileRoofGeometry();
  shared.wallMat = patchWorldMaterial(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }),
    {
      windows: true,
    },
  );
  shared.roofMat = patchWorldMaterial(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }),
    {
      breakup: 0.1,
    },
  );
  shared.stoneMat = patchWorldMaterial(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    {
      breakup: 0.12,
    },
  );
  // lighthouse beam: a long soft cone of light
  const beam = new THREE.ConeGeometry(30, 520, 24, 1, true);
  beam.translate(0, -260, 0);
  beam.rotateZ(Math.PI / 2);
  shared.beamGeo = beam;
  shared.beamMat = new THREE.ShaderMaterial({
    uniforms: { uNight: G.uNight },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vAlong = clamp(position.x / 520.0, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uNight;
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
        float a = (1.0 - vAlong) * (1.0 - vAlong) * edge * uNight;
        gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * a * 0.35, 1.0);
        #include <logdepthbuf_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function geometryFrom(a: MeshArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(a.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(a.normals, 3));
  g.setAttribute("color", new THREE.BufferAttribute(a.colors, 3));
  g.setIndex(new THREE.BufferAttribute(a.indices, 1));
  g.computeBoundingSphere();
  return g;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

export class IslandManager {
  readonly group = new THREE.Group();
  readonly islands = new Map<string, Island>();
  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private queue: IslandSpec[] = [];
  private pending = new Set<string>();

  // height map for the ocean shader
  private heightRT: THREE.WebGLRenderTarget;
  private heightScene = new THREE.Scene();
  private heightCam: THREE.OrthographicCamera;
  private heightCenter = new THREE.Vector2(1e9, 1e9);
  private heightDirty = true;
  private seaFloor: THREE.Mesh;
  private sample: TerrainSample = { h: 0, veg: 0, cliff: 0, sd: 0 };

  constructor(lights: NightLights) {
    ensureShared();
    terrainMat = patchWorldMaterial(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 }),
      { breakup: 0.1 },
    );
    heightMat = new THREE.ShaderMaterial({
      vertexShader: `varying float vY; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `varying float vY; void main(){ gl_FragColor = vec4(vY, 0.0, 0.0, 1.0); }`,
    });
    const n = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<IslandBuild>) => {
        this.busy[i] = false;
        this.onBuilt(e.data);
        this.pump();
      };
      this.workers.push(w);
      this.busy.push(false);
    }
    this.heightRT = new THREE.WebGLRenderTarget(HEIGHTMAP_RES, HEIGHTMAP_RES, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    });
    const hs = HEIGHTMAP_SIZE / 2;
    this.heightCam = new THREE.OrthographicCamera(-hs, hs, hs, -hs, 1, 3000);
    this.heightCam.up.set(0, 0, -1);
    this.seaFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(HEIGHTMAP_SIZE * 1.2, HEIGHTMAP_SIZE * 1.2).rotateX(-Math.PI / 2),
      heightMat,
    );
    this.seaFloor.frustumCulled = false;
    this.heightScene.add(this.seaFloor);
    G.uHeightMap.value = this.heightRT.texture;

    lights.addProvider((emit) => this.emitLights(emit));
  }

  /** Terrain height (m) at a world point, from the analytic island functions. */
  heightAt(x: number, z: number): number {
    let h = -60;
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const isl = this.islands.get(`${cx + i},${cz + j}`);
        if (!isl) continue;
        const s = isl.spec;
        const dx = x - s.x;
        const dz = z - s.z;
        if (dx * dx + dz * dz > (s.extent + 600) ** 2) continue;
        h = Math.max(h, islandSample(s, dx, dz, this.sample).h);
      }
    }
    return h;
  }

  /** Islands whose centre lies within `radius` of a point, nearest first. */
  near(x: number, z: number, radius: number): Island[] {
    const out: { i: Island; d: number }[] = [];
    for (const isl of this.islands.values()) {
      const d = Math.hypot(isl.spec.x - x, isl.spec.z - z);
      if (d < radius) out.push({ i: isl, d });
    }
    return out.toSorted((a, b) => a.d - b.d).map((o) => o.i);
  }

  private pump() {
    for (let i = 0; i < this.workers.length; i++) {
      if (this.busy[i] || this.queue.length === 0) continue;
      const spec = this.queue.shift()!;
      this.busy[i] = true;
      this.workers[i].postMessage(spec);
    }
  }

  get loading(): number {
    return this.queue.length + this.busy.filter(Boolean).length;
  }

  private onBuilt(b: IslandBuild) {
    this.pending.delete(b.id);
    const isl = this.islands.get(b.id);
    if (!isl) return;
    isl.build = b;
    const lod = new THREE.LOD();
    const hi = new THREE.Mesh(geometryFrom(b.hi), terrainMat!);
    const lo = new THREE.Mesh(geometryFrom(b.lo), terrainMat!);
    lod.addLevel(hi, 0);
    lod.addLevel(lo, LOD_SWITCH);
    lod.position.set(isl.spec.x, 0, isl.spec.z);
    lod.updateMatrixWorld(true);
    isl.lod = lod;
    this.group.add(lod);
    const proxy = new THREE.Mesh(hi.geometry, heightMat!);
    proxy.position.copy(lod.position);
    proxy.frustumCulled = false;
    isl.heightProxy = proxy;
    this.heightScene.add(proxy);
    this.heightDirty = true;
  }

  update(focus: THREE.Vector3, renderer: THREE.WebGLRenderer) {
    // discover cells in view
    const r = Math.ceil(VIEW_RADIUS / CELL_SIZE);
    const fcx = Math.floor(focus.x / CELL_SIZE);
    const fcz = Math.floor(focus.z / CELL_SIZE);
    const wanted = new Set<string>();
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        const cx = fcx + i;
        const cz = fcz + j;
        const ccx = (cx + 0.5) * CELL_SIZE;
        const ccz = (cz + 0.5) * CELL_SIZE;
        if (Math.hypot(ccx - focus.x, ccz - focus.z) > VIEW_RADIUS + CELL_SIZE) continue;
        const key = `${cx},${cz}`;
        wanted.add(key);
        if (this.islands.has(key)) continue;
        const spec = islandForCell(cx, cz);
        if (!spec) continue;
        this.islands.set(key, {
          spec,
          build: null,
          lod: null,
          props: null,
          heightProxy: null,
          beams: [],
          lamp: null,
        });
        this.pending.add(key);
        this.queue.push(spec);
      }
    }
    // drop far islands
    for (const [key, isl] of this.islands) {
      if (!wanted.has(key)) {
        this.dispose(isl);
        this.islands.delete(key);
        this.queue = this.queue.filter((s) => s.id !== key);
      }
    }
    this.queue.sort(
      (a, b) => Math.hypot(a.x - focus.x, a.z - focus.z) - Math.hypot(b.x - focus.x, b.z - focus.z),
    );
    this.pump();

    // props streaming
    for (const isl of this.islands.values()) {
      if (!isl.build) continue;
      const d = Math.hypot(isl.spec.x - focus.x, isl.spec.z - focus.z) - isl.spec.extent;
      if (!isl.props && d < PROP_IN) this.createProps(isl);
      else if (isl.props && d > PROP_OUT) this.disposeProps(isl);
    }

    // lighthouse beams rotate
    const t = G.uTime.value;
    for (const isl of this.islands.values()) {
      isl.beams.forEach((b, i) => {
        b.rotation.set(0, t * 0.55 + i * Math.PI, 0);
        b.visible = G.uNight.value > 0.02;
      });
    }

    // height map
    if (Math.hypot(focus.x - this.heightCenter.x, focus.z - this.heightCenter.y) > 1400)
      this.heightDirty = true;
    if (this.heightDirty) {
      this.heightDirty = false;
      this.heightCenter.set(Math.round(focus.x / 50) * 50, Math.round(focus.z / 50) * 50);
      this.heightCam.position.set(this.heightCenter.x, 1500, this.heightCenter.y);
      this.heightCam.lookAt(this.heightCenter.x, 0, this.heightCenter.y);
      this.heightCam.updateMatrixWorld();
      this.seaFloor.position.set(this.heightCenter.x, -60, this.heightCenter.y);
      renderer.setRenderTarget(this.heightRT);
      renderer.clear(true, true, false);
      renderer.render(this.heightScene, this.heightCam);
      renderer.setRenderTarget(null);
      G.uHeightFrame.value.set(this.heightCenter.x, this.heightCenter.y, HEIGHTMAP_SIZE);
    }
  }

  private createProps(isl: Island) {
    const b = isl.build!;
    const g = new THREE.Group();
    g.position.set(isl.spec.x, 0, isl.spec.z);
    const hash = (i: number) => {
      const x = Math.sin(i * 12.9898 + isl.spec.seed * 0.1) * 43758.5453;
      return x - Math.floor(x);
    };

    // trees
    const kinds = [shared.pine!, shared.cypress!, shared.olive!];
    const counts = [0, 0, 0];
    for (let i = 0; i < b.trees.length; i += 6) counts[b.trees[i + 5]]++;
    const meshes = kinds.map((geo, k) => {
      if (counts[k] === 0) return null;
      const m = new THREE.InstancedMesh(geo, shared.treeMat!, counts[k]);
      m.count = 0;
      return m;
    });
    for (let i = 0; i < b.trees.length; i += 6) {
      const k = b.trees[i + 5];
      const m = meshes[k]!;
      const sc = b.trees[i + 3];
      _p.set(b.trees[i], b.trees[i + 1], b.trees[i + 2]);
      _q.setFromEuler(_e.set((hash(i) - 0.5) * 0.08, b.trees[i + 4], (hash(i + 1) - 0.5) * 0.08));
      _s.set(sc, sc * (0.85 + hash(i + 2) * 0.3), sc);
      _m.compose(_p, _q, _s);
      m.setMatrixAt(m.count, _m);
      const v = 0.85 + hash(i + 3) * 0.3;
      m.setColorAt(m.count, _c.setRGB(v, v * (0.95 + hash(i + 4) * 0.1), v * 0.95));
      m.count++;
    }
    for (const m of meshes) {
      if (!m) continue;
      m.computeBoundingSphere();
      g.add(m);
    }

    // houses
    const nh = b.houses.length / 8;
    if (nh > 0) {
      const walls = new THREE.InstancedMesh(shared.wall!, shared.wallMat!, nh);
      const roofCount = Array.from({ length: nh }, (_, i) => b.houses[i * 8 + 7]).filter(
        (r) => r >= 1,
      ).length;
      const roofs = new THREE.InstancedMesh(shared.roof!, shared.roofMat!, Math.max(roofCount, 1));
      roofs.count = 0;
      const wallTints = [0xf4f1ea, 0xf2ede2, 0xefe6d2, 0xf3efe8, 0xe9dcc0, 0xdfe6ea, 0xf0e2d0];
      for (let i = 0; i < nh; i++) {
        const o = i * 8;
        const [x, y, z, rot, w, d, h, roof] = b.houses.slice(o, o + 8);
        _p.set(x, y - 3, z);
        _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -rot);
        _s.set(roof === 2 ? 3.4 : w, h + 3, roof === 2 ? 3.4 : d);
        _m.compose(_p, _q, _s);
        walls.setMatrixAt(i, _m);
        walls.setColorAt(i, srgbColor(wallTints[Math.floor(hash(i) * wallTints.length)]));
        if (roof >= 1) {
          _p.set(x, y + h, z);
          if (roof === 2) _s.set(3.8, 5, 3.8);
          else _s.set(w, Math.min(w, d) * 0.9, d);
          _m.compose(_p, _q, _s);
          roofs.setMatrixAt(roofs.count, _m);
          roofs.setColorAt(
            roofs.count,
            srgbColor(hash(i + 9) < 0.8 ? 0xb65a3a : 0xa8503a).multiplyScalar(
              0.9 + hash(i + 7) * 0.2,
            ),
          );
          roofs.count++;
        }
      }
      walls.computeBoundingSphere();
      roofs.computeBoundingSphere();
      g.add(walls, roofs);
    }

    if (b.lighthouse) {
      const { group, lamp } = lighthouseGroup();
      group.position.set(b.lighthouse[0], b.lighthouse[1] - 0.3, b.lighthouse[2]);
      g.add(group);
      group.updateMatrixWorld(true);
      const lampLocal = lamp.getWorldPosition(new THREE.Vector3());
      isl.lamp = new THREE.Vector3(lampLocal.x + isl.spec.x, lampLocal.y, lampLocal.z + isl.spec.z);
      for (let k = 0; k < 2; k++) {
        const beam = new THREE.Mesh(shared.beamGeo!, shared.beamMat!);
        beam.position.set(b.lighthouse[0], b.lighthouse[1] + 18.2, b.lighthouse[2]);
        beam.renderOrder = 11;
        beam.frustumCulled = false;
        isl.beams.push(beam);
        g.add(beam);
      }
      const lantern = group.getObjectByName("lantern") as THREE.Mesh | undefined;
      if (lantern) {
        const mat = lantern.material as THREE.MeshStandardMaterial;
        lantern.onBeforeRender = () => {
          mat.emissiveIntensity = G.uNight.value * 6;
        };
      }
    }
    if (b.tower) {
      const m = new THREE.Mesh(towerGeometry(isl.spec.seed), shared.stoneMat!);
      m.position.set(b.tower[0], b.tower[1] - 0.5, b.tower[2]);
      m.rotation.y = hash(5) * 6;
      g.add(m);
    }
    if (b.pier) {
      const m = new THREE.Mesh(pierGeometry(b.pier[4]), shared.stoneMat!);
      m.position.set(b.pier[0], b.pier[1] - 0.8, b.pier[2]);
      m.rotation.y = -b.pier[3];
      g.add(m);
    }
    for (let i = 0; i < b.moorings.length; i += 3) {
      const boat = makeBoatMesh("fishing", Math.floor(hash(i + 20) * 1000));
      boat.position.set(b.moorings[i], 0, b.moorings[i + 1]);
      boat.rotation.y = -b.moorings[i + 2];
      boat.userData.bob = hash(i) * 10;
      boat.onBeforeRender = () => {
        const t = G.uTime.value + (boat.userData.bob ?? 0);
        boat.position.y = Math.sin(t * 0.9) * 0.15 - 0.1;
        boat.rotation.z = Math.sin(t * 0.7) * 0.03;
      };
      g.add(boat);
    }
    g.traverse((o) => {
      o.matrixAutoUpdate = true;
    });
    isl.props = g;
    this.group.add(g);
  }

  private disposeProps(isl: Island) {
    if (!isl.props) return;
    isl.props.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
    // geometries of towers/piers are unique
    isl.props.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) {
        const shared0 = o.geometry === shared.beamGeo;
        if (!shared0) o.geometry.dispose();
      }
    });
    this.group.remove(isl.props);
    isl.props = null;
    isl.beams = [];
    isl.lamp = null;
  }

  private dispose(isl: Island) {
    this.disposeProps(isl);
    if (isl.lod) {
      for (const l of isl.lod.levels) (l.object as THREE.Mesh).geometry.dispose();
      this.group.remove(isl.lod);
    }
    if (isl.heightProxy) {
      this.heightScene.remove(isl.heightProxy);
      this.heightDirty = true;
    }
  }

  private emitLights(emit: Parameters<Parameters<NightLights["addProvider"]>[0]>[0]) {
    const t = G.uTime.value;
    for (const isl of this.islands.values()) {
      const b = isl.build;
      if (!b) continue;
      for (let i = 0; i < b.lights.length; i += 4) {
        const kind = b.lights[i + 3];
        const x = b.lights[i] + isl.spec.x;
        const z = b.lights[i + 2] + isl.spec.z;
        if (kind === 0) {
          emit({
            x,
            y: b.lights[i + 1],
            z,
            r: 1,
            g: 0.6,
            b: 0.26,
            intensity: 5,
            size: 1.6,
            phase: (i * 0.37) % 1,
          });
        } else {
          emit({
            x,
            y: b.lights[i + 1] + 1,
            z,
            r: 1,
            g: 0.75,
            b: 0.45,
            intensity: 8,
            size: 2.6,
            phase: -1,
          });
        }
      }
      if (b.lighthouse) {
        // bright sweeping flash: strongest when the beam faces the viewer (approx.)
        const flash = Math.pow(Math.max(0, Math.sin(t * 0.55 * 2)), 16) * 30 + 10;
        emit({
          x: b.lighthouse[0] + isl.spec.x,
          y: b.lighthouse[1] + 18.5,
          z: b.lighthouse[2] + isl.spec.z,
          r: 1,
          g: 0.88,
          b: 0.65,
          intensity: flash,
          size: 6,
          phase: -1,
        });
      }
    }
  }
}
