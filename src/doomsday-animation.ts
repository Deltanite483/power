import * as THREE from 'three';
import type { PunchStyle } from './faora';
import type { DoomsdayRig } from './doomsday-rig';

interface PoseInput {
  speed: number;
  vertical: number;
  airborne: boolean;
  crouch: number;
  landing: number;
  guard: boolean;
  flinch: number;
  windup: number;
  strike: number;
  punch: PunchStyle;
  special: 'beam-charge' | 'beam' | 'nova-charge' | 'recovery' | null;
  charge: number;
  aim: THREE.Vector3;
  exhausted: boolean;
  /** A world point to watch while not firing, if any. */
  look?: THREE.Vector3 | null;
  engaged?: boolean;
  held?: boolean;
}

const {lerp,smoothstep,clamp} = THREE.MathUtils;

export class DoomsdayAnimation {
  private phase = 0;
  private time = 0;
  private gait = 0;
  private aim = new THREE.Vector3();
  private hipDrop = 0;
  private wasChargingNova = false;
  private novaRecoil = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private shift = 0;
  private readonly gaze = new THREE.Vector3();

  constructor(private rig: DoomsdayRig) {}

  reset() {
    this.phase = this.time = this.gait = this.hipDrop = 0;
    this.wasChargingNova = false;
    this.novaRecoil = 0;
    this.lookYaw = this.lookPitch = this.shift = 0;
    this.rig.reset();
  }

  contact(style: PunchStyle) {
    const {arms,forearms,hands,torso} = this.rig;
    arms[1].rotation.set(style==='uppercut' ? -1.98 : style==='down' ? -.88 : -1.57,-.14,-.12);
    forearms[1].rotation.x = style==='uppercut' ? -.63 : -.10;
    hands[1].rotation.x = style==='down' ? .28 : 0;
    torso.rotation.y = -.25;
  }

  update(dt: number, input: PoseInput): boolean {
    const {root,torso,head,jaw,arms,forearms,hands,legs,shins,feet} = this.rig;
    const {speed,airborne,crouch,landing,guard,flinch,windup,strike,punch,special,charge,exhausted} = input;
    this.time += dt;
    const blend = 1-Math.exp(-dt*11);
    const quick = 1-Math.exp(-dt*20);
    const run = smoothstep(speed,12,55);
    const beam = special==='beam' || special==='beam-charge';
    const chargingNova = special==='nova-charge';
    const nova = chargingNova ? smoothstep(charge,0,1) : 0;
    if(this.wasChargingNova && !chargingNova && exhausted)this.novaRecoil=1;
    this.wasChargingNova=chargingNova;
    const release=this.novaRecoil*this.novaRecoil;
    this.novaRecoil=Math.max(0,this.novaRecoil-dt/.52);
    const stride = airborne || crouch>0 || landing>.55 || guard || nova>0 || special==='recovery' ? 0 : smoothstep(speed,.4,9);
    this.gait = lerp(this.gait,stride,blend);
    const previousStep = Math.floor(this.phase*2);
    if(stride>0)this.phase = (this.phase+dt*lerp(.9,3.5,smoothstep(speed,0,115)))%1;
    const footfall = stride>.8 && previousStep!==Math.floor(this.phase*2);
    const rhythm = Math.cos(this.phase*Math.PI*2)*this.gait;
    const breath = Math.sin(this.time*(exhausted?6:3.1));
    const impact = smoothstep(landing,0,1);
    const compression = Math.max(crouch*.22,impact*.25,nova*.18,guard?.105:0,exhausted?.12:0);
    this.hipDrop = lerp(this.hipDrop,airborne?0:compression+this.gait*(.033+.033*Math.abs(rhythm)),quick);
    root.position.y -= this.hipDrop*root.scale.y;
    root.rotation.x = lerp(root.rotation.x,0,quick);
    root.rotation.z = lerp(root.rotation.z,0,quick);

    // Standing still he never quite settles: weight rolls from foot to foot and the shoulders heave.
    const idle = (1-this.gait)*(airborne?0:1);
    this.shift = Math.sin(this.time*.9)*idle;
    let lean = .06+this.gait*lerp(.085,.34,run)+compression*.95+breath*(.019+idle*.016)-flinch*.36;
    let twist = rhythm*.14+this.shift*.05, roll = rhythm*.048+this.shift*.035;
    let jawOpen = .09+breath*.04+run*this.gait*.1+flinch*.42;
    if(airborne)lean = .19+smoothstep(input.vertical,-25,25)*.29;
    if(beam){
      lean = special==='beam' ? -.08+.035*Math.sin(this.time*40) : .12-charge*.24;
      twist = 0;
      jawOpen = special==='beam' ? .78 : .16+charge*.53;
    } else if(nova>0){
      lean = .23+nova*.2+Math.sin(this.time*34)*nova*.023;
      roll = 0;
      jawOpen = .18+nova*.52;
    } else if(special==='recovery'){
      lean = .17;
      jawOpen = .24;
    } else if(exhausted){
      lean += .21-release*.55;
      jawOpen = lerp(.25+breath*.13,.83,release);
    } else if(strike>0){
      const recoil = smoothstep(strike,0,.25);
      lean += (punch==='down'?.40:punch==='uppercut'?-.21:.19)*recoil;
      twist -= .30*recoil;
      jawOpen += recoil*.31;
    } else if(windup>0){
      lean += windup*.11;
      twist += windup*.27;
    }
    torso.rotation.x = lerp(torso.rotation.x,clamp(lean,-.32,.34),quick);
    torso.rotation.y = lerp(torso.rotation.y,twist,quick);
    torso.rotation.z = lerp(torso.rotation.z,roll,blend);
    if(beam){
      this.aim.copy(input.aim).applyAxisAngle(THREE.Object3D.DEFAULT_UP,-root.rotation.y);
      head.rotation.y = lerp(head.rotation.y,clamp(Math.atan2(this.aim.x,this.aim.z),-1.2,1.2),quick);
      head.rotation.x = lerp(head.rotation.x,clamp(-Math.atan2(this.aim.y,Math.hypot(this.aim.x,this.aim.z)),-1.1,1.1),quick);
    }else{
      // He keeps his eyes locked on whoever he is hunting.
      let yaw = 0, pitch = 0;
      if(input.look && flinch<.12 && nova<=0 && !exhausted){
        root.updateMatrixWorld();
        head.parent!.worldToLocal(this.gaze.copy(input.look)).sub(head.position);
        const bearing = Math.atan2(this.gaze.x,this.gaze.z);
        if(Math.abs(bearing)<2.2){
          yaw = clamp(bearing-twist,-1,1);
          pitch = clamp(-Math.atan2(this.gaze.y,Math.hypot(this.gaze.x,this.gaze.z))-lean,-.7,.6);
        }
      }
      this.lookYaw = lerp(this.lookYaw,yaw,1-Math.exp(-dt*7));
      this.lookPitch = lerp(this.lookPitch,pitch,1-Math.exp(-dt*7));
      head.rotation.y = lerp(head.rotation.y,-twist*.45+this.lookYaw*.85,blend);
      head.rotation.x = lerp(head.rotation.x,nova*.26+(exhausted?.11:0)-impact*.15+flinch*-.29-lean*.20+this.lookPitch*.8,quick);
      head.rotation.z = lerp(head.rotation.z,this.shift*.04+this.lookYaw*.12,blend);
    }
    jaw.rotation.x = lerp(jaw.rotation.x,jawOpen,quick);

    for(const side of [0,1] as const){
      const sign = side===0?-1:1;
      const cycle = (this.phase+side*.5)%1;
      const stance = lerp(.65,.52,run);
      const swing = smoothstep(cycle,stance,1);
      const sweep = cycle<stance ? 1-2*cycle/stance : 2*swing-1;
      const lift = Math.sin(Math.PI*swing)*this.gait*lerp(.12,.285,run);
      let reach = sweep*this.gait*lerp(.18,.44,run)+sign*.045;
      let height = lift;
      let footPitch = cycle<stance ? 0 : Math.sin(swing*Math.PI*2)*.22;
      if(airborne){
        const tuck = smoothstep(input.vertical,-26,7);
        reach = sign*lerp(.06,.16,tuck)+tuck*.13;
        height = .035+tuck*(side===0?.38:.29);
        footPitch = tuck*.28;
      }
      const upper = -shins[side].position.y, lower = -feet[side].position.y;
      const down = upper+lower-.005-this.hipDrop-height;
      const distance = clamp(Math.hypot(reach,down),Math.abs(upper-lower)+.002,upper+lower-.001);
      const knee = Math.acos(clamp((distance*distance-upper*upper-lower*lower)/(2*upper*lower),-1,1));
      const hip = -Math.atan2(reach,down)-Math.atan2(lower*Math.sin(knee),upper+lower*Math.cos(knee));
      legs[side].rotation.x = lerp(legs[side].rotation.x,hip,quick);
      shins[side].rotation.x = lerp(shins[side].rotation.x,knee,quick);
      feet[side].rotation.x = footPitch-legs[side].rotation.x-shins[side].rotation.x;

      const ready = input.engaged ? idle : 0; // squared up to a foe: claws forward, elbows cocked
      let shoulder = -.12+sign*rhythm*lerp(.28,.69,run)+lean*.45-ready*(side===0?.5:.22);
      let spread = sign*(.14+ready*.16+breath*.012*idle);
      let elbow = -.26-this.gait*.29-ready*(side===0?.62:.85);
      let wrist = .07+Math.sin(this.time*1.7+side*2.1)*.09*idle;
      if(flinch>.12){
        shoulder = -.3+flinch*.64; spread = sign*(.24+.56*flinch); elbow = -.38;
      }else if(guard){
        shoulder = -.94; spread = -sign*.32; elbow = -1.58; wrist = -.20;
      }else if(beam){
        shoulder = -.24+.22*charge; spread = sign*(.27+.14*charge); elbow = -.38-charge*.37;
      }else if(chargingNova){
        shoulder = -.78+.55*nova; spread = sign*lerp(-.30,.91,nova); elbow = -1.57+nova*1.24; wrist = -.30*nova;
      }else if(release>0){
        shoulder = lerp(shoulder,-.46,release);
        spread = sign*lerp(.14,1.36,release);
        elbow = lerp(elbow,-.12,release);
      }else if(strike>0){
        const extension = smoothstep(strike,0,.26);
        shoulder = side===1 ? lerp(-.64,punch==='uppercut'?-1.98:punch==='down'?-.88:-1.57,extension) : -.68;
        spread = side===1 ? -.13 : -.22; elbow = side===1 ? lerp(-1.05,punch==='uppercut'?-.63:-.10,extension) : -1.12;
        wrist = punch==='down' && side===1 ? .28*extension : 0;
      }else if(windup>0){
        shoulder = side===1 ? lerp(-.28,.73,windup) : -.71;
        spread = sign*.28; elbow = -1.03-windup*.30;
      }else if(airborne){
        const reachUp = smoothstep(input.vertical,-18,22);
        shoulder = -.65-reachUp*.95+sign*.22; spread = sign*.36; elbow = -.36;
      }else if(crouch>0 || impact>0){
        shoulder = .36*crouch-.71*impact; spread = sign*.31; elbow = -.48;
      }
      arms[side].rotation.x = lerp(arms[side].rotation.x,shoulder,quick);
      arms[side].rotation.y = lerp(arms[side].rotation.y,guard?-sign*.24:side===1 && strike>0?-.14:0,quick);
      arms[side].rotation.z = lerp(arms[side].rotation.z,spread,quick);
      forearms[side].rotation.x = lerp(forearms[side].rotation.x,elbow,quick);
      hands[side].rotation.x = lerp(hands[side].rotation.x,wrist,blend);
    }
    return footfall;
  }
}
