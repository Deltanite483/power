import type { GridMeta, TerrainData } from "./heightfield";

export interface Place {
  name: string;
  kind: string;
  tier: number;
  x: number;
  z: number;
  ele: number;
  municipality: boolean;
}

export interface WorldData {
  terrain: TerrainData;
  places: Place[];
  border: [number, number][][];
  rivers: { name: string; line: [number, number][] }[];
}

export type MapId = "vaduz" | "manhattan" | "manhattan-island";

const RIVER_WIDTH: Record<string, number> = { Rhein: 110, Rhine: 110, Binnenkanal: 14 };

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function u16(url: string): Promise<Uint16Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint16Array(await r.arrayBuffer());
}

/** Paint river centrelines into a mask on the inner grid. */
function rasterRivers(meta: GridMeta, rivers: WorldData["rivers"]): Uint8Array {
  const { width: w, height: h, cell_m: cell, origin_x: ox, origin_z: oz } = meta;
  const mask = new Uint8Array(w * h);
  for (const river of rivers) {
    const half = (RIVER_WIDTH[river.name] ?? 8) / 2;
    const reach = half + cell;
    for (let s = 0; s + 1 < river.line.length; s++) {
      const [ax, az] = river.line[s], [bx, bz] = river.line[s + 1];
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - ox) / cell));
      const c1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + reach - ox) / cell));
      const r0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - oz) / cell));
      const r1 = Math.min(h - 1, Math.ceil((Math.max(az, bz) + reach - oz) / cell));
      const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const px = ox + (c + 0.5) * cell, pz = oz + (r + 0.5) * cell;
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
          const d = Math.hypot(px - ax - dx * t, pz - az - dz * t);
          // soft edge so narrow streams still register on the bilinear sample
          const v = Math.max(0, Math.min(1, (half + cell * 0.5 - d) / cell));
          const i = r * w + c;
          const q = Math.round(v * 255);
          if (q > mask[i]) mask[i] = q;
        }
      }
    }
  }
  return mask;
}

export async function loadWorld(map: MapId = "vaduz"): Promise<WorldData> {
  if (map === "manhattan-island") {
    const [meta, data] = await Promise.all([
      json<GridMeta>("data/manhattan-island-terrain.json"),
      u16("data/manhattan-island-terrain.bin"),
    ]);
    const seabed = { ...meta, width: 2, height: 2, origin_x: 0, origin_z: 0 };
    return {
      terrain: {
        inner: { meta, data },
        outer: { meta: seabed, data: new Uint16Array(4) },
        water: new Uint8Array(data.length),
      },
      places: [], border: [], rivers: [],
    };
  }
  if (map === "manhattan") {
    // Keep the flat arena above the terrain engine's fixed water plane.
    const meta: GridMeta = {
      width: 64, height: 64, cell_m: 10, min_m: 420, step_m: 0.05,
      origin_x: -320, origin_z: -320,
    };
    const grid = { meta, data: new Uint16Array(meta.width * meta.height) };
    return {
      terrain: { inner: grid, outer: grid, water: new Uint8Array(grid.data.length) },
      places: [], border: [], rivers: [],
    };
  }
  const [im, om, ib, ob, places, border] = await Promise.all([
    json<GridMeta>("data/terrain.json"),
    json<GridMeta>("data/outer.json"),
    u16("data/terrain.bin"),
    u16("data/outer.bin"),
    json<{ places: Place[] }>("data/places.json"),
    json<{ border: [number, number][][]; rivers: WorldData["rivers"] }>("data/border.json"),
  ]);
  return {
    terrain: {
      inner: { meta: im, data: ib },
      outer: { meta: om, data: ob },
      water: rasterRivers(im, border.rivers),
    },
    places: places.places,
    border: border.border,
    rivers: border.rivers,
  };
}
