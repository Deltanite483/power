import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
  const {Vitality}=await server.ssrLoadModule('/src/vitality.ts');
  const {RevivalSystem,SelfRevive}=await server.ssrLoadModule('/src/revival.ts');
  const {Faora}=await server.ssrLoadModule('/src/faora.ts');
  const {friendOpponent}=await server.ssrLoadModule('/src/targeting.ts');
  const kill=v=>{while(!v.defeated)v.hit(1000);};
  const v=new Vitality();
  assert.equal(v.revive(),false,'living characters cannot spend a revive');
  for(let life=0;life<3;life++){
    kill(v);assert(v.downed && !v.eliminated);
    assert.equal(v.revive(),true);assert.equal(v.health,40);assert.equal(v.revivesUsed,life+1);
    v.advanceReviveGrace(5.5);
    assert.equal(v.revive(),false,'duplicate callbacks do not spend another revive');
    assert.equal(v.hit(100),false,'hits are ignored before six seconds');
    assert.equal(v.health,40);
    v.advanceReviveGrace(.5);
    assert.equal(v.hit(100),true,'damage resumes at six seconds');
  }
  kill(v);assert(v.eliminated && !v.downed);assert.equal(v.revive(),false,'fourth defeat is final');
  v.reset();assert.equal(v.revivesRemaining,3,'explicit new life resets the budget');

  const unit=(id,enemy,x)=>({id,enemy,pos:new THREE.Vector3(x,0,0),vitals:new Vitality(),canHelp:true,maxDistance:Infinity,
    canReach:()=>true,setGoal(other){this.goal=other?.id??null;},revive(){return this.vitals.revive();}});
  const wounded=unit('wounded',true,0),helper=unit('helper',true,2),opponent=unit('opponent',false,1);
  kill(wounded.vitals);wounded.canHelp=false;
  const system=new RevivalSystem();
  system.update(1,[wounded,helper,opponent]);
  assert.equal(helper.goal,'wounded','same-side enemy rushes to help');
  assert.equal(opponent.goal,null,'opponents never revive each other');
  assert(wounded.vitals.downed,'revive requires uninterrupted contact time');
  helper.vitals.hit(10);system.update(.1,[wounded,helper,opponent]);
  assert.equal(system.progressFor('wounded'),0,'damage interrupts aid');
  helper.canReach=()=>false;system.update(3,[wounded,helper,opponent]);
  assert(wounded.vitals.downed,'cannot revive through a wall');
  helper.canReach=()=>true;system.update(2.3,[wounded,helper,opponent]);
  assert.equal(wounded.vitals.health,40);assert.equal(wounded.vitals.revivesUsed,1);

  const distant=unit('distant',false,20000),beast=unit('beast',false,0);
  kill(distant.vitals);distant.canHelp=false;
  system.clear();system.update(3,[distant,beast]);
  assert.equal(beast.goal,'distant','map-wide rescue assignment');
  assert(distant.vitals.downed,'being assigned does not remotely revive a casualty');
  beast.pos.x=19998;system.update(2.3,[distant,beast]);assert.equal(distant.vitals.health,40);

  const ally=unit('ally',false,0),auto=unit('auto',false,100),manual=unit('YOU',false,2);
  kill(ally.vitals);ally.canHelp=false;manual.manual=true;manual.maxDistance=3.5;manual.canHelp=false;
  system.clear();system.update(.1,[ally,auto,manual]);assert.equal(auto.goal,'ally');
  manual.canHelp=true;system.update(.1,[ally,auto,manual]);
  assert.equal(system.helperFor('ally'),'YOU','holding aid nearby can take over from a distant AI helper');
  manual.canHelp=false;system.update(.1,[ally,auto,manual]);assert.equal(system.progressFor('ally'),0,'releasing manual aid resets its progress');

  const self=new SelfRevive();let ready=false;
  for(let i=0;i<19;i++)ready=self.tap(i*.1);
  assert.equal(ready,false);assert(self.progress>.9);
  assert.equal(self.tap(1.801),false,'duplicate rapid events cannot count as separate taps');
  ready=self.tap(1.9);assert.equal(ready,true,'twenty distinct clicks complete self-revive');
  self.reset();self.tap(3);self.update(1,5);assert.equal(self.progress,0,'idle recovery progress decays');

  const world={spans:()=>({top:0,floor:()=>0,ceil:()=>Infinity,solid:()=>false}),materialAt:()=>({bounce:0}),crater(){},launch(){}};
  const a=new Faora(world,new THREE.Scene()),b=new Faora(world,new THREE.Scene(),'Anissa');
  a.spawn(0,0);b.spawn(25,0);a.setEnemyMode(true);b.setEnemyMode(true);kill(b.vitals);
  const casualty={...unit('Anissa',true,25),pos:b.pos,vitals:b.vitals,canHelp:false,revive:()=>b.revive()};
  const rescuer={...unit('Faora-Ul',true,0),pos:a.pos,vitals:a.vitals,setGoal:other=>{a.rescueTarget=other?b.asTarget:null;},canReach:()=>true};
  system.clear();let attacks=0;a.onCounterAttack=()=>{attacks++;return true;};
  const player={pos:new THREE.Vector3(-100,0,0),vel:new THREE.Vector3(),speed:0,yaw:0,pitch:0,onGround:true,flying:false,inWater:false,vitals:new Vitality()};
  for(let i=0;i<600 && b.vitals.downed;i++){system.update(1/60,[rescuer,casualty]);a.update(1/60,player);}
  assert.equal(b.vitals.health,40,'AI physically reaches and revives its teammate');
  assert.equal(attacks,0,'rescuer breaks off attacks while giving aid');

  const tracker=new Faora(world,new THREE.Scene(),'Battle Beast');tracker.spawn(0,0);
  b.pos.set(24000,0,0);a.pos.set(0,0,0);a.setEnemyMode(false);
  assert.equal(friendOpponent(tracker,[tracker,b],player.pos),b,'friendly Battle Beast finds enemies across the whole map');
  assert.equal(friendOpponent(a,[a,b],player.pos),null,'ordinary flyers retain their local protection radius');
  b.vitals.health=0;assert.equal(friendOpponent(tracker,[tracker,b],player.pos),null,'tracking ignores downed foes');
  const supporter=new Faora(world,new THREE.Scene(),'Anissa');supporter.spawn(-250,0);supporter.setEnemyMode(true);
  supporter.supportAnchor=b.asTarget;b.pos.set(0,0,0);b.vitals.reset();
  player.pos.set(100,0,0);supporter.update(1/60,player);
  assert.ok(supporter.target.distanceTo(b.pos)<=65.01,'enemy support stays near the team instead of fighting alone across the map');

  globalThis.addEventListener=()=>{};
  globalThis.document={addEventListener(){},pointerLockElement:null};
  const {Player}=await server.ssrLoadModule('/src/player.ts');
  const actualPlayer=new Player({},{});actualPlayer.ground=world;
  for(let life=0;life<3;life++){
    while(!actualPlayer.vitals.defeated)actualPlayer.receiveHit(1000);
    actualPlayer.vel.set(30,-40,0);
    assert(actualPlayer.revive());assert.equal(actualPlayer.vitals.health,40);assert.equal(actualPlayer.vel.length(),0);
    assert.equal(actualPlayer.vitals.revivesRemaining,2-life);
    actualPlayer.vitals.advanceReviveGrace(6);
  }
  while(!actualPlayer.vitals.defeated)actualPlayer.receiveHit(1000);
  assert(actualPlayer.vitals.eliminated);assert.equal(actualPlayer.revive(),false,'player self-return also obeys the same three-use limit');
  console.log('Revival: three shared revives, 40 HP, team boundaries, contact time, interruption, walls, manual takeover, mashing, physical AI rescue and map-wide Beast tracking passed.');
}finally{await server.close();}
