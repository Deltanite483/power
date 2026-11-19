import assert from "node:assert/strict";
import { createServer } from "vite";
import * as THREE from "three";

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { launchSpeed } = await server.ssrLoadModule("/src/vitality.ts");
  const { Faora } = await server.ssrLoadModule("/src/faora.ts");
  assert.equal(launchSpeed(500, 45), 0);
  assert.ok(launchSpeed(500, 46) < 11, "barely exceeding resistance gives a small launch");
  assert.ok(launchSpeed(500, 100) > launchSpeed(500, 70), "more force gives more launch speed");
  assert.ok(launchSpeed(1040, 100) < 100, "a full-power hit stays below the old extreme launch speed");
  assert.equal(launchSpeed(500, NaN), 0);

  const spans = { floor: () => 0, ceil: () => Infinity, solid: () => false };
  const world = { spans: () => spans, materialAt: () => ({ bounce: 0 }) };
  for (const name of ["Faora-Ul", "Anissa"]) {
    const hit = (guard, strength) => {
      const fighter = new Faora(world, new THREE.Scene(), name);
      if (guard) { fighter.defense.begin("guard"); fighter.defense.update(guard / 50, false); }
      fighter.strike(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 500, true, strength);
      return fighter;
    };
    assert.equal(hit(100, 100).ragdoll.active, false, `${name}: full guard stops the hit`);
    assert.equal(hit(60, 100).ragdoll.active, false, `${name}: remaining force below resistance staggers`);
    const weak = hit(50, 100), strong = hit(0, 100);
    assert.equal(weak.ragdoll.active, true);
    assert.ok(weak.vel.x > 0 && weak.vel.x < strong.vel.x, `${name}: guard reduces launch`);
  }
  console.log("Launch: resistance, guard and punch strength scale both fighters' launch speeds.");
} finally { await server.close(); }
