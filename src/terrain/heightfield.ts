import { AuthoredVoxels, type VoxelModel, type VoxelInstance } from "./authored";
// Shared terrain sampling. Runs on the main thread (collision, HUD) and in mesh workers.
// World coordinates are metres: x east, z south, y elevation above sea level.

export interface GridMeta {
  width: number;
  height: number;
  cell_m: number;
  min_m: number;
  step_m: number;
  origin_x: number; // x of the north-west corner of cell (0,0)
  origin_z: number;
}

/** Raw data handed to every consumer (transferable to workers by copy). */
export interface TerrainData {
  inner: { meta: GridMeta; data: Uint16Array };
  outer: { meta: GridMeta; data: Uint16Array };
  water: Uint8Array; // river mask on the inner grid, 255 = water
  models?: VoxelModel[];
  instances?: VoxelInstance[];
  boxes?: Float32Array; // immutable voxel volumes: x0,y0,z0,x1,y1,z1,material
  roads?: Float32Array; // surface paint segments: ax,az,bx,bz,halfWidth
}

export const WATER_LEVEL = 396; // Lake Constance surface; anything below floods
export const WORLD_HALF = 40000; // outer grid covers ±40 km
/** Finest voxel edge in metres (Teardown is ~0.1). LOD level L uses VOXEL * 2^L. */
export const VOXEL = 0.125;

class Grid {
  readonly w: number;
  readonly h: number;
  constructor(
    w: number,
    h: number,
    readonly cell: number,
    readonly ox: number,
    readonly oz: number,
    readonly data: ArrayLike<number>,
    readonly offset = 0,
    readonly scale = 1,
  ) {
    this.w = w;
    this.h = h;
  }

  sample(x: number, z: number): number {
    let fx = (x - this.ox) / this.cell - 0.5;
    let fz = (z - this.oz) / this.cell - 0.5;
    const mx = this.w - 1, mz = this.h - 1;
    fx = fx < 0 ? 0 : fx > mx ? mx : fx;
    fz = fz < 0 ? 0 : fz > mz ? mz : fz;
    const c0 = fx | 0, r0 = fz | 0;
    const c1 = Math.min(c0 + 1, mx), r1 = Math.min(r0 + 1, mz);
    const tx = fx - c0, tz = fz - r0;
    const d = this.data, row0 = r0 * this.w, row1 = r1 * this.w;
    const a = d[row0 + c0] * (1 - tx) + d[row0 + c1] * tx;
    const b = d[row1 + c0] * (1 - tx) + d[row1 + c1] * tx;
    return this.offset + (a * (1 - tz) + b * tz) * this.scale;
  }

  /** Average 2x2 down into a Float32 grid of double the cell size. */
  downsample(): Grid {
    const w = Math.max(1, this.w >> 1), h = Math.max(1, this.h >> 1);
    const out = new Float32Array(w * h);
    const d = this.data, sw = this.w;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * 2 * sw + c * 2;
        out[r * w + c] = this.offset + ((d[i] + d[i + 1] + d[i + sw] + d[i + sw + 1]) / 4) * this.scale;
      }
    }
    return new Grid(w, h, this.cell * 2, this.ox, this.oz, out);
  }
}

function hash2(ix: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hashCol(x: number, z: number): number {
  return hash2(Math.floor(x), Math.floor(z));
}

/** Smooth value noise in [0,1]. */
export function vnoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz;
}

export class Heightfield {
  readonly authored: AuthoredVoxels;
  readonly boxes: Float32Array;
  readonly roads: Float32Array;
  private boxCells = new Map<string, number[]>();
  private roadCells = new Map<string, number[]>();

  private index(cells: Map<string, number[]>, id: number, x0: number, z0: number, x1: number, z1: number) {
    for (let x = Math.floor(x0 / 32); x <= Math.floor(x1 / 32); x++)
      for (let z = Math.floor(z0 / 32); z <= Math.floor(z1 / 32); z++) {
        const key = `${x}:${z}`, list = cells.get(key);
        if (list) list.push(id); else cells.set(key, [id]);
      }
  }

  /** Static volumes participate in the same columns as terrain and dynamic edits. */
  volumesAt(x: number, z: number): readonly number[] | undefined {
    return this.boxCells.get(`${Math.floor(x / 32)}:${Math.floor(z / 32)}`);
  }

  paintedRoad(x: number, z: number, padding = 0, minHalfWidth = 0): boolean {
    const list = this.roadCells.get(`${Math.floor(x / 32)}:${Math.floor(z / 32)}`);
    if (!list) return false;
    const d = this.roads;
    for (const o of list) {
      if (d[o + 4] < minHalfWidth) continue;
      const dx = d[o + 2] - d[o], dz = d[o + 3] - d[o + 1];
      const t = Math.max(0, Math.min(1, ((x - d[o]) * dx + (z - d[o + 1]) * dz) / (dx * dx + dz * dz || 1)));
      if ((x - d[o] - t * dx) ** 2 + (z - d[o + 1] - t * dz) ** 2 <= (d[o + 4] + padding) ** 2) return true;
    }
    return false;
  }

  /** Resolve original voxel identity even on a freshly carved interior face. */
  materialAt(x: number, y: number, z: number, base: number, surface: Mat, s = VOXEL): Mat {
    const list = this.volumesAt(x, z), d = this.boxes, q = verticalQuantum(s);
    if (list) for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      if (x >= d[o] && x < d[o + 3] && z >= d[o + 2] && z < d[o + 5] && y >= Math.round(d[o + 1] / q) * q && y <= Math.round(d[o + 4] / q) * q) return d[o + 6];
    }
    const authored = this.authored.materialAt(x,y,z,s);
    if (authored !== null) return authored;
    const depth = base - y;
    if (depth >= -0.3 && depth < 0.3 && surface !== Mat.Water && this.paintedRoad(x, z, Math.min(4,s*.25),s>2?2.2:s>.5?1.4:0)) return Mat.Asphalt;
    return depth > 0.3 ? subsurface(surface, depth) : y > base + 0.3 ? Mat.Soil : surface;
  }

  private mips: Grid[] = [];
  private outer: Grid;
  private water: Grid;
  private x0: number;
  private z0: number;
  private x1: number;
  private z1: number;

  constructor(t: TerrainData) {
    this.authored = new AuthoredVoxels(t.models ?? [], t.instances ?? []);
    this.boxes = t.boxes ?? new Float32Array();
    this.roads = t.roads ?? new Float32Array();
    for (let o = 0; o < this.boxes.length; o += 7) this.index(this.boxCells, o, this.boxes[o], this.boxes[o + 2], this.boxes[o + 3], this.boxes[o + 5]);
    for (let o = 0; o < this.roads.length; o += 5) {
      const d = this.roads, r = d[o + 4] + 8;
      this.index(this.roadCells, o, Math.min(d[o], d[o + 2]) - r, Math.min(d[o + 1], d[o + 3]) - r, Math.max(d[o], d[o + 2]) + r, Math.max(d[o + 1], d[o + 3]) + r);
    }
    const m = t.inner.meta;
    let g = new Grid(m.width, m.height, m.cell_m, m.origin_x, m.origin_z, t.inner.data, m.min_m, m.step_m);
    this.mips.push(g);
    for (let i = 0; i < 6 && g.w > 1 && g.h > 1; i++) {
      g = g.downsample();
      this.mips.push(g);
    }
    const o = t.outer.meta;
    this.outer = new Grid(o.width, o.height, o.cell_m, o.origin_x, o.origin_z, t.outer.data, o.min_m, o.step_m);
    this.water = new Grid(m.width, m.height, m.cell_m, m.origin_x, m.origin_z, t.water, 0, 1 / 255);
    this.x0 = m.origin_x;
    this.z0 = m.origin_z;
    this.x1 = m.origin_x + m.width * m.cell_m;
    this.z1 = m.origin_z + m.height * m.cell_m;
  }

  /** 0 outside the high-res survey, 1 well inside it. */
  private innerWeight(x: number, z: number): number {
    const margin = 800;
    const d = Math.min(x - this.x0, this.x1 - x, z - this.z0, this.z1 - z) - 50;
    if (d <= 0) return 0;
    if (d >= margin) return 1;
    const t = d / margin;
    return t * t * (3 - 2 * t);
  }

  /** Smooth ground elevation at (x,z), prefiltered for a voxel of size s metres. */
  height(x: number, z: number, s: number): number {
    const w = this.innerWeight(x, z);
    let h: number;
    if (w <= 0) {
      h = this.outer.sample(x, z);
    } else {
      const k = Math.max(0, Math.min(this.mips.length - 1, Math.floor(Math.log2(s / 10))));
      const hi = this.mips[k].sample(x, z);
      h = w >= 1 ? hi : this.outer.sample(x, z) * (1 - w) + hi * w;
      if (s < 16) {
        // Survey is 10 m; add a little rubble so close-up voxels aren't perfect ramps.
        const fade = 1 - s / 16;
        const g = this.mips[0];
        const slope = Math.min(1.5, Math.hypot(g.sample(x + 5, z) - g.sample(x - 5, z), g.sample(x, z + 5) - g.sample(x, z - 5)) / 10);
        const amp = (0.25 + slope * 1.4) * fade * w;
        h += ((vnoise(x / 13, z / 13) - 0.5) * 2.2 + (vnoise(x / 4.7, z / 4.7) - 0.5) * 0.8) * amp;
        if (s < 1) h += (vnoise(x / 1.6, z / 1.6) - 0.5) * 0.35 * amp * (1 - s);
      }
    }
    return h;
  }

  /** River mask in [0,1] (only meaningful inside the survey). */
  waterAt(x: number, z: number): number {
    if (this.innerWeight(x, z) < 1) return 0;
    return this.water.sample(x, z);
  }
}

export interface Column {
  top: number; // y of the top face
  water: boolean;
}

/** Vertical quantum for a voxel of size s. Far LODs use squashed columns so the skyline keeps its shape. */
export function verticalQuantum(s: number): number {
  return Math.min(s, 4);
}

/** The block column at (cx,cz) for voxel size s. This is the single source of truth for both meshing and collision. */
export function column(hf: Heightfield, cx: number, cz: number, s: number, out: Column): Column {
  let h = hf.height(cx, cz, s);
  const q = verticalQuantum(s);
  const river = s <= 64 && hf.waterAt(cx, cz) > 0.5;
  if (river) {
    out.top = Math.round((h - 1.5) / q) * q;
    out.water = true;
  } else if (h < WATER_LEVEL) {
    out.top = Math.round(WATER_LEVEL / q) * q;
    out.water = true;
  } else {
    out.top = Math.round(h / q) * q;
    out.water = false;
  }
  return out;
}

/** Depth below the undisturbed surface of an unbreakable floor: nothing carves deeper. */
export const BEDROCK_DEPTH = 2;

export enum Mat { Water, Snow, Rock, Alpine, Forest, Meadow, Farm, Soil, Bedrock, Asphalt, Concrete, Wood, Leaves, RoofTile, RoofSlate, Glass }

export interface MaterialProps {
  name: string;
  /** Sliding (kinetic) friction coefficient; also caps how hard you can push off when running. */
  friction: number;
  /** Restitution for impacts. */
  bounce: number;
  /** Footstep / impact timbre. */
  sound: "soft" | "hard" | "crunch" | "splash";
  /** How hard it is to break (relative; farmland = 1). Crater volume goes as impact energy / strength. */
  strength: number;
  /** Debris / dust colour (sRGB 0-255). */
  debris: [number, number, number];
}

export const MATERIALS: Record<Mat, MaterialProps> = {
  [Mat.RoofTile]: { name:"roof tile",friction:0.7,bounce:0.08,sound:"hard",strength:1.7,debris:[145,76,53] },
  [Mat.RoofSlate]: { name:"slate roof",friction:0.6,bounce:0.12,sound:"hard",strength:2.6,debris:[76,84,91] },
  [Mat.Glass]: { name:"window glass",friction:0.35,bounce:0.06,sound:"crunch",strength:0.25,debris:[57,91,112] },
  [Mat.Asphalt]: { name: "asphalt", friction: 0.85, bounce: 0.08, sound: "hard", strength: 2.5, debris: [68, 71, 74] },
  [Mat.Concrete]: { name: "concrete", friction: 0.8, bounce: 0, sound: "hard", strength: 0.35, debris: [168, 167, 160] },
  [Mat.Wood]: { name: "wood", friction: 0.7, bounce: 0.04, sound: "crunch", strength: 0.3, debris: [106, 77, 48] },
  [Mat.Leaves]: { name: "foliage", friction: 0.08, bounce: 0, sound: "soft", strength: 0.025, debris: [45, 83, 38] },
  [Mat.Water]: { name: "water", friction: 0, bounce: 0, sound: "splash", strength: 0, debris: [200, 225, 240] },
  [Mat.Snow]: { name: "snow", friction: 0.1, bounce: 0.04, sound: "crunch", strength: 0.25, debris: [236, 240, 246] },
  [Mat.Rock]: { name: "rock", friction: 0.75, bounce: 0.3, sound: "hard", strength: 4, debris: [118, 113, 108] },
  [Mat.Alpine]: { name: "alpine meadow", friction: 0.5, bounce: 0.12, sound: "soft", strength: 1.8, debris: [128, 118, 100] },
  [Mat.Forest]: { name: "forest floor", friction: 0.6, bounce: 0.08, sound: "soft", strength: 1.3, debris: [92, 74, 52] },
  [Mat.Meadow]: { name: "meadow", friction: 0.5, bounce: 0.12, sound: "soft", strength: 1.4, debris: [112, 90, 62] },
  [Mat.Farm]: { name: "farmland", friction: 0.55, bounce: 0.1, sound: "soft", strength: 1.3, debris: [120, 94, 64] },
  [Mat.Soil]: { name: "soil", friction: 0.6, bounce: 0.06, sound: "soft", strength: 1.35, debris: [122, 94, 64] },
  [Mat.Bedrock]: { name: "bedrock", friction: 0.75, bounce: 0.3, sound: "hard", strength: 5, debris: [106, 102, 98] },
};

/** Ground slope (rise over run) from the smooth surface, measured over at least 2 m so voxel steps don't make it noisy. */
export function slopeAt(hf: Heightfield, x: number, z: number, s: number): number {
  const d = Math.max(s, 2);
  return Math.hypot(hf.height(x + d, z, s) - hf.height(x - d, z, s), hf.height(x, z + d, s) - hf.height(x, z - d, s)) / (2 * d);
}

/** What the ground is made of. Drives colour, friction, bounce and sound, so what you see is what you stand on. */
export function surfaceMaterial(h: number, slope: number, water: boolean, x: number, z: number): Mat {
  if (water) return Mat.Water;
  const n = vnoise(x / 220, z / 220);
  if (h > 2080 + (n - 0.5) * 300 && slope < 1.25) return Mat.Snow;
  if (slope > 1.05) return Mat.Rock;
  if (h > 1720 + (n - 0.5) * 260) return Mat.Alpine;
  if (h > 570 || slope > 0.33) return vnoise(x / 90 + 17, z / 90) > 0.72 && slope < 0.6 ? Mat.Meadow : Mat.Forest;
  return Mat.Farm;
}

/** Surface colour (0-255 rgb) for a column, written into out[o..o+2]. */
export function surfaceColor(h: number, slope: number, water: boolean, x: number, z: number, s: number, out: Uint8Array | number[], o: number): void {
  let r: number, g: number, b: number;
  // a little patchiness at the scale of the voxel grid; per-voxel jitter is done in the terrain shader
  const j = 0.96 + hashCol(x / (s * 8), z / (s * 8)) * 0.08;
  switch (surfaceMaterial(h, slope, water, x, z)) {
    case Mat.Water: r = 52; g = 104; b = 150; break;
    case Mat.Snow: r = 238; g = 242; b = 248; break;
    case Mat.Rock: {
      const t = vnoise(x / 40, z / 40);
      r = 112 + t * 25; g = 108 + t * 22; b = 104 + t * 20;
      break;
    }
    case Mat.Alpine: {
      const t = Math.min(1, slope * 1.2 + (vnoise(x / 60, z / 60) - 0.5));
      r = 128 + (140 - 128) * t; g = 146 + (134 - 146) * t; b = 78 + (122 - 78) * t;
      break;
    }
    case Mat.Meadow: r = 104; g = 146; b = 64; break;
    case Mat.Forest: r = 44; g = 82; b = 42; break;
    default: {
      const f = vnoise(x / 110 + 5, z / 110 + 9);
      if (f < 0.35) { r = 104; g = 150; b = 62; }
      else if (f < 0.6) { r = 126; g = 160; b = 70; }
      else if (f < 0.8) { r = 150; g = 156; b = 82; }
      else { r = 86; g = 128; b = 56; }
    }
  }
  out[o] = Math.min(255, r * j);
  out[o + 1] = Math.min(255, g * j);
  out[o + 2] = Math.min(255, b * j);
}

/** What lies `depth` metres below an undisturbed surface of material m. */
export function subsurface(m: Mat, depth: number): Mat {
  switch (m) {
    case Mat.Asphalt: return depth < 0.3 ? Mat.Asphalt : depth < Math.min(4, BEDROCK_DEPTH) ? Mat.Soil : Mat.Bedrock;
    case Mat.Concrete: case Mat.Wood: case Mat.Leaves: case Mat.RoofTile: case Mat.RoofSlate: case Mat.Glass: return m;
    case Mat.Water: return Mat.Water;
    case Mat.Rock: case Mat.Bedrock: return Mat.Bedrock;
    case Mat.Snow: return depth < 1.5 ? Mat.Snow : Mat.Bedrock;
    case Mat.Alpine: return depth < 0.5 ? Mat.Soil : Mat.Bedrock;
    default: return depth < Math.min(4, BEDROCK_DEPTH) ? Mat.Soil : Mat.Bedrock;
  }
}

/** Colour of exposed ground `depth` metres below a surface of material m: topsoil, soil, gravel, bedrock strata. */
export function layerColor(m: Mat, depth: number, out: Uint8Array | number[], o: number): void {
  const sub = subsurface(m, depth);
  let r: number, g: number, b: number;
  if (depth >= BEDROCK_DEPTH) { r = 52; g = 50; b = 60; } // the unbreakable floor: dark basalt
  else if (sub >= Mat.Asphalt) { [r, g, b] = MATERIALS[sub].debris; }
  else if (sub === Mat.Snow) { r = 226; g = 232; b = 240; }
  else if (sub === Mat.Bedrock) {
    const band = Math.sin(depth * 1.7) * 0.5 + 0.5; // faint bedding planes
    r = 100 + band * 14; g = 97 + band * 12; b = 94 + band * 10;
  } else if (depth < 0.5) { r = 82; g = 63; b = 42; }
  else if (depth < 2) { r = 124; g = 96; b = 64; }
  else { r = 142; g = 120; b = 92; }
  out[o] = r; out[o + 1] = g; out[o + 2] = b;
}
