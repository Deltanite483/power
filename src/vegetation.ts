import { Mat } from "./terrain/heightfield";
import type { RGB, VoxelModel, VoxelPart } from "./terrain/authored";

export interface Species {
  id: string; name: string; latin: string; height: number; crown: number;
  form: "spire" | "fir" | "broad" | "pine" | "larch" | "shrub";
  foliage: RGB;
}
// Species selection is informed by the Liechtenstein forest inventory and InfoFlora.
// Sizes and placement are procedural art ranges, not a survey of individual trees.
export const SPECIES: Species[] = [
  { id:"spruce",name:"Norway spruce",latin:"Picea abies",height:32,crown:5,form:"spire",foliage:[36,75,48] },
  { id:"fir",name:"Silver fir",latin:"Abies alba",height:34,crown:5.8,form:"fir",foliage:[39,79,66] },
  { id:"beech",name:"European beech",latin:"Fagus sylvatica",height:27,crown:8,form:"broad",foliage:[72,110,43] },
  { id:"maple",name:"Sycamore maple",latin:"Acer pseudoplatanus",height:25,crown:7,form:"broad",foliage:[88,123,52] },
  { id:"larch",name:"European larch",latin:"Larix decidua",height:29,crown:5.7,form:"larch",foliage:[105,133,55] },
  { id:"pine",name:"Scots pine",latin:"Pinus sylvestris",height:25,crown:6.8,form:"pine",foliage:[61,96,68] },
  { id:"hazel",name:"Common hazel",latin:"Corylus avellana",height:4.5,crown:2.7,form:"shrub",foliage:[82,118,48] },
  { id:"dogwood",name:"Common dogwood",latin:"Cornus sanguinea",height:3.2,crown:2.1,form:"shrub",foliage:[66,103,44] },
];

export function vegetationModels(): VoxelModel[] {
  return SPECIES.flatMap((species,index) => [0,1].map(variant => {
    const h=species.height*(variant ? .87:1), r=species.crown*(variant ? 1.12:1);
    const lean=(variant ? .085:-.025)*h;
    const stem=(x:number,y:number,z:number,tx:number,ty:number,tz:number,radius:number):VoxelPart => ({kind:"stem",x,z,y0:y,y1:ty,tx,tz,rx:radius,rz:radius,material:Mat.Wood});
    const leaf=(x:number,z:number,a:number,b:number,rx:number,rz=rx,kind:"ellipsoid"|"cone"="ellipsoid",tip=0):VoxelPart => ({kind,x,z,y0:a,y1:b,rx,rz,tip,material:Mat.Leaves});
    const near:VoxelPart[]=[],mid:VoxelPart[]=[],far:VoxelPart[]=[];
    const shrub=species.form==="shrub", broad=species.form==="broad" || shrub, pine=species.form==="pine";
    const trunk=stem(0,-.3,0,lean,h*(broad?.78:.92),lean*.25,shrub?.10:.27+h*.006);
    if(broad || pine) {
      const center=pine?.8:shrub?.51:.66, spread=shrub?1:pine?.78:.92;
      // Broadleaf variants have asymmetric lobes; pine has a high, open, irregular crown.
      for(let k=0;k<(shrub?5:7);k++) {
        const a=k*2.399+variant*.7, rad=r*(k===0?.1:spread*.54),x=Math.cos(a)*rad+lean*.75,z=Math.sin(a)*rad;
        const low=h*(center-.2)+(k%3)*h*.045, high=k===0?h:Math.min(h,low+h*(shrub?.58:.38));
        near.push(leaf(x,z,low,high,r*.56,r*(k%2?.53:.65)));
        near.push(stem(lean*.35,h*(shrub?.06:.38),0,x,low+(high-low)*.35,z,shrub?.065:.14));
      }
      mid.push(leaf(lean*.65,0,h*(pine?.58:shrub?.08:.42),h,r,r*.83));
      mid.push(leaf(lean*.65+r*.4,r*.25,h*.53,h*.91,r*.63,r*.56));
      far.push(leaf(lean*.65,0,h*(pine?.58:shrub?.08:.42),h,r,r*.9));
    } else {
      const fir=species.form==="fir",larch=species.form==="larch";
      const tiers=fir?7:6;
      for(let k=0;k<tiers;k++) {
        const t=k/(tiers-1),a=h*(.17+t*.66),b=Math.min(h,a+h*(fir?.26:.35));
        const width=r*(1-t*.85)*(variant&&k%2?.88:1);
        near.push(leaf(lean*(a/h),Math.sin(k+variant)*r*.055,a,b,width,width*(larch?.78:.92),"cone",fir?.24:0));
        if(k<tiers-1)for(let branch=0;branch<3;branch++) {
          const angle=k*1.7+branch*Math.PI*2/3;
          near.push(stem(lean*(a/h),a+.3,0,lean*(a/h)+Math.cos(angle)*width*.78,a+(larch?-.7:.2),Math.sin(angle)*width*.78,.085));
        }
      }
      mid.push(leaf(lean*.4,0,h*.17,h*.68,r,r*.92,"cone",fir?.26:0));
      mid.push(leaf(lean*.75,0,h*.52,h,r*.57,r*.52,"cone",fir?.12:0));
      far.push(leaf(lean*.5,0,h*.17,h,r,r*.92,"cone",fir?.08:0));
    }
    // Wood takes precedence inside foliage. All variants keep the same grounded trunk.
    near.push(trunk);mid.push(trunk);far.push(trunk);
    return {name:`${species.id}-${variant+1}`,radius:r*1.8+Math.abs(lean),height:h,lods:[near,mid,far],foliage:species.foliage};
  }));
}

export function speciesAt(elevation:number,random:number):number {
  if(elevation>1600)return random<.65?0:random<.9?4:5;
  if(elevation>1000)return random<.49?0:random<.66?1:random<.81?4:random<.94?3:2;
  return random<.29?0:random<.40?1:random<.68?2:random<.86?3:5;
}
