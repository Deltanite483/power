import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import { CloudDamage, type CloudBank } from "./cloud-damage";
import { CloudTerrain } from "./cloud-terrain";
import { CloudPass, type CloudDepthUniforms } from "./cloud-pass";

export type CloudBodyVisitor = (id: object | number, position: THREE.Vector3, velocity: THREE.Vector3, radius: number) => void;

/** Soft world-anchored vapor ribbons: actual flight motion supplies the parallax. */
class CloudWisps {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

  constructor() {
    const centers: number[] = [], corners: number[] = [];
    const random = (n: number) => THREE.MathUtils.seededRandom(n);
    for (let i = 0; i < 96; i++) {
      const x = (random(i * 3 + 901) - 0.5) * 160;
      const y = (random(i * 3 + 902) - 0.5) * 160;
      const z = (random(i * 3 + 903) - 0.5) * 160;
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
        centers.push(x, y, z); corners.push(u, v);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(centers, 3));
    geometry.setAttribute("aCorner", new THREE.Float32BufferAttribute(corners, 2));
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uVelocity: { value: new THREE.Vector3() }, uDensity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec2 aCorner;
        uniform vec3 uVelocity;
        uniform float uDensity, uTime;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          vec3 wind = vec3(10.0, 0.0, 3.0);
          vec3 relative = position + wind * uTime - cameraPosition;
          relative = mod(relative + 80.0, 160.0) - 80.0;
          vec3 center = cameraPosition + relative;
          float speed = length(uVelocity);
          vec3 along = normalize(uVelocity - wind + vec3(0.001));
          vec3 across = normalize(cross(along, normalize(relative)) + vec3(0.001));
          float trailLength = 0.8 + min(32.0, speed * 0.045);
          vec3 world = center + along * aCorner.y * trailLength + across * aCorner.x * 0.9;
          vUv = aCorner;
          float distance = length(relative);
          vAlpha = uDensity * smoothstep(5.0, 80.0, speed) * 0.23
            * smoothstep(3.0, 12.0, distance) * (1.0 - smoothstep(45.0, 80.0, distance));
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          float alpha = vAlpha * exp(-dot(vUv * vec2(2.0, 1.6), vUv * vec2(2.0, 1.6)));
          if (alpha < 0.002) discard;
          gl_FragColor = vec4(0.87, 0.91, 0.96, alpha);
          #include <logdepthbuf_fragment>
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  update(velocity: THREE.Vector3, density: number, time: number) {
    this.mesh.visible = density > 0.01 && velocity.lengthSq() > 25;
    const u = this.mesh.material.uniforms;
    u.uVelocity.value.copy(velocity);
    u.uDensity.value = density;
    u.uTime.value = time;
  }
}

/** World-space cloud volumes, adapted from Three.js's MIT-licensed
 * examples/webgl_volume_cloud.html. See THIRD_PARTY_NOTICES.md. */
export class Atmosphere {
  get trackedBodyCount() { return this.bodyHistory.size; }
  readonly sky = new Sky();
  readonly clouds = new THREE.Group();
  readonly cloudScene = new THREE.Scene();
  private readonly depth: CloudDepthUniforms = {
    uSceneDepth: { value: null }, uCloudSize: { value: new THREE.Vector2(1, 1) }, uCameraFar: { value: 250000 },
  };
  private readonly view = new THREE.Vector3();
  private readonly sunDirection: THREE.Vector3;
  private readonly lowHaze = new THREE.Color("#bac7dc");
  private readonly highHaze = new THREE.Color("#7f9fbe");
  private readonly warmHaze = new THREE.Color("#e9c9af");
  private time = 0;
  private readonly damage = new CloudDamage();
  readonly terrain: CloudTerrain;
  /** Enumerate every physical body after simulation; no per-frame body wrappers needed. */
  bodySource: ((visit: CloudBodyVisitor) => void) | null = null;
  private readonly bodyHistory = new Map<object | number, { position: THREE.Vector3; time: number; seen: number }>();
  private lastPrune = 0;
  private readonly bankCells = new Map<string, CloudBank[]>();
  private readonly candidates: CloudBank[] = [];
  private indexTime = -Infinity;
  private queryStamp = 0;
  /** Smoothed local density, used only when actually inside a cloud. */
  immersion = 0;
  private readonly local = new THREE.Vector3();
  private readonly densitySize = 64;
  private readonly densityData = new Uint8Array(64 ** 3);
  private readonly wisps = new CloudWisps();
  private readonly banks: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>[] = [];
  private readonly haze = new THREE.Color("#bcd4e8");

  constructor(scene: THREE.Scene, sun: THREE.Vector3, groundHeight: (x: number, z: number) => number = () => -10000) {
    this.terrain = new CloudTerrain(groundHeight);
    this.sunDirection = sun.clone().normalize();
    this.sky.scale.setScalar(180000);
    this.sky.renderOrder = -100;
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(sun).multiplyScalar(100000);
    u.turbidity.value = 3.2;
    u.rayleigh.value = 2.1;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    u.cloudCoverage.value = 0; // clouds have actual world-space depth below
    scene.add(this.sky);
    this.cloudScene.add(this.clouds, this.wisps.mesh);

    // One shared density texture; no remote assets or per-frame noise generation.
    const size = this.densitySize, data = this.densityData, noise = new ImprovedNoise();
    let index = 0;
    for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const n = noise.noise(x / 13, y / 13, z / 13) * 0.7
        + noise.noise(x / 5 + 31, y / 5, z / 5) * 0.3;
      data[index++] = Math.round(THREE.MathUtils.clamp(0.5 + n * 0.65, 0, 1) * 255);
    }
    const texture = new THREE.Data3DTexture(data, size, size, size);
    texture.format = THREE.RedFormat;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false,
      uniforms: {
        ...this.depth,
        uSteps: { value: 40 }, uQuality: { value: 2 }, uHasDamage: { value: false },
        uMap: { value: texture }, uTime: { value: 0 },
        uSun: { value: sun.clone() }, uFogColor: { value: this.haze },
        uFogDensity: { value: 0.000026 },
        uSeed: { value: new THREE.Vector3() }, uExtinction: { value: 0.012 },
        uDamage: { value: this.damage.empty },
        uTerrain: { value: this.terrain.texture }, uTerrainHalf: { value: this.terrain.half },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vOrigin, vDirection;
        void main() {
          vOrigin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
          vDirection = position - vOrigin;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        precision highp sampler3D;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform sampler3D uMap, uDamage;
        uniform sampler2D uTerrain;
        uniform float uTerrainHalf, uSteps, uQuality, uCameraFar;
        uniform bool uHasDamage;
        uniform sampler2D uSceneDepth;
        uniform vec2 uCloudSize;
        uniform float uTime, uFogDensity, uExtinction;
        uniform vec3 uSun, uFogColor, uSeed;
        uniform mat4 modelMatrix;
        varying vec3 vOrigin, vDirection;
        float density(vec3 p) {
          float envelope = max(0.0, 1.0 - dot(p * vec3(1.9, 2.0, 1.9), p * vec3(1.9, 2.0, 1.9)));
          if (envelope <= 0.0) return 0.0;
          vec3 world = (modelMatrix * vec4(p, 1.0)).xyz;
          float clearance = world.y - texture(uTerrain, world.xz / (2.0 * uTerrainHalf) + 0.5).r;
          if (clearance <= 0.0) return 0.0;
          vec3 uv = p + 0.5 + uSeed + vec3(uTime * 0.0011, 0.0, uTime * 0.0004);
          // Wind-driven eddies lift and curl the density field along mountain faces.
          float lift = exp(-clearance / 180.0);
          uv += vec3(sin(uTime * 0.25 + p.y * 10.0) * 0.035, -0.08,
            cos(uTime * 0.25 + p.x * 8.0) * 0.035) * lift;
          float n = texture(uMap, uv).r;
          if (uQuality > 0.5) n = n * 0.8 + texture(uMap, uv * 2.07).r * 0.2;
          float removed = uHasDamage ? smoothstep(0.15, 0.90, texture(uDamage, p + 0.5).r) : 0.0;
          return smoothstep(0.40, 0.57, n + envelope * 0.32 - 0.22)
            * smoothstep(0.0, 0.25, envelope) * (1.0 - removed) * smoothstep(0.0, 80.0, clearance);
        }
        void main() {
          vec3 ray = normalize(vDirection);
          vec3 invRay = 1.0 / (ray + vec3(1e-7));
          vec3 t0 = (-0.5 - vOrigin) * invRay, t1 = (0.5 - vOrigin) * invRay;
          vec3 nearT = min(t0, t1), farT = max(t0, t1);
          float start = max(0.0, max(nearT.x, max(nearT.y, nearT.z)));
          float end = min(farT.x, min(farT.y, farT.z));
          // Clip the volume ray against full-resolution logarithmic terrain/body depth.
          vec3 worldRay = (modelMatrix * vec4(ray, 0.0)).xyz;
          float worldUnits = length(worldRay);
          vec3 worldDirection = worldRay / worldUnits;
          float sceneDepth = texture(uSceneDepth, gl_FragCoord.xy / uCloudSize).r;
          float terrainViewDepth = exp2(sceneDepth * log2(uCameraFar + 1.0)) - 1.0;
          float facing = max(0.00001, -(viewMatrix * vec4(worldDirection, 0.0)).z);
          end = min(end, max(0.0, terrainViewDepth - 0.2) / (facing * worldUnits));
          if (start >= end) discard;
          const int STEPS = 40;
          float stride = (end - start) / uSteps;
          // Stable screen-space jitter softens raymarch bands without temporal flicker.
          float jitter = 0.25 + 0.5 * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          vec3 rgb = vec3(0.0);
          float alpha = 0.0, first = end;
          vec3 scale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
          vec3 lightDir = normalize(inverse(mat3(modelMatrix)) * uSun);
          float worldStride = length(ray * scale) * stride;
          float light = 1.0;
          for (int i = 0; i < STEPS; i++) {
            if (float(i) >= uSteps) break;
            float t = start + (float(i) + jitter) * stride;
            vec3 p = vOrigin + ray * t;
            float d = density(p);
            if (d < 0.002) continue;
            if (alpha < 0.01) first = t;
            if (uQuality < 0.5) light = clamp(0.55 + (p.y + 0.4) * 0.3, 0.35, 0.85);
            else light = exp(-density(p + lightDir * 0.14) * 4.0);
            vec3 color = mix(vec3(0.36, 0.43, 0.61), vec3(1.0, 0.93, 0.82), light);
            color += max(p.y, 0.0) * 0.2;
            float a = 1.0 - exp(-d * worldStride * uExtinction);
            rgb += (1.0 - alpha) * a * color;
            alpha += (1.0 - alpha) * a;
            if (alpha > 0.98) break;
          }
          if (alpha < 0.003) discard;
          vec3 world = (modelMatrix * vec4(vOrigin + ray * first, 1.0)).xyz;
          float distanceToCloud = distance(world, cameraPosition);
          float haze = 1.0 - exp(-pow(distanceToCloud * uFogDensity, 2.0));
          vec3 viewDirection = normalize(world - cameraPosition);
          float sunGlow = pow(max(0.0, dot(viewDirection, uSun)), 6.0);
          vec3 air = mix(uFogColor, vec3(0.80, 0.64, 0.49), sunGlow * 0.35);
          air = mix(air, vec3(0.36, 0.51, 0.73), smoothstep(0.08, 0.85, abs(viewDirection.y)) * 0.28);
          gl_FragColor = vec4(mix(rgb / alpha, air, haze), alpha);
          // Test depth at the cloud, rather than the back of its bounding box.
          #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
            float viewDepth = -(viewMatrix * vec4(world, 1.0)).z;
            gl_FragDepth = log2(max(1.0, 1.0 + viewDepth)) * logDepthBufFC * 0.5;
          #endif
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    // Bases are in metres ABOVE SEA LEVEL, matching terrain and the altitude HUD.
    // Fair-weather Alpine layers: low cumulus above the valley, mid-level banks,
    // then thinner ice-cloud-like streaks. Mountains can naturally enter low cloud.
    const random = (n: number) => THREE.MathUtils.seededRandom(n);
    for (let i = 0; i < 180; i++) {
      const layer = i < 108 ? 0 : i < 156 ? 1 : 2;
      const r = (k: number) => random(i * 37 + k + 1);
      const angle = i * 2.399963;
      const radius = Math.sqrt(r(0)) * (i % 3 === 0 ? 30000 : 18000);
      const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      // A squared distribution gives plenty of small cloudlets and a few large banks.
      const width = layer === 0 ? 500 + r(1) ** 2 * 7200
        : layer === 1 ? 900 + r(1) ** 2 * 7100 : 4000 + r(1) * 8000;
      const height = layer === 0 ? 240 + width * (0.12 + r(2) * 0.20)
        : layer === 1 ? 250 + r(2) * 650 : 140 + r(2) * 220;
      const base = layer === 0 ? 1400 + r(3) * 600
        : layer === 1 ? 3500 + r(3) * 1500 : 7000 + r(3) * 2000;
      const bankMaterial = material.clone();
      // Share time/weather/texture uniforms; each bank has its own noise phase and density.
      bankMaterial.uniforms = { ...material.uniforms,
        uDamage: { value: this.damage.empty }, uHasDamage: { value: false },
        uSteps: { value: 40 }, uQuality: { value: 2 },
        uSeed: { value: new THREE.Vector3(r(4) * 8, r(5) * 8, r(6) * 8) },
        uExtinction: { value: layer === 2 ? 0.003 : 0.009 + r(7) * 0.006 },
      };
      const bank = new THREE.Mesh(geometry, bankMaterial);
      bank.position.set(x, base + height * 0.5, z);
      bank.scale.set(width, height, width * (layer === 2 ? 0.20 + r(8) * 0.18 : 0.55 + r(8) * 0.55));
      bank.rotation.y = r(9) * Math.PI;
      const windSpeed = [8, 17, 32][layer] + r(10) * [6, 9, 16][layer];
      const windAngle = 0.3 + layer * 0.13 + (r(11) - 0.5) * 0.3;
      bank.userData = { layer, base, bounds: new THREE.Box3(), wind: new THREE.Vector3(Math.cos(windAngle) * windSpeed, 0, Math.sin(windAngle) * windSpeed) };
      this.banks.push(bank);
      this.clouds.add(bank);
    }
  }

  /** Trilinear sampling mirrors the GPU's repeating, linearly filtered 3D texture. */
  private sampleNoise(x: number, y: number, z: number): number {
    const size = this.densitySize;
    x = (x - Math.floor(x)) * size - 0.5;
    y = (y - Math.floor(y)) * size - 0.5;
    z = (z - Math.floor(z)) * size - 0.5;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    let sum = 0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const index = ((iz + dz + size) % size) * size * size
        + ((iy + dy + size) % size) * size + ((ix + dx + size) % size);
      sum += this.densityData[index] / 255 * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    }
    return sum;
  }

  private localDensity(bank: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>, position: THREE.Vector3): number {
    const clearance = position.y - this.terrain.height(position.x, position.z);
    if (clearance <= 0) return 0;
    bank.worldToLocal(this.local.copy(position));
    const p = this.local;
    const envelope = Math.max(0, 1 - (p.x * 1.9) ** 2 - (p.y * 2) ** 2 - (p.z * 1.9) ** 2);
    if (envelope <= 0) return 0;
    const seed = bank.material.uniforms.uSeed.value as THREE.Vector3;
    const lift = Math.exp(-clearance / 180);
    const x = p.x + 0.5 + seed.x + this.time * 0.0011 + Math.sin(this.time * 0.25 + p.y * 10) * 0.035 * lift;
    const y = p.y + 0.5 + seed.y - 0.08 * lift;
    const z = p.z + 0.5 + seed.z + this.time * 0.0004 + Math.cos(this.time * 0.25 + p.x * 8) * 0.035 * lift;
    const n = this.sampleNoise(x, y, z) * 0.8 + this.sampleNoise(x * 2.07, y * 2.07, z * 2.07) * 0.2;
    return THREE.MathUtils.smoothstep(n + envelope * 0.32 - 0.22, 0.40, 0.57)
      * THREE.MathUtils.smoothstep(envelope, 0, 0.25) * (1 - this.damage.removal(bank, p)) * THREE.MathUtils.smoothstep(clearance, 0, 80);
  }

  createPass(camera: THREE.PerspectiveCamera): CloudPass {
    return new CloudPass(this.cloudScene, camera, this.depth);
  }

  /** Cloud must be within arm/shockwave reach; power changes local blast size, never reach. */
  punch(origin: THREE.Vector3, direction: THREE.Vector3, power = 1): boolean {
    const reach = 8;
    const end = origin.clone().addScaledVector(direction, reach);
    const point = new THREE.Vector3();
    let nearest = Infinity, hitBank: CloudBank | null = null;
    const box = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
    for (const bank of this.banks) {
      bank.updateMatrixWorld();
      const a = bank.worldToLocal(origin.clone());
      const b = bank.worldToLocal(end.clone());
      const delta = b.sub(a);
      let lo = 0, hi = 1;
      for (const axis of ["x", "y", "z"] as const) {
        if (Math.abs(delta[axis]) < 1e-8) {
          if (a[axis] < box.min[axis] || a[axis] > box.max[axis]) hi = -1;
        } else {
          const t0 = (box.min[axis] - a[axis]) / delta[axis];
          const t1 = (box.max[axis] - a[axis]) / delta[axis];
          lo = Math.max(lo, Math.min(t0, t1));
          hi = Math.min(hi, Math.max(t0, t1));
        }
      }
      if (lo > hi) continue;
      for (let distance = lo * reach; distance <= hi * reach && distance < nearest; distance += 0.5) {
        point.copy(origin).addScaledVector(direction, distance);
        if (this.localDensity(bank, point) < 0.04) continue;
        nearest = distance; hitBank = bank;
        break;
      }
    }
    if (!hitBank) return false;
    const cell = Math.max(12, Math.max(hitBank.scale.x, hitBank.scale.y, hitBank.scale.z) / 96);
    const radius = Math.min(90, Math.max(Math.min(70, cell * 1.25), 24 * Math.cbrt(Math.max(0.25, power))));
    const from = origin.clone().addScaledVector(direction, nearest);
    const to = origin.clone().addScaledVector(direction, nearest + radius * 0.6);
    return this.damage.carve(hitBank, from, to, radius, this.time);
  }

  /** A smash's wind: blow a channel of `radius` through every cloud the segment crosses. */
  gust(origin: THREE.Vector3, direction: THREE.Vector3, length: number, radius: number): boolean {
    const end = origin.clone().addScaledVector(direction, length);
    const from = new THREE.Vector3(), to = new THREE.Vector3();
    let hit = false;
    for (const bank of this.banks) {
      bank.updateMatrixWorld();
      const a = bank.worldToLocal(origin.clone());
      const delta = bank.worldToLocal(end.clone()).sub(a);
      // the bank's unit box, padded by the channel radius
      const pad = radius / Math.min(bank.scale.x, bank.scale.y, bank.scale.z);
      let lo = 0, hi = 1;
      for (const axis of ["x", "y", "z"] as const) {
        const min = -0.5 - pad, max = 0.5 + pad;
        if (Math.abs(delta[axis]) < 1e-8) {
          if (a[axis] < min || a[axis] > max) hi = -1;
        } else {
          const t0 = (min - a[axis]) / delta[axis], t1 = (max - a[axis]) / delta[axis];
          lo = Math.max(lo, Math.min(t0, t1));
          hi = Math.min(hi, Math.max(t0, t1));
        }
      }
      if (lo > hi) continue;
      from.copy(origin).addScaledVector(direction, lo * length);
      to.copy(origin).addScaledVector(direction, hi * length);
      if (this.damage.carve(bank, from, to, radius, this.time)) hit = true;
    }
    return hit;
  }

  /** Clear cloud density only where an expanding pressure ring has reached it. */
  shockwave(origin: THREE.Vector3, normal: THREE.Vector3, previous: number, radius: number, strength: number) {
    if (radius <= previous) return;
    const axis = Math.abs(normal.y) < .9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(normal, axis).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    const offset = new THREE.Vector3(), from = new THREE.Vector3(), to = new THREE.Vector3();
    // The cloud mask has coarse cells; a minimum width makes the disturbance visible.
    const width = Math.max(18, Math.min(60, strength * .8));
    const samples = Math.max(12, Math.min(48, Math.ceil(2 * Math.PI * radius / (width * 1.5))));
    for (const bank of this.banks) {
      const bounds = bank.userData.bounds as THREE.Box3;
      const center = bounds.getCenter(new THREE.Vector3());
      const extent = bounds.getSize(new THREE.Vector3()).multiplyScalar(.5);
      offset.subVectors(center, origin);
      const axial = Math.abs(offset.dot(normal));
      const axialExtent = Math.abs(normal.x) * extent.x + Math.abs(normal.y) * extent.y + Math.abs(normal.z) * extent.z;
      if (axial > axialExtent + width) continue;
      const planarDistance = Math.sqrt(Math.max(0, offset.lengthSq() - axial * axial));
      const bankRadius = extent.length();
      if (planarDistance - bankRadius > radius + width || planarDistance + bankRadius < previous - width) continue;
      bank.updateMatrixWorld();
      for (let i = 0; i < samples; i++) {
        const angle = i * Math.PI * 2 / samples;
        offset.copy(u).multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle));
        from.copy(origin).addScaledVector(offset, previous);
        to.copy(origin).addScaledVector(offset, radius);
        this.damage.carve(bank, from, to, width, this.time);
      }
    }
  }

  private rebuildBankIndex() {
    this.bankCells.clear();
    for (const bank of this.banks) {
      const b = bank.userData.bounds as THREE.Box3;
      // Padding covers wind drift until the next index refresh.
      for (let x = Math.floor((b.min.x - 64) / 4000); x <= Math.floor((b.max.x + 64) / 4000); x++)
        for (let y = Math.floor((b.min.y - 64) / 4000); y <= Math.floor((b.max.y + 64) / 4000); y++)
          for (let z = Math.floor((b.min.z - 64) / 4000); z <= Math.floor((b.max.z + 64) / 4000); z++) {
            const key = `${x}:${y}:${z}`;
            const cell = this.bankCells.get(key);
            if (cell) cell.push(bank); else this.bankCells.set(key, [bank]);
          }
    }
    this.indexTime = this.time;
  }

  private nearbyBanks(lx: number, ly: number, lz: number, hx: number, hy: number, hz: number): CloudBank[] {
    const result = this.candidates;
    result.length = 0;
    const stamp = ++this.queryStamp;
    for (let x = Math.floor(lx / 4000); x <= Math.floor(hx / 4000); x++)
      for (let y = Math.floor(ly / 4000); y <= Math.floor(hy / 4000); y++)
        for (let z = Math.floor(lz / 4000); z <= Math.floor(hz / 4000); z++) {
          const cell = this.bankCells.get(`${x}:${y}:${z}`);
          if (!cell) continue;
          for (const bank of cell) if (bank.userData.queryStamp !== stamp) {
            bank.userData.queryStamp = stamp;
            result.push(bank);
          }
        }
    return result;
  }

  /** Swept wakes depend on relative wind and body size, including held/resting bodies. */
  private readonly disturbBody: CloudBodyVisitor = (id, position, velocity, bodyRadius) => {
    let history = this.bodyHistory.get(id);
    if (!history) {
      history = { position: position.clone(), time: this.time - 0.1, seen: this.time };
      this.bodyHistory.set(id, history);
    }
    history.seen = this.time;
    const elapsed = this.time - history.time;
    const travel = history.position.distanceTo(position);
    if (elapsed < 0.08 && travel < 16) return;
    const speed = velocity.length();
    const continuous = travel < Math.max(250, speed * elapsed * 3 + 20);
    const from = continuous ? history.position : position;
    const maximumRadius = Math.max(90, Math.min(320, bodyRadius * 1.8 + 3 + (speed + 50) * 0.35));
    const lx = Math.min(from.x, position.x) - maximumRadius, hx = Math.max(from.x, position.x) + maximumRadius;
    const ly = Math.min(from.y, position.y) - maximumRadius, hy = Math.max(from.y, position.y) + maximumRadius;
    const lz = Math.min(from.z, position.z) - maximumRadius, hz = Math.max(from.z, position.z) + maximumRadius;
    for (const bank of this.nearbyBanks(lx, ly, lz, hx, hy, hz)) {
      const b = bank.userData.bounds as THREE.Box3;
      if (hx < b.min.x || lx > b.max.x || hy < b.min.y || ly > b.max.y || hz < b.min.z || lz > b.max.z) continue;
      const wind = bank.userData.wind as THREE.Vector3;
      const relativeSpeed = Math.hypot(velocity.x - wind.x, velocity.y - wind.y, velocity.z - wind.z);
      // Resolve the turbulent wake even when the solid body is smaller than a density voxel.
      const cell = Math.max(12, Math.max(bank.scale.x, bank.scale.y, bank.scale.z) / 96);
      const resolvedWake = Math.min(90, cell * 1.25);
      const radius = Math.min(320, Math.max(resolvedWake, bodyRadius * 1.8 + 3 + relativeSpeed * 0.35));
      this.damage.carve(bank, from, position, radius, this.time);
    }
    history.position.copy(position);
    history.time = this.time;
  };

  densityAt(position: THREE.Vector3): number {
    let density = 0;
    const {x,y,z} = position;
    for (const bank of this.nearbyBanks(x,y,z,x,y,z)) {
      if (Math.abs(y-bank.position.y)<bank.scale.y*.5) {
        density = Math.max(density,this.localDensity(bank,position));
      }
    }
    return density;
  }

  update(dt: number, camera: THREE.PerspectiveCamera, fog: THREE.FogExp2, velocity: THREE.Vector3) {
    this.time += dt;
    this.sky.position.copy(camera.position);
    // Clearer, deeper blue overhead as you leave the valley's aerosol layer.
    const altitude = Math.max(0, camera.position.y - 500);
    this.sky.material.uniforms.turbidity.value = 2 + 1.2 * Math.exp(-altitude / 2500);
    this.sky.material.uniforms.rayleigh.value = 1.35 + .75 * Math.exp(-altitude / 5000);
    const u = this.banks[0].material.uniforms;
    u.uTime.value = this.time;
    u.uFogDensity.value = fog.density;
    camera.getWorldDirection(this.view);
    const glow = Math.pow(Math.max(0, this.view.dot(this.sunDirection)), 5);
    this.haze.lerpColors(this.lowHaze, this.highHaze, THREE.MathUtils.clamp(altitude / 8000, 0, 1));
    this.haze.lerp(this.warmHaze, glow * 0.42);
    fog.color.copy(this.haze);
    this.terrain.update();
    this.damage.update(this.time);
    for (const bank of this.banks) {
      bank.position.addScaledVector(bank.userData.wind, dt);
      // Wrap only outside the playable region; clouds stay independent of player speed.
      if (bank.position.x > 44000) { bank.position.x -= 88000; this.indexTime = -Infinity; }
      if (bank.position.z > 44000) { bank.position.z -= 88000; this.indexTime = -Infinity; }
      bank.updateMatrixWorld();
      const distance = Math.max(0, camera.position.distanceTo(bank.position) - bank.scale.length() * 0.5);
      bank.material.uniforms.uSteps.value = distance < 2000 ? 40 : distance < 7000 ? 28 : 18;
      bank.material.uniforms.uQuality.value = distance < 2000 ? 2 : distance < 7000 ? 1 : 0;
      const m = bank.matrixWorld.elements, p = bank.position;
      const hx = (Math.abs(m[0]) + Math.abs(m[4]) + Math.abs(m[8])) * 0.5;
      const hy = (Math.abs(m[1]) + Math.abs(m[5]) + Math.abs(m[9])) * 0.5;
      const hz = (Math.abs(m[2]) + Math.abs(m[6]) + Math.abs(m[10])) * 0.5;
      const bounds = bank.userData.bounds as THREE.Box3;
      bounds.min.set(p.x - hx, p.y - hy, p.z - hz);
      bounds.max.set(p.x + hx, p.y + hy, p.z + hz);
    }
    if (this.time - this.indexTime >= 0.5) this.rebuildBankIndex();
    if (this.bodySource) this.bodySource(this.disturbBody);
    else this.disturbBody(camera, camera.position, velocity, 0.9);
    if (this.time - this.lastPrune > 5) {
      this.lastPrune = this.time;
      for (const [id, history] of this.bodyHistory) if (this.time - history.seen > 5) this.bodyHistory.delete(id);
    }
    const density = this.densityAt(camera.position);
    const target = THREE.MathUtils.smoothstep(density, 0.015, 0.35);
    this.immersion += (target - this.immersion) * (1 - Math.exp(-8 * dt));
    this.wisps.update(velocity, this.immersion, this.time);
  }
}
