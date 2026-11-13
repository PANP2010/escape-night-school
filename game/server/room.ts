// Authoritative rooms: membership, input validation, 20 TPS snapshots.
import { CROUCH_EYE_H, EYE_H, PLAYER_R, ROOM_CODE_ALPHABET, ROOM_CODE_LEN, SPEED, SPEED_TOLERANCE, maxPlayers } from '../shared/constants.ts';
import { barrierBox, exitOpen, generateLevel, hasLevel, inBounds, inExit, levelSolids, powered, LEVELS, type Level } from '../shared/level.ts';
import { enterLoopDoor, freshLoop, loopDestination, type LoopState } from '../shared/loop.ts';
import { type ActKind, ACT_DY, boxAt, HIDE_REACH, inReach, inReachDown, KEY_H, KEY_R } from '../shared/interact.ts';
export { HIDE_REACH };
import { DOOR_NOISE, DOOR_REACH, type DoorSnap, campusDoorSlab, type DoorSpot } from '../shared/doors.ts';
import { CollisionWorld, groundHeight, moveCapsule, overlaps, type AABB, type Body } from '../shared/campus/collision.ts';
import { lineOfSight, NAV_CAPSULE, walk } from '../shared/campus/nav.ts';
import { hears, moveKind, NOISE_RADIUS, NoiseBus, type NoiseKind, type NoiseEvent } from '../shared/noise.ts';
import campusData from '../shared/campus/colliders.json';
import { NavGraph } from '../shared/campus/nav.ts';
import { mulberry32 } from '../shared/rng.ts';
import { pickLine } from '../shared/lines.ts';
import { wardenBaseForm, wardenForm, wardenGazeOn, WardenStare, WARDEN_NIGHT_HEARING_MULTIPLIER, WARDEN_NIGHT_PATROL_MULTIPLIER } from '../shared/wardenForms.ts';
import { BATTERY_RUN_MUL, BATTERY_S, TICK_MS } from '../shared/constants.ts';
import { STAMINA_MIN, canRun, stepStamina } from '../shared/stamina.ts';
import { encode, F_CROUCH, F_HIDE, F_LIGHT, F_RUN, ST_DOWN, ST_OK, ST_SPECTATE, type CatchSource, type ClientMsg, type Bag, type WorldItem, type MobSnap, type PlayerSnap, type ServerMsg, type Vec3, type FinaleMember, type FinaleState, type CompletionStats } from '../shared/protocol.ts';
import { FLOOR_HEIGHT } from '../shared/campus/campus_schema.ts';
import { connectBlackoutCorridor } from '../shared/blackout-nav.ts';
import { TensionDirector, investigationGraph, investigationPoint } from './ai/tensionDirector.ts';
import { WardenAI, type WardenEnv, type WardenTarget } from './ai/warden.ts';
import { SEARCH_ANCHOR_LIMIT, SearchNavGraph, SearchPolicy, searchCanSee } from './ai/searchPolicy.ts';
import { evidenceRoute } from './ai/evidenceRoute.ts';
import { l4StairDoors } from './l4-nav.ts';
import { MidnightBroadcast, type BroadcastPlayer } from './broadcast.ts';
import { monitorDisplayName } from '../shared/studentNames.ts';
import { BLINK_S, MonitorAI } from './ai/monitor.ts';
import { BossAI } from './ai/role_boss.ts';
import type { AuthoritativeRun } from './leaderboard.ts';
import { isDeveloperName, type RoomOptions, type RunRanking } from '../shared/runMode.ts';
import { GymRuntime } from './gym.ts';
import { gymAreaNav } from './gym-nav.ts';
import { GYM_FLOOR, L5_INDEX } from '../shared/levels/l5.ts';
import { BALL_NOISE, BALL_TRIP_NOISE } from '../shared/gym.ts';
import { generateExam, gradeExam, type ExamQuestion } from '../shared/exam.ts';
import { L7_CAMPUS_DOORS, L7_INDEX, l7World } from '../shared/levels/l7.ts';
import type { CampaignMirrorClientMsg } from '../shared/l7-campaign.ts';
import { CampaignMirrors, type CampaignMirrorPlayer } from './l7-campaign.ts';
import { FinaleAI } from './ai/finale.ts';
import { createSpawnReady, isSpawnProtected, markSpawnReady, spendSpawnReady, type SpawnReadyState } from './spawn-ready.ts';
import { finaleAreaNav } from './finale-nav.ts';
import type { LobbySettings } from '../shared/lobby.ts';
import { IntroSession } from './intro.ts';
import type { ClearEvent } from '../shared/intro.ts';
import { selectSighting, sightingVisible, SIGHTING, type SightingPlan, type SightingViewer } from './ai/sighting.ts';
import { difficultyTeamSize, levelDifficulty, monitorUnlocked, safeMonitorStart } from '../shared/difficulty.ts';
import { difficultyMode, type DifficultyId } from '../shared/difficultyModes.ts';
import { l1PickState } from '../shared/l1Objectives.ts';
import { generateZonePhases, inRoyaleArea, ZONE_GRACE_S, ZONE_PHASE_S, ZONE_OUT_ELIM_S, inZone, type ZonePhase } from '../shared/royale.ts';

export interface Conn {
  id: number;
  name: string;
  send(m: ServerMsg): void;
  /** Send a pre-encoded message (broadcasts encode once). */
  sendRaw(s: string): void;
  room?: Room;
}

/** The campus colliders, built on the first room and shared by all of them (static; doors live in each room's doorWorld). */
let campus: CollisionWorld | undefined;
const sharedCampus = () => {
  if (!campus) {
    campus = new CollisionWorld(campusData.colliders as AABB[]);
    for (const h of campusData.holes) campus.addHole(h.x0, h.x1, h.z0, h.z1);
  }
  return campus;
};
/** 第 8 关 opens the middle gate leaf in this room only; every other room keeps the immutable campus collision world. */
function worldForLevel(level: Level, gateOpen = false): CollisionWorld {
  if (level.def.mirror) return l7World();
  if (!level.def.finale) return sharedCampus();
  const isGateLeaf = (b: AABB) => b.minX >= -4.81 && b.maxX <= 4.81 && b.minZ >= -8.2 && b.maxZ <= -7.8 && b.minY === 0 && b.maxY <= 1.6;
  const w = new CollisionWorld((campusData.colliders as AABB[]).filter((b) => !gateOpen || !isGateLeaf(b)));
  for (const h of campusData.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
  return w;
}
/** Claimed feet may sit this far above the ground under them (stair treads mid-step, small jumps), m. */
const CAMPUS_LIFT = 0.4;
/** Distance budget: a player may cover (allowed speed × SPEED_TOLERANCE) × MOVE_WINDOW_S + MOVE_BURST m in any window, so
 *  bunched / late packets pass while a 10 m teleport never does. */
export const MOVE_WINDOW_S = 1;
export const MOVE_BURST = 0.5;
/** A slide the chord check rejects is still fine if the server's own moveCapsule by the same delta lands this close (m). */
export const MOVE_SLACK = 0.15;
/** ms between two location markers from one player. */
export const PING_GAP_MS = 1000;
interface Player {
  conn: Conn;
  /** The slot remains reserved during the reconnect grace, but cannot act or be hunted. */
  offline?: boolean;
  /** Resumed connections must acknowledge the new epoch and use increasing input sequence numbers. */
  strictInputs?: boolean;
  lastSeq?: number;
  /** Spawn point index, kept for the whole stay: the lowest one free when they joined. */
  slot: number;
  p: Vec3;
  yaw: number;
  pitch: number;
  /** An input explicitly acknowledged the current correction epoch and supplied its camera direction. */
  cameraKnown?: boolean;
  f: number;
  st: number;
  /** Flashlight charge, 0..1; F_LIGHT only counts while > 0. */
  battery: number;
  stamina: number;
  exhausted: boolean;
  /** bat / sta as last put in a snap: they go out only when they change (the client keeps the last value). */
  sentF?: number;
  sentBat?: number;
  sentSta?: number;
  lastInput: number; // ms timestamp of last accepted input
  /** Movement budget (m) left in the sliding window, refilled at the allowed speed up to MOVE_WINDOW_S of it + MOVE_BURST; as of budgetAt (ms). */
  budget: number;
  budgetAt: number;
  /** Correction epoch: bumped by every `correct`; inputs still tagged with an older one were predicted from the stale spot. */
  c: number;
  loop: LoopState;
  /** Downed (st = ST_DOWN): the tick it turns into ST_SPECTATE unless a teammate revives them first. */
  heldUntil?: number;
  /** Monotonic for this connection, including after a level restart: capture presentation is once per real contact. */
  captureSeq?: number;
  /** Holding E on a downed teammate: who, since which tick, last refreshed at which tick. */
  reviving?: { id: number; since: number; seen: number };
  /** Hidden in `LevelDef.hides[id]`: where they stood before (the exit point) and whether Crouch was down on the last input. */
  hide?: { id: number; out: Vec3; crouch: boolean };
  /** Just revived / level (re)loaded: not prey for any mob before this tick (SAFE_S). */
  safeUntil?: number;
  escaped?: boolean;
  /** Personal loading / opening grace for this incarnation. Retained when the same player gets a new connection. */
  spawnReady?: SpawnReadyState;
}

/** Longest unassisted final chase. After the first extraction, everyone else gets 45 s; downed players still get the ordinary 30 s rescue hold. */
export const FINALE_CHASE_S = 180;
export const FINALE_RESCUE_S = 45;
export const ROLLCALL_R = 0.6;

/** Debug commands are accepted unless NODE_ENV=production (read per call so tests can flip it). */
export const debugEnabled = () => process.env.NODE_ENV !== 'production';

/** Royale zone timings. `ESCAPE_ZONE_GRACE_S` / `ESCAPE_ZONE_PHASE_S` shorten them so e2e need not wait minutes; ignored in production. */
export function royaleZoneTiming(env: NodeJS.ProcessEnv = process.env, debug = debugEnabled()) {
  const secs = (v: string | undefined, dflt: number) => { const n = Number(v); return debug && v !== undefined && Number.isFinite(n) && n >= 1 ? n : dflt; };
  return { graceS: secs(env.ESCAPE_ZONE_GRACE_S, ZONE_GRACE_S), phaseS: secs(env.ESCAPE_ZONE_PHASE_S, ZONE_PHASE_S) };
}

/** How long a caught player stays downed (waiting for a revive) before becoming a spectator, s. */
export const CAUGHT_HOLD_S = 30;
/** How long a teammate has to hold E on a downed player to get them up, s. */
export const REVIVE_S = 3;
/** A monitor can down one teammate at a time. The others get enough time for a full revive hold plus input latency. */
export const MONITOR_RESCUE_S = REVIVE_S + 0.5;
/** Grace after being revived or a level (re)load: mobs neither see nor catch the player, s (review #188). */
export const SAFE_S = 5;
/** After the start / a level load no mob hunts anyone for this long, s. Personal ready grace additionally covers slow
 * loaders after this room-wide opening. Debug 'warden' / 'monitor' summons end the room-wide opening. */
export const OPEN_GRACE_S = 15;
/** Mobs start (and 角色074 patrols) at least this far from every player spawn, m. */
export const SPAWN_CLEAR_M = 20;
/** 角色074's patrol keeps WARDEN_KEEP_OUT_M off the spawns this long after the start / a level load, s (outlasts OPEN_GRACE_S so the
 * first stretch of the level isn't him walking straight onto the spawn row the moment the grace ends). */
export const KEEP_OUT_S = 30;
/** 跳闸 (the floor's lights out, client CampusScene.out): `omen` s of stutter first, out for `off` [min, max] s; the first one
 * `first` s after the hunt opens, then every `every` s, and 角色074 breaking into a chase trips it (not within `chaseCool` s of the last) */
export const TRIP = { omen: 1.6, off: [5, 15] as const, first: [40, 80] as const, every: [80, 140] as const, chaseCool: 35 };
/** A revive hold is dropped when the client has not refreshed it for this many ticks (0.6 s: survives wifi jitter / TCP retransmits and frame hitches). */
const REVIVE_STALE_TICKS = 12;
/** Half-width (m) of the fuse box's use box. */
const FUSE_BOX_R = 0.6;
/** Black screen between levels (s). */
export const LEVEL_FADE_S = 3;
/** A wrong completed paper locks edits and blacks out the submitting floor for exactly ten seconds. */
export const EXAM_PENALTY_S = 10;

/** Warden's start node: same storey as the spawn, 25-40 m away (else the closest to that band). */
export function pickWardenStart(nav: NavGraph, sp: { x: number; z: number }, reach: number[], rng: () => number, others: readonly { x: number; z: number }[] = []): number {
  const y0 = nav.nodes[nav.nearest(sp.x, (sp as { y?: number }).y ?? 0, sp.z)].y;
  // distance to the nearest of all the spawns (a spawn row is ~8 m wide: 25 m from the first can be 17 m from the last)
  const d = (i: number) => Math.min(...[sp, ...others].map((q) => Math.hypot(nav.nodes[i].x - q.x, nav.nodes[i].z - q.z)));
  const floor = reach.filter((i) => Math.abs(nav.nodes[i].y - y0) < 1.5);
  const band = floor.filter((i) => d(i) >= 25 && d(i) <= 40);
  if (band.length) return band[Math.floor(rng() * band.length)];
  const pool0 = floor.length ? floor : reach, far = pool0.filter((i) => d(i) >= SPAWN_CLEAR_M);
  const pool = far.length ? far : pool0;
  return pool.reduce((a, b) => (Math.abs(d(b) - 32) < Math.abs(d(a) - 32) ? b : a));
}

/** Mob kind / form / st / target and player f are re-sent at least this often (ticks) even when unchanged. */
const MOB_KEY_TICKS = 20;

export class Room {
  readonly code: string;
  readonly difficulty: DifficultyId;
  readonly mode: 'campaign' | 'royale';
  readonly players = new Map<number, Player>();
  host = 0;
  /** False while the room waits in the lobby (only the host's `start` leaves it); the game doesn't tick and no snaps go out. */
  started = true;
  /** Real-server rooms: whoever joins after the start watches until the level ends (unit-test rooms keep everyone playing). */
  lateObserve = false;
  /** Discovery and late-join policy, assigned by the public lobby registry. */
  lobbySettings?: LobbySettings;
  levelIndex = 0;
  /** Server lifetime counter: same-seed wipes still start a new incarnation. */
  incarnation = 0;
  /** This level's opening roster; retries retain it so leaving cannot lower the challenge or refill supplies. */
  private difficultyPlayers = 1;
  private difficultyLocked = false;
  completed = false;
  seed: number;
  level: Level;
  tick = 0;
  /** Capture notification identity: never reset when this room changes / restarts a level. */
  private catchEpisode = 0;
  /** Network snapshots keep their regular cadence while the simulation clock pauses for the intro. */
  private snapTick = 0;
  private now = 0;
  /** Set by the real lobby start; observer policy alone does not create a cinematic session. */
  private introEnabled = false;
  private introEpoch = 0;
  private intro?: IntroSession;
  private clearEvent?: ClearEvent;
  private clearEpoch = 0;
  private levelStartedTick = 0;
  /** Level change in progress: the tick it completes at (everyone is frozen, screen black). */
  private advanceAt?: number;
  private restarting = false;
  emptySince = 0;
  /** Door state by id (see doorDefs); every door starts closed. */
  doorOpen: boolean[] = [];
  doorLocked: boolean[] = [];
  private doorDirty = new Set<number>();
  /** Items still lying in the world (drawn per seed by generateLevel; door keys are bound to the locked doors inside the area). */
  items: WorldItem[] = [];
  /** Ids picked up since the last snap. */
  private itemGone: number[] = [];
  /** The team's shared inventory: door ids whose key was found, and the other pick-ups by kind. */
  teamKeys = new Set<number>();
  bag: Bag = {};
  /** 停电关: fuses put back in the box so far (power is on at `fusesNeeded`). */
  fusesIn = 0;
  gym?: GymRuntime;
  private get simSeconds() { return this.tick * TICK_MS / 1000; }

  private gymPlayers() {
    return [...this.players.values()].filter((p) => p.st !== ST_SPECTATE)
      .map((p) => ({ id: p.conn.id, p: p.p, active: p.st === ST_OK && !p.hide }));
  }

  private resetGym() {
    const def = this.level.def.gym;
    this.gym = def ? new GymRuntime(def, this.simSeconds, {
      blocked: (x, z, r) => !inBounds(this.level, x, GYM_FLOOR, z) || [this.world, this.doorWorld, this.barrierWorld].some((w) =>
        w.query(x - r, z - r, x + r, z + r).some((b) => b.maxY > 0.08 && b.minY < 0.48 &&
          Math.hypot(x - Math.max(b.minX, Math.min(x, b.maxX)), z - Math.max(b.minZ, Math.min(z, b.maxZ))) < r)),
      noise: (p, r, id) => this.emitNoise(p[0], p[2], r, r === BALL_NOISE ? 'basketball' : 'item', p[1], id),
      sound: (e) => this.broadcast(e),
      trip: (id) => {
        const p = this.players.get(id);
        if (p) {
          p.reviving = undefined; p.f &= ~F_RUN; p.budget = 0; this.correct(p);
          // Only authoritative basketball contact can interrupt quiet pacing. Hearing still needs
          // range/occlusion, and sight must actually acquire the exposed player before a chase.
          this.hearWarden({ kind: 'item', x: p.p[0], y: p.p[1], z: p.p[2], r: BALL_TRIP_NOISE, src: id }, true);
        }
        if (this.gym) this.broadcast(this.gym.snapshot(this.simSeconds));
      },
    }) : undefined;
    this.gym?.switches.syncTeam(this.gymPlayers().map((p) => p.id));
  }
  private examQuestions: ExamQuestion[] = [];
  private examAnswers: (number | null)[] = [];
  private examPassed = false;
  private examRevision = -1;
  private examCooldownUntil = 0;
  private examBlackout?: { floor: number; until: number };
  private examFeedback = '';
  /** The doors of this room: the campus's (shared/campus/colliders.json). */
  doors: DoorSpot[] = [];
  /** Slabs of the closed doors (the shared campus world is static, so each room keeps its own). */
  private doorWorld = new CollisionWorld();
  private doorBox: number[] = [];
  /** The level's barriers (def.barriers: grates / desk piles across the ways out of its area); like the doors, per room. */
  private barrierWorld = new CollisionWorld();
  /** L4 shelters and L5 bleachers participate in the same capsule replay as the static campus. */
  private broadcastMoveWorld?: CollisionWorld;
  /** Doors leading out of the level's area: locked for good, no key opens them. */
  regionLocked = new Set<number>();
  /** Noise subscribers (monster AI): world position and audible radius in metres. */
  noiseListeners: ((x: number, z: number, r: number) => void)[] = [];

  /** The campus with capsule collision (shared/campus). */
  world: CollisionWorld;

  /** L7 shares this room's players, input authority and survival lifecycle. */
  mirrorCampaign?: CampaignMirrors;
  private mirrorPhysicsWorld?: CollisionWorld;

  /** 角色074 (rooms with a nav graph): server/ai/warden.ts state machine. */
  private warden?: WardenAI;
  /** One authoritative pacing clock per room; independent of Warden's movement/voice AI. */
  private readonly tension: TensionDirector;
  private wardenStare = new WardenStare();
  /** Debug 'safe' with mob 1: 角色074 has no prey before this tick. */
  private wardenOffUntil = 0;
  private monitorOffUntil = 0; // debug 'safe' mob 2
  /** 跳闸 (lights-out event): the running one (ticks) and when the next random / chase-triggered one may come */
  private trip?: { at: [number, number]; from: number; omen: number; off: number };
  private tripNext = 0;
  private tripCool = 0;
  private wardenChased = false;
  /** OPEN_GRACE_S: mobs have no prey before this tick (set at the start and at every level load). */
  private huntFrom = 0;
  /** KEEP_OUT_S: 角色074 keeps off the spawns before this tick (set with huntFrom). */
  private keepOutUntil = 0;
  /** 无脸值日生 (levels with `monitor`): server/ai/monitor.ts; rebuilt on every level load. Mob id = 2 + index. */
  private monitors: MonitorAI[] = [];
  private monitorIds: number[] = [];
  private boss?: BossAI;
  private monitorRetryAt = 0;
  private nav?: NavGraph;
  /** Campaign's bounded part of `nav`; royale uses the complete campus graph. */
  private areaNavs = new Map<number, NavGraph>();
  private navMsgs = new Map<number, ServerMsg>();
  private wardenEnv?: WardenEnv;
  /** Keep the authored patrol routes and ids, excluding only edges through locked doors. */
  private patrolNav?: { locks: string; graph: NavGraph };
  /** A level's static capsule routes change only when a locked door is unlocked. */
  private investigationNav?: { locks: string; graph: NavGraph; walkable: NonNullable<WardenEnv['walkable']> };

  private finaleAI?: FinaleAI;
  private finalePhase?: FinaleState['phase'];
  private finaleRevision = 0;
  private finaleSince = 0;
  /** Whole-run counters survive chapter transitions and automatic wipes. Explicit finale replay starts a new run. */
  private runSince = 0;
  /** Wall-clock start includes network stalls and cinematic transitions for public speedrun timing. */
  private runStartedAt?: number;
  private runStartedAtLevel: number;
  private runDebugUsed = false;
  private runMaxPlayers = 0;
  onRunComplete?: (run: AuthoritativeRun) => void;
  private runDownCounts = new Map<number, number>();
  private firstEscapeAt?: number;
  private finaleCompleted?: CompletionStats;
  private finaleReset = false;
  private finaleMembers = new Map<number, FinaleMember>();
  private finaleParticipants = new Set<number>();
  private finaleSignature = '';
  private finaleSentSecond = -1;
  private finaleHasStarted = false;
  private sightingFrom = 0;
  private sightingNext = 0;
  private sightingFinished = false;
  /** Bounded diagnostics are deliberately server-local; clients use the existing mob animation/position snapshots. */
  private sighting?: { plan: SightingPlan; phase: 'walk' | 'hold' | 'release'; next: number; startedAt: number;
    until: number; moved: boolean; said: boolean; exit: Vec3[]; retryAt: number };
  /** Only real sight observations and witnessed hide entrances, never a live wall-hidden player location. */
  readonly search = new SearchPolicy();
  private searchNav?: SearchNavGraph;
  private searchSource?: NavGraph;
  private lockedDoorWorld = new CollisionWorld();
  private searchArea = false;
  /** Rejected legacy follower proposals; observable in unit tests without adding game protocol/debug messages. */
  searchRecoveries = 0;
  private searchRestUntil = 0;
  private searchPatrolGraph = true;
  private searchAnchoredTarget = 0;
  private wardenTrail: Vec3[] = [];
  private followEvidenceUntil = 0;

  broadcastStation?: MidnightBroadcast;
  private broadcastFrom = 0;
  private broadcastLast = '';
  private stationPlayers(): BroadcastPlayer[] {
    return [...this.players.values()].filter(p => !p.offline).map(p => ({ id: p.conn.id, p: p.p, st: p.st, hidden: !!p.hide }));
  }
  private stationTime() { return (this.tick - this.broadcastFrom) * TICK_MS / 1000; }
  private resetStation() {
    this.broadcastStation = this.level.def.broadcast ? new MidnightBroadcast(this.level.def.broadcast, this.seed) : undefined;
    this.broadcastFrom = this.tick;
    this.broadcastLast = '';
  }
  private syncStation(to?: Conn) {
    const station = this.broadcastStation;
    if (!station) return;
    const m = station.snapshot(this.stationTime(), this.stationPlayers());
    if (to) { to.send(m); return; }
    const key = JSON.stringify(m);
    if (key !== this.broadcastLast) { this.broadcastLast = key; this.broadcast(m); }
  }
  private stepStation() {
    const station = this.broadcastStation;
    if (!station || this.advanceAt !== undefined) return;
    const now = this.stationTime(), players = this.stationPlayers();
    station.step(now, players);
    const call = station.snapshot(now, players).call;
    if (call?.p && this.tick % 10 === 0) this.hearWarden({ kind: 'item', x: call.p[0], y: call.p[1], z: call.p[2], r: 200, src: call.id });
    this.syncStation();
  }

  readonly guidance: boolean;
  readonly developerMode: boolean;
  readonly namedMonitors: boolean;
  /** Royale live player IDs. Only used in royale mode; tracks players in ST_OK (not spectate/down). */
  private royaleAlive = new Set<number>();
  /** Royale elimination order: id → rank (1 = winner, 2 = runner-up, …). */
  private royaleRank = new Map<number, number>();
  /** Royale zone phases (initial + shrink stages). */
  private royaleZones: ReadonlyArray<ZonePhase> = [];
  /** Current zone phase index (0 = initial, 1..4 = shrinks). */
  private royaleZonePhase = 0;
  /** Tick when the current zone phase started. */
  private royaleZonePhaseStart = 0;
  /** Cumulative seconds each player has been outside the zone (id → seconds). */
  private royaleOutTime = new Map<number, number>();
  /** Grace before the first shrink and length of each later phase (defaults unless a debug build overrides them). */
  private readonly zoneTiming = royaleZoneTiming();

  constructor(code: string, seed: number, nav?: NavGraph, initialLevel = 0, difficulty: DifficultyId = 'standard', options: RoomOptions = {}) {
    this.mode = options.mode ?? 'campaign';
    this.guidance = options.guidance !== false;
    this.developerMode = options.developerMode === true;
    this.namedMonitors = options.namedMonitors === true;
    this.runStartedAtLevel = initialLevel;
    this.code = code;
    this.difficulty = difficultyMode(difficulty).id;
    this.seed = seed;
    this.tension = new TensionDirector(seed);
    this.levelIndex = initialLevel;
    this.level = generateLevel(this.levelIndex, seed);
    this.world = worldForLevel(this.level);
    this.resetStation();
    this.resetExam();
    this.doors = campusData.doors as DoorSpot[];
    this.resetDoors();
    this.resetMirrors();
    if (nav?.nodes.length) {
      this.nav = nav;
      // start somewhere on the players' connected part of the level's area
      const area = this.wardenPatrolNav()!, sp = this.level.spawns[0], reach = [...area.reachable(area.nearest(sp.x, sp.y ?? 0, sp.z))];
      const rng = mulberry32(seed ^ 0x77616e67);
      const los = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
        lineOfSight(this.world, a, b) && lineOfSight(this.doorWorld, a, b) && lineOfSight(this.barrierWorld, a, b);
      // after a catch he walks off ≥ WARDEN_RETREAT_M from the spawns too (punish sends the caught player there)
      const avoid = () => this.level.spawns.map((q): Vec3 => [q.x, q.y ?? 0, q.z]);
      // the opening (#206): his patrol stays WARDEN_KEEP_OUT_M off the spawns and ignores noise there
      const keepOut = () => (this.tick < this.keepOutUntil || this.tick < this.searchRestUntil ? avoid() : []);
      this.wardenEnv = { graph: area, rng, los, walkable: (a, b) => {
        // Commit to a known detour while the direct pursuit segment remains blocked. Greedy sidesteps must not
        // erase that route and repeatedly lead back into the same furniture corner. Sight still uses real LOS.
        const w = this.warden;
        if (this.tick < this.followEvidenceUntil && w?.state === 'chase' && w.goal && !this.campusMoveOk(this.world, a, w.goal)) return false;
        return this.campusMoveOk(this.world, a, b);
      }, checkRouteSteps: !!this.level.def.exam, avoid, keepOut,
        hearingMultiplier: () => (wardenBaseForm(this.levelIndex) === 'night' ? WARDEN_NIGHT_HEARING_MULTIPLIER : 1) * difficultyMode(this.difficulty).hearing,
        patrolMultiplier: () => wardenBaseForm(this.levelIndex) === 'night' ? WARDEN_NIGHT_PATROL_MULTIPLIER : 1,
        speedMultiplier: () => difficultyMode(this.difficulty).monsterSpeed };
      const warden = new WardenAI(this.wardenEnv, pickWardenStart(area, sp, reach, rng, this.level.spawns));
      this.warden = warden;
      this.mobSent.clear();
      this.noise.subscribe((events) => { for (const ev of events) this.hearWarden(ev); });
    }
    this.resetSearchNav();
    if (this.warden && this.searchNav) {
      const sp = this.level.spawns[0], nav = this.searchNav;
      const reach = this.wardenSpawnReach(nav);
      this.warden.reset(pickWardenStart(nav, sp, reach, mulberry32(seed ^ 0x77616e67), this.level.spawns));
    }
    this.spawnMonitor();
  }

  private mirrorPlayers(): CampaignMirrorPlayer[] {
    return [...this.players.values()].filter(p => !p.hide).map(p => ({ id: p.conn.id, p: p.p, yaw: p.yaw, pitch: p.pitch, st: p.st }));
  }

  private resetMirrors() {
    this.mirrorCampaign = this.level.def.mirror ? new CampaignMirrors({
      los: (a, b) => this.mirrorLOS(a, b),
      move: (from, to, maxStep) => {
        const dx = to[0] - from[0], dz = to[2] - from[2], d = Math.hypot(dx, dz), k = d ? Math.min(1, maxStep / d) : 0;
        const body: Body = { x: from[0], y: from[1], z: from[2], vy: 0, grounded: true };
        // The capsule uses the same solids as the campaign's input validator, including ordinary campus doors.
        const world = this.mirrorMoveWorld();
        moveCapsule(world, body, dx * k, dz * k, TICK_MS / 1000, NAV_CAPSULE);
        const p: Vec3 = [body.x, body.y, body.z];
        return inBounds(this.level, ...p) ? p : from;
      },
      walkable: (a, b) => this.campusMoveOk(this.world, a, b),
    }) : undefined;
  }

  private mirrorLOS(a: Vec3, b: Vec3): boolean {
    const from = { x: a[0], y: a[1], z: a[2] }, to = { x: b[0], y: b[1], z: b[2] };
    return lineOfSight(this.world, from, to) && lineOfSight(this.doorWorld, from, to) && lineOfSight(this.barrierWorld, from, to);
  }

  private mirrorMoveWorld(): CollisionWorld {
    if (!this.mirrorPhysicsWorld) {
      this.mirrorPhysicsWorld = new CollisionWorld([...this.world.boxes, ...this.doorWorld.boxes, ...this.barrierWorld.boxes]);
      for (const h of this.world.holes) this.mirrorPhysicsWorld.addHole(...h);
    }
    return this.mirrorPhysicsWorld;
  }

  private syncMirrors(to?: Conn) {
    const m = this.mirrorCampaign?.snapshot(this.tick);
    if (m) { if (to) to.send(m); else this.broadcast(m); }
  }

  private actMirror(pl: Player, kind: CampaignMirrorClientMsg['kind'], id: number): boolean {
    const puzzle = this.mirrorCampaign;
    if (!puzzle) return false;
    const p: CampaignMirrorPlayer = { id: pl.conn.id, p: pl.p, yaw: pl.yaw, pitch: pl.pitch, st: pl.st };
    const changed = kind === 'mirror-key' ? id === 0 && puzzle.takeKey(p) : puzzle.push(p, id);
    if (!changed) return false;
    if (kind === 'mirror-push') {
      this.world = l7World([...puzzle.openDoors]);
      this.mirrorPhysicsWorld = undefined;
      this.areaNavs.delete(this.levelIndex);
      this.navMsgs.delete(this.levelIndex);
      const nv = this.navMsg();
      if (nv) this.broadcast(nv);
    }
    this.syncMirrors();
    return true;
  }

  /** Fill encounter slots only when progress permits and a safe reachable start exists. Never move an existing monitor. */
  private spawnMonitor(reset = true, immediate = false) {
    if (reset) {
      this.monitors = [];
      this.monitorIds = [];
      this.boss = undefined;
      this.monitorRetryAt = 0;
      for (const id of this.mobSent.keys()) if (id >= 2) this.mobSent.delete(id);
    }
    const nav = this.areaNav(), def = this.level.def.monitor;
    if (!nav || !def || !monitorUnlocked(def, this.bag)) return;
    const count = Math.max(0, levelDifficulty(this.levelIndex, this.level.def, this.difficultyPlayers).monitors);
    if (this.monitors.length + Number(!!this.boss) >= count) return;
    if (!immediate && this.tick < this.monitorRetryAt) return;
    this.monitorRetryAt = this.tick + 10;
    const sp = this.level.spawns[0], reach = [...nav.reachable(nav.nearest(sp.x, sp.y ?? 0, sp.z))];
    const players = [...this.players.values()].filter(p => !p.offline && p.st !== ST_SPECTATE).map(p => ({ x: p.p[0], y: p.p[1], z: p.p[2] }));
    const los = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
      lineOfSight(this.world, a, b) && lineOfSight(this.doorWorld, a, b) && lineOfSight(this.barrierWorld, a, b);
    const occupied = (i: number) => this.monitorIds.includes(2 + i) || this.boss?.id === 2 + i;
    const spawn = (i: number, n: { x: number; y: number; z: number }) => {
      const id = 2 + i;
      // The same seeded draw determines name, appearance, attacks and capture text for every peer and retry.
      if (this.namedMonitors && monitorDisplayName(this.seed, this.levelIndex, id) === '值周代号025') {
        this.boss = new BossAI([n.x, n.y, n.z], this.difficulty,
          (a, b) => los({ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }), id);
      } else {
        this.monitorIds.push(id);
        this.monitors.push(new MonitorAI({ graph: nav, los, speedMultiplier: difficultyMode(this.difficulty).monsterSpeed, walkable: (a, b) => this.campusMoveOk(this.world, a, b) }, [n.x, n.y, n.z]));
      }
    };
    if (this.levelIndex >= 2) {
      // Later chapters own authored elevated stands, exam summons and mirror controllers.
      for (let i = 0; i < count; i++) {
        if (occupied(i)) continue;
        const pin = def.spawns?.[i];
        const n = nav.nodes[pin ? nav.nearest(pin.x, pin.y ?? sp.y ?? 0, pin.z)
          : pickWardenStart(nav, sp, reach, mulberry32((this.seed ^ 0x6d6f6e69) + i * 7919), this.level.spawns)];
        spawn(i, n);
      }
      return;
    }
    for (let i = 0; i < count; i++) {
      if (occupied(i)) continue;
      const pin = def.spawns?.[i];
      const existing = [...this.monitors, ...(this.boss ? [this.boss] : [])].map(m => ({ x: m.p[0], y: m.p[1], z: m.p[2] }));
      const pool = reach.filter(j => Math.abs(nav.nodes[j].y - (sp.y ?? 0)) < 1.5 && safeMonitorStart(nav.nodes[j], this.level.spawns, players, existing));
      if (!pool.length) break; // everyone spread out: wait for space, instead of appearing beside a player
      const preferred = pin ? nav.nearest(pin.x, pin.y ?? sp.y ?? 0, pin.z) : undefined;
      const rng = mulberry32((this.seed ^ 0x6d6f6e69) + i * 7919);
      const n = nav.nodes[preferred !== undefined && pool.includes(preferred) ? preferred : pool[Math.floor(rng() * pool.length)]];
      spawn(i, n);
    }
  }

  resetDoors() {
    this.patrolNav = undefined;
    this.investigationNav = undefined;
    this.searchSource = undefined;
    const n = this.doors.length;
    this.doorOpen = new Array(n).fill(false);
    const lv = this.level;
    const mirrorDoors = new Set(lv.def.mirror ? L7_CAMPUS_DOORS.map(d => d.id) : []);
    for (const id of mirrorDoors) this.doorOpen[id] = true;
    this.regionLocked = new Set(this.doors.flatMap((d) => (inBounds(lv, d.x, d.y0 ?? 0, d.z) ? [] : [d.id])));
    this.doorLocked = this.doors.map((d) => !mirrorDoors.has(d.id) && (!!d.locked || lv.lockedDoors.includes(d.id) || this.regionLocked.has(d.id)));
    const keyed = this.doorLocked.flatMap((l, i) => (l && !this.regionLocked.has(i) ? [i] : []));
    let batteries = Math.ceil(levelDifficulty(this.levelIndex, this.level.def, this.difficultyPlayers).batteries * difficultyMode(this.difficulty).batteryMultiplier);
    this.items = this.level.items.flatMap((it) => {
      if (it.kind === 'battery' && batteries-- <= 0) return [];
      const base = { id: it.id, kind: it.kind, p: [it.x, it.y, it.z] as Vec3, ...(it.decoy ? { decoy: true } : {}), ...(it.label ? { label: it.label } : {}) };
      if (it.kind !== 'door_key') return [base];
      const door = keyed.shift(); // more keys than keyed doors: the extras are not placed
      return door === undefined ? [] : [{ ...base, door }];
    });
    this.itemGone = [];
    this.teamKeys.clear();
    this.bag = {};
    this.fusesIn = 0;
    this.doorDirty.clear();
    this.doorWorld = new CollisionWorld();
    this.doorBox = this.doors.map((d) => this.doorWorld.add(campusDoorSlab(d, this.doorOpen[d.id])));
    this.syncExamGate();
    this.broadcastMoveWorld = lv.def.broadcast || lv.def.gym ? new CollisionWorld([...this.world.boxes, ...levelSolids(lv.def)]) : undefined;
    if (this.broadcastMoveWorld) for (const h of this.world.holes) this.broadcastMoveWorld.addHole(...h);
    if (lv.def.gym) {
      const id = lv.def.gym.equipmentDoor;
      this.doorLocked[id] = false;
      this.doorOpen[id] = true;
      this.doorWorld.move(this.doorBox[id], campusDoorSlab(this.doors[id], true));
    }
    this.resetGym();
    this.mirrorPhysicsWorld = undefined;
    this.refreshLockedDoors();
  }

  private activePlayerCount(): number {
    return [...this.players.values()].filter((p) => p.st === ST_OK).length;
  }

  /** One sensing boundary for physical sounds and genuine broadcast reveals; grace applies to both. */
  private hearWarden(ev: NoiseEvent, impact = false) {
    if (this.sighting || this.tick < this.huntFrom || this.tick < this.wardenOffUntil || this.tick < this.searchRestUntil
      || (!impact && !this.tension.hears(this.directorTime(), ev.src))) return;
    const source = ev.src === undefined ? undefined : this.players.get(ev.src);
    if (ev.src !== undefined && (!source || !this.canCatch(source))) return;
    if (impact && (!source || source.hide)) return;
    this.search.setPlayerCount(this.activePlayerCount());
    const w = this.warden;
    if (!w || w.state === 'chase' || w.state === 'catch' || w.retreating) return;
    const sound = { ...ev, r: ev.r * this.search.difficulty.hearingMultiplier };
    const form = this.wardenEnv?.hearingMultiplier?.() ?? 1;
    const formRadius = Number.isFinite(form) && form > 0 ? form : 1;
    if (!hears({ ...sound, r: sound.r * formRadius }, w.p[0], w.p[1], w.p[2], this.noiseBlocked)) return;
    if (impact) this.tension.alert(this.directorTime(), source!.conn.id);
    // Hearing is actual evidence to plan through unlocked doors; a patrol's closed-door component is too small.
    if (this.searchPatrolGraph) { this.searchPatrolGraph = false; this.searchNav?.refresh(); }
    // Scale once at the room boundary; a form's WardenEnv hearing multiplier can multiply this independently.
    w.hear(sound, this.noiseBlocked);
  }

  private refreshLockedDoors() {
    this.lockedDoorWorld = new CollisionWorld(this.doors.filter((d) => this.doorLocked[d.id]).map((d) => campusDoorSlab(d, false)));
    this.searchNav?.refresh();
  }

  private resetSearchNav() {
    const area = this.areaNav();
    if (!area || !this.wardenEnv) return;
    this.searchArea = area.nodes.some((p) => inBounds(this.level, p.x, p.y, p.z));
    this.searchPatrolGraph = this.warden?.state !== 'chase' && this.warden?.state !== 'investigate';
    const source = this.searchArea ? (this.searchSource ??= investigationGraph(area,
      (a, b) => this.segmentClear([this.world], a, b) && this.feetOk(this.world, b))) : area;
    this.searchNav = new SearchNavGraph(source, (a, b) => !this.searchArea ||
      // The source already checked the immutable campus; only these room-owned solids can change on refresh.
      this.segmentClear([this.barrierWorld, this.searchPatrolGraph ? this.doorWorld : this.lockedDoorWorld], a, b), () => this.warden?.p,
      (a, b) => !this.searchArea || this.campusMoveOk(this.world, a, b));
    this.wardenEnv.graph = this.searchNav;
  }

  /** One stable set of capsule-checked area edges for both quiet approaches and evidence searches. */
  private wardenInvestigationNav() {
    const locked = this.doors.filter(d => (this.doorLocked[d.id] || this.regionLocked.has(d.id)) && !this.doorOpen[d.id]);
    const key = locked.map(d => d.id).join(',');
    if (!this.investigationNav || this.investigationNav.locks !== key) {
      const locks = new CollisionWorld(locked.map(d => campusDoorSlab(d, false)));
      const walkable = (a: Vec3, b: Vec3) => this.segmentClear([this.world, this.barrierWorld, locks], a, b) && this.feetOk(this.world, b);
      this.investigationNav = { locks: key, graph: investigationGraph(this.areaNav()!, walkable), walkable };
    }
    return this.investigationNav;
  }

  /** An unlocked classroom door must not shrink the safe spawn band to the tiny closed-door component. */
  private wardenSpawnReach(nav: SearchNavGraph): number[] {
    const patrol = this.searchPatrolGraph, sp = this.level.spawns[0];
    const far = (i: number) => this.level.spawns.every((s) => Math.hypot(nav.nodes[i].x - s.x, nav.nodes[i].z - s.z) >= SPAWN_CLEAR_M);
    this.searchPatrolGraph = true;
    nav.refresh();
    const closedReach = [...nav.reachable(nav.nearest(sp.x, sp.y ?? 0, sp.z))];
    if (closedReach.some(far)) {
      this.searchPatrolGraph = patrol;
      nav.refresh();
      return closedReach;
    }
    this.searchPatrolGraph = false;
    nav.refresh();
    const reach = [...nav.reachable(nav.nearest(sp.x, sp.y ?? 0, sp.z))];
    this.searchPatrolGraph = patrol;
    nav.refresh();
    if (!reach.some(far)) {
      // The old graph's `walk` can round furniture corners that its straight chord cannot. A smaller strict
      // component must never force a monster to spawn on the protected spawn row.
      const source = this.areaNav()!;
      const original = [...source.reachable(source.nearest(sp.x, sp.y ?? 0, sp.z))].filter((i) => {
        const n = source.nodes[i], p: Vec3 = [n.x, n.y, n.z];
        return Math.abs(n.y - (sp.y ?? 0)) < .5 && this.inPlayArea(...p) && far(i) && this.campusMoveOk(this.world, p, p);
      });
      if (original.length) return original;
    }
    return reach;
  }

  /** Royale keeps all campus routes; campaign cuts `nav` down to the current level's area. */
  private areaNav(): NavGraph | undefined {
    const nav = this.nav, lv = this.level;
    if (!nav) return undefined;
    if (this.mode === 'royale') return nav;
    let g = this.areaNavs.get(lv.index);
    if (!g) {
      g = lv.def.mirror ? mirrorAreaNav(nav, lv, this.mirrorMoveWorld()) : levelAreaNav(nav, lv);
      this.areaNavs.set(lv.index, g);
    }
    return g;
  }

  private wardenPatrolNav(): NavGraph | undefined {
    const source = this.areaNav();
    if (!source) return;
    const locked = this.doors.filter(d => (this.doorLocked[d.id] || this.regionLocked.has(d.id)) && !this.doorOpen[d.id]);
    const key = locked.map(d => d.id).join(',');
    if (this.patrolNav?.locks === key) return this.patrolNav.graph;
    const doors = new CollisionWorld(locked.map(d => campusDoorSlab(d, false))), graph = new NavGraph();
    graph.nodes.push(...source.nodes.map(n => ({ ...n })));
    graph.adj.push(...source.nodes.map(() => [] as number[]));
    for (let i = 0; i < source.nodes.length; i++) for (const j of source.adj[i]) {
      if (j <= i) continue;
      const a = source.nodes[i], b = source.nodes[j];
      if (this.segmentClear([doors], [a.x, a.y, a.z], [b.x, b.y, b.z])) graph.link(i, j);
    }
    this.patrolNav = { locks: key, graph };
    return graph;
  }

  /** areaNav() as a 'nav' message (the client's 目标箭头 runs A* on it), built once per level. */
  private navMsg(): ServerMsg | undefined {
    if (!this.guidance) return undefined;
    let m = this.navMsgs.get(this.level.index);
    if (!m) {
      const g = this.areaNav();
      if (!g) return undefined;
      m = { t: 'nav', n: g.nodes.flatMap((p) => [Math.round(p.x * 100), Math.round(p.y * 100), Math.round(p.z * 100)]), adj: g.adj.map((a) => [...a]) };
      this.navMsgs.set(this.level.index, m);
    }
    return m;
  }

  /** This tick's noise events; the monster AI subscribes (flushed once per step). */
  readonly noise = new NoiseBus();

  emitNoise(x: number, z: number, r: number, kind: NoiseKind = 'door', y = 0, src?: number) {
    if (this.introFrozen) return;
    for (const f of this.noiseListeners) f(x, z, r);
    this.noise.emit({ kind, x, y, z, r, src });
  }

  /** Is there a wall (or closed door) between two points? Muffles noise (shared/noise.ts hears). */
  noiseBlocked = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean => {
    const a = { x: ax, y: ay, z: az }, b = { x: bx, y: by, z: bz };
    return !lineOfSight(this.world, a, b) || !lineOfSight(this.doorWorld, a, b) || !lineOfSight(this.barrierWorld, a, b);
  };

  doorSnaps(ids?: Iterable<number>): DoorSnap[] {
    return [...(ids ?? this.doorOpen.keys())].map((id) => ({ id, open: this.doorOpen[id], locked: this.doorLocked[id] }));
  }

  /** The team now holds the key to locked door `id` (shared by everyone in the room). */
  giveKey(_pid: number, id: number) {
    this.teamKeys.add(id);
    this.broadcast({ t: 'keys', keys: [...this.teamKeys] });
  }

  /** Player `pl` picks up item `id` (E at the crosshair); needs reach. It is gone for everyone and goes into the team's bag. */
  private pickItem(pl: Player, id: number): boolean {
    const k = this.items.find((o) => o.id === id);
    const { min, max } = boxAt(k?.p ?? [0, 0, 0], KEY_R, KEY_H);
    if (!k || !inReach(pl.p, min, max)) return false;
    if ((this.levelIndex === 0 && l1PickState(k, this.bag) !== 'ready') || k.decoy) return false;
    this.difficultyLocked = true;
    this.items = this.items.filter((o) => o !== k);
    this.itemGone.push(k.id);
    if (k.kind === 'door_key' && k.door !== undefined) this.giveKey(pl.conn.id, k.door);
    else {
      this.bag = { ...this.bag, [k.kind]: (this.bag[k.kind] ?? 0) + 1 };
      this.broadcast({ t: 'bag', bag: this.bag });
    }
    this.emitNoise(pl.p[0], pl.p[2], NOISE_RADIUS.item, 'item', pl.p[1], pl.conn.id);
    this.broadcast({ t: 'activity', from: pl.conn.id, kind: 'pick', item: k.kind });
    this.spawnMonitor(false, true);
    return true;
  }

  /** R: one bag battery refills `pl`'s flashlight (not when it is already full). */
  private useBattery(pl: Player) {
    if (this.introFrozen) return;
    if (this.waitingForSpawn(pl) || (this.bag.battery ?? 0) < 1 || pl.battery >= 1 || pl.st !== ST_OK) return;
    pl.battery = 1;
    this.bag = { ...this.bag, battery: (this.bag.battery ?? 0) - 1 };
    this.broadcast({ t: 'bag', bag: this.bag });
  }

  /** Light on drains the battery (faster while running); at 0 the light goes out server-side. */
  private drainBattery(pl: Player) {
    if (!(pl.f & F_LIGHT) || pl.st !== ST_OK) return;
    pl.battery = Math.max(0, pl.battery - (TICK_MS / 1000 / BATTERY_S) * (pl.f & F_RUN ? BATTERY_RUN_MUL : 1));
    if (pl.battery <= 0) pl.f &= ~F_LIGHT;
  }

  /** E at the 配电箱 of a 停电 level: one bag fuse goes in (needs reach; `id` is unused). The last one restores the power for everyone. */
  private insertFuse(pl: Player): boolean {
    const bo = this.level.def.blackout;
    if (!bo || this.fusesIn >= bo.fuses || (this.bag.fuse ?? 0) < 1) return false;
    const { min, max } = boxAt([bo.fuseBox.x, bo.fuseBox.y, bo.fuseBox.z], FUSE_BOX_R, KEY_H);
    if (!inReach(pl.p, min, max)) return false;
    this.bag = { ...this.bag, fuse: (this.bag.fuse ?? 0) - 1 };
    this.fusesIn++;
    this.broadcast({ t: 'bag', bag: this.bag });
    this.broadcast({ t: 'power', n: this.fusesIn });
    this.emitNoise(pl.p[0], pl.p[2], NOISE_RADIUS.item, 'item', pl.p[1], pl.conn.id);
    return true;
  }

  /** A level reload clears the paper and penalty; revisions stay monotonic to reject old in-flight edits. */
  private resetExam() {
    this.examQuestions = this.level.def.exam ? generateExam(this.seed) : [];
    this.examAnswers = this.examQuestions.map(() => null);
    this.examPassed = false;
    this.examRevision++;
    this.examCooldownUntil = 0;
    this.examBlackout = undefined;
    this.examFeedback = '请完成全部五道题后交卷。';
  }

  private examState(): Extract<ServerMsg, { t: 'exam' }> {
    const remaining = (until: number) => Math.max(0, (until - this.tick) * TICK_MS / 1000);
    const b = this.examBlackout;
    return { t: 'exam', answers: [...this.examAnswers], passed: this.examPassed, revision: this.examRevision,
      cooldown: remaining(this.examCooldownUntil), feedback: this.examFeedback,
      ...(b && b.until > this.tick ? { blackout: { floor: b.floor, seconds: remaining(b.until) } } : {}) };
  }

  /** Both movement and line-of-sight use the same authority-owned exam exit door. */
  private syncExamGate() {
    const solids = this.mode === 'royale' ? [] : levelSolids(this.level.def);
    const gate = this.mode === 'royale' ? undefined : this.level.def.exam?.exitGate;
    if (gate && !this.examPassed) solids.push(barrierBox(gate));
    this.barrierWorld = new CollisionWorld(solids);
  }

  /** A paper operation is valid only beside its real world surface, with no wall / door / barrier in between. */
  private atExamPaper(pl: Player): boolean {
    const paper = this.level.def.exam?.paper;
    if (!paper || pl.st !== ST_OK || pl.hide || (pl.f & F_HIDE) || this.advanceAt !== undefined) return false;
    const { min, max } = boxAt([paper.x, paper.y, paper.z], 0.45, 0.15);
    if (!inReach(pl.p, min, max)) return false;
    const eye = { x: pl.p[0], y: pl.p[1] + (pl.f & F_CROUCH ? CROUCH_EYE_H : EYE_H), z: pl.p[2] };
    const surface = { x: paper.x, y: paper.y + 0.06, z: paper.z };
    return [this.world, this.doorWorld, this.barrierWorld].every((w) => lineOfSight(w, eye, surface));
  }

  private exam(pl: Player, m: Extract<ClientMsg, { t: 'exam' }>) {
    if (!this.atExamPaper(pl)) return;
    if (m.revision !== this.examRevision || this.examPassed || this.tick < this.examCooldownUntil) {
      pl.conn.send(this.examState()); // resync a stale teammate without changing everyone else's paper
      return;
    }
    if (m.op === 'answer') {
      const q = this.examQuestions[m.question];
      if (!Number.isInteger(m.question) || !q || !Number.isInteger(m.choice) || m.choice < 0 || m.choice >= q.choices.length) return;
      if (this.examAnswers[m.question] === m.choice) {
        pl.conn.send(this.examState()); // acknowledge an idempotent retry without broadcasting a new revision
        return;
      }
      this.examAnswers[m.question] = m.choice;
      this.examRevision++;
      this.examFeedback = '答案已同步给全队。';
    } else if (m.op === 'submit') {
      if (this.examAnswers.length !== 5 || this.examAnswers.some((a) => a === null)) {
        pl.conn.send({ ...this.examState(), feedback: '还有题目未作答，请完成五道题后交卷。' });
        return;
      }
      this.examRevision++;
      this.examPassed = gradeExam(this.examQuestions, this.examAnswers);
      if (this.examPassed) {
        this.syncExamGate();
        this.examFeedback = '全部正确，出口已开启。请全队前往出口。';
      }
      else {
        this.examCooldownUntil = this.tick + Math.ceil(EXAM_PENALTY_S * 1000 / TICK_MS);
        this.examBlackout = { floor: Math.round(pl.p[1] / FLOOR_HEIGHT), until: this.examCooldownUntil };
        this.examFeedback = '答案有误，本层熄灯十秒。请核对门口线索后再交卷。';
        this.puzzleFailed();
        this.summonExamWarden(pl);
      }
    } else return;
    this.broadcast(this.examState());
  }

  /** Closest usable door first; stand on a real, collision-free nav node on its far side, never inside its slab. */
  private summonExamWarden(pl: Player) {
    const nav = this.areaNav(), warden = this.warden;
    if (!nav || !warden) return;
    const doors = this.doors.filter((d) => Math.abs((d.y0 ?? 0) - pl.p[1]) < ACT_DY && !this.regionLocked.has(d.id))
      .sort((a, b) => Math.hypot(a.x - pl.p[0], a.z - pl.p[2]) - Math.hypot(b.x - pl.p[0], b.z - pl.p[2]) || a.id - b.id);
    for (const d of doors) {
      const normal = d.alongX ? 2 : 0, centre = normal === 0 ? d.x : d.z;
      const side = pl.p[normal] < centre ? 1 : -1;
      const span = d.alongX ? [d.box.x0, d.box.x1] : [d.box.z0, d.box.z1];
      const candidates = nav.nodes.map((n, i) => ({ n, i })).filter(({ n, i }) => {
        const p: Vec3 = [n.x, n.y, n.z], along = d.alongX ? n.x : n.z;
        if (Math.abs(n.y - pl.p[1]) >= 0.5 || (p[normal] - centre) * side < NAV_CAPSULE.radius + 0.2
          || Math.hypot(n.x - d.x, n.z - d.z) > 4 || along < span[0] - 1 || along > span[1] + 1 || !nav.adj[i]?.length) return false;
        const body: Body = { x: n.x, y: n.y, z: n.z, vy: 0, grounded: true };
        if (!inBounds(this.level, n.x, n.y, n.z) || !this.feetOk(this.world, p)
          || Math.abs(n.y - groundHeight(this.world, n.x, n.z, NAV_CAPSULE.radius, n.y + NAV_CAPSULE.stepHeight)) > CAMPUS_LIFT
          || [this.world, this.doorWorld, this.barrierWorld].some((w) => overlaps(w, body, NAV_CAPSULE))) return false;
        // The node must have a real local escape into the nav graph, rather than an isolated or wall-crossing edge.
        return nav.adj[i].some((j) => { const q = nav.nodes[j]; return this.campusMoveOk(this.world, p, [q.x, q.y, q.z]); });
      }).sort((a, b) => Math.hypot(a.n.x - d.x, a.n.z - d.z) - Math.hypot(b.n.x - d.x, b.n.z - d.z) || a.i - b.i);
      const at = candidates[0]?.n;
      if (!at) continue;
      const p: Vec3 = [at.x, at.y, at.z];
      warden.forceChase(p, Math.atan2(pl.p[0] - p[0], pl.p[2] - p[2]) + Math.PI, pl.conn.id, pl.p, false);
      this.mobSent.delete(1);
      return;
    }
  }

  private stepExam() {
    if (!this.level.def.exam || !this.examCooldownUntil || this.tick < this.examCooldownUntil) return;
    this.examCooldownUntil = 0;
    this.examBlackout = undefined;
    this.examFeedback = '照明已恢复，请核对线索后重新交卷。';
    this.examRevision++;
    this.broadcast(this.examState());
  }

  /** Player `pl` holds E on a downed teammate (renewed on the client's network clock); needs reach and REVIVE_S of holding. */
  private revive(pl: Player, id: number): boolean {
    const o = this.players.get(id);
    if (!o || o.offline || pl.offline || o === pl || o.st !== ST_DOWN || pl.st !== ST_OK) return false;
    if (!inReachDown(pl.p, o.p, o.yaw)) return false;
    // A late renewal starts over even if the tick's stale-hold cleanup has not run yet.
    if (pl.reviving?.id !== id || this.tick - pl.reviving.seen > REVIVE_STALE_TICKS) pl.reviving = { id, since: this.tick, seen: this.tick };
    pl.reviving.seen = this.tick;
    return true;
  }

  /** Complete or drop each player's revive hold. */
  private stepRevives() {
    for (const pl of this.players.values()) {
      const r = pl.reviving;
      if (!r) continue;
      const o = this.players.get(r.id);
      if (!o || o.offline || pl.offline || o.st !== ST_DOWN || pl.st !== ST_OK || this.tick - r.seen > REVIVE_STALE_TICKS || !inReachDown(pl.p, o.p, o.yaw)) { pl.reviving = undefined; continue; }
      if (this.tick - r.since >= Math.ceil((REVIVE_S * 1000) / TICK_MS)) {
        o.heldUntil = undefined;
        o.st = ST_OK;
        o.safeUntil = this.tick + this.safeTicks;
        pl.reviving = undefined;
        this.broadcast({ t: 'activity', from: pl.conn.id, kind: 'revive' });
      }
    }
  }

  /** `act` message: every kind is distance-checked on the server (ACT_REACH). */
  act(pl: Player, kind: ActKind | 'revive_cancel' | CampaignMirrorClientMsg['kind'], id: number): boolean {
    if (kind === 'revive_cancel') {
      if (pl.reviving?.id === id) pl.reviving = undefined;
      return true;
    }
    if (this.introFrozen || pl.offline || this.completed || this.advanceAt !== undefined || pl.st !== ST_OK || pl.escaped || this.waitingForSpawn(pl)) return false;
    if (this.gym?.tripped(pl.conn.id, this.simSeconds)) return false;
    if (kind === 'gym-switch') {
      const s = this.level.def.gym?.switches[id];
      if (!s || !this.gym || pl.hide) return false;
      const box = boxAt([s.x, s.y, s.z], 0.44, 1.9);
      if (!inReach(pl.p, box.min, box.max)) return false;
      const eye = { x: pl.p[0], y: pl.p[1] + 1.4, z: pl.p[2] }, at = { x: s.x, y: s.y + 1.4, z: s.z };
      if (!lineOfSight(this.world, eye, at) || !lineOfSight(this.doorWorld, eye, at) || !lineOfSight(this.barrierWorld, eye, at)) return false;
      this.gym.switches.syncTeam(this.gymPlayers().map((p) => p.id));
      const ok = this.gym.press(id, this.simSeconds);
      if (ok) this.broadcast(this.gym.snapshot(this.simSeconds));
      return ok;
    }
    if (kind === 'mirror-push' || kind === 'mirror-key') return !pl.hide && this.actMirror(pl, kind, id);
    if (kind === 'rollcall') return this.crossOut(pl, id);
    if (kind === 'hide') return this.hideIn(pl, id);
    if (kind === 'unhide') return this.unhide(pl);
    if (kind === 'pick') return this.pickItem(pl, id);
    if (kind === 'fuse') return this.insertFuse(pl);
    if (kind === 'revive') return this.revive(pl, id);
    const d = this.doors[id];
    if (!d) return false;
    const y0 = d.y0 ?? 0;
    if (!inReach(pl.p, [d.box.x0, y0, d.box.z0], [d.box.x1, d.y1 ?? y0 + 3, d.box.z1])) return false;
    return this.toggleDoor(pl, id);
  }

  /** Enter hiding place `id` (index in the level's `hides`): needs HIDE_REACH, a free spot and not already hidden. Pins the player there. */
  hideIn(pl: Player, id: number): boolean {
    if (this.introFrozen) return false;
    const h = this.level.def.hides[id];
    if (!h || pl.hide || pl.escaped || this.waitingForSpawn(pl) || pl.st !== ST_OK || this.completed || this.advanceAt !== undefined || (h.y !== undefined && Math.abs(pl.p[1] - h.y) >= ACT_DY)) return false;
    if (Math.hypot(pl.p[0] - h.x, pl.p[2] - h.z) > HIDE_REACH) return false;
    for (const o of this.players.values()) if (o.hide?.id === id) return false;
    const out = pl.p;
    const w = this.warden, now = this.tick * TICK_MS / 1000;
    // Check the actual entry at the moment it happens too; a stale sight sample through a shut door is insufficient.
    if (w && this.wardenEnv && this.tick >= this.huntFrom && this.tick >= this.wardenOffUntil && this.tick >= this.searchRestUntil && !w.retreating && w.state !== 'catch'
      && this.tick >= (pl.safeUntil ?? 0) && searchCanSee(w.p, w.yaw, { id: pl.conn.id, p: out, yaw: pl.yaw, f: pl.f }, this.wardenEnv.los)
      && this.wardenEnv.los({ x: w.p[0], y: w.p[1] + 1, z: w.p[2] }, { x: h.x, y: (h.y ?? out[1]) + 1, z: h.z })) {
      this.search.observe(now, this.prey(), (t) => searchCanSee(w.p, w.yaw, t, this.wardenEnv!.los));
      if (this.search.witnessHide(pl.conn.id, [h.x, h.y ?? out[1], h.z], out, now) && this.searchNav) {
        // These are fixed, genuinely observed, walkable positions. Cached room nodes can stop at the door,
        // so put the remembered entrance itself on the search route, with a physical local connection.
        this.searchNav.anchor(out);
        this.searchNav.anchor(w.p);
      }
    }
    pl.hide = { id, out, crouch: true }; // Crouch must be released and pressed again to climb out
    pl.p = [h.x, h.y ?? out[1], h.z];
    pl.f = (pl.f & ~F_RUN) | F_HIDE;
    pl.reviving = undefined;
    this.correct(pl);
    return true;
  }

  /** Leave the hiding place (E or Crouch), back to where the player stood on the way in. */
  unhide(pl: Player): boolean {
    if (this.introFrozen) return false;
    if (!pl.hide) return false;
    pl.p = pl.hide.out;
    pl.hide = undefined;
    pl.f &= ~F_HIDE;
    this.search.forget(pl.conn.id);
    this.correct(pl);
    return true;
  }

  /** Toggle a door for player `pl`. Needs reach, an unlocked door, and nobody standing in the doorway when closing. */
  toggleDoor(pl: Player, id: number): boolean {
    if (this.introFrozen || this.completed || this.advanceAt !== undefined || pl.st !== ST_OK || pl.escaped || this.waitingForSpawn(pl)) return false;
    const d = this.doors[id];
    if (!d || Math.abs(pl.p[1] - (d.y0 ?? 0)) >= ACT_DY || Math.hypot(pl.p[0] - d.x, pl.p[2] - d.z) > DOOR_REACH) return false;
    if (this.doorLocked[id]) {
      if (this.regionLocked.has(id) || !this.teamKeys.has(id)) return false;
      this.doorLocked[id] = false; // the key unlocks it for everyone, then it opens below
      this.refreshLockedDoors();
    }
    if (this.doorOpen[id]) {
      const m = PLAYER_R + 0.1;
      for (const o of this.players.values()) {
        if (o.offline) continue;
        if (d.y0 !== undefined && Math.abs(o.p[1] - d.y0) > 1.2) continue;
        if (o.p[0] > d.box.x0 - m && o.p[0] < d.box.x1 + m && o.p[2] > d.box.z0 - m && o.p[2] < d.box.z1 + m) return false;
      }
      const w = this.warden;
      if (w && (d.y0 === undefined || Math.abs(w.p[1] - d.y0) <= 1.2)
        && w.p[0] > d.box.x0 - m && w.p[0] < d.box.x1 + m && w.p[2] > d.box.z0 - m && w.p[2] < d.box.z1 + m) return false;
    }
    this.doorOpen[id] = !this.doorOpen[id];
    this.doorWorld.move(this.doorBox[id], campusDoorSlab(d, this.doorOpen[id]));
    if (this.level.def.mirror) {
      this.mirrorPhysicsWorld = undefined;
      this.areaNavs.delete(this.levelIndex);
      this.navMsgs.delete(this.levelIndex);
      const nv = this.navMsg();
      if (nv) this.broadcast(nv);
    }
    this.doorDirty.add(id);
    // Door feedback is a discrete result; do not add up to one snapshot tick to its round trip.
    this.broadcast({ t: 'doors', doors: this.doorSnaps([id]) });
    this.searchNav?.refresh();
    this.emitNoise(d.x, d.z, DOOR_NOISE, 'door', d.y0 ?? 0, pl.conn.id);
    this.broadcast({ t: 'activity', from: pl.conn.id, kind: this.doorOpen[id] ? 'open' : 'close' });
    return true;
  }

  get full() { return this.players.size >= maxPlayers(this.mode); }

  private spawnPos(k: number): Vec3 {
    const sps = this.level.spawns, sp = sps[k % sps.length];
    return [sp.x, groundHeight(this.world, sp.x, sp.z, NAV_CAPSULE.radius, (sp.y ?? 0) + NAV_CAPSULE.stepHeight), sp.z];
  }

  /** Royale: distribute players across the full campus navgraph, ≥25m apart. */
  private royaleDistribute() {
    const graph = this.nav;
    if (!graph) return; // no nav: stay where they were initialized
    const players = [...this.players.values()];
    const rng = mulberry32(this.seed ^ 0x726f79); // 'roy' in hex
    const spawns: number[] = [];
    const nodes = graph.nodes;
    // Pick distinct nodes, each ≥25m from all prior picks and inside the first safe circle (nobody starts out of the zone).
    const first = this.royaleZones[0];
    for (let attempt = 0; spawns.length < players.length && attempt < 500; attempt++) {
      const i = Math.floor(rng() * nodes.length);
      const n = nodes[i];
      if (first && !inZone(n.x, n.z, first)) continue;
      if (spawns.every((j) => graph.dist(i, j) >= 25)) spawns.push(i);
    }
    // Assign players to spawn nodes (if we ran out of valid nodes, some will share).
    for (let k = 0; k < players.length; k++) {
      const pl = players[k], idx = spawns[k] ?? spawns[k % spawns.length];
      if (idx !== undefined) {
        const n = nodes[idx];
        pl.p = [n.x, n.y, n.z];
        pl.st = ST_OK;
        this.royaleAlive.add(pl.conn.id);
      }
    }
  }

  /** Royale: eliminate a caught player (instant spectate, no down/rescue). */
  private royaleEliminate(pl: Player) {
    if (!this.royaleAlive.has(pl.conn.id)) return; // already out
    this.royaleAlive.delete(pl.conn.id);
    const rank = this.royaleAlive.size + 1; // e.g. 3 still alive → eliminating 4th → rank 4
    this.royaleRank.set(pl.conn.id, rank);
    pl.st = ST_SPECTATE;
    this.broadcast({ t: 'royale-eliminated', id: pl.conn.id, rank, alive: this.royaleAlive.size });
    // Last survivor wins.
    if (this.royaleAlive.size === 1) {
      const winner = [...this.royaleAlive][0];
      this.royaleRank.set(winner, 1);
      this.royaleSettle();
    } else if (this.royaleAlive.size === 0) {
      // Everyone out simultaneously (unlikely, but handle it).
      this.royaleSettle();
    }
  }

  private royaleSettle() {
    this.broadcast({
      t: 'royale-settle',
      ranking: [...this.players.values()].map((p) => ({ id: p.conn.id, rank: this.royaleRank.get(p.conn.id) ?? 99 })),
    });
    this.completed = true;
  }

  /** Royale zone shrinkage and out-of-zone elimination. */
  private stepRoyaleZone() {
    if (this.royaleZones.length === 0 || this.completed) return;

    const elapsed = (this.tick - this.royaleZonePhaseStart) * TICK_MS / 1000;
    const graceOver = this.tick >= this.runSince + Math.ceil((this.zoneTiming.graceS * 1000) / TICK_MS);

    // Advance to next phase if current phase duration exceeded
    if (this.royaleZonePhase === 0 && graceOver) {
      this.royaleZonePhase = 1;
      this.royaleZonePhaseStart = this.tick;
    } else if (this.royaleZonePhase > 0 && this.royaleZonePhase < this.royaleZones.length - 1 && elapsed >= this.zoneTiming.phaseS) {
      this.royaleZonePhase++;
      this.royaleZonePhaseStart = this.tick;
    }

    const zone = this.royaleZones[this.royaleZonePhase];
    if (!zone) return;

    // Check each alive player
    for (const pl of this.players.values()) {
      if (!this.royaleAlive.has(pl.conn.id)) continue;
      const [x, , z] = pl.p;
      const inside = inZone(x, z, zone);

      if (inside) {
        // Inside zone: reset out timer
        this.royaleOutTime.set(pl.conn.id, 0);
      } else {
        // Outside zone: accumulate time
        const prev = this.royaleOutTime.get(pl.conn.id) ?? 0;
        const now = prev + TICK_MS / 1000;
        this.royaleOutTime.set(pl.conn.id, now);
        if (now >= ZONE_OUT_ELIM_S) {
          this.royaleEliminate(pl);
        }
      }
    }
  }

  /** Keep a caught player at the contact point for the CAUGHT_HOLD_S rescue window. */
  private punish(pl: Player, by: CatchSource, source: Vec3, mob?: number) {
    if (pl.st !== ST_OK) return;
    this.search.forget(pl.conn.id);
    const at: Vec3 = [...pl.p];
    const name = by === 'monitor' && mob !== undefined ? this.monitorName(mob) : undefined;
    // Publish the exact contact before correcting prediction; later snapshots round positions.
    pl.conn.send({ t: 'caught', id: pl.conn.id, seq: pl.captureSeq = (pl.captureSeq ?? 0) + 1, tick: this.snapTick,
      hold: CAUGHT_HOLD_S, by, at, source: [...source],
      ...(name === undefined ? {} : { mob, name }) });
    pl.loop = { ...pl.loop, armed: true, entering: undefined };
    pl.hide = undefined;
    pl.f &= ~(F_HIDE | F_CROUCH | F_RUN); // the downed avatar uses ground-level feet; a crouch flag would sink it 0.5 m
    pl.st = ST_DOWN;
    pl.reviving = undefined;
    this.mirrorCampaign?.forget(pl.conn.id);
    pl.heldUntil = this.tick + Math.ceil((CAUGHT_HOLD_S * 1000) / TICK_MS);
    this.recordDown(pl);
    this.correct(pl);
    const notice = encode({ t: 'team-caught', id: pl.conn.id, by, episode: ++this.catchEpisode, ...(name === undefined ? {} : { name }) });
    for (const other of this.players.values()) if (other !== pl && !other.offline) other.conn.sendRaw(notice);
  }

  add(conn: Conn, now: number) {
    this.now = Math.max(this.now, now);
    this.expireIntro(this.now);
    const existing = this.players.get(conn.id);
    if (existing) { // an internal transport rebind retains the same Player and its absolute grace deadline
      if (existing.conn !== conn) existing.conn.room = undefined;
      existing.conn = conn;
      conn.room = this;
      this.broadcastRoom();
      if (this.started) { this.correct(existing); this.sendState(conn); }
      return;
    }
    const used = new Set([...this.players.values()].map((q) => q.slot));
    let slot = 0;
    while (used.has(slot)) slot++; // someone left: reuse their spawn instead of stacking on a teammate
    const p = this.spawnPos(slot);
    // joining a level in progress: watch until it ends (loadLevel puts everyone back to ST_OK)
    const finaleObserver = !!this.level.def.finale && this.started && (this.advanceAt !== undefined || (this.finaleHasStarted && this.finalePhase !== 'rollcall'));
    const st = finaleObserver || (this.lateObserve && this.started) ? ST_SPECTATE : ST_OK;
    this.players.set(conn.id, { conn, slot, p, yaw: 0, pitch: 0, f: 0, st, battery: 1, stamina: 1, exhausted: false, lastInput: now, budget: MOVE_BURST, budgetAt: now, c: 0, loop: freshLoop() });
    this.recordRunTeamSize();
    if (this.level.def.finale && this.advanceAt === undefined && !this.finaleHasStarted) this.startFinaleAttempt(false);
    else if (this.level.def.finale && this.advanceAt === undefined && this.finalePhase === 'rollcall' && st === ST_OK) {
      // Lobby members and active test-room joins are part of this register; late spectators wait for the next attempt.
      this.finaleParticipants.add(conn.id);
      this.finaleMembers.set(conn.id, { id: conn.id, name: conn.name, crossedOut: false, status: 'playing', downs: this.runDownCounts.get(conn.id) ?? 0 });
    }
    if (!this.difficultyLocked) {
      this.difficultyPlayers = difficultyTeamSize(this.players.size);
      this.resetDoors();
      this.spawnMonitor();
    }
    conn.room = this;
    if (!this.host) this.host = conn.id;
    this.broadcastRoom();
    if (this.started) {
      if (this.level.def.loop) this.broadcast(this.loopMsg());
      this.sendState(conn, false);
      if (this.level.def.finale) this.broadcastFinale(true);
    }
  }

  /** Items, keys, bag and doors; after 'room' because the client builds its level on that message. */
  private sendState(to?: Conn, includeLoop = true) {
    const send = (m: ServerMsg) => (to ? to.send(m) : this.broadcast(m));
    send({ t: 'items', items: this.items });
    send({ t: 'keys', keys: [...this.teamKeys] });
    send({ t: 'bag', bag: this.bag });
    send({ t: 'power', n: this.fusesIn });
    if (this.level.def.exam) send(this.examState());
    send({ t: 'doors', doors: this.doorSnaps() });
    if (this.gym) send(this.gym.snapshot(this.simSeconds));
    if (includeLoop && this.level.def.loop) send(this.loopMsg());
    if (this.completed) send({ t: 'complete', level: this.levelIndex });
    const nv = this.navMsg();
    if (nv) send(nv);
    this.syncStation(to);
    this.syncMirrors(to);
    if (this.level.def.finale) {
      send(this.finaleMessage());
      if (this.finaleCompleted) send(this.finaleCompleted);
    }
    const tr = this.trip; // a late joiner walks into the running 跳闸
    if (tr) {
      const gone = (this.tick - tr.from) * TICK_MS / 1000;
      // During a fade the simulation pauses before stepTrip can retire an expired event.
      if (gone < tr.omen + tr.off) send({ t: 'trip', at: tr.at, omen: Math.max(0, tr.omen - gone), off: Math.max(0, tr.off - Math.max(0, gone - tr.omen)) });
    }
    if (this.advanceAt !== undefined) {
      const secs = Math.max(0, (this.advanceAt - this.tick) * TICK_MS / 1000);
      if (!this.restarting && this.clearEvent) send({ ...this.clearEvent, secs });
      send({ t: 'fade', secs, restart: this.restarting });
    }
    if (this.intro) send(this.intro.event(this.now));
  }

  private recordDown(pl: Player) {
    const n = (this.runDownCounts.get(pl.conn.id) ?? 0) + 1;
    this.runDownCounts.set(pl.conn.id, n);
    const member = this.finaleMembers.get(pl.conn.id);
    if (member) member.downs = n;
  }

  private finaleDowns(): number { return [...this.runDownCounts.values()].reduce((n, d) => n + d, 0); }

  private currentFinaleMembers(): FinaleMember[] {
    return [...this.finaleParticipants].flatMap((id) => {
      const member = this.finaleMembers.get(id);
      if (!member) return [];
      const pl = this.players.get(id);
      const status: FinaleMember['status'] = !pl ? member.status === 'escaped' ? 'escaped' : 'left' : pl.escaped ? 'escaped' : pl.st === ST_DOWN ? 'down' : pl.st === ST_SPECTATE ? 'out' : 'playing';
      member.status = status;
      return [{ ...member }];
    });
  }

  private finaleMessage(): FinaleState {
    return {
      t: 'finale', revision: this.finaleRevision, phase: this.finalePhase ?? 'rollcall',
      members: this.currentFinaleMembers(), elapsedMs: this.finaleCompleted?.elapsedMs ?? Math.max(0, (this.tick - this.finaleSince) * TICK_MS), downs: this.finaleDowns(),
      ...(this.finalePhase === 'chase' ? { remainingMs: Math.max(0, FINALE_CHASE_S * 1000 - (this.tick - this.chaseStartedAt) * TICK_MS) } : {}),
      ...(this.finalePhase === 'chase' && this.firstEscapeAt !== undefined ? { rescueMs: Math.max(0, FINALE_RESCUE_S * 1000 - (this.tick - this.firstEscapeAt) * TICK_MS) } : {}),
    };
  }

  private chaseStartedAt = 0;

  private broadcastFinale(force = false) {
    const msg = this.finaleMessage();
    const signature = JSON.stringify({ phase: msg.phase, members: msg.members, completed: !!this.finaleCompleted });
    const sec = Math.floor(this.tick / (1000 / TICK_MS));
    if (!force && signature === this.finaleSignature && sec === this.finaleSentSecond) return;
    if (signature !== this.finaleSignature) this.finaleRevision++, msg.revision = this.finaleRevision;
    this.finaleSignature = signature;
    this.finaleSentSecond = sec;
    this.broadcast(msg);
  }

  private startFinaleAttempt(preserveRun: boolean) {
    if (!preserveRun || !this.finaleHasStarted) {
      this.finaleSince = this.runSince;
      this.finaleMembers.clear();
      this.finaleParticipants.clear();
    }
    this.finaleCompleted = undefined;
    this.finalePhase = 'rollcall';
    this.firstEscapeAt = undefined;
    this.chaseStartedAt = 0;
    this.finaleSignature = '';
    this.finaleSentSecond = -1;
    for (const p of this.players.values()) {
      p.escaped = false;
      const old = this.finaleMembers.get(p.conn.id);
      if (!preserveRun && p.st === ST_SPECTATE) continue;
      const member: FinaleMember = { id: p.conn.id, name: p.conn.name, crossedOut: false, status: p.st === ST_DOWN ? 'down' : p.st === ST_SPECTATE ? 'out' : 'playing', downs: this.runDownCounts.get(p.conn.id) ?? (preserveRun ? old?.downs ?? 0 : 0) };
      this.finaleMembers.set(p.conn.id, member);
      this.finaleParticipants.add(p.conn.id);
    }
    this.finaleHasStarted = true;
    this.finaleAI = undefined;
    this.finaleRevision++;
  }

  /** E at the roll-call book: any standing participant can cross off a teammate, but never from afar or while down. */
  private crossOut(pl: Player, id: number): boolean {
    const def = this.level.def.finale, member = this.finaleMembers.get(id);
    if (!def || this.finalePhase !== 'rollcall' || pl.st !== ST_OK || pl.escaped || pl.hide || !this.finaleParticipants.has(pl.conn.id) || !member || member.crossedOut || member.status === 'left') return false;
    const { min, max } = boxAt([def.rollcall.x, def.rollcall.y, def.rollcall.z], ROLLCALL_R, 1.4);
    if (!inReach(pl.p, min, max)) return false;
    const eye = { x: pl.p[0], y: pl.p[1] + 1.5, z: pl.p[2] };
    const book = { x: def.rollcall.x, y: def.rollcall.y + 0.98, z: def.rollcall.z };
    if (![this.world, this.doorWorld, this.barrierWorld].every((w) => lineOfSight(w, eye, book))) return false;
    member.crossedOut = true;
    this.broadcastFinale(true);
    return true;
  }

  private finaleTargets() {
    return [...this.finaleParticipants].flatMap((id) => {
      const pl = this.players.get(id);
      return pl && pl.st === ST_OK && !pl.escaped && this.tick >= (pl.safeUntil ?? 0) ? [{ id, p: pl.p }] : [];
    });
  }

  /** Add the authored escape route as a navigable spine so the pursuer can follow the outdoor route through the school gate. */
  private finaleGraph(): NavGraph {
    const graph = new NavGraph(), base = this.areaNav(), def = this.level.def.finale!;
    const pos = (i: number): Vec3 => { const n = graph.nodes[i]; return [n.x, n.y, n.z]; };
    const clear = (a: number, b: number) => this.campusMoveOk(this.world, pos(a), pos(b));
    if (base) {
      const ids = base.nodes.map((n) => graph.addNode(n));
      base.adj.forEach((edges, i) => { for (const j of edges) if (j > i && clear(ids[i], ids[j])) graph.link(ids[i], ids[j]); });
    }
    const add = (p: { x: number; y: number; z: number }) => graph.addNode({ ...p, tag: 'finale' });
    const chain = (points: { x: number; y: number; z: number }[]) => {
      let previous = add(points[0]);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 1.5));
        for (let k = 1; k <= steps; k++) {
          const t = k / steps, next = add({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
          if (clear(previous, next)) graph.link(previous, next);
          previous = next;
        }
      }
    };
    chain(def.route);
    chain([def.chaseSpawn, def.route[1]]); // west corridor joins behind the register's doorway
    chain([{ x: def.rollcall.x, y: def.rollcall.y, z: def.rollcall.z + 1.45 }, def.route[0]]);
    for (const sp of this.level.spawns) add({ ...sp, y: sp.y ?? 0 });
    // Small visible joins connect the authored spine and campus chains without wall-cutting anchor links.
    for (let i = 0; i < graph.nodes.length; i++) for (let j = i + 1; j < graph.nodes.length; j++) {
      if (graph.dist(i, j) <= 3 && clear(i, j)) graph.link(i, j);
    }
    return graph;
  }

  private escapeGate(pl: Player) {
    // Stand in the shared exit circle beyond the school wall, not in the physical gate leaf.
    if (this.finalePhase !== 'chase' || pl.st !== ST_OK || pl.escaped || !this.finaleParticipants.has(pl.conn.id)) return;
    if (!inExit(this.level, pl.p[0], pl.p[1], pl.p[2])) return;
    pl.escaped = true;
    pl.f = 0;
    pl.reviving = undefined;
    this.firstEscapeAt ??= this.tick;
    this.correct(pl);
  }

  private completeFinale() {
    if (this.finalePhase === 'complete') return;
    this.finalePhase = 'complete';
    this.finaleRevision++;
    this.finaleCompleted = {
      t: 'completed', difficulty: this.difficulty, elapsedMs: Math.max(0, (this.tick - this.finaleSince) * TICK_MS), downs: this.finaleDowns(),
      ranking: this.runRanking(),
      namedMonitorsUnlocked: this.difficulty === 'nightmare' && this.runStartedAt !== undefined && this.runStartedAtLevel === 0 && !this.runDebugUsed && !this.developerMode,
      members: this.currentFinaleMembers().map(({ id, name, downs, status }) => ({ id, name, downs, escaped: status === 'escaped' })),
    };
    this.broadcastFinale(true);
    this.broadcast(this.finaleCompleted);
    if (this.runStartedAt !== undefined && this.finaleCompleted.members.some(member => member.escaped)) {
      try {
        this.onRunComplete?.({ difficulty: this.difficulty, elapsedMs: Math.max(0, this.now - this.runStartedAt),
          downs: this.finaleCompleted.downs, members: this.finaleCompleted.members,
          startedAtLevel: this.runStartedAtLevel, debugUsed: this.runDebugUsed, guidance: this.guidance,
          developerMode: this.developerMode, maxPlayers: this.runMaxPlayers });
      } catch (error) { console.error('未能记录离校成绩：', error); }
    }
  }

  /** Final level: roll-call gates the relentless chase; extracted players freeze safely, while downed/out/left members never block. */
  private finaleFlow() {
    if (!this.level.def.finale || this.finalePhase === 'complete' || this.advanceAt !== undefined) return;
    if (![...this.players.values()].some(p => !p.offline)) return;
    this.eliminateUnrescuableDowns();
    const members = this.currentFinaleMembers();
    if (this.players.size && ![...this.finaleParticipants].some((id) => this.players.has(id))) {
      if (members.some((m) => m.status === 'escaped')) this.completeFinale();
      else this.beginFade(true);
      return;
    }
    if (this.finalePhase === 'rollcall') {
      if (members.length && !members.some((m) => m.status === 'playing' || m.status === 'down') && members.some((m) => m.status !== 'left')) this.beginFade(true);
      else if (members.length && members.some((m) => m.status !== 'left') && members.every((m) => m.crossedOut || m.status === 'left')) {
        this.finalePhase = 'chase';
        this.chaseStartedAt = this.tick;
        for (const p of this.players.values()) if (p.st === ST_OK) p.safeUntil = this.tick;
        const f = this.level.def.finale;
        this.world = worldForLevel(this.level, true); // the office gate opens only when the chase begins
        const graph = this.finaleGraph();
        this.finaleAI = new FinaleAI({ graph, walkable: (a, b) => this.campusMoveOk(this.world, a, b) }, [f.chaseSpawn.x, f.chaseSpawn.y, f.chaseSpawn.z]);
        this.mobSent.delete(1);
        this.broadcastFinale(true);
      }
    } else if (this.finalePhase === 'chase') {
      for (const pl of this.players.values()) this.escapeGate(pl);
      const escaped = members.filter((m) => m.status === 'escaped').length;
      const elapsed = (this.tick - this.chaseStartedAt) * TICK_MS / 1000;
      if (this.firstEscapeAt !== undefined && (this.tick - this.firstEscapeAt) * TICK_MS >= FINALE_RESCUE_S * 1000) {
        for (const id of this.finaleParticipants) {
          const pl = this.players.get(id);
          if (pl && !pl.escaped && pl.st !== ST_SPECTATE) { pl.st = ST_SPECTATE; pl.heldUntil = undefined; }
        }
      }
      if (this.firstEscapeAt === undefined && elapsed >= FINALE_CHASE_S) {
        for (const id of this.finaleParticipants) {
          const pl = this.players.get(id);
          if (pl && !pl.escaped && pl.st !== ST_SPECTATE) { pl.st = ST_SPECTATE; pl.heldUntil = undefined; }
        }
      }
      const nowMembers = this.currentFinaleMembers();
      const stillActive = nowMembers.some((m) => m.status === 'playing' || m.status === 'down');
      if (!stillActive) {
        if (escaped > 0 || nowMembers.some((m) => m.status === 'escaped')) this.completeFinale();
        else if (members.length && members.some((m) => m.status !== 'left')) this.beginFade(true);
      }
    }
    this.broadcastFinale();
  }

  /** 跳闸: omen s of stutter, then the floor dark from `at` for off s (TRIP); every client plays the same event */
  private startTrip(at: [number, number], off: number) {
    const r = Math.round;
    this.trip = { at: [r(at[0] * 10) / 10, r(at[1] * 10) / 10], from: this.tick, omen: TRIP.omen, off };
    this.broadcast({ t: 'trip', at: this.trip.at, omen: TRIP.omen, off });
    const end = this.tick + Math.ceil(((TRIP.omen + off) * 1000) / TICK_MS);
    this.tripCool = end + Math.ceil((TRIP.chaseCool * 1000) / TICK_MS);
    this.tripNext = end + Math.ceil(((TRIP.every[0] + this.tripRng() * (TRIP.every[1] - TRIP.every[0])) * 1000) / TICK_MS);
  }
  private tripRng = mulberry32(0);

  /** Debug cancellation consumes an already summoned chase, without letting the clock retrigger it immediately. */
  private cancelTrip() {
    this.trip = undefined;
    this.wardenChased = this.warden?.state === 'chase';
    const until = this.tick + Math.ceil((TRIP.chaseCool * 1000) / TICK_MS);
    this.tripCool = Math.max(this.tripCool, until);
    this.tripNext = Math.max(this.tripNext, until);
    this.broadcast({ t: 'trip', at: [0, 0], omen: 0, off: 0 });
  }

  private directorTime() { return this.tick * TICK_MS / 1000; }
  /** Sightings and natural breaker trips share the director's room-wide budget. */
  private scareReady(now = this.directorTime()) { return this.tension.scareReady(now); }
  private takeScare(now = this.directorTime()) { return this.tension.takeScare(now); }

  private sightingViewers(): SightingViewer[] {
    return [...this.players.values()].filter(p => !p.offline).map(p => ({ id: p.conn.id, p: p.p, yaw: p.yaw, pitch: p.pitch, f: p.f,
      eyeHeight: p.st === ST_DOWN ? .55 : p.hide ? this.level.def.hides[p.hide.id]?.kind === 'desk' ? .4 : 1.45 : undefined,
      canWitness: this.canCatch(p) && !p.hide }));
  }

  private sightingLos = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
    this.wardenEnv!.los(a, b) && lineOfSight(this.barrierWorld, a, b);

  /** Test the whole segment: safe endpoints alone can still cut through a nearby player's clearance. */
  private sightingDistant(a: Vec3, b: Vec3, viewers: readonly SightingViewer[], distance = SIGHTING.minDistance): boolean {
    const dx = b[0] - a[0], dz = b[2] - a[2], length2 = dx * dx + dz * dz;
    return viewers.every(v => {
      const u = length2 ? Math.max(0, Math.min(1, ((v.p[0] - a[0]) * dx + (v.p[2] - a[2]) * dz) / length2)) : 0;
      return Math.hypot(a[0] + dx * u - v.p[0], a[2] + dz * u - v.p[2]) >= distance;
    });
  }

  /** A short, same-floor, capsule-checked walk away; inability to leave means remain harmless, never teleport out. */
  private sightingExit(viewers: readonly SightingViewer[]): Vec3[] {
    const w = this.warden!, g = this.areaNav()!;
    const point = (i: number): Vec3 => { const n = g.nodes[i]; return [n.x, n.y, n.z]; };
    const safe = (p: Vec3, distance: number) => viewers.every(v => Math.hypot(v.p[0] - p[0], v.p[2] - p[2]) >= distance);
    const starts = g.nodes.map((n, id) => ({ id, d: Math.hypot(n.x - w.p[0], n.z - w.p[2]) }))
      .filter(n => Math.abs(g.nodes[n.id].y - w.p[1]) < .35 && n.d <= 6)
      .sort((a, b) => a.d - b.d);
    const start = starts.find(n => this.sightingDistant(w.p, point(n.id), viewers) && this.campusMoveOk(this.world, w.p, point(n.id)));
    if (!start) return [];
    const open = new Set([start.id]), distance = new Map([[start.id, start.d]]), previous = new Map<number, number>();
    while (open.size) {
      let at = -1, best = Infinity;
      for (const id of open) if (distance.get(id)! < best) { at = id; best = distance.get(id)!; }
      open.delete(at);
      if (best > 35) break;
      const p = point(at);
      if (safe(p, 15) && !viewers.some(v => sightingVisible(v, p, this.sightingLos))) {
        const ids = [at];
        while (previous.has(ids[0])) ids.unshift(previous.get(ids[0])!);
        return ids.map(point);
      }
      for (const next of g.adj[at]) {
        const q = point(next), d = best + g.dist(at, next);
        if (Math.abs(q[1] - w.p[1]) > .35 || d >= (distance.get(next) ?? Infinity) || !this.sightingDistant(p, q, viewers)) continue;
        if (!this.campusMoveOk(this.world, p, q)) continue;
        distance.set(next, d); previous.set(next, at); open.add(next);
      }
    }
    return [];
  }

  /** Returns true while the room owns Warden, including a blocked safe exit. All expensive planning is at most 1 Hz. */
  private stepSighting(): boolean {
    const w = this.warden, env = this.wardenEnv;
    if (!w || !env || this.levelIndex !== 0) return false;
    const now = this.directorTime(), dt = TICK_MS / 1000;
    const viewers = this.sightingViewers();
    let s = this.sighting;
    if (!s) {
      const elapsed = now - this.sightingFrom;
      // Sixty seconds is the ordinary opening target. Unsafe viewpoints defer it instead of forcing a relocation.
      if (this.sightingFinished || now < this.sightingNext) return false;
      this.sightingNext = now + 1;
      const plan = selectSighting({ graph: this.areaNav()!, los: this.sightingLos,
        walkable: (a, b) => this.inPlayArea(...b) && this.campusMoveOk(this.world, a, b) },
      { level: 1, elapsed, players: viewers, warden: w, ready: this.started && !this.completed && this.advanceAt === undefined,
        scareReady: this.scareReady(now), protected: this.tick < this.keepOutUntil || this.tick < this.huntFrom
          || [...this.players.values()].some(p => !p.offline && (this.tick < (p.safeUntil ?? 0)
            || (p.spawnReady !== undefined && isSpawnProtected(p.spawnReady, this.tick)))),
        controlBusy: !!this.trip || this.tension.resting(now) || this.tick < this.wardenOffUntil
          || [...this.players.values()].some(p => !p.offline && (p.st === ST_SPECTATE || !p.cameraKnown)) });
      if (!plan || !this.takeScare(now)) return false;
      w.startSighting(plan.path[0], plan.yaw);
      this.sighting = s = { plan, phase: 'walk', next: 1, startedAt: now, until: 0, moved: false, said: false, exit: [], retryAt: now };
      // Publish the exact hidden entry first: walking on this tick could reduce a 3.1 m relocation below
      // the existing client's >3 m interpolation-collapse threshold before it receives its first snapshot.
      w.stepSighting(dt);
      return true;
    }
    // Unknown cameras and explicit protection keep a running performance harmless until its exit can be validated.
    if (this.tick < this.wardenOffUntil || [...this.players.values()].some(p => !p.offline && (this.tick < (p.safeUntil ?? 0)
      || (p.spawnReady !== undefined && isSpawnProtected(p.spawnReady, this.tick))
      || p.st === ST_SPECTATE || !p.cameraKnown))) {
      s.moved = false; w.stepSighting(dt); return true;
    }
    const path = s.phase === 'release' ? s.exit : s.plan.path;
    const destination = path[s.next];
    let next: Vec3 | undefined;
    if (destination) {
      const d = Math.hypot(destination[0] - w.p[0], destination[1] - w.p[1], destination[2] - w.p[2]);
      const u = d > 0 ? Math.min(1, s.plan.speed * dt / d) : 0;
      const p: Vec3 = [w.p[0] + (destination[0] - w.p[0]) * u, w.p[1] + (destination[1] - w.p[1]) * u, w.p[2] + (destination[2] - w.p[2]) * u];
      const safe = this.sightingDistant(w.p, p, viewers);
      if (safe && Math.abs(p[1] - w.p[1]) < .35 && this.campusMoveOk(this.world, w.p, p)) next = p;
      else if (s.phase === 'release') { s.exit = []; s.next = 0; }
      if (next && d <= s.plan.speed * dt + 1e-6) s.next++;
    }
    s.moved = !!next;
    w.stepSighting(dt, next, s.plan.speed, s.phase === 'hold' && s.plan.kind === 'peek');
    if (!s.said && now >= s.startedAt + .25) { w.saySighting(); s.said = true; }
    if (s.phase === 'walk' && s.next >= s.plan.path.length) { s.phase = 'hold'; s.until = now + s.plan.holdSeconds; }
    if (s.phase === 'hold' && now >= s.until) {
      s.phase = 'release'; s.next = 0; s.until = now + 20; s.retryAt = now;
      this.sightingFinished = true;
    }
    if (s.phase === 'release') {
      if (!s.exit.length && now >= s.retryAt) { s.exit = this.sightingExit(viewers); s.next = 0; s.retryAt = now + 1; }
      if (now >= s.until && viewers.every(v => Math.hypot(v.p[0] - w.p[0], v.p[2] - w.p[2]) >= 15)
        && !viewers.some(v => sightingVisible(v, w.p, this.sightingLos)) && w.endSighting()) this.sighting = undefined;
      else if (s.next >= s.exit.length) s.exit = []; // the team moved after planning: find another safe exit, never resume nearby
    }
    return true;
  }

  /** Per tick: 角色074 breaking into a chase or the random clock trips the breaker (not on a 停电关 still dark, nor in the opening grace) */
  private stepTrip() {
    // The exam owns a precise, floor-scoped penalty; random/chase trips cannot extend it.
    if (this.level.def.exam) return;
    const tr = this.trip;
    if (tr && this.tick >= tr.from + Math.ceil(((tr.omen + tr.off) * 1000) / TICK_MS)) this.trip = undefined;
    const w = this.warden, chase = w?.state === 'chase', rose = chase && !this.wardenChased;
    this.wardenChased = chase;
    if (this.trip || this.sighting || this.tick < this.huntFrom || !powered(this.level, this.fusesIn) || !this.scareReady()) return;
    const off = () => TRIP.off[0] + this.tripRng() * (TRIP.off[1] - TRIP.off[0]);
    if (rose && w && this.tick >= this.tripCool && this.takeScare()) return this.startTrip([w.p[0], w.p[2]], off());
    if (this.tick >= this.tripNext) {
      const pls = [...this.players.values()].filter((p) => !p.offline && p.st === ST_OK);
      const pl = pls[Math.floor(this.tripRng() * pls.length)];
      if (pl && this.takeScare()) this.startTrip([pl.p[0], pl.p[2]], off());
    }
  }

  /** A level's first 跳闸: TRIP.first s after the hunt opens, then TRIP.every apart */
  private resetTrip(index: number) {
    this.trip = undefined;
    this.wardenChased = false;
    this.tripRng = mulberry32((this.seed ^ 0x74726970) + index * 7919);
    this.tripCool = 0;
    this.tripNext = this.huntFrom + Math.ceil(((TRIP.first[0] + this.tripRng() * (TRIP.first[1] - TRIP.first[0])) * 1000) / TICK_MS);
  }

  /** Host leaves the lobby: everyone goes into level 1 (campaign) or distributes across campus (royale). */
  private start(now: number) {
    if (this.started) return;
    this.started = true;
    this.runSince = this.tick;
    this.runStartedAt = now;
    this.recordRunTeamSize();
    this.runDownCounts.clear();
    if (this.mode === 'royale') {
      // Royale: spawn across the whole campus (no level flow).
      this.royaleZones = generateZonePhases(this.seed);
      this.royaleZonePhase = 0;
      this.royaleZonePhaseStart = this.tick;
      this.royaleOutTime.clear();
      this.royaleDistribute();
      this.beginSpawnIncarnation();
      // `regionLocked` marks every door outside the (level-1) area as permanently locked, and resetDoors() at
      // construction time folded that into doorLocked. Royale spawns are spread over the whole campus, so drop both or
      // players are walled into their spawn rooms.
      this.regionLocked.clear();
      const mirrorDoors = new Set(this.level.def.mirror ? L7_CAMPUS_DOORS.map(d => d.id) : []);
      this.doorLocked = this.doors.map((d) => !mirrorDoors.has(d.id) && (!!d.locked || this.level.lockedDoors.includes(d.id)));
      this.refreshLockedDoors();
      // Arm the clients' pending startup before its spawn correction advances the input epoch.
      this.broadcastRoom();
      for (const pl of this.players.values()) this.correct(pl);
      this.sendState();
      return;
    }
    // Campaign mode starts level 1.
    if (this.level.def.finale) this.startFinaleAttempt(false);
    this.beginSpawnIncarnation();
    this.introEnabled = true;
    this.difficultyPlayers = difficultyTeamSize(this.players.size);
    this.difficultyLocked = true;
    this.resetDoors();
    this.spawnMonitor();
    this.huntFrom = this.tick + this.openTicks;
    this.keepOutUntil = this.tick + Math.ceil((KEEP_OUT_S * 1000) / TICK_MS);
    this.tension.reset(this.directorTime());
    this.resetTrip(this.levelIndex);
    this.sightingFrom = this.directorTime(); this.sightingNext = 0; this.sightingFinished = false; this.sighting = undefined;
    this.broadcastFrom = this.tick;
    // Preview rooms may have waited in the lobby: start the first-ball clock with gameplay.
    if (this.level.def.gym) this.resetGym();
    this.broadcastRoom();
    this.sendState();
    this.levelStartedTick = this.tick;
    this.beginIntro(now);
  }

  remove(conn: Conn, now: number) {
    if (this.players.get(conn.id)?.conn !== conn) return; // the replaced transport cannot remove the current player
    const member = this.finaleMembers.get(conn.id), pl = this.players.get(conn.id);
    if (member) member.status = pl?.escaped ? 'escaped' : 'left';
    this.now = Math.max(this.now, now);
    if (pl && this.mode === 'royale' && !this.completed) this.royaleEliminate(pl); // a leaver is out: keeps the alive count and the last-survivor win honest
    this.players.delete(conn.id);
    this.royaleOutTime.delete(conn.id);
    conn.room = undefined;
    this.warden?.forget(conn.id); // stop hunting a ghost
    this.mirrorCampaign?.forget(conn.id);
    this.search.forget(conn.id);
    this.wardenStare.forget(conn.id);
    this.lastPing.delete(conn.id);
    if (this.host === conn.id) this.host = [...this.players.values()].find(p => !p.offline)?.conn.id ?? 0;
    if (this.players.size === 0) this.emptySince = now;
    else {
      this.broadcastRoom();
      if (this.started && this.level.def.loop) this.broadcast(this.loopMsg());
      if (this.started && this.level.def.finale) this.broadcastFinale(true);
    }
    const leftIntro = this.intro?.leave(conn.id);
    const expiredIntro = this.intro?.expire(this.now);
    if (leftIntro || expiredIntro) this.syncIntro();
  }

  /** Reserve a disconnected player's authoritative state. Ownership transfers immediately to an online teammate. */
  disconnect(conn: Conn) {
    const pl = this.players.get(conn.id);
    if (!pl || pl.conn !== conn || pl.offline) return;
    pl.offline = true;
    pl.reviving = undefined;
    for (const p of this.players.values()) if (p.reviving?.id === conn.id) p.reviving = undefined;
    this.warden?.forget(conn.id);
    if (this.host === conn.id) this.host = [...this.players.values()].find(p => !p.offline)?.conn.id ?? 0;
    this.broadcastRoom();
    this.syncStation();
    if (this.intro?.leave(conn.id)) this.syncIntro();
  }

  /** Move a reserved player to a new transport, without resetting their gameplay state or granting a safe period. */
  resume(previous: Conn, conn: Conn, now: number): boolean {
    const pl = this.players.get(previous.id);
    if (!pl || pl.conn !== previous || !pl.offline) return false;
    this.now = Math.max(this.now, now);
    this.expireIntro(this.now);
    conn.id = previous.id;
    conn.name = previous.name;
    conn.room = this;
    previous.room = undefined;
    pl.conn = conn;
    pl.offline = false;
    pl.strictInputs = true;
    pl.lastSeq = -1;
    pl.lastInput = pl.budgetAt = now;
    pl.budget = Math.min(pl.budget, MOVE_BURST); // elapsed offline time never becomes a teleport allowance
    if (!this.host) this.host = conn.id;
    this.broadcastRoom();
    this.sendState(conn);
    conn.send(this.fullSnapshot());
    conn.send({ t: 'resume', downLeft: pl.st === ST_DOWN && pl.heldUntil !== undefined ? Math.max(0, (pl.heldUntil - this.tick) * TICK_MS / 1000) : 0 });
    this.correct(pl);
    return true;
  }

  private runRanking(): RunRanking {
    if (this.developerMode) return 'developer';
    if (this.runDebugUsed) return 'debug';
    if (this.runStartedAtLevel !== 0) return 'incomplete';
    if (this.guidance) return 'guidance';
    if (!this.currentFinaleMembers().every(member => member.status === 'escaped')) return 'unescaped';
    return 'eligible';
  }

  /** Production privileges belong only to the currently bound host in an isolated, unranked test room. */
  canDebug(conn: Conn): boolean {
    const player = this.players.get(conn.id);
    return !!player && player.conn === conn && !player.offline &&
      (debugEnabled() || (this.developerMode && conn.id === this.host && isDeveloperName(conn.name)));
  }

  handle(conn: Conn, m: ClientMsg, now: number) {
    const pl = this.players.get(conn.id);
    if (!pl || pl.conn !== conn || pl.offline) return;
    // A release only clears this sender's matching hold, even if their state just changed.
    if (m.t === 'act' && m.kind === 'revive_cancel') { this.act(pl, m.kind, m.id); return; }
    if (!this.started) { if (m.t === 'start' && conn.id === this.host) this.start(now); return; }
    // Test rooms can change chapter during an intro, capture or completion; normal rooms retain their cinematic gates.
    if (m.t === 'debug' && this.developerMode && this.canDebug(conn)) {
      this.now = Math.max(this.now, now);
      this.runDebugUsed = true;
      this.debug(pl, m, now);
      return;
    }
    this.now = Math.max(this.now, now);
    this.expireIntro(this.now);
    if (m.t === 'intro-skip') {
      if (this.intro?.skip(conn.id, m.id, this.now)) this.syncIntro();
      return;
    }
    if (this.introFrozen && m.t !== 'input' && m.t !== 'chat' && m.t !== 'ping' && m.t !== 'ready') return;
    if ((this.completed || this.advanceAt !== undefined) && m.t !== 'input' && m.t !== 'chat' && m.t !== 'ping') return;
    if ((pl.st !== ST_OK || pl.escaped) && (m.t === 'use' || m.t === 'door' || m.t === 'act' || m.t === 'broadcast' || m.t === 'exam')) return; // downed / out: no interaction
    if (pl.hide && (m.t === 'broadcast' || m.t === 'exam' || m.t === 'door' || m.t === 'use' || (m.t === 'act' && m.kind !== 'unhide'))) return; // hidden: only climbing out
    if (this.gym?.tripped(conn.id, this.simSeconds) && (m.t === 'door' || m.t === 'use' || m.t === 'act' || m.t === 'exam')) return;
    if (this.waitingForSpawn(pl) && (m.t === 'use' || m.t === 'door' || m.t === 'act' || m.t === 'broadcast' || m.t === 'exam')) return;
    switch (m.t) {
      case 'exam': this.exam(pl, m); break;
      case 'ready':
        if (pl.st === ST_OK && !pl.hide && pl.spawnReady) markSpawnReady(pl.spawnReady, m.incarnation, this.tick);
        break;
      case 'broadcast': {
        if (!this.broadcastStation || this.advanceAt !== undefined) break;
        const p: BroadcastPlayer = { id: conn.id, p: pl.p, st: pl.st, hidden: !!pl.hide };
        if (m.op === 'read') this.broadcastStation.read(p, m.id);
        else {
          const result = this.broadcastStation.submit(p, m.code, this.stationTime());
          if (result === 'wrong') { this.puzzleFailed(); this.emitNoise(pl.p[0], pl.p[2], 80, 'item', pl.p[1], conn.id); }
          if (result === 'wrong' || result === 'missing') conn.send({ t: 'error', msg: result === 'wrong' ? '密码错误，广播惊动了角色074' : '先读齐四张编号贴纸' });
          if (result === 'refused' && !this.broadcastStation.off) conn.send({ t: 'error', msg: '操作过快或已离开广播台，请靠近后稍等一秒再试' });
        }
        this.syncStation();
        break;
      }
      case 'input': this.applyInput(pl, m, now); break;
      case 'restart': if (conn.id === this.host && this.level.def.finale && this.finalePhase === 'complete') {
        this.finaleReset = true;
        this.runStartedAtLevel = this.levelIndex;
        this.runStartedAt = now;
        this.runSince = this.tick + Math.ceil(LEVEL_FADE_S * 1000 / TICK_MS);
        this.runDownCounts.clear();
        this.finaleMembers.clear(); this.finaleParticipants.clear(); this.finaleHasStarted = false;
        this.beginFade(true);
      } break;
      case 'chat': this.broadcast({ t: 'chat', from: conn.id, text: m.text }); break;
      case 'use': this.useBattery(pl); break;
      case 'door':
        if (!this.toggleDoor(pl, m.id) && this.doors[m.id]) conn.send({ t: 'doors', doors: this.doorSnaps([m.id]) });
        break;
      case 'act':
        if (!this.act(pl, m.kind, m.id) && m.kind === 'use' && this.doors[m.id]) conn.send({ t: 'doors', doors: this.doorSnaps([m.id]) });
        break;
      case 'debug': if (this.canDebug(conn)) { this.runDebugUsed = true; this.debug(pl, m, now); } else this.badMsgs++; break;
      case 'ping': // at most one marker per PING_GAP_MS per player, so nobody can flood the others' screens
        if (now - (this.lastPing.get(conn.id) ?? -Infinity) >= PING_GAP_MS) { this.lastPing.set(conn.id, now); this.broadcast({ t: 'ping', from: conn.id, p: m.p }); }
        break;
      default: break;
    }
  }

  private readonly lastPing = new Map<number, number>();

  /** Messages the server refused as illegal (e.g. `debug` in production). */
  badMsgs = 0;

  /** A puzzle answer was wrong: 角色074 taunts (no-op in rooms without a nav graph). Puzzle handlers call this. */
  puzzleFailed() { this.warden?.sayFail(); }

  /** Validated developer commands: teleport, summon enemies, exercise capture, obtain puzzle resources. */
  private debug(pl: Player, m: Extract<ClientMsg, { t: 'debug' }>, now: number) {
    switch (m.op) {
      case 'level5':
        if (pl.conn.id === this.host) this.loadLevel(L5_INDEX);
        break;
      case 'tp': {
        // no floor given: stay on the sender's own floor (第 2 关 is all on 2F, so ground-floor x/z there is out of its area)
        const floor = m.floor ?? Math.round(pl.p[1] / FLOOR_HEIGHT);
        const y = groundHeight(this.world, m.x, m.z, NAV_CAPSULE.radius, floor * FLOOR_HEIGHT + 2);
        if (!this.inPlayArea(m.x, y, m.z)) { // out of the play area: refused, the player stays put
          this.correct(pl);
          break;
        }
        pl.hide = undefined;
        pl.f &= ~F_HIDE;
        pl.loop = { ...pl.loop, entering: undefined };
        pl.p = [m.x, y, m.z];
        this.mirrorCampaign?.forget(pl.conn.id);
        pl.lastInput = now;
        this.correct(pl);
        break;
      }
      case 'level': {
        if (!hasLevel(m.level)) { pl.conn.send({ t: 'error', msg: '未知关卡' }); break; }
        this.advanceAt = undefined; this.restarting = false;
        this.finaleReset = false;
        this.loadLevel(m.level);
        break;
      }
      case 'warden': {
        const d = Math.max(1.5, m.d ?? 6), fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
        pl.safeUntil = undefined; // summoned on purpose: no grace
        if (pl.spawnReady) spendSpawnReady(pl.spawnReady, this.tick);
        this.huntFrom = 0; this.keepOutUntil = 0;
        this.wardenOffUntil = 0;
        this.searchRestUntil = 0; // an explicit development summon also overrides the previous route-recovery pause
        this.tension.allowSummon(this.directorTime());
        this.sighting = undefined; this.sightingFinished = true;
        this.warden?.forceChase([pl.p[0] + fx * d, pl.p[1], pl.p[2] + fz * d], pl.yaw + Math.PI, pl.conn.id, pl.p);
        break;
      }
      case 'monitor': { // the 值日生 appears d m ahead of the sender, hunting
        const d = Math.max(1.5, m.d ?? 8), fx = -Math.sin(pl.yaw), fz = -Math.cos(pl.yaw);
        if (pl.spawnReady) spendSpawnReady(pl.spawnReady, this.tick);
        this.huntFrom = 0; this.keepOutUntil = 0;
        this.monitorOffUntil = 0;
        this.monitors[0]?.forceHunt([pl.p[0] + fx * d, pl.p[1], pl.p[2] + fz * d], pl.yaw + Math.PI);
        break;
      }
      case 'boss': {
        if (!this.developerMode) { pl.conn.send({ t: 'error', msg: '召唤值周代号025仅限专用开发者房间' }); break; }
        if (!this.level.def.monitor || !this.areaNav()) { pl.conn.send({ t: 'error', msg: '请先切换到有值周生的关卡，例如第五关体育馆' }); break; }
        const previous = this.boss ? undefined : this.monitors.shift(), id = this.boss?.id ?? this.monitorIds.shift() ?? 2;
        const p: Vec3 = previous?.p ?? this.boss?.p ?? [...pl.p];
        this.boss = new BossAI(p, this.difficulty,
          (a, b) => lineOfSight(this.world, { x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] })
            && lineOfSight(this.doorWorld, { x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }), id);
        this.mobSent.delete(id);
        break;
      }
      case 'down': // s: shorter hold so e2e doesn't sit through the full 30 s
        if (pl.st === ST_OK && !pl.escaped) this.recordDown(pl);
        pl.hide = undefined;
        pl.f &= ~(F_HIDE | F_CROUCH | F_RUN);
        pl.st = ST_DOWN;
        pl.heldUntil = this.tick + Math.ceil((Math.min(CAUGHT_HOLD_S, Math.max(1, m.s ?? CAUGHT_HOLD_S)) * 1000) / TICK_MS);
        break;
      case 'safe': { // s (default 120, at most 600): the NPCs leave everyone alone, as the spawn grace does; mob 1: only 角色074, mob 2: only the 值日生
        const until = this.tick + Math.ceil((Math.min(600, Math.max(0, m.s ?? 120)) * 1000) / TICK_MS);
        if (m.s === 0 && m.mob === undefined) { this.wardenOffUntil = 0; this.monitorOffUntil = 0; }
        if (m.mob === 1) this.wardenOffUntil = until;
        else if (m.mob === 2) this.monitorOffUntil = until;
        else for (const o of this.players.values()) o.safeUntil = until;
        break;
      }
      case 'power': // 跳闸 around the sender now
        if (m.s === 0) this.cancelTrip();
        else this.startTrip([pl.p[0], pl.p[2]], Math.min(30, Math.max(0.5, m.s ?? 8)));
        break;
      case 'key': {
        if (m.door === -1) { // the stairwell key
          this.bag = { ...this.bag, stair_key: (this.bag.stair_key ?? 0) + 1 };
          this.broadcast({ t: 'bag', bag: this.bag });
          break;
        }
        if (m.door === -2) { // the fuses still missing
          const n = this.level.def.blackout?.fuses ?? 0, have = this.fusesIn + (this.bag.fuse ?? 0);
          if (have < n) this.bag = { ...this.bag, fuse: (this.bag.fuse ?? 0) + n - have };
          this.broadcast({ t: 'bag', bag: this.bag });
          break;
        }
        const door = m.door ?? this.doorLocked.findIndex((l, i) => l && !this.regionLocked.has(i));
        if (door >= 0) for (const id of this.players.keys()) this.giveKey(id, door);
        break;
      }
    }
  }

  /** Accept the client's predicted position only if it is reachable and not inside a wall. */
  applyInput(pl: Player, m: Extract<ClientMsg, { t: 'input' }>, now: number) {
    if (pl.offline) return;
    if (pl.strictInputs) {
      if (m.c !== pl.c || !Number.isSafeInteger(m.seq) || m.seq <= (pl.lastSeq ?? -1)) return;
      pl.lastSeq = m.seq;
    }
    if (this.completed) return;
    if (this.introFrozen) {
      pl.lastInput = pl.budgetAt = now;
      return;
    }
    if (this.advanceAt !== undefined) { // fade covers in-flight predictions; the next level sends its own forced spawn
      pl.lastInput = now;
      return;
    }
    if (pl.escaped) { pl.yaw = m.yaw; pl.pitch = m.pitch; pl.lastInput = now; return; }
    if ((m.c !== undefined || this.level.def.loop || this.waitingForSpawn(pl) || this.introEnabled) && (m.c ?? 0) !== pl.c) { // stale inputs cannot move, spend budget or consume spawn grace
      pl.yaw = m.yaw;
      pl.pitch = m.pitch;
      pl.cameraKnown = false;
      return;
    }
    pl.cameraKnown = m.c === pl.c; // legacy inputs may still move, but cannot authorize a hidden relocation or safe release
    // The budget refills with elapsed wall time, so a bunched burst of inputs (a phone radio waking up, or a
    // 150-250 ms RTT link delivering four ticks at once) passes as long as its total distance is honest.
    const dt = Math.min(0.5, Math.max(0.05, (now - pl.lastInput) / 1000));
    const mayRun = canRun(pl.stamina, pl.exhausted);
    const rate = (mayRun ? SPEED.run : SPEED.walk) * SPEED_TOLERANCE;
    pl.budget = Math.min(rate * MOVE_WINDOW_S + MOVE_BURST, pl.budget + (rate * Math.max(0, now - pl.budgetAt)) / 1000);
    pl.budgetAt = now;
    const dx = m.p[0] - pl.p[0], dy = m.p[1] - pl.p[1], dz = m.p[2] - pl.p[2];
    if (this.gym?.tripped(pl.conn.id, this.simSeconds)) {
      pl.yaw = m.yaw; pl.pitch = m.pitch; pl.lastInput = now; pl.budget = 0;
      if (dx || dy || dz) this.correct(pl, m.seq);
      return;
    }
    if (pl.st !== ST_OK) { // downed or out: look around only
      pl.f &= ~F_HIDE;
      pl.yaw = m.yaw;
      pl.pitch = m.pitch;
      pl.lastInput = now;
      if (dx || dy || dz) this.correct(pl);
      return;
    }
    pl.yaw = m.yaw;
    pl.pitch = m.pitch;
    pl.f = pl.battery > 0 ? m.f : m.f & ~F_LIGHT;
    if (!mayRun) pl.f &= ~F_RUN;
    pl.f &= ~F_HIDE; // the client can't claim to be hiding: only hideIn() sets it
    if (pl.hide) { // pinned in the locker / under the desk: Crouch (rising edge) climbs out, anything else is ignored
      const down = (m.f & F_CROUCH) !== 0, edge = down && !pl.hide.crouch;
      pl.lastInput = now;
      pl.hide.crouch = down;
      if (edge) { this.unhide(pl); return; }
      pl.f = (pl.f & ~F_RUN) | F_HIDE;
      if (dx || dy || dz) this.correct(pl);
      return;
    }
    const d = Math.hypot(dx, dz);
    const out = !this.inPlayArea(m.p[0], m.p[1], m.p[2]); // the soft boundary behind the barriers
    if (d > pl.budget || out || !this.playerMoveOk(pl.p, m.p, dt)) {
      if (process.env.CORR_LOG) console.log('CORR', JSON.stringify({ id: pl.conn.id, seq: m.seq, d: +d.toFixed(3), budget: +pl.budget.toFixed(3), why: d > pl.budget ? 'dist' : out ? 'area' : 'collide', from: pl.p, to: m.p }));
      this.correct(pl, m.seq);
      return;
    }
    pl.budget -= d;
    // The existing client sends input only after spawnSynced. Old clients need no new handshake;
    // malformed, rejected, stale-epoch and look-only inputs have all returned before this point.
    if (pl.spawnReady) markSpawnReady(pl.spawnReady, this.incarnation, this.tick);
    this.footstep(pl, dx, dz, dt);
    this.gym?.touchMove(pl.conn.id, pl.p, m.p, this.simSeconds);
    if (this.gym?.tripped(pl.conn.id, this.simSeconds)) { this.correct(pl, m.seq); return; }
    const previous = pl.p;
    pl.p = [m.p[0], m.p[1], m.p[2]];
    pl.lastInput = now;
    this.stepLoop(pl, previous);
  }

  private loopMsg(): Extract<ServerMsg, { t: 'loop' }> {
    return { t: 'loop', players: [...this.players.values()].map((p) => ({ id: p.conn.id, step: p.loop.step, loops: p.loop.loops, mistakes: p.loop.mistakes })) };
  }

  /** Runs after collision/speed/region validation. Transport is an explicit epoch boundary for every client. */
  private stepLoop(pl: Player, previous: Vec3) {
    if (!this.level.def.loop) return;
    const before = pl.loop;
    pl.loop = enterLoopDoor(this.level.def, before, previous, pl.p, this.doorOpen);
    const to = loopDestination(this.level.def, pl.loop, previous, pl.p);
    if (to) {
      pl.p = to;
      pl.loop = { ...pl.loop, loops: pl.loop.loops + 1, armed: true, entering: undefined };
      pl.reviving = undefined;
      pl.c++;
      // Keep the remaining movement budget: crossing the seam cannot refill it or charge for the translation.
      this.broadcast({ t: 'warp', id: pl.conn.id, p: [...pl.p], c: pl.c, yaw: pl.yaw });
    }
    if (pl.loop.step !== before.step || pl.loop.loops !== before.loops || pl.loop.mistakes !== before.mistakes) this.broadcast(this.loopMsg());
  }

  /** Footstep noise for an accepted move (from pl.p by dx, dz over dt s); standing or crouching is silent. */
  private footstep(pl: Player, dx: number, dz: number, dt: number) {
    const kind = moveKind(pl.f, Math.hypot(dx, dz) / dt > 0.3);
    if (kind !== 'crouch') this.emitNoise(pl.p[0], pl.p[2], NOISE_RADIUS[kind], kind, pl.p[1], pl.conn.id);
  }

  /** The capsule is clear of every box in `ws` along a → b (sampled every half radius, so a thin wall can't be skipped). */
  private segmentClear(ws: CollisionWorld[], a: Vec3, b: Vec3): boolean {
    const r = NAV_CAPSULE.radius;
    // A refresh visits the whole campus. Most outdoor edges are nowhere near a door or barrier;
    // conservatively reject empty broad phases once rather than query them at every 15 cm sample.
    const x0 = Math.min(a[0], b[0]) - r, x1 = Math.max(a[0], b[0]) + r;
    const z0 = Math.min(a[2], b[2]) - r, z1 = Math.max(a[2], b[2]) + r;
    const y0 = Math.min(a[1], b[1]) + NAV_CAPSULE.stepHeight, y1 = Math.max(a[1], b[1]) + NAV_CAPSULE.height;
    const nearby = ws.filter(w => w.query(x0, z0, x1, z1).some(box => box.maxX > x0 && box.minX < x1
      && box.maxZ > z0 && box.minZ < z1 && box.maxY > y0 && box.minY < y1));
    if (!nearby.length) return true;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (r * 0.5)));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const q = { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t, vy: 0, grounded: true };
      if (nearby.some((w) => overlaps(w, q, NAV_CAPSULE))) return false;
    }
    return true;
  }

  /** b's feet are at most CAMPUS_LIFT above the ground under them. */
  private feetOk(w: CollisionWorld, b: Vec3): boolean {
    const maxY = b[1] + NAV_CAPSULE.stepHeight;
    const campusFloor = groundHeight(w, b[0], b[2], NAV_CAPSULE.radius, maxY);
    const floor = this.level.def.gym ? Math.max(campusFloor,
      groundHeight(this.barrierWorld, b[0], b[2], NAV_CAPSULE.radius, maxY)) : campusFloor;
    return b[1] <= floor + CAMPUS_LIFT;
  }

  /** Where a player may stand. A campaign level is one region of the campus; royale plays on all of it (its level 1 is only a stand-in, whose 50 × 34 m region would pin every player to one corner). */
  private inPlayArea(x: number, y: number, z: number): boolean {
    return this.mode === 'royale' ? inRoyaleArea(x, y, z) : inBounds(this.level, x, y, z);
  }

  /** A campus move a → b is fine if the segment is clear of the world, the closed doors and the barriers and b's feet are on the ground. */
  private campusMoveOk(w: CollisionWorld, a: Vec3, b: Vec3): boolean {
    return this.segmentClear([w, this.doorWorld, this.barrierWorld], a, b) && this.feetOk(w, b);
  }

  /**
   * A player's predicted move a → b over dt s. The client ran moveCapsule, so a slide along a wall or round a corner has a
   * chord that clips the box it slid past: besides campusMoveOk, accept b when it is clear, the chord misses the closed
   * doors and the server's own moveCapsule from a by the same delta lands within MOVE_SLACK of it (it can't pass a wall).
   */
  private playerMoveOk(a: Vec3, b: Vec3, dt: number): boolean {
    const w = this.broadcastMoveWorld ?? this.world;
    if (this.campusMoveOk(w, a, b)) return true;
    const end: Body = { x: b[0], y: b[1], z: b[2], vy: 0, grounded: true };
    const fixed = this.broadcastMoveWorld ? [this.doorWorld] : [this.doorWorld, this.barrierWorld];
    if (!this.feetOk(w, b) || overlaps(w, end, NAV_CAPSULE) || !this.segmentClear(fixed, a, b)) return false;
    const s: Body = { x: a[0], y: a[1], z: a[2], vy: 0, grounded: true };
    moveCapsule(w, s, b[0] - a[0], b[2] - a[2], dt, NAV_CAPSULE);
    return Math.hypot(s.x - b[0], s.z - b[2]) < MOVE_SLACK && Math.abs(s.y - b[1]) < MOVE_SLACK;
  }

  /**
   * Send pl.p back and start a new correction epoch (inputs still tagged with the old `c` are then ignored but for the
   * look). `ack`: the rejected input's seq, the client replays its later moves on top of p; without it the server moved
   * the player itself (spawn, caught, tp, hiding, frozen) and the client just snaps.
   */
  private correct(pl: Player, ack?: number) {
    pl.c++;
    pl.cameraKnown = false;
    pl.conn.send(ack === undefined ? { t: 'correct', p: pl.p, c: pl.c, forced: true, f: pl.f } : { t: 'correct', p: pl.p, c: pl.c, ack });
  }

  /** No remaining teammate can rescue: end down timers now, retaining offline ST_OK until their reservation expires. */
  private eliminateUnrescuableDowns(): boolean {
    const all = [...this.players.values()];
    const remaining = this.level.def.finale ? all.filter(p => this.finaleParticipants.has(p.conn.id) && !p.escaped) : all;
    if (!remaining.length || !all.some(p => !p.offline) || remaining.some(p => p.st === ST_OK)) return false;
    for (const pl of remaining) {
      if (pl.st === ST_DOWN) pl.st = ST_SPECTATE;
      pl.heldUntil = undefined;
      pl.reviving = undefined;
    }
    return true;
  }

  /** Level state machine: play → (exit reached | nobody can rescue) → black screen LEVEL_FADE_S → next / same level. */
  private levelFlow() {
    if (this.completed) return;
    if (this.advanceAt !== undefined) {
      if (this.tick >= this.advanceAt) {
        if (!this.restarting && !hasLevel(this.levelIndex + 1)) {
          this.completed = true;
          this.advanceAt = undefined;
          // Available chapters may end before L8 is integrated. Observers still share the team's clear.
          for (const p of this.players.values()) { p.st = ST_OK; p.heldUntil = undefined; p.reviving = undefined; }
          this.broadcast({ t: 'complete', level: this.levelIndex });
        } else this.loadLevel(this.restarting ? this.levelIndex : this.levelIndex + 1);
      }
      return;
    }
    if (this.level.def.finale) return;
    if (this.eliminateUnrescuableDowns()) { this.beginFade(true); return; }
    const all = [...this.players.values()].filter(p => !p.offline), alive = all.filter((p) => p.st !== ST_SPECTATE), up = all.filter((p) => p.st === ST_OK);
    if (!alive.length) return;
    if (this.level.def.exam
      ? this.examPassed && alive.every((p) => p.st === ST_OK && inExit(this.level, p.p[0], p.p[1], p.p[2]))
      : up.length > 0 && (this.level.def.broadcast || this.level.def.gym || this.level.def.mirror ? alive : up).every((p) =>
        (!this.level.def.mirror || p.st === ST_OK) && exitOpen(this.level, this.fusesIn, this.bag, this.level.def.mirror ? this.mirrorCampaign?.progress : this.level.def.gym ? this.gym?.switches.complete : this.level.def.broadcast ? this.broadcastStation?.off : p.loop)
        && inExit(this.level, p.p[0], p.p[1], p.p[2]))) this.beginFade(false);
  }

  private beginFade(restart: boolean) {
    this.restarting = restart;
    this.advanceAt = this.tick + Math.ceil((LEVEL_FADE_S * 1000) / TICK_MS);
    if (!restart) {
      this.clearEvent = { t: 'event', kind: 'clear', id: ++this.clearEpoch, level: this.levelIndex,
        elapsed: Math.max(0, (this.tick - this.levelStartedTick) * TICK_MS / 1000), secs: LEVEL_FADE_S };
      this.broadcast(this.clearEvent);
    }
    this.broadcast({ t: 'fade', secs: LEVEL_FADE_S, restart });
  }

  private readonly safeTicks = Math.ceil((SAFE_S * 1000) / TICK_MS);
  private readonly openTicks = Math.ceil((OPEN_GRACE_S * 1000) / TICK_MS);

  private waitingForSpawn(pl: Player): boolean { return pl.spawnReady !== undefined && pl.spawnReady.readyAtTick === undefined; }

  /** The real lobby lifecycle opts in; directly running simulation/test rooms keep their existing timing. */
  private beginSpawnIncarnation() {
    this.incarnation++;
    if (this.lateObserve) for (const pl of this.players.values()) pl.spawnReady = createSpawnReady(this.incarnation);
  }

  /** Rechecked at the caught boundary too: a mob may still hold a stale target from its preceding step. */
  private canCatch(pl: Player): boolean {
    return !pl.offline && pl.st === ST_OK && this.tick >= this.huntFrom && this.tick >= (pl.safeUntil ?? 0)
      && (!pl.spawnReady || !isSpawnProtected(pl.spawnReady, this.tick));
  }

  /** Mobs' prey: ready players past both personal graces and the room-wide opening. */
  private prey() {
    return [...this.players.values()].filter((p) => !p.offline && this.canCatch(p)).map((p) => ({ id: p.conn.id, p: p.p, yaw: p.yaw, pitch: p.pitch, f: p.f }));
  }

  /** The director selects eligible prey; search owns the one authoritative movement/door path. */
  private stepWarden(off: boolean) {
    const w = this.warden, env = this.wardenEnv;
    if (!w || !env) return;
    const now = this.directorTime(), spawn = this.level.spawns[0];
    const players = this.prey().map(p => ({ ...p, advance: Math.hypot(p.p[0] - spawn.x, p.p[2] - spawn.z) }));
    const progress = Math.min(1, (this.fusesIn + Object.values(this.bag).reduce((n, v) => n + (v ?? 0), 0)) / 4);
    const plan = this.tension.plan(now, players, w, !off && this.tick >= this.huntFrom, progress);
    if (plan.disengage) {
      w.forget(plan.disengage);
      this.search.reset();
      this.followEvidenceUntil = 0;
    }
    if (plan.investigate && this.searchNav) {
      const target = players.find(p => p.id === plan.investigate);
      const route = this.wardenInvestigationNav();
      const p = target && investigationPoint({ ...env, graph: route.graph, walkable: route.walkable }, w.p, target, players);
      if (p && target) {
        // The search graph uses this same validated source, with room-local evidence anchors.
        if (this.searchPatrolGraph) { this.searchPatrolGraph = false; this.searchNav.refresh(); }
        this.hearWarden({ kind: 'run', x: p[0], y: p[1], z: p[2], r: 200, src: target.id });
      }
    }
    this.stepWardenSearch(off, plan.prey);
    this.tension.observe(now, w);
  }

  /** Open only an unlocked door physically reachable in front of a known pursuit/search goal. */
  private openWardenDoor() {
    const w = this.warden, goal = w?.goal;
    if (!w || !goal || w.retreating || (w.state !== 'chase' && w.state !== 'investigate')) return;
    for (const d of this.doors) {
      if (this.doorOpen[d.id] || this.doorLocked[d.id] || this.regionLocked.has(d.id)
        || Math.abs((d.y0 ?? 0) - w.p[1]) > .6 || Math.hypot(w.p[0] - d.x, w.p[2] - d.z) > 2) continue;
      const side = d.alongX ? w.p[2] - d.z : w.p[0] - d.x;
      const targetSide = d.alongX ? goal[2] - d.z : goal[0] - d.x;
      if (side * targetSide >= -.01) continue;
      const offset = Math.sign(side) * (NAV_CAPSULE.radius + .15);
      const at: Vec3 = [d.x + (d.alongX ? 0 : offset), w.p[1], d.z + (d.alongX ? offset : 0)];
      // Reach the near side with the full capsule. Walls, barriers and every other closed door still block it.
      if (!this.campusMoveOk(this.world, w.p, at)) continue;
      this.doorOpen[d.id] = true;
      this.doorWorld.move(this.doorBox[d.id], campusDoorSlab(d, true));
      this.doorDirty.add(d.id);
      this.searchNav?.refresh();
      // Connection ids start at 1. Source 0 marks Warden's own action: other listeners still receive
      // the real door sound, while hearWarden rejects it as player-location evidence.
      this.emitNoise(d.x, d.z, DOOR_NOISE, 'door', d.y0 ?? 0, 0);
      break;
    }
  }

  private stepWardenSearch(off: boolean, targets: readonly WardenTarget[]) {
    const w = this.warden, env = this.wardenEnv;
    if (!w || !env) return;
    if (this.tick < this.searchRestUntil) { w.caught = []; this.search.reset(); return; }
    if (w.state === 'patrol' && !w.retreating && (this.searchNav?.anchorCount ?? 0) >= SEARCH_ANCHOR_LIMIT / 2) {
      // A patrol reset clears the native route, so only this boundary may discard old anchor indices.
      // Re-anchor at the same exact position; reset keeps the voice clock and never moves him elsewhere.
      this.resetSearchNav();
      w.reset(this.searchNav!.anchor(w.p));
      this.search.reset();
      this.searchAnchoredTarget = 0;
      this.wardenTrail = [];
      this.followEvidenceUntil = 0;
    }
    const patrolGraph = w.state !== 'chase' && w.state !== 'investigate';
    if (patrolGraph !== this.searchPatrolGraph) { this.searchPatrolGraph = patrolGraph; this.searchNav?.refresh(); }
    const dt = TICK_MS / 1000, now = this.tick * dt;
    const lastStep = this.wardenTrail.at(-1);
    if (lastStep && Math.hypot(lastStep[0] - w.p[0], lastStep[1] - w.p[1], lastStep[2] - w.p[2]) > .6) this.wardenTrail = [];
    this.search.setPlayerCount(this.activePlayerCount());
    const senses = !off && !w.retreating && w.state !== 'catch';
    const visible = (t: WardenTarget) => senses && searchCanSee(w.p, w.yaw, t, env.los);
    const seen = new Set(targets.filter(visible).map((t) => t.id));
    this.search.observe(now, senses ? targets : [], visible);
    const hidden = new Set(targets.filter((t) => t.f & F_HIDE).map((t) => t.id));
    if (seen.has(w.target)) this.searchAnchoredTarget = 0;
    if (senses && w.target && !seen.has(w.target)) {
      if (this.searchNav && this.searchAnchoredTarget !== w.target) {
        const last = this.search.lastSeen(w.target, now);
        if (last) {
          const remembered = this.searchNav.anchor(last), current = this.searchNav.anchor(w.p);
          if (current >= 0 && remembered >= 0 && !this.searchNav.astar(current, remembered)) {
            // A local sidestep can end in a nook which has no cached waypoint. His own accepted footsteps
            // are genuine navigation evidence: retrace the clear parts until the existing graph reconnects.
            const back: Vec3[] = [[...w.p], ...this.wardenTrail.slice().reverse()];
            let at = 0, node = current;
            for (let bends = 0; at < back.length - 1 && bends < 12; bends++) {
              let next = back.length - 1;
              while (next > at && !this.campusMoveOk(this.world, back[at], back[next])) next--;
              if (next === at) break;
              const previous = this.searchNav.anchor(back[next]);
              if (previous < 0) break;
              this.searchNav.link(node, previous);
              if (this.searchNav.astar(current, remembered)) break;
              node = previous; at = next;
            }
          }
          const connected = () => current >= 0 && remembered >= 0 && this.searchNav!.astar(current, remembered);
          const path = connected() || current < 0 || remembered < 0 ? null : evidenceRoute(w.p, last,
            (a, b) => this.segmentClear([this.world, this.barrierWorld, this.lockedDoorWorld], a, b) && this.feetOk(this.world, b),
            (p) => this.inPlayArea(...p));
          if (path) {
            const ids = path.map((p) => this.searchNav!.anchor(p));
            for (let i = 1; i < ids.length; i++) if (ids[i - 1] >= 0 && ids[i] >= 0) this.searchNav.link(ids[i - 1], ids[i]);
          }
          if (connected()) this.followEvidenceUntil = this.tick + Math.ceil(this.search.difficulty.searchSeconds / dt);
          this.searchAnchoredTarget = w.target;
        }
      }
      // A finite, fixed projection from the last two genuine LOS samples; no updates from a wall-hidden player.
      const goal = this.search.hidingGoal(w.target, now) ?? this.search.predict(w.target, now, env.graph, w.p,
        (p) => this.inPlayArea(...p));
      if (goal) w.goal = goal;
    }
    if (senses) this.openWardenDoor();
    const entrance = senses && hidden.has(w.target) ? this.search.hidingGoal(w.target, now) : null;
    const inspecting = entrance && !seen.size && Math.abs(entrance[1] - w.p[1]) < .6
      && Math.hypot(entrance[0] - w.p[0], entrance[2] - w.p[2]) <= 1.8
      && env.los({ x: w.p[0], y: w.p[1] + 1, z: w.p[2] }, { x: entrance[0], y: entrance[1] + 1, z: entrance[2] });
    const before: Vec3 = [...w.p];
    // Hidden players are never fed into the old perpetual `witnessed` sight path. Inspection is a visible pause.
    w.step(inspecting ? 0 : dt, targets.filter((t) => !(t.f & F_HIDE)));
    if (this.searchArea && (Math.hypot(w.p[0] - before[0], w.p[1] - before[1], w.p[2] - before[2]) > 1e-7)
      && (!this.inPlayArea(...w.p) || !this.campusMoveOk(this.world, before, w.p))) {
      // Discard the failed proposal and its native route/at state. Reset at the exact old position,
      // preserving the original instance/voice clock and emitting no corrective teleport.
      this.searchRecoveries++;
      this.searchRestUntil = this.tick + Math.ceil((w.retreating ? 20 : 1) / dt);
      this.search.reset();
      this.searchAnchoredTarget = 0;
      this.wardenTrail = [];
      this.followEvidenceUntil = 0;
      this.resetSearchNav();
      const anchor = this.searchNav!.anchor(before);
      w.takeLines(); // no line from the rejected proposal is authoritative
      w.reset(anchor);
      return;
    }
    if (Math.hypot(w.p[0] - before[0], w.p[1] - before[1], w.p[2] - before[2]) > 1e-7) {
      if (!this.wardenTrail.length) this.wardenTrail.push(before);
      this.wardenTrail.push([...w.p]);
      if (this.wardenTrail.length > 100) this.wardenTrail.splice(0, this.wardenTrail.length - 100);
    }
    const inspected = this.search.check(now, dt, w.p, inspecting ? hidden : new Set(), (a, b) => env.los(
      { x: a[0], y: a[1] + 1, z: a[2] }, { x: b[0], y: b[1] + 1, z: b[2] }));
    for (const id of inspected) {
      const pl = this.players.get(id);
      if (pl?.hide && pl.st === ST_OK && this.tick >= (pl.safeUntil ?? 0)) this.unhide(pl);
      // The next tick sees the real exposed player and uses the original catch hold and post-catch retreat.
    }
  }

  /** Same room and seed, new level index: items, doors, bag and positions are rebuilt. */
  private loadLevel(index: number) {
    // Resolve before changing room state: an unregistered chapter must leave the current game intact.
    const level = generateLevel(index, this.seed);
    const wasFinale = !!this.level.def.finale;
    if (index !== this.levelIndex) this.difficultyPlayers = difficultyTeamSize(this.players.size);
    this.difficultyLocked = true;
    this.advanceAt = undefined;
    this.completed = false;
    this.beginSpawnIncarnation();
    this.clearEvent = undefined;
    this.levelIndex = index;
    this.wardenStare.reset();
    this.level = level;
    this.world = worldForLevel(this.level);
    this.areaNavs.delete(index);
    this.navMsgs.delete(index);
    const preserveFinale = !!this.level.def.finale && wasFinale && !this.finaleReset;
    this.finaleReset = false;
    this.sightingFrom = this.directorTime(); this.sightingNext = 0; this.sightingFinished = false; this.sighting = undefined;
    this.resetStation();
    this.resetExam();
    this.resetDoors();
    this.resetMirrors();
    this.tension.reset(this.directorTime());
    this.search.reset();
    this.searchAnchoredTarget = 0;
    this.wardenTrail = [];
    this.followEvidenceUntil = 0;
    this.searchRestUntil = 0;
    this.resetSearchNav();
    this.huntFrom = this.tick + this.openTicks;
    this.keepOutUntil = this.tick + Math.ceil((KEEP_OUT_S * 1000) / TICK_MS);
    const nav = this.searchNav ?? this.areaNav();
    if (this.warden && this.wardenEnv && nav) { // a fresh start away from the (new) spawns, not wherever the last catch / wipe left him
      this.wardenEnv.checkRouteSteps = !!this.level.def.exam;
      this.wardenEnv.graph = this.searchNav ?? nav; // room-local locked-edge filtering, same node indices
      const sp = this.level.spawns[0], reach = this.searchNav ? this.wardenSpawnReach(this.searchNav)
        : [...nav.reachable(nav.nearest(sp.x, sp.y ?? 0, sp.z))];
      this.warden.reset(pickWardenStart(nav, sp, reach, mulberry32((this.seed ^ 0x77616e67) + index * 7919), this.level.spawns));
      this.mobSent.delete(1);
    }
    for (let i = 0; i < 8; i++) this.mobSent.delete(2 + i);
    for (const pl of this.players.values()) {
      pl.loop = freshLoop();
      pl.cameraKnown = false;
      pl.p = this.spawnPos(pl.slot);
      pl.hide = undefined;
      pl.f &= ~F_HIDE;
      pl.st = ST_OK;
      pl.escaped = false;
      pl.heldUntil = undefined;
      pl.reviving = undefined;
      pl.safeUntil = this.tick + this.safeTicks;
      pl.battery = 1;
      pl.stamina = 1;
      pl.exhausted = false;
      if (this.level.def.finale) pl.f = 0;
      pl.sentF = pl.sentBat = pl.sentSta = undefined; // level load resets battery/stamina: resend both
      this.correct(pl);
    }
    this.recordRunTeamSize();
    this.gym?.switches.syncTeam(this.gymPlayers().map((p) => p.id));
    if (this.level.def.finale) this.startFinaleAttempt(preserveFinale);
    else {
      this.finalePhase = undefined; this.finaleCompleted = undefined; this.finaleMembers.clear(); this.finaleParticipants.clear();
      this.finaleAI = undefined; this.finaleHasStarted = false;
    }
    this.spawnMonitor();
    this.broadcastRoom();
    this.levelStartedTick = this.tick;
    this.beginIntro(this.now); // same-level retry rebuilds the client before its authoritative puzzle/item state arrives
    if (this.level.def.loop) this.broadcast(this.loopMsg());
    this.broadcast({ t: 'items', items: this.items });
    this.broadcast({ t: 'keys', keys: [] });
    this.broadcast({ t: 'bag', bag: this.bag });
    this.broadcast({ t: 'power', n: this.fusesIn });
    if (this.level.def.exam) this.broadcast(this.examState());
    this.syncStation();
    if (this.gym) this.broadcast(this.gym.snapshot(this.simSeconds));
    this.syncMirrors();
    this.broadcast({ t: 'doors', doors: this.doorSnaps() });
    const nv = this.navMsg();
    if (nv) this.broadcast(nv);
    if (this.level.def.finale) this.broadcastFinale(true);
    this.resetTrip(index);
    this.broadcast({ t: 'trip', at: [0, 0], omen: 0, off: 0 });
  }

  /** Intro freezes simulation time; snapshots still arrive so clients can finish spawning. */
  get introFrozen() { return !!this.intro && !this.intro.ended; }

  private beginIntro(now: number) {
    if (!this.introEnabled) return; // direct, already-running rooms retain their original clock
    this.now = Math.max(this.now, now);
    const plan = this.introPlan();
    this.intro = new IntroSession(++this.introEpoch, this.levelIndex, this.now,
      [...this.players.values()].filter(p => !p.offline && p.st === ST_OK).map(p => p.conn.id), plan.route, plan.silhouette);
    this.broadcast(this.intro.event(this.now));
  }

  /** Keep the camera on connected, currently open nav edges. The final sighting stays on the same visible corridor. */
  private introPlan(): { route: Vec3[]; silhouette?: Vec3 } {
    const nav = this.areaNav(), spawn = this.level.spawns[0];
    if (!nav?.nodes.length) return { route: [[spawn.x, spawn.y ?? 0, spawn.z]] };
    // A long nav edge can begin beyond a sealed stairwell and continue down an open corridor. Keep its safe
    // sub-edges for the camera instead of throwing away that whole corridor. This graph never changes AI routing.
    const graph = new NavGraph();
    for (let i = 0; i < nav.nodes.length; i++) for (const j of nav.adj[i]) {
      if (j <= i) continue;
      const a = nav.nodes[i], b = nav.nodes[j], steps = Math.max(1, Math.ceil(nav.dist(i, j) / 2));
      let previous: number | undefined;
      for (let k = 0; k <= steps; k++) {
        const p: Vec3 = [a.x + (b.x - a.x) * k / steps, a.y + (b.y - a.y) * k / steps, a.z + (b.z - a.z) * k / steps];
        if (!inBounds(this.level, ...p) || !this.campusMoveOk(this.world, p, p)) { previous = undefined; continue; }
        const at = graph.addNode({ x: p[0], y: p[1], z: p[2] });
        if (previous !== undefined) {
          const q = graph.nodes[previous], target = graph.nodes[at];
          if (this.campusMoveOk(this.world, [q.x, q.y, q.z], [target.x, target.y, target.z])) graph.link(previous, at);
        }
        previous = at;
      }
    }
    const starts = graph.nodes.map((_, i) => i).filter(i => graph.adj[i].length)
      .sort((a, b) => {
        const distance = (i: number) => Math.hypot(graph.nodes[i].x - spawn.x, graph.nodes[i].y - (spawn.y ?? 0), graph.nodes[i].z - spawn.z);
        return distance(a) - distance(b);
      });
    let fallback: { route: Vec3[]; silhouette?: Vec3 } = { route: [[spawn.x, spawn.y ?? 0, spawn.z]] };
    for (const start of starts) {
      const plan = this.introPlanFrom(graph, start);
      const length = plan.route.slice(1).reduce((sum, p, i) => sum + Math.hypot(...p.map((v, k) => v - plan.route[i][k])), 0);
      if (plan.silhouette && length >= 4) return plan;
      if (plan.route.length > fallback.route.length) fallback = plan;
    }
    return fallback;
  }

  private introPlanFrom(graph: NavGraph, start: number): { route: Vec3[]; silhouette?: Vec3 } {
    const dist = new Map<number, number>([[start, 0]]), from = new Map<number, number>(), open = new Set([start]);
    // Find a short open corridor from the spawn, favoring the route toward the exit when lengths tie.
    while (open.size) {
      const at = [...open].reduce((a, b) => dist.get(a)! <= dist.get(b)! ? a : b);
      open.delete(at);
      const a = graph.nodes[at];
      for (const next of graph.adj[at]) {
        const b = graph.nodes[next], length = dist.get(at)! + graph.dist(at, next);
        if (length > 30 || length >= (dist.get(next) ?? Infinity)
          || !this.campusMoveOk(this.world, [a.x, a.y, a.z], [b.x, b.y, b.z])) continue;
        dist.set(next, length); from.set(next, at); open.add(next);
      }
    }
    const exit = this.level.exit;
    const score = (i: number) => dist.get(i)! - Math.hypot(graph.nodes[i].x - exit.x, graph.nodes[i].z - exit.z) * 0.01;
    // L1 teaches the actual southwest stairwell route, rather than taking the longest branch to the chained front door.
    const toExit = (i: number) => Math.hypot(graph.nodes[i].x - exit.x, graph.nodes[i].z - exit.z);
    const last = [...dist.keys()].reduce((a, b) => this.levelIndex === 0
      ? toExit(a) <= toExit(b) ? a : b
      : score(a) >= score(b) ? a : b);
    const ids = [last];
    while (from.has(ids[0])) ids.unshift(from.get(ids[0])!);
    // Subdivide the existing edges, so a long edge can still provide a flight and an 8 m sighting gap.
    const points: Vec3[] = [];
    for (let i = 0; i < ids.length; i++) {
      const b = graph.nodes[ids[i]], a = graph.nodes[ids[Math.max(0, i - 1)]];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 2));
      if (i === 0) points.push([b.x, b.y, b.z]);
      else for (let k = 1; k <= steps; k++) points.push([a.x + (b.x - a.x) * k / steps, a.y + (b.y - a.y) * k / steps, a.z + (b.z - a.z) * k / steps]);
    }
    let best: { at: number; to: number; score: number } | undefined;
    let travelled = 0;
    for (let i = 0; i < points.length; i++) {
      if (i) travelled += Math.hypot(...points[i].map((v, k) => v - points[i - 1][k]));
      if (travelled > 18) break;
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i], b = points[j], gap = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (gap < 6 || gap > 10) continue;
        const eyeA = { x: a[0], y: a[1] + 1.55, z: a[2] }, eyeB = { x: b[0], y: b[1] + 1.55, z: b[2] };
        if (!lineOfSight(this.world, eyeA, eyeB) || !lineOfSight(this.doorWorld, eyeA, eyeB) || !lineOfSight(this.barrierWorld, eyeA, eyeB)) continue;
        const s = Math.abs(travelled - 12) + Math.abs(gap - 8);
        if (!best || s < best.score) best = { at: i, to: j, score: s };
      }
    }
    if (best) return { route: points.slice(0, best.at + 1), silhouette: points[best.to] };
    // Tiny test graphs / closed rooms still get a title and a short safe camera move.
    return { route: points.slice(0, Math.max(1, Math.ceil(points.length / 2))) };
  }

  private expireIntro(now: number) {
    if (this.intro?.expire(now)) this.syncIntro();
  }

  private recordRunTeamSize(): void {
    this.runMaxPlayers = Math.max(this.runMaxPlayers, [...this.players.values()].filter(player => player.st !== ST_SPECTATE).length);
  }

  private syncIntro() {
    const intro = this.intro;
    if (!intro) return;
    if (intro.ended) {
      // No distance budget or prediction from the frozen camera may leak into active play.
      for (const pl of this.players.values()) {
        pl.lastInput = pl.budgetAt = this.now;
        pl.budget = MOVE_BURST;
        this.correct(pl);
      }
      this.levelStartedTick = this.tick;
    }
    this.broadcast(intro.event(this.now));
  }

  step(now?: number) {
    this.now = Math.max(this.now, now ?? this.now + TICK_MS);
    this.snapTick++;
    this.expireIntro(this.now);
    if (this.introFrozen) { this.sendSnap(); return; }
    this.tick++;
    this.noise.flush(this.tick);
    if (this.players.size === 0 || !this.started) return;
    this.difficultyLocked = true;
    this.levelFlow();
    if (this.introFrozen) { this.sendSnap(); return; }
    if (this.completed || this.advanceAt !== undefined) return;
    this.stepStation();
    if (this.gym) {
      const tripsChanged = this.gym.step(this.simSeconds, TICK_MS / 1000, this.gymPlayers());
      // Physics and expiry stay at 20Hz; visual ball snapshots need only 10Hz.
      if (tripsChanged || this.tick % 2 === 0) this.broadcast(this.gym.snapshot(this.simSeconds));
    }
    this.stepExam();
    // downed players (caught / waiting for a revive) and those in their SAFE_S grace are not prey
    const wardenOff = this.tick < this.wardenOffUntil; // debug 'safe' mob 1
    if (!this.level.def.mirror && !this.level.def.finale && !this.stepSighting()) this.stepWarden(wardenOff);
    this.stepRevives();
    if (!this.level.def.mirror && !this.level.def.finale) this.stepTrip();
    const mirrors = this.mirrorCampaign;
    if (mirrors) {
      mirrors.step(TICK_MS / 1000, this.mirrorPlayers());
      for (const id of mirrors.ai.caught) {
        const pl = this.players.get(id);
        const source = mirrors.ai.caughtSources.get(id);
        if (pl && source && this.canCatch(pl)) {
          if (this.mode === 'royale') {
            this.royaleEliminate(pl);
          } else {
            this.punish(pl, 'mirror', source);
          }
        }
      }
      this.syncMirrors();
    }
    if (!this.level.def.mirror && !this.level.def.finale) this.spawnMonitor(false);
    if ((this.monitors.length || this.boss) && !this.level.def.finale) {
      const prey = this.tick < this.monitorOffUntil ? [] : this.prey();
      for (const m of this.monitors) m.step(TICK_MS / 1000, prey);
      this.boss?.step(TICK_MS / 1000, prey);
      if (this.monitors.some((m) => m.blinked)) this.broadcast({ t: 'blink', secs: BLINK_S });
      const contacts = this.monitors.flatMap((m, i) => m.caught.map(id => ({ pl: this.players.get(id), source: m.p, mob: this.monitorMobId(i) })));
      if (this.boss) contacts.push(...this.boss.caught.map(id => ({ pl: this.players.get(id), source: this.boss!.p, mob: this.boss!.id })));
      const caught = contacts
        .filter((v): v is { pl: Player; source: Vec3; mob: number } => !!v.pl && this.canCatch(v.pl));
      const victim = caught[0];
      if (victim) {
        const at = victim.pl.p, until = this.tick + Math.ceil(MONITOR_RESCUE_S * 1000 / TICK_MS);
        for (const pl of this.players.values()) {
          if (pl === victim.pl || pl.offline || pl.st !== ST_OK) continue;
          if (caught.some(v => v.pl === pl) || (Math.abs(pl.p[1] - at[1]) < 1.5 && Math.hypot(pl.p[0] - at[0], pl.p[2] - at[2]) <= 3)) {
            pl.safeUntil = Math.max(pl.safeUntil ?? 0, until);
          }
        }
        this.punish(victim.pl, 'monitor', victim.source, victim.mob);
      }
    }
    const stared = this.stepWardenStare(wardenOff);
    const w = this.level.def.mirror || this.level.def.finale ? undefined : this.warden;
    const pending = w?.takeLines() ?? [];
    // Staring wins this tick: the AI may already have queued a natural spot line before the form transition.
    const lines = stared ? pending.slice(-1) : pending;
    for (const l of lines) {
      // forceChase enters pursuit through the existing AI API and starts its voice cooldown. Its spot line
      // becomes the authored stare line for this transition, with one subtitle / voice event.
      const line = stared && l.trigger === 'spot' ? pickLine('stare', () => 0) ?? l : l;
      this.broadcast({ t: 'event', kind: 'line', id: line.id, text: line.text, mob: 1 });
    }
    if (w && !wardenOff) for (const id of w.caught) {
      const pl = this.players.get(id);
      if (pl && !pl.offline && this.canCatch(pl)) {
        if (this.mode === 'royale') {
          this.royaleEliminate(pl);
        } else {
          this.punish(pl, 'warden', w.p);
        }
      }
    }
    if (this.level.def.finale && this.finalePhase === 'chase') {
      // Inputs already reached the gate this tick: extraction takes priority over a catch inside the safe circle.
      for (const pl of this.players.values()) this.escapeGate(pl);
      this.finaleAI?.step(TICK_MS / 1000, this.finaleTargets());
      for (const id of this.finaleAI?.caught ?? []) {
        const pl = this.players.get(id);
        if (pl && !pl.offline && this.canCatch(pl) && !pl.escaped) {
          if (this.mode === 'royale') {
            this.royaleEliminate(pl);
          } else {
            this.punish(pl, 'warden', this.finaleAI!.p);
          }
        }
      }
    }
    for (const pl of this.players.values()) {
      if (!pl.offline) {
        this.drainBattery(pl);
        pl.stamina = stepStamina(pl.stamina, !!(pl.f & F_RUN), TICK_MS / 1000);
        pl.exhausted = pl.stamina <= 0 || (pl.exhausted && pl.stamina < STAMINA_MIN);
      }
      if (pl.heldUntil !== undefined && this.tick >= pl.heldUntil) { pl.heldUntil = undefined; pl.st = ST_SPECTATE; } // nobody came: out for this level
    }
    if (this.level.def.finale) this.finaleFlow();
    else if (this.eliminateUnrescuableDowns()) this.beginFade(true);
    if (this.mode === 'royale') this.stepRoyaleZone();
    this.sendSnap();
  }

  private sendSnap() {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const snap: Extract<ServerMsg, { t: 'snap' }> = {
      t: 'snap', ...(this.snapTick % MOB_KEY_TICKS === 0 ? { difficulty: this.difficulty } : {}),
      tick: this.snapTick,
      // delta-light: st omitted when ST_OK, bat / sta only when changed (~7 KB/s per player with 4 players, tests/unit/bandwidth)
      players: [...this.players.values()].map((p) => {
        const e: PlayerSnap = { id: p.conn.id, p: [r2(p.p[0]), r2(p.p[1]), r2(p.p[2])], yaw: r2(p.yaw), pitch: r2(p.pitch) };
        if (p.offline) e.online = false;
        if (p.f !== p.sentF || this.snapTick % MOB_KEY_TICKS === 0) e.f = p.sentF = p.f; // changes + a keyframe for late joiners
        if (p.st !== ST_OK) e.st = p.st;
        if (p.escaped) e.escaped = true;
        if (p.st === ST_DOWN && p.heldUntil !== undefined) e.downUntil = this.snapTick + p.heldUntil - this.tick;
        const bat = r2(p.battery), sta = r2(p.stamina);
        if (bat !== p.sentBat) e.bat = p.sentBat = bat;
        // stamina moves every tick while running / recovering: 0.02 steps are enough for the bar (0 and 1 always go out)
        if (p.sentSta === undefined || (sta !== p.sentSta && (Math.abs(sta - p.sentSta) >= 0.02 || sta <= 0 || sta >= 1))) e.sta = p.sentSta = sta;
        return e;
      }),
      mobs: this.mobSnaps(r2),
      ...(this.boss ? { boss: this.boss.snapshot() } : {}),
    };
    if (this.mode === 'royale' && this.royaleZones.length > 0) {
      const zone = this.royaleZones[this.royaleZonePhase];
      const elapsed = (this.tick - this.royaleZonePhaseStart) * TICK_MS / 1000;
      const remaining = this.royaleZonePhase === 0
        ? Math.max(0, this.zoneTiming.graceS - (this.tick - this.runSince) * TICK_MS / 1000) * 1000
        : Math.max(0, this.zoneTiming.phaseS - elapsed) * 1000;
      snap.zone = {
        phase: this.royaleZonePhase,
        center: [zone.center[0], zone.center[1]],
        radius: zone.radius,
        remainingMs: Math.round(remaining),
        alive: this.royaleAlive.size,
      };
    }
    if (this.itemGone.length) {
      snap.gone = this.itemGone;
      this.itemGone = [];
    }
    if (this.doorDirty.size) {
      snap.doors = this.doorSnaps(this.doorDirty);
      this.doorDirty.clear();
    }
    this.broadcast(snap);
  }

  private monitorNames = new Map<string, string>();
  private monitorMobId(index: number) { return this.monitorIds[index] ?? 2 + index; }
  private monitorName(mob: number): string {
    if (this.boss?.id === mob) return '值周代号025';
    if (!this.namedMonitors) return '值周生';
    const key = `${this.levelIndex}:${mob}`;
    let name = this.monitorNames.get(key);
    if (!name) { name = monitorDisplayName(this.seed, this.levelIndex, mob); this.monitorNames.set(key, name); }
    return name;
  }

  private mobSent = new Map<number, { kind: string; form: string; st: number; target: number; anim: string; name?: string }>();

  private stepWardenStare(off: boolean): boolean {
    const w = this.warden, env = this.wardenEnv, base = wardenBaseForm(this.levelIndex);
    const viewers = !off && !this.sighting && !this.tension.resting(this.directorTime()) && !this.monitors.some(m => m.blinking)
      && w && env && w.state !== 'catch' && !w.retreating && base !== 'rollcall' && base !== 'finale'
      ? this.prey().filter(p => wardenGazeOn(p, w.p, (a, b) => env.los(a, b) && lineOfSight(this.barrierWorld, a, b))) : [];
    const id = this.wardenStare.step(TICK_MS / 1000, viewers.map(p => p.id));
    if (id === undefined || !w) return false;
    const viewer = viewers.find(p => p.id === id)!;
    w.forceChase(w.p, w.yaw, viewer.id, viewer.p);
    this.tension.observe(this.directorTime(), w);
    return true;
  }

  private mobSnaps(r2: (n: number) => number, full = false): MobSnap[] {
    const out: MobSnap[] = [];
    if (this.level.def.finale) {
      if (this.finalePhase !== 'chase') return out;
      const f = this.finaleAI, p = f?.p ?? [this.level.def.finale.chaseSpawn.x, this.level.def.finale.chaseSpawn.y, this.level.def.finale.chaseSpawn.z] as Vec3;
      out.push(this.mobSnap(1, r2, p, f?.yaw ?? 0, { anim: this.finalePhase === 'chase' ? 'chase' : 'patrol', kind: 'warden', form: 'perfect', st: 0, target: f?.target ?? 0 }, full));
      return out;
    }
    const w = this.level.def.mirror ? undefined : this.warden;
    if (w) out.push(this.mobSnap(1, r2, w.p, w.yaw, { anim: w.anim, kind: 'warden', form: wardenForm(this.levelIndex, this.wardenStare.changed), st: w.state === 'catch' ? 1 : 0, target: w.target ?? 0 }, full));
    if (this.boss) out.push(this.mobSnap(this.boss.id, r2, this.boss.p, this.boss.yaw, { anim: 'idle', kind: 'monitor', name: '值周代号025', form: 'role_boss', st: 0, target: 0 }, full));
    this.monitors.forEach((m, i) => { const id = this.monitorMobId(i); out.push(this.mobSnap(id, r2, m.p, m.yaw, { anim: m.anim, kind: 'monitor', name: this.monitorName(id), form: 'normal', st: m.state === 'hold' ? 1 : 0, target: 0 }, full)); });
    return out;
  }

  private mobSnap(id: number, r2: (n: number) => number, p: Vec3, yaw: number, full: { anim: string; kind: string; name?: string; form: string; st: number; target: number }, force = false): MobSnap {
    const last = this.mobSent.get(id);
    const key = force || !last || this.snapTick % MOB_KEY_TICKS === 0; // keyframe: late joiners / a dropped snap resync within a second
    const e: MobSnap = { id, p: [r2(p[0]), r2(p[1]), r2(p[2])], yaw: r2(yaw) };
    if (key || last!.anim !== full.anim) e.anim = full.anim;
    if (key || last!.kind !== full.kind) e.kind = full.kind;
    if (full.name !== undefined && (key || last!.name !== full.name)) e.name = full.name;
    if (key || last!.form !== full.form) e.form = full.form;
    if (key || last!.st !== full.st) e.st = full.st;
    if (key || last!.target !== full.target) e.target = full.target;
    if (!force) this.mobSent.set(id, full);
    return e;
  }

  /** A reconnect must never depend on another client's delta history or the next periodic keyframe. */
  private fullSnapshot(): Extract<ServerMsg, { t: 'snap' }> {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return { t: 'snap', difficulty: this.difficulty, tick: this.snapTick,
      players: [...this.players.values()].map(p => ({ id: p.conn.id, p: [...p.p], yaw: p.yaw, pitch: p.pitch, f: p.f, st: p.st, bat: r2(p.battery), sta: r2(p.stamina),
        ...(p.st === ST_DOWN && p.heldUntil !== undefined ? { downUntil: this.snapTick + p.heldUntil - this.tick } : {}),
        ...(p.escaped ? { escaped: true } : {}), ...(p.offline ? { online: false as const } : {}) })),
      mobs: this.mobSnaps(r2, true), ...(this.boss ? { boss: this.boss.snapshot() } : {}), doors: this.doorSnaps() };
  }

  broadcastRoom() {
    this.broadcast({
      ...this.lobbySettings,
      t: 'room', difficulty: this.difficulty, guidance: this.guidance, developerMode: this.developerMode, namedMonitors: this.namedMonitors,
      mode: this.mode, code: this.code, host: this.host, started: this.started, level: this.levelIndex, seed: this.seed, incarnation: this.incarnation,
      players: [...this.players.values()].map((p) => ({ id: p.conn.id, name: p.conn.name, ...(p.offline ? { online: false as const } : {}) })),
    });
  }

  broadcast(m: ServerMsg) {
    const s = encode(m);
    for (const p of this.players.values()) if (!p.offline) p.conn.sendRaw(s);
  }
}

/** `nav` cut down to the level's area (nodes inBounds); all of it if no node is in the area (e.g. a test graph). */
export function levelAreaNav(nav: NavGraph, lv: Level): NavGraph {
  if (lv.def.finale) return finaleAreaNav(lv);
  if (lv.def.gym) return gymAreaNav(lv);
  const sub = nav.subgraph((n) => inBounds(lv, n.x, n.y, n.z), // a bridge stays on its storey and in the area
    (a, b) => Math.abs(a.y - b.y) < 0.5 && inBounds(lv, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2));
  if (!sub.nodes.length) return nav;
  // #226: the campus graph chains each room's nodes and never links across chains, so a hall node 1 m from the next
  // room's chain only joined it far round (the arrow led 15 m east and back): link same-storey nodes within NEAR_LINK m
  // a capsule walks between straight, the doors shut and the level's barriers in (never through a door or a wall)
  const w = new CollisionWorld([...(campusData.colliders as AABB[]), ...(campusData.doors as DoorSpot[]).map((d) => campusDoorSlab(d, false)), ...levelSolids(lv.def)]);
  for (const h of campusData.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
  // B/3F has no west bridge, so the campus graph stops at the last classroom. Extend the playable corridor
  // to this level's exit; every link below is still capsule-tested against walls, shut doors and barriers.
  if (lv.def.loop) {
    for (let x = lv.exit.x; x <= lv.spawns[0].x; x += 1.8) sub.addNode({ x, y: lv.exit.y, z: lv.exit.z, tag: `${lv.def.building}:3` });
  }
  const ns = sub.nodes;
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const a = ns[i], b = ns[j];
    if (Math.abs(a.y - b.y) > 0.1 || Math.hypot(a.x - b.x, a.z - b.z) > NEAR_LINK || sub.adj[i].includes(j)) continue;
    const ys = walk(w, a, [[b.x, b.z]]);
    if (ys && Math.abs(ys[0] - b.y) < 0.1) sub.link(i, j);
  }
  if (lv.def.blackout) return connectBlackoutCorridor(sub, lv, w);
  if (lv.def.broadcast) l4StairDoors(sub);
  return sub;
}
/** Max flat gap (m) levelAreaNav links two nodes of different chains across. */
export const NEAR_LINK = 2.5;

/** L7's secret openings change geometry. Recheck the campus edges and add local points through each opened wall. */
export function mirrorAreaNav(nav: NavGraph, lv: Level, world: CollisionWorld): NavGraph {
  const g = new NavGraph(), ids = new Map<number, number>();
  const clear = (p: { x: number; y: number; z: number }) => inBounds(lv, p.x, p.y, p.z)
    && !overlaps(world, { ...p, vy: 0, grounded: true }, NAV_CAPSULE)
    && Math.abs(groundHeight(world, p.x, p.z, NAV_CAPSULE.radius, p.y + NAV_CAPSULE.stepHeight) - p.y) < 0.15;
  const add = (p: { x: number; y: number; z: number; tag?: string }) => clear(p) ? g.addNode(p) : -1;
  nav.nodes.forEach((p, i) => { const j = add(p); if (j >= 0) ids.set(i, j); });
  const walks = (a: number, b: number) => {
    const from = g.nodes[a], to = g.nodes[b], ys = walk(world, from, [[to.x, to.z]]);
    return !!ys && Math.abs(ys[0] - to.y) < 0.15;
  };
  for (const [a, i] of ids) for (const b of nav.adj[a]) {
    const j = ids.get(b);
    if (j !== undefined && i < j && walks(i, j) && walks(j, i)) g.link(i, j);
  }
  // The original campus graph predates the secret doors. These points connect the mirror rooms to their east hall.
  for (const y of [0, 3.6]) {
    for (let x = -81.2; x <= -75.7; x += 0.65) for (let z = 142.1; z <= 146.1; z += 0.65) add({ x, y, z, tag: `LAB:${y ? 2 : 1}` });
    for (const x of [-79, -78.5, -78, -77.5, -77, -76.5]) add({ x, y, z: 143.4, tag: `LAB:${y ? 2 : 1}` });
  }
  for (const p of lv.spawns) add({ x: p.x, y: p.y ?? 0, z: p.z });
  add(lv.exit);
  for (let i = 0; i < g.nodes.length; i++) for (let j = i + 1; j < g.nodes.length; j++) {
    const a = g.nodes[i], b = g.nodes[j];
    if (g.adj[i].includes(j) || Math.abs(a.y - b.y) > 0.1 || Math.hypot(a.x - b.x, a.z - b.z) > 1.8) continue;
    if (walks(i, j) && walks(j, i)) g.link(i, j);
  }
  return g;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private rng: () => number;

  /** `nav`: the campus nav graph for new rooms (called per room, may be cached by the caller); omitted → no monsters. */
  private nav?: () => NavGraph | undefined;
  onRunComplete?: (run: AuthoritativeRun) => void;

  constructor(rng: () => number = Math.random, nav?: () => NavGraph | undefined) { this.rng = rng; this.nav = nav; }

  newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) c += ROOM_CODE_ALPHABET[Math.floor(this.rng() * ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  /** `lobby`: the room waits for its host's `start` (the real server); unit tests default to an already running room. */
  create(lobby = false, initialLevel = 0, difficulty: DifficultyId = 'standard', options: RoomOptions = {}): Room {
    if (this.rooms.size >= MAX_ROOMS) throw new Error('房间数量已满，请稍后再试');
    const room = new Room(this.newCode(), Math.floor(this.rng() * 2 ** 31), this.nav?.(), initialLevel, difficulty, options);
    room.onRunComplete = run => this.onRunComplete?.(run);
    room.started = !lobby;
    room.lateObserve = lobby;
    this.rooms.set(room.code, room);
    return room;
  }

  get(code: string) { return this.rooms.get(code); }

  step(now: number) {
    for (const [code, room] of this.rooms) {
      if (room.players.size === 0 && now - room.emptySince >= 30_000) this.rooms.delete(code);
      else room.step(now);
    }
  }
}

export const MAX_ROOMS = 50;
