/** Unguarded hits weaker than this (attack strength; a full charge is 100) only stagger: full damage, a shove, no launch. */
export const STAGGER_LIMIT = 45;
/** m/s of shove a staggering hit gives. */
export const STAGGER_PUSH = 8;
/** Convert excess punch force to launch speed without throwing fighters across the map. */
const LAUNCH_SCALE = 0.15;
export const MAX_REVIVES = 3;
const REVIVE_GRACE_SECONDS = 6;
export const GUARD_HEAL_MULTIPLIER = 3;

/** Guard has already been deducted from strength and speed. Only force beyond
 * natural resistance contributes to a launch; this also avoids a speed jump
 * when a hit barely crosses the stagger threshold. */
export function launchSpeed(speed: number, through: number, resistance = STAGGER_LIMIT): number {
  if (!Number.isFinite(speed) || !Number.isFinite(through) || speed <= 0 || through <= resistance) return 0;
  return speed * (through - resistance) / through * LAUNCH_SCALE;
}

/** Quick punches take about 8–12 HP; a clean full-charge hit takes 24. */
export function hitDamage(strength: number): number {
  if (!Number.isFinite(strength) || strength <= 0) return 0;
  return strength <= STAGGER_LIMIT ? Math.min(12, strength / 3.6) : Math.min(30, 12 + (strength - STAGGER_LIMIT) * 12 / 55);
}

export class Vitality {
  damageScale = 1;
  health: number;
  orientation = 100;
  private quietTime = 0;
  private reviveGraceRemaining = 0;
  private readonly stasis = new Set<object>();
  private stasisRecovery = 0;

  constructor(readonly maxHealth = 100, private readonly onHealthLost?: () => void) {
    this.health = maxHealth;
  }

  get healthFraction() { return this.health / this.maxHealth; }
  get inReviveGrace() { return this.reviveGraceRemaining > 0; }
  get frozen() { return this.stasis.size > 0; }
  freeze(source: object) { if (!this.defeated) this.stasis.add(source); }
  thaw(source: object) {
    if (this.stasis.delete(source) && !this.frozen) this.stasisRecovery = 1.5;
  }

  drainWhileFrozen(source: object, remainingFraction: number) {
    if (!this.stasis.has(source) || this.defeated) return 0;
    const previous = this.health;
    this.health *= remainingFraction;
    return this.recordDamage(previous);
  }

  advanceReviveGrace(elapsed: number) {
    this.reviveGraceRemaining = Math.max(0, this.reviveGraceRemaining - elapsed);
  }
  revivesUsed = 0;
  damageRevision = 0;
  get defeated() { return this.health <= 0; }
  get revivesRemaining() { return Math.max(0,MAX_REVIVES-this.revivesUsed); }
  get downed() { return this.defeated && this.revivesRemaining>0; }
  get eliminated() { return this.defeated && this.revivesRemaining===0; }
  get control() { return .4 + .6 * this.orientation / 100; }

  hit(strength: number, damageMultiplier=1, bypassDefenseStat=false) {
    if (this.defeated || this.frozen || this.inReviveGrace || !Number.isFinite(strength) || strength <= 0 || !Number.isFinite(damageMultiplier) || damageMultiplier<=0) return false;
    const defenseScale = bypassDefenseStat ? 1 : this.damageScale;
    const previous = this.health;
    this.health = Math.max(0, this.health - hitDamage(strength) * defenseScale * damageMultiplier);
    this.orientation = Math.max(0, this.orientation - Math.min(40, strength * .4 * defenseScale));
    this.recordDamage(previous);
    return true;
  }

  private recordDamage(previousHealth: number) {
    this.quietTime = 0;
    this.damageRevision++;
    const damage = previousHealth - this.health;
    if (damage > 0) this.onHealthLost?.();
    return damage;
  }

  update(dt: number, guarding=false, regenerateHealth=true) {
    if (this.defeated || this.frozen) return;
    const elapsed = Math.max(0, dt);
    const healingTime = Math.max(0, elapsed - this.stasisRecovery);
    this.stasisRecovery = Math.max(0, this.stasisRecovery - elapsed);
    this.quietTime += elapsed;
    if (this.quietTime > 1.5) this.orientation = Math.min(100, this.orientation + dt * 8);
    if (regenerateHealth) this.health = Math.min(this.maxHealth, this.health + healingTime * .6 * (guarding ? GUARD_HEAL_MULTIPLIER : 1));
  }

  recoverWhenQuiet(dt: number, rate: number, delay: number) {
    if (!this.defeated && !this.frozen && this.stasisRecovery === 0 && this.quietTime >= delay) this.health = Math.min(this.maxHealth,this.health + dt * rate);
  }

  revive(health=this.maxHealth * .4,consumeRevive=true):boolean {
    if(!this.defeated || (consumeRevive && !this.downed) || !Number.isFinite(health) || health<=0)return false;
    if(consumeRevive)this.revivesUsed++;
    this.stasis.clear();
    this.stasisRecovery = 0;
    this.health=Math.min(this.maxHealth,health);this.orientation=Math.max(60,this.healthFraction * 100);this.quietTime=0;
    this.reviveGraceRemaining = REVIVE_GRACE_SECONDS;
    return true;
  }

  reset() { this.stasis.clear(); this.stasisRecovery = 0; this.health = this.maxHealth; this.orientation = 100; this.quietTime = 0; this.revivesUsed=0;this.reviveGraceRemaining=0;this.damageRevision++; }
}
