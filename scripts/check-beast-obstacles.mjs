import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
  const {GroundPath}=await server.ssrLoadModule('/src/ground-pathing.ts');
  const {Heightfield,Mat}=await server.ssrLoadModule('/src/terrain/heightfield.ts');
  const {Destruction}=await server.ssrLoadModule('/src/destruction.ts');
  const {Faora}=await server.ssrLoadModule('/src/faora.ts');
  const wall=(x,z)=>x>=4 && x<=8 && Math.abs(z)<12;
  const terrain={spans:(x,z)=>({floor:()=>wall(x,z)?5:0,solid:y=>wall(x,z)&&y<5,ceil:()=>Infinity})};
  const path=new GroundPath(terrain,1.6),position=new THREE.Vector3();
  let routed=false;
  for(let i=0;i<180;i++){
    const goal=new THREE.Vector3(18,0,Math.sin(i*.16)*8);
    const next=path.update(1/60,position,goal);
    if(next.distanceToSquared(position)>.1){routed=true;break;}
  }
  assert.ok(routed,'moving targets do not continually restart and starve the route search');

  const meta={width:128,height:128,cell_m:10,min_m:500,step_m:.1,origin_x:-640,origin_z:-640};
  const grid=()=>({meta,data:new Uint16Array(16384)});
  const makeWorld=material=>{
    const hf=new Heightfield({inner:grid(),outer:grid(),water:new Uint8Array(16384),boxes:new Float32Array([3,500,-70,5,507,70,material])});
    const world=new Destruction(hf,{},new THREE.Scene());world.edits.healing=false;return world;
  };
  const world=makeWorld(Mat.Concrete);
  const originalGround=world.spans(4,0).base;
  assert.ok(world.spans(4,0).solid(502));
  assert.ok(world.breach(new THREE.Vector3(0,500,0),new THREE.Vector3(1,0,0),1.6),'close concrete can be breached');
  for(const x of [3.25,4,4.75])for(const z of [-.6,0,.6])for(const height of [.4,1.6,3.0])
    assert.ok(!world.spans(x,z).solid(500+height),'breach clears a body-sized passage');
  assert.ok(world.spans(4,0).floor(500.5)>=originalGround,'breach preserves the supporting floor');
  const bedrock=makeWorld(Mat.Bedrock);
  assert.equal(bedrock.breach(new THREE.Vector3(0,500,0),new THREE.Vector3(1,0,0),1.6),false);
  assert.equal(bedrock.edits.count,0,'bedrock is not demolished');

  // Real voxel collision and real destruction: a following Beast breaks through an impassable wall.
  const blocked=makeWorld(Mat.Concrete),beast=new Faora(blocked,new THREE.Scene(),'Battle Beast');
  beast.spawn(0,0);beast.leapCooldown=1e6;
  const player={pos:new THREE.Vector3(15,500,0),vel:new THREE.Vector3(),speed:0,yaw:0,pitch:0,onGround:true,flying:false,inWater:false,vitals:{defeated:false}};
  let swings=0,windup=false;
  beast.onObstacleSmash=direction=>{swings++;return blocked.breach(beast.pos,direction,beast.bodyScale);};
  for(let i=0;i<1200 && beast.pos.x<9;i++){
    beast.update(1/60,player);windup ||= beast.breachWindup>0;
  }
  assert.ok(windup && swings>0,'stalled Beast winds up and smashes the obstruction');
  assert.ok(beast.pos.x>9,'replans and walks through the opening instead of staying stuck');
  assert.ok(beast.pos.y>=499.5 && beast.pos.y<501,'smashing a route does not create a trapping crater');

  const detourWorld={spans:(x,z)=>({top:wall(x,z)?5:0,floor:()=>wall(x,z)?5:0,solid:y=>y<0 || (wall(x,z)&&y<5),ceil:()=>Infinity}),materialAt:()=>({name:'concrete',bounce:0}),crater(){},launch(){}};
  const runner=new Faora(detourWorld,new THREE.Scene(),'Battle Beast');runner.spawn(0,0);runner.leapCooldown=1e6;
  player.pos.set(18,0,0);
  for(let i=0;i<1800 && runner.pos.x<12;i++)runner.update(1/60,player);
  assert.ok(runner.pos.x>12 && !wall(runner.pos.x,runner.pos.z),'physical steering follows a detour around tight corners');
  console.log('Obstacles: moving-target searches, body clearance, floor-preserving concrete breach, bedrock protection, NPC demolition/replanning and corner steering passed.');
}finally{await server.close();}
