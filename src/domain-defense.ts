import { CURSED_COST, type CursedEnergy } from "./cursed-energy";

export type DomainDefenseKind = "simple-domain" | "falling-blossom";
const SIMPLE_DOMAIN_TIME = 2.25, SIMPLE_DOMAIN_COOLDOWN = 18;
const BLOSSOM_TIME = 3.4, BLOSSOM_COOLDOWN = 13;
/** Falling Blossom doesn't stop a sure-hit, it blunts it to this fraction. */
export const BLOSSOM_WARD = .26;

/** Anti-domain techniques against a sure-hit: Simple Domain first (blocks it), then Falling Blossom (blunts it).
 * Gojo uses it against Malevolent Shrine and Sukuna against Unlimited Void. */
export class DomainDefense {
  private clock = 0;
  private simpleUntil = 0;
  private blossomUntil = 0;
  private simpleReady = 0;
  private blossomReady = 0;

  update(dt: number) { this.clock += Math.max(0, dt); }

  reset() { this.clock = this.simpleUntil = this.blossomUntil = this.simpleReady = this.blossomReady = 0; }

  /** Cover already raised, without spending anything: 0 inside Simple Domain, BLOSSOM_WARD inside Falling Blossom, else 1. */
  get cover() {
    return this.clock < this.simpleUntil ? 0 : this.clock < this.blossomUntil ? BLOSSOM_WARD : 1;
  }

  /** Damage scale against one sure-hit, raising Simple Domain or then Falling Blossom when it is uncovered. */
  defend(energy: CursedEnergy | null, able: boolean, onUse: (kind: DomainDefenseKind) => void = () => {}) {
    const cover = this.cover;
    if (cover < 1 || !able || !energy) return cover;
    if (this.clock >= this.simpleReady && energy.spend(CURSED_COST.simpleDomain)) {
      this.simpleUntil = this.clock + SIMPLE_DOMAIN_TIME;
      this.simpleReady = this.simpleUntil + SIMPLE_DOMAIN_COOLDOWN;
      onUse("simple-domain");
      return 0;
    }
    if (this.clock >= this.blossomReady && energy.spend(CURSED_COST.fallingBlossom)) {
      this.blossomUntil = this.clock + BLOSSOM_TIME;
      this.blossomReady = this.blossomUntil + BLOSSOM_COOLDOWN;
      onUse("falling-blossom");
      return BLOSSOM_WARD;
    }
    return 1;
  }
}
