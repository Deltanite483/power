import * as THREE from "three";
import {Sculpt,Skin} from "./fighter-mesh";

/** Camera-space front kick: draw the knee up while charging, extend the boot on release. */
export class KickView {
  readonly group=new THREE.Group();
  private readonly thigh=new THREE.Group();
  private readonly shin=new THREE.Group();
  private strikeTime=-1;
  private power=0;
  private readonly material:THREE.MeshStandardMaterial;
  private time=0;
  constructor(camera:THREE.PerspectiveCamera){
    // A sculpted thigh and shin in the white suit, ending in a dark boot with a tread.
    const [SUIT,BOOT,SOLE,SEAM]=[0,1,2,3];
    const skin=new Skin([{color:0xe9e6df,rough:.55,metal:.05},{color:0x292e36,rough:.5,metal:.25},{color:0x11161d,rough:.8},{color:0x9aa3ad,rough:.5,metal:.2}],.25);
    skin.material.fog=false;this.material=skin.material;
    const s=new Sculpt(skin);
    s.tube(this.thigh,(angle)=>Math.abs(Math.abs(angle)-Math.PI/2)<.2?SEAM:SUIT,[[.02,.1,.105],[-.12,.105,.11],[-.3,.088,.092],[-.44,.074,.078]],{sectors:16,rows:3});
    s.ball(this.thigh,SUIT,0,-.43,.012,.076,.078,.08);
    this.shin.position.y=-.43;
    s.tube(this.shin,(_angle,t)=>t>.42?BOOT:t>.38?SEAM:SUIT,[[.02,.074,.078],[-.12,.082,.092,-.012],[-.3,.064,.07],[-.44,.058,.066]],{sectors:16,rows:3});
    s.tube(this.shin,BOOT,[[-.1,.07,.05],[.02,.078,.06],[.16,.08,.048],[.24,.06,.03]],{sectors:12,rows:2,at:[0,-.46,-.005],rot:[-Math.PI/2,0,0]});
    s.box(this.shin,SOLE,0,-.525,-.07,.165,.03,.34);
    for(let i=0;i<4;i++)s.box(this.shin,SOLE,0,-.545,.05-i*.08,.15,.014,.04);
    s.bake();
    this.thigh.add(this.shin);this.group.add(this.thigh);camera.add(this.group);this.group.visible=false;
  }
  cancelStrike() { this.strikeTime = -1; this.group.visible = false; }

  strike(power:number){this.strikeTime=0;this.power=power;this.pose(1,power);}
  private pose(extension:number,charge:number,snap=0){
    this.group.visible=true;
    // The knee chambers high and tight, the hip turns over as the boot drives out, and the leg shudders on contact.
    const tremble=Math.sin(this.time*52)*Math.max(0,charge)*.012*(1-extension), shudder=Math.sin(this.time*95)*snap;
    this.group.position.set(.18-extension*.05,-.52+extension*.05+tremble,-.3-extension*.27);
    this.group.rotation.set(shudder*.03,-.08-extension*.16,-.07-extension*.14+shudder*.04);
    this.thigh.rotation.x=1.05+extension*.48;
    this.shin.rotation.x=-1.65*(1-extension)-Math.sin(extension*Math.PI)*.12;
    this.material.emissive.setRGB(.95,.32,.04).multiplyScalar(Math.max(0,charge)*.65);
  }
  update(dt:number,charge:number){
    this.time+=dt;
    if(this.strikeTime>=0){
      this.strikeTime+=dt;
      if(this.strikeTime<.12)this.pose(1,this.power,1-this.strikeTime/.12);
      else if(this.strikeTime<.48)this.pose(1-THREE.MathUtils.smoothstep(this.strikeTime,.12,.48),this.power*(1-this.strikeTime/.48));
      else {this.strikeTime=-1;this.group.visible=false;}
    }else if(charge>=0)this.pose(.12+Math.min(1,charge)*.12,charge);
    else this.group.visible=false;
  }
}
