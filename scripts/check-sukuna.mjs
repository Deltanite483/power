import assert from "node:assert/strict";
import * as THREE from "three";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { Faora } = await server.ssrLoadModule("/src/faora.ts");
  const { Vitality } = await server.ssrLoadModule("/src/vitality.ts");
  const { SukunaPowers } = await server.ssrLoadModule("/src/sukuna.ts");
  const { CURSED_COST } = await server.ssrLoadModule("/src/cursed-energy.ts");
  const scene = new THREE.Scene();
  let blocked = false;
  const world = { spans: () => ({ top: 0, solid: () => false, floor: () => 0, ceil: () => Infinity }),
    materialAt: () => ({ bounce: 0 }), crater() {}, launch() {} };
  const sukuna = new Faora(world, scene, "Sukuna");
  sukuna.setEnemyMode(true);
  sukuna.lineClear = () => !blocked;
  const effectsStart = scene.children.length;
  const powers = new SukunaPowers(scene);
  const resetFight = () => { powers.reset(sukuna); sukuna.cursedEnergy.reset(); };
  const effects = scene.children.slice(effectsStart);
  const opponent = { pos: new THREE.Vector3(45, 0, 0), vel: new THREE.Vector3(), vitals: new Vitality() };
  const ally = { pos: new THREE.Vector3(3, 0, 0), vitals: new Vitality() };
  const hits = [];
  powers.onHit = (technique, target) => hits.push({ technique, target });
  const step = dt => powers.update(dt, sukuna, opponent, [opponent], true);

  const armored = new Faora(world, scene, "Doomsday");
  const slash = { name: "Sukuna", team: "foe", action: "cleave" };
  armored.strike(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0, false, 100, 1, slash);
  assert.equal(armored.vitals.health, 76, "Cleave ignores Doomsday's passive defense");
  assert.equal(armored.vitals.damageScale, .1, "the defense stat stays intact for other attacks");
  armored.defense.begin("guard");
  armored.defense.update(2, false);
  armored.strike(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0, false, 100, 1, slash);
  assert.equal(armored.vitals.health, 76, "an active guard still blocks a slash");

  const casts = [];
  let shrinePulses = 0;
  powers.onCast = technique => casts.push(technique);
  powers.onShrinePulse = () => shrinePulses++;
  const second = { pos: new THREE.Vector3(0, 0, 45), vitals: new Vitality() };
  const third = { pos: new THREE.Vector3(-45, 0, 0), vitals: new Vitality() };
  const fourth = { pos: new THREE.Vector3(0, 0, -50), vitals: new Vitality() };
  const targets = [opponent, second, third, fourth];
  const tick = (dt, roster = targets) => powers.update(dt, sukuna, opponent, roster, true);
  const run = (frames, roster = targets) => {
    for (let i = 0; i < frames; i++) tick(1 / 60, roster);
  };

  tick(1.5);
  tick(.2);
  sukuna.strike(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 700, false, 100);
  assert(Math.abs(sukuna.vitals.health - 598.32) < 1e-6, "charge armor reduces incoming damage by 90 percent");
  assert(sukuna.specialChanneling && !sukuna.ragdoll.active, "heavy hits do not interrupt a charge");
  run(125);
  assert.equal(hits.filter(hit => hit.technique === "dismantle").length, 20);
  assert(!sukuna.hasSukunaChargeArmor);
  resetFight();
  sukuna.vitals.health = 600;
  hits.length = 0;

  tick(1.5);
  tick(.71);
  const direction = new THREE.Vector3(1, 0, 0), inherited = new THREE.Vector3();
  const beforeTap = sukuna.vitals.health, poise = sukuna.poiseRevision;
  sukuna.strike(direction, inherited, 260, false, 60);
  assert(sukuna.vitals.health < beforeTap && !sukuna.ragdoll.active && sukuna.poiseRevision === poise,
    "a lighter hit damages Sukuna without breaking stance or the volley");
  assert.equal(hits.length, 0, "Dismantle has travel time");
  run(100);
  assert.equal(hits.length, 20, "a full volley fires twenty slashes");
  assert.deepEqual(new Set(hits.splice(0).map(hit => hit.target)), new Set(targets.slice(0, 3)));

  resetFight();
  tick(1.5);
  tick(.71);
  sukuna.strike(direction, inherited, 260, false, 100);
  assert(!sukuna.ragdoll.active && sukuna.poiseRevision > poise, "a heavy hit interrupts without launching");
  tick(.05);
  assert(!sukuna.specialChanneling, "a poise break stops the volley");
  sukuna.strike(direction, inherited, 400, false, 130);
  assert(sukuna.ragdoll.active, "a stronger blow still knocks Sukuna down");
  sukuna.ragdollTime = .5;
  sukuna.strike(direction, inherited, 260, false, 60);
  assert.equal(sukuna.ragdollTime, .25, "a lighter hit halves the remaining knockdown recovery");
  sukuna.spawn(0, 0);
  sukuna.setEnemyMode(true);
  resetFight();
  tick(1.5);
  blocked = true;
  tick(.71);
  run(110);
  assert.equal(hits.length, 0, "cover stops a Dismantle volley");
  blocked = false;
  sukuna.setHeld(true);
  assert.equal(sukuna.held, false, "Sukuna cannot be grabbed");

  resetFight();
  opponent.pos.x = 3;
  powers.fugaCooldown = powers.domainCooldown = 60;
  casts.length = 0;
  for (let i = 0; i < 40 && casts.length < 6; i++) run(30, [opponent]);
  run(30, [opponent]);
  assert.deepEqual(casts.slice(0, 6), ["cleave", "punch", "kick", "cleave", "punch", "kick"]);
  assert.equal(hits.filter(hit => hit.technique === "cleave").length, 60, "two full Cleaves each hit thirty times");
  assert(hits.some(hit => hit.technique === "kick"), "the combo lands a kick");
  assert(!sukuna.canMaintainGrapple, "Sukuna's kick does not leave him grappling");
  hits.length = 0;

  resetFight();
  casts.length = hits.length = 0;
  shrinePulses = 0;
  const reserve = sukuna.cursedEnergy;
  assert(reserve.spend(40));
  powers.domainCooldown = 0;
  opponent.pos.set(188, 65, 0);
  tick(.1, [opponent]);
  assert(!casts.includes("shrine"), "Shrine needs enough CE even when its cooldown is ready");
  assert(!casts.includes("world-slash"), "Sukuna banks CE for a ready Shrine instead of spending it on a ranged slash");
  reserve.update(4);
  tick(.1, [opponent]);
  assert.equal(casts.at(-1), "shrine", "Shrine opens using replenished CE without any prior moves");
  tick(1.41, [opponent]);
  tick(.24, [opponent]);
  assert(reserve.burnedOut && powers.shrineActive);
  assert.equal(shrinePulses, 0, "the first Shrine pulse waits a quarter second");
  tick(.01, [opponent]);
  assert(hits.some(hit => hit.technique === "shrine" && hit.target === opponent), "Shrine catches an airborne target inside 200 metres");
  hits.length = 0;
  opponent.pos.set(201, 0, 0);
  tick(.8, [opponent]);
  assert.equal(hits.length, 0, "targets beyond 200 metres are outside the domain");
  const domainAura = reserve.auraLevel;
  tick(8.94, [opponent]);
  assert.equal(reserve.auraLevel, domainAura, "CE does not recharge during Shrine");
  assert.equal(shrinePulses, 39);
  assert(powers.shrineActive);
  tick(.01, [opponent]);
  assert(!powers.shrineActive, "Shrine ends at ten seconds");
  assert.equal(shrinePulses, 40, "Shrine emits forty groups of twenty slashes");
  assert(reserve.burnedOut && !reserve.canSpend(CURSED_COST.fuga), "Fuga is locked during post-domain burnout");
  assert.equal(ally.vitals.health, 100);
  resetFight();

  sukuna.vitals.health = 180;
  step(.1);
  step(1.61);
  assert.equal(sukuna.vitals.health, 576, "RCT restores 66% of max HP");
  powers.update(.1, sukuna, opponent, [], false);
  assert(!sukuna.specialChanneling);
  assert(effects.every(child => !child.visible), "dismissal clears the effects");

  sukuna.vitals.health = 0;
  assert(sukuna.revive(false, true));
  assert.equal(sukuna.vitals.health, 600);
  assert(sukuna.vitals.inReviveGrace);
  const mover = new Faora(world, scene, "Sukuna");
  mover.spawn(0, 0);
  mover.setEnemyMode(true);
  const airborne = { pos: new THREE.Vector3(20, 100, 0), vel: new THREE.Vector3(), speed: 0,
    yaw: 0, pitch: 0, flying: true, onGround: false, inWater: false, vitals: new Vitality() };
  for (let i = 0; i < 120; i++) mover.update(1 / 60, airborne);
  assert(mover.pos.y < .2, "Sukuna stays grounded beneath targets beyond jump range");
  mover.spawn(0, 0);
  mover.setEnemyMode(true);
  airborne.pos.set(43, 0, 0);
  airborne.flying = false;
  airborne.onGround = true;
  let leaps = 0, landings = 0, jumpStrikes = 0, topSpeed = 0;
  mover.onLeap = () => { leaps++; };
  mover.onLand = () => { landings++; };
  mover.onCounterAttack = (_direction, _charge, style) => {
    if (style === "down") jumpStrikes++;
    return true;
  };
  const mobilePowers = new SukunaPowers(scene);
  for (let i = 0; i < 240; i++) {
    mobilePowers.update(1 / 60, mover, airborne, [airborne], true);
    mover.update(1 / 60, airborne);
    topSpeed = Math.max(topSpeed, Math.hypot(mover.vel.x, mover.vel.z));
  }
  assert(topSpeed >= 22 && topSpeed <= 32.01, "Sukuna uses a fast, controlled sprint");
  assert(leaps >= 1 && landings === leaps, "Sukuna runs into a jump and lands");
  assert(jumpStrikes > 0 && mover.pos.distanceTo(airborne.pos) < 6, "he closes into melee and strikes from the jump");

  const pressured = new Faora(world, scene, "Sukuna");
  pressured.spawn(0, 0);
  pressured.setEnemyMode(true);
  const pressuringFoe = { ...airborne, pos: new THREE.Vector3(3, 0, 0) };
  const melee = { name: "Anissa", team: "foe", action: "punch" };
  const incoming = new THREE.Vector3(-1, 0, 0);
  let escapeJumps = 0;
  pressured.onLeap = () => { escapeJumps++; };
  for (let hit = 0; hit < 2; hit++) pressured.strike(incoming, inherited, 0, false, 30, 1, melee);
  for (let frame = 0; frame < 18; frame++) pressured.update(1 / 60, pressuringFoe);
  assert.equal(escapeJumps, 0, "two light hits do not trigger an escape");
  pressured.strike(incoming, inherited, 0, false, 30, 1, melee);
  pressured.leapCooldown = 1;
  const escapePowers = new SukunaPowers(scene);
  escapePowers.cooldown = 0;
  for (let frame = 0; frame < 45; frame++) {
    escapePowers.update(1 / 60, pressured, pressuringFoe, [pressuringFoe], true);
    pressured.update(1 / 60, pressuringFoe);
  }
  assert(escapeJumps === 1 && pressured.pos.x < -8 && pressured.pos.y > .5, "repeated melee hits trigger a jump away from the attacker");

  mobilePowers.reset(mover);
  mover.pos.y = 12;
  mover.poseCursedStrike(true);
  mover.update(1 / 60, airborne);
  assert.equal(mover.poseInput.grapple, "kick", "the kick animation still plays during the fall");
  for (let i = 0; i < 35; i++) mover.update(1 / 60, airborne);
  assert(mover.pos.y < 11, "Sukuna keeps falling after an airborne kick");
  assert.equal(mover.poseInput.grapple, null, "the kick blends out without switching to a hold");
  for (let i = 0; i < 120 && mover.pos.y > .02; i++) mover.update(1 / 60, airborne);
  assert(mover.asTarget.onGround && mover.pos.y === 0 && mover.vel.y === 0, "Sukuna lands after an airborne kick");
  const knockedDown = new Faora(world, scene, "Sukuna");
  knockedDown.spawn(0, 0);
  knockedDown.pos.set(0, 18, 0);
  knockedDown.model.position.copy(knockedDown.pos);
  knockedDown.ragdoll.start(new THREE.Vector3());
  knockedDown.ragdollTime = 0;
  knockedDown.update(1 / 60, airborne);
  assert(knockedDown.ragdoll.active && knockedDown.riseTime === 0, "Sukuna cannot get up midair");
  for (let i = 0; i < 250 && knockedDown.ragdoll.active; i++) knockedDown.update(1 / 60, airborne);
  assert(!knockedDown.ragdoll.active && knockedDown.pos.y < .4 && knockedDown.riseTime > 0, "Sukuna gets up after landing");
  const overhangWorld = {
    ...world,
    spans: (x) => ({
      top: x > .12 ? 20 : 0,
      floor: y => x > .12 && y >= 8 ? 20 : 0,
      ceil: y => x > .12 && y < 8 ? 8 : Infinity,
      solid: y => x > .12 && y >= 8 && y < 20,
    }),
  };
  const faller = new Faora(overhangWorld, scene, "Sukuna");
  faller.spawn(0, 0);
  faller.setEnemyMode(true);
  faller.pos.set(0, 12, 0);
  faller.vel.set(8, -1, 0);
  airborne.pos.set(20, 12, 0);
  for (let i = 0; i < 150; i++) faller.update(1 / 60, airborne);
  assert(faller.pos.y < .2, "sideways steering into a ledge cannot interrupt Sukuna's fall");

  const { DOOMSDAY_BEAM_STRENGTH, DOOMSDAY_BEAM_IMPULSE, DOOMSDAY_BEAM_DAMAGE_SCALE } =
    await server.ssrLoadModule("/src/beam-impact.ts");
  const beamVictim = new Faora(world, scene, "Sukuna");
  beamVictim.spawn(0, 0);
  beamVictim.setEnemyMode(true);
  beamVictim.pos.y = 9;
  airborne.pos.set(15, 0, 0);
  const beamDirection = new THREE.Vector3(1, .6, 0).normalize();
  for (let frame = 0; frame < 160; frame++) {
    if (frame < 90 && frame % 10 === 0) {
      beamVictim.strike(beamDirection, new THREE.Vector3(), DOOMSDAY_BEAM_IMPULSE, false,
        DOOMSDAY_BEAM_STRENGTH, DOOMSDAY_BEAM_DAMAGE_SCALE, { name: "Doomsday", team: "foe", action: "beam" });
      assert(!beamVictim.ragdoll.active && beamVictim.vel.y <= 0, "beam ticks cannot relaunch Sukuna");
    }
    beamVictim.update(1 / 60, airborne);
  }
  assert(beamVictim.pos.y < .2, "Sukuna lands after repeated upward beam hits");
  assert(beamVictim.vitals.health < 600, "the beam still deals damage");

  const novaVictim = new Faora(world, scene, "Sukuna");
  novaVictim.spawn(0, 0);
  novaVictim.setEnemyMode(true);
  novaVictim.pos.y = 9;
  novaVictim.strike(beamDirection, new THREE.Vector3(), 450, false, 180, 2,
    { name: "Doomsday", team: "foe", action: "nova" });
  assert(novaVictim.vitals.health < 600 && !novaVictim.ragdoll.active);
  for (let frame = 0; frame < 210; frame++) {
    novaVictim.applyDoomsdayShove(beamDirection, 4);
    assert(novaVictim.vel.y <= 0 && novaVictim.vel.x <= 36.001);
    novaVictim.update(1 / 60, airborne);
  }
  assert(novaVictim.pos.y < .2, "Sukuna lands despite the Nova's entire wake");

  const dodger = new Faora(world, scene, "Sukuna");
  dodger.spawn(0, 0);
  dodger.setEnemyMode(true);
  const shot = new THREE.Vector3(1, 0, 0);
  const beam = { name: "Doomsday", team: "foe", action: "beam" };
  assert.equal(dodger.strike(shot, new THREE.Vector3(), 1100, false, 130, .04, beam), false);
  assert(dodger.pos.z > 4 && dodger.vitals.health === 600, "Sukuna sidesteps the beam without damage");
  airborne.pos.copy(dodger.pos).x += 4;
  for (let i = 0; i < 18; i++) dodger.update(1 / 60, airborne);
  assert(dodger.strike(shot, new THREE.Vector3(), 1100, false, 130, .04, beam), "Sukuna can be hit during the dodge cooldown");
  assert(dodger.vitals.health < 600);
  dodger.spawn(0, 0);
  assert.equal(dodger.strike(shot, new THREE.Vector3(), 150, true, 75, 1,
    { name: "YOU", team: "player", action: "shockwave" }), false);
  assert(dodger.pos.z > 4 && dodger.vitals.health === 600, "Sukuna can also dodge a shockwave");

  const blink = new Faora(world, scene, "Sukuna");
  blink.spawn(0, 0);
  blink.setEnemyMode(true);
  let blinks = 0;
  blink.onBlink = () => { blinks++; };
  airborne.pos.set(90, 0, 0);
  blink.update(1 / 60, airborne);
  assert.equal(blinks, 1);
  assert(blink.pos.distanceTo(airborne.pos) < 6 && blink.pos.y < .2, "blink ends on clear ground beside the target");
  airborne.pos.set(160, 0, 0);
  blink.update(1 / 60, airborne);
  assert.equal(blinks, 1, "blink has a cooldown");

  // World-cutting slash: past Dismantle's reach, through cover, carving the ground as it flies.
  const reach = new SukunaPowers(scene);
  const caster = new Faora(world, scene, "Sukuna");
  caster.setEnemyMode(true);
  reach.domainCooldown = 60;
  caster.lineClear = () => false;
  const distant = { pos: new THREE.Vector3(150, 0, 0), vitals: new Vitality() };
  const worldHits = [], worldCasts = [], carved = [];
  reach.onHit = (technique, target) => worldHits.push({ technique, target });
  reach.onCast = technique => worldCasts.push(technique);
  reach.onWorldCut = point => carved.push(point.x);
  const aim = (frames, foe = distant) => { for (let i = 0; i < frames; i++) reach.update(1 / 60, caster, foe, [foe], true); };
  reach.update(2.1, caster, distant, [distant], true);
  aim(1);
  assert.deepEqual(worldCasts, ["world-slash"], "a distant target behind cover draws the world-cutting slash");
  aim(100);
  assert.equal(worldHits.length, 0, "the slash has a wind-up and travel time");
  aim(40);
  assert.deepEqual(worldHits.map(hit => hit.technique), ["world-slash"], "it ignores cover and lands once");
  aim(60);
  assert(carved.length >= 20 && carved.every((x, i) => i === 0 || x > carved[i - 1]), "it carves the ground along its whole line");
  assert.equal(worldHits.length, 1);
  worldHits.length = worldCasts.length = 0;
  aim(300);
  assert.equal(worldCasts.length, 0, "the slash has a long cooldown");
  for (let i = 0; i < 300 && !worldCasts.length; i++) aim(1);
  assert.equal(worldCasts.length, 1);
  aim(70);
  distant.pos.z = 20;
  aim(120);
  assert.equal(worldHits.length, 0, "stepping off the line after he commits dodges it");
  reach.reset(caster);
  worldCasts.length = 0;
  const outOfReach = { pos: new THREE.Vector3(300, 0, 0), vitals: new Vitality() };
  reach.update(2.1, caster, outOfReach, [outOfReach], true);
  aim(200, outOfReach);
  assert.equal(worldCasts.length, 0, "beyond 240 m he does not cast it");

  // Fuga: aimed at a clear target, a wall raised before release takes the blast instead.
  reach.reset(caster);
  let wall = false;
  caster.lineClear = (from, to) => !wall || Math.max(from.x, to.x) < 10;
  const archer = { pos: new THREE.Vector3(30, 0, 0), vel: new THREE.Vector3(), vitals: new Vitality() };
  const blasts = [];
  worldHits.length = worldCasts.length = 0;
  reach.onFuga = point => blasts.push(point.clone());
  caster.cursedEnergy.reset();
  reach.update(8.1, caster, outOfReach, [outOfReach], true);
  aim(1, archer);
  assert.deepEqual(worldCasts, ["fuga"]);
  wall = true;
  aim(90, archer);
  assert.equal(blasts.length, 1, "Fuga detonates even when cover cuts it short");
  assert(blasts[0].x > 8 && blasts[0].x < 10.01, "it bursts against the wall");
  assert.equal(worldHits.length, 0, "a target beyond the blast radius is spared");
  assert(caster.cursedEnergy.auraLevel < 1, "Fuga spends CE even when interrupted by terrain");

  const tactic = (foe, meleeCasts = 0) => {
    reach.reset(caster);
    reach.domainCooldown = 60;
    caster.cursedEnergy.reset();
    worldCasts.length = 0;
    reach.meleeCasts = meleeCasts;
    reach.update(2.1, caster, foe, [foe], true);
    return worldCasts[0];
  };
  wall = false;
  assert.equal(tactic({ ...archer, pos: new THREE.Vector3(3, 0, 0), combatWhiff: 1 }), "punch");
  assert.equal(tactic({ ...archer, pos: new THREE.Vector3(3, 0, 0), combatGuard: 90 }, 1), "cleave");
  assert.equal(tactic({ ...archer, infinityProtects: true }), "world-slash");
  wall = true;
  assert.equal(tactic(archer), "world-slash", "Sukuna uses World Slash against nearby cover");
  wall = false;
  reach.reset(caster);
  caster.cursedEnergy.reset();
  reach.domainCooldown = 60;
  reach.fugaCooldown = 0;
  reach.cooldown = 0;
  archer.vel.set(0, 0, 25);
  aim(1, archer);
  reach.update(1.6, caster, archer, [archer], true);
  assert(reach.fugaEnd.z > 10, "Sukuna aims Fuga ahead of a moving target");

  console.log("Sukuna: Dismantle, evasion, cover, Cleave, interrupts, Shrine, Fuga, RCT, CE-gated domains, World Slash, Fuga into cover, dismissal, and revival passed.");
} finally {
  await server.close();
}
