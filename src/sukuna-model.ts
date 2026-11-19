import * as THREE from "three";
import { Sculpt, Skin } from "./fighter-mesh";
import { HEAD_SCALE } from "./fighter-models";
import type { FighterRig, RigSpec } from "./fighter-rig";

export const SUKUNA_SPEC: RigSpec = {
  waist: 1.02, neck: [1.51, .01], shoulder: [.23, 1.43, 0], upperArm: .29,
  forearm: .26, hip: [.103, .92], thigh: .43, shin: .40, cape: [1.46, -.1],
};

const gauss = (value: number, center: number, width: number) => Math.exp(-(((value - center) / width) ** 2));
const HALF = Math.PI / 2;

/**
 * Sukuna in Yuji's body: the school jacket with its red hood, sleeves shoved up over banded wrists,
 * swept-back spikes, a second pair of eyes and the curse markings across his face.
 */
export function buildSukuna(rig: FighterRig) {
  const [SKIN, SKIN_SHADE, JACKET, SEAM, PANTS, HOOD, HOOD_DARK, HAIR, HAIR_LIGHT, HAIR_DARK, INK, WHITE, IRIS, GOLD, SHOE, SOLE, LIP] =
    Array.from({ length: 17 }, (_, i) => i);
  const s = new Sculpt(new Skin([
    { color: 0xd9a78c, rough: .66 }, { color: 0xbd8a72, rough: .7 },
    { color: 0x1a1c2b, rough: .86 }, { color: 0x30344b, rough: .8 }, { color: 0x13141c, rough: .9 },
    { color: 0xb4233a, rough: .8 }, { color: 0x6f1424, rough: .86 },
    { color: 0xd66b79, rough: .6 }, { color: 0xea979e, rough: .55 }, { color: 0x55282f, rough: .7 },
    { color: 0x130e15, rough: .72 }, { color: 0xefe7dd, rough: .35 }, { color: 0xd3122b, rough: .25, glow: .85 },
    { color: 0xc9a24a, rough: .32, metal: .85 }, { color: 0xb5202f, rough: .62 }, { color: 0xe9e3d8, rough: .6 },
    { color: 0x8f4f4b, rough: .5 },
  ], .34));
  const { hips, torso, lids, arms, forearms, hands, fingers, legs, shins, feet } = rig;
  const head = new THREE.Group();
  head.scale.setScalar(HEAD_SCALE * 1.06); head.position.y = -.03; rig.head.add(head); head.add(lids);

  // Jacket: wide shoulders tapering to a short hem, with a pale placket and a gold swirl button.
  s.tube(torso, (angle, _t, y) => {
    const a = Math.abs(angle);
    if (y < -.085) return SEAM;
    if (a < .07 && y < .4) return SEAM;
    if (a > 1.35 && a < 1.5 && y < .26) return SEAM;
    return JACKET;
  }, [
    [-.115, .15, .112], [-.05, .147, .108], [.02, .146, .106], [.09, .154, .11], [.16, .172, .12, .004], [.24, .196, .13, .008],
    [.31, .212, .124, .004], [.365, .21, .108], [.4, .168, .09, -.004], [.428, .08, .064, -.006], [.455, .06, .057, -.006],
  ], { sectors: 40, rows: 4, square: 2.3, bulge: (angle, _t, y) =>
    1 + .1 * gauss(Math.abs(angle), .5, .32) * gauss(y, .26, .07) + .05 * gauss(Math.abs(angle), 2.55, .35) * gauss(y, .28, .09) });
  s.tube(torso, JACKET, [[.4, .072, .067, -.004], [.45, .066, .063, -.004], [.478, .064, .061, -.002]], { sectors: 16, rows: 1 });
  s.cyl(torso, GOLD, .058, .352, .121, .017, .006, .017, HALF - .12);
  s.cyl(torso, INK, .058, .352, .1245, .008, .004, .008, HALF - .12);
  // The hood: gathered round the collar, hanging open down his back.
  s.tube(torso, HOOD, [[.378, .1, .085, -.018], [.402, .128, .104, -.03], [.428, .122, .1, -.034], [.45, .09, .078, -.03]], { sectors: 20, rows: 2 });
  s.ball(torso, HOOD, 0, .33, -.128, .112, .1, .05, .14);
  s.ball(torso, HOOD_DARK, 0, .418, -.1, .084, .034, .05, .25);

  // Trousers and belt.
  s.tube(hips, (_angle, _t, y) => y > .075 && y < .112 ? INK : PANTS,
    [[.14, .14, .104], [.07, .15, .11], [0, .164, .119, -.004], [-.06, .162, .12, -.006], [-.12, .112, .096], [-.165, .03, .04]],
    { sectors: 24, rows: 3, square: 2.2 });
  s.box(hips, GOLD, 0, .093, .112, .04, .03, .012);

  // Head: one sculpted sphere, with a heavier brow and jaw than the flyers.
  const face = new THREE.SphereGeometry(1, 32, 24), fp = face.attributes.position;
  for (let i = 0; i < fp.count; i++) {
    let x = fp.getX(i), y = fp.getY(i), z = fp.getZ(i);
    if (y < -.15) { const k = (y + .15) / .85; x *= 1 + k * .22; if (z > 0) z *= 1 + k * .08; else z *= 1 + k * .3; }
    if (z > 0) {
      z += gauss(Math.abs(x), .52, .26) * gauss(y, -.1, .3) * .055;      // cheekbones
      z += gauss(x, 0, .13) * gauss(y, -.06, .3) * .11;                  // nose bridge
      z += gauss(x, 0, .12) * gauss(y, -.27, .1) * .1;                   // nose tip
      z += gauss(x, 0, .5) * gauss(y, .27, .1) * .05;                    // brow ridge
      z -= gauss(Math.abs(x), .36, .16) * gauss(y, .1, .09) * .06;       // eye sockets
      z += gauss(x, 0, .24) * gauss(y, -.52, .07) * .04;                 // lips
      z += gauss(x, 0, .26) * gauss(y, -.82, .13) * .07;                 // chin
    }
    fp.setXYZ(i, x, y, z);
  }
  face.computeVertexNormals();
  const HX = .09, HY = .11, HZ = .097, CY = .135, CZ = .012;
  s.shape(head, face, SKIN, 0, CY, CZ, HX, HY, HZ);
  const surface = (x: number, y: number) => CZ + HZ * Math.sqrt(Math.max(0, 1 - (x / HX) ** 2 - ((y - CY) / HY) ** 2));
  s.tube(head, SKIN, [[-.09, .057, .054], [-.02, .051, .05], [.06, .049, .051, .004]], { sectors: 14, rows: 2 });
  /** A flat marking laid on the skin, turned to follow the curve of the skull. */
  const mark = (swatch: number, x: number, y: number, width: number, height: number, roll = 0, lift = .0015, parent: THREE.Object3D = head) => {
    const z = surface(x, y);
    const n = new THREE.Vector3(x / HX ** 2, (y - CY) / HY ** 2, (z - CZ) / HZ ** 2).normalize();
    s.box(parent, swatch, x, y, z + lift, width, height, .004, -Math.atan2(n.y, n.z), Math.asin(n.x), roll);
  };

  for (const sign of [-1, 1]) {
    // Narrow red eyes under hard, angled brows.
    const x = sign * .035, y = .149, z = surface(x, y) - .0065;
    s.ball(head, WHITE, x, y, z, .0205, .0095, .006, 0, sign * .3, sign * .16);
    s.ball(head, IRIS, x, y - .0004, z + .0042, .0092, .0092, .003);
    s.ball(head, INK, x, y - .0004, z + .0062, .0036, .0046, .002);
    s.ball(head, WHITE, x - .003, y + .003, z + .0078, .0015, .0015, .001);
    s.ball(head, INK, x, y + .0082, z + .003, .0225, .0032, .0044, 0, sign * .3, sign * .2);
    s.ball(head, INK, x + sign * .003, y - .008, z + .0026, .017, .0016, .003, 0, sign * .3, sign * .08);
    s.ball(head, HAIR_DARK, x + sign * .001, y + .024, z + .0075, .026, .0058, .006, 0, sign * .3, sign * .34);
    s.ball(lids, SKIN, x, y + .0125, z + .0012, .0205, .009, .0062, 0, sign * .3, sign * .16);
    // The second pair, set into the cheekbones.
    const x2 = sign * .045, y2 = .119, z2 = surface(x2, y2) - .003;
    s.ball(head, INK, x2, y2, z2 + .0006, .019, .0072, .004, 0, sign * .42, sign * .3);
    s.ball(head, WHITE, x2, y2 - .0004, z2 + .0022, .015, .0048, .003, 0, sign * .42, sign * .3);
    s.ball(head, IRIS, x2 - sign * .001, y2 - .0002, z2 + .0038, .0048, .0048, .002);
    // Curse marks: two bars sweeping back along each cheek, and a wing either side of the forehead crest.
    mark(INK, sign * .064, .1, .034, .0062, sign * .3);
    mark(INK, sign * .066, .084, .027, .0062, sign * .3);
    mark(INK, sign * .031, .208, .03, .0062, sign * .52);
    s.ball(head, SKIN_SHADE, sign * HX * .97, CY - .006, CZ - .012, .012, .028, .018);
    s.ball(head, HAIR_DARK, sign * .081, .16, .02, .01, .03, .02);
  }
  mark(INK, 0, .209, .017, .017, Math.PI / 4);
  mark(INK, 0, .154, .034, .0052, 0, .0125);
  mark(INK, 0, .05, .0058, .024, 0, .006);
  // A lopsided smirk.
  s.ball(head, LIP, .002, .0735, surface(0, .0735) + .0085, .0225, .0034, .006, 0, 0, .1);
  s.ball(head, LIP, .0225, .0768, surface(.0225, .0768) + .0052, .007, .003, .005, 0, .4, .7);
  s.ball(head, SKIN_SHADE, 0, .096, surface(0, .096) + .0095, .012, .004, .006);

  // Hair: a dark undercut, then rows of pale spikes raked up and back off a widow's peak.
  s.ball(head, HAIR_DARK, 0, .162, -.022, .0945, .1, .1);
  s.ball(head, HAIR, 0, .198, -.018, .087, .07, .098);
  const spike = (x: number, y: number, z: number, lean: number, back: number, length: number, width: number, light: boolean) =>
    s.spike(head, light ? HAIR_LIGHT : HAIR, [x, y, z], [lean, 1, back], length, width, 5, true, width * .8);
  for (let i = 0; i < 5; i++) {
    const k = i - 2, a = Math.abs(k), x = k * .033;
    spike(x, .222 - a * .014, .06 - a * .014, k * .3, -.75, .095 - a * .014, .034, i % 2 === 0);
    spike(x * 1.05, .24 - a * .017, .012, k * .34, -1.05, .135 - a * .02, .04, i % 2 === 1);
    spike(x, .232 - a * .016, -.046, k * .3, -1.7, .13 - a * .016, .04, i % 2 === 0);
  }
  for (let i = 0; i < 4; i++) {
    const k = i - 1.5, x = k * .04;
    spike(x, .196 - Math.abs(k) * .008, -.09, k * .2, -3.2, .1, .036, i % 2 === 1);
  }
  s.spike(head, HAIR, [0, .241, .076], [0, -1, .42], .036, .026, 4, true, .012);

  for (const side of [0, 1] as const) {
    const sign = side === 0 ? -1 : 1;
    const arm = arms[side], forearm = forearms[side], hand = hands[side], finger = fingers[side];
    const leg = legs[side], shin = shins[side], foot = feet[side];

    // Sleeve to the elbow, shoved up off the forearm.
    s.ball(arm, JACKET, 0, -.03, 0, .062, .056, .066);
    s.tube(arm, (angle) => Math.abs(angle - sign * HALF) < .16 ? SEAM : JACKET,
      [[.015, .058, .061], [-.07, .064, .067], [-.16, .058, .061, .003], [-.25, .051, .053], [-.295, .049, .05]], { sectors: 14, rows: 2 });
    s.ball(arm, JACKET, 0, -.285, -.004, .051, .05, .053);
    s.tube(forearm, JACKET, [[.02, .05, .052], [-.03, .056, .058], [-.085, .057, .058], [-.108, .052, .053]], { sectors: 14, rows: 1 });
    s.cyl(forearm, SEAM, 0, -.1, 0, .0575, .02, .0585);
    // Bare forearm with the two bands that ring each wrist.
    s.tube(forearm, (_angle, t) => (t > .56 && t < .68) || (t > .78 && t < .9) ? INK : SKIN,
      [[-.09, .046, .048], [-.14, .046, .048], [-.2, .038, .039], [-.245, .032, .033], [-.265, .031, .032]], { sectors: 14, rows: 3 });

    // Hand: palm, thumb, and four black-nailed fingers on one knuckle joint.
    s.ball(hand, SKIN, 0, -.04, 0, .0175, .045, .036);
    s.ball(hand, SKIN, -sign * .008, -.042, .038, .0115, .029, .0125, .35, 0, 0);
    s.ball(hand, INK, -sign * .009, -.064, .0455, .0075, .009, .007, .35, 0, 0);
    for (let i = 0; i < 4; i++) {
      const z = (i - 1.5) * .0176, reach = i === 0 || i === 3 ? .031 : .037;
      s.tube(finger, (_angle, t) => t > .72 ? INK : SKIN, [[.006, .0088, .0085], [-reach, .008, .0078], [-reach * 2, .0058, .0058]],
        { sectors: 6, rows: 3, at: [0, 0, z] });
    }

    // Loose trousers gathered at the ankle, over red trainers.
    s.tube(leg, PANTS, [[.05, .078, .086], [-.05, .093, .099, -.004], [-.17, .087, .091], [-.3, .073, .076, .003], [-.4, .063, .065], [-.44, .06, .062]],
      { sectors: 16, rows: 3 });
    s.ball(leg, PANTS, 0, -.43, .004, .058, .056, .06);
    s.tube(shin, (_angle, t) => t > .9 ? INK : PANTS,
      [[.02, .058, .06], [-.1, .064, .07, -.008], [-.22, .058, .062, -.004], [-.32, .054, .056], [-.37, .056, .058], [-.385, .045, .047]],
      { sectors: 14, rows: 3 });
    s.ball(foot, SHOE, 0, -.036, .008, .044, .046, .06);
    s.tube(foot, SHOE, [[-.055, .038, .032], [.02, .044, .038], [.1, .046, .03, 0], [.165, .04, .021], [.196, .02, .012]],
      { sectors: 10, rows: 2, at: [0, -.056, 0], rot: [HALF, 0, 0] });
    s.ball(foot, SOLE, 0, -.058, .168, .036, .02, .03);
    s.box(foot, SOLE, 0, -.083, .062, .084, .016, .262);
    s.box(foot, SOLE, sign * .0, -.03, .075, .05, .006, .05, -.5);
  }
  s.bake();
}
