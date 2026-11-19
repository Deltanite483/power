import type * as THREE from 'three';
export const DOOMSDAY_BEAM_STRENGTH=130;
export const DOOMSDAY_BEAM_DAMAGE_SCALE=.04;
export const DOOMSDAY_BEAM_IMPULSE=1100;

/** Repeated beam ticks maintain a hard shove without accelerating the player indefinitely. */
export function limitBeamPush(velocity:THREE.Vector3,direction:THREE.Vector3,previousAlong:number){
  const along=velocity.dot(direction),limit=Math.max(110,previousAlong);
  if(along>limit)velocity.addScaledVector(direction,limit-along);
}
