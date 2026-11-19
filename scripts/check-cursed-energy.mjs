import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
try {
  const { CursedEnergy, CURSED_COST } = await server.ssrLoadModule("/src/cursed-energy.ts");
  const { GojoInfinity } = await server.ssrLoadModule("/src/gojo.ts");
  const gojo = new CursedEnergy(), sukuna = new CursedEnergy();
  const regen = new CursedEnergy();
  assert(regen.spend(50));
  regen.update(1);
  assert.equal(regen.auraLevel, .54, "base recharge is four CE per second");
  const meleeCrit = () => .06;
  assert.equal(gojo.rollsBlackFlash(meleeCrit), sukuna.rollsBlackFlash(meleeCrit));
  assert(!gojo.rollsBlackFlash(meleeCrit), "Black Flash stays rare at high CE");
  assert(gojo.spend(90) && !gojo.canSpend(CURSED_COST.red));
  assert(gojo.rollsBlackFlash(meleeCrit), "low CE raises the same crit curve");
  assert(!sukuna.rollsBlackFlash(meleeCrit) && sukuna.canSpend(CURSED_COST.domain), "the reserves and rolls are independent");
  assert(!gojo.rollsBlackFlash(() => .13), "the low-CE critical chance remains capped");
  gojo.landedBlackFlash();
  assert(gojo.canSpend(CURSED_COST.rct), "a successful Black Flash pays CE back");
  const afterFlash = gojo.auraLevel;
  gojo.update(1);
  assert(Math.abs(gojo.auraLevel - afterFlash - .054) < 1e-8, "Black Flash temporarily improves energy recovery");

  assert(gojo.startRct() && !gojo.startRct(), "RCT pays CE and starts a cooldown");
  gojo.update(16);
  assert(gojo.canSpend(CURSED_COST.rct) && !gojo.startRct(), "enough CE cannot bypass the cooldown");
  gojo.update(2);
  assert(gojo.startRct());

  assert(sukuna.spend(CURSED_COST.domain));
  sukuna.openDomain();
  assert.equal(sukuna.reserveFraction, .24, "the HUD reserve stays accurate while burnout dims the aura");
  const depleted = sukuna.auraLevel;
  sukuna.update(30);
  assert.equal(sukuna.auraLevel, depleted, "domain suspends recharge");
  sukuna.closeDomain();
  sukuna.update(6.9);
  assert.equal(sukuna.auraLevel, depleted);
  assert(!sukuna.canSpend(CURSED_COST.melee) && !sukuna.rollsBlackFlash(() => 0) && !sukuna.startRct(), "burnout blocks all CE actions");
  sukuna.update(.2);
  assert(!sukuna.burnedOut && sukuna.canSpend(CURSED_COST.melee));
  assert.equal(sukuna.canSpend(CURSED_COST.domain), false, "burnout ending does not refill the reserve");

  gojo.reset();
  const infinity = new GojoInfinity(gojo);
  const before = gojo.auraLevel;
  for (let hit = 0; hit < 40; hit++) {
    assert(infinity.absorb(900, { name: "YOU", team: "player", action: "punch" }));
  }
  assert.equal(gojo.auraLevel, before, "Infinity cannot be overloaded and charges no CE per hit");
  infinity.update(1, false);
  const groundedCost = before - gojo.auraLevel;
  assert(Math.abs(groundedCost - .012) < 1e-8, "Infinity drains 1.2 CE per second on the ground");
  infinity.update(1, true);
  assert(Math.abs(before - gojo.auraLevel - groundedCost - .06) < 1e-8, "Infinity drains 6 CE per second in the air");
  assert(gojo.spend(20) && Math.abs(gojo.auraLevel - (before - groundedCost - .06 - .25)) < 1e-8, "moves remain available at a 25% surcharge");
  const beforeToggle = gojo.auraLevel;
  infinity.setActive(false);
  assert(!infinity.active && gojo.spend(20) && Math.abs(gojo.auraLevel - (beforeToggle - .2)) < 1e-8, "turning off Infinity returns to the normal cost");
  infinity.setActive(true);
  assert(infinity.active);
  assert(gojo.spendUpkeep(43) && infinity.active);
  infinity.update(1, true);
  assert(!infinity.active, "Infinity shuts off when upkeep exceeds the remaining reserve");
  gojo.update(3);
  infinity.setActive(true);
  assert(infinity.active, "Gojo can toggle Infinity back on after recharging");
  gojo.openDomain();
  assert(!infinity.active, "Infinity turns off during burnout");
  console.log("Cursed Energy: costs, independent reserves, inverse Black Flash rolls, RCT cooldown, Infinity and domain burnout passed.");
} finally {
  await server.close();
}
