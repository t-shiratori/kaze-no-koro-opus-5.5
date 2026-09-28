import * as THREE from "three";

export const FSQ_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const geometry = new THREE.BufferGeometry();
geometry.setAttribute(
  "position",
  new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
);

/** A single big triangle covering the viewport. */
export class FullscreenPass {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.RawShaderMaterial;
  private static camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(
    fragmentShader: string,
    uniforms: Record<string, THREE.IUniform>,
    defines?: Record<string, string | number>,
  ) {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `precision highp float;\nin vec3 position;\n${FSQ_VERT}`,
      fragmentShader,
      uniforms,
      ...(defines ? { defines } : {}),
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null) {
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, FullscreenPass.camera);
  }
}
