import * as THREE from "three";

const pixelHeight = () => typeof innerHeight === "undefined" ? 900 : innerHeight * Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, 1.5);
const QUAD = [-1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0];

/**
 * Sparks, droplets and puffs: ballistic particles drawn as quads stretched along their own motion.
 * One draw call per pool; flight, gravity, drag and fade all run on the GPU, so only spawning uploads data.
 */
export class Streaks {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly origin: Float32Array;
  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private readonly shape: Float32Array;
  private readonly color: Float32Array;
  private head = 0;
  private time = 0;
  private lastDeath = -1;
  private dirty: [number, number][] = [];

  constructor(private readonly cap: number, additive: boolean) {
    this.origin = new Float32Array(cap * 3); this.velocity = new Float32Array(cap * 3);
    this.life = new Float32Array(cap * 2).fill(-1e9); this.shape = new Float32Array(cap * 4); this.color = new Float32Array(cap * 4);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(QUAD, 3));
    for (const [name, array, size] of [["aOrigin", this.origin, 3], ["aVelocity", this.velocity, 3], ["aLife", this.life, 2], ["aShape", this.shape, 4], ["aColor", this.color, 4]] as const)
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
    geometry.instanceCount = cap;
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uHeight: { value: 900 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: !additive,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 aOrigin, aVelocity;
        attribute vec2 aLife;
        attribute vec4 aShape, aColor;
        uniform float uTime, uHeight;
        varying vec2 vUv;
        varying vec4 vColor;
        varying float vSoft;
        void main() {
          vSoft = aShape.x < 0.0 ? 1.0 : 0.0;
          float age = uTime - aLife.x;
          if (age < 0.0 || age > aLife.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float t = age / aLife.y, drag = max(.05, aShape.w);
          vec3 wp = aOrigin + aVelocity * (1.0 - exp(-drag * age)) / drag + vec3(0.0, -.5 * aShape.z * age * age, 0.0);
          vec3 motion = aVelocity * exp(-drag * age) + vec3(0.0, -aShape.z * age, 0.0);
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          vec3 seen = mat3(viewMatrix) * motion;
          vec2 axis = length(seen.xy) > .0001 ? normalize(seen.xy) : vec2(0.0, 1.0);
          float pixel = 2.0 * max(1.0, -mv.z) / (projectionMatrix[1][1] * uHeight);
          // Negative width marks a puff that swells instead of a streak that thins.
          float width = aShape.x < 0.0 ? -aShape.x * (.35 + t * 1.3) : max(aShape.x * (1.0 - t * .55), pixel * 1.1);
          float len = max(width, aShape.y * length(motion));
          mv.xy += axis * position.y * len + vec2(-axis.y, axis.x) * position.x * width;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
          vUv = position.xy;
          vColor = vec4(aColor.rgb, aColor.a * pow(1.0 - t, aShape.x < 0.0 ? 1.6 : .8) * smoothstep(0.0, .04, t));
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec2 vUv;
        varying vec4 vColor;
        varying float vSoft;
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vUv);
          float alpha = (1.0 - smoothstep(mix(.6, 0.0, vSoft), 1.0, r)) * vColor.a;
          if (alpha < .004) discard;
          // A hot centre line makes sparks read as glowing metal rather than paint.
          gl_FragColor = vec4(vColor.rgb * (1.0 + (1.0 - smoothstep(0.0, .35, abs(vUv.x))) * .6), alpha);
          ${additive ? "" : "#include <tonemapping_fragment>"}
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 9; this.mesh.visible = false;
  }

  /** width < 0 makes a soft swelling puff of that radius; stretch is seconds of motion drawn as tail. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, width: number, stretch: number,
    gravity: number, drag: number, r: number, g: number, b: number, alpha = 1) {
    const i = this.head; this.head = (this.head + 1) % this.cap;
    this.origin.set([x, y, z], i * 3); this.velocity.set([vx, vy, vz], i * 3);
    this.life.set([this.time, life], i * 2); this.shape.set([width, stretch, gravity, drag], i * 4); this.color.set([r, g, b, alpha], i * 4);
    this.lastDeath = Math.max(this.lastDeath, this.time + life);
    const last = this.dirty[this.dirty.length - 1];
    if (last && last[0] + last[1] === i) last[1]++; else this.dirty.push([i, 1]);
    this.mesh.visible = true;
  }

  update(dt: number) {
    this.time += dt;
    const { uniforms } = this.mesh.material;
    uniforms.uTime.value = this.time; uniforms.uHeight.value = pixelHeight();
    if (this.time > this.lastDeath) this.mesh.visible = false;
    if (!this.dirty.length) return;
    for (const name of ["aOrigin", "aVelocity", "aLife", "aShape", "aColor"]) {
      const attribute = this.mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
      attribute.clearUpdateRanges();
      for (const [first, count] of this.dirty) attribute.addUpdateRange(first * attribute.itemSize, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.dirty.length = 0;
  }
}

export const FLASH_STAR = 0, FLASH_RING = 1, FLASH_GLOW = 2;

/** Impact flashes and expanding rings: additive quads, one draw call, animated on the GPU. */
export class Flashes {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly center: Float32Array;
  private readonly normal: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Float32Array;
  private head = 0;
  private time = 0;
  private lastDeath = -1;
  private changed = false;

  constructor(private readonly cap = 48) {
    this.center = new Float32Array(cap * 3); this.normal = new Float32Array(cap * 3);
    this.life = new Float32Array(cap * 2).fill(-1e9); this.size = new Float32Array(cap * 3); this.color = new Float32Array(cap * 4);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(QUAD, 3));
    for (const [name, array, size] of [["aCenter", this.center, 3], ["aNormal", this.normal, 3], ["aLife", this.life, 2], ["aSize", this.size, 3], ["aColor", this.color, 4]] as const)
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage));
    geometry.instanceCount = cap;
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 aCenter, aNormal, aSize;
        attribute vec2 aLife;
        attribute vec4 aColor;
        uniform float uTime;
        varying vec2 vUv;
        varying vec4 vColor;
        varying float vKind, vAge, vSeed;
        void main() {
          float age = uTime - aLife.x;
          if (age < 0.0 || age > aLife.y) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float t = age / aLife.y;
          float size = mix(aSize.x, aSize.y, 1.0 - pow(1.0 - t, 3.0));
          vec4 mv;
          if (aSize.z > .5 && aSize.z < 1.5) {
            vec3 n = normalize(aNormal);
            vec3 a = normalize(cross(n, abs(n.y) > .9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
            mv = viewMatrix * vec4(aCenter + (a * position.x + cross(n, a) * position.y) * size, 1.0);
          } else {
            mv = viewMatrix * vec4(aCenter, 1.0);
            mv.xy += position.xy * size;
          }
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
          vUv = position.xy; vColor = aColor; vKind = aSize.z; vAge = t; vSeed = aLife.x * 37.0;
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec2 vUv;
        varying vec4 vColor;
        varying float vKind, vAge, vSeed;
        void main() {
          #include <logdepthbuf_fragment>
          float r = length(vUv), angle = atan(vUv.y, vUv.x), fade = 1.0 - vAge, alpha;
          if (vKind < .5) {
            // A white-hot core with uneven rays that shorten as it dies.
            float rays = pow(abs(cos(angle * 3.0 + vSeed)), 14.0) + .6 * pow(abs(cos(angle * 5.0 - vSeed * 1.7)), 22.0);
            alpha = (exp(-r * r * 9.0) * 1.6 + rays * exp(-r * (3.2 + vAge * 5.0)) * .8) * fade * fade;
          } else if (vKind < 1.5) {
            // A thin bright front with a fainter band trailing inside it, broken up around the rim.
            float breakup = .7 + .3 * sin(angle * 11.0 + vSeed) * sin(angle * 5.0 - vSeed);
            alpha = (exp(-pow((r - .93) / .035, 2.0)) + .35 * exp(-pow((r - .78) / .09, 2.0))) * breakup * pow(fade, 1.4);
          } else alpha = exp(-r * r * 4.0) * fade * fade;
          alpha *= vColor.a * (1.0 - smoothstep(.96, 1.0, r));
          if (alpha < .003) discard;
          gl_FragColor = vec4(vColor.rgb, min(1.0, alpha));
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 9; this.mesh.visible = false;
  }

  emit(kind: number, p: THREE.Vector3, normal: THREE.Vector3 | null, life: number, startSize: number, endSize: number, r: number, g: number, b: number, alpha = 1) {
    const i = this.head; this.head = (this.head + 1) % this.cap;
    this.center.set([p.x, p.y, p.z], i * 3);
    this.normal.set(normal ? [normal.x, normal.y, normal.z] : [0, 1, 0], i * 3);
    this.life.set([this.time, life], i * 2); this.size.set([startSize, endSize, kind], i * 3); this.color.set([r, g, b, alpha], i * 4);
    this.lastDeath = Math.max(this.lastDeath, this.time + life);
    this.changed = true; this.mesh.visible = true;
  }

  update(dt: number) {
    this.time += dt;
    this.mesh.material.uniforms.uTime.value = this.time;
    if (this.time > this.lastDeath) this.mesh.visible = false;
    if (!this.changed) return;
    for (const name of ["aCenter", "aNormal", "aLife", "aSize", "aColor"]) (this.mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.changed = false;
  }
}

/** A volumetric-looking energy beam for an open unit cylinder: bright along its axis, soft at the silhouette, with energy racing down it. */
export function beamMaterial(inner: number, outer: number, additive: boolean, opacity = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uInner: { value: new THREE.Color(inner) }, uOuter: { value: new THREE.Color(outer) }, uOpacity: { value: opacity } },
    transparent: true, depthWrite: false, toneMapped: false, fog: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vNormal, vView, vLocal;
      varying float vLength;
      void main() {
        vLocal = position;
        vLength = length(modelMatrix[1].xyz);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // The cylinder is stretched hugely along its length, so rebuild the radial normal by hand.
        vNormal = normalize(mat3(modelViewMatrix) * vec3(position.x, 0.0, position.z));
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime, uOpacity;
      uniform vec3 uInner, uOuter;
      varying vec3 vNormal, vView, vLocal;
      varying float vLength;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        #include <logdepthbuf_fragment>
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float along = (vLocal.y + .5) * vLength, angle = atan(vLocal.z, vLocal.x);
        float flow = noise(vec2(angle * 2.0, along * .35 - uTime * 26.0)) * .6 + noise(vec2(angle * 5.0 + 3.0, along * 1.1 - uTime * 48.0)) * .4;
        float pulse = .85 + .15 * sin(along * .6 - uTime * 40.0);
        float body = pow(facing, 1.6) * pulse * (.7 + flow * .6);
        float start = smoothstep(0.0, min(1.5, vLength * .2), along);
        float alpha = body * start * uOpacity;
        if (alpha < .004) discard;
        vec3 color = mix(uOuter, uInner, pow(facing, 3.0) * (.6 + flow * .5));
        gl_FragColor = vec4(color * (1.0 + flow * .5), alpha);
        #include <colorspace_fragment>
      }`,
  });
}

const HOT: [number, number, number][] = [[3.2, 2.6, 1.6], [3, 1.5, .45], [2.4, .7, .15]];

/** Everything that sells a hit: the flash, the ring, the spray of sparks and the blood. */
export class CombatFx {
  readonly group = new THREE.Group();
  readonly sparks = new Streaks(640, true);
  readonly blood = new Streaks(320, false);
  readonly flashes = new Flashes(48);
  private beamClock = 0;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(scene?: THREE.Scene) {
    this.group.add(this.blood.mesh, this.sparks.mesh, this.flashes.mesh);
    scene?.add(this.group);
  }

  set warm(on: boolean) { for (const child of this.group.children) child.visible = on; }

  /** Random unit-ish vector inside a cone around `this.dir`. */
  private cone(spread: number, out: THREE.Vector3) {
    this.a.set(Math.random() - .5, Math.random() - .5, Math.random() - .5).normalize();
    return out.copy(this.dir).addScaledVector(this.a, spread).normalize();
  }

  private spray(p: THREE.Vector3, count: number, speed: number, spread: number, life: number, width: number, gravity = 9) {
    for (let i = 0; i < count; i++) {
      this.cone(spread, this.b);
      const s = speed * (.25 + Math.random() * Math.random() * 1.4), c = HOT[i % 3];
      this.sparks.emit(p.x, p.y, p.z, this.b.x * s, this.b.y * s, this.b.z * s, life * (.5 + Math.random()), width * (.6 + Math.random() * .8), .02, gravity, 2.2, c[0], c[1], c[2], 1);
    }
  }

  /** A blow landing on a body. power 0..1 scales everything; direction is the way the blow travels. */
  hit(point: THREE.Vector3, direction: THREE.Vector3 | undefined, power: number) {
    const k = THREE.MathUtils.clamp(power, .15, 1.6);
    this.dir.copy(direction ?? this.n.set(0, 1, 0)).normalize();
    this.flashes.emit(FLASH_STAR, point, null, .1 + k * .06, .25 + k * .4, .7 + k * 1.2, 3, 2.6, 1.9, .85);
    this.flashes.emit(FLASH_RING, point, this.dir, .22 + k * .16, .25, 1.6 + k * 3.4, 2.4, 2.1, 1.7, .55 + k * .3);
    if (k > .7) this.flashes.emit(FLASH_RING, this.a.copy(point).addScaledVector(this.dir, .5), this.dir, .34, .2, 3 + k * 4, 1.8, 1.7, 1.6, .4);
    this.spray(point, Math.round(8 + k * 22), 9 + k * 22, .85, .22 + k * .2, .007 + k * .006);
  }

  /** A full-speed body ram: a burst thrown forward through the target, with rings left behind along the path. */
  ram(point: THREE.Vector3, direction: THREE.Vector3, speed: number) {
    const k = THREE.MathUtils.clamp(speed / 200, .3, 1.8);
    this.dir.copy(direction).normalize();
    this.flashes.emit(FLASH_STAR, point, null, .22, 1 + k, 3 + k * 3.5, 3, 2.7, 2.2, .9);
    this.flashes.emit(FLASH_GLOW, point, null, .32, 2, 4 + k * 4, 1.6, 1.3, 1, .22);
    for (let i = 0; i < 3; i++)
      this.flashes.emit(FLASH_RING, this.a.copy(point).addScaledVector(this.dir, i * (1.2 + k * 1.6)), this.dir, .3 + i * .1, .4, (5 + k * 7) * (1 - i * .22), 2.2, 2.2, 2.4, .8 - i * .2);
    this.spray(point, Math.round(26 + k * 30), 25 + speed * .32, .55, .4, .014, 5);
    // White speed lines torn off sideways by the pressure front.
    for (let i = 0; i < 18; i++) {
      this.cone(1.6, this.b);
      const s = 14 + Math.random() * 30 * k;
      this.sparks.emit(point.x, point.y, point.z, this.b.x * s, this.b.y * s, this.b.z * s, .22 + Math.random() * .2, .018, .04, 0, 3.5, 1.5, 1.7, 2, .7);
    }
  }

  /** Call every frame a beam is burning into something. hot picks orange (Doomsday) over red (heat vision). */
  beamImpact(point: THREE.Vector3, direction: THREE.Vector3, dt: number, scale: number, hot: boolean) {
    this.beamClock -= dt;
    if (this.beamClock > 0) return;
    this.beamClock = .03;
    this.dir.copy(direction).negate().normalize();
    this.dir.y += .35; this.dir.normalize();
    const r = hot ? 3 : 3.2, g = hot ? 1.9 : .7, b = hot ? .8 : .35;
    this.flashes.emit(FLASH_STAR, point, null, .09, scale * (.9 + Math.random() * .5), scale * 1.9, r, g, b, .9);
    for (let i = 0; i < (hot ? 5 : 3); i++) {
      this.cone(1.1, this.b);
      const s = (7 + Math.random() * 16) * Math.sqrt(scale);
      this.sparks.emit(point.x, point.y, point.z, this.b.x * s, this.b.y * s, this.b.z * s, .3 + Math.random() * .45, .008 * scale + .006, .02, 12, 1.6, r, g * (.6 + Math.random() * .6), b, 1);
    }
  }

  /** Doomsday's stored-energy detonation. */
  nova(origin: THREE.Vector3, radius: number) {
    this.n.set(0, 1, 0);
    this.flashes.emit(FLASH_GLOW, origin, null, .55, radius * .12, radius * .8, 3, 1.6, .9, 1);
    this.flashes.emit(FLASH_STAR, this.a.copy(origin).setY(origin.y + Math.min(3, radius * .2)), null, .4, radius * .1, radius * .55, 3, 2.6, 2.2, 1);
    for (let i = 0; i < 3; i++)
      this.flashes.emit(FLASH_RING, this.a.copy(origin).setY(origin.y + .4 + i * Math.min(radius * .12, 2.5)), this.n, .7 + i * .25, radius * .04, radius * (1 - i * .18), 3, 1.1 + i * .3, .35, 1 - i * .2);
    for (let i = 0; i < 150; i++) {
      const angle = Math.random() * Math.PI * 2, lift = Math.random() * .7, s = radius * (.35 + Math.random() * .9);
      const c = HOT[i % 3];
      this.sparks.emit(origin.x, origin.y + 1, origin.z, Math.cos(angle) * s, lift * s * .45, Math.sin(angle) * s, .7 + Math.random() * .9, .12 + Math.random() * .12, .04, 14, 1.3, c[0], c[1] * .7, c[2] * .5, 1);
    }
  }

  /** Blood thrown from a wound: heavy drops along the blow, lighter spatter, and a brief mist. */
  bleed(point: THREE.Vector3, direction: THREE.Vector3 | undefined, intensity: number) {
    const k = THREE.MathUtils.clamp(intensity, .15, 1);
    this.dir.copy(direction ?? this.n.set(0, 1, 0)).normalize();
    this.dir.y += .25; this.dir.normalize();
    const count = Math.round(8 + k * 26);
    for (let i = 0; i < count; i++) {
      this.cone(i % 3 ? .55 : 1.3, this.b);
      const s = (2.5 + Math.random() * Math.random() * (5 + k * 13)) * (i % 3 ? 1 : .5), shade = .55 + Math.random() * .45;
      this.blood.emit(point.x + (Math.random() - .5) * .25, point.y + (Math.random() - .5) * .3, point.z + (Math.random() - .5) * .25,
        this.b.x * s, this.b.y * s + 1.2, this.b.z * s, .45 + Math.random() * .7, .009 + Math.random() * (.012 + k * .014), .011, 15, .9,
        .36 * shade, .006 * shade, .012 * shade, 1);
    }
    for (let i = 0; i < 2 + Math.round(k * 3); i++) {
      this.cone(.9, this.b);
      this.blood.emit(point.x, point.y, point.z, this.b.x * (1.5 + k * 3), this.b.y * 1.5, this.b.z * (1.5 + k * 3), .28 + Math.random() * .2, -(.12 + k * .16), 0, 2, 2.5, .34, .012, .02, .2 + k * .14);
    }
  }

  update(dt: number) {
    this.sparks.update(dt); this.blood.update(dt); this.flashes.update(dt);
  }
}
