import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try {
 const {Heightfield,Mat}=await server.ssrLoadModule('/src/terrain/heightfield.ts');
 const {Spans,Edits,CARVE,columnSpans}=await server.ssrLoadModule('/src/terrain/edits.ts');
 const {buildChunk}=await server.ssrLoadModule('/src/terrain/mesher.ts');
 const {vegetationModels,SPECIES}=await server.ssrLoadModule('/src/vegetation.ts');
 const {sceneryLOD}=await server.ssrLoadModule('/src/terrain/authored.ts');
 const models=vegetationModels();
 assert.equal(models.length,16);
 for(const m of models){assert(m.lods[0].length>m.lods[1].length);assert(m.lods[1].length>m.lods[2].length);assert(m.lods.every(p=>p.some(p=>p.material===Mat.Wood)));}
 const building={polygon:[[-8,-5],[8,-5],[8,0],[2,0],[2,5],[-8,5]],bottom:-1,eaves:6.4,rise:3,halfX:8,halfZ:5,roof:'gable',roofMaterial:Mat.RoofTile,wallColor:[200,190,175],industrial:false};
 models.push({name:'diagonal L house',radius:11,height:9.4,lods:[[],[],[]],building});
 const meta={width:128,height:128,cell_m:10,min_m:500,step_m:.1,origin_x:-640,origin_z:-640},grid=()=>({meta,data:new Uint16Array(128*128)});
 const instance={model:16,x:0,y:500,z:0,yaw:Math.PI/4,scale:1};
 const hf=new Heightfield({inner:grid(),outer:grid(),water:new Uint8Array(128*128),models,instances:[instance,{model:1,x:30,y:500,z:0,yaw:Math.PI/3,scale:1},{model:12,x:50,y:500,z:0,yaw:.7,scale:1}]});
 const world=(x,z,y=503)=>({x:(x-z)*Math.SQRT1_2,z:(x+z)*Math.SQRT1_2,y});
 const edits=new Edits();
 const sample=(p,s=.125,time=0)=>columnSpans(hf,edits,edits.at(p.x,p.z),p.x,p.z,s,time,new Spans());
 assert(sample(world(-5,2)).solid(503),'Rotated wing must be concrete');
 assert(!sample(world(6,3)).solid(503),'Concave footprint must retain its notch');
 assert(!sample({x:8,z:8,y:503}).solid(503),'Bounding rectangle outside diagonal facade must stay empty');
 assert(sample(world(0,0)).top>sample(world(0,-4.8)).top,'Gable roof must slope towards its eaves');
 const glass=world(-6.8,-4.9,501.7),sp=sample(glass);
 assert.equal(hf.materialAt(glass.x,glass.y,glass.z,sp.base,Mat.Farm),Mat.Glass,'Facade windows must be material voxels');
 assert.equal(hf.materialAt(glass.x,glass.y,glass.z,sp.base,Mat.Farm,2),Mat.Concrete,'Distant facade must omit individual windows');
 const detailedModel={...models[16],building:{...building,eaveOverhang:.58}};
 const detailed=new Heightfield({inner:grid(),outer:grid(),water:new Uint8Array(128*128),models:[detailedModel],instances:[{...instance,model:0}]});
 const detailEdits=new Edits();
 const detail=(p,time=0)=>columnSpans(detailed,detailEdits,detailEdits.at(p.x,p.z),p.x,p.z,.125,time,new Spans());
 const pane=world(-6.8,-4.7,501.7);
 assert(!detail(glass).solid(glass.y),'Window reveal must leave the outside voxel empty');
 assert(detail(pane).solid(pane.y),'Recessed window must keep a solid pane');
 assert.equal(detailed.materialAt(pane.x,pane.y,pane.z,detail(pane).base,Mat.Farm),Mat.Glass);
 const eave=world(-4,-5.35,506.125);
 assert(detail(eave).solid(eave.y),'Roof lip must extend past the wall');
 assert(!detail(eave).solid(eave.y-1),'An overhang must leave open air below it');
 detailEdits.add(CARVE,eave.x,eave.y,eave.z,.7,0,1);
 assert(!detail(eave).solid(eave.y),'Roof lip must break with the same edits as the building');
 assert(detail(eave,61).solid(eave.y),'Roof lip must heal with the building');
 const wall=world(-6,-4.8,503.4);edits.add(CARVE,wall.x,wall.y,wall.z,1,0,1);
 assert(!sample(wall).solid(wall.y));assert(sample(wall,.125,61).solid(wall.y),'Rotated buildings must heal through terrain edits');
 const sizes=[];
 for(const s of [.125,1,4]){let vertices=0,roof=false;for(let x=-16;x<16;x+=32*s)for(let z=-16;z<16;z+=32*s){const mesh=buildChunk(hf,null,x,z,s,0);roof ||= mesh.materials.includes(Mat.RoofTile);vertices+=mesh.positions.length;}assert(roof);sizes.push(vertices);}
 assert(sizes[0]>sizes[1] && sizes[1]>sizes[2],`Voxel mesh LODs should reduce vertices: ${sizes}`);
 // Leaning trunk at its transformed midpoint, away from its vertical projection at the root.
 const tree=models[1],trunk=tree.lods[0].at(-1),mx=(trunk.x+trunk.tx)/2,mz=(trunk.z+trunk.tz)/2;
 const p={x:30+mx*.5-mz*Math.sqrt(3)/2,z:mx*Math.sqrt(3)/2+mz*.5,y:500+(trunk.y0+trunk.y1)/2};
 assert(sample(p).solid(p.y));assert.equal(hf.materialAt(p.x,p.y,p.z,sample(p).base,Mat.Farm),Mat.Wood);
 edits.add(CARVE,p.x,p.y,p.z,.8,0,2);assert(!sample(p).solid(p.y));
 const shrub=hf.authored.column(50,0,.125);assert(shrub.count>0);
 assert(hf.authored.heightNear(0,0)>=509.4,'LOD refinement must include roofs and crowns above the ground');
 assert.equal(sceneryLOD(.5),0);assert.equal(sceneryLOD(2),1);assert.equal(sceneryLOD(4),2);
 console.log(JSON.stringify({species:SPECIES.length,templates:16,buildingLODVertices:sizes,checks:'rotation, concavity, roof, glass, angled stems, shrubs, carving and healing passed'}));
} finally {await server.close();}
