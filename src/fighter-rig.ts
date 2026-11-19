import * as THREE from "three";

type Pair = [THREE.Group, THREE.Group];

export interface RigSpec {
  /** Height of the pivot the chest bends and twists around. */
  waist: number;
  neck: [y: number, z: number];
  shoulder: [x: number, y: number, z: number];
  upperArm: number;
  forearm: number;
  hip: [x: number, y: number];
  thigh: number;
  shin: number;
  /** Where the cape or mane hangs from, in model space. */
  cape: [y: number, z: number];
}

function joint(parent: THREE.Object3D, name: string, x: number, y: number, z = 0) {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(x, y, z);
  group.rotation.order = "YXZ";
  parent.add(group);
  return group;
}

/**
 * The jointed skeleton shared by Faora, Anissa and Battle Beast.
 * It stays flat at the top level (hips, chest, head, arms, legs) because the ragdoll re-parents those pieces;
 * the animation carries the head, arms and cape along with the chest itself.
 */
export class FighterRig {
  readonly hips: THREE.Group;
  readonly torso: THREE.Group;
  readonly head: THREE.Group;
  readonly jaw: THREE.Group;
  readonly lids: THREE.Group;
  readonly cape: THREE.Group;
  readonly hands: Pair;
  readonly fingers: Pair;
  readonly shins: Pair;
  readonly feet: Pair;
  /** Model-space rest position of each top-level joint. */
  readonly home = new Map<THREE.Group, THREE.Vector3>();
  readonly waist: THREE.Vector3;

  constructor(readonly root: THREE.Group, readonly arms: Pair, readonly forearms: Pair, readonly legs: Pair, readonly spec: RigSpec) {
    root.rotation.order = "YXZ";
    this.waist = new THREE.Vector3(0, spec.waist, 0);
    this.hips = joint(root, "hips", 0, spec.hip[1]);
    this.torso = joint(root, "chest", 0, spec.waist);
    this.head = joint(root, "neck", 0, spec.neck[0], spec.neck[1]);
    this.jaw = joint(this.head, "jaw", 0, .07, .02);
    this.lids = joint(this.head, "eyelids", 0, 0, 0);
    this.cape = joint(root, "cape", 0, spec.cape[0], spec.cape[1]);
    const side = (index: 0 | 1) => {
      const sign = index === 0 ? -1 : 1, label = index === 0 ? "left" : "right";
      const arm = arms[index], forearm = forearms[index], leg = legs[index];
      forearm.rotation.order = leg.rotation.order = "YXZ";
      arm.rotation.order = "XYZ"; // reads back a full-range shoulder pitch, even with the arm overhead
      arm.name = `${label} shoulder`; forearm.name = `${label} elbow`; leg.name = `${label} hip`;
      arm.position.set(sign * spec.shoulder[0], spec.shoulder[1], spec.shoulder[2]);
      forearm.position.set(0, -spec.upperArm, 0);
      leg.position.set(sign * spec.hip[0], spec.hip[1], 0);
      leg.userData.ragdollPart = index === 0 ? "leftLeg" : "rightLeg";
      root.add(arm, leg);
      arm.add(forearm);
      const hand = joint(forearm, `${label} wrist`, 0, -spec.forearm);
      const fingers = joint(hand, `${label} fingers`, 0, -.075);
      const shin = joint(leg, `${label} knee`, 0, -spec.thigh);
      const foot = joint(shin, `${label} ankle`, 0, -spec.shin);
      return { hand, fingers, shin, foot };
    };
    const left = side(0), right = side(1);
    this.hands = [left.hand, right.hand];
    this.fingers = [left.fingers, right.fingers];
    this.shins = [left.shin, right.shin];
    this.feet = [left.foot, right.foot];
    for (const group of [this.hips, this.torso, this.head, this.cape, ...arms]) this.home.set(group, group.position.clone());
  }
}
