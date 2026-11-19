import { Heightfield, type TerrainData } from "./heightfield";
import { Edits } from "./edits";
import { buildChunk } from "./mesher";
import { buildFarTile } from "./far";

export type WorkerIn =
  | { type: "init"; terrain: TerrainData }
  | { type: "edits"; mode: "append" | "reset"; data: Float32Array; healing: boolean }
  | { type: "build"; id: number; x0: number; z0: number; s: number; clock: number; far: boolean };

let hf: Heightfield | null = null;
const edits = new Edits();

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === "init") {
    hf = new Heightfield(msg.terrain);
    return;
  }
  if (msg.type === "edits") {
    edits.healing = msg.healing;
    if (msg.mode === "reset") edits.reset(msg.data);
    else edits.append(msg.data);
    return;
  }
  const active = edits.count ? edits : null;
  if (msg.far) {
    const m = buildFarTile(hf!, active, msg.x0, msg.z0, msg.s, msg.clock);
    (self as unknown as Worker).postMessage({ id: msg.id, mesh: m }, [
      m.positions.buffer, m.normals.buffer, m.colors.buffer, m.materials.buffer, m.indices.buffer,
      m.coarseY.buffer, m.coarseN.buffer, m.coarseC.buffer,
    ]);
    return;
  }
  const m = buildChunk(hf!, active, msg.x0, msg.z0, msg.s, msg.clock);
  (self as unknown as Worker).postMessage({ id: msg.id, mesh: m }, [
    m.positions.buffer,
    m.normals.buffer,
    m.colors.buffer,
    m.materials.buffer,
    m.indices.buffer,
  ]);
};
