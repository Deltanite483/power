import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
  const {Faora}=await server.ssrLoadModule('/src/faora.ts');
  const {Vitality}=await server.ssrLoadModule('/src/vitality.ts');
  const {doomsdayAwareness}=await server.ssrLoadModule('/src/targeting.ts');
  const {RevivalSystem}=await server.ssrLoadModule('/src/revival.ts');
  const world={spans:()=>({top:0,floor:()=>0,ceil:()=>Infinity,solid:()=>false}),materialAt:()=>({bounce:0}),crater(){},launch(){}};
  const scene=new THREE.Scene(),doom=new Faora(world,scene,'Doomsday'),friend=new Faora(world,scene),ally=new Faora(world,scene,'Anissa');
  doom.spawn(0,0);friend.spawn(30000,0);ally.spawn(10,0);doom.setEnemyMode(true);ally.setEnemyMode(true);
  const player={pos:new THREE.Vector3(24000,0,0),vel:new THREE.Vector3(),speed:0,yaw:0,pitch:0,onGround:true,flying:false,inWater:false,eyeLevel:1.6,vitals:new Vitality()};
  doom.visibleToPlayer=false;doom.lineClear=()=>false;
  const roster=[doom,friend,ally];let awareness=doomsdayAwareness(doom,roster,player);
  assert(awareness.hasTarget && awareness.opponent===null,'tracks the player 24 km away without sight');
  assert.equal(awareness.known.length,3,'knows the player and every active other fighter');
  friend.pos.x=5;awareness=doomsdayAwareness(doom,roster,player);assert.equal(awareness.opponent,friend,'instantly switches to a nearby opponent');
  friend.pos.x=40000;awareness=doomsdayAwareness(doom,roster,player);assert.equal(awareness.opponent,null,'instantly follows updated player/teammate positions');
  const observed=awareness.known.find(target=>target===friend.asTarget);friend.pos.z=1234;
  assert.equal(observed.pos.z,1234,'awareness stores live positions rather than stale last-seen locations');
  friend.vitals.health=0;player.vitals.health=0;ally.vitals.health=0;
  awareness=doomsdayAwareness(doom,roster,player);assert(!awareness.hasTarget && awareness.known.length===3,'retains casualty locations while waiting for opponents to return');
  player.vitals.revive(75,false);assert(doomsdayAwareness(doom,roster,player).hasTarget,'immediately reacquires a returning player');

  const rescue=new RevivalSystem();
  const helper={id:'Doomsday',enemy:true,pos:doom.pos,vitals:doom.vitals,canHelp:!doomsdayAwareness(doom,roster,player).hasTarget,maxDistance:Infinity,canReach:()=>true,setGoal(other){this.goal=other?.id??null;},revive:()=>doom.revive()};
  const casualty={...helper,id:'Anissa',pos:ally.pos,vitals:ally.vitals,canHelp:false,revive:()=>ally.revive()};
  rescue.update(.1,[helper,casualty]);assert.equal(rescue.targetFor('Doomsday'),null,'living prey takes priority over a rescue detour');
  player.vitals.health=0;helper.canHelp=!doomsdayAwareness(doom,roster,player).hasTarget;
  rescue.update(.1,[helper,casualty]);assert.equal(rescue.targetFor('Doomsday'),'Anissa','can aid the team only when no opponents remain standing');
  player.vitals.revive(75,false);helper.canHelp=!doomsdayAwareness(doom,roster,player).hasTarget;
  rescue.update(.1,[helper,casualty]);assert.equal(rescue.targetFor('Doomsday'),null,'returning prey immediately cancels the rescue detour');
  doom.setEnemyMode(false);ally.vitals.reset();ally.pos.x=35000;
  awareness=doomsdayAwareness(doom,roster,player);assert.equal(awareness.opponent,ally,'friendly assignment still hunts only foes across the map');
  doom.recall(player);assert.equal(doomsdayAwareness(doom,roster,player).opponent,null,'friendly Doomsday still obeys the player recall command');
  console.log('Doomsday awareness: map-wide live tracking, instant selection, cover independence, casualty memory, returning opponents, uninterrupted hunt and Friend/Foe rules passed.');
}finally{await server.close();}
