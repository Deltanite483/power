import * as THREE from "three";
import { Sculpt, Skin, type Swatch } from "./fighter-mesh";
import type { FighterRig, RigSpec } from "./fighter-rig";

export const FLYER_SPEC: RigSpec = {
  waist: 1.06, neck: [1.5, -.004], shoulder: [.196, 1.425, -.004], upperArm: .28, forearm: .25,
  hip: [.088, .93], thigh: .43, shin: .42, cape: [1.455, -.092],
};
export const BEAST_SPEC: RigSpec = {
  waist: 1.02, neck: [1.5, .02], shoulder: [.35, 1.41, 0], upperArm: .34, forearm: .3,
  hip: [.15, .84], thigh: .4, shin: .37, cape: [1.46, -.14],
};

export const HEAD_SCALE = 1.1;
const gauss = (value: number, center: number, width: number) => Math.exp(-(((value - center) / width) ** 2));
const HALF = Math.PI / 2;

/** Faora-Ul and Anissa share a body; palette, suit cut, hair and cape set them apart. */
export function buildFlyer(rig: FighterRig, anissa: boolean) {
  const [SUIT, ARMOR, EDGE, BLACK, SKIN, HAIR, HAIR_LIGHT, WHITE, IRIS, PUPIL, LIP, ARMOR_DARK, GLOW, SKIN_SHADE] = Array.from({ length: 14 }, (_, i) => i);
  const palette: Swatch[] = anissa ? [
    { color: 0xe6e4de, rough: .5, metal: .05 }, { color: 0x77818e, rough: .46, metal: .3 }, { color: 0xf6f1e8, rough: .36, metal: .25 },
    { color: 0x2b3038, rough: .62, metal: .15 }, { color: 0xd5a48e, rough: .68 }, { color: 0x1d1719, rough: .42, metal: .1 },
    { color: 0x43302f, rough: .42, metal: .1 }, { color: 0xe9e2d8, rough: .35 }, { color: 0x5788a8, rough: .25 },
    { color: 0x0b0d10, rough: .2 }, { color: 0xa96360, rough: .45 }, { color: 0x505a66, rough: .5, metal: .3 },
    { color: 0xf6f1e8, rough: .36, metal: .25 }, { color: 0xbf8d78, rough: .7 },
  ] : [
    { color: 0x151e2a, rough: .58, metal: .35 }, { color: 0x4d7181, rough: .36, metal: .7 }, { color: 0xa9cfd2, rough: .26, metal: .85 },
    { color: 0x0d1117, rough: .66, metal: .2 }, { color: 0xdcb098, rough: .68 }, { color: 0x141a24, rough: .4, metal: .1 },
    { color: 0x2f4054, rough: .4, metal: .1 }, { color: 0xe9e2d8, rough: .35 }, { color: 0x6f9b90, rough: .25 },
    { color: 0x0b0d10, rough: .2 }, { color: 0xb67472, rough: .45 }, { color: 0x243643, rough: .46, metal: .6 },
    { color: 0x7fdcee, rough: .3, glow: 1 }, { color: 0xc4967f, rough: .7 },
  ];
  const s = new Sculpt(new Skin(palette));
  const { hips, torso, lids, arms, forearms, hands, fingers, legs, shins, feet } = rig;
  // The head is sculpted at life size, then enlarged a touch: faces need to read from a long way off.
  const head = new THREE.Group();
  head.scale.setScalar(HEAD_SCALE); rig.head.add(head); head.add(lids);

  // Chest: ribcage, bust and shoulder line, painted with each fighter's suit cut.
  const chestPaint = (angle: number, _t: number, y: number) => {
    const a = Math.abs(angle);
    if (y > .405) return SUIT;
    if (anissa) {
      // Viltrumite cut: a grey yoke dipping to a point on the sternum, and dark flank panels.
      const yoke = a < HALF ? .245 + .105 * Math.sin(a) : .33;
      if (y > yoke) return ARMOR;
      if (y > yoke - .012) return ARMOR_DARK;
      if (a > 1.15 && a < 1.95 && y < .22) return ARMOR_DARK;
      return SUIT;
    }
    // Kryptonian armour: a breastplate with a bright rim, ribbed flanks and a spine channel.
    if (a < 1.02 && y > .115 && y < .37) return a > .9 || y < .135 || y > .35 ? EDGE : ARMOR;
    if (a < .55 && y < .115) return Math.floor((y + .2) / .034) % 2 ? ARMOR_DARK : SUIT;
    if (a > 1.2 && a < 2 && y < .3) return Math.floor((y + .2) / .028) % 2 ? ARMOR_DARK : SUIT;
    if (a > 2.95) return ARMOR_DARK;
    return SUIT;
  };
  s.tube(torso, chestPaint, [
    [-.05, .112, .086], [.02, .119, .092], [.09, .132, .1], [.16, .15, .112, .004], [.235, .167, .122, .01], [.3, .176, .116, .004],
    [.355, .168, .1], [.395, .12, .08, -.004], [.42, .058, .055, -.006], [.455, .05, .05, -.006],
  ], { sectors: 40, rows: 5, square: 2.25, bulge: (angle, _t, y) =>
    1 + .2 * gauss(Math.abs(angle), .46, .3) * gauss(y, .228, .058) + .05 * gauss(Math.abs(angle), 2.5, .35) * gauss(y, .27, .08) });
  if (anissa) {
    // Raised collar ring and a plain ring crest on the sternum.
    s.cyl(torso, ARMOR_DARK, 0, .415, -.004, .062, .022, .058);
  } else {
    s.cyl(torso, EDGE, 0, .412, -.004, .066, .016, .06);
    s.tube(torso, SUIT, [[.4, .06, .056, -.004], [.45, .054, .052, -.004], [.475, .052, .051, -.002]], { sectors: 14, rows: 1 });
    // A lit diamond glyph: the only light on an otherwise dark suit.
    s.plate(torso, EDGE, [[0, .045], [.04, 0], [0, -.045], [-.04, 0]], .138, .008, 0, .245, -.12);
    s.plate(torso, GLOW, [[0, .026], [.022, 0], [0, -.026], [-.022, 0]], .142, .006, 0, .245, -.12);
  }

  // Pelvis and belt.
  s.tube(hips, (angle, _t, y) => {
    if (anissa) return y < -.075 && Math.abs(angle) > .5 ? SUIT : y > .095 ? ARMOR_DARK : SUIT;
    return y > .085 ? EDGE : y > .06 ? BLACK : Math.abs(angle) > 1.1 && Math.abs(angle) < 2 ? ARMOR_DARK : SUIT;
  }, [[.16, .123, .095], [.1, .136, .103], [.04, .158, .116, -.004], [-.02, .17, .124, -.008], [-.08, .158, .118, -.006], [-.13, .1, .09], [-.165, .03, .04]],
    { sectors: 24, rows: 3, square: 2.2 });
  if (!anissa) s.box(hips, EDGE, 0, .092, .1, .06, .04, .018);

  // Head. The face is one sculpted sphere so light rolls over cheek, brow and chin instead of flat features.
  const face = new THREE.SphereGeometry(1, 32, 24), fp = face.attributes.position;
  for (let i = 0; i < fp.count; i++) {
    let x = fp.getX(i), y = fp.getY(i), z = fp.getZ(i);
    if (y < -.15) { const k = (y + .15) / .85; x *= 1 + k * .4; if (z > 0) z *= 1 + k * .12; else z *= 1 + k * .3; }
    if (z > 0) {
      z += gauss(Math.abs(x), .5, .26) * gauss(y, -.08, .3) * .05;       // cheekbones
      z += gauss(x, 0, .13) * gauss(y, -.08, .3) * .1;                   // nose bridge
      z += gauss(x, 0, .11) * gauss(y, -.27, .1) * .09;                  // nose tip
      z += gauss(x, 0, .4) * gauss(y, .3, .12) * .03;                    // brow
      z -= gauss(Math.abs(x), .36, .16) * gauss(y, .12, .09) * .05;      // eye sockets
      z += gauss(x, 0, .22) * gauss(y, -.52, .07) * .04;                 // lips
      z += gauss(x, 0, .2) * gauss(y, -.8, .12) * .05;                   // chin
    }
    fp.setXYZ(i, x, y, z);
  }
  face.computeVertexNormals();
  const HX = .084, HY = .112, HZ = .095, CY = .135, CZ = .012;
  s.shape(head, face, SKIN, 0, CY, CZ, HX, HY, HZ);
  const surface = (x: number, y: number) => CZ + HZ * Math.sqrt(Math.max(0, 1 - (x / HX) ** 2 - ((y - CY) / HY) ** 2));
  s.tube(head, SKIN, [[-.08, .05, .048], [-.02, .045, .045], [.06, .044, .047, .004]], { sectors: 14, rows: 2 });
  for (const sign of [-1, 1]) {
    const x = sign * .034, y = .148, z = surface(x, y) - .006;
    s.ball(head, WHITE, x, y, z, .019, .0098, .006, 0, sign * .3, sign * .06);
    s.ball(head, IRIS, x, y - .0005, z + .0042, .0094, .0094, .003);
    s.ball(head, PUPIL, x, y - .0005, z + .0064, .0046, .0046, .002);
    s.ball(head, WHITE, x - .0035, y + .0035, z + .008, .0018, .0018, .001);
    s.ball(head, PUPIL, x, y + .0092, z + .003, .0215, .0028, .0042, 0, sign * .3, sign * .12);      // lash line
    s.ball(head, HAIR, x + sign * .002, y + .029, z + .005, .024, .0048, .0055, 0, sign * .3, sign * (anissa ? .24 : .13)); // brow
    s.ball(lids, SKIN, x, y + .0135, z + .0012, .0205, .0098, .0062, 0, sign * .3, sign * .06);
    s.ball(head, SKIN_SHADE, sign * HX * .97, CY - .005, CZ - .012, .012, .027, .017);               // ear
    s.ball(head, LIP, sign * .0085, .0765, surface(0, .0765) + .008, .013, .0042, .006, 0, 0, sign * -.12);
  }
  s.ball(head, LIP, 0, .069, surface(0, .069) + .0065, .0165, .0052, .006);
  s.ball(head, SKIN_SHADE, 0, .096, surface(0, .096) + .0085, .011, .004, .006);                     // under the nose

  // Hair.
  const tail: THREE.Group[] = [];
  if (anissa) {
    // Swept straight back from a sharp hairline into a high tail that streams behind her in flight.
    s.ball(head, HAIR, 0, .166, -.03, .092, .104, .102);
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * .024;
      s.ball(head, i % 2 ? HAIR_LIGHT : HAIR, x, .232 - Math.abs(x) * .42, .012 - Math.abs(x) * .18, .017, .012, .075, .42, x * 2.6, 0);
    }
    s.ball(head, HAIR_LIGHT, 0, .215, -.118, .036, .036, .034);
    s.cyl(head, EDGE, 0, .212, -.146, .021, .014, .021, HALF + .45);
    let parent: THREE.Object3D = head, length = .1;
    for (let i = 0; i < 3; i++) {
      const link = new THREE.Group();
      link.position.set(0, i ? -length : .21, i ? 0 : -.152);
      parent.add(link); tail.push(link); parent = link;
      length = .1 - i * .012;
      s.tube(link, i % 2 ? HAIR_LIGHT : HAIR, [[.012, .02 - i * .003, .02 - i * .003], [-length * .5, .027 - i * .006, .024 - i * .005], [-length - .012, .012 - i * .003, .011 - i * .003]], { sectors: 8, rows: 2 });
    }
  } else {
    // A blunt asymmetric bob with a heavy side-swept fringe.
    s.ball(head, HAIR, 0, .158, -.02, .096, .116, .103);
    for (const sign of [-1, 1]) {
      const drop = sign < 0 ? .13 : .1;
      s.tube(head, HAIR, [[.19, .012, .05], [.12, .017, .064], [.12 - drop * .6, .016, .056, .006], [.115 - drop, .008, .028, .016]],
        { sectors: 10, rows: 2, at: [sign * .086, 0, -.014], rot: [0, 0, sign * .05] });
    }
    // The fringe sweeps from a parting on her right down across the left brow, with one lit streak.
    s.ball(head, HAIR, -.016, .204, surface(-.016, .204) - .013, .076, .04, .016, .3, -.15, -.3);
    s.ball(head, HAIR, .052, .208, surface(.052, .208) - .012, .04, .032, .014, .3, .5, .32);
    s.ball(head, HAIR_LIGHT, -.02, .214, surface(-.02, .214) - .001, .05, .006, .006, .3, -.15, -.3);
    s.ball(head, HAIR, 0, .12, -.085, .08, .09, .05);
  }

  for (const side of [0, 1] as const) {
    const sign = side === 0 ? -1 : 1;
    const arm = arms[side], forearm = forearms[side], hand = hands[side], finger = fingers[side];
    const leg = legs[side], shin = shins[side], foot = feet[side];

    // Shoulder, upper arm, elbow.
    s.ball(arm, anissa ? ARMOR : SUIT, 0, -.005, 0, .054, .054, .054);
    s.tube(arm, (angle, t) => anissa ? (t < .2 ? ARMOR : SUIT) : Math.abs(angle - sign * HALF) < .5 && t > .15 && t < .8 ? ARMOR_DARK : SUIT,
      [[.01, .048, .05], [-.07, .05, .053], [-.16, .044, .047, .003], [-.24, .038, .04], [-.285, .036, .037]], { sectors: 14, rows: 2 });
    if (!anissa) {
      // Layered pauldron with a swept fin.
      s.ball(arm, ARMOR, sign * .008, .026, 0, .06, .03, .064, 0, 0, -sign * .34);
      s.ball(arm, EDGE, sign * .014, .014, 0, .064, .008, .068, 0, 0, -sign * .34);
      s.ball(arm, ARMOR_DARK, sign * .03, -.03, 0, .034, .05, .05, 0, 0, -sign * .14);
    }
    s.ball(arm, anissa ? SUIT : BLACK, 0, -.28, -.003, .039, .041, .042);

    // Forearm and gauntlet.
    s.tube(forearm, (angle, t) => {
      if (anissa) return t > .28 ? ARMOR : SUIT;
      if (t < .14) return SUIT;
      return Math.abs(Math.abs(angle) - HALF) < .2 && t < .85 ? GLOW : t > .88 || t < .2 ? EDGE : ARMOR;
    }, [[.012, .037, .039], [-.06, .043, .046], [-.14, .039, .04], [-.215, .03, .031], [-.255, .027, .029]], { sectors: 14, rows: 2 });
    if (anissa) s.cyl(forearm, ARMOR_DARK, 0, -.075, 0, .045, .014, .047);
    else s.box(forearm, EDGE, sign * .036, -.12, -.012, .012, .15, .03, 0, 0, sign * .06);

    // Hand: palm, thumb, and four fingers on one knuckle joint so it can close into a fist.
    const GLOVE = anissa ? ARMOR : BLACK;
    s.ball(hand, GLOVE, 0, -.038, 0, .0165, .043, .034);
    s.ball(hand, GLOVE, -sign * .008, -.04, .036, .011, .028, .012, .35, 0, 0);
    if (!anissa) s.ball(hand, ARMOR, sign * .012, -.035, 0, .009, .032, .028);
    for (let i = 0; i < 4; i++) {
      const z = (i - 1.5) * .0168, reach = i === 0 || i === 3 ? .03 : .036;
      s.tube(finger, GLOVE, [[.006, .0085, .0082], [-reach, .0078, .0076], [-reach * 2, .0055, .0055]], { sectors: 6, rows: 1, at: [0, 0, z] });
    }

    // Thigh, knee, shin, boot.
    s.tube(leg, (angle, t) => {
      if (anissa) return Math.abs(angle - sign * HALF) < .42 ? ARMOR_DARK : SUIT;
      return Math.abs(angle - sign * HALF) < .5 && t > .12 ? (Math.floor(t * 12) % 2 ? ARMOR_DARK : ARMOR) : SUIT;
    }, [[.05, .07, .078], [-.04, .083, .09, -.004], [-.16, .078, .084], [-.29, .062, .067, .003], [-.4, .05, .054], [-.44, .048, .051]],
      { sectors: 16, rows: 3, bulge: (angle, _t, y) => 1 + .06 * gauss(Math.abs(angle), 0, .7) * gauss(y, -.2, .12) });
    s.ball(leg, anissa ? SUIT : ARMOR, 0, -.43, .012, .047, .05, .048);
    if (!anissa) s.ball(leg, EDGE, 0, -.425, .04, .03, .034, .018);
    s.tube(shin, (angle, t) => {
      if (anissa) return t > .22 ? ARMOR : t > .19 ? ARMOR_DARK : SUIT;
      if (t < .1) return SUIT;
      return Math.abs(angle) < .7 ? (t < .16 || t > .9 ? EDGE : ARMOR) : Math.abs(angle) > 2.6 ? ARMOR_DARK : BLACK;
    }, [[.02, .048, .051], [-.08, .054, .062, -.01], [-.2, .047, .052, -.006], [-.33, .036, .04], [-.42, .035, .041, .002]], { sectors: 14, rows: 3 });
    const BOOT = anissa ? ARMOR : BLACK;
    s.ball(foot, BOOT, 0, -.03, .012, .04, .045, .058);
    s.tube(foot, BOOT, [[-.05, .036, .03], [.02, .041, .036], [.1, .043, .028, 0], [.165, .034, .018], [.19, .012, .008]],
      { sectors: 10, rows: 2, at: [0, -.048, 0], rot: [HALF, 0, 0] });
    s.box(foot, anissa ? ARMOR_DARK : ARMOR_DARK, 0, -.074, .058, .074, .014, .245);
    if (!anissa) s.ball(foot, EDGE, 0, -.035, .12, .03, .018, .045);
  }
  s.bake();
  return { tail, capeColor: anissa ? null : { cloth: 0x1b2c3a, trim: 0x86b3bb } };
}

/** Battle Beast: a towering lion warrior with a full mane, gold armour and a flanged mace. */
export function buildBeast(rig: FighterRig) {
  const [FUR, FUR_SHADE, MANE, MANE_SHADE, GOLD, LEATHER, PANTS, CLOTH, STEEL, DARK, IVORY, EYE, TONGUE, GOLD_DARK] = Array.from({ length: 14 }, (_, i) => i);
  const s = new Sculpt(new Skin([
    { color: 0xe6dccb, rough: .9 }, { color: 0xcbbea8, rough: .92 }, { color: 0xf7f2e7, rough: .95 }, { color: 0xd8cdb9, rough: .95 },
    { color: 0xcb9a43, rough: .32, metal: .85 }, { color: 0x3d2b21, rough: .75 }, { color: 0x25242c, rough: .82 }, { color: 0x7a2a22, rough: .88 },
    { color: 0xb4bbc1, rough: .24, metal: .9 }, { color: 0x2c2422, rough: .85 }, { color: 0xf3ead3, rough: .42 }, { color: 0xffc640, rough: .3, glow: 1 },
    { color: 0x8b3434, rough: .5 }, { color: 0x8c6a2c, rough: .4, metal: .8 },
  ], .22));
  const { hips, torso, head, jaw, arms, forearms, hands, fingers, legs, shins, feet } = rig;

  // Torso: a narrow waist flaring into slab pectorals, lats and a thick neck.
  s.tube(torso, FUR, [
    [-.06, .2, .15], [.03, .205, .155], [.12, .245, .178], [.22, .31, .205, .008], [.31, .358, .212, .012], [.38, .345, .19],
    [.43, .27, .165, -.01], [.47, .16, .13, -.01], [.52, .115, .11],
  ], { sectors: 28, rows: 3, square: 2.3, bulge: (angle, _t, y) => {
    const a = Math.abs(angle);
    return 1 + .15 * gauss(a, .5, .34) * gauss(y, .3, .075)                 // pectorals
      + .05 * gauss(a, .22, .16) * (gauss(y, .17, .03) + gauss(y, .095, .03) + gauss(y, .02, .03)) // abdominals
      - .035 * gauss(a, 0, .08) * gauss(y, .2, .2)                           // sternum groove
      + .1 * gauss(a, 1.75, .4) * gauss(y, .22, .1)                          // lats
      + .06 * gauss(a, 2.6, .3) * gauss(y, .34, .08);                        // shoulder blades
  } });
  s.ball(torso, FUR_SHADE, 0, .46, -.04, .22, .09, .15); // trapezius under the mane
  // Crossed leather straps pinned by a gold medallion.
  for (const z of [.218, -.21]) for (const sign of [-1, 1]) s.box(torso, LEATHER, 0, .2, z, .07, .7, .03, 0, 0, sign * .62);
  s.cyl(torso, GOLD, 0, .2, .236, .066, .03, .066, HALF);
  s.cyl(torso, GOLD_DARK, 0, .2, .25, .036, .014, .036, HALF);
  // The mane drapes down the back and over the shoulders.
  for (let i = 0; i < 7; i++) {
    const x = (i - 3) * .08;
    s.ball(torso, i % 2 ? MANE : MANE_SHADE, x, .29, -.2 - Math.abs(x) * .1, .078, .25, .062, -.15, 0, x * .6);
  }
  for (const sign of [-1, 1]) {
    s.spike(torso, MANE, [sign * .2, .5, -.02], [sign * .5, -1, -.2], .32, .09);
    s.spike(torso, MANE_SHADE, [sign * .12, .5, .08], [sign * .25, -1, .35], .24, .075);
  }

  // Hips: belt, armoured tassets and cloth flaps that swing with his stride.
  s.tube(hips, (_a, _t, y) => y > .1 ? LEATHER : PANTS, [[.22, .2, .15], [.14, .212, .16], [.06, .24, .175], [-.02, .245, .178, -.006], [-.09, .215, .165], [-.15, .13, .12], [-.19, .03, .04]],
    { sectors: 24, rows: 3, square: 2.2 });
  s.box(hips, GOLD, 0, .14, .168, .14, .09, .03);
  s.box(hips, GOLD_DARK, 0, .14, .186, .07, .045, .012);
  for (const sign of [-1, 1]) {
    s.box(hips, GOLD, sign * .215, -.01, .04, .13, .17, .21, 0, 0, sign * .2);
    s.box(hips, GOLD_DARK, sign * .236, -.01, .04, .1, .1, .15, 0, 0, sign * .2);
  }
  const flaps: THREE.Group[] = [];
  for (const [z, width, length] of [[.172, .17, .36], [-.172, .2, .38]]) {
    const flap = new THREE.Group();
    flap.position.set(0, .07, z); hips.add(flap); flaps.push(flap);
    s.plate(flap, CLOTH, [[-width / 2, 0], [width / 2, 0], [width * .58, -length * .86], [0, -length], [-width * .58, -length * .86]], 0, .014);
    s.box(flap, GOLD, 0, -length * .8, 0, width * .7, .018, .02);
  }

  // Head: broad skull, heavy brow, projecting muzzle, and a jaw that opens to roar.
  s.ball(head, FUR, 0, .29, -.02, .155, .155, .145);
  s.ball(head, FUR_SHADE, 0, .34, .085, .152, .042, .068);                 // brow ridge
  s.tube(head, FUR, [[-.02, .1, .07], [.07, .092, .075], [.15, .068, .066], [.19, .04, .04]], { sectors: 12, rows: 2, at: [0, .225, .02], rot: [HALF - .1, 0, 0] }); // muzzle
  s.ball(head, DARK, 0, .258, .212, .042, .026, .026);                     // nose
  s.ball(head, DARK, 0, .188, .1, .07, .02, .075);                         // mouth interior
  for (const sign of [-1, 1]) {
    s.ball(head, DARK, sign * .06, .3, .117, .034, .019, .013);
    s.ball(head, EYE, sign * .06, .302, .126, .025, .0115, .01, 0, 0, -sign * .18);
    s.ball(head, FUR, sign * .052, .208, .158, .052, .04, .045);            // whisker pads
    s.spike(head, IVORY, [sign * .04, .192, .178], [0, -1, .1], .058, .012, 6, false);
    s.spike(head, FUR_SHADE, [sign * .12, .4, -.02], [sign * .5, 1, -.1], .09, .05, 5);   // ears
    for (let tooth = 0; tooth < 2; tooth++) s.spike(head, IVORY, [sign * (.012 + tooth * .014), .194, .2 - tooth * .008], [0, -1, 0], .018, .006, 5, false);
  }
  jaw.position.set(0, .19, .03);
  s.tube(jaw, FUR, [[-.03, .085, .04], [.06, .08, .042], [.13, .06, .036], [.165, .03, .02]], { sectors: 10, rows: 2, at: [0, -.03, 0], rot: [HALF - .05, 0, 0] });
  s.ball(jaw, TONGUE, 0, -.012, .08, .04, .012, .07);
  s.ball(jaw, FUR, 0, -.055, .06, .06, .035, .06);                          // chin tuft
  for (const sign of [-1, 1]) s.spike(jaw, IVORY, [sign * .042, -.008, .135], [0, 1, 0], .04, .01, 6, false);
  // Mane: layered rings of tufts sweep back and down around the face, over a solid core.
  s.ball(head, MANE_SHADE, 0, .24, -.12, .3, .32, .22);
  s.ball(head, MANE, 0, .4, -.05, .17, .08, .15);
  for (let ring = 0; ring < 4; ring++) {
    const count = 13 + ring * 3, radius = .16 + ring * .045, length = .26 + ring * .07, width = .1 + ring * .02;
    for (let i = 0; i < count; i++) {
      const a = (i + ring * .5) / count * Math.PI * 2, ux = Math.sin(a), uy = Math.cos(a);
      s.spike(head, (i + ring) % 3 ? MANE : MANE_SHADE, [ux * radius, .27 + uy * radius * 1.05, -.04 - ring * .05],
        [ux, uy * .7 - .45 - ring * .18, -.18 - ring * .08], length * (.9 + (i * 7 % 5) * .05), width);
    }
  }

  const weapon = new THREE.Group();
  for (const side of [0, 1] as const) {
    const sign = side === 0 ? -1 : 1;
    const arm = arms[side], forearm = forearms[side], hand = hands[side], finger = fingers[side];
    const leg = legs[side], shin = shins[side], foot = feet[side];

    // Deltoid under a spiked gold pauldron, then a heavy biceps and triceps.
    s.ball(arm, FUR, 0, -.01, 0, .13, .125, .13);
    s.ball(arm, GOLD, sign * .02, .035, 0, .17, .115, .17, 0, 0, -sign * .22);
    s.ball(arm, GOLD_DARK, sign * .025, .012, 0, .178, .03, .178, 0, 0, -sign * .22);
    for (let i = 0; i < 3; i++) s.spike(arm, IVORY, [sign * (.06 + i * .03), .1 - i * .025, (i - 1) * .07], [sign * (.5 + i * .25), 1 - i * .25, (i - 1) * .35], .1, .026, 6, false);
    s.tube(arm, FUR, [[.01, .1, .105], [-.08, .118, .125], [-.19, .11, .118, .006], [-.28, .09, .095], [-.345, .082, .086]],
      { sectors: 16, rows: 3, bulge: (angle, _t, y) => 1 + .14 * gauss(Math.abs(angle), 0, .7) * gauss(y, -.16, .07) + .1 * gauss(Math.abs(angle), Math.PI, .7) * gauss(y, -.12, .08) });
    s.cyl(arm, LEATHER, 0, -.07, 0, .127, .03, .132);
    s.ball(arm, FUR_SHADE, 0, -.34, -.01, .086, .088, .09);

    s.tube(forearm, (_a, t) => t > .3 && t < .82 ? GOLD : t > .26 && t < .86 ? GOLD_DARK : FUR,
      [[.015, .086, .09], [-.07, .108, .11], [-.17, .098, .1], [-.26, .08, .082], [-.305, .075, .078]], { sectors: 16, rows: 3 });
    for (let i = 0; i < 3; i++) s.spike(forearm, IVORY, [sign * .09, -.1 - i * .055, -.02], [sign, .25, -.35], .06, .018, 6, false);

    s.ball(hand, FUR, 0, -.05, 0, .06, .075, .085);
    s.ball(hand, FUR_SHADE, -sign * .02, -.055, .075, .032, .05, .034, .4);
    finger.position.y = -.1;
    for (let i = 0; i < 4; i++) {
      const z = (i - 1.5) * .04;
      s.tube(finger, FUR, [[.012, .024, .022], [-.05, .022, .02], [-.09, .014, .014]], { sectors: 6, rows: 1, at: [0, 0, z] });
      s.spike(finger, IVORY, [0, -.085, z], [-sign * .25, -1, 0], .045, .011, 6, false);
    }

    s.tube(leg, PANTS, [[.06, .125, .14], [-.05, .15, .16, -.004], [-.18, .135, .145], [-.3, .105, .11, .006], [-.41, .09, .095]],
      { sectors: 16, rows: 3, bulge: (angle, _t, y) => 1 + .08 * gauss(Math.abs(angle), 0, .8) * gauss(y, -.2, .1) });
    s.ball(leg, GOLD, 0, -.4, .06, .085, .075, .06);
    s.spike(leg, IVORY, [0, -.39, .1], [0, .35, 1], .06, .022, 6, false);
    s.tube(shin, (_a, t) => t > .2 && t < .78 ? GOLD : t > .16 && t < .82 ? GOLD_DARK : FUR,
      [[.02, .09, .095], [-.09, .102, .118, -.02], [-.2, .09, .1, -.014], [-.3, .072, .078], [-.375, .07, .076]], { sectors: 16, rows: 3 });
    s.ball(foot, FUR, 0, -.02, 0, .08, .06, .09);
    s.tube(foot, FUR, [[-.08, .075, .04], [.02, .09, .05], [.14, .1, .042], [.22, .085, .03], [.25, .03, .015]], { sectors: 12, rows: 2, at: [0, -.038, 0], rot: [HALF, 0, 0] });
    for (let c = 0; c < 3; c++) {
      s.ball(foot, FUR_SHADE, (c - 1) * .055, -.045, .2, .03, .028, .05);
      s.spike(foot, IVORY, [(c - 1) * .055, -.05, .235], [0, -.3, 1], .055, .014, 6, false);
    }
  }

  // The mace rides in the right fist, held across the body so a swing of the arm swings the head through its target.
  weapon.position.set(0, -.085, .01); weapon.rotation.set(1.9, 0, 0); weapon.scale.setScalar(.88); hands[1].add(weapon);
  s.cyl(weapon, LEATHER, 0, .3, 0, .034, 1.1, .034);
  for (const y of [-.2, -.02, .62]) s.cyl(weapon, GOLD, 0, y, 0, .046, .04, .046);
  s.ball(weapon, GOLD_DARK, 0, -.27, 0, .05, .05, .05);
  s.shape(weapon, new THREE.SphereGeometry(1, 12, 8), STEEL, 0, .9, 0, .15, .2, .15, 0, 0, 0, true);
  s.cyl(weapon, GOLD, 0, .72, 0, .062, .09, .062);
  for (let i = 0; i < 6; i++) s.box(weapon, STEEL, 0, .9, 0, .04, .36, .44, 0, i * Math.PI / 3, 0);
  s.spike(weapon, STEEL, [0, 1.07, 0], [0, 1, 0], .16, .04, 6);
  s.bake();
  return { flaps, weapon };
}
