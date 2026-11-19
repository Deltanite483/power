import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createServer } from 'vite';

const server = await createServer({server: {middlewareMode: true, hmr: false}, appType: 'custom'});
try {
  const { Faora } = await server.ssrLoadModule('/src/faora.ts');
  const { Vitality, hitDamage } = await server.ssrLoadModule('/src/vitality.ts');
  const world = {spans: () => ({top: 0, floor: () => 0, ceil: () => Infinity, solid: () => false}), materialAt: () => ({bounce: 0}), crater() {}, launch() {}};
  const target = () => ({pos: new THREE.Vector3(3,0,0), vel: new THREE.Vector3(), speed: 0, yaw: 0, pitch: 0, onGround: true, flying: false, inWater: false, combatAttacking: false, combatGuard: 0, combatWhiff: 0, launched: false, vitals: new Vitality()});
  const fighter = name => {
    const f = new Faora(world, new THREE.Scene(), name);
    f.spawn(0,0); f.pos.set(0,0,0); f.setEnemyMode(true); f.counterCooldown=0;
    return f;
  };
  for (const strength of [30,36,43]) assert.ok(hitDamage(strength)>=8 && hitDamage(strength)<=12);
  assert.equal(hitDamage(100),24);
  assert.equal(hitDamage(1000),30);

  const hunterBeast = fighter('Battle Beast'), farFoe = target();
  farFoe.pos.set(12000, 0, 0);
  hunterBeast.supportAnchor = target();
  hunterBeast.supportAnchor.pos.set(-150, 0, 0);
  for (let i = 0; i < 120; i++) hunterBeast.update(1/60, farFoe);
  assert.ok(Math.abs(hunterBeast.pos.x - farFoe.pos.x) < 40, 'Battle Beast skips across the map to his opponent');
  farFoe.pos.x += 5000;
  hunterBeast.update(1/60, farFoe);
  assert.ok(hunterBeast.pos.x < 12100, 'Battle Beast cannot skip again during cooldown');
  const rescueBeast = fighter('Battle Beast'), casualty = target();
  rescueBeast.vitals.health = 15;
  casualty.pos.set(-12000, 0, 0);
  casualty.vitals.health = 0;
  rescueBeast.rescueTarget = casualty;
  for (let i = 0; i < 120; i++) rescueBeast.update(1/60, farFoe);
  assert.ok(rescueBeast.pos.distanceTo(casualty.pos) <= 3.5, 'Battle Beast skips into range of an assigned casualty');

  const counts = new Map();
  for (const name of ['Faora-Ul','Anissa','Battle Beast']) {
    const f = fighter(name), foe = target(), attacks = [];
    f.onCounterAttack = (_dir,charge,style) => { attacks.push({charge,style,time:f.elapsed}); return true; };
    for (let i=0;i<360;i++) f.update(1/60,foe);
    assert.ok(attacks.length>=3, `${name}: repeated attacks without waiting for teammates`);
    counts.set(name,attacks.length);
    if (name==='Faora-Ul') {
      assert.deepEqual(attacks.slice(0,2).map(hit=>hit.style),['straight','uppercut']);
      assert.ok(attacks[0].charge<.3 && attacks[1].charge>.8, 'Faora chains a quick punch into a heavy uppercut');
    }
    if (name==='Anissa') {
      assert.ok(attacks.some(hit=>hit.charge>.8 && hit.style==='down'), 'Anissa delivers heavy attacks from above');
      assert.ok(f.pos.y>1, 'Anissa maintains an overhead attack position');
    }
  }
  assert.ok(counts.get('Faora-Ul')>counts.get('Anissa'), 'Faora has the faster attack cadence');

  for (const name of ['Faora-Ul','Anissa']) {
    const f = fighter(name), foe = target(); let attacks=0;
    f.onCounterAttack=()=>{attacks++;return true;};
    for(let i=0;i<8;i++) f.update(.025,foe);
    assert.ok(f.counterCharge>.12,'wind-up is visible before the hit');
    foe.pos.set(100,0,0); f.update(.025,foe);
    assert.ok(f.counterCooldown>=.8,'escaping a committed swing leaves a recovery window');
    for(let i=0;i<12;i++) f.update(.025,foe);
    assert.equal(attacks,0,'an out-of-range attack never hits');
  }

  for (const name of ['Faora-Ul','Anissa']) {
    const f = fighter(name), foe=target(); let followed=false, launchedAt=0;
    f.pos.y=40; foe.pos.y=40; foe.onGround=false; foe.flying=true;
    f.onCounterAttack=(_dir,charge)=>{
      if (f.followUpTarget===foe && f.followUpTime>0 && foe.launched) followed=true;
      if(charge>.35 && !foe.launched){foe.launched=true;foe.flying=false;foe.vel.set(55,0,0);foe.speed=55;launchedAt=f.elapsed;}
      return true;
    };
    for(let i=0;i<600 && !followed;i++) {
      foe.pos.addScaledVector(foe.vel,1/60);f.update(1/60,foe);
      if(launchedAt && f.elapsed-launchedAt>2.4) break;
    }
    assert.ok(followed,`${name}: catches a launched target and lands a follow-up before recovery`);
  }

  const healthy=fighter('Battle Beast'), enraged=fighter('Battle Beast');
  enraged.vitals.health=40;
  let healthyHits=0,rageHits=0;
  healthy.onCounterAttack=()=>{healthyHits++;return true;};
  enraged.onCounterAttack=()=>{rageHits++;return true;};
  const foe=target();
  for(let i=0;i<300;i++){healthy.update(1/60,foe);enraged.update(1/60,foe);}
  assert.ok(rageHits>healthyHits,'injured Battle Beast attacks faster');
  const beast=fighter('Battle Beast'), near=target(); near.pos.x=25;
  let peak=0,lands=0; beast.onLand=()=>lands++;
  for(let i=0;i<160;i++){beast.update(1/60,near);peak=Math.max(peak,beast.pos.y);}
  assert.ok(peak>3 && peak<10 && lands>0,'nearby prey gets a short, fast ballistic pounce');
  const specialist=fighter('Anissa'), runner=target();
  runner.pos.set(65,12,0);runner.vel.set(20,0,15);runner.speed=25;runner.onGround=false;runner.flying=true;
  specialist.pos.y=12;
  const rams=[];
  specialist.onRam=(foe,direction,speed)=>rams.push({foe,direction:direction.clone(),speed});
  specialist.update(1/60,runner);
  assert(specialist.attackCommitted && specialist.asTarget.combatAttacking,'Anissa telegraphs the double-fist rush');
  assert.equal(rams.length,0,'the rush gives a guard window before launch');
  for(let i=0;i<120 && rams.length===0;i++){
    runner.pos.addScaledVector(runner.vel,1/60);
    specialist.update(1/60,runner);
  }
  assert.equal(rams.length,1,'Anissa homes into a moving target');
  assert.equal(rams[0].foe,runner);
  assert(rams[0].speed>80 && rams[0].direction.x>0);
  assert(specialist.leftArm.rotation.x < -1.4 && specialist.rightArm.rotation.x < -1.4,'both fists extend at contact');

  const {playerHit}=await server.ssrLoadModule('/src/combat-events.ts');
  const {ramStrength,ANISSA_RAM_DAMAGE_MULTIPLIER}=await server.ssrLoadModule('/src/combat.ts');
  const open=fighter('Faora-Ul'), guarded=fighter('Faora-Ul');
  for(const victim of [open,guarded])victim.vel.set(6,0,14);
  guarded.defense.begin('guard');guarded.defense.guard=20;
  const direction=new THREE.Vector3(1,0,0);
  for(const victim of [open,guarded]){
    victim.strike(direction,new THREE.Vector3(),300,true,ramStrength(300),1,playerHit('ram'));
  }
  assert.equal(open.vel.x,156,'an unblocked ram adds half the attacker speed along the impact vector');
  assert.equal(open.vel.z,14,'the ram preserves perpendicular target momentum');
  assert(100-guarded.vitals.health < (100-open.vitals.health)*.25,'an undercharged block still cuts most ram damage');
  assert(guarded.vel.x<open.vel.x && !guarded.ragdoll.active,'blocking softens launch and velocity transfer');
  const armored=fighter('Anissa'), bonusVictim=fighter('Faora-Ul');
  armored.strike(direction,new THREE.Vector3(),300,true,ramStrength(300),1,playerHit('ram'));
  assert(Math.abs((100-armored.vitals.health)-(100-open.vitals.health)*.8)<1e-9,'Anissa takes 20% less damage');
  bonusVictim.strike(direction,new THREE.Vector3(),300,false,ramStrength(300),ANISSA_RAM_DAMAGE_MULTIPLIER,{name:'Anissa',team:'foe',action:'ram'});
  assert(Math.abs((100-bonusVictim.vitals.health)-(100-open.vitals.health)*1.2)<1e-9,'Anissa deals 20% more ram HP damage even above the normal damage cap');
  assert.equal(bonusVictim.vel.x,150,'the damage bonus does not raise momentum transfer');

  const {AnissaGrab}=await server.ssrLoadModule('/src/anissa-grab.ts');
  const grabber=fighter('Anissa'), captive=fighter('Faora-Ul');
  const playerCaptive=Object.assign(target(),{
    held:false,
    superBlock:{active:false},
    setHeld(value){this.held=value;},
    moveHeld(feet){this.pos.copy(feet);},
    receiveHit(strength,multiplier,source){this.vitals.hit(strength,multiplier); playerHits.push(source.action);},
  });
  const playerHits=[], captiveHits=[];
  const grab=new AnissaGrab(grabber,playerCaptive,action=>({name:'Anissa',team:'foe',action}));
  const tick=(frames,step=.02)=>{for(let i=0;i<frames;i++)grab.update(step,()=>true);};
  grabber.onGrab=foe=>foe===playerCaptive && grab.start(playerCaptive);
  grabber.update(.02,playerCaptive);
  assert(grab.holdingPlayer,'Anissa initiates a grab in melee range');
  for(let i=0;i<7;i++)grab.punchToEscape();
  assert(playerCaptive.held,'partial mash keeps the grab active');
  assert.equal(grab.progress,7/8);
  grab.punchToEscape();
  assert(!playerCaptive.held && !grab.active,'eight punch presses escape the grab');
  playerCaptive.pos.set(3,0,0);
  tick(1,5.9);
  assert(!grab.start(playerCaptive),'Anissa cannot grab again before six seconds');
  tick(1,.11);
  assert(grab.start(playerCaptive));
  tick(180);
  assert.deepEqual(playerHits,['punch','kick','throw'],'unescaped player takes the full sequence');
  assert(!playerCaptive.held && playerCaptive.vel.x>200,'Anissa throws the player out of the grab');

  captive.pos.set(3,0,0);
  assert(!grab.start(captive),'the cooldown after a throw also blocks grabbing a different target');
  tick(1,6);
  const lineClear = grabber.lineClear.bind(grabber);
  grabber.lineClear=(from,to)=>from.distanceTo(to)<10 && lineClear(from,to);
  captive.onCombatHit=hit=>captiveHits.push(hit.source.action);
  assert(grab.start(captive));
  for(let i=0;i<199;i++){captive.update(.02,playerCaptive);tick(1);}
  assert(captive.held && captive.escapeProgress>.99,'NPC gets the full four-second struggle even after strikes');
  captive.update(.02,playerCaptive);tick(1);
  assert(!captive.held && !grab.active,'NPC breaks free after four seconds');
  assert.deepEqual(captiveHits,['punch','kick']);

  tick(1,6);captive.spawn(3,0);captive.pos.y=0;
  grabber.lineClear=lineClear;
  grabber.opponent=captive;
  grabber.ramCooldown=20;
  assert(grab.start(captive));
  tick(180);
  assert.deepEqual(captiveHits.slice(-3),['punch','kick','throw']);
  assert(captive.ragdoll.active && captive.ragdoll.velocity[0].x>200,'throw impulse reaches the NPC ragdoll');
  const combo=[];
  grabber.onRam=(foe,direction,speed)=>combo.push({foe,speed});
  for(let i=0;i<170 && combo.length===0;i++){
    captive.ragdoll.update(1/60,captive.pos,captive.vel);
    grabber.update(1/60,playerCaptive);
  }
  assert.equal(combo.length,1,'Anissa follows a real throw with a ram even on regular cooldown');
  assert.equal(combo[0].foe,captive.asTarget,'the ram keeps the thrown opponent');
  assert(combo[0].speed>80);

  const withdrawing=fighter('Anissa'), distant=target();
  distant.pos.set(70,0,0);
  withdrawing.onRam=()=>assert.fail('Anissa should abandon the ram at low HP');
  withdrawing.update(1/60,distant);
  assert(withdrawing.attackCommitted);
  withdrawing.vitals.health=38;
  const retreatStep=()=>withdrawing.update(1/60,distant);
  for(let i=0;i<75;i++)retreatStep();
  assert(withdrawing.retreating && !withdrawing.attackCommitted,'low HP overrides an active ram wind-up');
  assert(withdrawing.pos.x < -35,'she moves away even when the opponent started outside the old retreat range');
  distant.pos.copy(withdrawing.pos).x+=3;
  withdrawing.onCounterAttack=()=>assert.fail('Anissa should keep escaping when chased');
  for(let i=0;i<45;i++){retreatStep();distant.pos.copy(withdrawing.pos).x+=3;}
  assert(withdrawing.retreating);
  withdrawing.vitals.health=55;
  retreatStep();
  assert(!withdrawing.retreating,'she reengages once recovered to 55 HP');
  const hurtGrabber=fighter('Anissa');
  const hurtGrab=new AnissaGrab(hurtGrabber,playerCaptive,action=>({name:'Anissa',team:'foe',action}));
  playerCaptive.pos.set(3,0,0);
  assert(hurtGrab.start(playerCaptive));
  hurtGrabber.vitals.health=35;
  hurtGrabber.update(1/60,playerCaptive);
  hurtGrab.update(1/60,()=>true);
  assert(hurtGrabber.retreating && !playerCaptive.held,'low HP also forces her to release a grab and retreat');
  const pressured=fighter('Anissa'), hunter=target();
  hunter.pos.x=30;
  for(let hit=0;hit<3;hit++){
    pressured.strike(direction,new THREE.Vector3(),0,false,36);
    for(let frame=0;frame<12;frame++)pressured.update(1/60,hunter);
  }
  assert(pressured.vitals.health>70 && pressured.retreating,'repeated hits force a retreat above 70 HP');
  assert(pressured.retreatUntilHP>pressured.vitals.health,'the retreat recovery goal is above current HP');
  const isolatedHit=fighter('Anissa');
  isolatedHit.strike(direction,new THREE.Vector3(),0,false,1000);
  isolatedHit.update(1/60,hunter);
  assert(!isolatedHit.retreating,'one isolated hit at healthy HP does not trigger a pressure retreat');

  for (const name of ['Sukuna', 'Satoru Gojo']) {
    const duelist = fighter(name), opponent = target();
    opponent.pos.x = 30;
    duelist.infinity?.setActive(false);
    duelist.vitals.health = 125;
    duelist.update(1/60, opponent);
    assert(duelist.availableToFight && !duelist.blocking, `${name} stays in the fight at low health`);
    for (let hit = 0; hit < 2; hit++) duelist.strike(direction, new THREE.Vector3(), 0, false, 65);
    duelist.update(1/60, opponent);
    assert(duelist.retreating && !duelist.blocking, `${name} can disengage under pressure without guarding for recovery`);
    for (let frame = 0; frame < 120; frame++) duelist.update(1/60, opponent);
    assert(duelist.availableToFight && duelist.vitals.health < 125, `${name} reengages when pressure fades, even at low health`);
  }

  const defendingGojo = fighter('Satoru Gojo'), windingUp = target();
  defendingGojo.vitals.health = 125;
  windingUp.pos.x = 20;
  windingUp.yaw = Math.PI / 2;
  windingUp.combatAttacking = true;
  windingUp.combatAttackCharge = .3;
  for (let frame = 0; frame < 10; frame++) {
    defendingGojo.pos.set(0, 0, 0);
    defendingGojo.vel.set(0, 0, 0);
    defendingGojo.update(.05, windingUp);
  }
  assert(defendingGojo.blocking, 'Gojo can still guard a visible attack at low health');

  const idle=fighter('Faora-Ul'), scouting=fighter('Anissa');
  idle.setEnemyMode(false);
  const distantEnemy=target();distantEnemy.pos.x=1000;
  idle.vitals.health=scouting.vitals.health=92;
  for(let i=0;i<135;i++){idle.update(1/60,target());scouting.update(1/60,distantEnemy);}
  assert(idle.vitals.health>93 && idle.healing,'idle fighters heal even at high HP');
  assert(scouting.vitals.health>93 && scouting.pos.x>50 && scouting.availableToFight,
    'scouting fighters heal on the move and stay ready to attack');
  console.log('Aggression: independent attacks, lethal damage, distinct styles, dodge recovery, launch pursuit and Beast rage/pounce passed.');
} finally { await server.close(); }
