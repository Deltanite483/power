import * as THREE from 'three';
import {DoomsdayAnimation} from '../src/doomsday-animation';
import {Faora} from '../src/faora';
import {DoomsdayPowers} from '../src/doomsday';
import {Vitality} from '../src/vitality';
import {Explosions,Dust,Shockwaves} from '../src/explosion-effects';
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#889495');scene.add(new THREE.HemisphereLight(0xe9efff,0x34362b,2.2));
const sun=new THREE.DirectionalLight(0xffead4,3);sun.position.set(-6,12,10);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);sun.shadow.normalBias=.025;scene.add(sun);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(300,300),new THREE.MeshLambertMaterial({color:0x434b45}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
const camera=new THREE.PerspectiveCamera(48,innerWidth/innerHeight,.1,1000);
const world={spans:()=>({top:0,floor:()=>0,ceil:()=>Infinity,solid:()=>false}),materialAt:()=>({bounce:0}),crater(){},launch(){}};
const doom=new Faora(world as never,scene,'Doomsday');doom.spawn(0,0);doom.model.rotation.y=-Math.PI/2;doom.model.updateMatrixWorld(true);doom.setEnemyMode(true);doom.model.traverse(part=>{if(part instanceof THREE.Mesh)part.castShadow=true;});
const target={pos:new THREE.Vector3(-30,0,0),vel:new THREE.Vector3(),speed:0,yaw:0,pitch:0,onGround:true,flying:false,inWater:false,eyeLevel:1.6,vitals:new Vitality()};
const powers=new DoomsdayPowers(scene),fire=new Explosions(),dust=new Dust(),waves=new Shockwaves();scene.add(fire.group,dust.points,waves.group);
const motion=new DoomsdayAnimation(doom.doomsdayRig!);
let time=0, shot='beam', shotTime=0;
const step=(dt:number)=>{
  time+=dt;
  powers.update(dt,doom,target,true);
  applyPose(dt);
  powers.syncPose(doom);
  fire.update(dt,camera);dust.update(time,camera,dt);waves.update(dt);
};
function applyPose(dt:number){
  doom.model.position.copy(doom.pos);
  const leap=shot==='leap', punch=shot==='punch';
  const phase=shotTime%2;
  motion.update(dt,{
    speed:shot==='sprint'?54:0,vertical:leap?20-40*phase:0,
    airborne:leap && phase>.25 && phase<1.30,
    crouch:leap && phase<.25 ? phase/.25 : 0,
    landing:leap && phase>=1.30 ? Math.max(0,1-(phase-1.30)/.42) : 0,
    guard:shot==='guard',flinch:0,
    windup:punch && phase<.8 ? phase/.8 : 0,
    strike:punch && phase>=.8 ? Math.max(0,.32-(phase-.8)) : 0,
    punch:'uppercut',special:doom.doomsdaySpecial,charge:doom.specialCharge,
    aim:doom.doomsdayAim,exhausted:doom.novaExhausted,
  });
}
powers.onNova=(point,radius)=>{const normal=new THREE.Vector3(0,1,0);fire.spawn(point,normal,22);dust.explosion(point,normal,20,[145,130,113]);waves.spawn(point.x,.15,point.z,radius/5.6);};
const pose=(kind:string)=>{
  shot=kind;shotTime=0;
  motion.reset();
  powers.reset();fire.update(20);waves.update(20);dust.update(time+20,camera);time+=20;
  doom.doomsdaySpecial=null;doom.novaExhausted=false;
  doom.model.rotation.y=-Math.PI/2;
  camera.position.set(-7,3.2,4.4);camera.lookAt(-.2,2.0,0);
  if(kind==='rear'){camera.position.set(6.5,3.7,-4);camera.lookAt(0,2,0);}
  if(kind==='beam'){for(let i=0;i<242;i++)step(1/60);}
  if(kind==='charge' || kind==='nova'){
    powers.absorb(450);
    for(let i=0;i<(kind==='charge'?430:463);i++)step(1/60);
  }
  if(kind==='nova'){camera.position.set(45,28,58);camera.lookAt(0,5,0);}
};
for(const button of document.querySelectorAll<HTMLButtonElement>('button[data-shot]')){
  button.onclick=()=>pose(button.dataset.shot!);
}
const query=new URLSearchParams(location.search);
pose(query.get('shot')??'beam');
let previous=performance.now();
renderer.setAnimationLoop(now=>{
  const dt=Math.min(.05,Math.max(0,(now-previous)/1000));previous=now;
  if(!['beam','charge','nova'].includes(shot)){
    shotTime+=dt;
    applyPose(dt);
  }
  renderer.render(scene,camera);
  document.getElementById('stats')!.textContent=`${renderer.info.render.calls} draw calls · ${shot.toUpperCase()}`;
});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
