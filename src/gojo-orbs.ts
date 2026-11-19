import * as THREE from "three";
import type { CombatTarget, Faora } from "./faora";
import type { CursedEnergy } from "./cursed-energy";
import type { GojoEffects } from "./gojo-fx";

export interface GojoOrbSpec {
  color: "red" | "blue";
  position: THREE.Vector3;
  destination: THREE.Vector3;
  radius: number;
  force: number;
  speed: number;
  duration: number;
  mergeTarget?: GojoOrb;
  proximityFuse?: boolean;
}

export interface GojoOrb extends GojoOrbSpec {
  previous: THREE.Vector3;
  visual: ReturnType<GojoEffects["takeOrb"]>;
}

export function segmentDistanceSq(from: THREE.Vector3, to: THREE.Vector3, point: THREE.Vector3, delta: THREE.Vector3, offset: THREE.Vector3) {
  delta.subVectors(to, from);
  offset.subVectors(point, from);
  const length = delta.lengthSq();
  return length ? offset.addScaledVector(delta, -THREE.MathUtils.clamp(offset.dot(delta) / length, 0, 1)).lengthSq() : offset.lengthSq();
}

export class GojoOrbs {
  readonly active: GojoOrb[] = [];
  private readonly targetPoint = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly relativeFrom = new THREE.Vector3();
  private readonly relativeTo = new THREE.Vector3();
  private readonly blastPoint = new THREE.Vector3();
  private lastTargetPoint = new WeakMap<CombatTarget, THREE.Vector3>();

  constructor(private readonly effects: GojoEffects,
    private readonly pull: (target: CombatTarget, direction: THREE.Vector3, impulse: number) => void,
    private readonly explode: (kind: "red" | "remote-purple", point: THREE.Vector3, radius: number, scale: number,
      fighter: Faora, targets: readonly CombatTarget[], contact?: CombatTarget) => void,
    private readonly solid: (point: THREE.Vector3) => boolean) {}

  castCost(spec: GojoOrbSpec, base: number) {
    return base + spec.radius * .6 + spec.force / 75 + spec.speed / 150 + spec.duration * .4;
  }

  spawn(spec: GojoOrbSpec) {
    if (!this.active.length) this.lastTargetPoint = new WeakMap();
    const orb = { ...spec, position: spec.position.clone(), destination: spec.destination.clone(), previous: spec.position.clone(), visual: this.effects.takeOrb() };
    this.active.push(orb);
    this.effects.showOrb(orb.visual, orb.color, orb.position, orb.radius, 0);
    return orb;
  }

  steer(orb: GojoOrb, destination: THREE.Vector3, speed: number, mergeTarget?: GojoOrb) {
    orb.destination.copy(destination);
    orb.speed = speed;
    orb.mergeTarget = mergeTarget;
  }

  private remove(orb: GojoOrb) {
    this.active.splice(this.active.indexOf(orb), 1);
    this.effects.releaseOrb(orb.visual);
  }

  clear() {
    if (!this.active.length) return;
    while (this.active.length) this.remove(this.active[this.active.length - 1]);
    this.lastTargetPoint = new WeakMap();
  }

  pullReach(orb: GojoOrb) { return (orb.radius * 3 + orb.force / 7) * 1.2; }

  blastRadius(orb: GojoOrb) { return 3 + orb.radius * 2.5 + orb.force / 27; }

  collapse(orb: GojoOrb, energy: CursedEnergy, fighter: Faora, targets: readonly CombatTarget[]) {
    if (orb.color !== "red" || !this.active.includes(orb) || !energy.spend(2)) return false;
    this.detonate(orb, fighter, targets);
    return true;
  }

  private detonate(orb: GojoOrb, fighter: Faora, targets: readonly CombatTarget[], contact?: CombatTarget) {
    this.remove(orb);
    this.explode("red", orb.position, this.blastRadius(orb), .63 + orb.radius * .14 + orb.force / 240, fighter, targets, contact);
  }

  private updateContact(orb: GojoOrb, target: CombatTarget) {
    const previous = this.lastTargetPoint.get(target) ?? this.targetPoint;
    this.relativeFrom.subVectors(orb.previous, previous);
    this.relativeTo.subVectors(orb.position, this.targetPoint);
    if (segmentDistanceSq(this.relativeFrom, this.relativeTo, ZERO, this.delta, this.offset) > (orb.radius + .65) ** 2) return false;
    const fraction = this.delta.lengthSq() ? THREE.MathUtils.clamp(-this.relativeFrom.dot(this.delta) / this.delta.lengthSq(), 0, 1) : 0;
    this.blastPoint.lerpVectors(orb.previous, orb.position, fraction);
    return true;
  }

  update(dt: number, clock: number, energy: CursedEnergy, fighter: Faora, targets: readonly CombatTarget[], contacts = targets) {
    if (!this.active.length) return;
    if (energy.burnedOut) { this.clear(); return; }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const orb = this.active[i];
      orb.duration -= dt;
      const upkeep = (1.2 + orb.radius * .55 + orb.force / 65 + orb.speed / 100) * .08;
      if (orb.duration <= 0 || !energy.spend(upkeep * dt)) { this.remove(orb); continue; }
      if (orb.mergeTarget) {
        if (this.active.includes(orb.mergeTarget)) orb.destination.copy(orb.mergeTarget.position);
        else orb.mergeTarget = undefined;
      }
      orb.previous.copy(orb.position);
      this.direction.subVectors(orb.destination, orb.position).clampLength(0, dt * orb.speed);
      orb.position.add(this.direction);
      if (this.direction.lengthSq() > .001 && (this.solid(orb.position) || !fighter.lineClear(orb.previous, orb.position))) {
        orb.position.copy(orb.previous);
        if (orb.color === "red") this.detonate(orb, fighter, targets);
        else this.steer(orb, orb.position, 0);
      }
    }

    // Opposite orbs interact along their relative paths, even when both are in motion.
    for (let i = this.active.length - 1; i > 0; i--) {
      const a = this.active[i];
      for (let j = i - 1; j >= 0; j--) {
        const b = this.active[j];
        if (a.color === b.color) continue;
        if (segmentDistanceSq(this.relativeFrom.subVectors(a.previous, b.previous),
          this.relativeTo.subVectors(a.position, b.position), ZERO, this.delta, this.offset) > (a.radius + b.radius) ** 2) continue;
        const fraction = this.delta.lengthSq() ? THREE.MathUtils.clamp(-this.relativeFrom.dot(this.delta) / this.delta.lengthSq(), 0, 1) : 0;
        this.blastPoint.lerpVectors(a.previous, a.position, fraction)
          .addScaledVector(this.direction.lerpVectors(b.previous, b.position, fraction).sub(this.blastPoint), .5);
        this.remove(a);
        this.remove(b);
        this.explode("remote-purple", this.blastPoint, 6 + this.blastRadius(a) * .54 + this.blastRadius(b) * .54,
          .75 + (a.force + b.force) / 310 + (a.radius + b.radius) * .08, fighter, targets);
        i--;
        break;
      }
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const orb = this.active[i];
      this.effects.showOrb(orb.visual, orb.color, orb.position, orb.radius, clock);
      // Red primed for fusion follows the Blue without knocking its captive clear.
      if (orb.color === "red" && orb.mergeTarget && this.active.includes(orb.mergeTarget)) continue;
      const reach = this.pullReach(orb);
      for (const target of orb.color === "red" ? contacts : targets) {
        if (target.vitals.defeated || target.vitals.frozen || target.vitals.inReviveGrace) continue;
        this.targetPoint.copy(target.pos).y += 1;
        const distance = this.direction.subVectors(orb.position, this.targetPoint).length();
        if (orb.color === "red" && this.updateContact(orb, target)) {
          const previous = this.lastTargetPoint.get(target) ?? this.targetPoint;
          if (fighter.lineClear(this.blastPoint, previous) || fighter.lineClear(this.blastPoint, this.targetPoint)) {
            orb.position.copy(this.blastPoint);
            this.detonate(orb, fighter, targets, target);
            break;
          }
        }
        if (distance >= reach || !targets.includes(target) || !fighter.lineClear(orb.position, this.targetPoint)) continue;
        if (orb.proximityFuse && distance <= this.blastRadius(orb) * .52) {
          this.detonate(orb, fighter, targets);
          break;
        }
        const blue = orb.color === "blue";
        const falloff = Math.min(1, distance / orb.radius) * (1 - (distance / reach) ** 2);
        this.direction.multiplyScalar(orb.force * falloff * (blue ? 3 : -3.4) / Math.max(.05, distance));
        // Dampen motion near the center so a captured fighter does not simply fly through Blue.
        if (blue) this.direction.addScaledVector(target.vel, -7 * Math.max(0, 1 - distance / (reach * .65)));
        const acceleration = this.direction.length();
        if (acceleration > .01) this.pull(target, this.direction.multiplyScalar(1 / acceleration), Math.min(acceleration, blue ? 240 : 300) * dt);
      }
    }
    if (!this.active.length) {
      this.lastTargetPoint = new WeakMap();
      return;
    }
    for (const target of contacts) {
      let previous = this.lastTargetPoint.get(target);
      if (!previous) {
        previous = new THREE.Vector3();
        this.lastTargetPoint.set(target, previous);
      }
      previous.copy(target.pos).y += 1;
    }
  }
}
const ZERO = new THREE.Vector3();
