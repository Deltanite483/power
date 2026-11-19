import { Heightfield, Mat, slopeAt, surfaceMaterial, hashCol, vnoise, type TerrainData } from "./terrain/heightfield";
import { vegetationModels, speciesAt, SPECIES } from "./vegetation";
import { AuthoredVoxels, inFootprint, type VoxelModel, type VoxelInstance, type VoxelPart, type BuildingShape, type RGB } from "./terrain/authored";
import type { SceneryData } from "./scenery-types";
import type { MapId, Place } from "./terrain/data";

/** Author world voxels before workers start. There are no separate scenery meshes or colliders. */
export class Scenery {
  readonly buildings: { x0: number; z0: number; x1: number; z1: number; bottom: number; top: number }[] = [];
  readonly landmarks: Place[] = [];
  treeCount = 0;
  shrubCount = 0;
  cityTreeCount = 0;
  cityShrubCount = 0;
  readonly speciesCounts: Record<string, number> = {};
  readonly lods = { near: "0.125–0.5 m: windows, doors, chimneys, crown lobes and branches", medium: "1–2 m: roof and footprint, two crown masses and trunk", far: "4 m+: roof and footprint, one crown silhouette and trunk" };
  private constructor(readonly data: SceneryData) {}

  static async create(terrain: TerrainData, map: MapId = "vaduz"): Promise<Scenery> {
    const response = await fetch(`data/${map === "vaduz" ? "scenery" : map}.json`);
    if (!response.ok) throw new Error(`Neighborhood data: ${response.status}`);
    const scenery = new Scenery(await response.json());
    scenery.populate(terrain, map);
    return scenery;
  }

  private populate(terrain: TerrainData, map: MapId) {
    const ground = new Heightfield(terrain), roads: number[] = [];
    const models: VoxelModel[] = vegetationModels(), instances: VoxelInstance[] = [];
    const widths: Record<string, number> = { motorway: 16, motorway_link: 6, trunk: 9, primary: 8, secondary: 7.5, tertiary: 7, residential: 5.5, service: 4, living_street: 4, unclassified: 5.5, cycleway: 2.5, footway: 2, path: 1.8, track: 3 };
    for (const road of this.data.roads) {
      if (road.tunnel) continue;
      const half = Math.max(1.5, Math.min(20, parseFloat(road.width ?? "") || widths[road.kind] || 3)) / 2;
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1], b = road.points[i];
        if (map !== "manhattan-island" && Math.min(Math.hypot(...a), Math.hypot(...b)) > 4000) continue;
        roads.push(...a, ...b, half);
      }
    }
    terrain.roads = new Float32Array(roads);
    for (const building of this.data.buildings) {
      const points = building.points;
      if(points.length<3)continue;
      // Align the local frame with the longest mapped facade, preserving diagonal and concave outlines.
      let yaw=0,longest=0;
      for(let j=0;j<points.length;j++) {const a=points[j],b=points[(j+1)%points.length],len=Math.hypot(b[0]-a[0],b[1]-a[1]);if(len>longest){longest=len;yaw=Math.atan2(b[1]-a[1],b[0]-a[0]);}}
      const co=Math.cos(yaw),si=Math.sin(yaw),cx=points.reduce((sum,p)=>sum+p[0],0)/points.length,cz=points.reduce((sum,p)=>sum+p[1],0)/points.length;
      const local=points.map(([x,z])=>[(x-cx)*co+(z-cz)*si,-(x-cx)*si+(z-cz)*co] as [number,number]);
      const u0=Math.min(...local.map(p=>p[0])),u1=Math.max(...local.map(p=>p[0])),v0=Math.min(...local.map(p=>p[1])),v1=Math.max(...local.map(p=>p[1]));
      const uc=(u0+u1)/2,vc=(v0+v1)/2;
      const polygon=local.map(([u,v])=>[u-uc,v-vc] as [number,number]);
      const simplify=(tolerance:number) => {
        const result=polygon.map(p=>[...p] as [number,number]);
        let changed=true;
        while(changed && result.length>4){changed=false;for(let j=0;j<result.length;j++){
          const a=result[(j+result.length-1)%result.length],b=result[j],c=result[(j+1)%result.length],dx=c[0]-a[0],dz=c[1]-a[1];
          const t=Math.max(0,Math.min(1,((b[0]-a[0])*dx+(b[1]-a[1])*dz)/(dx*dx+dz*dz||1)));
          if(Math.hypot(b[0]-a[0]-dx*t,b[1]-a[1]-dz*t)<tolerance){result.splice(j,1);changed=true;break;}
        }}return result;
      };
      const elevations=points.map(([x,z])=>ground.height(x,z,.125)),elevation=Math.max(...elevations);
      const chapel = map === "vaduz" && building.kind === "chapel";
      const hall = map === "vaduz" && building.kind === "sports_hall";
      const industrial=["industrial","warehouse","commercial","school","university"].includes(building.kind) || (u1-u0)*(v1-v0)>850;
      const seed = hashCol(building.id, 43);
      const mappedHeight = parseFloat(building.height ?? "") || (parseFloat(building.levels ?? "") || (industrial ? 2 : 2 + Math.floor(seed * 2))) * 3.2;
      // Compress the skyline above the hollow-building height limit while keeping taller landmarks distinct.
      const height = map === "manhattan-island" && mappedHeight > 60
        ? 60 + 100 * (1 - Math.exp(-(mappedHeight - 60) / 150))
        : Math.max(4, Math.min(60, mappedHeight));
      const roof: BuildingShape["roof"] = building.roof==="hipped"?"hip":building.roof==="skillion"?"shed":building.roof==="flat"?"flat":building.roof==="gabled"?"gable":chapel?"gable":industrial?"flat":seed<.55?"gable":seed<.88?"hip":"shed";
      const rise=roof==="flat"?.3:Math.min(5,Math.max(1.2,(v1-v0)*.38));
      const wallColors: RGB[] = [[188,181,166],[207,201,184],[179,176,165],[201,186,159],[176,184,183],[213,207,194]];
      const shape: BuildingShape={polygon,footprints:[polygon,simplify(.25),simplify(.8)],bottom:Math.min(...elevations)-elevation-1,eaves:Math.max(3.2,height-rise),rise,halfX:(u1-u0)/2,halfZ:(v1-v0)/2,roof,roofMaterial:industrial || seed>.7?Mat.RoofSlate:Mat.RoofTile,wallColor:wallColors[Math.floor(seed*wallColors.length)],industrial,hollow:height<=60};
      if (map === "vaduz") shape.eaveOverhang = industrial ? .38 : .58;
      const ridge = shape.eaves + rise;
      const landmarkParts: VoxelPart[] = [];
      if (chapel) {
        const towerX = inFootprint(-shape.halfX * .45, 0, polygon) ? -shape.halfX * .45 : 0;
        shape.wallColor = [224, 214, 193];
        shape.roofMaterial = Mat.RoofSlate;
        landmarkParts.push(
          { kind: "box", x: towerX, z: 0, y0: shape.eaves, y1: ridge + 3.2, rx: 1.65, rz: 1.65, material: Mat.Concrete },
          { kind: "cone", x: towerX, z: 0, y0: ridge + 3.2, y1: ridge + 7, rx: 2.1, rz: 2.1, tip: .08, material: Mat.RoofSlate },
        );
      } else if (hall) {
        shape.wallColor = [193, 169, 142];
        const rx = Math.min(11, shape.halfX * .4), rz = Math.min(4, shape.halfZ * .26);
        if ([-rx, rx].every(x => [-rz, rz].every(z => inFootprint(x, z, polygon)))) {
          landmarkParts.push(
            { kind: "box", x: 0, z: 0, y0: ridge - .3, y1: ridge + 1.5, rx, rz, material: Mat.Glass },
            { kind: "box", x: 0, z: 0, y0: ridge + 1.5, y1: ridge + 2, rx: rx + .35, rz: rz + .35, material: Mat.RoofSlate },
          );
        }
      }
      const chimney: VoxelPart[] = !chapel && !industrial && (u1-u0)>5 && (v1-v0)>5 ? [{kind:"box",x:(u1-u0)*.2,z:0,y0:shape.eaves+rise*.65,y1:ridge+1,rx:.45,rz:.45,material:Mat.Concrete}] : [];
      const top = Math.max(ridge + 1, ...landmarkParts.map(part => part.y1));
      const id=models.length;
      models.push({name:`building-${building.id}`,radius:Math.max(...polygon.map(p=>Math.hypot(...p)))+1,height:top,lods:[[...chimney, ...landmarkParts],landmarkParts,landmarkParts],building:shape});
      const x = cx + uc * co - vc * si, z = cz + uc * si + vc * co;
      instances.push({model:id,x,y:elevation,z,yaw,scale:1});
      if ((chapel || hall) && building.name) this.landmarks.push({ name: building.name, kind: "landmark", tier: 1, x, z, ele: elevation + top, municipality: false });
      this.buildings.push({x0:Math.min(...points.map(p=>p[0])),z0:Math.min(...points.map(p=>p[1])),x1:Math.max(...points.map(p=>p[0])),z1:Math.max(...points.map(p=>p[1])),bottom:Math.min(...elevations)-1,top:elevation+shape.eaves+rise});
    }
    terrain.models = models;
    terrain.instances = instances;
    if (map !== "vaduz") return;

    // Copy references to the same sixteen plant models; only transforms vary per instance.
    const roadSampler = new Heightfield(terrain);
    const buildingInstances = instances.slice();
    const buildingIndex = new AuthoredVoxels(models,buildingInstances);
    const clear = (x:number,z:number,r:number) => !roadSampler.paintedRoad(x,z,r+1) && !buildingIndex.occupied(x,z,r+2);
    const plantCells = new Map<string,{x:number,z:number,r:number}[]>();
    const spaced=(x:number,z:number,r:number)=>{
      const cx=Math.floor(x/16),cz=Math.floor(z/16);
      for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)for(const p of plantCells.get(`${cx+dx}:${cz+dz}`)??[])if(Math.hypot(x-p.x,z-p.z)<r+p.r)return false;
      return true;
    };

    const plant = (species:number,x:number,z:number,y:number,seed:number,scale:number) => {
      const variant=seed<.5?0:1;
      const key=`${Math.floor(x/16)}:${Math.floor(z/16)}`,list=plantCells.get(key)??[];
      list.push({x,z,r:species>=6?1.3:3});plantCells.set(key,list);
      instances.push({model:species*2+variant,x,y,z,yaw:hashCol(x+421,z-81)*Math.PI*2,scale});
      this.speciesCounts[SPECIES[species].id]=(this.speciesCounts[SPECIES[species].id]??0)+1;
      if(species>=6)this.shrubCount++;else this.treeCount++;
    };
    // Forest stands: closed canopy on a jittered grid, thinned by stand-scale noise into stands, glades and
    // shrubby edges. A stand shares its species mix and age, so from the air it reads as a patchwork, not a sprinkle.
    const SPACING=8, smooth=(a:number,b:number,v:number)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*(3-2*t);};
    for (let x=-3000;x<3000;x+=SPACING)for(let z=-3000;z<3000;z+=SPACING) {
      const px=x+(hashCol(x,z)-.5)*SPACING*.6,pz=z+(hashCol(z+71,x)-.5)*SPACING*.6;
      const coarse=ground.height(px,pz,10),slope=slopeAt(ground,px,pz,10);
      if(coarse>1880 || ground.waterAt(px,pz)>.15 || slope>.85)continue;
      const biome=surfaceMaterial(coarse,slope,false,px,pz),seed=hashCol(px+33,pz);
      const stand=vnoise(px/140+3,pz/140-7),glade=vnoise(px/45-11,pz/45+5);
      const density=biome===Mat.Forest ? smooth(.22,.4,stand)*(glade<.16?.12:.97) : coarse<1250 && biome===Mat.Meadow ? .025 : 0;
      if(seed>=density || !clear(px,pz,2.5))continue;
      const y=ground.height(px,pz,.125);
      if(biome===Mat.Forest && stand<.3 && hashCol(px-7,pz+3)<.4 && y<1550){plant(seed<density*.5?6:7,px,pz,y,seed,.8+hashCol(px,pz+9)*.6);continue;}
      // mostly the stand's mix, a fifth left to chance; age varies by stand, a little by tree
      const mix=vnoise(px/220+40,pz/220-13)*.8+hashCol(px-19,pz+47)*.2;
      const age=vnoise(px/300-5,pz/300+8);
      plant(speciesAt(y,mix),px,pz,y,seed,.58+age*.42+(hashCol(px+61,pz)-.5)*.12);
    }
    // Plant both verges by distance along each street, independent of OSM node spacing.
    const cityPlant=(x:number,z:number,shrub:boolean)=>{
      if(Math.hypot(x,z)>1500 || !spaced(x,z,shrub?1.4:3.5) || !clear(x,z,shrub?1:2.3))return;
      const y=ground.height(x,z,.125);
      if(ground.waterAt(x,z)>.15 || slopeAt(ground,x,z,10)>.4)return;
      const seed=hashCol(x,z);
      plant(shrub?(seed<.5?6:7):(seed<.65?3:2),x,z,y,seed,shrub?.65+seed*.3:.34+seed*.2);
      if(shrub)this.cityShrubCount++;else this.cityTreeCount++;
    };
    for(const road of this.data.roads){
      if(!["residential","service","living_street","tertiary","secondary","unclassified"].includes(road.kind) || road.bridge || road.tunnel)continue;
      const half=Math.max(1.5,Math.min(20,parseFloat(road.width??"")||widths[road.kind]||4))/2;
      let untilNext=8+hashCol(road.id,17)*10;
      for(let n=1;n<road.points.length;n++){
        const a=road.points[n-1],b=road.points[n],dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);
        if(length<.01)continue;
        for(;untilNext<length;untilNext+=21){
          const x=a[0]+dx*untilNext/length,z=a[1]+dz*untilNext/length;
          for(const side of [-1,1]){
            const offset=half+5.2;
            cityPlant(x-dz/length*offset*side,z+dx/length*offset*side,false);
            if(hashCol(x+side,z)>.4)cityPlant(x-dz/length*(offset+1.5)*side+dx/length*6,z+dx/length*(offset+1.5)*side+dz/length*6,true);
          }
        }
        untilNext-=length;
      }
    }
    // Courtyards and open town green spaces get small groups without filling roads or buildings.
    for(let x=-1200;x<=1200;x+=36)for(let z=-1200;z<=1200;z+=36){
      const seed=hashCol(x+89,z-53);if(seed<.72)continue;
      const px=x+seed*20,pz=z+hashCol(z,x)*20,y=ground.height(px,pz,10);
      if(y>750)continue;
      cityPlant(px,pz,false);
      if(seed>.9)cityPlant(px+6,pz-5,true);
    }
  }

  findClearPoint(hf: Heightfield, x: number, z: number, radius = 5): { x: number; y: number; z: number } {
    for (let ring = 0; ring <= 30; ring++) for (let step = 0; step < (ring ? 32 : 1); step++) {
      const a = step / 32 * Math.PI * 2, px = x + Math.cos(a)*ring*6, pz = z + Math.sin(a)*ring*6;
      const d = hf.boxes;
      let occupied = false;
      for (const dx of [-radius,0,radius]) for (const dz of [-radius,0,radius]) {
        const nearby = hf.volumesAt(px+dx,pz+dz);
        if (nearby?.some(o => px >= d[o]-radius && px <= d[o+3]+radius && pz >= d[o+2]-radius && pz <= d[o+5]+radius)) occupied = true;
      }
      if (occupied || hf.authored.occupied(px,pz,radius)) continue;
      if (hf.waterAt(px,pz) > 0.2 || slopeAt(hf,px,pz,10) > 0.35) continue;
      return { x: px, y: Math.round(hf.height(px,pz,0.125)*8)/8, z: pz };
    }
    throw new Error("No clear spawn point near the campus");
  }
}
