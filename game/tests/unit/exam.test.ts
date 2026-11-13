import { describe, expect, it } from 'vitest';
import { generateExam, gradeExam, type ExamQuestion } from '../../shared/exam.ts';

describe('shared five-question exam', () => {
  it('draws exactly five distinct four-choice questions deterministically for each seed', () => {
    const orders = new Set<string>(), ids = new Set<string>();
    for (const seed of [0, -1, 0x7fffffff, 0xffffffff, ...Array.from({ length: 100 }, (_, i) => i + 1)]) {
      const paper = generateExam(seed);
      expect(paper).toEqual(generateExam(seed));
      expect(paper).toHaveLength(5);
      expect(new Set(paper.map((q) => q.id)).size).toBe(5);
      orders.add(paper.map((q) => q.id).join(','));
      for (const q of paper) {
        ids.add(q.id);
        expect(q.id.length).toBeGreaterThan(0);
        expect(q.prompt.length).toBeGreaterThan(0);
        expect(q.clue.length).toBeGreaterThan(0);
        expect(q.choices).toHaveLength(4);
        expect(new Set(q.choices).size).toBe(4);
        expect(q.choices.every((choice) => choice.length > 0)).toBe(true);
        expect(Number.isInteger(q.correct) && q.correct >= 0 && q.correct < 4).toBe(true);
        expect(`${q.prompt}${q.clue}${q.choices.join('')}`).not.toMatch(/角色074|茉莉之夜|罚站|抓到|监考老师说/);
      }
    }
    expect(orders.size).toBeGreaterThan(20);
    expect(ids.size).toBeGreaterThan(5);
  });

  it('returns independent questions and choice arrays for every copy of the shared seed', () => {
    const first = generateExam(6), original = generateExam(6);
    first[0].choices[0] = 'changed';
    first[0].prompt = 'changed';
    first[0].correct = 99;
    expect(generateExam(6)).toEqual(original);
  });

  it('keeps every school question answer consistent with the fact explained by its notice', () => {
    const facts: Record<string, [string, RegExp]> = {
      'math-triangle': ['180°', /三个内角.*平角/],
      'math-square': ['16 平方厘米', /边长乘边长/],
      'math-hour': ['60 分钟', /60 分钟/],
      'math-fraction': ['1/2', /平均分成两份.*一半/],
      'math-perimeter': ['20 米', /（长＋宽）×2/],
      'math-metre': ['100 厘米', /1 米＝100 厘米/],
      'science-water': ['100℃', /标准大气压.*沸点为 100℃/],
      'science-plant': ['二氧化碳', /二氧化碳和水.*释放氧气/],
      'science-states': ['熔化', /固态变成液态.*熔化/],
      'science-earth': ['一年', /公转一周约一年/],
      'english-book': ['书', /Read a book.*读一本书/],
      'english-monday': ['Monday', /星期一.*Monday/],
      'language-punctuation': ['问号', /问号.*直接提出问题/],
      'language-antonym': ['喧闹', /与它相反的是喧闹/],
      'school-library': ['按规定归还或续借', /到期归还.*规定办理续借/],
      'school-recycle': ['可回收物', /清洁的普通废纸属于可回收物/],
    };
    const seen = new Set<string>();
    for (let seed = 0; seed < 100; seed++) for (const q of generateExam(seed)) {
      const fact = facts[q.id];
      expect(fact, q.id).toBeDefined();
      expect(q.choices[q.correct], q.id).toBe(fact[0]);
      expect(q.clue, q.id).toMatch(fact[1]);
      seen.add(q.id);
    }
    expect([...seen].sort()).toEqual(Object.keys(facts).sort());
  });

  it('accepts only a complete, fully correct five-question paper', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const paper = generateExam(seed), answers = paper.map((q) => q.correct);
      expect(gradeExam(paper, answers)).toBe(true);
      for (let i = 0; i < 5; i++) {
        const wrong = [...answers]; wrong[i] = (wrong[i] + 1) % 4;
        expect(gradeExam(paper, wrong)).toBe(false);
        const missing: (number | null)[] = [...answers]; missing[i] = null;
        expect(gradeExam(paper, missing)).toBe(false);
      }
      expect(gradeExam(paper, answers.slice(0, 4))).toBe(false);
      expect(gradeExam(paper, [...answers, 0])).toBe(false);
    }
  });

  it('rejects empty, sparse, out-of-range and malformed submissions', () => {
    const paper = generateExam(6), answers = paper.map((q) => q.correct);
    expect(gradeExam([], [])).toBe(false);
    expect(gradeExam(paper.slice(0, 4), answers.slice(0, 4))).toBe(false);
    expect(gradeExam(paper, new Array(5))).toBe(false);
    expect(gradeExam(new Array<ExamQuestion>(5), answers)).toBe(false);
    const sparsePaper = [...paper]; delete sparsePaper[2];
    expect(gradeExam(sparsePaper, answers)).toBe(false);
    for (const bad of [-1, 4, 0.5, NaN, Infinity, undefined, '0']) {
      const invalid = [...answers]; invalid[0] = bad as number;
      expect(gradeExam(paper, invalid)).toBe(false);
    }
    const malformed: ExamQuestion[] = paper.map((q) => ({ ...q, choices: [...q.choices] }));
    malformed[0].choices.pop();
    expect(gradeExam(malformed, answers)).toBe(false);
    malformed[0] = { ...paper[0], correct: 4 };
    expect(gradeExam(malformed, [4, ...answers.slice(1)])).toBe(false);
  });

  it('fails closed on non-array data and malformed four-slot choice arrays', () => {
    const paper = generateExam(6), answers = paper.map((q) => q.correct);
    for (const malformed of [null, undefined, {}, { length: 5 }, '01234']) {
      expect(gradeExam(malformed as unknown as ExamQuestion[], answers)).toBe(false);
      expect(gradeExam(paper, malformed as unknown as number[])).toBe(false);
    }
    const choices: unknown[][] = [new Array(4), ['a', 'b', 'c', null], ['a', 'b', 'c', 2], ['a', 'b', 'c', '   '], ['a', 'b', 'c', 'a']];
    const missing = [...paper[0].choices]; delete missing[(paper[0].correct + 1) % 4]; choices.push(missing);
    for (const invalid of choices) {
      const malformed = [{ ...paper[0], choices: invalid as string[] }, ...paper.slice(1)];
      expect(gradeExam(malformed, answers)).toBe(false);
    }
  });

  it('does not treat inherited array entries as an answered question or a printed choice', () => {
    const paper = generateExam(6), answers = paper.map((q) => q.correct);
    const inherited = <T>(source: T[], i: number) => {
      const copy = [...source], prototype = Object.create(Array.prototype);
      Object.defineProperty(prototype, i, { value: source[i] });
      delete copy[i]; Object.setPrototypeOf(copy, prototype);
      return copy;
    };
    expect(gradeExam(inherited(paper, 0), answers)).toBe(false);
    expect(gradeExam(paper, inherited(answers, 0))).toBe(false);
    const malformed = [{ ...paper[0], choices: inherited(paper[0].choices, 0) }, ...paper.slice(1)];
    expect(gradeExam(malformed, answers)).toBe(false);
    expect(gradeExam(paper, answers)).toBe(true);
  });
});
