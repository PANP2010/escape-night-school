import { mulberry32 } from './rng.ts';

/** The team answers one shared paper. `correct` is the zero-based choice index. */
export interface ExamQuestion {
  id: string;
  prompt: string;
  choices: string[];
  clue: string;
  correct: number;
}

/** Ordinary school questions: the door notices explain the answer without character dialogue. */
const BANK: readonly ExamQuestion[] = [
  { id: 'math-triangle', prompt: '一个三角形的内角和是多少度？', choices: ['90°', '180°', '270°', '360°'], clue: '把三角形三个内角拼在一起，正好组成一个平角。', correct: 1 },
  { id: 'math-square', prompt: '边长为 4 厘米的正方形，面积是多少？', choices: ['8 平方厘米', '12 平方厘米', '16 平方厘米', '20 平方厘米'], clue: '正方形的面积等于边长乘边长。', correct: 2 },
  { id: 'math-hour', prompt: '1 小时等于多少分钟？', choices: ['60 分钟', '30 分钟', '90 分钟', '100 分钟'], clue: '钟表的分针走完一圈，经过 60 分钟。', correct: 0 },
  { id: 'math-fraction', prompt: '下列哪个分数等于 0.5？', choices: ['1/4', '1/3', '3/4', '1/2'], clue: '把一个整体平均分成两份，其中一份就是一半。', correct: 3 },
  { id: 'math-perimeter', prompt: '长 6 米、宽 4 米的长方形，周长是多少？', choices: ['10 米', '20 米', '24 米', '40 米'], clue: '长方形的周长等于（长＋宽）×2。', correct: 1 },
  { id: 'math-metre', prompt: '1 米等于多少厘米？', choices: ['10 厘米', '50 厘米', '100 厘米', '1000 厘米'], clue: '长度单位换算：1 米＝100 厘米。', correct: 2 },
  { id: 'science-water', prompt: '在标准大气压下，纯水通常在多少摄氏度沸腾？', choices: ['0℃', '25℃', '50℃', '100℃'], clue: '标准大气压下，纯水的凝固点为 0℃，沸点为 100℃。', correct: 3 },
  { id: 'science-plant', prompt: '植物进行光合作用时，主要吸收空气中的哪种气体？', choices: ['二氧化碳', '氧气', '氮气', '氦气'], clue: '光合作用利用光能，把二氧化碳和水转化成有机物，并释放氧气。', correct: 0 },
  { id: 'science-states', prompt: '冰融化成水，属于哪种物态变化？', choices: ['凝固', '汽化', '熔化', '凝华'], clue: '固态变成液态的过程叫作熔化。', correct: 2 },
  { id: 'science-earth', prompt: '地球绕太阳公转一周，大约需要多长时间？', choices: ['一天', '一周', '一个月', '一年'], clue: '地球自转一周约一天，公转一周约一年。', correct: 3 },
  { id: 'english-book', prompt: '英语单词“book”的常见名词含义是什么？', choices: ['书', '窗户', '铅笔', '课桌'], clue: '“Read a book”表示“读一本书”。', correct: 0 },
  { id: 'english-monday', prompt: '英语中，星期一应写作哪一个单词？', choices: ['Sunday', 'Monday', 'Friday', 'Saturday'], clue: '一周中的星期一，英文拼写为 Monday。', correct: 1 },
  { id: 'language-punctuation', prompt: '一个直接疑问句的句末，通常应使用什么标点？', choices: ['逗号', '句号', '冒号', '问号'], clue: '问号用在直接提出问题的句子末尾。', correct: 3 },
  { id: 'language-antonym', prompt: '“安静”的反义词是下列哪一项？', choices: ['整齐', '明亮', '喧闹', '认真'], clue: '安静表示没有喧哗；与它相反的是喧闹。', correct: 2 },
  { id: 'school-library', prompt: '在学校图书馆借阅的书，到期后应怎样处理？', choices: ['按规定归还或续借', '随意放在走廊', '一直留在家里', '撕下需要的书页'], clue: '借阅规则：到期归还；仍需阅读时按规定办理续借。', correct: 0 },
  { id: 'school-recycle', prompt: '一张两面都已使用、没有油污的普通废纸，应投入哪类垃圾桶？', choices: ['厨余垃圾', '可回收物', '有害垃圾', '其他垃圾'], clue: '清洁的普通废纸属于可回收物。', correct: 1 },
];

/** Select five distinct questions, in a reproducible order, without exposing mutable bank objects. */
export function generateExam(seed: number): ExamQuestion[] {
  const rng = mulberry32(seed ^ 0x6e78616d), pool = [...BANK];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 5).map((q) => ({ ...q, choices: [...q.choices] }));
}

/** A submission passes only when the whole five-question paper has one valid, correct answer per question. */
export function gradeExam(questions: readonly ExamQuestion[], answers: readonly (number | null)[]): boolean {
  if (!Array.isArray(questions) || !Array.isArray(answers) || questions.length !== 5 || answers.length !== questions.length) return false;
  // Index explicitly: Array.every skips holes, so a sparse five-slot paper must not count as five correct questions.
  for (let i = 0; i < questions.length; i++) {
    if (!Object.hasOwn(questions, i) || !Object.hasOwn(answers, i)) return false;
    const q = questions[i];
    if (!q || !Array.isArray(q.choices) || q.choices.length !== 4 || !Number.isInteger(q.correct) || q.correct < 0 || q.correct >= 4
      || !Number.isInteger(answers[i]) || answers[i] !== q.correct) return false;
    // A four-slot array can still have missing / inherited choices, or choices the UI cannot display.
    for (let j = 0; j < q.choices.length; j++) {
      if (!Object.hasOwn(q.choices, j) || typeof q.choices[j] !== 'string' || !q.choices[j].trim()) return false;
    }
    if (new Set(q.choices).size !== q.choices.length) return false;
  }
  return true;
}
