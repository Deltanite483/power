import {GUARD_HEAL_MULTIPLIER} from "./vitality";
import * as THREE from 'three';
import type {Faora,CombatTarget} from './faora';
import {DOOMSDAY_BEAM_STRENGTH} from './beam-impact';
import {EnergyLightning} from './energy-lightning';
import {beamMaterial} from './combat-fx';

type PowerState='idle'|'beam-charge'|'beam'|'nova-charge'|'recovery';

/** Charged beam and stored-energy nova. Four reusable meshes and one bounded lightning batch; terrain work only on damage ticks. */
export class DoomsdayPowers {
  readonly group=new THREE.Group();
  state:PowerState='idle';
  energy=0;
  private exhaustion=0;
  readonly lightning:EnergyLightning;
  private poiseRevision:number|null=null;
  private clock=0;
  private beamCooldown=2.5;
  private novaCooldown=5;
  private sinceHit=0;
  private tick=0;
  private trace=0;
  private reach=500;
  private burnGroup=-1;
  private target:CombatTarget|null=null;
  private origin=new THREE.Vector3();
  private chest=new THREE.Vector3();
  private aim=new THREE.Vector3(0,0,1);
  private want=new THREE.Vector3();
  private end=new THREE.Vector3();
  private closest=new THREE.Vector3();
  private axis=new THREE.Vector3(0,1,0);
  private visualDirection=new THREE.Vector3();
  private beam:THREE.Mesh<THREE.CylinderGeometry,THREE.ShaderMaterial>;
  private core:THREE.Mesh<THREE.CylinderGeometry,THREE.ShaderMaterial>;
  private fxTime=0;
  /** Where the beam is burning this frame, or null. */
  get beamImpact(){return this.group.visible && this.impact.visible ? this.end : null;}
  get beamDirection(){return this.aim;}
  private halo:THREE.Mesh<THREE.SphereGeometry,THREE.MeshBasicMaterial>;
  private impact:THREE.Mesh<THREE.IcosahedronGeometry,THREE.MeshBasicMaterial>;
  onCharge:(kind:'beam'|'nova')=>void=()=>{};
  onBeamFire:()=>void=()=>{};
  onBeamHit:(target:CombatTarget,strength:number,direction:THREE.Vector3)=>void=()=>{};
  onBurn:(point:THREE.Vector3,group:number)=>number=()=>-1;
  onNova:(origin:THREE.Vector3,radius:number)=>void=()=>{};

  constructor(scene:THREE.Scene){
    this.lightning=new EnergyLightning(scene);
    const geometry=new THREE.CylinderGeometry(1,1,1,12,1,true);
    const material=(color:number,opacity:number)=>new THREE.MeshBasicMaterial({color,transparent:true,opacity,depthWrite:false,toneMapped:false,blending:THREE.AdditiveBlending});
    this.beam=new THREE.Mesh(geometry,beamMaterial(0xffd28a,0xff4a12,true,.75));this.core=new THREE.Mesh(geometry,beamMaterial(0xffffff,0xffe6b0,true,1));
    this.halo=new THREE.Mesh(new THREE.SphereGeometry(1,16,10),material(0xbfa0ff,.12));
    this.halo.material.side=THREE.BackSide;
    this.impact=new THREE.Mesh(new THREE.IcosahedronGeometry(1,1),material(0xffc067,.65));
    this.group.add(this.beam,this.core,this.halo,this.impact);this.group.visible=false;scene.add(this.group);
  }

  absorb(strength:number){
    if(!Number.isFinite(strength)||strength<=0)return;
    this.energy=Math.min(1,this.energy+strength/450);this.sinceHit=0;
  }

  reset(){this.state='idle';this.energy=0;this.exhaustion=0;this.clock=0;this.target=null;this.group.visible=false;this.beamCooldown=2.5;this.novaCooldown=5;this.poiseRevision=null;this.lightning.clear();}
  set warm(on:boolean){this.group.visible=on;for(const child of this.group.children)child.visible=on;this.lightning.mesh.visible=on;}

  update(dt:number,fighter:Faora,target:CombatTarget|null,deployed:boolean){
    this.updatePower(dt,fighter,target,deployed);
    fighter.doomsdaySpecial=this.state==='idle' ? null : this.state;
    fighter.doomsdayAim.copy(this.state==='beam-charge' ? this.want : this.aim);
    if(!deployed || fighter.vitals.defeated){this.lightning.clear();return;}
    this.lightning.update(dt,this.halo.position,Math.max(fighter.specialCharge,this.state==='beam'?.65:0),this.state==='beam'?this.end:null);
  }

  private updatePower(dt:number,fighter:Faora,target:CombatTarget|null,deployed:boolean){
    this.group.visible=false;this.beam.visible=this.core.visible=this.impact.visible=this.halo.visible=false;
    fighter.specialChanneling=false;fighter.specialCharge=0;
    fighter.specialAdvance=false;
    if(deployed) this.exhaustion=Math.max(0,this.exhaustion-dt);
    fighter.novaExhausted=this.exhaustion>0;
    if(!deployed || fighter.vitals.defeated){this.state='idle';this.clock=0;this.target=null;return;}
    const interrupted=this.poiseRevision!==null && this.poiseRevision!==fighter.poiseRevision;
    this.poiseRevision=fighter.poiseRevision;
    if(interrupted){
      this.state='idle';this.clock=0;this.target=null;
      this.beamCooldown=Math.max(this.beamCooldown,1);this.novaCooldown=Math.max(this.novaCooldown,1);
      return;
    }
    fighter.vitals.damageScale=.1/(1+.2*fighter.vitals.revivesUsed);
    this.sinceHit+=dt;
    if(this.sinceHit>2)fighter.vitals.health=Math.min(100,fighter.vitals.health+dt*.8*(fighter.blocking?GUARD_HEAL_MULTIPLIER:1));
    this.beamCooldown=Math.max(0,this.beamCooldown-dt);this.novaCooldown=Math.max(0,this.novaCooldown-dt);
    if(fighter.novaExhausted)return;
    if(!target || !fighter.availableToFight || target.vitals.defeated || (this.target && this.target!==target)){
      this.state='idle';this.clock=0;this.target=null;return;
    }
    this.beamOrigin(fighter);
    this.chest.copy(target.pos);this.chest.y+=(target.eyeLevel-target.pos.y)*.65;
    const distance=this.origin.distanceTo(this.chest);
    if(this.state==='idle'){
      if(this.novaCooldown<=0 && distance<110 && (this.energy>=.7 || distance<18)){
        this.state='nova-charge';this.clock=0;this.target=target;this.onCharge('nova');
      }else if(this.beamCooldown<=0 && distance>=8 && distance<=450 && fighter.lineClear(this.origin,this.chest)){
        this.state='beam-charge';this.clock=0;this.target=target;this.onCharge('beam');
      }else return;
    }
    if(this.state==='recovery'){
      this.clock-=dt;fighter.specialChanneling=true;
      if(this.clock<=0){this.state='idle';this.target=null;}
      return;
    }
    this.group.visible=true;fighter.specialChanneling=true;this.clock+=dt;
    this.halo.visible=true;this.halo.position.copy(fighter.pos);this.halo.position.y+=2;
    if(this.state==='nova-charge'){
      const charge=Math.min(1,this.clock/2.3);fighter.specialCharge=charge;
      this.halo.scale.setScalar(2+charge*5);this.halo.material.color.setHex(0xc6a0ff);
      this.halo.material.opacity=.06+charge*.22+Math.sin(this.clock*24)*.025;
      if(charge>=1){
        const origin=fighter.pos.clone();origin.y+=1;
        const radius=155+this.energy*85;
        this.lightning.burst(origin,radius);
        this.onNova(origin,radius);
        this.exhaustion=10;
        fighter.novaExhausted=true;
        this.energy=0;this.novaCooldown=16;this.beamCooldown=Math.max(this.beamCooldown,4);
        this.state='idle';this.clock=0;this.target=null;
      }
      return;
    }
    fighter.specialAdvance=true;
    this.halo.material.color.setHex(0xffb775);this.halo.scale.setScalar(1.2+Math.min(1,this.clock)*.5);
    this.halo.position.copy(this.origin);this.halo.material.opacity=.1+Math.sin(this.clock*30)*.035;
    this.want.subVectors(this.chest,this.origin).normalize();
    if(this.state==='beam-charge'){
      fighter.specialCharge=Math.min(1,this.clock/1.2);this.aim.copy(this.want);
      if(this.clock<1.2)return;
      this.state='beam';this.clock=0;this.tick=0;this.trace=0;this.burnGroup=-1;this.beamCooldown=12;
      this.onBeamFire();
    }
    const angle=this.aim.angleTo(this.want);
    if(angle>.0001)this.aim.lerp(this.want,Math.min(1,.35*dt/angle)).normalize();
    this.trace-=dt;this.tick-=dt;
    if(this.trace<=0 || this.tick<=0){
      this.end.copy(this.origin).addScaledVector(this.aim,600);
      this.reach=600*fighter.firstBlock(this.origin,this.end);this.trace=.06;
    }
    const along=this.closest.subVectors(this.chest,this.origin).dot(this.aim);
    this.closest.copy(this.origin).addScaledVector(this.aim,Math.max(0,along));
    const onTarget=along>0 && along<this.reach && this.closest.distanceTo(this.chest)<1.45;
    const reach=onTarget?Math.max(.1,along-1):this.reach;
    this.end.copy(this.origin).addScaledVector(this.aim,reach);
    this.beam.visible=this.core.visible=true;
    this.placeBeam();
    this.fxTime+=dt;this.beam.material.uniforms.uTime.value=this.core.material.uniforms.uTime.value=this.fxTime;
    this.impact.visible=this.reach<599 || onTarget;this.impact.position.copy(this.end);
    this.impact.scale.setScalar(1.5+Math.sin(this.fxTime*47)*.35+Math.sin(this.fxTime*31)*.2);this.impact.rotation.set(this.fxTime*9,this.fxTime*13,0);
    if(this.tick<=0){
      this.tick+=.16;
      if(onTarget)this.onBeamHit(target,DOOMSDAY_BEAM_STRENGTH,this.aim);
      else if(this.reach<599)this.burnGroup=this.onBurn(this.end,this.burnGroup);
    }
    if(this.clock>=1.35){this.state='recovery';this.clock=.2;this.target=null;}
  }

  /** Refresh the visible source after the fighter moves and poses this frame. */
  syncPose(fighter:Faora){
    if(!this.group.visible || !this.halo.visible || !fighter.specialAdvance)return;
    this.beamOrigin(fighter);
    this.halo.position.copy(this.origin);
    if(this.beam.visible)this.placeBeam();
  }

  private beamOrigin(fighter:Faora){
    if(fighter.doomsdayRig)fighter.doomsdayRig.mouth.getWorldPosition(this.origin);
    else fighter.model.localToWorld(this.origin.set(0,1.76,.2));
  }

  private placeBeam(){
    this.visualDirection.subVectors(this.end,this.origin);
    const length=this.visualDirection.length();
    if(length>0)this.visualDirection.divideScalar(length);
    for(const mesh of [this.beam,this.core]){
      mesh.position.copy(this.origin).lerp(this.end,.5);
      mesh.quaternion.setFromUnitVectors(this.axis,length>0?this.visualDirection:this.aim);
      const width=mesh===this.beam?1.05+Math.sin(this.fxTime*38)*.1:.36;
      mesh.scale.set(width,length,width);
    }
  }
}
