import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { Faora } = await server.ssrLoadModule('/src/faora.ts');
  const spans = { top: 0, water: false, floor: () => 0, ceil: () => Infinity, solid: () => false };
  const world = { spans: () => spans, materialAt: () => ({ bounce: 0 }), crater() {}, launch() {} };
  const player = { pos: new THREE.Vector3(0, 0, 100), vel: new THREE.Vector3(), speed: 0, yaw: 0, pitch: 0, flying: false, onGround: true, inWater: false, eyeLevel: 1.6, combatAttacking: false, vitals: { defeated: false } };
  // Resolve a punch the way the game does for fighter-on-fighter hits.
  const wire = (fighter, hits) => { fighter.onCounterAttack = (direction, charge) => {
    hits.push(fighter.pos.distanceTo(fighter.opponent.pos));
    return fighter.opponent.strike(direction, fighter.vel, 260 * (1 + charge * 3), false, 20 + charge * 80);
  }; };

  const friend = new Faora(world, new THREE.Scene()), foe = new Faora(world, new THREE.Scene(), 'Anissa');
  friend.spawn(0, 0); foe.spawn(20, 0); foe.setEnemyMode(true);
  friend.opponent = foe; foe.opponent = friend;
  const friendHits = [], foeHits = [];
  wire(friend, friendHits); wire(foe, foeHits);
  assert.equal(friend.hostile, false, 'a friend fighting a foe is not hostile to you');
  assert.equal(friend.availableToFight, true, 'an engaged friend counts as fighting');
  for (let i = 0; i < 400; i++) { friend.update(.025, player); foe.update(.025, player); }
  assert.equal(friend.state, 'retaliate', 'the friend squares up to the foe');
  assert.ok(friendHits.length > 0 && foeHits.length > 0, `both sides swing: ${friendHits.length} / ${foeHits.length}`);
  assert.ok([...friendHits, ...foeHits].every(range => range < 8), 'swings land at punching range');
  assert.ok(friend.vitals.health < 100 && foe.vitals.health < 100, 'both sides take damage');
  assert.ok(friend.pos.distanceTo(player.pos) > 60, 'the friend stays on the foe instead of returning to you');

  friend.recall(player);
  assert.equal(friend.opponent, null, 'recalling a friend calls her off the fight');
  friend.ragdoll.active && friend.ragdoll.stop();
  for (let i = 0; i < 4; i++) friend.update(.025, player);
  assert.equal(friend.state, 'follow', 'a recalled friend returns to formation');

  // Seen as a target, a fighter looks like the player to the combat code.
  const view = foe.asTarget;
  assert.ok(view.pos === foe.pos && view.vitals === foe.vitals && typeof view.yaw === 'number' && Number.isFinite(view.eyeLevel));

  // Battle Beast's charge builds into a sprint well past his old 22 m/s cap.
  const beast = new Faora(world, new THREE.Scene(), 'Battle Beast');
  beast.spawn(0, 0); beast.setEnemyMode(true); beast.leapCooldown = 1e9;
  const far = { ...player, pos: new THREE.Vector3(400, 0, 0) };
  let stomps = 0, top = 0; beast.onStomp = () => stomps++;
  for (let i = 0; i < 240; i++) { beast.update(1 / 60, far); top = Math.max(top, Math.hypot(beast.vel.x, beast.vel.z)); }
  assert.ok(top > 40, `sprint reaches over 40 m/s: ${top.toFixed(1)}`);
  assert.ok(stomps > 4, 'sprinting footfalls pound the ground');
  beast.setEnemyMode(false); beast.vel.set(0, 0, 0);
  const calm = { ...player, pos: beast.pos.clone().add(new THREE.Vector3(60, 0, 0)) };
  let walk = 0;
  for (let i = 0; i < 240; i++) { beast.update(1 / 60, calm); walk = Math.max(walk, Math.hypot(beast.vel.x, beast.vel.z)); }
  assert.ok(walk < 16, `a friendly beast following you does not sprint: ${walk.toFixed(1)}`);
  console.log('Allies: fighter-on-fighter combat, recall, target view and Battle Beast sprint passed.');
} finally { await server.close(); }
