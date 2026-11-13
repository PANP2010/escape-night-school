import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { ST_DOWN, ST_OK, type ClientMsg, type PlayerSnap, type ServerMsg, type Vec3 } from '../shared/protocol.ts';
import { WARDEN_CATCH_R } from '../server/ai/warden.ts';
import { MONITOR_CATCH_R } from '../server/ai/monitor.ts';
import type { IntroEvent } from '../shared/intro.ts';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
type Room = Extract<ServerMsg, { t: 'room' }>;
export type Received = { at: number; m: ServerMsg };

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor(check: () => boolean, label: string, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await delay(20);
  }
  assert.fail(`Timed out: ${label}`);
}

/** A renderer-free client of the real /ws endpoint; it never injects server state. */
export class FeedbackPeer {
  readonly name: string;
  readonly socket: WebSocket;
  readonly opened: Promise<void>;
  readonly history: Received[] = [];
  readonly snapshots: Snap[] = [];
  readonly players = new Map<number, PlayerSnap>();
  id = 0;
  epoch = 0;
  seq = 0;
  tick = 0;
  room?: Room;
  intro?: IntroEvent;
  private readyIncarnation = 0;
  fault?: string;
  closing = false;

  constructor(name: string, url: string) {
    this.name = name;
    this.socket = new WebSocket(url, { handshakeTimeout: 8000 });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('error', (error) => { this.fault = error.message; });
    this.socket.on('close', (code) => { if (!this.closing) this.fault = `Unexpected close ${code}`; });
    this.socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMsg;
      this.history.push({ at: Date.now(), m });
      if (m.t === 'welcome') this.id = m.id;
      if (m.t === 'room') this.room = m;
      if (m.t === 'correct') this.epoch = m.c ?? this.epoch;
      if (m.t === 'event' && m.kind === 'intro') {
        this.intro = m;
        if (!m.ended) this.send({ t: 'intro-skip', id: m.id });
      }
      if (m.t === 'snap') {
        this.tick = m.tick;
        this.snapshots.push(m);
        for (const p of m.players) this.players.set(p.id, { ...this.players.get(p.id), ...p, st: p.st ?? ST_OK });
        const incarnation = this.room?.incarnation;
        if (incarnation && this.room?.started && this.state()?.st === ST_OK && this.readyIncarnation !== incarnation) {
          this.readyIncarnation = incarnation;
          this.send({ t: 'ready', incarnation });
        }
      }
    });
  }

  async connect() {
    await this.opened;
    await waitFor(() => this.id > 0, `${this.name}: welcome`);
    this.send({ t: 'hello', name: this.name });
    return this;
  }

  send(m: ClientMsg) {
    assert.equal(this.fault, undefined, `${this.name}: ${this.fault}`);
    assert.equal(this.socket.readyState, WebSocket.OPEN);
    this.socket.send(JSON.stringify(m));
  }

  mark() { return this.history.length; }
  messages(mark: number, type: ServerMsg['t']) { return this.history.slice(mark).filter(({ m }) => m.t === type); }
  state(id = this.id) { return this.players.get(id); }

  async waitMessage<T extends ServerMsg['t']>(mark: number, type: T, predicate: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, timeout = 10_000) {
    let found: Extract<ServerMsg, { t: T }> | undefined;
    await waitFor(() => {
      assert.equal(this.fault, undefined, `${this.name}: ${this.fault}`);
      found = this.history.slice(mark).map(({ m }) => m).find((m) => m.t === type && predicate(m as Extract<ServerMsg, { t: T }>)) as typeof found;
      return found !== undefined;
    }, `${this.name}: ${type}`, timeout);
    return found!;
  }

  async ticks(n = 5) {
    const target = this.tick + n;
    await waitFor(() => this.tick >= target, `${this.name}: ${n} authoritative ticks`);
  }

  look(yaw: number, pitch = 0, f = 0) {
    const p = this.state();
    assert.ok(p, `${this.name}: no authoritative position`);
    this.send({ t: 'input', seq: ++this.seq, p: p.p, c: this.epoch, yaw, pitch, f });
  }

  async teleport(x: number, z: number, floor = 0, snapshot = true) {
    const mark = this.mark();
    this.send({ t: 'debug', op: 'tp', x, z, floor });
    const correct = await this.waitMessage(mark, 'correct', (m) => m.forced === true);
    assert.ok(Math.hypot(correct.p[0] - x, correct.p[2] - z) < .08,
      `${this.name}: debug teleport refused; requested ${x},${z}, received ${correct.p}`);
    if (snapshot) await waitFor(() => Math.hypot(this.state()!.p[0] - x, this.state()!.p[2] - z) < .08, `${this.name}: teleport snapshot`);
  }

  async close() {
    this.closing = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.socket.once('close', () => resolve()));
    this.socket.close();
    await Promise.race([closed, delay(750)]);
    if (Number(this.socket.readyState) !== WebSocket.CLOSED) this.socket.terminate();
  }
}

/** Exact wire contract plus independent contact evidence from the same authoritative snapshot. */
export function assertPrivateCapture(message: ServerMsg, expected: { id: number; seq: number; by: 'warden' | 'monitor'; at?: Vec3 }, snapshots: Snap[]) {
  assert.equal(message.t, 'caught');
  if (message.t !== 'caught') throw new Error('Expected private capture');
  const m = message as Extract<ServerMsg, { t: 'caught' }> & { name?: string; mob?: number };
  assert.ok(Number.isSafeInteger(m.tick) && m.tick >= 0, 'Capture has a current snapshot tick');
  for (const [label, position] of [['at', m.at], ['source', m.source]] as const) {
    assert.ok(Array.isArray(position) && position.length === 3 && position.every(Number.isFinite), `${label} is a finite three-dimensional contact position`);
  }
  if (expected.at) assert.deepEqual(m.at, expected.at, 'Capture retains the authoritative contact position');
  if (m.name !== undefined) assert.ok(m.by === 'monitor' && m.name.trim().length > 0, 'Only a monitor supplies a display name');
  if (m.mob !== undefined) assert.ok(m.by === 'monitor' && Number.isSafeInteger(m.mob) && m.mob >= 2, 'The display name belongs to an actual monitor id');
  assert.deepEqual(m, { t: 'caught', id: expected.id, seq: expected.seq, tick: m.tick, hold: 30, by: expected.by,
    at: m.at, source: m.source, ...(m.name === undefined ? {} : { name: m.name }), ...(m.mob === undefined ? {} : { mob: m.mob }) }, 'Private capture retains its full exact contract');
  const snapshot = snapshots.find(s => s.tick === m.tick);
  assert.ok(snapshot, 'The contact tick agrees with the continuous snapshot clock');
  const mob = snapshot.mobs.find(mob => mob.id === (m.mob ?? (m.by === 'warden' ? 1 : 2)));
  assert.ok(mob, 'The actual catcher is present in the contact snapshot');
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(m.source[axis] - mob.p[axis]) <= 0.00501, 'Contact source matches the catcher, allowing snapshot rounding');
  assert.ok(Math.hypot(m.at[0] - m.source[0], m.at[2] - m.source[2]) <= (m.by === 'warden' ? WARDEN_CATCH_R : MONITOR_CATCH_R) + 1e-6, 'The actual catcher reached its contact radius');
  assert.ok(Math.abs(m.at[1] - m.source[1]) < 1.5, 'Contact stays on the same storey');
  return m;
}

export async function reviveWith(rescuer: FeedbackPeer, target: number, recipients: FeedbackPeer[]) {
  assert.notEqual(rescuer.id, target, 'A teammate must perform the rescue');
  assert.equal(rescuer.state()?.st, ST_OK, 'The rescuer must be active');
  for (const p of recipients) assert.equal(p.state(target)?.st, ST_DOWN, `${p.name}: rescue starts with the target down`);
  const marks = recipients.map((p) => p.snapshots.length);
  const startedTick = rescuer.tick;
  const started = Date.now();
  const send = () => rescuer.send({ t: 'act', kind: 'revive', id: target });
  send();
  let sendError: unknown;
  const timer = setInterval(() => { try { send(); } catch (error) { sendError = error; } }, 100);
  try {
    await waitFor(() => {
      if (sendError) throw sendError;
      for (const p of recipients) assert.equal(p.fault, undefined, `${p.name}: ${p.fault}`);
      return recipients.every((p) => p.state(target)?.st === ST_OK);
    }, 'held rescue reaches ST_OK on all real clients', 7000);
  } finally { clearInterval(timer); }
  assert.ok(Date.now() - started >= 2800, 'Rescue must require the full hold');
  assert.ok(rescuer.tick - startedTick >= 60, 'Rescue must require sixty authoritative ticks');
  for (const [i, p] of recipients.entries()) {
    let up = false;
    for (const s of p.snapshots.slice(marks[i])) {
      const state = s.players.find((q) => q.id === target);
      assert.ok(state, `${p.name}: rescue target stays present at tick ${s.tick}`);
      const st = state.st ?? ST_OK;
      assert.ok(st === ST_DOWN || st === ST_OK, `${p.name}: rescue never passes through spectator state`);
      if (up) assert.equal(st, ST_OK, `${p.name}: rescue cannot revert after reaching ST_OK`);
      if (st === ST_OK) up = true;
    }
    assert.ok(up, `${p.name}: a real authoritative snapshot confirms the rescue`);
  }
  return Date.now() - started;
}

/** Inspect every received snapshot so an eventual ST_OK cannot hide a transient spectator state. */
export function assertActiveSince(recipients: FeedbackPeer[], target: number, tick: number, minSamples = 40) {
  return recipients.map((p) => {
    assert.equal(p.fault, undefined, `${p.name}: ${p.fault}`);
    const samples = p.snapshots.filter((s) => s.tick >= tick);
    assert.ok(samples.length >= minSamples, `${p.name}: enough authoritative post-rescue samples`);
    for (const s of samples) {
      const victim = s.players.find((q) => q.id === target);
      assert.ok(victim, `${p.name}: rescued player remains present at tick ${s.tick}`);
      assert.equal(victim.st ?? ST_OK, ST_OK, `${p.name}: rescued player stays active at tick ${s.tick}`);
    }
    return { name: p.name, samples: samples.length, firstTick: samples[0].tick, lastTick: samples.at(-1)!.tick };
  });
}
