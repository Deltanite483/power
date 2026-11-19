import type { CombatHit, HitAction } from "./combat-events";

export interface FeedEntry extends CombatHit { id: number; count: number; time: number }
/** Beam ticks share one row; discrete strikes always get their own entry. */
export class HitFeedModel {
  entries: FeedEntry[] = [];
  time = 0;
  private serial = 0;
  add(hit: CombatHit) {
    if (!Number.isFinite(hit.damage) || hit.damage <= 0) return;
    const recent = this.entries.find(e => e.source.action === "beam" && hit.source.action === "beam" && e.source.name === hit.source.name && e.source.team === hit.source.team && e.victim.name === hit.victim.name && e.victim.team === hit.victim.team && this.time-e.time < .6 && e.outcome === "hit");
    if (recent) {
      recent.damage += hit.damage; recent.count++; recent.time=this.time; recent.outcome=hit.outcome;
      this.entries.splice(this.entries.indexOf(recent),1); this.entries.unshift(recent);
    } else this.entries.unshift({...hit,source:{...hit.source},victim:{...hit.victim},id:++this.serial,count:1,time:this.time});
    this.entries.length=Math.min(6,this.entries.length);
  }
  update(dt: number) { this.time+=Math.max(0,dt); this.entries=this.entries.filter(e=>this.time-e.time<6); }
  clear() { this.entries=[]; }
}
const icons: Record<HitAction,string> = {
  kick:'M5 3h5l2 8 8 2 2 5-2 2h-9l-5-5zM14 4h7m-3-3 3 3-3 3',
  punch:'M3 15V9h4V6h3v3h3V5h3v4h4v7l-4 4H8zM7 10v4m3-4v4m3-4v4m3-4v4',
  uppercut:'M5 18h9v-6H9V8H5zM18 18V3m-4 4 4-4 4 4',
  slam:'M5 4h7v7H5zM16 3v12m-4-4 4 4 4-4M3 21h18M7 18l-2-3m12 3 2-3',
  smash:'m3 3 7 7m-7 0h7V3m1 10-3 8 7-4 6 3-2-8-6 3z',
  beam:'M2 8h5v8H2zM9 10h13M9 14h13m-5-8 3-3m-3 15 3 3',
  nova:'m12 2 2 6 6-4-3 7 5 3-7 1 1 7-5-5-7 4 3-7-5-3 7-2z',
  snatch:'M3 20 18 5m-7 0h7v7M3 12V7m4 9V9m-4 8 5 4h5l4-5',
  throw:'M2 19C5 4 13 2 21 7m-7-4 7 4-5 6M5 17l4 2-2 4-4-2z',
  impact:'m12 3 2 6 6-3-3 6 5 3-7 1-2 6-3-6-7 2 5-6-4-4 6 1z',
  ram:'M3 8h7v8H3zM14 8h7v8h-7zM12 3v3m0 12v3',
  fuga:'M12 2C22 12 20 21 12 22C4 22 3 15 8 10L10 15Z', "black-flash":'M13 2L5 13H11L10 22L20 10H14Z',
  "world-slash":'M12 1V23M9 5L15 9M9 15L15 19',
  blue:'M3 12h6m-3-3 3 3-3 3m15-3h-6m3-3-3 3 3 3M12 10v4',
  "maximum-blue":'M2 7l5 5-5 5m20-10-5 5 5 5M8 12a4 4 0 1 0 8 0 4 4 0 0 0-8 0z',
  red:'M10 12h-7m3-3-3 3 3 3m8-3h7m-3-3 3 3-3 3M12 10v4',
  purple:'M2 15c4-6 16-6 20-1M2 10c5 6 15 6 20-1M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  "amplified-purple":'M2 6l4 3M2 18l4-3M22 6l-4 3m4 9-4-3M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 9v6m-3-3h6',
  "remote-purple":'M12 2v4m0 12v4M2 12h4m12 0h4M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM12 9v6m-3-3h6',
  void:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM7 13c3-5 7-5 10 0-3 3-7 3-10 0zM12 11v4',
  dismantle:'M2 17L22 7', cleave:'M4 20L20 4M3 14L14 3', shrine:'M3 9L12 3L21 9M5 9H19M7 9V21M17 9V21M3 21H21',
  "blue-melee":'M4 15h9l4-4-4-4H8l-4 3zM20 6v12m-3-3 3 3 3-3',
  "red-melee":'M3 15h8l4-4-3-4H7l-4 3zM17 6l5-3m-4 9h5m-6 6 5 3',
  shockwave:'M9 9a4 4 0 0 1 6 6M6 6a8 8 0 0 1 12 12M3 3a12 12 0 0 1 18 18M3 16l5-5 5 5-5 5z'
};
const labels: Record<HitAction,string> = {punch:"Punch",kick:"Kick",uppercut:"Uppercut",slam:"Downward slam",smash:"Charged smash",beam:"Energy beam",nova:"Energy blast",snatch:"Leap / drag attack",throw:"Thrown object",impact:"Collision",ram:"Double-fist ram",shockwave:"Shockwave",dismantle:"Dismantle",cleave:"Cleave",shrine:"Malevolent Shrine",fuga:"Fuga","black-flash":"Black Flash","world-slash":"World-cutting slash",blue:"Blue","maximum-blue":"Maximum Output Blue",red:"Red",purple:"Hollow Purple","amplified-purple":"200% Hollow Purple","remote-purple":"Remote Hollow Purple",void:"Unlimited Void","blue-melee":"Blue-enhanced strike","red-melee":"Red-enhanced strike"};
export class HitFeed {
  readonly model=new HitFeedModel();
  private signature="";
  constructor(private root: HTMLElement) { root.classList.add("hit-feed"); root.setAttribute("aria-label","Combat hit log"); }
  add(hit: CombatHit) { this.model.add(hit); this.render(); }
  clear() { this.model.clear(); this.render(); }
  update(dt:number,visible=true) {
    this.root.hidden=!visible; this.model.update(dt); this.render();
    for(const row of this.root.children) { const entry=this.model.entries.find(e=>String(e.id)===(row as HTMLElement).dataset.id)!; (row as HTMLElement).style.opacity=String(Math.min(1,(6-this.model.time+entry.time)/.6)); }
  }
  private render() {
    const signature=this.model.entries.map(e=>`${e.id}:${e.count}:${e.damage}:${e.outcome}`).join("|");
    if(signature===this.signature)return; this.signature=signature;
    this.root.replaceChildren(...this.model.entries.map(e=>{
      const row=document.createElement("div"); row.className="hit-feed-row";row.dataset.id=String(e.id);
      if(e.source.team==="player" || e.victim.team==="player")row.classList.add("personal");
      const name=(text:string,team:string)=>{const el=document.createElement("b");el.className=`hit-team-${team}`;el.textContent=text;return el;};
      const icon=document.createElement("span");icon.className="hit-action";icon.title=labels[e.source.action];icon.setAttribute("aria-label",labels[e.source.action]);
      icon.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[e.source.action]}"/></svg>`;
      const damage=document.createElement("small");damage.className="hit-damage";damage.textContent=`−${e.source.action === "void" ? Number(e.damage.toFixed(2)) : e.damage<1?e.damage.toFixed(1):Math.round(e.damage)}${e.count>1?` ×${e.count}`:""}`;
      row.append(name(e.source.name,e.source.team),icon,name(e.victim.name,e.victim.team),damage);
      if(e.outcome!=="hit"){const tag=document.createElement("span");tag.className=`hit-outcome ${e.outcome}`;tag.textContent=e.outcome==="down"?"DOWN":"OUT";row.append(tag);}
      return row;
    }));
  }
}
