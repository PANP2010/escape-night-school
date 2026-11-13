import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LobbyDifficulty } from '../../client/src/lobbyDifficulty.ts';
import { ProgressionStore } from '../../client/src/progression.ts';

let saved: Map<string, string>;
beforeEach(() => {
  saved = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: 'story', checked: true, disabled: false, dataset: {}, textContent: '', replaceChildren: vi.fn() });
    return elements.get(id);
  };
  vi.stubGlobal('document', { getElementById: element, createElement: () => ({}) });
  const store = new ProgressionStore(), ui = new LobbyDifficulty(store);
  return { store, ui, element };
}
const escape = [{ id: 1, escaped: true, downs: 0 }];

describe('named monitor lobby option', () => {
  it('starts disabled and unchecked and rechecks progression when code tries to change the DOM', () => {
    saved.set('escape.namedMonitors', '1');
    const { ui, element } = setup(), input = element('named-monitors');
    expect(input.disabled).toBe(true); expect(input.checked).toBe(false);
    expect(element('named-monitors-hint').textContent).toContain('完成无人生还难度后解锁');
    input.checked = true; input.disabled = false;
    expect(ui.namedMonitors).toBe(false);
    ui.dispose();
  });

  it('reacts to a real progression unlock but requires an explicit selection on every page load', () => {
    const { store, ui, element } = setup();
    for (const difficulty of ['story', 'standard', 'challenge', 'nightmare'] as const) {
      store.setRoom(difficulty, difficulty, false); store.completed(escape, 1, difficulty === 'nightmare', 'eligible');
    }
    expect(element('named-monitors').disabled).toBe(false);
    expect(ui.namedMonitors).toBe(false);
    element('named-monitors').checked = true; expect(ui.namedMonitors).toBe(true);
    ui.dispose();
    const reload = setup();
    expect(reload.store.canEnableNamedMonitors).toBe(true);
    expect(reload.element('named-monitors').disabled).toBe(false);
    expect(reload.ui.namedMonitors).toBe(false);
    reload.ui.dispose();
  });

  it('preserves the independent room or connection lock when progression notifies subscribers', () => {
    const { store, ui, element } = setup();
    const input = element('named-monitors');
    input.dataset.lobbyLocked = 'true';
    for (const difficulty of ['story', 'standard', 'challenge', 'nightmare'] as const) {
      store.setRoom(difficulty, difficulty, false); store.completed(escape, 1, difficulty === 'nightmare', 'eligible');
    }
    expect(input.dataset.unlocked).toBe('true');
    expect(input.disabled).toBe(true);
    store.record('secret-chalk');
    expect(input.disabled).toBe(true);
    input.dataset.lobbyLocked = 'false';
    store.record('secret-mirror');
    expect(input.disabled).toBe(false);
    ui.dispose();
  });
});
