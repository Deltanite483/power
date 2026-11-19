import * as THREE from "three";
import type { PunchStyle } from "./faora";
import type { FighterRig } from "./fighter-rig";
import { Cape, Chain } from "./cape";

export type FighterKind = "faora" | "anissa" | "beast" | "sukuna" | "gojo";
export type GrapplePose = "hold" | "punch" | "kick" | "throw" | null;
/** Sukuna's casting stances. `castSwing` runs 0 (drawn back) to 1 (released) inside each. */
const CASTS = ["dismantle", "cleave", "shrine", "fuga", "rct", "world", "blue", "red", "purple", "void"] as const;
export type CastPose = typeof CASTS[number];

export interface FighterPoseInput {
  /** Feet position and velocity in the world. */
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Metres above whatever is under the feet. */
  height: number;
  airborne: boolean;
  engaged: boolean;
  guard: boolean;
  guardFlash: number;
  flinch: number;
  windup: number;
  /** Seconds left of the current strike (0.32 at contact). */
  strike: number;
  punch: PunchStyle;
  /** 0 none, 1 closing for a ram, 2 impact. */
  ram: 0 | 1 | 2;
  grapple: GrapplePose;
  crouch: number;
  landing: number;
  rise: number;
  gesture: number;
  hurt: number;
  helping: boolean;
  held: boolean;
  /** World point to watch, and how strongly (0 ignores it). */
  look: THREE.Vector3;
  lookWeight: number;
  cast?: CastPose | null;
  castSwing?: number;
}

const KEYS = [
  "drop", "sway", "cx", "cy", "cz", "hx", "hy", "hz", "jaw", "shrug",
  "lsx", "lin", "lout", "lex", "lwx", "lfc", "rsx", "rin", "rout", "rex", "rwx", "rfc",
  "lhx", "lho", "lk", "lf", "rhx", "rho", "rk", "rf",
  "lreach", "llift", "lside", "lfp", "lik", "rreach", "rlift", "rside", "rfp", "rik",
] as const;
type Key = typeof KEYS[number];
type Pose = Record<Key, number>;
type Part = Partial<Pose>;

const { lerp, smoothstep, clamp } = THREE.MathUtils;
const HALF = Math.PI / 2, TAU = Math.PI * 2;
const DOWN = new THREE.Vector3(0, -1, 0);
const BACK = new THREE.Vector3(0, 0, -1);
const STRIKE_TIME = .32;

/** Both arms the same. sx: negative raises the arm forward; out: away from the body; inward: across it; ex: negative bends the elbow. */
function arms(sx: number, out: number, inward: number, ex: number, fc = 1, wx = 0): Part {
  return { lsx: sx, rsx: sx, lout: out, rout: out, lin: inward, rin: inward, lex: ex, rex: ex, lfc: fc, rfc: fc, lwx: wx, rwx: wx };
}
const left = (sx: number, out: number, inward: number, ex: number, fc = 1, wx = 0): Part => ({ lsx: sx, lout: out, lin: inward, lex: ex, lfc: fc, lwx: wx });
const right = (sx: number, out: number, inward: number, ex: number, fc = 1, wx = 0): Part => ({ rsx: sx, rout: out, rin: inward, rex: ex, rfc: fc, rwx: wx });

/**
 * Procedural animation for the humanoid fighters. Every action is a pose with a smoothed weight, layered over
 * a locomotion base (planted-foot IK on the ground, a velocity-aligned body in the air), so any two actions blend.
 */
export class FighterAnimation {
  readonly cape: Cape | null = null;
  private readonly pose = {} as Pose;
  private readonly rest = new Map<THREE.Group, THREE.Vector3>();
  private bound = false;
  private released = true;
  private last: FighterPoseInput | null = null;
  private time = 0;
  private phase = 0;
  private gait = 0;
  private flight = 0;
  private travel = 0;
  private pitch = 0;
  private roll = 0;
  private leap = 0;
  private combat = 0;
  private guard = 0;
  private flinch = 0;
  private flinchSide = 1;
  private windup = 0;
  private readonly strike: Record<PunchStyle, number> = { straight: 0, uppercut: 0, down: 0 };
  private ramChase = 0;
  private ramHit = 0;
  private readonly grapple = { hold: 0, punch: 0, kick: 0, throw: 0 };
  private readonly cast = Object.fromEntries(CASTS.map(pose => [pose, 0])) as Record<CastPose, number>;
  private castSwing = 0;
  private crouch = 0;
  private landing = 0;
  private rise = 0;
  private gesture = 0;
  private hurt = 0;
  private help = 0;
  private held = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private forward = 0;
  private acceleration = 0;
  private yaw = 0;
  private turn = 0;
  private blink = 2;
  private readonly tailChain: Chain | null;
  private readonly chestQ = new THREE.Quaternion();
  private readonly localQ = new THREE.Quaternion();
  private readonly worldQ = new THREE.Quaternion();
  private readonly previousQ = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly v = new THREE.Vector3();
  private readonly gravity = new THREE.Vector3();
  private readonly wind = new THREE.Vector3();
  private readonly beast: boolean;

  constructor(private rig: FighterRig, private kind: FighterKind,
    private extras: { tail?: THREE.Group[]; flaps?: THREE.Group[]; cape?: { cloth: number; trim: number } | null } = {}) {
    this.beast = kind === "beast";
    rig.root.rotation.order = "YZX"; // yaw, then bank about the heading, then pitch: a prone flyer rolls about her own length
    for (const key of KEYS) this.pose[key] = 0;
    if (extras.cape) { this.cape = new Cape(extras.cape.cloth, extras.cape.trim); rig.cape.add(this.cape.mesh); }
    this.tailChain = extras.tail?.length ? new Chain(extras.tail.length, 13, .5) : null;
  }

  /** Call once the ragdoll has taken ownership of the top-level joints. */
  bind() {
    for (const group of this.rig.home.keys()) this.rest.set(group, group.position.clone());
    this.bound = true;
  }

  /** Hand the skeleton to the ragdoll: undo everything the chest carried. */
  release() {
    if (this.released) return;
    this.released = true;
    for (const [group, position] of this.rest) group.position.copy(position);
    this.rig.torso.quaternion.identity(); this.rig.head.quaternion.identity(); this.rig.cape.quaternion.identity(); this.rig.hips.quaternion.identity();
    for (const leg of this.rig.legs) leg.rotation.set(0, 0, 0);
    for (const foot of this.rig.feet) foot.rotation.set(0, 0, 0);
    this.pitch = this.roll = this.flight = this.travel = 0;
    for (const style of ["straight", "uppercut", "down"] as const) this.strike[style] = 0;
    this.windup = this.guard = this.ramChase = this.ramHit = this.castSwing = 0;
    for (const key of CASTS) this.cast[key] = 0;
  }

  reset() {
    this.release();
    this.released = false;
    this.phase = this.gait = this.leap = this.combat = this.flinch = this.crouch = this.landing = this.rise = this.gesture = this.hurt = this.help = this.held = 0;
    this.grapple.hold = this.grapple.punch = this.grapple.kick = this.grapple.throw = 0;
    this.forward = this.acceleration = this.turn = this.lookYaw = this.lookPitch = 0;
    this.yaw = this.rig.root.rotation.y;
    this.cape?.reset(); this.tailChain?.reset();
  }

  /** Snap straight to the moment of impact: contact is resolved the same frame, and hitstop may freeze this pose. */
  contact(style: PunchStyle) {
    this.windup = 0;
    for (const key of ["straight", "uppercut", "down"] as const) this.strike[key] = key === style ? 1 : 0;
    if (this.last) this.update(0, { ...this.last, strike: STRIKE_TIME, punch: style, windup: 0 });
  }

  private mix(weight: number, part: Part) {
    if (weight <= .0005) return;
    const pose = this.pose;
    for (const key in part) pose[key as Key] += (part[key as Key]! - pose[key as Key]) * weight;
  }

  update(dt: number, input: FighterPoseInput): boolean {
    const { rig, pose, beast } = this, { root } = rig;
    if (!this.bound) this.bind();
    this.released = false;
    this.last = input;
    this.time += dt;
    const time = this.time, scale = root.scale.y;
    const ease = (rate: number) => 1 - Math.exp(-dt * rate);
    const flyer = !beast && this.kind !== "sukuna";

    // --- Motion in the body's own frame ---
    const heading = root.rotation.y;
    const vx = input.velocity.x / scale, vy = input.velocity.y / scale, vz = input.velocity.z / scale;
    const forward = vx * Math.sin(heading) + vz * Math.cos(heading);
    const side = vx * Math.cos(heading) - vz * Math.sin(heading);
    const ground = Math.hypot(vx, vz), speed = Math.hypot(ground, vy);
    if (dt > 0) {
      this.acceleration = lerp(this.acceleration, clamp((forward - this.forward) / dt, -160, 160), ease(5));
      const turned = Math.atan2(Math.sin(heading - this.yaw), Math.cos(heading - this.yaw));
      this.turn = lerp(this.turn, clamp(turned / dt, -6, 6), ease(5));
    }
    this.forward = forward; this.yaw = heading;

    // --- Action weights ---
    const striking = input.strike > 0;
    const progress = 1 - clamp(input.strike / STRIKE_TIME, 0, 1);
    const extension = striking ? (progress < .34 ? 1 : 1 - smoothstep(progress, .34, 1)) : 0;
    for (const style of ["straight", "uppercut", "down"] as const)
      this.strike[style] = lerp(this.strike[style], style === input.punch ? extension : 0, ease(style === input.punch && striking ? 45 : 16));
    const struck = Math.max(this.strike.straight, this.strike.uppercut, this.strike.down);
    this.windup = lerp(this.windup, striking ? 0 : clamp(input.windup, 0, 1), ease(striking ? 40 : 15));
    this.guard = lerp(this.guard, input.guard ? 1 : 0, ease(input.guard ? 20 : 9));
    if (input.flinch > this.flinch + .3) this.flinchSide = -this.flinchSide;
    this.flinch = lerp(this.flinch, clamp(input.flinch, 0, 1), ease(input.flinch > this.flinch ? 40 : 10));
    this.ramChase = lerp(this.ramChase, input.ram === 1 ? 1 : 0, ease(9));
    // Ram contact is resolved the frame it lands, so the fists are already out.
    this.ramHit = input.ram === 2 ? 1 : lerp(this.ramHit, 0, ease(10));
    for (const key of ["hold", "punch", "kick", "throw"] as const)
      this.grapple[key] = lerp(this.grapple[key], input.grapple === key ? 1 : 0, ease(key === "hold" ? 10 : input.grapple === key ? 34 : 9));
    this.crouch = lerp(this.crouch, clamp(input.crouch, 0, 1), ease(22));
    this.landing = lerp(this.landing, clamp(input.landing, 0, 1), ease(input.landing > this.landing ? 60 : 12));
    this.rise = lerp(this.rise, clamp(input.rise, 0, 1), ease(input.rise > this.rise ? 60 : 9));
    this.gesture = lerp(this.gesture, clamp(input.gesture, 0, 1), ease(11));
    this.hurt = lerp(this.hurt, clamp(input.hurt, 0, 1), ease(3));
    this.help = lerp(this.help, input.helping ? 1 : 0, ease(5));
    this.held = lerp(this.held, input.held ? 1 : 0, ease(12));
    let casting = 0;
    for (const key of CASTS) {
      this.cast[key] = lerp(this.cast[key], input.cast === key ? 1 : 0, ease(input.cast === key ? 13 : 7));
      casting = Math.max(casting, this.cast[key]);
    }
    this.castSwing = lerp(this.castSwing, clamp(input.castSwing ?? 0, 0, 1), ease(26));
    const busy = Math.max(this.guard, struck, this.windup, this.grapple.hold, this.ramChase, this.ramHit, casting);
    this.flight = lerp(this.flight, flyer && !input.held ? Math.max(smoothstep(input.height, .12, .95), input.airborne ? 1 : 0) : 0, ease(5));
    this.leap = lerp(this.leap, !flyer && input.airborne ? 1 : 0, ease(input.airborne ? 14 : 9));
    this.travel = lerp(this.travel, smoothstep(speed, 7, 85), ease(3));
    const grounded = 1 - Math.max(this.flight, this.leap);
    this.combat = lerp(this.combat, input.engaged ? 1 : 0, ease(5));

    // --- Stride ---
    const run = this.kind === "sukuna" ? smoothstep(ground, 5, 24) : beast ? smoothstep(ground, 5, 22) : smoothstep(ground, 3, 9);
    const stride = input.airborne || input.crouch > 0 || input.landing > .5 || input.rise > .3 || input.helping || input.held || grounded < .5
      ? 0 : smoothstep(ground, .25, 2.4);
    this.gait = lerp(this.gait, stride, ease(9));
    const step = Math.floor(this.phase * 2);
    if (stride > 0) this.phase = (this.phase + dt * (beast ? lerp(.85, 2.7, smoothstep(ground, 0, 36)) : lerp(.9, 1.75, run))) % 1;
    const footfall = stride > .8 && step !== Math.floor(this.phase * 2);
    const gait = this.gait, rhythm = Math.cos(this.phase * TAU) * gait;
    const breath = Math.sin(time * (1.7 + this.hurt * 1.6 + run * gait * 2.5));
    const idle = 1 - gait;

    // --- Base: standing, walking, running ---
    for (const key of KEYS) pose[key] = 0;
    const lean = clamp(this.acceleration * .006, -.12, .2) * grounded;
    pose.cx = (beast ? .1 : .03) + gait * lerp(.05, beast ? .3 : .2, run) + lean;
    pose.cy = rhythm * lerp(.1, .2, run);
    pose.cz = rhythm * .035 - Math.sin(time * .55) * .02 * idle;
    pose.sway = Math.sin(time * .55) * .014 * idle;
    pose.hy = -pose.cy * .7;
    pose.hx = -pose.cx * .55;
    pose.drop = gait * (.012 + Math.abs(Math.sin(this.phase * TAU)) * lerp(.02, .05, run)) + (beast ? .035 : 0);
    const swing = lerp(.38, beast ? .8 : .95, run);
    const elbow = -.2 - gait * lerp(.12, 1.25, run);
    this.mix(1, beast ? arms(.06, .3, -.05, -.42, .45) : arms(.05, .1, 0, -.2, .35));
    pose.lsx += rhythm * swing; pose.rsx -= rhythm * swing * (beast ? .45 : 1);
    pose.lex = elbow + Math.min(0, rhythm) * .3 * gait; pose.rex = (beast ? -.55 : elbow) - Math.max(0, rhythm) * .3 * gait;
    pose.lfc = pose.rfc = lerp(beast ? .5 : .35, 1, run * gait);
    if (beast) pose.rfc = 1; // he never lets go of the mace
    pose.lik = pose.rik = 1;
    const legLength = rig.spec.thigh + rig.spec.shin;
    for (const index of [0, 1] as const) {
      const sign = index === 0 ? -1 : 1;
      const cycle = (this.phase + index * .5) % 1, stance = lerp(.64, .46, run);
      const lift = smoothstep(cycle, stance, 1);
      const sweep = cycle < stance ? 1 - 2 * cycle / stance : 2 * lift - 1;
      const reach = sweep * gait * legLength * lerp(.2, beast ? .58 : .52, run) - sign * .02 * idle;
      const height = Math.sin(Math.PI * lift) * gait * legLength * lerp(.1, .34, run);
      const pitch = cycle < stance ? -sweep * gait * .22 * (1 - run * .5) : Math.sin(lift * Math.PI) * gait * lerp(.3, .9, run) - sweep * gait * .15;
      if (index === 0) { pose.lreach = reach; pose.llift = height; pose.lfp = pitch; pose.lside = .012; }
      else { pose.rreach = reach; pose.rlift = height; pose.rfp = pitch; pose.rside = .012; }
    }

    // --- Fighting stance: bladed body, hands up, light on the feet ---
    const stanceWeight = this.combat * grounded * (1 - gait * .75);
    if (beast) {
      this.mix(stanceWeight, { cx: .26, cy: .26, drop: .11, hy: -.22, hx: -.2, lreach: .2, rreach: -.18, lside: .07, rside: .07, jaw: .16,
        ...left(-.72, .38, .1, -1.12, .15), ...right(.22, .34, 0, -.95, 1, .25) });
    } else {
      this.mix(stanceWeight, { cx: .1, cy: .34, drop: .055 + Math.sin(time * 5.6) * .012, hy: -.3, lreach: .15, rreach: -.13, lside: .035, rside: .035,
        ...left(-.98, .1, .3, -1.82), ...right(-.5, .2, .1, -2.1) });
    }

    // --- Flight: hover upright, then lay the body along the velocity as speed builds ---
    if (this.flight > .001) {
      const t = this.travel, bob = Math.sin(time * 1.6), drift = Math.sin(time * 1.05 + 1);
      const hover: Part = {
        drop: bob * .022 - .01, sway: drift * .012, cx: -.05, cy: drift * .03, cz: 0, hx: .03, hy: 0,
        ...arms(.14, .24, .08, -.38, .7),
        lhx: -.5 + bob * .04, lho: .03, lk: .95, lf: .45, rhx: .07 - bob * .03, rho: .03, rk: .14, rf: .62,
        lik: 0, rik: 0,
      };
      this.mix(this.flight, hover);
      // In a fight she squares up even in mid-air.
      this.mix(this.flight * this.combat * (1 - smoothstep(t, .06, .55)), { cy: .32, hy: -.28, cx: .04, ...left(-.98, .1, .3, -1.82), ...right(-.5, .2, .1, -2.1), lhx: -.75, lk: 1.25 });
      const flutter = Math.sin(time * 9) * .03 * t;
      const cruise: Part = {
        drop: 0, sway: 0, cx: -.17, cy: 0, cz: 0,
        lhx: .06 + flutter, lk: .08, lf: .95, rhx: .13 - flutter, rk: .3, rf: .95, lho: .015, rho: .015,
        ...(this.kind === "faora"
          ? { ...right(-3, .1, .12, -.05), ...left(.38, .16, 0, -.95) }      // one fist leading, the other chambered at her hip
          : arms(.46, .3, -.05, -.14)),                                      // Viltrumite: arms swept back like a diving falcon
      };
      this.mix(this.flight * smoothstep(t, .06, .55), cruise);
    }
    const level = Math.atan2(Math.max(0, forward), vy);
    const aligned = smoothstep(speed, 5, 70);
    const brake = clamp(-this.acceleration * .006, 0, .65) * this.flight;
    const pitchTarget = this.flight * (aligned * Math.min(level, 2.5) * .94 + (1 - aligned) * clamp(forward / 40, -.25, .5) - brake)
      + grounded * gait * run * (beast ? .18 : .13) + this.leap * (.12 + smoothstep(vy, -25, 25) * .2);
    this.pitch = lerp(this.pitch, input.held ? .2 + Math.sin(time * 13) * .16 : pitchTarget, ease(input.held ? 14 : 4.5));
    const bank = this.flight * (-Math.atan(side / 45) * .5 - clamp(this.turn * (.12 + this.travel * .3), -.75, .75)) - grounded * gait * clamp(this.turn * .06, -.2, .2);
    this.roll = lerp(this.roll, input.held ? Math.sin(time * 8.5) * .22 : bank, ease(input.held ? 14 : 5));
    // Keep her eyes on where she is going, however far the body tips over.
    const ahead = this.flight * clamp(this.pitch * .8, -.3, 1.05);
    pose.hx -= ahead;

    // --- Ground-only leaps ---
    if (this.leap > .001) {
      const tuck = smoothstep(vy, -26, 7), up = smoothstep(vy, -18, 22);
      this.mix(this.leap, {
        cx: .16 + tuck * .1, drop: 0, cy: 0, hx: -.15,
        lhx: -.2 - tuck * 1.05, lk: .25 + tuck * 1.5, lf: .3, rhx: -.1 - tuck * .7, rk: .2 + tuck * 1.25, rf: .3, lho: .12, rho: .12, lik: 0, rik: 0,
        ...left(-.7 - up * .95, .42, 0, -.4, .2), ...right(lerp(-2.7, -1.2, up), .4, 0, lerp(-1.05, -.5, up), 1, .2), jaw: .5 - up * .3,
      });
    }

    // --- Reactions and intent ---
    this.mix(this.hurt * (1 - busy), { cx: .3, cz: .08, hx: .22, drop: .05, ...right(-.56, 0, .98, -1.78, .25), ...left(.06, .12, 0, -.28, .3) });
    this.mix(this.help, { drop: legLength * .55, cx: .58, hx: .18, lreach: .22, rreach: -.26, lside: .06, rside: .06, ...arms(-.78, .12, .12, -.55, .1) });
    this.mix(this.gesture * (1 - busy), beast
      ? { ...right(-2.9, .25, 0, -.25, 1), jaw: .75, cx: -.12, hx: -.2 }
      : this.kind === "sukuna" ? { ...right(-.65, .25, .45, -1.65, .12), cx: -.08, hx: -.14, cy: -.12 }
      : { ...right(-2.2, .58, 0, -1.78, .15), hx: .06 + Math.sin(time * 9) * .04, cy: -.12 });
    this.mix(this.crouch, { drop: legLength * .36, cx: .5, hx: -.4, lside: .05, rside: .05, lreach: .08, rreach: -.1, ...arms(.7, .3, 0, -.55, 1), jaw: .3 });
    this.mix(this.landing, { drop: legLength * .34, cx: .44, hx: -.25, lside: .08, rside: .08, lreach: .14, rreach: -.12, ...left(-.52, .25, 0, -.3, .1), ...right(.5, .35, 0, -.5, 1) });
    this.mix(this.rise, { drop: legLength * .5, cx: .62, hx: -.3, lreach: .2, rreach: -.22, lside: .06, rside: .06, ...arms(-.5, .3, 0, -.65, .1) });

    // --- Guard ---
    const flash = input.guardFlash;
    if (beast) {
      this.mix(this.guard, { cx: .2 - flash * .15, cy: .2, drop: .12 + flash * .04, hx: .1, lreach: .18, rreach: -.18, lside: .08, rside: .08,
        ...left(-1.15, -.2, .35, -1.75), ...right(-1.05, -.1, .62, -1.5, 1, -.35) });
    } else {
      this.mix(this.guard, { cx: .17 - flash * .15, cy: .1, drop: .09 + flash * .035, hx: .14, hy: 0, lreach: .16, rreach: -.16, lside: .05, rside: .05,
        ...arms(-1.12 + flash * .1, -.3, .34, -1.72 - flash * .12, 1, -.15), lhx: -.85, lk: 1.4, rhx: -.6, rk: 1.25 });
    }

    // --- Wind-up and strikes ---
    const w = this.windup;
    if (beast) {
      this.mix(Math.min(1, w * 3), { cy: .18 + w * .32, cx: .1 - w * .26, drop: .08 + w * .05, hy: -.3 * w, jaw: .2 + w * .45, lreach: .2, rreach: -.2,
        ...right(lerp(-.7, -2.85, w), .36, 0, -.5 - w * .85, 1, -.3 * w), ...left(-1.0, .3, .1, -.65, .1) });
      this.mix(this.strike.straight, { cy: -.78, cx: .24, drop: .1, hy: .4, jaw: .85, lreach: .3, rreach: -.26,
        ...right(-1.42, -.1, .8, -.22, 1, .35), ...left(.35, .5, 0, -.6, .2) });
      this.mix(this.strike.uppercut, { cy: -.5, cx: -.22, drop: 0, hx: -.2, jaw: .85, lreach: .22, rreach: -.2,
        ...right(-2.35, .1, .25, -.4, 1, -.2), ...left(.3, .45, 0, -.7, .2) });
      this.mix(this.strike.down, { cy: -.45, cx: .62, drop: .17, hx: -.3, jaw: .9, lreach: .28, rreach: -.24,
        ...right(-.7, 0, .3, -.12, 1, .4), ...left(.45, .5, 0, -.5, .2) });
    } else {
      this.mix(Math.min(1, w * 3.2), { cy: .34 + w * .5, cx: .08 + w * .08, drop: .05 + w * .05, hy: -.3 - w * .4, lreach: .17, rreach: -.17, lside: .04, rside: .04,
        ...right(lerp(-.5, .78, w), .42, 0, -2.15), ...left(-1.18, .08, .16, -1.0 + w * .2, .9) });
      this.mix(this.strike.straight, { cy: -.62, cx: .24, drop: .07, hy: .45, hx: -.08, lreach: .27, rreach: -.25,
        ...right(-1.52, -.04, .16, -.06), ...left(-.55, .15, .1, -2.2) });
      this.mix(this.strike.uppercut, { cy: -.5, cx: -.15, cz: -.1, drop: -.02, hy: .35, hx: -.2, lreach: .2, rreach: -.18,
        ...right(-2.12, 0, .2, -1.05), ...left(-.5, .2, .1, -2.15) });
      this.mix(this.strike.down, { cy: -.56, cx: .52, drop: .12, hy: .4, hx: -.35, lreach: .26, rreach: -.22,
        ...right(-.95, 0, .26, -.3), ...left(.42, .42, 0, -.6) });
    }

    // --- Sukuna's techniques: each hand sign is held through the charge, then thrown ---
    if (casting > .001) {
      const k = this.castSwing, c = this.cast, tremor = Math.sin(time * 31) * .012;
      // Dismantle: two fingers drawn across the chest, then flicked out along the cut.
      this.mix(c.dismantle, { cy: lerp(.42, -.4, k), cx: lerp(.02, .12, k), hy: lerp(-.38, .3, k), drop: .03, lreach: .12, rreach: -.12, lside: .03, rside: .03,
        ...right(lerp(-1.42, -1.5, k), lerp(-.1, .62, k), lerp(1.05, -.15, k), lerp(-1.35, -.12, k), .08, lerp(-.2, .25, k)), ...left(.16, .1, 0, -.42, .7) });
      // Cleave: a lunge, open palm laid on the target.
      this.mix(c.cleave, { cy: lerp(.3, -.42, k), cx: lerp(.06, .26, k), hy: lerp(-.25, .35, k), hx: -.1, drop: .09, lreach: .3, rreach: -.26, lside: .04, rside: .04,
        ...right(lerp(-.6, -1.5, k), .12, lerp(.3, .12, k), lerp(-1.9, -.1, k), 0, -.75), ...left(.3, .3, 0, -.9, .8) });
      // Malevolent Shrine: both hands folded into the seal before his chest, head bowed over them.
      this.mix(c.shrine, { cx: .07, cy: 0, hx: .2 - k * .34, hy: 0, drop: .015, shrug: .012, jaw: .25 * k, lreach: .03, rreach: -.03, lside: .05, rside: .05,
        ...arms(-.86 + tremor, -.12, .62, -1.86, .55, -.35) });
      // Fuga: bow arm out along the shot, string hand hauled back past the jaw.
      this.mix(c.fuga, { cy: .9, cx: -.03, hy: -.8, hx: -.04, drop: .05, lreach: .22, rreach: -.2, lside: .07, rside: .07,
        ...left(-1.52, .85, 0, -.05, .9),
        ...right(lerp(-1.42, -1.3, k), lerp(.9, 1.15, k), lerp(0, -.2, k), lerp(-2.3, -1.1, k), lerp(.7, 0, k)) });
      // Reverse cursed technique: he stands easy and lets it knit, one hand raised to his face.
      this.mix(c.rct, { cx: -.07, cy: .08, hx: -.2, hz: .08, drop: 0, jaw: .15, ...right(-1.05, .08, .62, -2.25, .1, -.2), ...left(.1, .16, 0, -.2, .3) });
      // The world-cutting slash: hand raised overhead like an executioner's blade, then brought down.
      this.mix(c.world, { cy: lerp(.26, -.3, k), cx: lerp(-.16, .4, k), hx: lerp(-.1, -.3, k), hy: lerp(-.2, .25, k), drop: lerp(.02, .13, k), lreach: .26, rreach: -.24, lside: .05, rside: .05,
        ...right(lerp(-2.95, -.85, k), .08, lerp(0, .25, k), lerp(-.45, -.08, k), 0, lerp(.2, -.3, k)), ...left(lerp(-1.3, .3, k), .1, .55, lerp(-1.5, -.6, k), .5) });
      this.mix(c.blue, { cx: -.12, cy: lerp(-.44, .28, k), hx: .05,
        ...left(lerp(-1.36, -.82, k), .30, .17, lerp(-.38, -1.8, k), .18, -.28), ...right(.22, .19, 0, -.4, .6) });
      this.mix(c.red, { cx: lerp(-.12, .13, k), cy: lerp(.32, -.25, k), hx: -.12,
        ...right(lerp(-1.02, -1.58, k), .18, .14, lerp(-1.75, -.12, k), .18, -.18), ...left(.13, .25, 0, -.6, .55) });
      this.mix(c.purple, { cx: lerp(-.17, .17, k), cy: lerp(.23, -.21, k), hy: lerp(-.2, .13, k),
        ...right(lerp(-1.16, -1.52, k), .21, .18, lerp(-1.53, -.1, k), .13, -.35),
        ...left(lerp(-1.32, .1, k), .13, .51, lerp(-1.56, -.42, k), .21) });
      this.mix(c.void, { cx: -.04, cy: .12, hx: -.08 - k * .12,
        ...right(-1.25, .17, .42, -2.14, .14, -.4), ...left(.11, .16, 0, -.48, .45) });
    }

    // --- Rams and grapples ---
    const reach = -clamp(HALF + this.pitch, 1.2, 3.02); // "forward along the flight path" in shoulder terms
    this.mix(this.ramChase, { cx: .08, ...arms(lerp(-.9, reach, .45), .16, .2, -1.5) });
    this.mix(this.ramHit, { cx: .12, hx: pose.hx - .1, ...arms(reach - .12, .07, .12, -.05) });
    this.mix(this.grapple.hold, { cy: .26, cx: .1, hy: -.22, ...left(-1.36, .02, .14, -.32, .85), ...right(-.45, .26, 0, -2.1), lreach: .16, rreach: -.14 });
    this.mix(this.grapple.punch, { cy: -.48, cx: .2, hy: .35, ...right(-1.6, -.04, .16, -.1) });
    this.mix(this.grapple.kick, { cx: -.24, cy: .2, rhx: -1.42, rk: .12, rf: -.35, rik: 0, ...arms(-.6, .45, 0, -1.3) });
    this.mix(this.grapple.throw, { cy: -.55, cx: .32, ...left(-1.7, .05, .2, -.1, .1), ...right(-1.78, .05, .2, -.08, .1), lreach: .26, rreach: -.22 });

    // --- Hit reactions and struggling ---
    const f = this.flinch;
    this.mix(f, { cx: -.32, cz: this.flinchSide * .16, hx: -.2, hz: this.flinchSide * .2, drop: .035, rreach: -.22, lreach: -.06, jaw: .5,
      ...arms(.28, .74, 0, -.55, .3) });
    if (this.held > .001) {
      const s = time * 13;
      this.mix(this.held, { cx: .05, cy: Math.sin(s * .5) * .2, hy: Math.sin(s * .8) * .32, hx: -.1, jaw: .45,
        lsx: -.85 + Math.sin(s) * .5, rsx: -.85 + Math.cos(s) * .5, lout: .6, rout: .6, lin: 0, rin: 0,
        lex: -1.25 + Math.cos(s) * .35, rex: -1.25 + Math.sin(s) * .35, lfc: 1, rfc: 1,
        lhx: Math.sin(s) * .65, rhx: -Math.sin(s) * .65, lk: .56 + Math.cos(s) * .42, rk: .56 - Math.cos(s) * .42, lf: .3, rf: .3, lik: 0, rik: 0, drop: 0 });
    }

    // --- Breathing, and watching the opponent ---
    pose.cx += breath * .013; pose.shrug += breath * .004 + this.guard * .012;
    pose.lout += breath * .008; pose.rout += breath * .008;
    root.updateMatrixWorld();
    const lookWeight = input.lookWeight * (1 - Math.max(f, this.held, this.rise, this.help * .6));
    if (lookWeight > 0) {
      this.v.copy(input.look);
      rig.head.parent!.worldToLocal(this.v).sub(rig.head.position);
      const yaw = Math.atan2(this.v.x, this.v.z) - pose.cy, pitch = -Math.atan2(this.v.y, Math.hypot(this.v.x, this.v.z)) - pose.cx;
      const behind = Math.abs(yaw) > 2.3 ? 0 : 1;
      this.lookYaw = lerp(this.lookYaw, clamp(yaw, -1.15, 1.15) * behind * lookWeight, ease(8));
      this.lookPitch = lerp(this.lookPitch, clamp(pitch, -.9, .75) * behind * lookWeight, ease(8));
    } else { this.lookYaw = lerp(this.lookYaw, 0, ease(5)); this.lookPitch = lerp(this.lookPitch, 0, ease(5)); }
    const watching = clamp(input.lookWeight, 0, 1);
    pose.hy = lerp(pose.hy, this.lookYaw * .8, watching * .85);
    pose.hx = lerp(pose.hx, this.lookPitch * .85, watching * .85);
    pose.cy += this.lookYaw * .16 * (1 - busy);

    this.apply(dt, input, scale);
    return footfall;
  }

  private apply(dt: number, input: FighterPoseInput, scale: number) {
    const { rig, pose } = this, { root, spec } = rig;
    // Root: drop the hips, bank and pitch about the body's centre while flying (about the feet while standing).
    root.rotation.x = this.pitch; root.rotation.z = this.roll;
    root.position.copy(input.position);
    const pivot = (spec.hip[1] + .06) * scale * Math.max(this.flight, this.held);
    this.v.set(0, pivot, 0).applyQuaternion(root.quaternion);
    root.position.x -= this.v.x; root.position.y += pivot - this.v.y; root.position.z -= this.v.z;
    const heading = root.rotation.y;
    root.position.x += Math.cos(heading) * pose.sway * scale; root.position.z -= Math.sin(heading) * pose.sway * scale;
    const drop = Math.max(-.03, pose.drop);
    root.position.y -= drop * scale * Math.cos(this.pitch);

    // Chest, carrying the head, arms and cape with it.
    const waist = rig.waist;
    this.chestQ.setFromEuler(this.euler.set(pose.cx, pose.cy, pose.cz));
    const carry = (group: THREE.Group, local: THREE.Quaternion | null, lift = 0) => {
      const home = rig.home.get(group)!, rest = this.rest.get(group)!;
      this.v.copy(home).sub(waist).applyQuaternion(this.chestQ).add(waist).sub(home);
      group.position.copy(rest).add(this.v);
      group.position.y += lift;
      if (local) group.quaternion.copy(this.chestQ).multiply(local); else group.quaternion.copy(this.chestQ);
    };
    carry(rig.torso, null);
    carry(rig.cape, null);
    carry(rig.head, this.localQ.setFromEuler(this.euler.set(pose.hx, pose.hy, pose.hz)));
    rig.jaw.rotation.x = Math.max(0, pose.jaw) * .62;
    for (const index of [0, 1] as const) {
      const sign = index === 0 ? -1 : 1, l = index === 0;
      const sx = l ? pose.lsx : pose.rsx, out = l ? pose.lout : pose.rout, inward = l ? pose.lin : pose.rin;
      // Raising an arm lifts its shoulder.
      carry(rig.arms[index], this.localQ.setFromEuler(this.euler.set(sx, -sign * inward, sign * out)), pose.shrug + smoothstep(-sx, 1.2, 2.8) * .03);
      rig.forearms[index].rotation.set(Math.min(0, l ? pose.lex : pose.rex), 0, 0);
      rig.hands[index].rotation.set(l ? pose.lwx : pose.rwx, 0, 0);
      rig.fingers[index].rotation.set(0, 0, -sign * clamp(l ? pose.lfc : pose.rfc, 0, 1) * 1.5);

      // Legs: a planted-foot solve on the ground, blended against free poses in the air.
      const upper = spec.thigh, lower = spec.shin;
      const sideways = l ? pose.lside : pose.rside, forward = l ? pose.lreach : pose.rreach;
      const down = Math.max(.05, upper + lower - .004 - drop - (l ? pose.llift : pose.rlift));
      const plane = Math.hypot(down, sideways);
      const distance = clamp(Math.hypot(forward, plane), Math.abs(upper - lower) + .002, upper + lower - .001);
      const knee = Math.acos(clamp((distance * distance - upper * upper - lower * lower) / (2 * upper * lower), -1, 1));
      const hip = -Math.atan2(forward, plane) - Math.atan2(lower * Math.sin(knee), upper + lower * Math.cos(knee));
      const ik = clamp(l ? pose.lik : pose.rik, 0, 1);
      const hx = lerp(l ? pose.lhx : pose.rhx, hip, ik), bend = lerp(Math.max(0, l ? pose.lk : pose.rk), knee, ik);
      rig.legs[index].rotation.set(hx, 0, sign * lerp(l ? pose.lho : pose.rho, Math.atan2(sideways, down), ik));
      rig.shins[index].rotation.set(bend, 0, 0);
      rig.feet[index].rotation.set(lerp(l ? pose.lf : pose.rf, (l ? pose.lfp : pose.rfp) - hx - bend - this.pitch, ik), 0, 0);
    }
    if (this.extras.flaps) {
      const front = Math.min(0, rig.legs[0].rotation.x, rig.legs[1].rotation.x), back = Math.max(0, rig.legs[0].rotation.x, rig.legs[1].rotation.x);
      const sway = Math.sin(this.time * 6) * this.gait * .08;
      this.extras.flaps[0].rotation.x = front * .85 - .04 + sway;
      this.extras.flaps[1].rotation.x = back * .85 + .04 + sway;
    }

    // Blink.
    this.blink -= dt;
    if (this.blink < -.12) this.blink = 1.6 + (Math.sin(this.time * 12.9898) * 43758.5453 % 1 + 1) % 1 * 3.4;
    rig.lids.position.y = this.blink < 0 || this.flinch > .5 ? -.0125 : 0;

    // Cloth and hair trail the chest and head.
    if (dt <= 0 || (!this.cape && !this.tailChain)) return;
    root.updateMatrixWorld(true);
    if (this.cape) {
      rig.cape.getWorldQuaternion(this.worldQ).invert();
      this.gravity.copy(DOWN).applyQuaternion(this.worldQ);
      this.wind.copy(input.velocity).multiplyScalar(-1 / scale).applyQuaternion(this.worldQ);
      this.cape.update(dt, this.gravity, this.wind, this.time);
    }
    if (this.tailChain && this.extras.tail) {
      rig.head.getWorldQuaternion(this.worldQ).invert();
      this.gravity.copy(DOWN).applyQuaternion(this.worldQ);
      this.wind.copy(input.velocity).multiplyScalar(-1 / scale).applyQuaternion(this.worldQ);
      this.tailChain.update(dt, this.gravity, this.wind, this.time, smoothstep(this.wind.length(), 2, 60) * .7 + .05, BACK);
      this.previousQ.identity();
      this.extras.tail.forEach((link, i) => {
        this.localQ.setFromUnitVectors(DOWN, this.tailChain!.directions[i]);
        link.quaternion.copy(this.previousQ).invert().multiply(this.localQ);
        this.previousQ.copy(this.localQ);
      });
    }
  }
}
