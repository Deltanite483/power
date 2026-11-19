import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createServer } from 'vite';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
  const {Heightfield,BEDROCK_DEPTH,Mat,subsurface}=await server.ssrLoadModule('/src/terrain/heightfield.ts');
  const {Edits,Spans,CARVE,FILL,columnSpans}=await server.ssrLoadModule('/src/terrain/edits.ts');
  const meta={width:128,height:128,cell_m:10,min_m:500,step_m:.1,origin_x:-640,origin_z:-640};
  const grid=()=>({meta,data:new Uint16Array(16384)});
  const hf=new Heightfield({inner:grid(),outer:grid(),water:new Uint8Array(16384),models:[],instances:[]});
  const edits=new Edits();edits.healing=false;
  const sample=()=>columnSpans(hf,edits,edits.at(0,0),0,0,.125,0,new Spans());
  const surface=sample().top;
  assert.equal(BEDROCK_DEPTH,2);
  assert.equal(subsurface(Mat.Farm,1.99),Mat.Soil,'soil extends to just above the floor');
  assert.equal(subsurface(Mat.Farm,2),Mat.Bedrock,'exposed floor has bedrock material properties');
  assert.equal(subsurface(Mat.Asphalt,2),Mat.Bedrock,'bedrock also lies beneath roads');
  assert.equal(subsurface(Mat.Concrete,2),Mat.Concrete,'constructed volumes retain their materials');
  edits.add(CARVE,0,surface,0,100,0,1);
  assert.equal(sample().top,surface-2);
  edits.add(CARVE,0,surface-10,0,100,0,2);
  assert.equal(sample().top,surface-2,'repeated blasts cannot breach bedrock');
  edits.add(FILL,0,surface-2,0,1,0,3);
  assert.ok(sample().top>surface-2,'rubble can still pile above bedrock');
  const regional=new Edits(), out=[];
  regional.add(CARVE,2,500,2,2,0,1);
  regional.add(FILL,4,500,4,5,30,1);
  regional.add(CARVE,9000,500,9000,20,0,2);
  assert.deepEqual(regional.inBox(0,0,8,8,0,1,out),[0,1],'local queries preserve edit order');
  assert.deepEqual(regional.inBox(-4096,-4096,4096,4096,0,1,out),[0,1],'coarse sparse queries preserve the same order and bounds');
  assert.deepEqual(regional.inBox(-65536,-65536,65536,65536,0,21,out),[],'coarse tiles skip edits too small to affect them');
  assert(regional.compact(61));
  assert.deepEqual(regional.inBox(-4096,-4096,4096,4096,61,1,out),[0],'compaction preserves the index of a surviving fill');
  regional.reset(new Float32Array());
  assert.deepEqual(regional.inBox(-4096,-4096,4096,4096,61,1,out),[]);

  const {CloudTerrain}=await server.ssrLoadModule('/src/cloud-terrain.ts');
  const clouds=new CloudTerrain(()=>500);
  let samples=0;clouds.setSampler(()=>{samples++;return 499;});
  clouds.invalidate(-18000,-18000,-17990,-17990);
  clouds.invalidate(18000,18000,18010,18010);
  clouds.update();
  assert(samples>0 && samples<100,'distant damage resamples only the two affected cloud neighborhoods');
  assert.equal(clouds.height(0,0),500,'untouched terrain between edits is preserved');

  const {Destruction}=await server.ssrLoadModule('/src/destruction.ts');
  const redraws=[], collisionChanges=[];
  const destruction=new Destruction(hf, {heat:{update(){}}, sendEdits(){}, invalidate(...box){redraws.push(box);}}, new THREE.Scene());
  destruction.onCollisionChange=(...box)=>collisionChanges.push(box);
  destruction.dust.update=()=>{}; // the particle renderer uses browser viewport globals
  const eye=new THREE.PerspectiveCamera(), along=new THREE.Vector3(1,0,0), cut={streaming:true,scatter:false};
  assert(destruction.slashCut(new THREE.Vector3(4,surface,4),along,5.8,3.8,cut));
  assert(destruction.spans(4,4).top<surface && collisionChanges.length===1,'streamed cuts still affect terrain collision on contact');
  destruction.update(.03,eye);
  assert(destruction.slashCut(new THREE.Vector3(12,surface,4),along,5.8,3.8,cut));
  destruction.update(.03,eye);
  assert.equal(redraws.length,0);
  destruction.update(.04,eye);
  assert.equal(redraws.length,1,'close streaming cuts share a single local redraw across frames');
  assert(redraws[0][0]<4 && redraws[0][2]>12,'the combined redraw covers both cuts');

  console.log('Bedrock: 2 m floor, repeated blasts, rubble fill and bounded terrain edit queries passed.');
} finally {await server.close();}
