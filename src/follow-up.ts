import * as THREE from "three";
import type { Player } from "./player";
import type { Faora } from "./faora";
import { BODY_CENTER, PathFollower, speedMargin, type Pathfinder } from "./pathing";

export function nearestEnemy(fighters: readonly Faora[], position: THREE.Vector3): Faora | null {
  let nearest: Faora | null = null, best = Infinity;
  for (const fighter of fighters) {
    if (!fighter.hostile || fighter.vitals.defeated || fighter.held) continue;
    const distance = fighter.pos.distanceToSquared(position);
    if (distance < best) { best = distance; nearest = fighter; }
  }
  return nearest;
}

/** A lock selects the target; these temporary conditions only postpone the chase. */
export function pursuitBlockReason(player:Player,target:Faora,combatIdle=true):string|null {
  if(player.vitals.defeated)return "You are downed";
  if(target.vitals.defeated)return "Target is downed";
  if(target.held)return "Release the target first";
  if(!target.hostile)return "Target is no longer hostile";
  if(!combatIdle)return "Waiting for punch / guard to finish";
  if(player.vitals.orientation<35)return "Dazed · Q to recover flight";
  return null;
}

/** Fraction of a movement segment at first contact with a body sphere. */
export function ramContact(offset: THREE.Vector3, travel: THREE.Vector3, radius: number): number | null {
  const a = travel.lengthSq(), b = offset.dot(travel);
  if (a < 1e-10 || b >= 0) return null;
  const c = offset.lengthSq() - radius * radius;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const t = Math.max(0, (-b - Math.sqrt(discriminant)) / a);
  return t <= 1 ? t : null;
}

const THRUST = 450;
const DETOUR_ACCELERATION = 900;
const DETOUR_SPEED = 160; // m/s cap while routing around things: fast enough to chase, slow enough to make the corners
const ROUTE_RETRY = .4; // keep trying safely when the route is temporarily obstructed

/** Guide flight around obstacles and carry its speed into contact. */
export class FollowUp {
  target: Faora | null = null;
  active = false;
  onRam: (target: Faora, direction: THREE.Vector3, speed: number) => void = () => {};
  waitingForRoute=false;
  private routeRetry=0;
  private routeElapsed=0;
  private readonly route: PathFollower;
  private readonly from = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly change = new THREE.Vector3();
  private readonly heading = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly rotation = new THREE.Quaternion();
  private readonly offset = new THREE.Vector3();
  private readonly contact = new THREE.Vector3();

  constructor(pathfinder: Pathfinder) { this.route = new PathFollower(pathfinder, 0); }

  start(player: Player, target: Faora): boolean {
    if (pursuitBlockReason(player,target)) return false;
    this.target = target;
    player.setFlying(true);
    if (!player.flying) return false;
    this.route.reset();this.waitingForRoute=false;this.routeRetry=0;this.routeElapsed=0;
    this.active = true;
    return true;
  }

  cancel() { this.active = false; this.waitingForRoute=false; }

  update(dt: number, player: Player) {
    if (!this.active) return;
    const target = this.target;
    if (!target || !player.flying || player.vitals.defeated || target.vitals.defeated || target.held || !target.hostile) { this.cancel(); return; }
    this.routeElapsed+=dt;
    this.routeRetry=Math.max(0,this.routeRetry-dt);
    if(this.waitingForRoute && this.routeRetry>0){player.vel.set(0,0,0);return;}
    this.direction.subVectors(target.pos, player.pos);
    const separation = this.direction.length();
    if (separation > .001) this.direction.multiplyScalar(1 / separation);
    else this.direction.set(0, 0, 0);
    const speed = player.vel.length();
    const closing = Math.max(30, speed, player.flySpeed) - Math.min(0, target.vel.dot(this.direction));
    const lead = Math.min(.75, separation / closing) * THREE.MathUtils.smoothstep(separation, 6, 28);
    this.from.copy(player.pos).y += BODY_CENTER;
    this.goal.copy(target.pos).addScaledVector(target.vel, lead).y += BODY_CENTER * target.bodyScale;
    const waypoint = this.route.update(this.routeElapsed, this.from, this.goal,
      Math.max(60, speed * 1.5), speedMargin(speed));
    this.routeElapsed=0;
    if(this.route.mode==="stuck") {
      // Stop before an obstruction, retaining the lock and chase intent. Never fly at a failed route.
      player.vel.set(0,0,0);
      this.waitingForRoute=true;this.routeRetry=ROUTE_RETRY;
      return;
    }
    this.waitingForRoute=false;

    if (this.route.detouring) {
      // Slow only for obstacle corners.
      this.route.detourVelocity(this.from, Math.min(player.flySpeed, DETOUR_SPEED), DETOUR_ACCELERATION, this.change).sub(player.vel);
      const amount = this.change.length();
      if (amount > 0) player.vel.addScaledVector(this.change, Math.min(1, DETOUR_ACCELERATION * dt / amount));
      return;
    }

    this.direction.subVectors(waypoint, this.from);
    if (this.direction.lengthSq() < .000001) return;
    this.direction.normalize();
    if (speed > .01) {
      this.heading.copy(player.vel).divideScalar(speed);
      const angle = this.heading.angleTo(this.direction);
      if (angle > .001) {
        this.rotation.setFromUnitVectors(this.heading, this.direction);
        this.turn.identity().slerp(this.rotation, Math.min(1, dt * 10 / angle));
        this.direction.copy(this.heading).applyQuaternion(this.turn);
      }
    }
    const cruise = Math.max(player.flySpeed, target.vel.dot(this.direction) + Math.min(player.flySpeed, 30));
    player.vel.copy(this.direction).multiplyScalar(Math.max(speed, Math.min(cruise, speed + THRUST * dt)));
  }

  /** Sweep actual movement after terrain collision, including at speeds that cross a body in one step. */
  sweep(player: Player, previous: THREE.Vector3) {
    const target = this.target;
    if (!this.active || this.waitingForRoute || !target) return;
    this.goal.copy(target.pos).y += BODY_CENTER * target.bodyScale;
    this.from.copy(previous).y += BODY_CENTER;
    this.offset.subVectors(this.from, this.goal);
    this.change.subVectors(player.pos, previous);
    if (player.vel.lengthSq() < 1) return;
    const t = ramContact(this.offset,this.change,.45 + target.bodyScale * .58);
    if (t === null) return;
    this.contact.copy(this.from).addScaledVector(this.change,t);
    if (!target.lineClear(this.contact,this.goal)) return;

    const speed = player.vel.length();
    this.direction.copy(player.vel).divideScalar(speed);
    player.pos.copy(this.contact).y -= BODY_CENTER;
    player.vel.multiplyScalar(-.12);
    this.cancel();
    this.onRam(target,this.direction,speed);
  }
}
