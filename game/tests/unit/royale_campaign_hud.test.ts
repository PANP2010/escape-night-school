import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../../client/src/game.ts';
import { IdleHint } from '../../client/src/objective.ts';
import { L1 } from '../../shared/levels/l1.ts';
import type { WorldItem } from '../../shared/protocol.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { walk } from '../../shared/campus/nav.ts';
import { levelSolids } from '../../shared/level.ts';

// Keep the real mode transition and campaign handlers, without creating a WebGL renderer or a zone DOM tree.
vi.mock('../../client/src/royaleHud.ts', async (original) => ({
  ...await original<typeof import('../../client/src/royaleHud.ts')>(),
  ZoneHud: class { update = vi.fn(); },
}));

function element() {
  const children = new Map<string, { textContent: string; replaceChildren(): void }>();
  return {
    hidden: true, textContent: '', classList: { remove: vi.fn(), toggle: vi.fn() },
    querySelector(selector: string) {
      if (!children.has(selector)) children.set(selector, { textContent: '', replaceChildren() { this.textContent = ''; } });
      return children.get(selector)!;
    },
  };
}

const zone = { phase: 0, center: [0, 100] as [number, number], radius: 145, remainingMs: 60000, alive: 2 };
const item = (id: number, kind: WorldItem['kind'], decoy = false): WorldItem => ({ id, kind, decoy, p: [0, 0, -1] });
const pick = (id: number) => ({ kind: 'pick' as const, id, min: [0, 0, 0], max: [1, 1, 1] });

function fixture() {
  const hud = new Map(['banner', 'objective', 'goal-arrow', 'keys', 'prompt'].map(id => [id, element()]));
  vi.stubGlobal('document', {
    hidden: false, body: { classList: { contains: () => false } },
    getElementById: (id: string) => hud.get(id) ?? null,
    querySelector: () => null,
  });
  const g = Object.assign(Object.create(Game.prototype), {
    ...inactiveGameCollaborators(),
    myId: 1, level: { index: 0, seed: 42, def: L1 }, loopPlayers: new Map(),
    input: { enabled: true, yaw: 0, pitch: 0 },
    body: { y: 0 },
    down: false, spectate: false, hiding: -1, spawnSynced: true,
    fadeUntil: 0, drawOn: true, completed: false, completion: null,
    idle: new IdleHint(), objCur: -1, openingBanner: false, openingTutorial: false,
    introShown: false, tutPicks: new Map(), tutFrom: { x: 0, z: 0 },
    heldKeys: [], fusesIn: 0, doorOpen: [], doorLocked: [], regionLocked: () => false,
    arrowEl: hud.get('goal-arrow'), arrowOn: true, guidance: true, arrowLast: '',
    guide: null, guideAt: 0, explored: new Set(), settings: { isOpen: false },
    promptEl: hud.get('prompt'), target: () => null, toggleMap: vi.fn(),
    net: { send: vi.fn(() => true) },
    scene: new THREE.Scene(), itemMeshes: new Map(),
    campus: { collision: new CollisionWorld([]) }, barrierObjs: [], barrierIds: [],
    itemMat: { battery: new THREE.MeshLambertMaterial() }, refreshItemHighlights: vi.fn(),
  }) as any;
  return { g, hud };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('royale campaign guidance boundary', () => {
  it('the first royale zone removes campaign barriers from both the scene and capsule collision', () => {
    const { g } = fixture();
    const solids = levelSolids(L1), collision = new CollisionWorld(solids);
    g.campus.collision = collision;
    g.barrierIds = solids.map((_, i) => i);
    const grate = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial());
    g.barrierObjs = [grate];
    g.scene.add(grate);
    const from = { x: -40, y: 0, z: 64 }, to: [number, number][] = [[-40, 62]];
    expect(walk(collision, from, to)).toBeNull();
    g.onZoneSnap(zone);
    expect(grate.parent).toBeNull();
    expect(walk(collision, from, to)).not.toBeNull();
    g.buildBarriers();
    expect(g.barrierObjs).toEqual([]);
    expect(walk(collision, from, to)).not.toBeNull();
  });
  it('the first zone discards an already displayed campaign goal and its pending opening', () => {
    const { g, hud } = fixture();
    g.bag = { drawer_key: 1, stair_key: 1, battery: 2 };
    g.heldKeys = [5];
    g.items = [item(1, 'drawer_key'), item(2, 'stair_key'), item(3, 'battery')];
    g.showBag();
    g.startObjective();
    g.guide = { goal: { x: 10, y: 0, z: 10 }, x: 10, y: 0, z: 10, dist: 100 };
    hud.get('goal-arrow')!.hidden = false;
    expect(hud.get('banner')!.hidden).toBe(false);
    expect(g.obj).toBeDefined();

    g.onZoneSnap(zone);

    expect(g.obj).toBeUndefined();
    expect(g.guide).toBeNull();
    expect(g.openingBanner).toBe(false);
    expect(g.openingTutorial).toBe(false);
    expect(g.objectiveTiming.pending).toBe(false);
    for (const id of ['banner', 'objective', 'goal-arrow']) expect(hud.get(id)!.hidden, id).toBe(true);
    expect(hud.get('keys')!.textContent).toBe('电池 ×2');
    expect(g.items.map((it: WorldItem) => it.kind)).toEqual(['battery']);
  });

  it('later inventory, zone and rendered-frame updates cannot restart campaign guidance', () => {
    const { g, hud } = fixture();
    g.onZoneSnap(zone);
    for (let n = 1; n <= 3; n++) {
      g.onMsg({ t: 'keys', keys: [5, 6] });
      g.onMsg({ t: 'bag', bag: { drawer_key: n, stair_key: n, fuse: n, battery: n } });
      g.onZoneSnap({ ...zone, remainingMs: zone.remainingMs - n * 1000 });
      g.objectiveTiming.input();
      g.refreshObjective();
      g.startObjective();
      g.tickObjective(n * 5000);
      g.tickGuide(n * 5000);
      expect(g.obj).toBeUndefined();
      expect(hud.get('keys')!.textContent).toBe(`电池 ×${n}`);
      for (const id of ['banner', 'objective', 'goal-arrow']) expect(hud.get(id)!.hidden, id).toBe(true);
    }
    expect(g.tut.start).not.toHaveBeenCalled();
    expect(g.royaleZone.remainingMs).toBe(57000);
    expect(g.zoneHud).toBeDefined();
  });

  it('ignores stale campaign pickup targets while keeping battery prompts and actions', () => {
    const { g } = fixture();
    g.royaleZone = zone;
    g.items = [item(1, 'drawer_key'), item(2, 'stair_key', true), item(3, 'battery')];
    for (const id of [1, 2, 99]) {
      expect(g.promptText(pick(id))).toBe('');
      g.interact(pick(id));
    }
    expect(g.net.send).not.toHaveBeenCalled();
    expect(g.promptText(pick(3))).toBe('E 拾取');
    g.interact(pick(3));
    expect(g.net.send).toHaveBeenCalledExactlyOnceWith({ t: 'act', kind: 'pick', id: 3 });
  });

  it('retains the L1 opening, shared key counts and drawer instructions in campaign', () => {
    const { g, hud } = fixture();
    g.items = [item(1, 'drawer_key'), item(2, 'stair_key'), item(3, 'stair_key', true)];
    g.refreshObjective();
    expect(hud.get('objective')!.querySelector('.h').textContent).toBe('目标 1/3');
    expect(hud.get('objective')!.querySelector('.g').textContent).toBe('找到抽屉钥匙');
    expect(g.promptText(pick(2))).toBe('讲台抽屉锁着，需要抽屉钥匙');
    expect(g.promptText(pick(3))).toBe('无齿仿制钥匙 · 戏剧道具，不用拿');
    g.startObjective();
    expect(hud.get('banner')!.hidden).toBe(false);
    expect(hud.get('banner')!.querySelector('.t').textContent).toBe(L1.name);
    g.onMsg({ t: 'bag', bag: { drawer_key: 1, battery: 2 } });
    expect(hud.get('keys')!.textContent).toBe('抽屉钥匙 ×1　电池 ×2');
    expect(hud.get('objective')!.querySelector('.g').textContent).toBe('打开上锁讲台抽屉，取出楼梯钥匙');
    expect(g.promptText(pick(2))).toBe('E 打开抽屉，取出楼梯钥匙');
  });
});
