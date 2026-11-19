import assert from "node:assert/strict";
import * as THREE from "three";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { Faora } = await server.ssrLoadModule("/src/faora.ts");
  const { GojoPowers, GOJO_HITS } = await server.ssrLoadModule("/src/gojo.ts");
  const { Vitality, hitDamage } = await server.ssrLoadModule("/src/vitality.ts");
  const { bypassesDefenseStat, playerHit } = await server.ssrLoadModule("/src/combat-events.ts");
  const scene = new THREE.Scene();
  const world = {
    spans: () => ({ top: 0, floor: () => 0, ceil: () => Infinity, solid: () => false }),
    materialAt: () => ({ bounce: 0 }), crater() {}, launch() {},
  };
  const gojo = new Faora(world, scene, "Satoru Gojo");
  const sukuna = new Faora(world, scene, "Sukuna");
  const ally = new Faora(world, scene, "Anissa");
  const powers = new GojoPowers(scene);
  const zero = new THREE.Vector3(), heading = new THREE.Vector3(1, 0, 0);
  const makeTarget = (x, y = 0, z = 0) => ({
    pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), vitals: new Vitality(),
    yaw: 0, pitch: 0, speed: 0, onGround: y === 0, flying: y > 0, inWater: false, eyeLevel: y + 1.6,
  });
  const target = makeTarget(45);
  const base = () => {
    gojo.spawn(0, 0);
    gojo.pos.y = 0;
    gojo.setEnemyMode(true);
    powers.reset(gojo);
    gojo.lineClear = () => true;
    powers.blockedAt = () => false;
    target.pos.set(45, 0, 0);
    target.vel.set(0, 0, 0);
    target.vitals.reset();
  };
  const step = (dt = 1 / 60, enemies = [target], everyone = enemies, elapsed = dt) =>
    powers.update(dt, gojo, target, enemies, everyone, elapsed);
  const run = (seconds, enemies = [target], everyone = enemies) => {
    for (let frame = 0; frame < Math.round(seconds * 60); frame++) step(1 / 60, enemies, everyone);
  };
  for (const [kind, cost] of [["blue-melee", 17], ["red-melee", 22]]) {
    base();
    gojo.infinity.setActive(false);
    assert(powers.begin(gojo, kind, target));
    assert(Math.abs(gojo.cursedEnergy.auraLevel - (100 - cost) / 100) < 1e-8, `${kind} spends ${cost} CE`);
  }
  for (const [kind, strikeCost] of [["blue", 17], ["maximum-blue", 17], ["red", 22]]) {
    base();
    gojo.infinity.setActive(false);
    target.pos.x = 86;
    target.vel.x = 85;
    assert(powers.begin(gojo, kind, target));
    const { spec } = powers.cast.plan;
    powers.orbs.spawn(spec);
    const afterCast = gojo.cursedEnergy.reserveFraction;
    for (let frame = 0; frame <= Math.ceil(spec.duration * 60); frame++) {
      powers.orbs.update(1 / 60, frame / 60, gojo.cursedEnergy, gojo, []);
    }
    const spent = 100 * (1 - gojo.cursedEnergy.reserveFraction);
    assert(gojo.cursedEnergy.reserveFraction < afterCast, `${kind} still pays upkeep`);
    assert(spent < strikeCost, `${kind} costs less over its full duration than the matching infused strike`);
  }
  base();
  gojo.infinity.setActive(false);
  assert(gojo.cursedEnergy.spend(89));
  assert(!powers.begin(gojo, "red", target), "Red still requires enough CE to cast");

  const casts = [], impacts = [], hits = [], cuts = [], pulls = [], explosions = [];
  powers.onCast = kind => casts.push(kind);
  powers.onHit = (kind, victim, direction, scale) => { hits.push({ kind, victim, direction: direction.clone(), scale }); return true; };
  powers.onExplosion = (kind, point, radius) => explosions.push({ kind, point: point.clone(), radius });
  powers.onImpact = (kind, point) => impacts.push({ kind, point: point.clone() });
  powers.onPurplePath = point => cuts.push(point.clone());
  powers.onPull = (victim, direction) => pulls.push({ victim, direction: direction.clone() });

  base();
  gojo.standing = false;
  gojo.pos.y = 5;
  target.pos.x = 18;
  powers.cooldown = 3;
  gojo.infinity.setActive(false);
  assert(gojo.cursedEnergy.spend(45));
  gojo.infinity.setActive(true);
  step(1);
  assert(!gojo.infinity.active && Math.abs(gojo.cursedEnergy.reserveFraction - .59) < 1e-8,
    "nearby enemies alone do not drain Gojo's airborne reserve");

  base();
  gojo.standing = true;
  target.pos.x = 7;
  target.combatAttacking = true;
  target.combatAttackCharge = .8;
  powers.cooldown = 3;
  step(.05);
  assert(gojo.infinity.active, "Gojo raises Infinity for a heavy attack");
  step(.6);
  assert(!gojo.infinity.active, "a sustained wind-up cannot keep Infinity running");
  target.combatAttacking = false;
  step(.05);
  target.combatAttacking = true;
  step(.05);
  assert(gojo.infinity.active, "a fresh threat re-arms the defense");

  base();
  casts.length = 0;
  target.pos.x = 4;
  gojo.infinity.setActive(false);
  assert(gojo.cursedEnergy.spend(74));
  powers.cooldown = 0;
  step(.05);
  assert.equal(casts.at(-1), "red-melee", "Gojo risks an infused counter instead of paying to stay behind Infinity");
  assert(!gojo.infinity.active);
  target.combatAttacking = false;
  target.combatAttackCharge = 0;

  base();
  gojo.infinity.setActive(false);
  assert(gojo.cursedEnergy.spend(80));
  assert(!powers.spendOnMelee(gojo), "Gojo banks low CE for techniques instead of spending it on basic strikes");
  gojo.cursedEnergy.update(2);
  assert(powers.spendOnMelee(gojo), "Gojo still spends excess CE on basic strikes");

  base();
  casts.length = hits.length = 0;
  gojo.standing = false;
  gojo.pos.y = 9;
  powers.cooldown = powers.purpleCooldown = 0;
  target.pos.x = 38;
  target.castPose = "world";
  target.castProgress = .5;
  gojo.dodgeTime = .5;
  step(.05);
  assert.equal(casts.at(-1), "purple", "Gojo can counter a committed cast even while airborne and dodging");
  assert(!gojo.infinity.active, "Infinity stays down against an attack it cannot block");
  assert(gojo.vitals.hit(20), "chip damage lands");
  run(1.8);
  assert(hits.some(hit => hit.kind === "purple"), "chip damage does not cancel the attack");
  delete target.castPose;
  delete target.castProgress;

  base();
  assert(powers.begin(gojo, "red", target));
  assert(gojo.vitals.hit(100), "a heavy hit lands");
  step(.1);
  assert(!gojo.specialChanneling && !powers.orbs.active.length, "a heavy hit still cancels the cast");

  base();
  gojo.setEnemyMode(false);
  sukuna.spawn(35, 0);
  gojo.opponent = sukuna;
  for (let frame = 0; frame < 90; frame++) gojo.update(1 / 60, target);
  const castingGap = gojo.pos.distanceTo(sukuna.pos);
  assert(castingGap > 12 && castingGap < 20 && gojo.pos.y < 1,
    `Gojo closes to casting range and lands there (gap=${castingGap.toFixed(1)}, height=${gojo.pos.y.toFixed(1)})`);

  base();
  casts.length = 0;
  powers.cooldown = 0;
  gojo.infinity.setActive(false);
  assert(gojo.cursedEnergy.spend(85));
  step(.05);
  assert.equal(casts.length, 0, "Gojo avoids an unaffordable Blue-to-Red setup when only Blue is affordable");
  step(1);
  assert.equal(casts.at(-1), "red", "Gojo uses direct damage as soon as he can afford it");

  base();
  hits.length = 0;
  assert(powers.begin(gojo, "purple", target));
  step(1.15);
  target.pos.z = 12;
  run(.6);
  assert(hits.some(hit => hit.kind === "purple" && hit.victim === target), "Purple aims at the target's late move before firing");

  base();
  hits.length = 0;
  target.chargeArmored = true;
  assert(powers.begin(gojo, "purple", target));
  step(1.45);
  assert(gojo.specialChanneling && !powers.shot.kind, "Gojo holds Purple through Sukuna's charge armor");
  target.chargeArmored = false;
  run(.3);
  assert(hits.some(hit => hit.kind === "purple"), "Gojo fires when the armor drops");
  delete target.chargeArmored;

  base();
  gojo.standing = true;
  target.pos.x = 24;
  target.castPose = "dismantle";
  target.castProgress = .9;
  powers.cooldown = 3;
  step(.05);
  step(1.1);
  assert(gojo.infinity.active, "Gojo covers the Dismantle volley rather than dropping Infinity midway");
  step(.5);
  assert(!gojo.infinity.active, "the volley cannot keep Infinity running indefinitely");
  delete target.castPose;
  delete target.castProgress;

  base();
  let blocks = 0;
  gojo.onInfinityBlock = () => blocks++;
  assert(!gojo.strike(heading, zero, 100, false, 100, 1, playerHit("smash")));
  assert(!gojo.strike(heading, zero, 100, false, 100, 1, playerHit("smash")));
  assert.equal(gojo.vitals.health, 600);
  assert.equal(blocks, 2);
  assert(gojo.infinity.active, "heavy pressure cannot overload Infinity");
  for (const action of ["dismantle", "cleave"]) {
    assert(!gojo.strike(heading, zero, 0, false, 45, 1, { name: "Sukuna", team: "foe", action }));
  }
  assert(gojo.strike(heading, zero, 0, false, 45, 1, { name: "Sukuna", team: "foe", action: "world-slash" }));
  assert(gojo.strike(heading, zero, 0, false, 45, 1, { name: "Sukuna", team: "foe", action: "shrine" }));
  gojo.infinity.setActive(false);
  assert(gojo.strike(heading, zero, 0, false, 20, 1, playerHit("punch")));
  assert.equal(powers.defendDomain(gojo), 0);
  step(2.3, []);
  assert.equal(powers.defendDomain(gojo), .26);
  step(3.5, []);
  assert.equal(powers.defendDomain(gojo), 1);

  base();
  casts.length = hits.length = 0;
  const bystander = makeTarget(55, 0, .5), offAxis = makeTarget(44, 0, 22);
  gojo.lineClear = () => false;
  powers.blockedAt = point => point.x >= 14 && point.x < 17;
  step(1.55, [target, bystander, offAxis]);
  assert.equal(casts.at(-1), "amplified-purple");
  run(2.95, [target, bystander, offAxis]);
  assert.deepEqual(hits.map(hit => hit.victim), [target, bystander], "opening Purple sweeps through cover and hits each target once");
  assert(hits.every(hit => hit.kind === "amplified-purple"));
  assert(cuts.length > 20, "Purple opens a continuous corridor through the route");
  assert(bypassesDefenseStat({name: gojo.name, team: "foe", action: "amplified-purple"}));
  assert(hitDamage(GOJO_HITS["amplified-purple"].strength) * GOJO_HITS["amplified-purple"].multiplier > 60);
  casts.length = 0;
  step(12);
  assert.equal(casts.at(-1), "purple", "later shots use regular Hollow Purple");

  base();
  casts.length = hits.length = 0;
  gojo.setEnemyMode(false);
  sukuna.spawn(20, 0);
  sukuna.pos.set(20, 0, 0);
  sukuna.vel.set(-24, 0, 0);
  gojo.opponent = sukuna;
  const rival = sukuna.asTarget;
  powers.update(1, gojo, rival, [rival]);
  assert.equal(casts.at(-1), "red", "friendly Gojo opens with Red to intercept a rushing Sukuna");
  for (let frame = 0; frame < 48; frame++) {
    sukuna.pos.x -= .2;
    powers.update(1 / 60, gojo, rival, [rival]);
  }
  assert(hits.some(hit => hit.kind === "red" && hit.victim === rival), "the released Red orb connects");

  const point = (x, z = 0) => new THREE.Vector3(x, 1, z);
  const place = (color, x, { radius = 2, force = 50, speed = 0, destination = point(x), duration = 6 } = {}) =>
    powers.orbs.spawn({ color, position: point(x), destination, radius, force, speed, duration });
  const orbStep = (dt, enemies = [target]) => powers.orbs.update(dt, 1, gojo.cursedEnergy, gojo, enemies);

  base();
  hits.length = pulls.length = 0;
  const blue = place("blue", 45);
  const red = place("red", 59);
  const side = makeTarget(48, 0, 5);
  const beforeUpkeep = gojo.cursedEnergy.auraLevel;
  orbStep(.1, [target, side]);
  assert.equal(powers.orbs.active.length, 2, "multiple independently maintained orbs coexist");
  assert(gojo.cursedEnergy.auraLevel < beforeUpkeep, "every live orb costs CE");
  assert.equal(hits.length, 0, "touching Blue causes no damage");
  assert(pulls.some(pull => pull.victim === side && pull.direction.x < 0 && pull.direction.z < 0), "Blue pulls inward");
  pulls.length = 0;
  const repelled = makeTarget(65);
  orbStep(.1, [repelled]);
  assert(pulls.some(pull => pull.direction.x > 0), "Red repels");
  powers.orbs.steer(red, blue.position, 160);
  orbStep(.19, [target]);
  assert.equal(powers.orbs.active.length, 0, "opposite orbs crossing at speed are consumed together");
  assert.equal(explosions.at(-1).kind, "remote-purple");
  assert(hits.some(hit => hit.kind === "remote-purple" && hit.victim === target));

  base();
  hits.length = 0;
  const intercept = place("red", 10);
  intercept.proximityFuse = true;
  target.pos.x = 14;
  orbStep(.02);
  assert(!powers.orbs.active.includes(intercept) && hits.some(hit => hit.kind === "red" && hit.victim === target),
    "aimed Red explodes when the target is in splash range before repelling them out of contact");

  const recordPull = powers.onPull;
  const orbMotion = (color, start, enemyX, channeling = false, speed = 0) => {
    base();
    sukuna.spawn(start, 0);
    sukuna.setEnemyMode(true);
    sukuna.specialChanneling = channeling;
    sukuna.vel.x = speed;
    place(color, 0);
    powers.onPull = (victim, direction, impulse) => {
      if (victim === sukuna.asTarget) sukuna.applyOrbImpulse(direction, impulse);
    };
    const enemy = makeTarget(enemyX);
    for (let frame = 0; frame < 40; frame++) {
      orbStep(1 / 60, [sukuna.asTarget]);
      sukuna.update(1 / 60, enemy);
    }
    return sukuna.pos.x;
  };
  const pulled = orbMotion("blue", 8, 25, false, 12);
  assert(pulled < 5, `Blue overcomes Sukuna's outward movement (x=${pulled.toFixed(2)})`);
  const dragged = orbMotion("blue", 8, 25, true);
  assert(dragged < 5, `Blue displaces Sukuna even while he channels a technique (x=${dragged.toFixed(2)})`);
  const pushed = orbMotion("red", 6, 0, false, -4);
  assert(pushed > 10, `Red repels Sukuna against his approach (x=${pushed.toFixed(2)})`);
  powers.onPull = recordPull;

  base();
  casts.length = hits.length = 0;
  const well = place("blue", 43);
  target.pos.x = 65;
  const captive = makeTarget(39);
  const beforeFusionCast = gojo.cursedEnergy.auraLevel;
  powers.cooldown = 3;
  powers.decisionDelay = .16;
  step(1 / 60, [target, captive]);
  assert.equal(casts.at(-1), "red", "Gojo starts Red immediately when Blue catches an enemy, even during normal recovery");
  assert.equal(powers.cast.target, captive, "the combo spots a trapped enemy outside Gojo’s current target");
  assert(gojo.cursedEnergy.auraLevel < beforeFusionCast - .12, "Gojo pays to cast Red toward the existing Blue");
  run(1.1, [target, captive]);
  assert(!powers.orbs.active.includes(well) && explosions.at(-1).kind === "remote-purple", "Red fuses instead of hitting the captive early");
  assert(hits.some(hit => hit.kind === "remote-purple" && hit.victim === captive));

  base();
  casts.length = hits.length = 0;
  const nextWell = place("blue", 45);
  const readyRed = place("red", 32);
  powers.cooldown = 2;
  const beforeRedirect = gojo.cursedEnergy.reserveFraction;
  step();
  assert.equal(casts.length, 0, "Gojo redirects an existing Red instead of casting another");
  assert.equal(readyRed.mergeTarget, nextWell);
  assert(gojo.cursedEnergy.reserveFraction > beforeRedirect - .03, "steering saves CE");
  run(.2);
  assert(hits.some(hit => hit.kind === "remote-purple" && hit.victim === target));

  base();
  const small = place("red", 16, { radius: 1, force: 26 });
  const big = place("red", 40, { radius: 3, force: 90 });
  assert(powers.orbs.collapse(small, gojo.cursedEnergy, gojo, []));
  assert(!powers.orbs.collapse(small, gojo.cursedEnergy, gojo, []));
  assert(powers.orbs.collapse(big, gojo.cursedEnergy, gojo, []));
  assert(explosions.at(-1).radius > explosions.at(-2).radius);
  const contact = place("red", 18);
  target.pos.x = 14;
  orbStep(.02);
  target.pos.x = 37;
  orbStep(.05);
  assert(!powers.orbs.active.includes(contact) && hits.at(-1).victim === target && hits.at(-1).kind === "red",
    "knocking someone all the way through Red still detonates it and hits them");

  base();
  const fleeting = place("blue", 45, { duration: .15 });
  orbStep(.16);
  assert(!powers.orbs.active.includes(fleeting), "orbs honor their duration");
  const expensive = place("blue", 45, { force: 99 });
  assert(gojo.cursedEnergy.spendUpkeep(99.95));
  orbStep(1);
  assert(!powers.orbs.active.includes(expensive), "orbs expire when upkeep is unaffordable");

  base();
  casts.length = hits.length = 0;
  target.pos.x = 4;
  step(1);
  run(.5);
  assert.equal(hits[0].kind, "blue-melee");
  for (const [kind, previous] of [["red", 1.18], ["blue-melee", 1], ["purple", 1.7], ["amplified-purple", 2.05], ["remote-purple", 1.85]]) {
    assert(Math.abs(GOJO_HITS[kind].multiplier / previous - 1.2) < 1e-8, `${kind} deals 20% more damage`);
  }
  assert.equal(GOJO_HITS["red-melee"].multiplier, 1);
  assert.equal(GOJO_HITS["red-melee"].splashMultiplier, 1.2);
  assert.equal(GOJO_HITS["blue-melee"].strength, 100);
  assert.equal(GOJO_HITS["red-melee"].strength, 100);
  assert.equal(GOJO_HITS["blue-melee"].impulse, 0);
  assert(GOJO_HITS["red-melee"].impulse > 500);

  base();
  casts.length = hits.length = 0;
  powers.domainCooldown = 60;
  target.pos.x = 8;
  step(1);
  assert.equal(casts.at(-1), "red");
  run(.65);
  const trap = powers.orbs.active[0];
  assert(trap.position.x > target.pos.x + 6 && trap.speed === 0, "Gojo plants Red behind an opponent he can approach");
  target.pos.x = 4;
  // Move the caster toward the opponent on the same line, as normal chase physics would.
  gojo.pos.x = .5;
  assert(powers.alignMelee(gojo, target, heading.clone()), "Gojo spots a melee trajectory into Red");
  run(1.9);
  assert(hits.some(hit => hit.kind === "red-melee" && hit.direction.x > .85), "the trap makes Red melee preferable to Blue melee");
  target.pos.copy(trap.position).y -= 1;
  orbStep(.1);
  assert.equal(hits.at(-1).kind, "red", "knocking the opponent into the trap adds a second hit");

  base();
  gojo.vitals.health = 234;
  step(1);
  run(1.4);
  assert.equal(gojo.vitals.health, 600, "RCT caps the restored health at full HP");

  base();
  target.pos.set(225, 12, 0);
  const beforeBlink = gojo.pos.clone();
  step(1);
  assert(beforeBlink.distanceTo(gojo.pos) > 100 && target.pos.distanceTo(gojo.pos) < 26, "Gojo blinks into a checked position at long range");

  base();
  casts.length = 0;
  const player = makeTarget(12, 7, 0), outside = makeTarget(37);
  target.pos.set(14, 0, 0);
  sukuna.spawn(0, 0);
  ally.spawn(0, 0);
  sukuna.pos.set(-3, 6, 0);
  ally.pos.set(-8, 2, 0);
  const everyone = [target, player, sukuna.asTarget, ally.asTarget, outside];
  const pulses = [];
  powers.onDomainDrain = (victim, damage) => { if (victim === player) pulses.push([victim.vitals.health, damage]); };
  powers.domainCooldown = 0;
  step(1, [target], everyone);
  assert.equal(casts.at(-1), "void");
  step(1.1, [target], everyone);
  assert(powers.domainActive && player.vitals.frozen && sukuna.vitals.frozen && ally.vitals.frozen);
  assert(!outside.vitals.frozen && !gojo.vitals.frozen);
  const outsideStart = new THREE.Vector3(41, 0, 0);
  const across = new THREE.Vector3(-48, 0, 0);
  const velocity = new THREE.Vector3(-2000, 0, 0);
  assert(powers.sealEntry(outsideStart, across, velocity), "a high-speed path cannot tunnel through the entire domain");
  assert(across.x > 36 && velocity.length() < 15);
  assert(powers.voidWall(outsideStart, new THREE.Vector3(0, 1, 0)) < 1);
  assert(!powers.sealEntry(outsideStart, new THREE.Vector3(41, 0, 7), new THREE.Vector3(0, 0, 10)), "movement along the outside remains free");
  const inAir = ally.pos.clone();
  ally.vel.set(50, -100, 0);
  ally.update(.1, player);
  assert(inAir.equals(ally.pos) && ally.vel.length() === 0);
  assert(!ally.strike(heading, zero, 700, true, 140, 1, playerHit("smash")));

  for (const expected of [50, 25, 12, 6]) {
    const previous = player.vitals.health;
    step(0, [target], everyone, 1.99);
    assert.equal(player.vitals.health, previous, "no damage before the scheduled pulse");
    assert(player.vitals.frozen);
    step(0, [target], everyone, .01);
    assert.equal(player.vitals.health, expected);
    assert.equal(sukuna.vitals.health, expected * 6);
    assert.equal(ally.vitals.health, expected);
    assert(player.vitals.frozen, "targets stay frozen through pulse four");
  }
  assert.deepEqual(pulses, [[50, 50], [25, 25], [12, 13], [6, 6]]);
  step(0, [target], everyone, 1.99);
  assert(player.vitals.frozen && powers.domainActive);
  step(0, [target], everyone, .01);
  assert.equal(player.vitals.health, 6, "the domain closes at ten seconds without a fifth damage pulse");
  assert.equal(outside.vitals.health, 100);
  assert(!powers.domainActive && !ally.vitals.frozen && !gojo.specialChanneling);
  assert(!powers.sealEntry(outsideStart, across.set(-48, 0, 0), velocity), "the boundary is removed when the domain ends");
  assert(!gojo.infinity.active, "domain burnout exposes Gojo when everyone thaws");
  ally.update(.1, player);
  assert(!ally.pos.equals(inAir), "the fighter moves again immediately after thaw");

  base();
  target.pos.x = 15;
  powers.domainCooldown = 0;
  step(1); step(1.1);
  assert(target.vitals.frozen);
  powers.reset(gojo);
  assert(!target.vitals.frozen && !gojo.specialChanneling, "dismissal immediately releases all domain victims");
  assert(gojo.cursedEnergy.burnedOut, "dismissing a domain cannot bypass burnout");
  gojo.cursedEnergy.update(32);
  powers.domainCooldown = 0;
  step(1); step(1.1);
  assert(target.vitals.frozen);
  gojo.vitals.health = 0;
  step();
  assert(!target.vitals.frozen && !powers.domainActive, "defeat releases every victim too");

  let searches = 0, routeClear = false;
  gojo.route.reset();
  gojo.route.finder.find = () => { searches++; return []; };
  gojo.route.finder.segmentClear = () => routeClear;
  for (let frame = 0; frame < 60; frame++) gojo.route.update(1 / 60, zero, target.pos);
  assert(gojo.route.mode === "stuck" && searches >= 2 && searches <= 6, "a blocked Gojo keeps retrying without searching every frame");
  routeClear = true;
  assert(gojo.route.update(.12, zero, target.pos).equals(target.pos) && gojo.route.mode === "direct", "Gojo takes a newly open route immediately on the next sight check");

  console.log("Gojo: Infinity, anti-domain defenses, Purple volleys and orb fusion, tactical Red traps, orb upkeep, melee, RCT, blink, and sealed four-pulse Unlimited Void passed.");
} finally {
  await server.close();
}
