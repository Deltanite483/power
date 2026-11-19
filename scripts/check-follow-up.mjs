import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { FollowUp, nearestEnemy, pursuitBlockReason } = await server.ssrLoadModule('/src/follow-up.ts');
  const { Pathfinder } = await server.ssrLoadModule('/src/pathing.ts');
  // Open sky over deep ground, plus optional solid walls (x0, x1, z0, z1, top).
  const walls = [];
  const world = { spans(x, z, out = { n: 0, lo: [], hi: [] }) {
    out.n = 1; out.lo[0] = -1e9; out.hi[0] = -100;
    for (const [x0, x1, z0, z1, top] of walls) if (x >= x0 && x < x1 && z >= z0 && z < z1) { out.lo[out.n] = -100; out.hi[out.n++] = top; }
    return out;
  } };
  const fighter = (x, hostile = true) => ({ pos: new THREE.Vector3(x, 0, 0), vel: new THREE.Vector3(), hostile, bodyScale: 1, lineClear: () => true, vitals: { defeated: false }, held: false, ragdoll: { active: false } });
  const target = fighter(70), closerFriend = fighter(1, false), defeated = fighter(2), held = fighter(3), nearest = fighter(-10);
  defeated.vitals.defeated = true; held.held = true;
  assert.equal(nearestEnemy([closerFriend, defeated, held, target, nearest], new THREE.Vector3()), nearest);
  assert.equal(nearestEnemy([closerFriend, defeated, held], new THREE.Vector3()), null);
  const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), vitals: { defeated: false, orientation: 100 }, flySpeed: 150, flying: false, setFlying(value) { this.flying = value; }, cancelMomentum() { const v=this.vel.clone();this.vel.set(0,0,0);return v; } };
  const follow = new FollowUp(new Pathfinder(world));
  const impacts=[];
  follow.onRam=(target,direction,speed)=>impacts.push({target,direction:direction.clone(),speed});
  for (const initialSpeed of [0, 250, 700]) {
    player.pos.set(0, 0, 0); player.vel.set(initialSpeed, 0, 0);
    target.pos.set(70, 0, 0); target.vel.set(15, 0, 0);
    assert.equal(follow.start(player, target), true);
    assert.equal(player.pos.x, 0, 'pursuit does not teleport');
    const before=impacts.length;
    for (let i = 0; i < 200 && follow.active; i++) {
      follow.update(.02, player);
      const previous=player.pos.clone();
      player.pos.addScaledVector(player.vel, .02);
      follow.sweep(player,previous);
      target.pos.addScaledVector(target.vel, .02);
    }
    assert.equal(impacts.length,before+1,'swept contact registers exactly one ram');
    const impact=impacts.at(-1);
    assert.equal(impact.target,target);
    assert(impact.direction.x>.95);
    assert(impact.speed+1e-6>=initialSpeed,'final approach retains inherited speed');
    assert.equal(follow.active,false,'impact ends guidance');
    assert(player.pos.x<target.pos.x && player.vel.x<0,'contact stops penetration and produces a small rebound');
    follow.sweep(player,new THREE.Vector3());
    assert.equal(impacts.length,before+1,'post-impact sweep cannot hit again');
  }
  target.pos.set(4,0,0);target.vel.set(0,0,0);
  player.pos.set(0,0,0);player.vel.set(200,0,0);
  follow.start(player,target);
  follow.update(.02,player);
  assert(player.vel.x>=200,'close approach does not brake');
  target.lineClear=()=>false;
  player.pos.set(5,0,0);
  follow.sweep(player,new THREE.Vector3());
  assert(follow.active,'a wall between the bodies blocks the ram');
  target.lineClear=()=>true;
  follow.cancel(); const velocity = player.vel.clone(); follow.update(.02, player);
  assert.ok(player.vel.equals(velocity), 'release stops assisted movement');
  // A wall between you and the target is flown around, never through.
  walls.push([30, 34, -40, 40, 1e9]);
  player.pos.set(0, 0, 0); player.vel.set(0, 0, 0); target.pos.set(70, 0, 0); target.vel.set(0, 0, 0);
  assert.equal(follow.start(player, target), true);
  let crossedWall = false;
  for (let i = 0; i < 600 && player.pos.distanceTo(target.pos) > 10; i++) {
    follow.update(.02, player);
    const next = player.pos.clone().addScaledVector(player.vel, .02);
    if (next.x >= 30 && next.x < 34 && Math.abs(next.z) < 40) crossedWall = true;
    player.pos.copy(next);
  }
  assert.equal(crossedWall, false, 'pursuit does not fly through walls');
  assert.ok(player.pos.distanceTo(target.pos) <= 10, `pursuit routes around the wall: ${player.pos.distanceTo(target.pos).toFixed(1)} m left`);
  walls.length = 0;
  player.vitals.orientation = 34; follow.cancel();
  assert.equal(follow.start(player, target), false, 'disorientation prevents pursuit');
  player.vitals.orientation = 100; assert.equal(follow.start(player, target), true);
  target.hostile = false; follow.update(.02, player);
  assert.equal(follow.active, false, 'a target that stops being hostile ends pursuit');
  target.hostile = true; assert.equal(follow.start(player, target), true);
  player.flying = false; follow.update(.02, player);
  assert.equal(follow.active, false, 'losing flight interrupts pursuit');
  player.vitals.orientation=34;
  assert.equal(pursuitBlockReason(player,target),'Dazed · Q to recover flight');
  player.vitals.orientation=100;
  assert.equal(pursuitBlockReason(player,target,false),'Waiting for punch / guard to finish');
  assert.equal(pursuitBlockReason(player,target,true),null,'temporary blockers clear without losing the target');
  let obstructed=true,plans=0;
  const retrying=new FollowUp({margin:0,segmentClear:()=>!obstructed,find:()=>{plans++;return [];}});
  player.vel.set(200,0,0);player.pos.set(0,0,0);target.pos.set(70,0,0);target.vel.set(0,0,0);
  assert(retrying.start(player,target));
  for(let i=0;i<120;i++)retrying.update(.02,player);
  assert(retrying.active && retrying.waitingForRoute,'blocked route retains pursuit instead of latching unavailable');
  assert.equal(player.vel.length(),0,'waits before the obstruction');
  assert(plans>=3 && plans<=7,'route retries have a bounded cadence');
  obstructed=false;
  for(let i=0;i<30;i++)retrying.update(.02,player);
  assert(retrying.active && !retrying.waitingForRoute && player.vel.length()>0,`chase resumes when the obstruction clears: active=${retrying.active} waiting=${retrying.waitingForRoute} speed=${player.vel.length()} plans=${plans}`);
  retrying.cancel();const stopped=player.vel.clone();retrying.update(.02,player);
  assert(player.vel.equals(stopped),'explicit release still cancels retrying');
  console.log('Pursuit: target selection, speed-preserving swept rams, obstruction checks, release and wall routing passed.');
} finally { await server.close(); }
