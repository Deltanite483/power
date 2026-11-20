import * as THREE from "three";
import type { Faora } from "./faora";
import type { Player } from "./player";
import type { HitSource } from "./combat-events";

type Captive = Player | Faora;
type Attack = "punch" | "kick" | "throw";
const STRUGGLE_TIME = 4;
const GRAB_COOLDOWN = 6;
const ESCAPE_PUNCHES = 4; // punches for the player to break free; kept low so her grab stays a hiccup, not a chore

export class AnissaGrab {
  private captive: Captive | null = null;
  private age = 0;
  private stage = 0;
  private taps = 0;
  private cooldown = 0;
  private readonly direction = new THREE.Vector3();
  private readonly chest = new THREE.Vector3();
  private readonly grip = new THREE.Vector3();
  private readonly feet = new THREE.Vector3();
  private readonly grabberEyes = new THREE.Vector3();

  constructor(private anissa: Faora, private player: Player, private source: (action: Attack) => HitSource) {}

  get active() { return this.captive !== null; }
  get holdingPlayer() { return this.captive === this.player && this.player.held; }
  holds(captive: Captive) { return this.captive === captive; }
  get progress() { return this.taps / ESCAPE_PUNCHES; }

  start(captive: Captive): boolean {
    if (this.captive || this.cooldown > 0 || captive.held || captive.vitals.defeated
      || captive.vitals.inReviveGrace || captive.vitals.frozen || ("bodyScale" in captive ? captive.cannotBeGrabbed || captive.superBlocking : captive.superBlock.active) || captive.pos.distanceToSquared(this.anissa.pos) > 3.6 ** 2) return false;
    const scale = "bodyScale" in captive ? captive.bodyScale : 1;
    this.chest.copy(this.anissa.pos).y += 1.15;
    this.grip.copy(captive.pos).y += .9 * scale;
    if (!this.anissa.lineClear(this.chest,this.grip)) return false;
    this.direction.subVectors(this.grip,this.chest).setY(0);
    if(this.direction.lengthSq()<.01)this.direction.set(0,0,1);
    this.direction.normalize();

    this.captive = captive;
    this.age = this.stage = this.taps = 0;
    this.anissa.vel.set(0,0,0);
    this.anissa.poseGrapple("hold",this.direction);
    if ("bodyScale" in captive) {
      captive.setHeld(true,STRUGGLE_TIME);
      captive.setGripPoint(this.grip,this.yaw);
    } else captive.setHeld(true);
    return true;
  }

  private get yaw() { return Math.atan2(this.direction.x,this.direction.z); }

  punchToEscape() {
    if (!this.holdingPlayer) return;
    if (++this.taps >= ESCAPE_PUNCHES) this.end();
  }

  end() {
    const captive = this.captive;
    if (!captive) return;
    this.captive = null;
    this.cooldown = GRAB_COOLDOWN;
    this.anissa.poseGrapple(null,this.direction);
    if (captive.held) captive.setHeld(false);
  }

  update(dt: number, valid: (captive: Captive) => boolean) {
    this.cooldown = Math.max(0,this.cooldown-dt);
    const captive = this.captive;
    if (!captive) return;
    if (!captive.held || captive.vitals.defeated || !valid(captive) || !this.anissa.canMaintainGrapple) {
      this.end();
      return;
    }
    const scale = "bodyScale" in captive ? captive.bodyScale : 1;
    this.chest.copy(this.anissa.pos).y += 1.15;
    this.grip.copy(this.chest).addScaledVector(this.direction,1.65+.35*scale);
    if (!this.anissa.lineClear(this.chest,this.grip)) { this.end(); return; }
    if ("bodyScale" in captive) captive.moveHeld(this.grip,this.anissa.vel,this.yaw);
    else {
      this.feet.copy(this.grip).y -= .9;
      this.grabberEyes.copy(this.anissa.pos).y = this.anissa.asTarget.eyeLevel;
      captive.moveHeld(this.feet, this.grabberEyes);
    }

    this.age += dt;
    if (this.stage === 0 && this.age >= .75) this.hit(captive,"punch",28,1);
    else if (this.stage === 1 && this.age >= 1.8) this.hit(captive,"kick",36,2);
    else if (this.stage === 2 && this.age >= 3.45) {
      this.feet.copy(this.grip).addScaledVector(this.direction,26).y += 2;
      const clearLane = this.anissa.lineClear(this.grip,this.feet);
      if(captive !== this.player && !clearLane) return;
      this.hit(captive,"throw",55,1);
      if (!captive.held || captive.vitals.defeated) { this.end(); return; }
      this.feet.copy(this.direction).y = .13;
      this.feet.normalize();
      if ("bodyScale" in captive) captive.release(this.feet,this.anissa.vel);
      else captive.vel.copy(this.anissa.vel).addScaledVector(this.feet,230);
      this.end();
      this.anissa.poseGrapple("throw",this.direction);
      if(clearLane)this.anissa.followThrownTarget("bodyScale" in captive ? captive.asTarget : captive);
    }
  }

  private hit(captive: Captive, action: Attack, strength: number, multiplier: number) {
    this.stage++;
    this.anissa.poseGrapple(action,this.direction);
    if ("bodyScale" in captive) captive.strike(this.direction,this.anissa.vel,0,false,strength,multiplier,this.source(action));
    else captive.receiveHit(strength,multiplier,this.source(action));
  }
}
