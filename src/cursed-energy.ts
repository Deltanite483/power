const CAPACITY = 100;
const REGEN_PER_SECOND = 4;
/** Technique burnout after a domain closes normally. */
export const BURNOUT_SECONDS = 7;
/** A domain clash cancels both domains, and each caster burns out this many times longer. */
export const CLASH_BURNOUT_SCALE = 3;
const BLACK_FLASH_REFUND = 16;
const FOCUS_SECONDS = 6;
/** After a Black Flash the sorcerer is "in the zone": techniques cost this fraction while focus lasts. */
const ZONE_COST = .75;
/** Negative emotions generate cursed energy: CE gained per HP lost to damage. */
const PAIN_CE_PER_HP = .2;
/** Pain only tops the reserve up to this fraction, so a beating fuels a comeback, not an endless supply. */
const PAIN_RESERVE_CAP = .6;

export const RCT_HEAL_FRACTION = .66;
/** Caught inside an enemy's domain, expanding your own costs this fraction: a domain is answered with a domain. */
export const COUNTER_DOMAIN_COST = .4;

export const CURSED_COST = {
  melee: 3, gojoMelee: 4, infinity: 1.2, blink: 9, simpleDomain: 9, fallingBlossom: 12,
  blueMelee: 12, redMelee: 16, blue: 7, red: 10, maximumBlue: 12,
  dismantle: 16, cleave: 20, rct: 24,
  purple: 30, openingPurple: 38, worldSlash: 37, fuga: 15, domain: 76,
} as const;

/** Per-fighter reserve with separate readings for the HUD and the combat aura. */
export class CursedEnergy {
  #reserve = CAPACITY;
  #domain = false;
  #costScale = 1;
  #burnout = 0;
  #focus = 0;
  #rctCooldown = 0;
  /** Gojo's Six Eyes waste almost nothing, so his reserve refills faster than Sukuna's. */
  constructor(private readonly regen = REGEN_PER_SECOND) {}

  get reserveFraction() { return this.#reserve / CAPACITY; }
  get auraLevel() { return this.reserveFraction * (this.burnedOut ? .18 : 1); }
  get burnedOut() { return this.#domain || this.#burnout > 0; }
  get canHeal() { return this.#rctCooldown === 0 && this.canSpend(CURSED_COST.rct); }

  setInfinity(active: boolean) { this.#costScale = active ? 1.25 : 1; }

  /** True while a Black Flash has the sorcerer "in the zone". */
  get inZone() { return this.#focus > 0 && !this.burnedOut; }

  private scaled(cost: number) { return cost * this.#costScale * (this.inZone ? ZONE_COST : 1); }

  canSpend(cost: number, keep = 0) {
    return !this.burnedOut && this.#reserve >= this.scaled(cost) + keep;
  }

  spend(cost: number) {
    if (!this.canSpend(cost)) return false;
    this.#reserve -= this.scaled(cost);
    return true;
  }

  /** Pain, anger and fear are where cursed energy comes from: taking damage yields a sliver of CE. */
  fromPain(healthLost: number) {
    if (this.burnedOut || !(healthLost > 0)) return;
    const cap = CAPACITY * PAIN_RESERVE_CAP;
    if (this.#reserve < cap) this.#reserve = Math.min(cap, this.#reserve + healthLost * PAIN_CE_PER_HP);
  }

  spendUpkeep(cost: number) {
    if (this.burnedOut || this.#reserve < cost) return false;
    this.#reserve -= cost;
    return true;
  }

  startRct() {
    if (!this.canHeal || !this.spend(CURSED_COST.rct)) return false;
    this.#rctCooldown = 18;
    return true;
  }

  openDomain() { this.#domain = true; }

  /** burnout: seconds of technique burnout after the domain; longer domains burn out longer. */
  closeDomain(burnout = BURNOUT_SECONDS) {
    if (!this.#domain) return;
    this.#domain = false;
    this.#burnout = burnout;
  }

  /** A technique drawn inside his own open domain (Fuga as the Shrine closes), before burnout sets in. */
  spendDuringDomain(cost: number) {
    if (!this.#domain || this.#reserve < cost) return false;
    this.#reserve -= cost;
    return true;
  }

  update(dt: number) {
    const availableTime = this.#domain ? 0 : Math.max(0, dt - this.#burnout);
    const focusTime = Math.min(availableTime, Math.max(0, this.#focus - (dt - availableTime)));
    this.#burnout = Math.max(0, this.#burnout - dt);
    this.#focus = Math.max(0, this.#focus - dt);
    this.#rctCooldown = Math.max(0, this.#rctCooldown - dt);
    this.#reserve = Math.min(CAPACITY, this.#reserve + this.regen * (availableTime + focusTime * .35));
  }

  rollsBlackFlash(random = Math.random) {
    if (this.burnedOut) return false;
    const missing = 1 - this.#reserve / CAPACITY;
    return random() < .025 + .10 * missing ** 2;
  }

  landedBlackFlash() {
    if (this.burnedOut) return;
    this.#reserve = Math.min(CAPACITY, this.#reserve + BLACK_FLASH_REFUND);
    this.#focus = FOCUS_SECONDS;
  }

  reset() {
    this.#reserve = CAPACITY;
    this.#costScale = 1;
    this.#domain = false;
    this.#burnout = this.#focus = this.#rctCooldown = 0;
  }
}
