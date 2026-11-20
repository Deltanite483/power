export type HitAction = "punch" | "kick" | "uppercut" | "slam" | "smash" | "beam" | "nova" | "snatch" | "throw" | "impact" | "ram" | "shockwave" | "dismantle" | "cleave" | "shrine" | "black-flash" | "fuga" | "world-slash" | "blue" | "maximum-blue" | "red" | "purple" | "amplified-purple" | "remote-purple" | "blue-melee" | "red-melee" | "void";
export type HitTeam = "player" | "friend" | "foe" | "world";
export interface HitSource { name: string; team: HitTeam; action: HitAction }
export interface DamageHit { source: HitSource; damage: number; outcome: "hit" | "down" | "out" }
export interface CombatHit extends DamageHit { victim: {name: string; team: HitTeam} }
export const terrainHit: HitSource = {name:"Terrain",team:"world",action:"impact"};
export const playerHit = (action: HitAction): HitSource => ({name:"YOU",team:"player",action});

/** The non-sorcerer heavy hitters (you, Faora, Anissa, Battle Beast, Doomsday) deal this much more damage. */
export const POWER_DAMAGE_MULTIPLIER = 1.5;
const POWER_USERS = new Set(["YOU", "Faora-Ul", "Anissa", "Battle Beast", "Doomsday"]);
export function attackerMultiplier(source: HitSource): number {
  return POWER_USERS.has(source.name) ? POWER_DAMAGE_MULTIPLIER : 1;
}

export function bypassesDefenseStat(source: HitSource): boolean {
  return source.action === "purple" || source.action === "amplified-purple" || source.action === "remote-purple" || source.action === "void"
    || source.name === "Sukuna" && (source.action === "dismantle" || source.action === "cleave" || source.action === "shrine" || source.action === "world-slash");
}
