import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoryJournal } from '../../client/src/storyJournal.ts';
import { ACT_REACH } from '../../shared/interact.ts';
import { storySites } from '../../shared/storySite.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { L2 } from '../../shared/levels/l2.ts';
import { L5 } from '../../shared/levels/l5.ts';
import { ProgressionStore } from '../../client/src/progression.ts';
import campus from '../../shared/campus/colliders.json';

// Browser layout has separate coverage; isolate the server-pose adapter from DOM/WebGL here.
vi.mock('../../client/src/storyView.ts', () => ({
  StoryView: class {
    isOpen = false;
    onOpenChange?: (open: boolean) => void;
    onRead?: () => void;
    setVisible(visible: boolean) { if (!visible) this.toggle(false); }
    setCandidate() {}
    update() {}
    toggle(force?: boolean) { this.isOpen = force ?? !this.isOpen; this.onOpenChange?.(this.isOpen); }
    showEntry() { this.toggle(true); }
    destroy() {}
  },
}));

let journal: StoryJournal;
let lineClear: boolean;
const pose = (extra: Record<string, unknown> = {}) => ({
  t: 'snap', players: [{ id: 7, p: [0.6, 0, 1.5], yaw: 0, ...extra }],
});
beforeEach(() => {
  vi.stubGlobal('document', { body: {}, createElement: () => ({ getContext: () => null }) });
  lineClear = true;
  journal = new StoryJournal(new THREE.Scene(), 7, () => lineClear);
  journal.enter(0, 123, {
    name: '一楼·晚自习后', landmarks: [],
    barriers: [{ kind: 'grate', x0: 0, x1: 1, z0: 0, z1: 0, y: 0, face: 'z+' }],
  });
});
afterEach(() => { journal.destroy(); vi.unstubAllGlobals(); });

describe('story journal authoritative reading', () => {
  it.each([false, true])('uses the room choice namedMonitors=%s for the physical note, notebook and achievement', namedMonitors => {
    const store = new ProgressionStore();
    store.setRoom('GYM', 'story', false, true, false, namedMonitors);
    journal.receive({ t: 'room', code: 'GYM', namedMonitors });
    journal.enter(4, 123, L5);
    journal.onDiscovered = id => store.storyRead(id);
    journal.receive(pose({ p: [-95.5, 0, 46.65] }));
    expect(journal.candidateId).toBe('role_boss-signature');
    expect(journal.candidateTitle).toBe(namedMonitors ? '值周生的签名' : '值周提醒');
    expect(journal.readCandidate()).toBe(true);
    const entry = journal.state.model().entries.find(e => e.id === '4:note:role_boss-signature')!;
    expect(entry.text.includes('值周代号025')).toBe(namedMonitors);
    expect(store.achievements.includes('secret-role_boss')).toBe(namedMonitors);
    expect(journal.readCandidate()).toBe(true);
    expect(journal.state.model().entries).toHaveLength(1);
  });

  it('discards named writing and records when the next room omits the optional choice', () => {
    journal.receive({ t: 'room', code: 'NAMED', namedMonitors: true });
    journal.enter(4, 123, L5);
    journal.receive(pose({ p: [-95.5, 0, 46.65] })); journal.readCandidate();
    expect(journal.state.model().entries[0].text).toContain('值周代号025');
    journal.receive({ t: 'room', code: 'PLAIN' });
    journal.enter(4, 123, L5);
    expect(journal.state.model().entries).toEqual([]);
    journal.receive(pose({ p: [-95.5, 0, 46.65] })); journal.readCandidate();
    expect(journal.state.model().entries[0].text).not.toContain('值周代号025');
    expect(journal.candidateTitle).toBe('值周提醒');
  });

  it('accepts the real protocol omission of ST_OK and reads only after explicit activation', () => {
    journal.receive(pose());
    expect(journal.candidateId).toBe('gate');
    expect(journal.state.model().entries).toEqual([]);
    expect(journal.readCandidate()).toBe(true);
    expect(journal.state.model().entries.map((entry) => entry.id)).toEqual(['0:note:gate']);
    expect(journal.isOpen).toBe(true);
    expect(journal.readCandidate()).toBe(true);
    expect(journal.state.model().entries).toHaveLength(1);
  });

  it.each([1, 2, null, '0', -1])('rejects down, spectator and invalid states: %s', (st) => {
    journal.receive(pose({ st }));
    expect(journal.candidateId).toBeUndefined();
    expect(journal.readCandidate()).toBe(false);
    expect(journal.state.model().entries).toEqual([]);
  });

  it('rechecks current doors/LOS when a previously visible note is activated', () => {
    journal.receive(pose({ st: 0 }));
    expect(journal.candidateId).toBe('gate');
    lineClear = false;
    expect(journal.readCandidate()).toBe(false);
    expect(journal.state.model().entries).toEqual([]);
    lineClear = true;
    expect(journal.readCandidate()).toBe(true);
  });

  it('rejects missing own snapshots, distant positions, nonfinite values and facing away', () => {
    for (const message of [
      { t: 'snap', players: [] }, pose({ p: [0.6, 0, 8] }),
      pose({ p: [NaN, 0, 1.5] }), pose({ yaw: Infinity }), pose({ yaw: Math.PI }),
    ]) {
      journal.receive(message);
      expect(journal.candidateId).toBeUndefined();
      expect(journal.readCandidate()).toBe(false);
    }
  });

  it('uses the same two metre reach as physical object interactions', () => {
    journal.receive(pose({ p: [0.6, 0, 0.1 + ACT_REACH] }));
    expect(journal.candidateId).toBe('gate');
    journal.receive(pose({ p: [0.6, 0, 0.11 + ACT_REACH] }));
    expect(journal.readCandidate()).toBe(false);
  });

  it.each([
    { t: 'correct', p: [10, 0, 10] }, { t: 'caught' }, { t: 'warp', id: 7, p: [10, 0, 10] },
    { t: 'fade', restart: true }, { t: 'fade', restart: false }, { t: 'complete', level: 0 },
  ])('discards a pre-move snapshot until authority provides a new pose: %j', (message) => {
    journal.receive(pose());
    expect(journal.candidateId).toBe('gate');
    journal.receive(message);
    journal.setVisible(true);
    expect(journal.candidateId).toBeUndefined();
    expect(journal.readCandidate()).toBe(false);
    journal.receive(pose());
    expect(journal.candidateId).toBe('gate');
  });

  it('preserves readings on a same-seed restart, and clears them for a different room', () => {
    journal.receive({ t: 'room', code: 'AB12' });
    journal.receive(pose());
    journal.readCandidate();
    journal.receive({ t: 'fade', restart: true });
    expect(journal.isOpen).toBe(false);
    journal.enter(0, 123, { name: L1.name, landmarks: [] });
    expect(journal.state.model().entries.map(e => e.id)).toEqual(['0:note:gate']);
    journal.receive({ t: 'room', code: 'CD34' });
    journal.enter(0, 123, L1);
    expect(journal.state.model().entries).toEqual([]);
    expect(journal.candidateId).toBeUndefined();
  });

  it('keeps ordinary interactions and overlays in control of availability', () => {
    journal.receive(pose());
    journal.setAvailable(false);
    expect(journal.readCandidate()).toBe(false);
    journal.setAvailable(true);
    expect(journal.candidateId).toBe('gate');
    journal.setVisible(false);
    expect(journal.readCandidate()).toBe(false);
    journal.toggle(true);
    expect(journal.isOpen).toBe(false);
    journal.setVisible(true);
    expect(journal.readCandidate()).toBe(true);
  });

  it('does not retain a candidate after changing level or disconnecting', () => {
    journal.receive(pose());
    journal.enter(1, 456, { name: '二楼·停电', landmarks: [] });
    expect(journal.candidateId).toBeUndefined();
    expect(journal.readCandidate()).toBe(false);
    journal.destroy();
    journal.receive(pose());
    expect(journal.readCandidate()).toBe(false);
  });

  it('keeps the complete rendered workbook inside both audited lectern tabletops', () => {
    const context = new Proxy({ measureText: (text: string) => ({ width: text.length * 24 }) }, {
      get: (target, key) => Reflect.get(target, key) ?? (() => {}),
    });
    vi.stubGlobal('document', { body: {}, createElement: () => ({ getContext: () => context }) });
    for (const [level, def, kind] of [[0, L1, 'stair_key'], [1, L2, 'fuse']] as const) {
      journal.destroy();
      const scene = new THREE.Scene();
      journal = new StoryJournal(scene, 7, () => true);
      journal.enter(level, 123, def);
      const site = storySites(level, def).find(s => s.tone === 'workbook')!;
      const mesh = scene.getObjectByName(`story-fragment:${site.id}`)!;
      const bounds = new THREE.Box3().setFromObject(mesh);
      const spot = def.items.find(item => item.kind === kind)!.spots[0];
      const lectern = campus.colliders.find(b => Math.abs(b.maxY - spot.y) < .001
        && b.minX <= spot.x && b.maxX >= spot.x && b.minZ <= spot.z && b.maxZ >= spot.z)!;
      expect(bounds.max.y - bounds.min.y).toBeLessThan(.001);
      expect(bounds.min.y).toBeGreaterThan(lectern.maxY);
      expect(bounds.min.x).toBeGreaterThan(lectern.minX);
      expect(bounds.max.x).toBeLessThan(lectern.maxX);
      expect(bounds.min.z).toBeGreaterThan(lectern.minZ);
      expect(bounds.max.z).toBeLessThan(lectern.maxZ);
      expect(bounds.min.z - spot.z).toBeGreaterThan(.08);
    }
  });
});
