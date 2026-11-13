import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_DURATION_MS, CAPTURE_RECOVERY_MS, CapturePresentation, CaptureTimeline, captureSide,
} from '../../client/src/capturePresentation.ts';
import type { CaptureEvent } from '../../client/src/capturePresentation.ts';

const event = (seq = 1, changes: Partial<CaptureEvent> = {}): CaptureEvent => ({
  id: 7, seq, tick: 100, by: 'warden', hold: 30, at: [4, 3.6, 9], source: [4.6, 3.6, 8.8], ...changes,
});

describe('authoritative local capture timeline', () => {
  it('starts only a fresh local event, once, without deriving a catch from down snapshots', () => {
    const timeline = new CaptureTimeline(() => 7);
    expect(timeline.begin(event(1, { id: 8 }), 0)).toBe(false);
    expect(timeline.diagnostics).toMatchObject({ starts: 0, lastSeq: 0, phase: 'idle' });
    expect(timeline.begin(event(), 0)).toBe(true);
    for (let n = 0; n < 20; n++) {
      timeline.sync(true, false, n * 50);
      expect(timeline.begin(event(), n * 50)).toBe(false);
    }
    expect(timeline.diagnostics).toMatchObject({ starts: 1, lastSeq: 1, phase: 'caught', elapsed: 950 });
    expect(timeline.update(1499).phase).toBe('caught');
    expect(timeline.update(1500).phase).toBe('down');
    timeline.sync(true, false, 4000);
    expect(timeline.diagnostics.starts).toBe(1);
  });

  it('uses exactly 1.5 seconds and one continuous pressure into the low downed view', () => {
    const timeline = new CaptureTimeline(() => 7);
    timeline.begin(event(), 100);
    expect(timeline.update(100)).toMatchObject({ phase: 'caught', lowering: 0, roll: 0, shoulder: 0 });
    expect(timeline.update(100).pitch).toBeCloseTo(0);
    const values = [100, 300, 600, 900, 1200, 1499].map((t) => timeline.update(t + 100).lowering);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    const end = timeline.update(100 + CAPTURE_DURATION_MS);
    expect(end).toMatchObject({ phase: 'down', lowering: 1, pitch: 0, roll: 0, grayscale: 0.9, shoulder: 0 });
    expect(timeline.diagnostics.durationMs).toBe(1500);
  });

  it('covers the transition to the downed pose once, then reveals the contact location', () => {
    const timeline = new CaptureTimeline(() => 7);
    timeline.begin(event(), 0);
    expect(timeline.update(1000).cover).toBe(0);
    expect(timeline.update(1490).cover).toBeGreaterThan(0.99);
    expect(timeline.update(1500).cover).toBe(1);
    expect(timeline.update(1610).cover).toBeCloseTo(0.5);
    expect(timeline.update(1720).cover).toBe(0);
    timeline.sync(true, false, 1750);
    expect(timeline.update(1800).cover).toBe(0);
  });

  it('late join, debug down, and spectators never play a catch or the handoff blackout', () => {
    const timeline = new CaptureTimeline(() => 7);
    timeline.sync(true, false, 0);
    expect(timeline.update(0)).toMatchObject({ phase: 'down', lowering: 1, cover: 0, shoulder: 0 });
    expect(timeline.begin(event(), 10)).toBe(false);
    timeline.sync(false, true, 100);
    expect(timeline.update(100)).toMatchObject({ phase: 'spectate', lowering: 0, grayscale: 0, cover: 0 });
    expect(timeline.begin(event(2), 110)).toBe(false);
    timeline.sync(false, false, 200);
    expect(timeline.diagnostics).toMatchObject({ starts: 0, lastSeq: 2, phase: 'idle' });
  });

  it('retains the watermark through reset/level changes and consumes suppressed events', () => {
    const timeline = new CaptureTimeline(() => 7);
    timeline.begin(event(4), 0); timeline.reset();
    expect(timeline.begin(event(4), 50)).toBe(false);
    expect(timeline.begin(event(5), 100, 0, false)).toBe(false);
    expect(timeline.begin(event(5), 200)).toBe(false);
    expect(timeline.update(200).phase).toBe('idle');
    expect(timeline.begin(event(6), 250)).toBe(true);
    expect(timeline.diagnostics).toMatchObject({ starts: 2, lastSeq: 6 });
  });

  it('rejects detached/far/floor-mismatched threat positions and malformed events', () => {
    const cases: Partial<CaptureEvent>[] = [
      { source: [20, 3.6, 9] }, { source: [4, 7.2, 9] }, { source: [NaN, 3.6, 9] },
      { at: [4, Infinity, 9] }, { tick: -1 }, { tick: NaN }, { hold: 0 }, { hold: Infinity },
      { by: 'unknown' as CaptureEvent['by'] }, { source: undefined as unknown as CaptureEvent['source'] },
    ];
    for (const changes of cases) {
      const timeline = new CaptureTimeline(() => 7);
      expect(timeline.begin(event(1, changes), 0)).toBe(false);
      expect(timeline.diagnostics).toMatchObject({ starts: 0, phase: 'idle', lastSeq: 1 });
    }
    for (const seq of [0, -1, NaN, 1.5]) expect(new CaptureTimeline(() => 7).begin(event(seq), 0)).toBe(false);
    expect(new CaptureTimeline(() => 7).begin(event(), NaN)).toBe(false);
  });

  it('derives the shoulder side from the actual source and capture view yaw', () => {
    expect(captureSide([0, 0, 0], [1, 0, 0], 0)).toBe('right');
    expect(captureSide([0, 0, 0], [-1, 0, 0], 0)).toBe('left');
    expect(captureSide([0, 0, 0], [0, 0, -1], Math.PI / 2)).toBe('right');
    expect(captureSide([0, 0, 0], [0, 0, 1], Math.PI / 2)).toBe('left');
    const timeline = new CaptureTimeline(() => 7);
    timeline.begin(event(1, { by: 'monitor', source: [3.4, 3.6, 9] }), 0);
    expect(timeline.update(500)).toMatchObject({ side: 'left', by: 'monitor' });
    expect(timeline.update(500).roll).toBeLessThan(0);
  });

  it('recovers smoothly for 600 ms, restoring every view effect without restarting on repeated OK snaps', () => {
    const timeline = new CaptureTimeline(() => 7);
    timeline.sync(true, false, 0); timeline.sync(false, false, 1000);
    const from = timeline.update(1000);
    expect(from).toMatchObject({ phase: 'recover', lowering: 1, grayscale: 0.9 });
    timeline.sync(false, false, 1300);
    expect(timeline.update(1300).lowering).toBeCloseTo(0.5);
    const end = timeline.update(1000 + CAPTURE_RECOVERY_MS);
    expect(end).toMatchObject({ phase: 'idle', lowering: 0, pitch: 0, roll: 0, grayscale: 0, veil: 0, cover: 0, shoulder: 0 });
    expect(timeline.diagnostics.starts).toBe(0);
  });

  it('early rescue and observer authority interrupt contact instead of delaying gameplay', () => {
    const timeline = new CaptureTimeline(() => 7);
    timeline.begin(event(), 0); const before = timeline.update(600);
    timeline.sync(false, false, 600);
    expect(timeline.update(600).lowering).toBe(before.lowering);
    expect(timeline.update(1200).phase).toBe('idle');
    timeline.begin(event(2), 1300); timeline.sync(false, true, 1400);
    expect(timeline.update(1400)).toMatchObject({ phase: 'spectate', lowering: 0, pitch: 0, roll: 0, grayscale: 0, cover: 0 });
  });

  it('never rewinds or catches up with a burst after a long frame', () => {
    const timeline = new CaptureTimeline(() => 7);
    timeline.begin(event(), 0);
    const before = timeline.update(800);
    expect(timeline.update(400)).toEqual(before);
    expect(timeline.update(4000)).toMatchObject({ phase: 'down', shoulder: 0, cover: 0 });
    expect(timeline.diagnostics.starts).toBe(1);
  });

  it('reduced motion removes camera sway, shadow travel, and the peripheral pulse', () => {
    const timeline = new CaptureTimeline(() => 7, true);
    timeline.begin(event(), 0);
    for (const t of [0, 100, 500, 1000, 1400]) expect(timeline.update(t)).toMatchObject({ pitch: 0, roll: 0, reach: 1 });
    expect(timeline.update(1600).veil).toBe(0.62);
    expect(timeline.update(1800).veil).toBe(0.62);
    timeline.sync(false, false, 2000);
    expect(timeline.update(2300)).toMatchObject({ pitch: 0, roll: 0 });
  });
});

class Classes {
  readonly values = new Set<string>();
  add(...values: string[]) { values.forEach((v) => this.values.add(v)); }
  remove(...values: string[]) { values.forEach((v) => this.values.delete(v)); }
  contains(value: string) { return this.values.has(value); }
  toggle(value: string, force?: boolean) {
    const on = force ?? !this.values.has(value);
    if (on) this.values.add(value); else this.values.delete(value);
    return on;
  }
}
class Element {
  id = '';
  className = '';
  classList = new Classes();
  hidden = false;
  textContent = '';
  dataset: Record<string, string> = {};
  style = { opacity: '', transform: '' };
  readonly attributes: Record<string, string> = {};
  children: Element[] = [];
  parent?: Element;
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  append(...elements: Element[]) { for (const el of elements) { el.remove(); el.parent = this; this.children.push(el); } }
  replaceChildren(...elements: Element[]) { this.children = []; this.append(...elements); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((el) => el !== this); this.parent = undefined; }
}
class Document extends EventTarget {
  body = new Element();
  hidden = false;
  createElement() { return new Element(); }
}
class Motion extends EventTarget { matches = false; }

let doc: Document;
let media: Motion;
let time: number;
const views: CapturePresentation[] = [];
const mount = (options = {}) => { const view = new CapturePresentation(() => 7, options); views.push(view); return view; };
const root = () => doc.body.children.find((el) => el.id === 'capture-presentation')!;

beforeEach(() => {
  doc = new Document(); media = new Motion(); time = 0;
  vi.stubGlobal('document', doc); vi.stubGlobal('matchMedia', () => media);
  vi.spyOn(performance, 'now').mockImplementation(() => time);
});
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('capture foreground lifecycle', () => {
  it('uses the same named monitor for the shoulder contact presentation', () => {
    const view = mount();
    expect(view.begin(event(1, { by: 'monitor', name: '角色003' }), 0)).toBe(true);
    expect(root().children[3].textContent).toBe('角色003扣住了你的肩膀');
  });

  it('mounts pointer-free decorative nodes and exposes live phase diagnostics', () => {
    const view = mount();
    expect(root().hidden).toBe(true);
    expect(root().children.map((e) => e.className)).toEqual(['capture-veil', 'capture-edge', 'capture-cover', 'capture-status']);
    expect(view.begin(event(), 0)).toBe(true);
    expect(doc.body.classList.contains('capture-caught')).toBe(true);
    expect(root().dataset).toMatchObject({ phase: 'caught', side: 'right', by: 'warden', reduced: 'false' });
    expect(root().children[3].textContent).toContain('角色074');
    view.update(750);
    expect(view.diagnostics).toMatchObject({ starts: 1, lastSeq: 1, phase: 'caught', progress: 0.5, elapsed: 750 });
    view.update(1500);
    expect(doc.body.classList.contains('capture-caught')).toBe(false);
    expect(root().children[3].textContent).toBe('');
    expect(root().dataset.phase).toBe('down');
  });

  it('visibility loss cancels transient contact; returning never replays it', () => {
    const view = mount(); view.begin(event(), 0); time = 350;
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    expect(view.diagnostics).toMatchObject({ phase: 'down', starts: 1, lastSeq: 1 });
    expect(doc.body.classList.contains('capture-caught')).toBe(false);
    expect(view.update(350)).toMatchObject({ shoulder: 0, pitch: 0, roll: 0, cover: 0 });
    doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
    expect(view.begin(event(), 400)).toBe(false);
    view.update(500); expect(view.diagnostics.starts).toBe(1);
  });

  it('suppresses intro copy through contact, penalty, and recovery; normal and spectator views restore it', () => {
    const view = mount();
    expect(doc.body.classList.contains('capture-penalty')).toBe(false);
    view.begin(event(), 0);
    expect(doc.body.classList.contains('capture-penalty')).toBe(true);
    view.update(1500);
    expect(doc.body.classList.contains('capture-penalty')).toBe(true);
    view.sync(false, false, 2000);
    expect(doc.body.classList.contains('capture-penalty')).toBe(true);
    view.update(2600);
    expect(doc.body.classList.contains('capture-penalty')).toBe(false);
    view.sync(true, false, 2700); // A direct debug-down snapshot has the same copy priority.
    expect(doc.body.classList.contains('capture-penalty')).toBe(true);
    view.sync(false, true, 2800);
    expect(doc.body.classList.contains('capture-penalty')).toBe(false);
  });

  it('consumes caught events received while hidden and never starts audio or a timer', () => {
    const view = mount(); doc.hidden = true;
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const audio = vi.fn(); vi.stubGlobal('AudioContext', audio);
    expect(view.begin(event(), 0)).toBe(false);
    doc.hidden = false;
    expect(view.begin(event(), 100)).toBe(false);
    expect(root().hidden).toBe(true);
    expect(audio).not.toHaveBeenCalled(); expect(timeout).not.toHaveBeenCalled();
  });

  it('updates the reduced-motion preference live without changing the server penalty', () => {
    const view = mount(); view.begin(event(), 0); time = 500;
    expect(Math.abs(view.update(time).roll)).toBeGreaterThan(0);
    media.matches = true; media.dispatchEvent(new Event('change'));
    expect(view.update(time)).toMatchObject({ pitch: 0, roll: 0, reach: 1 });
    expect(view.diagnostics.reduced).toBe(true);
    expect(root().dataset.reduced).toBe('true');
    view.update(1500); expect(view.diagnostics.phase).toBe('down');
  });

  it('reset removes the overlay and keeps old capture events consumed', () => {
    const view = mount(); view.begin(event(), 0); view.update(1200); view.reset();
    expect(root().hidden).toBe(true); expect(doc.body.classList.contains('capture-caught')).toBe(false);
    expect(doc.body.classList.contains('capture-penalty')).toBe(false);
    expect(view.begin(event(), 1300)).toBe(false);
    expect(view.diagnostics).toMatchObject({ phase: 'idle', starts: 1, lastSeq: 1 });
  });

  it('disposal removes only owned DOM, listeners, and temporary body state', () => {
    const removeDocument = vi.spyOn(doc, 'removeEventListener'), removeMedia = vi.spyOn(media, 'removeEventListener');
    const view = mount(); view.begin(event(), 0); view.dispose(); view.dispose();
    expect(doc.body.children).toHaveLength(0);
    expect(doc.body.classList.contains('capture-caught')).toBe(false);
    expect(doc.body.classList.contains('capture-penalty')).toBe(false);
    expect(removeDocument).toHaveBeenCalledTimes(1); expect(removeMedia).toHaveBeenCalledTimes(1);
    expect(view.begin(event(2), 500)).toBe(false);
    expect(view.update(600)).toMatchObject({ phase: 'idle', lowering: 0, grayscale: 0 });
    expect(view.diagnostics.starts).toBe(1);
  });

  it('preserves a supplied host element on disposal', () => {
    const host = new Element(); doc.body.append(host);
    const view = mount({ root: host as unknown as HTMLElement, reducedMotion: true });
    view.begin(event(), 0); view.dispose();
    expect(doc.body.children).toEqual([host]); expect(host.hidden).toBe(true);
  });
});
