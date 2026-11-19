import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
  const {Vitality,launchSpeed}=await server.ssrLoadModule('/src/vitality.ts');
  const {PersistenceMode,RevivalSystem}=await server.ssrLoadModule('/src/revival.ts');
  const {Faora}=await server.ssrLoadModule('/src/faora.ts');
  const {DOOMSDAY_BEAM_STRENGTH:strength,DOOMSDAY_BEAM_DAMAGE_SCALE:scale,DOOMSDAY_BEAM_IMPULSE:impulse,limitBeamPush}=await server.ssrLoadModule('/src/beam-impact.ts');
  const unit=(id,enemy=false)=>({id,enemy,pos:new THREE.Vector3(),vitals:new Vitality(),canHelp:false,maxDistance:Infinity,canReach:()=>true,setGoal(){},revive(){return this.vitals.revive();}});
  const mode=new PersistenceMode(),player=unit('YOU'),friend=unit('friend'),enemy=unit('enemy',true);
  for(const u of [player,friend,enemy])u.vitals.health=0;
  mode.update(30,[player,friend,enemy]);assert.equal(player.vitals.health,0,'mode defaults off');
  mode.setEnabled(true);mode.update(24,[player,friend,enemy]);
  assert.equal(player.vitals.health,0);assert.equal(mode.remainingFor('YOU'),1);
  mode.update(.99,[player,friend,enemy]);assert.equal(friend.vitals.health,0,'no early return');
  mode.update(.01,[player,friend,enemy]);
  assert.equal(player.vitals.health,75);assert.equal(friend.vitals.health,75);assert.equal(enemy.vitals.health,0,'foes do not get persistence returns');
  assert.equal(player.vitals.revivesUsed,0,'automatic returns do not spend normal revive budget');
  for(let life=0;life<5;life++){player.vitals.health=0;mode.update(25,[player]);assert.equal(player.vitals.health,75);}
  player.vitals.revivesUsed=3;player.vitals.health=0;mode.update(25,[player]);assert.equal(player.vitals.health,75,'persistence overrides exhausted normal budget');
  player.vitals.health=0;mode.update(10,[player]);mode.setEnabled(false);mode.update(30,[player]);assert.equal(player.vitals.health,0,'disabling the mode restores final defeat');
  mode.setEnabled(true);mode.update(1,[player]);assert.equal(mode.remainingFor('YOU'),24,'re-enabling starts a fresh countdown');
  player.enemy=true;mode.update(1,[player]);assert.equal(mode.remainingFor('YOU'),25,'side changes clear friendly auto-return timers');
  player.enemy=false;mode.update(1,[player]);mode.update(1,[]);assert.equal(mode.remainingFor('YOU'),25,'dismissed fighters do not keep stale countdowns');

  const world={spans:()=>({top:0,floor:()=>0,ceil:()=>Infinity,solid:()=>false}),materialAt:()=>({bounce:0}),crater(){},launch(){}};
  const victim=new Faora(world,new THREE.Scene());victim.spawn(0,0);
  for(let hit=0;hit<9;hit++)victim.strike(new THREE.Vector3(1,0,0),new THREE.Vector3(),impulse,false,strength,scale);
  assert(victim.vitals.health>88,'a full beam removes about 11 HP instead of an entire health bar');
  assert(victim.vel.x>90 && victim.vel.x<=110,'beam launches hard without accumulating unlimited speed');
  const guarded=new Faora(world,new THREE.Scene());guarded.spawn(0,0);guarded.defense.begin('guard');guarded.defense.guard=100;
  guarded.strike(new THREE.Vector3(1,0,0),new THREE.Vector3(),impulse,false,strength,scale);
  assert(!guarded.ragdoll.active && guarded.vel.x<10,'guard absorbs the initial beam knockback');
  const velocity=new THREE.Vector3(),direction=new THREE.Vector3(1,0,0);
  for(let hit=0;hit<9;hit++){const before=velocity.dot(direction);velocity.addScaledVector(direction,launchSpeed(impulse,strength));limitBeamPush(velocity,direction,before);}
  assert.equal(velocity.x,110,'player beam acceleration is capped across ticks');

  victim.vitals.health=0;victim.vitals.revivesUsed=3;
  const actual={...unit('actual'),vitals:victim.vitals,persistentRevive:()=>victim.revive(true)};
  mode.update(25,[actual]);assert.equal(victim.vitals.health,75);assert(!victim.ragdoll.active,'automatic NPC return restores the animated body');
  globalThis.addEventListener=()=>{};globalThis.document={addEventListener(){},pointerLockElement:null};
  const {Player}=await server.ssrLoadModule('/src/player.ts');
  const avatar=new Player({},{});avatar.ground=world;avatar.vitals.health=0;avatar.vitals.revivesUsed=3;
  assert(avatar.revive(true));assert.equal(avatar.vitals.health,75);assert.equal(avatar.vitals.revivesUsed,3,'player auto-return works after final normal defeat');
  const standard=new RevivalSystem();const helper=unit('helper');helper.canHelp=true;enemy.pos.x=1;
  helper.enemy=true;standard.update(2.3,[enemy,helper]);assert.equal(enemy.vitals.health,40,'enemy teammate revives remain at 40 HP');
  console.log('Persistence: 25 s/75 HP, unlimited friendly returns, mode toggling, enemy rules, stale timers, actual NPC/player restoration and low-damage high-knockback beam passed.');
}finally{await server.close();}
