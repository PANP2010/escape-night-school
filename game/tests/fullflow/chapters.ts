import { expect } from '@playwright/test';
import { Flow, type Point } from './harness.ts';
import { KEY_R } from '../../shared/interact.ts';

export async function firstChapter(f: Flow) {
  const items = await f.page.evaluate(() => [...(window.__escape.game() as any).items]) as { id: number; kind: string; door?: number; p: number[]; decoy?: boolean }[];
  const stair = items.find(i => i.kind === 'stair_key' && !i.decoy)!, key = items.find(i => i.kind === 'door_key' && !i.decoy)!;
  const drawer = items.find(i => i.kind === 'drawer_key' && !i.decoy);
  expect(stair, 'L1 must contain a real stair key').toBeDefined();
  expect(key, 'L1 must contain a real door key').toBeDefined();
  // A forged remote pick must not grant it. Assert the network table stays unchanged before approaching.
  const rejectedPickAt = f.messages.length, rejectedPickTick = f.snap?.tick ?? 0;
  const start = await f.state();
  expect(Math.hypot(start.p[0] - stair.p[0], start.p[2] - stair.p[2]), 'negative pick must actually start beyond reach').toBeGreaterThan(3);
  await f.page.evaluate(id => window.__escape.net.send({ t: 'act', kind: 'pick', id }), stair.id);
  await expect.poll(() => f.snap?.tick ?? 0).toBeGreaterThan(rejectedPickTick + 4);
  expect(f.latest('bag')?.bag?.stair_key ?? 0).toBe(0);
  expect(f.messages.slice(rejectedPickAt).some(m => m.t === 'snap' && m.gone?.includes(stair.id))).toBe(false);
  expect(await f.page.evaluate(id => (window.__escape.game() as any).items.some((i: any) => i.id === id), stair.id)).toBe(true);
  const pickItem = async (item: typeof key) => {
    await f.approach({ x: item.p[0], y: item.p[1] + .6, z: item.p[2] }, 0, KEY_R);
    const mark = f.messages.length;
    await f.use('pick', item.id);
    await expect.poll(() => f.messages.slice(mark).some(m => m.t === 'snap' && m.gone?.includes(item.id))).toBe(true);
    await expect.poll(() => f.page.evaluate(id => !(window.__escape.game() as any).items.some((i: any) => i.id === id), item.id)).toBe(true);
    if (item.kind === 'door_key') await expect.poll(() => f.latest('keys')?.keys).toContain(item.door);
    else await expect.poll(() => f.latest('bag')?.bag?.[item.kind] ?? 0).toBe(1);
    await f.checkpoint(`L1-picked-${item.kind}`);
  };
  await pickItem(key);
  // A real keyed door has a server-owned lock and opening state (the stair grate itself is a region barrier).
  await f.approachDoor(key.door!);
  const doorAt = f.messages.length;
  await f.use('use', key.door);
  await expect.poll(() => f.messages.slice(doorAt).some(m =>
    (m.t === 'snap' || m.t === 'doors') && m.doors?.some((d: any) => d.id === key.door && d.open && !d.locked))).toBe(true);
  await expect.poll(() => f.page.evaluate(id => (window.__escape.game() as any).doorOpen[id!], key.door)).toBe(true);
  await f.checkpoint('L1-keyed-door-unlocked');
  // The difficulty lane keeps the stair key in a locked drawer. Use its real prerequisite when present;
  // the existing four-chapter baseline retains the original key → door → stair-key route.
  if (drawer) await pickItem(drawer);
  await pickItem(stair);
  await f.photo('l1-key-and-unlock');
}

export async function monitorMechanism(f: Flow) {
  // This tests the real AI at a directed encounter, not natural encounter frequency or difficulty.
  await f.go({ x: 40, y: 3.6, z: 84.2 });
  await f.page.evaluate(() => {
    const g = window.__escape.game() as any;
    g.input.yaw = Math.PI / 2; g.input.pitch = 0;
  });
  await f.page.waitForTimeout(150);
  await f.page.evaluate(() => window.__escape.debug('monitor', 12));
  await expect.poll(() => f.mobs.get(2)?.anim, { timeout: 10_000 }).toBe('freeze');
  const before = [...f.mobs.get(2).p];
  await f.page.waitForTimeout(500);
  expect(Math.hypot(...f.mobs.get(2).p.map((v: number, i: number) => v - before[i]) as [number, number, number])).toBeLessThan(.05);
  await f.page.evaluate(() => { window.__escape.game()!.input.yaw = -Math.PI / 2; });
  try {
    await expect.poll(() => f.mobs.get(2)?.anim).toBe('run');
    await expect.poll(() => Math.hypot(...f.mobs.get(2).p.map((v: number, i: number) => v - before[i]) as [number, number, number]),
      { message: 'unwatched monitor must actually move on the authoritative simulation' }).toBeGreaterThan(.2);
  } finally { await f.page.evaluate(() => { window.__escape.game()!.input.yaw = Math.PI / 2; }); }
  await expect.poll(() => f.mobs.get(2)?.anim).toBe('freeze');
  f.note('L2-monitor-directed-mechanism', { watched: 'freeze', unwatched: 'run', rewatched: 'freeze' });
  await f.photo('l2-monitor-freeze');
  if (process.env.ESC_FULLFLOW_NATURAL !== '1') await f.page.evaluate(() => window.__escape.debug('safe', 600, 2));
}

export async function secondChapter(f: Flow) {
  expect(f.latest('power')?.n).toBe(0);
  await monitorMechanism(f);
  const items = await f.page.evaluate(() => (window.__escape.game() as any).items.filter((i: any) => i.kind === 'fuse')) as { id: number; p: number[] }[];
  expect(items).toHaveLength(3);
  for (const item of items) {
    await f.approach({ x: item.p[0], y: item.p[1] + .6, z: item.p[2] }, 3.6, KEY_R);
    const mark = f.messages.length;
    await f.use('pick', item.id);
    await expect.poll(() => f.messages.slice(mark).some(m => m.t === 'snap' && m.gone?.includes(item.id))).toBe(true);
    await expect.poll(() => f.page.evaluate(id => !(window.__escape.game() as any).items.some((i: any) => i.id === id), item.id)).toBe(true);
  }
  await expect.poll(() => f.latest('bag')?.bag?.fuse ?? 0).toBe(3);
  const box = await f.page.evaluate(() => window.__escape.game()!.level.def.blackout!.fuseBox);
  await f.go({ x: box.x, y: box.y, z: box.z - 1 });
  await f.aim({ ...box, y: box.y + .6 });
  for (let n = 1; n <= 3; n++) {
    await f.use('fuse', 0);
    await expect.poll(() => f.latest('power')?.n).toBe(n);
    await expect.poll(() => f.latest('bag')?.bag?.fuse ?? 0).toBe(3 - n);
  }
  expect(await f.page.evaluate(() => (window.__escape.game() as any).campus.blackout)).toBe(false);
  await f.checkpoint('L2-three-fuses-restored'); await f.photo('l2-powered');
}

async function enterDoor(f: Flow, label: string) {
  const d = await f.page.evaluate(label => window.__escape.game()!.level.def.loop!.doors.filter(d => d.label === label).at(-1)!, label);
  await f.go({ x: d.x, y: d.y, z: 84.2 });
  // Crossing the actual aperture is the puzzle action; toggling its door is insufficient.
  await f.walk([[d.x, d.z - 1], [d.x, 84.2]]);
}
export async function thirdChapter(f: Flow) {
  const def = await f.page.evaluate(() => window.__escape.game()!.level.def.loop!);
  await enterDoor(f, '302');
  await expect.poll(() => f.page.evaluate(() => window.__escape.game()!.loopPlayers.get(window.__escape.game()!.myId))).toMatchObject({ step: 0, mistakes: 1 });
  // Cross the loop seam on foot, observe a real warp and preserve the correction count.
  await f.go({ x: 20.2, y: 7.2, z: 84.2 });
  const mark = f.messages.length, corrections = (await f.state()).corrections;
  await f.page.evaluate(() => { const g = window.__escape.game()!; g.input.yaw = Math.PI / 2; g.input.press('KeyW'); });
  try { await expect.poll(() => f.messages.slice(mark).some(m => m.t === 'warp')).toBe(true); }
  finally { await f.page.evaluate(() => window.__escape.game()!.input.release('KeyW')); }
  expect((await f.state()).corrections).toBe(corrections);
  for (const [i, label] of def.sequence.entries()) {
    await enterDoor(f, label);
    await expect.poll(() => f.page.evaluate(() => window.__escape.game()!.loopPlayers.get(window.__escape.game()!.myId)?.step)).toBe(i + 1);
  }
  await f.checkpoint('L3-real-door-sequence-and-warp'); await f.photo('l3-loop-solved');
}

export async function fourthChapter(f: Flow) {
  const def = await f.page.evaluate(() => window.__escape.game()!.level.def.broadcast!);
  // First observe an ordinary roll call while standing next to a real shield. No schedule/time manipulation.
  const h = await f.page.evaluate(() => window.__escape.game()!.level.def.hides[0]);
  await f.go({ x: h.x, y: h.y ?? 0, z: h.z - .8 });
  await f.aim({ x: h.x, y: (h.y ?? 0) + 1, z: h.z });
  await expect.poll(() => f.latest('broadcast')?.call?.id ?? 0, { timeout: 95_000, intervals: [100] }).toBe((await f.state()).id);
  expect(f.latest('broadcast')?.call?.shielded).toBe(false);
  await f.use('hide', 0);
  await expect.poll(() => f.page.evaluate(() => window.__escape.game()!.hiding)).toBe(0);
  await expect.poll(() => f.latest('broadcast')?.call?.shielded).toBe(true);
  expect(f.latest('broadcast')?.call?.p).toBeUndefined();
  await f.photo('l4-natural-call-shielded');
  // Leaving a hide is a player action. The mobile path uses the actual visible interaction button for exit only;
  // every world prop (clue/keypad/item) below still requires a direct object tap.
  if (f.mode === 'mobile') await f.page.locator('.touch-btn.main').tap();
  else await f.page.keyboard.press('KeyE');
  await expect.poll(() => f.page.evaluate(() => window.__escape.game()!.hiding)).toBe(-1);
  for (const [id, s] of def.stickers.entries()) {
    await f.go({ x: s.x, y: s.y, z: s.z + (s.face === 'z+' ? .7 : -.7) });
    await f.aim({ x: s.x, y: s.y + 1.45, z: s.z });
    await f.use('sticker', id);
    await expect.poll(() => f.latest('broadcast')?.clues[id]).toMatch(/^\d$/);
    await f.checkpoint(`L4-read-sticker-${id + 1}`);
    if (id === 1) {
      // Revisit the reported 2/4 stance on foot in this same campaign and original WebSocket.
      await f.go({ x: -14, y: 7.2, z: 130 });
      const cabinet = await f.page.evaluate(() => window.__escape.game()!.level.def.landmarks.find(m => m.kind === 'hydrant')!);
      await f.aim({ x: cabinet.x, y: cabinet.y + 1.1, z: cabinet.z });
      await expect(f.page.locator('#goal-arrow .d')).toBeVisible();
      await expect(f.page.locator('#goal-arrow .d')).toContainText('贴纸④ · 4楼');
      f.note('L4-east-two-of-four-guidance', { cabinet, tag: await f.page.locator('#goal-arrow .d').innerText() });
      await f.photo('l4-east-two-of-four-wall-cabinet-and-guide');
    }
  }
  const answer = f.latest('broadcast')!.clues.join(''); expect(answer).toMatch(/^\d{4}$/);
  const at = def.console;
  await f.go({ x: at.x, y: at.y, z: at.z - .8 }); await f.aim({ ...at, y: at.y + 1.25 });
  await f.use('keypad', 0); await expect(f.page.locator('#broadcast-keypad')).toBeVisible();
  const submit = f.page.getByRole('button', { name: '确认停播', exact: true });
  const wrong = String((Number(answer) + 1) % 10000).padStart(4, '0');
  await f.page.getByLabel('四位停播密码').fill(wrong); await submit.click();
  await expect(f.page.locator('#broadcast-keypad')).toContainText('密码错误');
  expect(f.latest('broadcast')?.off).toBe(false);
  await f.page.waitForTimeout(1050);
  await f.page.getByLabel('四位停播密码').fill('');
  for (const d of answer) {
    const button = f.page.locator('.broadcast-digits').getByRole('button', { name: d, exact: true });
    if (f.mode === 'mobile') await button.tap(); else await button.click();
  }
  if (f.mode === 'mobile') await submit.tap(); else await submit.click();
  await expect.poll(() => f.latest('broadcast')?.off).toBe(true);
  await expect(f.page.locator('#broadcast-keypad')).toBeHidden();
  await f.checkpoint('L4-read-four-clues-and-stop-broadcast'); await f.photo('l4-broadcast-stopped');
}
