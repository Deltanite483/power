import { buildSukuna, SUKUNA_SPEC } from "./sukuna-model";
import { buildGojo, GOJO_SPEC } from "./gojo-model";
import { GojoInfinity } from "./gojo";
import { CursedEnergy, CURSED_COST } from "./cursed-energy";
import { CursedReserveAura } from "./cursed-aura";
import { attackerMultiplier, bypassesDefenseStat, terrainHit, playerHit, type HitSource, type DamageHit } from "./combat-events";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Player } from "./player";
import { BOOST_MACH_LIMIT, SOUND_SPEED, soundSpeed } from "./player";
import type { Destruction } from "./destruction";
import { Contrails } from "./effects";
import { GroundPath } from "./ground-pathing";
import { planBeastJump, planBeastEscape, DOOMSDAY_JUMP, SUKUNA_JUMP, type BeastJump } from "./beast-leap";
import { Ragdoll } from "./ragdoll";
import { DoomsdayAnimation } from "./doomsday-animation";
import { DoomsdayRig } from "./doomsday-rig";
import {buildDoomsday} from "./doomsday-model";
import { FighterRig } from "./fighter-rig";
import { BEAST_SPEC, FLYER_SPEC, buildBeast, buildFlyer } from "./fighter-models";
import { FighterAnimation, type CastPose, type FighterPoseInput } from "./fighter-animation";
import type { Interactions } from "./interactions";
import { SuperBlock } from "./super-block";
import { Combat, MELEE_CHARGE_THRESHOLD, RAM_BLOCK_DAMAGE, RAM_TRANSFER } from "./combat";
import { STAGGER_LIMIT, STAGGER_PUSH, Vitality, launchSpeed } from "./vitality";
import { ramContact } from "./follow-up";
import { BODY_CENTER, PathFollower, Pathfinder, speedMargin } from "./pathing";

const RISE_TIME = .55; // s spent getting back up after a knockdown
const STAGGER_TIME = .35; // s of flinch after a hit below the stagger limit
const DETOUR_SPEED = 160; // m/s cap while routing around things, so the corners can actually be made

const GRAB_ESCAPE_TIME = 6;
const DOOMSDAY_ESCAPE_SECONDS_PER_HP = .35;
const ANISSA_RETREAT_HP = 38;
const PRESSURE_DECAY_SECONDS = 2.4;
const RECOVERY_RATE = 3;

export type FaoraState = "follow" | "retaliate" | "ragdoll" | "carried";
export type PunchStyle = "straight" | "uppercut" | "down";
const UP = new THREE.Vector3(0, 1, 0);
const BODY = 1.9;
const BEAST_SPRINT = 50; // m/s a charging sprint adds over his 22 m/s run
const BEAST_SKIP_DISTANCE = 300;
const BEAST_SKIP_COOLDOWN = 5;
const SUKUNA_BLINK_COOLDOWN = 3.5;
const SUKUNA_POISE_THRESHOLD = 75;
const SUKUNA_LAUNCH_THRESHOLD = 110;
const SUKUNA_STAGGER_TIME = .2;
const SUKUNA_MELEE_HITS = new Set<HitSource["action"]>([
  "punch", "kick", "smash", "slam", "uppercut", "snatch", "black-flash", "blue-melee", "red-melee",
]);

const FIGHT_STYLES = {
  doomsday: {speed:0,steering:0,spacing:3.2,chargeTime:1,cooldown:.3,missRecovery:.85,charges:[.8,1,.9],followCharge:.9},
  faora: { speed: 185, steering: 440, spacing: 2.7, chargeTime: 1.2, cooldown: .34, missRecovery: .85, charges: [.24, .85, .6], followCharge: .6 },
  anissa: { speed: 230, steering: 540, spacing: 2.8, chargeTime: 1.5, cooldown: .72, missRecovery: 1.1, charges: [.3, .85, .95], followCharge: .8 },
  sukuna: { speed: 245, steering: 510, spacing: 2.4, chargeTime: 1.25, cooldown: 1.25, missRecovery: 1.2, charges: [.32, .78, .58], followCharge: .78 },
  gojo: { speed: 355, steering: 650, spacing: 3.1, chargeTime: .83, cooldown: .72, missRecovery: .8, charges: [.42, .83, .62], followCharge: .83 },
  beast: { speed: 0, steering: 0, spacing: 3, chargeTime: .65, cooldown: .32, missRecovery: .75, charges: [.48, .85, .65], followCharge: .65 },
};

/** Whoever a fighter is squaring up to: the player, or another fighter seen through `Faora.asTarget`. */
export interface CombatTarget {
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  readonly speed: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly onGround: boolean;
  readonly flying: boolean;
  readonly inWater: boolean;
  readonly eyeLevel: number;
  readonly combatAttacking?: boolean;
  readonly combatAttackCharge?: number;
  readonly combatGuard?: number;
  readonly combatWhiff?: number;
  readonly vitals: Vitality;
  readonly launched?: boolean;
  readonly infinityProtects?: boolean;
  readonly castPose?: CastPose | null;
  readonly castProgress?: number;
  readonly chargeArmored?: boolean;
  readonly attackTarget?: CombatTarget | null;
}

/** Which ragdoll piece a loose model part falls into (mirrors Ragdoll's own split), so merging never moves a part between pieces. */
function ragdollPiece(mesh: THREE.Mesh): string {
  const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
  return center.y > 1.5 ? "head" : center.y < .8 ? (center.x < 0 ? "left" : "right") : "torso";
}

/** Collapse each rig's dozens of primitives into one mesh per material and limb: ~10x fewer draw calls per fighter.
 *  Transparent parts (guard shield, charge ring) stay separate because they toggle on their own. */
function mergeStatic(parent: THREE.Object3D, top = false) {
  parent.updateMatrixWorld(true);
  const buckets = new Map<string, THREE.Mesh[]>();
  for (const child of [...parent.children]) {
    if (!(child instanceof THREE.Mesh)) { mergeStatic(child); continue; }
    const material = child.material as THREE.Material;
    if (material.transparent || !child.geometry.index) continue;
    const key = material.uuid + (top ? ragdollPiece(child) : "");
    buckets.set(key, [...(buckets.get(key) ?? []), child]);
  }
  for (const parts of buckets.values()) {
    if (parts.length < 2) continue;
    const geometry = mergeGeometries(parts.map(part => {
      part.updateMatrix();
      const g = part.geometry.clone().applyMatrix4(part.matrix);
      for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
      return g;
    }));
    if (!geometry) continue;
    for (const part of parts) parent.remove(part);
    parent.add(new THREE.Mesh(geometry, parts[0].material));
  }
}

/** A wingmate who flies in formation with you, and fights when provoked or set as an enemy. */
export class Faora {
  readonly vitals: Vitality;
  onDefeated: () => void = () => {};
  onCombatHit: (hit: DamageHit) => void = () => {};
  onInjured: (strength: number, direction?: THREE.Vector3) => void = () => {};
  readonly model = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  private readonly orbImpulse = new THREE.Vector3();
  readonly trails = new Contrails();
  readonly ragdoll: Ragdoll;
  readonly doomsdayRig?: DoomsdayRig;
  private readonly doomsdayAnimation?: DoomsdayAnimation;
  /** Faora, Anissa and Battle Beast share one jointed rig and animation system; Doomsday keeps his own. */
  private motion?: FighterAnimation;
  private fighterRig?: FighterRig;
  private focus: CombatTarget | null = null;
  private riseTime = 0;
  private readonly poseInput: FighterPoseInput = {
    position: this.pos, velocity: this.vel, height: 0, airborne: false, engaged: false, guard: false, guardFlash: 0, flinch: 0,
    windup: 0, strike: 0, punch: "straight", ram: 0, grapple: null, crouch: 0, landing: 0, rise: 0, gesture: 0, hurt: 0,
    helping: false, held: false, look: new THREE.Vector3(), lookWeight: 0,
  };
  private doomsdayLanding = 0;
  private doomsdayPunch: PunchStyle = "straight";
  doomsdaySpecial: "beam-charge" | "beam" | "nova-charge" | "recovery" | null = null;
  readonly doomsdayAim = new THREE.Vector3(0,0,1);
  held = false;
  private escapeTime = 0;
  private escapeDuration = GRAB_ESCAPE_TIME;
  get escapeProgress() { return THREE.MathUtils.clamp(1 - this.escapeTime / this.escapeDuration, 0, 1); }
  private gripYawOffset = 0;
  private readonly gripPoint = new THREE.Vector3();
  private readonly gripOffset = new THREE.Vector3();
  interactions: Interactions|null = null;
  private ragdollTime = 0;
  private get knockdownDuration() { return this.isSukuna ? 2 : this.isDoomsday ? .9 : 4; }
  onSmash: (origin: THREE.Vector3, direction: THREE.Vector3, charge: number, knockback?: THREE.Vector3) => boolean = () => false;
  /** Returns true when the counterattack actually gets through the player's guard. */
  onGrab?: (target: CombatTarget) => boolean;
  private grappling = false;
  private grapplePose: "hold" | "punch" | "kick" | "throw" | null = null;
  private grapplePoseTime = 0;
  get canMaintainGrapple() {
    return this.grappling && this.availableToFight && this.staggerTime <= 0;
  }
  poseGrapple(action: "hold" | "punch" | "kick" | "throw" | null, direction: THREE.Vector3) {
    this.grappling = action !== null && action !== "throw";
    this.grapplePose = action;
    this.grapplePoseTime = action === "hold" ? Infinity : .28;
    if(action)this.forward.copy(direction);
  }
  onRam?: (target: CombatTarget, direction: THREE.Vector3, speed: number) => void;
  private ramTarget: CombatTarget | null = null;
  private thrownTarget: CombatTarget | null = null;
  private throwFollowTime = 0;
  private ramFollowsThrow = false;

  followThrownTarget(target: CombatTarget) {
    if (this.name !== "Anissa" || this.vitals.healthFraction * 100 <= ANISSA_RETREAT_HP || this.recovering) return;
    this.thrownTarget = target;
    this.throwFollowTime = 1.25;
  }
  private ramClock = 0;
  private ramCooldown = 0;
  private ramPose = 0;
  onCounterAttack: (direction: THREE.Vector3, charge: number, style: PunchStyle) => boolean = () => false;
  /** Contact-only leap snatch. Return true if the target's guard was overcome. */
  onPounceAttack: (target: CombatTarget) => boolean = () => false;
  onObstacleSmash: (direction: THREE.Vector3) => boolean = () => false;
  private readonly superBlock = new SuperBlock();
  get superBlocking() { return !this.hostile && this.superBlock.active; }
  onGuard: (fullyBlocked: boolean) => void = () => {};
  private readonly defense = new Combat();
  private guardVisual: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  /** 1 the instant her guard eats a hit, fading: the arms jolt and the shield flares. */
  private guardFlash = 0;
  get blocking() { return this.defense.mode === "guard"; }
  private angerTime = 0;
  private revengeHits = 0;
  private counterCooldown = 0;
  private counterCharge = 0;
  private threatTime = 0;
  private dodgeTime = 0;
  private dodgeCooldown = 0;
  private circleDirection = 1;
  private attacksAttempted = 0;
  private followUpTime = 0;
  private followUpTarget: CombatTarget | null = null;
  private previousFoe: CombatTarget | null = null;
  private previousFoeGuard = 0;
  private droppedGuardTime = 0;
  passive = false;
  enemyMode = false;
  private uppercutPose = 0;
  private strikePose = 0;
  /** > 0 while flinching from a hit she held her ground against. */
  private staggerTime = 0;
  private attackVisual: THREE.Mesh | null = null;
  state: FaoraState = "follow";
  visibleToPlayer = false;
  private elapsed = 0;
  private sightTick = 0;
  private gesture = 0;
  private forward = new THREE.Vector3(0, 0, 1);
  private rightArm = new THREE.Group();
  private leftArm = new THREE.Group();
  private rightForearm = new THREE.Group();
  private leftForearm = new THREE.Group();
  private leftLeg = new THREE.Group();
  private rightLeg = new THREE.Group();
  private jumping = false;
  private leapCooldown = .25;
  private pounceCheck = 0;
  private groundStuckTime = 0;
  private skipCooldown = 0;
  private evadeCooldown = 0;
  private evadeTime = 0;
  private tauntCooldown = 0;
  private sukunaMeleePressure = 0;
  private sukunaEscapeCooldown = 0;
  private readonly sukunaEscapeHeading = new THREE.Vector3();
  get isTaunting() { return this.isSukuna && this.gesture > 0 && this.staggerTime === 0; }
  onBlink: (from: THREE.Vector3, to: THREE.Vector3) => void = () => {};
  onTaunt: () => void = () => {};
  private lastGroundPosition = new THREE.Vector3();
  private beastJumpWindup = 0;
  private plannedJump: BeastJump | null = null;
  private jumpKind: "escape" | "pounce" | "snatch" | null = null;
  private pounceTarget: CombatTarget | null = null;
  private pounceSpent = false;
  private jumpLanding: THREE.Vector3 | null = null;
  private escapePerch: THREE.Vector3 | null = null;
  private breachWindup = 0;
  private breachCooldown = 0;
  private breachDirection = new THREE.Vector3();
  onLeap: () => void = () => {};
  onLand: (speed: number) => void = () => {};
  cursedHand(out: THREE.Vector3, left: boolean) {
    this.fighterRig?.hands[left ? 0 : 1].localToWorld(out.set(0, -.05, .06));
  }

  poseCursedStrike(kick: boolean) {
    this.strikePose = .32;
    this.doomsdayPunch = kick ? "down" : "straight";
    if (kick) {
      // Reuse the kick animation while keeping normal movement and gravity.
      this.grapplePose = "kick";
      this.grapplePoseTime = .28;
    } else this.motion?.contact("straight");
  }
  get isSukuna() { return this.name === "Sukuna"; }
  get isGojo() { return this.name === "Satoru Gojo"; }
  readonly infinity: GojoInfinity | null;
  readonly cursedEnergy: CursedEnergy | null;
  private readonly reserveAura: CursedReserveAura | null;
  onInfinityBlock: () => void = () => {};
  get infinityProtects() {
    return this.infinity?.active === true && !this.vitals.defeated && !this.vitals.frozen;
  }
  get cannotBeGrabbed() { return this.isSukuna || this.vitals.frozen || this.infinityProtects; }
  get isDoomsday(){return this.name==="Doomsday";}
  get bodyScale() { return this.isDoomsday ? 2.05 : this.name === "Battle Beast" ? 1.6 : 1; }
  get meleeStrengthMultiplier(){return this.isDoomsday ? 3.2 : this.isGojo ? 1.3 : this.isSukuna ? 1.25 : this.groundOnly ? 1.8 : 1;}
  specialAdvance=false;
  /** Sukuna's current hand sign, and how far through its release he is. */
  castPose: CastPose | null = null;
  castSwing = 0;
  specialChanneling=false;
  get hasSukunaChargeArmor() { return this.isSukuna && this.specialChanneling && this.specialCharge < 1; }
  novaExhausted=false;
  specialCharge=0;
  poiseRevision=0;
  get poiseThreshold() { return this.isSukuna ? SUKUNA_POISE_THRESHOLD : this.isDoomsday ? 95 : 1; }
  get attackCommitted(){return this.grappling || this.ramTarget !== null || this.thrownTarget !== null || this.specialChanneling || this.isDoomsday && (this.counterCharge>=.12 || this.strikePose>0);}
  private boostCooldown = 0;
  private target = new THREE.Vector3();
  private formationHeading = new THREE.Vector3();
  private meetingPoint: THREE.Vector3|null = null;
  private delta = new THREE.Vector3();
  private readonly route: PathFollower;
  private readonly groundPath: GroundPath;
  private readonly routeFrom = new THREE.Vector3();
  private readonly routeGoal = new THREE.Vector3();
  private eye = new THREE.Vector3();
  private playerEye = new THREE.Vector3();
  private combatSide = new THREE.Vector3(1, 0, 0);
  /** The player's velocity minus any part aimed at her: what she keeps pace with in a fight. */
  private paceVelocity = new THREE.Vector3();
  private buriedTime = 0;
  private injuryCooldown = 0;
  private get fightStyle() { return this.isGojo ? FIGHT_STYLES.gojo : this.isSukuna ? FIGHT_STYLES.sukuna : this.isDoomsday?FIGHT_STYLES.doomsday:this.groundOnly ? FIGHT_STYLES.beast : this.name === "Anissa" ? FIGHT_STYLES.anissa : FIGHT_STYLES.faora; }
  get groundOnly() { return this.name === "Battle Beast" || this.isDoomsday || this.isSukuna; }
  get hostile() { return !this.vitals.defeated && (this.enemyMode || this.angerTime > 0); }
  /** The fighter she's fighting, or null for the player (when hostile) / no one (when friendly). */
  opponent: Faora | null = null;
  rescueTarget: CombatTarget | null = null;
  rescueCountering = false;
  rescuePressure = false;
  rescueRecovery = false;
  supportAnchor: CombatTarget | null = null;
  trackedTargets: readonly CombatTarget[] = [];
  /** Seconds left of a recall order: a called-back friend stays out of fights. */
  recallTime = 0;
  /** Fighting anyone at all: the player, or an opponent fighter. */
  get engaged() { return !this.rescueTarget && (this.opponent !== null || this.hostile && this.canTargetPlayer()); }
  canTargetPlayer = () => true;
  retreating = false;
  /** Where to fly to leave an enemy domain (Gojo only), or null. */
  domainEscape: THREE.Vector3 | null = null;
  healing = false;
  private get recovering() { return this.retreating; }
  private damagePressure = 0;
  private recentDamageHits = 0;
  private retreatUntilHP = 0;
  private readonly retreatGoal = new THREE.Vector3();
  private retreatReplan = 0;
  private retreatSide = 1;
  get availableToFight() { return this.engaged && !this.recovering && !this.vitals.frozen && !this.held && !this.ragdoll.active; }
  /** She stands on something (for opponents deciding how to strike her). */
  private standing = true;
  private sprint = 0;
  private stridePhase = 0;
  onStomp: (speed: number) => void = () => {};
  /** How another fighter sees her: the same shape as the player, so one set of combat rules serves both. */
  readonly asTarget: CombatTarget = (() => {
    const self = this;
    return {
      get pos() { return self.pos; },
      get vel() { return self.vel; },
      get speed() { return self.vel.length(); },
      get yaw() { return Math.atan2(-self.forward.x, -self.forward.z); },
      get pitch() { return Math.asin(THREE.MathUtils.clamp(self.forward.y, -1, 1)); },
      get onGround() { return self.standing; },
      get flying() { return !self.standing; },
      inWater: false,
      get eyeLevel() { return self.pos.y + 1.6 * self.bodyScale; },
      get combatAttacking() { return self.ramTarget !== null || self.counterCharge > 0; },
      get combatAttackCharge() { return self.ramTarget ? .85 : self.counterCharge; },
      get combatGuard() { return self.blocking ? self.defense.guard : 0; },
      combatWhiff: 0,
      get vitals() { return self.vitals; },
      get launched() { return self.ragdoll.active; },
      get infinityProtects() { return self.infinityProtects; },
      get castPose() { return self.specialChanneling ? self.castPose : null; },
      get castProgress() { return self.specialCharge; },
      get chargeArmored() { return self.hasSukunaChargeArmor; },
      get attackTarget() { return self.opponent?.asTarget ?? self.focus; },
    };
  })();
  get availableToAttack() {
    return this.availableToFight && !this.blocking && this.dodgeTime <= 0 && (!this.isSukuna || this.staggerTime <= 0);
  }

  constructor(private world: Destruction, scene: THREE.Scene, readonly name = "Faora-Ul") {
    // Sorcerers 300 HP; Battle Beast and Doomsday 150 (they also resist most damage); Faora and Anissa 200.
    this.vitals = new Vitality(this.isGojo || this.isSukuna ? 300 : this.name === "Battle Beast" || this.isDoomsday ? 150 : 200, () => {
      if (this.ragdoll.active) this.ragdollTime *= .5;
    });
    this.cursedEnergy = this.isGojo || this.isSukuna ? new CursedEnergy(this.isGojo ? 5.5 : undefined) : null;
    this.infinity = this.isGojo ? new GojoInfinity(this.cursedEnergy!) : null;
    this.reserveAura = this.cursedEnergy ? new CursedReserveAura(this.isGojo) : null;
    if (this.isSukuna) this.vitals.damageScale = .7;
    else if (this.isGojo) this.vitals.damageScale = .82;
    else if (this.groundOnly) this.vitals.damageScale = this.isDoomsday?.1:.25;
    else if (this.name === "Anissa") this.vitals.damageScale = .8;
    this.groundPath = new GroundPath(world, this.bodyScale);
    if(this.isDoomsday){
      this.doomsdayRig = new DoomsdayRig(this.model,[this.leftArm,this.rightArm],[this.leftForearm,this.rightForearm],[this.leftLeg,this.rightLeg]);
      buildDoomsday(this.doomsdayRig);
      this.doomsdayAnimation = new DoomsdayAnimation(this.doomsdayRig);
    } else this.fighterRig = this.buildModel();
    this.guardVisual = new THREE.Mesh(new THREE.RingGeometry(.34, .42, 6), new THREE.MeshBasicMaterial({ color: 0x85d9ff, transparent: true, opacity: .45, depthWrite: false, side: THREE.DoubleSide }));
    this.guardVisual.position.set(0, 1.45, .55); // a hex shield over the crossed forearms
    this.guardVisual.visible = false;
    this.model.add(this.guardVisual);
    mergeStatic(this.model, true);
    this.ragdoll = new Ragdoll(this.model, world, this.bodyScale, this.doomsdayRig ?? this.fighterRig);
    this.motion?.bind();
    if (this.reserveAura) this.model.add(this.reserveAura.mesh);
    this.model.scale.setScalar(this.bodyScale);
    this.route = new PathFollower(new Pathfinder(world), undefined, this.isGojo ? .18 : 0);
    scene.add(this.model, this.trails.mesh);
  }

  revive(persistent=false, fromMenu=false):boolean {
    const health = fromMenu ? this.vitals.maxHealth : persistent ? this.vitals.maxHealth * .75 : undefined;
    if(!this.vitals.revive(health,!persistent && !fromMenu))return false;
    this.staggerTime = 0;
    this.orbImpulse.set(0, 0, 0);
    this.cursedEnergy?.reset();
    this.infinity?.reset();
    this.evadeCooldown = this.evadeTime = 0;
    this.superBlock.reset();
    this.ramTarget = this.thrownTarget = null;this.ramCooldown=0;this.ramPose=0;
    this.grappling=false;this.grapplePose=null;
    this.retreating = false;
    this.healing = false;
    this.recentDamageHits = this.damagePressure = this.retreatUntilHP = this.sukunaMeleePressure = this.sukunaEscapeCooldown = 0;
    if(this.ragdoll.active)this.ragdoll.stop();
    this.held=false;this.vel.set(0,0,0);this.jumping=false;this.ragdollTime=0;this.specialChanneling=false;this.specialAdvance=false;this.specialCharge=0;
    this.cancelBeastJump();this.breachWindup=0;this.defense.cancel();this.counterCharge=0;this.counterCooldown=.75;
    this.opponent=null;this.rescueTarget=null;this.recallTime=0;this.followUpTime=0;this.dodgeTime=0;
    this.groundPath.reset();this.route.reset();this.buriedTime=0;
    this.pos.y=Math.max(this.pos.y,this.world.spans(this.pos.x,this.pos.z).floor(this.pos.y+2)+.05);
    this.model.position.copy(this.pos);this.lastGroundPosition.copy(this.pos);
    this.state=this.hostile?"retaliate":"follow";
    return true;
  }

  spawn(x: number, z: number) {
    this.orbImpulse.set(0, 0, 0);
    this.cursedEnergy?.reset();
    this.infinity?.reset();
    this.skipCooldown = 0;
    this.evadeCooldown = this.evadeTime = 0;
    this.staggerTime = 0;
    this.tauntCooldown = 0;
    this.superBlock.reset();
    this.ramTarget = this.thrownTarget = null;this.ramCooldown=0;this.ramPose=0;
    this.grappling=false;this.grapplePose=null;
    this.retreating = false;
    this.healing = false;
    this.recentDamageHits = this.damagePressure = this.retreatUntilHP = this.sukunaMeleePressure = this.sukunaEscapeCooldown = 0;
    this.vitals.reset();
    this.enemyMode = false;
    this.angerTime = 0;
    this.revengeHits = 0;
    this.attacksAttempted = 0;
    this.counterCooldown = 0;
    this.followUpTime = 0; this.followUpTarget = null;
    this.previousFoe = null; this.previousFoeGuard = 0; this.droppedGuardTime = 0;
    this.rescueTarget=null;this.supportAnchor=null;this.specialChanneling=false;this.specialAdvance=false;this.specialCharge=0;
    this.cancelBeastJump(); this.escapePerch=null; this.pounceCheck = 0; this.groundStuckTime = 0;
    this.breachWindup=0;this.breachCooldown=0;this.groundPath.reset();
    if (this.ragdoll.active) this.ragdoll.stop();
    if(this.doomsdayAnimation){
      this.ragdoll.recover(1);
      this.doomsdayAnimation.reset();
      this.doomsdayLanding=0;
      this.doomsdaySpecial=null;
      this.doomsdayPunch="straight";
      this.strikePose=0;
    }
    if (this.motion) { this.ragdoll.recover(1); this.motion.reset(); this.doomsdayLanding = this.riseTime = this.strikePose = 0; }
    this.held = false;
    this.defense.cancel();
    this.jumping = false;
    this.leapCooldown = .25;
    this.counterCharge = 0;
    this.dodgeTime = 0;
    this.leapCooldown = .25;
    this.jumping = false;
    this.buriedTime = 0;
    if (this.attackVisual) this.attackVisual.visible = false;
    if (this.guardVisual) this.guardVisual.visible = false;
    this.pos.set(x, this.world.spans(x, z).top + (this.groundOnly ? .05 : 3), z);
    this.lastGroundPosition.copy(this.pos);
    this.model.position.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.state = "follow";
    this.route.reset();
    this.trails.emit(this.pos, 0, this.elapsed);
  }

  recall(player?: Player) {
    this.meetingPoint = null;
    this.recallTime = 4;
    this.opponent = null;
    this.followUpTime = 0; this.followUpTarget = null;
    if (this.beastJumpWindup > 0) this.cancelBeastJump();
    if (player) this.formationHeading.set(-Math.sin(player.yaw),0,-Math.cos(player.yaw));
    if (!this.ragdoll.active) this.state = "follow";
    this.gesture = 2;
  }

  setEnemyMode(enabled: boolean) {
    this.enemyMode = enabled;
    if (enabled) {
      this.angerTime = 25; this.revengeHits = 0; this.counterCooldown = .6;
      this.attacksAttempted = 0;
      this.meetingPoint = null;
      if (!this.ragdoll.active) this.state = "retaliate";
    } else if (this.angerTime > 0) this.calmDown();
  }

  private provoke() {
    const alreadyProvoked=this.isDoomsday && (this.enemyMode || this.angerTime>0);
    this.angerTime = 25;
    if(alreadyProvoked)return;
    this.revengeHits = 0;
    this.attacksAttempted = 0;
    this.counterCooldown = .6;
    this.counterCharge = 0;
    this.meetingPoint = null;
  }

  private calmDown() {
    if (this.angerTime <= 0) return;
    this.angerTime = 0;
    this.revengeHits = 0;
    this.counterCharge = 0;
    this.dodgeTime = 0;
    this.threatTime = 0;
    this.state = "follow";
  }

  /** Match a nearby player's charged jump, while preserving her own position and momentum. */
  jumpWith(player: Player, charge: number) {
    if (this.groundOnly || this.hostile && !this.canTargetPlayer()) return;
    if (this.held || this.ragdoll.active || this.state !== "follow" || charge < .15 || this.pos.distanceTo(player.pos) > 25) return;
    const floor = this.world.spans(this.pos.x, this.pos.z).floor(this.pos.y + .5);
    if (this.pos.y - floor > 1.5) return;
    this.jumping = true;
    this.pos.y = Math.max(this.pos.y, floor + .05);
    this.vel.copy(player.vel);
    this.gesture = .35;
    this.world.launch(this.pos, Math.min(300, Math.max(5, this.vel.y)), charge, this.world.materialAt(this.pos.x, floor - .05, this.pos.z));
  }

  private takeDamage(strength: number, direction?: THREE.Vector3, source: HitSource=terrainHit, multiplier=1) {
    if (this.superBlocking) return;
    if (this.hasSukunaChargeArmor) multiplier *= .1;
    const before=this.vitals.health;
    if(!this.vitals.hit(strength,multiplier*attackerMultiplier(source),bypassesDefenseStat(source)))return;
    const damage = before-this.vitals.health;
    this.damagePressure += damage;
    if (damage > 0) {
      this.cursedEnergy?.fromPain(damage);
      this.recentDamageHits++;
      if (this.isSukuna && SUKUNA_MELEE_HITS.has(source.action)) {
        this.sukunaMeleePressure++;
        if (direction) this.sukunaEscapeHeading.copy(direction).setY(0).normalize();
      }
    }
    if (this.held && damage > 0 && this.escapeDuration === GRAB_ESCAPE_TIME) {
      this.escapeTime = this.isDoomsday
        ? Math.min(GRAB_ESCAPE_TIME, this.escapeTime + damage * DOOMSDAY_ESCAPE_SECONDS_PER_HP)
        : GRAB_ESCAPE_TIME;
    }
    this.onInjured(strength,direction);
    this.onCombatHit({source,damage,outcome:this.vitals.eliminated?"out":this.vitals.defeated?"down":"hit"});
  }

  strike(direction: THREE.Vector3, inherited: THREE.Vector3, speed = 260, playerCaused = false, strength = Math.max(0, speed / 2.6), damageMultiplier=1, source: HitSource=playerCaused?playerHit("punch"):terrainHit, heldCharge?: number): boolean {
    if (this.vitals.defeated || this.vitals.frozen || this.vitals.inReviveGrace) return false;
    if (this.infinity?.absorb(strength, source)) {
      if (playerCaused && !this.passive) this.provoke();
      this.onInfinityBlock();
      return false;
    }
    if ((source.action === "beam" || source.action === "shockwave") && this.dodgeIncoming(direction)) return false;
    const guarding = this.blocking && !this.held && !this.ragdoll.active;
    if (!this.hostile && !playerCaused && strength >= 85) this.superBlock.activate(guarding);
    if (this.superBlocking) {
      this.guardFlash = 1;
      this.onGuard(true);
      return false;
    }
    const ram = source.action === "ram";
    const remaining = guarding ? this.defense.defend(strength) : 1;
    const guardScale = ram && guarding ? RAM_BLOCK_DAMAGE : 1;
    if (playerCaused && !this.passive) this.provoke();
    if (guarding) { this.onGuard(remaining === 0); this.guardFlash = 1; }
    // A fighter squared up to you can bat away a light, unguarded jab instead of eating every one.
    if (!this.isDoomsday && !guarding && playerCaused && strength <= 30 && this.state === "retaliate" && !this.held && !this.ragdoll.active
      && Math.random() < (this.name === "Anissa" ? .35 : .25)) {
      this.onGuard(true);
      return false;
    }
    if (remaining <= 0) return false;
    // Same rules as the player: only her guard reduces what gets through.
    const resistance = remaining, through = strength * resistance * guardScale;
    this.takeDamage(through,direction,source,damageMultiplier * guardScale);
    if (this.hasSukunaChargeArmor && !this.vitals.defeated) return true;
    const doomsdayBeam = this.isSukuna && source.name === "Doomsday" && source.action === "beam";
    const doomsdayNova = this.isSukuna && source.name === "Doomsday" && source.action === "nova";
    const armoredTap = this.isDoomsday && playerCaused && heldCharge !== undefined && heldCharge < MELEE_CHARGE_THRESHOLD;
    const breaksPoise = !armoredTap && !doomsdayBeam && through >= this.poiseThreshold;
    if (breaksPoise) {
      this.cancelBeastJump();this.breachWindup=0;
      if (this.isDoomsday || this.isSukuna) this.poiseRevision++;
    }
    if ((doomsdayBeam || doomsdayNova) && !this.vitals.defeated) {
      if (!this.ragdoll.active) {
        this.applyDoomsdayShove(direction, speed * resistance * (doomsdayNova ? .08 : .025));
        if (breaksPoise) this.flinchFromHit();
      }
      return true;
    }
    const ramBoost = ram ? speed * RAM_TRANSFER * resistance * guardScale : 0;
    // A full-charge melee hit can dislodge Doomsday from a grab with a short shove.
    const grabKnockdown = this.isDoomsday && this.held && playerCaused && !armoredTap && through >= 100
      && (source.action === "punch" || source.action === "smash" || source.action === "kick");
    const launchThreshold = this.isSukuna ? SUKUNA_LAUNCH_THRESHOLD : this.isDoomsday ? 140 : this.name === "Battle Beast" ? 85 : STAGGER_LIMIT;
    const launch = grabKnockdown ? 10 : armoredTap ? 0 : launchSpeed(speed * resistance * (ram ? 2 : 1), through, launchThreshold);
    if (this.held && launch === 0 && !this.vitals.defeated) return true;
    // Light hits damage these fighters without changing their ragdoll motion.
    if((this.isDoomsday || this.isSukuna) && launch===0 && this.ragdoll.active && !this.vitals.defeated && !this.held){
      if(ram){
        this.vel.addScaledVector(direction,ramBoost);
        for(const velocity of this.ragdoll.velocity)velocity.addScaledVector(direction,ramBoost);
      }
      return true;
    }
    if (launch === 0 && !this.vitals.defeated && !this.held && !this.ragdoll.active) {
      if (!armoredTap) this.vel.addScaledVector(direction, ram ? ramBoost : Math.min(speed * resistance, breaksPoise ? STAGGER_PUSH : this.isSukuna ? 2 : this.isDoomsday ? 1 : STAGGER_PUSH));
      if (breaksPoise) this.flinchFromHit();
      return true;
    }
    this.jumping = false;
    this.held = false;
    this.ragdoll.anchor = null;
    this.ramTarget = null;
    if(ram) this.vel.addScaledVector(direction,ramBoost);
    else {
      this.vel.copy(inherited).multiplyScalar(resistance).addScaledVector(direction, launch);
      this.vel.y += Math.min(15, launch * .1);
    }
    if (!this.ragdoll.active) this.ragdollTime = grabKnockdown ? 2 : this.knockdownDuration;
    this.ragdoll.start(this.vel);
    this.state = "ragdoll";
    this.defense.cancel();
    this.counterCharge = 0;
    if (this.attackVisual) this.attackVisual.visible = false;
    if (this.guardVisual) this.guardVisual.visible = false;
    if (this.vitals.defeated) this.onDefeated();
    return true;
  }

  private flinchFromHit() {
    this.staggerTime = this.isSukuna ? SUKUNA_STAGGER_TIME : STAGGER_TIME;
    this.ramTarget = null;
    this.counterCharge = 0;
    this.counterCooldown = Math.max(this.counterCooldown, this.isSukuna ? .28 : .5);
  }

  applyOrbImpulse(direction: THREE.Vector3, impulse: number) {
    if (this.held || this.grappling || this.vitals.defeated || this.vitals.frozen
      || this.vitals.inReviveGrace || this.superBlocking || this.infinityProtects) return;
    this.orbImpulse.addScaledVector(direction, impulse);
  }

  dodgeIncoming(direction: THREE.Vector3): boolean {
    if (!this.isSukuna || this.held || this.vitals.defeated || this.ragdoll.active) return false;
    if (this.evadeTime > 0) return true;
    if (this.evadeCooldown > 0 || this.staggerTime > 0 || this.specialChanneling) return false;
    if (!this.cursedEnergy?.canSpend(CURSED_COST.blink)) return false;
    const side = new THREE.Vector3(-direction.z, 0, direction.x);
    if (side.lengthSq() < .001) side.set(this.forward.z, 0, -this.forward.x);
    if (side.lengthSq() < .001) side.set(1, 0, 0);
    side.normalize();
    const from = this.pos.clone();
    const chest = from.clone().addScaledVector(UP, .9);
    const dest = new THREE.Vector3();
    for (const offset of [7, -7, 4, -4]) {
      dest.copy(from).addScaledVector(side, offset);
      if (!this.lineClear(chest, dest.clone().addScaledVector(UP, .9))) continue;
      const spans = this.world.spans(dest.x, dest.z);
      const floor = spans.floor(dest.y + .5);
      if (!Number.isFinite(floor) || floor > dest.y + .5 || spans.water) continue;
      dest.y = Math.max(dest.y, floor + .05);
      if (spans.solid(dest.y + .1) || spans.ceil(dest.y + .1) < dest.y + BODY * this.bodyScale) continue;
      this.cursedEnergy.spend(CURSED_COST.blink);
      this.pos.copy(dest);
      this.model.position.copy(dest);
      this.vel.x = this.vel.z = 0;
      this.groundPath.reset();
      this.lastGroundPosition.copy(dest);
      this.groundStuckTime = 0;
      this.evadeCooldown = 2.8;
      this.evadeTime = .22;
      this.onBlink(from, this.pos);
      return true;
    }
    return false;
  }

  applyDoomsdayShove(direction: THREE.Vector3, impulse: number) {
    const push = this.delta.copy(direction).setY(0);
    if (push.lengthSq() > .001) {
      push.normalize();
      const room = Math.max(0, 36 - this.vel.dot(push));
      this.vel.addScaledVector(push, Math.min(room, impulse));
    }
    this.vel.y = Math.min(this.vel.y, 0);
  }

  setHeld(held: boolean, escapeDuration = GRAB_ESCAPE_TIME) {
    if (this.held === held || (held && this.cannotBeGrabbed)) return;
    this.ramTarget = null;
    this.cancelBeastJump();
    this.breachWindup = 0;
    this.jumping = false;
    this.defense.cancel();
    this.counterCharge = 0;
    if (this.attackVisual) this.attackVisual.visible = false;
    if (this.guardVisual) this.guardVisual.visible = false;
    this.held = held;
    if (held) {
      this.ragdoll.stop();
      this.ragdoll.recover(.45);
      this.model.position.copy(this.pos);
      this.escapeTime = this.escapeDuration = escapeDuration;
      this.state = "carried";
    } else {
      this.ragdoll.start(this.vel);
      this.ragdollTime = this.knockdownDuration;
      this.state = "ragdoll";
    }
  }

  setGripPoint(point: THREE.Vector3, holderYaw: number) {
    this.gripYawOffset = this.model.rotation.y - holderYaw;
    this.gripPoint.copy(point);
    this.model.worldToLocal(this.gripPoint);
  }

  /** World position of an eye (0 left, 1 right), following the head wherever it turns. */
  eyePosition(index: number, out: THREE.Vector3) {
    if (this.fighterRig) return this.fighterRig.head.localToWorld(out.set(index ? .037 : -.037, .163, .112));
    return this.model.localToWorld(out.set(index ? .048 : -.048, 1.737, .134));
  }

  grabPosition(out: THREE.Vector3) {
    return this.model.localToWorld(out.copy(this.gripPoint));
  }

  moveHeld(point: THREE.Vector3, velocity: THREE.Vector3, holderYaw: number) {
    if (this.vitals.frozen) return;
    if (!this.held) return;
    this.model.rotation.y = holderYaw + this.gripYawOffset;
    this.grabPosition(this.gripOffset);
    this.pos.add(this.gripOffset.subVectors(point, this.gripOffset));
    const floor = this.world.spans(this.pos.x, this.pos.z).floor(this.pos.y + .5);
    this.pos.y = Math.max(this.pos.y, floor + .05);
    this.vel.copy(velocity);
    this.model.position.copy(this.pos);
  }

  release(direction: THREE.Vector3, inherited: THREE.Vector3) {
    this.vel.copy(inherited).addScaledVector(direction, 230);
    this.setHeld(false);
  }

  lineClear(from: THREE.Vector3, to: THREE.Vector3): boolean {
    return this.firstBlock(from, to) >= 1;
  }

  blinkGojoToward(target: CombatTarget) {
    if (!this.isGojo || !this.availableToAttack || this.specialChanneling) return false;
    if (!this.cursedEnergy?.canSpend(CURSED_COST.blink)) return false;
    const approach = this.pos.clone().sub(target.pos).setY(0);
    if (approach.lengthSq() < .01) approach.set(0, 0, 1);
    approach.normalize();
    const destination = new THREE.Vector3(), eye = new THREE.Vector3();
    const targetEye = target.pos.clone().addScaledVector(UP, 1);
    for (const side of [Math.PI / 3, -Math.PI / 3, 0]) {
      destination.copy(approach).applyAxisAngle(UP, side).multiplyScalar(24).add(target.pos);
      const floor = this.world.spans(destination.x, destination.z).floor(destination.y + 2);
      destination.y = Math.max(destination.y + .8, floor + .15);
      if (destination.y > target.pos.y + 6) continue;
      const fits = [[0, 0], [.34, 0], [-.34, 0], [0, .34], [0, -.34]].every(([x, z]) => {
        const column = this.world.spans(destination.x + x, destination.z + z);
        return !column.solid(destination.y + .15) && column.ceil(destination.y + .15) > destination.y + BODY;
      });
      if (!fits || !this.lineClear(eye.copy(destination).addScaledVector(UP, 1.3), targetEye)) continue;
      this.cursedEnergy.spend(CURSED_COST.blink);
      const from = this.pos.clone();
      this.pos.copy(destination);
      this.model.position.copy(this.pos);
      this.vel.set(0, 0, 0);
      this.forward.subVectors(target.pos, this.pos).normalize();
      this.route.reset();
      this.onBlink(from, this.pos);
      return true;
    }
    return false;
  }

  domainWall?: (from: THREE.Vector3, to: THREE.Vector3) => number;

  /** Fraction of the way from `from` to `to` at the first solid sample, or 1 when the line is clear. */
  firstBlock(from: THREE.Vector3, to: THREE.Vector3): number {
    const barrier = this.domainWall?.(from, to) ?? 1;
    const distance = from.distanceTo(to);
    // Half-metre steps up close, at most 128 samples further out: walls are thicker than a step.
    const spacing = Math.min(2, Math.max(0.5, distance / 128));
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (t >= barrier) break;
      if (this.world.spans(THREE.MathUtils.lerp(from.x, to.x, t), THREE.MathUtils.lerp(from.z, to.z, t))
        .solid(THREE.MathUtils.lerp(from.y, to.y, t))) return (i - 1) / steps;
    }
    return barrier;
  }

  private skipToward(target: CombatTarget, rescuing: boolean, blink = false) {
    if (blink && !this.cursedEnergy?.canSpend(CURSED_COST.blink)) return;
    const direction = this.pos.clone().sub(target.pos).setY(0);
    if (!blink && direction.lengthSq() < BEAST_SKIP_DISTANCE ** 2) return;
    if (direction.lengthSq() < .01) direction.set(1, 0, 0);
    direction.normalize();
    const bodyHeight = BODY * this.bodyScale;
    const width = .55 * this.bodyScale;
    const destination = new THREE.Vector3();
    for (const radius of rescuing ? [2.5, 5, 12, 24] : blink ? [4.5, 7, 12] : [18, 26, 40]) {
      for (const angle of blink ? [Math.PI / 2, -Math.PI / 2, Math.PI, 0] : [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI]) {
        destination.copy(direction).applyAxisAngle(UP, angle).multiplyScalar(radius).add(target.pos);
        const column = this.world.spans(destination.x, destination.z);
        const floor = column.floor(target.pos.y + 2);
        if (!Number.isFinite(floor) || (rescuing && Math.abs(floor - target.pos.y) > 3)) continue;
        const fits = [[0, 0], [width, width], [width, -width], [-width, width], [-width, -width]].every(([x, z]) => {
          const side = this.world.spans(destination.x + x, destination.z + z);
          return !side.water && Math.abs(side.floor(floor + .5) - floor) < .5
            && !side.solid(floor + .1) && side.ceil(floor + .1) >= floor + bodyHeight + .1;
        });
        if (!fits) continue;
        if (blink && !this.lineClear(destination.setY(floor + 1.35), target.pos.clone().addScaledVector(UP, 1))) continue;
        const departure = blink ? this.pos.clone() : null;
        this.pos.set(destination.x, floor + .05, destination.z);
        this.model.position.copy(this.pos);
        this.vel.set(0, 0, 0);
        this.groundPath.reset();
        this.lastGroundPosition.copy(this.pos);
        this.groundStuckTime = 0;
        this.escapePerch = null;
        this.sprint = 0;
        this.counterCharge = 0;
        this.skipCooldown = blink ? SUKUNA_BLINK_COOLDOWN : BEAST_SKIP_COOLDOWN;
        if (departure) {
          this.cursedEnergy?.spend(CURSED_COST.blink);
          this.jumping = false;
          this.cancelBeastJump();
          this.riseTime = 0;
          this.onBlink(departure, this.pos);
        }
        return;
      }
    }
    this.skipCooldown = 1;
  }

  /** Recover only from sustained solid penetration, not from a normal indoor space. */
  private recoverFromTerrain(dt: number): boolean {
    if (this.held) { this.buriedTime = 0; return false; }
    let embedded = 0;
    if (this.ragdoll.active) {
      for (const index of [0, 1, 2]) {
        const joint = this.ragdoll.joints[index];
        if (this.world.spans(joint.x, joint.z).solid(joint.y)) embedded++;
      }
    } else {
      const column = this.world.spans(this.pos.x, this.pos.z);
      for (const height of [.3, .95, 1.6]) if (column.solid(this.pos.y + height)) embedded++;
    }
    this.buriedTime = embedded >= 2 ? this.buriedTime + dt : 0;
    if (this.buriedTime < .8) return false;
    let surface = -Infinity;
    for (const [x, z] of [[0, 0], [.6, 0], [-.6, 0], [0, .6], [0, -.6]]) {
      surface = Math.max(surface, this.world.spans(this.pos.x + x, this.pos.z + z).top);
    }
    if (!Number.isFinite(surface)) { this.buriedTime = 0; return false; }
    if (this.ragdoll.active) this.ragdoll.stop();
    this.pos.y = surface + (this.groundOnly ? .1 : 25);
    this.cancelBeastJump();this.breachWindup=0;this.escapePerch=null;
    this.groundPath.reset();this.lastGroundPosition.copy(this.pos);this.groundStuckTime=0;
    this.model.position.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.jumping = false;
    this.leapCooldown = .25;
    this.counterCharge = 0;
    this.buriedTime = 0;
    this.state = this.enemyMode || this.angerTime > 0 ? "retaliate" : "follow";
    this.trails.emit(this.pos, 0, this.elapsed);
    return true;
  }

  update(dt: number, player: Player, fog?: THREE.FogExp2, elapsed = dt) {
    if (this.vitals.frozen) { this.vel.set(0, 0, 0); this.orbImpulse.set(0, 0, 0); return; }
    if (this.reserveAura && this.cursedEnergy) this.reserveAura.update(dt, this.vitals.defeated ? 0 : this.cursedEnergy.auraLevel);
    this.superBlock.update(elapsed);
    this.elapsed += dt;
    this.injuryCooldown = Math.max(0, this.injuryCooldown - dt);
    const passiveRecovery = this.cursedEnergy === null;
    const lowHealth = this.vitals.healthFraction <= (this.isDoomsday ? .15 : this.name === "Anissa" ? ANISSA_RETREAT_HP / 100 : .3);
    this.vitals.update(dt,this.blocking && !this.held && !this.ragdoll.active, passiveRecovery);
    const pressureDecay = Math.exp(-dt/PRESSURE_DECAY_SECONDS);
    this.damagePressure *= pressureDecay;
    this.recentDamageHits *= pressureDecay;
    this.sukunaMeleePressure *= pressureDecay * pressureDecay;
    if (this.vitals.defeated) {
      this.orbImpulse.set(0, 0, 0);
      if (this.ragdoll.active) { this.motion?.release(); this.ragdoll.update(dt, this.pos, this.vel); }
      return;
    }
    if (this.held) {
      this.orbImpulse.set(0, 0, 0);
      this.escapeTime -= dt;
      if (this.escapeTime > 1e-6) {
        if (this.motion) { this.animate(dt); return; }
        const struggle = this.elapsed * 13;
        this.model.rotation.x = .2 + Math.sin(struggle) * .16;
        this.model.rotation.z = Math.sin(struggle * .65) * .22;
        this.leftArm.rotation.set(-.85 + Math.sin(struggle) * .5, 0, -.6);
        this.rightArm.rotation.set(-.85 + Math.cos(struggle) * .5, 0, .6);
        this.leftForearm.rotation.x = -1.25 + Math.cos(struggle) * .35;
        this.rightForearm.rotation.x = -1.25 + Math.sin(struggle) * .35;
        this.leftLeg.rotation.x = Math.sin(struggle) * .65;
        this.rightLeg.rotation.x = -Math.sin(struggle) * .65;
        if(this.doomsdayRig){
          this.doomsdayRig.shins[0].rotation.x=.56+Math.cos(struggle)*.42;
          this.doomsdayRig.shins[1].rotation.x=.56-Math.cos(struggle)*.42;
          this.doomsdayRig.jaw.rotation.x=.42+Math.sin(struggle)*.15;
        }
        return;
      }
      this.held = false;
      this.state = this.hostile ? "retaliate" : "follow";
      this.vel.clampLength(0, 20);
    }
    if (this.recoverFromTerrain(dt)) return;
    if (this.ragdoll.active) {
      this.vel.add(this.orbImpulse);
      for (const velocity of this.ragdoll.velocity) velocity.add(this.orbImpulse);
      this.orbImpulse.set(0, 0, 0);
      const previous = this.vel.length();
      this.motion?.release();
      this.ragdoll.update(dt, this.pos, this.vel);
      if (!this.held && previous > 40 && previous - this.vel.length() > 30) {
        if (this.injuryCooldown <= 0) {
          const strength = (previous - this.vel.length()) * .35;
          this.takeDamage(strength);
          this.injuryCooldown = .5;
          if (this.vitals.defeated) { this.onDefeated(); return; }
        }
        const floor = this.world.spans(this.pos.x, this.pos.z).floor(this.pos.y + 1);
        if (Math.abs(this.pos.y - floor) < 3) this.world.crater(this.pos.clone().setY(floor), UP, previous * .5, this.world.materialAt(this.pos.x, floor-.1, this.pos.z));
      }
      this.ragdollTime = Math.max(0, this.ragdollTime - dt);
      this.trails.emit(this.pos, 0, this.elapsed);
      this.trails.uniforms.uTime.value = this.elapsed;
      this.sightTick -= dt;
      if (this.sightTick <= 0) {
        this.eye.copy(this.pos).addScaledVector(UP, 1.65);
        this.playerEye.copy(player.pos).addScaledVector(UP, 1.6);
        this.visibleToPlayer = this.lineClear(this.playerEye, this.eye);
        this.sightTick = .15;
      }
      const floor = this.world.spans(this.pos.x, this.pos.z).floor(this.pos.y + (this.isSukuna ? .05 : 2));
      const canRise = this.isSukuna
        ? Number.isFinite(floor) && this.pos.y - floor <= .35 && this.vel.y <= 1
        : this.isDoomsday || this.vel.length() < 70 || this.angerTime > 0;
      if (!this.held && this.ragdollTime <= 0 && canRise) {
        this.ragdoll.stop();
        this.riseTime = RISE_TIME;
        this.pos.y = Math.max(this.pos.y, floor);
        this.vel.multiplyScalar(.2);
        this.state = this.angerTime > 0 ? "retaliate" : "follow";
      }
      return;
    }
    this.ragdoll.recover(dt);
    if (this.angerTime > 0 && !this.enemyMode) {
      if (dt >= this.angerTime) this.calmDown();
      else this.angerTime -= dt;
    }
    this.counterCooldown = Math.max(0, this.counterCooldown - dt);
    this.dodgeTime = Math.max(0, this.dodgeTime - dt);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.boostCooldown = Math.max(0, this.boostCooldown - dt);
    this.gesture = Math.max(0, this.gesture - dt);
    this.uppercutPose = Math.max(0, this.uppercutPose - dt);
    this.strikePose = Math.max(0, this.strikePose - dt);
    this.doomsdayLanding = Math.max(0,this.doomsdayLanding-dt/.42);
    this.riseTime = Math.max(0, this.riseTime - dt);
    this.staggerTime = Math.max(0, this.staggerTime - dt);
    this.skipCooldown = Math.max(0, this.skipCooldown - dt);
    this.evadeCooldown = Math.max(0, this.evadeCooldown - dt);
    this.evadeTime = Math.max(0, this.evadeTime - dt);
    this.tauntCooldown = Math.max(0, this.tauntCooldown - dt);
    if (this.grapplePoseTime > 0) {
      this.grapplePoseTime -= dt;
      if(this.grapplePoseTime <= 0)this.grapplePose = this.grappling ? "hold" : null;
    }
    this.recallTime = Math.max(0, this.recallTime - dt);
    // Everything about the fight below is relative to `foe`; following and sight stay with the player.
    const foe: CombatTarget = this.rescueTarget ?? this.opponent?.asTarget ?? player;
    const idleHostile = this.hostile && !this.engaged && !this.rescueTarget;
    this.focus = idleHostile ? null : foe;
    if (this.pounceTarget === player && !this.canTargetPlayer()) this.cancelBeastJump();
    const style = this.fightStyle;
    const isAnissa = this.name === "Anissa";
    const isBattleBeast = this.name === "Battle Beast";
    this.throwFollowTime = Math.max(0,this.throwFollowTime-dt);
    if (this.thrownTarget !== foe || this.throwFollowTime === 0 || foe.vitals?.defeated) this.thrownTarget = null;
    const rage = this.rescuePressure && !this.rescueRecovery ? 1.35 : this.groundOnly && this.vitals.healthFraction < .45 ? 1.2 : 1;
    this.followUpTime = Math.max(0, this.followUpTime - dt);
    this.droppedGuardTime = Math.max(0, this.droppedGuardTime - dt);
    if (this.previousFoe !== foe) {
      this.previousFoe = foe; this.previousFoeGuard = 0; this.droppedGuardTime = 0;
      this.followUpTime = 0; this.followUpTarget = null; this.counterCharge = 0;
    }
    const guard = foe.combatGuard ?? 0;
    if (this.previousFoeGuard >= 20 && guard < 10) this.droppedGuardTime = .75;
    this.previousFoeGuard = guard;
    const followingLaunch = this.followUpTime > 0 && this.followUpTarget === foe && foe.launched === true;
    const opening = (foe.combatWhiff ?? 0) > 0 || this.droppedGuardTime > 0;
    // A missed swing still leaves her vulnerable even when she sees your opening.
    if (opening && this.strikePose <= 0 && this.counterCooldown < style.cooldown) this.counterCooldown = Math.min(this.counterCooldown, .15);
    const foeVisible = foe === player ? this.visibleToPlayer : true;
    const distanceToPlayer = this.pos.distanceTo(foe.pos);
    const toFriend = this.pos.clone().sub(foe.pos);
    const cp = Math.cos(foe.pitch);
    const playerAim = new THREE.Vector3(-Math.sin(foe.yaw) * cp, Math.sin(foe.pitch), -Math.cos(foe.yaw) * cp);
    const aimedAtHer = distanceToPlayer < 40 && toFriend.lengthSq() > .01 && playerAim.dot(toFriend.normalize()) > .75;
    const incomingProp = (this.interactions?.props ?? []).some(prop => {
      if (prop.held || prop.vel.lengthSq() < 225) return false;
      const toward = this.pos.clone().sub(prop.pos);
      return toward.lengthSq() < 1600 && prop.vel.dot(toward.normalize()) > 10;
    });
    // She reacts to what she can see: a fist visibly wound up (not the instant the button goes down), after a human-ish delay.
    const windup = !idleHostile && foe.combatAttacking && (foe.combatAttackCharge ?? 0) >= .2 && aimedAtHer && foeVisible;
    const threat = !this.rescueTarget && (windup || incomingProp);
    this.threatTime = threat ? this.threatTime + dt : 0;
    const reactive = this.threatTime >= (this.name === "Anissa" ? .22 : .32);
    // Holding a charge on her for long stops working: she drops the guard and moves or swings instead of turtling.
    const stalled = windup && this.threatTime > 1.5;
    const committed = this.counterCharge >= .12 || this.ramTarget !== null;
    if (!this.groundOnly && this.state === "retaliate" && !committed && stalled && this.dodgeCooldown <= 0 && this.dodgeTime <= 0) {
      this.dodgeTime = .7;
      this.dodgeCooldown = this.name === "Anissa" ? 3.5 : 2.5;
      this.circleDirection *= -1;
    }
    const heavyWindup = foe.combatAttacking && (foe.combatAttackCharge ?? 0) >= .55;
    if (!this.groundOnly && this.state === "retaliate" && !committed && reactive && heavyWindup && distanceToPlayer < 30 && this.dodgeCooldown <= 0 && this.dodgeTime <= 0) {
      this.dodgeTime = .7;
      this.dodgeCooldown = this.name === "Anissa" ? 3.5 : 2.5;
      this.circleDirection *= -1;
    }
    const canRetreat = !this.rescueCountering && !((this.isSukuna || this.isGojo) && this.specialChanneling) && this.engaged && !foe.vitals?.defeated && this.recallTime <= 0;
    const pressureThreshold = this.isGojo && this.vitals.healthFraction >= .45 ? 52 : this.isDoomsday ? 25 : 20;
    const underPressure = this.recentDamageHits >= 1.5 && this.damagePressure >= pressureThreshold;
    const needsRecovery = passiveRecovery && (this.rescueRecovery || lowHealth && (isAnissa || !this.attackCommitted));
    const recoveryComplete = !passiveRecovery || this.vitals.health >= this.retreatUntilHP;
    if (!canRetreat || (this.retreating && recoveryComplete && !underPressure)) {
      this.retreating = false;
    } else if (!this.retreating && (underPressure || needsRecovery)) {
      this.retreating = true;
      if (passiveRecovery) {
        const emergencyGoal = this.vitals.maxHealth * (this.isDoomsday ? .4 : .55);
        this.retreatUntilHP = underPressure ? Math.min(this.vitals.maxHealth, Math.max(emergencyGoal, this.vitals.health + 15)) : emergencyGoal;
      }
      if (isAnissa) {
        this.ramTarget = this.thrownTarget = null;
        this.ramPose = 0;
        this.poseGrapple(null,this.forward);
      }
      this.specialChanneling = this.specialAdvance = false;
      this.specialCharge = 0;
      this.route.reset();
      this.retreatGoal.copy(this.pos);
      this.retreatReplan = 0;
      this.counterCharge = 0;
      this.dodgeTime = 0;
      this.cancelBeastJump();
      this.breachWindup = 0;
      this.escapePerch = null;
    }
    // Quiet recovery runs alongside scouting, formation travel and withdrawal.
    const safeToHeal = !this.engaged || foe.vitals?.defeated || distanceToPlayer >= (this.retreating ? 14 : 24);
    this.healing = passiveRecovery && this.vitals.health < this.vitals.maxHealth && !this.rescueTarget && safeToHeal && !threat
      && (this.retreating || !committed && !this.attackCommitted);
    if (this.healing) this.vitals.recoverWhenQuiet(dt,RECOVERY_RATE,1.5);
    if (!this.hostile && !this.rescueTarget && windup && reactive && heavyWindup && !committed) {
      this.superBlock.activate(true);
    }
    const recoveryGuard = passiveRecovery && (this.recovering || (this.healing && !this.engaged && this.vel.lengthSq() < 4));
    const pressing = this.isGojo && this.engaged && this.vitals.healthFraction >= .45;
    const needsGuard = !pressing || incomingProp || (heavyWindup && !this.infinityProtects);
    const reactiveGuard = !this.groundOnly && !committed && threat && reactive && !stalled && this.dodgeTime <= 0 && needsGuard;
    const wantsGuard = this.superBlocking || recoveryGuard || reactiveGuard;
    if (wantsGuard && !this.blocking) this.defense.begin("guard");
    else if (!wantsGuard && this.blocking) this.defense.end("guard");
    this.defense.update(dt * this.vitals.control, false);
    if (this.guardVisual) this.guardVisual.visible = this.blocking;
    const travelling = !idleHostile && player.speed > 8;
    const underOrbForce = this.orbImpulse.lengthSq() > 1e-6;
    const steeringControl = underOrbForce ? .12 : 1;
    this.state = this.engaged ? "retaliate" : "follow";
    if (this.name === "Battle Beast" && this.skipCooldown === 0 && !this.retreating && !underOrbForce
      && !this.jumping && this.beastJumpWindup === 0 && this.breachWindup === 0 && this.staggerTime === 0
      && (this.rescueTarget || (this.engaged && !foe.vitals?.defeated))) {
      this.skipToward(foe, this.rescueTarget !== null);
    }
    if (this.grappling || (isAnissa && this.onGrab && this.engaged && !this.recovering
      && !this.blocking && this.staggerTime <= 0 && this.counterCharge === 0 && !this.ramTarget && !this.thrownTarget && this.ramPose <= 0
      && distanceToPlayer <= 3.6 && this.onGrab(foe))) {
      this.orbImpulse.set(0, 0, 0);
      this.animate(dt);
      return;
    }
    if (isAnissa && this.onRam && this.updateRam(dt, foe, distanceToPlayer)) return;
    if (this.isSukuna && this.engaged && !this.specialChanneling && !this.retreating && !this.jumping && !underOrbForce
      && this.skipCooldown === 0 && this.staggerTime === 0 && !foe.vitals?.defeated
      && (distanceToPlayer >= 55 || (distanceToPlayer > 9 && this.groundStuckTime > .65))) {
      this.skipToward(foe, false, true);
    }
    if (this.isSukuna && this.engaged && !this.specialChanneling && !this.retreating
      && !foe.vitals?.defeated && this.standing && this.staggerTime === 0 && !this.blocking
      && this.tauntCooldown === 0 && this.vel.lengthSq() < 9 && distanceToPlayer > 9 && distanceToPlayer < 65) {
      this.gesture = .5;
      this.tauntCooldown = 11;
      this.onTaunt();
    }
    if (this.domainEscape && !this.groundOnly) {
      this.target.copy(this.domainEscape);
      const floor = this.world.spans(this.target.x, this.target.z).floor(this.target.y + 1);
      this.target.y = Math.max(this.target.y, floor + .05);
      this.paceVelocity.set(0, 0, 0);
    } else if (this.retreating) {
      const initialRoute = this.retreatReplan === 0;
      this.retreatReplan -= dt;
      const blocked = this.groundOnly ? this.groundStuckTime > .55 : this.route.stuckTime > .55;
      if (this.retreatReplan <= 0 && (distanceToPlayer < 40 || blocked || initialRoute)) {
        this.delta.subVectors(this.pos, foe.pos).setY(0);
        if (this.delta.lengthSq() < .01) this.delta.copy(this.forward).negate().setY(0);
        this.delta.normalize();
        if (blocked) {
          this.delta.applyAxisAngle(UP, this.retreatSide * Math.PI / 3);
          this.retreatSide *= -1;
        }
        this.retreatGoal.copy(this.pos).addScaledVector(this.delta, this.isGojo ? 24 : isAnissa ? 85 : 55);
        if (!this.groundOnly) this.retreatGoal.y += this.isGojo ? 3 : isAnissa ? 18 : 10;
        this.retreatReplan = .8;
      }
      this.target.copy(this.retreatGoal);
      const floor = this.world.spans(this.target.x, this.target.z).floor(this.target.y + 1);
      this.target.y = Math.max(this.target.y, floor + .05);
      this.paceVelocity.set(0, 0, 0);
    } else if(this.rescueTarget){
      this.target.copy(this.rescueTarget.pos);
      this.delta.subVectors(this.pos,this.target).setY(0);
      if(this.delta.lengthSq()>.01)this.target.addScaledVector(this.delta.normalize(),1.5);
      this.target.y=Math.max(this.target.y,this.world.spans(this.target.x,this.target.z).floor(this.target.y+2)+.05);
    } else if (this.state === "retaliate") {
      // Aim for a position beside the player, not their exact position.
      // Keep pace with the player, but not with the part of their motion that's rushing at her:
      // matching that too would make her flee a charging player at their own speed and never let them close.
      this.delta.subVectors(this.pos, foe.pos);
      if (this.delta.lengthSq() > .01) this.delta.normalize();
      this.paceVelocity.copy(foe.vel).addScaledVector(this.delta, -Math.max(0, foe.vel.dot(this.delta)));
      // Two fighters pacing each other would accelerate together without limit; only chase one that's been sent flying.
      if (this.opponent && !this.opponent.ragdoll.active) this.paceVelocity.set(0, 0, 0);
      const lead = Math.min(this.isDoomsday?.85:this.name === "Anissa" ? .7 : .45, distanceToPlayer / Math.max(100, this.vel.length() + foe.speed));
      // Anissa cuts across the flight path; Faora closes on the target's trailing side.
      this.target.copy(foe.pos).addScaledVector(this.isDoomsday || this.name === "Anissa" ? foe.vel : this.paceVelocity, lead * (followingLaunch ? .2 : this.isDoomsday?1.3:1));
      this.delta.subVectors(this.pos, this.target).setY(0);
      if (this.delta.lengthSq() > .25) this.combatSide.copy(this.delta).normalize();
      if (this.groundOnly) {
        // Rush straight into mace range. Do not inherit flyer flanking or orbiting.
        const approach = this.pos.clone().sub(foe.pos).setY(0);
        if (approach.lengthSq() > .01) this.target.addScaledVector(approach.normalize(), 3);
      } else {
      const castSpacing = this.isGojo && this.cursedEnergy!.reserveFraction >= .14 ? 15 : style.spacing;
      const spacing = followingLaunch ? 2.2 : castSpacing;
      if (this.dodgeTime > 0) {
        this.target.addScaledVector(this.combatSide, spacing + 4);
        this.target.x += -this.combatSide.z * this.circleDirection * 9;
        this.target.z += this.combatSide.x * this.circleDirection * 9;
      } else {
        const orbit = !followingLaunch && this.counterCooldown > 0 && distanceToPlayer < 12 ? Math.sin(this.elapsed * 1.5) * .25 * this.circleDirection : 0;
        this.delta.copy(this.combatSide).applyAxisAngle(UP, orbit);
        this.target.addScaledVector(this.delta, spacing);
      }
      }
      const airborne = !foe.onGround && !foe.inWater;
      // Prefer roughly eye level in the air, while leaving a little vertical
      // lead for a moving target. Grounded fighters keep their feet on the floor.
      if (airborne) {
        const eyeLevel = Number.isFinite(foe.eyeLevel) ? foe.eyeLevel : foe.pos.y + 1.6;
        const verticalLead = THREE.MathUtils.clamp(this.paceVelocity.y * lead * .2, -1, 1);
        this.target.y = eyeLevel - 1.74 + .2 + verticalLead;
      } else this.target.y = foe.pos.y + .05;
      if (this.name === "Anissa") this.target.y += distanceToPlayer > 12 ? 3.5 : 1.8;
    } else if (idleHostile) {
      this.escapePerch = null;
      this.target.copy(this.pos);
    } else {
      // Hold a world-space heading at rest: looking at her must not move her away.
      if (this.formationHeading.lengthSq() < .1) this.formationHeading.set(-Math.sin(player.yaw),0,-Math.cos(player.yaw));
      if (travelling && Math.hypot(player.vel.x,player.vel.z)>4) this.formationHeading.set(player.vel.x,0,player.vel.z).normalize();
      const side = travelling ? 1.2 : .35;
      const ahead = travelling ? 5 : 1.6;
      this.target.copy(player.pos);
      this.target.addScaledVector(this.formationHeading,ahead);
      this.target.x -= this.formationHeading.z*side;
      this.target.z += this.formationHeading.x*side;
      this.target.y += player.flying ? 0 : .05;
      const surface = this.world.spans(this.target.x, this.target.z).floor(this.target.y + 1);
      this.target.y = Math.max(this.target.y, surface + .05);
      if(!travelling) {
        if(this.meetingPoint&&this.meetingPoint.distanceTo(player.pos)<14) this.target.copy(this.meetingPoint);
        else {
          this.meetingPoint=null;
          if(this.pos.distanceTo(this.target)<.5)this.meetingPoint=this.target.clone();
        }
      } else this.meetingPoint=null;
    }
    if(this.enemyMode && !this.groundOnly && !this.recovering && !this.rescueTarget && this.supportAnchor && this.pos.distanceTo(this.supportAnchor.pos)>90 && distanceToPlayer>14){
      this.delta.subVectors(this.target,this.supportAnchor.pos);
      if(this.delta.length()>65)this.target.copy(this.supportAnchor.pos).add(this.delta.setLength(65));
    }
    this.delta.subVectors(this.target, this.pos);
    const distance = this.delta.length();
    const chaseSpeed = this.opponent && !this.opponent.ragdoll.active ? 0 : foe.speed;
    const maxSpeed = this.rescueTarget?200:this.state === "retaliate" ? Math.min(1500, Math.max(style.speed, chaseSpeed * (followingLaunch ? 1.4 : 1.25) + 90)) : Math.min(1500, Math.max(90, player.speed * 1.2 + 45));
    const steering = (this.rescueTarget?400:this.state === "retaliate" ? style.steering * (followingLaunch ? 1.25 : 1) : 180) * this.vitals.control;
    if (!this.groundOnly && !(this.isGojo && this.specialChanneling && !this.jumping)) {
    // Route around buildings, ridges and overhangs while actively flying.
    this.routeFrom.copy(this.pos).y += BODY_CENTER;
    this.routeGoal.copy(this.target).y += BODY_CENTER;
    const cruise = Math.min(maxSpeed, Math.sqrt(2 * steering * distance) + 15);
    this.route.update(dt, this.routeFrom, this.routeGoal, Math.max(40, this.vel.length() * 1.5), speedMargin(Math.max(this.vel.length(), cruise)));
    if (this.retreating && this.route.mode === "stuck") {
      this.delta.set(0, 0, 0);
    } else if (this.route.detouring) {
      // Fly the route at speed, braking for each corner and for the end of the trip.
      this.route.detourVelocity(this.routeFrom, Math.min(cruise, DETOUR_SPEED), steering * 2, this.delta);
    } else {
      // Never ask for more speed than she can shed before arriving, or she overshoots and swings back.
      if (distance > 0.01) this.delta.multiplyScalar(Math.min(maxSpeed, distance * (this.engaged ? 2.8 : 1.6), Math.sqrt(2 * steering * distance)) / distance);
      if (this.state === "follow" && !this.recovering && !this.rescueTarget && travelling) this.delta.add(player.vel).clampLength(0, maxSpeed);
      else if (this.state === "retaliate") this.delta.add(this.paceVelocity).clampLength(0, maxSpeed);
    }
    // Anticipate ridges both near and ahead of her path; she still collides with real terrain.
    const currentFloor = this.isGojo && foe.onGround && this.engaged && !this.rescueTarget && !this.retreating
      ? this.world.spans(this.pos.x, this.pos.z).floor(this.pos.y + 2) : -Infinity;
    for (const lookAhead of [0.25, 0.7]) {
      const ahead = this.pos.clone().addScaledVector(this.vel, lookAhead);
      const floor = this.world.spans(ahead.x, ahead.z).floor(this.pos.y + 2);
      if (floor > currentFloor + 1.5 && floor + 3 > this.pos.y && distance > 10) this.delta.y = Math.max(this.delta.y, Math.min(260, (floor + 8 - this.pos.y) * 3));
    }
    }
    if (this.groundOnly) {
      this.leapCooldown = Math.max(0, this.leapCooldown - dt);
      this.sukunaEscapeCooldown = Math.max(0, this.sukunaEscapeCooldown - dt);
      this.breachCooldown = Math.max(0,this.breachCooldown-dt);
      const floor = this.world.spans(this.pos.x, this.pos.z).floor(this.pos.y + .2);
      const grounded = this.pos.y - floor < .2 && this.vel.y <= .5;
      // Do not walk straight back into the hole beneath a hovering target after escaping it.
      if (this.rescueTarget) this.escapePerch = null;
      if(this.escapePerch){
        const perchFloor=this.world.spans(this.escapePerch.x,this.escapePerch.z).floor(this.escapePerch.y+1);
        if(foe.onGround || foe.pos.y<this.escapePerch.y+3 || Math.hypot(foe.pos.x-this.escapePerch.x,foe.pos.z-this.escapePerch.z)>30 || perchFloor<this.escapePerch.y-1)
          this.escapePerch=null;
        else if(this.world.spans(this.target.x,this.target.z).floor(this.pos.y+24)<this.escapePerch.y-1)
          this.target.copy(this.escapePerch);
      }
      const chaseDistance = Math.hypot(this.target.x-this.pos.x,this.target.z-this.pos.z);
      const waypoint = !this.jumping ? this.groundPath.update(dt,this.pos,this.target) : this.pos;
      const horizontal = waypoint.clone().sub(this.pos).setY(0), gap = horizontal.length();
      const wantsMove = chaseDistance > 2 || this.target.y-this.pos.y > 2;
      const progressed = this.pos.distanceToSquared(this.lastGroundPosition) > (dt*.8)**2;
      this.groundStuckTime = grounded && !this.jumping && wantsMove && (!progressed || !this.groundPath.hasRoute || gap < .1) ? this.groundStuckTime+dt : 0;
      this.lastGroundPosition.copy(this.pos);
      this.pounceCheck = Math.max(0,this.pounceCheck-dt);
      if (this.isSukuna && grounded && !this.jumping && !this.specialChanneling && !this.breachWindup && !underOrbForce
        && this.engaged && !foe.vitals?.defeated && this.staggerTime <= 0 && this.pounceCheck === 0) {
        const escape = this.canSukunaEscape(foe);
        if (escape || this.leapCooldown === 0) {
          this.pounceCheck = .16;
          this.trySukunaJump(foe, escape);
        }
      }
      if(grounded && !this.novaExhausted && !this.specialChanneling && !this.jumping && this.staggerTime<=0 && this.beastJumpWindup<=0 && this.breachWindup<=0 && this.breachCooldown<=0 && this.groundStuckTime>(this.isDoomsday?.4:.8)){
        const toward=this.groundPath.hasRoute && gap>1?waypoint:this.target;
        const obstacle=this.groundPath.obstacle(this.pos,toward);
        if(obstacle && this.world.materialAt(obstacle.x,obstacle.y,obstacle.z).name!=="bedrock"){
          this.breachDirection.copy(obstacle).sub(this.pos).setY(0).normalize();
          this.breachWindup=this.isDoomsday?.22:.4;this.counterCharge=0;
        }else{
          this.groundPath.reset();this.breachCooldown=.8;
        }
      }
      if (!this.isSukuna && grounded && !this.novaExhausted && !this.specialChanneling && !this.jumping && !underOrbForce && this.staggerTime <= 0 && this.breachWindup<=0 && this.beastJumpWindup <= 0 && this.leapCooldown <= 0 && this.pounceCheck <= 0) {
        this.pounceCheck = this.isDoomsday?.4:.3;
        const escape = this.groundStuckTime > .55 ? planBeastEscape(this.world,this.pos,this.target,this.bodyScale) : null;
        const overhead = this.engaged && !this.recovering && foe.pos.y-this.pos.y > 3 && foe.pos.y-this.pos.y <= (this.isDoomsday ? 180 : 55);
        const landingFloor=this.world.spans(this.target.x,this.target.z).floor(this.pos.y+24);
        const uphill = landingFloor-this.pos.y > 1.2 && chaseDistance > 2;
        if (escape) this.prepareBeastJump(escape,"escape");
        else if (overhead) {
          const jump=this.planBeastPounce(foe,true);
          if(jump)this.prepareBeastJump(jump,"snatch",foe);
        } else if (this.engaged && !this.recovering && (foe.onGround || Math.abs(foe.pos.y-this.pos.y)<3) && (chaseDistance > (this.isDoomsday?18:12) || uphill) && chaseDistance < (this.isDoomsday ? 800 : 220)) {
          const jump=this.planBeastPounce(foe,false);
          if(jump)this.prepareBeastJump(jump,"pounce",foe);
        }
      }
      if (this.specialChanneling) {
        if (!this.jumping) this.cancelBeastJump();
        this.breachWindup = 0;
        if(this.specialAdvance && grounded){
          const speed=Math.min(65,Math.max(0,chaseDistance-5)*5,this.groundPath.straight?65:Math.min(20,gap*4));
          if(gap>.01)horizontal.multiplyScalar(speed/gap);
          this.vel.x+=(horizontal.x-this.vel.x)*Math.min(1,dt*12);
          this.vel.z+=(horizontal.z-this.vel.z)*Math.min(1,dt*12);
        } else if (!this.specialAdvance && (!this.isSukuna || !this.jumping)) {
          const drag = underOrbForce ? Math.exp(-dt * 3) : 0;
          this.vel.x *= drag;
          this.vel.z *= drag;
        }
      }
      else if(this.breachWindup>0){
        this.vel.x=0;this.vel.z=0;
        this.breachWindup=Math.max(0,this.breachWindup-dt);
        if(!grounded)this.breachWindup=0;
        else if(this.breachWindup===0){
          const aim=this.pos.clone().addScaledVector(this.breachDirection,5);
          if(this.groundPath.obstacle(this.pos,aim)){
            this.strikePose=.4;
            this.doomsdayPunch="down";
            this.doomsdayAnimation?.contact("down");this.motion?.contact("down");
            this.onObstacleSmash(this.breachDirection);
          }
          this.groundPath.reset();this.breachCooldown=(this.isDoomsday?.6:1.5)/rage;
          this.counterCooldown=Math.max(this.counterCooldown,.5);this.groundStuckTime=0;
        }
      } else if (this.beastJumpWindup > 0) {
        this.vel.x=0; this.vel.z=0;
        this.beastJumpWindup=Math.max(0,this.beastJumpWindup-dt);
        if (!grounded || (this.jumpKind!=="escape" && (!this.engaged || this.pounceTarget!==foe || foe.vitals?.defeated))) {
          this.cancelBeastJump();
        } else if (this.beastJumpWindup===0) {
          // Recheck a moved target or freshly destroyed rim before committing to takeoff.
          const jump=this.jumpKind==="escape" && this.plannedJump
            ? planBeastJump(this.world,this.pos,this.plannedJump.destination,this.bodyScale)
            : this.planBeastPounce(foe,this.jumpKind==="snatch");
          if(jump){
            this.vel.copy(jump.velocity);this.jumping=true;this.jumpLanding=jump.destination.clone();
            this.leapCooldown=(this.isDoomsday?(this.jumpKind==="snatch"?2.2:1.2):this.jumpKind==="snatch"?5:3.2)/rage;
            this.groundStuckTime=0;this.counterCharge=0;this.onLeap();
          }else{this.cancelBeastJump();this.leapCooldown=.8;}
          this.plannedJump=null;
        }
      } else if (!this.jumping) {
        // Build a sprint on clear ground and brake into mace range.
        const charging = (this.engaged || this.rescueTarget!==null) && chaseDistance > 8;
        this.sprint = charging ? Math.min(1.4, this.sprint + dt * 1.5 * rage) : Math.max(0, this.sprint - dt * 3);
        const top = this.isSukuna ? (this.engaged ? 24 : 6) : !this.engaged && !this.rescueTarget ? 14 : (this.isDoomsday?36:22) + (this.isDoomsday?90:BEAST_SPRINT) * rage * THREE.MathUtils.smoothstep(this.sprint, .1, 1);
        const cornerSpeed=this.groundPath.straight?top:Math.min(26,Math.sqrt(200*gap),gap*5+2);
        const speed = gap < .01 ? 0 : Math.min(top,cornerSpeed,chaseDistance * 3 + 3,this.novaExhausted ? 9 : Infinity);
        if (gap > .01) horizontal.multiplyScalar(speed / gap);
        const change=horizontal.clone().sub(this.vel).setY(0), amount=change.length();
        const blend=amount>.001?Math.min(1,(this.isSukuna ? 260 : this.isDoomsday ? 320 : 180)*steeringControl*dt/amount):0;
        this.vel.x+=change.x*blend;this.vel.z+=change.z*blend;
        const ground = Math.hypot(this.vel.x, this.vel.z);
        if (!this.isDoomsday && ground > 26 && grounded) {
          this.stridePhase += dt * ground/3.2;
          if (this.stridePhase >= 1) { this.stridePhase -= 1; this.onStomp(ground); }
        } else this.stridePhase = 0;
      }
      if(this.isDoomsday && this.jumping && this.jumpKind!=="escape" && this.engaged && !this.recovering && !this.specialChanneling && chaseDistance>8){
        // Strong but finite air steering; gravity is unchanged, so the leap always comes back down.
        const desired=this.target.clone().sub(this.pos).setY(0).clampLength(0,DOOMSDAY_JUMP.horizontal);
        if(desired.lengthSq()>1)desired.setLength(Math.min(DOOMSDAY_JUMP.horizontal,Math.max(70,chaseDistance*2)));
        desired.x-=this.vel.x;desired.z-=this.vel.z;
        desired.clampLength(0,70*dt);this.vel.x+=desired.x;this.vel.z+=desired.z;
      }
      if (isBattleBeast && this.jumping && this.pounceTarget === foe && !this.pounceSpent
        && !foe.vitals?.defeated && Math.hypot(foe.vel.x, foe.vel.z) > 1) {
        // Adjust a committed leap enough to track movement near its path.
        const desired = this.delta.copy(foe.pos).sub(this.pos).setY(0).multiplyScalar(3)
          .add(new THREE.Vector3(foe.vel.x, 0, foe.vel.z)).clampLength(0, 55);
        desired.x -= this.vel.x;
        desired.z -= this.vel.z;
        desired.clampLength(0, 22 * dt);
        this.vel.x += desired.x;
        this.vel.z += desired.z;
      }
      this.vel.y -= 9.81 * dt;
    } else if (this.isGojo && this.specialChanneling && !this.jumping) {
      this.vel.multiplyScalar(Math.exp(-dt * 12));
    } else if (this.jumping) {
      this.vel.y -= 9.81 * dt;
      this.vel.multiplyScalar(Math.exp(-dt * .015 * Math.min(1, this.vel.length() / 100)));
    } else {
      const change = this.delta.sub(this.vel), amount = change.length();
      const acceleration = steering * steeringControl * (this.route.detouring ? 2 : 1);
      if (amount > 0) this.vel.addScaledVector(change, Math.min(1, acceleration * dt / amount));
      if (this.state === "follow" && travelling && !this.route.detouring && distance > 150 && this.vel.length() > 30 && this.vel.length() < SOUND_SPEED * BOOST_MACH_LIMIT && this.boostCooldown === 0) {
        this.vel.addScaledVector(this.target.clone().sub(this.pos).normalize(), this.vel.length() * 1.2);
        this.boostCooldown = .5;
      }
    }
    this.move(dt);
    if (this.vitals.defeated) return;
    if (!this.recovering) this.tryBeastPounce(foe);
    if (!this.recovering && !this.isTaunting && !this.specialChanneling && !(this.groundOnly && (this.breachWindup>0 || this.beastJumpWindup>0 || this.jumpKind!==null)) && this.state === "retaliate" && !foe.vitals?.defeated && !(this.isSukuna && foe.infinityProtects) && this.staggerTime <= 0 && !this.blocking && this.dodgeTime <= 0 && this.counterCooldown <= 0) {
      this.eye.copy(this.pos).addScaledVector(UP, 1.3 * this.bodyScale);
      this.playerEye.copy(foe.pos).addScaledVector(UP, isBattleBeast ? 1.2 * (this.opponent?.bodyScale ?? 1) : .9);
      const range = this.eye.distanceTo(this.playerEye);
      if (range >= (isBattleBeast ? .25 : 1.2) && range <= (isBattleBeast ? 5.5 : this.groundOnly ? 4.5 : 6) && this.lineClear(this.eye, this.playerEye)) {
        this.counterCharge = Math.min(1, this.counterCharge + dt / style.chargeTime * this.vitals.control * rage * (this.novaExhausted ? .35 : 1));
        // A spent guard invites a quick punish; a strong guard requires a readable heavy wind-up.
        const targetCharge = this.rescueCountering || guard >= 45 ? .95 : opening ? (this.groundOnly ? .5 : .24) : followingLaunch ? style.followCharge : style.charges[this.attacksAttempted % style.charges.length];
        if (this.counterCharge >= targetCharge) {
          const direction = this.playerEye.clone().sub(this.eye).normalize();
          const charge = this.counterCharge;
          this.counterCharge = 0;
          const grounded = foe.onGround && !foe.flying && !foe.inWater;
          const punchStyle: PunchStyle = !grounded || (this.name === "Anissa" && this.pos.y > foe.pos.y + 1.1) ? "down" : this.attacksAttempted % 3 === 1 ? "uppercut" : "straight";
          this.strikePose = .32;
          // The callback resolves contact immediately. Put the rig at contact
          // before it can trigger hitstop, then animate the arm back to guard.
          this.doomsdayPunch=punchStyle;
          this.doomsdayAnimation?.contact(punchStyle);
          this.motion?.contact(punchStyle);
          this.attacksAttempted++;
          if (punchStyle === "uppercut") this.uppercutPose = .32;
          const landed = this.onCounterAttack(direction, charge, punchStyle);
          this.counterCooldown = landed ? style.cooldown / rage * (this.novaExhausted ? 2 : 1) : style.missRecovery;
          if (landed) {
            if (charge > .35 && !followingLaunch) {
              this.followUpTime = 2.4; this.followUpTarget = foe;
            } else if (followingLaunch) this.followUpTime = 0;
            this.revengeHits++;
            if (!this.enemyMode && this.revengeHits >= 2) this.calmDown();
          }
        }
      } else if (this.counterCharge >= .12) {
        // Dodging out of a committed swing creates a real counterattack window.
        this.counterCharge = 0; this.counterCooldown = style.missRecovery;
      } else this.counterCharge = Math.max(0, this.counterCharge - dt * .5);
    } else this.counterCharge = 0;
    if (this.attackVisual) {
      this.attackVisual.visible = this.counterCharge > 0 || this.beastJumpWindup > 0 || this.breachWindup > 0;
      this.attackVisual.scale.setScalar(.55 + this.counterCharge * .45);
    }
    if (this.jumping && this.vel.y <= 0 && (!this.groundOnly || this.vel.y > -.5) && this.pos.y - this.world.spans(this.pos.x, this.pos.z).floor(this.pos.y + .2) < .25) this.jumping = false;
    if (this.groundOnly) {
      // Running and leaping follow the travel direction; only square up for melee.
      if (Math.hypot(this.vel.x, this.vel.z) > 1.5) this.forward.set(this.vel.x, 0, this.vel.z).normalize();
      else if (this.doomsdaySpecial==="beam" || this.doomsdaySpecial==="beam-charge") this.forward.copy(this.doomsdayAim).setY(0).normalize();
      else if (this.engaged && (this.isSukuna || distanceToPlayer < 5)) this.forward.subVectors(foe.pos, this.pos).setY(0).normalize();
    } else if (this.state === "retaliate") this.forward.subVectors(foe.pos, this.pos).normalize();
    else if (this.vel.lengthSq() > 9) this.forward.copy(this.vel).normalize();
    else if (!idleHostile) this.forward.subVectors(player.pos, this.pos).normalize();
    this.sightTick -= dt;
    if (this.sightTick <= 0) {
      this.eye.copy(this.pos).addScaledVector(UP, 1.65);
      this.playerEye.copy(player.pos).addScaledVector(UP, 1.6);
      this.visibleToPlayer = this.lineClear(this.playerEye, this.eye);
      this.sightTick = 0.15;
    }
    this.animate(dt);
    const speed = this.vel.length(), mach = speed / soundSpeed(this.pos.y);
    const rho = 1.225 * Math.exp(-this.pos.y / 8500);
    let kind = speed > 60 ? (mach < 1 ? 0.05 + 0.3 * THREE.MathUtils.smoothstep(speed, 60, 330) : 0.6 + 0.4 * THREE.MathUtils.smoothstep(mach, 1, 2.2)) * Math.min(1, rho / 0.5) : 0;
    if (this.pos.y - this.world.spans(this.pos.x, this.pos.z).floor(this.pos.y + 0.1) < 1) kind = 0;
    this.eye.copy(this.pos).addScaledVector(UP, 0.9);
    if (speed > 1) this.eye.addScaledVector(this.vel, -4 / speed);
    this.trails.emit(this.eye, kind, this.elapsed);
    this.trails.flush();
    this.trails.uniforms.uTime.value = this.elapsed;
    if (fog) { this.trails.uniforms.uFogColor.value.copy(fog.color); this.trails.uniforms.uFogDensity.value = fog.density; }
  }

  private cancelBeastJump() {
    this.beastJumpWindup=0;this.plannedJump=null;this.jumpKind=null;
    this.pounceTarget=null;this.pounceSpent=false;this.jumpLanding=null;
  }

  private prepareBeastJump(jump:BeastJump,kind:"escape"|"pounce"|"snatch",target:CombatTarget|null=null) {
    this.plannedJump=jump;this.jumpKind=kind;this.pounceTarget=target;this.pounceSpent=false;
    this.beastJumpWindup=kind==="escape"?.2:this.isDoomsday?.16:kind==="snatch"?.45:.3;
    this.counterCharge=0;
  }

  private planBeastPounce(foe:CombatTarget,airborne:boolean):BeastJump|null {
    const destination=this.target.clone();
    if(airborne){
      destination.copy(foe.pos).addScaledVector(foe.vel,this.isDoomsday?.4:.25);
      destination.y-=1.3*this.bodyScale-.9;
    }else{
      if (!this.isDoomsday) destination.copy(foe.pos).addScaledVector(foe.vel, .25);
      destination.y=this.world.spans(destination.x,destination.z).floor(Math.max(this.pos.y,foe.pos.y)+2)+.05;
    }
    const profile = this.isDoomsday ? DOOMSDAY_JUMP : undefined;
    const jump = planBeastJump(this.world, this.pos, destination, this.bodyScale, profile);
    if (!jump || this.isDoomsday || foe.vel.lengthSq() < 1) return jump;
    destination.addScaledVector(foe.vel, jump.duration - .25);
    if (!airborne) destination.y = this.world.spans(destination.x,destination.z).floor(Math.max(this.pos.y,foe.pos.y)+2)+.05;
    return planBeastJump(this.world, this.pos, destination, this.bodyScale, profile) ?? jump;
  }

  prioritizesSukunaJump(foe: CombatTarget) {
    return this.jumping || (this.engaged && this.standing && !this.held && !this.ragdoll.active
      && this.staggerTime <= 0 && this.breachWindup === 0 && this.canSukunaEscape(foe));
  }

  private canSukunaEscape(foe: CombatTarget) {
    return this.sukunaEscapeCooldown === 0 && this.sukunaMeleePressure >= 2.1 && this.pos.distanceToSquared(foe.pos) <= 100;
  }

  private trySukunaJump(foe: CombatTarget, escape: boolean) {
    const towardFoe = new THREE.Vector3().subVectors(foe.pos, this.pos).setY(0);
    const distance = towardFoe.length();
    if (!escape && (this.retreating || foe.infinityProtects || distance < 9 || distance > 27
      || foe.pos.y - this.pos.y > SUKUNA_JUMP.rise || this.vel.dot(towardFoe) < distance * 9)) return;
    towardFoe.normalize();
    const destination = new THREE.Vector3();
    const heading = this.sukunaEscapeHeading.lengthSq() > 0
      ? this.sukunaEscapeHeading : towardFoe.clone().negate();
    for (const angle of escape ? [0, Math.PI / 3, -Math.PI / 3] : [0]) {
      if (escape) destination.copy(heading).applyAxisAngle(UP, angle).multiplyScalar(15).add(this.pos);
      else destination.copy(foe.pos).addScaledVector(towardFoe, -1.8)
        .add(this.delta.copy(foe.vel).setY(0).multiplyScalar(.3).clampLength(0, 4));
      const spans = this.world.spans(destination.x, destination.z);
      const floor = spans.floor(Math.min(this.pos.y + SUKUNA_JUMP.rise, Math.max(this.pos.y, destination.y) + 2));
      if (!Number.isFinite(floor) || spans.water) continue;
      destination.y = floor + .05;
      const jump = planBeastJump(this.world, this.pos, destination, this.bodyScale, SUKUNA_JUMP);
      if (!jump) continue;
      this.vel.copy(jump.velocity);
      this.jumping = true;
      this.jumpKind = escape ? "escape" : "pounce";
      this.pounceTarget = escape ? null : foe;
      this.leapCooldown = 2.1;
      this.counterCharge = 0;
      this.groundStuckTime = 0;
      if (escape) {
        this.sukunaEscapeCooldown = 1.9;
        this.sukunaMeleePressure = 0;
      }
      this.onLeap();
      return;
    }
  }

  private tryBeastPounce(foe:CombatTarget) {
    if(!this.groundOnly || this.specialChanneling || !this.jumping || this.jumpKind==="escape" || !this.jumpKind || this.pounceSpent
      || !this.engaged || this.pounceTarget!==foe || foe.vitals?.defeated)return;
    this.eye.copy(this.pos).y+=1.3*this.bodyScale;
    this.playerEye.copy(foe.pos).y+=.9;
    if(this.eye.distanceTo(this.playerEye)>3 || !this.lineClear(this.eye,this.playerEye))return;
    this.pounceSpent=true;this.strikePose=.4;
    this.doomsdayPunch="down";
    this.doomsdayAnimation?.contact("down");this.motion?.contact("down");
    if (this.isSukuna) {
      if (!foe.infinityProtects) {
        const aim = this.playerEye.clone().sub(this.eye).normalize();
        this.onCounterAttack(aim, .75, "down");
      }
      this.counterCooldown = .6;
      return;
    }
    const landed=this.onPounceAttack(foe);
    this.counterCooldown=landed?.65:1.1;
    if(landed){
      this.vel.y=Math.min(this.vel.y,-22);
      this.revengeHits++;
      if(!this.enemyMode && this.revengeHits>=2)this.calmDown();
    }
  }

  private updateRam(dt: number, foe: CombatTarget, distance: number) {
    this.ramCooldown = Math.max(0,this.ramCooldown-dt);
    this.ramPose = Math.max(0,this.ramPose-dt);
    if (!this.engaged || foe.vitals?.defeated || this.opponent?.held || this.recovering || this.blocking || this.staggerTime > 0) {
      this.ramTarget = null;
      return false;
    }
    if (this.ramTarget !== foe) this.ramTarget = null;
    const targetScale = this.opponent?.bodyScale ?? 1;
    this.routeFrom.copy(this.pos).y += BODY_CENTER;
    this.routeGoal.copy(foe.pos).y += BODY_CENTER * targetScale;
    if (!this.ramTarget) {
      const followingThrow = this.thrownTarget === foe;
      if ((!followingThrow && (this.ramCooldown > 0 || this.counterCharge > 0))
        || distance < (followingThrow ? 8 : 13) || distance > (followingThrow ? 240 : 145)
        || !this.lineClear(this.routeFrom,this.routeGoal)) return false;
      this.ramTarget = foe;
      this.ramFollowsThrow = followingThrow;
      this.thrownTarget = null;
      this.counterCharge = 0;
      this.ramClock = followingThrow ? -.16 : -.32;
      this.ramCooldown = 3.8;
    }
    this.ramClock += dt;
    if (this.ramClock > (this.ramFollowsThrow ? 2.1 : 1.5)) {
      this.ramTarget = null;
      return false;
    }

    this.target.copy(this.routeGoal).sub(this.routeFrom);
    if(this.ramClock < 0) {
      this.vel.multiplyScalar(Math.exp(-dt*9));
    } else {
      const speed = this.vel.length();
      const lead = Math.min(.32,distance/Math.max(90,speed))*THREE.MathUtils.smoothstep(distance,5,25);
      this.target.addScaledVector(foe.vel,lead);
      if(this.target.lengthSq()>.0001){
        const closingSpeed = this.ramFollowsThrow ? 105 : 45;
        const thrust = this.ramFollowsThrow ? 760 : 520;
        const cruise = Math.min(440,Math.max(140,foe.speed+closingSpeed));
        const desiredSpeed = Math.max(speed,Math.min(cruise,speed+thrust*dt));
        this.vel.lerp(this.target.setLength(desiredSpeed),1-Math.exp(-dt*23)).setLength(desiredSpeed);
      }
    }
    this.forward.copy(this.target).normalize();
    this.move(dt);
    if (this.vitals.defeated || this.ragdoll.active) { this.ramTarget=null; return true; }
    this.delta.copy(this.pos).y += BODY_CENTER;
    this.delta.sub(this.routeFrom);
    this.target.subVectors(this.routeFrom,this.routeGoal);
    const contact = this.ramClock >= 0 ? ramContact(this.target,this.delta,.45+targetScale*.58) : null;
    if(contact !== null){
      this.routeFrom.addScaledVector(this.delta,contact);
      if(this.lineClear(this.routeFrom,this.routeGoal)){
        const speed=this.vel.length();
        this.pos.copy(this.routeFrom).y -= BODY_CENTER;
        this.forward.copy(this.vel).normalize();
        this.vel.multiplyScalar(-.12);
        this.ramTarget=null;
        this.ramPose=.32;
        this.counterCooldown=Math.max(this.counterCooldown,.6);
        this.onRam?.(foe,this.forward,speed);
      }
    }
    this.animate(dt);
    return true;
  }

  private move(dt: number) {
    this.vel.add(this.orbImpulse);
    this.orbImpulse.set(0, 0, 0);
    const count = Math.min(128, Math.max(1, Math.ceil(this.vel.length() * dt / 0.5)));
    const step = dt / count;
    let impact = 0;
    let landedJump = false;
    const point = new THREE.Vector3(), normal = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const next = this.pos.clone().addScaledVector(this.vel, step);
      if (this.isSukuna && this.vel.y < 0) {
        // Resolve falling in the current column before testing sideways motion.
        // A ledge beside him must never zero his descent or hold his feet up.
        const floor = this.world.spans(this.pos.x, this.pos.z).floor(this.pos.y + .05);
        if (next.y <= floor && floor <= this.pos.y + .05) {
          const into = -this.vel.y;
          this.pos.y = floor;
          this.vel.y = 0;
          landedJump ||= this.jumping;
          if (into > impact) {
            impact = into;
            point.copy(this.pos);
            normal.copy(UP);
          }
        } else {
          this.pos.y = next.y;
        }
        const side = this.world.spans(next.x, next.z);
        const stepUp = this.vel.y === 0 ? .6 : .05;
        const sideFloor = side.floor(this.pos.y + stepUp);
        const feet = Math.max(this.pos.y, sideFloor);
        if (sideFloor <= this.pos.y + stepUp && !side.solid(feet + .06)
          && !side.solid(feet + BODY * this.bodyScale) && side.ceil(feet + .06) >= feet + BODY * this.bodyScale) {
          this.pos.set(next.x, feet, next.z);
        } else {
          this.vel.x = this.vel.z = 0;
        }
        continue;
      }
      const spans = this.world.spans(next.x, next.z);
      const floor = spans.floor(next.y + 0.1);
      const roof = spans.ceil(this.pos.y + 0.1);
      if (next.y < floor) {
        const wall = floor > this.pos.y + 1.1;
        const n = wall ? new THREE.Vector3(-this.vel.x, 0.15 * Math.hypot(this.vel.x, this.vel.z), -this.vel.z).normalize() : UP;
        const contactMaterial=this.world.materialAt(next.x,wall?this.pos.y+.6:floor-.05,next.z);
        if(wall && contactMaterial.bounce===0)n.setY(0).normalize();
        const into = -this.vel.dot(n);
        if (into > impact) { impact = into; point.copy(wall ? this.pos : next); point.y = wall ? this.pos.y + 0.6 : floor; normal.copy(n); }
        if (into > 0)this.vel.addScaledVector(n, into*(1+Math.min(.15,contactMaterial.bounce)));
        if (!wall) {
          next.y = floor; this.pos.copy(next);
          if(this.groundOnly && this.jumping && into>0)landedJump=true;
        }
      } else if (next.y + BODY * this.bodyScale > roof) {
        const into = Math.max(0, this.vel.y);
        if (into > impact) { impact = into; point.copy(next).y = roof; normal.set(0, -1, 0); }
        this.vel.y = -Math.abs(this.vel.y)*Math.min(.15,this.world.materialAt(next.x,roof+.05,next.z).bounce);
        // A walker too tall for the gap stops at it rather than hanging in the air.
        if (this.groundOnly) { this.vel.x = 0; this.vel.z = 0; }
      } else this.pos.copy(next);
    }
    if (impact > 12 || (this.groundOnly && this.jumping && normal.y > .7 && impact > 1)) {
      const leapLanding = this.groundOnly && this.jumping && normal.y > .7;
      if (leapLanding) this.onLand(impact);
      if (!leapLanding && this.injuryCooldown <= 0) {
        this.takeDamage(impact * .35);
        this.injuryCooldown = .5;
        if (this.vitals.defeated) {
          this.ragdoll.start(this.vel);
          this.state = "ragdoll";
          this.onDefeated();
          return;
        }
      }
      if (!this.isSukuna || !leapLanding) {
        const material = this.world.materialAt(point.x, point.y - 0.1, point.z);
        this.world.crater(point, normal, impact, material);
      }
    }
    if(landedJump){
      this.doomsdayLanding=1;
      if(this.jumpKind==="escape" && this.jumpLanding)this.escapePerch=this.jumpLanding.clone();
      this.jumping=false;this.cancelBeastJump();
    }
  }

  private animate(dt: number) {
    this.model.position.copy(this.pos);
    const speed = this.vel.length();
    const yaw = Math.atan2(this.forward.x, this.forward.z);
    // A held fighter faces wherever the grip turns her.
    if (!this.held) this.model.rotation.y += Math.atan2(Math.sin(yaw - this.model.rotation.y), Math.cos(yaw - this.model.rotation.y)) * (1 - Math.exp(-dt * 7));
    const floor = this.world.spans(this.pos.x, this.pos.z).floor(this.pos.y + .2);
    const airborne = this.jumping || this.pos.y - floor > 1.5;
    this.standing = !this.jumping && this.pos.y - floor < .4;
    this.guardFlash = Math.max(0, this.guardFlash - dt * 4);
    const flash = this.guardFlash;
    if (this.guardVisual) {
      const guard = this.blocking ? this.defense.guard / 100 : 0;
      this.guardVisual.scale.setScalar(this.superBlocking ? 1.55 : .8 + guard * .5 + flash * .4);
      this.guardVisual.material.opacity = this.superBlocking ? .9 : .18 + guard * .4 + flash * .4;
    }
    if(this.doomsdayAnimation){
      const speed=Math.hypot(this.vel.x,this.vel.z);
      const footfall=this.doomsdayAnimation.update(dt,{
        speed,vertical:this.vel.y,airborne,
        crouch:this.beastJumpWindup>0 ? THREE.MathUtils.smoothstep(.16-this.beastJumpWindup,0,.16) : 0,
        landing:this.doomsdayLanding,guard:this.blocking,flinch:this.staggerTime/STAGGER_TIME,
        windup:this.breachWindup>0 ? Math.max(.2,1-this.breachWindup/.22) : Math.min(1,this.counterCharge),
        strike:this.strikePose,punch:this.doomsdayPunch,special:this.doomsdaySpecial,
        charge:this.specialCharge,aim:this.doomsdayAim,exhausted:this.novaExhausted,
        engaged:this.engaged && !this.recovering,
        look:this.focus && this.focus.pos!==this.pos && Number.isFinite(this.focus.eyeLevel) ? this.poseInput.look.set(this.focus.pos.x,this.focus.eyeLevel,this.focus.pos.z) : null,
      });
      if(footfall && speed>26 && this.standing && !this.specialChanneling)this.onStomp(speed);
      return;
    }
    const input = this.poseInput;
    input.height = this.pos.y - floor; input.airborne = airborne;
    input.engaged = this.engaged && !this.recovering;
    input.guard = this.blocking; input.guardFlash = flash;
    input.flinch = this.staggerTime / STAGGER_TIME;
    input.windup = this.breachWindup > 0 ? Math.max(.2, 1 - this.breachWindup / .22) : this.castPose ? 0 : Math.min(1, Math.max(this.counterCharge, this.specialCharge));
    input.cast = this.castPose; input.castSwing = this.castSwing;
    input.strike = this.strikePose; input.punch = this.doomsdayPunch;
    input.ram = this.ramPose > 0 ? 2 : this.ramTarget ? 1 : 0;
    input.grapple = this.grapplePose;
    input.crouch = this.beastJumpWindup > 0 ? THREE.MathUtils.clamp(1 - this.beastJumpWindup / .3, .3, 1) : 0;
    input.landing = this.doomsdayLanding; input.rise = this.isSukuna && airborne ? 0 : this.riseTime / RISE_TIME;
    input.gesture = Math.min(1, this.gesture / .25);
    input.hurt = this.retreating ? 1 : this.healing ? THREE.MathUtils.smoothstep(80 - this.vitals.healthFraction * 100, 0, 40) : 0;
    input.helping = this.rescueTarget !== null && this.pos.distanceTo(this.rescueTarget.pos) < 3.5;
    input.held = this.held;
    const focus = this.focus;
    if (focus && focus.pos !== this.pos) {
      input.look.set(focus.pos.x, Number.isFinite(focus.eyeLevel) ? focus.eyeLevel : focus.pos.y + 1.6, focus.pos.z);
      input.lookWeight = input.engaged ? 1 : this.standing && speed < 6 ? .75 : 0;
    } else input.lookWeight = 0;
    this.motion!.update(dt, input);
  }

  private buildModel() {
    const anissa = this.name === "Anissa";
    const rig = new FighterRig(this.model, [this.leftArm, this.rightArm], [this.leftForearm, this.rightForearm], [this.leftLeg, this.rightLeg], this.isGojo ? GOJO_SPEC : this.isSukuna ? SUKUNA_SPEC : this.groundOnly ? BEAST_SPEC : FLYER_SPEC);
    if (this.isGojo) {
      buildGojo(rig);
      this.motion = new FighterAnimation(rig, "gojo");
    } else if (this.isSukuna) {
      buildSukuna(rig);
      this.motion = new FighterAnimation(rig, "sukuna");
    } else if (this.groundOnly) {
      const { flaps } = buildBeast(rig);
      this.motion = new FighterAnimation(rig, "beast", { flaps });
    } else {
      const { tail, capeColor } = buildFlyer(rig, anissa);
      this.motion = new FighterAnimation(rig, anissa ? "anissa" : "faora", { tail, cape: capeColor });
    }
    this.attackVisual = new THREE.Mesh(new THREE.RingGeometry(.09, .095, 24), new THREE.MeshBasicMaterial({ color: 0x85d9ff, transparent: true, opacity: .7, depthWrite: false, side: THREE.DoubleSide }));
    this.attackVisual.position.set(0, -.05, .06);
    this.attackVisual.visible = false;
    rig.hands[1].add(this.attackVisual);
    return rig;
  }
}
