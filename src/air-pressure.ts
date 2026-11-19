import * as THREE from "three";
import { soundSpeed } from "./player";

const UP = new THREE.Vector3(0, 1, 0);
const { smoothstep } = THREE.MathUtils;

function veil(geometry: THREE.BufferGeometry) {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
    uniforms: {
      uOpacity: { value: 0 }, uPhase: { value: 0 }, uCollar: { value: 0 },
      uTint: { value: new THREE.Color(0xd9ecf7) },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vLocal, vNormal, vView;
      void main() {
        vLocal = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uOpacity, uPhase, uCollar;
      uniform vec3 uTint;
      varying vec3 vLocal, vNormal, vView;
      float hash(vec2 p) {
        return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 w = f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),w.x),
          mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),w.x),w.y);
      }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 flow = vLocal.xz + vec2(vLocal.y*.41,vLocal.y*.68);
        float broad = noise(flow*5.0 + vec2(uPhase*.18,0));
        float wisps = noise(flow*15.0 + vec2(0,uPhase*.37));
        float fibers = smoothstep(.12,.87,broad*.72+wisps*.28);
        float edge = 1.0 - abs(dot(normalize(vView), normalize(vNormal)));
        float crest = exp(-pow((vLocal.y - .13) / .095, 2.0));
        float shell = smoothstep(0.0, .10, vLocal.y) * (.08 + .74*pow(edge, 3.0) + crest*.47);
        float collar = smoothstep(-3.4, -2.5, vLocal.y) * (1.0-smoothstep(-.25,.63,vLocal.y))
          * (.21 + .77*pow(edge, 1.8));
        float alpha = mix(shell, collar, uCollar) * fibers * uOpacity;
        if (alpha < .005) discard;
        gl_FragColor = vec4(uTint, alpha);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;
  return mesh;
}

type Veil = ReturnType<typeof veil>;
interface Front {
  mesh: Veil;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  age: number;
  duration: number;
  radius: number;
  height: number;
  travel: number;
  startRadius: number;
  opacity: number;
}

/** A bounded pool of air shells. Existing shockwaves still own physical impulses. */
export class PressureFronts {
  readonly group = new THREE.Group();
  private readonly slots: Front[];

  constructor() {
    const dome = new THREE.SphereGeometry(1, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    this.slots = Array.from({ length: 16 }, () => {
      const mesh = veil(dome);
      this.group.add(mesh);
      return { mesh, origin: new THREE.Vector3(), direction: new THREE.Vector3(), age: 0, duration: 0,
        radius: 0, height: 0, travel: 0, startRadius: 0, opacity: 0 };
    });
  }

  strike(origin: THREE.Vector3, direction: THREE.Vector3, length: number, baseRadius: number, radius: number, speed: number) {
    this.spawn(origin, direction, Math.max(.14, length/speed), radius, .40, length, baseRadius/radius, .88, 0xd2eaf7);
  }

  impact(origin: THREE.Vector3, normal: THREE.Vector3, radius: number, nova = false) {
    this.spawn(origin, normal, nova ? 1.05 : .8, radius, nova ? .37 : .16, 0, .6/5.6,
      nova ? 1.15 : .92, nova ? 0xffd1ae : 0xe8d9c6);
  }

  private spawn(origin: THREE.Vector3, direction: THREE.Vector3, duration: number, radius: number, height: number,
    travel: number, startRadius: number, opacity: number, tint: number) {
    const slot = this.slots.find(front => !front.mesh.visible)
      ?? this.slots.reduce((oldest, front) => front.age > oldest.age ? front : oldest);
    slot.origin.copy(origin);
    slot.direction.copy(direction).normalize();
    slot.age = 0;
    slot.duration = duration;
    slot.radius = radius;
    slot.height = height;
    slot.travel = travel;
    slot.startRadius = startRadius;
    slot.opacity = opacity;
    slot.mesh.quaternion.setFromUnitVectors(UP, slot.direction);
    slot.mesh.material.uniforms.uTint.value.setHex(tint);
    slot.mesh.visible = true;
    this.pose(slot);
  }

  private pose(front: Front) {
    const t = front.age / front.duration;
    const progress = front.travel > 0 ? t : smoothstep(t, 0, 1);
    const radius = front.radius * THREE.MathUtils.lerp(front.startRadius, 1, progress);
    front.mesh.position.copy(front.origin).addScaledVector(front.direction, front.travel * t);
    front.mesh.scale.set(radius, radius * front.height, radius);
    front.mesh.material.uniforms.uPhase.value = front.age * 6;
    front.mesh.material.uniforms.uOpacity.value = front.opacity * (1 - t) ** .72;
  }

  update(dt: number) {
    for (const front of this.slots) {
      if (!front.mesh.visible) continue;
      front.age += dt;
      if (front.age >= front.duration) front.mesh.visible = false;
      else this.pose(front);
    }
  }
}

export function condensation(mach: number, density: number, cloud: number) {
  const window = smoothstep(mach, .86, .97) * (1 - smoothstep(mach, 1.02, 1.16));
  return window * smoothstep(density, .18, 1.1) * THREE.MathUtils.lerp(.58, 1, smoothstep(cloud, 0, .3));
}

/** The visible collar for an external view. The pilot sees the matching screen effect. */
export class MachCollar {
  private static readonly geometry = new THREE.LatheGeometry([
    new THREE.Vector2(2.7, -3.4), new THREE.Vector2(2.45, -2.75), new THREE.Vector2(1.93, -1.85),
    new THREE.Vector2(1.18, -.9), new THREE.Vector2(.54, -.12), new THREE.Vector2(.25, .63),
  ], 36);
  readonly mesh = veil(MachCollar.geometry);
  private readonly direction = new THREE.Vector3();

  constructor() {
    this.mesh.material.uniforms.uCollar.value = 1;
  }

  update(position: THREE.Vector3, velocity: THREE.Vector3, scale: number, airborne: boolean, time: number,
    cloudAt: (position: THREE.Vector3) => number) {
    const mach = velocity.length() / soundSpeed(position.y);
    this.mesh.visible = false;
    if (!airborne || mach <= .86 || mach >= 1.16) return;
    this.mesh.position.copy(position).y += scale;
    const density = 1.225 * Math.exp(-position.y / 8500);
    const opacity = condensation(mach, density, cloudAt(this.mesh.position));
    if (opacity < .01) return;
    this.mesh.visible = true;
    this.direction.copy(velocity).normalize();
    this.mesh.quaternion.setFromUnitVectors(UP, this.direction);
    this.mesh.scale.setScalar(scale);
    this.mesh.material.uniforms.uPhase.value = time * 5;
    this.mesh.material.uniforms.uOpacity.value = opacity;
  }
}

/** First arrival from a sampled supersonic path, including after the flyer slows down. */
export class SonicFlyby {
  private readonly samples = Array.from({length: 144}, () => ({
    position: new THREE.Vector3(), time: 0, pass: 0,
  }));
  private time = 0;
  private nextSample = 0;
  private nextSlot = 0;
  private pass = 0;
  private heard = 0;
  private supersonic = false;

  update(dt: number, position: THREE.Vector3, velocity: THREE.Vector3, active: boolean,
    listener: THREE.Vector3, arrive: (origin: THREE.Vector3) => void) {
    this.time += dt;
    const mach = active ? velocity.length() / soundSpeed(position.y) : 0;
    if (!this.supersonic && mach >= 1) {
      this.supersonic = true;
      this.pass++;
      this.nextSample = this.time;
    } else if (mach < .95) this.supersonic = false;

    if (mach >= 1 && this.pass > this.heard && this.time >= this.nextSample) {
      const sample = this.samples[this.nextSlot];
      sample.position.copy(position);
      sample.time = this.time;
      sample.pass = this.pass;
      this.nextSlot = (this.nextSlot + 1) % this.samples.length;
      this.nextSample = this.time + .22;
    }

    for (const sample of this.samples) {
      if (sample.pass <= this.heard) continue;
      const age = this.time-sample.time;
      if (age > 31) { sample.pass = 0; continue; }
      const travel = age * soundSpeed((sample.position.y+listener.y)*.5);
      const distanceSquared = sample.position.distanceToSquared(listener);
      if (distanceSquared > 9000**2 || distanceSquared > travel*travel) continue;
      this.heard = sample.pass;
      arrive(sample.position);
    }
  }
}
