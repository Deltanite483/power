import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
  const {GroundPath}=await server.ssrLoadModule('/src/ground-pathing.ts');
  const wall=(x,z)=>x>=4&&x<=8&&Math.abs(z)<4;
  const world={spans:(x,z)=>({floor:()=>wall(x,z)?4:0,solid:y=>wall(x,z)&&y<4,ceil:()=>Infinity})};
  const path=new GroundPath(world),position=new THREE.Vector3(0,0,0),goal=new THREE.Vector3(16,30,0);
  let detoured=false;
  for(let i=0;i<500;i++) {
    const point=path.update(.05,position,goal),change=point.clone().sub(position).setY(0);
    if(change.length()>.001)position.add(change.clampLength(0,.35));
    assert.equal(wall(position.x,position.z),false,'does not cross wall');
    assert.equal(position.y,0,'never climbs toward airborne target');
    if(Math.abs(position.z)>4)detoured=true;
    if(Math.hypot(position.x-goal.x,position.z-goal.z)<2)break;
  }
  assert.ok(detoured,'walks around wall');
  assert.ok(position.distanceTo(new THREE.Vector3(16,0,0))<2,'reaches other side');
  const pursuit = new GroundPath(world), runner = new THREE.Vector3(12000, 30, 0);
  position.set(0, 0, 0);
  for (let i = 0; i < 500 && position.x < 12; i++) {
    runner.x += 50;
    const point = pursuit.update(.05, position, runner);
    position.add(point.clone().sub(position).setY(0).clampLength(0, .35));
    assert.equal(wall(position.x, position.z), false);
  }
  assert.ok(position.x >= 12, 'a fast distant target does not starve the wall detour search');
  const cliff=new GroundPath({spans:(x)=>({floor:()=>x>3?-20:0,solid:()=>false})});
  const next=cliff.update(.1,new THREE.Vector3(),new THREE.Vector3(10,0,0));
  assert.ok(next.x<=3,'does not route over a sheer drop');
  console.log('Ground pathing: wall detour, no flight, and cliff avoidance passed.');
} finally {await server.close();}
