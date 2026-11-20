import * as THREE from 'three';
import type { CombatTarget, Faora } from './faora';
import { beamMaterial } from './combat-fx';

const RANGE = 160;        // m the beam reaches past its target
const TARGET_RANGE = 280;
const CHARGE = .45;       // s of glowing eyes before it fires
const BURST = .9;         // s of beam
const SWEEP = .4;         // rad/s the beam can drag toward you: a quick sidestep still escapes it
const COOLDOWN = 3;

function glowTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d')!;
  const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,240,1)');
  gradient.addColorStop(.2, 'rgba(255,170,120,.9)');
  gradient.addColorStop(.5, 'rgba(255,50,20,.35)');
  gradient.addColorStop(1, 'rgba(255,0,0,0)');
  g.fillStyle = gradient; g.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Faora's telegraphed heat vision: eyes flare, then a beam rakes toward her target and melts whatever it lands on. */
export class LaserVision {
  private readonly group = new THREE.Group();
  /** Where the beam is burning this frame, for sparks. */
  readonly impactPoint = new THREE.Vector3();
  readonly beamDirection = new THREE.Vector3(0, 0, 1);
  impacting = false;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly beams: THREE.Mesh[] = [];
  private readonly cores: THREE.Mesh[] = [];
  private readonly eyes: THREE.Sprite[] = [];
  private readonly splash: THREE.Sprite;
  private readonly aim = new THREE.Vector3();
  private readonly want = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly chest = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly closest = new THREE.Vector3();
  private readonly axis = new THREE.Vector3(0, 1, 0);
  private readonly direction = new THREE.Vector3();
  private cooldown = 3;
  private charge = 0;
  private firing = 0;
  private tick = 0;
  private burnGroup = -1;
  private flicker = 0;
  private look = 0;
  private clear = false;
  private target: CombatTarget | null = null;
  private counteringGrab = false;
  onCharge = () => {};
  onFire = () => {};
  onHit = (_strength: number, _target: CombatTarget) => {};
  /** Where the beam is blocked; returns the edit group so one burst cuts one continuous groove. */
  onBurn = (_point: THREE.Vector3, _group: number) => -1;

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    const additive = { transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending, fog: false };
    const glow = typeof document === 'undefined' ? null : glowTexture();
    for (let i = 0; i < 2; i++) {
      // Normal blending keeps the sheath red against bright sky; only the white-hot core adds light.
      const beam = new THREE.Mesh(geometry, beamMaterial(0xff5a1c, 0xe60d00, false, .85));
      const core = new THREE.Mesh(geometry, beamMaterial(0xffffff, 0xffb48a, true, 1));
      this.materials.push(beam.material, core.material);
      beam.frustumCulled = core.frustumCulled = false;
      this.beams.push(beam); this.cores.push(core); this.group.add(beam, core);
      const eye = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xff6040, ...additive }));
      this.eyes.push(eye); this.group.add(eye);
    }
    this.splash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffa060, ...additive }));
    this.group.add(this.splash);
    this.group.visible = false; scene.add(this.group);
  }

  /** Show every part once so the renderer can compile its shaders up front. */
  set warm(on: boolean) { this.group.visible = on; for (const part of this.group.children) part.visible = true; }

  get active() { return this.charge > 0 || this.firing > 0; }

  update(dt: number, fighter: Faora, player: CombatTarget | null, deployed: boolean, counterGrab = false) {
    this.group.visible = false;
    this.impacting = false;
    if (!player || !deployed || (!fighter.availableToFight && !counterGrab) || player.vitals.defeated) {
      this.target = null;
      this.counteringGrab = false;
      this.charge = this.firing = this.look = 0;
      return;
    }
    if (player !== this.target || counterGrab !== this.counteringGrab) {
      this.charge = this.firing = this.look = 0;
      this.target = player;
      this.counteringGrab = counterGrab;
      if (counterGrab) this.cooldown = Math.min(this.cooldown, .35);
    }
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.origin.copy(fighter.pos).y += 1.74 * fighter.bodyScale;
    this.chest.copy(player.pos).y += counterGrab ? player.eyeLevel : 1.2;
    const distance = this.origin.distanceTo(this.chest);
    if (this.firing <= 0) {
      // Only check sight when she could actually start a burst.
      if (this.cooldown > 0 || (!counterGrab && distance < 8) || distance > TARGET_RANGE) {
        this.charge = this.look = 0;
        return;
      }
      // Sight is rechecked a few times a second, not every frame.
      this.look -= dt;
      if (this.look <= 0) { this.look = .2; this.clear = fighter.lineClear(this.origin, this.chest); }
      if (!this.clear) { this.charge = 0; return; }
      if (this.charge === 0) this.onCharge();
      this.charge += dt;
      this.aim.subVectors(this.chest, this.origin).normalize();
      if (this.charge >= CHARGE) {
        this.firing = BURST; this.tick = 0; this.charge = 0; this.cooldown = COOLDOWN; this.burnGroup = -1;
        this.onFire();
      }
    } else {
      // The beam drags toward you at a limited rate: keep moving and it trails behind.
      this.want.subVectors(this.chest, this.origin).normalize();
      const angle = this.aim.angleTo(this.want);
      if (angle > 1e-4) this.aim.lerp(this.want, Math.min(1, SWEEP * dt / angle)).normalize();
    }

    this.group.visible = true;
    this.flicker += dt * 40;
    fighter.model.updateMatrixWorld(true);
    const firing = this.firing > 0;
    const eyeSize = firing ? .5 + Math.sin(this.flicker) * .08 : .06 + (this.charge / CHARGE) ** 2 * .34 + Math.sin(this.flicker * 1.7) * .02;
    // One march for both beams: the eyes are 10 cm apart.
    let reach = RANGE + distance, terrainBlocked = false, onTarget = false;
    if (firing) {
      this.end.copy(this.origin).addScaledVector(this.aim, reach);
      reach *= fighter.firstBlock(this.origin, this.end);
      terrainBlocked = reach < RANGE + distance - .5;
      // Your body stops the beam too; end it short of the lens so it doesn't fill the screen.
      const along = this.closest.subVectors(this.chest, this.origin).dot(this.aim);
      this.closest.copy(this.origin).addScaledVector(this.aim, THREE.MathUtils.clamp(along, 0, reach));
      if (along > 0 && along < reach && this.closest.distanceTo(this.chest) < .85) {
        onTarget = true; terrainBlocked = false; reach = Math.max(0, along - Math.min(1.4, along * .45));
      }
      this.end.copy(this.origin).addScaledVector(this.aim, reach);
      this.impacting = terrainBlocked || onTarget;
      this.impactPoint.copy(this.end); this.beamDirection.copy(this.aim);
      for (const material of this.materials) material.uniforms.uTime.value = this.flicker / 40;
    }
    for (let i = 0; i < 2; i++) {
      fighter.eyePosition(i, this.eye);
      const sprite = this.eyes[i];
      sprite.position.copy(this.eye); sprite.scale.setScalar(eyeSize);
      const beam = this.beams[i], core = this.cores[i];
      beam.visible = core.visible = firing;
      if (!firing) continue;
      this.direction.subVectors(this.end, this.eye);
      const length = this.direction.length();
      if (length < .001) { beam.visible = core.visible = false; continue; }
      this.direction.divideScalar(length);
      for (const mesh of [beam, core]) {
        mesh.position.copy(this.eye).addScaledVector(this.direction, length / 2);
        mesh.quaternion.setFromUnitVectors(this.axis, this.direction);
      }
      const pulse = 1 + Math.sin(this.flicker + i) * .15;
      beam.scale.set(.1 * pulse, length, .1 * pulse);
      core.scale.set(.042, length, .042);
    }
    this.splash.visible = terrainBlocked;
    if (terrainBlocked) {
      this.splash.position.copy(this.end);
      this.splash.scale.setScalar(2.1 + Math.sin(this.flicker * .7) * .5);
    }
    if (!firing) return;
    this.firing = Math.max(0, this.firing - dt);
    this.tick -= dt;
    if (this.tick > 0) return;
    this.tick += .1;
    if (terrainBlocked) this.burnGroup = this.onBurn(this.end, this.burnGroup);
    if (onTarget) this.onHit(4, player);
  }
}
