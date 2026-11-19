import * as THREE from "three";
import type { HitSource } from "./combat-events";
import { Shockwaves } from "./explosion-effects";

/** Kinetic energy shapes the release; saturation keeps extreme falls within a fixed budget. */
export function momentumPower(speed: number) {
  const s=Number.isFinite(speed)?Math.min(1e6,Math.max(0,speed)):0;
  const energy=(s/180)**2/(1+(s/180)**2);
  return { energy, range:8+180*Math.sqrt(energy), radius:2+20*Math.sqrt(energy), impulse:4+180*energy, strength:2+90*energy };
}
export interface MomentumWave {
  origin: THREE.Vector3; direction: THREE.Vector3; power: ReturnType<typeof momentumPower>;
  distance:number; hit:Set<object>; source?: HitSource;
}
/** A swept forward cone, so even a long frame cannot skip a target or hit someone behind the brake. */
export function momentumContact(wave: MomentumWave, position: THREE.Vector3, size: number, previous: number, next: number) {
  const x=position.x-wave.origin.x,y=position.y-wave.origin.y,z=position.z-wave.origin.z;
  const axial=x*wave.direction.x+y*wave.direction.y+z*wave.direction.z;
  if(axial<0 || axial>next+size || axial+size<previous || axial>wave.power.range+size)return 0;
  const radius=2+(wave.power.radius-2)*Math.min(1,axial/wave.power.range);
  const radial=Math.sqrt(Math.max(0,x*x+y*y+z*z-axial*axial));
  if(radial>radius+size)return 0;
  return (1-.65*Math.min(1,axial/wave.power.range))*(1-.5*Math.min(1,radial/(radius+size)));
}

/** Four pressure rings per release, using the existing fixed 24-mesh visual pool. */
export class MomentumWaves {
  readonly rings=new Shockwaves();
  readonly waves:MomentumWave[]=[];
  onSweep:(wave:MomentumWave,previous:number,next:number)=>void=()=>{};
  constructor(scene:THREE.Scene) { scene.add(this.rings.group); }
  spawn(origin:THREE.Vector3,velocity:THREE.Vector3,source?:HitSource,exempt:readonly object[]=[]) {
    const speed=velocity.length();if(speed<2 || !Number.isFinite(speed))return null;
    const wave:MomentumWave={origin:origin.clone(),direction:velocity.clone().divideScalar(speed),power:momentumPower(speed),distance:0,hit:new Set(exempt),source};
    if(this.waves.length>=8)this.waves.shift();
    this.waves.push(wave);
    for(let i=0;i<4;i++){
      const distance=wave.power.range*((source ? 0 : .08)+i*.25),at=origin.clone().addScaledVector(wave.direction,distance);
      const radius=2+(wave.power.radius-2)*distance/wave.power.range;
      this.rings.spawn(at.x,at.y,at.z,radius/5.6,wave.direction,distance/340);
    }
    return wave;
  }
  update(dt:number) {
    if(dt<=0)return;
    for(let i=this.waves.length-1;i>=0;i--){
      const wave=this.waves[i],previous=wave.distance;
      wave.distance=Math.min(wave.power.range,previous+340*dt);
      this.onSweep(wave,previous,wave.distance);
      if(wave.distance>=wave.power.range)this.waves.splice(i,1);
    }
    this.rings.update(dt);
  }
}
