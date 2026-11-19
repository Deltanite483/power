import * as THREE from "three";
import type { HitSource } from "./combat-events";
import type { CombatTarget, Faora } from "./faora";
import type { CastPose } from "./fighter-animation";
import { GojoEffects } from "./gojo-fx";
import { CURSED_COST, RCT_HEAL_FRACTION, type CursedEnergy } from "./cursed-energy";
import { GojoOrbs, segmentDistanceSq, type GojoOrb, type GojoOrbSpec } from "./gojo-orbs";
import { BlackFlashFx } from "./sukuna-fx";

export type GojoAttack = "red" | "purple" | "amplified-purple" | "remote-purple" | "blue-melee" | "red-melee";
type Technique = Exclude<GojoAttack, "remote-purple"> | "blue" | "maximum-blue" | "void" | "rct";
type Projectile = "purple" | "amplified-purple";
type OrbMode = "pull" | "intercept" | "trap" | "merge";
type Tactic = Technique | "collapse" | "steer" | "blink";
type PlanDetails = { orb?: GojoOrb; spec?: GojoOrbSpec; mode?: OrbMode; destination?: THREE.Vector3; speed?: number };
type Plan = PlanDetails & { kind: Tactic; score: number; dropShield: boolean };

export const GOJO_HITS: Record<GojoAttack, { strength: number; multiplier: number; impulse: number; splashMultiplier?: number }> = {
  red: { strength: 113, multiplier: 1.416, impulse: 225 },
  purple: { strength: 185, multiplier: 2.04, impulse: 285 },
  "amplified-purple": { strength: 205, multiplier: 2.46, impulse: 355 },
  "remote-purple": { strength: 202, multiplier: 1.6, impulse: 310 },
  "blue-melee": { strength: 100, multiplier: 1.2, impulse: 0 },
  "red-melee": { strength: 100, multiplier: 1, impulse: 720, splashMultiplier: 1.2 },
};
const WINDUP: Record<Technique, number> = { blue: .66, "maximum-blue": .96, red: .58, purple: 1.42, "amplified-purple": 1.88, void: 1.07, "blue-melee": .29, "red-melee": .39, rct: 1.3 };
const POSE: Record<Technique, CastPose> = { blue: "blue", "maximum-blue": "blue", red: "red", purple: "purple", "amplified-purple": "purple", void: "void", "blue-melee": "blue", "red-melee": "red", rct: "rct" };
const COLORS = { blue: "blue", "maximum-blue": "blue", red: "red", purple: "purple", "amplified-purple": "purple", void: "void", rct: "rct", "blue-melee": "blue", "red-melee": "red" } as const;
const COST: Record<Technique, number> = {
  blue: CURSED_COST.blue, red: CURSED_COST.red, "maximum-blue": CURSED_COST.maximumBlue,
  "blue-melee": CURSED_COST.blueMelee, "red-melee": CURSED_COST.redMelee,
  purple: CURSED_COST.purple, "amplified-purple": CURSED_COST.openingPurple,
  void: CURSED_COST.domain, rct: CURSED_COST.rct,
};
const DOMAIN_RADIUS = 36;
const DOMAIN_DURATION = 10;
const DOMAIN_PULSE_INTERVAL = 2;
// Each multiplier applies to the HP left by the previous pulse.
const DOMAIN_PULSE_MULTIPLIERS = [.5, .5, .48, .5];
const AIR_INFINITY_UPKEEP = 6;
const INFINITY_REACTION_TIME = .55;
const CAST_INTERRUPT_DAMAGE = 12;
// A domain expansion is a committed cast: a stray punch must not throw away the reserve it took.
const VOID_INTERRUPT_DAMAGE = 30;
// How far outside an enemy domain he hovers while he cannot clash with it.
const DOMAIN_ESCAPE_MARGIN = 30;
const PURPLE_MAX_HOLD = 1.15;
const GOJO_MELEE_RESERVE = 16;
const ORB_MERGE_SPEED = 115;

export class GojoInfinity {
  private enabled = true;
  constructor(private readonly reserve: CursedEnergy) { this.reset(); }
  get active() { return this.enabled && !this.reserve.burnedOut && this.reserve.auraLevel > 0; }
  payContact() { return this.active; }

  absorb(strength: number, source: HitSource) {
    return this.active && Number.isFinite(strength) && strength > 0
      && source.action !== "impact" && source.action !== "void" && source.action !== "shrine" && source.action !== "world-slash";
  }

  setActive(enabled: boolean) {
    this.enabled = enabled;
    this.reserve.setInfinity(this.active);
  }

  update(dt: number, airborne: boolean) {
    if (!this.active || !this.reserve.spendUpkeep(dt * (airborne ? AIR_INFINITY_UPKEEP : CURSED_COST.infinity))) this.setActive(false);
    else this.reserve.setInfinity(true);
  }

  reset() { this.setActive(true); }
}

export class GojoPowers {
  private readonly effects: GojoEffects;
  private readonly blackFlash: BlackFlashFx;
  private cast: { kind: Technique; target: CombatTarget | null; age: number; startHealth: number; plan?: Plan } | null = null;
  private readonly orbs: GojoOrbs;
  private readonly forecast = new THREE.Vector3();
  private readonly barrierOffset = new THREE.Vector3();
  private readonly barrierDelta = new THREE.Vector3();
  private readonly barrierNormal = new THREE.Vector3();
  private readonly strikeEnd = new THREE.Vector3();
  private readonly strikeDelta = new THREE.Vector3();
  private readonly strikeOffset = new THREE.Vector3();
  private infinityUntil = 0;
  private incomingThreat = false;
  private readonly aim = new THREE.Vector3();
  private readonly destination = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly shot = {
    kind: null as Projectile | null, from: new THREE.Vector3(), direction: new THREE.Vector3(), distance: 0,
    limit: 0, carved: 0, hit: new Set<CombatTarget>(),
  };
  private readonly domain = { center: new THREE.Vector3(), age: 0, pulse: 0, active: false, victims: new Set<CombatTarget>() };
  get domainActive() { return this.domain.active; }
  get voidPulse() {
    if (!this.domain.active) return 0;
    const sincePulse = this.domain.age - this.domain.pulse * DOMAIN_PULSE_INTERVAL;
    return Math.max(0, 1 - sincePulse * 3) ** 2;
  }
  warmEffects(renderer: THREE.WebGLRenderer, visible: boolean) { this.effects.warm(renderer, visible); }
  private openingPurple = true;
  private lastOrbColor: GojoOrb["color"] | null = null;
  private lastTechnique: Technique | null = null;
  private blinkCooldown = 0;
  private decisionDelay = 0;
  private maximumCooldown = 5.5;
  private cooldown = .9;
  private purpleCooldown = 1.5;
  private domainCooldown = 12;
  private poseHold = 0;
  private clock = 0;
  private blockFxAt = -Infinity;
  private simpleDomainAt = 0;
  private blossomAt = 0;

  /** An enemy sure-hit domain he is standing in, or null. Set by the caller each frame. */
  hostileDomain: { readonly center: THREE.Vector3; readonly radius: number } | null = null;
  private readonly escapePoint = new THREE.Vector3();

  onCast: (kind: Technique, origin: THREE.Vector3) => void = () => {};
  onRelease: (kind: Technique, point: THREE.Vector3) => void = () => {};
  onVoidPulse: (point: THREE.Vector3) => void = () => {};
  onHit: (kind: GojoAttack, target: CombatTarget, direction: THREE.Vector3, scale?: number) => boolean = () => false;
  onExplosion: (kind: "red" | "red-melee" | "remote-purple", point: THREE.Vector3, radius: number) => void = () => {};
  onImpact: (kind: Projectile | "blue-melee" | "void", point: THREE.Vector3) => void = () => {};
  onDomainCapture: (target: CombatTarget) => void = () => {};
  onDomainDrain: (target: CombatTarget, damage: number) => void = () => {};
  onDomainDefense: (kind: "simple-domain" | "falling-blossom", origin: THREE.Vector3) => void = () => {};
  onPull: (target: CombatTarget, direction: THREE.Vector3, impulse: number) => void = () => {};
  onPurplePath: (point: THREE.Vector3, direction: THREE.Vector3) => void = () => {};
  blockedAt: (point: THREE.Vector3) => boolean = () => false;

  constructor(scene: THREE.Scene) {
    this.effects = new GojoEffects(scene);
    this.blackFlash = new BlackFlashFx(scene);
    this.orbs = new GojoOrbs(this.effects, (target, direction, impulse) => this.onPull(target, direction, impulse),
      (kind, point, radius, scale, fighter, targets, contact) => this.explode(kind, point, radius, scale, fighter, targets, contact),
      point => this.blockedAt(point));
  }

  reset(fighter: Faora) {
    this.finishCast(fighter);
    this.shot.kind = null; this.shot.hit.clear();
    this.orbs.clear();
    this.closeDomain(fighter);
    this.poseHold = this.clock = 0;
    this.blockFxAt = -Infinity;
    this.cooldown = .9; this.purpleCooldown = 1.5; this.domainCooldown = 12;
    this.blinkCooldown = this.decisionDelay = this.simpleDomainAt = this.blossomAt = 0;
    this.maximumCooldown = 5.5;
    this.openingPurple = true;
    this.lastOrbColor = null;
    this.lastTechnique = null;
    this.infinityUntil = 0;
    this.incomingThreat = false;
    fighter.domainEscape = null;
    this.effects.reset();
    this.blackFlash.hide();
  }

  showBlackFlash(point: THREE.Vector3) {
    this.blackFlash.fire(point);
    this.effects.burst("black-flash", point, 5, .4);
  }

  block(point: THREE.Vector3) {
    if (this.clock - this.blockFxAt < .12) return false;
    this.blockFxAt = this.clock;
    this.effects.burst("infinity", this.center.copy(point).addScaledVector(UP, .95), 2.2, .29);
    return true;
  }

  /** The first answer to a sure-hit is a short Simple Domain. Falling Blossom covers a second window. */
  defendDomain(fighter: Faora) {
    if (fighter.vitals.frozen || fighter.vitals.defeated || fighter.held || fighter.ragdoll.active) return 1;
    if (this.simpleDomainAt > this.clock) return 0;
    if (this.blossomAt > this.clock) return .26;
    if ((this.clock >= this.simpleDomainAt + 18 || this.simpleDomainAt === 0) && fighter.cursedEnergy?.spend(CURSED_COST.simpleDomain)) {
      this.simpleDomainAt = this.clock + 2.25;
      this.effects.burst("simple-domain", this.point.copy(fighter.pos).addScaledVector(UP, .14), 4.8, 2.25);
      this.onDomainDefense("simple-domain", fighter.pos);
      return 0;
    }
    if ((this.clock >= this.blossomAt + 13 || this.blossomAt === 0) && fighter.cursedEnergy?.spend(CURSED_COST.fallingBlossom)) {
      this.blossomAt = this.clock + 3.4;
      this.effects.burst("falling-blossom", this.point.copy(fighter.pos).addScaledVector(UP, .9), 3.8, 1.1);
      this.onDomainDefense("falling-blossom", fighter.pos);
      return .26;
    }
    return 1;
  }

  update(dt: number, fighter: Faora, opponent: CombatTarget | null, targets: readonly CombatTarget[], domainTargets = targets, elapsed = dt) {
    if (fighter.vitals.defeated) { this.reset(fighter); return; }
    if (fighter.vitals.frozen) return;
    const energy = fighter.cursedEnergy!;
    this.clock += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.purpleCooldown = Math.max(0, this.purpleCooldown - dt);
    this.domainCooldown = Math.max(0, this.domainCooldown - dt);
    this.maximumCooldown = Math.max(0, this.maximumCooldown - dt);
    this.blinkCooldown = Math.max(0, this.blinkCooldown - dt);
    this.decisionDelay = Math.max(0, this.decisionDelay - dt);
    if (this.poseHold > 0 && (this.poseHold -= dt) <= 0) fighter.castPose = null;
    const airborne = !fighter.asTarget.onGround && !fighter.asTarget.inWater;
    energy.update(dt);
    let defenseWindow = 0;
    for (const target of targets) defenseWindow = Math.max(defenseWindow, this.interceptWindow(fighter, target));
    const threatened = defenseWindow > 0;
    if (threatened && !this.incomingThreat) this.infinityUntil = this.clock + defenseWindow;
    this.incomingThreat = threatened;
    // Infinity holds through a domain's windup however low the reserve, or a rushing melee fighter breaks every expansion.
    if (this.cast?.kind === "void") this.infinityUntil = Math.max(this.infinityUntil, this.clock + .1);
    else if (!energy.canSpend(0, airborne ? 36 : 26)) this.infinityUntil = 0;
    this.toggleInfinity(fighter, this.clock < this.infinityUntil);
    fighter.infinity?.update(dt, airborne);
    this.orbs.update(dt, this.clock, energy, fighter, targets, domainTargets);
    if (this.shot.kind) this.updateProjectile(dt, targets);
    if (this.domain.active) {
      if (fighter.held || fighter.ragdoll.active) this.endDomain(fighter);
      else this.updateDomain(elapsed, fighter);
    }
    this.effects.update(dt, this.clock);
    this.blackFlash.update(dt);

    if (this.cast) {
      this.updateCast(dt, fighter, targets, domainTargets);
    } else if (!(fighter.held || fighter.ragdoll.active || fighter.rescueTarget || energy.burnedOut)
      && !(fighter.engaged && this.fuseBlueTrap(fighter, targets, energy))
      && this.cooldown === 0 && this.decisionDelay === 0) {
      this.decisionDelay = .16;
      this.choose(fighter, opponent, targets, airborne, threatened);
    }
    this.planDomainEscape(fighter);
  }

  /** Without a Void of his own to clash with, he does not stand inside Malevolent Shrine: he flies clear and waits at its edge. */
  private planDomainEscape(fighter: Faora) {
    const shrine = this.hostileDomain;
    const clashing = this.domain.active || this.cast?.kind === "void";
    if (!shrine || clashing || fighter.held || fighter.ragdoll.active || fighter.rescueTarget) {
      fighter.domainEscape = null;
      return;
    }
    const away = this.direction.subVectors(fighter.pos, shrine.center).setY(0);
    if (away.lengthSq() < .01) away.set(1, 0, 0);
    away.normalize();
    this.escapePoint.copy(shrine.center).addScaledVector(away, shrine.radius + DOMAIN_ESCAPE_MARGIN);
    this.escapePoint.y = Math.max(fighter.pos.y, shrine.center.y + 20);
    fighter.domainEscape = this.escapePoint;
  }

  private interceptWindow(fighter: Faora, target: CombatTarget) {
    if (target.vitals.defeated || target.vitals.frozen || target.launched
      || (target.attackTarget && target.attackTarget !== fighter.asTarget)) return 0;
    const distanceSq = target.pos.distanceToSquared(fighter.pos);
    const castReach = target.castPose === "dismantle" ? 40 : target.castPose === "cleave" ? 7 : target.castPose === "fuga" ? 28 : 0;
    const dangerousCast = (target.castProgress ?? 0) >= .8 && distanceSq <= castReach ** 2 && castReach > 0;
    const heavyMelee = !target.castPose && target.combatAttacking
      && (target.combatAttackCharge ?? 0) >= .6 && distanceSq <= 10 ** 2;
    if ((!dangerousCast && !heavyMelee)
      || !fighter.lineClear(this.point.copy(fighter.pos).add(UP), this.center.copy(target.pos).add(UP))) return 0;
    if (target.castPose === "dismantle") return 1.55;
    if (target.castPose === "cleave") return 1.2;
    return INFINITY_REACTION_TIME;
  }

  spendOnMelee(fighter: Faora) {
    const energy = fighter.cursedEnergy!;
    return energy.canSpend(CURSED_COST.gojoMelee, GOJO_MELEE_RESERVE) && energy.spend(CURSED_COST.gojoMelee);
  }

  private fuseBlueTrap(fighter: Faora, targets: readonly CombatTarget[], energy: CursedEnergy) {
    const orbs = this.orbs.active;
    if (!targets.length || !orbs.length || !energy.canSpend(2)) return false;
    this.origin.copy(fighter.pos).addScaledVector(UP, 1.25);
    let blue: GojoOrb | undefined;
    let red: GojoOrb | undefined;
    let captive: CombatTarget | undefined;
    let closest = Infinity;
    for (const orb of orbs) {
      if (orb.color !== "blue" || orb.duration < .12 || orbs.some(other => other.mergeTarget === orb)) continue;
      const reach = this.orbs.pullReach(orb);
      for (const target of targets) {
        if (target.vitals.defeated || target.vitals.frozen || target.vitals.inReviveGrace) continue;
        this.point.copy(target.pos).add(UP);
        const gap = orb.position.distanceToSquared(this.point);
        if (gap >= closest || gap > (reach * .6) ** 2 || !fighter.lineClear(orb.position, this.point)) continue;
        const escaping = this.direction.subVectors(this.point, orb.position).dot(target.vel) > 0;
        if (escaping && this.forecast.copy(this.point).addScaledVector(target.vel, .35).distanceToSquared(orb.position) > reach ** 2) continue;

        const redirect = orbs.find(other => {
          if (other.color !== "red" || other.mergeTarget) return false;
          const travel = other.position.distanceTo(orb.position) / ORB_MERGE_SPEED;
          return travel + .06 < Math.min(other.duration, orb.duration) && fighter.lineClear(other.position, orb.position);
        });
        const distance = this.origin.distanceTo(orb.position);
        if (!redirect && (distance > 86 || orb.duration <= WINDUP.red + distance / ORB_MERGE_SPEED + .06
          || !fighter.lineClear(this.origin, orb.position))) continue;
        blue = orb;
        red = redirect;
        captive = target;
        closest = gap;
      }
    }
    if (!blue || !captive) return false;

    if (red && energy.spend(2)) {
      this.orbs.steer(red, blue.position, ORB_MERGE_SPEED, blue);
      this.cooldown = Math.max(this.cooldown, .45);
      return true;
    }
    const spec = this.orbSpec("red", "merge", captive, this.origin.distanceTo(blue.position), blue);
    return this.begin(fighter, "red", captive, { kind: "red", score: 0, mode: "merge", spec, orb: blue, dropShield: false });
  }

  syncShield(fighter: Faora) {
    this.effects.showInfinity(fighter.infinityProtects, fighter.pos, this.clock, this.clock - this.blockFxAt);
  }

  private toggleInfinity(fighter: Faora, enabled: boolean) {
    if (!fighter.infinity || fighter.infinity.active === enabled) return;
    fighter.infinity.setActive(enabled);
  }

  /** Score attacks against their likely impact position, available CE and immediate danger. */
  private choose(fighter: Faora, opponent: CombatTarget | null, targets: readonly CombatTarget[], airborne: boolean, threatened: boolean) {
    const energy = fighter.cursedEnergy!;
    const health = fighter.vitals.healthFraction * 100;
    this.origin.copy(fighter.pos).y += 1.25;
    if (opponent) this.center.copy(opponent.pos).y += 1;
    const distance = opponent ? this.origin.distanceTo(this.center) : Infinity;
    const validTarget = opponent && targets.includes(opponent) && !opponent.vitals.defeated && !opponent.vitals.frozen;
    const pressure = validTarget && opponent.combatAttacking ? (opponent.combatAttackCharge ?? .5) : 0;
    const committedCast = opponent?.castPose && (opponent.castProgress ?? 0) >= .25;
    const guard = THREE.MathUtils.clamp((opponent?.combatGuard ?? 0) / 100, 0, 1);
    const clear = validTarget && distance <= 100 && fighter.lineClear(this.origin, this.center);
    const domainWindow = this.domainCooldown < 2 && distance <= 24 && (clear || distance < 12);
    const inward = opponent ? this.direction.subVectors(this.origin, this.center).normalize().dot(opponent.vel) : 0;
    const closing = THREE.MathUtils.clamp(inward / 30, 0, 1);
    const plannedDistance = distance - THREE.MathUtils.clamp(inward * .36, -18, 18);
    const openings = Math.min(1, opponent?.combatWhiff ?? 0) + (opponent?.launched ? .34 : 0);
    const reserve = domainWindow && energy.reserveFraction >= .64 ? 54 : health < 32 ? 14 : 2;
    const shrineThreat = !!this.hostileDomain || (validTarget && opponent.castPose === "shrine");
    const abundance = energy.auraLevel;
    const price = .36 + (1 - abundance) * .88;
    let best: Plan | undefined;
    const canDropShield = fighter.infinityProtects && (health >= 45 || !threatened);
    const evaluate = (kind: Tactic, value: number, keep = reserve, details: PlanDetails = {}) => {
      const cost = kind === "collapse" || kind === "steer" ? 2 : kind === "blink" ? CURSED_COST.blink
        : details.spec ? this.orbs.castCost(details.spec, COST[kind]) : COST[kind];
      const dropShield = !energy.canSpend(cost, keep);
      if (dropShield && !(canDropShield && energy.canSpend(cost / 1.25, keep))) return;
      const actualCost = fighter.infinityProtects && !dropShield ? cost * 1.25 : cost;
      // He mixes it up: repeating the last technique costs, and a little noise keeps him unpredictable.
      const repetition = kind !== this.lastTechnique ? 0 : kind === "blue-melee" || kind === "red-melee" ? 13 : 9;
      const score = value + Math.random() * 14 - repetition - actualCost * price - (dropShield && threatened ? 4 : 0);
      if (score > (best?.score ?? 9)) best = { ...details, kind, score, dropShield };
    };
    if (energy.canHeal && health < 65) evaluate("rct", (72 - health) * 1.45 + (distance > 13 ? 24 : 0) - 22 * pressure, 0);
    if (validTarget && fighter.engaged && (!fighter.retreating || distance >= 9) && !fighter.superBlocking) {
      const targetHealth = opponent.vitals.health;
      // Unlimited Void is a trump card, not a rotation: he answers a Shrine with it, or opens it from a full reserve.
      const voidValue = shrineThreat ? 228 : energy.reserveFraction >= .9 && opponent.vitals.healthFraction >= .35 ? 66 : 0;
      if (voidValue && this.domainCooldown === 0 && distance < 28 && (clear || distance < 12)) {
        const nearby = targets.filter(target => !target.vitals.defeated && target.pos.distanceToSquared(fighter.pos) < 31 ** 2).length;
        evaluate("void", voidValue + nearby * 8 + pressure * 10 - Math.max(0, plannedDistance - 19) * 3, 0);
      }

      const redTrap = this.orbs.active.find(orb => orb.color === "red" && this.canPunchIntoOrb(fighter, opponent, orb));
      if (clear && distance <= 5.8 && fighter.availableToAttack) {
        evaluate("blue-melee", 48 + openings * 12 + guard * 8 - Math.max(0, plannedDistance - distance) * 8, Math.min(reserve, 28));
        evaluate("red-melee", 37 + (redTrap ? 49 : 0) + pressure * 25 + closing * 14 + (targetHealth <= 25 ? 9 : 0) - guard * 8, Math.min(reserve, 30));
      }

      this.forecast.copy(this.center).addScaledVector(opponent.vel, .28);
      for (const orb of this.orbs.active) {
        if (orb.duration < .16 || orb.mergeTarget) continue;
        const radius = this.orbs.blastRadius(orb);
        const gap = orb.position.distanceTo(this.center);
        const gapAfter = orb.position.distanceTo(this.forecast);
        if (orb.color === "red" && gap < radius * .92 && fighter.lineClear(orb.position, this.center)) {
          const combo = redTrap === orb && distance < 6 ? 23 : 0;
          evaluate("collapse", 17 + (1 - gap / radius) * 39 + Math.max(0, gapAfter - gap) * 2 - combo, 0, { orb });
        }
        if (orb.duration < .65 || gapAfter > 32) continue;
        const partner = this.orbs.active.find(other => other.color !== orb.color && other !== redTrap && !other.mergeTarget && other.duration > .65
          && other.position.distanceToSquared(this.forecast) < 10 ** 2 && other.position.distanceToSquared(orb.position) < 26 ** 2);
        if (partner && orb !== redTrap && fighter.lineClear(orb.position, partner.position)) {
          evaluate("steer", 57 - partner.position.distanceTo(this.forecast) * 2, 5,
            { orb, destination: partner.position, speed: 67 });
        } else if (plannedDistance > 7 && orb.destination.distanceToSquared(this.forecast) > 6 ** 2
          && !this.blockedAt(this.forecast) && fighter.lineClear(orb.position, this.forecast)) {
          const value = orb.color === "blue" ? 35 + guard * 9 : 32 + openings * 12 - (orb === redTrap ? 25 : 0);
          evaluate("steer", value - gapAfter * .43, 5, { orb, destination: this.forecast, speed: orb.color === "blue" ? 31 : 63 });
        }
      }

      if (clear && plannedDistance < 86) {
        const blue = this.orbs.active.find(orb => orb.color === "blue" && orb.duration > 1.4
          && orb.position.distanceToSquared(this.forecast) < 16 ** 2);
        const red = this.orbs.active.find(orb => orb.color === "red" && orb.duration > 1
          && orb.position.distanceToSquared(this.forecast) < 14 ** 2);
        const mobile = Math.min(1, opponent.vel.length() / 60);
        const pulls = this.orbSpec("blue", "pull", opponent, distance);
        const maximum = this.orbSpec("maximum-blue", "pull", opponent, distance);
        const intercept = this.orbSpec("red", "intercept", opponent, distance);
        const closePenalty = distance < 4.1 ? 14 : 0;
        const repeatBlue = this.lastOrbColor === "blue" ? 8 : 0;
        const repeatRed = this.lastOrbColor === "red" ? 8 : 0;
        const canFundFusion = red || energy.canSpend(CURSED_COST.blue + CURSED_COST.red + 6);
        if (canFundFusion) {
          evaluate("blue", 53 + guard * 10 + mobile * 7 - closePenalty - repeatBlue - (blue ? 24 : 0) - (distance > 56 ? 10 : 0), reserve, { spec: pulls, mode: "pull" });
          if (this.maximumCooldown === 0) {
            evaluate("maximum-blue", 60 + mobile * 9 - closePenalty - repeatBlue - (blue ? 23 : 0), reserve, { spec: maximum, mode: "pull" });
          }
        }
        const redValue = 46 + closing * 25 + pressure * 16 + openings * 9 - mobile * 3 - closePenalty - (distance < 5.8 ? 6 : 0)
          - repeatRed - (red ? 18 : 0) - (distance > 61 ? 13 : 0);
        evaluate("red", redValue, reserve, { spec: intercept, mode: "intercept" });
        if (!red && distance > 4.1 && distance < 16 && plannedDistance < 14) {
          const trap = this.orbSpec("red", "trap", opponent, distance);
          if (!this.blockedAt(trap.position) && fighter.lineClear(this.origin, trap.position)) {
            evaluate("red", 65 + guard * 7 - mobile * 33 - Math.abs(distance - 8) * 1.8, reserve, { spec: trap, mode: "trap" });
          }
        }
        if (blue) {
          const merge = this.orbSpec("red", "merge", opponent, distance, blue);
          evaluate("red", 80 - blue.position.distanceTo(this.forecast) * 1.5, Math.min(reserve, 37), { spec: merge, mode: "merge", orb: blue });
        }
        if (red && !redTrap) {
          const merge = this.orbSpec("blue", "merge", opponent, distance, red);
          evaluate("blue", 72 - red.position.distanceTo(this.forecast) * 1.5, Math.min(reserve, 37), { spec: merge, mode: "merge", orb: red });
        }
      }

      if (!this.shot.kind && this.purpleCooldown === 0 && distance >= 12 && distance < 182) {
        const purple = this.openingPurple && (!clear || guard > .3) ? "amplified-purple" : "purple";
        const punishCast = clear && committedCast && distance <= 100 ? 37 : 0;
        const clearShot = clear && pressure < .5 ? 10 + Math.max(0, abundance - .42) * 35 : 0;
        evaluate(purple, 45 + (clear ? 0 : 23) + clearShot + openings * 21 + (targetHealth <= 61 ? 28 : 0)
          + punishCast + (distance > 90 ? 13 : 0) - pressure * 9, punishCast ? 0 : Math.min(reserve, 39));
      }
      if (fighter.availableToAttack && this.blinkCooldown === 0 && distance > (clear ? 150 : 55) && distance < 355) {
        evaluate("blink", 33 + (distance > 183 ? 11 : 0));
      }
    }

    const plan = best as Plan | undefined;
    if (!plan) return;
    const { kind, orb, destination, speed } = plan;
    if (plan.dropShield || (canDropShield && kind === "void" && airborne)) {
      this.infinityUntil = this.clock;
      this.toggleInfinity(fighter, false);
    }
    if (kind === "collapse" && orb) {
      if (this.orbs.collapse(orb, energy, fighter, targets)) this.cooldown = .32;
    } else if (kind === "steer" && orb && destination && speed !== undefined) {
      if (energy.spend(2)) {
        this.orbs.steer(orb, destination, speed);
        this.cooldown = .45;
      }
    } else if (kind === "blink") {
      if (opponent && fighter.blinkGojoToward(opponent)) { this.blinkCooldown = 7.5; this.cooldown = .55; }
    } else if (kind !== "collapse" && kind !== "steer" && this.begin(fighter, kind, kind === "rct" ? null : opponent, plan)) {
      if (kind === "void") this.domainCooldown = 30;
      if (kind === "maximum-blue") this.maximumCooldown = 8;
      if (kind === "purple" || kind === "amplified-purple") this.purpleCooldown = 8;
    }
  }

  private orbSpec(kind: "blue" | "red" | "maximum-blue", mode: OrbMode, target: CombatTarget, distance: number, partner?: GojoOrb): GojoOrbSpec {
    const color = kind === "red" ? "red" : "blue";
    const targetSpeed = Math.min(target.vel.length(), 85);
    const radius = mode === "merge" ? 1.25 : mode === "trap" ? 2.1
      : kind === "maximum-blue" ? 3.4 : 1.3 + Math.min(1.1, distance / 63);
    const force = mode === "merge" ? 27 : mode === "trap" ? 42
      : kind === "maximum-blue" ? 99 : 39 + targetSpeed * .55;
    const speed = mode === "trap" ? 0 : mode === "pull" ? 16 + targetSpeed * .25
      : mode === "merge" ? ORB_MERGE_SPEED : 92 + targetSpeed * .55;
    const duration = mode === "trap" ? 4.4 : mode === "pull" ? kind === "maximum-blue" ? 5.4 : 3.5
      : mode === "merge" ? Math.max(1.4, distance / speed + .6) : Math.max(1, distance / speed + .6);
    const lead = mode === "intercept" ? distance / speed : .24;
    const destination = target.vel.clone().multiplyScalar(lead).clampLength(0, 29).add(target.pos).add(UP);
    const position = this.origin.clone();
    if (partner) destination.copy(partner.position);
    else if (mode === "trap") {
      this.strikeDelta.subVectors(destination, this.origin).normalize();
      destination.addScaledVector(this.strikeDelta, 8.5);
      position.copy(destination);
    } else if (mode === "pull") {
      this.strikeDelta.subVectors(this.origin, destination).normalize();
      position.copy(destination).addScaledVector(this.strikeDelta, Math.min(13, distance * .55));
      destination.copy(position).addScaledVector(this.strikeDelta, Math.min(10, distance * .3));
    }
    return {
      color, position, destination, radius, force, speed, duration,
      mergeTarget: mode === "merge" ? partner : undefined,
      proximityFuse: kind === "red" && mode === "intercept",
    };
  }

  private canPunchIntoOrb(fighter: Faora, target: CombatTarget, orb: GojoOrb) {
    this.strikeDelta.subVectors(target.pos, fighter.pos).normalize();
    this.strikeEnd.copy(target.pos).add(UP).addScaledVector(this.strikeDelta, 19);
    this.strikeOffset.copy(target.pos).add(UP);
    return orb.position.distanceToSquared(this.strikeOffset) > (orb.radius + .65) ** 2
      && fighter.lineClear(this.strikeOffset, orb.position)
      && segmentDistanceSq(this.strikeOffset, this.strikeEnd, orb.position, this.barrierDelta, this.barrierOffset) < (orb.radius + 1) ** 2;
  }

  alignMelee(fighter: Faora, target: CombatTarget, direction: THREE.Vector3) {
    const trap = this.orbs.active.find(orb => orb.color === "red" && this.canPunchIntoOrb(fighter, target, orb));
    if (!trap) return false;
    direction.subVectors(trap.position, target.pos).sub(UP).normalize();
    return true;
  }

  private begin(fighter: Faora, kind: Technique, target: CombatTarget | null, plan?: Plan) {
    const energy = fighter.cursedEnergy;
    if (!plan && target && (kind === "blue" || kind === "maximum-blue" || kind === "red")) {
      this.origin.copy(fighter.pos).addScaledVector(UP, 1.25);
      const mode = kind === "red" ? "intercept" : "pull";
      const spec = this.orbSpec(kind, mode, target, this.origin.distanceTo(target.pos));
      plan = { kind, score: 0, spec, mode, dropShield: false };
    }
    const cost = plan?.spec ? this.orbs.castCost(plan.spec, COST[kind]) : COST[kind];
    if (!(kind === "rct" ? energy?.startRct() : energy?.spend(cost))) return false;
    this.cast = { kind, target, age: 0, startHealth: fighter.vitals.health, plan };
    this.lastTechnique = kind;
    this.poseHold = 0;
    this.aim.set(0, 0, 1);
    if (target) this.track(fighter, target, kind);
    fighter.castPose = POSE[kind];
    fighter.castSwing = 0;
    fighter.specialChanneling = true;
    fighter.specialCharge = 0;
    this.onCast(kind, fighter.pos);
    return true;
  }

  private finishCast(fighter: Faora, released = false) {
    this.cast = null;
    fighter.specialChanneling = false;
    fighter.specialCharge = 0;
    fighter.castSwing = released ? 1 : 0;
    if (released) this.poseHold = .29;
    else fighter.castPose = null;
    this.effects.hideCharge();
  }

  private track(fighter: Faora, target: CombatTarget, kind: Technique) {
    this.origin.copy(fighter.pos).addScaledVector(UP, 1.25);
    const lead = kind === "blue" || kind === "maximum-blue" ? .15
      : kind === "purple" || kind === "amplified-purple" ? this.origin.distanceTo(target.pos) / 245
      : kind === "red" ? this.origin.distanceTo(target.pos) / 147 : 0;
    this.direction.copy(target.vel).multiplyScalar(lead).clampLength(0, 23);
    this.destination.copy(target.pos).addScaledVector(UP, 1).add(this.direction);
    this.aim.subVectors(this.destination, this.origin).normalize();
    if (this.aim.lengthSq() < .01) this.aim.set(0, 0, 1);
  }

  private updateCast(dt: number, fighter: Faora, targets: readonly CombatTarget[], domainTargets: readonly CombatTarget[]) {
    const cast = this.cast!;
    const { kind, target, plan } = cast;
    if (fighter.held || fighter.ragdoll.active || fighter.rescueTarget || !fighter.specialChanneling
      || cast.startHealth - fighter.vitals.health >= (kind === "void" ? VOID_INTERRUPT_DAMAGE : CAST_INTERRUPT_DAMAGE) || (target && (target.vitals.defeated || !targets.includes(target)))) {
      this.cooldown = .55;
      // A broken expansion can be tried again soon; the full cooldown is for one that opened.
      if (kind === "void") this.domainCooldown = Math.min(this.domainCooldown, 6);
      this.finishCast(fighter);
      return;
    }
    cast.age += dt;
    const progress = Math.min(1, cast.age / WINDUP[kind]);
    fighter.specialCharge = progress;
    const purpleShot = kind === "purple" || kind === "amplified-purple";
    if (target && (progress < .69 || purpleShot && progress === 1)) this.track(fighter, target, kind);
    this.origin.copy(fighter.pos).addScaledVector(UP, 1.25);
    const waitForArmor = purpleShot && target?.chargeArmored && cast.age < WINDUP[kind] + PURPLE_MAX_HOLD;
    if (progress < 1 || waitForArmor) {
      const color = COLORS[kind];
      const striking = kind === "blue-melee" || kind === "red-melee";
      this.point.copy(color === "blue" && !striking ? this.destination : this.origin);
      if (striking || kind === "void" || kind === "rct") fighter.cursedHand(this.point, kind === "blue-melee");
      else if (color !== "blue") this.point.addScaledVector(this.aim, color === "purple" ? 2 + progress * 1.4 : .9);
      if (plan?.spec && progress > .22 && (color === "blue" || plan.mode === "trap")) {
        this.point.lerp(plan.spec.position, THREE.MathUtils.smoothstep(progress, .22, .67));
      }
      this.effects.showCharge(color, this.point, progress, this.clock);
      if (kind === "void") this.effects.showVoidWarning(fighter.pos, DOMAIN_RADIUS, progress);
      return;
    }
    const melee = kind === "blue-melee" || kind === "red-melee";
    this.cooldown = melee ? .9 : kind === "void" ? 3.6 : COLORS[kind] === "purple" ? 1.8 : .7;
    this.finishCast(fighter, true);
    if (kind === "rct") {
      fighter.vitals.health = Math.min(fighter.vitals.maxHealth, fighter.vitals.health + fighter.vitals.maxHealth * RCT_HEAL_FRACTION);
      this.effects.burst("rct", this.origin, 2.4, .8);
      this.onRelease(kind, this.origin);
    } else if (kind === "void") {
      this.openDomain(fighter, domainTargets);
    } else if (kind === "blue" || kind === "maximum-blue" || kind === "red") {
      if (!target) return;
      const mode = plan?.mode ?? (kind === "red" ? "intercept" : "pull");
      const partner = plan?.orb;
      if (mode === "merge" && (!partner || !this.orbs.active.includes(partner) || !fighter.lineClear(this.origin, partner.position))) return;
      const spec = this.orbSpec(kind, mode, target, this.origin.distanceTo(target.pos), partner);
      if (plan?.spec) {
        // The price paid on windup fixes output. Position and aim can still follow the fight.
        spec.radius = plan.spec.radius;
        spec.force = plan.spec.force;
        spec.speed = plan.spec.speed;
        spec.duration = plan.spec.duration;
      }
      if (this.blockedAt(spec.position) || !fighter.lineClear(this.origin, spec.position)) return;
      this.orbs.spawn(spec);
      this.lastOrbColor = spec.color;
      this.effects.burst(spec.color, spec.position, spec.radius * 1.7, .35);
      this.onRelease(kind, spec.position);
    } else if (melee) {
      if (!target) return;
      this.center.copy(target.pos).add(UP);
      const distance = this.origin.distanceTo(this.center);
      if (distance > 5.8 || !fighter.lineClear(this.origin, this.center)) return;
      this.direction.subVectors(this.center, this.origin).normalize();
      if (kind === "red-melee") this.alignMelee(fighter, target, this.direction);
      const landed = this.onHit(kind, target, this.direction);
      fighter.poseCursedStrike(distance > 3.3);
      if (!landed) return;
      if (kind === "red-melee") this.explode(kind, this.center, 14, .62, fighter, targets, target);
      else {
        this.effects.burst("blue", this.center, 1.65, .2);
        this.onImpact(kind, this.center);
      }
    } else {
      if (kind === "amplified-purple") this.openingPurple = false;
      this.shot.kind = kind;
      this.shot.from.copy(this.origin);
      this.shot.direction.copy(this.aim);
      this.shot.distance = this.shot.carved = 0;
      this.shot.limit = kind === "amplified-purple" ? 227 : 200;
      this.shot.hit.clear();
      this.effects.showProjectile(this.origin, this.shot.direction, this.clock, kind === "amplified-purple");
      this.onRelease(kind, this.origin);
    }
  }

  private explode(kind: "red" | "remote-purple" | "red-melee", point: THREE.Vector3, radius: number, scale: number,
    fighter: Faora, targets: readonly CombatTarget[], primary?: CombatTarget) {
    const purple = kind === "remote-purple";
    this.effects.burst(purple ? "purple" : "red", point, radius, purple ? 1.05 : .76);
    this.onExplosion(kind, point, radius);
    for (const target of targets) {
      if ((target === primary && kind === "red-melee") || target.vitals.defeated || target.vitals.frozen) continue;
      this.point.copy(target.pos).add(UP);
      const distance = this.direction.subVectors(this.point, point).length();
      if (target !== primary && (distance > radius
        || (purple ? this.voidWall(point, this.point) < 1 : !fighter.lineClear(point, this.point)))) continue;
      if (distance < .01) this.direction.copy(UP);
      this.onHit(kind, target, this.direction.normalize(), target === primary ? scale : scale * (1 - distance / radius * .65));
    }
  }

  private updateProjectile(dt: number, targets: readonly CombatTarget[]) {
    const shot = this.shot;
    const kind = shot.kind!;
    const amplified = kind === "amplified-purple";
    const radius = amplified ? 6.2 : 4.7;
    const proposed = Math.min(shot.limit, shot.distance + dt * 245);
    const wall = this.domain.active ? this.voidWall(this.destination.copy(shot.from).addScaledVector(shot.direction, shot.distance),
      this.point.copy(shot.from).addScaledVector(shot.direction, proposed)) : 1;
    const next = THREE.MathUtils.lerp(shot.distance, proposed, wall);
    for (const target of targets) {
      if (target.vitals.defeated || target.vitals.frozen || shot.hit.has(target)) continue;
      this.center.copy(target.pos).add(UP);
      if (this.voidWall(shot.from, this.center) < 1) continue;
      const along = this.center.sub(shot.from).dot(shot.direction);
      this.point.copy(shot.from).addScaledVector(shot.direction, THREE.MathUtils.clamp(along, shot.distance, next));
      this.center.add(shot.from);
      if (this.center.distanceToSquared(this.point) > radius ** 2) continue;
      shot.hit.add(target);
      this.onHit(kind, target, shot.direction);
    }
    for (; shot.carved <= next; shot.carved += 8) {
      this.point.copy(shot.from).addScaledVector(shot.direction, shot.carved);
      this.onPurplePath(this.point, shot.direction);
    }
    shot.distance = next;
    this.point.copy(shot.from).addScaledVector(shot.direction, next);
    if (next < shot.limit && wall === 1) {
      this.effects.showProjectile(this.point, shot.direction, this.clock, amplified);
      return;
    }
    shot.kind = null;
    shot.hit.clear();
    this.effects.hideProjectile();
    this.effects.burst("purple", this.point, 11, .7);
    if (wall === 1) this.onImpact(kind, this.point);
  }

  insideVoid(point: THREE.Vector3) {
    return this.domain.active && point.distanceToSquared(this.domain.center) < DOMAIN_RADIUS ** 2;
  }

  voidWall(from: THREE.Vector3, to: THREE.Vector3) {
    if (!this.domain.active) return 1;
    const start = this.barrierOffset.subVectors(from, this.domain.center);
    const step = this.barrierDelta.subVectors(to, from);
    const a = step.lengthSq();
    const b = start.dot(step);
    const c = start.lengthSq() - DOMAIN_RADIUS ** 2;
    const discriminant = b * b - a * c;
    if (a < 1e-12 || discriminant <= 0) return 1;
    const t = (-b + (c < 0 ? 1 : -1) * Math.sqrt(discriminant)) / a;
    return t >= 0 && t < 1 ? t : 1;
  }

  /** Resolve the first entry, including a path that crosses the entire sphere in one update. */
  sealEntry(from: THREE.Vector3, to: THREE.Vector3, velocity: THREE.Vector3, height = 1, padding = .55) {
    if (!this.domain.active) return false;
    const radius = DOMAIN_RADIUS + padding;
    const start = this.barrierOffset.copy(from).addScaledVector(UP, height).sub(this.domain.center);
    const step = this.barrierDelta.subVectors(to, from);
    const a = step.lengthSq();
    const b = start.dot(step);
    const c = start.lengthSq() - radius ** 2;
    if (c < 0 && start.lengthSq() < (DOMAIN_RADIUS - .05) ** 2) return false;
    if (a < 1e-12 || b >= 0) return false;
    const discriminant = b * b - a * Math.max(0, c);
    if (discriminant < 0) return false;
    const t = (-b - Math.sqrt(discriminant)) / a;
    if (t > 1) return false;
    const normal = this.barrierNormal.copy(start).addScaledVector(step, t).normalize();
    to.copy(this.domain.center).addScaledVector(normal, radius + .04).addScaledVector(UP, -height);
    // Retain motion along the shell to avoid catching when running beside it.
    step.multiplyScalar(1 - t).addScaledVector(normal, -Math.min(0, step.dot(normal)));
    to.add(step);
    velocity.addScaledVector(normal, -Math.min(0, velocity.dot(normal)));
    return true;
  }

  private openDomain(fighter: Faora, targets: readonly CombatTarget[]) {
    const domain = this.domain;
    domain.center.copy(this.origin);
    domain.age = domain.pulse = 0;
    domain.active = true;
    fighter.cursedEnergy?.openDomain();
    fighter.infinity?.setActive(false);
    this.orbs.clear();
    this.effects.showInfinity(false, fighter.pos, this.clock, 0);
    this.effects.showDomain(domain.center, DOMAIN_RADIUS, 1);
    fighter.specialChanneling = true;
    for (const target of targets) {
      this.center.copy(target.pos).addScaledVector(UP, 1);
      if (target.vitals.defeated || domain.victims.has(target) || this.center.distanceToSquared(domain.center) > DOMAIN_RADIUS ** 2) continue;
      domain.victims.add(target);
      target.vitals.freeze(domain);
      target.vel.set(0, 0, 0);
      this.onDomainCapture(target);
    }
    this.effects.burst("void", domain.center, DOMAIN_RADIUS, .8);
    this.onImpact("void", domain.center);
  }

  releaseDomainTarget(target: CombatTarget) {
    if (this.domain.victims.delete(target)) target.vitals.thaw(this.domain);
  }

  private closeDomain(fighter: Faora) {
    const domain = this.domain;
    if (domain.active) fighter.cursedEnergy?.closeDomain();
    for (const target of domain.victims) target.vitals.thaw(domain);
    domain.victims.clear();
    domain.active = false;
    this.effects.hideDomain();
  }

  private endDomain(fighter: Faora) {
    this.closeDomain(fighter);
    fighter.specialChanneling = false;
    this.cooldown = .65;
  }

  private updateDomain(dt: number, fighter: Faora) {
    const domain = this.domain;
    domain.age += dt;
    while (domain.pulse < DOMAIN_PULSE_MULTIPLIERS.length && domain.age + 1e-7 >= (domain.pulse + 1) * DOMAIN_PULSE_INTERVAL) {
      const remainingFraction = DOMAIN_PULSE_MULTIPLIERS[domain.pulse++];
      this.onVoidPulse(domain.center);
      this.effects.burst("void", domain.center, DOMAIN_RADIUS, .65);
      for (const target of domain.victims) {
        const damage = target.vitals.drainWhileFrozen(domain, remainingFraction);
        if (damage > 0) this.onDomainDrain(target, damage);
      }
    }
    if (domain.age + 1e-7 >= DOMAIN_DURATION) this.endDomain(fighter);
    else this.effects.showDomain(domain.center, DOMAIN_RADIUS, this.voidPulse);
  }
}
const UP = new THREE.Vector3(0, 1, 0);
