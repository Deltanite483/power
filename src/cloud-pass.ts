import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

export interface CloudDepthUniforms {
  uSceneDepth: { value: THREE.Texture | null };
  uCloudSize: { value: THREE.Vector2 };
  uCameraFar: { value: number };
}

/** Raymarch fewer pixels, then reconstruct against the full-resolution scene depth. */
export class CloudPass extends Pass {
  private readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  private readonly oldColor = new THREE.Color();
  private readonly material = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: {
      tScene: { value: null }, tClouds: { value: this.target.texture }, tDepth: { value: null },
      uSize: { value: new THREE.Vector2() }, uLogFar: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene, tClouds, tDepth;
      uniform vec2 uSize;
      uniform float uLogFar;
      varying vec2 vUv;
      float depthAt(vec2 uv) { return exp2(texture2D(tDepth, uv).r * uLogFar) - 1.0; }
      void main() {
        vec2 p = vUv * uSize - 0.5, base = floor(p), f = fract(p);
        float depth = depthAt(vUv);
        vec4 clouds = vec4(0.0);
        float weights = 0.0, closest = 1e20;
        vec4 nearestCloud = vec4(0.0);
        // Bilateral upsampling keeps half-resolution clouds from bleeding across ridgelines.
        for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
          vec2 corner = vec2(float(x), float(y));
          vec2 uv = (base + corner + 0.5) / uSize;
          vec2 bilinear = mix(1.0 - f, f, corner);
          float w = bilinear.x * bilinear.y;
          float delta = abs(depthAt(uv) - depth);
          vec4 sampleCloud = texture2D(tClouds, uv);
          if (delta < closest) { closest = delta; nearestCloud = sampleCloud; }
          w *= exp(-delta / max(8.0, depth * 0.015));
          clouds += sampleCloud * w;
          weights += w;
        }
        clouds = weights > 0.001 ? clouds / weights : nearestCloud;
        // Rendering into a transparent target accumulates premultiplied cloud color.
        vec3 scene = texture2D(tScene, vUv).rgb;
        gl_FragColor = vec4(clouds.rgb + scene * (1.0 - clouds.a), 1.0);
      }`,
  });
  private readonly quad = new FullScreenQuad(this.material);

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private depth: CloudDepthUniforms) {
    super();
  }

  setSize(width: number, height: number) {
    // 36% of the full-resolution raymarch work; terrain and HUD retain full resolution.
    this.target.setSize(Math.max(1, Math.round(width * 0.6)), Math.max(1, Math.round(height * 0.6)));
    this.depth.uCloudSize.value.set(this.target.width, this.target.height);
    this.material.uniforms.uSize.value.copy(this.depth.uCloudSize.value);
  }

  render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
    this.depth.uSceneDepth.value = read.depthTexture;
    this.depth.uCameraFar.value = this.camera.far;
    const autoClear = renderer.autoClear, alpha = renderer.getClearAlpha();
    renderer.getClearColor(this.oldColor);
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setClearColor(this.oldColor, alpha);
    renderer.autoClear = autoClear;
    this.material.uniforms.tScene.value = read.texture;
    this.material.uniforms.tDepth.value = read.depthTexture;
    this.material.uniforms.uLogFar.value = Math.log2(this.camera.far + 1);
    renderer.setRenderTarget(this.renderToScreen ? null : write);
    this.quad.render(renderer);
  }

  dispose() { this.target.dispose(); this.material.dispose(); this.quad.dispose(); }
}
