import * as THREE from "three";
import { Sculpt, Skin } from "./fighter-mesh";
import { HEAD_SCALE } from "./fighter-models";
import type { FighterRig, RigSpec } from "./fighter-rig";

export const GOJO_SPEC: RigSpec = {
  waist: 1.03, neck: [1.54, .005], shoulder: [.235, 1.46, 0],
  upperArm: .30, forearm: .27, hip: [.105, .94], thigh: .44, shin: .41, cape: [1.5, -.1],
};

/** Shinjuku outfit, built on the game's articulated humanoid rig. */
export function buildGojo(rig: FighterRig) {
  const [SKIN, SHADE, SHIRT, SEAM, TROUSERS, FOLD, BELT, HAIR, HAIR_SHADE, EYE, BLUE, INK] =
    Array.from({ length: 12 }, (_, index) => index);
  const s = new Sculpt(new Skin([
    { color: 0xeac4af, rough: .65 }, { color: 0xd19f8a, rough: .7 },
    { color: 0x151924, rough: .83 }, { color: 0x343b4d, rough: .82 },
    { color: 0xe6e2dc, rough: .92 }, { color: 0xb9b7bc, rough: .9 },
    { color: 0x242535, rough: .78 }, { color: 0xf0f3fb, rough: .54 }, { color: 0xb5c2da, rough: .62 },
    { color: 0xfaf8ff, rough: .32 }, { color: 0x51bfff, rough: .28, glow: .75 }, { color: 0x222638, rough: .65 },
  ], .33));
  s.tube(rig.torso, (angle, _t, y) => Math.abs(Math.abs(angle) - 1.47) < .1 && y < .32 ? SEAM : SHIRT, [
    [-.075, .148, .108], [0, .152, .106], [.12, .163, .111], [.23, .194, .128],
    [.32, .218, .127], [.40, .205, .105], [.45, .125, .077], [.48, .063, .055],
  ], { sectors: 24, rows: 3, square: 2.25 });
  s.tube(rig.torso, SHIRT, [[.465, .067, .057], [.505, .061, .051], [.536, .06, .051]], { sectors: 16, rows: 2 });
  s.tube(rig.hips, (_a, _t, y) => y > .065 ? BELT : TROUSERS, [
    [-.136, .099, .095], [-.07, .164, .121], [.015, .167, .119], [.078, .153, .11], [.142, .147, .103],
  ], { sectors: 24, rows: 3 });
  s.ball(rig.hips, BELT, .026, .087, .112, .049, .021, .018, 0, 0, -.24);
  s.ball(rig.hips, BELT, -.028, .055, .107, .019, .06, .011, .08, 0, -.3);

  const head = new THREE.Group();
  head.scale.setScalar(HEAD_SCALE * 1.04);
  rig.head.add(head); head.add(rig.lids);
  s.ball(head, SKIN, 0, .127, .004, .085, .107, .087);
  s.ball(head, SKIN, 0, .09, .025, .068, .064, .064);
  s.ball(head, SKIN, 0, .113, .093, .012, .025, .014, -.15);
  s.ball(head, SHADE, 0, .075, .084, .019, .003, .005, 0, 0, .08);
  s.ball(head, HAIR_SHADE, 0, .172, -.014, .091, .087, .087);
  s.ball(head, HAIR, 0, .207, -.014, .085, .062, .087);
  for (const side of [-1, 1]) {
    const x = side * .034;
    s.ball(head, SHADE, side * .081, .129, -.007, .011, .021, .013);
    s.ball(head, INK, x, .147, .083, .021, .009, .007, 0, side * .22, side * .10);
    s.ball(head, EYE, x, .1455, .087, .019, .0074, .006, 0, side * .22, side * .09);
    s.ball(head, BLUE, x, .145, .093, .0084, .008, .003);
    s.ball(head, INK, x, .145, .095, .0033, .0045, .002);
    s.ball(head, EYE, x - .0025, .148, .096, .002, .002, .001);
    s.ball(head, HAIR_SHADE, x, .165, .084, .021, .004, .003, 0, side * .21, side * .16);
    s.ball(rig.lids, SKIN, x, .158, .084, .02, .008, .006, 0, side * .22, side * .09);
    for (let row = 0; row < 3; row++) {
      for (let strand = 0; strand < 3; strand++) {
        const offset = .023 + strand * .025;
        s.spike(head, (row + strand) % 3 === 1 ? HAIR_SHADE : HAIR,
          [side * offset, .237 - strand * .016, .052 - row * .052],
          [side * (.32 + strand * .46), 1, .25 - row * .56],
          .126 - strand * .019 + row * .005, .032, 5, true, .019);
      }
    }
    s.spike(head, HAIR, [side * .037, .232, .059], [side * .62, -.83, .64], .075, .032, 5, true, .016);
    s.spike(head, HAIR, [side * .067, .208, .046], [side * .65, -.9, .22], .066, .027, 5, true, .015);
  }
  s.spike(head, HAIR, [0, .244, .002], [.26, 1, -.3], .141, .039, 5, true, .023);

  for (const side of [0, 1] as const) {
    const { arms, forearms, hands, fingers, legs, shins, feet } = rig;
    s.tube(arms[side], (_a, _t, y) => y < -.084 && y > -.109 ? SEAM : y <= -.109 ? SKIN : SHIRT, [
      [.035, .051, .056], [-.032, .067, .071], [-.11, .062, .064], [-.21, .052, .057], [-.30, .045, .048],
    ], { sectors: 16, rows: 4 });
    s.ball(arms[side], SKIN, 0, -.288, 0, .045, .043, .046);
    s.tube(forearms[side], SKIN, [[.015, .043, .047], [-.06, .047, .049], [-.15, .039, .041], [-.27, .029, .033]],
      { sectors: 14, rows: 3 });
    s.ball(hands[side], SKIN, 0, -.036, 0, .019, .048, .034);
    s.ball(hands[side], SKIN, side ? -.009 : .009, -.035, .030, .011, .027, .011, .38);
    for (let digit = 0; digit < 4; digit++)
      s.ball(fingers[side], SKIN, 0, -.025, (digit - 1.5) * .016, .008, .032 - Math.abs(digit - 1.5) * .004, .008);
    const cloth = (angle: number, _t: number, y: number) => Math.cos(angle * 5 + y * 12 + side) > .82 ? FOLD : TROUSERS;
    s.tube(legs[side], cloth, [[.052, .085, .095], [-.06, .105, .113], [-.20, .109, .112], [-.32, .096, .104], [-.45, .078, .083]],
      { sectors: 20, rows: 3 });
    s.ball(legs[side], TROUSERS, 0, -.421, 0, .077, .066, .082);
    s.tube(shins[side], cloth, [[.03, .078, .079], [-.10, .086, .088], [-.23, .081, .083], [-.35, .069, .075], [-.415, .044, .052]],
      { sectors: 18, rows: 4 });
    s.ball(feet[side], SHIRT, 0, -.035, .04, .046, .036, .109);
    s.box(feet[side], INK, 0, -.070, .048, .095, .022, .225);
  }
  s.bake();
}
