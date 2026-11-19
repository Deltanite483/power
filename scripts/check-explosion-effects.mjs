import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try{
  const {Explosions,Dust,Shockwaves}=await server.ssrLoadModule('/src/explosion-effects.ts');
  const {PressureFronts,MachCollar,SonicFlyby,condensation}=await server.ssrLoadModule('/src/air-pressure.ts');
  const normal=new THREE.Vector3(0,1,0),fire=new Explosions();
  for(let i=0;i<200;i++)fire.spawn(new THREE.Vector3(i*5,0,0),normal,4);
  assert.equal(fire.group.children.length,1,'all fireballs use one instanced draw');
  const geometry=fire.group.children[0].geometry;
  assert.equal(geometry.instanceCount,60,'fireball slots never grow under sustained spawning');
  const version=geometry.getAttribute('aBurst').version;
  for(let i=0;i<30;i++)fire.update(1/60);
  assert.equal(geometry.getAttribute('aBurst').version,version,'fireball animation needs no per-frame attribute uploads');
  fire.update(1);assert.equal(fire.group.visible,false,'expired fireballs stop rendering');

  const waves=new Shockwaves(),shared=new Set(),exempt={};let sweeps=0;
  for(let i=0;i<100;i++)waves.spawn(i,0,0,4,normal,0,exempt,shared);
  assert.equal(waves.group.children.length,24,'visual wind fronts have a fixed mesh budget');
  assert.equal(new Set(waves.group.children.map(mesh=>mesh.geometry)).size,1,'pressure fronts share their geometry');
  waves.onSweep=(_p,_n,_old,_radius,_strength,hit)=>{sweeps++;assert.equal(hit,shared);assert(hit.has(exempt));};
  waves.update(1);
  assert.equal(sweeps,100,'visual limits never drop physical pressure-wave interactions');
  assert.equal(waves.pool.length,24);assert(waves.group.children.every(mesh=>!mesh.visible));
  waves.spawn(0,0,0,4,normal,1);waves.onSweep=()=>sweeps++;waves.update(.2);
  assert.equal(sweeps,100,'delayed pressure fronts preserve their timing');
  waves.update(2);assert.equal(sweeps,101);

  const pressure=new PressureFronts(), forward=new THREE.Vector3(1,0,0), origin=new THREE.Vector3();
  pressure.strike(origin,forward,68,2,10,340);
  pressure.update(.1);
  const strike=pressure.group.children.find(mesh=>mesh.visible);
  assert.equal(strike.position.x,34,'strike front travels in the attack direction');
  assert(strike.scale.x>2 && strike.scale.x<10,'strike front widens as it travels');
  pressure.impact(origin,normal,200,true);
  pressure.update(.525);
  const nova=pressure.group.children.find(mesh=>mesh.visible);
  assert(Math.abs(nova.scale.x-200*(.6+2.5)/5.6)<1e-8,'nova shell matches the physical pressure front');
  for(let i=0;i<60;i++)pressure.impact(origin,normal,25);
  assert.equal(pressure.group.children.length,16,'air shells reuse a fixed mesh pool');
  pressure.update(2);
  assert(pressure.group.children.every(mesh=>!mesh.visible),'expired shells stop drawing');

  const collar=new MachCollar();
  collar.update(origin,new THREE.Vector3(340,0,0),1,true,0,()=>.5);
  assert(collar.mesh.visible,'humid transonic air produces a visible collar');
  assert(condensation(1,1.2,.5)>condensation(1,1.2,0),'cloud density makes condensation stronger');
  collar.update(origin,new THREE.Vector3(550,0,0),1,true,0,()=>.5);
  assert(!collar.mesh.visible,'the collar dissipates beyond the transonic window');
  collar.update(origin,new THREE.Vector3(340,0,0),1,false,0,()=>.5);
  assert(!collar.mesh.visible,'grounded fighters have no vapor collar');

  const flyby=new SonicFlyby(), source=new THREE.Vector3(-1200,0,120);
  const velocity=new THREE.Vector3(600,0,0), arrivals=[];
  for(let frame=0;frame<210;frame++){
    const time=frame*.02;
    source.x=-1200+600*time;
    flyby.update(.02,source,velocity,time<2.1,origin,point=>arrivals.push({time,x:point.x}));
  }
  assert.equal(arrivals.length,1,'the flyby yields one boom even after the flyer slows down');
  assert(arrivals[0].time>2.1 && arrivals[0].time<3.5 && arrivals[0].x>-1100,
    'the boom arrives after the visible pass and before the original Mach crossing sound could travel that far');


  globalThis.innerHeight=900;globalThis.devicePixelRatio=1;
  const dust=new Dust(),camera=new THREE.PerspectiveCamera(65,1,.1,10000);camera.position.set(0,3,10);
  dust.update(0,camera);
  for(let i=0;i<100;i++)dust.explosion(new THREE.Vector3(0,0,0),normal,10,[130,110,90]);
  assert.equal(dust.emitted,180,'dust emission is capped across all impacts in a frame');
  assert.equal(dust.points.geometry.getAttribute('position').count,2400,'dust stays in its fixed pool');
  dust.update(.1,camera);
  const dustVersion=dust.points.geometry.getAttribute('aVel').version;dust.update(.2,camera);
  assert.equal(dust.points.geometry.getAttribute('aVel').version,dustVersion,'dust motion only updates shader time');
  dust.explosion(new THREE.Vector3(),normal,10,[130,110,90]);const near=dust.emitted;
  dust.update(.3,camera);dust.explosion(new THREE.Vector3(2400,0,0),normal,10,[130,110,90]);
  assert(dust.emitted<near,'distant blasts emit less dust');
  for(let i=0;i<120;i++)dust.update(i/20,camera,.05);
  assert(dust.quality<=.36,'sustained slow frames reduce dust density and screen coverage');
  assert(dust.uniforms.uPointLimit.value<105,'adaptive budget limits large transparent sprites');
  console.log('Explosion effects: one fireball draw, fixed pools, bounded emission/overdraw, GPU animation, distance/adaptive detail and preserved pressure physics passed.');
}finally{await server.close();}
