import * as THREE from "three";
import { CombatFx } from "./combat-fx";

/** Blood, sparks and flashes come from fixed GPU pools, so feedback stays bounded even during sustained combat. */
export class DamageEffects {
  readonly fx: CombatFx;
  private flash = 0;
  private lowHealth = 0;
  private readonly overlay: HTMLDivElement;
  private readonly healthOverlay: HTMLDivElement;
  private readonly wound = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.fx = new CombatFx(scene);
    this.overlay = document.createElement("div");
    this.overlay.className = "damage-flash";
    this.overlay.setAttribute("aria-hidden", "true");
    document.body.appendChild(this.overlay);
    this.healthOverlay = document.createElement("div");
    this.healthOverlay.className = "low-health-vignette";
    this.healthOverlay.setAttribute("aria-hidden", "true");
    const pulse = document.createElement("div");
    pulse.className = "low-health-pulse";
    this.healthOverlay.appendChild(pulse);
    document.body.appendChild(this.healthOverlay);
  }

  /** position is the victim's feet; scale is their body scale, so wounds open at chest height on giants too. */
  hit(position: THREE.Vector3, strength: number, direction?: THREE.Vector3, player = false, scale = 1) {
    const intensity = THREE.MathUtils.clamp(strength / 75, .15, 1);
    this.wound.copy(position).y += 1.15 * scale;
    // Your own wounds are felt on screen; a flash in your face would only blind you.
    if (!player) {
      if (direction) this.wound.addScaledVector(direction, -.25 * scale);
      this.fx.hit(this.wound, direction, intensity * (.6 + scale * .4));
      this.fx.bleed(this.wound, direction, intensity);
    }
    if (player) this.flash = Math.min(.9, Math.max(this.flash, .28 + intensity * .55) + this.flash * .12);
  }

  /** Clear screen feedback immediately on respawn. */
  resetScreen() {
    this.flash = this.lowHealth = 0;
    this.overlay.style.opacity = "0";
    this.healthOverlay.style.opacity = "0";
    this.healthOverlay.classList.remove("active", "critical", "defeated");
  }

  update(dt: number, health = 100, realDt = dt) {
    this.fx.update(dt);
    // Screen feedback runs in real time so hitstop doesn't hold the hit flash on screen.
    this.flash *= Math.exp(-Math.max(0, realDt) * 5);
    if (this.flash < .001) this.flash = 0;
    this.overlay.style.opacity = String(this.flash);
    const severity = THREE.MathUtils.clamp((50 - health) / 40, 0, 1);
    const target = severity * severity * (3 - 2 * severity) * .85;
    this.lowHealth += (target - this.lowHealth) * (1 - Math.exp(-Math.max(0, realDt) * 4));
    if (this.lowHealth < .001 && target === 0) this.lowHealth = 0;
    this.healthOverlay.style.opacity = String(this.lowHealth);
    this.healthOverlay.classList.toggle("active", this.lowHealth > .001);
    this.healthOverlay.classList.toggle("critical", health > 0 && health <= 25);
    this.healthOverlay.classList.toggle("defeated", health <= 0);
  }
}
