import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
  const {Faora}=await server.ssrLoadModule('/src/faora.ts');
  const {DoomsdayPowers}=await server.ssrLoadModule('/src/doomsday.ts');
  const {DoomsdayAnimation}=await server.ssrLoadModule('/src/doomsday-animation.ts');
  const {Vitality}=await server.ssrLoadModule('/src/vitality.ts');
  const world={spans:()=>({top:0,floor:()=>0,ceil:()=>Infinity,solid:()=>false}),materialAt:()=>({bounce:0,name:'soil'}),crater(){},launch(){}};
  const scene=new THREE.Scene(),doom=new Faora(world,scene,'Doomsday');doom.spawn(0,0);doom.setEnemyMode(true);
  const foe={pos:new THREE.Vector3(60,0,0),vel:new THREE.Vector3(),speed:0,yaw:0,pitch:0,onGround:true,flying:false,inWater:false,eyeLevel:1.6,vitals:new Vitality()};
  assert.equal(doom.groundOnly,true);assert(doom.bodyScale>2);assert(doom.meleeStrengthMultiplier>=3);
  doom.vitals.hit(100);assert(doom.vitals.health>97,'boss durability exceeds Battle Beast');
  doom.strike(new THREE.Vector3(1,0,0),new THREE.Vector3(),500,false,120);assert(!doom.ragdoll.active,'normal heavy hits cannot launch Doomsday');

  const powers=new DoomsdayPowers(scene);let beamHits=0,charged=0,nova=0;
  powers.onCharge=kind=>{if(kind==='beam')charged++;};powers.onBeamHit=(target,strength)=>{assert.equal(target,foe);assert(strength>=40);beamHits++;};
  for(let i=0;i<300;i++)powers.update(1/60,doom,foe,true);
  assert(charged>0 && beamHits>=6,'telegraphed beam deals repeated high-power hits');
  assert.equal(powers.group.children.length,4,'special visuals use a fixed small mesh count');
  const rig=doom.doomsdayRig, animation=new DoomsdayAnimation(rig);
  const pose={speed:0,vertical:0,airborne:false,crouch:0,landing:0,guard:false,flinch:0,
    windup:0,strike:0,punch:'straight',special:null,charge:0,aim:new THREE.Vector3(0,0,1),exhausted:false};
  const holdPose=overrides=>{
    for(let i=0;i<45;i++){
      doom.model.position.copy(doom.pos);
      animation.update(1/60,{...pose,...overrides});
    }
  };
  holdPose({guard:true});
  assert(rig.shins.every(shin=>shin.rotation.x>.65),'the guard crouch bends both knees');
  const planted=rig.feet.map(foot=>foot.getWorldPosition(new THREE.Vector3()));
  assert(planted.every(foot=>Math.abs(foot.y-doom.pos.y-.105*doom.bodyScale)<.045),'guard ankles stay near standing height');
  holdPose({airborne:true,vertical:20});
  assert(rig.feet.every(foot=>foot.getWorldPosition(new THREE.Vector3()).y>doom.pos.y+.5),'leap tucks both feet');
  const visibleJoints=[rig.shins[0],rig.feet[0],rig.shins[1],rig.feet[1],rig.hands[1]].map(joint=>joint.getWorldPosition(new THREE.Vector3()));
  doom.ragdoll.start(new THREE.Vector3());
  for(const [i,joint] of [9,10,11,12,8].entries()){
    assert(doom.ragdoll.joints[joint].distanceTo(visibleJoints[i])<.0001,'ragdoll starts from the animated joint positions');
  }
  doom.ragdoll.stop();
  holdPose({special:'beam',aim:new THREE.Vector3(1,.25,1).normalize()});
  assert(rig.jaw.rotation.x>.65 && rig.head.rotation.y>.3,'beam opens the jaw and turns the head toward its aim');
  powers.syncPose(doom);
  const beam=powers.group.children[0];
  const visibleStart=new THREE.Vector3(0,-.5,0).multiply(beam.scale).applyQuaternion(beam.quaternion).add(beam.position);
  assert(visibleStart.distanceTo(rig.mouth.getWorldPosition(new THREE.Vector3()))<.0001,'the rendered beam follows the animated mouth socket');
  animation.reset();
  doom.model.position.copy(doom.pos);


  powers.reset();beamHits=0;doom.lineClear=()=>false;
  for(let i=0;i<360;i++)powers.update(1/60,doom,foe,true);
  assert.equal(beamHits,0,'cannot start a beam through solid cover');
  doom.lineClear=()=>true;doom.firstBlock=()=>.04;
  powers.reset();let burns=0;powers.onBurn=()=>{burns++;return 1;};
  for(let i=0;i<300;i++)powers.update(1/60,doom,foe,true);
  assert.equal(beamHits,0,'a wall stops beam damage until burned through');assert(burns>0);
  doom.firstBlock=()=>1;

  powers.reset();powers.absorb(400);assert(powers.energy>.8);
  powers.onNova=(origin,radius)=>{nova++;assert(radius>200);assert(origin.distanceTo(doom.pos)<2);};
  for(let i=0;i<600 && !nova;i++)powers.update(1/60,doom,foe,true);
  assert.equal(nova,1,'absorbed damage charges one nuclear-style pulse');assert.equal(powers.energy,0);
  assert(doom.novaExhausted,'nova immediately puts Doomsday into sluggish mode');
  const hitsBeforeRecovery=beamHits;
  doom.poiseRevision++;
  for(let i=0;i<599;i++)powers.update(1/60,doom,foe,true);
  assert(doom.novaExhausted,'interruption cannot end the ten-second recovery early');
  assert.equal(beamHits,hitsBeforeRecovery,'beam stays disabled during recovery');
  for(let i=0;i<2;i++)powers.update(1/60,doom,foe,true);
  assert(!doom.novaExhausted,'normal movement returns after ten seconds');
  assert.equal(nova,1,'nova cooldown prevents repeated pulses');

  powers.reset();powers.absorb(400);
  for(let i=0;i<330;i++)powers.update(1/60,doom,foe,true);
  doom.rescueTarget=foe;powers.update(1/60,doom,foe,true);
  assert.equal(powers.state,'idle');assert.equal(doom.specialChanneling,false,'giving aid cancels the special attack');doom.rescueTarget=null;
  powers.reset();doom.vitals.health=70;
  for(let i=0;i<240;i++)powers.update(1/60,doom,foe,false);
  assert.equal(doom.vitals.health,70,'benched Doomsday does not secretly regenerate');
  for(let i=0;i<240;i++)powers.update(1/60,doom,foe,true);
  assert(doom.vitals.health>70,'living Doomsday regenerates after a break in incoming damage');

  while(!doom.vitals.defeated)doom.vitals.hit(1000);
  for(let i=0;i<300;i++)powers.update(1/60,doom,foe,true);
  assert.equal(doom.vitals.health,0,'regeneration cannot bypass downed state');assert(!powers.group.visible);
  assert(doom.revive());powers.update(1/60,doom,foe,true);assert(doom.vitals.damageScale<.1,'revival increases damage resistance');
  for(let life=1;life<3;life++){doom.vitals.advanceReviveGrace(6);while(!doom.vitals.defeated)doom.vitals.hit(1000);assert(doom.revive());}
  doom.vitals.advanceReviveGrace(6);
  while(!doom.vitals.defeated)doom.vitals.hit(1000);assert(!doom.revive() && doom.vitals.eliminated,'boss obeys the same three-revive limit');
  doom.vitals.reset();doom.specialChanneling=false;doom.strike(new THREE.Vector3(1,0,0),new THREE.Vector3(),800,false,220);
  assert(doom.ragdoll.active,'sufficient force can still launch Doomsday');
  for(let i=0;i<180;i++)doom.ragdoll.update(1/60,doom.pos,doom.vel);
  assert(doom.ragdoll.joints.every(p=>Number.isFinite(p.lengthSq()) && p.y>=0),'large spiked model has stable ragdoll physics');
  const {Destruction}=await server.ssrLoadModule('/src/destruction.ts');
  const {Heightfield}=await server.ssrLoadModule('/src/terrain/heightfield.ts');
  const meta={width:128,height:128,cell_m:10,min_m:500,step_m:.1,origin_x:-640,origin_z:-640},grid=()=>({meta,data:new Uint16Array(16384)});
  const hf=new Heightfield({inner:grid(),outer:grid(),water:new Uint8Array(16384),models:[],instances:[]});
  const destruction=new Destruction(hf,{heat:{add(){}}},new THREE.Scene());
  const ground=destruction.spans(0,0).top;
  destruction.energyBlast(new THREE.Vector3(0,ground+1,0),110,[doom]);
  assert(destruction.spans(0,0).top>=ground-2,'nuclear pulse cannot break through the bedrock floor');
  assert(destruction.dust.emitted<=180 && destruction.explosions.group.children.length===1,'nuclear blast reuses bounded effects');
  const ordinary=new Vitality(),nuked=new Vitality();ordinary.hit(200);nuked.hit(200,2);
  assert.equal(nuked.health,40);assert.equal(ordinary.health,70,'special damage multiplier does not change ordinary combat');
  console.log('Doomsday: model, durability, beam charge/damage/cover, energy nova, cooldown, rescue cancellation, bounded visuals, regeneration, adaptation and revive limits passed.');
}finally{await server.close();}
