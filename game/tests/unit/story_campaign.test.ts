import { describe, expect, it } from 'vitest';
import { Room } from '../../server/room.ts';
import { groundHeight, overlaps } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE, lineOfSight } from '../../shared/campus/nav.ts';
import { inBounds } from '../../shared/level.ts';
import { canReadStory } from '../../shared/story.ts';
import { storySites } from '../../shared/storySite.ts';

describe('later campaign fragments in the actual collision world', () => {
  for (const index of [2, 4, 5, 6, 7]) it(`chapter ${index + 1} has reachable readable clues and optional secrets`, () => {
    const room = new Room('NOTE', 71, undefined, index);
    const sites = storySites(index, room.level.def);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      const x = site.p[0] + site.normal[0], z = site.p[2] + site.normal[2];
      const y = groundHeight(room.world, x, z, NAV_CAPSULE.radius, site.p[1] - .8);
      const feet = { x, y, z, vy: 0, grounded: true };
      const eye = { x, y: y + 1.5, z }, point = { x: site.p[0], y: site.p[1], z: site.p[2] };
      const context = `${index + 1}:${site.id} @ ${JSON.stringify(feet)}`;
      expect(inBounds(room.level, x, y, z), context).toBe(true);
      expect(overlaps(room.world, feet, NAV_CAPSULE), context).toBe(false);
      expect(lineOfSight(room.world, eye, point), context).toBe(true);
      expect(canReadStory(site, [x, y, z], Math.atan2(site.normal[0], site.normal[2]), true), context).toBe(true);
    }
  });
});
