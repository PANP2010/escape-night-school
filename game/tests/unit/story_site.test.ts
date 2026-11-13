import { describe, expect, it } from 'vitest';
import { storySite, storySites } from '../../shared/storySite.ts';
import { canReadStory, STORY_CHAPTERS } from '../../shared/story.ts';
import { generateLevel, LEVELS } from '../../shared/level.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { L2 } from '../../shared/levels/l2.ts';
import { L3 } from '../../shared/levels/l3.ts';
import { L4 } from '../../shared/levels/l4.ts';
import { freshLoop, loopDestination } from '../../shared/loop.ts';
import campus from '../../shared/campus/colliders.json';

describe('physical fragment anchors', () => {
  it('places the L1 entrance paper beside the native notice, inside the chained entrance', () => {
    const gate = L1.barriers.find(b => b.kind === 'grate' && b.face === 'z+')!;
    const s = storySite(0, L1)!;
    expect(s.id).toBe('gate');
    expect(s.p).toEqual([-41.199999999999996, 1.5, 63.440000000000005]);
    const noticeHalf = .62 / 2 * Math.cos(.04) + .3 / 2 * Math.sin(.04);
    expect(s.p[0] + .66 / 2).toBeLessThan((gate.x0 + gate.x1) / 2 - noticeHalf);
    expect(s.p[0] - .66 / 2).toBeGreaterThan(gate.x0);
    expect(s.normal).toEqual([0, 0, 1]);
  });

  it('keeps L2 at the fuse box and L3 clear of the complete native chalk board edges', () => {
    const power = storySite(1, L2)!;
    expect(power.id).toBe('repair');
    expect(power.p[0]).toBeCloseTo(39.28, 8);
    expect(power.p[1]).toBeCloseTo(5.1, 8);
    expect(power.p[2]).toBeCloseTo(85.52, 8);
    const chalk = storySite(2, L3)!;
    expect(chalk.id).toBe('chalk');
    expect(chalk.tone).toBe('chalk');
    expect(L3.loop!.clue.x - 2.4 / 2 - (chalk.p[0] + .66 / 2)).toBeCloseTo(.12, 8);
  });

  it('keeps the L3 end note and its reading stance outside the unsolved loop seam', () => {
    const site = storySites(2, L3).find(s => s.id === 'margin')!;
    const halfWidth = .66 / 2;
    expect(site.p[0]).toBeCloseTo(20.9, 8);
    expect(site.p[0] - halfWidth).toBeGreaterThan(L3.loop!.endX);
    const feet: [number, number, number] = [site.p[0], L3.exit.y, site.p[2] - 1.5];
    expect(loopDestination(L3, freshLoop(), feet, feet)).toBeNull();
    expect(canReadStory(site, feet, Math.PI, true)).toBe(true);
    // The complete page is supported by the corridor's actual back wall.
    const wall = campus.colliders.find(b => b.minX < site.p[0] - halfWidth && b.maxX > site.p[0] + halfWidth
      && b.minY < site.p[1] - halfWidth && b.maxY > site.p[1] + halfWidth
      && b.minZ > site.p[2] && b.minZ - site.p[2] < .2);
    expect(wall).toBeDefined();
    // The native projecting sign is at x=20; its plates remain separate from this page.
    const sign = L3.landmarks.find(m => m.kind === 'sign')!;
    expect(site.p[0] - halfWidth).toBeGreaterThan(sign.x + .006);
  });

  it('separates L4 writing by floor and keeps the keypad and password stickers intact', () => {
    const sites = storySites(3, L4);
    const duty = sites.find(s => s.id === 'duty')!, silence = sites.find(s => s.id === 'silence')!, stairs = sites.find(s => s.id === 'stairs')!;
    expect(duty.p[1]).toBeCloseTo(12.3, 8);
    expect(stairs.p[1]).toBeCloseTo(8.7, 8);
    // The complete chalk fragment needs a real wall, rather than hanging in the adjacent doorway.
    const chalkHalf = .66 / 2;
    const wall = campus.colliders.find(b => b.minX < stairs.p[0] - chalkHalf && b.maxX > stairs.p[0] + chalkHalf
      && b.minY < stairs.p[1] - .66 / 2 && b.maxY > stairs.p[1] + .66 / 2
      && b.maxZ < stairs.p[2] && stairs.p[2] - b.maxZ < .2);
    expect(wall).toBeDefined();
    for (const door of campus.doors) {
      if (door.alongX && door.y0 < stairs.p[1] && door.y1 > stairs.p[1] && Math.abs(door.z - stairs.p[2]) < .3) {
        expect(stairs.p[0] + chalkHalf <= door.box.x0 || stairs.p[0] - chalkHalf >= door.box.x1).toBe(true);
      }
    }
    const console = L4.broadcast!.console;
    expect(silence.p[0]).toBeCloseTo(console.x - 1.1, 8);
    expect(silence.p[2]).toBeCloseTo(131.42, 8);
    expect(silence.normal).toEqual([0, 0, 1]);
    expect(silence.p[0] + .58 / 2).toBeLessThan(console.x - .65 / 2);
    for (const site of sites) for (const sticker of L4.broadcast!.stickers) {
      if (Math.abs(site.p[1] - (sticker.y + 1.45)) < .5) expect(Math.hypot(site.p[0] - sticker.x, site.p[2] - sticker.z)).toBeGreaterThan(.7);
    }
  });

  it('puts workbooks on real lectern candidates instead of inventing item pickups', () => {
    for (const [level, def, item] of [[0, L1, 'stair_key'], [1, L2, 'fuse']] as const) {
      const site = storySites(level, def).find(s => s.tone === 'workbook')!;
      const spot = def.items.find(i => i.kind === item)!.spots[0];
      expect(site.surface).toBe('desk');
      expect(site.p[0]).toBeCloseTo(spot.x, 8);
      expect(site.p[1]).toBeCloseTo(spot.y + .012, 8);
      expect(site.p[2]).toBeCloseTo(spot.z + .3, 8);
      const lectern = campus.colliders.find(b => Math.abs(b.maxY - spot.y) < .001
        && b.minX <= spot.x && b.maxX >= spot.x && b.minZ <= spot.z && b.maxZ >= spot.z)!;
      expect(lectern).toBeDefined();
      // Complete rotated mesh bounds, using the real tabletop rather than its centre.
      const hx = .4 / 2 * Math.cos(.08) + .38 / 2 * Math.sin(.08);
      const hz = .4 / 2 * Math.sin(.08) + .38 / 2 * Math.cos(.08);
      expect(site.p[0] - hx).toBeGreaterThan(lectern.minX);
      expect(site.p[0] + hx).toBeLessThan(lectern.maxX);
      expect(site.p[2] - hz).toBeGreaterThan(lectern.minZ);
      expect(site.p[2] + hz).toBeLessThan(lectern.maxZ);
      expect(site.p[2] - hz - spot.z).toBeGreaterThan(.08);
    }
  });

  it('leaves level definitions untouched and keeps every current fragment in its authored area', () => {
    const before = JSON.stringify(LEVELS);
    expect(LEVELS.map((d, i) => storySites(i, d).length)).toEqual([3, 3, 3, 3, 3, 2, 3, 2]);
    LEVELS.forEach((def, level) => {
      for (const s of storySites(level, def)) {
        expect(s.p[0]).toBeGreaterThanOrEqual(def.area.x0);
        expect(s.p[0]).toBeLessThanOrEqual(def.area.x1);
        expect(s.p[2]).toBeGreaterThanOrEqual(def.area.z0);
        expect(s.p[2]).toBeLessThanOrEqual(def.area.z1);
        expect(STORY_CHAPTERS[level].fragments.map(f => f.id)).toContain(s.id);
        const feet = [s.p[0] + s.normal[0], s.p[1] - 1.5, s.p[2] + s.normal[2]];
        expect(canReadStory(s, feet, Math.atan2(s.normal[0], s.normal[2]), true)).toBe(true);
      }
    });
    expect(JSON.stringify(LEVELS)).toBe(before);
  });

  it('requires the real feature for later chapters and creates no fallback for a catalogue name alone', () => {
    for (let i = 4; i < 8; i++) {
      expect(storySites(i, { name: STORY_CHAPTERS[i].name, landmarks: L4.landmarks })).toEqual([]);
      expect(storySite(i, generateLevel(i, 71).def)).toBeDefined();
    }
    expect(storySites(1, L1)).toEqual([]);
    expect(storySites(0, { ...L1, barriers: [] })).toEqual([]);
    expect(storySites(1, { ...L2, blackout: undefined })).toEqual([]);
    expect(storySites(2, { ...L3, loop: undefined })).toEqual([]);
    expect(storySites(3, { ...L4, broadcast: undefined })).toEqual([]);
  });
});
