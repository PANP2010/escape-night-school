import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardDutyNames, canonicalStudentName, captureTitle, monitorDisplayName, STUDENT_NAMES } from '../../shared/studentNames.ts';
import { Blackboards, frontText } from '../../client/src/campus/world/blackboard.ts';

afterEach(() => vi.unstubAllGlobals());

describe('anonymized student roster', () => {
  it('keeps the 42 distinct requested names, including the added and renamed identities', () => {
    expect(STUDENT_NAMES).toHaveLength(42);
    expect(new Set(STUDENT_NAMES).size).toBe(42);
    expect(STUDENT_NAMES).toEqual(expect.arrayContaining(['角色091', '角色114', '角色051', '角色009', '角色020', '角色094', '角色078']));
    expect(STUDENT_NAMES).not.toContain('角色003');
    expect(canonicalStudentName('角色078')).toBe('角色078');
    expect(canonicalStudentName('角色072')).toBe('值周代号025');
    expect(STUDENT_NAMES).not.toContain('角色072');
  });

  it('gives each monitor a stable peer-independent identity and varies it between rooms', () => {
    const encountered = new Set<string>();
    for (let seed = 1; seed <= 100; seed++) {
      const names = Array.from({ length: 8 }, (_, i) => monitorDisplayName(seed, 1, 2 + i));
      expect(new Set(names).size).toBe(names.length);
      for (const [i, name] of names.entries()) {
        expect(STUDENT_NAMES).toContain(name);
        expect(monitorDisplayName(seed, 1, 2 + i)).toBe(name);
      }
      encountered.add(names[0]);
    }
    expect(encountered.size).toBeGreaterThan(30);
  });

  it('fills every school-day board from the same pool without repetition and keeps weekends empty', () => {
    for (const seed of [0, 1, 19, 65536]) for (const key of ['default', 'A.4F.class7']) {
      const week = Array.from({ length: 5 }, (_, day) => frontText(key, day, seed, true).duty).flat();
      expect(week).toHaveLength(20);
      expect(new Set(week).size).toBe(20);
      week.forEach(name => expect(STUDENT_NAMES).toContain(name));
      expect(frontText(key, 3, seed, true).duty).toEqual(boardDutyNames(key, 3, seed));
      expect(frontText(key, 5, seed, true).duty).toEqual([]);
      expect(frontText(key, 6, seed, true).duty).toEqual([]);
    }
    expect(frontText('default', 1, 4, true).duty).not.toEqual(frontText('default', 1, 5, true).duty);
    expect(new Set(boardDutyNames('default', 1, 2, 100)).size).toBe(42);
  });

  it('keeps default writing anonymous and repaints a reused atlas when the room choice changes', () => {
    const labels: string[] = [];
    const context = new Proxy({ fillText: (text: string) => labels.push(text), measureText: (text: string) => ({ width: text.length * 20 }) }, {
      get: (target, key) => Reflect.get(target, key) ?? (() => {}),
    });
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => context }) });
    const boards = new Blackboards();
    const namedWriting = () => labels.filter(text => (STUDENT_NAMES as readonly string[]).includes(text) || text === '角色099');
    boards.sync(0);
    expect(frontText('A.4F.class7', 0).duty).toEqual(['同学甲', '同学乙', '同学丙', '同学丁']);
    expect(namedWriting()).toEqual([]);
    expect(labels).toContain('本班同学');
    labels.length = 0;
    boards.setNamedMonitors(true);
    expect(namedWriting()).toHaveLength(9);
    expect(labels).toContain('角色099');
    labels.length = 0;
    boards.setNamedMonitors(false);
    boards.setRosterSeed(514);
    expect(namedWriting()).toEqual([]);
    expect(labels).toContain('同学甲');
    boards.texture?.dispose();
  });

  it('uses the actual displayed name in the exact monitor defeat message', () => {
    expect(captureTitle({ by: 'monitor', name: '角色117' })).toBe('你被角色117卷死了');
    expect(captureTitle({ by: 'monitor', name: '角色020' })).toBe('你被角色020卷死了');
    expect(captureTitle({ by: 'monitor', name: '角色094' })).toBe('你被角色094卷死了');
    expect(captureTitle({ by: 'monitor', name: '角色078' })).toBe('你被角色078卷死了');
    expect(captureTitle({ by: 'warden' })).toBe('你被角色074抓住了');
    expect(captureTitle({ by: 'mirror' })).toBe('你被镜中人抓住了');
  });
});
