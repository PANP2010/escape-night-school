import type { CampaignMirrorSnap } from '../../shared/l7-campaign.ts';
import type { BroadcastSnap } from '../../shared/broadcast.ts';
import type { GymSnap } from '../../shared/gym.ts';
import type { ItemKind, LevelDef } from '../../shared/levels/def.ts';
import { loopSolved, type LoopProgress } from '../../shared/loop.ts';
import { L1_KEY_CLUE, l1Stage } from '../../shared/l1Objectives.ts';

type Bag = Partial<Record<ItemKind, number>>;

/** The level's goal as an ordered list of steps; `cur` is the first not yet done (= steps.length - 1 once only the exit is left). */
export interface Objective {
  steps: string[];
  cur: number;
  /** Objective items so far, e.g. 「保险丝 1/3」. */
  got: string;
  /** A specific label when these counts describe carried / installed items rather than total collection. */
  gotLabel?: string;
  /** Changes whenever the team makes progress (a key / fuse found or put in): the idle hint's clock restarts on a change. */
  key: string;
  /** Neutral nudges for the current step, shown in turn after IDLE_HINT_S without progress. */
  hints: string[];
  note?: string;
  target?: { x: number; y: number; z: number };
  personal?: true;
}

/** 45 s without objective progress: a neutral hint (not a 角色074 line). */
export const IDLE_HINT_S = 45;

/** The current objective of `def` given the shared bag and (停电关) the fuses in the box. */
export function objective(def: LevelDef, bag: Bag, fusesIn: number, state?: LoopProgress | BroadcastSnap | GymSnap | CampaignMirrorSnap, exam?: { answers: readonly (number | null)[]; passed: boolean }): Objective {
  const mirror = state && 't' in state && state.t === 'l7' ? state : undefined;
  const gym = state && 't' in state && state.t === 'gym' ? state : undefined;
  const station = state && 't' in state && state.t === 'broadcast' ? state : undefined;
  const progress = state && !('t' in state) ? state : undefined;
  const bo = def.blackout;
  const meet = `所有人到${def.exitName}集合`;
  if (def.gym) {
    const n = gym?.until.filter((t) => t > gym.now).length ?? 0, done = gym?.complete ?? false;
    return {
      steps: [`按齐4个记分牌开关（${gym?.solo === false ? '多人5秒内' : '单人各锁定20秒'}）`, meet], cur: done ? 1 : 0,
      got: done ? '四灯已亮 · 东门门禁解除' : def.gym.switches.map((s, i) => `${i + 1}${s.label}：${(gym?.until[i] ?? 0) > (gym?.now ?? 0) ? `亮 ${((gym?.until[i] ?? 0) - (gym?.now ?? 0)).toFixed(1)}秒` : '待按'}`).join(' / '),
      key: `${gym?.solo}/${gym?.until.join(',')}/${done}`,
      hints: done ? [meet] : [`已亮 ${n}/4，红灯可按，绿灯倒计时结束会熄灭`, '1在器材室，2在西侧篮架，3在北侧看台，4在记分台', '先各自就位再按，单人可按1→2→3→4；贴墙避开篮球，看着值日生'],
    };
  }
  if (def.exam) {
    const done = exam?.answers.filter((v) => v !== null).length ?? 0;
    const cur = exam?.passed ? 2 : done === 5 ? 1 : 0;
    return {
      steps: [`查阅4–5层门口公告，在4层考桌完成试卷 ${done}/5`, '回到4层考桌交卷（5题全对开门）', meet],
      cur,
      got: `全队共用试卷 ${done}/5${exam?.passed ? ' · 已通过' : ''}`,
      key: `exam/${done}/${exam?.passed ? 1 : 0}`,
      hints: [
        ['4层公告提供前3题线索，沿西南楼梯上5层查后2题线索', '试卷在4层高三(7)班讲台上；全队共享答案，可分工查公告'],
        ['填完不等于交卷：回到4层讲台打开试卷，点击交卷', '答错交卷会使本层熄灯10秒；先核对4层和5层的公告线索'],
        [`试卷通过了，所有存活队员到${def.exitName}集合`, '沿西南楼梯上5层，跟随出口标志集合'],
      ][cur],
    };
  }
  if (def.mirror) {
    const taken = !!mirror?.key.taken, first = !!mirror?.openDoors.includes(1), second = !!mirror?.openDoors.includes(2);
    const cur = !taken ? 0 : !first ? 1 : !second ? 2 : 3;
    return { steps: ['观察暗室镜中值日生的背后，趁空档取钥匙', '找到一楼镜中门，推开现实对应的墙', '到二楼标本室，从镜中找到第二道门', meet], cur,
      got: `镜中钥匙 ${taken ? 1 : 0}/1 · 密门 ${Number(first) + Number(second)}/2`, key: `${taken}/${first}/${second}`,
      note: '倒影延迟 0.6 秒；停住后 5 秒会出镜，背对镜子离开镜廊',
      hints: [['面对暗室镜子观察值日生背后的口袋，转身露出钥匙时按 E；不要直接盯着他'], ['镜中的门对应身后的柜墙，走近那面墙按 E 推开'], ['沿真实楼梯上二楼，再看标本室镜中的门，推开对应的墙'], ['两道密门已开，所有存活队友到二楼出口集合']][cur] };
  }
  if (def.broadcast) {
    const found = station?.clues.filter(c => c !== null).length ?? 0, cur = station?.off ? 2 : found < 4 ? 0 : 1;
    return { steps: [`阅读三、四楼编号贴纸 ${found}/4`, '到四楼广播室按编号输入密码，关闭广播', meet], cur,
      got: `贴纸 ${found}/4 · ${station?.clues.map(c => c ?? '□').join(' ') ?? '□ □ □ □'}`, key: `${found}/${station?.off ?? false}`,
      hints: [['贴纸贴在三、四楼走廊墙上，走近按 E 揭开；东侧楼梯通四楼'], ['四楼工会值班室改为广播室；按 ①②③④ 顺序输入数字'], ['广播停了，所有存活者到三楼东侧楼梯口集合']][cur] };
  }
  if (def.loop) {
    const p = progress ?? { step: 0, loops: 0, mistakes: 0 }, done = loopSolved(def, p);
    const next = def.loop.sequence[p.step], door = def.loop.doors.filter((d) => d.label === next).at(-1);
    return {
      steps: [`按黑板顺序进入 ${next ?? ''} 教室`, meet], cur: done ? 1 : 0,
      got: `门序 ${p.step}/${def.loop.sequence.length} · 回环 ${p.loops} 次`, personal: true,
      key: `${p.step}/${p.loops}/${p.mistakes}`,
      note: `${def.loop.sequence.join(' → ')} · ${done ? '你的循环已解除，等待队友' : '进教室后回走廊；错门重来'}`,
      hints: done ? [`你的循环已解除，到${def.exitName}等队友`] : ['黑板在起点走廊墙上，门牌标在教室门上方', '开门后要走进教室，再退回走廊；每个人都要完成门序'],
      // Lead inside the room: the capsule must cross the real threshold to advance.
      ...(door ? { target: { x: door.x, y: door.y, z: door.z - 0.95 } } : {}),
    };
  }
  if (bo) {
    const n = bo.fuses, found = Math.min(n, fusesIn + (bag.fuse ?? 0));
    const cur = found < n ? 0 : fusesIn < n ? 1 : 2;
    return {
      steps: [`找齐保险丝 ${found}/${n}`, `把保险丝插进走廊配电箱 ${fusesIn}/${n}`, meet],
      cur,
      got: `包里 ${bag.fuse ?? 0} · 已插 ${fusesIn}/${n}`,
      gotLabel: '保险丝',
      key: `${found}/${fusesIn}`,
      note: '盯住无脸值日生，它就不会动',
      hints: [
        ['保险丝在教室讲台的抽屉里，一间间找过去', '还没找过的教室，讲台抽屉也看一眼'],
        ['配电箱挂在走廊中段的墙上，亮着红灯，走近就能插保险丝', '把包里剩下的保险丝送到走廊中段的配电箱'],
        [`门禁有电了，所有人到${def.exitName}`, `${def.exitName}要所有人都到齐才能走`],
      ][cur],
    };
  }
  const stage = l1Stage(bag), cur = stage === 'exit' ? 2 : stage === 'stair_key' ? 1 : 0;
  const drawer = (bag.drawer_key ?? 0) > 0, stair = (bag.stair_key ?? 0) > 0;
  return {
    steps: ['找到抽屉钥匙', '打开上锁讲台抽屉，取出楼梯钥匙', meet],
    cur,
    got: `抽屉钥匙 ${drawer ? 1 : 0}/1 · 楼梯钥匙 ${stair ? 1 : 0}/1`,
    key: `${drawer ? 1 : 0}/${stair ? 1 : 0}`,
    note: cur === 0 ? L1_KEY_CLUE : `${L1_KEY_CLUE}；值日生醒了：看着它就停；队友被抓后可按住互动救援`,
    hints: [
      ['先在教室讲台上找抽屉钥匙，认准铜牌与齿口', L1_KEY_CLUE, '锁着的那几间没有讲台，不用急着开'],
      ['抽屉钥匙全队共享，到另一间教室寻找上锁的讲台抽屉', '走近上锁抽屉互动，就能取出楼梯钥匙'],
      [`钥匙到手了，所有人到${def.exitName}`, `${def.exitName}要所有人都到齐才能走`],
    ][cur],
  };
}

/** Banner text at the start of a level: the big title and the one-line goal. */
export const bannerFor = (def: LevelDef, o: Objective) => ({ title: def.name, goal: o.steps[o.cur] });

/** The always-on panel (top right): 「目标 n/m」 heading, the current step, the objective items. */
export const panelFor = (o: Objective) => ({ head: `目标 ${o.cur + 1}/${o.steps.length}`, goal: o.steps[o.cur], got: `${o.gotLabel ?? (o.personal ? '个人进度' : '已收集')}：${o.got}` });

/** Shows a hint after `after` s without progress (the objective key unchanged), then again every `after` s, cycling the hints. */
export class IdleHint {
  private since = 0;
  private key = '';
  private shown = 0;
  private readonly after: number;
  constructor(after = IDLE_HINT_S) { this.after = after; }
  /** A new level / a fresh start: the clock restarts. */
  reset(now: number, key = '') { this.since = now; this.key = key; this.shown = 0; }
  /** `now` in s. Returns the hint to show this tick, if any. */
  tick(now: number, o: Objective): string | undefined {
    if (o.key !== this.key) { this.reset(now, o.key); return undefined; }
    if (now - this.since < this.after || !o.hints.length) return undefined;
    this.since = now;
    return o.hints[this.shown++ % o.hints.length];
  }
}
