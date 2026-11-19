import * as THREE from "three";
import type { Destruction } from "./destruction";
import { Spans } from "./terrain/edits";

/**
 * Flight pathfinding over the voxel world. A* runs on a horizontal grid of coarse cells, and every cell
 * reached carries the altitude it is flown at: kept from the previous cell when that's free (so flyers pass
 * under arches and between buildings), eased toward the goal's height, or lifted over whatever is in the way.
 * Climbing costs extra, so the search weighs going over against going around. The route is then string-pulled
 * so flyers cut straight lines between the corners that matter.
 * Positions here are body centres (feet + BODY_CENTER), not feet.
 */
export const BODY_CENTER = .9;
const CELL = 2.5;
const CLEARANCE = .85; // half-height of the body band that must be free
const BELOW = .8; // extra room under the feet, so a fast flyer skimming a roof or canopy doesn't clip it
const RADIUS = .7; // horizontal half-width checked either side of a straight flight line
const FINE = 50; // m of a sight line checked densely and at full width; beyond, a coarse centreline check
const MARGIN = 1.5; // extra room above an obstacle when lifting over it
// Flyers go over clutter rather than slalom through it: climbing is cheap, and the route only glides
// back down gently, so it stays above a forest or town instead of dipping into every gap.
const CLIMB_COST = .5; // per metre climbed, relative to a metre flown level
const DESCENT_SLOPE = .3; // metres of descent toward the goal per metre flown
/** Horizontal offsets (in half-cells) sampled per cell so thin walls between column centres still block it. */
const SAMPLES = [[0, 0], [-.8, -.8], [.8, -.8], [-.8, .8], [.8, .8]] as const;
const MAX_EXPANDED = 800;
const SEARCH_BUDGET = 5; // ms per search; past it the route ends at the closest cell so far and is extended later
const SMOOTH_BUDGET = 3; // ms of line checks for straightening a route
const SMOOTHED = 100; // m of route kept per plan; flyers replan before they run out of it
const HEURISTIC_WEIGHT = 1.8;
const RANGE = 200; // cells from the start in either direction (500 m)
const SIZE = RANGE * 2 + 1;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, z]) => [x, z, Math.hypot(x, z) * CELL] as const);

class Heap {
  private items: number[] = [];
  private scores: number[] = [];
  get size() { return this.items.length; }
  clear() { this.items.length = 0; this.scores.length = 0; }
  push(item: number, score: number) {
    const items = this.items, scores = this.scores;
    let i = items.length;
    items.push(item); scores.push(score);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (scores[parent] <= score) break;
      items[i] = items[parent]; scores[i] = scores[parent]; i = parent;
    }
    items[i] = item; scores[i] = score;
  }
  pop(): number {
    const items = this.items, scores = this.scores;
    const top = items[0], item = items.pop()!, score = scores.pop()!;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= n) break;
        if (child + 1 < n && scores[child + 1] < scores[child]) child++;
        if (scores[child] >= score) break;
        items[i] = items[child]; scores[i] = scores[child]; i = child;
      }
      items[i] = item; scores[i] = score;
    }
    return top;
  }
}

/** Extra clearance for a flyer at `speed` m/s: none at combat speeds, a few metres when really moving. */
export const speedMargin = (speed: number) => THREE.MathUtils.clamp((speed - 40) / 50, 0, 4);

export class Pathfinder {
  private readonly spans = new Spans();
  private readonly origin = new THREE.Vector3();
  // Search state over the grid around the start, reset per search by bumping `generation`.
  private readonly stamp = new Uint32Array(SIZE * SIZE);
  private readonly closedStamp = new Uint32Array(SIZE * SIZE);
  private readonly cost = new Float64Array(SIZE * SIZE);
  private readonly altitude = new Float64Array(SIZE * SIZE);
  private readonly parent = new Int32Array(SIZE * SIZE);
  private readonly columnStamp = new Uint32Array(SIZE * SIZE);
  private readonly columns: Float64Array[] = new Array(SIZE * SIZE);
  private readonly open = new Heap();
  private generation = 0;
  /** Extra clearance in metres for the flyer currently asking, grown with its speed: fast means wide berths. */
  margin = 0;

  constructor(private world: Destruction, private maxExpanded = MAX_EXPANDED, private weight = HEURISTIC_WEIGHT) {}

  /** True if a body can fly straight from `from` to `to` (both body centres). */
  segmentClear(from: THREE.Vector3, to: THREE.Vector3, maxLength = Infinity): boolean {
    const total = from.distanceTo(to);
    const distance = Math.min(maxLength, total);
    if (distance < .01) return true;
    const horizontal = Math.hypot(to.x - from.x, to.z - from.z);
    // Unit sideways vector, for checking the body's width either side of the line.
    const sideX = horizontal > .01 ? -(to.z - from.z) / horizontal * RADIUS : RADIUS, sideZ = horizontal > .01 ? (to.x - from.x) / horizontal * RADIUS : 0;
    for (let along = .5; along < distance + .25; along += along < FINE ? .5 : 1.5) {
      const t = Math.min(along, distance) / total;
      const x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t, z = from.z + (to.z - from.z) * t;
      // The margins fade out near the ends: taking off from or arriving at the ground is fine.
      const fade = Math.min(1, along / 4, (total - along) / 6);
      const low = y - CLEARANCE - (BELOW + this.margin) * fade, high = y + CLEARANCE + this.margin * fade;
      if (this.blockedAt(x, z, low, high)) return false;
      if (along < FINE && (this.blockedAt(x + sideX, z + sideZ, low, high) || this.blockedAt(x - sideX, z - sideZ, low, high))) return false;
    }
    return true;
  }

  private blockedAt(x: number, z: number, low: number, high: number): boolean {
    const column = this.world.spans(x, z, this.spans);
    for (let j = 0; j < column.n; j++) if (column.lo[j] < high && column.hi[j] > low && column.hi[j] > column.lo[j]) return true;
    return false;
  }

  /**
   * Waypoints (body centres) from `from` toward `to`, excluding `from`. If the goal can't be reached within
   * the search budget, the route ends at the explored cell closest to it. Empty when nothing better was found.
   */
  find(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    if (++this.generation === 0xffffffff) { this.generation = 1; this.stamp.fill(0); this.closedStamp.fill(0); this.columnStamp.fill(0); }
    const gen = this.generation;
    this.origin.copy(from);
    const gx = THREE.MathUtils.clamp(Math.round((to.x - from.x) / CELL), -RANGE, RANGE);
    const gz = THREE.MathUtils.clamp(Math.round((to.z - from.z) / CELL), -RANGE, RANGE);
    const heuristic = (x: number, z: number) => Math.hypot(gx - x, gz - z) * CELL;
    const index = (x: number, z: number) => (x + RANGE) * SIZE + (z + RANGE);
    const open = this.open;
    open.clear();
    const start = index(0, 0);
    this.stamp[start] = gen; this.cost[start] = 0; this.parent[start] = -1;
    this.altitude[start] = from.y;
    open.push(start, 0);
    let best = start, bestH = heuristic(0, 0), expanded = 0, reached = false;
    const began = performance.now();
    while (open.size && expanded < this.maxExpanded && ((expanded & 15) !== 0 || performance.now() - began < SEARCH_BUDGET)) {
      const current = open.pop();
      if (this.closedStamp[current] === gen) continue;
      this.closedStamp[current] = gen; expanded++;
      const x = Math.floor(current / SIZE) - RANGE, z = current % SIZE - RANGE;
      const h = heuristic(x, z);
      if (h < bestH) { bestH = h; best = current; }
      if (Math.abs(gx - x) <= 1 && Math.abs(gz - z) <= 1) { best = current; reached = true; break; }
      const g = this.cost[current], y = this.altitude[current];
      for (const [dx, dz, step] of NEIGHBOURS) {
        const nx = x + dx, nz = z + dz;
        if (Math.abs(nx) > RANGE || Math.abs(nz) > RANGE) continue;
        const next = index(nx, nz);
        if (this.closedStamp[next] === gen) continue;
        // Ease toward the goal's height when there's room, otherwise hold, otherwise lift over.
        const eased = y + THREE.MathUtils.clamp(to.y - y, -step * DESCENT_SLOPE, step * DESCENT_SLOPE);
        const ny = this.free(nx, nz, eased) ? eased : this.freeAltitude(nx, nz, y);
        // A climb happens in this cell before moving across, so it needs open air overhead here too.
        if (ny > y && !this.openAbove(x, z, y, ny)) continue;
        const nextCost = g + step + Math.max(0, ny - y) * CLIMB_COST;
        if (this.stamp[next] === gen && nextCost >= this.cost[next]) continue;
        this.stamp[next] = gen; this.cost[next] = nextCost; this.altitude[next] = ny; this.parent[next] = current;
        open.push(next, nextCost + heuristic(nx, nz) * this.weight);
      }
    }
    if (best === start) return [];
    const cells: number[] = [];
    for (let node = best; node !== -1 && node !== start; node = this.parent[node]) cells.push(node);
    cells.reverse();
    const path: THREE.Vector3[] = [];
    let previousX = from.x, previousY = this.altitude[start], previousZ = from.z;
    for (const node of cells) {
      const x = from.x + (Math.floor(node / SIZE) - RANGE) * CELL, z = from.z + (node % SIZE - RANGE) * CELL, y = this.altitude[node];
      // Climb before moving across, so the corner clears the lip instead of clipping it.
      if (y > previousY + .01) path.push(new THREE.Vector3(previousX, y, previousZ));
      path.push(new THREE.Vector3(x, y, z));
      previousX = x; previousY = y; previousZ = z;
    }
    if (reached && this.segmentClear(path[path.length - 1], to)) path.push(to.clone());
    return this.smooth(from, path);
  }

  /**
   * Drop every waypoint that the previous kept point can see past. Only the near part of the route is kept:
   * flyers replan long before reaching the rest, so straightening it would be wasted line checks.
   */
  private smooth(from: THREE.Vector3, path: THREE.Vector3[]): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const began = performance.now();
    let anchor = from, i = 0;
    while (i < path.length && anchor.distanceTo(from) < SMOOTHED) {
      let far = i;
      // Look a bounded distance ahead, and only while there's time, so smoothing stays cheap on long routes.
      if (performance.now() - began < SMOOTH_BUDGET) for (let j = Math.min(path.length - 1, i + 12); j > i; j--) if (this.segmentClear(anchor, path[j])) { far = j; break; }
      out.push(path[far]);
      anchor = path[far]; i = far + 1;
    }
    return out;
  }

  private free(x: number, z: number, y: number): boolean {
    const column = this.column(x, z);
    const low = y - CLEARANCE - BELOW - this.margin, high = y + CLEARANCE + this.margin;
    for (let i = 0; i < column.length; i += 2) if (column[i] < high && column[i + 1] > low) return false;
    return true;
  }

  /** Nothing solid between a body at `y` and one at `top` in this cell. */
  private openAbove(x: number, z: number, y: number, top: number): boolean {
    const column = this.column(x, z);
    const high = top + CLEARANCE + this.margin;
    for (let i = 0; i < column.length; i += 2) if (column[i] < high && column[i + 1] > y) return false;
    return true;
  }

  /** Lowest altitude at or above `y` where the body fits in this cell. */
  private freeAltitude(x: number, z: number, y: number): number {
    const column = this.column(x, z);
    for (let moved = true; moved;) {
      moved = false;
      for (let i = 0; i < column.length; i += 2) {
        if (column[i] < y + CLEARANCE + this.margin && column[i + 1] > y - CLEARANCE - BELOW - this.margin) { y = column[i + 1] + CLEARANCE + BELOW + this.margin + MARGIN; moved = true; }
      }
    }
    return y;
  }

  /** Solid intervals of every sample in a cell's footprint, flattened [lo, hi, lo, hi, ...]. */
  private column(x: number, z: number): Float64Array {
    const id = (x + RANGE) * SIZE + (z + RANGE);
    if (this.columnStamp[id] === this.generation) return this.columns[id];
    const intervals: number[] = [];
    const cx = this.origin.x + x * CELL, cz = this.origin.z + z * CELL;
    for (const [sx, sz] of SAMPLES) {
      const spans = this.world.spans(cx + sx * CELL / 2, cz + sz * CELL / 2, this.spans);
      for (let i = 0; i < spans.n; i++) if (spans.hi[i] > spans.lo[i]) intervals.push(spans.lo[i], spans.hi[i]);
    }
    this.columnStamp[id] = this.generation;
    return this.columns[id] = Float64Array.from(intervals);
  }
}

/**
 * Per-flyer route keeper: flies straight when the way is open, otherwise follows an A* route that is
 * replanned as the goal moves and skipped ahead whenever a later waypoint comes into view.
 */
export class PathFollower {
  /** Where to steer this frame (body centre). */
  readonly waypoint = new THREE.Vector3();
  /** "direct": nothing in the way; "path": routing around something; "stuck": no route found yet. */
  mode: "direct" | "path" | "stuck" = "direct";
  /** Seconds in a row without any usable route. */
  stuckTime = 0;
  private route: THREE.Vector3[] = [];
  private index = 0;
  /** The route stops short of the goal (search budget or plan length); replan on nearing its end. */
  private partial = false;
  /** Start of the leg being flown: the route keeps flyers on the checked line from here to the waypoint. */
  private readonly legStart = new THREE.Vector3();
  private readonly plannedGoal = new THREE.Vector3();
  private readonly lastFrom = new THREE.Vector3();
  private replan = 0;
  private nextSearch = 0;
  private sight = 0;
  private directClear = true;
  private readonly bend = new THREE.Vector3();
  private readonly along = new THREE.Vector3();

  constructor(private finder: Pathfinder, private stagger = Math.random() * .1, private minSearchInterval = 0) {}

  reset() { this.route = []; this.partial = false; this.index = 0; this.mode = "direct"; this.stuckTime = 0; this.directClear = true; this.sight = this.nextSearch = 0; this.lastFrom.set(NaN, NaN, NaN); }

  private plan(from: THREE.Vector3, goal: THREE.Vector3) {
    this.route = this.finder.find(from, goal);
    this.index = 0;
    this.partial = this.route.length > 0 && this.route[this.route.length - 1].distanceToSquared(goal) > 1;
    this.legStart.copy(from);
    this.plannedGoal.copy(goal);
    this.replan = .6 + this.stagger;
    this.nextSearch = this.minSearchInterval;
  }

  /**
   * `lookAhead` limits how far ahead the straight line is checked; obstacles beyond it are dealt with on approach.
   * `margin` is extra clearance to keep from everything, for flyers too fast to thread tight gaps.
   */
  update(dt: number, from: THREE.Vector3, goal: THREE.Vector3, lookAhead = 150, margin = 0): THREE.Vector3 {
    this.sight -= dt; this.replan -= dt; this.nextSearch -= dt;
    this.finder.margin = margin;
    // Line-of-sight probes are the expensive part, so they run on a tick rather than every frame:
    // ~10 Hz, or every ~8 m travelled for a fast flyer.
    const speed = dt > 0 && Number.isFinite(this.lastFrom.x) ? this.lastFrom.distanceTo(from) / dt : 0;
    this.lastFrom.copy(from);
    const look = this.sight <= 0;
    if (look) {
      this.sight = Math.min(.1 + this.stagger * .5, 8 / Math.max(1, speed));
      this.directClear = this.finder.segmentClear(from, goal, lookAhead);
    }
    if (this.directClear) {
      this.route = []; this.partial = false; this.mode = "direct"; this.stuckTime = 0;
      return this.waypoint.copy(goal);
    }
    const drift = this.plannedGoal.distanceTo(goal);
    const runningOut = this.partial && this.route.length > 0 && from.distanceTo(this.route[this.route.length - 1]) < 30;
    if (this.nextSearch <= 0) {
      if (!this.route.length || this.replan <= 0 || runningOut || drift > 6 + from.distanceTo(goal) * .15) this.plan(from, goal);
      // Momentum can carry a fast flyer off a leg, so check the next waypoint when sight refreshes.
      else if (look && !this.finder.segmentClear(from, this.route[this.index], lookAhead)) this.plan(from, goal);
    }
    if (!this.route.length) {
      this.mode = "stuck"; this.stuckTime += dt;
      return this.waypoint.copy(goal);
    }
    // Reached the current waypoint, or the next one is already visible: move on.
    while (this.index < this.route.length - 1) {
      if (from.distanceTo(this.route[this.index]) < 2) this.legStart.copy(this.route[this.index]);
      else if (look && this.finder.segmentClear(from, this.route[this.index + 1], lookAhead)) this.legStart.copy(from);
      else break;
      this.index++;
    }
    this.mode = "path"; this.stuckTime = 0;
    return this.waypoint.copy(this.route[this.index]);
  }

  /**
   * Velocity for flying the route around a detour corner: fast on the straights, slowed before the corner
   * by as much as the bend needs, so a flyer with `acceleration` to spare can actually make the turn.
   * It steers for a point a little ahead on the leg rather than at the corner, pulling a drifting flyer
   * back onto the line that was checked clear.
   */
  detourVelocity(from: THREE.Vector3, maxSpeed: number, acceleration: number, out: THREE.Vector3): THREE.Vector3 {
    const corner = this.route[this.index], next = this.route[this.index + 1];
    out.subVectors(corner, from);
    const leg = out.length();
    let cornerSpeed = maxSpeed;
    if (next) {
      this.bend.subVectors(next, corner).normalize();
      // 0 for flying straight on, 1 for doubling back; even a 90° turn calls for slowing right down.
      const bend = (1 - this.bend.dot(out) / Math.max(leg, .001)) / 2;
      cornerSpeed = THREE.MathUtils.lerp(maxSpeed, Math.min(maxSpeed, Math.sqrt(acceleration * 6)), Math.min(1, bend * 4));
    }
    const speed = Math.min(maxSpeed, Math.sqrt(cornerSpeed * cornerSpeed + 2 * acceleration * .6 * leg));
    // Carrot on the leg: the closest point on it, then a speed-scaled distance further along, capped at the corner.
    this.along.subVectors(corner, this.legStart);
    const length = this.along.length();
    if (length > .01) {
      this.along.multiplyScalar(1 / length);
      const projected = THREE.MathUtils.clamp(this.bend.subVectors(from, this.legStart).dot(this.along), 0, length);
      const carrot = Math.min(length, projected + Math.max(4, speed * .12));
      out.copy(this.legStart).addScaledVector(this.along, carrot).sub(from);
    }
    return out.setLength(speed);
  }

  /** True when the current waypoint is a detour corner rather than the goal itself. */
  get detouring() { return this.mode === "path" && (this.partial || this.index < this.route.length - 1); }
}
