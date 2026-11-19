import * as THREE from "three";
import { addRimLight } from "./fighter-mesh";

/**
 * A hanging strand: each segment's direction chases the pull of gravity and wind, later segments lagging more,
 * which is what makes cloth and hair whip and settle instead of swinging like a board.
 */
export class Chain {
  readonly directions: THREE.Vector3[];
  private readonly pull = new THREE.Vector3();
  private readonly ripple = new THREE.Vector3();

  constructor(readonly segments: number, private stiffness = 9, private lag = .4) {
    this.directions = Array.from({ length: segments }, () => new THREE.Vector3(0, -1, 0));
  }

  reset() { for (const direction of this.directions) direction.set(0, -1, 0); }

  /**
   * gravity and wind are in the strand's own frame. `out` is the direction the strand may never fold into
   * (through the body); flutter 0..1 adds a travelling wave.
   */
  update(dt: number, gravity: THREE.Vector3, wind: THREE.Vector3, time: number, flutter: number, out: THREE.Vector3) {
    this.pull.copy(gravity).addScaledVector(wind, .055);
    if (this.pull.lengthSq() < 1e-6) this.pull.set(0, -1, 0);
    this.pull.normalize();
    for (let i = 0; i < this.segments; i++) {
      const direction = this.directions[i], depth = i / this.segments;
      this.ripple.copy(this.pull);
      const wave = Math.sin(time * (7 + flutter * 9) - i * 1.15) * flutter * (.12 + depth * .42);
      this.ripple.addScaledVector(out, wave - .04);
      this.ripple.x += Math.sin(time * (4.3 + flutter * 5) - i * .8 + 1.7) * flutter * depth * .3;
      this.ripple.normalize();
      direction.lerp(this.ripple, 1 - Math.exp(-dt * this.stiffness / (1 + i * this.lag))).normalize();
      // Keep cloth on its own side of the body.
      const inward = direction.dot(out);
      if (inward < .02) direction.addScaledVector(out, .02 - inward).normalize();
    }
  }
}

const COLUMNS = 9, ROWS = 11, LENGTH = 1.12;

/** Faora's cape: a cloth sheet pinned at the shoulders that hangs, billows and streams with her motion. */
export class Cape {
  readonly mesh: THREE.Mesh;
  private readonly chain = new Chain(ROWS - 1, 10, .34);
  private readonly positions: THREE.BufferAttribute;
  private readonly point = new THREE.Vector3();
  private readonly back = new THREE.Vector3(0, 0, -1);

  constructor(cloth: number, trim: number) {
    const geometry = new THREE.BufferGeometry();
    const count = COLUMNS * ROWS, colors = new Float32Array(count * 3), indices: number[] = [];
    const base = new THREE.Color(cloth), edge = new THREE.Color(trim), shade = new THREE.Color();
    for (let row = 0; row < ROWS; row++) for (let column = 0; column < COLUMNS; column++) {
      const u = column / (COLUMNS - 1) * 2 - 1;
      const border = Math.abs(u) > .76 || row === ROWS - 1 || row === 0;
      const stripe = Math.abs(Math.abs(u) - .5) < .13;
      shade.copy(border ? edge : base).multiplyScalar(border ? .8 : stripe ? 1.55 : 1 - row / ROWS * .2);
      shade.toArray(colors, (row * COLUMNS + column) * 3);
      if (row < ROWS - 1 && column < COLUMNS - 1) {
        const a = row * COLUMNS + column, b = a + 1, c = a + COLUMNS, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    this.positions = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -.6, -.3), 1.6);
    const material = addRimLight(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .78, metalness: .05, side: THREE.DoubleSide }), .22);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.layout(0, 0);
  }

  reset() { this.chain.reset(); this.layout(0, 0); }

  /** gravity and wind in the cape anchor's frame (the fighter's chest). */
  update(dt: number, gravity: THREE.Vector3, wind: THREE.Vector3, time: number) {
    const flutter = THREE.MathUtils.smoothstep(wind.length(), 2, 70);
    this.chain.update(dt, gravity, wind, time, .08 + flutter * .92, this.back);
    this.layout(time, flutter);
  }

  private layout(time: number, flutter: number) {
    const p = this.positions, segment = LENGTH / (ROWS - 1);
    this.point.set(0, 0, 0);
    for (let row = 0; row < ROWS; row++) {
      const depth = row / (ROWS - 1);
      // Narrow at the collar, flaring toward the hem, and gathering in when it streams flat out behind her.
      const half = THREE.MathUtils.lerp(.17, .36 - flutter * .07, Math.pow(depth, .8));
      for (let column = 0; column < COLUMNS; column++) {
        const u = column / (COLUMNS - 1) * 2 - 1;
        const fold = Math.sin(u * 4.2 + depth * 2 + time * (1.2 + flutter * 6)) * depth * (.016 + flutter * .03);
        // The middle bows away from the body; the edges wrap toward the shoulders.
        const bow = (1 - u * u) * (.045 + depth * .05) - (1 - depth) * Math.abs(u) * .03;
        p.setXYZ(row * COLUMNS + column, this.point.x + u * half, this.point.y, this.point.z - bow + fold);
      }
      if (row < ROWS - 1) this.point.addScaledVector(this.chain.directions[row], segment);
    }
    p.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }
}
