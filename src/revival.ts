import type * as THREE from 'three';
import type {Vitality} from './vitality';

export const REVIVE_TIME=2.2;
export interface RescueUnit {
  id:string;
  enemy:boolean;
  pos:THREE.Vector3;
  vitals:Vitality;
  canHelp:boolean;
  rescuePriority?:number;
  maxDistance:number;
  groundOnly?:boolean;
  manual?:boolean;
  canBeHelped?:boolean;
  canReach:(other:RescueUnit)=>boolean;
  setGoal:(other:RescueUnit|null)=>void;
  revive:()=>boolean;
  persistentRevive?:()=>boolean;
}
interface Rescue {helper:string;victim:string;progress:number;injury:number;}

/** One helper per casualty. Arrive, hold contact, and restart aid if the helper takes damage. */
export class RevivalSystem {
  private rescues:Rescue[]=[];
  progressFor(id:string) { return this.rescues.find(r=>r.victim===id)?.progress ?? 0; }
  helperFor(id:string) { return this.rescues.find(r=>r.victim===id)?.helper ?? null; }
  targetFor(id:string) { return this.rescues.find(r=>r.helper===id)?.victim ?? null; }
  clear(){this.rescues=[];}

  update(dt:number,units:RescueUnit[]){
    const byId=new Map(units.map(unit=>[unit.id,unit]));
    const eligible=(helper:RescueUnit|undefined,victim:RescueUnit|undefined)=>!!helper && !!victim
      && helper!==victim && helper.canHelp && !helper.vitals.defeated && victim.vitals.downed
      && victim.canBeHelped!==false
      && helper.enemy===victim.enemy && helper.pos.distanceTo(victim.pos)<=helper.maxDistance
      && (!helper.groundOnly || victim.pos.y-helper.pos.y<8);
    this.rescues=this.rescues.filter(r=>{
      const helper=byId.get(r.helper),victim=byId.get(r.victim);
      if(!eligible(helper,victim))return false;
      return helper!.manual || !units.some(unit=>unit.manual && eligible(unit,victim) && unit.pos.distanceTo(victim!.pos)<=3.5 && unit.canReach(victim!));
    });
    const helpers=new Set(this.rescues.map(r=>r.helper)), victims=new Set(this.rescues.map(r=>r.victim));
    const choices:{helper:RescueUnit;victim:RescueUnit;distance:number}[]=[];
    for(const victim of units)if(victim.vitals.downed && !victims.has(victim.id))for(const helper of units)
      if(!helpers.has(helper.id) && eligible(helper,victim))choices.push({helper,victim,distance:helper.pos.distanceTo(victim.pos)});
    choices.sort((a,b)=>Number(!!b.helper.manual)-Number(!!a.helper.manual)
      || (b.helper.rescuePriority ?? 0)-(a.helper.rescuePriority ?? 0) || a.distance-b.distance);
    for(const {helper,victim} of choices){
      if(helpers.has(helper.id)||victims.has(victim.id))continue;
      this.rescues.push({helper:helper.id,victim:victim.id,progress:0,injury:helper.vitals.damageRevision});
      helpers.add(helper.id);victims.add(victim.id);
    }
    for(const unit of units)unit.setGoal(null);
    const completed=new Set<Rescue>();
    for(const rescue of this.rescues){
      const helper=byId.get(rescue.helper)!,victim=byId.get(rescue.victim)!;
      helper.setGoal(victim);
      const injured=helper.vitals.damageRevision!==rescue.injury;
      rescue.injury=helper.vitals.damageRevision;
      const touching=helper.pos.distanceTo(victim.pos)<=3.5 && helper.canReach(victim);
      rescue.progress=touching && !injured?Math.min(1,rescue.progress+Math.max(0,dt)/REVIVE_TIME):0;
      if(rescue.progress>=1){victim.revive();helper.setGoal(null);completed.add(rescue);}
    }
    this.rescues=this.rescues.filter(r=>!completed.has(r));
  }
}

/** Physical clicks only: holding the mouse cannot fill the player's recovery meter. */
export class SelfRevive {
  progress=0;
  private lastTap=-Infinity;
  reset(){this.progress=0;this.lastTap=-Infinity;}
  tap(now:number):boolean {
    if(now-this.lastTap<.055)return false;
    this.lastTap=now;this.progress=Math.min(1,this.progress+1/20);
    return this.progress>=1;
  }
  update(dt:number,now:number){
    if(now-this.lastTap>.8)this.progress=Math.max(0,this.progress-Math.max(0,dt)*.12);
  }
}

export const PERSISTENCE_DELAY=25;
/** Optional auto-return, set separately for your side (you + friends) and for foes. Independent of the revive budget. */
export class PersistenceMode {
  /** Your side: you and friendly fighters. */
  enabled=false;
  foes=false;
  private timers=new Map<string,number>();
  setEnabled(enabled:boolean){if(enabled!==this.enabled){this.enabled=enabled;this.clear();}}
  setFoes(enabled:boolean){if(enabled!==this.foes){this.foes=enabled;this.clear();}}
  covers(enemy:boolean){return enemy?this.foes:this.enabled;}
  clear(){this.timers.clear();}
  forget(id:string){this.timers.delete(id);}
  remainingFor(id:string){return this.timers.get(id)??PERSISTENCE_DELAY;}
  progressFor(id:string){return 1-this.remainingFor(id)/PERSISTENCE_DELAY;}
  update(dt:number,units:RescueUnit[]){
    if(!this.enabled && !this.foes){this.clear();return;}
    const valid=new Set<string>();
    for(const unit of units){
      if(!this.covers(unit.enemy) || !unit.vitals.defeated)continue;
      valid.add(unit.id);
      const remaining=Math.max(0,this.remainingFor(unit.id)-Math.max(0,dt));
      this.timers.set(unit.id,remaining);
      if(remaining<=1e-6){
        const revived=unit.persistentRevive?unit.persistentRevive():unit.vitals.revive(unit.vitals.maxHealth * .75,false);
        if(revived){this.timers.delete(unit.id);valid.delete(unit.id);}
      }
    }
    for(const id of this.timers.keys())if(!valid.has(id))this.timers.delete(id);
  }
}
