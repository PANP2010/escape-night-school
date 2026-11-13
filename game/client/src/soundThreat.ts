import { jasmineIntensity } from './fx.ts';

/** A rendered mob's animation names follow its server AI: 角色074 uses `chase`, 值日生 uses `run`. */
interface ThreatMob { monitor: boolean; anim: string }

/** Raise the existing threat layer only while a chasing mob is strictly within 15 metres. */
export function isNearbyChase(mob: ThreatMob, distance: number): boolean {
  return distance < 15 && (mob.monitor ? mob.anim === 'run' : mob.anim === 'chase');
}

/** A pursuit uses its own distance; nearby patrolling 角色074 retains only the quiet ambient layer. */
export function soundThreat(wardenDistance: number, chaseDistance: number): number {
  return Math.max(jasmineIntensity(wardenDistance) * 0.35, jasmineIntensity(chaseDistance));
}
