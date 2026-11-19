import assert from "node:assert/strict";
import { createServer } from "vite";
import * as THREE from "three";

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { Combat } = await server.ssrLoadModule("/src/combat.ts");
  const c = new Combat();
  assert.equal(c.defend(25), 1, "unguarded attacks pass through");
  assert.equal(c.begin("guard"), true);
  assert.equal(c.begin("attack"), false, "guard and attack are exclusive");
  c.update(1, false);
  assert.equal(c.guard, 50);
  assert.equal(c.defend(50), 0, "equal guard fully blocks");
  assert.equal(c.guard, 0, "full block consumes attack strength");
  c.update(.25, true);
  assert.equal(c.guard, 25, "Shift doubles guard charge");
  assert.equal(c.defend(100), .75, "partial block passes only the remainder");
  assert.equal(c.guard, 0);
  c.end("guard");
  assert.equal(c.begin("attack"), true);
  c.update(.5, true);
  assert.equal(c.end("attack"), .5, "Shift doubles attack charge");
  assert.equal(c.end("guard"), null, "releasing the other button does not cancel the active action");
  assert.equal(c.begin("attack", true), true);
  c.update(1, false);
  assert.equal(c.begin("guard"), true, "guard interrupts a charged kick");
  assert.equal(c.end("attack"), null, "releasing the canceled attack does not fire");
  assert.equal(c.attack, 0);
  assert.equal(c.kick, false);
  c.update(3, true); assert.equal(c.guard, 100);
  c.cancel(); assert.equal(c.guard, 0);
  const { Interactions } = await server.ssrLoadModule("/src/interactions.ts");
  const collision = (guard) => {
    const defender = new Combat(); defender.begin("guard"); defender.update(guard / 50, false);
    const prop = {
      held: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(40, 0, 0), radius: 1,
      collider: { projectPoint: p => ({ isInside: false, point: new THREE.Vector3(p.x - .1, p.y, p.z) }) },
      body: { applyImpulseAtPoint() { throw new Error("blocked projectile received an impulse"); } },
    };
    const context = { props: [prop], center: new THREE.Vector3(), playerHitCooldown: new Map(),
      onIncomingAttack: amount => defender.defend(amount), onImpact() {} };
    const player = { pos: new THREE.Vector3(.1, 0, 0), vel: new THREE.Vector3() };
    Interactions.prototype.resolvePlayer.call(context, player);
    return { defender, player };
  };
  const blocked = collision(50);
  assert.equal(blocked.player.vel.length(), 0, "a fully blocked incoming prop adds no knockback");
  assert.equal(blocked.defender.guard, 10, "projectile strength is consumed once per contact");
  const partial = collision(10);
  assert.ok(Math.abs(partial.player.vel.x - 32.4) < .001, "partial projectile block scales the incoming impulse");
  let collisionSpeed = 0;
  const stationary = { held: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), radius: 1,
    collider: { projectPoint: p => ({ isInside: false, point: new THREE.Vector3(p.x - .1, p.y, p.z) }) },
    body: { applyImpulseAtPoint() {} } };
  const crashContext = { props: [stationary], center: new THREE.Vector3(), playerHitCooldown: new Map(),
    onIncomingAttack: () => 1, onImpact() {}, onPlayerCollision: speed => { collisionSpeed = speed; } };
  Interactions.prototype.resolvePlayer.call(crashContext, { pos: new THREE.Vector3(.1, 0, 0), vel: new THREE.Vector3(-20, 0, 0) });
  assert.equal(collisionSpeed, 20, "slamming into an object reports the impact for injury");
  console.log("Combat: charge, exclusivity, full and partial blocks, consumption and cancellation passed.");
} finally { await server.close(); }
