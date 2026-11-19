import assert from 'node:assert/strict';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
  const {SuperBlock}=await server.ssrLoadModule('/src/super-block.ts');
  const shield=new SuperBlock();
  assert.equal(shield.activate(false),false,'Q alone cannot grant immunity');
  assert.equal(shield.activate(true,false),false,'cannot activate while defeated');
  assert(shield.activate(true));assert.equal(shield.remaining,3);
  shield.update(2.5);assert(shield.active);assert.equal(shield.activate(true),false,'cannot refresh immunity');
  shield.update(.5);assert.equal(shield.active,false);assert.equal(shield.cooldown,2);
  shield.update(1.99);assert.equal(shield.activate(true),false);
  shield.update(.02);assert(shield.activate(true),'ready two seconds after immunity expires');
  shield.update(10);assert.equal(shield.active,false);assert.equal(shield.cooldown,0,'long frames correctly cross both phases');
  shield.activate(true);shield.reset();assert.equal(shield.active,false);assert.equal(shield.cooldown,0);
  globalThis.addEventListener=()=>{};globalThis.document={addEventListener(){},pointerLockElement:null};
  const {Player}=await server.ssrLoadModule('/src/player.ts');
  const player=new Player({},{});let damageEvents=0,injuries=0;
  player.onCombatHit=()=>damageEvents++;player.onInjured=()=>injuries++;
  player.superBlock.activate(true);player.receiveHit(1000,10);player.receiveHit(100,2);
  assert.equal(player.vitals.health,100);assert.equal(player.vitals.orientation,100);assert.equal(damageEvents,0);assert.equal(injuries,0,'no injury cancellation or false hit-log rows');
  player.superBlock.update(3);player.receiveHit(100);
  assert.equal(player.vitals.health,76,'normal damage resumes exactly when immunity ends');assert.equal(injuries,1);
  player.vitals.health=0;player.floorAt=()=>0;player.revive(false,true);assert.equal(player.superBlock.cooldown,0,'revive clears stale shield state');
  console.log('Super Block: guard combo, 3s immunity, subsequent 2s cooldown, refresh prevention, damage/orientation protection, feed filtering and revival reset passed.');
}finally{await server.close();}
