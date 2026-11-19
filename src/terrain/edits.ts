// Terrain destruction as carve / fill volumes, shared by collision and mesh workers.
// A column of terrain becomes a stack of solid spans: [-inf, top] minus carved intervals plus filled ones,
// applied in the order the edits happened. Spheres slowly shrink back to nothing while healing is on.
import { BEDROCK_DEPTH, Mat, column, verticalQuantum, type Column, type Heightfield } from "./heightfield";

export const CARVE = 0;
export const FILL = 1;
/** Axis scales are <= 1; roughness only reduces the footprint, keeping radius a safe bound. */
export interface EditShape {
  sx: number; sy: number; sz: number;
  cos: number; sin: number;
  roughness: number; phase: number; profile: number;
}
const SPHERE: EditShape = { sx: 1, sy: 1, sz: 1, cos: 1, sin: 0, roughness: 0, phase: 0, profile: 0.5 };
/** x, y, z, bounding radius, creation clock, kind, group, then EditShape fields */
export const STRIDE = 15;
export const HEAL_DELAY = 20; // s before damage starts to heal
export const HEAL_TIME = 40; // s to heal completely
const CELL = 16;
export const MAX_SPANS = 24;
const BOTTOM = -1e9;

const cellKey = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

export class Edits {
  data = new Float32Array(STRIDE * 1024);
  count = 0;
  healing = true;
  private maxRadius = 0;
  private grid = new Map<number, number[]>();

  /** Radius of edit i at heal-clock time `clock` (0 = healed away). */
  radius(i: number, clock: number): number {
    const o = i * STRIDE, r = this.data[o + 3];
    if (!this.healing) return r;
    const t = (clock - this.data[o + 4] - HEAL_DELAY) / HEAL_TIME;
    return t <= 0 ? r : t >= 1 ? 0 : r * (1 - t * t * (3 - 2 * t));
  }

  add(kind: number, x: number, y: number, z: number, r: number, clock: number, group: number, shape: EditShape = SPHERE): number {
    if ((this.count + 1) * STRIDE > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    const i = this.count++;
    this.data.set([x, y, z, r, clock, kind, group, shape.sx, shape.sy, shape.sz, shape.cos, shape.sin, shape.roughness, shape.phase, shape.profile], i * STRIDE);
    this.maxRadius = Math.max(this.maxRadius, this.data[i * STRIDE + 3]);
    this.index(i);
    return i;
  }

  /** Append raw edits (worker side). */
  append(raw: Float32Array) {
    const n = raw.length / STRIDE;
    for (let k = 0; k < n; k++) {
      const o = k * STRIDE;
      this.add(raw[o + 5], raw[o], raw[o + 1], raw[o + 2], raw[o + 3], raw[o + 4], raw[o + 6], {
        sx: raw[o + 7], sy: raw[o + 8], sz: raw[o + 9], cos: raw[o + 10], sin: raw[o + 11],
        roughness: raw[o + 12], phase: raw[o + 13], profile: raw[o + 14],
      });
    }
  }

  reset(raw: Float32Array) {
    this.count = 0;
    this.maxRadius = 0;
    this.grid.clear();
    this.append(raw);
  }

  /** Drop edits that have fully healed. Returns true if anything was removed. */
  compact(clock: number): boolean {
    if (!this.healing) return false;
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.radius(i, clock) <= 0) continue;
      if (w !== i) this.data.copyWithin(w * STRIDE, i * STRIDE, (i + 1) * STRIDE);
      w++;
    }
    if (w === this.count) return false;
    this.count = w;
    this.maxRadius = 0;
    this.grid.clear();
    for (let i = 0; i < w; i++) {
      this.maxRadius = Math.max(this.maxRadius, this.data[i * STRIDE + 3]);
      this.index(i);
    }
    return true;
  }

  raw(from = 0, to = this.count): Float32Array {
    return this.data.slice(from * STRIDE, to * STRIDE);
  }

  private index(i: number) {
    const o = i * STRIDE, x = this.data[o], z = this.data[o + 2], r = this.data[o + 3];
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const k = cellKey(ix, iz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(i);
      }
    }
  }

  /** Edits whose cell covers (x,z), in creation order. */
  at(x: number, z: number): number[] | undefined {
    return this.grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  }

  /** Edits touching a box (creation order), skipping those smaller than minR at `clock`. */
  inBox(x0: number, z0: number, x1: number, z1: number, clock: number, minR: number, out: number[]): number[] {
    out.length = 0;
    if (!this.count || minR > this.maxRadius) return out;
    const ax = Math.floor(x0 / CELL), bx = Math.floor(x1 / CELL);
    const az = Math.floor(z0 / CELL), bz = Math.floor(z1 / CELL);
    const include = (i: number) => {
      const o = i * STRIDE, r = this.radius(i, clock);
      if (r < minR) return;
      const x = this.data[o], z = this.data[o + 2];
      if (x + r < x0 || x - r > x1 || z + r < z0 || z - r > z1) return;
      out.push(i);
    };
    // Coarse LODs can cover millions of empty cells after even one terrain hit.
    if ((bx - ax + 1) * (bz - az + 1) > this.count) {
      for (let i = 0; i < this.count; i++) include(i);
      return out;
    }
    const seen = new Set<number>();
    for (let ix = ax; ix <= bx; ix++) {
      for (let iz = az; iz <= bz; iz++) {
        const list = this.grid.get(cellKey(ix, iz));
        if (list) for (const i of list) seen.add(i);
      }
    }
    for (const i of seen) include(i);
    return out.sort((a, b) => a - b);
  }
}

export class Spans {
  n = 1;
  lo = new Float64Array(MAX_SPANS);
  hi = new Float64Array(MAX_SPANS);
  /** Undisturbed surface height of this column. */
  base = 0;
  water = false;
  get top(): number {
    return this.hi[this.n - 1];
  }
  private tl = new Float64Array(MAX_SPANS + 2);
  private th = new Float64Array(MAX_SPANS + 2);

  subtract(a: number, b: number) {
    let m = 0;
    for (let i = 0; i < this.n; i++) {
      const l = this.lo[i], h = this.hi[i];
      if (h <= a || l >= b) { this.tl[m] = l; this.th[m++] = h; continue; }
      if (l < a) { this.tl[m] = l; this.th[m++] = a; }
      if (h > b) { this.tl[m] = b; this.th[m++] = h; }
    }
    this.commit(m);
  }

  union(a: number, b: number) {
    let m = 0, placed = false;
    const push = (l: number, h: number) => {
      if (m > 0 && l <= this.th[m - 1]) this.th[m - 1] = Math.max(this.th[m - 1], h);
      else { this.tl[m] = l; this.th[m++] = h; }
    };
    for (let i = 0; i < this.n; i++) {
      if (!placed && a < this.lo[i]) { push(a, b); placed = true; }
      push(this.lo[i], this.hi[i]);
    }
    if (!placed) push(a, b);
    this.commit(m);
  }

  private commit(m: number) {
    // keep the lowest spans if a column gets absurdly holey
    this.n = Math.min(m, MAX_SPANS);
    for (let i = 0; i < this.n; i++) { this.lo[i] = this.tl[i]; this.hi[i] = this.th[i]; }
    if (this.n === 0) { this.n = 1; this.lo[0] = BOTTOM; this.hi[0] = BOTTOM; }
  }

  /** Top of the solid mass at or below height y (the floor you'd stand on, or the top of a wall you're inside). */
  floor(y: number): number {
    let f = BOTTOM;
    for (let i = 0; i < this.n; i++) if (this.lo[i] <= y) f = this.hi[i];
    return f;
  }

  /** Underside of the first solid above height y, or Infinity. */
  ceil(y: number): number {
    for (let i = 0; i < this.n; i++) if (this.lo[i] > y) return this.lo[i];
    return Infinity;
  }

  solid(y: number): boolean {
    for (let i = 0; i < this.n; i++) if (this.lo[i] <= y && y < this.hi[i]) return true;
    return false;
  }
}

const baseCol: Column = { top: 0, water: false };

/**
 * Solid spans of the column centred at (cx,cz) for voxel size s.
 * `cand` lists the edit indices that may touch it (creation order); boundaries snap to the vertical quantum.
 */
export function columnSpans(hf: Heightfield, edits: Edits | null, cand: ArrayLike<number> | undefined, cx: number, cz: number, s: number, clock: number, out: Spans, solidOnly = false, groundOnly = false): Spans {
  column(hf, cx, cz, s, baseCol);
  out.n = 1;
  out.lo[0] = BOTTOM;
  out.hi[0] = baseCol.top;
  out.base = baseCol.top;
  out.water = baseCol.water;
  const boxes = hf.boxes, volumes = groundOnly ? undefined : hf.volumesAt(cx, cz), quantum = verticalQuantum(s);
  if (volumes) for (const o of volumes) {
    if (solidOnly && boxes[o+6] === Mat.Leaves) continue;
    if (cx >= boxes[o] && cx < boxes[o + 3] && cz >= boxes[o + 2] && cz < boxes[o + 5])
      out.union(Math.round(boxes[o + 1] / quantum) * quantum, Math.round(boxes[o + 4] / quantum) * quantum);
  }
  if (!groundOnly) {
    const authored = hf.authored.column(cx,cz,s,solidOnly);
    for(let n=0;n<authored.count;n++)out.union(authored.low[n],authored.high[n]);
  }
  if (!edits || !cand || cand.length === 0 || (baseCol.water && out.top <= out.base)) return out;
  const q = verticalQuantum(s), d = edits.data;
  // carves stop at the bedrock floor; fills (spoil, rubble) can still pile anywhere
  const bedrock = Math.round((baseCol.top - BEDROCK_DEPTH) / q) * q;
  for (let k = 0; k < cand.length; k++) {
    const i = cand[k];
    const r = edits.radius(i, clock);
    if (r <= 0) continue;
    const o = i * STRIDE, dx = cx - d[o], dz = cz - d[o + 2];
    const u = (dx * d[o + 10] + dz * d[o + 11]) / (r * d[o + 7]);
    const v = (-dx * d[o + 11] + dz * d[o + 10]) / (r * d[o + 9]);
    const distance2 = u * u + v * v;
    if (distance2 >= 1) continue;
    let edge = 1;
    if (d[o + 12] > 0) {
      const angle = Math.atan2(v, u), phase = d[o + 13];
      edge -= d[o + 12] * (0.5 + 0.3 * Math.sin(3 * angle + phase) + 0.2 * Math.sin(7 * angle - phase));
    }
    const inside = 1 - distance2 / (edge * edge);
    if (inside <= 0) continue;
    const h = r * d[o + 8] * Math.pow(inside, d[o + 14]), y = d[o + 1];
    const a = Math.round((y - h) / q) * q, b = Math.round((y + h) / q) * q;
    if (b <= a) continue;
    if (d[o + 5] === CARVE) { if (b > bedrock) out.subtract(Math.max(a, bedrock), b); }
    else out.union(a, b);
  }
  return out;
}
