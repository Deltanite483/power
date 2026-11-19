import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
  const {Combat}=await server.ssrLoadModule('/src/combat.ts');
  const {Interactions}=await server.ssrLoadModule('/src/interactions.ts');
  const {Faora}=await server.ssrLoadModule('/src/faora.ts');
  const {KickView}=await server.ssrLoadModule('/src/kick.ts');
  const combat=new Combat();assert(combat.begin('attack',true));assert(combat.kick,'Q first selects kick');
  combat.update(1,false);assert.equal(combat.attack,.5,'kick charges like punch');
  const charge=combat.end('attack');assert.equal(charge,.5);assert.equal(combat.kick,false,'release clears combo');
  combat.begin('attack');combat.update(.5,false);assert(combat.armKick());assert.equal(combat.attack,.25,'Q during charge retains charge');
  combat.cancel();assert.equal(combat.kick,false);combat.begin('guard');assert.equal(combat.armKick(),false,'Q + guard stays Super Block');combat.cancel();
  const world={spans:()=>({top:0,floor:()=>0,ceil:()=>Infinity,solid:()=>false}),materialAt:()=>({bounce:0}),crater(){},launch(){}};
  const fighter=new Faora(world,new THREE.Scene());fighter.spawn(0,0);fighter.passive=true;
  const interactions=Object.create(Interactions.prototype);interactions.carrying=null;interactions.rayPick=()=>({item:fighter,point:new THREE.Vector3()});
  const direction=new THREE.Vector3(1,0,0),player={pos:new THREE.Vector3(),vel:new THREE.Vector3()},hits=[];fighter.onCombatHit=e=>hits.push(e);
  for(const charge of [0,.25,.5,1,1.4]){
    for(const guard of [1,.5,0]){
      Object.defineProperty(fighter,'blocking',{configurable:true,get:()=>guard<1});fighter.defense.defend=()=>guard;
      const damage=[];
      for(const kick of [false,true]){
        fighter.vitals.reset();fighter.state='follow';fighter.ragdoll.stop();hits.length=0;
        interactions.punch(new THREE.Vector3(),direction,player,1+charge*3,kick);
        damage.push(100-fighter.vitals.health);
        if(guard>0)assert.equal(hits[0].source.action,kick?'kick':charge>=.3?'smash':'punch');
        else assert.equal(hits.length,0,'full blocks produce no landed kick');
      }
      assert(Math.abs(damage[1]-2*damage[0])<1e-9,`2x damage at charge ${charge}, guard ${guard}`);
    }
  }
  const captive=new Faora(world,new THREE.Scene());captive.spawn(0,0);captive.passive=true;
  interactions.carrying=captive;captive.setHeld(true);
  captive.update(5,player);
  assert(captive.held && !captive.ragdoll.active,'held fighter struggles without entering ragdoll');
  const armPose=captive.leftArm.rotation.x;
  captive.update(.2,player);
  assert.notEqual(captive.leftArm.rotation.x,armPose,'struggle pose animates');
  interactions.punch(new THREE.Vector3(),direction,player);
  assert.equal(interactions.carrying,captive,'a light punch keeps the grab');
  captive.update(5.9,player);
  assert.equal(interactions.carrying,captive,'damage restarts the full escape timer');
  captive.update(.1,{...player,pos:new THREE.Vector3(0,0,10),vitals:{defeated:false}});
  assert.equal(interactions.carrying,null,'escape clears the grab after six seconds');
  assert(!captive.ragdoll.active,'escape restores control');
  captive.setHeld(true);interactions.carrying=captive;
  interactions.punch(new THREE.Vector3(),direction,player,4,true);
  assert.equal(interactions.carrying,null,'launching kick releases the grab immediately');
  assert(captive.ragdoll.active && captive.vel.x>0,'released fighter receives the kick launch');
  for(const kick of [false,true]){
    const boss=new Faora(world,new THREE.Scene(),'Doomsday');boss.spawn(0,0);boss.passive=true;
    interactions.carrying=boss;boss.setHeld(true);
    interactions.punch(new THREE.Vector3(),direction,player);
    assert.equal(boss.escapeProgress,0,'damage cannot push struggle progress below zero');
    boss.update(3,player);
    const progress=boss.escapeProgress, health=boss.vitals.health;
    interactions.punch(new THREE.Vector3(),direction,player,3.7,kick);
    assert.equal(interactions.carrying,boss,'a partial charge keeps Doomsday held');
    const lostProgress=progress-boss.escapeProgress;
    const damage=health-boss.vitals.health;
    assert(lostProgress>0 && boss.escapeProgress>0,'damage reduces struggle progress without wiping it');
    assert(Math.abs(lostProgress-damage*.35/6)<1e-9,'the setback scales with actual HP lost');
    assert(!boss.ragdoll.active);
    interactions.punch(new THREE.Vector3(),direction,player,4,kick);
    assert.equal(interactions.carrying,null,'a full charge releases Doomsday');
    assert(boss.ragdoll.active && boss.vel.x>0 && boss.vel.x<=12,'full charge gives Doomsday a small ragdoll shove');
    for(let frame=0;frame<119;frame++)boss.update(1/60,player);
    assert(boss.ragdoll.active,'Doomsday stays down for nearly two seconds');
    boss.update(.02,player);
    assert(!boss.ragdoll.active,'Doomsday recovers after two seconds');
  }

  const view=new KickView(new THREE.PerspectiveCamera());view.update(.02,.8);assert(view.group.visible,'charged knee visible');
  view.strike(1);assert(view.group.visible,'boot extends at impact');for(let i=0;i<40;i++)view.update(.02,-1);assert(!view.group.visible,'kick retracts');
  console.log('Kick: either input order, retained/full charge, combo reset, guard compatibility, exact 2x damage at all charges, hit-log action and animation passed.');
}finally{await server.close();}
