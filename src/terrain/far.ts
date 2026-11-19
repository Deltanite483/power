import { layerColor, surfaceColor, surfaceMaterial, verticalQuantum, Mat, WATER_LEVEL, type Heightfield } from "./heightfield";
import { columnSpans, Spans, type Edits } from "./edits";
import { buildChunk, CHUNK_COLS, type ChunkMesh } from "./mesher";

/**
 * A far tile: smooth ground (CDLOD-style) plus the voxel scenery standing on it.
 * Ground vertices also carry where they sit on the parent tile (aCoarse*), and the vertex shader morphs toward
 * that with distance, so when a tile merges into its parent (or splits) the surfaces are already identical.
 */
export interface FarMesh extends ChunkMesh {
  coarseY: Float32Array;
  coarseN: Int8Array;
  coarseC: Uint8Array;
  /** Indices [0, groundIndices) draw the ground; the rest are voxel scenery. */
  groundIndices: number;
}

const N = CHUNK_COLS;
const F = N + 3; // fine samples -1..N+1
const H = N / 2;
const C = H + 3; // coarse (parent) samples -1..H+1
/** Trees blur into the forest floor colour beyond this voxel size; buildings are kept a while longer. */
const MAX_TREE_VOXEL = 16;
const MAX_BUILDING_VOXEL = 64;

const spans = new Spans();
const candFine: number[] = [];
const candCoarse: number[] = [];
const tmp = [0, 0, 0];
const fineH = new Float64Array(F * F), fineDug = new Float64Array(F * F), fineWet = new Uint8Array(F * F);
const coarseH = new Float64Array(C * C), coarseDug = new Float64Array(C * C), coarseWet = new Uint8Array(C * C);

/** Ground height without vertical quantisation, with craters and mounds from destruction applied. */
function groundAt(hf: Heightfield, edits: Edits | null, list: number[], x: number, z: number, s: number, clock: number, i: number, h: Float64Array, dug: Float64Array, wet: Uint8Array) {
  let y = hf.height(x, z, s), water = 0;
  if (s <= 64 && hf.waterAt(x, z) > 0.5) { y -= 1.5; water = 1; }
  else if (y < WATER_LEVEL) { y = WATER_LEVEL; water = 1; }
  let d = 0;
  if (edits && list.length) {
    columnSpans(hf, edits, list, x, z, s, clock, spans, false, true);
    const delta = spans.top - spans.base;
    if (Math.abs(delta) >= verticalQuantum(s) * 0.5) d = delta;
  }
  h[i] = y + d;
  dug[i] = d;
  wet[i] = water;
}

/** Ground colour (0-255) and material at a sample, matching the voxel mesher's rules for tops. */
function groundColor(hf: Heightfield, x: number, z: number, s: number, h: number, dug: number, water: boolean, slope: number, out: number[]): Mat {
  const q = verticalQuantum(s), base = h - dug;
  const m = surfaceMaterial(base, slope, water, x, z);
  const exposed = hf.materialAt(x, h - 0.01, z, base, m, s);
  if (exposed >= Mat.Asphalt) layerColor(exposed, 0, out, 0);
  else if (dug < -q * 0.5) layerColor(m, -dug, out, 0);
  else if (dug > q * 0.5) { layerColor(m, 1, out, 0); out[0] += 10; out[1] += 6; }
  else surfaceColor(h, slope, water, x, z, s, out, 0);
  const tint = hf.authored.colorAt(x, h - 0.01, z, s, exposed);
  if (tint) { out[0] = tint[0]; out[1] = tint[1]; out[2] = tint[2]; }
  return exposed;
}

export function buildFarTile(hf: Heightfield, edits: Edits | null, x0: number, z0: number, s: number, clock: number): FarMesh {
  const s2 = s * 2;
  const listF = edits ? edits.inBox(x0 - s2, z0 - s2, x0 + (N + 2) * s, z0 + (N + 2) * s, clock, s * 0.35, candFine) : candFine;
  const listC = edits ? edits.inBox(x0 - s2 * 2, z0 - s2 * 2, x0 + (N + 4) * s, z0 + (N + 4) * s, clock, s2 * 0.35, candCoarse) : candCoarse;
  if (!edits) { candFine.length = 0; candCoarse.length = 0; }
  for (let j = 0; j < F; j++) for (let i = 0; i < F; i++)
    groundAt(hf, edits, listF, x0 + (i - 1) * s, z0 + (j - 1) * s, s, clock, j * F + i, fineH, fineDug, fineWet);
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++)
    groundAt(hf, edits, listC, x0 + (i - 1) * s2, z0 + (j - 1) * s2, s2, clock, j * C + i, coarseH, coarseDug, coarseWet);

  // --- ground grid, (N+1)² vertices, then a skirt under each edge
  const side = N + 1, gridVerts = side * side, skirtVerts = 4 * side;
  const scenery = buildChunk(hf, edits, x0, z0, s, clock);
  const keepTrees = s <= MAX_TREE_VOXEL, keepScenery = s <= MAX_BUILDING_VOXEL;
  const keep: number[] = [];
  if (keepScenery) for (let quad = 0; quad < scenery.materials.length / 4; quad++) {
    const m = scenery.materials[quad * 4];
    if (m === Mat.Concrete || m === Mat.RoofTile || m === Mat.RoofSlate || m === Mat.Glass || (keepTrees && (m === Mat.Wood || m === Mat.Leaves))) keep.push(quad);
  }
  const V = gridVerts + skirtVerts + keep.length * 4;
  const positions = new Float32Array(V * 3), normals = new Int8Array(V * 3), colors = new Uint8Array(V * 3), materials = new Uint8Array(V);
  const coarseY = new Float32Array(V), coarseN = new Int8Array(V * 3), coarseC = new Uint8Array(V * 3);
  let minY = Infinity, maxY = -Infinity;

  // coarse normals and colours on the parent grid (even vertices), interpolated for odd ones like heights
  const cN = new Float32Array(C * C * 3), cRGB = new Float32Array(C * C * 3);
  for (let j = 1; j < C - 1; j++) for (let i = 1; i < C - 1; i++) {
    const k = j * C + i;
    const gx = (coarseH[k + 1] - coarseH[k - 1]) / (2 * s2), gz = (coarseH[k + C] - coarseH[k - C]) / (2 * s2);
    const l = Math.hypot(gx, 1, gz);
    cN[k * 3] = -gx / l; cN[k * 3 + 1] = 1 / l; cN[k * 3 + 2] = -gz / l;
    groundColor(hf, x0 + (i - 1) * s2, z0 + (j - 1) * s2, s2, coarseH[k], coarseDug[k], coarseWet[k] === 1, Math.hypot(gx, gz), tmp);
    cRGB[k * 3] = tmp[0]; cRGB[k * 3 + 1] = tmp[1]; cRGB[k * 3 + 2] = tmp[2];
  }
  // parent value at child vertex (i,j): exact on even vertices, along the parent's edge or (i,j)-(i+1,j+1) diagonal otherwise
  const coarse = (i: number, j: number, arr: Float64Array | Float32Array, stride: number, c: number): number => {
    const ci = (i >> 1) + 1, cj = (j >> 1) + 1, oi = i & 1, oj = j & 1;
    const at = (a: number, b: number) => arr[(b * C + a) * stride + c];
    if (!oi && !oj) return at(ci, cj);
    if (oi && !oj) return (at(ci, cj) + at(ci + 1, cj)) / 2;
    if (!oi && oj) return (at(ci, cj) + at(ci, cj + 1)) / 2;
    return (at(ci, cj) + at(ci + 1, cj + 1)) / 2;
  };

  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const v = j * side + i, k = (j + 1) * F + (i + 1);
    const x = i * s, z = j * s, y = fineH[k];
    const gx = (fineH[k + 1] - fineH[k - 1]) / (2 * s), gz = (fineH[k + F] - fineH[k - F]) / (2 * s);
    const l = Math.hypot(gx, 1, gz);
    positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
    normals[v * 3] = Math.round(-gx / l * 127); normals[v * 3 + 1] = Math.round(127 / l); normals[v * 3 + 2] = Math.round(-gz / l * 127);
    materials[v] = groundColor(hf, x0 + x, z0 + z, s, y, fineDug[k], fineWet[k] === 1, Math.hypot(gx, gz), tmp);
    colors[v * 3] = tmp[0]; colors[v * 3 + 1] = tmp[1]; colors[v * 3 + 2] = tmp[2];
    coarseY[v] = coarse(i, j, coarseH, 1, 0);
    let nx = coarse(i, j, cN, 3, 0), ny = coarse(i, j, cN, 3, 1), nz = coarse(i, j, cN, 3, 2);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    coarseN[v * 3] = Math.round(nx * 127); coarseN[v * 3 + 1] = Math.round(ny * 127); coarseN[v * 3 + 2] = Math.round(nz * 127);
    for (let c = 0; c < 3; c++) coarseC[v * 3 + c] = Math.round(coarse(i, j, cRGB, 3, c));
    minY = Math.min(minY, y, coarseY[v]); maxY = Math.max(maxY, y, coarseY[v]);
  }
  // skirts: a copy of each edge vertex dropped well below, hiding cracks against neighbours of another level
  const skirt = Math.max(4, s * 2);
  const edge = (e: number, t: number) => e === 0 ? t : e === 1 ? N * side + t : e === 2 ? t * side : t * side + N;
  for (let e = 0; e < 4; e++) for (let t = 0; t <= N; t++) {
    const src = edge(e, t), dst = gridVerts + e * side + t;
    for (let c = 0; c < 3; c++) {
      positions[dst * 3 + c] = positions[src * 3 + c]; normals[dst * 3 + c] = normals[src * 3 + c];
      colors[dst * 3 + c] = colors[src * 3 + c]; coarseN[dst * 3 + c] = coarseN[src * 3 + c]; coarseC[dst * 3 + c] = coarseC[src * 3 + c];
    }
    positions[dst * 3 + 1] -= skirt;
    coarseY[dst] = coarseY[src] - skirt;
    materials[dst] = materials[src];
    minY = Math.min(minY, positions[dst * 3 + 1], coarseY[dst]);
  }

  // voxel scenery standing on the ground; wall bottoms reach a quantum lower so smooth ground never shows a gap
  const q = verticalQuantum(s);
  let v = gridVerts + skirtVerts;
  for (const quad of keep) {
    const src = quad * 4, wall = scenery.normals[src * 3 + 1] === 0;
    for (let c4 = 0; c4 < 4; c4++, v++) {
      const a = src + c4;
      for (let c = 0; c < 3; c++) {
        positions[v * 3 + c] = scenery.positions[a * 3 + c]; normals[v * 3 + c] = scenery.normals[a * 3 + c];
        colors[v * 3 + c] = scenery.colors[a * 3 + c]; coarseN[v * 3 + c] = normals[v * 3 + c]; coarseC[v * 3 + c] = colors[v * 3 + c];
      }
      if (wall && c4 >= 2) positions[v * 3 + 1] -= q;
      coarseY[v] = positions[v * 3 + 1];
      materials[v] = scenery.materials[a];
      minY = Math.min(minY, positions[v * 3 + 1]); maxY = Math.max(maxY, positions[v * 3 + 1]);
    }
  }

  const groundIndices = N * N * 6 + 4 * N * 12;
  const indexCount = groundIndices + keep.length * 6;
  const indices = V > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let o = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * side + i, b = a + side, c = b + 1, d = a + 1; // (i,j) (i,j+1) (i+1,j+1) (i+1,j)
    indices[o++] = a; indices[o++] = b; indices[o++] = c;
    indices[o++] = a; indices[o++] = c; indices[o++] = d;
  }
  for (let e = 0; e < 4; e++) for (let t = 0; t < N; t++) {
    const a = edge(e, t), b = edge(e, t + 1), as = gridVerts + e * side + t, bs = as + 1;
    // both windings: skirts are seen from either side depending on the edge
    indices[o++] = a; indices[o++] = b; indices[o++] = bs; indices[o++] = a; indices[o++] = bs; indices[o++] = as;
    indices[o++] = a; indices[o++] = bs; indices[o++] = b; indices[o++] = a; indices[o++] = as; indices[o++] = bs;
  }
  for (let n = 0, base = gridVerts + skirtVerts; n < keep.length; n++, base += 4) {
    indices[o++] = base; indices[o++] = base + 1; indices[o++] = base + 2;
    indices[o++] = base; indices[o++] = base + 2; indices[o++] = base + 3;
  }
  return { positions, normals, colors, materials, indices, minY, maxY, coarseY, coarseN, coarseC, groundIndices };
}
