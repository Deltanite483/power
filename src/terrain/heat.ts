import * as THREE from "three";

const MAX_PATCHES = 128;
export const HEAT_SLOTS = 24;
const HOT_HOLD = 3;
const COOL_TIME = 17;
const SCORCH_HOLD = 8;
const SCORCH_TIME = 37;

interface HeatPatch {
  x: number; y: number; z: number; radius: number;
  age: number; intensity: number;
}

const fade = (age: number, hold: number, duration: number) => {
  const t = THREE.MathUtils.clamp((age - hold) / duration, 0, 1);
  return 1 - t * t * (3 - 2 * t);
};

/** Real-time cooling, independent of the terrain healing toggle. No mesh rebuilds needed. */
export class ThermalField {
  private patches: HeatPatch[] = [];
  readonly uniforms = {
    uHeatCount: { value: 0 },
    uHeatPosition: { value: Array.from({ length: HEAT_SLOTS }, () => new THREE.Vector4()) },
    uHeatState: { value: Array.from({ length: HEAT_SLOTS }, () => new THREE.Vector2()) },
    uHeatTime: { value: 0 },
  };

  add(x: number, y: number, z: number, radius: number, intensity = 1) {
    // Repeated hits refresh a patch; long trenches retain separate heated sections.
    const nearby = this.patches.find(p =>
      p.radius >= radius * 0.6 && p.radius <= radius * 1.6 &&
      Math.hypot(p.x - x, p.y - y, p.z - z) < Math.min(p.radius, radius) * 0.4);
    if (nearby) {
      nearby.age = 0;
      nearby.radius = Math.max(nearby.radius, radius);
      nearby.intensity = Math.max(nearby.intensity, intensity);
      return;
    }
    if (this.patches.length >= MAX_PATCHES) {
      const oldest = this.patches.reduce((a, p, i, all) => p.age > all[a].age ? i : a, 0);
      this.patches.splice(oldest, 1);
    }
    this.patches.push({ x, y, z, radius: Math.max(0.1, radius), intensity, age: 0 });
  }

  update(dt: number, camera: THREE.Vector3) {
    this.uniforms.uHeatTime.value += dt;
    for (const patch of this.patches) patch.age += dt;
    this.patches = this.patches.filter(p => p.age < SCORCH_HOLD + SCORCH_TIME);
    // Only nearby patches cost fragment work; all patches continue cooling offscreen.
    const distance = (p: HeatPatch) => Math.max(0, Math.hypot(p.x - camera.x, p.y - camera.y, p.z - camera.z) - p.radius);
    const visible = this.patches.slice().sort((a, b) => distance(a) - distance(b)).slice(0, HEAT_SLOTS);
    this.uniforms.uHeatCount.value = visible.length;
    for (let i = 0; i < visible.length; i++) {
      const p = visible[i];
      this.uniforms.uHeatPosition.value[i].set(p.x, p.y, p.z, p.radius);
      this.uniforms.uHeatState.value[i].set(
        fade(p.age, HOT_HOLD, COOL_TIME) * p.intensity,
        fade(p.age, SCORCH_HOLD, SCORCH_TIME) * Math.min(1, p.intensity),
      );
    }
  }
}

/** Material identity comes from the mesher, including bedrock exposed inside a crater. */
export function patchThermalShader(shader: {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string; fragmentShader: string;
}, field: ThermalField) {
  Object.assign(shader.uniforms, field.uniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nattribute float materialId;\nvarying float vThermalMaterial;")
    .replace("#include <project_vertex>", "#include <project_vertex>\nvThermalMaterial = materialId;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>
varying float vThermalMaterial;
uniform int uHeatCount;
uniform vec4 uHeatPosition[${HEAT_SLOTS}];
uniform vec2 uHeatState[${HEAT_SLOTS}];
uniform float uHeatTime;
`)
    .replace("#include <color_fragment>", `#include <color_fragment>
  float thermalHeat = 0.0;
  float thermalScorch = 0.0;
  float thermalGrain = voxelHash(floor(vWPos * 2.0));
  for (int i = 0; i < ${HEAT_SLOTS}; i++) {
    if (i >= uHeatCount) break;
    vec3 offset = vWPos - uHeatPosition[i].xyz;
    float radius = uHeatPosition[i].w;
    if (dot(offset, offset) > radius * radius) continue;
    float distanceToHeat = length(offset) / radius;
    float footprint = 1.0 - smoothstep(0.35, 1.0, distanceToHeat + (thermalGrain - 0.5) * 0.15);
    thermalHeat = max(thermalHeat, footprint * uHeatState[i].x);
    thermalScorch = max(thermalScorch, footprint * uHeatState[i].y);
  }
  bool thermalRock = abs(vThermalMaterial - 2.0) < 0.25 || abs(vThermalMaterial - 8.0) < 0.25;
  bool thermalOrganic = vThermalMaterial > 2.5 && vThermalMaterial < 7.5 || (vThermalMaterial > 10.5 && vThermalMaterial < 12.5);
  if (thermalOrganic) {
    vec3 charcoal = vec3(0.014, 0.009, 0.005) * (0.7 + thermalGrain * 0.6);
    diffuseColor.rgb = mix(diffuseColor.rgb, charcoal, thermalScorch * 0.96);
  }
  if (thermalRock) {
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.018, 0.006), thermalHeat * 0.8);
  }
`)
    .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
  if (thermalRock) {
    float glow = pow(thermalHeat, 1.6);
    float cracks = smoothstep(0.75, 0.95, thermalGrain);
    float pulse = 1.0 + 0.05 * sin(uHeatTime * 5.0 + thermalGrain * 6.0);
    vec3 heatColor = mix(vec3(1.8, 0.025, 0.003), vec3(3.5, 0.65, 0.025), thermalHeat * thermalHeat);
    totalEmissiveRadiance += heatColor * glow * (0.7 + cracks * 0.7) * pulse;
  }
`);
}
