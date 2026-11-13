/** Swing sign so the leaf opens away from the player's side of the door. */
export function doorSwingDir(d: { alongX: boolean; x: number; z: number }, p: { x: number; z: number }): number {
  const s = (d.alongX ? p.z - d.z : p.x - d.x) >= 0 ? 1 : -1;
  return d.alongX ? s : -s;
}
