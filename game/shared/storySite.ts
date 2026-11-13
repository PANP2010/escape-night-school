import { roomStoryFragment, storyChapter, type StoryNoteSite, type StorySite } from './story.ts';

interface Landmark { kind: string; x: number; y: number; z: number; dir: 'x+' | 'x-' | 'z+' | 'z-' }
/** Structural subset: no renderer, level registry, puzzle or server dependency. */
export interface StoryEnvironment {
  name: string;
  landmarks: readonly Landmark[];
  barriers?: readonly { kind: string; x0: number; x1: number; z0: number; z1: number; y: number; face: Landmark['dir'] }[];
  items?: readonly { kind: string; spots: readonly { x: number; y: number; z: number }[] }[];
  blackout?: { fuseBox: { x: number; y: number; z: number } };
  loop?: { clue: { x: number; y: number; z: number } };
  broadcast?: { console: { x: number; y: number; z: number } };
  gym?: { switches: readonly { x: number; y: number; z: number }[] };
  exam?: { paper: { x: number; y: number; z: number } };
  mirror?: boolean;
  finale?: { rollcall: { x: number; y: number; z: number }; gate?: { x: number; y: number; z: number } };
}

const NORMAL = { 'x+': [1, 0, 0], 'x-': [-1, 0, 0], 'z+': [0, 0, 1], 'z-': [0, 0, -1] } as const;

/** Fragments belong to the chapter's actual features; a catalogue name alone never creates an anchor. */
export function storySites(level: number, def: StoryEnvironment, namedMonitors = false): StoryNoteSite[] {
  const c = storyChapter(level, def.name);
  if (!c) return [];
  const sites: StoryNoteSite[] = [];
  const add = (id: string, p: StorySite['p'], normal: StorySite['normal'], surface: 'wall' | 'desk' = 'wall') => {
    const fragment = c.fragments.find(f => f.id === id);
    if (fragment) sites.push({ ...roomStoryFragment(fragment, namedMonitors), p, normal, surface });
  };
  const sign = (id: string, pick: (m: Landmark) => boolean = () => true, along = 0.9) => {
    const m = def.landmarks.find(m => m.kind === 'sign' && pick(m));
    if (!m) return;
    const n = NORMAL[m.dir];
    // Leave the authored sign intact, on the adjacent wall and 0.1m in front.
    add(id, [m.x + n[0] * 0.1 + n[2] * along, m.y + 1.5, m.z + n[2] * 0.1 - n[0] * along], [...n]);
  };
  const workbook = (id: string, item: string) => {
    const b = def.items?.find(i => i.kind === item)?.spots[0];
    // These audited lecterns are 0.55m along world x and 1.2m along z. A 0.40x0.38m
    // workbook fits at this offset and stays clear of the central item spawn.
    if (b) add(id, [b.x, b.y + 0.012, b.z + 0.3], [0, 0, 1], 'desk');
  };
  if (level === 0) {
    const gate = def.barriers?.find(b => b.kind === 'grate' && b.face === 'z+');
    if (!gate) return [];
    add('gate', [gate.x0 + 0.6, gate.y + 1.5, gate.z1 + 0.1], [0, 0, 1]);
    workbook('route', 'stair_key'); sign('scent');
  }
  if (level === 1 && def.blackout) {
    const b = def.blackout.fuseBox;
    add('repair', [b.x - 0.72, b.y + 1.5, b.z - 0.08], [0, 0, -1]);
    workbook('circuit', 'fuse'); sign('red-light');
  }
  if (level === 2 && def.loop) {
    const b = def.loop.clue;
    // Native chalk board = 2.4m wide; a 0.66m fragment leaves 0.12m between complete edges.
    add('chalk', [b.x - 1.65, b.y + 1.5, b.z - 0.08], [0, 0, -1]);
    add('chalk-cat', [b.x + 1.65, b.y + 1.35, b.z - 0.08], [0, 0, -1]);
    // The west side lies behind loop.endX (19.5): approaching it would warp an unsolved player.
    // Use the same sign's east wall segment so its whole page and a frontal reading stance stay clear.
    sign('margin', () => true, -0.9);
  }
  if (level === 3 && def.broadcast) {
    sign('duty', m => Math.abs(m.y - def.broadcast!.console.y) < 0.5);
    const b = def.broadcast.console;
    // Use the actual room-side wall west of the console, facing into the room.
    // Its east side is boxed in by a wall and fixed open leaf; it has no standing space.
    add('silence', [b.x - 1.1, b.y + 1.3, b.z - 0.68], [0, 0, 1]);
    // The default east offset lands inside the real 3F door aperture (-16.95..-15.95).
    // The west wall segment (-18.15..-16.95) supports the full 0.66m chalk fragment.
    sign('stairs', m => m.y < def.broadcast!.console.y - 1, -0.75);
  }
  if (level === 4 && def.gym) {
    add('lights', [-98, 1.535, 45.45], [0, 0, 1]);
    add('timing', [-117.3, 1.5, 49], [1, 0, 0]);
    add('role_boss-signature', [-95.5, 1.4, 45.45], [0, 0, 1]);
  }
  if (level === 5 && def.exam) {
    const floor = def.exam.paper.y - 1.15;
    add('exam', [-56.72, floor + 1.5, 76.3], [1, 0, 0]);
    add('check', [-56.72, floor + 5.1, 76.4], [1, 0, 0]);
  }
  if (level === 6 && def.mirror) {
    add('gap', [-82.17, 1.45, 145.1], [1, 0, 0]);
    add('reflection', [-82.17, 5.05, 145.1], [1, 0, 0]);
    add('mirror-wink', [-82.17, 1.45, 143.1], [1, 0, 0]);
  }
  if (level === 7 && def.finale) {
    add('rollcall', [-29.5, 1.5, 125.4], [0, 0, 1]);
    add('gate-out', [-2.85, 1.3, -5.7], [0, 0, 1]);
  }
  return sites;
}

/** Compatibility anchor for callers that display a single main fragment. */
export function storySite(level: number, def: StoryEnvironment): StoryNoteSite | undefined {
  return storySites(level, def)[0];
}
