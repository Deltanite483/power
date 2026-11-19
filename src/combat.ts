export const MELEE_CHARGE_THRESHOLD = .3;
export const RAM_BLOCK_DAMAGE = .25;
export const RAM_TRANSFER = .5;
export const ANISSA_RAM_DAMAGE_MULTIPLIER = 1.2;
export const ramStrength = (speed: number) => speed * .45;

/** Shared combat charge and guard arithmetic, expressed in attack/guard points. */
export class Combat {
  mode: "idle" | "attack" | "guard" = "idle";
  kick = false;
  attack = 0;
  guard = 0;

  begin(mode: "attack" | "guard", kick=false): boolean {
    if (this.mode === mode || (mode === "attack" && this.mode === "guard")) return false;
    this.cancel();
    this.mode = mode;
    this.kick=mode==="attack" && kick;
    if (mode === "attack") this.attack = 0;
    else this.guard = 0;
    return true;
  }

  armKick() { if(this.mode!=="attack")return false;this.kick=true;return true; }

  update(dt: number, accelerated: boolean) {
    const increment = Math.max(0, dt) * (accelerated ? 2 : 1) / 2;
    if (this.mode === "attack") this.attack = Math.min(1, this.attack + increment);
    if (this.mode === "guard") this.guard = Math.min(100, this.guard + increment * 100);
  }

  end(mode: "attack" | "guard"): number | null {
    if (this.mode !== mode) return null;
    const charge = this.attack;
    this.mode = "idle";
    this.kick = false;
    this.attack = 0;
    this.guard = 0;
    return charge;
  }

  cancel() { this.kick=false;this.mode = "idle"; this.attack = 0; this.guard = 0; }

  /** Return the fraction of an incoming attack that gets through. */
  defend(amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    if (this.mode !== "guard") return 1;
    const absorbed = Math.min(this.guard, amount);
    this.guard -= absorbed;
    return Math.max(0, (amount - absorbed) / amount);
  }
}
