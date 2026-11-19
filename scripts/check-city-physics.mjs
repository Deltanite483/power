import assert from 'node:assert/strict';
import {createServer} from 'vite';
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
 const{Heightfield,Mat,MATERIALS}=await server.ssrLoadModule('/src/terrain/heightfield.ts');
 const{loadWorld}=await server.ssrLoadModule('/src/terrain/data.ts');
 const{Spans,Edits,CARVE,columnSpans}=await server.ssrLoadModule('/src/terrain/edits.ts');
 const{buildChunk}=await server.ssrLoadModule('/src/terrain/mesher.ts');
 const{vegetationModels}=await server.ssrLoadModule('/src/vegetation.ts');
 const manhattan=new Heightfield((await loadWorld('manhattan')).terrain);
 assert.equal(manhattan.height(0,0,4096),420,'The coarsest Manhattan tile must have a valid height so LOD can refine');
 const models=vegetationModels();
 const house={polygon:[[-10,-8],[10,-8],[10,8],[-10,8]],bottom:-2,eaves:12.8,rise:3,halfX:10,halfZ:8,roof:'gable',roofMaterial:Mat.RoofTile,wallColor:[195,190,178],industrial:false,hollow:true};
 models.push({name:'hollow house',radius:15,height:17,lods:[[],[],[]],building:house});
 const meta={width:128,height:128,cell_m:10,min_m:500,step_m:.1,origin_x:-640,origin_z:-640},grid=()=>({meta,data:new Uint16Array(16384)});
 const hf=new Heightfield({inner:grid(),outer:grid(),water:new Uint8Array(16384),models,instances:[{model:16,x:0,y:500,z:0,yaw:0,scale:1},{model:0,x:30,y:500,z:0,yaw:0,scale:1}]});
 const edits=new Edits();
 const sample=(x,z,physical=false,t=0,s=.125)=>columnSpans(hf,edits,edits.at(x,z),x,z,s,t,new Spans(),physical);
 const room=sample(0,0);
 assert(!room.solid(501.5),'Ground floor must contain walkable air');
 assert.equal(room.floor(501.5),500.25);assert(room.ceil(501.5)>503);
 assert(room.solid(503.3),'Upper storey slab must remain solid');
 assert(!room.solid(504.7),'Second storey must contain air');
 assert(room.solid(515.7),'Roof shell must remain solid');
 assert(!sample(0,-7.875).solid(501.5),'Entrance must be open');
 assert(sample(4,-7.875).solid(501.5),'Exterior wall must remain solid');
 edits.add(CARVE,4,501.5,-7.875,1.2,0,1);
 assert(!sample(4,-7.875).solid(501.5));assert(sample(4,-7.875,false,61).solid(501.5),'Cached source geometry must still heal');
 const canopyX=32,canopyZ=0;
 const visible=sample(canopyX,canopyZ),physical=sample(canopyX,canopyZ,true);
 let leafY;
 for(let y=506;y<525;y+=.125)if(visible.solid(y)&&hf.materialAt(canopyX,y,canopyZ,visible.base,Mat.Farm)===Mat.Leaves){leafY=y;break;}
 assert(leafY);assert(!physical.solid(leafY),'Foliage must not block bodies');
 assert(sample(30,0,true).solid(505),'Trunks must remain solid');
 const collision=buildChunk(hf,null,28,-2,.5,0,true);assert(!collision.materials.includes(Mat.Leaves),'Rapier collision mesh must omit foliage too');
 assert(MATERIALS[Mat.Concrete].strength<MATERIALS[Mat.Soil].strength);
 assert(MATERIALS[Mat.Leaves].strength<.05);assert.equal(MATERIALS[Mat.Concrete].bounce,0);
 const before=hf.authored.stats.cacheHits;sample(0,0);sample(0,0);assert(hf.authored.stats.cacheHits>before);
 // High-rise roofs must not be discarded by the span limit after adding storeys.
 house.eaves=57.6; // use a fresh field because authored source caches are immutable
 const tall=new Heightfield({inner:grid(),outer:grid(),water:new Uint8Array(16384),models,instances:[{model:16,x:0,y:500,z:0,yaw:0,scale:1}]});
 const high=columnSpans(tall,null,undefined,0,0,.125,0,new Spans());assert(high.top>560 && !high.solid(555));
 console.log('City physics: hollow rooms, floors, entrances, roofs, soft foliage, weak concrete, healing and cache reuse passed.');
}finally{await server.close();}
