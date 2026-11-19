import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Exercise the actual worker mesher and collision sampler against a small authored world.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { Heightfield, Mat } = await server.ssrLoadModule('/src/terrain/heightfield.ts');
  const { Spans, Edits, CARVE, columnSpans } = await server.ssrLoadModule('/src/terrain/edits.ts');
  const { buildChunk } = await server.ssrLoadModule('/src/terrain/mesher.ts');
  const meta = { width: 128, height: 128, cell_m: 10, min_m: 500, step_m: 0.1, origin_x: -640, origin_z: -640 };
  const grid = () => ({ meta, data: new Uint16Array(128 * 128) });
  const hf = new Heightfield({
    inner: grid(), outer: grid(), water: new Uint8Array(128 * 128),
    boxes: new Float32Array([
      4, 498, 4, 20, 520.375, 20, Mat.Concrete,
      -20, 499, 4, -19, 510, 5, Mat.Wood,
      -23, 507, 1, -16, 515, 8, Mat.Leaves,
    ]),
    roads: new Float32Array([-12, 4, -4, 4, 2]),
  });
  const edits = new Edits();
  const sample = (x, z, time = 0, s = 0.125) => columnSpans(hf, edits, edits.at(x,z), x,z,s,time,new Spans());
  const material = (x,y,z,base,s = 0.125) => hf.materialAt(x,y,z,base,Mat.Farm,s);
  const wall = sample(4.0625,10.0625);
  assert.equal(wall.top,520.375);
  assert(wall.solid(516));
  assert.equal(material(4.0625,516,10.0625,wall.base),Mat.Concrete);
  edits.add(CARVE,4.0625,516,10.0625,1.5,0,1);
  const hole = sample(4.0625,10.0625);
  assert(!hole.solid(516),'A local punch must remove concrete from collision spans');
  assert.equal(hole.top,wall.top,'A local hole must leave the roof intact');
  assert(sample(4.0625,10.0625,61).solid(516),'Healing must restore the original concrete');
  const mesh = buildChunk(hf,edits,4,8,0.125,0);
  const interior = [];
  for (let i=0; i<mesh.materials.length; i++) {
    const y=mesh.positions[i*3+1];
    if (mesh.normals[i*3+1] !== 0 && y > 513 && y < 519) interior.push(mesh.materials[i]);
  }
  assert(interior.length > 0,'A carved wall must emit floors and ceilings');
  assert(interior.every(m=>m===Mat.Concrete),'Carved wall interiors must retain concrete identity');
  for (const s of [0.125,0.25,0.5,1,2,4,8]) {
    const sp=sample(10,10,0,s);
    assert.equal(material(10,sp.top-0.01,10,sp.base,s),Mat.Concrete,`Concrete roof identity at voxel size ${s}`);
  }
  const road = sample(-8,4);
  assert.equal(material(-8,road.top-0.05,4,road.base),Mat.Asphalt);
  assert.equal(material(-8,road.base-1,4,road.base),Mat.Soil);
  const roadMesh = buildChunk(hf,null,-12,2,0.125,0);
  assert(roadMesh.materials.includes(Mat.Asphalt),'Roads must be painted by the terrain mesher');
  edits.add(CARVE,-8,road.top,4,1.5,0,2);
  const cutRoad = sample(-8,4);
  assert(cutRoad.top < road.top-1,'A road must carve together with its underlying terrain');
  assert.equal(material(-8,cutRoad.top-0.01,4,cutRoad.base),Mat.Soil,'No asphalt ribbon may remain over the crater');
  assert.equal(material(-19.5,505,4.5,500),Mat.Wood);
  assert.equal(material(-22,510,2,500),Mat.Leaves);
  edits.add(CARVE,-19.5,505,4.5,1,0,3);
  assert(!sample(-19.5,4.5).solid(505),'Tree trunks must use the same carve edits');
  assert(sample(-19.5,4.5,61).solid(505),'Tree voxels must use the same healing');
  console.log('Voxel scenery: concrete interiors, roof LODs, local holes, road paint, soil, trees and healing passed.');
} finally {
  await server.close();
}
