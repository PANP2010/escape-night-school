import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GymView } from '../../client/src/gym.ts';
import { BALL_RADIUS, type GymSnap } from '../../shared/gym.ts';
import { L5 } from '../../shared/levels/l5.ts';

type Canvas = { width: number; height: number; lines: string[]; getContext: () => unknown };
let scene: THREE.Scene, view: GymView;
let caption: { hidden: boolean; textContent: string; remove: ReturnType<typeof vi.fn> };
const snapshot = (overrides: Partial<GymSnap> = {}): GymSnap => ({
  t: 'gym', now: 10, solo: true, until: [0, 0, 0, 0], complete: false, balls: [], trips: [], ...overrides,
});
const signs = (target = view) => target.root.children.filter((o): o is THREE.Sprite => o instanceof THREE.Sprite);
const lines = (sign: THREE.Sprite) => (sign.material.map!.image as Canvas).lines;

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement(tag: string) {
      if (tag !== 'canvas') {
        caption = { hidden: false, textContent: '', remove: vi.fn() };
        return Object.assign(caption, { style: {} });
      }
      const canvas: Canvas = { width: 0, height: 0, lines: [], getContext: () => ctx };
      const ctx = {
        fillRect() { canvas.lines = []; }, strokeRect() {},
        fillText(text: string) { canvas.lines.push(text); },
      };
      return canvas;
    },
    getElementById: () => ({ appendChild() {} }),
  });
  scene = new THREE.Scene(); view = new GymView(scene, L5.gym!);
});
afterEach(() => { if (view.root.parent) view.dispose(scene); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('GymView station feedback', () => {
  it('shows a readable station name and state from any approach while respecting walls', () => {
    expect(signs()).toHaveLength(4);
    signs().forEach((sign, i) => {
      expect(lines(sign)).toEqual([`${i + 1} · ${L5.gym!.switches[i].label}`, '待按']);
      expect(sign.material.depthTest).toBe(true);
    });
  });

  it('follows authoritative expiry and keeps completed stations visibly unlocked', () => {
    view.apply(snapshot({ until: [15, 0, 0, 0] }));
    expect(lines(signs()[0])[1]).toBe('亮 · 5.0秒');
    view.apply(snapshot({ now: 14.98, until: [15, 0, 0, 0] }));
    expect(lines(signs()[0])[1]).toBe('亮 · 0.1秒');
    view.apply(snapshot({ now: 15, until: [15, 0, 0, 0] }));
    expect(lines(signs()[0])[1]).toBe('待按');
    view.apply(snapshot({ now: 500, complete: true }));
    expect(signs().map((sign) => lines(sign)[1])).toEqual(Array(4).fill('常亮 · 已解锁'));
  });

  it('reuses canvases and skips texture uploads when a snapshot does not change displayed text', () => {
    const textures = signs().map((sign) => sign.material.map!);
    view.apply(snapshot({ until: [15, 0, 0, 0] }));
    const versions = textures.map((texture) => texture.version);
    view.apply(snapshot({ now: 10.01, until: [15, 0, 0, 0] }));
    expect(signs().map((sign) => sign.material.map)).toEqual(textures);
    expect(textures.map((texture) => texture.version)).toEqual(versions);
    view.apply(snapshot({ now: 10.1, until: [15, 0, 0, 0] }));
    expect(textures[0].version).toBeGreaterThan(versions[0]);
    expect(lines(signs()[0])[1]).toBe('亮 · 4.9秒');
  });

  it('shows the same team state, trip deadlines and unlock on separate clients', () => {
    const ownCaption = caption, peer = new GymView(scene, L5.gym!);
    try {
      const active = snapshot({ solo: false, until: [15, 14, 0, 0], trips: [{ id: 29, until: 11.5 }] });
      view.apply(active); peer.apply(active);
      expect(signs(peer).map(lines)).toEqual(signs().map(lines));
      expect(signs().map((sign) => lines(sign)[1])).toEqual(['亮 · 5.0秒', '亮 · 4.0秒', '待按', '待按']);
      expect(view.tripped(29)).toBe(true); expect(peer.tripped(29)).toBe(true);
      expect(view.tripped(30)).toBe(false); expect(peer.tripped(30)).toBe(false);
      const unlocked = snapshot({ solo: false, now: 11.5, complete: true, trips: [{ id: 29, until: 11.5 }] });
      view.apply(unlocked); peer.apply(unlocked);
      expect(signs(peer).map((sign) => lines(sign)[1])).toEqual(Array(4).fill('常亮 · 已解锁'));
      expect(view.tripped(29)).toBe(false); expect(peer.tripped(29)).toBe(false);
    } finally {
      peer.dispose(scene); caption = ownCaption;
    }
  });
});

describe('GymView basketball and captions', () => {
  it('places a spawned ball on the floor and disposes it when the server removes it', () => {
    view.apply(snapshot({ balls: [{ id: 7, p: [-100, 0.035, 60], v: [2, 0] }] }));
    const ball = view.root.children.find((o) => o.position.x === -100 && o.position.z === 60)!;
    expect(ball.position.y).toBeCloseTo(0.035 + BALL_RADIUS);
    const mesh = ball.children[0] as THREE.Mesh<THREE.SphereGeometry, THREE.Material>;
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose'), materialDispose = vi.spyOn(mesh.material, 'dispose');
    view.apply(snapshot());
    expect(ball.parent).toBeNull();
    expect(geometryDispose).toHaveBeenCalledOnce(); expect(materialDispose).toHaveBeenCalledOnce();
  });

  it('moves an existing ball toward the latest server position and rolls along both floor axes', () => {
    view.apply(snapshot({ balls: [{ id: 7, p: [-100, 0.035, 60], v: [2, 3] }] }));
    const ball = view.root.children.find((o) => o.position.x === -100 && o.position.z === 60)!;
    view.apply(snapshot({ balls: [{ id: 7, p: [-98, 0.035, 63], v: [2, 3] }] }));
    view.tick(0.1, 1000);
    expect(ball.position.x).toBeGreaterThan(-100); expect(ball.position.x).toBeLessThan(-98);
    expect(ball.position.z).toBeGreaterThan(60); expect(ball.position.z).toBeLessThan(63);
    expect(ball.position.y).toBeCloseTo(0.035 + BALL_RADIUS);
    expect(ball.rotation.x).toBeCloseTo(0.3 / BALL_RADIUS);
    expect(ball.rotation.z).toBeCloseTo(-0.2 / BALL_RADIUS);
    expect(view.root.children.filter((o) => o === ball)).toHaveLength(1);
  });

  it('keeps a trip warning visible despite roll sounds and expires it on time', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    view.say('被篮球绊倒', 1.5, 2); view.say('篮球滚动', 1.2, 1);
    expect(caption.textContent).toBe('被篮球绊倒');
    view.tick(0.016, 2_499); expect(caption.hidden).toBe(false);
    view.tick(0.016, 2_500); expect(caption.hidden).toBe(true);
    vi.mocked(performance.now).mockReturnValue(2_500);
    view.say('篮球滚动', 1.2, 1); expect(caption.textContent).toBe('篮球滚动');
  });

  it('lets an unlock announcement supersede a trip warning and protects it from roll captions', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    view.say('被篮球绊倒', 1.5, 2);
    view.say('四灯全亮 · 东门门禁已解除', 1.2, 3);
    view.say('篮球滚动', 1.2, 1);
    expect(caption.textContent).toBe('四灯全亮 · 东门门禁已解除');
    view.tick(0.016, 2_199); expect(caption.hidden).toBe(false);
    view.tick(0.016, 2_200); expect(caption.hidden).toBe(true);
  });

  it('releases station textures, scene objects and captions on level unload', () => {
    const texture = signs()[0].material.map!, dispose = vi.spyOn(texture, 'dispose');
    view.dispose(scene);
    expect(view.root.parent).toBeNull(); expect(dispose).toHaveBeenCalledOnce();
    expect(caption.remove).toHaveBeenCalledOnce();
  });

  it('clears an unloaded view and safely ignores duplicate cleanup and late events', () => {
    view.apply(snapshot({ balls: [{ id: 7, p: [-100, 0.035, 60], v: [2, 0] }], trips: [{ id: 29, until: 11.5 }] }));
    const disposes: unknown[] = [];
    view.root.traverse((object) => {
      if (object instanceof THREE.Mesh) disposes.push(vi.spyOn(object.geometry, 'dispose'));
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          disposes.push(vi.spyOn(material, 'dispose'));
          if ('map' in material && material.map) disposes.push(vi.spyOn(material.map as THREE.Texture, 'dispose'));
        }
      }
    });
    view.dispose(scene); view.dispose(scene);
    view.apply(snapshot({ balls: [{ id: 8, p: [-99, 0.035, 61], v: [2, 0] }] }));
    view.say('迟到的篮球声音'); view.tick(0.1, 1000);
    expect(view.root.children).toHaveLength(0); expect(view.root.parent).toBeNull();
    expect(view.state).toBeUndefined(); expect(view.tripped(29)).toBe(false);
    expect(caption.textContent).toBe(''); expect(caption.remove).toHaveBeenCalledOnce();
    disposes.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce());
  });
});
