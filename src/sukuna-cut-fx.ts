import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);
const SEGMENTS = 28;
const outer = (x: number) => .62 * Math.max(0, 1 - x * x) ** .6;
const inner = (x: number) => .34 * Math.max(0, 1 - x * x) ** 1.1;

const BLADE_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;
const BLADE_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uTime, uOpacity;
  uniform vec3 uGlow;
  varying vec2 vLocal;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    #include <logdepthbuf_fragment>
    float x = vLocal.x, y = vLocal.y, span = max(0.0, 1.0 - x * x);
    float rim = .62 * pow(span, .6), belly = .34 * pow(span, 1.1);
    float inside = min(y - belly, rim - y);
    float body = smoothstep(0.0, .022, inside) * step(abs(x), 1.0);
    // A white-hot cutting edge, an ink body, and cursed energy bleeding off both sides.
    float edge = body * (1.0 - smoothstep(0.0, .075, rim - y));
    float streak = noise(vec2(x * 11.0 - uTime * 34.0, y * 46.0));
    float halo = exp(-max(0.0, -inside) * 13.0) * (1.0 - body) * (.55 + streak * .45) * smoothstep(1.18, .9, abs(x));
    vec3 color = mix(vec3(.012, .008, .014), uGlow * .55, body * smoothstep(.1, 0.0, y - belly) * (.5 + streak * .5));
    color = mix(color, vec3(1.0, .93, .92) * 1.5, edge);
    color = mix(color, uGlow * 1.35, halo * (1.0 - body));
    float alpha = max(body, halo * .8) * uOpacity;
    if (alpha < .004) discard;
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }`;
const TRAIL_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;
const TRAIL_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uTime, uOpacity;
  uniform vec3 uGlow;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    #include <logdepthbuf_fragment>
    float across = vUv.x * 2.0 - 1.0, back = vUv.y;
    float streak = noise(vec2(across * 16.0, back * 2.4 + uTime * 9.0));
    float alpha = pow(1.0 - back, 1.7) * pow(max(0.0, 1.0 - across * across), .45) * (.35 + streak * .65) * uOpacity * .85;
    if (alpha < .004) discard;
    gl_FragColor = vec4(mix(vec3(.015, .008, .016), uGlow, smoothstep(.05, .75, back) * (.4 + streak * .6)), alpha);
    #include <colorspace_fragment>
  }`;

let bladeGeometry: THREE.PlaneGeometry | null = null;
let trailGeometry: THREE.BufferGeometry | null = null;
function geometries() {
  if (!bladeGeometry) {
    bladeGeometry = new THREE.PlaneGeometry(2.5, 1.3);
    bladeGeometry.translate(0, .32, 0);
    // The wake hangs off the blade's own curve, so it reads as one ribbon from the side.
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const x = -1 + 2 * i / SEGMENTS, y = (outer(x) + inner(x)) / 2;
      positions.push(x, y, 0, x, y, -1);
      uvs.push(i / SEGMENTS, 0, i / SEGMENTS, 1);
      if (i < SEGMENTS) { const a = i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    trailGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    trailGeometry.setIndex(indices);
  }
  return { blade: bladeGeometry, trail: trailGeometry! };
}

/** One of Sukuna's cuts: an ink crescent with a white edge and a crimson halo, dragging a ribbon of cursed energy. */
export class SukunaCutFx {
  readonly group = new THREE.Group();
  private readonly uniforms = { uTime: { value: 0 }, uOpacity: { value: 1 }, uGlow: { value: new THREE.Color(1, .07, .16) } };
  private readonly trail: THREE.Mesh;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();

  constructor(scene: THREE.Scene, glow = 0xff1229) {
    const { blade, trail } = geometries();
    this.uniforms.uGlow.value.setHex(glow);
    const material = (vertexShader: string, fragmentShader: string) => new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
    });
    this.trail = new THREE.Mesh(trail, material(TRAIL_VERTEX, TRAIL_FRAGMENT));
    const edge = new THREE.Mesh(blade, material(BLADE_VERTEX, BLADE_FRAGMENT));
    this.trail.renderOrder = 4; edge.renderOrder = 5;
    this.trail.frustumCulled = false;
    this.group.add(this.trail, edge);
    this.group.visible = false;
    scene.add(this.group);
  }

  /**
   * tilt rolls the blade about its line of travel; lean tips the crescent's belly toward that line (a swung cut);
   * wake is the length of the ribbon behind it, in blade widths.
   */
  pose(center: THREE.Vector3, direction: THREE.Vector3, width: number, tilt: number, opacity: number, lean = 0, wake = 0, time = 0) {
    this.right.crossVectors(UP, direction);
    if (this.right.lengthSq() < .001) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(direction, this.right);
    this.basis.makeBasis(this.right, this.up, direction);
    this.group.position.copy(center);
    this.group.quaternion.setFromRotationMatrix(this.basis);
    this.group.rotateZ(tilt);
    this.group.scale.setScalar(width);
    this.trail.visible = wake > 0;
    this.trail.scale.z = Math.max(.001, wake);
    if (lean) this.group.rotateX(lean);
    this.uniforms.uOpacity.value = opacity;
    this.uniforms.uTime.value = time;
    this.group.visible = true;
  }

  hide() { this.group.visible = false; }
}
