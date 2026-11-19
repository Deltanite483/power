import { layerColor, slopeAt, subsurface, surfaceColor, surfaceMaterial, verticalQuantum, Mat, type Heightfield } from "./heightfield";
import { columnSpans, MAX_SPANS, Spans, type Edits } from "./edits";

export const CHUNK_COLS = 32;

export interface ChunkMesh {
  positions: Float32Array; // chunk-local (x - x0, y, z - z0)
  normals: Int8Array;
  colors: Uint8Array;
  materials: Uint8Array; // actual surface / exposed stratum, for thermal shading
  indices: Uint16Array | Uint32Array;
  minY: number;
  maxY: number;
}

const N = CHUNK_COLS;
const P = N + 2;
const MS = MAX_SPANS;
const tops = new Float32Array(P * P); // top of the highest solid span
const base = new Float32Array(P * P); // undisturbed surface
const nSpan = new Uint8Array(P * P);
const lo = new Float64Array(P * P * MS);
const hi = new Float64Array(P * P * MS);
const wet = new Uint8Array(P * P);
const authored = new Uint8Array(P * P);
const mat = new Uint8Array(P * P); // surface material
const exposedMat = new Uint8Array(P * P);
const rgb = new Int32Array(P * P); // packed top colour, quantised (per-voxel jitter happens in the shader)
const used = new Uint8Array(P * P);
const bottoms = new Float32Array(P * P);
const lowerUsed = new Uint32Array(P * P);
const lowerColors = new Int32Array(P * P * MS);
const lowerMaterials = new Uint8Array(P * P * MS);
const slopes = new Float32Array(P * P);
const spans = new Spans();
const cand: number[] = [];
const MAX_QUADS = N * N * 24;
const pos = new Float32Array(MAX_QUADS * 12);
const nrm = new Int8Array(MAX_QUADS * 12);
const clr = new Uint8Array(MAX_QUADS * 12);
const materialIds = new Uint8Array(MAX_QUADS * 4);
const tmp = [0, 0, 0];
const pieceLo = new Float64Array(MS * 2 + 2);
const pieceHi = new Float64Array(MS * 2 + 2);

// Side directions: dx, dz
const SIDES: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const pack = (c: number[]) => ((c[0] >> 2) << 16) | ((c[1] >> 2) << 8) | (c[2] >> 2);

/**
 * Blocky mesh for the chunk whose north-west corner is (x0,z0), voxel size s, with destruction edits applied.
 * Undamaged columns are greedy-merged (tops into rectangles, sides into runs); damaged ones get exact faces:
 * crater walls, tunnel floors, ceilings and overhangs, coloured by how deep below the old surface they are.
 */
export function buildChunk(hf: Heightfield, edits: Edits | null, x0: number, z0: number, s: number, clock: number, solidOnly = false): ChunkMesh {
  const q = verticalQuantum(s);
  // edits smaller than a third of a voxel don't show at this level of detail
  const list = edits ? edits.inBox(x0 - s, z0 - s, x0 + (N + 1) * s, z0 + (N + 1) * s, clock, s * 0.35, cand) : cand;
  for (let j = 0; j < P; j++) {
    for (let i = 0; i < P; i++) {
      const cx = x0 + (i - 0.5) * s, cz = z0 + (j - 0.5) * s;
      columnSpans(hf, edits, list, cx, cz, s, clock, spans, solidOnly);
      const k = j * P + i;
      authored[k] = hf.authored.count ? 1 : 0;
      const volumes = hf.volumesAt(cx, cz), boxes = hf.boxes;
      if (volumes) for (const o of volumes) if (cx >= boxes[o] && cx < boxes[o+3] && cz >= boxes[o+2] && cz < boxes[o+5]) { authored[k] = 1; break; }
      nSpan[k] = spans.n;
      for (let m = 0; m < spans.n; m++) { lo[k * MS + m] = spans.lo[m]; hi[k * MS + m] = spans.hi[m]; }
      tops[k] = spans.top;
      base[k] = spans.base;
      wet[k] = spans.water ? 1 : 0;
    }
  }
  let minY = Infinity, maxY = -Infinity;
  for (let j = 1; j <= N; j++) {
    for (let i = 1; i <= N; i++) {
      const k = j * P + i;
      const t = tops[k], b = base[k];
      const cx = x0 + (i - 0.5) * s, cz = z0 + (j - 0.5) * s;
      const slope = slopeAt(hf, cx, cz, s);
      slopes[k] = slope;
      mat[k] = surfaceMaterial(b, slope, wet[k] === 1, cx, cz);
      exposedMat[k] = hf.materialAt(cx, t - 0.01, cz, b, mat[k], s);
      if (exposedMat[k] >= Mat.Asphalt) layerColor(exposedMat[k], 0, tmp, 0);
      else if (t < b - q * 0.5) layerColor(mat[k], b - t, tmp, 0); // dug out: you see what was underneath
      else if (t > b + q * 0.5) { layerColor(mat[k], 1, tmp, 0); tmp[0] += 10; tmp[1] += 6; } // thrown-up rim / spoil
      else surfaceColor(t, slope, wet[k] === 1, cx, cz, s, tmp, 0);
      const tint = hf.authored.colorAt(cx, t - .01, cz, s, exposedMat[k], b);
      if(tint){tmp[0]=tint[0];tmp[1]=tint[1];tmp[2]=tint[2];}
      rgb[k] = pack(tmp);
      if (t < minY) minY = t;
      if (t > maxY) maxY = t;
    }
  }

  let v = 0;
  const emit = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    c: number, bottomShade: number,
    materialId: number = Mat.Soil,
  ) => {
    if (v + 4 > MAX_QUADS * 4) return;
    const p = v * 3;
    pos[p] = ax; pos[p + 1] = ay; pos[p + 2] = az;
    pos[p + 3] = bx; pos[p + 4] = by; pos[p + 5] = bz;
    pos[p + 6] = cx; pos[p + 7] = cy; pos[p + 8] = cz;
    pos[p + 9] = dx; pos[p + 10] = dy; pos[p + 11] = dz;
    const r = ((c >> 16) & 255) << 2, g = ((c >> 8) & 255) << 2, b = (c & 255) << 2;
    for (let q2 = 0; q2 < 4; q2++) {
      materialIds[v + q2] = materialId;
      const o = p + q2 * 3;
      nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
      const sh = q2 >= 2 ? bottomShade : 1; // a,b top edge; c,d bottom edge
      clr[o] = r * sh; clr[o + 1] = g * sh; clr[o + 2] = b * sh;
    }
    v += 4;
  };
  /** One side face of column (a = i or j index along the run axis) between heights bot..t. */
  const side = (d: number, i: number, j: number, len: number, t: number, bot: number, c: number, shade: number, materialId: number) => {
    const [dx, dz] = SIDES[d];
    if (dx !== 0) {
      const z0l = (j - 1) * s, z1l = z0l + len * s;
      if (dx === 1) { const x = i * s; emit(x, t, z0l, x, t, z1l, x, bot, z1l, x, bot, z0l, 127, 0, 0, c, shade, materialId); }
      else { const x = (i - 1) * s; emit(x, t, z1l, x, t, z0l, x, bot, z0l, x, bot, z1l, -127, 0, 0, c, shade, materialId); }
    } else {
      const x0l = (i - 1) * s, x1l = x0l + len * s;
      if (dz === 1) { const z = j * s; emit(x1l, t, z, x0l, t, z, x0l, bot, z, x1l, bot, z, 0, 0, 127, c, shade, materialId); }
      else { const z = (j - 1) * s; emit(x0l, t, z, x1l, t, z, x1l, bot, z, x0l, bot, z, 0, 0, -127, c, shade, materialId); }
    }
  };
  const earthy = (c: number) => {
    const sr = ((c >> 16) & 255) * 0.62 + 30 * 0.38, sg = ((c >> 8) & 255) * 0.62 + 26 * 0.38, sb = (c & 255) * 0.62 + 21 * 0.38;
    return (sr << 16) | (sg << 8) | sb;
  };
  const materialAt = (k: number, y: number): Mat => {
    const i = k % P, j = Math.floor(k / P);
    return hf.materialAt(x0 + (i - 0.5) * s, y, z0 + (j - 0.5) * s, base[k], mat[k], s);
  };
  // deep inside the ground no sunlight gets in: bake darkness by depth below the old surface
  const layerPacked = (k: number, y: number, m = materialAt(k, y)) => {
    const depth = Math.max(0, base[k] - y);
    layerColor(m >= Mat.Asphalt ? m : mat[k], m >= Mat.Asphalt ? 0 : depth, tmp, 0);
    const i = k % P, j = Math.floor(k / P);
    const tint = hf.authored.colorAt(x0 + (i - .5) * s, y, z0 + (j - .5) * s, s, m, base[k]);
    if(tint){tmp[0]=tint[0];tmp[1]=tint[1];tmp[2]=tint[2];}
    const dark = depth < 4 ? 1 : Math.max(0.16, 1 - (depth - 4) / 24);
    tmp[0] *= dark; tmp[1] *= dark; tmp[2] *= dark;
    return pack(tmp);
  };

  // Split exposed sides at original material boundaries: a cut through a wall stays concrete,
  // while soil beneath its foundation and under the asphalt remains soil.
  const materialSide = (d: number, i: number, j: number, len: number, h: number, l: number, k: number) => {
    const cx = x0 + (i - 0.5) * s, cz = z0 + (j - 0.5) * s;
    if (!authored[k] && exposedMat[k] !== Mat.Asphalt) {
      const dug = Math.abs(tops[k] - base[k]) >= q * 0.5;
      side(d,i,j,len,h,l,dug ? layerPacked(k,(h+l)/2) : earthy(rgb[k]),Math.max(0.55,1-(h-l)/(s*12)),subsurface(mat[k],Math.max(0.4,base[k]-(h+l)/2)));
      return;
    }
    const cuts = [l, h], boxes = hf.boxes;
    const add = (y: number) => { if (y > l && y < h) cuts.push(y); };
    add(base[k]); add(base[k] - 0.3);
    if (authored[k]) add(base[k] + .9);
    const volumes = hf.volumesAt(cx, cz);
    if (volumes) for (const o of volumes) {
      if (cx < boxes[o] || cx >= boxes[o+3] || cz < boxes[o+2] || cz >= boxes[o+5]) continue;
      add(Math.round(boxes[o+1] / q) * q); add(Math.round(boxes[o+4] / q) * q);
    }
    hf.authored.cuts(cx,cz,s,l,h,cuts);
    cuts.sort((a,b) => a-b);
    for (let a = 1; a < cuts.length; a++) {
      const bot = cuts[a-1], top = cuts[a];
      if (top - bot < 1e-6) continue;
      const y = (bot + top) / 2, m = materialAt(k,y);
      const surface = m < Mat.Asphalt && top >= tops[k] - 1e-6 && Math.abs(tops[k] - base[k]) < q * 0.5;
      const shade = m === Mat.Concrete || m === Mat.Glass ? 1 : Math.max(.55, 1 - (top - bot) / (s * 12));
      side(d,i,j,len,top,bot,surface ? earthy(rgb[k]) : layerPacked(k,y,m),shade,m);
    }
  };

  // --- top of the highest span: greedy rectangles
  used.fill(0);
  for (let j = 1; j <= N; j++) {
    for (let i = 1; i <= N; i++) {
      const k = j * P + i;
      if (used[k]) continue;
      const t = tops[k], c = rgb[k];
      let w = 1;
      while (i + w <= N && !used[k + w] && tops[k + w] === t && rgb[k + w] === c && exposedMat[k + w] === exposedMat[k]) w++;
      let h = 1;
      grow: while (j + h <= N) {
        const row = k + h * P;
        for (let q2 = 0; q2 < w; q2++) if (used[row + q2] || tops[row + q2] !== t || rgb[row + q2] !== c || exposedMat[row + q2] !== exposedMat[k]) break grow;
        h++;
      }
      for (let b = 0; b < h; b++) used.fill(1, k + b * P, k + b * P + w);
      const lx = (i - 1) * s, lz = (j - 1) * s, ex = lx + w * s, ez = lz + h * s;
      emit(lx, t, lz, lx, t, ez, ex, t, ez, ex, t, lz, 0, 127, 0, c, 1, exposedMat[k]);
    }
  }

  // Greedy merge floors and ceilings too. Hollow buildings otherwise emit every interior
  // slab as thousands of tiny quads, even when its material and elevation are constant.
  for (const underside of [false,true]) {
    lowerUsed.fill(0);
    const faceExists=(k:number,m:number)=>underside ? m>0 && m<nSpan[k] : m<nSpan[k]-1;
    const height=(k:number,m:number)=>underside ? lo[k*MS+m] : hi[k*MS+m];
    for(let j=1;j<=N;j++)for(let i=1;i<=N;i++){
      const k=j*P+i;
      for(let m=0;m<nSpan[k];m++){
        if(!faceExists(k,m))continue;
        const y=height(k,m),sampleY=y+(underside?.01:-.01),material=materialAt(k,sampleY);
        let c:number;
        if(!underside && material<Mat.Asphalt && Math.abs(y-base[k])<q*.5){
          surfaceColor(base[k],slopes[k],wet[k]===1,x0+(i-.5)*s,z0+(j-.5)*s,s,tmp,0);c=pack(tmp);
        }else c=layerPacked(k,sampleY,material);
        if(underside)c=((((c>>16)&255)*.75)<<16)|((((c>>8)&255)*.75)<<8)|((c&255)*.75);
        lowerColors[k*MS+m]=c;lowerMaterials[k*MS+m]=material;
      }
    }
    for(let j=1;j<=N;j++)for(let i=1;i<=N;i++){
      const k=j*P+i;
      for(let m=0;m<nSpan[k];m++){
        const bit=1<<m;
        if(!faceExists(k,m) || (lowerUsed[k]&bit))continue;
        const y=height(k,m),c=lowerColors[k*MS+m],material=lowerMaterials[k*MS+m];
        const same=(kk:number)=>!(lowerUsed[kk]&bit) && faceExists(kk,m) && height(kk,m)===y && lowerColors[kk*MS+m]===c && lowerMaterials[kk*MS+m]===material;
        let w=1,h=1;
        while(i+w<=N && same(k+w))w++;
        grow:while(j+h<=N){for(let u=0;u<w;u++)if(!same(k+h*P+u))break grow;h++;}
        for(let v=0;v<h;v++)for(let u=0;u<w;u++)lowerUsed[k+v*P+u]|=bit;
        const lx=(i-1)*s,lz=(j-1)*s,ex=lx+w*s,ez=lz+h*s;
        if(underside)emit(lx,y,lz,ex,y,lz,ex,y,ez,lx,y,ez,0,-127,0,c,1,material);
        else emit(lx,y,lz,lx,y,ez,ex,y,ez,ex,y,lz,0,127,0,c,1,material);
        minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      }
    }
  }

  // --- sides
  const skirt = Math.max(3 * q, s * 0.5);
  for (let d = 0; d < 4; d++) {
    const [dx, dz] = SIDES[d];
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        const k = j * P + i;
        const ni = i + dx, nj = j + dz, nk = nj * P + ni;
        const edge = ni === 0 || ni === P - 1 || nj === 0 || nj === P - 1;
        if (nSpan[k] === 1 && nSpan[nk] === 1 && !authored[k]) {
          let bottom = tops[nk];
          if (edge) bottom = Math.min(bottom, tops[k]) - skirt;
          bottoms[k] = bottom < tops[k] ? bottom : NaN;
          if (bottom < minY) minY = bottom;
          continue;
        }
        bottoms[k] = NaN;
        // exact: each solid span of this column, minus what the neighbour covers
        for (let m = 0; m < nSpan[k]; m++) {
          let pc = 1;
          pieceLo[0] = lo[k * MS + m];
          pieceHi[0] = hi[k * MS + m];
          for (let o = 0; o < nSpan[nk] && pc > 0; o++) {
            let a = lo[nk * MS + o], b = hi[nk * MS + o];
            if (edge && o === 0) b = Math.max(a, b - skirt);
            if (b <= a) continue;
            let w = 0;
            for (let p = 0; p < pc; p++) {
              const l = pieceLo[p], h = pieceHi[p];
              if (h <= a || l >= b) { pieceLo[w] = l; pieceHi[w++] = h; continue; }
              const l2 = l, h2 = h;
              if (l2 < a) { pieceLo[w] = l2; pieceHi[w++] = a; }
              if (h2 > b) { pieceLo[w] = b; pieceHi[w++] = h2; }
            }
            pc = w;
          }
          for (let p = 0; p < pc; p++) {
            const l = pieceLo[p], h = pieceHi[p];
            if (h <= l || l < -1e8) continue;
            materialSide(d, i, j, 1, h, l, k);
            if (l < minY) minY = l;
          }
        }
      }
    }
    // undamaged neighbours: runs along the face (x-facing sides run along z, z-facing along x)
    const alongJ = dx !== 0;
    for (let a = 1; a <= N; a++) {
      let b = 1;
      while (b <= N) {
        const k = alongJ ? b * P + a : a * P + b;
        const bot = bottoms[k];
        if (Number.isNaN(bot)) { b++; continue; }
        const t = tops[k], c = rgb[k];
        let len = 1;
        for (;;) {
          const nb = b + len;
          if (nb > N) break;
          const kk = alongJ ? nb * P + a : a * P + nb;
          if (bottoms[kk] !== bot || tops[kk] !== t || rgb[kk] !== c || mat[kk] !== mat[k] || base[kk] !== base[k]) break;
          len++;
        }
        if (alongJ) materialSide(d, a, b, len, t, bot, k);
        else materialSide(d, b, a, len, t, bot, k);
        b += len;
      }
    }
  }

  const quads = v / 4;
  const indices = v > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  for (let q2 = 0, o = 0; q2 < quads; q2++, o += 6) {
    const b = q2 * 4;
    indices[o] = b; indices[o + 1] = b + 1; indices[o + 2] = b + 2;
    indices[o + 3] = b; indices[o + 4] = b + 2; indices[o + 5] = b + 3;
  }
  return {
    positions: pos.slice(0, v * 3),
    normals: nrm.slice(0, v * 3),
    colors: clr.slice(0, v * 3),
    materials: materialIds.slice(0, v),
    indices,
    minY,
    maxY,
  };
}
