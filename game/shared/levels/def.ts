// Data-driven level parameters: shared/level.ts assembles a Level from one of these (a region of the campus).
export type ItemKind = 'stair_key' | 'drawer_key' | 'door_key' | 'battery' | 'fuse';

export interface Pt { x: number; z: number }
/** One connected part of an active campus route (feet height in metres). */
export interface AreaDef { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number }
/** A place an item can be hidden (world coordinates; `y` = height of the surface above the ground it rests on). */
export interface ItemSpotDef extends Pt { y: number; label: string }

/** A place a player can hide (E): inside a 储物柜 or under a 课桌; (x, z) is where they are pinned, `id` is its index in `LevelDef.hides`. */
export interface HideSpotDef extends Pt { kind: 'locker' | 'desk' | 'booth'; y?: number }

/** Something that physically closes a way out of the level's area (same box for the server's and client's colliders):
 *  a chained 铁栅门, a 堆叠课桌 pile or a 封条-taped pile. `face` = the side the players stand on (sign / prompt side). */
export interface BarrierDef { kind: 'grate' | 'desks'; x0: number; x1: number; z0: number; z1: number; y: number; h: number; face: 'x+' | 'x-' | 'z+' | 'z-'; say: string; tape?: boolean }
/** Wayfinding props: 粉笔箭头 on the floor pointing `dir`, a red 消火栓 cabinet on a wall facing `dir`, a hanging 门牌 (`text`)
 *  facing `dir`, a lit classroom (light pool + ceiling tube round the point) and a fallen desk lying against a wall, its top
 *  facing `dir` — the only one with a collider (fallenBox, server and client). */
export interface LandmarkDef extends Pt { kind: 'arrow' | 'hydrant' | 'sign' | 'lit' | 'fallen'; y: number; dir: 'x+' | 'x-' | 'z+' | 'z-'; text?: string }

export interface LevelDef {
  name: string;
  /** Campus building id and storeys (1 = ground floor) that are active in this level. */
  building: string;
  floors: number[];
  /** World-space box of the active region (x/z in m, y = feet height range); everything below must lie inside. */
  area: AreaDef;
  /** Optional union of narrow regions; `area` remains the overall map bounds. */
  regions?: AreaDef[];
  /** One spawn per player slot. */
  spawns: (Pt & { y?: number })[];
  /** Exit zone: standing within `r` (horizontally) of (x, z) at feet height ≈ y counts as being in it. */
  exit: Pt & { y: number; r: number };
  /** Where the exit is, as the objective HUD names it (「所有人到{exitName}集合」). */
  exitName: string;
  /** Extra locked door ids (wire ids of shared/campus/colliders.json doors), on top of the campus's keyed ones. */
  lockedDoors: number[];
  /** Mirror hall: delayed figures, reflected wall doors and one shared guard key. */
  mirror?: true;
  /** Endless corridor: each player must enter these numbered classrooms in order. */
  loop?: {
    sequence: string[];
    doors: { id: number; label: string; x: number; z: number; y: number; halfWidth: number }[];
    clue: Pt & { y: number };
    endX: number;
    corridorZ: number;
    shiftX: number;
  };
  /** 停电关: the whole level is dark (only the `emergency` exit lamps glow) and the exit's 门禁 stays shut until `fuses` fuses are put back in the box at `fuseBox`. */
  blackout?: { fuses: number; fuseBox: Pt & { y: number }; emergency: (Pt & { y: number })[]; };
  /** L4 midnight station. Positions use feet height; sticker digits are generated server-side per room seed. */
  broadcast?: {
    console: Pt & { y: number };
    stickers: (Pt & { y: number; label: string; face: 'z+' | 'z-' })[];
    interval: readonly [number, number];
    reveal: number;
  };
  /** Shared five-question paper. paper.y is the lectern surface; notice.y is its posted sheet's centre. */
  exam?: {
    paper: Pt & { y: number };
    notices: (Pt & { y: number; questions: number[]; dir: 'x+' | 'x-' | 'z+' | 'z-' })[];
    /** A local exit door: closed until the server accepts the paper; excluded from permanent levelSolids. */
    exitGate?: BarrierDef;
  };
  /** Final chapter: the office register starts a persistent pursuit along the outdoor escape route. */
  finale?: {
    rollcall: Pt & { y: number };
    chaseSpawn: Pt & { y: number };
    route: (Pt & { y: number })[];
    gate?: Pt & { y: number };
  };
  /** L5's authoritative scoreboard and rolling basketballs. */
  gym?: import('../gym.ts').GymDef;
  /** 无脸值日生 freeze while watched and hunt when not. `count` for solo, `teamCount` for 2–4 players (mob ids 2, 3, …).
   * `afterItem` gates their first appearance. Preferred `spawns` are used only when safely away from every spawn/player. */
  monitor?: { count: number; teamCount?: number; afterItem?: ItemKind; spawns?: (Pt & { y?: number })[] };
  /** Every way out of `area` other than the exit is shut by one of these (tests/unit/level_bounds.test.ts walks the area to check). */
  barriers: BarrierDef[];
  landmarks: LandmarkDef[];
  /** Hiding places (furniture centres of world/classroom.ts, in world coordinates). */
  hides: HideSpotDef[];
  /** Candidate item spots; `n` of them are drawn per seed, one item each. */
  items: { kind: ItemKind; n: number; spots: ItemSpotDef[]; decoy?: boolean; label?: string }[];
}
