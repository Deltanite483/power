// Speed effects: post-process (motion blur toward the direction of travel, aberration, vapor cone, vignette),
// air streaks rushing past, buffeting, and contrails that spread and drift behind you.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { soundSpeed, type Player } from "./player";
import { condensation } from "./air-pressure";
import type { Atmosphere } from "./atmosphere";

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const SpeedShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uBlur: { value: 0 },
    uAberr: { value: 0 },
    uVapor: { value: 0 },
    uVignette: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uPixel: { value: new THREE.Vector2() },
    uImpact: { value: 0 },
    uGlow: { value: 0 },
    uVoid: { value: 0 },
    uVoidPulse: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uCenter, uPixel;
    uniform float uBlur, uAberr, uVapor, uVignette, uTime, uAspect, uImpact, uGlow, uVoid, uVoidPulse;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    vec3 highlight(vec2 uv) {
      vec3 c = texture2D(tDiffuse, uv).rgb;
      float high = max(c.r, max(c.g, c.b));
      float low = min(c.r, min(c.g, c.b));
      return min(c, vec3(3.0)) * max(smoothstep(0.74, 1.3, high) * smoothstep(0.34, 0.67, high - low),
                                    smoothstep(1.35, 2.4, high));
    }
    void main() {
      vec2 d = vUv - uCenter;
      float r = length(d * vec2(uAspect, 1.0));
      float edge = max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0;
      float peripheral = smoothstep(0.32, 0.94, edge);
      float w = uBlur * peripheral * smoothstep(0.05, 0.66, r);
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      if (w > 0.002) {
        for (int i = 1; i <= 7; i++) {
          float t = float(i) / 7.0;
          col += texture2D(tDiffuse, vUv - d * w * 0.075 * t).rgb;
        }
        col *= 0.125;
      }
      if (uAberr * peripheral > 0.002) {
        vec2 o = d * uAberr * 0.007 * peripheral;
        col.r = mix(col.r, texture2D(tDiffuse, vUv + o).r, 0.6);
        col.b = mix(col.b, texture2D(tDiffuse, vUv - o).b, 0.6);
      }
      // vapor cone: a streaming condensation shroud around the edges of the view through Mach 1
      if (uVapor > 0.0) {
        float a = atan(d.y, d.x);
        float n = noise(vec2(a * 5.0, r * 7.0 - uTime * 14.0)) * 0.6 + noise(vec2(a * 13.0, r * 19.0 - uTime * 30.0)) * 0.4;
        float shroud = peripheral * smoothstep(0.32, 0.75, r + (n - 0.5) * 0.35);
        col = mix(col, vec3(0.94, 0.96, 0.99), min(shroud * uVapor, 0.68));
      }
      col *= 1.0 - uVignette * peripheral;
      if (uVoid > .5) {
        float edgeShade = smoothstep(.30, .88, r);
        col = col * vec3(.24,.27,.43) + col * col * .13;
        col *= 1. - edgeShade*.30;
        col += vec3(.13,.10,.46) * edgeShade * uVoidPulse * (.62 + .38*sin(r*25.-uVoidPulse*4.));
      }
      if (uGlow > 0.002) {
        vec2 spread = uPixel * 3.5;
        vec3 glow = highlight(vUv + vec2(spread.x, 0.0)) + highlight(vUv - vec2(spread.x, 0.0))
                  + highlight(vUv + vec2(0.0, spread.y)) + highlight(vUv - vec2(0.0, spread.y));
        col += glow * (0.10 * uGlow);
      }
      float flash = uImpact * (1.0 - smoothstep(0.02, 0.31, length((vUv - 0.5) * vec2(uAspect, 1.0))));
      col += vec3(1.0, 0.74, 0.48) * (0.14 * flash);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/** World-fixed air motes, drawn as streaks along the relative wind. They wrap around the camera. */
class AirStreaks {
  readonly lines: THREE.LineSegments;
  private pts: Float32Array;
  private pos: Float32Array;
  private col: Float32Array;
  private readonly n = 700;
  private readonly box = 45;
  private drift = new THREE.Vector3();

  constructor() {
    this.pts = new Float32Array(this.n * 3);
    for (let i = 0; i < this.pts.length; i++) this.pts[i] = (Math.random() * 2 - 1) * this.box;
    this.pos = new Float32Array(this.n * 6);
    this.col = new Float32Array(this.n * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    material.onBeforeCompile = shader => {
      shader.vertexShader = `varying vec3 vStreakClip;\n${shader.vertexShader}`.replace(
        "#include <project_vertex>", "#include <project_vertex>\nvStreakClip = vec3(gl_Position.xy, gl_Position.w);",
      );
      shader.fragmentShader = `varying vec3 vStreakClip;\n${shader.fragmentShader}`.replace(
        "#include <opaque_fragment>", `
          vec2 screen = abs(vStreakClip.xy / max(0.001, vStreakClip.z));
          outgoingLight *= smoothstep(0.38, 0.92, max(screen.x, screen.y));
          #include <opaque_fragment>
        `,
      );
    };
    this.lines = new THREE.LineSegments(g, material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 10;
  }

  update(cam: THREE.Vector3, vel: THREE.Vector3, intensity: number, wind: THREE.Vector3, dt: number) {
    this.lines.visible = intensity > 0.001;
    if (!this.lines.visible) return;
    const B = this.box, B2 = B * 2;
    this.drift.addScaledVector(wind, dt);
    this.drift.set(this.drift.x % B2, this.drift.y % B2, this.drift.z % B2);
    const speed = vel.length();
    // a ~1/30 s shutter, capped so streaks stay readable at Mach 2
    const len = Math.min(30, speed / 30);
    const sx = speed > 0 ? (-vel.x / speed) * len : 0, sy = speed > 0 ? (-vel.y / speed) * len : 0, sz = speed > 0 ? (-vel.z / speed) * len : 0;
    for (let i = 0; i < this.n; i++) {
      // Wrap the drifting motes around the camera.
      let rx = this.pts[i * 3] + this.drift.x - cam.x, ry = this.pts[i * 3 + 1] + this.drift.y - cam.y, rz = this.pts[i * 3 + 2] + this.drift.z - cam.z;
      rx -= Math.floor((rx + B) / B2) * B2;
      ry -= Math.floor((ry + B) / B2) * B2;
      rz -= Math.floor((rz + B) / B2) * B2;
      const d = Math.hypot(rx, ry, rz);
      const fade = d < 2 ? 0 : (1 - d / (B * 1.2)) * intensity;
      const o = i * 6;
      this.pos[o] = cam.x + rx; this.pos[o + 1] = cam.y + ry; this.pos[o + 2] = cam.z + rz;
      this.pos[o + 3] = cam.x + rx + sx; this.pos[o + 4] = cam.y + ry + sy; this.pos[o + 5] = cam.z + rz + sz;
      this.col[o] = this.col[o + 1] = this.col[o + 2] = Math.max(0, fade) * 0.55;
      this.col[o + 3] = this.col[o + 4] = this.col[o + 5] = 0;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }
}

/**
 * Contrail: one continuous camera-facing ribbon traced along the flight path. Each point remembers when it was laid;
 * in the shader the ribbon widens with sqrt(age), drifts with the wind, wobbles, breaks into streaks and fades out.
 * kind 0 = faint subsonic wisp … 1 = heavy supersonic trail.
 */
export class Contrails {
  readonly mesh: THREE.Mesh;
  private readonly n = 4096; // trail points (two vertices each)
  private head = 0;
  private prevIndex = -1; // last point written, -1 when the trail is broken
  private dist = 0;
  private pos: Float32Array;
  private tan: Float32Array;
  private birth: Float32Array;
  private kind: Float32Array;
  private along: Float32Array;
  private seed: Float32Array;
  private index: Uint16Array;
  private written: number[] = [];
  private quads: number[] = [];
  private last = new THREE.Vector3();
  readonly uniforms = {
    uTime: { value: 0 },
    uFogColor: { value: new THREE.Color() },
    uFogDensity: { value: 0 },
    uWind: { value: new THREE.Vector3(1.6, 0, 0.7) },
  };

  constructor() {
    const v = this.n * 2;
    this.pos = new Float32Array(v * 3);
    this.tan = new Float32Array(v * 3);
    this.birth = new Float32Array(v).fill(-1e9);
    this.kind = new Float32Array(v);
    this.along = new Float32Array(v);
    this.seed = new Float32Array(v);
    const side = new Float32Array(v);
    for (let i = 0; i < v; i++) side[i] = i & 1 ? 1 : -1;
    // every quad starts degenerate; quads are switched on as the trail is laid
    this.index = new Uint16Array(this.n * 6);
    for (let k = 0; k < this.n; k++) this.index.fill(k * 2, k * 6, k * 6 + 6);
    const g = new THREE.BufferGeometry();
    const dyn = (a: Float32Array, size: number) => new THREE.BufferAttribute(a, size).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", dyn(this.pos, 3));
    g.setAttribute("aTan", dyn(this.tan, 3));
    g.setAttribute("aBirth", dyn(this.birth, 1));
    g.setAttribute("aKind", dyn(this.kind, 1));
    g.setAttribute("aAlong", dyn(this.along, 1));
    g.setAttribute("aSeed", dyn(this.seed, 1));
    g.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    g.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 aTan;
        attribute float aBirth, aKind, aAlong, aSeed, aSide;
        uniform float uTime;
        uniform vec3 uWind;
        varying float vAlpha, vSide, vAlong, vAge, vLife, vSeed, vDepth;
        void main() {
          float age = uTime - aBirth;
          float life = mix(4.0, 30.0, aKind * aKind);
          float t = clamp(age / life, 0.0, 1.0);
          // the wake mixes out: width grows ~sqrt(age); it drifts with the wind, sinks a little and wobbles
          float width = mix(0.35, 2.4, aKind) + mix(0.9, 4.5, aKind) * sqrt(max(age, 0.0));
          // uneven puffing along the length, growing as the wake ages
          width *= 1.0 + (sin(aAlong * 0.045 + aSeed * 11.0) * 0.5 + sin(aAlong * 0.013 + aSeed * 5.0) * 0.5) * mix(0.12, 0.4, t);
          vec3 up = vec3(0.0, 1.0, 0.0);
          vec3 lateral = normalize(cross(aTan, up) + vec3(1e-4));
          float wob = sin(aAlong * 0.011 + aSeed * 6.0) * 0.6 + sin(aAlong * 0.037 + aSeed * 3.0) * 0.4;
          vec3 c = position + uWind * age + vec3(0.0, -0.06 * age, 0.0) + lateral * wob * age * mix(0.15, 0.45, aKind);
          // face the camera: offset sideways, perpendicular to the trail and the view ray
          vec3 side = normalize(cross(aTan, c - cameraPosition) + vec3(1e-4));
          vec3 wp = c + side * aSide * width * 0.5;
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
          float dist = -mv.z;
          vAlpha = mix(0.12, 0.7, aKind) * pow(1.0 - t, 1.25) * step(age, life) * smoothstep(0.0, 0.25, age) * smoothstep(4.0, 30.0, dist);
          vSide = aSide;
          vAlong = aAlong;
          vAge = t;
          vSeed = aSeed;
          vDepth = dist;
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        varying float vAlpha, vSide, vAlong, vAge, vSeed, vDepth;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
        }
        void main() {
          #include <logdepthbuf_fragment>
          // ragged edges that get wispier with age, a dense bright core
          float n2 = noise(vec2(vAlong * 0.018 + 3.0, vSide * 1.3 + vSeed * 5.0));
          float edge = abs(vSide) * (1.0 + (n2 - 0.5) * (0.6 + vAge * 1.2));
          float profile = exp(-edge * edge * 3.2);
          // knots and beading along the length, like real condensation trails
          float knots = mix(0.45, 1.15, noise(vec2(vAlong * 0.07, vSeed * 9.0)) * 0.7 + noise(vec2(vAlong * 0.21, vSeed)) * 0.3);
          // as it ages it tears into streaks along the flow
          vec2 q = vec2(vAlong * 0.02, vSide * 2.5 + vSeed);
          float streak = noise(q * vec2(1.0, 3.0)) * 0.6 + noise(q * vec2(3.1, 7.0)) * 0.4;
          float breakup = mix(1.0, smoothstep(0.2, 0.8, streak) * 1.5, smoothstep(0.1, 0.7, vAge));
          float a = vAlpha * profile * knots * breakup;
          if (a < 0.003) discard;
          vec3 col = mix(vec3(0.84, 0.87, 0.93), vec3(1.0, 1.0, 0.99), clamp(profile * 1.3 - vAge * 0.3, 0.0, 1.0));
          float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
          gl_FragColor = vec4(mix(col, uFogColor, fog), min(a, 0.92));
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  private setQuad(k: number, on: boolean) {
    const o = k * 6, a = k * 2, b = ((k + 1) % this.n) * 2;
    if (on) {
      this.index[o] = a; this.index[o + 1] = a + 1; this.index[o + 2] = b;
      this.index[o + 3] = a + 1; this.index[o + 4] = b + 1; this.index[o + 5] = b;
    } else this.index.fill(a, o, o + 6);
    this.quads.push(k);
  }

  private add(p: THREE.Vector3, kind: number, time: number) {
    const i = this.head;
    const prev = this.prevIndex;
    let tx = 0, ty = 0, tz = 1;
    if (prev >= 0) {
      tx = p.x - this.last.x; ty = p.y - this.last.y; tz = p.z - this.last.z;
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l; ty /= l; tz /= l;
      this.dist += Math.hypot(p.x - this.last.x, p.y - this.last.y, p.z - this.last.z);
    }
    const seed = Math.random();
    for (const v of [i * 2, i * 2 + 1]) {
      this.pos[v * 3] = p.x; this.pos[v * 3 + 1] = p.y; this.pos[v * 3 + 2] = p.z;
      this.tan[v * 3] = tx; this.tan[v * 3 + 1] = ty; this.tan[v * 3 + 2] = tz;
      this.birth[v] = time;
      this.kind[v] = kind;
      this.along[v] = this.dist % 100000;
      this.seed[v] = prev >= 0 ? this.seed[prev * 2] : seed;
    }
    if (prev >= 0) {
      // the first point of a trail borrows this tangent too
      if (this.tan[prev * 6] === 0 && this.tan[prev * 6 + 1] === 0) for (const v of [prev * 2, prev * 2 + 1]) { this.tan[v * 3] = tx; this.tan[v * 3 + 1] = ty; this.tan[v * 3 + 2] = tz; }
      this.setQuad(prev, true);
    }
    this.setQuad(i, false); // never join the newest point to the oldest one
    this.written.push(i);
    this.prevIndex = i;
    this.head = (i + 1) % this.n;
    this.last.copy(p);
  }

  /** Extend the trail to p. kind <= 0 ends the current trail. */
  emit(p: THREE.Vector3, kind: number, time: number) {
    if (kind <= 0) { this.prevIndex = -1; return; }
    if (this.prevIndex >= 0 && p.distanceTo(this.last) > 3000) this.prevIndex = -1; // teleported
    if (this.prevIndex < 0 || p.distanceTo(this.last) >= 2.5) this.add(p, kind, time);
  }

  flush() {
    if (!this.written.length && !this.quads.length) return;
    const g = this.mesh.geometry;
    for (const [name, size] of [["position", 3], ["aTan", 3], ["aBirth", 1], ["aKind", 1], ["aAlong", 1], ["aSeed", 1]] as const) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      for (const i of this.written) a.addUpdateRange(i * 2 * size, 2 * size);
      // tangents of the previous point may have been patched
      if (name === "aTan") for (const k of this.quads) a.addUpdateRange(k * 2 * size, 2 * size);
      a.needsUpdate = true;
    }
    const idx = g.index!;
    idx.clearUpdateRanges();
    for (const k of this.quads) idx.addUpdateRange(k * 6, 6);
    idx.needsUpdate = true;
    this.written.length = 0;
    this.quads.length = 0;
  }
}

export class SpeedEffects {
  private composer: EffectComposer;
  private pass: ShaderPass;
  private readonly cloudPass?: ReturnType<Atmosphere["createPass"]>;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private drawRatio = 0;
  private streaks = new AirStreaks();
  private trails = new Contrails();
  private time = 0;
  private tmp = new THREE.Vector3();
  private blur = 0;
  private impact = 0;
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  /** Buffet shake (radians) to add to the camera this frame. */
  buffet = 0;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private atmosphere?: Atmosphere) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 2 });
    rt.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType);
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    if (atmosphere) {
      this.cloudPass = atmosphere.createPass(camera);
      this.composer.addPass(this.cloudPass);
    }
    this.pass = new ShaderPass(SpeedShader);
    this.composer.addPass(this.pass);
    this.composer.addPass(new OutputPass());
    // EffectComposer treats a supplied target's dimensions as CSS pixels when sizing passes.
    // Reset to the actual viewport so high-DPI screens don't oversize the cloud target.
    this.setSize(innerWidth, innerHeight);
    scene.add(this.streaks.lines, this.trails.mesh);
  }

  setSize(w: number, h: number) {
    const ratio = this.renderer.getPixelRatio();
    if (w !== this.viewportWidth || h !== this.viewportHeight) {
      this.viewportWidth = w;
      this.viewportHeight = h;
      this.composer.setSize(w, h);
    }
    if (ratio !== this.drawRatio) {
      this.drawRatio = ratio;
      this.composer.setPixelRatio(ratio);
    }
    this.pass.uniforms.uPixel.value.set(1 / Math.max(1, w * ratio), 1 / Math.max(1, h * ratio));
  }

  update(dt: number, player: Player, fog: THREE.FogExp2, wind: THREE.Vector3) {
    this.time += dt;
    const v = player.vel, speed = v.length();
    const mach = speed / soundSpeed(player.pos.y);
    const rho = player.airDensity;
    const u = this.pass.uniforms;

    // focus of expansion: where the velocity points on screen
    let ahead = 0;
    if (speed > 1) {
      this.tmp.copy(v).normalize().multiplyScalar(1000).add(this.camera.position).project(this.camera);
      // moving exactly sideways to the view (e.g. climbing straight up while looking level) projects through w = 0: NaN
      const facing = this.tmp.z < 1 && Number.isFinite(this.tmp.x) && Number.isFinite(this.tmp.y) ? 1 : 0;
      ahead = facing * (1 - smoothstep(0.9, 1.6, Math.max(Math.abs(this.tmp.x), Math.abs(this.tmp.y))));
      if (facing) u.uCenter.value.set(THREE.MathUtils.clamp(this.tmp.x * 0.5 + 0.5, -0.2, 1.2), THREE.MathUtils.clamp(this.tmp.y * 0.5 + 0.5, -0.2, 1.2));
    }
    // effects follow how fast the ground and air rush past, not just raw speed
    const rush = smoothstep(40, 420, speed) * (0.5 + 0.5 * Math.min(1, rho / 1));
    this.blur += (rush * (0.35 + 0.65 * ahead) - this.blur) * Math.min(1, dt * 6);
    if (!Number.isFinite(this.blur)) this.blur = 0; // a NaN here would stick forever and white out the screen
    u.uBlur.value = this.blur;
    u.uAberr.value = smoothstep(250, 800, speed);
    // vapor cone: transonic condensation, strongest just under and through Mach 1 in dense air
    u.uVapor.value = !player.inWater && (player.flying || !player.onGround) && mach > .86 && mach < 1.16
      ? condensation(mach,rho,this.atmosphere?.densityAt(this.camera.position) ?? 0)
      : 0;
    u.uVignette.value = smoothstep(60, 600, speed) * 0.55;
    u.uTime.value = this.time;
    u.uAspect.value = this.camera.aspect;

    // buffeting: grows with dynamic pressure, peaks in the transonic range
    const q = 0.5 * rho * speed * speed;
    const transonic = 1 + 2.5 * Math.exp(-(((mach - 0.97) / 0.12) ** 2));
    this.buffet = player.flying || !player.onGround ? Math.min(0.012, 0.0025 * Math.pow(q / 1e5, 0.7) * transonic) : 0;

    const relativeAir = this.tmp.subVectors(v, wind);
    const gust = smoothstep(10, 180, wind.length());
    if (!player.underwater) this.buffet += gust * .014;
    const streakIntensity = Math.max(gust, smoothstep(15, 160, relativeAir.length())) * (.35 + .65 * Math.min(1, rho));
    this.streaks.update(this.camera.position, relativeAir, player.underwater ? 0 : streakIntensity, wind, dt);

    // contrails: faint wisps from ~60 m/s, a proper trail past Mach 1
    const airborne = player.flying || !player.onGround;
    let kind = 0;
    if (airborne && !player.inWater && speed > 60) {
      kind = mach < 1 ? 0.05 + 0.3 * smoothstep(60, 330, speed) : 0.6 + 0.4 * smoothstep(1, 2.2, mach);
      kind *= Math.min(1, rho / 0.5); // thin air at altitude can't hold much of a wake
    }
    // the wake condenses a few body lengths behind you, not at your eyes
    const src = this.tmp.set(player.pos.x, player.pos.y + 0.9, player.pos.z);
    if (speed > 1) src.addScaledVector(v, -4 / speed);
    this.trails.emit(src, kind, this.time);
    this.trails.flush();
    const tu = this.trails.uniforms;
    tu.uTime.value = this.time;
    tu.uFogColor.value.copy(fog.color);
    tu.uFogDensity.value = fog.density;
  }

  flashImpact(intensity: number) {
    this.impact = Math.max(this.impact, intensity);
  }

  render(real = 1 / 60, beamImpact = false, insideVoid = false, voidPulse = 0) {
    const p = this.pass.uniforms;
    if (this.cloudPass) this.cloudPass.enabled = !insideVoid;
    p.uVoid.value = insideVoid ? 1 : 0;
    p.uVoidPulse.value = this.reducedMotion.matches ? 0 : voidPulse;
    p.uImpact.value = this.reducedMotion.matches ? 0 : this.impact;
    p.uGlow.value = Math.max(beamImpact ? .75 : 0, p.uImpact.value);
    this.impact = Math.max(0, this.impact - real * 9);
    this.pass.enabled = insideVoid || p.uBlur.value >= 0.002 || p.uVapor.value >= 0.002 || p.uVignette.value >= 0.002
      || p.uAberr.value >= 0.002 || p.uImpact.value >= 0.002 || p.uGlow.value >= 0.002;
    if (insideVoid) {
      // The sealed sphere hides the distant world. Cull those chunks before submitting the scene.
      const far = this.camera.far;
      this.camera.far = 74;
      this.camera.updateProjectionMatrix();
      this.composer.render();
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    } else if (!this.atmosphere && !this.pass.enabled) this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }
}
