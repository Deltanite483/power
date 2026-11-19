import { Mat, verticalQuantum } from "./heightfield";

export type RGB = [number, number, number];
export interface VoxelPart {
  kind: "ellipsoid" | "cone" | "box" | "stem";
  x: number; z: number; y0: number; y1: number; rx: number; rz: number;
  // Stems connect (x,y0,z) to (tx,y1,tz), allowing diagonal trunks and branches.
  tx?: number; tz?: number; tip?: number;
  material: Mat;
}
export interface BuildingShape {
  polygon: [number, number][];
  footprints?: [[number, number][], [number, number][], [number, number][]];
  bottom: number; eaves: number; rise: number;
  halfX: number; halfZ: number;
  roof: "gable" | "hip" | "flat" | "shed";
  roofMaterial: Mat;
  wallColor: RGB;
  industrial: boolean;
  hollow?: boolean;
  eaveOverhang?: number;
}
export interface VoxelModel {
  name: string;
  radius: number;
  height: number;
  // Three reusable representations, evaluated directly by the voxel column sampler.
  lods: [VoxelPart[], VoxelPart[], VoxelPart[]];
  foliage?: RGB;
  building?: BuildingShape;
}
export interface VoxelInstance {
  model: number; x: number; y: number; z: number;
  yaw: number; scale: number;
}
export const sceneryLOD = (s: number): 0 | 1 | 2 => s <= 0.5 ? 0 : s <= 2 ? 1 : 2;
/** Coarsest voxel size that still voxelises trees; beyond it the instanced and impostor tree layers draw them. */
export const TREE_VOXEL_MAX = 1;

export function inFootprint(x: number, z: number, points: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]) inside = !inside;
  }
  return inside;
}

/** Euclidean distance to a polygon boundary, used to keep spawns and plants clear of facades. */
export function footprintDistance(x:number,z:number,polygon:[number,number][]):number {
  let distance=Infinity;
  for(let j=0;j<polygon.length;j++){
    const a=polygon[j],b=polygon[(j+1)%polygon.length],dx=b[0]-a[0],dz=b[1]-a[1];
    const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz||1)));
    distance=Math.min(distance,Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz));
  }
  return distance;
}

export function roofHeight(b: BuildingShape, x: number, z: number): number {
  const v = Math.max(0, 1 - Math.abs(z) / Math.max(0.1,b.halfZ));
  const u = Math.max(0, 1 - Math.abs(x) / Math.max(0.1,b.halfX));
  return b.eaves + b.rise * (b.roof === "gable" ? v : b.roof === "hip" ? Math.min(u,v) : b.roof === "shed" ? Math.max(0, Math.min(1, (z/b.halfZ+1)/2)) : 1);
}

function facade(b: BuildingShape, x: number, z: number, depth: number): "door" | "window" | null {
  for (let edge = 0; edge < b.polygon.length; edge++) {
    const a = b.polygon[edge], c = b.polygon[(edge + 1) % b.polygon.length];
    const ex = c[0] - a[0], ez = c[1] - a[1], length = Math.hypot(ex, ez);
    if (length < 1.2) continue;
    const along = ((x - a[0]) * ex + (z - a[1]) * ez) / length;
    const distance = Math.abs(ex * (z - a[1]) - ez * (x - a[0])) / length;
    if (distance > depth || along < .6 || along > length - .6) continue;
    if (edge === 0 && Math.abs(along - length * .5) < .7) return "door";
    const bay = along % (b.industrial ? 4.4 : 2.8);
    if (bay > .65 && bay < (b.industrial ? 3.7 : 1.9)) return "window";
  }
  return null;
}

/** Shared by terrain workers, physics and destruction. Instancing only shares source data;
 * visible geometry is always produced by the terrain's voxel mesher. */
export class AuthoredVoxels {
  private cells = new Map<string, number[]>();
  private cosine: Float64Array;
  private sine: Float64Array;
  // Column results are immutable source geometry. Damage is applied afterwards by columnSpans.
  private columnCache = new Map<number, { low: Float64Array; high: Float64Array; source: Int32Array; material: Uint8Array }>();
  private cachedIntervals = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private lastSize = NaN;
  private lastSolid = false;
  private intervalResult: [number,number] = [0,0];
  stats = { cacheHits: 0, cacheMisses: 0 };
  count = 0;
  readonly low = new Float64Array(256);
  readonly high = new Float64Array(256);
  private source = new Int32Array(256);
  private material = new Uint8Array(256);
  constructor(readonly models: VoxelModel[], readonly instances: VoxelInstance[]) {
    this.cosine = new Float64Array(instances.length);
    this.sine = new Float64Array(instances.length);
    instances.forEach((instance,id) => {
      this.cosine[id] = Math.cos(instance.yaw); this.sine[id] = Math.sin(instance.yaw);
      const r = models[instance.model].radius * instance.scale;
      for (let x = Math.floor((instance.x-r)/32); x <= Math.floor((instance.x+r)/32); x++)
        for (let z = Math.floor((instance.z-r)/32); z <= Math.floor((instance.z+r)/32); z++) {
          const key = `${x}:${z}`, list = this.cells.get(key);
          if (list) list.push(id); else this.cells.set(key,[id]);
        }
    });
  }
  at(x: number, z: number): readonly number[] | undefined { return this.cells.get(`${Math.floor(x/32)}:${Math.floor(z/32)}`); }

  /** Conservative local height for quadtree refinement near roofs and treetops. */
  heightNear(x:number,z:number):number {
    let top=-Infinity;
    for(const id of this.at(x,z)??[]){const i=this.instances[id];top=Math.max(top,i.y+this.models[i.model].height*i.scale);}
    return top;
  }

  private result(low:number,high:number):[number,number] {
    this.intervalResult[0]=low;this.intervalResult[1]=high;return this.intervalResult;
  }

  private interval(p: VoxelPart, x: number, z: number): [number,number] | null {
    const dx=x-p.x, dz=z-p.z;
    if (p.kind === "stem") {
      const ax=(p.tx ?? p.x)-p.x, ay=p.y1-p.y0, az=(p.tz ?? p.z)-p.z;
      const len2=ax*ax+ay*ay+az*az;
      if (len2 < 1e-9) return null;
      // Intersect a vertical line with a finite, arbitrarily angled cylinder.
      const dot=dx*ax+dz*az;
      const a=1-ay*ay/len2, b=-2*dot*ay/len2, c=dx*dx+dz*dz-dot*dot/len2-p.rx*p.rx;
      let l=-1e6,h=1e6;
      if (a < 1e-10) { if (c>0) return null; }
      else { const disc=b*b-4*a*c; if (disc<0) return null; const r=Math.sqrt(disc); l=(-b-r)/(2*a); h=(-b+r)/(2*a); }
      if (Math.abs(ay)>1e-9) { const t0=-dot/ay,t1=(len2-dot)/ay; l=Math.max(l,Math.min(t0,t1));h=Math.min(h,Math.max(t0,t1)); }
      else if (dot<0 || dot>len2) return null;
      return h>l ? this.result(p.y0+l,p.y0+h) : null;
    }
    const r2=(dx/p.rx)**2+(dz/p.rz)**2;
    if (p.kind === "box") return Math.abs(dx)<=p.rx && Math.abs(dz)<=p.rz ? this.result(p.y0,p.y1) : null;
    if (r2>=1) return null;
    if (p.kind === "cone") {
      const tip=p.tip ?? 0, f=tip>=0.999 ? 1 : Math.min(1,(1-Math.sqrt(r2))/(1-tip));
      return this.result(p.y0,p.y0+(p.y1-p.y0)*f);
    }
    const half=(p.y1-p.y0)/2, center=(p.y1+p.y0)/2, dy=half*Math.sqrt(1-r2);
    return this.result(center-dy,center+dy);
  }

  column(x: number, z: number, s: number, solidOnly = false): this {
    if(x===this.lastX && z===this.lastZ && s===this.lastSize && solidOnly===this.lastSolid){this.stats.cacheHits++;return this;}
    this.lastX=x;this.lastZ=z;this.lastSize=s;this.lastSolid=solidOnly;
    this.count=0;
    const list=this.at(x,z); if (!list) return this;
    const levelKey=Math.log2(s/.125),ix=x*16+1048576,iz=z*16+1048576;
    const cacheable=Number.isInteger(ix) && Number.isInteger(iz) && Number.isInteger(levelKey) && ix>=0 && ix<2097152 && iz>=0 && iz<2097152;
    const cacheKey=ix*2097152+iz+(levelKey+(solidOnly?32:0))*4398046511104;
    const cached=cacheable?this.columnCache.get(cacheKey):undefined;
    if(cached){this.count=cached.low.length;this.low.set(cached.low);this.high.set(cached.high);this.source.set(cached.source);this.material.set(cached.material);this.stats.cacheHits++;return this;}
    this.stats.cacheMisses++;
    const q=verticalQuantum(s), level=sceneryLOD(s);
    let sourceId=-1;
    const push=(lo: number,hi: number,material=255) => { if (this.count>=256) return;lo=Math.round(lo/q)*q;hi=Math.round(hi/q)*q;if(hi<=lo)return;this.source[this.count]=sourceId;this.material[this.count]=material;this.low[this.count]=lo;this.high[this.count++]=hi; };
    for (const id of list) {
      sourceId=id;
      const i=this.instances[id], m=this.models[i.model], co=this.cosine[id],si=this.sine[id];
      if (m.foliage && s > TREE_VOXEL_MAX) continue;
      const dx=(x-i.x)/i.scale,dz=(z-i.z)/i.scale,lx=dx*co+dz*si,lz=-dx*si+dz*co;
      if (lx*lx+lz*lz > m.radius*m.radius) continue;
      const b = m.building;
      const inside = b && inFootprint(lx, lz, b.footprints?.[level] ?? b.polygon);
      if (b && inside) {
        const top=roofHeight(b,lx,lz);
        const wall=b.hollow && level===0 ? footprintDistance(lx,lz,b.polygon)<=.5 : true;
        let doorway=false;
        if(wall && b.hollow && level===0){
          const a=b.polygon[0],c=b.polygon[1],ex=c[0]-a[0],ez=c[1]-a[1],len=Math.hypot(ex,ez);
          const along=((lx-a[0])*ex+(lz-a[1])*ez)/len;
          const dist=Math.abs(ex*(lz-a[1])-ez*(lx-a[0]))/len;
          doorway=dist<=.55 && Math.abs(along-len*.5)<.8;
        }
        if (wall && !doorway) {
          let sill = b.bottom;
          // Leave a solid glass column behind the reveal in the same editable voxel wall.
          if (b.eaveOverhang && s <= .25 && facade(b, lx, lz, .21) === "window") {
            for (let floor = 0; floor + 2.4 < b.eaves - .15; floor += 3.2) {
              push(i.y + sill * i.scale, i.y + (floor + 1.05) * i.scale);
              sill = floor + 2.4;
            }
          }
          push(i.y + sill * i.scale, i.y + top * i.scale);
        }
        else {
          const slab=Math.max(.25,s/i.scale), roofSlab=Math.max(.35,s/i.scale);
          push(i.y+b.bottom*i.scale,i.y+slab*i.scale);
          for(let floor=3.2;floor<b.eaves-.6;floor+=3.2)push(i.y+floor*i.scale,i.y+(floor+slab)*i.scale);
          push(i.y+(top-roofSlab)*i.scale,i.y+top*i.scale);
          if(doorway)push(i.y+2.6*i.scale,i.y+top*i.scale);
        }
      } else if (b?.eaveOverhang && s <= .5 && footprintDistance(lx, lz, b.polygon) <= b.eaveOverhang) {
        const top = roofHeight(b, lx, lz);
        push(i.y + (top - .5) * i.scale, i.y + top * i.scale, b.roofMaterial);
      }
      if (b && !inside) continue;
      for (const p of m.lods[level]) { if(solidOnly && p.material===Mat.Leaves)continue; const hit=this.interval(p,lx,lz);if(hit)push(i.y+hit[0]*i.scale,i.y+hit[1]*i.scale,p.material); }
    }
    if(!cacheable)return this;
    // Bound cache memory, retaining commonly sampled neighborhoods across edit remeshes.
    while(this.columnCache.size>=16384 || this.cachedIntervals+this.count>131072){
      const key=this.columnCache.keys().next().value;
      if(key===undefined)break;
      const old=this.columnCache.get(key)!;this.cachedIntervals-=old.low.length;this.columnCache.delete(key);
    }
    this.columnCache.set(cacheKey,{low:this.low.slice(0,this.count),high:this.high.slice(0,this.count),source:this.source.slice(0,this.count),material:this.material.slice(0,this.count)});
    this.cachedIntervals+=this.count;
    return this;
  }

  materialAt(x: number, y: number, z: number, s: number): Mat | null {
    this.column(x,z,s);
    const level=sceneryLOD(s);
    for(let n=this.count-1;n>=0;n--){
      if(y<this.low[n]-.01 || y>this.high[n]+.01)continue;
      if(this.material[n]!==255)return this.material[n];
      const id=this.source[n],i=this.instances[id],m=this.models[i.model],b=m.building!;
      const co=this.cosine[id],si=this.sine[id],dx=(x-i.x)/i.scale,dz=(z-i.z)/i.scale,lx=dx*co+dz*si,lz=-dx*si+dz*co,ly=(y-i.y)/i.scale;
      if(ly>=b.eaves-0.15)return b.roofMaterial;
      if(level===0 && ly>0.2) {
        // Windows and doors are material voxels in each facade, never overlay geometry.
        const opening = facade(b, lx, lz, b.eaveOverhang ? .5 : .42);
        if (opening === "door" && ly < 2.35) return Mat.Wood;
        const floor = ly % 3.2;
        if (opening && floor > 1.05 && floor < 2.4) return Mat.Glass;
      }
      return Mat.Concrete;
    }
    return null;
  }

  /** Material boundaries for exposed vertical faces, including window sills and lintels. */
  cuts(x: number,z: number,s: number,lo: number,hi: number,out: number[]) {
    this.column(x,z,s);
    const add=(v:number)=>{if(v>lo && v<hi)out.push(v);};
    for(let n=0;n<this.count;n++){add(this.low[n]);add(this.high[n]);}
    const list=this.at(x,z);if(!list)return;
    for(const id of list){const i=this.instances[id],b=this.models[i.model].building;if(!b)continue;
      add(i.y+b.eaves*i.scale);
      if(sceneryLOD(s)===0){for(let y=0;y<b.eaves;y+=3.2){add(i.y+(y+1.05)*i.scale);add(i.y+(y+2.4)*i.scale);}add(i.y+2.35*i.scale);}
      if (b.eaveOverhang) add(i.y + .9 * i.scale);
    }
  }

  colorAt(x:number,y:number,z:number,s:number,material:Mat,ground?:number): RGB | null {
    if(material!==Mat.Leaves && material!==Mat.Concrete)return null;
    const list=this.at(x,z);if(!list)return null;
    for(let n=list.length-1;n>=0;n--){const i=this.instances[list[n]],m=this.models[i.model];
      if((x-i.x)**2+(z-i.z)**2>m.radius*m.radius*i.scale*i.scale)continue;
      if(material===Mat.Leaves && m.foliage)return m.foliage;
      if (material === Mat.Concrete && m.building) {
        const b = m.building;
        const aboveGround = y - Math.max(i.y, ground ?? i.y);
        if (b.eaveOverhang && aboveGround < .9 * i.scale) {
          const [r, g, blue] = b.wallColor;
          return [r * .75, g * .77, blue * .80];
        }
        return b.wallColor;
      }
    }
    return null;
  }

  occupied(x:number,z:number,padding:number):boolean {
    const ids=new Set<number>();
    for(const dx of [-padding,0,padding])for(const dz of [-padding,0,padding])for(const id of this.at(x+dx,z+dz)??[])ids.add(id);
    for(const id of ids){const i=this.instances[id],m=this.models[i.model];
      const dx=(x-i.x)/i.scale,dz=(z-i.z)/i.scale,co=this.cosine[id],si=this.sine[id];
      if(m.building){const b=m.building;if(inFootprint(dx*co+dz*si,-dx*si+dz*co,b.polygon))return true;
        if(footprintDistance(dx*co+dz*si,-dx*si+dz*co,b.polygon)<padding/i.scale)return true;
      }else if(Math.hypot(dx,dz)<m.radius+padding/i.scale)return true;
    }
    return false;
  }
}
