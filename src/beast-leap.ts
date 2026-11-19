import * as THREE from 'three';
import type { Destruction } from './destruction';

const GRAVITY = 9.81;
export interface BeastJump {
  velocity: THREE.Vector3;
  destination: THREE.Vector3;
  duration: number;
}
interface JumpProfile {distance:number;rise:number;fall:number;horizontal:number;vertical:number;times:readonly number[];}
const STANDARD:JumpProfile={distance:220,rise:55,fall:65,horizontal:55,vertical:35,times:[]};
export const SUKUNA_JUMP: JumpProfile = { distance: 28, rise: 5, fall: 6, horizontal: 32, vertical: 12, times: [1, 1.2, 1.45, 1.65] };
export const DOOMSDAY_JUMP:JumpProfile={distance:800,rise:180,fall:120,horizontal:240,vertical:65,times:[.9,1.2,1.6,2,2.4,3,3.6,4.4,5.3,6.5,8]};

/** A ballistic jump to a real destination, including uphill landings and midair interceptions. */
export function planBeastJump(world: Destruction, from: THREE.Vector3, destination: THREE.Vector3, size: number,profile:JumpProfile=STANDARD): BeastJump | null {
  const delta = destination.clone().sub(from), distance = Math.hypot(delta.x, delta.z);
  if (distance > profile.distance || delta.y > profile.rise || delta.y < -profile.fall) return null;
  // Long leaps retain their huge arc; shorter hops try a low, fast arc first.
  const times = profile.times.length?profile.times:distance > 55 ? [5.3, 3.6, 4.4] : [1.8, 1.4, 2.2, 2.8, 3.6, 4.4, 5.3];
  const p = new THREE.Vector3(), width = .4 * size;
  let probes=0;
  for (const duration of times) {
    const velocity = delta.clone().divideScalar(duration);
    velocity.y += GRAVITY * duration / 2;
    if (velocity.y < 4 || velocity.y > profile.vertical || distance / duration > profile.horizontal) continue;
    // Check feet, torso, head and body width throughout the actual parabolic trajectory.
    const steps = Math.min(768,Math.ceil(Math.max(duration * 30, distance / .4)));
    let clear = true;
    for (let i=1;i<=steps && clear;i++) {
      if(profile.times.length && ++probes>1536)return null;
      const t = duration * i / steps;
      p.copy(from).addScaledVector(velocity,t); p.y -= .5 * GRAVITY * t * t;
      for (const [x,z] of [[0,0],[width,0],[-width,0],[0,width],[0,-width]]) {
        const spans = world.spans(p.x+x,p.z+z);
        if (spans.solid(p.y+.12) || spans.solid(p.y+size) || spans.solid(p.y+1.9*size)) { clear=false; break; }
      }
    }
    if (clear) return {velocity,destination:destination.clone(),duration};
  }
  return null;
}

/** Find a higher, supported rim when walking cannot leave a crater. Never teleport out. */
export function planBeastEscape(world: Destruction, from: THREE.Vector3, goal: THREE.Vector3, size: number): BeastJump | null {
  const heading = Math.atan2(goal.z-from.z,goal.x-from.x);
  const candidates: {point:THREE.Vector3;score:number}[] = [];
  for (const radius of [5,10,18,28]) for (let n=0;n<8;n++) {
    const angle=heading+n*Math.PI/4, x=from.x+Math.cos(angle)*radius, z=from.z+Math.sin(angle)*radius;
    const spans=world.spans(x,z), y=spans.floor(from.y+24);
    if (!Number.isFinite(y) || y-from.y<.8 || y-from.y>20 || spans.solid(y+1.9*size)) continue;
    const point=new THREE.Vector3(x,y+.05,z);
    candidates.push({point,score:Math.hypot(goal.x-x,goal.z-z)+radius*.25+(y-from.y)*.3});
  }
  candidates.sort((a,b)=>a.score-b.score);
  for (const candidate of candidates.slice(0,10)) {
    const jump=planBeastJump(world,from,candidate.point,size);
    if (jump) return jump;
  }
  return null;
}
