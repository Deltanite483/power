import * as THREE from "three";
import { Sculpt, Skin } from "./fighter-mesh";

// Camera-space poses of the right fist (metres; -z is forward), laid out for a 16:9 view at ~68° vertical FOV:
// ready sits in the lower right, wound pulls closer and further out, extend reaches just under the crosshair.
const HIDDEN = new THREE.Vector3(0.35, -0.6, -0.45);
const READY = new THREE.Vector3(0.32, -0.22, -0.6);
const WOUND = new THREE.Vector3(0.29, -0.19, -0.42);
const EXTEND = new THREE.Vector3(0.13, -0.21, -1.0);
const HOLD = 0.09, RETRACT = 0.36; // seconds after impact
const HOT = new THREE.Color(0xff7a1f);

/** First-person right fist: hidden at rest, rises and winds back while a punch charges, snaps out on release. */
export class FistView {
  readonly group = new THREE.Group();
  private readonly arm = new THREE.Group();
  private readonly material: THREE.MeshStandardMaterial;
  private twist = 0;
  private jolt = 0;
  private readonly pos = HIDDEN.clone();
  private readonly target = new THREE.Vector3();
  private strikeT = -1;
  private strikePower = 0;
  private heat = 0;
  private time = 0;

  constructor(private camera: THREE.PerspectiveCamera, private side = 1) {
    // A sculpted forearm in the white suit sleeve, a dark cuff, and a bare clenched fist with knuckles and thumb.
    const [SLEEVE, CUFF, SKIN, SHADE, SEAM] = [0, 1, 2, 3, 4];
    const skin = new Skin([{ color: 0xe9e6df, rough: .55, metal: .05 }, { color: 0x2a2d34, rough: .5, metal: .3 },
      { color: 0xd9a07a, rough: .7 }, { color: 0xbd8463, rough: .72 }, { color: 0x9aa3ad, rough: .5, metal: .2 }], .25);
    skin.material.fog = false;
    this.material = skin.material;
    const s = new Sculpt(skin);
    s.tube(this.arm, (angle, t) => t < .1 ? CUFF : Math.abs(Math.abs(angle) - Math.PI / 2) < .22 ? SEAM : SLEEVE,
      [[.07, .046, .04], [.2, .054, .05], [.36, .062, .058], [.5, .058, .055], [.62, .05, .05]], { sectors: 16, rows: 3, rot: [Math.PI / 2, 0, 0] });
    s.tube(this.arm, SKIN, [[.0, .05, .04], [.085, .042, .036]], { sectors: 12, rows: 1, rot: [Math.PI / 2, 0, 0] });
    s.ball(this.arm, SKIN, 0, 0, -.008, .066, .052, .058);
    for (let i = 0; i < 4; i++) {
      const x = -.047 + i * .031, drop = i === 0 || i === 3 ? .006 : 0;
      s.ball(this.arm, SKIN, x, .018 - drop, -.05, .0165, .021, .026);    // first joints
      s.ball(this.arm, SHADE, x, .038 - drop, -.052, .011, .008, .012);   // knuckles
      s.ball(this.arm, SKIN, x, -.02 - drop, -.04, .0155, .02, .027);     // fingers curled under
    }
    s.ball(this.arm, SKIN, -.064, -.012, -.022, .02, .021, .04, .2, .35, 0); // thumb wrapped across
    s.ball(this.arm, SHADE, -.07, -.014, -.052, .014, .014, .014);
    s.bake();
    this.arm.rotation.set(0.25, 0.35, 0); // sleeve trails back toward the lower-right corner
    this.group.add(this.arm);
    this.group.scale.x = side;
    this.group.position.copy(HIDDEN);
    this.group.visible = false;
    camera.add(this.group);
  }

  cancelStrike() {
    this.strikeT = -1;
    this.pos.copy(HIDDEN);
    this.group.visible = false;
    this.heat = this.jolt = 0;
  }

  /** Throw the fist; power 0..1+ sets the glow and how far the arm overreaches. */
  strike(power: number) {
    this.strikeT = 0;
    this.strikePower = power;
    this.heat = Math.max(this.heat, Math.min(1, power));
    this.twist = 0; this.jolt = 0.4 + Math.min(1, power) * 0.6;
    this.arm.rotation.set(0.25, 0.35, 0);
    // Damage is resolved on release, so show the contact pose even during hitstop.
    this.pos.copy(EXTEND);
    this.pos.z -= power * 0.12;
    this.group.position.copy(this.pos);
    this.group.position.x *= this.side * THREE.MathUtils.clamp(this.camera.aspect / (16 / 9), 0.25, 1.3);
    this.group.visible = true;
  }

  /** charge: 0..1 while a punch charges, negative otherwise. */
  update(dt: number, charge: number) {
    this.time += dt;
    if (this.strikeT >= 0) {
      this.strikeT += dt;
      const t = this.strikeT;
      if (t < HOLD) {
        this.pos.copy(EXTEND);
        this.pos.z -= this.strikePower * 0.12 * (1 - t / HOLD);
      } else if (t < RETRACT) {
        const k = (t - HOLD) / (RETRACT - HOLD);
        this.pos.lerpVectors(EXTEND, charge >= 0 ? READY : HIDDEN, k * k * (3 - 2 * k));
      } else this.strikeT = -1;
    } else {
      if (charge >= 0) {
        this.target.lerpVectors(READY, WOUND, charge);
        // the wound-up fist trembles harder the more power it holds
        const shake = charge * charge * 0.012;
        this.target.x += Math.sin(this.time * 61) * shake;
        this.target.y += Math.sin(this.time * 47 + 1) * shake;
        this.heat += ((charge >= 0.3 ? charge : 0) - this.heat) * Math.min(1, dt * 10);
      } else this.target.copy(HIDDEN);
      this.pos.lerp(this.target, 1 - Math.exp(-dt * (charge >= 0 ? 14 : 8)));
    }
    if (charge < 0) this.heat *= Math.exp(-dt * 3);
    // narrower windows pull the fist inward so it stays in the same spot on screen
    this.group.position.copy(this.pos);
    this.group.position.x *= this.side * THREE.MathUtils.clamp(this.camera.aspect / (16 / 9), 0.25, 1.3);
    this.group.visible = this.pos.y > HIDDEN.y + 0.05;
    this.material.emissive.copy(HOT).multiplyScalar(this.heat * 0.8);
    // The fist is cocked palm-in while charging and corkscrews flat as it lands, then shudders with the impact.
    const striking = this.strikeT >= 0;
    const cocked = striking ? 0 : charge >= 0 ? 0.55 + charge * 0.35 : 0.3;
    this.twist += (cocked - this.twist) * (1 - Math.exp(-dt * (striking ? 40 : 10)));
    this.jolt *= Math.exp(-dt * 16);
    const shudder = Math.sin(this.time * 90) * this.jolt;
    this.arm.rotation.set(0.25 + this.twist * 0.18 + shudder * 0.05, 0.35 - this.twist * 0.12, -this.twist * 0.9 + shudder * 0.06);
    this.group.position.y += Math.sin(this.time * 2.1) * 0.004 * (charge >= 0 && !striking ? 1 : 0);
  }
}
