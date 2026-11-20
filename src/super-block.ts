export const SUPER_BLOCK_DURATION=5;
export const SUPER_BLOCK_COOLDOWN=1;
/** Cooldown begins when immunity expires. Time advances only during unpaused play. */
export class SuperBlock {
  private time=0;
  private activeUntil=0;
  private readyAt=0;
  get active(){return this.time<this.activeUntil;}
  get remaining(){return Math.max(0,this.activeUntil-this.time);}
  get cooldown(){return this.active?0:Math.max(0,this.readyAt-this.time);}
  activate(guarding:boolean,alive=true){
    if(!guarding || !alive || this.time<this.readyAt)return false;
    this.activeUntil=this.time+SUPER_BLOCK_DURATION;
    this.readyAt=this.activeUntil+SUPER_BLOCK_COOLDOWN;
    return true;
  }
  update(dt:number){if(Number.isFinite(dt))this.time+=Math.max(0,dt);}
  reset(){this.time=0;this.activeUntil=0;this.readyAt=0;}
}
