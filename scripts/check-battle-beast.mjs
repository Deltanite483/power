import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { Faora } = await server.ssrLoadModule('/src/faora.ts');
  const spans = { top: 0, water: false, floor: () => 0, ceil: () => Infinity, solid: () => false };
  const world = { spans: () => spans, materialAt: () => ({ bounce: 0 }), crater() {}, launch() {} };
  const beast = new Faora(world, new THREE.Scene(), 'Battle Beast');
  beast.spawn(0, 0); beast.setEnemyMode(true);
  const player = { pos: new THREE.Vector3(12, 100, 0), vel: new THREE.Vector3(), speed: 0, yaw: 0, pitch: 0, flying: true, onGround: false, inWater: false };
  for (let i = 0; i < 120; i++) beast.update(1 / 60, player);
  assert.ok(beast.pos.y < .1, 'does not fly after targets beyond ballistic jump height');
  beast.pos.set(0, 15, 0); beast.vel.set(0, 0, 0);
  for (let i = 0; i < 30; i++) beast.update(1 / 60, player);
  assert.ok(beast.pos.y < 14, 'falls under gravity');
  beast.spawn(0, 0); beast.setEnemyMode(true);
  player.pos.set(100, 0, 0); player.onGround = true; player.flying = false;
  let landings = 0; beast.onLand = () => landings++;
  let leaps = 0; beast.onLeap = () => leaps++;
  let highest = 0;
  for (let i=0;i<390;i++) { beast.update(1/60,player); highest=Math.max(highest,beast.pos.y); }
  assert.ok(leaps > 0 && highest > 30, 'makes a massive leap over 30 metres high');
  assert.ok(beast.pos.y < .2 && landings > 0, 'lands after a ballistic leap');
  assert.ok(beast.pos.x > 85, 'covers substantial distance in the leap');
  assert.equal(beast.model.scale.x,1.6,'is visibly larger than other fighters');
  const runner = new Faora(world, new THREE.Scene(), 'Battle Beast');
  runner.spawn(0,0); runner.setEnemyMode(true);
  player.pos.set(20,0,0);
  for(let i=0;i<120;i++) {
    runner.update(1/60,player);
    assert.ok(Math.abs(runner.pos.z)<.01,'does not orbit a stationary player');
    const travel = runner.vel.clone().setY(0);
    if(travel.length()>1.5) assert.ok(runner.forward.dot(travel.normalize())>.99,'faces travel direction while running and leaping');
  }
  const normal = new Faora(world, new THREE.Scene());
  beast.vitals.reset(); normal.vitals.hit(100); beast.vitals.hit(100);
  assert.ok(100 - beast.vitals.health < (100 - normal.vitals.health) / 3, 'takes substantially less damage');
  beast.spawn(0, 0);
  beast.strike(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 500, false, 80);
  assert.equal(beast.ragdoll.active, false, 'natural resistance withstands strong hits');
  beast.strike(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 500, false, 120);
  assert.equal(beast.ragdoll.active, true, 'sufficient force still launches him');
  console.log('Battle Beast: gravity, no flight, durability and launch resistance passed.');
} finally { await server.close(); }
