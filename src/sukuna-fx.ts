import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const UP = new THREE.Vector3(0, 1, 0);
const pixelHeight = () => typeof innerHeight === "undefined" ? 900 : innerHeight * Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, 1.5);
const NOISE = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  // Tiles every "period" cells along x, so it wraps cleanly round a cylinder.
  float noise(vec2 p, float period) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float x0 = mod(i.x, period), x1 = mod(i.x + 1.0, period);
    return mix(mix(hash(vec2(x0, i.y)), hash(vec2(x1, i.y)), f.x), mix(hash(vec2(x0, i.y + 1.0)), hash(vec2(x1, i.y + 1.0)), f.x), f.y);
  }
  float fbm(vec2 p, float period) {
    return noise(p, period) * .58 + noise(p * 2.0 + vec2(7.0, 3.7), period * 2.0) * .29 + noise(p * 4.0 + vec2(3.0, 9.1), period * 4.0) * .13;
  }`;

/**
 * Cut marks: thin camera-facing scars that snap open white, then hang as an ink line with a red glow.
 * One instanced draw call; everything after the spawn runs on the GPU.
 */
export class SlashMarks {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly center: Float32Array;
  private readonly axis: Float32Array;
  private readonly life: Float32Array;
  private readonly width: Float32Array;
  private head = 0;
  private time = 0;
  private lastDeath = -1;
  private changed = false;

  constructor(private readonly cap = 160) {
    this.center = new Float32Array(cap * 3); this.axis = new Float32Array(cap * 3);
    this.life = new Float32Array(cap * 2).fill(-1e9); this.width = new Float32Array(cap);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    for (const [name, array, size] of [["aCenter", this.center, 3], ["aAxis", this.axis, 3], ["aLife", this.life, 2], ["aWidth", this.width, 1]] as const)
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
    geometry.instanceCount = cap;
    this.mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uHeight: { value: 900 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 aCenter, aAxis;
        attribute vec2 aLife;
        attribute float aWidth;
        uniform float uTime, uHeight;
        varying vec2 vUv;
        varying float vT;
        void main() {
          float age = uTime - aLife.x;
          if (age < 0.0 || age > aLife.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vT = age / aLife.y; vUv = position.xy;
          vec4 mv = viewMatrix * vec4(aCenter, 1.0);
          vec3 along = mat3(viewMatrix) * aAxis;
          vec3 side = cross(normalize(along), normalize(-mv.xyz));
          side = length(side) > .001 ? normalize(side) : vec3(0.0, 1.0, 0.0);
          float pixel = 2.0 * max(1.0, -mv.z) / (projectionMatrix[1][1] * uHeight);
          float width = max(aWidth * (1.0 + vT * .5), pixel * 2.2);
          mv.xyz += along * position.x + side * position.y * width;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec2 vUv;
        varying float vT;
        void main() {
          #include <logdepthbuf_fragment>
          float along = vUv.x, across = abs(vUv.y);
          // The cut races from one end to the other in the first instants, then tapers to points.
          float reveal = 1.0 - smoothstep(-.1, .0, along * .5 + .5 - vT * 9.0);
          float taper = pow(max(0.0, 1.0 - along * along), .55);
          float ink = 1.0 - smoothstep(.28 * taper, .5 * taper, across);
          float core = (1.0 - smoothstep(0.0, .2 * taper, across)) * (1.0 - smoothstep(.1, .42, vT));
          float glow = (1.0 - smoothstep(.2, 1.0, across)) * taper;
          vec3 color = mix(vec3(1.0, .05, .13) * 1.3, vec3(.012, .008, .014), ink);
          color = mix(color, vec3(1.0, .95, .94) * 1.6, core);
          float alpha = max(ink, glow * .6) * reveal * (1.0 - smoothstep(.4, 1.0, vT));
          if (alpha < .004) discard;
          gl_FragColor = vec4(color, alpha);
          #include <colorspace_fragment>
        }`,
    }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 6; this.mesh.visible = false;
  }

  /** A cut centred on (x, y, z), running `length` metres along the unit vector (dx, dy, dz). */
  emit(x: number, y: number, z: number, dx: number, dy: number, dz: number, length: number, width: number, life: number, delay = 0) {
    const i = this.head; this.head = (this.head + 1) % this.cap;
    const half = length / 2;
    this.center.set([x, y, z], i * 3); this.axis.set([dx * half, dy * half, dz * half], i * 3);
    this.life.set([this.time + delay, life], i * 2); this.width[i] = width;
    this.lastDeath = Math.max(this.lastDeath, this.time + delay + life);
    this.changed = true; this.mesh.visible = true;
  }

  /** A cut at a random angle through `point`, loosely facing along `facing` when one is given. */
  scatter(point: THREE.Vector3, spread: number, length: number, width: number, life: number, delay = 0, flat = .55) {
    const angle = Math.random() * Math.PI * 2, rise = (Math.random() - .5) * 2 * flat;
    const horizontal = Math.sqrt(1 - rise * rise);
    const ox = (Math.random() - .5) * 2 * spread, oy = (Math.random() - .5) * spread, oz = (Math.random() - .5) * 2 * spread;
    this.emit(point.x + ox, point.y + oy, point.z + oz, Math.cos(angle) * horizontal, rise, Math.sin(angle) * horizontal,
      length * (.6 + Math.random() * .8), width, life * (.75 + Math.random() * .5), delay);
  }

  clear() {
    this.life.fill(-1e9); this.lastDeath = -1; this.changed = true; this.mesh.visible = false;
  }

  update(dt: number) {
    this.time += dt;
    const { uniforms } = this.mesh.material;
    uniforms.uTime.value = this.time; uniforms.uHeight.value = pixelHeight();
    if (this.time > this.lastDeath) this.mesh.visible = false;
    if (!this.changed) return;
    for (const name of ["aCenter", "aAxis", "aLife", "aWidth"]) this.mesh.geometry.getAttribute(name).needsUpdate = true;
    this.changed = false;
  }
}

export type FlameLook = "curse" | "heal" | "fire";
const LOOKS: Record<FlameLook, { edge: number; mid: number; core: number; additive: boolean }> = {
  // Cursed energy burns dark: black at the heart, crimson only where it thins.
  curse: { edge: 0xd8102a, mid: 0x3a0410, core: 0x050104, additive: false },
  heal: { edge: 0x3b8f7c, mid: 0xb9f2df, core: 0xffffff, additive: true },
  fire: { edge: 0xe0260a, mid: 0xff8a1c, core: 0xfff0b8, additive: true },
};

/** Flames licking up (or back along) any open tube whose v runs from base to tip. */
export function flameMaterial(look: FlameLook, options: { stretch?: number; speed?: number; base?: number; soft?: number; flip?: boolean; cut?: number; floor?: number } = {}) {
  const { edge, mid, core, additive } = LOOKS[look];
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uOpacity: { value: 1 }, uSeed: { value: Math.random() * 40 },
      uEdge: { value: new THREE.Color(edge) }, uMid: { value: new THREE.Color(mid) }, uCore: { value: new THREE.Color(core) },
      uStretch: { value: options.stretch ?? 3 }, uSpeed: { value: options.speed ?? 2.4 }, uBase: { value: options.base ?? .45 },
      uSoft: { value: options.soft ?? .6 }, uFlip: { value: options.flip ? 1 : 0 },
      uCut: { value: options.cut ?? .4 }, uFloor: { value: options.floor ?? 0 },
    },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vNormal, vView;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalMatrix * normal; vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime, uOpacity, uSeed, uStretch, uSpeed, uBase, uSoft, uFlip, uCut, uFloor;
      uniform vec3 uEdge, uMid, uCore;
      varying vec2 vUv;
      varying vec3 vNormal, vView;
      ${NOISE}
      void main() {
        #include <logdepthbuf_fragment>
        float rise = mix(vUv.y, 1.0 - vUv.y, uFlip), sink = 1.0 - rise;
        float body = fbm(vec2(vUv.x * 6.0, rise * uStretch - uTime * uSpeed + uSeed), 6.0);
        float lick = fbm(vec2(vUv.x * 12.0 + 3.0, rise * uStretch * 2.3 - uTime * uSpeed * 1.8 + uSeed), 12.0);
        float heat = body * .7 + lick * .3 + sink * uBase - rise * .32;
        float alpha = smoothstep(uCut, uCut + .3, heat) * smoothstep(1.0, .82, rise) * smoothstep(0.0, uFloor + .0001, rise);
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        alpha *= mix(1.0, pow(facing, .9), uSoft) * uOpacity;
        if (alpha < .004) discard;
        vec3 color = mix(uEdge, uMid, smoothstep(.45, .72, heat));
        color = mix(color, uCore, smoothstep(.72, 1.0, heat));
        gl_FragColor = vec4(color, alpha);
        #include <colorspace_fragment>
      }`,
  });
}

/** The cursed energy that boils off Sukuna while he gathers a technique. */
export class CursedAura {
  readonly group = new THREE.Group();
  private readonly layers: Record<FlameLook, THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>>;
  private level = 0;
  private look: FlameLook = "curse";

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.CylinderGeometry(.5, .42, 1, 28, 8, true);
    geometry.translate(0, .5, 0);
    const layer = (look: FlameLook) => {
      const mesh = new THREE.Mesh(geometry, flameMaterial(look, { stretch: 3.2, speed: 2.4, base: .34, soft: .85, cut: .48, floor: .14 }));
      mesh.renderOrder = 3; mesh.visible = false;
      this.group.add(mesh);
      return mesh;
    };
    this.layers = { curse: layer("curse"), heal: layer("heal"), fire: layer("fire") };
    this.group.visible = false;
    scene.add(this.group);
  }

  update(dt: number, time: number, feet: THREE.Vector3, target: number, look: FlameLook) {
    if (target > 0) this.look = look;
    this.level += (target - this.level) * (1 - Math.exp(-dt * (target > this.level ? 7 : 4)));
    if (this.level < .01 && target === 0) { this.hide(); return; }
    this.group.visible = true;
    this.group.position.copy(feet).y -= .08;
    this.group.scale.set(1 + this.level * .25, 1.7 + this.level * 1.0, 1 + this.level * .25);
    for (const key of ["curse", "heal", "fire"] as const) {
      const mesh = this.layers[key];
      mesh.visible = key === this.look;
      mesh.material.uniforms.uTime.value = time;
      mesh.material.uniforms.uOpacity.value = Math.min(1, this.level * (key === "curse" ? .8 : .55));
    }
  }

  hide() { this.level = 0; this.group.visible = false; }
}

/** Black Flash: a jagged star of black lightning with a red fringe, snapping out and gone in a third of a second. */
export class BlackFlashFx {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private age = 1;

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { uT: { value: 1 }, uSeed: { value: 0 }, uSize: { value: 4 } },
      transparent: true, depthWrite: false, depthTest: false, toneMapped: false, fog: false,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform float uSize;
        varying vec2 vUv;
        void main() {
          vUv = position.xy;
          vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy * uSize;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uT, uSeed;
        varying vec2 vUv;
        ${NOISE}
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vUv), angle = atan(vUv.y, vUv.x);
          vec2 ring = vec2(cos(angle), sin(angle));
          float spikes = pow(noise(ring * 3.1 + uSeed, 4096.0), 3.6), barbs = noise(ring * 11.0 + uSeed * 3.1, 4096.0);
          float reach = (.14 + .86 * spikes) * (.7 + .6 * barbs) * mix(.3, 1.0, smoothstep(0.0, .2, uT));
          float d = r / max(reach, .001);
          float body = 1.0 - smoothstep(.8, 1.0, d);
          float fringe = smoothstep(.5, .95, d) * body;
          float core = (1.0 - smoothstep(0.0, .2, r)) * (1.0 - smoothstep(0.0, .4, uT));
          vec3 color = mix(vec3(.01, .005, .012), vec3(.95, .02, .06) * 1.2, fringe * fringe);
          color = mix(color, vec3(1.0, .96, .96) * 1.7, core);
          float alpha = max(body, core) * (1.0 - smoothstep(.55, 1.0, uT));
          if (alpha < .004) discard;
          gl_FragColor = vec4(color, alpha);
          #include <colorspace_fragment>
        }`,
    }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 8; this.mesh.visible = false;
    scene.add(this.mesh);
  }

  fire(point: THREE.Vector3, size = 4.2) {
    this.mesh.position.copy(point);
    this.mesh.material.uniforms.uSeed.value = Math.random() * 50;
    this.mesh.material.uniforms.uSize.value = size;
    this.age = 0; this.mesh.visible = true;
  }

  update(dt: number) {
    if (!this.mesh.visible) return;
    this.age += dt / .34;
    this.mesh.material.uniforms.uT.value = this.age;
    if (this.age >= 1) this.mesh.visible = false;
  }

  hide() { this.age = 1; this.mesh.visible = false; }
}

/** Fuga's arrow of flame, and the column it leaves standing where it lands. */
export class FugaFx {
  readonly arrow = new THREE.Group();
  readonly pillar: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  private readonly flame: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>;
  private readonly shaft: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  private pillarAge = 9;
  private pillarRadius = 1;
  private static readonly PILLAR_LIFE = 3.4;

  constructor(scene: THREE.Scene) {
    // Both cones point along +y with their base at the origin's tail end.
    const cone = new THREE.ConeGeometry(1, 1, 18, 10, true);
    cone.translate(0, -.5, 0);
    this.flame = new THREE.Mesh(cone, flameMaterial("fire", { stretch: 3.4, speed: 5.5, base: .62, soft: .25, flip: true }));
    this.shaft = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({
      color: 0xfff3c4, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    this.flame.renderOrder = 6; this.shaft.renderOrder = 7;
    this.arrow.add(this.flame, this.shaft);
    const column = new THREE.CylinderGeometry(.55, 1, 1, 32, 12, true);
    column.translate(0, .5, 0);
    this.pillar = new THREE.Mesh(column, flameMaterial("fire", { stretch: 3.6, speed: 2.8, base: .3, soft: .92, cut: .54, floor: .05 }));
    this.pillar.renderOrder = 5;
    this.arrow.visible = this.pillar.visible = false;
    scene.add(this.arrow, this.pillar);
  }

  /** tip is the arrowhead; strength 0..1 grows it from a spark between his hands into the full shot. */
  poseArrow(tip: THREE.Vector3, direction: THREE.Vector3, strength: number, flying: boolean, time: number) {
    this.arrow.position.copy(tip);
    this.arrow.quaternion.setFromUnitVectors(UP, direction);
    const length = flying ? 11 : .5 + strength * 1.5, girth = flying ? .85 : .1 + strength * .2;
    this.flame.scale.set(girth, length, girth);
    this.shaft.scale.set(girth * .22, length * (flying ? .5 : .9), girth * .22);
    this.flame.material.uniforms.uTime.value = time;
    this.flame.material.uniforms.uOpacity.value = .55 + strength * .45;
    this.shaft.material.opacity = .5 + strength * .5;
    this.arrow.visible = true;
  }

  hideArrow() { this.arrow.visible = false; }

  erupt(point: THREE.Vector3, radius: number) {
    this.pillar.position.copy(point).y -= 1.5;
    this.pillarRadius = radius;
    this.pillarAge = 0; this.pillar.visible = true;
  }

  update(dt: number, time: number) {
    if (!this.pillar.visible) return;
    this.pillarAge += dt;
    const t = this.pillarAge / FugaFx.PILLAR_LIFE;
    if (t >= 1) { this.pillar.visible = false; return; }
    const swell = 1 - Math.exp(-this.pillarAge * 9);
    const radius = this.pillarRadius * (.35 + .65 * swell) * (1 - t * .35);
    this.pillar.scale.set(radius, this.pillarRadius * (1.2 + swell * 2.6), radius);
    this.pillar.material.uniforms.uTime.value = time;
    this.pillar.material.uniforms.uOpacity.value = .7 * (1 - t) ** 1.4;
  }

  hide() { this.arrow.visible = this.pillar.visible = false; this.pillarAge = 9; }
}

/** The inside of the domain: a blood-dark sky that flares each time the shrine cuts. */
export class DomainSky {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private pulse = 0;
  private level = 0;

  constructor(scene: THREE.Scene, radius: number) {
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 20), new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uPulse: { value: 0 }, uTime: { value: 0 } },
      transparent: true, depthWrite: false, side: THREE.BackSide, toneMapped: false, fog: false,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uOpacity, uPulse, uTime;
        varying vec3 vDir;
        ${NOISE}
        void main() {
          #include <logdepthbuf_fragment>
          float h = vDir.y, around = atan(vDir.z, vDir.x) / 6.2831853 + .5;
          float drift = fbm(vec2(around * 16.0 + uTime * .01, h * 5.0 - uTime * .05), 16.0);
          vec3 color = mix(vec3(.5, .02, .06), vec3(.035, .0, .012), smoothstep(-.05, .75, h));
          color *= .65 + drift * .7 + uPulse * .9;
          float alpha = uOpacity * mix(.74, .5, smoothstep(0.0, .8, h));
          if (alpha < .004) discard;
          gl_FragColor = vec4(color, alpha);
          #include <colorspace_fragment>
        }`,
    }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 1; this.mesh.visible = false;
    scene.add(this.mesh);
  }

  flare() { this.pulse = 1; }

  update(dt: number, time: number, center: THREE.Vector3, active: boolean) {
    this.level += ((active ? 1 : 0) - this.level) * (1 - Math.exp(-dt * (active ? 2.2 : 3)));
    this.pulse *= Math.exp(-dt * 5);
    if (!active && this.level < .01) { this.hide(); return; }
    this.mesh.visible = true;
    this.mesh.position.copy(center);
    const { uniforms } = this.mesh.material;
    uniforms.uOpacity.value = this.level; uniforms.uPulse.value = this.pulse; uniforms.uTime.value = time;
  }

  hide() { this.level = this.pulse = 0; this.mesh.visible = false; }
}

/**
 * The Malevolent Shrine itself: a three-tiered hall on a stone plinth, a fanged maw for a door,
 * horns on every eave and the dead piled at its steps. Five draw calls. Its front faces +z.
 */
export function buildShrine(): THREE.Group {
  type Key = "wood" | "dark" | "bone" | "void" | "glow";
  const parts: Record<Key, THREE.BufferGeometry[]> = { wood: [], dark: [], bone: [], void: [], glow: [] };
  const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), euler = new THREE.Euler(), at = new THREE.Vector3(), size = new THREE.Vector3();
  const place = (key: Key, geometry: THREE.BufferGeometry) => parts[key].push(geometry.index ? geometry.toNonIndexed() : geometry);
  const add = (key: Key, geometry: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    geometry.applyMatrix4(matrix.compose(at.set(x, y, z), rotation.setFromEuler(euler.set(rx, ry, rz)), size.set(sx, sy, sz)));
    place(key, geometry);
  };
  const box = (key: Key, w: number, h: number, d: number, x: number, y: number, z: number) => add(key, new THREE.BoxGeometry(w, h, d), x, y, z);
  /** A horn or fang from `from` along `toward`. */
  const spike = (key: Key, from: [number, number, number], toward: [number, number, number], length: number, radius: number, tip = 0) => {
    const direction = new THREE.Vector3(...toward).normalize();
    const geometry: THREE.BufferGeometry = new THREE.CylinderGeometry(tip, radius, length, 6);
    at.set(...from).addScaledVector(direction, length / 2);
    geometry.applyMatrix4(matrix.compose(at, rotation.setFromUnitVectors(UP, direction), size.set(1, 1, 1)));
    place(key, geometry);
  };
  const skull = (x: number, y: number, z: number, r: number, turn: number) => {
    add("bone", new THREE.SphereGeometry(r, 10, 8), x, y, z, 0, turn, 0, 1, .92, 1.05);
    add("bone", new THREE.BoxGeometry(r * 1.05, r * .55, r * .8), x + Math.sin(turn) * r * .5, y - r * .72, z + Math.cos(turn) * r * .5, 0, turn, 0);
    for (const side of [-1, 1]) {
      const ex = x + Math.sin(turn) * r * .82 + Math.cos(turn) * side * r * .38, ez = z + Math.cos(turn) * r * .82 - Math.sin(turn) * side * r * .38;
      add("void", new THREE.SphereGeometry(r * .27, 6, 5), ex, y + r * .05, ez);
    }
  };

  // Plinth and steps.
  box("dark", 14.5, .8, 11.5, 0, .4, 0); box("dark", 12.6, .7, 9.6, 0, 1.15, 0);
  box("dark", 5.4, .4, 2.2, 0, .2, 6.5); box("dark", 5.4, .4, 1.4, 0, .6, 6.2); box("dark", 5.4, .4, .7, 0, 1.0, 5.9);
  // Hall: lacquered pillars, dark walls ribbed with bone, and the maw.
  for (const x of [-5, 5]) for (const z of [-3.5, 3.5]) box("wood", 1, 6.5, 1, x, 4.75, z);
  for (const x of [-2.6, 2.6]) box("wood", .9, 6.5, .9, x, 4.75, 3.55);
  box("dark", 10, 6.5, .5, 0, 4.75, -3.5);
  for (const x of [-5, 5]) box("dark", .5, 6.5, 7, x, 4.75, 0);
  for (const x of [-3.8, 3.8]) {
    box("dark", 2.2, 6.5, .4, x, 4.75, 3.4);
    for (const offset of [-.6, 0, .6]) box("bone", .16, 5.2, .16, x + offset, 4.5, 3.65);
  }
  for (const side of [-1, 1]) for (let i = 0; i < 5; i++) box("bone", .16, 5.2, .16, side * 5.28, 4.5, -2.4 + i * 1.2);
  box("wood", 6.2, .9, 1.1, 0, 7.15, 3.55); box("wood", 11, .7, .7, 0, 7.65, 3.5); box("wood", 11, .7, .7, 0, 7.65, -3.5);
  box("void", 4.4, 5.3, .3, 0, 4.1, 3.3);
  // A slit eye burning in the dark of the maw.
  add("glow", new THREE.SphereGeometry(1, 16, 10), 0, 3.95, 3.42, 0, 0, 0, .34, 1.75, .06);
  for (let i = 0; i < 7; i++) {
    const x = (i - 3) * .66, middle = 1 - Math.abs(i - 3) / 3;
    spike("bone", [x, 6.72, 3.7], [0, -1, .04], 1.1 + middle * .7, .3);
    spike("bone", [x + .33 * (i < 6 ? 1 : 0), 1.5, 3.7], [0, 1, .04], .8 + middle * .5, .28);
  }
  // Three roofs, each with a broad eave and a horn lifting off every corner.
  const roof = (y: number, halfWidth: number, halfDepth: number, height: number, top: number) => {
    box("dark", halfWidth * 2 + 1.4, .32, halfDepth * 2 + 1.4, 0, y + .16, 0);
    add("dark", new THREE.CylinderGeometry(top, 1, height, 4, 1), 0, y + .32 + height / 2, 0, 0, Math.PI / 4, 0, halfWidth / Math.SQRT1_2, 1, halfDepth / Math.SQRT1_2);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      spike("bone", [sx * (halfWidth + .5), y + .2, sz * (halfDepth + .5)], [sx * .9, 1, sz * .9], halfWidth * .34, .3);
      spike("wood", [sx * halfWidth * .45, y + .3 + height * .55, sz * halfDepth * .45], [sx * 1.6, -.62, sz * 1.6], Math.hypot(halfWidth, halfDepth) * .62, .16, .12);
    }
  };
  roof(8, 7.4, 5.7, 2.1, .58);
  box("wood", 8.2, 1.9, 5.8, 0, 11.3, 0);
  for (const x of [-3, -1, 1, 3]) box("void", .9, 1.1, .2, x, 11.3, 2.85);
  roof(12.25, 5.3, 3.9, 1.8, .5);
  box("wood", 4.6, 1.5, 3.1, 0, 15.1, 0);
  roof(15.85, 3.3, 2.5, 2.7, .04);
  // The great horns on the ridge, and ribs clawing up over the lowest eave.
  for (const side of [-1, 1]) {
    spike("bone", [side * .5, 18.2, 0], [side * 1, .45, 0], 2.3, .42, .3);
    spike("bone", [side * 2.55, 19.15, 0], [side * .55, 1, 0], 2.2, .3, .16);
    spike("bone", [side * 3.6, 21.05, 0], [-side * .15, 1, 0], 1.7, .16);
    for (let i = 0; i < 4; i++)
      add("bone", new THREE.TorusGeometry(1.5, .13, 5, 10, Math.PI * .8), side * 7.7, 8.3, -4.2 + i * 2.8, 0, side > 0 ? 0 : Math.PI, 0);
  }
  // The horned skull over the door, and the dead heaped at the steps.
  skull(0, 8.75, 4.25, 1.05, 0);
  for (const side of [-1, 1]) { spike("bone", [side * .85, 9.2, 4.1], [side * 1, .5, 0], 1.3, .26, .18); spike("bone", [side * 2.02, 9.8, 4.1], [side * .3, 1, 0], 1.2, .18); }
  const heap: [number, number, number, number, number][] = [
    [-3.6, 1.9, 4.6, .46, -.4], [-4.3, 1.85, 4.2, .4, .3], [-3.9, 2.55, 4.3, .38, -.1], [3.5, 1.9, 4.7, .48, .5], [4.3, 1.85, 4.3, .4, -.2],
    [3.9, 2.55, 4.4, .36, .2], [-6.4, .35, 6.2, .42, -.7], [6.2, .35, 6.4, .44, .6], [-3.3, .4, 7, .4, .2], [3.4, .4, 7.2, .38, -.3],
  ];
  for (const [x, y, z, r, turn] of heap) skull(x, y, z, r, turn);

  const materials: Record<Key, THREE.Material> = {
    wood: new THREE.MeshStandardMaterial({ color: 0x5c131f, emissive: 0x30060d, roughness: .78 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1b1219, emissive: 0x0d0307, roughness: .9 }),
    bone: new THREE.MeshStandardMaterial({ color: 0xd9cdb4, emissive: 0x33211c, roughness: .62 }),
    void: new THREE.MeshBasicMaterial({ color: 0x050003 }),
    glow: new THREE.MeshBasicMaterial({ color: 0xff1f38, toneMapped: false }),
  };
  const group = new THREE.Group();
  for (const key of Object.keys(parts) as Key[]) {
    const geometry = mergeGeometries(parts[key]);
    for (const part of parts[key]) part.dispose();
    geometry.computeBoundingSphere();
    group.add(new THREE.Mesh(geometry, materials[key]));
  }
  return group;
}
