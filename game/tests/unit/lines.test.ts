import { describe, expect, it } from 'vitest';
import { WARDEN_LINES, linesFor, pickLine, ROLE_SLOT, type LineTrigger } from '../../shared/lines.ts';
import { mulberry32 } from '../../shared/rng.ts';

// User-provided 角色074语录 — must stay verbatim (only the 「xx者」 slot is templated).
const QUOTES = [
  '我感觉这不是xx者应有的态度',
  '我们要找到自己的节奏',
  '你缺乏青春舒展的姿态',
  '粗疏',
  '心中有一片尚未崩坏的地方',
  '你没有人格',
  '这真是浮乎江湖之上的瞬间',
  '你有担当吗',
  '你喜欢我吗？看着我的眼睛，你真的喜欢我吗？！',
];
const TRIGGERS: LineTrigger[] = ['patrol', 'spot', 'chase', 'lost', 'catch', 'stare', 'sprint', 'crouch', 'noise', 'fail'];

describe('角色074语录', () => {
  it('contains every user quote verbatim', () => {
    const texts = WARDEN_LINES.map(l => l.text.replace(ROLE_SLOT, 'xx者'));
    for (const q of QUOTES) expect(texts).toContain(q);
    expect(new Set(WARDEN_LINES.map(l => l.id)).size).toBe(WARDEN_LINES.length);
  });

  it('every trigger has at least one line; stare is the 变脸 line', () => {
    for (const t of TRIGGERS) expect(linesFor(t).length).toBeGreaterThan(0);
    expect(linesFor('stare').map(l => l.id)).toEqual(['likeme']);
  });

  it('fills the xx者 slot and never leaks the placeholder', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const t = TRIGGERS[i % TRIGGERS.length];
      const p = pickLine(t, rng)!;
      expect(p.text).not.toContain(ROLE_SLOT);
      if (p.id === 'attitude') expect(p.text).toMatch(/^我感觉这不是.+者应有的态度$/);
    }
  });

  it('is deterministic per seed and avoids recent ids', () => {
    const a = pickLine('catch', mulberry32(3)), b = pickLine('catch', mulberry32(3));
    expect(a).toEqual(b);
    const rng = mulberry32(11);
    const all = linesFor('catch').map(l => l.id);
    for (let i = 0; i < 50; i++) {
      const recent = all.slice(0, all.length - 1);
      expect(pickLine('catch', rng, recent)!.id).toBe(all[all.length - 1]);
    }
    // all recent → still returns something
    expect(pickLine('stare', rng, ['likeme'])!.id).toBe('likeme');
  });
});

import { isLineEvent } from '../../shared/protocol.ts';
describe('line event validation', () => {
  it('accepts a well-formed event and rejects junk', () => {
    expect(isLineEvent({ t: 'event', kind: 'line', id: 'duty', text: '你有担当吗', mob: 1 })).toBe(true);
    expect(isLineEvent({ t: 'event', kind: 'line', id: 'x', text: '', mob: 1 })).toBe(false);
    expect(isLineEvent({ t: 'event', kind: 'line', id: 'x', text: 'a', mob: 'm' })).toBe(false);
    expect(isLineEvent({ t: 'event', kind: 'other', id: 'x', text: 'a', mob: 1 })).toBe(false);
    expect(isLineEvent(null)).toBe(false);
  });
});
