import * as THREE from "three";

export type CloudBank = THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>;
interface DamageGrid {
  data: Uint8Array;
  touched: Float32Array;
  texture: THREE.Data3DTexture;
  nx: number;
  ny: number;
  nz: number;
  active: number[];
  healAfter: number;
}

/** Lazy, cloud-local density removal: holes travel with their parent cloud. */
export class CloudDamage {
  readonly empty = this.texture(new Uint8Array(1), 1, 1, 1);
  private readonly grids = new Map<CloudBank, DamageGrid>();
  private lastHeal = 0;
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();

  private texture(data: Uint8Array, nx: number, ny: number, nz: number) {
    const texture = new THREE.Data3DTexture(data, nx, ny, nz);
    texture.format = THREE.RedFormat;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
  }

  carve(bank: CloudBank, from: THREE.Vector3, to: THREE.Vector3, radius: number, now: number): boolean {
    bank.worldToLocal(this.start.copy(from));
    bank.worldToLocal(this.end.copy(to));
    const a = this.start, b = this.end, scale = bank.scale;
    // Bound work to cells touched by the swept capsule, including its feathered edge.
    const rx = radius * 1.15 / scale.x, ry = radius * 1.15 / scale.y, rz = radius * 1.15 / scale.z;
    const lx = Math.min(a.x, b.x) - rx, hx = Math.max(a.x, b.x) + rx;
    const ly = Math.min(a.y, b.y) - ry, hy = Math.max(a.y, b.y) + ry;
    const lz = Math.min(a.z, b.z) - rz, hz = Math.max(a.z, b.z) + rz;
    if (hx < -0.5 || lx > 0.5 || hy < -0.5 || ly > 0.5 || hz < -0.5 || lz > 0.5) return false;

    let grid = this.grids.get(bank);
    if (!grid) {
      const cell = Math.max(12, Math.max(scale.x, scale.y, scale.z) / 96);
      const nx = Math.max(8, Math.ceil(scale.x / cell));
      const ny = Math.max(8, Math.ceil(scale.y / cell));
      const nz = Math.max(8, Math.ceil(scale.z / cell));
      const data = new Uint8Array(nx * ny * nz);
      grid = { data, touched: new Float32Array(data.length), texture: this.texture(data, nx, ny, nz), nx, ny, nz, active: [], healAfter: now + 10 };
      this.grids.set(bank, grid);
      bank.material.uniforms.uDamage.value = grid.texture;
      bank.material.uniforms.uHasDamage.value = true;
    }
    const { nx, ny, nz, data, touched } = grid;
    const x0 = Math.max(0, Math.floor((lx + 0.5) * nx)), x1 = Math.min(nx - 1, Math.ceil((hx + 0.5) * nx));
    const y0 = Math.max(0, Math.floor((ly + 0.5) * ny)), y1 = Math.min(ny - 1, Math.ceil((hy + 0.5) * ny));
    const z0 = Math.max(0, Math.floor((lz + 0.5) * nz)), z1 = Math.min(nz - 1, Math.ceil((hz + 0.5) * nz));
    const dx = (b.x - a.x) * scale.x, dy = (b.y - a.y) * scale.y, dz = (b.z - a.z) * scale.z;
    const lengthSq = Math.max(0.0001, dx * dx + dy * dy + dz * dz);
    let changed = false, touchedAny = false;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = ((x + 0.5) / nx - 0.5 - a.x) * scale.x;
      const py = ((y + 0.5) / ny - 0.5 - a.y) * scale.y;
      const pz = ((z + 0.5) / nz - 0.5 - a.z) * scale.z;
      const t = THREE.MathUtils.clamp((px * dx + py * dy + pz * dz) / lengthSq, 0, 1);
      const distance = Math.hypot(px - dx * t, py - dy * t, pz - dz * t);
      // Uneven margins leave torn wisps around a fully transparent core.
      const rough = 1 + 0.06 * Math.sin(x * 1.7 + z * 0.8) * Math.sin(y * 1.3 - z * 0.6);
      const amount = Math.round(255 * (1 - THREE.MathUtils.smoothstep(distance, radius * 0.78 * rough, radius * 1.1 * rough)));
      if (amount <= 0) continue;
      const i = (z * ny + y) * nx + x;
      if (data[i] === 0) grid.active.push(i);
      if (amount > data[i]) { data[i] = amount; changed = true; }
      touched[i] = now;
      touchedAny = true;
    }
    if (changed) grid.texture.needsUpdate = true;
    return touchedAny;
  }

  /** CPU sampling uses the same mask as the volume shader, including healed holes. */
  removal(bank: CloudBank, p: THREE.Vector3): number {
    const grid = this.grids.get(bank);
    if (!grid) return 0;
    const { nx, ny, nz, data } = grid;
    const x = THREE.MathUtils.clamp((p.x + 0.5) * nx - 0.5, 0, nx - 1);
    const y = THREE.MathUtils.clamp((p.y + 0.5) * ny - 0.5, 0, ny - 1);
    const z = THREE.MathUtils.clamp((p.z + 0.5) * nz - 0.5, 0, nz - 1);
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    let amount = 0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const index = (Math.min(nz - 1, iz + dz) * ny + Math.min(ny - 1, iy + dy)) * nx + Math.min(nx - 1, ix + dx);
      amount += data[index] / 255 * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    }
    return THREE.MathUtils.smoothstep(amount, 0.15, 0.90);
  }

  update(now: number) {
    const dt = now - this.lastHeal;
    if (dt < 0.25) return;
    this.lastHeal = now;
    for (const [bank, grid] of this.grids) {
      if (now < grid.healAfter) continue;
      let changed = false, nextHeal = Infinity;
      let kept = 0;
      for (const i of grid.active) {
        // Keep an unmistakable opening for ten seconds, then gradually mix back in.
        const elapsed = Math.min(dt, Math.max(0, now - grid.touched[i] - 10));
        if (elapsed > 0) {
          grid.data[i] = Math.max(0, grid.data[i] - Math.max(1, Math.round(255 * elapsed / 16)));
          changed = true;
        }
        if (grid.data[i]) {
          grid.active[kept++] = i;
          nextHeal = Math.min(nextHeal, Math.max(now + 0.25, grid.touched[i] + 10));
        }
      }
      grid.active.length = kept;
      grid.healAfter = nextHeal;
      if (!grid.active.length) {
        bank.material.uniforms.uDamage.value = this.empty;
        bank.material.uniforms.uHasDamage.value = false;
        grid.texture.dispose();
        this.grids.delete(bank);
      } else if (changed) grid.texture.needsUpdate = true;
    }
  }
}
