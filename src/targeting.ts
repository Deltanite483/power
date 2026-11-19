import type * as THREE from 'three';
import type {Faora,CombatTarget} from './faora';

/** Omniscient tracking: live positions, no sight/range gate, including casualties awaiting a return. */
export function doomsdayAwareness(fighter:Faora,roster:readonly Faora[],player:CombatTarget|null){
  const active=roster.filter(other=>other!==fighter && other.model.visible);
  const known=active.map(other=>other.asTarget);
  if(player)known.unshift(player);
  if(!fighter.enemyMode && !fighter.hostile && fighter.recallTime>0)return {known,opponent:null,hasTarget:false};
  let opponent:Faora|null=null;
  let score=(fighter.enemyMode || fighter.hostile) && player && !player.vitals.defeated
    ?fighter.pos.distanceTo(player.pos)*.75*(fighter.opponent===null?.85:1):Infinity;
  const angryFriend=fighter.hostile && !fighter.enemyMode;
  if(!angryFriend)for(const other of active){
    if(other.enemyMode===fighter.enemyMode || other.vitals.defeated || other.held)continue;
    const distance=fighter.pos.distanceTo(other.pos)*(fighter.opponent===other?.85:1);
    if(distance<score){score=distance;opponent=other;}
  }
  return {known,opponent,hasTarget:Number.isFinite(score)};
}

/** Battle Beast hunts across the map; the other friendly flyers protect the local fight. */
export function friendOpponent(fighter:Faora,roster:readonly Faora[],player:THREE.Vector3):Faora|null {
  if(fighter.hostile || fighter.recallTime>0 || fighter.held || fighter.rescueTarget)return null;
  let best:Faora|null=null, bestDistance=fighter.groundOnly?Infinity:fighter.isGojo?300:150;
  for(const other of roster){
    if(other===fighter || !other.model.visible || other.enemyMode===fighter.enemyMode || other.vitals.defeated || other.held)continue;
    if(!fighter.groundOnly && other.opponent!==fighter && other.pos.distanceTo(player)>(fighter.isGojo?330:220))continue;
    const distance=other.pos.distanceTo(fighter.pos)*(other===fighter.opponent ? .8 : 1);
    if(distance<bestDistance){best=other;bestDistance=distance;}
  }
  return best;
}
