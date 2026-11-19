import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
  const {Faora}=await server.ssrLoadModule('/src/faora.ts');
  const {Interactions}=await server.ssrLoadModule('/src/interactions.ts');
  const {DoomsdayPowers}=await server.ssrLoadModule('/src/doomsday.ts');
  const {EnergyLightning}=await server.ssrLoadModule('/src/energy-lightning.ts');
  const {Vitality}=await server.ssrLoadModule('/src/vitality.ts');
  const world={spans:()=>({top:0,floor:()=>0,ceil:()=>Infinity,solid:()=>false}),materialAt:()=>({name:'soil',bounce:0}),crater(){},launch(){}};
  const make=()=>{const f=new Faora(world,new THREE.Scene(),'Doomsday');f.spawn(0,0);f.setEnemyMode(true);f.leapCooldown=1e6;return f;};
  const target={pos:new THREE.Vector3(3.8,0,0),vel:new THREE.Vector3(),speed:0,yaw:0,pitch:0,onGround:true,flying:false,inWater:false,eyeLevel:1.6,vitals:new Vitality()};
  const incoming=new THREE.Vector3(-1,0,0),zero=new THREE.Vector3();
  const interactions=Object.create(Interactions.prototype);
  const punch=(fighter,kick,force=0,held=0)=>{
    interactions.rayPick=()=>({item:fighter,point:fighter.pos});
    interactions.punch(zero,incoming,target,1+force*3,kick,held);
  };
  const doom=make();let punches=0;
  doom.onCounterAttack=()=>{punches++;return true;};
  for(let frame=0;frame<240;frame++){
    if(frame%6===0)punch(doom,frame%12===0);
    doom.update(1/60,target);
  }
  assert(punches>=2,'Doomsday lands attacks while receiving ten light clicks per second');
  assert(doom.vitals.health<100 && doom.vitals.health>50,'light clicks still inflict normal reduced boss damage');
  assert.equal(doom.poiseRevision,0,'light hits never accumulate into a stun lock');
  doom.counterCharge=.6;doom.counterCooldown=0;
  doom.strike(incoming,zero,52,true,20);
  assert.equal(doom.counterCharge,.6);assert.equal(doom.counterCooldown,0,'repeated provocation cannot reset his cooldown');
  assert(doom.attackCommitted,'charged attack stays committed');
  for(const kick of [false,true]){
    const health=doom.vitals.health, velocity=doom.vel.clone();
    punch(doom,kick,1.4,0);
    assert(doom.vitals.health<health,'momentum-assisted taps still deal damage');
    assert(doom.vel.equals(velocity),'momentum-assisted taps do not shove Doomsday out of attack range');
    assert.equal(doom.poiseRevision,0);
    assert.equal(doom.counterCharge,.6,'momentum alone cannot interrupt melee wind-up');
  }
  punch(doom,true,1,1);
  assert.equal(doom.counterCharge,0);assert(doom.poiseRevision>0 && doom.counterCooldown>=.5,'a properly charged heavy hit still interrupts');

  const caster=make(),powers=new DoomsdayPowers(new THREE.Scene());target.pos.x=60;
  powers.beamCooldown=0;powers.novaCooldown=1e9;
  let fires=0;powers.onBeamFire=()=>fires++;
  for(let frame=0;frame<120;frame++){
    if(frame===12 || frame===18)punch(caster,frame===12,1.4,0);
    else if(frame%6===0)punch(caster,frame%12===0);
    powers.update(1/60,caster,target,true);
  }
  assert.equal(fires,1,'light spam cannot cancel the energy-beam wind-up');
  assert(powers.lightning.mesh.visible,'beam carries visible electric arcs');
  punch(caster,false,1,1);powers.update(1/60,caster,target,true);
  assert.equal(powers.state,'idle','heavy impact breaks special-attack concentration');
  powers.reset();powers.novaCooldown=0;powers.beamCooldown=100;powers.absorb(450);
  let novas=0;powers.onNova=()=>novas++;
  for(let frame=0;frame<150;frame++){
    if(frame===12 || frame===18)punch(caster,frame===12,1.4,0);
    else if(frame%6===0)punch(caster,frame%12===0);
    powers.update(1/60,caster,target,true);
  }
  assert.equal(novas,1,'light spam cannot prevent a charged nova');
  assert(powers.lightning.mesh.visible,'nova discharge leaves branching lightning');

  const knocked=make();knocked.strike(incoming,zero,800,false,220);
  assert(knocked.ragdoll.active);
  for(let frame=0;frame<61;frame++){
    if(frame%6===0)knocked.strike(incoming,zero,52,true,20);
    knocked.update(1/60,target);
  }
  assert(!knocked.ragdoll.active,'Doomsday recovers within a second even under repeated weak hits');
  const carried=make();carried.setHeld(true);
  for(let frame=0;frame<90;frame++)carried.update(1/60,target);
  assert(!carried.ragdoll.active && carried.held,'held fighters struggle without ragdolling');
  carried.setHeld(false);
  for(let frame=0;frame<61;frame++)carried.update(1/60,target);
  assert(!carried.ragdoll.active,'recovers quickly after being released');
  const downed=make();downed.strike(incoming,zero,800,false,220);downed.vitals.health=0;
  for(let frame=0;frame<90;frame++)downed.update(1/60,target);
  assert(downed.vitals.defeated && downed.ragdoll.active,'knockdown recovery does not bypass defeat/revival rules');
  const arcs=new EnergyLightning(new THREE.Scene()),source=new THREE.Vector3(0,3,0),end=new THREE.Vector3(100,8,0);
  arcs.burst(source,115);arcs.update(.05,source,1,end);
  assert(arcs.mesh.geometry.instanceCount>300 && arcs.mesh.geometry.instanceCount<=512,'all arc layers fit inside a fixed segment pool');
  const attribute=arcs.mesh.geometry.getAttribute('aStart'),version=attribute.version;
  arcs.update(.001,source,1,end);assert.equal(attribute.version,version,'arc shape is not rebuilt every animation frame');
  assert(Array.from(attribute.array).every(Number.isFinite),'arc coordinates remain finite');
  arcs.update(1,source);assert(!arcs.mesh.visible,'electric discharge expires');
  arcs.clear();assert.equal(arcs.mesh.geometry.instanceCount,0);
  console.log('Doomsday poise: spam resistance, damage retained, committed melee/beam/nova, heavy interruption, lightning expiry and fixed GPU budget passed.');
}finally{await server.close();}
