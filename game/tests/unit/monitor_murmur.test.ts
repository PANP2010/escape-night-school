import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MONITOR_LETTER_S, MonitorMurmurLine, MonitorMurmurs, monitorMurmurLine, monitorObserved, type MurmurSource } from '../../client/src/monitorMurmur.ts';
import type { Voice } from '../../client/src/voice.ts';

afterEach(() => vi.unstubAllGlobals());
const open = () => true;
function camera() { const c = new THREE.PerspectiveCamera(75, 1.6, .1, 100); c.position.y = 1.6; c.updateMatrixWorld(); return c; }
function actor(name = '角色117', z = 3): MurmurSource {
  const mesh = new THREE.Object3D(); mesh.position.z = z;
  return { monitor: true, displayName: name, anim: 'run', mesh };
}
function fixture() {
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', win); vi.stubGlobal('document', doc);
  const el = { textContent: '', hidden: true, style: {}, dataset: {}, classList: { add: vi.fn() }, remove: vi.fn() } as unknown as HTMLElement;
  const voice = { say: vi.fn(), cancel: vi.fn(), setPreferences: vi.fn(), dispose: vi.fn() };
  const murmurs = new MonitorMurmurs(el, voice as unknown as Voice);
  const cam = camera(), source = actor(), mobs = new Map([[2, source]]);
  const step = (frames = 1, active = true, sight = open) => { for (let i = 0; i < frames; ++i) murmurs.update(.1, cam, mobs, sight, active); };
  return { win, doc, el, voice, murmurs, cam, source, mobs, step };
}

describe('值周生的原句与连续打字时钟', () => {
  it('uses the actual identity in the ordinary random line and keeps all three requested variants', () => {
    expect(monitorMurmurLine('角色117', () => 0)).toBe('角色081…………\n角色117没错…………为什么要写检讨');
    expect(monitorMurmurLine('角色117', () => .4)).toBe('角色081…………\n检讨…………必须写吗');
    expect(monitorMurmurLine('角色117', () => .99)).toBe('角色081…………\n我已经…………深刻检讨');
    for (const r of [0, .4, .99]) expect(monitorMurmurLine('角色039', () => r)).toBe('我卷在哪了…………');
    for (const name of ['角色021', '角色026']) expect(monitorMurmurLine(name)).toBe('可以可以，不赖不赖');
    expect(monitorMurmurLine('角色020')).toBe('嗯～你看看，你和我谁更糖一点？');
    expect([0, .26, .51, .99].map(r => monitorMurmurLine('角色094', () => r))).toEqual(['区完了…………', '别…………见证', '行。', '对。']);
    expect([0, .26, .51, .99].map(r => monitorMurmurLine('角色078', () => r))).toEqual(['这波看我操作。', '拿捏了。', '问题不大。', '我想角色070了…………孤独……']);
  });

  it('reveals letters slowly, preserves the first line and newline, and repeats after a quiet hold', () => {
    const line = new MonitorMurmurLine('角色117', () => .4);
    for (let t = 0; t < MONITOR_LETTER_S - .05; t += .05) line.step(.05);
    expect(line.text).toBe('');
    line.step(.05); expect(line.text).toBe(monitorMurmurLine('角色117', () => .4).slice(0, 1));
    let all = false, repeated = false;
    for (let i = 0; i < 300; i++) {
      const f = line.step(.05);
      expect(f.letter.length).toBeLessThanOrEqual(1);
      if (f.text === '角色081…………\n检讨…………必须写吗') all = true;
      if (all && f.text === '') { repeated = true; break; }
    }
    expect(all).toBe(true); expect(repeated).toBe(true);
  });

  it('never catches up several characters or audio syllables after a stalled frame', () => {
    const line = new MonitorMurmurLine('角色117', () => 0);
    expect(line.step(30).text).toBe('');
    for (let i = 0; i < 3; i++) line.step(.1);
    const prefix = line.text;
    expect(line.step(NaN).text).toBe(prefix);
    expect(line.step(-1).text).toBe(prefix);
    expect(line.step(100).text.length - prefix.length).toBeLessThanOrEqual(1);
  });
});

describe('本机直视与近距离默念', () => {
  it('uses the actual look direction, body LOS and server-sized view cone', () => {
    const cam = camera(), front = new THREE.Vector3(0, 0, -3);
    expect(monitorObserved(cam, front, open)).toBe(true);
    expect(monitorObserved(cam, front, () => false)).toBe(false);
    expect(monitorObserved(cam, new THREE.Vector3(0, 0, 3), open)).toBe(false);
    expect(monitorObserved(cam, new THREE.Vector3(0, 0, -42), open)).toBe(false);
    cam.rotation.y = Math.PI;
    expect(monitorObserved(cam, new THREE.Vector3(0, 0, 3), open)).toBe(true);
  });

  it('keeps typing across equivalent snapshots and stops immediately on local gaze or a remote freeze', () => {
    const f = fixture(); f.step(8);
    expect(f.el.textContent).toBe(monitorMurmurLine('角色117', () => .4).slice(0, 2)); expect(f.voice.say).toHaveBeenCalledTimes(2);
    const prefix = f.el.textContent!;
    f.mobs.set(2, { ...f.source }); f.step();
    expect(f.el.textContent?.startsWith(prefix)).toBe(true);
    f.cam.rotation.y = Math.PI; f.step();
    expect(f.el.hidden).toBe(true); expect(f.el.textContent).toBe('');
    const voices = f.voice.say.mock.calls.length;
    f.cam.rotation.y = 0; f.mobs.get(2)!.anim = 'freeze'; f.step(20);
    expect(f.voice.say).toHaveBeenCalledTimes(voices); expect(f.el.hidden).toBe(true);
    f.mobs.get(2)!.anim = 'run'; f.step();
    expect(f.el.textContent?.startsWith(prefix)).toBe(true);
    f.murmurs.dispose();
  });

  it('excludes far, occluded and other-storey creatures and gives only one nearby monster the voice', () => {
    const f = fixture();
    f.source.mesh.position.z = 12; f.step(8); expect(f.el.hidden).toBe(true); expect(f.voice.say).not.toHaveBeenCalled();
    f.source.mesh.position.z = 3; f.step(8, true, () => false); expect(f.el.hidden).toBe(true);
    f.source.mesh.position.y = 4; f.step(8); expect(f.el.hidden).toBe(true);
    f.source.mesh.position.y = 0;
    f.mobs.set(3, actor('角色039', 2)); f.step(8);
    expect(f.el.dataset.speaker).toBe('角色039'); expect(f.voice.say).toHaveBeenCalledTimes(2);
    for (const call of f.voice.say.mock.calls) expect(call[1]).toBeGreaterThan(28); // quiet distance-mapped voice gain
    f.mobs.delete(3); f.step(4); expect(f.el.dataset.speaker).toBe('角色117');
    f.murmurs.dispose();
  });

  it('pauses on stale/network-disabled frames and page hiding, forwards mute, and releases listeners and audio', () => {
    const f = fixture(); f.step(4);
    f.step(1, false); expect(f.el.hidden).toBe(true); expect(f.voice.cancel).toHaveBeenCalled();
    f.step(4); expect(f.el.hidden).toBe(false);
    f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange'));
    expect(f.el.hidden).toBe(true);
    const calls = f.voice.say.mock.calls.length; f.step(10);
    expect(f.voice.say).toHaveBeenCalledTimes(calls);
    f.murmurs.setPreferences(.4, true); expect(f.voice.setPreferences).toHaveBeenLastCalledWith(.4, true);
    f.murmurs.dispose(); f.murmurs.dispose();
    expect(f.voice.dispose).toHaveBeenCalledOnce(); expect(f.el.remove).toHaveBeenCalledOnce();
    const cancels = f.voice.cancel.mock.calls.length;
    f.win.dispatchEvent(new Event('pagehide')); f.doc.dispatchEvent(new Event('visibilitychange'));
    expect(f.voice.cancel).toHaveBeenCalledTimes(cancels);
  });
});
