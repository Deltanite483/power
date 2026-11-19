import * as THREE from 'three';
import type { Destruction } from './destruction';

const CELL = 2;          // m between grid nodes
const RADIUS = 30;       // grid half-extent in cells (60 m either way)
const BUDGET = 900;      // node expansions per plan; best partial route is used past this
const PER_FRAME = 24;    // bounded work per frame; finish before a moving target invalidates the route
const STEP_UP = .65, STEP_DOWN = 4; // per metre of body scale: climb a kerb, hop off a ledge, never scale a wall
const NEIGHBOURS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]] as const;

/** Local A* over walkable surfaces. Never turns a wall into a flying waypoint.
 *  Kept cheap: a straight walk is tried first, floors are cached per plan, and the search is budgeted. */
export class GroundPath {
  private path: THREE.Vector3[] = [];
  private age = 0;
  private checkAge = 0;
  private direct = false;
  private search: Generator<void, THREE.Vector3[]> | null = null;
  private goal = new THREE.Vector3(Infinity, 0, 0);
  private readonly localGoal = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  constructor(private world: Destruction, private size = 1) {}

  /** Heading straight for the goal, with no detour to slow down for. */
  get straight() { return this.direct; }
  get hasRoute() { return this.direct || this.path.length > 0; }

  reset() {
    this.path=[];this.search=null;this.direct=false;this.age=0;this.checkAge=0;
    this.goal.set(Infinity,0,0);
  }

  /** The solid body-height obstruction within mace reach along the desired route. */
  obstacle(from:THREE.Vector3,goal:THREE.Vector3):THREE.Vector3|null {
    const direction=goal.clone().sub(from).setY(0), length=direction.length();
    if(length<.1)return null;
    direction.divideScalar(length);
    for(let distance=.5;distance<=Math.min(4.5,length);distance+=.25){
      for(const offset of [0,-.45*this.size,.45*this.size]){
        const x=from.x+direction.x*distance-direction.z*offset,z=from.z+direction.z*distance+direction.x*offset;
        const column=this.world.spans(x,z);
        for(const height of [.3,.9,1.5,1.9]){
          const y=from.y+height*this.size;
          if(column.solid(y))return new THREE.Vector3(x,y,z);
        }
      }
    }
    return null;
  }

  /** Floor a body can stand on near `previous`, or null for walls, drops and low ceilings.
   *  (px, pz) is the unit sideways direction: the body's width is checked across the direction of travel. */
  private floor(x: number, z: number, previous: number, px: number, pz: number): number | null {
    const column = this.world.spans(x, z);
    const up = STEP_UP * this.size, down = STEP_DOWN * this.size;
    const floor = column.floor(previous + up);
    if (!Number.isFinite(floor) || floor - previous > up || previous - floor > down) return null;
    if(column.solid(floor+.2) || column.solid(floor+this.size) || column.solid(floor+1.95*this.size))return null;
    const r = .5 * this.size;
    for(const offset of [-r,r]) {
      const body=this.world.spans(x+px*offset,z+pz*offset);
      if(body.solid(floor+.2) || body.solid(floor+this.size) || body.solid(floor+1.95*this.size))return null;
    }
    return floor;
  }

  /** Walkable straight line, sampled every `spacing` metres. */
  private segment(from: THREE.Vector3, to: THREE.Vector3, spacing = .5): boolean {
    const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
    if (length < 1e-3) return true;
    const count = Math.max(1, Math.ceil(length / spacing));
    let y = from.y;
    for (let i = 1; i <= count; i++) {
      const t = i / count;
      // Same rule as the planner: step checks along the way, body width where it stops.
      const x = from.x + dx * t, z = from.z + dz * t;
      const floor = this.floor(x, z, y, -dz / length, dx / length);
      if (floor === null) return false;
      y = floor;
    }
    return true;
  }

  update(dt: number, from: THREE.Vector3, goal: THREE.Vector3): THREE.Vector3 {
    this.age -= dt; this.checkAge -= dt;
    // Plan toward a local point so distant fighters moving at flight speed
    // don't restart a ground search before it can find a way around a wall.
    const reach = Math.hypot(goal.x - from.x, goal.z - from.z);
    this.localGoal.copy(goal);
    if (reach > RADIUS * CELL) this.localGoal.lerpVectors(from, goal, RADIUS * CELL / reach);
    // A search in progress finishes unless the goal itself moves away.
    const moved = Math.hypot(this.goal.x - this.localGoal.x, this.goal.z - this.localGoal.z);
    // Small target movements must not restart an unfinished search every few frames.
    if ((!this.search && (this.age <= 0 || moved > 4)) || (this.search && moved > 40)) {
      this.goal.copy(this.localGoal);
      // Open ground is the common case: one coarse line check instead of a search.
      // Far goals only need the next 40 m clear; it's rechecked as he goes.
      const probe = reach <= 40 ? goal : this.scratch.lerpVectors(from, goal, 40 / reach);
      this.direct = this.segment(from, probe);
      if (this.direct) { this.path = [goal.clone()]; this.search = null; this.age = .35; }
      else { this.search = this.plan(from.clone(), this.goal.clone()); this.age = 1.2; }
      this.checkAge = .15;
    }
    // The search runs a few nodes per frame; the old route is followed meanwhile.
    if (this.search) {
      const step = this.search.next();
      if (step.done) { this.path = step.value; this.search = null; this.age = 1.2; }
    }
    if (this.direct) {
      if(this.checkAge<=0){
        this.checkAge=.15;
        const reach=Math.hypot(goal.x-from.x,goal.z-from.z);
        const probe=reach<=40?goal:this.scratch.lerpVectors(from,goal,40/reach);
        if(!this.segment(from,probe)){this.reset();return from;}
      }
      return this.path[0].copy(goal);
    }
    while (this.path.length && Math.hypot(this.path[0].x - from.x, this.path[0].z - from.z) < .9) this.path.shift();
    let next = this.path[0];
    if (!next) return from; // No walkable route (yet): wait rather than push through a wall.
    if (this.checkAge <= 0) {
      this.checkAge = .15;
      // Terrain can be smashed or raised under the route; replan when the next leg closes.
      if (!this.segment(from, next)) { this.path = []; if (!this.search) this.age = 0; return from; }
      // Aim along the clear corridor instead of steering at every 2 m grid corner at sprint speed.
      for(let i=Math.min(5,this.path.length-1);i>0;i--) {
        if(this.segment(from,this.path[i])){this.path.splice(0,i);next=this.path[0];break;}
      }
    }
    return next;
  }

  private *plan(from: THREE.Vector3, goal: THREE.Vector3): Generator<void, THREE.Vector3[]> {
    const size = RADIUS * 2 + 1, cells = size * size;
    const index = (x: number, z: number) => (x + RADIUS) * size + (z + RADIUS);
    const g = new Float32Array(cells).fill(Infinity);
    const y = new Float32Array(cells).fill(NaN);
    const parent = new Int32Array(cells).fill(-1);
    const closed = new Uint8Array(cells);
    const heap: number[] = [], score = new Float32Array(cells);
    const push = (i: number) => {
      heap.push(i);
      for (let c = heap.length - 1; c > 0;) {
        const p = (c - 1) >> 1;
        if (score[heap[p]] <= score[heap[c]]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]]; c = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let c = 0; ;) {
          const l = c * 2 + 1, r = l + 1;
          let m = c;
          if (l < heap.length && score[heap[l]] < score[heap[m]]) m = l;
          if (r < heap.length && score[heap[r]] < score[heap[m]]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]]; c = m;
        }
      }
      return top;
    };
    const h = (x: number, z: number) => Math.hypot(goal.x - (from.x + x * CELL), goal.z - (from.z + z * CELL));
    const start = index(0, 0);
    g[start] = 0; y[start] = from.y; score[start] = h(0, 0) * 1.15; push(start);
    let best = start, bestH = Infinity;
    const a = this.scratch, b = new THREE.Vector3();
    for (let expanded = 0; heap.length && expanded < BUDGET; expanded++) {
      if (expanded % PER_FRAME === PER_FRAME - 1) yield;
      const current = pop();
      if (closed[current]) continue;
      closed[current] = 1;
      const cx = Math.floor(current / size) - RADIUS, cz = current % size - RADIUS;
      const ch = h(cx, cz);
      if (current!==start && ch < bestH) { bestH = ch; best = current; }
      if (ch < CELL) break;
      a.set(from.x + cx * CELL, y[current], from.z + cz * CELL);
      for (const [dx, dz] of NEIGHBOURS) {
        const x = cx + dx, z = cz + dz;
        if (Math.abs(x) > RADIUS || Math.abs(z) > RADIUS) continue;
        const n = index(x, z);
        if (closed[n]) continue;
        const cost = g[current] + (dx && dz ? CELL * Math.SQRT2 : CELL);
        if (cost >= g[n]) continue;
        // The midpoint check stops cutting corners through walls between nodes.
        const length = Math.hypot(dx, dz), px = -dz / length, pz = dx / length;
        let floor:number|null=a.y;
        for(let step=1;step<=4;step++) {
          floor=this.floor(a.x+dx*CELL*step/4,a.z+dz*CELL*step/4,floor,px,pz);
          if(floor===null)break;
        }
        if(floor===null)continue;
        g[n] = cost; y[n] = floor; parent[n] = current;
        score[n] = cost + h(x, z) * 1.15;
        push(n);
      }
    }
    const result: THREE.Vector3[] = [];
    for (let n = best; parent[n] >= 0; n = parent[n]) {
      b.set(from.x + (Math.floor(n / size) - RADIUS) * CELL, y[n], from.z + (n % size - RADIUS) * CELL);
      result.push(b.clone());
    }
    return result.reverse();
  }
}
