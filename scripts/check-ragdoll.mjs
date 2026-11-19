import assert from "node:assert/strict";
import * as THREE from "three";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { Ragdoll } = await server.ssrLoadModule("/src/ragdoll.ts");
  const spans = { floor: () => 0, ceil: () => Infinity };
  const world = { spans: () => spans };
  const model = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(.4, .6, .2), new THREE.MeshBasicMaterial());
  body.position.y = 1.2; model.add(body);
  const left = new THREE.Group(); left.position.set(-.31, 1.4, 0); model.add(left);
  model.position.set(4, 20, 8); model.rotation.set(.6, 1.1, 0); model.updateMatrixWorld(true);
  const expectedHead = new THREE.Vector3(0, 1.75, 0).applyMatrix4(model.matrixWorld);
  const ragdoll = new Ragdoll(model, world);
  const feet = model.position.clone(), velocity = new THREE.Vector3(50, 20, -10);
  ragdoll.start(velocity);
  assert.ok(ragdoll.joints[2].distanceTo(expectedHead) < 1e-6, "initial joints follow the visible flight pose");
  ragdoll.update(.016, feet, velocity);
  for (const p of ragdoll.joints) assert.ok(Number.isFinite(p.x + p.y + p.z) && p.y >= 0, "joints remain finite and above terrain");
  const relativeBefore = ragdoll.velocity[4].clone().sub(ragdoll.velocity[0]);
  ragdoll.start(new THREE.Vector3(70, 15, 0));
  assert.ok(ragdoll.velocity[4].clone().sub(ragdoll.velocity[0]).distanceTo(relativeBefore) < 1e-6, "repeat hits preserve limb motion");
  ragdoll.anchor = ragdoll.joints[1].clone().add(new THREE.Vector3(0, 1, 0));
  ragdoll.grabJoint = 1; ragdoll.update(.016, feet, velocity);
  assert.ok(Number.isFinite(feet.x + feet.y + feet.z), "held ragdoll remains stable");
  ragdoll.stop(); ragdoll.recover(.45);
  assert.equal(ragdoll.active, false);
  for (const binding of ragdoll.bindings) {
    assert.ok(binding.group.position.distanceTo(binding.pivot) < 1e-6, "recovery returns the animated pivot");
    assert.ok(binding.group.quaternion.angleTo(new THREE.Quaternion()) < 1e-6, "recovery returns the animated rotation");
  }
  const { Faora } = await server.ssrLoadModule("/src/faora.ts");
  for (const name of ["Faora-Ul", "Anissa", "Battle Beast"]) {
    const fighter = new Faora(world, new THREE.Scene(), name);
    fighter.model.position.set(0, 6, 0);
    const rag = fighter.ragdoll;
    const feet = fighter.model.position.clone(), velocity = new THREE.Vector3(90, 15, 35);
    rag.start(velocity);
    const core = [0,1,3,6,13,14];
    const lengths = core.flatMap((a,i) => core.slice(i+1).map(b => [a,b,rag.joints[a].distanceTo(rag.joints[b])]));
    for (let frame=0;frame<360;frame++) {
      rag.update(1/60, feet, velocity);
      for (const [a,b,length] of lengths)
        assert.ok(Math.abs(rag.joints[a].distanceTo(rag.joints[b])-length)<.035*fighter.bodyScale, `${name}: torso keeps its shape during flight and landing`);
      for (const link of rag.links) {
        const distance=rag.joints[link.a].distanceTo(rag.joints[link.b]);
        assert.ok(distance>=link.min-.05*fighter.bodyScale && distance<=link.max+.05*fighter.bodyScale, `${name}: anatomical joint limits hold`);
      }
      for (const joint of rag.joints) assert.ok(Number.isFinite(joint.lengthSq()) && joint.y >= 0, `${name}: stable collision`);
    }
    fighter.model.updateMatrixWorld(true);
    for (const arm of rag.arms) {
      const elbow = arm.forearm.getWorldPosition(new THREE.Vector3());
      assert.ok(elbow.distanceTo(rag.joints[arm.elbow]) < .04*fighter.bodyScale, `${name}: visible elbow follows physics`);
    }
    for (const binding of rag.bindings.filter(b => b.from===13 || b.from===14)) {
      const hip = binding.group.getWorldPosition(new THREE.Vector3());
      assert.ok(hip.distanceTo(rag.joints[binding.from]) < 1e-5, `${name}: legs stay attached at hips`);
    }
    assert.ok(velocity.length()<1, `${name}: landed body settles instead of shaking`);
    rag.anchor=rag.joints[1].clone().add(new THREE.Vector3(0,3,0));
    for (let i=0;i<120;i++) rag.update(1/60, feet, velocity);
    assert.ok(rag.joints[1].distanceTo(rag.anchor)<.5*fighter.bodyScale, `${name}: held torso follows grip`);
    rag.stop();rag.recover(.45);
  }
  const direction = new THREE.Vector3(1, 0, 0), inherited = new THREE.Vector3();
  for (const [name, duration] of [["Faora-Ul", 4], ["Sukuna", 2], ["Doomsday", .9]]) {
    const fighter = new Faora(world, new THREE.Scene(), name);
    fighter.setEnemyMode(true);
    fighter.strike(direction, inherited, 300, false, 170);
    assert(fighter.ragdoll.active);
    assert.equal(fighter.ragdollTime, duration, "the first knockdown starts the full timer");
    fighter.strike(direction, inherited, 0, false, 10);
    assert.equal(fighter.ragdollTime, duration / 2, "a light hit halves the timer");
    fighter.strike(direction, inherited, 300, false, 170);
    assert.equal(fighter.ragdollTime, duration / 4, "getting relaunched halves the timer again");
    const domain = {};
    fighter.vitals.freeze(domain);
    fighter.strike(direction, inherited, 300, false, 170);
    assert.equal(fighter.ragdollTime, duration / 4, "a blocked hit leaves the timer alone");
    fighter.vitals.drainWhileFrozen(domain, .5);
    assert.equal(fighter.ragdollTime, duration / 8, "domain damage also halves the timer");
  }
  console.log("Ragdoll: rigid torso, joint limits, hip/elbow alignment, landing stability, grabbing and recovery passed for all three fighters.");
} finally { await server.close(); }
