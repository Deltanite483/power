import * as THREE from "three";

const STRANDS = 9, SEGMENTS = 7;

/** A single additive draw per fighter. Blue traces jump between points; red flames climb in curling strands. */
export class CursedReserveAura {
  readonly mesh: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly positions = new Float32Array(STRANDS * SEGMENTS * 6);
  private readonly colors = new Float32Array(this.positions.length);
  private time = 0;
  private nextUpdate = 0;
  private level = 0;

  constructor(private electric: boolean) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 2.8);
    this.mesh = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.mesh.visible = false;
  }

  update(dt: number, reserve: number) {
    this.time += dt;
    this.level += (reserve - this.level) * Math.min(1, dt * 12);
    this.mesh.visible = this.level > .035;
    if (!this.mesh.visible) return;
    this.mesh.material.opacity = .22 + .62 * this.level;
    this.nextUpdate -= dt;
    if (this.nextUpdate > 0) return;
    this.nextUpdate = 1 / 30;
    const strands = Math.ceil(STRANDS * this.level);
    this.mesh.geometry.setDrawRange(0, strands * SEGMENTS * 2);
    const cycle = Math.floor(this.time * 19);
    for (let strand = 0; strand < strands; strand++) {
      let x = 0, y = 0, z = 0, brightness = 0;
      for (let joint = 0; joint <= SEGMENTS; joint++) {
        const t = joint / SEGMENTS, phase = strand * 2.39996 + this.time * (this.electric ? .8 : 1.7);
        const flicker = Math.sin(cycle * 4.3 + strand * 9.7 + joint * 14.2);
        const angle = phase + (this.electric ? t * 2.8 + flicker * .46 : t * (.6 + strand * .13) + .25 * Math.sin(t * 8 + phase));
        const radius = .4 + this.level * .18 + (this.electric ? .24 * flicker : t * .52);
        const px = Math.cos(angle) * radius, pz = Math.sin(angle) * radius;
        const py = .08 + t * (1.05 + this.level * 1.35) + (this.electric ? flicker * .14 : Math.sin(phase) * t * .37);
        const light = (1 - t * .70) * (.5 + this.level * .5) * (.86 + .14 * flicker);
        if (joint) {
          const index = (strand * SEGMENTS + joint - 1) * 6;
          this.positions[index] = x; this.positions[index + 1] = y; this.positions[index + 2] = z;
          this.positions[index + 3] = px; this.positions[index + 4] = py; this.positions[index + 5] = pz;
          this.color(index, brightness); this.color(index + 3, light);
        }
        x = px; y = py; z = pz; brightness = light;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  private color(index: number, light: number) {
    this.colors[index] = light * (this.electric ? .13 : 1.4);
    this.colors[index + 1] = light * (this.electric ? .70 : .045);
    this.colors[index + 2] = light * (this.electric ? 1.55 : .08);
  }
}
