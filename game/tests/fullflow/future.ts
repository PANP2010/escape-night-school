import { expect } from '@playwright/test';
import { showCanvas } from '../e2e/draw.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { Flow } from './harness.ts';

/** Select the actual visible paper mesh; its interaction point is above the horizontal sheet. */
async function useExamObject(f: Flow, kind: 'paper' | 'notice', index: number, at: { x: number; y: number; z: number }) {
  if (f.mode !== 'mobile') { await f.use(undefined, undefined, at); return; }
  await showCanvas(f.page, true);
  const point = await f.page.evaluate(({ kind, index }) => {
    const g = window.__escape.game() as any;
    const object = g.exam.group.children.find((o: any) => o.userData.examTarget?.kind === kind
      && o.userData.examTarget.index === index && (kind !== 'paper' || o.rotation.x < -1));
    if (!object) throw new Error(`No rendered exam ${kind}:${index}`);
    object.updateWorldMatrix(true, false); g.camera.updateMatrixWorld(true);
    const v = object.getWorldPosition(new window.__escape.THREE.Vector3()).project(g.camera);
    if (![v.x, v.y, v.z].every(Number.isFinite) || Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || Math.abs(v.z) > 1)
      throw new Error('Exam sheet is outside the camera');
    const rect = g.renderer.domElement.getBoundingClientRect();
    const x = rect.left + (v.x + 1) * rect.width / 2, y = rect.top + (1 - v.y) * rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit.closest('button,input,textarea,select,.touch-btn,#touch-stick'))
      throw new Error('Exam sheet tap is covered by a control');
    return { x, y, kind, index };
  }, { kind, index });
  await f.page.touchscreen.tap(point.x, point.y);
  expect(await f.page.evaluate(() => document.pointerLockElement)).toBeNull();
  f.note('L6-rendered-sheet-tap', point);
}

/** L5–L8 adapters follow the current migration contracts; only a continuous ordinary /ws campaign can pass. */
export async function futureChapters(f: Flow) {
  const gym = await f.page.evaluate(() => (window.__escape.game() as any).level.def.gym);
  expect(gym, 'L5 must be registered in the campaign; a separate preview is insufficient').toBeDefined();
  expect(f.latest('gym'), 'L5 must send real gym state').toMatchObject({ solo: true, complete: false });
  expect(await f.page.evaluate(() => (window.__escape.game() as any).level.def.monitor?.count)).toBe(2);
  await expect.poll(() => f.latest('gym')?.balls?.length ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
  f.note('L5-basketball-spawn', f.latest('gym')?.balls);
  // Let a fresh ball pass before stepping into its rollout. Approaching an incoming ball while moving
  // would deliberately trigger the server's movement rejection instead of testing a stationary trip.
  const wait = { x: gym.ballSpawn.x + 1, y: gym.ballSpawn.y, z: gym.ballSpawn.z + 1.8 };
  await f.go(wait);
  await expect.poll(() => f.latest('gym')?.balls?.some((b: any) => b.v[1] > 0
    && b.p[2] > gym.ballSpawn.z + 2.8 && b.p[2] < gym.ballSpawn.z + 5
    && Math.abs(b.p[0] - gym.ballSpawn.x) < 1), { timeout: 12_000, intervals: [50] }).toBe(true);
  await f.go({ ...wait, x: gym.ballSpawn.x });
  const playerId = (await f.state()).id, tripAt = f.messages.length;
  await expect.poll(() => f.messages.slice(tripAt).some(m => m.t === 'gym-sound' && m.kind === 'trip' && m.player === playerId),
    { timeout: 20_000, intervals: [50], message: 'a real rolled ball must trip the stationary player' }).toBe(true);
  await expect.poll(() => f.latest('gym')?.trips.some((t: any) => t.id === playerId)).toBe(true);
  const tripUntil = f.latest('gym')!.trips.find((t: any) => t.id === playerId).until;
  expect(tripUntil - f.latest('gym')!.now).toBeGreaterThan(1.3);
  expect(tripUntil - f.latest('gym')!.now).toBeLessThanOrEqual(1.5);
  await expect.poll(() => f.latest('gym')?.now, { timeout: 3000 }).toBeGreaterThanOrEqual(tripUntil);
  expect(f.latest('gym')!.trips.some((t: any) => t.id === playerId)).toBe(false);
  await f.page.evaluate(() => window.__escape.game()!.input.press('ShiftLeft'));
  try {
    for (let id = 0; id < gym.switches.length; id++) {
      const at = gym.switches[id];
      const panel = { x: at.x, y: at.y + 1.25, z: at.z };
      await f.approach(panel, at.y);
      await f.use('gym-switch', id, panel);
      await expect.poll(() => f.latest('gym')?.until[id] - f.latest('gym')?.now).toBeGreaterThan(18);
      expect(f.latest('gym')?.until[id] - f.latest('gym')?.now).toBeLessThanOrEqual(20);
    }
  } finally { await f.page.evaluate(() => window.__escape.game()!.input.release('ShiftLeft')); }
  await expect.poll(() => f.latest('gym')?.complete).toBe(true);
  await f.checkpoint('L5-four-switches-and-ball-trip'); await f.photo('l5-switches-solved'); await f.exit(4, false);
  await examChapter(f); await f.exit(5, false);

  await mirrorChapter(f); await f.exit(6, false);
  await finaleChapter(f);
}

/** Runtime adapter for sprint-l7_campaign's ordinary /ws contract; no standalone page or room is opened. */
export async function mirrorChapter(f: Flow) {
  expect((await f.state()).level).toBe(6);
  expect(await f.page.evaluate(() => (window.__escape.game() as any).level.def.mirror),
    'L7 must be registered in the common campaign').toBe(true);
  await expect.poll(() => f.latest('l7')).toBeDefined();
  expect(f.latest('l7')?.key.taken).toBe(false);
  expect(f.latest('l7')?.openDoors).toEqual([]);
  const guard = f.latest('l7')!.key.guard.p as number[];
  await f.go({ x: -80.7, y: 0, z: 143.4 });
  await f.aim({ x: guard[0], y: guard[1] + 1.3, z: guard[2] });
  await expect.poll(() => f.latest('l7')?.key.guard.watched).toBe(true);
  const frozen = f.latest('l7')!.key.guard.yaw, frozenTick = f.latest('l7')!.tick;
  await expect.poll(() => f.latest('l7')?.tick).toBeGreaterThanOrEqual(frozenTick + 8);
  expect(f.latest('l7')!.key.guard.yaw).toBe(frozen);
  // Looking at the real guard cannot claim the key, even when its turn happens to expose the pouch.
  await f.page.evaluate(() => window.__escape.net.send({ t: 'act', kind: 'mirror-key', id: 0 } as any));
  await f.page.waitForTimeout(150); expect(f.latest('l7')!.key.taken).toBe(false);
  await f.aim({ x: -82.22, y: 1.45, z: 143.4 });
  await expect.poll(() => f.latest('l7')?.key.guard.watched).toBe(false);
  await expect.poll(() => f.latest('l7')?.key.guard.yaw).not.toBe(frozen);
  // Small real look input keeps the delayed reflection moving while waiting for the seven-second inspection turn.
  if (f.mode === 'mobile') await showCanvas(f.page, true);
  const timer = await f.page.evaluate(() => {
    const g = window.__escape.game() as any, pitch = g.input.pitch;
    return setInterval(() => { g.input.pitch = pitch + Math.sin(performance.now() / 250) * .025; }, 50);
  });
  try {
    // The authority's open flag can precede a visible pouch key. Wait for the actual reflected mesh,
    // rather than tapping the whole mirror as soon as the guard starts its turn.
    const keyWindow = () => f.page.evaluate(() => {
      const g = window.__escape.game() as any, state = g.mirrorState;
      if (!state?.key.open || state.key.guard.watched || g.target()?.kind !== 'mirror-key') return null;
      const hit = g.mirrorView.keyHitTarget();
      return hit ? { ...hit, yaw: state.key.guard.yaw } : null;
    });
    await expect.poll(keyWindow, { timeout: 9000, intervals: [50] }).not.toBeNull();
    expect(f.latest('l7')!.key.guard.watched).toBe(false);
    const keyActionAt = f.sent.length;
    if (f.mode === 'mobile') {
      const key = await keyWindow();
      expect(key, 'tap must hit the reflected back-pouch key on the glass').toBeTruthy();
      expect(-Math.sin(key!.yaw), 'only the east-facing turn exposes the back pouch').toBeGreaterThan(.78);
      await f.page.touchscreen.tap(key!.x, key!.y);
      f.note('L7-reflected-key-object-tap', key);
    } else await f.use('mirror-key', 0);
    await expect.poll(() => f.sent.slice(keyActionAt).some(m => m.t === 'act' && m.kind === 'mirror-key' && m.id === 0)).toBe(true);
    await expect.poll(() => f.latest('l7')?.key.taken).toBe(true);
    if (f.mode === 'mobile') expect(await f.page.evaluate(() => document.pointerLockElement)).toBeNull();
    // Dismiss the reflection before stopping look input or spending time on screenshot rendering.
    await f.aim({ x: -77.65, y: 1.3, z: 143.4 });
  } finally { await f.page.evaluate(timer => clearInterval(timer), timer); }
  f.note('L7-mirror-back-gap-key', { directSightFreezes: true, reflectedSightFreezes: false, taken: true });
  await f.photo('l7-mirror-back-gap-key');

  // Observe a real still→emerge transition at a safe distance, then dismiss it by turning away.
  await f.go({ x: -79.6, y: 0, z: 145.7 });
  await f.aim({ x: -82.22, y: 1.45, z: 143.4 });
  const id = (await f.state()).id;
  await expect.poll(() => f.latest('l7')?.mirrors.find((m: any) => m.id === id)?.phase,
    { timeout: 8000, intervals: [50] }).toBe('chase');
  const actor = f.latest('l7')!.mirrors.find((m: any) => m.id === id);
  expect(actor.stillFor).toBe(5); expect(actor.chaseLeft).toBeGreaterThan(3.5);
  await f.aim({ x: -75, y: 1.45, z: 145.7 });
  await expect.poll(() => f.latest('l7')?.mirrors.some((m: any) => m.id === id)).toBe(false);
  f.note('L7-reflection-emerges-and-dismisses', actor);
  for (const [door, y] of [[1, 0], [2, 3.6]]) {
    if (door === 2) {
      // The secret wall exposes the east hall; authoritative nav leads through the real LAB staircase.
      await f.go({ x: -80.7, y, z: 143.4 });
      await f.aim({ x: -82.22, y: y + 1.45, z: 143.4 });
      await expect.poll(() => f.latest('l7')?.mirrors.some((m: any) => m.id === id && m.mirrorId === 2)).toBe(true);
    }
    await expect.poll(() => f.latest('l7')?.revealedDoors).toContain(door);
    await f.go({ x: -78.85, y, z: 143.4 });
    await f.aim({ x: -77.65, y: y + 1.3, z: 143.4 });
    await f.use('mirror-push', door);
    await expect.poll(() => f.latest('l7')?.openDoors).toContain(door);
    await f.checkpoint(`L7-pushed-secret-wall-${door}`);
  }
  expect(f.latest('l7')!.openDoors.slice().sort()).toEqual([1, 2]);
  await f.photo('l7-both-mirror-walls-open');
}

// Deliberately answer from neutral question semantics after reading both real notice dialogs. Never read q.correct.
const answers: [RegExp, string][] = [
  [/三角形/, '180°'], [/正方形/, '16 平方厘米'], [/小时/, '60 分钟'], [/0\.5/, '1/2'],
  [/长方形/, '20 米'], [/1 米/, '100 厘米'], [/沸腾/, '100℃'], [/光合作用/, '二氧化碳'],
  [/冰融化/, '熔化'], [/公转/, '一年'], [/book/, '书'], [/星期一/, 'Monday'],
  [/疑问句/, '问号'], [/安静/, '喧闹'], [/图书馆/, '按规定归还或续借'], [/废纸/, '可回收物'],
];
async function examChapter(f: Flow) {
  const activate = async (control: import('@playwright/test').Locator) => {
    if (f.mode === 'mobile') await control.tap(); else await control.click();
  };
  const def = await f.page.evaluate(() => (window.__escape.game() as any).level.def.exam);
  expect(def, 'L6 must use the common campaign definition').toBeDefined();
  await expect.poll(() => f.latest('exam')?.passed).toBe(false);
  expect(def.notices.flatMap((n: any) => n.questions).sort()).toEqual([0, 1, 2, 3, 4]);
  const visibleClues: string[] = [];
  for (const [index, notice] of def.notices.entries()) {
    const floor = Math.round((notice.y - 1.45) / 3.6) * 3.6;
    await f.approach(notice, floor); await useExamObject(f, 'notice', index, notice);
    await expect(f.page.locator('#exam-overlay')).toBeVisible();
    await expect(f.page.locator('.exam-clue')).toHaveCount(notice.questions.length);
    visibleClues.push(...await f.page.locator('.exam-clue').allInnerTexts());
    f.note('L6-read-notice', { index, text: await f.page.locator('.exam-body').innerText() });
    await activate(f.page.locator('#exam-close'));
  }
  const at = { ...def.paper, y: def.paper.y + .12 };
  // The static stair graph's landing node is close to the door jamb. The optional autopilot accepts a
  // 30 cm waypoint radius, so explicitly cross the middle of the real aperture before taking the stairs.
  const current = await f.state(), paperFloor = Math.round((def.paper.y - 1.15) / 3.6) * 3.6;
  if (current.p[1] > paperFloor + 2) {
    await f.go({ x: -56.25, y: paperFloor + 3.6, z: 66.02 });
    await f.walk([[-58, 66.02], [-58, 67.49], [-64.06, 67.49], [-64.06, 64.56],
      [-58, 64.56], [-58, 66.02], [-56.45, 66.02]], { x: -56.45, y: paperFloor, z: 66.02 });
    f.note('L6-descended-through-centre-of-stair-door', await f.state());
  }
  await f.approach(at, Math.round((def.paper.y - 1.15) / 3.6) * 3.6);
  await useExamObject(f, 'paper', 0, at); await expect(f.page.locator('#exam-overlay')).toBeVisible();
  const choices: number[] = [];
  for (let q = 0; q < 5; q++) {
    await activate(f.page.locator('.exam-progress button').nth(q));
    const prompt = await f.page.locator('.exam-question').innerText();
    const question = prompt.replace(/^第\d+题\s*\/\s*5\s*/, '').trim();
    expect(visibleClues.some(clue => clue.includes(question)), 'each question must have been readable on a real notice').toBe(true);
    const correct = answers.find(([pattern]) => pattern.test(prompt))?.[1];
    expect(correct, `unmapped visible school question: ${prompt}`).toBeDefined();
    const labels = await f.page.locator('.exam-choice').allInnerTexts();
    const choice = labels.findIndex(s => s.replace(/^[A-D]\s*/, '').trim() === correct);
    expect(choice).toBeGreaterThanOrEqual(0); choices.push(choice);
    const revision = f.latest('exam')!.revision, selected = q === 0 ? (choice + 1) % 4 : choice, mark = f.sent.length;
    await activate(f.page.locator('.exam-choice').nth(selected));
    await expect.poll(() => f.sent.slice(mark).some(m => m.t === 'exam' && m.op === 'answer'
      && m.question === q && m.choice === selected && m.revision === revision)).toBe(true);
    await expect.poll(() => f.latest('exam')?.revision).toBe(revision + 1);
    expect(f.latest('exam')!.answers[q]).toBe(selected);
  }
  const penaltyStartTick = f.snap!.tick, submitRevision = f.latest('exam')!.revision, submitAt = f.sent.length;
  await activate(f.page.locator('#exam-submit'));
  await expect.poll(() => f.sent.slice(submitAt).some(m => m.t === 'exam' && m.op === 'submit' && m.revision === submitRevision)).toBe(true);
  await expect.poll(() => f.latest('exam')?.blackout).toEqual({ floor: 3, seconds: 10 });
  const penaltyRevision = f.latest('exam')!.revision;
  expect(penaltyRevision).toBe(submitRevision + 1);
  expect(f.latest('exam')!.cooldown).toBe(10);
  expect(f.latest('exam')?.passed).toBe(false);
  let penaltyEndTick = 0;
  // Observe the authority while the screenshot is being captured; render stalls must not extend the measured penalty.
  await Promise.all([
    expect.poll(() => {
      const state = f.latest('exam');
      if (state?.blackout || state?.cooldown !== 0 || state?.revision !== penaltyRevision + 1) return false;
      penaltyEndTick = f.snap!.tick; return true;
    }, { timeout: 13_000, intervals: [20, 50] }).toBe(true),
    f.photo('l6-wrong-answer-penalty'),
  ]);
  // Exam messages precede the next snap in the same ordered /ws stream, so the last received snap may be one tick behind.
  expect(penaltyEndTick - penaltyStartTick, 'ten-second blackout cannot end early on the authority').toBeGreaterThanOrEqual(Math.ceil(10_000 / TICK_MS) - 1);
  f.note('L6-authoritative-blackout', { startTick: penaltyStartTick, endTick: penaltyEndTick, revision: penaltyRevision, floor: 3, seconds: 10 });
  await expect(f.page.locator('#exam-submit')).toBeEnabled({ timeout: 13_000 });
  await activate(f.page.locator('.exam-progress button').first()); await activate(f.page.locator('.exam-choice').nth(choices[0]));
  await expect.poll(() => f.latest('exam')?.answers[0]).toBe(choices[0]);
  await activate(f.page.locator('#exam-submit')); await expect.poll(() => f.latest('exam')?.passed).toBe(true);
  await activate(f.page.locator('#exam-close')); await f.photo('l6-paper-passed');
}

/** Continues after the ordinary L7 exit; the finale's real pursuit and counters remain authoritative. */
export async function finaleChapter(f: Flow) {
  expect((await f.state()).level).toBe(7);
  const def = await f.page.evaluate(() => (window.__escape.game() as any).level.def.finale);
  expect(def).toBeDefined();
  await expect.poll(() => f.latest('finale')?.phase).toBe('rollcall');
  const entryStats = { elapsedMs: f.latest('finale')!.elapsedMs, downs: f.latest('finale')!.downs };
  await f.approach({ ...def.rollcall, y: def.rollcall.y + .86 }, def.rollcall.y);
  await expect.poll(() => f.page.evaluate(() => (window.__escape.game() as any).isRegisterNear())).toBe(true);
  await expect(f.page.locator('#prompt')).toContainText('点名册');
  await f.use(undefined, undefined, { ...def.rollcall, y: def.rollcall.y + .86 });
  await expect(f.page.locator('#rollcall-panel')).toBeVisible();
  const members = f.latest('finale')!.members.filter((m: any) => m.status !== 'left');
  const count = members.length;
  for (let i = 0; i < count; i++) {
    const b = f.page.locator('#rollcall-list button').nth(i);
    const mark = f.sent.length;
    if (f.mode === 'mobile') await b.tap(); else await b.click();
    await expect.poll(() => f.sent.slice(mark).some(m => m.t === 'act' && m.kind === 'rollcall' && m.id === members[i].id)).toBe(true);
    await expect.poll(() => f.latest('finale')?.members.find((m: any) => m.id === members[i].id)?.crossedOut).toBe(true);
  }
  await expect.poll(() => f.latest('finale')?.phase).toBe('chase');
  const traceFrom = f.messages.length;
  await expect.poll(() => f.mobs.get(1)?.form).toBe('perfect');
  const player = (await f.state()).id;
  await expect.poll(() => f.mobs.get(1)?.target).toBe(player);
  const trace: { tick: number; p: number[]; mob: number[]; target: number }[] = [];
  const timer = setInterval(() => {
    const p = f.snap?.players?.find((p: any) => p.id === player)?.p, mob = f.mobs.get(1);
    if (p && mob?.p) trace.push({ tick: f.snap!.tick, p: [...p], mob: [...mob.p], target: mob.target });
  }, 100);
  // Natural finale chase is never suppressed by debug safe after the register opens.
  await f.page.evaluate(route => {
    const g = window.__escape.game()!; g.autopilot([[g.pos.x, g.pos.z], ...route.map((p: any) => [p.x, p.z])]); g.input.press('ShiftLeft');
  }, def.route);
  try { await expect(f.page.locator('#finale-result')).toBeVisible({ timeout: 90_000 }); }
  finally { clearInterval(timer); await f.page.evaluate(() => window.__escape.game()!.input.release('ShiftLeft')); }
  expect(trace.some(v => v.p[2] > 123), 'walk inside OFF').toBe(true);
  expect(trace.some(v => v.p[2] < 122 && v.p[2] > 116), 'walk out through OFF entrance').toBe(true);
  expect(trace.some(v => v.p[2] < 0 && v.p[2] > -8.2), 'pass the actual school gate').toBe(true);
  expect(trace.some(v => v.p[2] < -8.2), 'reach beyond the perimeter').toBe(true);
  expect(trace.some(v => v.target === player), 'the authoritative pursuer must actually target this player').toBe(true);
  expect(trace.filter(v => v.p[2] > -8.2).every(v => v.target === player),
    'pursuit must continue through the office and outdoor turns until the school gate').toBe(true);
  let pursued = 0;
  for (let i = 1; i < trace.length; i++) pursued += Math.hypot(trace[i].mob[0] - trace[i-1].mob[0], trace[i].mob[2] - trace[i-1].mob[2]);
  expect(pursued, 'the authoritative pursuer must follow the real outdoor route').toBeGreaterThan(100);
  expect(f.messages.slice(traceFrom).filter(m => m.t === 'correct' && !m.forced)).toEqual([]);
  f.note('L8-natural-authority-route', { pursuedMetres: pursued, trace });
  const stats = f.latest('completed');
  expect(stats, 'statistics must come from the server').toBeDefined();
  expect(stats!.elapsedMs).toBeGreaterThan(0); expect(Number.isInteger(stats!.downs)).toBe(true);
  expect(stats!.elapsedMs).toBeGreaterThanOrEqual(entryStats.elapsedMs);
  expect(stats!.downs, 'earlier campaign downs must survive the finale').toBeGreaterThanOrEqual(entryStats.downs);
  expect(stats!.downs).toBeGreaterThanOrEqual(0); expect(stats!.members).toHaveLength(count);
  expect(stats!.members.some((m: any) => m.id === player && m.escaped)).toBe(true);
  expect(f.mobs.get(1)?.form).toBe('perfect');
  await expect(f.page.locator('#finale-summary')).toContainText('用时');
  await expect(f.page.locator('#finale-summary')).toContainText('倒地');
  const completedTick = f.snap!.tick;
  await expect.poll(() => f.snap?.tick).toBeGreaterThanOrEqual(completedTick + 25);
  expect(f.latest('completed')).toEqual(stats);
  expect(f.latest('finale')).toMatchObject({ phase: 'complete', elapsedMs: stats!.elapsedMs, downs: stats!.downs });
  await f.checkpoint('L8-authoritative-ending');
  await f.photo('l8-authoritative-ending'); f.note('eight-chapter-final-statistics', stats);
}
