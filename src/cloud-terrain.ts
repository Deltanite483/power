import * as THREE from "three";

/** A shared world-space terrain field for clipping and lifting cloud density. */
export class CloudTerrain {
  readonly half = 44000;
  readonly size = 512;
  readonly data = new Float32Array(this.size * this.size);
  readonly texture: THREE.DataTexture;
  private readonly pending = new Set<number>();

  constructor(private sampleHeight: (x: number, z: number) => number) {
    for (let z = 0; z < this.size; z++) for (let x = 0; x < this.size; x++) this.sampleCell(x, z);
    this.texture = new THREE.DataTexture(this.data, this.size, this.size, THREE.RedFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  private sampleCell(x: number, z: number) {
    const wx = ((x + 0.5) / this.size * 2 - 1) * this.half;
    const wz = ((z + 0.5) / this.size * 2 - 1) * this.half;
    const height = this.sampleHeight(wx, wz);
    this.data[z * this.size + x] = Number.isFinite(height) ? height : -10000;
  }

  setSampler(sampleHeight: (x: number, z: number) => number) { this.sampleHeight = sampleHeight; }

  invalidate(x0: number, z0: number, x1: number, z1: number) {
    const index = (value: number) => (value / (2 * this.half) + 0.5) * this.size - 0.5;
    const ax = Math.max(0, Math.floor(index(x0)) - 1), bx = Math.min(this.size - 1, Math.ceil(index(x1)) + 1);
    const az = Math.max(0, Math.floor(index(z0)) - 1), bz = Math.min(this.size - 1, Math.ceil(index(z1)) + 1);
    for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) this.pending.add(z * this.size + x);
  }

  update() {
    if (!this.pending.size) return;
    for (const cell of this.pending) this.sampleCell(cell % this.size, Math.floor(cell / this.size));
    this.pending.clear();
    this.texture.needsUpdate = true;
  }

  height(x: number, z: number): number {
    const tx = THREE.MathUtils.clamp((x / (2 * this.half) + 0.5) * this.size - 0.5, 0, this.size - 1);
    const tz = THREE.MathUtils.clamp((z / (2 * this.half) + 0.5) * this.size - 0.5, 0, this.size - 1);
    const ix = Math.floor(tx), iz = Math.floor(tz), fx = tx - ix, fz = tz - iz;
    const jx = Math.min(this.size - 1, ix + 1), jz = Math.min(this.size - 1, iz + 1);
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(this.data[iz * this.size + ix], this.data[iz * this.size + jx], fx),
      THREE.MathUtils.lerp(this.data[jz * this.size + ix], this.data[jz * this.size + jx], fx), fz);
  }
}
