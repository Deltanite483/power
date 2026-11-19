import * as THREE from 'three';
import { MachCollar, PressureFronts } from '../src/air-pressure';
import {Explosions,Dust,Shockwaves} from '../src/explosion-effects';
const renderer=new THREE.WebGLRenderer({antialias:true,logarithmicDepthBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));renderer.setSize(innerWidth,innerHeight);
renderer.toneMapping=THREE.ACESFilmicToneMapping;document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#bbcbd4');
scene.add(new THREE.HemisphereLight(0xd9eaff,0x534a38,2));
const sun=new THREE.DirectionalLight(0xffe8cf,2.5);sun.position.set(-8,20,8);scene.add(sun);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(180,180),new THREE.MeshLambertMaterial({color:0x79705a}));floor.rotation.x=-Math.PI/2;scene.add(floor);
const grid=new THREE.GridHelper(160,32,0x8d8879,0x8d8879);grid.position.y=.01;scene.add(grid);
const camera=new THREE.PerspectiveCamera(57,innerWidth/innerHeight,.1,1000);camera.position.set(24,15,31);camera.lookAt(0,3,0);
const fire=new Explosions(),dust=new Dust(),waves=new Shockwaves();scene.add(fire.group,dust.points,waves.group);
const pressure=new PressureFronts(), collar=new MachCollar();
scene.add(pressure.group,collar.mesh);
const flyer=new THREE.Mesh(new THREE.CapsuleGeometry(.42,1.65,6,14),new THREE.MeshStandardMaterial({color:0x3b485e}));
flyer.visible=false;
flyer.rotation.z=-Math.PI/2;
scene.add(flyer);
let time=0,paused=false,last=performance.now();
const normal=new THREE.Vector3(0,1,0);
function resetView(){
  camera.position.set(24,15,31);camera.lookAt(0,3,0);
  collar.mesh.visible=flyer.visible=false;
}
const emit=(p:THREE.Vector3,r=4)=>{fire.spawn(p,normal,r);dust.explosion(p,normal,r,[135,118,94]);waves.spawn(p.x,.15,p.z,r*1.5);};
const step=(dt:number,frameDt=1/60)=>{time+=dt;fire.update(dt,camera);dust.update(time,camera,frameDt);waves.update(dt);pressure.update(dt);};
document.getElementById('blast')!.onclick=()=>{resetView();paused=false;emit(new THREE.Vector3());};
document.getElementById('stress')!.onclick=()=>{resetView();paused=false;for(let i=0;i<40;i++)emit(new THREE.Vector3((i%8-3.5)*4,0,(Math.floor(i/8)-2)*5),3);};
document.getElementById('freeze')!.onclick=()=>{resetView();step(10);emit(new THREE.Vector3());step(.35);paused=true;};
const shots: Record<string,(freeze:boolean)=>void> = {
  strike:freeze=>{
    pressure.strike(new THREE.Vector3(-23,3,0),new THREE.Vector3(1,0,0),44,2.5,8,100);
    for (const x of [-22,-18,-13,-8])dust.burst(x,.1,0,new THREE.Vector3(1,.3,0),28,12,4,[161,143,116],1.4);
    if(freeze)step(.22);
  },
  landing:freeze=>{
    pressure.impact(new THREE.Vector3(0,.14,0),normal,22);
    dust.burst(0,.1,0,normal,75,18,7,[161,143,116],1.4,1);
    if(freeze)step(.33);
  },
  nova:freeze=>{
    pressure.impact(new THREE.Vector3(0,.2,0),normal,44,true);
    fire.spawn(new THREE.Vector3(0,1,0),normal,7,true);
    dust.explosion(new THREE.Vector3(),normal,8,[171,140,115]);
    if(freeze)step(.52);
  },
  mach:()=>{
    const position=new THREE.Vector3(0,5,0);
    collar.update(position,new THREE.Vector3(340,0,0),1,true,time,()=>.5);
    flyer.position.copy(collar.mesh.position);
    flyer.visible=true;
    camera.position.set(7,7,11);camera.lookAt(-1.3,5.8,0);
  },
};
function showShot(name:string,freeze=false){
  step(10);
  resetView();
  shots[name]?.(freeze);
  paused=freeze || name==='mach';
}
for(const button of document.querySelectorAll<HTMLButtonElement>('button[data-shot]')){
  button.onclick=()=>showShot(button.dataset.shot!);
}
const shot=new URLSearchParams(location.search).get('shot');
if(shot && shots[shot])showShot(shot,true);

step(0);
renderer.setAnimationLoop(()=>{
  const now=performance.now(),dt=Math.min(.05,(now-last)/1000);last=now;if(!paused)step(dt,dt);
  renderer.render(scene,camera);
  document.getElementById('stats')!.textContent=`${renderer.info.render.calls} draw calls · 60 fire lobes max · 16 air shells max · 2,400 dust slots`;
});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
