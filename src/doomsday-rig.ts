import * as THREE from 'three';

type Pair = [THREE.Group, THREE.Group];

function joint(parent: THREE.Group, name: string, x: number, y: number, z = 0) {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(x, y, z);
  group.rotation.order = 'YXZ';
  parent.add(group);
  return group;
}

export class DoomsdayRig {
  readonly torso: THREE.Group;
  readonly head: THREE.Group;
  readonly jaw: THREE.Group;
  readonly mouth: THREE.Group;
  readonly hands: Pair;
  readonly shins: Pair;
  readonly feet: Pair;

  constructor(readonly root: THREE.Group, readonly arms: Pair, readonly forearms: Pair, readonly legs: Pair) {
    root.rotation.order = 'YXZ';
    this.torso = joint(root, 'Doomsday torso', 0, 1.15);
    this.head = joint(root, 'Doomsday neck', 0, 1.64, .035);
    this.jaw = joint(this.head, 'Doomsday jaw', 0, -.045, .045);
    this.mouth = joint(this.head, 'Doomsday beam socket', 0, .025, .294);
    const buildSide = (side: 0 | 1) => {
      const sign = side === 0 ? -1 : 1;
      const label = side === 0 ? 'left' : 'right';
      const arm = arms[side], forearm = forearms[side], leg = legs[side];
      arm.rotation.order = forearm.rotation.order = leg.rotation.order = 'YXZ';
      arm.name = `Doomsday ${label} shoulder`;
      arm.position.set(sign * .415, 1.40, 0);
      forearm.name = `Doomsday ${label} elbow`;
      forearm.position.set(0, -.365, 0);
      leg.name = `Doomsday ${label} hip`;
      leg.position.set(sign * .205, .84, 0);
      leg.userData.ragdollPart = side === 0 ? 'leftLeg' : 'rightLeg';
      root.add(arm, leg);
      arm.add(forearm);
      const hand = joint(forearm, `Doomsday ${label} wrist`, 0, -.295);
      const shin = joint(leg, `Doomsday ${label} knee`, 0, -.37);
      const foot = joint(shin, `Doomsday ${label} ankle`, 0, -.365);
      return {hand, shin, foot};
    };
    const left = buildSide(0), right = buildSide(1);
    this.hands = [left.hand, right.hand];
    this.shins = [left.shin, right.shin];
    this.feet = [left.foot, right.foot];
  }

  reset() {
    this.root.rotation.x = this.root.rotation.z = 0;
    for (const group of [this.torso, this.head, this.jaw, ...this.arms, ...this.forearms, ...this.hands,
      ...this.legs, ...this.shins, ...this.feet]) group.rotation.set(0, 0, 0);
  }
}
