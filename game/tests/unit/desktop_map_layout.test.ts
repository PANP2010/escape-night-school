import { afterEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../client/src/game.ts';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { campusMap } from '../../client/src/map.ts';

type ZoneVisibility = 'visible' | 'absent' | 'hidden' | 'no-rect' | 'display-none' | 'visibility-hidden';
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height });

// Exercise Game's actual sizing method without constructing its WebGL renderer. The panel's
// bounds follow its written canvas size, frame padding and translate(-50%, -50%) positioning.
function fixture(width: number, height: number, visibility: ZoneVisibility = 'visible') {
  const canvas = { style: { width: '', height: '' }, width: 0, height: 0 };
  const panel = {
    style: { width: '', left: '', top: '' },
    querySelector: () => canvas,
    getBoundingClientRect() {
      const w = parseFloat(this.style.width) + 24, h = parseFloat(canvas.style.height) + 72;
      return rect(parseFloat(this.style.left) - w / 2, parseFloat(this.style.top) - h / 2, w, h);
    },
  };
  const node = (bounds: ReturnType<typeof rect>) => ({
    hidden: false, display: 'block', visibility: 'visible',
    getClientRects: () => [bounds], getBoundingClientRect: () => bounds,
  });
  const zone = node(rect(width - 318, 18, 300, 82));
  zone.hidden = visibility === 'hidden';
  if (visibility === 'display-none') zone.display = 'none';
  if (visibility === 'visibility-hidden') zone.visibility = 'hidden';
  if (visibility === 'no-rect') zone.getClientRects = () => [];
  const nodes = new Map([
    ['room-code', node(rect(12, 10, 220, 28))],
    ['objective', { ...node(rect(width - 280, 18, 262, 110)), hidden: true }],
    ['battery', node(rect(width - 124, height - 86, 110, 26))],
    ['stamina', node(rect(width - 124, height - 94, 110, 3))],
  ]);
  if (visibility !== 'absent') nodes.set('zone-hud', zone);
  vi.stubGlobal('innerWidth', width); vi.stubGlobal('innerHeight', height); vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('document', { body: { classList: { contains: () => false } }, getElementById: (id: string) => nodes.get(id) ?? null });
  vi.stubGlobal('getComputedStyle', (el: typeof zone | typeof panel) => el === panel
    ? { paddingLeft: '12px', paddingRight: '12px' }
    : { display: (el as typeof zone).display, visibility: (el as typeof zone).visibility });
  const game = Object.assign(Object.create(Game.prototype), { mapEl: panel, plan: campusMap(CAMPUS) }) as {
    sizeMap(): void; mapSize: { w: number; h: number };
  };
  game.sizeMap();
  return { panel: panel.getBoundingClientRect(), canvas, zone: zone.getBoundingClientRect(), mapSize: game.mapSize };
}

afterEach(() => vi.unstubAllGlobals());

describe('desktop campus plan avoids the safe-zone HUD', () => {
  it.each([[1280, 720], [960, 540], [800, 600], [640, 400]])('keeps a 12px gap and the frame inside %i×%i', (width, height) => {
    const { panel, zone, canvas } = fixture(width, height);
    expect(panel.right).toBeLessThanOrEqual(zone.left - 12);
    expect(panel.left).toBeGreaterThanOrEqual(12);
    expect(panel.top).toBeGreaterThanOrEqual(50);
    expect(panel.bottom).toBeLessThanOrEqual(height - 12);
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
  });

  it.each<ZoneVisibility>(['hidden', 'no-rect', 'display-none', 'visibility-hidden'])('does not reserve space for a %s zone HUD', visibility => {
    const absent = fixture(640, 400, 'absent');
    const hidden = fixture(640, 400, visibility);
    expect(hidden.panel).toEqual(absent.panel);
    expect(hidden.mapSize).toEqual(absent.mapSize);
  });

  it('reduces the canvas on a narrow desktop when shifting alone cannot leave the gap', () => {
    const absent = fixture(640, 400, 'absent');
    const visible = fixture(640, 400);
    expect(visible.mapSize.w).toBeLessThan(absent.mapSize.w);
    expect(visible.mapSize.h).toBeLessThan(absent.mapSize.h);
    expect(visible.panel.right).toBeLessThanOrEqual(visible.zone.left - 12);
  });
});
