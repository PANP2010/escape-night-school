import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../client/src/game.ts';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { campusDoorSlab } from '../../shared/doors.ts';

const door = { id: 0, x: 0, z: 0, alongX: true, y0: 0, y1: 3,
  box: { x0: -.5, x1: .5, z0: -.1, z1: .1 } };
let now = 1000;
const fixture = () => Object.assign(Object.create(Game.prototype), {
  doors: [door], doorOpen: [false], doorLocked: [false], doorSwing: [0], doorDir: [1], doorPreview: new Map(),
  body: { y: 0 }, pos: { x: 0, z: -1 }, regionLocked: () => false, spawnSynced: true,
  knobMesh: { instanceMatrix: {} }, doorMesh: { instanceMatrix: {} },
  campus: { collision: new CollisionWorld([campusDoorSlab(door, false)]) }, campusDoorBox: [0], mirrorDoorBoxes: new Map(),
  placeLeaf: vi.fn(), doorSound: vi.fn(), refreshDoors: vi.fn(),
}) as any;
beforeEach(() => { now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now); });
afterEach(() => vi.restoreAllMocks());

describe('bounded door anticipation with authoritative collision', () => {
  it('moves the leaf before a reply while keeping the actual door state and slab closed', () => {
    const g = fixture(); g.previewDoor(0, now);
    for (let i = 0; i < 20; i++) g.animateDoors(.016);
    expect(g.doorSwing[0]).toBe(.45);
    expect(g.doorOpen[0]).toBe(false);
    expect(g.campus.collision.boxes[0].maxY).toBe(3);
    g.onMsg({ t: 'doors', doors: [{ id: 0, open: true, locked: false }] });
    expect(g.doorPreview.size).toBe(0);
    g.animateDoors(.02);
    expect(g.doorSwing[0]).toBe(.5);
    expect(g.campus.collision.boxes[0].maxY).toBe(-100);
    expect(g.doorSound).toHaveBeenCalledExactlyOnceWith(door, true);
  });

  it('rolls back a rejected or missing reply and clears the pending prompt', () => {
    const g = fixture(); g.previewDoor(0, now); g.animateDoors(.1);
    g.pendingFeedback = { kind: 'use', id: 0, until: 2500 };
    g.onMsg({ t: 'doors', doors: [{ id: 0, open: false, locked: true }] });
    g.animateDoors(.1);
    expect(g.doorSwing[0]).toBe(0);
    expect(g.pendingFeedback).toBeUndefined();
    g.doorLocked[0] = false; g.previewDoor(0, now); g.animateDoors(.1);
    now += 651; g.animateDoors(.1);
    expect(g.doorSwing[0]).toBe(0);
    expect(g.doorPreview.size).toBe(0);
    expect(g.campus.collision.boxes[0].maxY).toBe(3);
  });

  it.each([
    { doorLocked: [true] }, { regionLocked: () => true }, { body: { y: 3.6 } },
    { pos: { x: 0, z: -4 } }, { doorOpen: [true] },
  ])('does not anticipate a locked, foreign-floor, distant or already open door: %j', state => {
    const g = Object.assign(fixture(), state); g.previewDoor(0, now);
    expect(g.doorPreview.size).toBe(0);
  });

  it('restores the authoritative leaf immediately when the attempt is discarded', () => {
    const g = fixture(); g.previewDoor(0, now); g.animateDoors(.1); g.clearDoorPreviews();
    expect(g.doorSwing[0]).toBe(0); expect(g.doorPreview.size).toBe(0);
    expect(g.refreshDoors).toHaveBeenCalledTimes(1);
  });
});
