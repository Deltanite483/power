import { playerHit, type HitSource } from "./combat-events";
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Destruction } from "./destruction";
import { Mat } from "./terrain/heightfield";
import type { Player } from "./player";
import type { Faora } from "./faora";

const PUNCH_REACH = 12;
const MELEE_ASSIST_REACH = 5;
const MELEE_ASSIST_ALIGNMENT = Math.cos(THREE.MathUtils.degToRad(12));
const GRAB_REACH = 20;
const STEP = 1 / 120;
const GRAB_STIFFNESS = 500_000;
const GRAB_DAMPING = 100_000;
const MAX_GRAB_FORCE = 2_000_000;
let initialized: Promise<void> | undefined;

export class CarryProp {
  readonly mesh = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly spin = new THREE.Vector3();
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly radius: number;
  readonly localGrab = new THREE.Vector3();
  private spherical: boolean;
  held = false;
  hitCooldown = 0;
  /** Recent player attack attribution: a prop you hit or threw counts as your attack for a while. */
  playerAttackTime = 0;
  attackSource: HitSource | null = null;
  private grabTarget = new THREE.Vector3();
  private grabVelocity = new THREE.Vector3();
  private force = new THREE.Vector3();
  private point = new THREE.Vector3();
  private offset = new THREE.Vector3();
  private pointVelocity = new THREE.Vector3();

  constructor(readonly name: string, readonly size: THREE.Vector3, scene: THREE.Scene, world: Destruction, physics: RAPIER.World, x: number, z: number, sphere = false) {
    this.spherical=sphere;
    this.radius = sphere ? size.x / 2 : size.length() / 2;
    let floor = world.spans(x, z).top;
    for (const dx of [-size.x*.45,size.x*.45]) for (const dz of [-size.z*.45,size.z*.45]) floor=Math.max(floor,world.spans(x+dx,z+dz).top);
    this.pos.set(x, floor + size.y/2 + .12, z);
    this.body = physics.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(this.pos.x,this.pos.y,this.pos.z).setCcdEnabled(true)
      .setLinearDamping(.015).setAngularDamping(.2).setCanSleep(true));
    const shape = sphere ? RAPIER.ColliderDesc.ball(size.x/2) : RAPIER.ColliderDesc.cuboid(size.x/2,size.y/2,size.z/2);
    this.collider = physics.createCollider(shape.setDensity(240).setFriction(.95).setRestitution(.035)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),this.body);
    this.body.recomputeMassPropertiesFromColliders();
    const metal = new THREE.MeshStandardMaterial({color:sphere?0xaac0cc:0xc88c37,metalness:.65,roughness:.36});
    const geometry = sphere ? new THREE.SphereGeometry(size.x/2,24,16) : new THREE.BoxGeometry(size.x,size.y,size.z);
    this.mesh.add(new THREE.Mesh(geometry,metal));
    if (!sphere) {
      this.mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry),new THREE.LineBasicMaterial({color:0x303f4b})));
      for (const y of [-.34,.34]) {
        const stripe=new THREE.Mesh(new THREE.BoxGeometry(size.x*1.01,.16,size.z*1.01),new THREE.MeshStandardMaterial({color:0xe8dfb6,metalness:.3,roughness:.55}));
        stripe.position.y=size.y*y;this.mesh.add(stripe);
      }
    } else this.mesh.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(size.x*.502,1)),new THREE.LineBasicMaterial({color:0x405c70})));
    this.mesh.position.copy(this.pos);scene.add(this.mesh);
  }

  get mass() { return this.body.mass(); }
  supportHeight() {
    if(this.spherical)return this.size.y/2;
    const m=this.mesh.matrix.elements;
    return (Math.abs(m[1])*this.size.x+Math.abs(m[5])*this.size.y+Math.abs(m[9])*this.size.z)/2;
  }
  setHeld(held: boolean) { this.held=held; if(held)this.body.wakeUp(); }
  setGripPoint(point: THREE.Vector3) { this.mesh.updateMatrixWorld(true);this.localGrab.copy(this.mesh.worldToLocal(point.clone())); }
  grabPosition(out: THREE.Vector3) { return out.copy(this.localGrab).applyQuaternion(this.mesh.quaternion).add(this.pos); }
  moveHeld(point: THREE.Vector3, velocity: THREE.Vector3) { this.grabTarget.copy(point);this.grabVelocity.copy(velocity); }

  /** Forces act at the clicked point: off-center grabs generate torque, not teleportation. */
  applyGrabForce() {
    if(!this.held)return;
    this.grabPosition(this.point);
    this.offset.subVectors(this.point,this.pos);
    this.pointVelocity.crossVectors(this.spin,this.offset).add(this.vel);
    this.force.subVectors(this.grabTarget,this.point).multiplyScalar(GRAB_STIFFNESS)
      .addScaledVector(this.grabVelocity,GRAB_DAMPING).addScaledVector(this.pointVelocity,-GRAB_DAMPING);
    this.force.y += this.mass * 9.81 * .75;
    this.force.clampLength(0,MAX_GRAB_FORCE);
    this.body.addForceAtPoint(this.force,this.point,true);
  }

  /** Ground deformation resists a many-tonne sphere rolling across soil. */
  applyRollingResistance(world:Destruction) {
    if(this.held||!this.spherical||this.body.isSleeping())return;
    const floor=world.spans(this.pos.x,this.pos.z).floor(this.pos.y);
    if(this.pos.y-this.radius-floor>.55)return;
    const speed=Math.hypot(this.vel.x,this.vel.z);
    if(speed>1e-5){
      this.force.set(this.vel.x,0,this.vel.z).multiplyScalar(-Math.min(this.mass*9.81*.18,this.mass*speed/STEP)/speed);
      this.body.addForce(this.force,false);
    }
    const angularSpeed=this.spin.length();
    if(angularSpeed>1e-5){
      const torque=Math.min(this.mass*9.81*this.radius*.08,.4*this.mass*this.radius*this.radius*angularSpeed/STEP);
      this.body.addTorque(this.force.copy(this.spin).multiplyScalar(-torque/angularSpeed),false);
    }
  }

  strike(direction: THREE.Vector3, inherited: THREE.Vector3, point?: THREE.Vector3, scale=1) {
    this.held=false;
    this.force.copy(direction).multiplyScalar(2_800_000*scale).addScaledVector(inherited,this.mass*.12);
    this.body.applyImpulseAtPoint(this.force,point??this.grabPosition(this.point),true);
  }
  release(direction: THREE.Vector3, inherited: THREE.Vector3) {
    this.held=false;
    this.force.copy(direction).multiplyScalar(1_800_000).addScaledVector(inherited,this.mass*.1);
    this.body.applyImpulseAtPoint(this.force,this.grabPosition(this.point),true);
  }
  sync() {
    this.pos.copy(this.body.translation());this.vel.copy(this.body.linvel());this.spin.copy(this.body.angvel());
    this.mesh.position.copy(this.pos);this.mesh.quaternion.copy(this.body.rotation());this.mesh.updateMatrixWorld(true);
  }
}

type Item = CarryProp | Faora;
interface Tile { colliders: RAPIER.Collider[]; x: number; z: number; dirty: boolean; }
interface Pick { item: Item; point: THREE.Vector3; distance: number; }

export class Interactions {
  readonly props: CarryProp[]=[];
  readonly opponents: Faora[]=[];
  readonly physics: RAPIER.World;
  private carriedItem: Item | null = null;
  get carrying(): Item | null { return this.carriedItem?.held ? this.carriedItem : null; }
  set carrying(item: Item | null) { this.carriedItem = item; }
  lastPunchHitFighter: Faora | null = null;
  aimed: Item|null=null;
  grabDistance = 5;
  onImpact: (speed: number, point: THREE.Vector3) => void = () => {};
  onIncomingAttack: (strength: number, source: HitSource) => number = () => 1;
  onPlayerCollision: (speed: number) => void = () => {};
  private playerHitCooldown = new Map<CarryProp, number>();
  private tiles=new Map<string,Tile>();
  get terrainColliderTileCount() { return this.tiles.size; }
  private events: RAPIER.EventQueue;
  private raycaster=new THREE.Raycaster();
  private forward=new THREE.Vector3();
  private center=new THREE.Vector3();
  private target=new THREE.Vector3();
  private targetVelocity=new THREE.Vector3();
  private previousTarget=new THREE.Vector3();
  private accumulator=0;
  private lastPick:Pick|null=null;
  private impactCooldown=new Map<CarryProp,number>();

  static async create(world: Destruction,scene:THREE.Scene,friend:Faora) {
    await (initialized ??= RAPIER.init());
    return new Interactions(world,scene,friend);
  }
  private constructor(private world:Destruction,scene:THREE.Scene,readonly friend:Faora) {
    this.physics=new RAPIER.World({x:0,y:-9.81,z:0});
    this.physics.numSolverIterations=8;
    this.physics.integrationParameters.maxCcdSubsteps=4;
    this.events=new RAPIER.EventQueue(true);
    this.props.push(new CarryProp("Titanium monolith",new THREE.Vector3(4,6,4),scene,world,this.physics,28,-12));
    this.props.push(new CarryProp("Armored cargo vault",new THREE.Vector3(8,4,4),scene,world,this.physics,48,12));
    this.props.push(new CarryProp("Solid alloy sphere",new THREE.Vector3(6,6,6),scene,world,this.physics,65,-18,true));
    this.props.push(new CarryProp("Reinforced slab",new THREE.Vector3(9,2,6),scene,world,this.physics,90,16));
    this.syncTerrain();
    world.onCollisionChange = (x0,z0,x1,z1) => this.invalidateTerrain(x0,z0,x1,z1);
  }

  private invalidateTerrain(x0: number, z0: number, x1: number, z1: number) {
    const ax=Math.floor(x0/16), bx=Math.floor(x1/16), az=Math.floor(z0/16), bz=Math.floor(z1/16);
    for (const tile of this.tiles.values()) {
      if (tile.x >= ax && tile.x <= bx && tile.z >= az && tile.z <= bz) tile.dirty = true;
    }
  }

  /** Build physical terrain around the bodies, including their swept path and new destruction. */
  private syncTerrain() {
    const needed=new Set<string>();
    // Missing tiles are built at once so nothing falls through; stale ones (fresh craters) refresh one per frame, never as a hitch.
    let refreshes=1;
    for(const prop of this.props) {
      const padding=prop.radius+1;
      const future=prop.pos.clone().addScaledVector(prop.vel,.08);
      for(let x=Math.floor((Math.min(prop.pos.x,future.x)-padding)/16);x<=Math.floor((Math.max(prop.pos.x,future.x)+padding)/16);x++)
        for(let z=Math.floor((Math.min(prop.pos.z,future.z)-padding)/16);z<=Math.floor((Math.max(prop.pos.z,future.z)+padding)/16);z++) {
          const key=`${x}:${z}`;needed.add(key);
          const old=this.tiles.get(key);
          if(old && !old.dirty)continue;
          if(old&&refreshes--<=0)continue;
          if(old)for(const collider of old.colliders)this.physics.removeCollider(collider,false);
          const mesh=this.world.collisionMesh(x,z);
          const concrete:number[]=[],other:number[]=[];
          for(let n=0;n<mesh.indices.length;n+=3){const into=mesh.materials[mesh.indices[n]]===Mat.Concrete?concrete:other;into.push(mesh.indices[n],mesh.indices[n+1],mesh.indices[n+2]);}
          const colliders:RAPIER.Collider[]=[];
          for(const [indices,noBounce] of [[concrete,true],[other,false]] as const){
            if(!indices.length)continue;
            const desc=RAPIER.ColliderDesc.trimesh(mesh.positions,new Uint32Array(indices),RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
              .setTranslation(x*16,0,z*16).setFriction(1).setRestitution(noBounce?0:.015);
            if(noBounce)desc.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
            colliders.push(this.physics.createCollider(desc));
          }
          this.tiles.set(key,{colliders,x,z,dirty:false});
        }
    }
    for(const [key,tile] of this.tiles)if(!needed.has(key)){for(const collider of tile.colliders)this.physics.removeCollider(collider,false);this.tiles.delete(key);}
  }

  private rayPick(eye:THREE.Vector3,dir:THREE.Vector3, reach: number):Pick|null {
    this.raycaster.set(eye,dir);this.raycaster.far=reach;
    let closest:Pick|null=null;
    for(const item of [this.friend,...this.opponents,...this.props]) {
      if (!(item instanceof CarryProp) && item.vitals.defeated) continue;
      const model=item instanceof CarryProp?item.mesh:item.model;
      if (!model.visible) continue;
      model.updateMatrixWorld(true);
      const hit=this.raycaster.intersectObject(model,true).find(hit=>hit.object instanceof THREE.Mesh);
      if(!hit||hit.distance>(closest?.distance??reach))continue;
      const before=hit.point.clone().addScaledVector(dir,-.05);
      if(!this.friend.lineClear(eye,before))continue;
      closest={item,point:hit.point.clone(),distance:hit.distance};
    }
    return closest;
  }

  private assistedMeleePick(eye: THREE.Vector3, direction: THREE.Vector3): Pick | null {
    let best: Pick | null = null;
    let bestAlignment = MELEE_ASSIST_ALIGNMENT;
    const aim = new THREE.Vector3();
    for (const fighter of [this.friend, ...this.opponents]) {
      if (!fighter.model.visible || fighter.vitals.defeated) continue;
      if (fighter.pos.distanceToSquared(eye) > (MELEE_ASSIST_REACH + fighter.bodyScale * 2) ** 2) continue;
      for (const height of [1.28, 1.68, .88]) {
        aim.subVectors(fighter.pos, eye).y += height * fighter.bodyScale;
        if (aim.lengthSq() < 1e-6) continue;
        aim.normalize();
        const alignment = aim.dot(direction);
        if (alignment <= bestAlignment) continue;
        const hit = this.rayPick(eye, aim, MELEE_ASSIST_REACH);
        if (hit?.item !== fighter) continue;
        best = hit;
        bestAlignment = alignment;
      }
    }
    return best;
  }

  punch(eye:THREE.Vector3,dir:THREE.Vector3,player:Player,scale=1,kick=false,heldCharge=(scale-1)/3):boolean {
    const carried = this.carrying;
    const direct = this.rayPick(eye, dir, PUNCH_REACH);
    const assisted = !carried && !direct ? this.assistedMeleePick(eye, dir) : null;
    const hit = direct ?? assisted;
    const item = carried ?? hit?.item;
    const strikeDirection = assisted ? assisted.point.clone().sub(eye).normalize() : dir;
    this.lastPunchHitFighter = item && !(item instanceof CarryProp) ? item : null;
    if(!item)return false;
    if (this.carrying && item instanceof CarryProp) this.drop();
    if(item instanceof CarryProp){item.playerAttackTime=8;item.attackSource=playerHit("throw");item.strike(dir,player.vel,hit?.item===item?hit.point:undefined,scale);}
    else item.strike(strikeDirection,player.vel,260*scale,true,20 + (scale-1)*80/3,kick?2:1,playerHit(kick?"kick":scale>=1.9?"smash":"punch"),heldCharge);
    return true;
  }
  grabOrThrow(eye:THREE.Vector3,dir:THREE.Vector3,player:Player):string|null {
    if(this.carrying){const item=this.carrying;if(item instanceof CarryProp){item.playerAttackTime=8;item.attackSource=playerHit("throw");}item.release(dir,player.vel);this.carrying=null;return `Threw ${item.name}`;}
    const hit=this.rayPick(eye,dir,GRAB_REACH);if(!hit || hit.item.held)return null;
    if (!(hit.item instanceof CarryProp) && hit.item.cannotBeGrabbed) {
      if (!hit.item.vitals.frozen && hit.item.infinity?.payContact()) hit.item.onInfinityBlock();
      return null;
    }
    this.carrying=hit.item;this.grabDistance=THREE.MathUtils.clamp(hit.distance,2,GRAB_REACH);
    hit.item.setHeld(true);hit.item.setGripPoint(hit.point, player.yaw);
    this.previousTarget.copy(hit.point);this.target.copy(hit.point);this.targetVelocity.set(0,0,0);
    hit.item.moveHeld(this.target,this.targetVelocity,player.yaw);
    return `Grabbed ${hit.item.name}`;
  }
  drop() { if(this.carrying){this.carrying.setHeld(false);this.carrying=null;} }
  destroyPropsWithin(center: THREE.Vector3, radius: number, halfHeight: number) {
    for (let i = this.props.length - 1; i >= 0; i--) {
      const prop = this.props[i];
      if (Math.hypot(prop.pos.x - center.x, prop.pos.z - center.z) > radius + prop.radius
        || Math.abs(prop.pos.y - center.y) > halfHeight + prop.radius) continue;
      if (this.carrying === prop) this.drop();
      if (this.aimed === prop) this.aimed = null;
      this.playerHitCooldown.delete(prop);
      this.physics.removeRigidBody(prop.body);
      prop.mesh.removeFromParent();
      prop.mesh.traverse(node => {
        if (node instanceof THREE.Mesh || node instanceof THREE.LineSegments) {
          node.geometry.dispose();
          if (!Array.isArray(node.material)) node.material.dispose();
        }
      });
      this.props.splice(i, 1);
    }
  }

  adjustDistance(delta:number) { if(this.carrying)this.grabDistance=THREE.MathUtils.clamp(this.grabDistance+delta*.008,2,GRAB_REACH); }


  private readonly constrainedPosition = new THREE.Vector3();
  private readonly constrainedVelocity = new THREE.Vector3();

  update(dt:number,camera:THREE.PerspectiveCamera,player:Player,
    constrain?: (from: THREE.Vector3, to: THREE.Vector3, velocity: THREE.Vector3, radius: number) => boolean) {
    camera.getWorldDirection(this.forward);
    if(this.carrying) {
      this.target.copy(camera.position).addScaledVector(this.forward,this.grabDistance);
      // Preserve the grabbed surface point under the reticle; terrain/body contacts resist the pull.
      for(let d=.5;d<this.grabDistance;d+=.25) {
        this.center.copy(camera.position).addScaledVector(this.forward,d);
        if(this.world.spans(this.center.x,this.center.z).solid(this.center.y)) {this.target.copy(camera.position).addScaledVector(this.forward,Math.max(.6,d-.3));break;}
      }
      this.targetVelocity.subVectors(this.target,this.previousTarget).divideScalar(Math.max(dt,1/240)).clampLength(0,600);
      this.previousTarget.copy(this.target);
      this.carrying.moveHeld(this.target,this.targetVelocity,player.yaw);
      const point=this.carrying.grabPosition(this.center);
      if(point.distanceTo(this.target)>18)this.drop();
    }
    this.syncTerrain();
    this.accumulator=Math.min(.075,this.accumulator+dt);
    const speeds=new Map<CarryProp,number>();
    while(this.accumulator>=STEP) {
      for(const prop of this.props) {
        speeds.set(prop,prop.body.linvel().x**2+prop.body.linvel().y**2+prop.body.linvel().z**2);
        prop.body.resetForces(false);prop.body.resetTorques(false);prop.applyGrabForce();prop.applyRollingResistance(this.world);
      }
      this.physics.timestep=STEP;this.physics.step(this.events);
      if (constrain) for (const prop of this.props) {
        this.constrainedPosition.copy(prop.body.translation());
        this.constrainedVelocity.copy(prop.body.linvel());
        if (!constrain(prop.pos, this.constrainedPosition, this.constrainedVelocity, prop.radius)) continue;
        prop.body.setTranslation(this.constrainedPosition, true);
        prop.body.setLinvel(this.constrainedVelocity, true);
      }
      this.events.drainCollisionEvents((a,b,started)=>{
        if(!started)return;
        const prop=this.props.find(p=>p.collider.handle===a||p.collider.handle===b);
        if(!prop)return;
        const speed=Math.sqrt(speeds.get(prop)??0);
        if(speed<5||(this.impactCooldown.get(prop)??0)>0)return;
        const ca=this.physics.getCollider(a),cb=this.physics.getCollider(b);
        const point=new THREE.Vector3().copy(prop.body.translation()),normal=new THREE.Vector3(0,1,0);
        if(ca&&cb)this.physics.contactPair(ca,cb,(manifold,flipped)=>{
          const contact=manifold.solverContactPoint(0);if(contact)point.copy(contact);
          normal.copy(manifold.normal());if(flipped)normal.negate();if(prop.collider.handle===a)normal.negate();
        });
        this.onImpact(speed,point);
        if(speed>28) this.world.crater(point,normal,Math.min(600,speed*1.15),this.world.materialAt(point.x,point.y-.1,point.z));
        this.impactCooldown.set(prop,.18);
      });
      this.accumulator-=STEP;
      for(const prop of this.props)prop.sync();
    }
    for(const prop of this.props) {
      this.impactCooldown.set(prop,Math.max(0,(this.impactCooldown.get(prop)??0)-dt));
      this.playerHitCooldown.set(prop,Math.max(0,(this.playerHitCooldown.get(prop)??0)-dt));
      prop.hitCooldown=Math.max(0,prop.hitCooldown-dt);
      prop.playerAttackTime=Math.max(0,prop.playerAttackTime-dt);
      if(prop.playerAttackTime===0)prop.attackSource=null;
      if(!prop.held&&prop.hitCooldown<=0&&prop.vel.length()>15) for(const fighter of [this.friend,...this.opponents]) {
        if(!fighter.model.visible || fighter.held)continue;
        this.center.copy(fighter.pos).y+=1;
        const projection=prop.collider.projectPoint(this.center,false);
        if(projection&&(projection.isInside||this.center.distanceTo(projection.point)<.65)) {
          fighter.strike(prop.vel.clone().normalize(),prop.vel.clone().multiplyScalar(.25),260,prop.attackSource?.team==="player",prop.vel.length(),1,prop.attackSource??{name:prop.name,team:"world",action:"throw"});prop.hitCooldown=.8;break;
        }
      }
    }
    this.resolvePlayer(player);
    this.lastPick=this.rayPick(camera.position,this.forward,GRAB_REACH);this.aimed=this.lastPick?.item??null;
  }

  private resolvePlayer(player:Player) {
    for(const prop of this.props) {
      if(prop.held||prop.pos.distanceTo(player.pos)>prop.radius+3)continue;
      for(const height of [.35,.95,1.55]) {
        this.center.copy(player.pos).y+=height;
        const projection=prop.collider.projectPoint(this.center,false);if(!projection)continue;
        const distance=this.center.distanceTo(projection.point);
        if(!projection.isInside&&distance>=.32)continue;
        const normal=projection.isInside?new THREE.Vector3().subVectors(projection.point,this.center):new THREE.Vector3().subVectors(this.center,projection.point);
        if(normal.lengthSq()<1e-8)normal.subVectors(player.pos,prop.pos).setY(0);
        normal.normalize();
        player.pos.addScaledVector(normal,projection.isInside?distance+.32:.32-distance);
        const incoming = prop.vel.dot(normal);
        if (incoming > 5 && (this.playerHitCooldown.get(prop) ?? 0) <= 0) {
          const remaining = this.onIncomingAttack(incoming,prop.attackSource??{name:prop.name,team:"world",action:"throw"});
          if (remaining > 0) {
            player.vel.addScaledVector(normal, incoming * 1.08 * remaining);
            this.onImpact(incoming * remaining, this.center);
          }
          this.playerHitCooldown.set(prop, .25);
        }
        const into=player.vel.dot(normal);
        if(into<0){
          prop.body.applyImpulseAtPoint(normal.clone().multiplyScalar(into*68),this.center,true);
          player.vel.addScaledVector(normal,-into*1.08);
          if(into< -5)this.onImpact(-into,this.center);
          if(into< -12 && (this.playerHitCooldown.get(prop)??0)<=0){this.onPlayerCollision(-into);this.playerHitCooldown.set(prop,.25);}
        }
      }
    }
  }

  /** The aimed-at or held item, for the HUD's icon prompt. */
  get prompt():{name:string;carrying:boolean;inPunchRange:boolean}|null {
    const item=this.carrying??this.aimed;if(!item)return null;
    return {name:item.name,carrying:this.carrying!==null,inPunchRange:(this.lastPick?.distance??Infinity)<=PUNCH_REACH};
  }
}
