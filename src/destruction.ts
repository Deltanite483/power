import { PressureFronts } from "./air-pressure";
// Terrain destruction: craters, tunnels and punches carved into the voxel terrain, flying debris, dust and shockwaves.
// Damage volumes (terrain/edits.ts) are shared with mesh workers; healing shrinks them away.
import * as THREE from "three";
import { Explosions, Dust, Shockwaves } from "./explosion-effects";
import type { CloudBodyVisitor } from "./atmosphere";
import { CARVE, Edits, FILL, HEAL_DELAY, HEAL_TIME, Spans, columnSpans, type EditShape } from "./terrain/edits";
import { MATERIALS, Mat, VOXEL, slopeAt, surfaceMaterial, type Heightfield, type MaterialProps } from "./terrain/heightfield";
import type { TerrainLOD } from "./terrain/lod";
import type { Ground, Impact } from "./player";
import { MASS } from "./player";
import { buildChunk } from "./terrain/mesher";

const CRATER_MIN = 12; // m/s: slower hits don't break the ground
const CRATER_K = 0.06; // R = K · cbrt(explosive impact energy / strength)
const MAX_R = 60;
const BORE_R = 1.6; // tunnel radius around a 1.83 m body
const BORE_STEP = 0.55; // metres between tunnel slugs
const PUNCH_R = 1.8;
const REACH = 9;
const WIND_SPEED = 340; // m/s the smash's air front travels down the punch line

/** Shape of a charged smash: a cone from the fist, `length` long, radius r0 + t·spread at distance t. */
export function smashCone(charge: number, power: number) {
  const k = Math.cbrt(power);
  return {
    length: Math.min(1500, (12 + 500 * charge * charge) * k),
    r0: (1.5 + 2 * charge) * k,
    spread: 0.04 + 0.08 * charge,
  };
}

/** Shallow scars, long gouges and deeper pits, each with a broken, asymmetric edge. */
function fractureShape(): EditShape {
  const angle = Math.random() * Math.PI * 2;
  const style = Math.floor(Math.random() * 3);
  return {
    sx: 0.85 + Math.random() * 0.15,
    sy: style === 0 ? 0.38 + Math.random() * 0.2 : 0.65 + Math.random() * 0.35,
    sz: style === 1 ? 0.4 + Math.random() * 0.2 : 0.72 + Math.random() * 0.25,
    cos: Math.cos(angle), sin: Math.sin(angle),
    roughness: 0.16 + Math.random() * 0.22,
    phase: Math.random() * Math.PI * 2,
    profile: 0.35 + Math.random() * 0.65,
  };
}

interface HealRegion {
  x0: number; z0: number; x1: number; z1: number;
  first: number;
  latest: number;
}

export class Destruction implements Ground {
  readonly edits = new Edits();
  /** Power multiplier for everything you break ([ and ] keys). */
  power = 1;
  /** Heal clock: only runs while healing is on, so pausing healing freezes damage where it is. */
  clock = 0;
  readonly debris: Debris;
  readonly dust: Dust;
  private rings: Shockwaves;
  private readonly pressure = new PressureFronts();
  private explosions = new Explosions();
  private synced = 0;
  private healRegions = new Map<string, HealRegion>();
  private nextGroup = 1;
  private boreGroup = 0;
  private lastBore = -10;
  private lastBorePos = new THREE.Vector3(1e9, 0, 0);
  private tearGroup = 0;
  private lastTear = -10;
  private lastTearPos = new THREE.Vector3(1e9, 0, 0);
  private time = 0;
  private healTick = 0;
  private compactTick = 0;
  onTerrainChange: (x0: number, z0: number, x1: number, z1: number) => void = () => {};
  onCollisionChange: typeof this.onTerrainChange = () => {};
  private notifyTerrainChange(x0: number, z0: number, x1: number, z1: number) {
    this.onCollisionChange(x0,z0,x1,z1);
    this.onTerrainChange(x0,z0,x1,z1);
  }
  private sp = new Spans();
  private tmp = new THREE.Vector3();
  /** Hooks for sound and camera. */
  onBreak: (energy: number, material: MaterialProps, kind: "crater" | "bore" | "punch" | "tear", position: THREE.Vector3) => void = () => {};
  onShockwave: (origin: THREE.Vector3, normal: THREE.Vector3, previous: number, radius: number, strength: number, hit: Set<object | number>) => void = () => {};
  /** 16 m collision tiles match the destructible voxel mesh, including overhangs. */
  collisionMesh(x: number, z: number) { return buildChunk(this.hf, this.edits, x * 16, z * 16, .5, this.clock, true); }

  constructor(private hf: Heightfield, private lod: TerrainLOD, scene: THREE.Scene) {
    this.debris = new Debris(this);
    this.dust = new Dust();
    this.rings = new Shockwaves();
    this.rings.onSweep = (origin, normal, previous, radius, strength, hit) => {
      this.debris.shockwave(origin, normal, previous, radius, strength, hit);
      this.onShockwave(origin, normal, previous, radius, strength, hit);
    };
    scene.add(this.debris.mesh, this.dust.points, this.rings.group, this.explosions.group, this.pressure.group);
  }

  get healing(): boolean {
    return this.edits.healing;
  }

  get performanceStats() {
    return {
      terrainEdits: this.edits.count,
      healRegions: this.healRegions.size,
      healing: this.healing,
      destructionPower: this.power,
      shockwaves: this.rings.activeCount,
      dustQuality: this.dust.quality,
      ...this.debris.performanceStats,
    };
  }

  set healing(on: boolean) {
    this.edits.healing = on;
    this.lod.sendEdits("reset", this.edits.raw(), on);
    this.synced = this.edits.count;
    for (const g of this.healRegions.values()) {
      this.lod.invalidate(g.x0, g.z0, g.x1, g.z1);
      this.notifyTerrainChange(g.x0-1,g.z0-1,g.x1+1,g.z1+1);
    }
  }

  // --- Ground (for the player and debris)
  spans(x: number, z: number, out = this.sp): Spans {
    const cx = (Math.floor(x / VOXEL) + 0.5) * VOXEL, cz = (Math.floor(z / VOXEL) + 0.5) * VOXEL;
    return columnSpans(this.hf, this.edits, this.edits.at(cx, cz), cx, cz, VOXEL, this.clock, out, true);
  }

  /** Rendered source geometry, including soft foliage, remains punchable. */
  visualSpans(x:number,z:number,out=this.sp):Spans {
    const cx=(Math.floor(x/VOXEL)+.5)*VOXEL,cz=(Math.floor(z/VOXEL)+.5)*VOXEL;
    return columnSpans(this.hf,this.edits,this.edits.at(cx,cz),cx,cz,VOXEL,this.clock,out);
  }

  /** Material at a point: the surface, or whatever stratum you've dug down to. */
  materialAt(x: number, y: number, z: number): MaterialProps {
    const sp = this.spans(x, z);
    const surface = surfaceMaterial(sp.base, slopeAt(this.hf, x, z, VOXEL), sp.water, x, z);
    return MATERIALS[this.hf.materialAt(x, y, z, sp.base, surface)];
  }

  bore(x: number, y: number, z: number, vel: THREE.Vector3): number {
    const m = this.materialAt(x, y + 0.8, z);
    const speed = vel.length();
    const fresh = this.time - this.lastBore > 0.3;
    if (fresh) {
      // smashing in from open air: a crater at the entry point and a blast of debris back out
      this.boreGroup = this.nextGroup++;
      const n = new THREE.Vector3().copy(vel).normalize().negate();
      this.crater(new THREE.Vector3(x, y, z), n, speed * 0.8, m, true);
    }
    this.lastBore = this.time;
    if (this.lastBorePos.distanceTo(this.tmp.set(x, y + 0.8, z)) >= BORE_STEP || fresh) {
      this.lastBorePos.set(x, y + 0.8, z);
      // slightly uneven slugs so the bore looks smashed, not drilled
      this.addEdit(CARVE, x + (Math.random() - 0.5) * 0.3, y + 0.8 + (Math.random() - 0.5) * 0.3, z + (Math.random() - 0.5) * 0.3, BORE_R * (0.9 + Math.random() * 0.25), this.boreGroup);
      // rubble sprays out behind you
      const back = this.tmp.copy(vel).normalize().multiplyScalar(-1);
      this.debris.spray(x, y + 0.8, z, back, Math.min(60, 10 + speed * 0.15), 2, BORE_R * 0.5, m);
      if (Math.random() < 0.35) this.dust.burst(x, y + 0.8, z, back, 3, 1.5, 4, m.debris, 2.5);
      this.onBreak(Math.min(1.2, speed / 300), m, "bore", new THREE.Vector3(x,y,z));
    }
    return m.strength;
  }

  /** Overlapping, shallow, ragged cuts open to the sky, rather than enclosed tunnel slugs. */
  tear(x: number, y: number, z: number, vel: THREE.Vector3): number {
    const m = this.materialAt(x, y - 0.1, z);
    if (m === MATERIALS[Mat.Water]) return 0;
    const speed = vel.length();
    const radius = Math.min(6, (1.3 + speed * 0.015) * Math.cbrt(this.power / Math.max(0.25, m.strength)));
    const fresh = this.time - this.lastTear > 0.25;
    this.lastTear = this.time;
    if (!fresh && this.lastTearPos.distanceToSquared(this.tmp.set(x, y, z)) < (radius * 0.35) ** 2) return m.strength;
    if (fresh) this.tearGroup = this.nextGroup++;
    this.lastTearPos.set(x, y, z);
    const angle = Math.atan2(vel.z, vel.x);
    const shape = fractureShape();
    shape.sx = 1; shape.sz = 0.4 + Math.random() * 0.15;
    shape.sy = 0.8; shape.profile = 0.12;
    shape.cos = Math.cos(angle); shape.sin = Math.sin(angle);
    this.addEdit(CARVE, x, y + radius * 0.4, z, radius, this.tearGroup, shape);
    this.lod.heat.add(x, y, z, radius * 1.6, Math.min(1, 0.45 + speed / 200));
    const spray = new THREE.Vector3(-vel.x, speed * 0.8, -vel.z).normalize();
    this.debris.spray(x, y + 0.1, z, spray, Math.min(85, 10 + speed * 0.35), 12 + radius * 4, 0.2 + radius * 0.1, m, 0.8);
    this.dust.burst(x, y + 0.3, z, spray, 8 + radius * 3, 3 + radius, 3 + radius * 1.5, m.debris, 2.5);
    this.onBreak(Math.min(1.5, speed / 160), m, "tear", new THREE.Vector3(x,y,z));
    return m.strength;
  }

  // --- making damage
  private addEdit(kind: number, x: number, y: number, z: number, r: number, group: number, shape?: EditShape, redraw = this.pendingBoxes) {
    this.edits.add(kind, x, y, z, r, this.clock, group, shape);
    // A long tunnel or trench must never invalidate everything inside its full bounding rectangle.
    const key = `${Math.floor(x / 64)}:${Math.floor(z / 64)}`;
    let g = this.healRegions.get(key);
    if (!g) this.healRegions.set(key, (g = {
      x0: x - r, z0: z - r, x1: x + r, z1: z + r, first: this.clock, latest: this.clock,
    }));
    g.x0 = Math.min(g.x0, x - r); g.z0 = Math.min(g.z0, z - r);
    g.x1 = Math.max(g.x1, x + r); g.z1 = Math.max(g.z1, z + r);
    g.latest = this.clock;
    const x0 = x-r-1, z0 = z-r-1, x1 = x+r+1, z1 = z+r+1;
    const pending = redraw.get(key);
    if (pending) {
      pending[0] = Math.min(pending[0], x0); pending[1] = Math.min(pending[1], z0);
      pending[2] = Math.max(pending[2], x1); pending[3] = Math.max(pending[3], z1);
    } else redraw.set(key, [x0,z0,x1,z1]);
    this.onCollisionChange(x0,z0,x1,z1);
  }
  private pendingBoxes = new Map<string, [number, number, number, number]>();
  private readonly streamingBoxes = new Map<string, [number, number, number, number]>();
  private streamingTime = 0;

  private redrawBoxes(boxes: typeof this.pendingBoxes, streaming = false) {
    for (const box of boxes.values()) {
      this.lod.invalidate(...box, streaming);
      this.onTerrainChange(...box);
    }
    boxes.clear();
  }

  /** An impact of `speed` m/s on material m at point p with surface normal n. */
  /** A heavy sprinting footfall: a kick of dust and grit behind the foot, no carving. */
  stomp(p: THREE.Vector3, vel: THREE.Vector3) {
    const m = this.materialAt(p.x, p.y - 0.1, p.z);
    if (m === MATERIALS[Mat.Water]) { this.splash(p, vel.length() * .4); return; }
    const speed = vel.length();
    const spray = this.tmp.set(-vel.x * .3, speed * .5, -vel.z * .3).normalize();
    this.dust.burst(p.x, p.y + .2, p.z, spray, 3 + speed * .1, 1.5, 2.5, m.debris, 1.6);
    this.debris.spray(p.x, p.y + .1, p.z, spray, 6 + speed * .2, 5, .12, m, .5);
  }

  /** Heat vision: a narrow molten bore along one burst, no spoil thrown out. Returns the group to reuse. */
  burn(p: THREE.Vector3, radius: number, group = -1): number {
    if (group < 0) group = this.nextGroup++;
    this.addEdit(CARVE, p.x, p.y, p.z, radius, group);
    this.lod.heat.add(p.x, p.y, p.z, radius * 2.5, 1);
    return group;
  }

  /** A walking-sized breach through a close obstruction. Preserve the floor; throw out no blocking spoil. */
  breach(feet: THREE.Vector3, direction: THREE.Vector3, size = 1): boolean {
    const forward=direction.clone().setY(0);
    if(forward.lengthSq()<.01)return false;
    forward.normalize();
    const halfHeight=1.15*size, halfWidth=.85*size, halfDepth=1.1*size;
    const radius=Math.max(halfHeight,halfWidth,halfDepth), group=this.nextGroup++;
    const shape:EditShape={sx:halfDepth/radius,sy:halfHeight/radius,sz:halfWidth/radius,cos:forward.x,sin:forward.z,roughness:0,phase:0,profile:.5};
    let first:THREE.Vector3|null=null, firstMat=MATERIALS[Mat.Concrete];
    for(let distance=.8;distance<=5;distance+=.8){
      const x=feet.x+forward.x*distance,z=feet.z+forward.z*distance;
      let hit:THREE.Vector3|null=null;
      for(const offset of [0,-halfWidth*.6,halfWidth*.6]){
        const px=x-forward.z*offset,pz=z+forward.x*offset;
        for(const height of [.3,.9,1.5,2.05]){
          const y=feet.y+height*size;
          if(this.spans(px,pz).solid(y)){hit=new THREE.Vector3(px,y,pz);break;}
        }
        if(hit)break;
      }
      if(!hit)continue;
      const material=this.materialAt(hit.x,hit.y,hit.z);
      if(material===MATERIALS[Mat.Bedrock] || material===MATERIALS[Mat.Water])continue;
      this.addEdit(CARVE,x,feet.y+halfHeight+.05,z,radius,group,shape);
      this.debris.spray(hit.x,hit.y,hit.z,forward,12,16,.15,material,.5);
      this.dust.burst(hit.x,hit.y,hit.z,forward,22,2,3,material.debris,2);
      if(!first){first=hit;firstMat=material;}
    }
    if(first)this.onBreak(.8,firstMat,"punch",first);
    return first!==null;
  }

  /**
   * One of Sukuna's cuts opening the ground: a slot `reach` metres long and deep, a blade's width across,
   * lying along `direction`. Carves only where there is something within the blade's height to cut.
   */
  slashCut(point: THREE.Vector3, direction: THREE.Vector3, reach: number, width = .7,
    { streaming = false, scatter = true } = {}): boolean {
    const length = Math.hypot(direction.x, direction.z);
    const cos = length > .05 ? direction.x / length : 1, sin = length > .05 ? direction.z / length : 0;
    const spans = this.spans(point.x, point.z);
    const ground = spans.floor(point.y + reach);
    if (!spans.solid(point.y) && (!Number.isFinite(ground) || ground < point.y - reach)) return false;
    const at = spans.solid(point.y) ? point.y : ground;
    const material = this.materialAt(point.x, at - .1, point.z);
    if (material === MATERIALS[Mat.Bedrock] || material === MATERIALS[Mat.Water]) return false;
    this.addEdit(CARVE, point.x, at, point.z, reach, this.nextGroup++, {
      sx: 1, sy: 1, sz: Math.min(1, width / reach), cos, sin, roughness: 0, phase: 0, profile: .5,
    }, streaming ? this.streamingBoxes : this.pendingBoxes);
    if (scatter) {
      const up = this.tmp.set(0, 1, 0);
      this.dust.burst(point.x, at + .5, point.z, up, 14, reach * .5, reach * .35, material.debris, 1.6);
      this.debris.spray(point.x, at + .2, point.z, up, 9, 10, .16, material, .6);
    }
    return true;
  }

  /** Successive cuts widen the cleared area, with no spoil left inside the domain. */
  shrineCut(origin: THREE.Vector3, radius: number) {
    const ground = this.spans(origin.x, origin.z).floor(origin.y + 2);
    if (!Number.isFinite(ground)) return;
    this.addEdit(CARVE, origin.x, origin.y + 8, origin.z, radius, this.nextGroup++, {
      sx: 1, sy: Math.min(1, 18 / radius), sz: 1, cos: 1, sin: 0, roughness: 0, phase: 0, profile: .5,
    });
    this.dust.burst(origin.x, Math.max(ground, origin.y - 2), origin.z, new THREE.Vector3(0, 1, 0),
      100, radius, 20, [167, 94, 99], 2, 1.2);
  }

  /** Nuclear-style energy discharge, sharing the bounded blast/dust pools and existing terrain limits. */
  energyBlast(origin:THREE.Vector3,radius:number,exempt:readonly object[]=[]){
    const normal=new THREE.Vector3(0,1,0),ground=this.spans(origin.x,origin.z).floor(origin.y+2);
    const at=origin.clone();at.y=ground;
    this.crater(at,normal,240,this.materialAt(at.x,at.y-.1,at.z));
    this.explosions.spawn(origin,normal,radius*.36,true);
    this.pressure.impact(origin,normal,radius,true);
    this.dust.burst(origin.x,origin.y+5,origin.z,normal,180,44,48,[102,78,66],4,2);
    this.dust.burst(at.x,at.y+1,at.z,normal,210,110,40,[171,140,115],4,1);
    const hit=new Set<object|number>();
    this.rings.spawn(origin.x,origin.y,origin.z,radius/5.6,normal,0,exempt,hit,true);
    this.rings.spawn(origin.x,origin.y+5,origin.z,radius/6.4,new THREE.Vector3(.1,1,.15),.14,exempt,hit,true,1.8);
    this.rings.spawn(origin.x,origin.y+12,origin.z,radius/7.5,normal,.3,exempt,hit,true,2.8);
  }

  doomsdayImpact(origin:THREE.Vector3,normal:THREE.Vector3,radius:number,exempt:readonly object[]){
    this.rings.spawn(origin.x,origin.y,origin.z,radius/5.6,normal,0,exempt,undefined,true);
    this.pressure.impact(origin,normal,radius);
    this.dust.burst(origin.x,origin.y,origin.z,normal,45,radius*.8,radius*.32,[204,145,110],1,1);
  }

  crater(p: THREE.Vector3, n: THREE.Vector3, speed: number, m: MaterialProps, entry = false) {
    if (speed < CRATER_MIN || m === MATERIALS[Mat.Water]) {
      if (m === MATERIALS[Mat.Water] && speed > 8) this.splash(p, speed);
      return;
    }
    const energy = 0.5 * MASS * speed * speed * this.power * 3;
    const R = Math.min(MAX_R, CRATER_K * Math.cbrt(energy / Math.max(0.05, m.strength)));
    if (R < 0.35) return;
    const group = entry ? this.boreGroup : this.nextGroup++;
    const up = Math.abs(n.y) > 0.7;
    const shape = fractureShape();
    // Offset outward without losing the shallow variants beneath the surface.
    const cx = p.x + n.x * R * 0.2, cy = p.y + n.y * R * shape.sy * 0.25, cz = p.z + n.z * R * 0.2;
    this.addEdit(CARVE, cx, cy, cz, R, group, shape);
    this.lod.heat.add(p.x, p.y, p.z, R * 1.6, Math.min(1, 0.55 + speed / 200));
    // Broken spoil follows the irregular ellipse, with gaps instead of a circular bead necklace.
    if (up && R > 1.2) {
      const k = Math.min(16, 6 + Math.round(R));
      for (let i = 0; i < k; i++) {
        if (Math.random() < 0.25) continue;
        const a = (i / k) * Math.PI * 2 + Math.random() * 0.3;
        const rr = R * (0.1 + Math.random() * 0.14);
        const edge = 1 - shape.roughness * (0.5 + 0.3 * Math.sin(3 * a + shape.phase) + 0.2 * Math.sin(7 * a - shape.phase));
        const d = R * edge * (1.01 + Math.random() * 0.08);
        const u = Math.cos(a) * d * shape.sx, v = Math.sin(a) * d * shape.sz;
        const x = cx + u * shape.cos - v * shape.sin, z = cz + u * shape.sin + v * shape.cos;
        const y = this.spans(x, z).top;
        this.addEdit(FILL, x, y - rr * 0.6, z, rr, group, fractureShape());
      }
    }
    // debris, dust, shockwave
    const count = Math.min(300, Math.round(12 + R * R * 3));
    this.debris.spray(p.x, p.y + 0.2, p.z, n, Math.min(130, 10 + R * 6), count, Math.min(2, 0.15 + R * 0.08), m, up ? 0.65 : 0.4);
    this.dust.explosion(p,n,R,m.debris);
    if (R > 1.2) this.explosions.spawn(p, n, R);
    if (R > 2) this.rings.spawn(p.x, p.y + 0.3, p.z, R * 1.8);
    this.onBreak(Math.min(2.2, R / 8), m, "crater", p);
  }

  private splash(p: THREE.Vector3, speed: number) {
    const R = Math.min(30, 0.05 * Math.cbrt(0.5 * MASS * speed * speed * this.power));
    this.dust.burst(p.x, p.y, p.z, new THREE.Vector3(0, 1, 0), Math.min(220, 30 + R * 20), 1 + R * 0.4, 3 + R, [225, 235, 242], 2.5 + R * 0.1);
    if (R > 2) this.rings.spawn(p.x, p.y + 0.1, p.z, R * 1.5);
  }

  /** Punch along a view ray. big = a charged smash. Returns true if something was hit. */
  punch(eye: THREE.Vector3, dir: THREE.Vector3, big: boolean): boolean {
    for (let t = 0.3; t < REACH; t += 0.06) {
      const x = eye.x + dir.x * t, y = eye.y + dir.y * t, z = eye.z + dir.z * t;
      const sp = this.visualSpans(x, z);
      if (!sp.solid(y) && !(sp.water && y < sp.top)) continue;
      const m = this.materialAt(x, y, z);
      const n = this.tmp.copy(dir).negate();
      if (m === MATERIALS[Mat.Water]) { this.splash(new THREE.Vector3(x, sp.top, z), big ? 60 : 30); return true; }
      const R = Math.min(MAX_R, (big ? 2.6 : 1) * PUNCH_R * Math.cbrt(this.power / Math.max(0.05, m.strength)));
      const group = this.nextGroup++;
      this.addEdit(CARVE, x + dir.x * R * 0.4, y + dir.y * R * 0.4, z + dir.z * R * 0.4, R, group);
      this.lod.heat.add(x, y, z, R * 1.6, big ? 1 : 0.65);
      this.debris.spray(x, y, z, n, 8 + R * 6, Math.min(200, Math.round(15 + R * R * 6)), Math.min(0.9, 0.1 + R * 0.05), m, 0.45);
      if(big)this.dust.explosion(new THREE.Vector3(x,y,z),n,R,m.debris);
      else this.dust.burst(x, y, z, n, 20 + R * 10, 1 + R * 0.4, 2 + R * 1.2, m.debris, 2 + R * 0.3);
      if (big) this.rings.spawn(x, y, z, R * 1.2);
      if (big) this.explosions.spawn(new THREE.Vector3(x, y, z), n, R);
      this.onBreak(Math.min(2, (big ? 0.6 : 0.3) + R / 10), m, "punch", new THREE.Vector3(x,y,z));
      return true;
    }
    return false;
  }

  /** Take-off of a charged jump at feet p: kicked-up dust, a ground ring, and a crater once the push is hard enough. */
  launch(p: THREE.Vector3, speed: number, charge: number, m: MaterialProps) {
    if (speed < 5 || m === MATERIALS[Mat.Water]) return;
    const up = new THREE.Vector3(0, 1, 0);
    const R = Math.min(MAX_R, 0.6 + speed * 0.08 * Math.cbrt(this.power));
    this.dust.burst(p.x, p.y + 0.2, p.z, up, Math.min(450, 20 + R * 30), 2 + R * 0.8, 3 + R * 1.5, m.debris, 1.5 + R * 0.25);
    this.rings.spawn(p.x, p.y + 0.15, p.z, R * (0.6 + charge));
    if (speed * 0.8 >= CRATER_MIN) this.crater(p.clone(), up, speed * 0.8, m);
    else this.onBreak(0.1 + charge * 0.3, m, "punch", p.clone());
  }

  /** One For All style smash along the view: a widening cone that levels whatever it crosses, then the air front. */
  smash(eye: THREE.Vector3, dir: THREE.Vector3, charge: number, exempt?: object | readonly object[]): boolean {
    const cone = smashCone(charge, this.power);
    const group = this.nextGroup++;
    const lift = new THREE.Vector3().copy(dir).setY(dir.y + 0.35).normalize();
    let first: THREE.Vector3 | null = null, firstMat = MATERIALS[Mat.Rock], edits = 0;
    // Start near the fist so a close wall is hit too; overlapping bites carry the smash forward.
    for (let t = 0.5; t < cone.length && edits < 48; ) {
      const r = Math.min(MAX_R, cone.r0 + t * cone.spread);
      const x = eye.x + dir.x * t, y = eye.y + dir.y * t, z = eye.z + dir.z * t;
      const sp = this.visualSpans(x, z);
      // Test actual solid spans, not just the column top: buildings can have hollow interiors.
      let hitY: number | null = null;
      for (let i = 0; i < sp.n; i++) {
        if (sp.hi[i] <= y - r || sp.lo[i] >= y + r) continue;
        const candidate = THREE.MathUtils.clamp(y, sp.lo[i] + 0.01, sp.hi[i] - 0.01);
        if (hitY === null || Math.abs(candidate - y) < Math.abs(hitY - y)) hitY = candidate;
      }
      if (hitY !== null && !(sp.water && sp.top > y)) {
        const m = this.materialAt(x, hitY, z);
        const R = Math.min(MAX_R, r * Math.cbrt(1 / Math.max(0.3, m.strength)));
        this.addEdit(CARVE, x, y, z, R, group);
        this.lod.heat.add(x, hitY, z, R * 1.3, 0.5 + charge * 0.5);
        this.debris.spray(x, hitY, z, lift, 30 + R * 3 + charge * 60, Math.min(90, Math.round(10 + R * 4)), Math.min(2, 0.2 + R * 0.06), m, 0.5);
        if (!first) {
          first = new THREE.Vector3(x, hitY, z); firstMat = m;
          this.dust.explosion(first,lift,R,m.debris);
          this.explosions.spawn(first, this.tmp.copy(dir).negate(), R);
        }else this.dust.burst(x, hitY, z, dir, Math.min(100, 12 + R * 6), 3 + R * 0.6, 4 + R * 1.6, m.debris, 3 + R * 0.25);
        edits++;
      }
      t += Math.max(1.5, r * 0.8);
    }
    this.tmp.copy(eye).addScaledVector(dir,2);
    this.pressure.strike(this.tmp,dir,cone.length,cone.r0,Math.min(110,cone.r0+cone.length*cone.spread),WIND_SPEED);
    // Close to the ground, the leading edge picks up loose dust even between solid hits.
    for (const distance of [3,8,16,28]) {
      if(distance>cone.length)break;
      const x=eye.x+dir.x*distance, y=eye.y+dir.y*distance, z=eye.z+dir.z*distance;
      const span=this.visualSpans(x,z);
      const floor=span.floor(y);
      if(!Number.isFinite(floor) || span.water || y-floor>3+distance*cone.spread)continue;
      const surface=this.materialAt(x,floor-.05,z);
      this.dust.burst(x,floor+.12,z,lift,12+charge*20,9+charge*20,2+charge*4,surface.debris,1.4);
    }
    // the air front: rings facing down the punch line, each arriving as the wind reaches it
    const waveHits = new Set<object | number>();
    for (let i = 1; i <= 10; i++) {
      const t = (cone.length * 1.2 * i) / 10;
      const at = this.tmp.copy(eye).addScaledVector(dir, t);
      this.rings.spawn(at.x, at.y, at.z, Math.min(90, cone.r0 + t * cone.spread) * 0.9, dir, t / WIND_SPEED, exempt, waveHits);
    }
    this.debris.gust(eye, dir, cone, 60 + charge * 140);
    if (first) this.onBreak(Math.min(2.2, 0.6 + charge * 1.6), firstMat, "crater", first);
    return first !== null;
  }

  onImpact(i: Impact) {
    this.crater(i.point, i.normal, i.speed, i.material);
  }

  update(dt: number, camera: THREE.Camera, frameDt=dt) {
    this.time += dt;
    this.lod.heat.update(dt, camera.position);
    if (this.edits.healing) this.clock += dt;
    this.lod.clock = this.clock;

    // sync new edits to the workers, then rebuild what they touched
    if (this.edits.count > this.synced) {
      this.lod.sendEdits("append", this.edits.raw(this.synced), this.edits.healing);
      this.synced = this.edits.count;
    }
    this.redrawBoxes(this.pendingBoxes);
    // Fast sweeps touch the same mesh for several consecutive frames. Physics sees
    // every cut immediately, while workers rebuild the visible terrain in batches.
    if (this.streamingBoxes.size) {
      this.streamingTime += frameDt;
      if (this.streamingTime >= .09) {
        this.redrawBoxes(this.streamingBoxes, true);
        this.streamingTime = 0;
      }
    }

    // healing: re-mesh damage as it closes up
    if (this.edits.healing) {
      this.healTick -= dt;
      if (this.healTick <= 0) {
        this.healTick = 0.5;
        for (const [key, g] of this.healRegions) {
          const age = this.clock - g.first;
          if (age < HEAL_DELAY) continue;
          this.lod.invalidate(g.x0 - 1, g.z0 - 1, g.x1 + 1, g.z1 + 1);
          this.notifyTerrainChange(g.x0 - 1, g.z0 - 1, g.x1 + 1, g.z1 + 1);
          if (this.clock - g.latest > HEAL_DELAY + HEAL_TIME + 1) this.healRegions.delete(key);
        }
      }
      this.compactTick -= dt;
      if (this.compactTick <= 0) {
        this.compactTick = 5;
        if (this.edits.compact(this.clock)) {
          this.lod.sendEdits("reset", this.edits.raw(), true);
          this.synced = this.edits.count;
        }
      }
    }

    this.dust.update(this.time, camera,frameDt);
    this.debris.update(dt, this.dust.quality);
    this.rings.update(dt);
    this.pressure.update(dt);
    this.explosions.update(dt,camera);
  }

}

/** Flying voxel chunks: instanced cubes under gravity that bounce off the (damaged) terrain and settle. */
class Debris {
  readonly mesh: THREE.InstancedMesh;
  private readonly cap = 900;
  private static readonly spawnBudget = 160;
  private spawnRemaining = Debris.spawnBudget;
  private p: Float32Array;
  private v: Float32Array;
  private rot: Float32Array;
  private w: Float32Array;
  private size: Float32Array;
  private life: Float32Array;
  private supportCheck: Float32Array;
  private state: Uint8Array; // 0 dead, 1 flying, 2 resting
  private head = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private pos = new THREE.Vector3();
  private scl = new THREE.Vector3();
  private col = new THREE.Color();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private sp = new Spans();
  private readonly cloudPosition = new THREE.Vector3();
  private readonly cloudVelocity = new THREE.Vector3();
  /** Include every live chunk, including settled rubble that clouds flow past. */
  forEachCloudBody(visit: CloudBodyVisitor) {
    for (let i = 0; i < this.cap; i++) {
      if (!this.state[i]) continue;
      this.cloudPosition.fromArray(this.p, i * 3);
      if (this.state[i] === 1) this.cloudVelocity.fromArray(this.v, i * 3);
      else this.cloudVelocity.set(0, 0, 0);
      visit(i, this.cloudPosition, this.cloudVelocity, this.size[i] * 0.866);
    }
  }
  /** Landings this frame, for the clatter sound. */
  landed = 0;
  private landingIds: number[] = [];
  get performanceStats() {
    let activeRubble = 0, flyingRubble = 0;
    for (const state of this.state) {
      if (state) activeRubble++;
      if (state === 1) flyingRubble++;
    }
    return { activeRubble, flyingRubble };
  }
  nearbyLanding(listener: THREE.Vector3, range: number): { point: THREE.Vector3; count: number } | null {
    let nearest = range * range, best = -1, count = 0;
    for (const i of this.landingIds) {
      const o = i * 3, distance = (this.p[o]-listener.x)**2 + (this.p[o+1]-listener.y)**2 + (this.p[o+2]-listener.z)**2;
      if (distance < range*range) count++;
      if (distance < nearest) { nearest=distance; best=i; }
    }
    return best < 0 ? null : {point:new THREE.Vector3(this.p[best*3],this.p[best*3+1],this.p[best*3+2]),count};
  }

  constructor(private world: Destruction) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial(), this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.p = new Float32Array(this.cap * 3);
    this.v = new Float32Array(this.cap * 3);
    this.rot = new Float32Array(this.cap * 3);
    this.w = new Float32Array(this.cap * 3);
    this.size = new Float32Array(this.cap);
    this.life = new Float32Array(this.cap);
    this.supportCheck = new Float32Array(this.cap);
    this.state = new Uint8Array(this.cap);
    for (let i = 0; i < this.cap; i++) {
      this.mesh.setMatrixAt(i, this.zero);
      this.mesh.setColorAt(i, this.col.setRGB(1, 1, 1));
    }
  }

  /** A smash's wind: chunks inside the (slightly wider) cone are hurled down it, strongest near the fist. */
  gust(o: THREE.Vector3, d: THREE.Vector3, cone: { length: number; r0: number; spread: number }, speed: number) {
    const reach = cone.length * 1.3;
    for (let i = 0; i < this.cap; i++) {
      if (!this.state[i]) continue;
      const k = i * 3;
      const rx = this.p[k] - o.x, ry = this.p[k + 1] - o.y, rz = this.p[k + 2] - o.z;
      const t = rx * d.x + ry * d.y + rz * d.z;
      if (t < 0 || t > reach) continue;
      const r = cone.r0 + t * cone.spread * 1.5;
      const perp = Math.sqrt(Math.max(0, rx * rx + ry * ry + rz * rz - t * t));
      if (perp > r) continue;
      const f = speed * (1 - t / reach) * (1 - 0.5 * perp / r) * (0.7 + Math.random() * 0.6);
      this.v[k] += d.x * f; this.v[k + 1] += d.y * f + f * 0.15; this.v[k + 2] += d.z * f;
      this.state[i] = 1;
      this.life[i] = Math.max(this.life[i], 4);
    }
  }

  /** Give debris an outward impulse as a visible ring passes it. */
  shockwave(o: THREE.Vector3, normal: THREE.Vector3, previous: number, radius: number, strength: number, hit: Set<object | number>) {
    const halfDepth = Math.max(3, strength * 0.7);
    for (let i = 0; i < this.cap; i++) {
      if (!this.state[i] || hit.has(i)) continue;
      const k = i * 3, x = this.p[k] - o.x, y = this.p[k + 1] - o.y, z = this.p[k + 2] - o.z;
      const axial = x * normal.x + y * normal.y + z * normal.z;
      if (Math.abs(axial) > halfDepth) continue;
      const dx = x - axial * normal.x, dy = y - axial * normal.y, dz = z - axial * normal.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > radius || (previous > 0 && distance < previous) || distance < .01) continue;
      hit.add(i);
      const speed = Math.min(18, 3 + strength * .5) / (1 + distance / Math.max(5, strength * 1.2)) ** 2;
      this.v[k] += dx / distance * speed;
      this.v[k + 1] += dy / distance * speed + speed * .2;
      this.v[k + 2] += dz / distance * speed;
      this.state[i] = 1;
      this.life[i] = Math.max(this.life[i], 4);
    }
  }

  /** Throw `count` chunks from (x,y,z) around direction n. lift 0..1 biases the cone upward. */
  spray(x: number, y: number, z: number, n: THREE.Vector3, speed: number, count: number, size: number, m: MaterialProps, lift = 0.5) {
    count = Math.min(this.spawnRemaining, 80, Math.max(1, Math.round(count * .4)));
    if (count === 0) return;
    this.spawnRemaining -= count;
    // rubble blasted out deep underground was never in the sun: match the tunnel's darkness
    const depth = this.world.spans(x, z, this.sp).base - y;
    const dark = depth < 4 ? 1 : Math.max(0.2, 1 - (depth - 4) / 24);
    const [r, g, b] = m.debris.map((c) => c * dark);
    for (let k = 0; k < count; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.cap;
      // a cone around the normal, flattened toward the ground for craters
      let dx = n.x + (Math.random() - 0.5) * 1.6, dy = n.y * lift + Math.random() * lift + (Math.random() - 0.5) * 0.4, dz = n.z + (Math.random() - 0.5) * 1.6;
      const l = Math.hypot(dx, dy, dz) || 1;
      const sp = speed * (0.25 + Math.random() * 0.75);
      dx /= l; dy /= l; dz /= l;
      this.p[i * 3] = x + dx * 0.5; this.p[i * 3 + 1] = y + Math.abs(dy) * 0.5; this.p[i * 3 + 2] = z + dz * 0.5;
      this.v[i * 3] = dx * sp; this.v[i * 3 + 1] = dy * sp; this.v[i * 3 + 2] = dz * sp;
      for (let a = 0; a < 3; a++) { this.rot[i * 3 + a] = Math.random() * 6.3; this.w[i * 3 + a] = (Math.random() - 0.5) * 18; }
      // sizes snap to whole voxels
      this.size[i] = Math.max(VOXEL, Math.round((size * (0.5 + Math.random())) / VOXEL) * VOXEL);
      this.life[i] = 4 + Math.random() * 5;
      this.state[i] = 1;
      const j = 0.85 + Math.random() * 0.3;
      this.mesh.setColorAt(i, this.col.setRGB((r * j) / 255, (g * j) / 255, (b * j) / 255, THREE.SRGBColorSpace));
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(dt: number, detail = 1) {
    this.spawnRemaining = Math.round(Debris.spawnBudget * detail);
    this.landed = 0;
    this.landingIds.length = 0;
    let matrixChanged = false;
    for (let i = 0; i < this.cap; i++) {
      const st = this.state[i];
      if (st === 0) continue;
      const o = i * 3, s = this.size[i];
      let shrink = 1;
      this.life[i] -= dt;
      if (st === 1) {
        this.v[o + 1] -= 9.81 * dt;
        const drag = Math.max(0, 1 - dt * 0.15);
        this.v[o] *= drag; this.v[o + 1] *= drag; this.v[o + 2] *= drag;
        const px = this.p[o] + this.v[o] * dt, py = this.p[o + 1] + this.v[o + 1] * dt, pz = this.p[o + 2] + this.v[o + 2] * dt;
        const floor = this.world.spans(px, pz, this.sp).floor(py);
        if (py - s * 0.5 < floor) {
          if (floor - py < Math.max(1, s * 2)) {
            // landed: bounce a little, scrub speed, settle
            this.p[o] = px; this.p[o + 2] = pz; this.p[o + 1] = floor + s * 0.5;
            const bounce=Math.min(.3,this.world.materialAt(px,floor-.05,pz).bounce);
            this.v[o + 1] = -this.v[o + 1] * bounce;
            this.v[o] *= 0.55; this.v[o + 2] *= 0.55;
            for (let a = 0; a < 3; a++) this.w[o + a] *= 0.5;
            if (Math.hypot(this.v[o], this.v[o + 1], this.v[o + 2]) < 1.5) {
              this.state[i] = 2;
              this.supportCheck[i] = .08 + (i % 20) * .013;
              this.landed++;
              this.landingIds.push(i);
            }
          } else {
            // hit a wall: knock back
            const bounce=Math.min(.3,this.world.materialAt(px,py,pz).bounce);
            this.v[o] *= -bounce; this.v[o + 2] *= -bounce;
          }
        } else {
          this.p[o] = px; this.p[o + 1] = py; this.p[o + 2] = pz;
        }
        for (let a = 0; a < 3; a++) this.rot[o + a] += this.w[o + a] * dt;
      } else {
        // a resting chunk falls again if the ground under it is blown away (or heals over it)
        this.supportCheck[i] -= dt;
        if (this.supportCheck[i] <= 0) {
          this.supportCheck[i] = .33;
          const floor = this.world.spans(this.p[o], this.p[o + 2], this.sp).floor(this.p[o + 1]);
          if (floor < this.p[o + 1] - s) this.state[i] = 1;
          else if (floor > this.p[o + 1] + s) this.life[i] = Math.min(this.life[i], 0.5); // buried by healing
        }
        if (this.life[i] >= .8) continue; // the settled instance's transform is already on the GPU
      }
      matrixChanged = true;
      if (this.life[i] < 0.8) shrink = Math.max(0, this.life[i] / 0.8);
      if (this.life[i] <= 0) {
        this.state[i] = 0;
        this.mesh.setMatrixAt(i, this.zero);
        continue;
      }
      this.e.set(this.rot[o], this.rot[o + 1], this.rot[o + 2]);
      this.q.setFromEuler(this.e);
      this.pos.set(this.p[o], this.p[o + 1], this.p[o + 2]);
      this.scl.setScalar(s * shrink);
      this.mesh.setMatrixAt(i, this.m4.compose(this.pos, this.q, this.scl));
    }
    if (matrixChanged) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

