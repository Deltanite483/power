import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Mat } from "./terrain/heightfield";
import type { VoxelInstance, VoxelModel, VoxelPart } from "./terrain/authored";

/**
 * Trees beyond the voxel range. The same instance list the voxel sampler uses is drawn as
 *   mid: low-poly instanced meshes built from each model's medium voxel LOD, and
 *   far: impostors, baked at startup from those meshes into albedo + normal atlases (8×8 hemi-octahedral views),
 *        lit per pixel by the scene's lights so they follow any time of day.
 * Both tiers dither by distance to the tree with the same screen-space noise: mid keeps n < 1−t, far keeps n ≥ 1−t,
 * so the handover is exactly complementary. Near trees are voxels (chunks of ≤ TREE_VOXEL_MAX voxels).
 */

const FRAMES = 8; // views per axis per model
const FRAME_PX = 64;
const GRID = 4; // models per atlas axis
const CELL = 128; // spatial index cell (m)
const WOOD: [number, number, number] = [106, 77, 48];

/** Interleaved-gradient noise and the distance ramps, shared verbatim by both tiers so their dithers complement. */
const DITHER_GLSL = /* glsl */ `
uniform vec4 uTreeRange; // mid fade-in start/end, mid→far handover start/end (m)
uniform vec2 uTreeEnd;   // far fade-out start/end (m)
varying float vTreeDist;
float treeNoise() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }
float treeHandover() { return smoothstep(uTreeRange.z, uTreeRange.w, vTreeDist); }`;

interface Tree { x: number; y: number; z: number; yaw: number; scale: number; model: number }

export class TreeLayers {
  readonly group = new THREE.Group();
  /** Distance where mid trees hand over to impostors, and where impostors end (m). */
  midRange = 700;
  farRange = 6500;
  private trees: Tree[] = [];
  private cells = new Map<string, number[]>();
  private felled = new Set<number>();
  private uniforms = {
    uTreeRange: { value: new THREE.Vector4() },
    uTreeEnd: { value: new THREE.Vector2() },
  };
  private mid: THREE.InstancedMesh[] = [];
  private midModels: number[] = [];
  private lastRefresh = new THREE.Vector3(Infinity, 0, 0);
  private lastNear = 0;
  private impostor: THREE.Mesh;
  private impScale: THREE.InstancedBufferAttribute;
  private matrix = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private vec = new THREE.Vector3();
  private one = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(renderer: THREE.WebGLRenderer, models: VoxelModel[], instances: readonly VoxelInstance[]) {
    const plantModels = models.map((m, i) => m.foliage ? i : -1).filter(i => i >= 0);
    const slot = new Map(plantModels.map((m, k) => [m, k]));
    instances.forEach(i => {
      if (!slot.has(i.model)) return;
      const id = this.trees.length;
      this.trees.push({ x: i.x, y: i.y, z: i.z, yaw: i.yaw, scale: i.scale, model: slot.get(i.model)! });
      const key = `${Math.floor(i.x / CELL)}:${Math.floor(i.z / CELL)}`;
      const list = this.cells.get(key);
      if (list) list.push(id); else this.cells.set(key, [id]);
    });

    const geometries = plantModels.map(m => treeGeometry(models[m]));
    const midMaterial = this.midMaterial();
    const counts = new Array(plantModels.length).fill(0);
    for (const t of this.trees) counts[t.model]++;
    geometries.forEach((g, k) => {
      const mesh = new THREE.InstancedMesh(g, midMaterial, Math.max(1, Math.min(counts[k], 20000)));
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mid.push(mesh);
      this.group.add(mesh);
    });
    this.midModels = plantModels;

    const bounds = geometries.map(g => { g.computeBoundingBox(); const b = g.boundingBox!; const c = (b.min.y + b.max.y) / 2; return new THREE.Vector2(Math.max(b.max.x, -b.min.x, b.max.z, -b.min.z, (b.max.y - b.min.y) / 2) * 1.05, c); });
    const atlases = bakeImpostors(renderer, geometries, bounds);
    const [impostor, scale] = this.buildImpostors(atlases, bounds);
    this.impostor = impostor;
    this.impScale = scale;
    this.group.add(impostor);
  }

  get count(): number {
    return this.trees.length;
  }

  /** Hide trees whose trunk no longer stands (destruction carved it), for the mesh tiers. */
  fell(x0: number, z0: number, x1: number, z1: number, standing: (x: number, y: number, z: number) => boolean) {
    let changed = false;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++)
      for (const id of this.cells.get(`${cx}:${cz}`) ?? []) {
        const t = this.trees[id];
        if (this.felled.has(id) || t.x < x0 - 2 || t.x > x1 + 2 || t.z < z0 - 2 || t.z > z1 + 2) continue;
        if (standing(t.x, t.y + 1.5 * t.scale, t.z)) continue;
        this.felled.add(id);
        this.impScale.setX(id, 0);
        this.impScale.addUpdateRange(id, 1);
        changed = true;
      }
    if (changed) { this.impScale.needsUpdate = true; this.lastRefresh.set(Infinity, 0, 0); }
  }

  /** nearRange: distance inside which voxel trees are guaranteed (from the terrain LOD). */
  update(camera: THREE.Vector3, nearRange: number) {
    const mid = Math.max(this.midRange, nearRange * 2.5);
    this.uniforms.uTreeRange.value.set(nearRange * 0.55, nearRange * 0.8, mid * 0.82, mid);
    this.uniforms.uTreeEnd.value.set(this.farRange * 0.85, this.farRange);
    if (camera.distanceTo(this.lastRefresh) < 25 && Math.abs(nearRange - this.lastNear) < nearRange * 0.1) return;
    this.lastRefresh.copy(camera);
    this.lastNear = nearRange;
    // mid tier: rebuild the instance lists around the camera
    for (const m of this.mid) m.count = 0;
    const r = mid * 1.05, r2 = r * r, lo = nearRange * 0.5, lo2 = lo * lo;
    for (let cx = Math.floor((camera.x - r) / CELL); cx <= Math.floor((camera.x + r) / CELL); cx++)
      for (let cz = Math.floor((camera.z - r) / CELL); cz <= Math.floor((camera.z + r) / CELL); cz++)
        for (const id of this.cells.get(`${cx}:${cz}`) ?? []) {
          const t = this.trees[id], d2 = (t.x - camera.x) ** 2 + (t.y - camera.y) ** 2 + (t.z - camera.z) ** 2;
          if (d2 > r2 || d2 < lo2 || this.felled.has(id)) continue;
          const mesh = this.mid[t.model];
          if (mesh.count >= mesh.instanceMatrix.count) continue;
          // voxel yaw maps world→local as (x cos + z sin); the matching rotation about +Y is −yaw
          this.quat.setFromAxisAngle(this.up, -t.yaw);
          this.matrix.compose(this.vec.set(t.x, t.y, t.z), this.quat, this.one.setScalar(t.scale));
          mesh.setMatrixAt(mesh.count++, this.matrix);
        }
    for (const m of this.mid) m.instanceMatrix.needsUpdate = true;
  }

  private midMaterial(): THREE.MeshLambertMaterial {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    material.customProgramCacheKey = () => "trees-mid";
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vTreeDist;")
        .replace("#include <project_vertex>", "#include <project_vertex>\n\tvTreeDist = distance((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz, cameraPosition);");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\n" + DITHER_GLSL)
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
  float n = treeNoise();
  if (n >= smoothstep(uTreeRange.x, uTreeRange.y, vTreeDist) || n >= 1.0 - treeHandover()) discard;`);
    };
    return material;
  }

  private buildImpostors(atlases: { albedo: THREE.Texture; normal: THREE.Texture }, bounds: THREE.Vector2[]): [THREE.Mesh, THREE.InstancedBufferAttribute] {
    const n = this.trees.length;
    const g = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    g.index = plane.index;
    g.setAttribute("position", plane.getAttribute("position"));
    g.setAttribute("normal", plane.getAttribute("normal"));
    g.setAttribute("uv", plane.getAttribute("uv"));
    const pos = new Float32Array(n * 3), imp = new Float32Array(n * 2), scale = new Float32Array(n);
    this.trees.forEach((t, i) => {
      pos[i * 3] = t.x; pos[i * 3 + 1] = t.y; pos[i * 3 + 2] = t.z;
      imp[i * 2] = t.model; imp[i * 2 + 1] = t.yaw; scale[i] = t.scale;
    });
    const scaleAttr = new THREE.InstancedBufferAttribute(scale, 1);
    g.setAttribute("aTreePos", new THREE.InstancedBufferAttribute(pos, 3));
    g.setAttribute("aTreeImp", new THREE.InstancedBufferAttribute(imp, 2));
    g.setAttribute("aTreeScale", scaleAttr);
    g.instanceCount = n;

    const material = new THREE.MeshLambertMaterial({ alphaTest: 0.5 });
    const uniforms = {
      ...this.uniforms,
      uImpAlbedo: { value: atlases.albedo },
      uImpNormal: { value: atlases.normal },
      uImpBounds: { value: bounds },
    };
    material.customProgramCacheKey = () => "trees-impostor";
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", `#include <common>
attribute vec3 aTreePos;
attribute vec2 aTreeImp;
attribute float aTreeScale;
uniform vec2 uImpBounds[${bounds.length}];
varying float vTreeDist;
varying vec2 vImpUv;
varying vec2 vImpYaw;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
  vec2 bnd = uImpBounds[int(aTreeImp.x + 0.5)];
  vec3 impCenter = aTreePos + vec3(0.0, bnd.y * aTreeScale, 0.0);
  vec3 toCam = normalize(cameraPosition - impCenter);
  vec3 impRight = cross(vec3(0.0, 1.0, 0.0), toCam);
  impRight = length(impRight) < 1e-4 ? vec3(1.0, 0.0, 0.0) : normalize(impRight);
  vec3 impUp = cross(toCam, impRight);
  transformed = impCenter + (impRight * position.x + impUp * position.y) * bnd.x * aTreeScale * 2.0;
  vTreeDist = distance(aTreePos, cameraPosition);
  // view direction in the tree's own frame picks the baked view (hemi-octahedral grid)
  float co = cos(aTreeImp.y), si = sin(aTreeImp.y);
  vImpYaw = vec2(co, si);
  vec3 lv = vec3(toCam.x * co + toCam.z * si, max(toCam.y, 0.0), -toCam.x * si + toCam.z * co);
  lv /= abs(lv.x) + abs(lv.y) + abs(lv.z);
  vec2 oct = vec2(lv.x + lv.z, lv.x - lv.z) * 0.5 + 0.5;
  vec2 frame = clamp(floor(oct * ${FRAMES}.0), 0.0, ${FRAMES - 1}.0);
  float model = aTreeImp.x;
  vec2 tile = vec2(mod(model, ${GRID}.0), floor(model / ${GRID}.0));
  vImpUv = (tile * ${FRAMES}.0 + frame + uv) / ${FRAMES * GRID}.0;`)
        .replace("#include <project_vertex>", `vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;`);
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", `#include <common>
${DITHER_GLSL}
uniform sampler2D uImpAlbedo;
uniform sampler2D uImpNormal;
varying vec2 vImpUv;
varying vec2 vImpYaw;`)
        .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
  float n = treeNoise();
  if (n < 1.0 - treeHandover() || n >= 1.0 - smoothstep(uTreeEnd.x, uTreeEnd.y, vTreeDist)) discard;
  vec4 impAlbedo = texture2D(uImpAlbedo, vImpUv);`)
        .replace("#include <map_fragment>", "diffuseColor.rgb = impAlbedo.rgb;")
        .replace("#include <alphamap_fragment>", "diffuseColor.a = impAlbedo.a;")
        .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
  vec3 ln = texture2D(uImpNormal, vImpUv).xyz * 2.0 - 1.0;
  vec3 wn = vec3(ln.x * vImpYaw.x - ln.z * vImpYaw.y, ln.y, ln.x * vImpYaw.y + ln.z * vImpYaw.x);
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
  nonPerturbedNormal = normal;`);
    };
    const mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    return [mesh, scaleAttr];
  }
}

/** Low-poly faceted mesh of a model's medium voxel LOD, vertex-coloured (linear) like the voxel trees. */
function treeGeometry(model: VoxelModel): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  const color = new THREE.Color();
  const tint = (g: THREE.BufferGeometry, rgb: [number, number, number]) => {
    color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    const n = g.getAttribute("position").count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    g.deleteAttribute("uv");
    return g;
  };
  const up = new THREE.Vector3(0, 1, 0);
  for (const p of model.lods[1] as VoxelPart[]) {
    const rgb = p.material === Mat.Leaves ? model.foliage! : WOOD;
    let g: THREE.BufferGeometry;
    if (p.kind === "stem") {
      const a = new THREE.Vector3(p.x, p.y0, p.z), b = new THREE.Vector3(p.tx ?? p.x, p.y1, p.tz ?? p.z);
      const dir = b.clone().sub(a), len = dir.length();
      g = new THREE.CylinderGeometry(p.rx, p.rx, len, 5, 1);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.normalize()));
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    } else if (p.kind === "cone") {
      g = new THREE.CylinderGeometry(p.rx * (p.tip ?? 0), p.rx, p.y1 - p.y0, 8, 1);
      g.scale(1, 1, p.rz / p.rx);
      g.translate(p.x, (p.y0 + p.y1) / 2, p.z);
    } else {
      g = new THREE.IcosahedronGeometry(1, 1);
      g.scale(p.rx, (p.y1 - p.y0) / 2, p.rz);
      g.translate(p.x, (p.y0 + p.y1) / 2, p.z);
    }
    pieces.push(tint(g.index ? g.toNonIndexed() : g, rgb));
  }
  const merged = mergeGeometries(pieces)!;
  merged.computeVertexNormals(); // non-indexed: flat facets, matching the voxel look
  return merged;
}

/** Render each model from FRAMES² hemi-octahedral directions into albedo (sRGB, unlit) and local-normal atlases. */
function bakeImpostors(renderer: THREE.WebGLRenderer, geometries: THREE.BufferGeometry[], bounds: THREE.Vector2[]) {
  const size = FRAME_PX * FRAMES * GRID;
  const make = (srgb: boolean) => {
    const rt = new THREE.WebGLRenderTarget(size, size, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    if (srgb) rt.texture.colorSpace = THREE.SRGBColorSpace;
    return rt;
  };
  const albedoRT = make(true), normalRT = make(false);
  const scene = new THREE.Scene();
  const albedo = new THREE.MeshBasicMaterial({ vertexColors: true });
  const normal = new THREE.ShaderMaterial({
    vertexShader: "varying vec3 vN; void main() { vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "varying vec3 vN; void main() { gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, 1.0); }",
  });
  const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(geometries[0], albedo);
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  const prevTarget = renderer.getRenderTarget(), prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  const prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);
  for (const [rt, mat] of [[albedoRT, albedo], [normalRT, normal]] as const) {
    renderer.setRenderTarget(rt);
    rt.scissorTest = false;
    rt.viewport.set(0, 0, size, size);
    renderer.clear();
    mesh.material = mat;
    rt.scissorTest = true;
    geometries.forEach((g, model) => {
      mesh.geometry = g;
      const r = bounds[model].x, cy = bounds[model].y;
      camera.left = -r; camera.right = r; camera.top = r; camera.bottom = -r;
      camera.near = 0.01; camera.far = r * 6;
      camera.updateProjectionMatrix();
      const tx = model % GRID, ty = Math.floor(model / GRID);
      for (let j = 0; j < FRAMES; j++) for (let i = 0; i < FRAMES; i++) {
        // frame centre → direction (inverse of the shader's hemi-octahedral lookup)
        const u = ((i + 0.5) / FRAMES) * 2 - 1, w = ((j + 0.5) / FRAMES) * 2 - 1;
        const dx = (u + w) / 2, dz = (u - w) / 2, dy = Math.max(0, 1 - Math.abs(dx) - Math.abs(dz));
        const d = new THREE.Vector3(dx, dy, dz).normalize();
        camera.position.set(d.x * r * 3, cy + d.y * r * 3, d.z * r * 3);
        camera.up.set(0, 1, 0);
        camera.lookAt(0, cy, 0);
        const x = (tx * FRAMES + i) * FRAME_PX, y = (ty * FRAMES + j) * FRAME_PX;
        rt.viewport.set(x, y, FRAME_PX, FRAME_PX);
        rt.scissor.set(x, y, FRAME_PX, FRAME_PX);
        renderer.setRenderTarget(rt);
        renderer.render(scene, camera);
      }
    });
    rt.scissorTest = false;
  }
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevColor, prevAlpha);
  renderer.toneMapping = prevTone;
  return { albedo: albedoRT.texture, normal: normalRT.texture };
}
