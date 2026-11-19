import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
  const {Faora}=await server.ssrLoadModule('/src/faora.ts');
  const {DoomsdayPowers}=await server.ssrLoadModule('/src/doomsday.ts');
  const {Vitality}=await server.ssrLoadModule('/src/vitality.ts');
  const {planBeastJump,DOOMSDAY_JUMP}=await server.ssrLoadModule('/src/beast-leap.ts');
  const world={spans:()=>({top:0,floor:()=>0,ceil:()=>Infinity,solid:()=>false}),materialAt:()=>({name:'soil',bounce:0}),crater(){},launch(){}};
  const foe=(x,y=0)=>({pos:new THREE.Vector3(x,y,0),vel:new THREE.Vector3(),speed:0,yaw:0,pitch:0,onGround:y===0,flying:y>0,inWater:false,get eyeLevel(){return this.pos.y+1.6;},vitals:new Vitality()});
  const make=()=>{const f=new Faora(world,new THREE.Scene(),'Doomsday');f.spawn(0,0);f.setEnemyMode(true);return f;};

  const jump=planBeastJump(world,new THREE.Vector3(0,.05,0),new THREE.Vector3(650,.05,0),2.05,DOOMSDAY_JUMP);
  assert(jump && jump.velocity.x>180 && jump.duration<4,'Doomsday makes fast long-range leaps');
  assert.equal(planBeastJump(world,new THREE.Vector3(),new THREE.Vector3(650,0,0),1.6),null,'Battle Beast retains his existing leap limits');
  const high=planBeastJump(world,new THREE.Vector3(),new THREE.Vector3(20,160,0),2.05,DOOMSDAY_JUMP);
  assert(high && high.velocity.y<=65,'high aerial pursuit still uses a bounded ballistic impulse');

  const doom=make(),runner=foe(220);runner.vel.x=35;runner.speed=35;
  let attacks=0,leaps=0,closest=Infinity;
  doom.onLeap=()=>leaps++;
  doom.onCounterAttack=()=>{attacks++;return true;};doom.onPounceAttack=()=>{attacks++;return true;};
  for(let i=0;i<600 && attacks===0;i++){
    runner.pos.addScaledVector(runner.vel,1/60);doom.update(1/60,runner);
    closest=Math.min(closest,doom.pos.distanceTo(runner.pos));
  }
  assert(attacks>0 && leaps>0 && closest<6,'closes a 220 m gap and attacks a fleeing target');

  const sprinter=make(),far=foe(3000);sprinter.leapCooldown=1e6;
  let top=0,stomps=0;sprinter.onStomp=()=>stomps++;
  for(let i=0;i<180;i++){sprinter.update(1/60,far);top=Math.max(top,Math.hypot(sprinter.vel.x,sprinter.vel.z));}
  assert(top>120,'ground charge builds past 120 m/s');
  assert(stomps<=24,'high-speed footfall effects have a bounded cadence');
  sprinter.supportAnchor={...foe(-100),pos:new THREE.Vector3(-100,0,0)};
  sprinter.update(1/60,far);assert(sprinter.target.x>2000,'team spacing cannot leash Doomsday away from pursuit');

  const hunter=make(),hover=foe(20,120);let snatched=false,peak=0;
  hunter.onPounceAttack=()=>{snatched=true;return true;};
  for(let i=0;i<900;i++){
    hunter.update(1/60,hover);peak=Math.max(peak,hunter.pos.y);
    if(snatched && !hunter.jumping && hunter.pos.y<.2)break;
  }
  assert(snatched && peak>100,'reaches and attacks a high airborne target');
  assert(hunter.pos.y<.2 && !hunter.jumping,'high pursuit leap returns to the ground');

  const advancing=make(),target=foe(150),powers=new DoomsdayPowers(new THREE.Scene());powers.beamCooldown=0;
  let beamStart=null,beamEnd=null;
  for(let i=0;i<180;i++){
    powers.update(1/60,advancing,target,true);advancing.update(1/60,target);
    if(powers.state==='beam'){beamStart??=advancing.pos.x;beamEnd=advancing.pos.x;}
  }
  assert(beamStart!==null && beamEnd-beamStart>20,'keeps advancing while firing the low-damage beam');
  assert(advancing.pos.x>60,'beam wind-up does not halt the chase');
  const distant=foe(1000);powers.reset();powers.absorb(450);
  for(let i=0;i<600;i++)powers.update(1/60,advancing,distant,true);
  assert.notEqual(powers.state,'nova-charge','does not waste a stationary nova on distant prey');
  console.log('Doomsday pursuit: long/high ballistic leaps, moving-target interception, fast sprint, bounded footsteps, no team leash, advancing beam and no distant nova camping passed.');
}finally{await server.close();}
