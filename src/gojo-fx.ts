import * as THREE from "three";

const sphere = new THREE.SphereGeometry(1, 24, 12);
const card = new THREE.PlaneGeometry(2, 2);
const wave = new THREE.RingGeometry(.968, 1, 72);
const PALETTES = {
  blue: [0x166afc, 0x9be8ff, 0],
  red: [0xee093d, 0xff8093, 1],
  purple: [0x8732ff, 0xe5c0ff, 2],
  void: [0x5946c0, 0xbdb5ff, 3],
  rct: [0x26db9b, 0xc3ffdf, 4],
  "black-flash": [0xca1038, 0xff8153, 5],
  infinity: [0x508bd8, 0xc9edff, 6],
  "simple-domain": [0x3983b5, 0x9deaff, 7],
  "falling-blossom": [0xe5738e, 0xffe8bb, 8],
} as const;
export type GojoEffect = keyof typeof PALETTES;

const billboardVertex = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  uniform vec3 flight;
  varying vec2 vDisc;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(0., 0., 0., 1.);
    vec2 offset = position.xy;
    vec2 projected = (viewMatrix * vec4(flight, 0.)).xy;
    float width = length(projected);
    if (width > .01) {
      vec2 axis = projected / width;
      float wake = min(0., position.x) * width * 1.55;
      offset = axis * (position.x + wake) + vec2(-axis.y, axis.x) * position.y;
    }
    mvPosition.xy += offset * length(modelViewMatrix[0].xyz);
    gl_Position = projectionMatrix * mvPosition;
    vDisc = position.xy;
    #include <logdepthbuf_vertex>
  }`;

const orbFragment = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 ink, hot;
  uniform float time, style, charge;
  varying vec2 vDisc;

  float ribbon(float phase, float tightness) {
    float s = .5 + .5 * sin(phase);
    return pow(s, tightness);
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = vDisc;
    float r = length(p);
    if (r >= 1.) discard;
    float angle = atan(p.y, p.x);
    float trail = smoothstep(.12, .29, r) * (1. - smoothstep(.30, .97, r));
    float shell = .293 + .022 * sin(angle * 5. + time * 5.) + .016 * sin(angle * 9. - time * 7.);
    float rim = exp(-abs(r - shell) * 48.);
    float core = 1. - smoothstep(shell - .035, shell + .035, r);
    float mist = (1. - smoothstep(.14, .92, r)) * .22;
    vec3 col;
    float alpha;
    if (style < .5) {
      // Blue has a dark lens and tight streams moving toward the center.
      float flow = ribbon(3.*angle - 13.*r - time*9. + 1.1*sin(3.*angle+4.*r), 13.);
      float threads = ribbon(6.*angle - 27.*r - time*12., 22.) * .34;
      col = mix(ink*.19, hot*1.55, clamp(rim + flow*.66 + threads, 0., 1.));
      alpha = max(core*.97, rim*.86 + (flow + threads)*trail + mist);
    } else if (style < 1.5) {
      // Red sheds pressure and shards toward the outside.
      float sparks = ribbon(11.*angle + sin(17.*angle)*.8 + 3.*r, 24.) * ribbon(22.*r - time*12. + 2.*sin(angle*7.), 7.);
      float plasma = ribbon(5.*angle - 17.*r + time*9., 5.);
      float nucleus = 1. - smoothstep(.05, .19, r);
      col = mix(ink*.60, hot*1.45, clamp(nucleus*.65 + core*.20 + rim*.46 + sparks*.63 + plasma*.3, 0., 1.));
      alpha = core + rim*.58 + trail*(.48*plasma+1.5*sparks) + mist;
    } else if (style < 2.5) {
      float phase = 4.*angle + 16.*r - time*10.;
      float currents = ribbon(phase, 13.) + .4 * ribbon(7.*angle - 23.*r + time*13., 19.);
      vec3 split = mix(vec3(.23,.39,1.5), vec3(1.65,.10,.25), .5 + .5*sin(2.*angle-time*4.));
      col = mix(mix(split, ink*1.65, charge), hot*2.15, clamp(core*.68 + .6*rim + currents*.31, 0., 1.));
      alpha = core*.96 + rim*.55 + currents*trail + mist;
    } else {
      float flow = ribbon(7.*angle + 17.*r - time*8., 11.);
      col = mix(ink*.55, hot*1.4, clamp(rim + flow*.5, 0., 1.));
      if (style < 3.5) col *= 1. - core*.92;
      alpha = core*.93 + rim*.72 + flow*trail + mist;
    }
    gl_FragColor = vec4(col, clamp(alpha, 0., 1.) * (1. - smoothstep(.87, 1., r)));
  }`;

const burstFragment = `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 ink, hot;
  uniform float time, style, charge;
  varying vec2 vDisc;

  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vDisc);
    if (r >= 1.) discard;
    float a = atan(vDisc.y, vDisc.x);
    float t = charge;
    float front = .10 + .80 * (1. - (1. - t) * (1. - t));
    float lobes = .011 * sin(7.*a - 8.*t) + .008 * sin(13.*a + 11.*t) + .005 * sin(31.*a);
    float edge = exp(-abs(r - front - lobes) * (42. + 11.*t));
    float trail = exp(-max(0., front-r) * 14.) * (1. - smoothstep(front, front+.09, r));
    float rays = pow(.5 + .5*sin(19.*a + 2.*sin(8.*a) + r*7.), 16.) *
      exp(-abs(r-front*.83-sin(13.*a)*.13) * 10.) * smoothstep(.08, .29, r);
    rays *= .28 + .72 * smoothstep(-.32, .9, sin(17.*a + 2.*sin(9.*a) + r*21. - t*5.));
    float flash = exp(-r*(8.+17.*t)) * (1. - smoothstep(.02, .4, t));
    float orient = .5 + .5 * sin(a*4. + time*.9);
    float weight = style < .5 || style > 5.5 ? .43 : 1.;
    float beam = style > 4.5 && style < 5.5 ? rays*1.5 : rays;
    vec3 col = mix(ink*1.14, hot*1.6, clamp(edge*.65 + flash + beam*.44, 0., 1.));
    gl_FragColor = vec4(col, (edge*(.56+.24*orient) + trail*.18 + beam*.58 + flash) *
      (1. - smoothstep(.50, 1., t)) * (1. - smoothstep(.88, 1., r)) * weight);
  }`;

function makeCard(fragmentShader: string) {
  const mesh = new THREE.Mesh(card, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false,
    uniforms: { ink: { value: new THREE.Color() }, hot: { value: new THREE.Color() },
      time: { value: 0 }, style: { value: 0 }, charge: { value: 0 }, flight: { value: new THREE.Vector3() } },
    vertexShader: billboardVertex, fragmentShader,
  }));
  mesh.visible = false;
  return { mesh, kind: null as GojoEffect | null };
}

function setPalette(effect: ReturnType<typeof makeCard>, kind: GojoEffect) {
  if (effect.kind === kind) return;
  effect.kind = kind;
  const uniforms = effect.mesh.material.uniforms;
  const [ink, hot, style] = PALETTES[kind];
  uniforms.ink.value.setHex(ink);
  uniforms.hot.value.setHex(hot);
  uniforms.style.value = style;
}

function makeVoidSky() {
  // Bake the star field once. The dome needs just a texture lookup, even when it fills the view.
  const width = 768, height = 384;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / width, v = y / height, azimuth = u * Math.PI * 2;
    const lane = v - .47 - .16 * Math.sin(azimuth + .3);
    const swirls = Math.sin(azimuth * 9 + v * 37) + .5 * Math.sin(azimuth * 17 - v * 79);
    const dust = Math.exp(-Math.abs(lane + .016 * swirls) * 15);
    const strands = .35 + .65 * Math.sin(azimuth * 4 + lane * 28 + swirls) ** 2;
    const clouds = dust * strands * (1 + .3 * swirls);
    const hole = Math.hypot((u - .65) * 2.4, (v - .60) * 1.45);
    const halo = Math.exp(-Math.abs(hole - .054 - .004 * Math.sin(azimuth * 33)) * 159);
    const outside = THREE.MathUtils.smoothstep(hole, .049, .055);
    const accretion = halo * (.45 + .55 * Math.sin(azimuth * 19 + v * 23) ** 2);
    const i = (x + y * width) * 4;
    pixels[i] = (1 + clouds * 11 + accretion * 57) * outside;
    pixels[i + 1] = (2 + clouds * 8 + accretion * 43) * outside;
    pixels[i + 2] = (6 + clouds * 31 + accretion * 132) * outside;
    pixels[i + 3] = 255;
  }
  let seed = 824743;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let star = 0; star < 2100; star++) {
    const x = Math.round(random() * (width - 1)), y = Math.round(random() * (height - 1));
    if (Math.hypot((x / width - .65) * 2.4, (y / height - .60) * 1.45) < .057) continue;
    const shine = 18 + Math.round(random() ** 2 * 201), hue = random();
    const i = (x + y * width) * 4;
    pixels[i] = Math.min(255, pixels[i] + shine * (.58 + hue * .38));
    pixels[i + 1] = Math.min(255, pixels[i + 1] + shine * (.79 + hue * .12));
    pixels[i + 2] = Math.min(255, pixels[i + 2] + shine);
    if (shine < 170 || x === 0 || x === width - 1 || y === 0 || y === height - 1) continue;
    for (const neighbor of [i - 4, i + 4, i - width * 4, i + width * 4]) {
      for (let channel = 0; channel < 3; channel++) pixels[neighbor + channel] = Math.min(255, pixels[neighbor + channel] + pixels[i + channel] * .24);
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const voidSky = makeVoidSky();
const shellVertex = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 n, eye, p;
  varying vec2 skyUV;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.);
    gl_Position = projectionMatrix * mvPosition;
    n = normalMatrix * normal;
    eye = -mvPosition.xyz;
    p = position;
    skyUV = uv;
    #include <logdepthbuf_vertex>
  }`;

export class GojoEffects {
  private readonly charge = makeCard(orbFragment);
  private readonly projectile = makeCard(orbFragment);
  private readonly orbPool: ReturnType<typeof makeCard>[] = [];
  private readonly shield = new THREE.Mesh(sphere, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
    uniforms: { tick: { value: 0 }, ripple: { value: 0 } },
    vertexShader: shellVertex,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float tick, ripple;
      varying vec3 n, eye, p;
      void main() {
        #include <logdepthbuf_fragment>
        float rim = 1. - abs(dot(normalize(n), normalize(eye)));
        float bands = sin(p.y*17. + p.x*15. + 2.1*sin(p.z*5. - tick*1.6) - tick*3.2);
        float glint = smoothstep(.91, .99, bands) * smoothstep(.55, .94, rim);
        float pulse = exp(-24.*abs(p.y - (1. - ripple*2.))) * ripple;
        gl_FragColor = vec4(mix(vec3(.21,.46,.81), vec3(.82,1.,1.), glint), rim*rim*(.10+.30*glint) + .59*pulse);
      }`,
  }));
  private readonly dome = new THREE.Mesh(sphere, new THREE.ShaderMaterial({
    side: THREE.DoubleSide, toneMapped: false,
    uniforms: { sky: { value: voidSky }, pulse: { value: 0 } },
    vertexShader: shellVertex,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D sky;
      uniform float pulse;
      varying vec3 n, eye, p;
      varying vec2 skyUV;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 col = texture2D(sky, skyUV).rgb;
        if (gl_FrontFacing) {
          float rim = 1. - abs(dot(normalize(n), normalize(eye)));
          col = col*.32 + rim*rim*rim*vec3(.22,.12,.46);
        }
        gl_FragColor = vec4(col*(1. + pulse*.75) + pulse*vec3(.018,.012,.066), 1.);
      }`,
  }));
  private readonly boundary = new THREE.Mesh(wave, new THREE.MeshBasicMaterial({
    color: 0xa49dff, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    toneMapped: false, blending: THREE.AdditiveBlending,
  }));
  private readonly bursts = Array.from({ length: 6 }, () => ({
    ...makeCard(burstFragment), age: 1, duration: .4,
  }));
  private cursor = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.boundary.rotation.x = -Math.PI / 2;
    this.projectile.mesh.frustumCulled = false;
    scene.add(this.charge.mesh, this.projectile.mesh, this.shield, this.dome, this.boundary, ...this.bursts.map(burst => burst.mesh));
    this.reset();
  }

  warm(renderer: THREE.WebGLRenderer, visible: boolean) {
    if (visible) renderer.initTexture(voidSky);
    this.charge.mesh.visible = this.shield.visible = this.dome.visible = this.boundary.visible = this.bursts[0].mesh.visible = visible;
  }

  reset() {
    this.hideCharge();
    this.projectile.mesh.visible = this.shield.visible = this.dome.visible = false;
    for (const burst of this.bursts) burst.mesh.visible = false;
  }

  private orb(effect: ReturnType<typeof makeCard>, kind: GojoEffect, point: THREE.Vector3, radius: number, clock: number, charge = 1) {
    setPalette(effect, kind);
    effect.mesh.visible = true;
    effect.mesh.position.copy(point);
    effect.mesh.scale.setScalar(radius);
    effect.mesh.material.uniforms.time.value = clock;
    effect.mesh.material.uniforms.charge.value = charge;
  }

  showCharge(kind: GojoEffect, point: THREE.Vector3, amount: number, clock: number) {
    const size = kind === "purple" ? 4.9 : kind === "void" ? 1.9 : 1.65;
    this.orb(this.charge, kind, point, .23 + amount * size, clock, THREE.MathUtils.smoothstep(amount, .34, .93));
  }

  showVoidWarning(point: THREE.Vector3, radius: number, amount: number) {
    this.boundary.visible = true;
    this.boundary.position.copy(point).y += .12;
    this.boundary.scale.setScalar(radius * (.92 + .08 * amount));
    this.boundary.material.opacity = amount * .62;
  }

  hideCharge() { this.charge.mesh.visible = this.boundary.visible = false; }

  showProjectile(point: THREE.Vector3, direction: THREE.Vector3, clock: number, amplified: boolean) {
    this.orb(this.projectile, "purple", point, amplified ? 9.2 : 7.4, clock, .8);
    this.projectile.mesh.material.uniforms.flight.value.copy(direction);
  }

  hideProjectile() { this.projectile.mesh.visible = false; }

  takeOrb() { return this.orbPool.pop() ?? makeCard(orbFragment); }

  releaseOrb(orb: ReturnType<typeof makeCard>) {
    orb.mesh.removeFromParent();
    orb.mesh.visible = false;
    this.orbPool.push(orb);
  }

  showOrb(orb: ReturnType<typeof makeCard>, color: "red" | "blue", point: THREE.Vector3, radius: number, clock: number) {
    if (!orb.mesh.parent) this.scene.add(orb.mesh);
    this.orb(orb, color, point, radius * 2.1, clock);
  }

  showInfinity(active: boolean, point: THREE.Vector3, clock: number, sinceBlock: number) {
    this.shield.visible = active;
    if (!active) return;
    this.shield.position.copy(point).y += 1.03;
    this.shield.scale.set(1.15, 1.48, 1.15);
    this.shield.material.uniforms.tick.value = clock;
    this.shield.material.uniforms.ripple.value = Math.max(0, 1 - sinceBlock / .39);
  }

  showDomain(point: THREE.Vector3, radius: number, pulse: number) {
    this.dome.visible = true;
    this.dome.position.copy(point);
    this.dome.scale.setScalar(radius);
    this.dome.material.uniforms.pulse.value = pulse;
  }

  hideDomain() { this.dome.visible = false; }

  burst(kind: GojoEffect, point: THREE.Vector3, radius: number, duration = .55) {
    const burst = this.bursts[this.cursor++ % this.bursts.length];
    burst.age = 0;
    burst.duration = duration;
    this.orb(burst, kind, point, radius, 0, 0);
  }

  update(dt: number, clock: number) {
    for (const burst of this.bursts) {
      if (!burst.mesh.visible) continue;
      burst.age += dt;
      const t = burst.age / burst.duration;
      burst.mesh.visible = t < 1;
      if (!burst.mesh.visible) continue;
      burst.mesh.material.uniforms.time.value = clock;
      burst.mesh.material.uniforms.charge.value = t;
    }
  }
}
