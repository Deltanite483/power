import * as THREE from "three";
import type { Destruction } from "./destruction";

const JOINTS = [
  [0,.9,0],[0,1.4,0],[0,1.75,0],[-.31,1.4,0],[-.31,1.08,0],[-.31,.8,0],
  [.31,1.4,0],[.31,1.08,0],[.31,.8,0],[-.125,.48,0],[-.125,.1,0],[.125,.48,0],[.125,.1,0],
  [-.125,.82,0],[.125,.82,0],
];
// A rigid chest/pelvis cage prevents the spine and shoulders folding like cloth.
const CORE = [0, 1, 3, 6, 13, 14];
const LINKS = [[1,2],[3,4],[4,5],[6,7],[7,8],[13,9],[9,10],[14,11],[11,12],[13,10],[14,12]];
for (let i=0;i<CORE.length;i++) for (let j=i+1;j<CORE.length;j++) LINKS.push([CORE[i],CORE[j]]);
/** Any skeleton with real elbows, wrists, knees and ankles: the ragdoll drives those joints instead of stiff limbs. */
export interface JointedRig {
  torso: THREE.Group; head: THREE.Group;
  arms: [THREE.Group, THREE.Group]; forearms: [THREE.Group, THREE.Group]; hands: [THREE.Group, THREE.Group];
  legs: [THREE.Group, THREE.Group]; shins: [THREE.Group, THREE.Group]; feet: [THREE.Group, THREE.Group];
}
interface Constraint { a: number; b: number; min: number; max: number; }
interface ArmBinding { arm: THREE.Group; forearm: THREE.Group; shoulder: number; elbow: number; wrist: number; recoveryRotation: THREE.Quaternion; }
const INVERSE_MASS = [ .2, .16, .8, .35, 1, 1.5, .35, 1, 1.5, .7, 1, .7, 1, .3, .3 ];
interface Binding { group: THREE.Group; from: number; to: number; pivot: THREE.Vector3; recoveryPosition: THREE.Vector3; recoveryRotation: THREE.Quaternion; }

/** A constrained, terrain-colliding skeleton; limbs swing independently around the held chest. */
export class Ragdoll {
  translate(offset: THREE.Vector3, velocity: THREE.Vector3) {
    this.delta.subVectors(velocity, this.velocity[0]);
    for (let i = 0; i < this.joints.length; i++) {
      this.joints[i].add(offset);
      this.velocity[i].add(this.delta);
    }
    this.model.position.add(offset);
  }

  readonly joints = JOINTS.map(() => new THREE.Vector3());
  readonly velocity = JOINTS.map(() => new THREE.Vector3());
  anchor: THREE.Vector3 | null = null;
  readonly anchorVelocity = new THREE.Vector3();
  grabJoint = 1;
  active = false;
  private rest = JOINTS.map(p => new THREE.Vector3(...p as [number,number,number]));
  private links: Constraint[] = [];
  private arms: ArmBinding[] = [];
  private knees: {leg: THREE.Group; shin: THREE.Group; knee: number; ankle: number; recovery: THREE.Quaternion}[] = [];
  private poseAnchors: [number, THREE.Group][] = [];
  private angularVelocity = new THREE.Vector3();
  private centerVelocity = new THREE.Vector3();
  private localRotation = new THREE.Quaternion();
  private bindings: Binding[] = [];
  private previous = JOINTS.map(() => new THREE.Vector3());
  private axis = new THREE.Vector3(0,1,0);
  private down = new THREE.Vector3(0,-1,0);
  private delta = new THREE.Vector3();
  private torsoX = new THREE.Vector3();
  private torsoY = new THREE.Vector3();
  private torsoZ = new THREE.Vector3();
  private basis = new THREE.Matrix4();
  private torsoRotation = new THREE.Quaternion();
  private swing = new THREE.Quaternion();
  private identity = new THREE.Quaternion();
  private recoveryTime = 0;
  private simulatedPose = false;

  constructor(private model: THREE.Group, private world: Destruction, private size = 1, private doom?: JointedRig) {
    const children = [...model.children];
    const pieces = Array.from({length:6},()=>new THREE.Group());
    const pivots = [[0,1.15,0],[0,1.735,0],[-.31,1.4,0],[.31,1.4,0],[-.125,.82,0],[.125,.82,0]];
    if(doom){
      pivots[1]=doom.head.position.toArray();
      this.rest[2].copy(doom.head.position);
      this.poseAnchors.push([2,doom.head]);
    }
    for(let i=0;i<pieces.length;i++){ pieces[i].position.fromArray(pivots[i]); model.add(pieces[i]); }
    model.updateMatrixWorld(true);
    for(const child of children){
      const center=new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
      const y=center.y,x=center.x;
      // Arms retain their articulated shoulder groups; the cape follows the torso.
      const index = doom && child === doom.head ? 1 : doom && child === doom.torso ? 0 : doom && child === doom.arms[0] ? 2 : doom && child === doom.arms[1] ? 3 : child.userData.ragdollPart === "leftLeg" ? 4 : child.userData.ragdollPart === "rightLeg" ? 5 : child instanceof THREE.Group ? (Math.abs(child.position.x)>.25 ? (x<0?2:3) : 0) : y>1.5 ? 1 : y<.8 ? (x<0?4:5) : 0;
      if (index === 2 || index === 3) {
        const shoulder=index===2?3:6, elbow=shoulder+1, wrist=shoulder+2;
        // The model's shoulder and elbow pivots are the physical joint anchors.
        this.rest[shoulder].copy(child.position);
        pieces[index].position.copy(child.position);
        pivots[index]=child.position.toArray();
        const forearm=doom?.forearms[index-2] ?? child.children.find(part => part instanceof THREE.Group && part.position.y < -.2) as THREE.Group | undefined;
        if (forearm && child instanceof THREE.Group) {
          this.rest[elbow].copy(child.position).add(forearm.position);
          this.rest[wrist].copy(this.rest[elbow]).add(new THREE.Vector3(0,-.28,0));
          if(doom){
            this.rest[wrist].copy(this.rest[elbow]).add(doom.hands[index-2].position);
            this.poseAnchors.push([shoulder,doom.arms[index-2]],[elbow,forearm],[wrist,doom.hands[index-2]]);
          }
          this.arms.push({arm:child,forearm,shoulder,elbow,wrist,recoveryRotation:new THREE.Quaternion()});
        }
      }
      if (index === 4 || index === 5) {
        if (child.userData.ragdollPart) {
          this.rest[index===4?13:14].copy(child.position);
          pieces[index].position.copy(child.position);
          pivots[index]=child.position.toArray();
          if(doom){
            const side=index-4, hip=13+side, knee=9+2*side, ankle=knee+1;
            const leg=doom.legs[side], shin=doom.shins[side], foot=doom.feet[side];
            this.rest[knee].copy(this.rest[hip]).add(shin.position);
            this.rest[ankle].copy(this.rest[knee]).add(foot.position);
            this.poseAnchors.push([hip,leg],[knee,shin],[ankle,foot]);
            this.knees.push({leg,shin,knee,ankle,recovery:new THREE.Quaternion()});
          }
        }
      }
      pieces[index].attach(child);
    }
    for (const [a,b] of LINKS) {
      const length=this.rest[a].distanceTo(this.rest[b])*size;
      const flexingKnee=doom && (a===13 && b===10 || a===14 && b===12);
      this.links.push({a,b,min:flexingKnee?length*.55:length,max:length});
    }
    // Elbows flex, but cannot collapse completely; the neck stays attached to the chest.
    for (const [a,b,c] of [[3,4,5],[6,7,8]]) {
      const upper=this.rest[a].distanceTo(this.rest[b])*size, lower=this.rest[b].distanceTo(this.rest[c])*size;
      this.links.push({a,b:c,min:Math.sqrt(upper*upper+lower*lower+2*upper*lower*Math.cos(2.4)),max:upper+lower});
    }
    const neck=this.rest[0].distanceTo(this.rest[2])*size;
    this.links.push({a:0,b:2,min:neck*.94,max:neck});
    // Keep knees on their own side of the pelvis and arms outside the chest.
    for (const [a,b,min,max] of [[9,11,.17,.75],[4,6,.32,.95],[7,3,.32,.95],[10,14,.28,1.05],[12,13,.28,1.05]])
      this.links.push({a,b,min:min*size,max:max*size});
    const endpoints=[[0,1],[1,2],[3,4],[6,7],[13,doom?9:10],[14,doom?11:12]];
    for(let i=0;i<pieces.length;i++)this.bindings.push({group:pieces[i],from:endpoints[i][0],to:endpoints[i][1],pivot:new THREE.Vector3().fromArray(pivots[i]),recoveryPosition:new THREE.Vector3(),recoveryRotation:new THREE.Quaternion()});
  }

  start(velocity: THREE.Vector3) {
    if(this.active){
      this.delta.subVectors(velocity,this.velocity[0]);
      for(const v of this.velocity)v.add(this.delta);
      return;
    }
    this.active=true;this.anchor=null;
    this.simulatedPose=false;
    this.recoveryTime=0;
    // Start in the visible pose, including a flight lean, instead of snapping upright.
    this.model.updateWorldMatrix(true, false);
    const transform=this.model.matrixWorld;
    for(let i=0;i<this.joints.length;i++)this.joints[i].copy(this.rest[i]).applyMatrix4(transform);
    for(const [index,group] of this.poseAnchors)group.getWorldPosition(this.joints[index]);
    // One coherent angular impulse tumbles the body instead of scattering every joint.
    this.angularVelocity.set(velocity.z,0,-velocity.x).multiplyScalar(.035).clampLength(0,5);
    const center=this.rest[0].clone().applyMatrix4(transform);
    for(let i=0;i<this.joints.length;i++){
      this.delta.subVectors(this.joints[i],center);
      this.velocity[i].copy(velocity).add(this.delta.crossVectors(this.angularVelocity,this.delta));
    }
  }

  stop(){
    if(!this.active)return;
    this.active=false;this.anchor=null;
    if (!this.simulatedPose) return;
    // Preserve the visible world pose while turning the root back toward the torso.
    this.torsoX.subVectors(this.joints[6],this.joints[3]).setY(0);
    const yaw=this.torsoX.lengthSq()>.001 ? -Math.atan2(this.torsoX.z,this.torsoX.x) : 0;
    const inverse=new THREE.Quaternion().setFromAxisAngle(this.axis,-yaw);
    for(const b of this.bindings){
      b.group.position.applyQuaternion(inverse);
      b.group.quaternion.premultiply(inverse);
      b.recoveryPosition.copy(b.group.position);
      b.recoveryRotation.copy(b.group.quaternion);
    }
    this.model.rotation.set(0,yaw,0);
    for (const arm of this.arms) arm.recoveryRotation.copy(arm.forearm.quaternion);
    for(const knee of this.knees)knee.recovery.copy(knee.shin.quaternion);
    this.recoveryTime=.45;
  }

  /** Ease the simulated pose back to the animated rig after recovery. */
  recover(dt:number){
    if(this.active||this.recoveryTime<=0)return;
    this.recoveryTime=Math.max(0,this.recoveryTime-dt);
    const t=1-this.recoveryTime/.45, eased=t*t*(3-2*t);
    for(const b of this.bindings){
      b.group.position.lerpVectors(b.recoveryPosition,b.pivot,eased);
      b.group.quaternion.copy(b.recoveryRotation).slerp(this.identity,eased);
    }
    for (const arm of this.arms) arm.forearm.quaternion.copy(arm.recoveryRotation).slerp(this.identity,eased);
    for(const knee of this.knees)knee.shin.quaternion.copy(knee.recovery).slerp(this.identity,eased);
  }

  update(dt:number,feet:THREE.Vector3,velocity:THREE.Vector3){
    const fastest=Math.max(...this.velocity.map(v=>v.length()));
    const steps=Math.min(128,Math.max(1,Math.ceil(Math.max(dt*120,fastest*dt/.4))));
    const h=dt/steps;
    if(h<=0)return;
    for(let step=0;step<steps;step++){
      if(this.anchor){
        this.delta.subVectors(this.anchor,this.joints[this.grabJoint]).multiplyScalar(700)
          .addScaledVector(this.anchorVelocity,80).addScaledVector(this.velocity[this.grabJoint],-80).clampLength(0,1300);
        this.velocity[this.grabJoint].addScaledVector(this.delta,h);
      }
      for(let i=0;i<this.joints.length;i++){
        this.previous[i].copy(this.joints[i]);this.velocity[i].y-=9.81*h;
        this.velocity[i].multiplyScalar(Math.exp(-h*.16));this.joints[i].addScaledVector(this.velocity[i],h);
      }
      for(let iteration=0;iteration<12;iteration++){
        for(const link of this.links){
          const a=this.joints[link.a],b=this.joints[link.b];this.delta.subVectors(b,a);const length=this.delta.length();
          if(length>1e-7){
            const target=THREE.MathUtils.clamp(length,link.min,link.max);
            const wa=INVERSE_MASS[link.a],wb=INVERSE_MASS[link.b];
            this.delta.multiplyScalar((length-target)/length/(wa+wb));a.addScaledVector(this.delta,wa);b.addScaledVector(this.delta,-wb);
          }
        }
        for(let i=0;i<this.joints.length;i++){
          const p=this.joints[i],old=this.previous[i],radius=(i===0||i===1?.18:i===2?.16:.09)*this.size;
          let floor=this.world.spans(p.x,p.z).floor(p.y+radius);
          if(floor>old.y+.5){p.x=old.x;p.z=old.z;floor=this.world.spans(p.x,p.z).floor(old.y+radius);}
          p.y=Math.max(p.y,floor+radius);
          const roof=this.world.spans(p.x,p.z).ceil(old.y);
          if(Number.isFinite(roof))p.y=Math.min(p.y,roof-radius);
        }
      }
      this.centerVelocity.set(0,0,0);
      let mass=0;
      for(let i=0;i<this.joints.length;i++){
        this.velocity[i].subVectors(this.joints[i],this.previous[i]).divideScalar(h);
        const floor=this.world.spans(this.joints[i].x,this.joints[i].z).floor(this.joints[i].y);
        const radius=(i===0||i===1?.18:i===2?.16:.09)*this.size;
        if(this.joints[i].y-floor<radius+.025)this.velocity[i].multiplyScalar(Math.exp(-h*8));
        this.centerVelocity.addScaledVector(this.velocity[i],1/INVERSE_MASS[i]);mass+=1/INVERSE_MASS[i];
      }
      this.centerVelocity.divideScalar(mass);
      // Dissipate internal jitter without removing the body's launch momentum.
      for(const v of this.velocity)v.lerp(this.centerVelocity,1-Math.exp(-h*1.8));
    }
    feet.copy(this.joints[0]);feet.y-=.9*this.size;
    velocity.copy(this.velocity[0]);
    this.model.position.copy(feet);this.model.rotation.set(0,0,0);
    this.simulatedPose=true;
    // Preserve body twist using both shoulders and the spine, not just the spine direction.
    this.torsoY.subVectors(this.joints[1],this.joints[0]).normalize();
    this.torsoX.subVectors(this.joints[6],this.joints[3]).normalize();
    this.torsoZ.crossVectors(this.torsoX,this.torsoY).normalize();
    if(this.torsoZ.lengthSq()<.01)this.torsoZ.set(0,0,1);
    this.torsoX.crossVectors(this.torsoY,this.torsoZ).normalize();
    this.torsoRotation.setFromRotationMatrix(this.basis.makeBasis(this.torsoX,this.torsoY,this.torsoZ));
    for(const binding of this.bindings){
      const a=this.joints[binding.from],b=this.joints[binding.to];
      // Limbs rotate at the shoulder/hip; the chest is centered on the spine.
      if(binding.from===3||binding.from===6||binding.from===13||binding.from===14)binding.group.position.copy(a).sub(feet);
      else if(binding.to===2)binding.group.position.copy(b).sub(feet);
      else binding.group.position.copy(a).add(b).multiplyScalar(.5).sub(feet);
      binding.group.position.divideScalar(this.size);
      this.delta.subVectors(b,a).normalize();
      if(binding.from===3||binding.from===6||binding.from===13||binding.from===14)this.delta.negate();
      this.swing.setFromUnitVectors(this.torsoY,this.delta);
      binding.group.quaternion.copy(this.swing).multiply(this.torsoRotation);
    }
    if(this.doom){
      this.doom.head.quaternion.identity();
      this.doom.torso.quaternion.identity();
      for(const knee of this.knees){
        knee.leg.quaternion.identity();
        this.localRotation.copy(knee.leg.parent!.quaternion).invert();
        this.delta.subVectors(this.joints[knee.ankle],this.joints[knee.knee]).normalize().applyQuaternion(this.localRotation);
        knee.shin.quaternion.setFromUnitVectors(this.down,this.delta);
      }
    }
    for(const arm of this.arms){
      arm.arm.quaternion.identity();
      this.localRotation.copy(arm.arm.parent!.quaternion).invert();
      this.delta.subVectors(this.joints[arm.wrist],this.joints[arm.elbow]).normalize().applyQuaternion(this.localRotation);
      arm.forearm.quaternion.setFromUnitVectors(this.down,this.delta);
    }
  }
}
