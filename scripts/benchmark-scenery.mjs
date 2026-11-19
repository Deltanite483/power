import { createServer } from 'vite';
const server=await createServer({server:{middlewareMode:true},appType:'custom'});
try{
 const{Heightfield,Mat}=await server.ssrLoadModule('/src/terrain/heightfield.ts');
 const{buildChunk}=await server.ssrLoadModule('/src/terrain/mesher.ts');
 const{vegetationModels}=await server.ssrLoadModule('/src/vegetation.ts');
 const meta={width:128,height:128,cell_m:10,min_m:500,step_m:.1,origin_x:-640,origin_z:-640},grid=()=>({meta,data:new Uint16Array(16384)});
 const models=vegetationModels();models.push({name:'benchmark house',radius:30,height:18,lods:[[],[],[]],building:{polygon:[[-20,-20],[20,-20],[20,20],[-20,20]],bottom:-1,eaves:12.8,rise:3,halfX:20,halfZ:20,roof:'gable',roofMaterial:Mat.RoofTile,wallColor:[190,185,170],industrial:false,hollow:true}});
 const hf=new Heightfield({inner:grid(),outer:grid(),water:new Uint8Array(16384),models,instances:[{model:16,x:0,y:500,z:0,yaw:.4,scale:1},{model:1,x:45,y:500,z:0,yaw:.5,scale:1}]});
 for(const [name,x,z] of [['interior',-2,-2],['vegetation',44,-2]]){
  const first=performance.now();let mesh=buildChunk(hf,null,x,z,.125,0);const cold=performance.now()-first;
  for(let n=0;n<3;n++)buildChunk(hf,null,x,z,.125,0);
  const times=[];for(let n=0;n<15;n++){const start=performance.now();mesh=buildChunk(hf,null,x,z,.125,0);times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);console.log(JSON.stringify({name,coldMs:+cold.toFixed(2),warmMedianMs:+times[7].toFixed(2),vertices:mesh.positions.length/3,triangles:mesh.indices.length/3,cache:hf.authored.stats}));
 }
}finally{await server.close();}
