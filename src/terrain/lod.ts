import * as THREE from "three";
import { VOXEL, WORLD_HALF, type Heightfield, type TerrainData } from "./heightfield";
import { CHUNK_COLS, type ChunkMesh } from "./mesher";
import type { FarMesh } from "./far";
import { TREE_VOXEL_MAX } from "./authored";
import { ThermalField, patchThermalShader } from "./heat";

// Quadtree of chunks. Level L chunks hold CHUNK_COLS² columns of voxel size VOXEL·2^L metres.
const ROOT_LEVEL = Math.round(Math.log2(131072 / (CHUNK_COLS * VOXEL)));
const ROOT_MIN = -65536;
const chunkSize = (level: number) => CHUNK_COLS * VOXEL * 2 ** level;
const MAX_CACHED = 1800;
const CACHE_BYTE_BUDGET = 160 * 1024 ** 2;
/** A split chunk merges back only once its voxels are this much smaller than the split threshold. */
const HYSTERESIS = 1.3;
/** Fading chunks draw with one of this many materials, each holding a fixed dither coverage. */
const FADE_STEPS = 16;
const MESHES_PER_FRAME = 6;
const MESH_BYTES_PER_FRAME = 3 * 1024 ** 2;

const parseKey = (key: string) => key.split(":").map(Number) as [number, number, number];
/** Whether two quadtree chunks cover any of the same ground (one contains the other). */
function overlaps(a: [number, number, number], b: [number, number, number]): boolean {
  const [hi, lo] = a[0] >= b[0] ? [a, b] : [b, a];
  const d = hi[0] - lo[0];
  return lo[1] >> d === hi[1] && lo[2] >> d === hi[2];
}

interface Entry {
  mesh: THREE.Mesh;
  lastUsed: number;
  bytes: number;
  /** Edit version the mesh was built with. */
  ver: number;
  /** Dither coverage in [0,1] while fading in over a replaced LOD; 1 = solid. While fading out, the time left. */
  fade: number;
  /** Replaced by another LOD: drawn solid until its replacement has fully faded in. */
  fadingOut: boolean;
  /** Smooth far tile (morphing ground + voxel scenery) rather than a voxel chunk. */
  far: boolean;
  level: number;
}

interface Job {
  key: string;
  level: number;
  dist: number;
  x0: number;
  z0: number;
}

export class TerrainLOD {
  readonly group = new THREE.Group();
  readonly heat = new ThermalField();
  /** Split a chunk once its voxels would span more than this many CSS pixels on screen. Lower = finer distant terrain. */
  pixelError = 5;
  /** Soft cap on drawn chunks: on big viewports the effective pixel error eases above pixelError to stay under it. */
  chunkBudget = 1400;
  private errorScale = 1;
  /** Seconds a LOD swap takes to dither from the old chunks to the new ones. 0 = instant. */
  fadeTime = 0.3;
  /**
   * Coarsest voxel size drawn as voxel ground. Coarser levels are smooth far tiles whose vertices morph toward
   * their parent with distance (CDLOD), so distant mountains no longer change shape when a tile splits or merges.
   */
  voxelMaxSize = 4;
  private material: THREE.MeshLambertMaterial;
  private cachedBytes = 0;
  private entries = new Map<string, Entry>();
  private pending = new Set<string>();
  private shown = new Set<string>();
  /** Chunks that were replaced and stay solid underneath their replacements until those finish fading in. */
  private fading = new Set<string>();
  /** Chunks drawn as their children last frame / this frame, for hysteresis. */
  private split = new Set<string>();
  private nextSplit = new Set<string>();
  /** Distance (in chunk sizes) under which a chunk splits, from FOV and viewport height. */
  private splitAt = 2.2;
  private workers: Worker[] = [];
  private inflight = new Map<number, string>();
  private completed: { id: number; mesh: ChunkMesh | FarMesh; bytes: number }[] = [];
  private nextId = 1;
  private frame = 0;
  private paceUploadsUntil = 0;
  private maxInflight: number;
  private wanted: Job[] = [];
  private showList: string[] = [];
  private cam = new THREE.Vector3();
  /**
   * Coverage steps for fading-in chunks, sharing one compiled program. three.js only re-uploads a
   * non-ShaderMaterial's uniforms when the material changes between draws, so a per-object uniform set in
   * onBeforeRender leaks to every chunk drawn after it; distinct materials are the reliable way to vary it.
   */
  private fadeMaterials: THREE.MeshLambertMaterial[] = [];
  private fadeUniforms: { value: number }[] = [];
  /** Per-level morph range (start, end distance) shared by that level's far materials. */
  private morphUniforms = new Map<number, { value: THREE.Vector2 }>();
  /** [far ground, voxel scenery] material pairs by level and fade step (FADE_STEPS = solid). */
  private farPairs = new Map<number, THREE.MeshLambertMaterial[]>();
  /** Bumped by every invalidation; chunks remember the version they were built at. */
  private editVersion = 0;
  private staleAt = new Map<string, number>();
  private jobVer = new Map<number, number>();
  /** Heal clock passed to workers so damage heals consistently. */
  clock = 0;

  constructor(terrain: TerrainData, private hf: Heightfield) {
    for (let k = 0; k <= FADE_STEPS; k++) this.fadeUniforms.push({ value: k / FADE_STEPS });
    this.material = this.makeMaterial(this.fadeUniforms[FADE_STEPS]);
    for (let k = 0; k < FADE_STEPS; k++) this.fadeMaterials.push(this.makeMaterial(this.fadeUniforms[k]));
    // Each worker owns a terrain copy, mip pyramid and scenery index.
    const n = Math.max(2, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
    this.maxInflight = n * 6;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      w.postMessage({ type: "init", terrain });
      w.onmessage = (e: MessageEvent<{ id: number; mesh: ChunkMesh | FarMesh }>) => {
        const { id, mesh } = e.data;
        const bytes = mesh.positions.byteLength + mesh.normals.byteLength + mesh.colors.byteLength
          + mesh.materials.byteLength + mesh.indices.byteLength
          + ("coarseY" in mesh ? mesh.coarseY.byteLength + mesh.coarseN.byteLength + mesh.coarseC.byteLength : 0);
        this.completed.push({ id, mesh, bytes });
      };
      this.workers.push(w);
    }
  }

  private makeMaterial(fade: { value: number }, morph?: { value: THREE.Vector2 }): THREE.MeshLambertMaterial {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: this.material?.side ?? THREE.FrontSide });
    const uniforms = morph ? { uFade: fade, uMorph: morph } : { uFade: fade };
    material.customProgramCacheKey = () => morph ? "terrain-far" : "terrain-voxel";
    material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;" + (morph
          ? "\nattribute float aCoarseY;\nattribute vec3 aCoarseN;\nattribute vec3 aCoarseC;\nuniform vec2 uMorph;\nfloat terrainMorph = 0.0;" : ""))
        // far ground morphs toward its parent tile with distance: height, normal and colour
        .replace("#include <color_vertex>", "#include <color_vertex>\n" + (morph
          ? "\tterrainMorph = smoothstep(uMorph.x, uMorph.y, distance((modelMatrix * vec4(position, 1.0)).xyz, cameraPosition));\n\tvColor.rgb = mix(vColor.rgb, aCoarseC, terrainMorph);\n" : "")
          // vertex colours are authored in sRGB
          + "\tvColor.rgb = pow(vColor.rgb, vec3(2.2));")
        .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>" + (morph ? "\n\tobjectNormal = normalize(mix(objectNormal, aCoarseN, terrainMorph));" : ""))
        .replace("#include <begin_vertex>", "#include <begin_vertex>" + (morph ? "\n\ttransformed.y = mix(transformed.y, aCoarseY, terrainMorph);" : ""))
        // Use the same projection arithmetic on both sides of a shared chunk border.
        .replace("#include <project_vertex>", `
          vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vec4 mvPosition = viewMatrix * vec4(vWPos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          vWNormal = objectNormal;`);
      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
uniform float uFade;
float voxelHash(vec3 p) {
  p = fract(mod(p, 4096.0) * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}`,
        )
        // pull fading-in chunks a hair forward (~0.03% of distance) so they win where they coincide with the old LOD
        .replace(
          "#include <logdepthbuf_fragment>",
          `#include <logdepthbuf_fragment>
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
  if (uFade < 1.0) gl_FragDepth -= 2e-5;
#endif`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
  // LOD crossfade: an incoming chunk dithers in over the solid chunk it replaces, so a swap can never open a hole
  if (uFade < 1.0) {
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (n >= uFade) discard;
  }
  // Shade jitter on a world grid sized to the pixel footprint, not to this chunk's voxels: it doesn't reshuffle
  // when a chunk swaps LOD, and coarse voxels still read as finely faceted. Adjacent grid sizes blend like mips.
  float grid = log2(max(length(fwidth(vWPos)) * 3.0, ${VOXEL.toFixed(3)}));
  float g0 = floor(grid), c0 = exp2(g0), c1 = c0 * 2.0;
  float j0 = voxelHash(floor((vWPos - vWNormal * 0.5 * c0) / c0));
  float j1 = voxelHash(floor((vWPos - vWNormal * 0.5 * c1) / c1));
  float grain = ${morph ? "0.045" : "mix(0.070, 0.115, abs(vWNormal.y))"};
  diffuseColor.rgb *= 1.0 + grain * (2.0 * mix(j0, j1, smoothstep(0.0, 1.0, grid - g0)) - 1.0);
  // seen from inside solid ground (only drawn while you're underground): dark rock, not a window to the sky
  if (!gl_FrontFacing) diffuseColor.rgb = vec3(0.035, 0.032, 0.03);`,
        );
      patchThermalShader(sh, this.heat);
    };
    return material;
  }

  /** Solid chunks (and replaced ones still underneath) use the base material; fading-in ones a coverage step. */
  private applyFade(e: Entry) {
    const step = e.fadingOut || e.fade >= 1 ? FADE_STEPS : Math.min(FADE_STEPS - 1, Math.floor(e.fade * FADE_STEPS));
    if (!e.far) {
      e.mesh.material = step === FADE_STEPS ? this.material : this.fadeMaterials[step];
      return;
    }
    const key = e.level * (FADE_STEPS + 1) + step;
    let pair = this.farPairs.get(key);
    if (!pair) {
      let morph = this.morphUniforms.get(e.level);
      if (!morph) this.morphUniforms.set(e.level, morph = { value: new THREE.Vector2(1e9, 2e9) });
      pair = [this.makeMaterial(this.fadeUniforms[step], morph), step === FADE_STEPS ? this.material : this.fadeMaterials[step]];
      this.farPairs.set(key, pair);
    }
    e.mesh.material = pair;
  }

  /** Send destruction edits to every worker (append new ones, or reset after healed ones were dropped). */
  sendEdits(mode: "append" | "reset", data: Float32Array, healing: boolean) {
    for (const w of this.workers) w.postMessage({ type: "edits", mode, data, healing });
  }

  /** Rebuild every cached chunk overlapping the box (x/z bounds), keeping the old mesh until the new one lands. */
  invalidate(x0: number, z0: number, x1: number, z1: number, streaming = false) {
    if (streaming) this.paceUploadsUntil = this.frame + 18;
    const ver = ++this.editVersion;
    const ranges: {ax:number; az:number; bx:number; bz:number}[] = [];
    let candidates = 0;
    for (let level = 0; level <= ROOT_LEVEL; level++) {
      const size = chunkSize(level), max = 2 ** (ROOT_LEVEL - level) - 1;
      const ax = Math.max(0, Math.ceil((x0 - ROOT_MIN) / size) - 1);
      const az = Math.max(0, Math.ceil((z0 - ROOT_MIN) / size) - 1);
      const bx = Math.min(max, Math.floor((x1 - ROOT_MIN) / size));
      const bz = Math.min(max, Math.floor((z1 - ROOT_MIN) / size));
      ranges.push({ax,az,bx,bz});
      candidates += Math.max(0, bx-ax+1) * Math.max(0, bz-az+1);
    }
    if (candidates < this.entries.size + this.pending.size) {
      for (let level = 0; level < ranges.length; level++) {
        const {ax,az,bx,bz} = ranges[level];
        for (let x = ax; x <= bx; x++) for (let z = az; z <= bz; z++) {
          const key = `${level}:${x}:${z}`;
          if (this.entries.has(key) || this.pending.has(key)) this.staleAt.set(key,ver);
        }
      }
    } else {
      const mark = (key: string) => {
        const [level, x, z] = parseKey(key);
        const {ax,az,bx,bz} = ranges[level];
        if (x >= ax && x <= bx && z >= az && z <= bz) this.staleAt.set(key,ver);
      };
      for (const key of this.entries.keys()) mark(key);
      for (const key of this.pending) mark(key);
    }
  }

  /** While underground, back faces are drawn (as dark rock) so the mountain you're inside stays opaque. */
  set underground(on: boolean) {
    const side = on ? THREE.DoubleSide : THREE.FrontSide;
    if (this.material.side === side) return;
    for (const m of [this.material, ...this.fadeMaterials]) m.side = side;
    for (const pair of this.farPairs.values()) pair[0].side = side;
  }

  get pendingCount(): number {
    return this.pending.size + this.wanted.length;
  }

  get chunkCount(): number {
    return this.shown.size;
  }

  get performanceStats() {
    return {
      visibleTerrainMeshes: this.shown.size,
      cachedTerrainMeshes: this.entries.size,
      cachedTerrainBytes: this.cachedBytes,
      pendingTerrainMeshes: this.pending.size,
      completedTerrainMeshes: this.completed.length,
      staleTerrainMeshes: this.staleAt.size,
    };
  }

  /** Distance inside which every chunk is fine enough to voxelise trees (they all have voxels ≤ TREE_VOXEL_MAX). */
  get treeVoxelRange(): number {
    return this.splitAt * CHUNK_COLS * TREE_VOXEL_MAX;
  }

  private onBuilt(id: number, m: ChunkMesh | FarMesh, bytes: number) {
    const key = this.inflight.get(id)!;
    const ver = this.jobVer.get(id) ?? 0;
    this.inflight.delete(id);
    this.jobVer.delete(id);
    this.pending.delete(key);
    const old = this.entries.get(key);
    const [level, ix, iz] = key.split(":").map(Number);
    const size = chunkSize(level);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3, true));
    g.setAttribute("color", new THREE.BufferAttribute(m.colors, 3, true));
    g.setAttribute("materialId", new THREE.BufferAttribute(m.materials, 1));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    const far = "coarseY" in m;
    if (far) {
      g.setAttribute("aCoarseY", new THREE.BufferAttribute(m.coarseY, 1));
      g.setAttribute("aCoarseN", new THREE.BufferAttribute(m.coarseN, 3, true));
      g.setAttribute("aCoarseC", new THREE.BufferAttribute(m.coarseC, 3, true));
      g.addGroup(0, m.groundIndices, 0);
      g.addGroup(m.groundIndices, m.indices.length - m.groundIndices, 1);
    }
    const minY = Number.isFinite(m.minY) ? m.minY : 0, maxY = Number.isFinite(m.maxY) ? m.maxY : 0;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, minY, 0), new THREE.Vector3(size, maxY, size));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(g, this.material);
    mesh.receiveShadow = true;
    const entry: Entry = { mesh, bytes, lastUsed: old ? old.lastUsed : this.frame, ver, fade: old ? old.fade : 1, fadingOut: old ? old.fadingOut : false, far, level };
    this.applyFade(entry);
    mesh.position.set(ROOT_MIN + ix * size, 0, ROOT_MIN + iz * size);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = old ? old.mesh.visible : false;
    if (old) {
      this.group.remove(old.mesh);
      old.mesh.geometry.dispose();
    }
    this.group.add(mesh);
    this.entries.set(key, entry);
    this.cachedBytes += bytes - (old?.bytes ?? 0);
    if ((this.staleAt.get(key) ?? 0) <= ver) this.staleAt.delete(key);
  }

  private ready(key: string): boolean {
    return this.entries.has(key);
  }

  private show(key: string) {
    this.showList.push(key);
  }

  /** Show already-built finer chunks in place of an unbuilt one (used while zooming out). */
  private coverFromChildren(level: number, ix: number, iz: number, depth: number): boolean {
    if (level === 0 || depth === 0) return false;
    for (let c = 0; c < 4; c++) {
      const cx = ix * 2 + (c & 1), cz = iz * 2 + (c >> 1);
      const key = `${level - 1}:${cx}:${cz}`;
      if (this.ready(key)) this.show(key);
      else if (!this.coverFromChildren(level - 1, cx, cz, depth - 1)) return false;
    }
    return true;
  }

  private visit(level: number, ix: number, iz: number): boolean {
    const size = chunkSize(level);
    const x0 = ROOT_MIN + ix * size, z0 = ROOT_MIN + iz * size;
    if (x0 >= WORLD_HALF || z0 >= WORLD_HALF || x0 + size <= -WORLD_HALF || z0 + size <= -WORLD_HALF) return true;
    const c = this.cam;
    const px = Math.max(x0, Math.min(c.x, x0 + size)), pz = Math.max(z0, Math.min(c.z, z0 + size));
    const dy = Math.max(0, c.y - Math.max(this.hf.height(px, pz, size / CHUNK_COLS), this.hf.authored.heightNear(px,pz)));
    const dist = Math.hypot(px - c.x, pz - c.z, dy);
    const key = `${level}:${ix}:${iz}`;

    // once split, stay split a little further out so chunks on the boundary don't flicker between levels
    const reach = this.splitAt * size * (this.split.has(key) ? HYSTERESIS : 1);
    if (level > 0 && dist < reach) {
      const mark = this.showList.length;
      let all = true;
      for (let q = 0; q < 4; q++) {
        if (!this.visit(level - 1, ix * 2 + (q & 1), iz * 2 + (q >> 1))) all = false;
      }
      if (all) {
        this.nextSplit.add(key);
        return true;
      }
      if (this.ready(key)) {
        this.showList.length = mark;
        this.show(key);
        return true;
      }
      return false;
    }

    if (this.ready(key)) {
      this.show(key);
      return true;
    }
    if (!this.pending.has(key)) this.wanted.push({ key, level, dist, x0, z0 });
    const mark = this.showList.length;
    if (this.coverFromChildren(level, ix, iz, 2)) return true;
    this.showList.length = mark;
    return false;
  }

  update(camera: THREE.PerspectiveCamera, dt: number) {
    this.frame++;
    const pacingUploads = this.frame <= this.paceUploadsUntil;
    const uploadLimit = pacingUploads ? 2 : MESHES_PER_FRAME;
    // Keep completed jobs in flight until installed, bounding both the queue and bursts of GPU uploads.
    let installedBytes = 0;
    for (let i = 0; i < uploadLimit && this.completed.length; i++) {
      const next = this.completed[0];
      if (i > 0 && installedBytes + next.bytes > MESH_BYTES_PER_FRAME) break;
      this.completed.shift();
      this.onBuilt(next.id, next.mesh, next.bytes);
      installedBytes += next.bytes;
    }
    this.cam.copy(camera.position);
    // a voxel of size s at distance d spans s/d radians; split once that exceeds pixelError pixels
    const pxPerRadian = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const load = this.shown.size / this.chunkBudget;
    this.errorScale = Math.max(1, this.errorScale * (load > 1 ? 1.01 : load < 0.85 ? 0.995 : 1));
    this.splitAt = pxPerRadian / (this.pixelError * this.errorScale * CHUNK_COLS);
    // a far tile is fully morphed into its parent by the distance at which that parent would split into it
    for (const [level, morph] of this.morphUniforms) {
      const parentSplit = this.splitAt * chunkSize(level + 1);
      morph.value.set(parentSplit * 0.6, parentSplit * 0.95);
    }
    this.wanted.length = 0;
    this.showList.length = 0;
    this.nextSplit.clear();
    this.visit(ROOT_LEVEL, 0, 0);
    [this.split, this.nextSplit] = [this.nextSplit, this.split];

    // visibility: on a LOD swap the replaced chunks stay solid while their replacements dither in over them
    const next = new Set(this.showList);
    const removed: string[] = [], added: string[] = [];
    for (const key of this.shown) if (!next.has(key)) removed.push(key);
    for (const key of next) if (!this.shown.has(key)) added.push(key);
    const removedAt = removed.map(parseKey), addedAt = added.map(parseKey);
    const crossing = (at: [number, number, number], others: [number, number, number][]) => this.fadeTime > 0 && others.some((o) => overlaps(at, o));
    for (let i = 0; i < removed.length; i++) {
      const key = removed[i], e = this.entries.get(key)!;
      if (crossing(removedAt[i], addedAt)) {
        e.fadingOut = true;
        e.fade = 1; // countdown; it may itself have been mid-fade-in, but a replaced chunk is always drawn solid
        this.fading.add(key);
      } else {
        e.mesh.visible = false;
        e.fade = 1;
      }
    }
    for (let i = 0; i < added.length; i++) {
      const key = added[i], e = this.entries.get(key)!;
      if (this.fading.delete(key)) {
        e.fadingOut = false; // coming back before it was hidden: it was still solid, so stay solid
        e.fade = 1;
      } else e.fade = crossing(addedAt[i], removedAt) ? 0 : 1;
      this.applyFade(e);
    }
    for (const key of next) {
      const e = this.entries.get(key)!;
      e.mesh.visible = true;
      const size = chunkSize(e.level);
      const dx = this.cam.x - e.mesh.position.x - size * 0.5;
      const dz = this.cam.z - e.mesh.position.z - size * 0.5;
      e.mesh.castShadow = !e.far && Math.max(Math.abs(dx), Math.abs(dz)) < 75 + size * 0.5;
      e.lastUsed = this.frame;
    }
    this.shown = next;
    const step = this.fadeTime > 0 ? dt / this.fadeTime : 1;
    const settling: [number, number, number][] = [];
    for (const key of this.shown) {
      const e = this.entries.get(key)!;
      if (e.fade < 1) {
        e.fade = Math.min(1, e.fade + step);
        this.applyFade(e);
        if (e.fade < 1) settling.push(parseKey(key));
      }
    }
    for (const key of this.fading) {
      const e = this.entries.get(key)!;
      e.fade -= step;
      e.mesh.castShadow = false;
      this.applyFade(e);
      // A second swap can begin before the first finishes. Keep the old coverage
      // until the currently selected chunks over this area are fully drawn.
      if (e.fade <= 0 && !crossing(parseKey(key), settling)) {
        e.mesh.visible = false;
        e.fade = 1;
        e.fadingOut = false;
        this.fading.delete(key);
      }
    }

    // damaged chunks you can see are rebuilt first, finest (nearest the damage) first
    const rebuild: Job[] = [];
    for (const [key, ver] of this.staleAt) {
      const e = this.entries.get(key);
      if (!e || this.pending.has(key) || e.ver >= ver) continue;
      if (!this.shown.has(key)) continue;
      const [level, ix, iz] = key.split(":").map(Number);
      const size = chunkSize(level);
      rebuild.push({ key, level, dist: 0, x0: ROOT_MIN + ix * size, z0: ROOT_MIN + iz * size });
    }
    rebuild.sort((a, b) => a.level - b.level);
    // then new chunks: coarse first so there is never a hole, then nearest
    this.wanted.sort((a, b) => b.level - a.level || a.dist - b.dist);
    const queue = rebuild.concat(this.wanted);
    let wi = 0;
    // A streamed trench can dirty many chunks at once. Keep workers from
    // returning a burst of replacements while the projectile is still onscreen.
    const budget = pacingUploads ? Math.ceil(this.maxInflight / 2) : this.maxInflight + Math.min(rebuild.length, this.maxInflight);
    while (this.inflight.size < budget && wi < queue.length) {
      const j = queue[wi++];
      const id = this.nextId++;
      this.inflight.set(id, j.key);
      this.jobVer.set(id, this.editVersion);
      this.pending.add(j.key);
      const s = VOXEL * 2 ** j.level;
      this.workers[id % this.workers.length].postMessage({ type: "build", id, x0: j.x0, z0: j.z0, s, clock: this.clock, far: s > this.voxelMaxSize });
    }
    this.wanted.length = 0;

    if (this.entries.size > this.shown.size + this.fading.size
      && (this.entries.size > MAX_CACHED || this.cachedBytes > CACHE_BYTE_BUDGET)) this.evict();
  }

  private evict() {
    const old = [...this.entries].filter(([k, entry]) => !this.shown.has(k) && !this.fading.has(k) && !this.pending.has(k) && this.frame - entry.lastUsed > 90).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const targetCount = this.entries.size > MAX_CACHED ? Math.floor(MAX_CACHED * .8) : MAX_CACHED;
    const targetBytes = this.cachedBytes > CACHE_BYTE_BUDGET ? CACHE_BYTE_BUDGET * .8 : CACHE_BYTE_BUDGET;
    for (const [key, e] of old) {
      if (this.entries.size <= targetCount && this.cachedBytes <= targetBytes) break;
      this.group.remove(e.mesh);
      e.mesh.geometry.dispose();
      this.entries.delete(key);
      this.cachedBytes -= e.bytes;
      this.staleAt.delete(key);
    }
  }
}
