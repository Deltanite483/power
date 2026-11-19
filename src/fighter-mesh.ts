import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** One entry of a fighter's palette: every part of a fighter shares a single material and picks its look by UV. */
export interface Swatch { color: number; rough?: number; metal?: number; glow?: number }

const skins: THREE.MeshStandardMaterial[] = [];
let environment: THREE.Texture | null = null;

/** A soft view-dependent edge light, so fighters separate from terrain and sky at any range. */
export function addRimLight(material: THREE.MeshStandardMaterial, strength = .3) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uRim = { value: strength };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uRim;")
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        float rimTerm = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
        totalEmissiveRadiance += (diffuseColor.rgb * 0.75 + vec3(0.05, 0.07, 0.1)) * rimTerm * uRim * (0.45 + 0.55 * saturate(normal.y * 0.5 + 0.5));`);
  };
  material.customProgramCacheKey = () => `rim${strength}`;
  return material;
}

/** Reflections for fighter armour. Without an environment, metallic surfaces render nearly black. */
export function setFighterEnvironment(texture: THREE.Texture | null) {
  environment = texture;
  for (const material of skins) { material.envMap = texture; material.needsUpdate = true; }
}

/** A small prefiltered sky: bright zenith, warm sun side, dark ground. Call once with the game renderer. */
export function createFighterEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `varying vec3 vDir; void main(){
      vec3 d = normalize(vDir);
      vec3 ground = vec3(0.16, 0.15, 0.13), horizon = vec3(0.92, 0.94, 0.98), zenith = vec3(0.34, 0.52, 0.86);
      vec3 c = d.y < 0.0 ? mix(horizon * 0.6, ground, smoothstep(0.0, -0.35, d.y)) : mix(horizon, zenith, pow(d.y, 0.55));
      float sun = max(0.0, dot(d, normalize(vec3(-0.45, 0.62, 0.64))));
      c += vec3(1.0, 0.86, 0.66) * (pow(sun, 24.0) * 5.0 + pow(sun, 3.0) * 0.35);
      gl_FragColor = vec4(c, 1.0); }`,
  }));
  scene.add(sky);
  const generator = new THREE.PMREMGenerator(renderer);
  const texture = generator.fromScene(scene, .03).texture;
  generator.dispose(); sky.geometry.dispose(); (sky.material as THREE.Material).dispose();
  return texture;
}

/** A palette material: colour, roughness, metalness and glow all come from one row of texels. */
export class Skin {
  readonly material: THREE.MeshStandardMaterial;
  private readonly count: number;

  constructor(swatches: readonly Swatch[], rim = .3) {
    const n = this.count = swatches.length;
    const color = new Uint8Array(n * 4), surface = new Uint8Array(n * 4), glow = new Uint8Array(n * 4);
    let glowing = false;
    swatches.forEach((swatch, i) => {
      const r = swatch.color >> 16 & 255, g = swatch.color >> 8 & 255, b = swatch.color & 255;
      color.set([r, g, b, 255], i * 4);
      surface.set([255, Math.round((swatch.rough ?? .8) * 255), Math.round((swatch.metal ?? 0) * 255), 255], i * 4);
      const k = Math.min(1, swatch.glow ?? 0);
      if (k > 0) glowing = true;
      glow.set([r * k, g * k, b * k, 255], i * 4);
    });
    const texture = (data: Uint8Array, srgb: boolean) => {
      const t = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      return t;
    };
    const surfaceMap = texture(surface, false);
    this.material = new THREE.MeshStandardMaterial({
      map: texture(color, true), roughnessMap: surfaceMap, metalnessMap: surfaceMap, roughness: 1, metalness: 1,
      envMap: environment, envMapIntensity: .7,
    });
    if (glowing) {
      this.material.emissiveMap = texture(glow, true);
      this.material.emissive.set(0xffffff);
      this.material.emissiveIntensity = 1.6;
    }
    addRimLight(this.material, rim);
    skins.push(this.material);
  }

  u(swatch: number) { return (swatch + .5) / this.count; }
}

export type Ring = [y: number, width: number, depth: number, centerZ?: number, centerX?: number];
export type Paint = number | ((angle: number, t: number, y: number) => number);
export interface TubeOptions {
  sectors?: number;
  /** Extra interpolated rows between each pair of authored rings. */
  rows?: number;
  /** 2 is an ellipse; higher values square off the cross-section. */
  square?: number;
  /** Radial multiplier, for muscle and armour relief. angle 0 faces forward (+z), π/2 faces +x. */
  bulge?: (angle: number, t: number, y: number) => number;
  at?: [number, number, number];
  rot?: [number, number, number];
}

const sphere = new THREE.SphereGeometry(1, 16, 12);
const cube = new THREE.BoxGeometry(1, 1, 1);
const cylinder = new THREE.CylinderGeometry(1, 1, 1, 16);
const UP = new THREE.Vector3(0, 1, 0);

function catmull(a: number, b: number, c: number, d: number, t: number) {
  return .5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
}

/** Collects sculpted parts per rig joint, then bakes each joint down to one mesh: one draw call per bone. */
export class Sculpt {
  private readonly buckets = new Map<THREE.Object3D, THREE.BufferGeometry[]>();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly euler = new THREE.Euler();

  constructor(readonly skin: Skin) {}

  private push(parent: THREE.Object3D, geometry: THREE.BufferGeometry, swatch: number | null) {
    for (const name of Object.keys(geometry.attributes)) if (!["position", "normal", "uv"].includes(name)) geometry.deleteAttribute(name);
    const count = geometry.attributes.position.count;
    if (swatch !== null) {
      const uv = new Float32Array(count * 2), u = this.skin.u(swatch);
      for (let i = 0; i < count; i++) { uv[i * 2] = u; uv[i * 2 + 1] = .5; }
      geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    }
    if (!geometry.index) geometry.setIndex(Array.from({ length: count }, (_, i) => i));
    const list = this.buckets.get(parent);
    if (list) list.push(geometry); else this.buckets.set(parent, [geometry]);
  }

  private transform(x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0) {
    this.quaternion.setFromEuler(this.euler.set(rx, ry, rz));
    return this.matrix.compose(this.position.set(x, y, z), this.quaternion, this.scale.set(sx, sy, sz));
  }

  /** Any geometry, placed and coloured. `flat` gives it faceted shading. */
  shape(parent: THREE.Object3D, base: THREE.BufferGeometry, swatch: number, x: number, y: number, z: number,
    sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0, flat = false) {
    let geometry = base.clone().applyMatrix4(this.transform(x, y, z, sx, sy, sz, rx, ry, rz));
    if (flat) { geometry = geometry.toNonIndexed(); geometry.computeVertexNormals(); }
    this.push(parent, geometry, swatch);
  }
  ball(parent: THREE.Object3D, swatch: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0) {
    this.shape(parent, sphere, swatch, x, y, z, sx, sy, sz, rx, ry, rz);
  }
  box(parent: THREE.Object3D, swatch: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0) {
    this.shape(parent, cube, swatch, x, y, z, sx, sy, sz, rx, ry, rz, true);
  }
  cyl(parent: THREE.Object3D, swatch: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx = 0, ry = 0, rz = 0) {
    this.shape(parent, cylinder, swatch, x, y, z, sx, sy, sz, rx, ry, rz);
  }

  /** A tapered point from `at` along `dir`: claws, tufts, horns and blades. */
  spike(parent: THREE.Object3D, swatch: number, at: [number, number, number], dir: [number, number, number],
    length: number, width: number, sides = 5, flat = true, depth = width) {
    const toward = new THREE.Vector3(...dir).normalize();
    let geometry: THREE.BufferGeometry = new THREE.ConeGeometry(1, 1, sides);
    this.quaternion.setFromUnitVectors(UP, toward);
    this.position.set(...at).addScaledVector(toward, length / 2);
    geometry.applyMatrix4(this.matrix.compose(this.position, this.quaternion, this.scale.set(width, length, depth)));
    if (flat) { geometry = geometry.toNonIndexed(); geometry.computeVertexNormals(); }
    this.push(parent, geometry, swatch);
  }

  /** A flat armour plate cut from an outline in the XY plane, with real thickness. */
  plate(parent: THREE.Object3D, swatch: number, points: [number, number][], z: number, depth = .012,
    x = 0, y = 0, rx = 0, ry = 0, rz = 0) {
    const outline = new THREE.Shape();
    outline.moveTo(points[0][0], points[0][1]);
    for (const [px, py] of points.slice(1)) outline.lineTo(px, py);
    outline.closePath();
    const geometry = new THREE.ExtrudeGeometry(outline, { depth, bevelEnabled: false });
    geometry.translate(0, 0, -depth / 2);
    geometry.applyMatrix4(this.transform(x, y, z, 1, 1, 1, rx, ry, rz));
    this.push(parent, geometry, swatch);
  }

  /**
   * A smooth lofted body part: elliptical rings along Y, splined together.
   * `paint` may pick a swatch per face, which is how suits get panels, gloves and boots without extra geometry.
   */
  tube(parent: THREE.Object3D, paint: Paint, rings: Ring[], options: TubeOptions = {}) {
    const sectors = options.sectors ?? 16, extra = options.rows ?? 3, power = 2 / (options.square ?? 2);
    const rows: Ring[] = [];
    const ring = (i: number) => rings[Math.max(0, Math.min(rings.length - 1, i))];
    for (let i = 0; i < rings.length - 1; i++) {
      const a = ring(i - 1), b = ring(i), c = ring(i + 1), d = ring(i + 2);
      for (let step = 0; step < extra + 1; step++) {
        const t = step / (extra + 1);
        // Height stays linear so authored rings land exactly where they were placed; the section shape is splined.
        rows.push([b[0] + (c[0] - b[0]) * t, Math.max(0, catmull(a[1], b[1], c[1], d[1], t)), Math.max(0, catmull(a[2], b[2], c[2], d[2], t)),
          catmull(a[3] ?? 0, b[3] ?? 0, c[3] ?? 0, d[3] ?? 0, t), catmull(a[4] ?? 0, b[4] ?? 0, c[4] ?? 0, d[4] ?? 0, t)]);
      }
    }
    rows.push(rings[rings.length - 1]);
    const first = rows[0][0], span = rows[rows.length - 1][0] - first || 1;
    const positions: number[] = [], indices: number[] = [];
    for (const [y, width, depth, cz = 0, cx = 0] of rows) {
      const t = (y - first) / span;
      for (let s = 0; s < sectors; s++) {
        const angle = s / sectors * Math.PI * 2;
        const sin = Math.sin(angle), cos = Math.cos(angle);
        const swell = options.bulge ? options.bulge(angle > Math.PI ? angle - Math.PI * 2 : angle, t, y) : 1;
        positions.push(cx + Math.sign(sin) * Math.abs(sin) ** power * width * swell, y, cz + Math.sign(cos) * Math.abs(cos) ** power * depth * swell);
      }
    }
    for (let r = 0; r < rows.length - 1; r++) for (let s = 0; s < sectors; s++) {
      const a = r * sectors + s, b = r * sectors + (s + 1) % sectors, c = a + sectors, d = b + sectors;
      indices.push(a, b, c, b, d, c);
    }
    // Close both ends with a fan so no tube is ever hollow when a joint bends.
    for (const end of [0, rows.length - 1]) {
      const [y, , , cz = 0, cx = 0] = rows[end], center = positions.length / 3, base = end * sectors;
      positions.push(cx, y, cz);
      for (let s = 0; s < sectors; s++) {
        const a = base + s, b = base + (s + 1) % sectors;
        if (end === 0) indices.push(center, b, a); else indices.push(center, a, b);
      }
    }
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    // Make the winding face outward whichever way the rings were listed.
    const p = geometry.attributes.position, n = geometry.attributes.normal;
    let outward = 0;
    for (let i = 0; i < sectors * rows.length; i += 7) {
      const row = rows[Math.floor(i / sectors)];
      outward += (p.getX(i) - (row[4] ?? 0)) * n.getX(i) + (p.getZ(i) - (row[3] ?? 0)) * n.getZ(i);
    }
    if (outward < 0) {
      for (let i = 0; i < indices.length; i += 3) { const swap = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = swap; }
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
    }
    if (typeof paint === "function") {
      const smooth = geometry;
      geometry = smooth.toNonIndexed();
      const count = geometry.attributes.position.count, uv = new Float32Array(count * 2), q = geometry.attributes.position;
      // Both triangles of a quad take one swatch, so panel edges follow the rows and columns instead of zig-zagging.
      const quads = (rows.length - 1) * sectors * 6;
      for (let face = 0; face < count; face += face < quads ? 6 : 3) {
        const corners = face < quads ? 6 : 3;
        let x = 0, y = 0, z = 0;
        for (let k = 0; k < corners; k++) { x += q.getX(face + k); y += q.getY(face + k); z += q.getZ(face + k); }
        x /= corners; y /= corners; z /= corners;
        const t = (y - first) / span;
        const row = rows[Math.max(0, Math.min(rows.length - 1, Math.round(t * (rows.length - 1))))];
        const u = this.skin.u(paint(Math.atan2(x - (row[4] ?? 0), z - (row[3] ?? 0)), t, y));
        for (let k = 0; k < corners; k++) { uv[(face + k) * 2] = u; uv[(face + k) * 2 + 1] = .5; }
      }
      geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      smooth.dispose();
    }
    const [x, y, z] = options.at ?? [0, 0, 0], [rx, ry, rz] = options.rot ?? [0, 0, 0];
    geometry.applyMatrix4(this.transform(x, y, z, 1, 1, 1, rx, ry, rz));
    this.push(parent, geometry, typeof paint === "function" ? null : paint);
  }

  /** Merge everything sculpted so far into one mesh per joint. */
  bake() {
    for (const [parent, parts] of this.buckets) {
      const geometry = parts.length > 1 ? mergeGeometries(parts) : parts[0];
      if (!geometry) continue;
      if (parts.length > 1) for (const part of parts) part.dispose();
      geometry.computeBoundingSphere();
      parent.add(new THREE.Mesh(geometry, this.skin.material));
    }
    this.buckets.clear();
  }
}
