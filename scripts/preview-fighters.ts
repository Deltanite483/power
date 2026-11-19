import * as THREE from 'three';
import {Faora} from '../src/faora';
import {createFighterEnvironment,setFighterEnvironment} from '../src/fighter-mesh';
import type {FighterPoseInput} from '../src/fighter-animation';
import {FistView} from '../src/fist';
import {KickView} from '../src/kick';
import {CombatFx,beamMaterial} from '../src/combat-fx';
import {Shockwaves,Explosions} from '../src/explosion-effects';
import {EnergyLightning} from '../src/energy-lightning';
import {SukunaPowers} from '../src/sukuna';
import {Vitality} from '../src/vitality';

const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.85;document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#8fa3b3');
scene.add(new THREE.HemisphereLight(0xbfd8ff,0x5b5242,1.1));
const sun=new THREE.DirectionalLight(0xfff1dc,2.6);sun.position.set(-5,9,7);scene.add(sun);
const floor=new THREE.Mesh(new THREE.CircleGeometry(40,64),new THREE.MeshLambertMaterial({color:0x56624f}));floor.rotation.x=-Math.PI/2;scene.add(floor);
const grid=new THREE.GridHelper(40,40,0x33402f,0x4a5744);grid.position.y=.002;scene.add(grid);
setFighterEnvironment(createFighterEnvironment(renderer));
const camera=new THREE.PerspectiveCamera(36,innerWidth/innerHeight,.05,500);
scene.add(camera);
const fist=new FistView(camera), leftFist=new FistView(camera,-1), kick=new KickView(camera);
let firstPerson='';
const fx=new CombatFx(scene), waves=new Shockwaves(), fire=new Explosions(), bolts=new EnergyLightning(scene);scene.add(waves.group,fire.group);
const demoBeam=new THREE.Mesh(new THREE.CylinderGeometry(1,1,1,12,1,true),beamMaterial(0xffd28a,0xff4a12,true,.75)), demoCore=new THREE.Mesh(demoBeam.geometry,beamMaterial(0xffffff,0xffe6b0,true,1));
const heat=new THREE.Mesh(demoBeam.geometry,beamMaterial(0xff5a1c,0xe60d00,false,.85)), heatCore=new THREE.Mesh(demoBeam.geometry,beamMaterial(0xffffff,0xffb48a,true,1));
for(const m of [demoBeam,demoCore,heat,heatCore]){m.visible=false;m.rotation.x=Math.PI/2;scene.add(m);}
let effect='', effectClock=0;
const FORWARD=new THREE.Vector3(0,0,1), UPWARD=new THREE.Vector3(0,1,0), at=new THREE.Vector3();
function effects(dt:number){
  effectClock+=dt;const period=effect==='nova'?3:1.4, fired=effectClock<=dt*1.5||effectClock%period<(effectClock-dt)%period;
  for(const m of [demoBeam,demoCore,heat,heatCore])m.visible=false;
  at.set(0,1.3,.9);
  if(effect==='hit'&&fired){fx.hit(at,FORWARD,1);fx.bleed(at,FORWARD,1);waves.spawn(at.x,at.y,at.z,1.6,FORWARD);}
  if(effect==='ram'&&fired){fx.ram(at,FORWARD,220);waves.spawn(at.x,at.y,at.z,2.6,FORWARD);}
  if(effect==='blood'&&(effectClock<=dt*1.5||effectClock%.7<(effectClock-dt)%.7))fx.bleed(at,FORWARD,1);
  if(effect==='nova'&&fired){at.set(0,.5,0);fx.nova(at,40);fire.spawn(at,UPWARD,12,true);waves.spawn(0,.3,0,7,UPWARD,0,undefined,undefined,true);bolts.burst(at,40);}
  if(effect==='beam'||effect==='heat'){
    const big=effect==='beam', a=big?demoBeam:heat, b=big?demoCore:heatCore, length=14;
    for(const m of [a,b]){m.visible=true;m.position.set(big?0:.04,big?2.6:1.75,length/2);(m.material as THREE.ShaderMaterial).uniforms.uTime.value=effectClock;}
    a.scale.set(big?1.05:.1,length,big?1.05:.1);b.scale.set(big?.36:.042,length,big?.36:.042);
    at.set(0,big?2.6:1.75,length);fx.beamImpact(at,FORWARD,dt,big?2.4:.7,big);
    if(big){at.set(0,2.6,0);bolts.update(dt,at,.65,new THREE.Vector3(0,2.6,length));}
  }
  if(effect==='thunder'){at.set(0,2.2,0);bolts.update(dt,at,1,null);}
  else if(effect!=='beam')bolts.update(dt,at,0,null);
  fx.update(dt);waves.update(dt);fire.update(dt,camera);
}
const world={spans:()=>({top:0,floor:()=>0,ceil:()=>Infinity,solid:()=>false}),materialAt:()=>({bounce:0}),crater(){},launch(){}};
const NAMES:Record<string,string>={faora:'Faora-Ul',anissa:'Anissa',beast:'Battle Beast',doomsday:'Doomsday',sukuna:'Sukuna'};
const fighters:Record<string,Faora>={};
for(const [key,name] of Object.entries(NAMES)){const f=new Faora(world as never,scene,name);f.spawn(0,0);f.trails.mesh.visible=false;f.model.visible=false;fighters[key]=f;}
const query=new URLSearchParams(location.search);
let who=query.get('who')??'faora', shot=query.get('shot')??'idle', clock=0, orbit=Number(query.get('angle')??.6), tilt=.12, zoom=1, focus=1, frozen=query.has('t');
const pos=new THREE.Vector3(), vel=new THREE.Vector3(), look=new THREE.Vector3();
const base=():FighterPoseInput=>({position:pos,velocity:vel,height:0,airborne:false,engaged:false,guard:false,guardFlash:0,flinch:0,windup:0,strike:0,punch:'straight',ram:0,grapple:null,crouch:0,landing:0,rise:0,gesture:0,hurt:0,helping:false,held:false,look,lookWeight:0});
function drive(t:number):FighterPoseInput{
  const i=base(), flyer=who==='faora'||who==='anissa', beast=who==='beast';
  pos.set(0,0,0);vel.set(0,0,0);look.set(Math.sin(t*.7)*3,1.6,6);
  const air=()=>{pos.y=6;i.height=6;i.airborne=true;};
  const loop=(length:number)=>t%length;
  switch(shot){
    case 'idle':i.lookWeight=.75;break;
    case 'stance':i.engaged=true;i.lookWeight=1;break;
    case 'walk':vel.z=beast?4:1.6;break;
    case 'run':vel.z=beast?26:8;break;
    case 'sprint':vel.z=beast?58:14;i.engaged=true;break;
    case 'hover':air();i.lookWeight=.5;break;
    case 'airfight':air();i.engaged=true;i.lookWeight=1;break;
    case 'cruise':air();vel.z=60;break;
    case 'fast':air();vel.z=300;break;
    case 'climb':air();vel.set(0,80,40);break;
    case 'dive':air();vel.set(0,-90,30);break;
    case 'bank':air();{const a=t*.9;vel.set(Math.cos(a)*120,0,-Math.sin(a)*120);fighter().model.rotation.y=Math.atan2(vel.x,vel.z);}break;
    case 'brake':air();vel.z=loop(3)<1.5?140:4;break;
    case 'guard':i.engaged=true;i.guard=true;i.guardFlash=Math.max(0,1-loop(1.2)*4);break;
    case 'airguard':air();i.engaged=true;i.guard=true;break;
    case 'straight':case 'uppercut':case 'down':{
      i.engaged=true;i.lookWeight=1;i.punch=shot;const p=loop(1.9);if(shot==='down'&&flyer)air();
      if(p<.9)i.windup=Math.min(1,p/.8);else if(p<1.22)i.strike=.32-(p-.9);break;}
    case 'flinch':i.engaged=true;i.flinch=Math.max(0,1-loop(1.1)/.35);break;
    case 'ram':air();vel.z=200;i.engaged=true;i.ram=loop(2)<1.3?1:loop(2)<1.62?2:0;break;
    case 'grapple':{i.engaged=true;const p=loop(3.2);i.grapple=p<1?'hold':p<1.28?'punch':p<2?'hold':p<2.28?'kick':p<2.8?'hold':p<3.08?'throw':null;break;}
    case 'leap':{const p=loop(2.4);if(p<.4)i.crouch=p/.4;else if(p<1.6){i.airborne=true;const q=(p-.4)/1.2;pos.y=18*q*(1-q)*4/4*4;i.height=pos.y;vel.set(0,(1-2*q)*30,14);}else i.landing=Math.max(0,1-(p-1.6)/.42);break;}
    case 'gesture':i.gesture=loop(2.4)<1.3?1:0;i.lookWeight=.75;break;
    case 'hurt':i.hurt=1;break;
    case 'help':i.helping=true;break;
    case 'held':i.held=true;pos.y=1.5;break;
    case 'rise':i.rise=Math.max(0,1-loop(2)/.55);break;
    case 'dismantle':case 'cleave':case 'shrine':case 'fuga':case 'rct':case 'world':case 'blackflash':{const f=fighter();i.engaged=true;i.lookWeight=1;look.copy(dummy.pos).y+=1.4;i.cast=f.castPose;i.castSwing=f.castSwing;i.windup=f.castPose?0:f.specialCharge;i.strike=(f as any).strikePose??0;break;}
  }
  return i;
}
const fighter=()=>fighters[who];
// Sukuna's techniques run for real against a standing dummy, so the preview shows exactly what the game does.
const TECHNIQUES:Record<string,number>={dismantle:16,cleave:3,blackflash:3,fuga:24,world:110,shrine:20,rct:16};
const powers=new SukunaPowers(scene);
const dummy={pos:new THREE.Vector3(0,0,16),vel:new THREE.Vector3(),speed:0,yaw:0,pitch:0,onGround:true,flying:false,inWater:false,eyeLevel:1.6,vitals:new Vitality()};
const dummyBody=new THREE.Mesh(new THREE.CapsuleGeometry(.32,1.15,6,12),new THREE.MeshStandardMaterial({color:0x8d99a6,roughness:.8}));dummyBody.visible=false;scene.add(dummyBody);
powers.onHit=(technique,target,direction)=>{at.copy(target.pos).y+=1.1;fx.hit(at,direction,technique==='cleave'||technique==='dismantle'?.35:1);if(technique!=='shrine')fx.bleed(at,direction,.6);};
powers.onFuga=point=>{fx.nova(point,13);fire.spawn(point,UPWARD,5,true);waves.spawn(point.x,point.y,point.z,3,UPWARD);};
fighters.sukuna.setEnemyMode(true);
function technique(dt:number){
  const f=fighters.sukuna, range=who==='sukuna'?TECHNIQUES[shot]:undefined, p=powers as any;
  dummyBody.visible=range!==undefined;
  if(range===undefined){powers.update(dt,f,dummy as never,[],false);return;}
  dummy.pos.set(0,0,range);dummyBody.position.set(0,.9,range);dummy.vitals.health=100;f.vitals.health=shot==='rct'?30:100;
  if(shot==='shrine'&&!p.shrineActive)p.domainCharge=500;
  if(shot==='fuga')p.fugaCharge=1000;
  if(shot==='blackflash'&&!p.technique)p.meleeCasts=5;
  if(shot==='rct'&&!p.technique)p.recoveryCooldown=Math.min(p.recoveryCooldown,1.2);
  if(shot==='world')p.worldCooldown=Math.min(p.worldCooldown,1.5);
  f.pos.set(0,0,0);
  powers.update(dt,f,dummy as never,[dummy as never],true);
  (f as any).strikePose=Math.max(0,(f as any).strikePose-dt);
}
function select(){for(const [key,f] of Object.entries(fighters))f.model.visible=key===who;clock=0;fighter().model.rotation.set(0,0,0);(fighter() as any).motion?.reset();(fighter() as any).doomsdayAnimation?.reset();}
function doom(t:number,dt:number){
  const f=fighter() as any, i=drive(t);f.model.position.copy(pos);
  f.doomsdayAnimation.update(dt,{speed:Math.hypot(vel.x,vel.z),vertical:vel.y,airborne:i.airborne,crouch:i.crouch,landing:i.landing,guard:i.guard,flinch:i.flinch,windup:i.windup,strike:i.strike,punch:i.punch,special:null,charge:0,aim:new THREE.Vector3(0,0,1),exhausted:shot==='hurt',engaged:i.engaged,look:i.lookWeight>0?look:null,held:i.held});
}
function limbs(dt:number){
  // First-person limbs: charge for a second, strike, recover, repeat.
  const p=clock%2.2, charging=p<1.2;
  if(firstPerson==='fist'){if(!charging&&p-dt<1.2)fist.strike(1);fist.update(dt,charging?Math.min(1,p):-1);leftFist.update(dt,p>1.5&&p<2?.7:-1);kick.update(dt,-1);}
  else if(firstPerson==='kick'){if(!charging&&p-dt<1.2)kick.strike(1);kick.update(dt,charging?Math.min(1,p):-1);fist.update(dt,-1);leftFist.update(dt,-1);}
  else{fist.update(dt,-1);leftFist.update(dt,-1);kick.update(dt,-1);}
}
function step(dt:number){
  clock+=dt;limbs(dt);effects(dt);technique(dt);
  if(who==='doomsday')doom(clock,dt);else (fighter() as any).motion.update(dt,drive(clock));
}
for(const button of document.querySelectorAll<HTMLButtonElement>('button[data-who]'))button.onclick=()=>{who=button.dataset.who!;select();mark();};
for(const button of document.querySelectorAll<HTMLButtonElement>('button[data-fx]'))button.onclick=()=>{effect=effect===button.dataset.fx?'':button.dataset.fx!;effectClock=0;};
(window as any).fxShot=(kind:string,t:number,a=1.2,z=1,ti=.15)=>{effect=kind;effectClock=0;orbit=a;zoom=z;tilt=ti;frozen=true;for(let k=0;k<Math.round(t*60);k++)step(1/60);};
for(const button of document.querySelectorAll<HTMLButtonElement>('button[data-limb]'))button.onclick=()=>{firstPerson=firstPerson===button.dataset.limb?'':button.dataset.limb!;clock=0;};
(window as any).limb=(kind:string,t:number)=>{firstPerson=kind;clock=0;frozen=true;for(let k=0;k<Math.round(t*60);k++)step(1/60);};
for(const button of document.querySelectorAll<HTMLButtonElement>('button[data-shot]'))button.onclick=()=>{shot=button.dataset.shot!;select();mark();};
function mark(){for(const b of document.querySelectorAll<HTMLButtonElement>('button'))b.classList.toggle('on',b.dataset.who===who||b.dataset.shot===shot);}
let dragging=false;
renderer.domElement.addEventListener('pointerdown',()=>dragging=true);addEventListener('pointerup',()=>dragging=false);
addEventListener('pointermove',e=>{if(dragging){orbit-=e.movementX*.008;tilt=THREE.MathUtils.clamp(tilt+e.movementY*.005,-.4,1.2);}});
addEventListener('wheel',e=>{zoom=THREE.MathUtils.clamp(zoom*Math.exp(e.deltaY*.001),.2,4);});
if(query.has('zoom'))zoom=Number(query.get('zoom'));if(query.has('tilt'))tilt=Number(query.get('tilt'));
(window as any).fighters=fighters;(window as any).powers=powers;(window as any).THREE=THREE;
select();mark();
if(frozen){const until=Number(query.get('t'));for(let k=0;k<Math.round(until*60);k++)step(1/60);}
let previous=performance.now();
const center=new THREE.Vector3();
const frameOffset=new THREE.Vector3();(window as any).frameOffset=frameOffset;
(window as any).advance=(seconds:number)=>{for(let k=0;k<Math.round(seconds*60);k++)step(1/60);};
(window as any).view=(w:string,s:string,t:number,a=.6,z=1,ti=.12,fy=1)=>{who=w;shot=s;orbit=a;zoom=z;tilt=ti;focus=fy;frozen=true;select();mark();for(let k=0;k<Math.round(t*60);k++)step(1/60);};
renderer.setAnimationLoop(now=>{
  const dt=Math.min(.05,Math.max(0,(now-previous)/1000));previous=now;
  if(renderer.domElement.clientWidth!==innerWidth||renderer.domElement.clientHeight!==innerHeight){camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);}
  if(!frozen)step(dt);
  const f=fighter(), scale=f.bodyScale, distance=7.5*scale*zoom;
  center.copy(pos).add(frameOffset).y+=focus*scale;
  camera.position.set(center.x+Math.sin(orbit)*Math.cos(tilt)*distance,center.y+Math.sin(tilt)*distance,center.z+Math.cos(orbit)*Math.cos(tilt)*distance);
  camera.lookAt(center);
  renderer.render(scene,camera);
  document.getElementById('stats')!.textContent=`${renderer.info.render.calls} draw calls · ${renderer.info.render.triangles.toLocaleString()} triangles`;
});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
