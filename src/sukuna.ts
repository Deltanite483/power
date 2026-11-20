import * as THREE from "three";
import type { CombatTarget, Faora } from "./faora";
import { COUNTER_DOMAIN_COST, CURSED_COST, RCT_HEAL_FRACTION } from "./cursed-energy";
import { DomainDefense } from "./domain-defense";
import type { CastPose } from "./fighter-animation";
import { SukunaCutFx } from "./sukuna-cut-fx";
import { BlackFlashFx, buildShrine, CursedAura, DomainSky, FugaFx, ShrineBarrier, SlashMarks, type FlameLook } from "./sukuna-fx";

export type SukunaTechnique = "dismantle" | "cleave" | "shrine" | "fuga" | "rct" | "punch" | "kick" | "world-slash";
const WINDUP = { dismantle: .7, cleave: .42, shrine: 1.4, fuga: 1.15, rct: 1.6, punch: .23, kick: .36, "world-slash": 1.5 };
const CAST_POSE: Partial<Record<SukunaTechnique, CastPose>> = { dismantle: "dismantle", cleave: "cleave", shrine: "shrine", fuga: "fuga", rct: "rct", "world-slash": "world" };
const COST: Record<SukunaTechnique, number> = {
  dismantle: CURSED_COST.dismantle, cleave: CURSED_COST.cleave, shrine: CURSED_COST.domain,
  fuga: CURSED_COST.fuga, rct: CURSED_COST.rct, punch: CURSED_COST.melee,
  kick: CURSED_COST.melee, "world-slash": CURSED_COST.worldSlash,
};
/** Largest reach of the barrierless Shrine. */
const DOMAIN_RADIUS = 200;
const VOLLEY_SIZE = 20;
const VOLLEY_INTERVAL = .055;
/** Each pulse of the Shrine is a volley of slashes over everything inside it. */
const DOMAIN_PULSE_INTERVAL = .25;

/** Sukuna shapes his domain each time: open (no barrier, huge reach, enemies can run) or a closed barrier
 * (small, traps everyone inside, stronger sure-hit, and ends with Fuga). Size and duration drive the CE cost. */
export type DomainForm = "open" | "barrier";
export interface DomainSettings { form: DomainForm; radius: number; duration: number }
const OPEN_RADIUS = { min: 60, max: DOMAIN_RADIUS }, BARRIER_RADIUS = { min: 25, max: 70 };
const DOMAIN_DURATION = { min: 3, open: 6, barrier: 10 };
export function domainCost({ form, radius, duration }: DomainSettings) {
  const max = form === "open" ? OPEN_RADIUS.max : BARRIER_RADIUS.max;
  return 18 + 58 * (duration / 10) * (radius / max) ** 1.5;
}
/** Burnout after the domain closes grows with how long it was held. */
const domainBurnout = (duration: number) => 2 + duration * .5;
/** The barrier's sure-hit is stronger than the open form's. */
const BARRIER_SURE_HIT = 1.5;

const FUGA_RADIUS = 13;
/** Slashes at which Fuga reaches full strength: about a long barrier domain's worth. */
const FUGA_FULL_SLASHES = 640;
const FUGA_MAX_RADIUS = 170;
/** 0 at the binding vow's minimum, 1 at a full-strength Fuga. */
export const fugaPower = (slashes: number) => THREE.MathUtils.clamp((slashes - FUGA_SLASHES) / (FUGA_FULL_SLASHES - FUGA_SLASHES), 0, 1);
const fugaRadius = (power: number) => FUGA_RADIUS + (FUGA_MAX_RADIUS - FUGA_RADIUS) * power ** .8;
const CUT_RECOVERY = 2.2;
const DISMANTLE_RANGE = 86;
const DISMANTLE_SPEED = 150;
const CLEAVE_REACH = 5.5;
const PUNCH_REACH = 3.8;
const KICK_REACH = 4.6;
const CLEAVE_HITS = 30;
/** Binding vow: Fuga can only be drawn after this many slashes (Dismantle, Cleave, World Slash, Shrine). In exchange it costs little CE. */
export const FUGA_SLASHES = 40;
const CLEAVE_INTERVAL = .035;
const FUGA_SPEED = 230;
/** Beyond Dismantle's reach he answers with a single cut that ignores cover and splits the ground under it. */
const CUT_RANGE = 82;
const WORLD_RANGE = 240;
const WORLD_SPEED = 300;
const WORLD_HALF_HEIGHT = 7;
const WORLD_HALF_WIDTH = 1.5;
const WORLD_COOLDOWN = 7;
const WORLD_CARVE_STEP = 10;
const SHRINE_SCALE = .78;
const HALF = Math.PI / 2;
const UP = new THREE.Vector3(0, 1, 0);

export class SukunaPowers {
  private technique: SukunaTechnique | null = null;
  private target: CombatTarget | null = null;
  private age = 0;
  private cooldown = 1.5;
  private domainCooldown = 11;
  private fugaCooldown = 8;
  /** Slashes thrown since the last Fuga; the binding vow unlocks Fuga at FUGA_SLASHES. */
  private slashes = 0;
  private volleyPoiseRevision = 0;
  private meleeCasts = 0;
  private readonly volleyTargets: CombatTarget[] = [];
  private volleyCursor = 0;
  private shrineActive = false;
  /** Whether a point is inside an enemy's active domain (Unlimited Void). Set by main. */
  insideHostileDomain: (point: THREE.Vector3) => boolean = () => false;
  /** Sukuna's own Simple Domain / Falling Blossom against an enemy sure-hit (Unlimited Void). */
  readonly defense = new DomainDefense();
  private settings: DomainSettings = { form: "open", radius: DOMAIN_RADIUS, duration: DOMAIN_DURATION.open };
  private domainPulses = 0;
  /** Power and radius of the Fuga in flight (or being drawn). */
  private fugaShot = { power: 0, radius: FUGA_RADIUS };
  private pulse = 0;
  private clock = 0;
  private poseHold = 0;
  private worldCooldown = 2;
  private shrineRise = 0;
  private shrineGround = 0;
  private fugaFlying = false;
  private fugaTime = 0;
  private fugaDuration = 0;
  private readonly cutFx: SukunaCutFx;
  private readonly worldFx: SukunaCutFx;
  private readonly volleyFx: SukunaCutFx[];
  private readonly marks = new SlashMarks();
  private readonly aura: CursedAura;
  private readonly blackFlash: BlackFlashFx;
  private readonly fugaFx: FugaFx;
  private readonly sky: DomainSky;
  private readonly barrier: ShrineBarrier;
  private volleyRemaining = 0;
  private volleyDelay = 0;
  private readonly activeCuts: {
    fx: SukunaCutFx;
    tilt: number;
    kind: "dismantle" | "cleave";
    origin: THREE.Vector3;
    direction: THREE.Vector3;
    distance: number;
    age: number;
    hit: Set<CombatTarget>;
    targets: readonly CombatTarget[];
  }[] = [];
  private readonly world = {
    active: false, origin: new THREE.Vector3(), direction: new THREE.Vector3(), right: new THREE.Vector3(),
    distance: 0, carved: 0, hit: new Set<CombatTarget>(),
  };
  private readonly origin = new THREE.Vector3();
  private readonly fugaPoint = new THREE.Vector3();
  private readonly fugaFrom = new THREE.Vector3();
  private readonly fugaEnd = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly cutStart = new THREE.Vector3();
  private readonly cutEnd = new THREE.Vector3();
  private readonly cutCenter = new THREE.Vector3();
  private readonly cutOffset = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly boundary: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly impactRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly shrine: THREE.Group;

  onCast: (technique: SukunaTechnique, origin: THREE.Vector3) => void = () => {};
  onRelease: (technique: "shrine" | "fuga" | "world-slash", origin: THREE.Vector3) => void = () => {};
  onShrinePulse: (origin: THREE.Vector3, radius: number, pulse: number) => void = () => {};
  onFuga: (point: THREE.Vector3, radius: number, power: number) => void = () => {};
  /** scale: extra force for a charged Fuga (1 for everything else). */
  onHit: (technique: Exclude<SukunaTechnique, "rct">, target: CombatTarget, direction: THREE.Vector3, scale?: number) => void = () => {};
  /** The world-cutting slash passing `point`: main carves the ground along it. */
  onWorldCut: (point: THREE.Vector3, direction: THREE.Vector3) => void = () => {};
  /** A Dismantle stopped by cover at about `point`. */
  onCutBlocked: (point: THREE.Vector3, direction: THREE.Vector3) => void = () => {};
  /** Height of the ground under (x, z), looking down from y. */
  groundAt: (x: number, y: number, z: number) => number = (_x, y) => y;

  constructor(scene: THREE.Scene) {
    const material = (color: number) => new THREE.MeshBasicMaterial({
      color, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.boundary = new THREE.Mesh(new THREE.RingGeometry(.97, 1, 128), material(0xe62b45));
    this.boundary.rotation.x = -HALF;
    this.impactRing = new THREE.Mesh(new THREE.RingGeometry(.86, 1, 64), material(0xff8736));
    this.impactRing.rotation.x = -HALF;
    this.impactRing.scale.setScalar(FUGA_RADIUS);
    this.shrine = buildShrine();
    this.sky = new DomainSky(scene, DOMAIN_RADIUS);
    this.barrier = new ShrineBarrier(scene);
    this.aura = new CursedAura(scene);
    this.cutFx = new SukunaCutFx(scene);
    this.worldFx = new SukunaCutFx(scene, 0xff2a3c);
    this.volleyFx = Array.from({ length: VOLLEY_SIZE }, () => new SukunaCutFx(scene));
    this.fugaFx = new FugaFx(scene);
    this.blackFlash = new BlackFlashFx(scene);
    scene.add(this.impactRing, this.boundary, this.shrine, this.marks.mesh);
    this.impactRing.visible = this.boundary.visible = this.shrine.visible = false;
  }

  reset(fighter: Faora) {
    this.stop(fighter);
    fighter.castPose = null;
    fighter.castSwing = 0;
    this.poseHold = 0;
    this.activeCuts.length = 0;
    this.volleyRemaining = 0;
    for (const fx of this.volleyFx) fx.hide();
    this.cutFx.hide(); this.worldFx.hide();
    this.world.active = false;
    this.fugaFlying = false;
    this.marks.clear(); this.aura.hide(); this.blackFlash.hide(); this.fugaFx.hide(); this.sky.hide(); this.barrier.hide();
    this.cooldown = 1.5;
    this.worldCooldown = 2;
    this.domainCooldown = 11;
    this.fugaCooldown = 8;
    this.slashes = 0;
    this.meleeCasts = 0;
    this.defense.reset();
  }

  /** The active Malevolent Shrine, for fighters who must decide whether to clash with it or leave. */
  get domain() { return this.shrineActive ? this.openDomain : null; }
  private readonly openDomain = { center: new THREE.Vector3(), radius: DOMAIN_RADIUS, form: "open" as DomainForm };
  /** Sure-hit damage scale for the current domain. */
  get sureHitScale() { return this.settings.form === "barrier" ? BARRIER_SURE_HIT : 1; }
  /** Slashes counted toward Fuga, for the HUD. */
  get slashCount() { return this.slashes; }
  /** Seconds left in the active domain, or 0. */
  get domainTimeLeft() { return this.shrineActive ? Math.max(0, this.domainPulses * DOMAIN_PULSE_INTERVAL - this.age) : 0; }

  /** Keep a body inside the closed barrier: clamp it to the dome and cancel motion through the wall. */
  confine(pos: THREE.Vector3, vel: THREE.Vector3) {
    if (!this.shrineActive || this.settings.form !== "barrier") return false;
    const limit = this.settings.radius - 1.2;
    const offset = this.cutOffset.subVectors(pos, this.openDomain.center);
    const distance = offset.length();
    if (distance <= limit) return false;
    offset.multiplyScalar(1 / distance);
    pos.copy(this.openDomain.center).addScaledVector(offset, limit);
    vel.addScaledVector(offset, -Math.max(0, vel.dot(offset)));
    return true;
  }

  showBlackFlash(point: THREE.Vector3) {
    this.blackFlash.fire(point);
    for (let i = 0; i < 7; i++) this.marks.scatter(point, .25, 3.2, .035, .3, i * .012, .95);
  }

  /** A domain clash: the Shrine shatters at once (no closing Fuga) and his burnout runs burnoutScale times as long. */
  shatterDomain(fighter: Faora, burnoutScale: number) {
    if (!this.shrineActive) return;
    this.sky.flare(); this.barrier.flare();
    if (!this.fugaFlying) this.fugaFx.hideArrow();
    this.burnoutScale = burnoutScale;
    this.cooldown = .65;
    this.stop(fighter);
    this.burnoutScale = 1;
  }
  private burnoutScale = 1;

  private stop(fighter: Faora) {
    if (this.shrineActive) fighter.cursedEnergy?.closeDomain(domainBurnout(this.settings.duration) * this.burnoutScale);
    this.barrier.close();
    // Hold the thrown pose for a beat, so every technique visibly lands before he moves on.
    if (this.technique && fighter.castPose) { fighter.castSwing = 1; this.poseHold = .34; }
    this.technique = this.target = null;
    this.volleyTargets.length = 0;
    this.boundary.visible = this.shrine.visible = this.impactRing.visible = false;
    this.shrineActive = false;
    fighter.specialChanneling = false;
    fighter.specialCharge = 0;
  }

  update(dt: number, fighter: Faora, opponent: CombatTarget | null, enemies: readonly CombatTarget[], deployed: boolean, domainTargets = enemies, elapsed = dt) {
    if (!deployed || fighter.vitals.defeated) { this.reset(fighter); return; }
    if (fighter.vitals.frozen) return;
    fighter.cursedEnergy?.update(dt);
    this.clock += dt;
    this.step(dt, fighter, opponent, enemies, domainTargets, elapsed);
    this.present(dt, fighter);
  }

  /** Everything that is only looked at: aura, sky, lingering marks and flames, and the held pose. */
  private present(dt: number, fighter: Faora) {
    if (this.poseHold > 0 && (this.poseHold -= dt) <= 0) fighter.castPose = null;
    const casting = this.technique !== null && fighter.specialChanneling;
    const look: FlameLook = this.technique === "rct" ? "heal" : this.technique === "fuga" ? "fire" : "curse";
    this.aura.update(dt, this.clock, fighter.pos, casting && look !== "curse" ? .35 + fighter.specialCharge * .65 : 0, look);
    this.sky.update(dt, this.clock, this.origin, this.shrineActive, this.settings.form === "barrier");
    this.barrier.update(dt, this.clock);
    this.marks.update(dt);
    this.blackFlash.update(dt);
    this.fugaFx.update(dt, this.clock);
    if (this.shrineActive) {
      // It heaves up out of the ground, and settles as the domain shaves the land away beneath it.
      this.shrineRise = Math.min(1, this.shrineRise + dt / .8);
      if ((this.shrineGround -= dt) <= 0) {
        this.shrineGround = .5;
        this.shrine.position.y = this.groundAt(this.shrine.position.x, this.origin.y + 2, this.shrine.position.z);
      }
      const rise = 1 - (1 - this.shrineRise) ** 3;
      this.shrine.scale.set(SHRINE_SCALE, SHRINE_SCALE * Math.max(.02, rise), SHRINE_SCALE);
    }
  }

  private step(dt: number, fighter: Faora, opponent: CombatTarget | null, enemies: readonly CombatTarget[], domainTargets: readonly CombatTarget[], elapsed: number) {
    for (let i = this.activeCuts.length - 1; i >= 0; i--) {
      if (this.updateCut(this.activeCuts[i], dt, fighter, enemies)) this.activeCuts.splice(i, 1);
    }
    if (this.world.active) this.updateWorldSlash(dt, enemies);
    if (this.fugaFlying) this.updateFuga(dt, fighter, enemies);
    this.cutFx.hide();
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.domainCooldown = Math.max(0, this.domainCooldown - dt);
    this.fugaCooldown = Math.max(0, this.fugaCooldown - dt);
    this.worldCooldown = Math.max(0, this.worldCooldown - dt);
    const energy = fighter.cursedEnergy!;
    if (!this.technique && opponent && fighter.prioritizesSukunaJump(opponent)) return;
    // Caught in an enemy domain he answers it with his own, even a little before his cooldown would allow.
    const counter = this.insideHostileDomain(fighter.pos);
    const plan = !this.technique && (this.domainCooldown === 0 || counter && this.domainCooldown <= 6)
      && !fighter.held && !fighter.ragdoll.active && !fighter.rescueTarget
      ? this.planDomain(fighter, enemies, counter) : null;
    if (plan && (fighter.vitals.healthFraction > .25 || !energy.canHeal)) {
      fighter.retreating = false;
      this.settings = plan.settings;
      this.begin(fighter, "shrine", plan.target, 5, domainCost(plan.settings) * (counter ? COUNTER_DOMAIN_COST : 1));
      if (this.technique === "shrine") this.domainCooldown = 38;
      return;
    }
    if (this.technique === "rct") {
      if (fighter.held || fighter.ragdoll.active || fighter.rescueTarget || !fighter.specialChanneling) {
        this.stop(fighter);
        return;
      }
      this.age += dt;
      fighter.specialCharge = Math.min(1, this.age / WINDUP.rct);
      if (this.age >= WINDUP.rct) {
        fighter.vitals.health = Math.min(fighter.vitals.maxHealth, fighter.vitals.health + fighter.vitals.maxHealth * RCT_HEAL_FRACTION);
        this.stop(fighter);
      }
      return;
    }
    if (!this.technique && fighter.vitals.healthFraction <= .38 && energy.canHeal
      && !fighter.held && !fighter.ragdoll.active && !fighter.rescueTarget) {
      this.begin(fighter, "rct", null, 1.8);
      return;
    }
    if (this.shrineActive) {
      this.age += elapsed;
      const due = Math.min(this.domainPulses, Math.floor((this.age + 1e-7) / DOMAIN_PULSE_INTERVAL));
      this.boundary.material.opacity = .58 + .33 * Math.cos(this.age * 12);
      if (due > this.pulse) {
        this.sky.flare(); this.barrier.flare();
        for (let i = 0; i < 8; i++) this.marks.scatter(this.shrine.position, Math.min(26, this.settings.radius * .6), 22, .26, .7, i * .03, .8);
        for (const target of domainTargets) {
          this.point.copy(target.pos).y += 1;
          if (target.vitals.defeated || this.point.distanceToSquared(this.origin) > this.settings.radius ** 2) continue;
          for (let i = 0; i < 3; i++) this.marks.scatter(this.point, .5, 3.4, .07, .5, i * .05);
          for (let i = 0; i < 6; i++) this.marks.scatter(this.point, 13, 13, .2, .65, i * .04, .8);
        }
        while (this.pulse < due) {
          this.onShrinePulse(this.origin, this.settings.radius, this.pulse++);
          this.slashes += VOLLEY_SIZE;
          for (const target of domainTargets) {
            this.point.copy(target.pos).y += 1;
            if (!target.vitals.defeated && this.point.distanceToSquared(this.origin) <= this.settings.radius ** 2) {
              this.onHit("shrine", target, this.point.sub(this.origin).normalize());
            }
          }
        }
      }
      // The barrier's finale: as it closes he draws Fuga on the slashes the domain just piled up.
      const finaleTarget = this.settings.form === "barrier" && this.slashes >= FUGA_SLASHES && this.target
        && enemies.includes(this.target) && !this.target.vitals.defeated ? this.target : null;
      const left = this.domainTimeLeft;
      if (finaleTarget && left <= WINDUP.fuga) {
        if (fighter.castPose !== "fuga") {
          this.fugaShot.power = fugaPower(this.slashes);
          this.fugaShot.radius = fugaRadius(this.fugaShot.power);
          fighter.castPose = "fuga"; fighter.castSwing = 0;
          this.onCast("fuga", fighter.pos);
        }
        fighter.specialCharge = 1 - left / WINDUP.fuga;
        this.origin.copy(fighter.pos).y += 1.35;
        this.fugaPoint.copy(finaleTarget.pos).y += 1;
        this.aim.subVectors(this.fugaPoint, this.origin).normalize();
        this.impactRing.position.copy(this.fugaPoint);
        this.impactRing.scale.setScalar(this.fugaShot.radius);
        this.impactRing.rotation.z = this.clock * 1.4;
        this.impactRing.material.opacity = .45 + fighter.specialCharge * .45;
        this.impactRing.visible = true;
        this.fugaFx.poseArrow(this.point.copy(this.origin).addScaledVector(this.aim, 1.25), this.aim, fighter.specialCharge, false, this.clock);
      }
      if (this.pulse === this.domainPulses) {
        if (finaleTarget && energy.spendDuringDomain(COST.fuga)) this.releaseFuga(fighter);
        this.cooldown = .65;
        this.origin.copy(this.openDomain.center);
        this.stop(fighter);
      }
      return;
    }

    if (this.volleyRemaining > 0) {
      const cleaving = this.technique === "cleave";
      if (!fighter.availableToFight || !fighter.specialChanneling || fighter.poiseRevision !== this.volleyPoiseRevision) {
        this.volleyRemaining = 0;
      } else {
        this.volleyDelay -= dt;
        const targets = (cleaving && this.target ? [this.target] : this.volleyTargets)
          .filter(target => enemies.includes(target) && !target.vitals.defeated && !target.vitals.frozen && !target.infinityProtects);
        if (!targets.length) this.volleyRemaining = 0;
        while (this.volleyRemaining > 0 && this.volleyDelay <= 0) {
          const target = targets[this.volleyCursor++ % targets.length];
          this.origin.copy(fighter.pos).y += 1.35;
          this.point.copy(target.pos).addScaledVector(UP, 1);
          this.direction.subVectors(this.point, this.origin).normalize();
          if (cleaving) {
            if (this.origin.distanceToSquared(this.point) > CLEAVE_REACH ** 2 || !fighter.lineClear(this.origin, this.point)) {
              this.volleyRemaining = 0;
              break;
            }
            this.onHit("cleave", target, this.direction);
            this.slashes++;
            this.marks.scatter(this.point, .45, 2.6, .075, .5);
            if (this.volleyRemaining % 2 === 0) this.marks.scatter(this.point, .6, 1.6, .05, .35, .02, .9);
            fighter.castSwing = 1;
          } else {
            this.launchCut("dismantle", this.direction, fighter, enemies);
            fighter.castSwing = Math.floor(this.volleyRemaining / 3) % 2;
          }
          this.volleyRemaining--;
          this.volleyDelay += cleaving ? CLEAVE_INTERVAL : VOLLEY_INTERVAL;
        }
      }
      if (this.volleyRemaining === 0) {
        this.cooldown = cleaving ? CUT_RECOVERY : .85;
        this.stop(fighter);
      }
      return;
    }

    if (this.technique) {
      if (!fighter.availableToFight || !fighter.specialChanneling
        || (this.technique !== "fuga" && this.technique !== "shrine"
          && (!this.target || !enemies.includes(this.target) || this.target.vitals.defeated))) {
        this.stop(fighter);
        return;
      }
      this.age += dt;
      fighter.specialCharge = Math.min(1, this.age / WINDUP[this.technique]);
      if (this.age < WINDUP[this.technique]) {
        if (this.technique === "shrine") {
          // The barrierless domain rolls outward from his feet as the seal closes.
          this.boundary.position.copy(fighter.pos).y += .1;
          this.boundary.scale.setScalar(Math.max(1, this.settings.radius * fighter.specialCharge ** 2));
          this.boundary.material.opacity = .2 + fighter.specialCharge * .35;
          this.boundary.visible = true;
        } else if (this.technique === "dismantle") {
          this.origin.copy(fighter.pos).y += 1.35;
          this.point.copy(this.origin).addScaledVector(this.aim, 1.2);
          this.cutFx.pose(this.point, this.aim, .35 + fighter.specialCharge * .3, -.65, .35 + fighter.specialCharge * .5, 0, 0, this.clock);
        } else if (this.technique === "fuga") {
          this.origin.copy(fighter.pos).y += 1.35;
          this.impactRing.position.copy(this.fugaPoint);
          this.impactRing.rotation.z = this.clock * 1.4;
          this.impactRing.material.opacity = .45 + fighter.specialCharge * .45;
          this.impactRing.visible = true;
          this.point.copy(this.origin).addScaledVector(this.aim, 1.25);
          this.fugaFx.poseArrow(this.point, this.aim, fighter.specialCharge, false, this.clock);
        } else if (this.technique === "world-slash") {
          // He tracks the target until the cut is nearly formed, then commits to the line.
          this.origin.copy(fighter.pos).y += 1.35;
          if (fighter.specialCharge < .72) this.aim.copy(this.target!.pos).addScaledVector(UP, 1).sub(this.origin).normalize();
          this.point.copy(this.origin).addScaledVector(UP, 1.5).addScaledVector(this.aim, .5);
          this.worldFx.pose(this.point, this.aim, .5 + fighter.specialCharge * 1.6, HALF, .3 + fighter.specialCharge * .7, 1, 0, this.clock);
        }
        return;
      }
      if (this.technique === "shrine") {
        this.origin.copy(fighter.pos).y += .1;
        this.boundary.position.copy(this.origin);
        this.boundary.scale.setScalar(this.settings.radius);
        this.sky.setRadius(this.settings.radius);
        if (this.settings.form === "barrier") this.barrier.show(this.origin, this.settings.radius);
        this.domainPulses = Math.round(this.settings.duration / DOMAIN_PULSE_INTERVAL);
        // The shrine rises at his back, its maw turned on whoever he opened the domain against.
        this.direction.set(0, 0, 1);
        if (this.target) this.direction.subVectors(this.target.pos, fighter.pos).setY(0);
        if (this.direction.lengthSq() < .01) this.direction.set(0, 0, 1);
        this.direction.normalize();
        this.shrine.position.copy(this.origin).addScaledVector(this.direction, -Math.min(13, this.settings.radius * .35));
        this.shrine.rotation.y = Math.atan2(this.direction.x, this.direction.z);
        this.shrine.scale.set(SHRINE_SCALE, .02, SHRINE_SCALE);
        this.shrineRise = this.shrineGround = 0;
        this.boundary.visible = this.shrine.visible = true;
        fighter.castSwing = 1; this.poseHold = .7;
        this.shrineActive = true;
        this.openDomain.center.copy(this.origin);
        this.openDomain.radius = this.settings.radius;
        this.openDomain.form = this.settings.form;
        this.age = 0;
        energy.openDomain();
        this.pulse = 0;
        fighter.specialChanneling = false;
        fighter.specialCharge = 0;
        this.onRelease("shrine", this.origin);
        return;
      }
      this.origin.copy(fighter.pos).y += 1.35;
      if (this.technique === "fuga") {
        this.releaseFuga(fighter);
        this.cooldown = 3.4;
        this.stop(fighter);
        return;
      }
      if (this.technique === "world-slash") {
        const world = this.world;
        world.origin.copy(this.origin);
        world.direction.copy(this.aim);
        world.right.crossVectors(UP, this.aim);
        if (world.right.lengthSq() < .001) world.right.set(1, 0, 0);
        world.right.normalize();
        world.distance = world.carved = 0;
        world.hit.clear();
        world.active = true;
        this.onRelease("world-slash", this.origin);
        this.slashes++;
        this.updateWorldSlash(0, enemies);
        this.cooldown = 1.3;
        this.worldCooldown = WORLD_COOLDOWN;
        this.stop(fighter);
        return;
      }
      const target = this.target!;
      this.point.copy(target.pos).addScaledVector(UP, 1);
      this.direction.subVectors(this.point, this.origin);
      const distance = this.direction.length();
      this.direction.normalize();
      if (this.technique === "dismantle") {
        this.volleyPoiseRevision = fighter.poiseRevision;
        this.launchCut("dismantle", this.aim, fighter, enemies);
        this.volleyRemaining = VOLLEY_SIZE - 1;
        this.volleyCursor = 1;
        this.volleyDelay = VOLLEY_INTERVAL;
        return;
      }
      if (this.technique === "cleave") {
        this.volleyPoiseRevision = fighter.poiseRevision;
        this.volleyRemaining = CLEAVE_HITS;
        this.volleyDelay = 0;
        return;
      } else {
        const reach = this.technique === "punch" ? PUNCH_REACH : this.technique === "kick" ? KICK_REACH : CLEAVE_REACH;
        if (distance <= reach && fighter.lineClear(this.origin, this.point)) {
          this.onHit(this.technique, target, this.direction);
          fighter.poseCursedStrike(this.technique === "kick");
        }
      }
      this.cooldown = this.technique === "punch" || this.technique === "kick" ? .6 : CUT_RECOVERY;
      this.stop(fighter);
      return;
    }

    if (!opponent || energy.burnedOut || this.cooldown > 0 || fighter.isTaunting || !fighter.availableToAttack
      || !enemies.includes(opponent) || opponent.vitals.defeated || opponent.vitals.frozen) return;
    this.origin.copy(fighter.pos).y += 1.35;
    this.point.copy(opponent.pos).y += 1;
    const distance = this.origin.distanceTo(this.point);
    const shrineWindow = this.domainCooldown < 4 && distance <= DOMAIN_RADIUS;
    const reserve = fighter.vitals.healthFraction < .5 ? CURSED_COST.rct : shrineWindow ? 55 : 0;
    const imminentHit = opponent.combatAttacking && (opponent.combatAttackCharge ?? 0) > .35 && distance < 14;
    if (distance > WORLD_RANGE) return;
    if (opponent.infinityProtects || distance > CUT_RANGE || !fighter.lineClear(this.origin, this.point)) {
      if (imminentHit || this.worldCooldown > 0 || !energy.canSpend(COST["world-slash"], reserve)) return;
      this.aim.copy(this.point).sub(this.origin).normalize();
      this.begin(fighter, "world-slash", opponent, 4.5);
      return;
    }
    const finisher = opponent.vitals.health <= 28;
    const guarding = (opponent.combatGuard ?? 0) >= 35;
    const opening = (opponent.combatWhiff ?? 0) > 0 || opponent.launched === true;
    const melee = distance <= CLEAVE_REACH;
    const fuga = this.slashes >= FUGA_SLASHES && this.fugaCooldown === 0 && distance <= 74 && !imminentHit && !(melee && opening)
      && energy.canSpend(COST.fuga, finisher ? 0 : reserve);
    let technique: SukunaTechnique = "dismantle";
    if (fuga) technique = "fuga";
    else if (melee) {
      const quickStrike = distance > PUNCH_REACH ? "kick" : "punch";
      const canCleave = energy.canSpend(COST.cleave, reserve);
      if (distance > KICK_REACH) {
        if (!canCleave || imminentHit) return;
        technique = "cleave";
      } else if (imminentHit || opening || !canCleave) technique = quickStrike;
      else if (guarding || this.meleeCasts % 3 === 0) technique = "cleave";
      else technique = quickStrike === "kick" || this.meleeCasts % 3 === 2 ? "kick" : "punch";
    }
    if (!energy.canSpend(COST[technique], melee && technique !== "cleave" || finisher ? 0 : reserve)) return;
    if (melee && !fuga) this.meleeCasts++;
    if (technique === "fuga") {
      const leadTime = .5 + distance / FUGA_SPEED;
      this.fugaPoint.copy(this.point).add(this.cutOffset.copy(opponent.vel).multiplyScalar(leadTime).clampLength(0, FUGA_RADIUS));
      if (!fighter.lineClear(this.origin, this.fugaPoint)) this.fugaPoint.copy(this.point);
      this.fugaCooldown = 15;
      this.fugaShot.power = fugaPower(this.slashes);
      this.fugaShot.radius = fugaRadius(this.fugaShot.power);
      this.impactRing.scale.setScalar(this.fugaShot.radius);
    }
    if (technique === "dismantle") {
      this.volleyTargets.push(opponent);
      const nearby = enemies.filter(target => target !== opponent && !target.vitals.defeated && !target.vitals.frozen && !target.infinityProtects
        && this.origin.distanceToSquared(target.pos) <= DISMANTLE_RANGE ** 2
        && fighter.lineClear(this.origin, this.cutOffset.copy(target.pos).addScaledVector(UP, 1)));
      nearby.sort((a, b) => this.origin.distanceToSquared(a.pos) - this.origin.distanceToSquared(b.pos));
      this.volleyTargets.push(...nearby.slice(0, 2));
    }
    this.aim.copy(fuga ? this.fugaPoint : this.point).sub(this.origin).normalize();
    this.begin(fighter, technique, opponent, fuga ? 4 : melee ? 2.4 : 3.3);
  }

  private launchCut(kind: "dismantle" | "cleave", direction: THREE.Vector3, fighter: Faora, enemies: readonly CombatTarget[]) {
    this.slashes++;
    const fx = this.volleyFx.find(candidate => !this.activeCuts.some(cut => cut.fx === candidate));
    if (!fx) return;
    const cut = { kind, fx, tilt: (this.volleyRemaining * 2.39996) % Math.PI - HALF, origin: this.origin.clone(), direction: direction.clone(), distance: 0, age: 0, hit: new Set<CombatTarget>(), targets: kind === "dismantle" ? [...this.volleyTargets] : enemies };
    if (!this.updateCut(cut, 0, fighter, enemies)) this.activeCuts.push(cut);
  }

  private updateCut(cut: SukunaPowers["activeCuts"][number], dt: number, fighter: Faora, enemies: readonly CombatTarget[]) {
    cut.age += dt;
    const ranged = cut.kind === "dismantle";
    const from = cut.distance;
    const to = ranged ? Math.min(DISMANTLE_RANGE, from + dt * DISMANTLE_SPEED) : CLEAVE_REACH;
    const sweep = THREE.MathUtils.clamp(cut.age / .24, 0, 1);
    const heading = ranged ? cut.direction : this.direction.copy(cut.direction).applyAxisAngle(UP, (sweep - .5) * 1.5);
    const center = this.cutCenter.copy(cut.origin).addScaledVector(heading, ranged ? to : 1.45 + sweep * 1.15);
    const end = ranged ? center : this.cutEnd.copy(cut.origin).addScaledVector(heading, to);
    const start = this.cutStart.copy(cut.origin).addScaledVector(cut.direction, from);
    const clear = fighter.lineClear(start, end);
    if (!ranged || clear) {
      for (const enemy of enemies) {
        if (enemy.vitals.defeated || cut.hit.has(enemy) || !cut.targets.includes(enemy)) continue;
        const chest = this.point.copy(enemy.pos).addScaledVector(UP, 1);
        const offset = this.cutOffset.subVectors(chest, cut.origin);
        const along = offset.dot(heading);
        const reach = ranged ? 1.65 : 1.35;
        if (along < from - reach || along > to + reach || (!ranged && offset.lengthSq() > CLEAVE_REACH ** 2)
          || offset.addScaledVector(heading, -along).lengthSq() > reach ** 2 || !fighter.lineClear(start, chest)) continue;
        cut.hit.add(enemy);
        this.onHit(cut.kind, enemy, heading);
        // Leave the cut hanging across them, on the same slant the blade flew at.
        const axis = this.axis.crossVectors(UP, heading);
        if (axis.lengthSq() < .001) axis.set(1, 0, 0);
        axis.normalize().applyAxisAngle(heading, cut.tilt);
        this.marks.emit(chest.x, chest.y, chest.z, axis.x, axis.y, axis.z, 2.7, .065, .55);
      }
    }
    cut.distance = ranged ? to : 0;
    if ((ranged && (!clear || to >= DISMANTLE_RANGE)) || (!ranged && sweep === 1)) {
      if (ranged && !clear && cut.age > 0) this.onCutBlocked(center, heading);
      cut.fx.hide();
      return true;
    }
    cut.fx.pose(center, heading, ranged ? 1.9 : 1.3 + sweep * 1.35,
      ranged ? cut.tilt : -.72 + sweep * 1.42, ranged ? Math.min(1, .35 + cut.age * 9) : 1 - sweep * .9,
      ranged ? 0 : .76, ranged ? Math.min(1.7, cut.age * 14) : 0, this.clock + cut.tilt * 3);
    return false;
  }

  private updateWorldSlash(dt: number, enemies: readonly CombatTarget[]) {
    const world = this.world, from = world.distance, to = Math.min(WORLD_RANGE + 30, from + dt * WORLD_SPEED);
    for (const enemy of enemies) {
      if (enemy.vitals.defeated || world.hit.has(enemy)) continue;
      const chest = this.point.copy(enemy.pos).addScaledVector(UP, 1);
      const offset = this.cutOffset.subVectors(chest, world.origin);
      const along = offset.dot(world.direction), side = offset.dot(world.right);
      if (along < from - 1.5 || along > to + 1.5 || Math.abs(side) > WORLD_HALF_WIDTH
        || offset.lengthSq() - along * along - side * side > WORLD_HALF_HEIGHT ** 2) continue;
      world.hit.add(enemy);
      this.onHit("world-slash", enemy, world.direction);
      this.axis.crossVectors(world.direction, world.right).normalize();
      this.marks.emit(chest.x, chest.y, chest.z, this.axis.x, this.axis.y, this.axis.z, 11, .2, .9);
    }
    while (world.carved + WORLD_CARVE_STEP <= to) {
      world.carved += WORLD_CARVE_STEP;
      this.onWorldCut(this.point.copy(world.origin).addScaledVector(world.direction, world.carved), world.direction);
    }
    world.distance = to;
    if (to >= WORLD_RANGE + 30) { world.active = false; this.worldFx.hide(); return; }
    const fade = Math.min(1, (WORLD_RANGE + 30 - to) / 40);
    this.worldFx.pose(this.point.copy(world.origin).addScaledVector(world.direction, to), world.direction,
      Math.min(WORLD_HALF_HEIGHT + .5, 2 + to * .4), HALF, fade, 1, 0, this.clock);
  }

  private updateFuga(dt: number, fighter: Faora, enemies: readonly CombatTarget[]) {
    this.fugaTime += dt;
    const t = Math.min(1, this.fugaTime / this.fugaDuration);
    this.direction.subVectors(this.fugaEnd, this.fugaFrom);
    if (this.direction.lengthSq() < .001) this.direction.copy(this.aim);
    this.direction.normalize();
    if (t < 1) {
      this.fugaFx.poseArrow(this.point.lerpVectors(this.fugaFrom, this.fugaEnd, t), this.direction, 1, true, this.clock);
      return;
    }
    this.fugaFlying = false;
    this.fugaFx.hideArrow();
    const { power, radius } = this.fugaShot;
    this.fugaFx.erupt(this.fugaEnd, radius * .62, power);
    this.onFuga(this.fugaEnd, radius, power);
    for (const enemy of enemies) {
      this.point.copy(enemy.pos).y += 1;
      const distance = this.point.distanceTo(this.fugaEnd);
      if (!enemy.vitals.defeated && distance <= radius && fighter.lineClear(this.fugaEnd, this.point)) {
        // A charged Fuga hits harder at its heart and fades toward its edge.
        const scale = (1 + power * 1.5) * (1 - power * .5 * distance / radius);
        this.onHit("fuga", enemy, this.direction.subVectors(this.point, this.fugaEnd).normalize(), scale);
      }
    }
  }

  releaseTarget(fighter: Faora, target: CombatTarget) {
    if (this.target === target && !this.shrineActive) this.stop(fighter);
  }

  /** Pick the domain's form, size and duration for the fight in front of him, and the longest he can afford. */
  private planDomain(fighter: Faora, enemies: readonly CombatTarget[], counter = false): { target: CombatTarget; settings: DomainSettings } | null {
    const energy = fighter.cursedEnergy!;
    const inRange = enemies.filter(enemy => !enemy.vitals.defeated && !enemy.vitals.frozen
      && enemy.pos.distanceToSquared(fighter.pos) <= OPEN_RADIUS.max ** 2);
    if (!inRange.length) return null;
    const target = [...inRange].sort((a, b) => Number(Boolean(b.infinityProtects)) - Number(Boolean(a.infinityProtects))
      || b.vitals.health - a.vitals.health)[0];
    const farthest = Math.max(...inRange.map(enemy => enemy.pos.distanceTo(fighter.pos)));
    // Seal them in when everyone fits inside a barrier; throw it wide when they're spread out or far.
    const form: DomainForm = farthest + 10 <= BARRIER_RADIUS.max ? "barrier" : "open";
    const radius = form === "barrier"
      ? THREE.MathUtils.clamp(farthest + 12, BARRIER_RADIUS.min, BARRIER_RADIUS.max)
      : THREE.MathUtils.clamp(farthest + 25, OPEN_RADIUS.min, OPEN_RADIUS.max);
    const keep = fighter.vitals.healthFraction < .5 ? CURSED_COST.rct : 0;
    for (let duration = form === "barrier" ? DOMAIN_DURATION.barrier : DOMAIN_DURATION.open; duration >= DOMAIN_DURATION.min; duration--) {
      const settings = { form, radius, duration };
      if (energy.canSpend(domainCost(settings) * (counter ? COUNTER_DOMAIN_COST : 1), keep)) return { target, settings };
    }
    return null;
  }

  /** Loose the Fuga toward fugaPoint; a wall in the way takes the blast instead. Spends the vow's slashes. */
  private releaseFuga(fighter: Faora) {
    this.origin.copy(fighter.pos).y += 1.35;
    this.fugaFrom.copy(this.origin);
    this.fugaEnd.copy(this.fugaPoint);
    if (!fighter.lineClear(this.origin, this.fugaPoint)) {
      let clear = 0, blocked = 1;
      for (let i = 0; i < 6; i++) {
        const middle = (clear + blocked) / 2;
        if (fighter.lineClear(this.origin, this.point.lerpVectors(this.origin, this.fugaPoint, middle))) clear = middle; else blocked = middle;
      }
      this.fugaEnd.lerpVectors(this.origin, this.fugaPoint, clear);
    }
    this.fugaShot.power = fugaPower(this.slashes);
    this.fugaShot.radius = fugaRadius(this.fugaShot.power);
    this.fugaTime = 0;
    this.fugaDuration = Math.max(.04, this.fugaFrom.distanceTo(this.fugaEnd) / FUGA_SPEED);
    this.fugaFlying = true;
    this.onRelease("fuga", this.origin);
    this.slashes = 0; // the vow is spent; the next Fuga needs another full count
  }

  private begin(fighter: Faora, technique: SukunaTechnique, target: CombatTarget | null, cooldown: number, cost = COST[technique]) {
    const energy = fighter.cursedEnergy;
    if (!(technique === "rct" ? energy?.startRct() : energy?.spend(cost))) return;
    this.technique = technique;
    this.target = target;
    this.age = 0;
    this.cooldown = cooldown;
    this.poseHold = 0;
    fighter.castPose = CAST_POSE[technique] ?? null;
    fighter.castSwing = 0;
    fighter.specialChanneling = true;
    this.onCast(technique, fighter.pos);
  }
}
