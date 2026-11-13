import type { Vec3 } from '../../shared/protocol.ts';

/** Feet positions, in traversal order. These are authored corridor routes, never arbitrary room centres. */
export interface SightingPoint {
  id: string;
  /** Displayed level number (L1 = 1). */
  level: number;
  kind: 'crossing' | 'peek';
  path: readonly Vec3[];
  yaw?: number;
  speed?: number;
  holdSeconds?: number;
}

/**
 * A 1F's west passage continues through the south corridor into the stair lobby; no classroom door needs to open.
 * Both ends sit behind its corners. The mirrored traversal covers a team arriving from either direction.
 * Room collision, closed doors, nav connectivity and every viewer are checked again before using any route.
 */
export const L1_SIGHTING_POINTS: readonly SightingPoint[] = [
  { id: 'a1-west-crossing-south', level: 1, kind: 'crossing',
    path: [[-55.2, 0, 80], [-55.2, 0, 73.36], [-55.2, 0, 68.8]], speed: 1.4, holdSeconds: 1.2 },
  { id: 'a1-west-crossing-north', level: 1, kind: 'crossing',
    path: [[-55.2, 0, 68.8], [-55.2, 0, 73.36], [-55.2, 0, 80]], speed: 1.4, holdSeconds: 1.2 },
];
