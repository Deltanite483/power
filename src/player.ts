import {SuperBlock} from "./super-block";
import { attackerMultiplier, bypassesDefenseStat, terrainHit, type HitSource, type DamageHit } from "./combat-events";
import * as THREE from "three";
import { STAGGER_LIMIT, Vitality } from "./vitality";
import { column, slopeAt, surfaceMaterial, MATERIALS, Mat, VOXEL, type Column, type Heightfield, type MaterialProps } from "./terrain/heightfield";
import type { Spans } from "./terrain/edits";

/** The destructible ground as the player sees it. */
export interface Ground {
  /** Solid spans of the finest-voxel column containing (x,z). */
  spans(x: number, z: number): Spans;
  materialAt(x: number, y: number, z: number): MaterialProps;
  /** Carve a way through for a body flying at (x,y,z) (feet). Returns the strength of what was broken. */
  bore(x: number, y: number, z: number, vel: THREE.Vector3): number;
  /** Rip an open surface trench along ground contact; returns material resistance. */
  tear(x: number, y: number, z: number, vel: THREE.Vector3): number;
}

/** Shallow hits skip; direct hits dig in. Rebound stays below 30% of normal speed. */
function rebound(normalSpeed: number, speed: number, maximum = 0.3): number {
  const incidence = Math.min(1, Math.abs(normalSpeed) / Math.max(0.01, speed));
  return maximum * (0.1 + 0.9 * Math.sqrt(1 - incidence * incidence));
}
const TEAR_SPEED = 12;

// --- body (6 ft man). Gait and stepping follow Weisscap's walker, rescaled to 1.83 m.
export const BODY_HEIGHT = 1.83;
const EYE_STAND = BODY_HEIGHT * 0.936; // eyes sit at ~93.6 % of stature
const EYE_CROUCH = BODY_HEIGHT * 0.63;
export const MASS = 68; // kg
const RADIUS = 0.3;

const WALK = 1.4; // m/s, ordinary walking pace
const RUN = 5.5; // Shift
const CROUCH = 0.9;
const ACCEL = 10; // m/s² towards target speed, if the ground's friction allows it
const STEP_WALK = 0.41 * BODY_HEIGHT, STEP_RUN = 0.75 * BODY_HEIGHT;
const BOB_WALK = 0.022, BOB_RUN = 0.05, SWAY_WALK = 0.016, SWAY_RUN = 0.022;
const STEP_UP = 0.45; // kerb / stair, no effort
const STEP_DOWN = 0.6; // drops that still count as walking
const CLIMB_UP = 1.1; // hauls himself onto waist-high ledges, slowly

// --- physics
const GRAVITY = 9.81;
// Drag area (Cd × frontal area, m²) depends on pose, as for skydivers:
// spread belly-down ≈ 0.5 (terminal ~50 m/s), head-first dive ≈ 0.13 (terminal ~90 m/s, like speed skydivers)
const CDA_SPREAD = 0.5;
const CDA_DIVE = 0.13;
const CDA_AIR = 0.3; // standing / neutral pose
const CDA_WATER = 0.35;
const WATER_DEPTH = 2; // beds sit this far below the water surface
const BUOYANCY = 1.1; // fully submerged, buoyancy is 1.1× weight: you float with your head out
const SWIM = 1.3;
const BOUNCE_MIN = 4; // below this impact speed (m/s) you just land
const LAUNCH_CONTROL = RUN * 1.4; // above this ground speed you've lost your footing and slide

// --- flight
export const FLY_MAX = 400;
/** Scroll steps one level per mouse notch. In flight: top speed (m/s). */
export const FLY_LEVELS = [5, 10, 20, 35, 50, 75, 100, 150, 200, 250, 300, 350, 400];
/** On foot: a tap of Space hops JUMP_MIN; a full charge leaps JUMP_MAX (m). */
export const JUMP_MIN = 1, JUMP_MAX = 1800;
const FLY_ACCEL = 35; // m/s²: build speed and turn with finite thrust
const FLY_BRAKE = 45; // m/s²: slow down when movement keys are released
const CHARGE_TIME = 4.5; // seconds of holding Space to charge a jump fully
const CHARGE_TAP = 0.04; // each Shift tap while charging adds this much charge
const CHARGE_SQUAT = 0.45; // m the eye sinks at full charge
const JUMP_V_MAX = 3000; // m/s: charged jumps may go hypersonic
const BOOST = 1.2; // Shift adds a view-directed impulse worth 120% of current speed
const BOOST_TIME = 0.5; // seconds between boosts
export const SOUND_SPEED = 343; // m/s, sea-level reference for the boost limit
export const BOOST_MACH_LIMIT = 2.5;
const SWERVE_RATE = 1.35; // rad/s at low speeds
const SWERVE_ACCEL = 140; // m/s² lateral authority: high-speed turns still need room
const TURN_UP = new THREE.Vector3(0, 1, 0);
const WHEEL_STEP = 100; // wheel delta per level: one mouse notch, or a short trackpad swipe
const FLY_PRESETS = [1, 3, 5, 7, 9, 12]; // keys 1-6 → FLY_LEVELS indices

const airDensity = (y: number) => 1.225 * Math.exp(-y / 8500);
/** Speed of sound (m/s): ~340 at sea level, falling with temperature to ~295 above 11 km. */
export const soundSpeed = (y: number) => Math.max(295, 340 - 0.004 * y);
/** Transonic drag rise for a blunt body: Cd roughly doubles through Mach 1, then eases off. */
function machDrag(m: number): number {
  if (m < 0.8) return 1;
  if (m < 1.1) return 1 + 1.3 * ((m - 0.8) / 0.3) ** 2;
  return Math.max(1.6, 2.3 - (m - 1.1) * 0.5);
}

export interface Impact {
  speed: number; // m/s into the surface
  material: MaterialProps;
  point: THREE.Vector3; // where (feet position)
  normal: THREE.Vector3; // surface normal at the hit
  flying: boolean;
}

export class Player {
  /** Max health 200: the player is one of the power users. */
  readonly vitals = Object.assign(new Vitality(200), { regenRate: 1.2 }); // twice the base regeneration
  onDefeated: () => void = () => {};
  onCombatHit: (hit: DamageHit) => void = () => {};
  onInjured: (strength: number) => void = () => {};
  readonly pos = new THREE.Vector3(); // feet
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  roll = 0;
  flying = false;
  onGround = false;
  crouched = false;
  inWater = false;
  underwater = false;
  flyLevel = 6;
  /** Flight top speed under normal thrust (m/s); boosts can exceed it. */
  get flySpeed(): number { return FLY_LEVELS[this.flyLevel]; }
  /** 0..1 while Space is held on foot; released, the jump fires with this charge. */
  jumpCharge = 0;
  charging = false;
  /** Height the current charge would reach, rising exponentially from JUMP_MIN to JUMP_MAX. */
  get chargedHeight(): number {
    return JUMP_MIN * Math.pow(JUMP_MAX / JUMP_MIN, this.jumpCharge);
  }
  material: MaterialProps = MATERIALS[Mat.Farm];
  /** 0 = spread out (air brake), 1 = head-first dive. Airborne: hold W to dive, S to spread. */
  streamline = 0.5;

  /** Sound / camera hooks. */
  onImpact: (i: Impact) => void = () => {};
  onStep: (m: MaterialProps, speed: number) => void = () => {};
  onLaunch: (power: number) => void = () => {};
  onPound: () => void = () => {};
  /** A jump left the ground: blast strength (as an impact speed, m/s), charge 0..1, where and on what. */
  onJump: (speed: number, charge: number, point: THREE.Vector3, material: MaterialProps) => void = () => {};
  /** Charge rose: Shift tap or a crossed tenth while holding Space. */
  onCharge: (charge: number) => void = () => {};
  /** A scroll / preset changed a level: which setting, its level index and level count. */
  onLevel: (kind: "fly", level: number, count: number) => void = () => {};

  private keys = new Set<string>();
  private col: Column = { top: 0, water: false };
  private wheel = 0;
  private eye = EYE_STAND;
  private viewY = 0;
  /** World-space eye height before camera bob and impact effects. */
  get eyeLevel() { return this.viewY + this.eye; }
  private bob = 0;
  private climb = 0;
  private land = 0;
  private impactThisFrame = 0;
  private impactMat: MaterialProps = this.material;
  private impactPoint = new THREE.Vector3();
  private impactNormal = new THREE.Vector3(0, 1, 0);
  /** Destructible ground; without it the terrain is just the heightfield. */
  ground: Ground | null = null;
  carryingObject: () => boolean = () => false;
  /** > 0 while smashing through terrain. */
  boring = 0;
  private time = 0;
  private lastGround = -1;
  private lastJump = -1;
  /** Rising from a jump: held head-first (dive drag) until the apex, unless S spreads you out. */
  private leaping = false;
  /** C in the air: driving head-first into the ground; cleared on landing. */
  pounding = false;
  private dashT = 0; // seconds of boost cooldown left
  private readonly flightDelta = new THREE.Vector3();
  private readonly contactVelocity = new THREE.Vector3();
  private readonly turnAxis = new THREE.Vector3();
  /** 0..1: how ready the next boost is (1 = ready). */
  get boostReady(): number { return 1 - this.dashT / BOOST_TIME; }
  held = false;
  private readonly grabberViewTarget = new THREE.Vector3();
  private hasGrabberViewTarget = false;
  combatCharging = false;
  combatAttacking = false;
  combatAttackCharge = 0;
  combatGuard = 0;
  combatWhiff = 0;
  get momentumKeyHeld(): boolean { return this.keys.has("KeyQ"); }
  get shiftHeld(): boolean { return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"); }

  constructor(private hf: Heightfield, private dom: HTMLElement) {
    addEventListener("keydown", (e) => {
      if (document.pointerLockElement !== this.dom) return;
      if (e.code === "Space" || (this.flying && e.code.startsWith("Arrow"))) e.preventDefault();
      if (e.repeat || this.vitals.defeated || this.vitals.frozen || this.held) return;
      this.keys.add(e.code);
      if (e.code === "KeyE") this.setFlying(!this.flying);
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        if (!this.combatCharging && this.flying) this.boost();
        else if (!this.combatCharging && this.charging) this.addCharge(CHARGE_TAP);
      }
      if (e.code === "Space" && !this.blocking && !this.flying && !this.inWater) { this.charging = true; this.jumpCharge = 0; }
      if (e.code === "KeyC" && !this.flying) {
        if (this.onGround || this.inWater) this.crouched = !this.crouched;
        else if (!this.blocking) this.groundPound();
      }
      const d = /^Digit([1-6])$/.exec(e.code);
      if (d && this.flying) this.setFlyLevel(FLY_PRESETS[+d[1] - 1]);
    });
    addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (e.code === "Space" && this.charging) this.release();
    });
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== this.dom) { this.keys.clear(); this.charging = false; this.jumpCharge = 0; }
    });
    addEventListener("blur", () => { this.keys.clear(); this.charging = false; this.jumpCharge = 0; });
    addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== this.dom || this.held || this.vitals.frozen) return;
      this.yaw -= e.movementX * 0.0021;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * 0.0021));
    });
    addEventListener("wheel", (e) => {
      // Scroll only sets flight speed; on foot, jump height comes from charging Space.
      if (this.carryingObject() || !this.flying || this.vitals.frozen) return;
      // scroll up = more. Accumulate so a trackpad swipe steps levels instead of jittering.
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (Math.sign(delta) !== Math.sign(this.wheel)) this.wheel = 0;
      this.wheel += delta;
      while (Math.abs(this.wheel) >= WHEEL_STEP * 0.5) {
        const up = this.wheel < 0 ? 1 : -1;
        this.wheel += up * WHEEL_STEP;
        this.setFlyLevel(this.flyLevel + up);
      }
    }, { passive: true });
  }

  /** Adjust the speed ceiling; existing momentum changes only through acceleration/braking. */
  setFlyLevel(level: number) {
    const next = Math.max(0, Math.min(FLY_LEVELS.length - 1, level));
    this.flyLevel = next;
    this.onLevel("fly", next, FLY_LEVELS.length);
  }

  setFlying(f: boolean) {
    if (f && (this.held || this.vitals.defeated || this.vitals.orientation < 35)) return;
    if (f === this.flying) return;
    this.flying = f;
    if (f) {
      this.crouched = false;
      if (this.onGround) { this.vel.y = Math.max(this.vel.y, 6); this.onLaunch(0.2); }
    }
    // switching off keeps vel: you carry on ballistically with whatever momentum you had, still in flying pose
    else if (this.speed > 20) this.streamline = 1;
  }

  setHeld(held: boolean) {
    if (held && this.vitals.frozen) return;
    this.held = held;
    this.hasGrabberViewTarget = false;
    if (!held) return;
    this.setFlying(false);
    this.keys.clear();
    this.vel.set(0,0,0);
    this.charging = this.pounding = this.crouched = false;
    this.jumpCharge = 0;
  }

  moveHeld(feet: THREE.Vector3, grabberEyes: THREE.Vector3) {
    if (!this.held || this.vitals.frozen) return;
    this.grabberViewTarget.copy(grabberEyes);
    this.hasGrabberViewTarget = true;
    this.pos.copy(feet);
    const floor=this.floorAt(feet.x,feet.z,feet.y+.5);
    this.pos.y=Math.max(feet.y,floor+.05);
    this.viewY=this.pos.y;
    this.onGround=false;
    this.vel.set(0,0,0);
    this.updateWater();
  }

  get launched() { return !this.onGround && !this.flying && this.vitals.orientation < 75; }

  revive(persistent=false, fromMenu=false):boolean {
    const max=this.vitals.maxHealth;
    if(!this.vitals.revive(fromMenu ? max : persistent ? max * .75 : max * .4,!persistent && !fromMenu))return false;
    this.superBlock.reset();
    this.held=false;
    this.keys.clear();this.setFlying(false);this.vel.set(0,0,0);
    this.charging=false;this.jumpCharge=0;this.pounding=false;
    this.combatCharging=false;this.combatAttacking=false;this.combatAttackCharge=0;this.combatGuard=0;
    this.pos.y=Math.max(this.pos.y,this.floorAt(this.pos.x,this.pos.z,this.pos.y+2));
    this.viewY=this.pos.y;
    return true;
  }

  readonly superBlock=new SuperBlock();

  receiveHit(strength: number, damageMultiplier=1, source: HitSource=terrainHit) {
    if(this.superBlock.active)return;
    const before=this.vitals.health;
    if (!this.vitals.hit(strength,damageMultiplier*attackerMultiplier(source),bypassesDefenseStat(source))) return;
    // only a hit past the stagger limit, or being badly dazed, knocks you out of flight
    if (strength > STAGGER_LIMIT || this.vitals.orientation < 35) this.setFlying(false);
    this.onInjured(strength);
    this.onCombatHit({source,damage:before-this.vitals.health,outcome:this.vitals.eliminated?"out":this.vitals.defeated?"down":"hit"});
    if (this.vitals.defeated) { this.keys.clear();this.charging=false;this.jumpCharge=0;this.pounding=false; this.onDefeated(); }
  }

  private get blocking() { return this.combatCharging && !this.combatAttacking; }

  cancelForBlock() {
    this.charging = false;
    this.jumpCharge = 0;
    this.pounding = false;
    this.leaping = false;
    this.combatWhiff = 0;
  }

  stopForStasis() {
    this.keys.clear();
    this.cancelForBlock();
    this.combatCharging = this.combatAttacking = false;
    this.combatAttackCharge = this.combatGuard = 0;
    this.vel.set(0, 0, 0);
  }

  /** Emergency flight halt. Snapshot first: the released pressure follows motion, never camera aim. */
  cancelMomentum(): THREE.Vector3 | null {
    if(this.vitals.defeated || this.vitals.frozen || this.held)return null;
    const momentum=this.vel.clone();
    // An emergency arrest can engage flight while dazed, without a takeoff impulse.
    this.flying=true;this.crouched=false;
    this.vel.set(0,0,0);this.pounding=false;this.leaping=false;
    this.charging=false;this.jumpCharge=0;this.streamline=0;
    return momentum;
  }

  /** Push the body: J in newton-seconds. */
  applyImpulse(j: THREE.Vector3) {
    if (this.vitals.frozen) return;
    this.vel.addScaledVector(j, 1 / MASS);
  }

  spawn(x: number, z: number, yaw: number) {
    this.superBlock.reset();
    this.pos.set(x, this.floorAt(x, z, 1e6), z);
    this.vel.set(0, 0, 0);
    this.viewY = this.pos.y;
    this.yaw = yaw;
  }

  private sample(x: number, z: number): Column {
    const cx = (Math.floor(x / VOXEL) + 0.5) * VOXEL, cz = (Math.floor(z / VOXEL) + 0.5) * VOXEL;
    return column(this.hf, cx, cz, VOXEL, this.col);
  }

  /** Visible surface below you (water surface over water). */
  groundAt(x: number, z: number): number {
    const c = this.sample(x, z);
    return c.water ? c.top : this.floorAt(x, z, this.pos.y);
  }

  /** What you'd stand on at height y: the top of the solid at or below y (river / lake bed under water). */
  floorAt(x: number, z: number, y: number): number {
    if (!this.ground) {
      const c = this.sample(x, z);
      return c.water ? c.top - WATER_DEPTH : c.top;
    }
    const sp = this.ground.spans(x, z);
    const floor = sp.floor(y + 0.05);
    return sp.water && floor <= sp.base + 0.05 ? sp.base - WATER_DEPTH : floor;
  }

  /** Underside of the first solid above height y (tunnel roofs, overhangs). */
  private ceilAt(x: number, z: number, y: number): number {
    return this.ground ? this.ground.spans(x, z).ceil(y + 0.05) : Infinity;
  }

  private footprint(x: number, z: number, y = this.pos.y): number {
    const r = RADIUS * 0.7;
    return Math.max(this.floorAt(x - r, z - r, y), this.floorAt(x + r, z - r, y), this.floorAt(x - r, z + r, y), this.floorAt(x + r, z + r, y));
  }

  private ceiling(x: number, z: number, y = this.pos.y): number {
    const r = RADIUS * 0.7;
    return Math.min(this.ceilAt(x - r, z - r, y), this.ceilAt(x + r, z - r, y), this.ceilAt(x - r, z + r, y), this.ceilAt(x + r, z + r, y));
  }

  private materialAt(x: number, z: number, y = this.pos.y): MaterialProps {
    if (this.ground) return this.ground.materialAt(x, this.floorAt(x, z, y) - 0.05, z);
    const c = this.sample(x, z);
    return MATERIALS[surfaceMaterial(c.top, slopeAt(this.hf, x, z, VOXEL), c.water, x, z)];
  }

  get speed(): number {
    return this.vel.length();
  }

  get altitudeAGL(): number {
    return this.pos.y - this.groundAt(this.pos.x, this.pos.z);
  }

  get airDensity(): number {
    return airDensity(this.pos.y);
  }

  private key(c: string): number {
    return this.keys.has(c) ? 1 : 0;
  }

  /** Apex of a straight-up leap at v, head-first, under the same thinning air and transonic drag as the airborne body. */
  private apex(v: number): number {
    const cda = CDA_DIVE;
    let y = 0;
    for (let i = 0; i < 20000 && v > 0; i++) {
      const h = Math.min(0.05, Math.max(0.002, 2 / v)); // ~2 m per step
      const y0 = this.pos.y + y;
      v -= (GRAVITY + (0.5 * airDensity(y0) * cda * machDrag(v / soundSpeed(y0)) * v * v) / MASS) * h;
      y += Math.max(0, v) * h;
    }
    return y;
  }

  /** Launch speed that reaches height h (bisection on the simulated apex). */
  private jumpVelocity(h: number): number {
    let lo = 0, hi = JUMP_V_MAX;
    if (this.apex(hi) <= h) return hi;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (this.apex(mid) < h) lo = mid; else hi = mid;
    }
    return hi;
  }

  private addCharge(amount: number) {
    const before = this.jumpCharge;
    this.jumpCharge = Math.min(1, before + amount);
    if (this.jumpCharge > before) this.onCharge(this.jumpCharge);
  }

  /** Space released: jump if your feet are (or just were) on the ground, otherwise the charge is lost. */
  private release() {
    const charge = this.jumpCharge;
    this.charging = false;
    this.jumpCharge = 0;
    if (!this.flying && !this.inWater && this.time - this.lastGround < 0.12 && this.time - this.lastJump > 0.3) this.jump(charge);
  }

  /** Slam straight down: kill most drift and drive into the ground; the landing crater follows the impact speed. */
  private groundPound() {
    if (this.pounding) return;
    this.pounding = true;
    this.leaping = false;
    this.streamline = 1;
    this.vel.x *= 0.3;
    this.vel.z *= 0.3;
    this.vel.y = Math.min(this.vel.y, -Math.min(400, 60 + Math.max(0, this.altitudeAGL) * 0.3));
    this.onLaunch(0.6);
    this.onPound();
  }

  /** Jump to the height the charge reached; the take-off blast grows with it. */
  private jump(charge: number) {
    if (this.flying) return;
    this.jumpCharge = charge;
    const height = this.chargedHeight;
    this.jumpCharge = 0;
    this.lastJump = this.time;
    this.streamline = 1;
    this.leaping = true;
    this.lastGround = -1;
    const v = this.jumpVelocity(height);
    this.vel.y = v;
    // big jumps carry you forward if you're pressing W
    const fwd = this.key("KeyW") - this.key("KeyS");
    if (fwd && height > 4) {
      const push = Math.min(v, FLY_MAX) * 0.45;
      this.vel.x += -Math.sin(this.yaw) * fwd * push;
      this.vel.z += -Math.cos(this.yaw) * fwd * push;
    }
    this.onGround = false;
    this.crouched = false;
    this.onLaunch(height <= 2 ? 0 : Math.min(1.5, v / 60));
    // The blast follows the height: matches the old take-off speeds (no crater at 8 m, ~270 m/s at 600 m).
    this.onJump(270 * Math.pow(height / 600, 0.7), charge, this.pos, this.material);
  }

  private hit(speed: number, m: MaterialProps, nx = 0, ny = 1, nz = 0) {
    if (speed > this.impactThisFrame) {
      this.impactThisFrame = speed;
      this.impactMat = m;
      this.impactPoint.copy(this.pos);
      this.impactNormal.set(nx, ny, nz);
    }
  }

  private readonly guidedFrom = new THREE.Vector3();

  update(dt: number, flightContact?: (from: THREE.Vector3) => void, constrain?: (from: THREE.Vector3) => void) {
    if (this.vitals.frozen) { this.vel.set(0, 0, 0); return; }
    this.time += dt;
    this.vitals.update(dt,this.blocking);
    if(this.held)return;
    this.combatWhiff = Math.max(0, this.combatWhiff - dt);
    this.boring = Math.max(0, this.boring - dt);
    this.dashT = Math.max(0, this.dashT - dt);
    // Holding Space charges; the jump fires on release (see release), with a little coyote time off edges.
    if (this.onGround) this.lastGround = this.time;
    if (this.onGround || this.inWater) this.pounding = false;
    if (this.charging && (this.flying || this.inWater)) { this.charging = false; this.jumpCharge = 0; }
    if (this.charging) {
      const tenth = Math.floor(this.jumpCharge * 10);
      this.jumpCharge = Math.min(1, this.jumpCharge + dt / CHARGE_TIME);
      if (Math.floor(this.jumpCharge * 10) > tenth) this.onCharge(this.jumpCharge);
    }
    this.impactThisFrame = 0;

    const n = Math.min(64, Math.max(1, Math.ceil((this.vel.length() * dt) / 0.4)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (flightContact || constrain) this.guidedFrom.copy(this.pos);
      if (this.flying) {
        this.stepFly(h, !!flightContact);
        constrain?.(this.guidedFrom);
        flightContact?.(this.guidedFrom);
      } else {
        this.stepBody(h);
        constrain?.(this.guidedFrom);
      }
    }

    if (this.impactThisFrame > 2) {
      this.onImpact({ speed: this.impactThisFrame, material: this.impactMat, point: this.impactPoint, normal: this.impactNormal, flying: this.flying });
      if (!this.flying) this.land = Math.min(0.35, this.impactThisFrame * 0.015);
    }

    // view: ease over steps (Weisscap), track directly in the air
    const dy = this.pos.y - this.viewY;
    this.viewY = Math.abs(dy) > 2 || !this.onGround ? this.pos.y : this.viewY + dy * Math.min(1, dt * (this.climb > 0 ? 5 : 14));
    this.climb = Math.max(0, this.climb - dt * 1.5);
    const eye = (this.crouched ? EYE_CROUCH : EYE_STAND) - (this.charging ? CHARGE_SQUAT * this.jumpCharge : 0);
    this.eye += (eye - this.eye) * Math.min(1, dt * 9);
    this.land *= Math.exp(-dt * 8);

    // gait: phase advances one unit per step; a footstep sound at each foot strike
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && !this.flying && hs > 0.05 && hs < LAUNCH_CONTROL) {
      const run = THREE.MathUtils.smoothstep(hs, WALK, RUN);
      const before = Math.floor(this.bob);
      this.bob += (dt * hs) / THREE.MathUtils.lerp(STEP_WALK, STEP_RUN, run);
      if (Math.floor(this.bob) !== before) this.onStep(this.material, hs);
    }
    // No camera bank when swerving or turning; any leftover roll settles back to level.
    this.roll *= 1 - Math.min(1, 6 * dt);
  }

  /** Unit vector of the held movement keys (camera-relative, including up/down), zero if none. */
  private inputDir(out: THREE.Vector3): THREE.Vector3 {
    const fwd = this.key("KeyW") - this.key("KeyS");
    const strafe = this.flying && this.key("KeyW") ? 0 : this.key("KeyD") - this.key("KeyA");
    const lift = this.key("Space") - this.key("KeyC");
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    out.set(-sy * cp * fwd + cy * strafe, sp * fwd + lift, -cy * cp * fwd - sy * strafe);
    return out.lengthSq() > 0 ? out.normalize() : out;
  }

  /** Add thrust along the view, preserving every component of existing momentum. */
  private boost() {
    if (this.dashT > 0 || this.speed < 0.01 || this.speed >= SOUND_SPEED * BOOST_MACH_LIMIT) return;
    const impulse = this.speed * BOOST, cp = Math.cos(this.pitch);
    const look = this.flightDelta.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    this.vel.addScaledVector(look, impulse);
    this.dashT = BOOST_TIME;
    this.onLaunch(Math.min(1, 0.25 + this.speed / 400));
  }

  /** W + A/D turns; without W, A/D strafes. Arrows always steer, with finite lateral thrust. */
  private swerve(h: number): boolean {
    let yawInput = THREE.MathUtils.clamp(this.key("KeyW") * (this.key("KeyA") - this.key("KeyD")) + this.key("ArrowLeft") - this.key("ArrowRight"), -1, 1);
    let pitchInput = this.key("ArrowUp") - this.key("ArrowDown");
    const input = Math.hypot(yawInput, pitchInput);
    if (!input) return false;
    yawInput /= input; pitchInput /= input;
    const rate = Math.min(SWERVE_RATE, SWERVE_ACCEL / Math.max(1, this.speed)) * this.vitals.control;
    const yawDelta = yawInput * rate * h;
    this.yaw += yawDelta;
    this.vel.applyAxisAngle(TURN_UP, yawDelta);
    const pitch = Math.max(-1.55, Math.min(1.55, this.pitch + pitchInput * rate * h));
    this.turnAxis.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.vel.applyAxisAngle(this.turnAxis, pitch - this.pitch);
    this.pitch = pitch;
    return true;
  }

  /** Ground contact spends tangential momentum breaking terrain instead of freely sliding. */
  private tearGround(h: number, floor: number, normal = new THREE.Vector3(0, 1, 0)) {
    if (!this.ground || this.inWater) return;
    const tangent = this.contactVelocity.copy(this.vel).addScaledVector(normal, -this.vel.dot(normal));
    const speed = tangent.length();
    if (speed < TEAR_SPEED) return;
    const strength = this.ground.tear(this.pos.x, floor, this.pos.z, tangent);
    const lost = Math.min(speed, (90 + 70 * strength) * h);
    this.vel.addScaledVector(tangent, -lost / speed);
  }

  private stepFly(h: number, guided: boolean) {
    const p = this.pos, v = this.vel;
    if (!guided) {
      const swerving = this.swerve(h);
      const dir = this.inputDir(this.flightDelta);
      const steering = dir.lengthSq() > 0;
      if (!steering && swerving) dir.copy(v);
      else dir.multiplyScalar(this.flySpeed);
      // Bound velocity change by thrust, including turns and braking from a boost or lower ceiling.
      const delta = dir.sub(v);
      const change = delta.length();
      const maxChange = (steering ? FLY_ACCEL * this.vitals.control : FLY_BRAKE) * h;
      if (change > 0) v.addScaledVector(delta, Math.min(1, maxChange / change));
    }

    let nx = p.x + v.x * h, nz = p.z + v.z * h;

    // Collision response follows the contacted material, including non-bouncing concrete.
    const rx = this.footprint(nx, p.z) - p.y;
    if (rx > 2 || this.ceiling(nx, p.z) < p.y + 0.9) { const m=this.ground?.materialAt(nx,p.y+.5,p.z)??this.materialAt(nx,p.z); this.hit(Math.abs(v.x), m, -Math.sign(v.x), 0, 0); v.x *= -rebound(v.x, v.length(),Math.min(.3,m.bounce)); } else p.x = nx;
    const rz = this.footprint(p.x, nz) - p.y;
    if (rz > 2 || this.ceiling(p.x, nz) < p.y + 0.9) { const m=this.ground?.materialAt(p.x,p.y+.5,nz)??this.materialAt(p.x,nz); this.hit(Math.abs(v.z), m, 0, 0, -Math.sign(v.z)); v.z *= -rebound(v.z, v.length(),Math.min(.3,m.bounce)); } else p.z = nz;
    const y0 = p.y;
    p.y += v.y * h;
    const roof = this.ceiling(p.x, p.z, y0);
    if (p.y + 0.9 > roof) {
      if (v.y > 0) { const m=this.ground?.materialAt(p.x,roof+.05,p.z)??this.materialAt(p.x,p.z,roof+.1); this.hit(v.y, m, 0, -1, 0); v.y *= -rebound(v.y, v.length(),Math.min(.3,m.bounce)); }
      p.y = Math.min(p.y, roof - 0.9);
    }
    const g = this.footprint(p.x, p.z, y0);
    if (p.y < g) {
      // Reflect the incoming normal component; tangential momentum carries the ricochet.
      // Underground (tunnels, craters) the mountain's slope means nothing: treat it as a flat floor.
      const d = 1.5;
      const groundMaterial=this.materialAt(p.x,p.z);
      const deep = groundMaterial === MATERIALS[Mat.Concrete] || this.hf.height(p.x, p.z, 1) - p.y > 2;
      const nx2 = deep ? 0 : -(this.hf.height(p.x + d, p.z, 1) - this.hf.height(p.x - d, p.z, 1)) / (2 * d);
      const nz2 = deep ? 0 : -(this.hf.height(p.x, p.z + d, 1) - this.hf.height(p.x, p.z - d, 1)) / (2 * d);
      const n = new THREE.Vector3(nx2, 1, nz2).normalize();
      const vn = v.dot(n);
      if (vn < 0) {
        this.hit(-vn, groundMaterial, n.x, n.y, n.z);
        const bounce = rebound(vn, v.length(),Math.min(.3,groundMaterial.bounce));
        this.tearGround(h, g, n);
        v.addScaledVector(n, -(1 + bounce) * vn);
      }
      p.y = g;
    } else if (p.y - g < 0.15) {
      this.tearGround(h, g);
    }
    this.onGround = p.y - g < 0.05;
    this.updateWater();
  }

  private updateWater() {
    const c = this.sample(this.pos.x, this.pos.z);
    this.inWater = c.water && this.pos.y < c.top;
    this.underwater = c.water && this.pos.y + this.eye < c.top;
  }

  /** Not flying: a 68 kg body under gravity, drag, buoyancy and ground friction. */
  private stepBody(h: number) {
    const p = this.pos, v = this.vel;
    const surf = this.sample(p.x, p.z);
    const waterTop = surf.water ? surf.top : -Infinity;
    const ground = this.footprint(p.x, p.z);
    const grounded = p.y - ground < 0.02 && v.y <= 0.5;
    if (grounded) this.material = this.materialAt(p.x, p.z);
    const m = this.material;

    const fwd = this.key("KeyW") - this.key("KeyS");
    const strafe = this.key("KeyD") - this.key("KeyA");
    const run = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let wx = -sy * fwd + cy * strafe, wz = -cy * fwd - sy * strafe;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }

    // submerged fraction of the body
    const sub = Math.max(0, Math.min(1, (waterTop - p.y) / BODY_HEIGHT));
    const swimming = sub > 0.05 && !grounded;
    const hs = Math.hypot(v.x, v.z);

    if (swimming) {
      const target = SWIM * (run ? 1.6 : 1);
      v.x += (wx * target - v.x) * Math.min(1, 3 * h);
      v.z += (wz * target - v.z) * Math.min(1, 3 * h);
      v.y += (GRAVITY * (sub * BUOYANCY - 1) + this.key("Space") * 6) * h;
    } else if (grounded && hs < LAUNCH_CONTROL) {
      // walking (Weisscap): accelerate towards the target speed, limited by what the ground's grip allows
      const target = wl === 0 ? 0 : this.crouched || this.charging ? CROUCH : run ? RUN : WALK;
      const grip = Math.min(ACCEL, m.friction * GRAVITY * 1.3) * (wl ? 1 : 1.6);
      let dx = wx * target - v.x, dz = wz * target - v.z;
      const dl = Math.hypot(dx, dz), max = grip * h;
      if (dl > max) { dx *= max / dl; dz *= max / dl; }
      v.x += dx;
      v.z += dz;
      v.y = Math.max(v.y, 0);
    } else if (grounded) {
      // Uncontrolled ground contact ploughs a trench and sheds momentum.
      this.tearGround(h, ground);
      const dec = Math.min(hs, m.friction * GRAVITY * h);
      v.x -= (v.x / hs) * dec;
      v.z -= (v.z / hs) * dec;
      v.y = Math.max(v.y, 0);
    } else {
      // airborne: a little air control, and your pose sets the drag (W dive, S spread, else neutral)
      v.x += wx * 1.5 * h;
      v.z += wz * 1.5 * h;
      if (v.y <= 0) this.leaping = false;
      const pose = this.pounding || fwd > 0 || (this.leaping && fwd === 0) ? 1 : fwd < 0 ? 0 : 0.5;
      this.streamline += (pose - this.streamline) * Math.min(1, 1.5 * h);
      v.y -= GRAVITY * (this.pounding ? 4 : 1) * h;
    }

    // drag: air, or water for the submerged part
    const sp = v.length();
    if (sp > 0) {
      const rho = airDensity(p.y) * (1 - sub) + 1000 * sub;
      const air = grounded ? CDA_AIR : CDA_SPREAD + (CDA_DIVE - CDA_SPREAD) * this.streamline;
      const cda = air * machDrag(sp / soundSpeed(p.y)) * (1 - sub) + CDA_WATER * sub;
      const drag = Math.min(sp, ((0.5 * rho * cda * sp * sp) / MASS) * h);
      v.multiplyScalar(1 - drag / sp);
    }

    // move: horizontal axes separately, so you slide along walls
    const controlled = grounded && hs < LAUNCH_CONTROL;
    const slow = this.climb > 0 ? 0.35 : 1;
    for (let axis = 0; axis < 2; axis++) {
      const va = axis === 0 ? v.x : v.z;
      if (va === 0) continue;
      const nx = axis === 0 ? p.x + va * h * slow : p.x;
      const nz = axis === 1 ? p.z + va * h * slow : p.z;
      const lead = Math.sign(va) * RADIUS * 0.3;
      const probe = axis === 0 ? this.footprint(nx + lead, nz) : this.footprint(nx, nz + lead);
      const rise = probe - p.y;
      // room for your body between that floor and whatever is overhead?
      const head = (axis === 0 ? this.ceiling(nx + lead, nz) : this.ceiling(nx, nz + lead)) - Math.max(p.y, probe);
      const room = head >= BODY_HEIGHT * (this.crouched ? 0.68 : 1) || (!controlled && head >= 0.9);
      let ok = rise <= STEP_UP && room;
      if (!ok && room && controlled && rise <= CLIMB_UP && wl > 0) { this.climb = Math.max(this.climb, rise); ok = true; }
      if (ok) {
        p.x = nx;
        p.z = nz;
        if (rise > 0 && !controlled) p.y = Math.max(p.y, probe); // ride up over small ledges at speed
      } else {
        // wall: bounce back with the material's restitution
        const wm = this.ground?.materialAt(nx,p.y+.5,nz)??this.materialAt(nx,nz);
        const hard = Math.abs(va) > BOUNCE_MIN;
        if (hard) this.hit(Math.abs(va), wm, axis === 0 ? -Math.sign(va) : 0, 0, axis === 1 ? -Math.sign(va) : 0);
        if (Math.abs(va) > 15) this.streamline = 0;
        const out = hard ? -va * rebound(va, v.length(), Math.min(0.3, wm.bounce)) : 0;
        if (axis === 0) v.x = out; else v.z = out;
      }
    }

    // vertical
    const y0 = p.y;
    p.y += v.y * h;
    const roof = this.ceiling(p.x, p.z, y0);
    if (p.y + BODY_HEIGHT > roof && v.y > 0) {
      // head into a tunnel roof / overhang
      const m=this.ground?.materialAt(p.x,roof+.05,p.z)??this.materialAt(p.x,p.z,roof+.1);
      this.hit(v.y, m, 0, -1, 0);
      p.y = Math.max(y0, roof - BODY_HEIGHT);
      v.y = -v.y * rebound(v.y, v.length(), Math.min(.2,m.bounce));
    }
    const g = this.footprint(p.x, p.z, y0);
    if (p.y < g) {
      const vin = -v.y;
      p.y = g;
      const gm = this.materialAt(p.x, p.z);
      this.hit(vin, gm);
      if (vin > 15) this.streamline = 0; // knocked into a tumble
      const bounce = rebound(vin, v.length(), Math.min(0.3, gm.bounce));
      this.tearGround(h, g);
      v.y = vin > BOUNCE_MIN ? vin * bounce : 0;
      // landing at an angle scrubs horizontal speed with the friction impulse
      const hs2 = Math.hypot(v.x, v.z);
      if (hs2 > 0) {
        const scrub = Math.min(hs2, gm.friction * vin * 0.6);
        v.x -= (v.x / hs2) * scrub;
        v.z -= (v.z / hs2) * scrub;
      }
    } else if (grounded && v.y <= 0 && p.y - g <= (controlled ? STEP_DOWN : 0.3)) {
      p.y = g; // walking downhill or off a kerb; sliding bodies hug small voxel steps too
    }
    this.onGround = p.y - this.footprint(p.x, p.z) < 0.02 && v.y <= 0.5;

    const wasIn = this.inWater;
    this.updateWater();
    if (this.inWater && !wasIn) this.hit(Math.max(2.5, -v.y), MATERIALS[Mat.Water]);
  }

  private gait() {
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const walking = this.onGround && !this.flying && hs < LAUNCH_CONTROL;
    const moving = walking ? THREE.MathUtils.smoothstep(hs, 0.05, 0.6) : 0;
    const run = THREE.MathUtils.smoothstep(hs, WALK, RUN);
    const vA = THREE.MathUtils.lerp(BOB_WALK, BOB_RUN, run) * moving;
    const sA = THREE.MathUtils.lerp(SWAY_WALK, SWAY_RUN, run) * moving;
    const f = this.bob - Math.floor(this.bob);
    const dip = Math.pow(1 - Math.abs(Math.sin(Math.PI * f)), 2);
    return {
      bob: -vA * dip,
      sway: Math.sin(Math.PI * this.bob) * sA,
      roll: Math.sin(Math.PI * this.bob) * 0.006 * moving,
      nod: -dip * 0.006 * moving,
    };
  }

  applyCamera(cam: THREE.PerspectiveCamera) {
    if (this.held && this.hasGrabberViewTarget) {
      cam.position.set(this.pos.x, this.viewY + this.eye, this.pos.z);
      const dx = this.grabberViewTarget.x - cam.position.x;
      const dy = this.grabberViewTarget.y - cam.position.y;
      const dz = this.grabberViewTarget.z - cam.position.z;
      this.yaw = Math.atan2(-dx, -dz);
      this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      cam.rotation.set(this.pitch, this.yaw, 0, "YXZ");
      return;
    }
    const g = this.gait();
    cam.position.set(
      this.pos.x + Math.cos(this.yaw) * g.sway,
      this.viewY + this.eye + g.bob - this.land,
      this.pos.z - Math.sin(this.yaw) * g.sway,
    );
    cam.rotation.set(this.pitch + g.nod, this.yaw, this.roll + g.roll, "YXZ");
  }
}
