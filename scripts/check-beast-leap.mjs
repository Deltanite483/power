import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
  const {Faora}=await server.ssrLoadModule('/src/faora.ts');
  const {Vitality}=await server.ssrLoadModule('/src/vitality.ts');
  const {planBeastJump}=await server.ssrLoadModule('/src/beast-leap.ts');
  const world=(height=()=>0,roof=()=>Infinity)=>({
    spans:(x,z)=>{const y=height(x,z),ceiling=roof(x,z);return {top:y,floor:()=>y,ceil:()=>ceiling,solid:p=>p<y || p>=ceiling};},
    materialAt:()=>({bounce:0}),crater(){},launch(){}
  });
  const target=(x,y,z=0)=>({pos:new THREE.Vector3(x,y,z),vel:new THREE.Vector3(),speed:0,yaw:0,pitch:0,onGround:false,flying:true,inWater:false,eyeLevel:y+1.6,vitals:new Vitality()});
  const beast=(terrain,pos,enemy=true)=>{
    const f=new Faora(terrain,new THREE.Scene(),'Battle Beast');f.spawn(pos.x,pos.z);f.pos.copy(pos);f.vel.set(0,0,0);
    f.lastGroundPosition.copy(pos);if(enemy)f.setEnemyMode(true);return f;
  };

  const crater=world((x,z)=>Math.hypot(x,z)<6?-3:0);
  // A friend must escape even when the player is nearby, above him, and not an attack target.
  for(const position of [new THREE.Vector3(0,-3,0),new THREE.Vector3(5,-3,0)]) {
    const f=beast(crater,position,false),foe=target(1,8);let escaped=false,leaps=0;
    f.onLeap=()=>leaps++;
    for(let i=0;i<600;i++){
      f.update(1/60,foe);
      if(Math.hypot(f.pos.x,f.pos.z)>6.2 && f.pos.y>-.1){escaped=true;break;}
    }
    assert.ok(escaped && leaps>0,`escapes a 3 m crater from ${position.toArray()}`);
    assert.ok(!f.hostile,'escape does not change friend assignment');
    for(let i=0;i<180;i++)f.update(1/60,foe);
    assert.ok(Math.hypot(f.pos.x,f.pos.z)>6 && f.pos.y>-.1,'stays on the rim instead of walking back into the crater');
  }
  const uphill=planBeastJump(crater,new THREE.Vector3(0,-3,0),new THREE.Vector3(10,.05,0),1.6);
  assert.ok(uphill,'a raised crater rim is a legal landing');

  const flat=world(),f=beast(flat,new THREE.Vector3(0,.05,0)),foe=target(0,22);
  let takeoff=0,contacts=0,windup=0,contactHeight=0;
  f.onLeap=()=>{takeoff=f.elapsed;};
  f.onPounceAttack=victim=>{
    contacts++;contactHeight=f.pos.y;
    assert.equal(victim,foe);assert.ok(f.eye.distanceTo(f.playerEye)<=3,'snatch requires physical contact');
    victim.vitals.hit(100);victim.flying=false;victim.vel.y=-35;return true;
  };
  for(let i=0;i<600;i++){
    f.update(1/60,foe);
    if(f.beastJumpWindup>0)windup+=1/60;
    if(!foe.flying){foe.vel.y-=9.81/60;foe.pos.addScaledVector(foe.vel,1/60);if(foe.pos.y<0){foe.pos.y=0;foe.vel.set(0,0,0);foe.onGround=true;}}
    if(contacts && f.pos.y<.2 && !f.jumping)break;
  }
  assert.ok(takeoff>0 && windup>.3,'air snatch has a visible wind-up');
  assert.equal(contacts,1,'one leap cannot repeatedly damage a grabbed target');
  assert.ok(contactHeight>15 && foe.vitals.health===76 && !foe.flying,'leaps vertically and brings an airborne target down');
  assert.ok(f.pos.y<.2 && !f.jumping && f.jumpKind===null,'lands and clears jump state');

  const interceptor = beast(flat, new THREE.Vector3(0,.05,0)), moving = target(0,22);
  moving.vel.set(12,0,0);
  let intercepts = 0;
  interceptor.onPounceAttack = () => { intercepts++; return true; };
  for (let i=0; i<360 && !intercepts; i++) {
    moving.pos.addScaledVector(moving.vel,1/60);
    interceptor.update(1/60,moving);
  }
  assert.equal(intercepts,1,'Battle Beast leads and intercepts a moving airborne target');

  const miss=beast(flat,new THREE.Vector3(0,.05,0)),evasive=target(0,20);
  let missContacts=0,missLeaps=0;miss.onLeap=()=>{missLeaps++;evasive.pos.x=150;};miss.onPounceAttack=()=>{missContacts++;return true;};
  for(let i=0;i<480;i++){miss.update(1/60,evasive);if(missLeaps>0 && miss.pos.y<.2 && !miss.jumping)break;}
  assert.equal(missContacts,0,'a target can dodge a committed leap');
  assert.ok(miss.pos.y<.2,'a missed snatch falls back to the ground');

  const blocked=beast(world(()=>0,()=>4),new THREE.Vector3(0,.05,0));let blockedLeaps=0;
  blocked.onLeap=()=>blockedLeaps++;
  for(let i=0;i<180;i++)blocked.update(1/60,target(0,20));
  assert.equal(blockedLeaps,0,'cannot jump through a low ceiling to reach a target');

  const interrupt=beast(flat,new THREE.Vector3(0,.05,0)),above=target(0,20);
  for(let i=0;i<20;i++)interrupt.update(1/60,above);
  assert.ok(interrupt.beastJumpWindup>0);
  interrupt.strike(new THREE.Vector3(1,0,0),new THREE.Vector3(),5,false,10);
  assert.equal(interrupt.beastJumpWindup,0,'a hit interrupts the leap wind-up');
  for(let i=0;i<12;i++)interrupt.update(1/60,above);
  assert.equal(interrupt.beastJumpWindup,0,'stagger prevents an immediate leap restart');
  console.log('Beast leaps: crater escape, uphill landings, vertical snatch, contact damage, wind-up, evasion, ceiling checks and interruption passed.');
}finally{await server.close();}
