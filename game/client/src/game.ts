// In-level client: renderer, local movement with prediction, remote players, input upload.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CROUCH_EYE_H, EXTRAP_MAX_MS, EXTRAP_MAX_SPEED, EYE_H, INTERP_DELAY_MS, SPEED, TICK_MS } from '../../shared/constants.ts';
import { moveCapsule, type Body, type CollisionWorld } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE, beamHit, lineOfSight, type BeamHit, type NavGraph } from '../../shared/campus/nav.ts';
import { campusDoorSlab, doorTargetIn, DOOR_REACH, type DoorSpot } from '../../shared/doors.ts';
import { barrierBox, generateLevel, inBounds, levelSolids, type Level } from '../../shared/level.ts';
import { boxAt, downCand, fuseBoxBounds, FUSE_BOX_CENTER_H, FUSE_BOX_H, inReachDown, hideTarget, pickNear, rayTarget, pingPoint, PING_LEN, PROMPT, KEY_R, KEY_H, HIDE_REACH, ACT_DY, type Cand } from '../../shared/interact.ts';
import { STAMINA_MIN, canRun } from '../../shared/stamina.ts';
import { l1ItemPrompt, l1PickState } from '../../shared/l1Objectives.ts';
import { F_CROUCH, F_HIDE, F_LIGHT, F_RUN, ST_DOWN, ST_OK, ST_SPECTATE, isLineEvent, type Bag, type WorldItem, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import type { CompletionStats, FinaleState } from '../../shared/protocol.ts';
import { rankingNote } from '../../shared/runMode.ts';
import { captureTitle } from '../../shared/studentNames.ts';
import { BroadcastView } from './broadcast.ts';
import { Input, MOUSE_SENSITIVITY } from './input.ts';
import { L7MirrorView, type L7PlayerPose } from './l7-view.ts';
import { L7_CAMPUS_DOORS, l7World, MIRRORS } from '../../shared/levels/l7.ts';
import type { CampaignMirrorSnap } from '../../shared/l7-campaign.ts';
import { mirrorGuideGoal, mirrorKeyCandidate, mirrorKeyReady, mirrorWallCandidates } from './campaignMirror.ts';
import { ReviveHold } from './reviveHold.ts';
import { touchHitState, worldTouchHit, type TouchHit, type TouchMesh, type WorldTouchPhase } from './worldTouch.ts';
import { furnitureHighlightTargets, InteractionHighlight, type HighlightTarget } from './interactionHighlight.ts';
import { cullSkinned, figureInView, Mobs, viewFrustum } from './mobs.ts';
import { Voice } from './voice.ts';
import { JasmineFx } from './fx.ts';
import { AtmosphereFx } from './atmosphere.ts';
import { MonitorMurmurs } from './monitorMurmur.ts';
import { doorSoundPoint, FootstepClock, Sound } from './sound.ts';
import { isNearbyChase, soundThreat } from './soundThreat.ts';
import { Haptics } from './haptics.ts';
import { FeedbackSettings } from './feedbackSettings.ts';
import { CapturePresentation, type CaptureFrame } from './capturePresentation.ts';
import { StoryJournal } from './storyJournal.ts';
import { GameSettings } from './settings.ts';
import { LevelIntro } from './intro.ts';
import { Student, tooClose, BEAM_LEN, BEAM_HALF } from './warden/student.ts';
import { FLASH_ANGLE, FLASH_LIGHT, FLASH_PENUMBRA, FLASH_POS, TEAM_ANGLE, TEAM_LIGHT, TEAM_PENUMBRA, TEAM_REACH, TeamLightPick, beamScore, teammateLightGain, teammatePoolOverlap, type TeamBeam } from './teamlight.ts';
import { TeamActivity } from './teamActivity.ts';
import { CorrectionSmoother, InterpBuffer, PlaybackClock, StepSmoother, approachYaw, frameSlices } from './interp.ts';
import type { Net } from './net.ts';
import { clearResume } from './reconnect.ts';
import { MoveLog } from './reconcile.ts';
import { HeadBob } from './bob.ts';
import { CAMPUS, FLOOR_HEIGHT, eyeIndoors } from './campus/world/campus.ts';
import { campusDoors } from './campus/world/doorway.ts';
import { CampusScene, minuteFromQuery, type PreparedCampus } from './campus/scene.ts';
import { spawnRoute } from './campus/world/navgraph.ts';
import { GymView } from './gym.ts';
import { BossView } from './bossView.ts';
import { ExamRoom, examReachable, examTarget, type ExamTarget } from './exam.ts';

const COLORS = [0xb04a3a, 0x3a6ab0, 0xb09a3a, 0x5aa05a];

interface Remote { mesh: THREE.Object3D; st: Student; buf: InterpBuffer; clock: PlaybackClock; sm: StepSmoother; f: number; down: boolean; out: boolean; escaped: boolean; offline: boolean; pitch: number; marker?: THREE.Sprite }
/** Seconds a teammate must be held with E (mirrors the server's REVIVE_S). */
const REVIVE_HOLD_S = 3;
/** Eye height while downed, m. */
const DOWN_EYE_H = 0.55;
/** Any non-forced correction is blended within CORRECT_BLEND_S (≥ 95 % of the camera offset gone); a replayed position
 *  closer than SOFT_CORRECT_M to where we were is a soft nudge (τ = blend/3), a bigger miss catches up faster (τ = blend/5). */
const SOFT_CORRECT_M = 0.3, CORRECT_BLEND_S = 0.15;
const PING_MS = 4000, PING_GAP_MS = 1000;
// a teammate's rendered body slides (≤1.3× run) to targets this close instead of popping: a lagging B frame can leave it
// 2 m+ behind its playback point (#184 gate: 2.14 m pop); real teleports (tp / respawn) are farther
const REMOTE_SNAP_M = 4;
const _beamO = new THREE.Vector3(), _beamD = new THREE.Vector3(), _toPool = new THREE.Vector3();

/** Red ▼ above a downed teammate; depthTest off so it shows through walls. */
const MARKER_Y = 2.55; // m above a standing teammate's feet
function downMarker(): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e22'; g.strokeStyle = '#000'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(8, 10); g.lineTo(56, 10); g.lineTo(32, 56); g.closePath(); g.stroke(); g.fill();
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false }));
  s.scale.setScalar(0.45);
  s.position.y = MARKER_Y;
  s.renderOrder = 999;
  return s;
}

/** How far an open campus door's leaf turns (rad). */
import { doorSwingDir } from './doorDir';
import { barFrac, touchObjectiveText, touchPrompt } from './hudText.ts';
import { bannerFor, IdleHint, objective, panelFor, type Objective } from './objective.ts';
import { ObjectiveTiming } from './objectiveTiming.ts';
import { buildLoopView } from './loopView.ts';
import type { LoopProgress } from '../../shared/loop.ts';
import { ARRIVED, avoidArrowControls, broadcastGoalPoint, distText, edgeArrow, goalPoint, guideWaypoint, navFromMsg, shutDoorOn, type Goal, type ScreenRect } from './guide.ts';
import { campusMap, drawMap, levelMap, mapFloorAt, mapSize, roomAt, type LevelMap, type MapState } from './map.ts';
import { ZoneHud, nextZoneOf, type ZoneSnap } from './royaleHud.ts';
import { generateZonePhases, type ZonePhase } from '../../shared/royale.ts';
import { Tutorial, tutParts, tutText } from './tutorial.ts';
import { advanceFinaleRoute, buildGoalBeacon, buildRollcallBook, completionText, finaleGoalPoint, finaleObjective, finaleStatusText } from './finale.ts';
import { GATE, gateColliders, gateGeometry, gateSpan, headX } from './campus/world/gate.ts';
const DOOR_SWING = Math.PI * 0.47;
/** Level start banner (title + goal) / a new step's goal line, in the centre. */
const LEVEL_BANNER_MS = 3000, STEP_BANNER_MS = 2000;
/** 目标箭头: items in this range with a clear line from the eye count as found; the arrow's inset from the view edge. */
const SEEN_R = 8, ARROW_MARGIN = (w: number) => (w < 900 ? 34 : 46);
/** The idle hint stays a bit longer than a toast: it is a sentence to read. */
const IDLE_HINT_MS = 4500;

/** A flat label texture: `text` (lines split by \n) in `fg` on `bg`, with a thin border. */
function textTex(text: string, fg: string, bg: string, w: number, h: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = fg; g.lineWidth = 4; g.strokeRect(4, 4, w - 8, h - 8);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  const lines = text.split('\n');
  g.font = `bold ${Math.floor((h * 0.6) / lines.length)}px sans-serif`;
  lines.forEach((l, i) => g.fillText(l, w / 2, (h * (i + 1)) / (lines.length + 1)));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Group yaw turning local +z to a level def's `face` / `dir`. */
const FACE_YAW = { 'z+': 0, 'z-': Math.PI, 'x+': Math.PI / 2, 'x-': -Math.PI / 2 } as const;
/** Where a collider of the last level's barriers goes when the new level has fewer (CollisionWorld has no remove). */
const PARKED = { minX: 9e3, maxX: 9e3, minY: -9e3, maxY: -9e3, minZ: 9e3, maxZ: 9e3 };

/** A chalk arrow pointing up the texture, `text` under it, on transparent ground; slightly smudged strokes. */
function chalkArrow(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 384;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(238,238,228,0.92)'; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const [w, a] of [[22, 0.35], [14, 1]] as const) {
    g.globalAlpha = a; g.lineWidth = w;
    g.beginPath(); g.moveTo(128, 250); g.lineTo(128, 40); g.moveTo(58, 112); g.lineTo(128, 36); g.lineTo(198, 112); g.stroke();
  }
  if (text) {
    g.globalAlpha = 0.9; g.fillStyle = 'rgba(238,238,228,1)';
    g.font = 'bold 72px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 320);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft round glow (white, fading to transparent at the rim) for additive light pools. */
function glowTex(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!, r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,0.55)'); r.addColorStop(0.5, 'rgba(255,255,255,0.22)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** These level-only props own their resources; clones and repeated material slots share them within this batch. */
function disposeLevelProps(roots: THREE.Object3D[]) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), maps = new Set<THREE.Texture>();
  for (const root of roots) {
    root.removeFromParent();
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) geometries.add(o.geometry);
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
      }
    });
  }
  for (const m of materials) {
    const map = (m as THREE.MeshBasicMaterial | THREE.SpriteMaterial).map;
    if (map) maps.add(map);
  }
  for (const map of maps) map.dispose();
  for (const m of materials) m.dispose();
  for (const g of geometries) g.dispose();
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly atmosphere: AtmosphereFx;
  readonly scene = new THREE.Scene();
  readonly interactionHighlight = new InteractionHighlight(this.scene);
  readonly camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
  readonly input: Input;
  private readonly reviveHold: ReviveHold;
  readonly intro: LevelIntro;
  private introView?: { yaw: number; pitch: number };
  private introShown = false;
  private reloadLevel = false;
  readonly flashlight = new THREE.SpotLight(0xfff2d0, FLASH_LIGHT, 30, FLASH_ANGLE, FLASH_PENUMBRA, 2);
  /**
   * The 手电 of the (up to) two lit teammates whose beam pools cover most of the screen (teamlight.ts): real lights with
   * the player's torch's reach and shape, always in the scene (a fixed light count: no shader recompiles as people switch
   * theirs on and off) and at intensity 0 when nobody qualifies. decay 2 ≥ TORCH_DECAY: they light interiors.
   */
  readonly teamLights = [0, 1].map(() => new THREE.SpotLight(0xfff2d0, 0, 30, TEAM_ANGLE, TEAM_PENUMBRA, 2));
  private readonly beamHit: BeamHit = { t: 0, nx: 0, ny: 0, nz: 0 };
  /** Which lit teammates hold teamLights (by screen share of the beam's pool), and each one's beam this frame. */
  readonly teamPick = new TeamLightPick<number>(2);
  private readonly beamScores = new Map<number, number>();
  private readonly beams = new Map<number, TeamBeam>();
  level!: Level;
  gym?: GymView;
  get gymState() { return this.gym?.state; }
  /** Royale zone state (phase, center, radius, countdown, alive). */
  private royaleZone: ZoneSnap | undefined;
  /** Zone table regenerated from the room seed (shared/royale.ts) only to preview the next circle; the server's snap rules. */
  private zonePhases: readonly ZonePhase[] = [];
  private zoneHud?: ZoneHud;
  private get nextZone(): ZonePhase | undefined { return this.royaleZone && nextZoneOf(this.zonePhases, this.royaleZone); }
  readonly loopPlayers = new Map<number, LoopProgress>();
  private loopView?: ReturnType<typeof buildLoopView>;
  completed = false;
  /** Pause prediction while the authoritative level transition is covered by its black screen. */
  private fadeUntil = 0;
  /** A same-seed restart still reloads its state, even though its chapter number did not change. */
  private awaitingLevel = false;
  readonly capture: CapturePresentation;
  private captureFrameState: CaptureFrame = { phase: 'idle', elapsed: 0, progress: 0, lowering: 0, pitch: 0, roll: 0,
    grayscale: 0, veil: 0, cover: 0, shoulder: 0, reach: 0, side: 'right', by: 'warden', caught: false };
  get captureFrame(): CaptureFrame { return { ...this.captureFrameState }; }
  private lastCaptureSeq = 0;
  private lastSnapTick = -1;
  /** Preserve the exact contact point while the capture camera settles into the downed pose. */
  private captureOrigin?: { at: Vec3; yaw: number; pitch: number };
  /** A forced spawn after a fade identifies a new episode, even when its level and seed repeat. */
  private levelHandoff: 'fade' | 'spawn' | null = null;
  /** Server incarnation changes on a new attempt; roster updates keep the current one. */
  private loadedIncarnation = -1;
  /** Per-player warp epochs also protect remote buffers from a repeated older warp. */
  private warpEpochs = new Map<number, number>();
  /** Campus rooms: the ported campus at night with capsule movement (shared/campus). */
  campus: CampusScene;
  readonly story: StoryJournal;
  private storyInputEnabled = true;
  worldReady = false;
  private spawnSynced = false;
  /** L7 shares this Game and Net; only its campus solids and mirror passes change. */
  mirrorView?: L7MirrorView;
  mirrorState?: CampaignMirrorSnap;
  private mirrorCollision?: CollisionWorld;
  private mirrorDoorBoxes = new Map<number, number>();
  private campusObjects: THREE.Object3D[] = [];
  private campusVisibility = new Map<THREE.Object3D, boolean>();
  private campusBeforeRender?: THREE.Scene['onBeforeRender'];
  private campusFog?: THREE.Scene['fog'];
  private campusBackground?: THREE.Scene['background'];
  get collision(): CollisionWorld { return this.mirrorCollision ?? this.campus.collision; }
  get presentationReady() { return this.spawnSynced && this.worldReady; }
  /** The opening was actually presented and its reading interval has finished. */
  get openingComplete() { return this.presentationReady && !this.objectiveTiming.pending && !this.openingBanner; }
  /** Campus feet position + vertical state (y is real: stairs, floors); `pos` mirrors its x/z. */
  body: Body = { x: 0, y: 0, z: 0, vy: 0, grounded: true };
  /** Server position corrections received (a clean client prediction never gets one). */
  corrections = 0;
  /** Camera offset that slides a rejected prediction back to the server's position over ~0.1 s instead of a one-frame jump. */
  private smooth = new CorrectionSmoother();
  private bob = new HeadBob();
  /** e2e/debug: walk the given (x, z) waypoints, route[0] being the start; null when idle or finished. */
  private route: [number, number][] | null = null;
  private routeAt = 0;
  /** Debug/screenshot camera override (window.__escape.view). */
  view: { x: number; y: number; z: number; yaw: number; pitch: number } | null = null;
  /** Door state by id, mirrored from the server. */
  doorOpen: boolean[] = [];
  /** Closable doors: the campus's (world/doorway.ts campusDoors); the index is the wire id. */
  doors: DoorSpot[] = [];
  private campusDoorBox: number[] = [];
  private autoDoorAt = 0;
  private doorMesh?: THREE.InstancedMesh;
  /** Campus doors' 把手 (one instance per door, rides the leaf) and swing progress 0 (shut)..1 (open) by id. */
  private knobMesh?: THREE.InstancedMesh;
  private doorSwing: number[] = [];
  /** Cosmetic anticipation only: the authoritative closed slab stays solid until the server agrees. */
  private readonly doorPreview = new Map<number, number>();
  private doorDir: number[] = []; // +1/-1: which side the leaf swings to, away from whoever opened it
  readonly sound: Sound;
  readonly haptics = new Haptics();
  readonly feedbackSettings: FeedbackSettings;
  readonly settings: GameSettings;
  private settingsUnlockPending = false;
  private steps = new FootstepClock();
  private remoteSteps = new Map<number, FootstepClock>();
  private lastFeedbackSnap = -Infinity;
  private pendingFeedback?: { kind: string; id: number; until: number };
  private dangerFeedback = false;
  private readonly feedbackCleanups: (() => void)[] = [];
  private feedbackDisposed = false;
  private pausedForNetwork = false;
  private feedbackEpoch = 0;
  get networkPaused() { return this.pausedForNetwork; }
  /** A lost connection discards prediction and action edges; the authoritative correct is applied before release. */
  setNetworkPaused(paused: boolean) {
    const entering = paused && !this.pausedForNetwork;
    this.pausedForNetwork = paused;
    if (paused) this.clearDoorPreviews();
    if (paused) ++this.feedbackEpoch;
    if (entering) {
      for (const r of [...this.remotes.values(), ...this.mobs.byId.values()]) {
        r.buf = new InterpBuffer(); r.clock = new PlaybackClock(INTERP_DELAY_MS); r.sm.reset();
      }
    }
    this.broadcastView?.pauseFeedback();
    this.input.clear(); this.input.enabled = !paused && !this.completed && !this.intro.active;
    this.route = null; this.sendAcc = 0;
    this.moves.clear(); this.smooth.reset();
    this.sound.reset(); this.haptics.cancel(); this.voice.silence();
    this.monitorMurmurs.pause();
    this.steps.reset(); this.remoteSteps.clear();
    this.pendingFeedback = undefined; this.dangerFeedback = false;
    this.lastFeedbackSnap = -Infinity;
    if (paused) {
      this.humStop(); this.jasmine.update(Infinity);
      const count = document.querySelector('#down-overlay .n'); if (count && this.down) count.textContent = '…';
    }
    else { this.lastFeedbackSnap = performance.now(); this.light = !!(this.myF & F_LIGHT); }
  }
  pos = { x: 0, z: 0 };
  eye = EYE_H;
  light = false; // design: the torch starts off (F toggles) so the opening is dark
  remotes = new Map<number, Remote>();
  /** Player names by id (filled by main.ts from the room message). */
  names = new Map<number, string>();
  private readonly teamActivity = new TeamActivity();
  readonly mobs = new Mobs(this.scene);
  private readonly bossView = new BossView(this.scene);
  private jasmine: JasmineFx;
  private readonly voice = new Voice();
  private readonly monitorMurmurs = new MonitorMurmurs();
  private voiceEpoch = 0;
  snaps = 0;
  /** e2e only (`?nodraw` starts with false): false skips the WebGL draw and hides the canvas (update, interpolation and animation still run) so 3
   *  swiftshader clients fit on one CPU; a visible canvas under changing HUD CSS still costs ~0.8 s per composite there. */
  private drawOn = true;
  get draw() { return this.drawOn; }
  set draw(v: boolean) { this.drawOn = v; this.renderer.domElement.style.visibility = v ? '' : 'hidden'; }
  private seq = 0;
  /** The last correction epoch the server sent (echoed in every input so it can drop ones predicted before it). */
  private corrC = 0;
  /** Predicted moves not yet known to be accepted, replayed on top of a rejecting `correct`. */
  private moves = new MoveLog();
  private sendAcc = 0;
  private last = performance.now();
  /** Physical clue sheets and the server's shared answer sheet, only in the exam chapter. */
  exam?: ExamRoom;
  private examModal = false;
  private examHadLock = false;
  private examWasEnabled = true;
  private examBlackout?: { floor: number; until: number };

  readonly net: Net;
  myId: number;

  constructor(net: Net, myId: number, container: HTMLElement, prepared?: PreparedCampus, sound = new Sound()) {
    this.net = net;
    this.myId = myId;
    this.sound = sound;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, stencil: true, powerPreference: 'high-performance' });
    const touch = document.body.classList.contains('touch'); // mobile: DPR 1, nearer fog (no post-processing exists to turn off)
    const q = new URLSearchParams(location.search);
    this.renderer.setPixelRatio(touch ? 1 : Math.min(devicePixelRatio, 1.5));
    this.atmosphere = new AtmosphereFx(this.scene, { touch, steady: q.has('steady') });
    container.appendChild(this.renderer.domElement);
    this.jasmine = new JasmineFx(); // after the canvas, including when its downed-state filter creates a stacking context
    this.capture = new CapturePresentation(() => this.myId, {
      camera: this.camera, worldCaptor: () => this.mobs.byId.get(1)?.warden.mesh,
    });
    void this.capture.prewarm(this.renderer, this.scene);
    this.input = new Input(this.renderer.domElement);
    const readPaper = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const canvas = this.renderer.domElement, rect = canvas.getBoundingClientRect();
      const captured = document.pointerLockElement === canvas;
      if (!this.touchInteractAt(captured ? rect.left + rect.width / 2 : event.clientX, captured ? rect.top + rect.height / 2 : event.clientY)) return;
      // Opening a sheet releases the mouse. Do not let Input recapture it on this same click.
      event.preventDefault(); event.stopImmediatePropagation();
    };
    this.renderer.domElement.addEventListener('click', readPaper, true);
    this.feedbackCleanups.push(() => this.renderer.domElement.removeEventListener('click', readPaper, true));
    this.input.onInteract = () => this.interactPressed(performance.now());
    this.reviveHold = new ReviveHold({
      target: () => this.heldReviveTarget(),
      send: id => this.net.sendNow({ t: 'act', kind: 'revive', id }),
      cancel: id => { this.net.sendNow({ t: 'act', kind: 'revive_cancel', id }); this.hideReviveRing(); },
    });
    this.input.onChange = () => {
      if (!this.input.enabled) this.touchPending = this.touchRevive = null;
      this.reviveHold.sync();
    };
    const cancelHold = () => { this.touchPending = this.touchRevive = null; this.input.clear(); this.reviveHold.stop(); };
    const visibility = () => { if (document.visibilityState === 'hidden') cancelHold(); };
    addEventListener('blur', cancelHold);
    addEventListener('pagehide', cancelHold);
    document.addEventListener('visibilitychange', visibility);
    this.feedbackCleanups.push(() => removeEventListener('blur', cancelHold), () => removeEventListener('pagehide', cancelHold),
      () => document.removeEventListener('visibilitychange', visibility));
    this.intro = new LevelIntro(this.scene, this.camera, (id) => this.net.send({ t: 'intro-skip', id }),
      () => {
        cancelHold(); this.input.enabled = false; this.introView = undefined;
        this.route = null; this.moves.clear(); this.bob = new HeadBob();
        this.introShown = true; this.setObjectivePaused('intro', true); this.clearBanner(); this.tut.stop();
        this.broadcastView?.close(); this.toggleMap(false);
        this.story.toggle(false); this.story.setVisible(false);
        const chat = document.getElementById('chat-input') as HTMLInputElement | null;
        if (chat) { chat.hidden = true; chat.blur(); }
        this.input.enabled = false;
      },
      () => {
        if (this.introView) { this.input.yaw = this.introView.yaw; this.input.pitch = this.introView.pitch; }
        this.introView = undefined; this.input.clear();
        this.input.enabled = !this.feedbackDisposed && !this.pausedForNetwork && !this.completed && document.getElementById('chat-input')?.hidden !== false;
        this.eye = EYE_H; this.smooth.reset();
        if (this.spawnSynced) {
          this.camera.position.set(this.pos.x, this.body.y + EYE_H, this.pos.z);
          this.camera.rotation.set(this.input.pitch, this.input.yaw, 0);
          this.camera.updateMatrixWorld();
        }
        this.steps.reset(); this.remoteSteps.clear(); this.moves.clear(); this.sendAcc = 0;
        this.setObjectivePaused('intro', false);
      },
      () => { this.sound.tone('sine', 64, 0.11, 1.1, 38); this.sound.tone('triangle', 83, 0.035, 0.85, 47); });
    this.input.onInteraction = () => this.objectiveTiming.input();
    this.feedbackSettings = new FeedbackSettings((p) => {
      this.sound.setPreferences(p.volume, p.muted);
      this.voice.setPreferences(p.volume, p.muted);
      this.monitorMurmurs.setPreferences(p.volume, p.muted);
      this.haptics.setEnabled(p.haptics);
    });
    let resumeInput: (() => void) | undefined;
    this.settings = new GameSettings(this.feedbackSettings, {
      touch,
      onOpen: () => {
        if (document.pointerLockElement === this.renderer.domElement) this.settingsUnlockPending = true;
        resumeInput = this.input.suspend();
        this.haptics.cancel();
      },
      onClose: (reason) => {
        resumeInput?.(); resumeInput = undefined;
        // Escape has a browser capture cooldown. The next canvas click can retry it.
        if ((reason === 'button' || reason === 'backdrop') && this.canControl) this.input.requestPointerLock();
      },
      onChange: (p) => {
        this.input.sensitivity = MOUSE_SENSITIVITY * p.sensitivity;
        this.interactionHighlight.setEnabled(p.interactionHighlights);
        this.jasmine.setPostprocessing(p.postprocessing);
        this.atmosphere.setEnabled(p.postprocessing);
        if (this.renderer.getPixelRatio() !== p.pixelRatio) {
          this.renderer.setPixelRatio(p.pixelRatio);
          this.resize();
        }
      },
    });
    // Network messages never unlock audio. Capture also sees native settings and touch gestures.
    const unlock = (e: Event) => {
      if (!e.isTrusted || (e instanceof KeyboardEvent && e.repeat)) return;
      this.sound.unlock(); this.haptics.unlock();
    };
    for (const event of ['pointerdown', 'touchend', 'keydown']) {
      addEventListener(event, unlock, { capture: true, passive: event === 'touchend' });
      this.feedbackCleanups.push(() => removeEventListener(event, unlock, true));
    }
    const hide = () => { this.haptics.cancel(); this.objectiveTiming.pause(); };
    addEventListener('pagehide', hide);
    this.feedbackCleanups.push(() => removeEventListener('pagehide', hide));
    const pauseObjective = () => { if (document.hidden) this.objectiveTiming.pause(); };
    document.addEventListener('visibilitychange', pauseObjective);
    this.feedbackCleanups.push(() => document.removeEventListener('visibilitychange', pauseObjective));
    if (touch) this.input.worldTouch = (phase, x, y) => this.onWorldTouch(phase, x, y);
    this.campus = new CampusScene(this.scene, minuteFromQuery(location.search), prepared);
    this.story = new StoryJournal(this.scene, myId, (from, to) => lineOfSight(this.campus.collision, from, to), this.camera);
    this.story.onRead = () => { this.readStory(); };
    this.story.onOpenChange = (open) => {
      this.input.clear();
      if (open) { this.storyInputEnabled = this.input.enabled; this.input.enabled = false; }
      else this.input.enabled = this.storyInputEnabled && !this.feedbackDisposed && !this.completed
        && document.getElementById('chat-input')?.hidden !== false && document.getElementById('broadcast-keypad')?.hidden !== false;
    };
    // The global notebook shortcut clears held movement before toggling. Ignore it in royale before it bubbles there.
    const storyKey = (event: KeyboardEvent) => {
      const editing = (target: EventTarget | null) => target instanceof HTMLElement
        && !!target.closest('input, textarea, select, [contenteditable="true"]');
      if (this.royaleZone && event.code === 'KeyJ' && !event.isComposing && event.keyCode !== 229
        && !editing(event.target) && !editing(document.activeElement)) event.preventDefault();
    };
    addEventListener('keydown', storyKey, true);
    this.feedbackCleanups.push(() => removeEventListener('keydown', storyKey, true));
    if (touch && this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density *= 1.5;
    this.campusObjects = [...this.scene.children];
    this.campusBeforeRender = this.scene.onBeforeRender;
    this.campusFog = this.scene.fog;
    this.campusBackground = this.scene.background;
    this.scene.onAfterRender = () => this.mirrorView?.renderMirrors();
    this.scene.add(this.camera);
    this.camera.add(this.flashlight);
    this.flashlight.position.set(...FLASH_POS);
    this.flashlight.target.position.set(0, 0, -1);
    this.camera.add(this.flashlight.target);
    for (const l of this.teamLights) this.scene.add(l, l.target);
    this.camera.rotation.order = 'YXZ';
    document.getElementById('rollcall-close')?.addEventListener('click', () => this.closeRollcall());
    document.getElementById('finale-restart')?.addEventListener('click', () => this.net.send({ t: 'restart' }));
    document.addEventListener('keydown', (e) => {
      if (!this.rollcallOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); this.closeRollcall(); }
      else if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) this.closeRollcall();
    });
    this.bindFinaleTouch();
    addEventListener('resize', () => this.resize());
    this.resize();
    if (q.has('nodraw')) this.draw = false;
    if (q.has('steady')) this.campus.steady = true;
  }

  /** Release feedback resources on disconnect/page teardown; repeated calls are harmless. */
  disposeFeedback() {
    if (this.feedbackDisposed) return;
    this.feedbackDisposed = true;
    this.clearDoorPreviews();
    this.input.enabled = false; this.input.clear(); this.objectiveTiming.pause();
    this.clearBanner(); this.tut.stop();
    ++this.voiceEpoch;
    this.touchPending = this.touchRevive = null;
    this.reviveHold.dispose();
    this.input.onChange = undefined;
    for (const cleanup of this.feedbackCleanups.splice(0)) cleanup();
    this.settings.dispose();
    this.sound.dispose(); this.haptics.dispose(); this.feedbackSettings.dispose(); this.voice.dispose(); this.monitorMurmurs.dispose(); this.jasmine.dispose(); this.zoneHud?.dispose(); this.capture.dispose();
    this.renderer.domElement.style.filter = '';
    this.gym?.dispose(this.scene);
    this.bossView.dispose(this.scene);
    this.story.destroy();
    this.atmosphere.dispose();
    this.intro.dispose();
    this.interactionHighlight.dispose();
    this.steps.reset(); this.remoteSteps.clear();
    this.exam?.dispose(this.scene); this.exam = undefined;
  }

  private cancelVoice() {
    ++this.voiceEpoch;
    this.voice.cancel();
    this.monitorMurmurs.reset();
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    if (this.mapOn) this.sizeMap();
  }

  /** Local overlays can pause controls while the shared room keeps running. */
  get canControl() { return this.input.enabled && !this.completed && performance.now() >= this.fadeUntil && !this.feedbackDisposed; }

  /** Consume even while controls are suspended: the browser can report our unlock after the panel closes. */
  consumeSettingsUnlock() {
    const pending = this.settingsUnlockPending;
    this.settingsUnlockPending = false;
    return pending;
  }

  broadcastView?: BroadcastView;
  private resetCapture() {
    this.capture.reset();
    this.captureFrameState = this.capture.update(performance.now());
    this.captureOrigin = undefined;
    this.renderer.domElement.style.filter = '';
  }
  loadLevel(index: number, seed: number, force = false, resumed = false, incarnation?: number) {
    // A retry's pending force request must not consume roster updates from its
    // old attempt. The server incarnation takes priority when it is present.
    if (this.level?.index === index && this.level.seed === seed
      && (incarnation === undefined ? !force && this.levelHandoff !== 'spawn' : this.loadedIncarnation === incarnation)) {
      if (this.completion) this.renderCompletion(this.completion);
      this.story.enter(index, seed, this.level.def);
      this.story.setVisible(this.storyCanShow());
      return false;
    }
    if (incarnation !== undefined) this.loadedIncarnation = incarnation;
    this.clearDoorPreviews();
    this.levelHandoff = null;
    this.cancelVoice();
    this.awaitingLevel = false;
    this.bossView.receive();
    this.resetCapture();
    this.setDown(false); this.setSpectate(false); this.downUntil = undefined;
    this.jasmine.reset();
    const hadFinale = !!this.level?.def.finale;
    this.exam?.dispose(this.scene);
    this.exam = undefined;
    this.examBlackout = undefined;
    this.campus.outFloor = null;
    this.interactionHighlight.setGroup('level', []);
    this.interactionHighlight.setGroup('items', []);
    this.teamActivity.clear();

    this.touchPending = this.touchRevive = null;
    this.reviveHold.stop();
    this.reloadLevel = false;
    this.intro.reset(); this.introView = undefined; this.introShown = false;
    this.clearBanner(); this.tut.stop(); this.input.clear();
    this.input.enabled = !this.feedbackDisposed && !this.pausedForNetwork && document.getElementById('chat-input')?.hidden !== false;
    this.broadcastView?.dispose();
    this.gym?.dispose(this.scene);
    this.touchPending = this.touchRevive = null;
    this.mirrorView?.dispose(); this.mirrorView = undefined; this.mirrorState = undefined; this.mirrorCollision = undefined; this.mirrorDoorBoxes.clear();
    for (const [o, visible] of this.campusVisibility) o.visible = visible;
    this.campusVisibility.clear();
    this.scene.onBeforeRender = this.campusBeforeRender ?? (() => {});
    this.scene.fog = this.campusFog ?? null; this.scene.background = this.campusBackground ?? null;
    this.level = generateLevel(index, seed);
    this.campus.world.boards?.setRosterSeed(seed);
    this.gym = this.level.def.gym ? new GymView(this.scene, this.level.def.gym) : undefined;
    if (hadFinale || this.level.def.finale) {
      this.finaleRouteIndex = 0;
      this.escaped = false;
      this.setDown(false);
      this.setSpectate(false);
      this.setHiding(0, [this.body.x, this.body.y, this.body.z]);
      this.finalState = null;
      this.completion = null;
      for (const timer of this.rollcallPending.values()) clearTimeout(timer);
      this.rollcallPending.clear();
      this.closeRollcall();
      this.hideCompletion();
      this.input.enabled = !this.pausedForNetwork;
      this.input.clear();
    }
    this.story.enter(index, seed, this.level.def);
    this.story.setAvailable(false);
    this.story.setVisible(false);
    this.sound.reset(); this.steps.reset(); this.remoteSteps.clear(); this.haptics.cancel();
    this.pendingFeedback = undefined; this.dangerFeedback = false;
    this.broadcastView = this.level.def.broadcast ? new BroadcastView(this.level.def.broadcast, this.level.def.hides, this.scene, this.input, this.net, this.voice) : undefined;
    this.completed = false;
    this.fadeUntil = 0;
    this.route = null;
    this.loopPlayers.clear();
    this.warpEpochs.clear();
    if (this.loopView) { this.scene.remove(this.loopView.root); this.loopView.dispose(); }
    this.loopView = buildLoopView(this.level.def);
    this.scene.add(this.loopView.root);
    this.fusesIn = 0;
    this.bag = {}; // the server resends the new level's bag right after the room msg
    this.buildBlackout();
    this.buildDoors();
    this.buildBarriers();
    this.campus.setLandmarks(this.level.def.landmarks);
    if (this.level.def.exam) this.exam = new ExamRoom(this.level.def.exam, seed, this.scene, (msg) => {
      // Recheck at send time: a correction can move us between frames and a button press.
      const target = this.exam?.activeTarget;
      if (target && this.canReadExam(target)) this.net.send(msg);
      else this.exam?.close(false);
    }, (open, resume) => this.setExamModal(open, resume), this.level.def.exit);
    if (this.level.def.mirror) {
      for (const o of this.campusObjects) { this.campusVisibility.set(o, o.visible); o.visible = false; }
      this.scene.onBeforeRender = () => {};
      this.scene.fog = new THREE.FogExp2('#182723', .024);
      this.scene.background = new THREE.Color('#111e1d');
      for (const d of L7_CAMPUS_DOORS) { this.doorOpen[d.id] = true; this.doorSwing[d.id] = 1; this.doorLocked[d.id] = false; }
      this.rebuildMirrorCollision([]);
      this.mirrorView = new L7MirrorView(this.scene, this.camera, this.renderer);
    }
    this.refreshDoors();
    if (hadFinale || this.level.def.finale) this.setupFinaleWorld();
    this.refreshLevelHighlights();
    this.spawnSynced = false;
    this.pos = { x: this.body.x, z: this.body.z };
    this.objCur = -1;
    this.obj = undefined;
    this.tut.stop(); this.tutLast = ''; this.tutUsed = false;
    if (this.tutEl) this.tutEl.hidden = true;
    this.seen.clear();
    this.guide = null;
    this.guideAt = 0;
    this.loadPlan();
    this.objectivePauses.clear();
    this.objectiveTiming.reset();
    this.openingBanner = false;
    this.openingTutorial = false;
    this.tut.stop();
    const banner = document.getElementById('banner');
    if (banner) banner.hidden = true;
    const objectivePanel = document.getElementById('objective');
    if (objectivePanel) objectivePanel.hidden = false;
    this.refreshObjective(); // Panel now; opening banner after input or stable presented frames.
    if (resumed) this.objectiveTiming.pending = false;
    if (this.drawOn) void this.mobs.prewarm(this.renderer, this.camera); // the first summon must not stall on shader links
    return true;
  }

  private canReadExam(target: ExamTarget) {
    const feet = { x: this.pos.x, y: this.body.y, z: this.pos.z };
    return !!this.exam && !this.down && !this.spectate && this.hiding < 0
      && examReachable(this.exam.def, target, feet, { ...feet, y: feet.y + this.eye }, (a, b) => lineOfSight(this.campus.collision, a, b));
  }

  /** Canvas clicks and phone taps select the visible physical sheet at their screen coordinates. */
  touchInteractAt(x: number, y: number) {
    if (!this.exam || this.exam.open || !this.input.enabled || this.completed || performance.now() < this.fadeUntil || this.mapOn) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
    const ray = new THREE.Raycaster();
    this.camera.updateMatrixWorld();
    ray.setFromCamera(new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2), this.camera);
    this.exam.group.updateWorldMatrix(true, true);
    const target = this.exam.targetAt(ray, (point) => lineOfSight(this.campus.collision, this.camera.position, point));
    if (!target || !this.canReadExam(target)) return false;
    if (target.kind === 'paper') this.exam.openPaper();
    else this.exam.openNotice(target.index);
    return true;
  }

  private setExamModal(open: boolean, resume = true) {
    if (open === this.examModal) return;
    this.examModal = open;
    this.input.clear();
    if (open) {
      this.examHadLock = document.pointerLockElement === this.renderer.domElement;
      this.examWasEnabled = this.input.enabled;
      this.input.enabled = false;
      this.route = null;
      document.exitPointerLock?.();
      this.toggleMap(false);
    } else {
      const chat = document.getElementById('chat-input');
      this.input.enabled = this.examWasEnabled && (!chat || chat.hidden);
      (document.activeElement as HTMLElement | null)?.blur();
      if (resume && this.examHadLock && this.input.pointerLock && this.input.enabled) void this.renderer.domElement.requestPointerLock?.()?.catch(() => {});
    }
  }

  hostId = 0;
  finalState: FinaleState | null = null;
  completion: CompletionStats | null = null;
  private rollcallOpen = false;
  private rollcallPending = new Map<number, number>();
  private register?: ReturnType<typeof buildRollcallBook>;
  private goalBeacon?: THREE.Group;
  private finaleGateOpen = false;
  private finaleGateSlab = -1;
  private finaleRouteIndex = 0;

  /** The south gate is open for the last chapter only; mutate this scene's private collision copy and gate mesh. */
  private openFinaleGate() {
    this.setFinaleGate(true);
  }

  private setFinaleGate(open: boolean, force = false) {
    if (!force && this.finaleGateOpen === open) return;
    this.finaleGateOpen = open;
    const shut = gateColliders(CAMPUS.wall, 0)[2], slab = gateColliders(CAMPUS.wall, open ? 1 : 0)[2];
    if (this.finaleGateSlab < 0) this.finaleGateSlab = this.campus.collision.boxes.findIndex((b) => b.minX === shut.minX && b.maxX === shut.maxX && b.minZ === shut.minZ && b.maxZ === shut.maxZ && b.maxY === shut.maxY);
    if (this.finaleGateSlab >= 0) this.campus.collision.move(this.finaleGateSlab, slab);
    const old = this.campus.world.gate.mesh.geometry;
    this.campus.world.gate.mesh.geometry = gateGeometry(CAMPUS.wall, open ? 1 : 0);
    const gate = this.campus.world.gate;
    gate.open = gate.target = open ? 1 : 0;
    gate.led?.position.set(headX(CAMPUS.wall, gate.open) + GATE.head.w / 2, 0, gateSpan(CAMPUS.wall).z);
    old.dispose();
  }

  private setupFinaleWorld() {
    if (this.register) {
      this.scene.remove(this.register.root);
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
      this.register.root.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) geometries.add(m.geometry); const ms = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []; for (const mat of ms) { materials.add(mat); const map = (mat as THREE.MeshBasicMaterial).map; if (map) textures.add(map); } });
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
      this.register = undefined;
    }
    if (this.goalBeacon) this.goalBeacon.visible = false;
    const def = this.level.def.finale;
    if (!def) { this.setFinaleGate(false, true); return; }
    this.setFinaleGate(false, true);
    this.register = buildRollcallBook(this.scene, def.rollcall, document.body.classList.contains('touch'));
    this.goalBeacon ??= buildGoalBeacon(this.scene);
  }

  private isRegisterNear(): boolean {
    const def = this.level?.def.finale;
    if (!def || this.finalState?.phase === 'chase' || this.finalState?.phase === 'complete' || this.down || this.spectate || this.escaped || this.hiding >= 0 || !this.spawnSynced) return false;
    const p = def.rollcall, dx = this.pos.x - p.x, dz = this.pos.z - p.z;
    if (Math.hypot(dx, dz) > 2.1 || Math.abs(this.body.y - p.y) > 1.6) return false;
    return lineOfSight(this.campus.collision, this.camera.position, { x: p.x, y: p.y + 0.98, z: p.z });
  }

  /** Local bridge for the chapter's book; shared mobile object picking can call this same guarded action. */
  tapFinaleObject(clientX: number, clientY: number): boolean {
    if (!this.register || !this.input.enabled || this.completion || this.completed || this.rollcallOpen || this.mapOn || performance.now() < this.fadeUntil || !this.isRegisterNear()) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    this.camera.updateMatrixWorld();
    this.register.root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2), this.camera);
    // The cover, ring and legible floating label are all part of this book's touch target.
    if (!ray.intersectObject(this.register.root, true).length) return false;
    this.openRollcall();
    return this.rollcallOpen;
  }

  private bindFinaleTouch() {
    let tap: { id: number; x: number; y: number; at: number } | undefined;
    const start = (e: TouchEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!document.body.classList.contains('touch') || !target || !(target.closest('#touch-look') || target === this.renderer.domElement)) return;
      if (e.touches.length > 1 || !this.input.enabled || !this.isRegisterNear()) { tap = undefined; return; }
      const t = e.changedTouches[0];
      if (t) tap = { id: t.identifier, x: t.clientX, y: t.clientY, at: performance.now() };
    };
    const move = (e: TouchEvent) => {
      if (!tap) return;
      const t = Array.from(e.changedTouches).find(t => t.identifier === tap!.id);
      if (t && Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > 12) tap = undefined;
    };
    const end = (e: TouchEvent) => {
      if (!tap) return;
      const t = Array.from(e.changedTouches).find(t => t.identifier === tap!.id);
      if (!t) return;
      const gesture = tap; tap = undefined;
      if (performance.now() - gesture.at > 350 || Math.hypot(t.clientX - gesture.x, t.clientY - gesture.y) > 12) return;
      this.tapFinaleObject(t.clientX, t.clientY);
    };
    const cancel = () => { tap = undefined; };
    document.addEventListener('touchstart', start, { capture: true, passive: true });
    document.addEventListener('touchmove', move, { capture: true, passive: true });
    document.addEventListener('touchend', end, { capture: true, passive: true });
    document.addEventListener('touchcancel', cancel, { capture: true, passive: true });
    this.feedbackCleanups.push(() => {
      document.removeEventListener('touchstart', start, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', end, true);
      document.removeEventListener('touchcancel', cancel, true);
    });
  }

  private openRollcall() {
    const panel = document.getElementById('rollcall-panel');
    if (!panel || !this.level?.def.finale || !this.isRegisterNear()) return;
    this.rollcallOpen = true;
    this.toggleMap(false);
    this.input.enabled = false;
    this.input.clear();
    document.exitPointerLock?.();
    panel.hidden = false;
    this.renderRollcall();
    document.getElementById('rollcall-close')?.focus({ preventScroll: true });
  }

  private closeRollcall() {
    this.rollcallOpen = false;
    const panel = document.getElementById('rollcall-panel');
    if (panel) panel.hidden = true;
    if (this.input) this.input.enabled = !this.escaped && !this.completion && !this.completed && document.getElementById('chat-input')?.hidden !== false;
  }

  private renderRollcall() {
    const state = this.finalState;
    const panel = document.getElementById('rollcall-panel'), list = document.getElementById('rollcall-list');
    if (!panel || !list || !this.rollcallOpen) return;
    const stage = document.getElementById('rollcall-stage');
    if (stage) stage.textContent = state ? finaleStatusText(state) : '等待服务器同步队员名单…';
    const members = state?.members ?? [];
    list.replaceChildren(...members.map((member) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      const name = document.createElement('span'), mark = document.createElement('span');
      button.type = 'button';
      button.className = `roll${member.crossedOut ? ' crossed' : ''}${this.rollcallPending.has(member.id) ? ' pending' : ''}`;
      name.className = 'name'; name.textContent = member.name + (member.id === this.myId ? '（你）' : '');
      mark.className = 'mark';
      mark.textContent = member.status === 'left' ? '已离队 · 不阻塞' : member.crossedOut ? '✓ 已划掉' : this.rollcallPending.has(member.id) ? '等待确认…' : '点此划名';
      button.disabled = member.status === 'left' || member.crossedOut || this.rollcallPending.has(member.id) || state?.phase !== 'rollcall';
      button.append(name, mark);
      button.addEventListener('click', () => {
        if (!this.isRegisterNear() || this.finalState?.phase !== 'rollcall' || member.crossedOut || this.rollcallPending.has(member.id)) return;
        this.rollcallPending.set(member.id, window.setTimeout(() => { this.rollcallPending.delete(member.id); this.renderRollcall(); }, 1800));
        this.renderRollcall();
        this.net.send({ t: 'act', kind: 'rollcall', id: member.id });
      });
      li.appendChild(button);
      return li;
    }));
  }

  private renderCompletion(stats: CompletionStats | Extract<ServerMsg, { t: 'royale-settle' }>) {
    const panel = document.getElementById('finale-result');
    if (!panel) return;
    this.closeRollcall();
    this.toggleMap(false);
    this.sound.reset(); this.steps.reset(); this.remoteSteps.clear(); this.haptics.cancel();
    this.input.enabled = false;
    this.input.clear();
    this.route = null;
    document.exitPointerLock?.();
    panel.hidden = false;
    if (stats.t === 'royale-settle') { this.renderRoyaleRanking(panel, stats); return; }
    panel.setAttribute('aria-label', '逃出校门结算');
    const title = panel.querySelector('.ft'); if (title) title.textContent = '夜校 · 结局';
    document.getElementById('royale-return')?.remove();
    const view = completionText(stats), summary = document.getElementById('finale-summary'), members = document.getElementById('finale-members');
    if (summary) {
      summary.innerHTML = `八关总用时 <strong>${view.time}</strong><br>全队倒地 <strong>${view.downs}</strong> 次`;
      if (stats.ranking) {
        const note = document.createElement('p'); note.id = 'completion-ranking'; note.textContent = rankingNote(stats.ranking);
        summary.append(note);
      }
    }
    if (members) members.replaceChildren(...view.members.map((member) => {
      const li = document.createElement('li'), name = document.createElement('span'), result = document.createElement('span');
      name.textContent = member.name;
      result.textContent = `${member.result} · 倒地 ${member.downs} 次`;
      if (member.escaped) result.className = 'escaped';
      li.append(name, result);
      return li;
    }));
    const restart = document.getElementById('finale-restart') as HTMLButtonElement | null;
    if (restart) restart.hidden = this.hostId !== this.myId;
    const hint = document.getElementById('finale-restart-hint');
    if (hint) hint.textContent = this.hostId === this.myId ? '房主可使用同一地图和种子重玩这一关' : '等待房主决定是否重玩…';
  }

  private renderRoyaleRanking(panel: HTMLElement, stats: Extract<ServerMsg, { t: 'royale-settle' }>) {
    panel.setAttribute('aria-label', '大逃杀结算');
    const title = panel.querySelector('.ft'); if (title) title.textContent = '大逃杀 · 本局结束';
    const ranking = [...stats.ranking].sort((a, b) => a.rank - b.rank);
    const champion = ranking.find(p => p.rank === 1), mine = ranking.find(p => p.id === this.myId);
    const playerName = (id: number) => this.names.get(id) ?? `玩家 ${id}`;
    const summary = document.getElementById('finale-summary');
    if (summary) {
      const winner = document.createElement('strong'), place = document.createElement('strong');
      winner.textContent = champion ? playerName(champion.id) : '无人获胜';
      place.textContent = mine ? `第 ${mine.rank} 名` : '本局旁观';
      summary.replaceChildren('冠军：', winner, document.createElement('br'), '你的名次：', place);
    }
    const members = document.getElementById('finale-members');
    if (members) members.replaceChildren(...ranking.map(p => {
      const li = document.createElement('li'), name = document.createElement('span'), rank = document.createElement('span');
      name.textContent = `${playerName(p.id)}${p.id === this.myId ? '（你）' : ''}`;
      rank.textContent = `第 ${p.rank} 名${p.rank === 1 ? ' · 冠军' : ''}`;
      if (p.rank === 1) rank.className = 'escaped';
      li.append(name, rank); return li;
    }));
    const restart = document.getElementById('finale-restart'); if (restart) restart.hidden = true;
    const hint = document.getElementById('finale-restart-hint');
    if (hint) hint.textContent = '本局已结束，返回大厅可创建新房间';
    let back = document.getElementById('royale-return');
    if (!back) {
      back = document.createElement('button'); back.id = 'royale-return';
      back.setAttribute('type', 'button'); back.textContent = '返回大厅';
      back.style.cssText = 'min-height:48px;padding:10px 20px;font:inherit;color:#102018;font-weight:700;background:#a7d7b5;border:0;border-radius:4px;box-shadow:0 3px 0 #3c7552;cursor:pointer';
      back.addEventListener('click', () => { clearResume(); this.net.close(); location.reload(); });
      panel.insertBefore(back, hint);
    }
    for (const id of ['objective', 'spec-bar', 'prompt', 'team', 'down-overlay', 'revive-ring']) {
      const el = document.getElementById(id); if (el) el.hidden = true;
    }
    this.clearBanner(); this.tut.stop();
    this.zoneHud?.dispose(); this.zoneHud = undefined;
    back.focus({ preventScroll: true });
  }

  private hideCompletion() {
    const panel = document.getElementById('finale-result');
    if (panel) panel.hidden = true;
    const restart = document.getElementById('finale-restart') as HTMLButtonElement | null;
    if (restart) restart.hidden = true;
    if (this.input) this.input.enabled = !this.completed && !this.completion;
  }

  /** 停电关 (LevelDef.blackout): the 配电箱 on the wall and two green emergency lamps; the campus goes dark until the fuses are in. */
  private fusesIn = 0;
  private blackoutObjs: THREE.Object3D[] = [];
  private fuseLamp?: THREE.Mesh;
  private buildBlackout() {
    disposeLevelProps(this.blackoutObjs);
    this.blackoutObjs = [];
    this.fuseLamp = undefined;
    const bo = this.level.def.blackout;
    this.campus.blackout = this.campus.dark = !!bo;
    if (!bo) return;
    // 配电箱: a grey steel cabinet with a lighter door, a hinge side, a handle, a 高压 plate and the status lamp
    const box = new THREE.Group();
    box.userData.touchFuse = true;
    const steel = new THREE.MeshLambertMaterial({ color: 0x5a6068 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, FUSE_BOX_H, 0.16), steel);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.82, 0.03), new THREE.MeshLambertMaterial({ color: 0x78808a }));
    door.position.set(0, 0, -0.095);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.04), new THREE.MeshLambertMaterial({ color: 0xc8c8c0 }));
    handle.position.set(0.22, -0.05, -0.13);
    box.add(body, door, handle);
    for (const hy of [-0.3, 0.3]) {
      const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.05), steel);
      hinge.position.set(-0.32, hy, -0.1);
      box.add(hinge);
    }
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.2), new THREE.MeshBasicMaterial({ map: textTex('⚡ 配电箱 ⚡\n高压危险', '#e8d020', '#1a1a1a', 256, 128) }));
    plate.position.set(0, 0.22, -0.112);
    plate.rotation.y = Math.PI;
    box.add(plate);
    this.fuseLamp = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff2010 }));
    this.fuseLamp.position.set(-0.2, -0.28, -0.125);
    box.add(this.fuseLamp);
    box.position.set(bo.fuseBox.x, bo.fuseBox.y + FUSE_BOX_CENTER_H, bo.fuseBox.z + 0.1);
    this.blackoutObjs.push(box);
    // 应急灯: a green 安全出口 sign (lit box, 出口 / EXIT) over each exit, with a faint glow on the floor
    const signMat = new THREE.MeshBasicMaterial({ map: textTex('出口 EXIT', '#ffffff', '#139a45', 256, 96) });
    const edge = new THREE.MeshLambertMaterial({ color: 0x1c5a34 });
    for (const e of bo.emergency) {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.26, 0.08), [edge, edge, edge, edge, edge, signMat]);
      sign.position.set(e.x, e.y + 2.45, e.z + 1.4);
      const light = new THREE.PointLight(0x30ff70, 1.2, 9, 1.6);
      light.position.copy(sign.position).add(new THREE.Vector3(0, -0.2, -0.3));
      this.blackoutObjs.push(sign, light);
    }
    for (const o of this.blackoutObjs) this.scene.add(o);
  }
  /**
   * The level's barriers (def.barriers: 铁栅门 / 堆叠课桌 across the ways out of its area, the same boxes the server
   * collides with) and its wayfinding landmarks (粉笔箭头, 消火栓). Rebuilt per level; old colliders are parked far away.
   */
  private barrierObjs: THREE.Object3D[] = [];
  private barrierIds: number[] = [];
  private examGateObj?: THREE.Object3D;
  private examGateId?: number;
  private examGatePassed?: boolean;
  private finaleFenceResources?: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[]; textures: THREE.Texture[] };
  private buildBarriers() {
    disposeLevelProps(this.barrierObjs);
    this.finaleFenceResources = undefined;
    this.barrierObjs = [];
    if (this.royaleZone) {
      for (const id of this.barrierIds) this.campus.collision.move(id, PARKED);
      if (this.examGateId !== undefined) this.campus.collision.move(this.examGateId, PARKED);
      return;
    }
    if (this.level.def.mirror) return;
    this.examGateObj = undefined; this.examGatePassed = undefined;
    const col = this.campus.collision, gate = this.level.def.exam?.exitGate;
    if (this.examGateId !== undefined) col.move(this.examGateId, PARKED);
    const bs = gate ? [...this.level.def.barriers, gate] : this.level.def.barriers, solids = levelSolids(this.level.def);
    solids.forEach((box, i) => {
      if (i < this.barrierIds.length) col.move(this.barrierIds[i], box);
      else this.barrierIds.push(col.add(box));
    });
    for (let i = solids.length; i < this.barrierIds.length; i++) col.move(this.barrierIds[i], PARKED);
    const iron = new THREE.MeshLambertMaterial({ color: 0x34373c }), rust = new THREE.MeshLambertMaterial({ color: 0x7a4a2a });
    const wood = new THREE.MeshLambertMaterial({ color: 0xa8743e }), leg = new THREE.MeshLambertMaterial({ color: 0x5a5e66 });
    const fenceChain = new THREE.MeshLambertMaterial({ color: 0x9a9aa0 }), fenceLock = new THREE.MeshLambertMaterial({ color: 0xc8a030 });
    const fenceNotes = new Map<string, THREE.MeshLambertMaterial>();
    for (const b of bs) {
      // local frame: u along the barrier, v towards the players (face side), y up from b.y
      const alongX = b.face[0] === 'z', len = alongX ? b.x1 - b.x0 : b.z1 - b.z0, dep = alongX ? b.z1 - b.z0 : b.x1 - b.x0;
      const g = new THREE.Group();
      g.position.set((b.x0 + b.x1) / 2, b.y, (b.z0 + b.z1) / 2);
      g.rotation.y = FACE_YAW[b.face];
      const add = (m: THREE.Mesh, u: number, y: number, v: number, ry = 0, rz = 0) => { m.position.set(u, y, v); m.rotation.set(0, ry, rz); g.add(m); return m; };
      if (b.kind === 'grate') {
        for (const u of [-len / 2 + 0.04, len / 2 - 0.04]) add(new THREE.Mesh(new THREE.BoxGeometry(0.08, b.h, dep), iron), u, b.h / 2, 0);
        for (const y of [0.08, b.h * 0.5, b.h - 0.06]) add(new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, dep * 0.6), y < 1 ? rust : iron), 0, y, 0);
        const bar = new THREE.CylinderGeometry(0.018, 0.018, b.h, 6);
        for (let u = -len / 2 + 0.14; u < len / 2 - 0.1; u += 0.13) add(new THREE.Mesh(bar, iron), u, b.h / 2, 0);
        // a chain wound across the middle and a brass padlock on the players' side
        const link = new THREE.TorusGeometry(0.035, 0.009, 4, 8), chain = fenceChain;
        for (let k = -5; k <= 5; k++) add(new THREE.Mesh(link, chain), k * 0.055, b.h * 0.5 + 0.12 - Math.abs(k) * 0.025, dep / 2 + 0.03, k % 2 ? Math.PI / 2 : 0);
        add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.04), fenceLock), 0, b.h * 0.5 - 0.08, dep / 2 + 0.05);
      } else {
        // 堆叠课桌: a row of upright desks with more piled on top upside down / tipped, filling the box
        const n = Math.max(1, Math.round(len / 1.15)), w = len / n;
        const desk = (u: number, y: number, flip: boolean, tilt: number, ry: number) => {
          const d = new THREE.Group();
          const top = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.04, Math.min(0.6, dep)), wood);
          top.position.y = flip ? 0.02 : 0.72; d.add(top);
          for (const lu of [-1, 1]) for (const lv of [-1, 1]) {
            const l = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.7, 0.035), leg);
            l.position.set(lu * (w * 0.42), flip ? 0.39 : 0.35, lv * Math.min(0.26, dep / 2 - 0.04)); d.add(l);
          }
          d.position.set(u, y, 0); d.rotation.set(0, ry, tilt); g.add(d);
        };
        for (let k = 0; k < n; k++) {
          const u = -len / 2 + w * (k + 0.5);
          desk(u, 0, false, 0, (k % 2 ? 0.06 : -0.05));
          if (b.h > 1.2) desk(u + (k % 2 ? 0.08 : -0.1), 0.76, true, k % 2 ? 0.12 : -0.18, k % 2 ? -0.1 : 0.15);
        }
        if (b.tape) { // 封条: two crossed red-on-white strips over the pile
          const tex = textTex('封 条', '#c01818', '#eeeae0', 512, 64), tape = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
          const diag = Math.hypot(len, b.h), ang = Math.atan2(b.h, len);
          for (const s of [1, -1]) add(new THREE.Mesh(new THREE.PlaneGeometry(diag * 0.95, 0.14), tape), 0, b.h / 2, dep / 2 + 0.02 + (s > 0 ? 0 : 0.005), 0, s * ang);
        }
      }
      // a paper notice with the barrier's line, at eye height on the players' side
      const lines = b.say.split('，').join('\n');
      let noteMat = this.level.def.finale ? fenceNotes.get(lines) : undefined;
      if (!noteMat) { noteMat = new THREE.MeshLambertMaterial({ map: textTex(lines, '#202020', '#f2eee2', 512, 248) }); if (this.level.def.finale) fenceNotes.set(lines, noteMat); }
      const note = add(new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.3), noteMat), 0, Math.min(b.h - 0.25, 1.5), dep / 2 + 0.04);
      note.rotation.z = 0.04;
      if (b === gate) { g.name = 'EXAM_EXIT_GATE'; this.examGateObj = g; }
      this.barrierObjs.push(g);
    }
    if (this.level.def.finale) this.batchFinaleFences();
    for (const m of this.level.def.landmarks) {
      const g = new THREE.Group();
      g.position.set(m.x, m.y, m.z);
      g.rotation.y = FACE_YAW[m.dir];
      if (m.kind === 'arrow') { // chalk on the floor, the arrow (and text) pointing along dir
        const c = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.3), new THREE.MeshLambertMaterial({ map: chalkArrow(m.text ?? ''), transparent: true, depthWrite: false }));
        c.rotation.x = -Math.PI / 2; c.position.y = 0.015;
        g.add(c);
      } else if (m.kind === 'sign') { // 门牌 hanging out from the wall on a bracket, readable (not mirrored) from both ends of the corridor
        const signMat = new THREE.MeshBasicMaterial({ map: textTex(m.text ?? '', '#f4f4ee', '#1e4f8c', 384, 128) });
        for (const s of [1, -1]) { // two single-sided plates back to back
          const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.3), signMat);
          plate.position.set(s * 0.006, 2.25, 0.5); plate.rotation.y = s * Math.PI / 2; g.add(plate);
        }
        const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.98), leg);
        bracket.position.set(0, 2.44, 0.49); g.add(bracket);
      } else if (m.kind === 'lit') { // the one classroom whose lights are still on: a glowing tube and a warm pool on the floor
        if (this.level.def.exam) g.userData.examLampFloor = Math.round(m.y / 3.6);
        const tube = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 0.12), new THREE.MeshBasicMaterial({ color: 0xfff4d8 }));
        tube.position.set(0, 2.95, 0); g.add(tube);
        const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 4.5), new THREE.MeshBasicMaterial({ map: glowTex(), color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        pool.rotation.x = -Math.PI / 2; pool.position.y = 0.04; g.add(pool);
        // no real light (the interior shader drops PointLights, and an extra SpotLight stalled software-GL frames at the
        // level switch, x-bounds #214): a wider second pool and a halo round the tube carry the glow instead
        const wide = pool.clone(); wide.scale.setScalar(1.5); wide.position.y = 0.03; g.add(wide);
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: 0xffe8c0, blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.scale.set(2.6, 1.3, 1); halo.position.set(0, 2.9, 0); g.add(halo);
      } else if (m.kind === 'fallen') { // a desk on its side against the wall, top facing dir, a chair tipped over in front
        const d = new THREE.Group(); g.add(d);
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.6, 0.04), wood);
        top.position.set(0, 0.32, 0.3); d.add(top);
        for (const u of [-0.5, 0.5]) for (const y of [0.08, 0.56]) {
          const l = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.6), leg);
          l.position.set(u, y, -0.02); d.add(l);
        }
        d.rotation.z = 0.12;
        const chair = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.4), wood);
        chair.position.set(0.25, 0.12, 0.55); chair.rotation.set(0.5, 0.6, 0); g.add(chair);
        // a battery 应急灯 on the wall above it, so the dead end shows up as one from down the corridor
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.14, 0.1), new THREE.MeshLambertMaterial({ color: 0xe8e4d8 }));
        box.position.set(0, 2.2, 0.05); g.add(box);
        const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.02), new THREE.MeshBasicMaterial({ color: 0xfff0c8 }));
        bulb.position.set(0, 2.16, 0.11); g.add(bulb);
        const halo = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.8), new THREE.MeshBasicMaterial({ map: glowTex(), color: 0xa08868, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.position.set(0, 1.7, 0.03); g.add(halo); // its wash on the wall, the desk dark against it
        const pool = new THREE.Mesh(new THREE.PlaneGeometry(3, 2.4), new THREE.MeshBasicMaterial({ map: glowTex(), color: 0x806a50, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        pool.rotation.x = -Math.PI / 2; pool.position.set(0, 0.02, 1.1); g.add(pool);
      } else { // 消火栓 cabinet on the wall, its glass door and label facing dir
        const red = new THREE.MeshLambertMaterial({ color: 0xc81a14 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.22), red);
        body.position.set(0, 1.0, 0); g.add(body);
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshLambertMaterial({ color: 0xd8e6ea, transparent: true, opacity: 0.45 }));
        glass.position.set(0, 1.08, 0.115); g.add(glass);
        const hose = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.04, 6, 16), new THREE.MeshLambertMaterial({ color: 0xe0d8c0 }));
        hose.position.set(0, 1.08, 0.04); g.add(hose);
        const label = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.14), new THREE.MeshBasicMaterial({ map: textTex('消火栓', '#ffffff', '#c81a14', 256, 72) }));
        label.position.set(0, 0.68, 0.115); g.add(label);
      }
      this.barrierObjs.push(g);
    }
    for (const o of this.barrierObjs) this.scene.add(o);
    this.syncExamGate(false);
  }
  /** The server's accepted paper state opens the same physical exit barrier on every client. */
  private syncExamGate(passed: boolean) {
    const gate = this.level.def.exam?.exitGate;
    if (!gate || passed === this.examGatePassed) return;
    this.examGatePassed = passed;
    if (this.examGateObj) this.examGateObj.visible = !passed;
    const col = this.campus.collision, solid = passed ? PARKED : barrierBox(gate);
    if (this.examGateId === undefined) this.examGateId = col.add(solid);
    else col.move(this.examGateId, solid);
  }
  /** Thousands of repeated exterior fence bars become one mesh per material, preserving their authored shapes. */
  private batchFinaleFences() {
    const parts = new Map<THREE.Material, THREE.BufferGeometry[]>(), originals = new Set<THREE.BufferGeometry>();
    for (const root of this.barrierObjs) {
      root.updateMatrixWorld(true);
      root.traverse(o => {
        if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
        const bucket = parts.get(o.material) ?? [];
        bucket.push(o.geometry.clone().applyMatrix4(o.matrixWorld));
        parts.set(o.material, bucket);
        originals.add(o.geometry);
      });
    }
    this.barrierObjs = [];
    for (const [material, geometries] of parts) {
      const geometry = mergeGeometries(geometries, false);
      geometries.forEach(g => g.dispose());
      if (!geometry) throw new Error('Finale fence geometry must remain merge-compatible');
      geometry.computeBoundingSphere();
      this.barrierObjs.push(new THREE.Mesh(geometry, material));
    }
    originals.forEach(g => g.dispose());
    const materials = [...parts.keys()];
    this.finaleFenceResources = {
      geometries: this.barrierObjs.map(o => (o as THREE.Mesh).geometry),
      materials,
      textures: [...new Set(materials.map(m => (m as THREE.MeshLambertMaterial).map).filter((t): t is THREE.Texture => !!t))],
    };
  }

  /** Barriers as crosshair candidates (kind 'use', id -1 - index: client-only, E says why it's shut). */
  private barrierCands(out: Cand[]) {
    this.level.def.barriers.forEach((b, i) => out.push({ kind: 'use', id: -1 - i, min: [b.x0, b.y, b.z0], max: [b.x1, b.y + b.h, b.z1] }));
    const gate = this.level.def.exam?.exitGate;
    if (gate && !this.exam?.state.passed) out.push({ kind: 'use', id: -1 - this.level.def.barriers.length,
      min: [gate.x0, gate.y, gate.z0], max: [gate.x1, gate.y + gate.h, gate.z1] });
  }
  /** Doors out of the level's area: locked for good (the server never opens them). */
  private regionLocked(id: number): boolean {
    const d = this.doors[id];
    return !!d && !inBounds(this.level, d.x, d.y0 ?? 0, d.z);
  }

  /** Cache the real interactable surfaces once; pickups have their own replaceable group. */
  private refreshLevelHighlights() {
    const targets: HighlightTarget[] = [];
    for (const door of this.doors) {
      if (!inBounds(this.level, door.x, door.y0 ?? 0, door.z) || !this.doorMesh) continue;
      targets.push({ key: `use:${door.id}`, position: [door.x, ((door.y0 ?? 0) + (door.y1 ?? 3)) / 2, door.z], floorY: door.y0 ?? 0,
        sources: [{ object: this.doorMesh, instanceId: door.id }, ...(this.knobMesh ? [{ object: this.knobMesh, instanceId: door.id }] : [])] });
    }
    this.level.def.barriers.forEach((barrier, id) => {
      const object = this.barrierObjs[id];
      if (object) targets.push({ key: `use:${-1 - id}`, position: [(barrier.x0 + barrier.x1) / 2, barrier.y + barrier.h / 2, (barrier.z0 + barrier.z1) / 2], floorY: barrier.y, sources: [{ object }] });
    });
    const bo = this.level.def.blackout;
    if (bo) for (const object of this.blackoutObjs) if (object.userData.touchFuse)
      targets.push({ key: 'fuse:0', position: [bo.fuseBox.x, bo.fuseBox.y + FUSE_BOX_CENTER_H, bo.fuseBox.z], floorY: bo.fuseBox.y,
        sources: [{ object }], enabled: () => this.fusesIn < bo.fuses });
    const building = CAMPUS.buildings.find(building => building.id === this.level.def.building);
    if (building && !this.broadcastView) targets.push(...furnitureHighlightTargets(building, this.level.def.hides, this.level.exit.y));
    targets.push(...this.broadcastView?.highlightTargets() ?? []);
    this.interactionHighlight.setGroup('level', targets);
  }

  private refreshItemHighlights() {
    this.interactionHighlight.setGroup('items', this.items.flatMap(item => {
      const object = this.itemMeshes.get(item.id);
      return object ? [{ key: `pick:${item.id}`, position: item.p, floorY: item.p[1],
        sources: [{ object }] }] : [];
    }));
  }
  setPower(n: number) {
    const bo = this.level.def.blackout;
    if (!bo || n === this.fusesIn) return;
    if (!this.pausedForNetwork && n > this.fusesIn) { this.click(); this.toast(n >= bo.fuses ? '电来了，门禁亮了' : `保险丝 ${n}/${bo.fuses}`); }
    this.fusesIn = n;
    this.refreshObjective();
    this.campus.blackout = n < bo.fuses;
    (this.fuseLamp?.material as THREE.MeshBasicMaterial | undefined)?.color.setHex(n >= bo.fuses ? 0x30ff60 : 0xff2010);
  }

  private buildDoors() {
    const campus = this.campus;
    if (this.doorMesh) return; // the campus's doors don't depend on the level
    const defs = this.doors = campusDoors(CAMPUS);
    this.doorOpen = defs.map(() => false);
    this.doorSwing = defs.map(() => 0);
    this.doorDir = defs.map(() => 1);
    this.campusDoorBox = defs.map((d) => campus.collision.add(campusDoorSlab(d, false)));
    const mat = new THREE.MeshLambertMaterial({ color: 0x3b2a1a });
    this.doorMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, Math.max(1, defs.length));
    this.doorMesh.frustumCulled = false;
    this.scene.add(this.doorMesh);
    this.knobMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xa8a29a }), Math.max(1, defs.length));
    this.knobMesh.frustumCulled = false;
    this.scene.add(this.knobMesh);
    this.refreshDoors();
  }

  private refreshDoors() {
    if (!this.doorMesh) return;
    for (const d of this.doors) {
      this.placeLeaf(d);
      this.syncSlab(d);
    }
    this.doorMesh.instanceMatrix.needsUpdate = true;
    this.knobMesh!.instanceMatrix.needsUpdate = true;
  }

  /** Ordinary LAB doors keep the same snapshots, leaf animation and collision as the other chapters. */
  private rebuildMirrorCollision(open: readonly number[]) {
    this.mirrorCollision = l7World(open);
    this.mirrorDoorBoxes.clear();
    for (const d of L7_CAMPUS_DOORS) this.mirrorDoorBoxes.set(d.id,
      this.mirrorCollision.add(campusDoorSlab(d, !!this.doorOpen[d.id] && this.doorSwing[d.id] >= .5)));
  }

  private activeDoors(): readonly DoorSpot[] { return this.level.def.mirror ? L7_CAMPUS_DOORS : this.doors; }

  /** A campus door's leaf and 把手 at its current swing: hinged on the box's low end of its long side, turned up to ~90°. */
  private placeLeaf(d: DoorSpot) {
    if (this.level.def.mirror && !L7_CAMPUS_DOORS.some(q => q.id === d.id)) {
      const hidden = new THREE.Matrix4().makeTranslation(0, -1000, 0);
      this.doorMesh!.setMatrixAt(d.id, hidden); this.knobMesh!.setMatrixAt(d.id, hidden);
      return;
    }
    const sx = d.box.x1 - d.box.x0, sz = d.box.z1 - d.box.z0;
    const len = d.alongX ? sx : sz, thick = Math.min(sx, sz), h = d.y1! - d.y0! - 0.02;
    const swing = this.doorSwing[d.id] ?? 0;
    const hinge = new THREE.Vector3(d.alongX ? d.box.x0 : d.x, d.y0!, d.alongX ? d.z : d.box.z0);
    const base = new THREE.Matrix4().makeTranslation(hinge.x, hinge.y, hinge.z)
      .multiply(new THREE.Matrix4().makeRotationY((d.alongX ? 0 : -Math.PI / 2) + swing * DOOR_SWING * (this.doorDir[d.id] ?? 1)));
    const leaf = base.clone().multiply(new THREE.Matrix4().makeTranslation(len / 2, h / 2, 0)).scale(new THREE.Vector3(len, h, thick));
    this.doorMesh!.setMatrixAt(d.id, leaf);
    // a bar through the leaf at hand height near its free end, standing 6 cm proud of both faces
    const knob = base.clone().multiply(new THREE.Matrix4().makeTranslation(len - 0.18, Math.min(1.0, h * 0.45), 0)).scale(new THREE.Vector3(0.12, 0.06, thick + 0.12));
    this.knobMesh!.setMatrixAt(d.id, knob);
  }

  /** Collision slab follows the visible leaf: sinks once the swing is half way, rises as soon as it starts closing. */
  private syncSlab(d: DoorSpot) {
    const open = !!this.doorOpen[d.id] && (this.doorSwing[d.id] ?? 0) >= 0.5;
    this.campus.collision.move(this.campusDoorBox[d.id], campusDoorSlab(d, open));
    const mirrorId = this.mirrorDoorBoxes.get(d.id);
    if (mirrorId !== undefined) this.mirrorCollision?.move(mirrorId, campusDoorSlab(d, open));
  }

  private clearDoorPreviews() {
    if (!this.doorPreview?.size) return;
    for (const id of this.doorPreview.keys()) this.doorSwing[id] = this.doorOpen[id] ? 1 : 0;
    this.doorPreview.clear();
    this.refreshDoors();
  }

  private previewDoor(id: number, now: number) {
    const d = this.doors?.[id];
    if (!d || this.doorOpen[id] || this.doorLocked[id] || this.regionLocked(id)
      || Math.abs(this.body.y - (d.y0 ?? 0)) >= ACT_DY
      || Math.hypot(this.pos.x - d.x, this.pos.z - d.z) > DOOR_REACH) return;
    this.doorDir[id] = doorSwingDir(d, this.pos);
    this.doorPreview.set(id, now + 650);
  }

  /** Ease every campus door's swing toward its target; redraw only the ones moving. */
  private animateDoors(dt: number) {
    if (!this.knobMesh) return;
    let moved = false;
    for (const d of this.doors) {
      const until = this.doorPreview.get(d.id);
      if (until !== undefined && performance.now() >= until) this.doorPreview.delete(d.id);
      // Stay below the half-swing collision threshold. A refusal/timeout eases back to closed.
      const to = this.doorOpen[d.id] ? 1 : this.doorPreview.has(d.id) ? .45 : 0, cur = this.doorSwing[d.id];
      if (cur === to) continue;
      this.doorSwing[d.id] = cur < to ? Math.min(to, cur + dt * 2.5) : Math.max(to, cur - dt * 2.5);
      this.placeLeaf(d);
      this.syncSlab(d);
      moved = true;
    }
    if (moved) { this.doorMesh!.instanceMatrix.needsUpdate = true; this.knobMesh.instanceMatrix.needsUpdate = true; }
  }

  /** Server-confirmed creak/thud, with stereo bearing, floor/distance falloff and wall muffling. */
  private doorSound(d: DoorSpot, open: boolean) {
    const point = doorSoundPoint(this.camera.position, d);
    this.sound.door(point, open, !lineOfSight(this.collision, this.camera.position, point));
    const pending = this.pendingFeedback;
    if (pending?.kind === 'use' && pending.id === d.id && performance.now() <= pending.until) {
      this.haptics.pulse('door'); this.pendingFeedback = undefined;
    }
  }

  /** Door ids the team holds keys for (server 'keys' message). */
  heldKeys: number[] = [];
  /** Rendered pickups and the L1 locked drawer, also used by direct world taps. */
  private itemMeshes = new Map<number, THREE.Object3D>();
  private itemMat = {
    key: new THREE.MeshLambertMaterial({ color: 0xe0b020, emissive: 0x403000 }),
    battery: new THREE.MeshLambertMaterial({ color: 0x40c040, emissive: 0x103010 }),
    fuse: new THREE.MeshLambertMaterial({ color: 0xe0c030, emissive: 0x403000 }),
    decoy: new THREE.MeshLambertMaterial({ color: 0x879097, emissive: 0x15181b }),
    drawer: new THREE.MeshLambertMaterial({ color: 0x76512f }),
    metal: new THREE.MeshLambertMaterial({ color: 0x34383c }),
  };
  private items: WorldItem[] = [];
  private doorLocked: boolean[] = [];
  private promptEl = document.getElementById('prompt');

  /** What the crosshair ray hits right now: doors, key items, downed teammates. */
  target(eye: Vec3 = [this.camera.position.x, this.camera.position.y, this.camera.position.z]): Cand | null {
    const cands: Cand[] = this.broadcastView?.candidates() ?? [];
    for (const d of this.activeDoors()) {
      const y0 = d.y0 ?? 0;
      if (Math.abs(this.body.y - y0) < 1.5) cands.push({ kind: 'use', id: d.id, min: [d.box.x0, y0, d.box.z0], max: [d.box.x1, d.y1 ?? y0 + 3, d.box.z1] });
    }
    const bo = this.level.def.blackout;
    if (bo && this.fusesIn < bo.fuses && (this.bag.fuse ?? 0) > 0) cands.push({ kind: 'fuse', id: 0, ...fuseBoxBounds([bo.fuseBox.x, bo.fuseBox.y, bo.fuseBox.z]) });
    this.level.def.gym?.switches.forEach((s, id) => cands.push({ kind: 'gym-switch', id, ...boxAt([s.x, s.y, s.z], 0.44, 1.9) }));
    for (const k of this.items) cands.push({ kind: 'pick', id: k.id, ...boxAt(k.p, KEY_R, KEY_H) });
    this.barrierCands(cands);
    if (this.mirrorState) {
      if (this.mirrorKeyAvailable()) cands.push(mirrorKeyCandidate());
      cands.push(...mirrorWallCandidates(this.mirrorState));
    }
    for (const [id, p] of this.peers) if (id !== this.myId && p.st === ST_DOWN && p.online) cands.push({ kind: 'revive', id, ...downCand(p.p, p.yaw) });
    const hit = rayTarget(eye, this.input.yaw, this.input.pitch, cands);
    if (hit) return hit;
    // a key in reach in front of us beats the hiding place next to it (the ray easily passes over a small key on a desk)
    const k = pickNear(this.items, [this.pos.x, this.body.y, this.pos.z], this.input.yaw);
    return k >= 0 ? { kind: 'pick', id: this.items[k].id, ...boxAt(this.items[k].p, KEY_R, KEY_H) } : null;
  }

  private mirrorKeyAvailable(): boolean {
    return !!this.mirrorState && mirrorKeyReady({ p: [this.pos.x, this.body.y, this.pos.z], yaw: this.input.yaw, pitch: this.input.pitch, st: this.down ? ST_DOWN : this.spectate ? ST_SPECTATE : ST_OK }, this.mirrorState, this.collision);
  }

  private touchRevive: { id: number; x: number; y: number } | null = null;
  private touchPending: { hit: TouchHit | null; x: number; y: number } | null = null;
  private readonly reviveCamera = new THREE.PerspectiveCamera();

  /** Screen taps follow the rendered leaf/item instead of redirecting the player's view. */
  private touchTarget(x: number, y: number, camera = this.camera) {
    const meshes: TouchMesh[] = [];
    const doorTarget = (id: number | undefined): Cand | null => {
      const d = id === undefined ? undefined : this.doors[id];
      return d ? { kind: 'use', id: d.id, min: [d.box.x0, d.y0 ?? 0, d.box.z0], max: [d.box.x1, d.y1 ?? 3, d.box.z1] } : null;
    };
    if (this.doorMesh) meshes.push({ object: this.doorMesh, target: doorTarget });
    if (this.knobMesh) meshes.push({ object: this.knobMesh, target: doorTarget });
    for (const item of this.items) {
      const object = this.itemMeshes.get(item.id);
      if (object) meshes.push({ object, target: { kind: 'pick', id: item.id, ...boxAt(item.p, KEY_R, KEY_H) }, radius: 22 });
    }
    const bo = this.level.def.blackout;
    for (const object of this.blackoutObjs) if (bo && object.userData.touchFuse)
      meshes.push({ object, target: { kind: 'fuse', id: 0, ...fuseBoxBounds([bo.fuseBox.x, bo.fuseBox.y, bo.fuseBox.z]) } });
    for (const { id, object } of this.gym?.switchMeshes ?? []) {
      const s = this.level.def.gym!.switches[id];
      meshes.push({ object, target: { kind: 'gym-switch', id, ...boxAt([s.x, s.y, s.z], 0.44, 1.9) } });
    }
    const boxes: Cand[] = this.broadcastView?.candidates() ?? [];
    for (const [id, hide] of this.level.def.hides.entries()) {
      boxes.push({ kind: 'hide', id, ...boxAt([hide.x, hide.y ?? this.level.exit.y, hide.z],
        hide.kind === 'booth' ? .6 : .35, hide.kind === 'desk' ? .8 : 1.9) });
    }
    this.barrierCands(boxes);
    if (this.mirrorState) {
      if (this.mirrorKeyAvailable() && this.mirrorView?.interactionAt(x, y)) {
        const m = MIRRORS[0];
        return { target: mirrorKeyCandidate(), point: new THREE.Vector3(m.center[0] + .06, this.camera.position.y, m.center[2]), distance: this.camera.position.distanceTo(new THREE.Vector3(...m.center)) };
      }
      boxes.push(...mirrorWallCandidates(this.mirrorState));
    }
    for (const [id, peer] of this.peers) if (id !== this.myId && peer.st === ST_DOWN && peer.online)
      boxes.push({ kind: 'revive', id, ...downCand(peer.p, peer.yaw) });
    return worldTouchHit(camera, this.renderer.domElement.getBoundingClientRect(), x, y, meshes, boxes);
  }

  private onWorldTouch(phase: WorldTouchPhase, x: number, y: number) {
    if (phase === 'release') {
      if (this.touchPending?.x === x && this.touchPending.y === y) this.touchPending = null;
      if (this.touchRevive?.x === x && this.touchRevive.y === y) this.touchRevive = null;
      this.reviveHold.sync();
      return;
    }
    if (!this.input.enabled || this.feedbackDisposed || this.completed || this.awaitingLevel || this.down || this.spectate || this.mapOn || this.gym?.tripped(this.myId) || !this.spawnSynced || performance.now() < this.fadeUntil) return;
    if (phase === 'start') this.objectiveTiming.input();
    if (this.hiding >= 0) { if (phase === 'tap') this.interact(null); return; }
    if (phase === 'tap' && this.touchInteractAt(x, y)) { this.touchPending = null; return; }
    // Latch the world object under finger-down, then recheck reach/visibility on release. Moving with the
    // other thumb must not make a short tap select whatever slid underneath the finger a frame later.
    if (phase === 'start') { this.touchPending = { hit: this.touchTarget(x, y), x, y }; return; }
    if (!this.touchPending || Math.hypot(this.touchPending.x - x, this.touchPending.y - y) > 10) return;
    const hit = this.touchPending?.hit;
    if (!hit) return;
    const state = touchHitState(hit, this.camera, [this.pos.x, this.body.y, this.pos.z], this.collision);
    if (state !== 'ready') { if (phase === 'tap') this.toast(state === 'far' ? '再靠近一点' : '中间有遮挡'); return; }
    if (phase === 'hold') {
      if (hit.target.kind === 'revive') { this.touchRevive = { id: hit.target.id, x, y }; this.reviveHold.sync(); }
    } else if (hit.target.kind === 'revive') this.toast('按住队友搀扶');
    else this.interact(hit.target);
  }

  /** Dispatch a button/key edge independently of rendering; the server still confirms every action. */
  private interactPressed(now: number) {
    // Consume the edge here so the next update cannot send it again. Keep the held key intact for rescue.
    if (!this.input.consume('KeyE')) return;
    if (!this.input.enabled || this.feedbackDisposed || this.pausedForNetwork || this.completed || this.awaitingLevel || this.down || this.spectate || this.escaped || !this.presentationReady || this.gym?.tripped(this.myId) || now < this.fadeUntil) return;
    if (this.isRegisterNear() && !this.rollcallOpen) { this.openRollcall(); return; }
    if (this.rollcallOpen) { this.closeRollcall(); return; }
    if (this.readStory()) { this.tutUsed = true; return; }
    const examHit = this.exam && !this.exam.open && this.hiding < 0
      ? examTarget(this.exam.def, { x: this.pos.x, y: this.body.y, z: this.pos.z }, this.camera.position, this.input.yaw,
        (a, b) => lineOfSight(this.collision, a, b)) : null;
    if (examHit?.kind === 'paper') { this.exam!.openPaper(); return; }
    if (examHit?.kind === 'notice') { this.exam!.openNotice(examHit.index); return; }
    const tgt = this.target();
    if (tgt?.kind === 'revive') { this.reviveHold.sync(); this.tickRevive(now); }
    else this.interact(tgt);
  }

  /** Keyboard, the auxiliary touch button and direct world taps share the authoritative act path. */
  private interact(tgt: Cand | null) {
    if (!this.input.enabled || this.completed || this.down || this.spectate || this.gym?.tripped(this.myId) || performance.now() < this.fadeUntil) return;
    if (this.royaleZone && tgt?.kind === 'pick' && !this.items.some(item => item.id === tgt.id && item.kind === 'battery')) return;
    if (tgt) this.tutUsed = true;
    if (this.hiding >= 0) this.net.send({ t: 'act', kind: 'unhide', id: this.hiding });
    else if (tgt?.kind === 'use' && tgt.id < 0) this.toast(this.level.def.barriers[-1 - tgt.id]?.say ?? '');
    else if (tgt?.kind === 'use' && this.regionLocked(tgt.id) && !this.doorOpen[tgt.id]) { this.click(); this.toast('锁着'); }
    else if (tgt?.kind === 'fuse' && (this.bag.fuse ?? 0) <= 0) this.toast('先找到保险丝');
    else if (tgt?.kind === 'mirror-key') this.net.send({ t: 'act', kind: 'mirror-key', id: 0 });
    else if (tgt?.kind === 'mirror-push') this.net.send({ t: 'act', kind: 'mirror-push', id: tgt.id });
    else if (tgt?.kind === 'pick' && this.level.index === 0 && this.items.some(it => it.id === tgt.id && l1PickState(it, this.bag) !== 'ready')) {
      const item = this.items.find(it => it.id === tgt.id)!;
      this.toast(l1ItemPrompt(item, this.bag));
    }
    else if (tgt?.kind === 'sticker') this.net.send({ t: 'broadcast', op: 'read', id: tgt.id });
    else if (tgt?.kind === 'keypad') this.broadcastView?.open();
    else if (tgt?.kind === 'exam') this.exam?.openPaper();
    else if (tgt?.kind === 'clue') this.exam?.openNotice(tgt.id);
    else if (tgt?.kind === 'hide') {
      const hide = this.level.def.hides[tgt.id];
      if (!hide || Math.hypot(this.pos.x - hide.x, this.pos.z - hide.z) > HIDE_REACH
        || Math.abs(this.body.y - (hide.y ?? this.level.exit.y)) >= ACT_DY) { this.toast('再靠近一点'); return; }
      this.hideYaw = this.input.yaw + (hide.kind === 'locker' ? Math.PI : 0);
      this.net.send({ t: 'act', kind: 'hide', id: tgt.id });
    }
    else if (tgt) {
      const pending = this.pendingFeedback;
      if (pending?.kind === tgt.kind && pending.id === tgt.id && performance.now() <= pending.until) return;
      if (tgt.kind === 'pick') this.tutPicks.set(tgt.id, performance.now() + 5000);
      this.pendingFeedback = { kind: tgt.kind, id: tgt.id, until: performance.now() + 1500 };
      const sent = this.net.send({ t: 'act', kind: tgt.kind, id: tgt.id });
      if (sent && tgt.kind === 'use') this.previewDoor(tgt.id, performance.now());
      this.showPrompt(tgt);
    }
    else if (!this.down && !this.spectate) {
      const h = this.hideCand();
      if (h >= 0) {
        this.hideYaw = this.input.yaw + (this.level.def.hides[h].kind === 'locker' ? Math.PI : 0);
        this.net.send({ t: 'act', kind: 'hide', id: h });
      }
    }
  }

  /** The hiding place (index in level.def.hides) we are in, from our own snapshot's F_HIDE; -1 when not hiding. */
  hiding = -1;
  /** Yaw to look out of the hiding place with (a locker's slit faces away from where we entered); set when hide is sent. */
  private hideYaw = 0;
  private hideEl = document.getElementById('hide-overlay');
  private myF = 0;
  private setHiding(f: number, at: Vec3) {
    let id = -1;
    if (f & F_HIDE) {
      const hs = this.level.def.hides;
      let best = 0.25;
      for (let i = 0; i < hs.length; i++) { if (hs[i].y !== undefined && Math.abs(hs[i].y! - at[1]) > 1) continue; const d = Math.hypot(hs[i].x - at[0], hs[i].z - at[2]); if (d < best) { best = d; id = i; } }
    }
    if (id === this.hiding) return;
    this.hiding = id;
    const kind = id >= 0 ? this.level.def.hides[id].kind : '';
    if (this.hideEl) { this.hideEl.hidden = id < 0; this.hideEl.className = kind; }
    if (id >= 0) { this.input.yaw = kind === 'locker' ? this.hideYaw : this.input.yaw; this.input.pitch = 0; }
    // Sync the HUD prompt with the overlay now rather than on the next frame (a starved tab may not render one for seconds).
    this.showPrompt(this.down || this.spectate ? null : this.target());
  }

  private showPrompt(t: Cand | null, extra = '') {
    if (!this.promptEl) return;
    const p = this.pendingFeedback && performance.now() <= this.pendingFeedback.until
      ? '请求已发出，等待确认…' : extra || this.promptText(t);
    this.promptEl.textContent = document.body.classList.contains('touch') ? touchPrompt(p) : p;
  }

  /** The hiding place within reach in front of us, or -1. */
  private hideCand(): number {
    return hideTarget(this.level.def.hides, this.pos.x, this.pos.z, this.input.yaw, undefined, this.body.y);
  }

  private promptText(t: Cand | null): string {
    if (this.gym?.tripped(this.myId)) return '篮球绊倒了你 · 1.5秒后可动';
    if (this.story.isOpen) return '';
    if (this.hiding >= 0) return PROMPT.unhide;
    if (this.royaleZone && t?.kind === 'pick' && !this.items.some(item => item.id === t.id && item.kind === 'battery')) return '';
    if (!this.royaleZone && !this.down && !this.spectate && !this.view && !this.storyBlocked(t) && this.story.candidateId) return 'E 阅读线索';
    if (!t) {
      return !this.down && !this.spectate && this.hideCand() >= 0 ? PROMPT.hide : '';
    }
    if (t.kind === 'revive') return '按住 E 搀扶';
    if (t.kind === 'gym-switch') {
      const state = this.gym?.state;
      return state?.complete ? '四灯已亮 · 到东门集合' : (state?.until[t.id] ?? 0) > (state?.now ?? 0) ? `开关${t.id + 1}已锁定 ${(state!.until[t.id] - state!.now).toFixed(1)}秒` : `E 按下开关${t.id + 1}`;
    }
    if (t.kind === 'pick' && this.level.index === 0) {
      const item = this.items.find(it => it.id === t.id);
      if (item) return l1ItemPrompt(item, this.bag);
    }
    if (t.kind !== 'use') return PROMPT[t.kind];
    if (t.id < 0) return (this.level.def.barriers[-1 - t.id] ?? this.level.def.exam?.exitGate)?.say ?? '';
    if (this.doorOpen[t.id]) return 'E 关上';
    if (this.regionLocked(t.id)) return '锁着';
    return this.doorLocked[t.id] && !this.heldKeys.includes(t.id) ? '门锁着，需要钥匙' : PROMPT.use;
  }

  /** Physical notes use the same interaction priority for E and the projected touch button. */
  private storyBlocked(target: Cand | null): boolean {
    return !!target && (target.kind !== 'use' || target.id >= 0);
  }

  private storyCanShow(now = performance.now()): boolean {
    return !this.royaleZone && !this.feedbackDisposed && this.spawnSynced && !this.completed && now >= this.fadeUntil && !this.mapOn
      && document.getElementById('chat-input')?.hidden !== false
      && document.getElementById('broadcast-keypad')?.hidden !== false
      && document.getElementById('fade-overlay')?.hidden !== false;
  }

  private readStory(): boolean {
    if (this.royaleZone || !this.input.enabled || !this.storyCanShow()
      || this.down || this.spectate || this.hiding >= 0 || this.view || this.storyBlocked(this.target())) return false;
    return this.story.readCandidate();
  }

  private showItems(items: WorldItem[]) {
    if (this.royaleZone) items = items.filter(item => item.kind === 'battery');
    this.items = items;
    for (const k of this.itemMeshes.values()) this.disposeItem(k);
    this.itemMeshes.clear();
    for (const it of items) {
      const bat = it.kind === 'battery' || it.kind === 'fuse';
      const k = new THREE.Group();
      const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
        const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, z); k.add(mesh); return mesh;
      };
      if (it.kind === 'stair_key' && this.level.index === 0 && !it.decoy) {
        // The stair key stays inside this closed drawer until the team's drawer key is used.
        add(new THREE.BoxGeometry(.66, .22, .38), this.itemMat.drawer, 0, .11, 0);
        add(new THREE.BoxGeometry(.6, .16, .025), this.itemMat.drawer, 0, .11, .2);
        add(new THREE.BoxGeometry(.15, .025, .035), this.itemMat.metal, 0, .12, .23);
        add(new THREE.BoxGeometry(.025, .045, .01), this.itemMat.metal, 0, .055, .22);
        const label = new THREE.MeshBasicMaterial({ map: textTex('上锁抽屉 · 楼梯钥匙', '#382815', '#d9c18c', 512, 96) });
        const plate = add(new THREE.PlaneGeometry(.55, .1), label, 0, .225, 0);
        plate.rotation.x = -Math.PI / 2; plate.userData.itemOwnMaterial = true;
      } else if (bat) add(new THREE.BoxGeometry(.06, .14, .06), it.kind === 'fuse' ? this.itemMat.fuse : this.itemMat.battery, 0, .07, 0);
      else {
        const material = it.decoy ? this.itemMat.decoy : this.itemMat.key;
        add(new THREE.TorusGeometry(.065, .016, 5, 12), material, -.12, .025, 0).rotation.x = Math.PI / 2;
        add(new THREE.BoxGeometry(.23, .025, .025), material, .035, .025, 0);
        if (!it.decoy) {
          for (const x of [.09, .145]) add(new THREE.BoxGeometry(.025, .025, .06), material, x, .025, .025);
          add(new THREE.BoxGeometry(.09, .018, .055), material, -.17, .025, -.085); // brass tag
        }
      }
      k.position.set(...it.p);
      this.scene.add(k);
      this.itemMeshes.set(it.id, k);
    }
    this.refreshItemHighlights();
    this.guideAt = 0;
  }

  private disposeItem(object: THREE.Object3D) {
    this.scene.remove(object);
    object.traverse(child => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
      if (child.userData.itemOwnMaterial) {
        const material = child.material as THREE.MeshBasicMaterial;
        material.map?.dispose(); material.dispose();
      }
    });
  }

  private dropItems(gone: number[]) {
    for (const id of gone) {
      const k = this.itemMeshes.get(id);
      if (k) this.disposeItem(k);
      this.itemMeshes.delete(id);
    }
    this.items = this.items.filter((it) => !gone.includes(it.id));
    this.refreshItemHighlights();
  }

  /** 跳闸 in progress (server 'trip'): omen → dark (spreading from `at`) → stuttering restart. */
  private trip?: { t0: number; at: [number, number]; omen: number; off: number; beat: number };
  /** Drives the campus darkness from the trip phases; `beat` makes each phase's sound play once. */
  private stepTrip() {
    const c = this.campus, tr = this.trip;
    c.outFloor = null;
    const examFloor = this.examBlackout && performance.now() < this.examBlackout.until ? this.examBlackout.floor : null;
    for (const object of this.barrierObjs) {
      if (typeof object.userData.examLampFloor === 'number') object.visible = object.userData.examLampFloor !== examFloor;
    }
    if (examFloor !== null) {
      c.outFloor = examFloor;
      c.out = 1; c.outAt.set(0, 0); c.outR = 999; c.stutter = 0;
      return;
    }
    this.examBlackout = undefined;
    if (!tr) { c.out = 0; c.stutter = 0; return; }
    const e = (performance.now() - tr.t0) / 1000, back = tr.omen + tr.off;
    if (e < tr.omen) { // omen: tubes stutter faster and faster, the hum climbs
      if (tr.beat < 1) { tr.beat = 1; this.humStart(tr.omen); }
      c.stutter = Math.random() < 0.15 + 0.35 * (e / tr.omen) ? 1 : 0;
      c.out = 0;
    } else if (e < back) { // dark: the cut runs outward from `at` and swallows the floor
      if (tr.beat < 2) { tr.beat = 2; this.humStop(); this.tone('square', 55, 0.35, 0.5, 30); this.tone('sawtooth', 2400, 0.08, 0.05); }
      c.stutter = 0; c.out = 1; c.outAt.set(tr.at[0], tr.at[1]); c.outR = 4 + (e - tr.omen) * 30;
    } else if (e < back + 0.9) { // restart: tubes ping back on with a buzz
      if (tr.beat < 3) { tr.beat = 3; this.tone('square', 120, 0.12, 0.8, 100); }
      c.out = 0; c.stutter = Math.random() < 0.5 ? 1 : 0;
    } else { c.out = 0; c.stutter = 0; this.trip = undefined; }
  }
  /** One decaying oscillator note (optionally gliding to `to` Hz). */
  private tone(type: OscillatorType, hz: number, gain: number, s: number, to?: number) {
    this.sound.tone(type, hz, gain, s, to);
  }
  /** The ballast hum bending upward over `s` seconds (the omen). */
  private humStart(s: number) {
    this.sound.humStart(s);
  }
  private humStop() {
    this.sound.humStop();
  }

  /** Short "click" blip (battery swap / low-power warning). */
  private click() {
    this.sound.click();
  }
  private toastTimer = 0;
  /** Transient message in the bottom hint line. */
  private toast(msg: string, ms = 2000) {
    const el = document.getElementById('subtitle');
    if (!el) return;
    el.textContent = msg;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, ms);
  }

  /** Own flashlight charge 0..1 (server value from snapshots); the light is dead at 0 and flickers below 20%. */
  battery = 1;
  /** Own stamina 0..1 from snapshots; exhausted at 0 until STAMINA_MIN is back. */
  stamina = 1;
  private exhausted = false;
  private setStamina(v: number) {
    this.stamina = v;
    this.exhausted = v <= 0 || (this.exhausted && v < STAMINA_MIN);
    const el = document.getElementById('stamina-fill');
    if (el) el.style.width = `${Math.round(v * 100)}%`;
  }
  private setBattery(b: number) {
    if (!this.pausedForNetwork && b > this.battery + 0.2) { this.click(); this.haptics.pulse('pickup'); this.toast('换上了电池'); }
    else if (!this.pausedForNetwork && b < 0.2 && this.battery >= 0.2) { this.click(); this.haptics.pulse('danger'); this.toast('手电快没电了'); }
    this.battery = b;
    const el = document.getElementById('battery');
    if (!el) return;
    el.textContent = `手电 ${Math.round(b * 100)}%`;
    el.classList.toggle('low', b < 0.2);
    el.style.setProperty('--v', String(barFrac(b)));
  }

  /** HUD bag (bottom right): door keys held + shared pick-ups. */
  private bag: Bag = {};
  private showBag() {
    const el = document.getElementById('keys');
    if (!el) return;
    const parts = this.royaleZone
      ? [this.bag.battery ? `电池 ×${this.bag.battery}` : '']
      : [
          this.heldKeys.length ? `钥匙 ×${this.heldKeys.length}` : '',
          this.bag.drawer_key ? `抽屉钥匙 ×${this.bag.drawer_key}` : '',
          this.bag.stair_key ? `楼梯钥匙 ×${this.bag.stair_key}` : '',
          this.bag.battery ? `电池 ×${this.bag.battery}` : '',
          this.bag.fuse ? `保险丝 ×${this.bag.fuse}` : '',
          this.mirrorState?.key.taken ? '镜中钥匙 ×1' : '',
        ];
    el.textContent = parts.filter(Boolean).join('　');
    this.refreshObjective();
  }

  /** The level goal (objective.ts): a centre banner at level start, then the always-on panel top right. */
  obj?: Objective;
  private objCur = -1;
  private idle = new IdleHint();
  private readonly objectiveTiming = new ObjectiveTiming();
  private readonly objectivePauses = new Set<'intro' | 'capture'>();
  private openingBanner = false;
  private openingTutorial = false;
  /** Cutscene presenters pair calls on entry/exit; time under either overlay never consumes a banner. */
  setObjectivePaused(reason: 'intro' | 'capture', paused: boolean) {
    if (paused) { this.objectivePauses.add(reason); this.objectiveTiming.pause(); }
    else this.objectivePauses.delete(reason);
  }
  /** Level start: title + goal in the centre for LEVEL_BANNER_MS, then the panel flies in top right. */
  private startObjective() {
    if (this.completion || this.royaleZone) return;
    this.objCur = -1;
    this.refreshObjective();
    const o = this.obj!;
    this.idle.reset(performance.now() / 1000, o.key);
    if (this.introShown) {
      this.clearBanner();
      const panel = document.getElementById('objective'); if (panel) panel.hidden = false;
    } else {
      const b = bannerFor(this.level.def, o);
      this.openingBanner = true;
      this.showBanner(b.title, b.goal, LEVEL_BANNER_MS);
    }
    this.tutFrom = { ...this.pos };
    this.tutUsed = false;
    this.tutCrouched = this.tutPicked = false;
    this.tutPicks.clear();
    this.openingTutorial = this.level.index === 0;
    this.tut.stop();
  }
  /** Re-reads bag / fusesIn into the panel; a step forward shows the new goal in the centre for STEP_BANNER_MS. */
  private refreshObjective() {
    if (!this.level) return;
    if (this.royaleZone) {
      this.obj = undefined;
      this.objCur = -1;
      const el = document.getElementById('objective');
      if (el) el.hidden = true;
      return;
    }
    const state = this.level.def.mirror ? this.mirrorState : this.level.def.gym ? this.gym?.state : this.level.def.broadcast ? this.broadcastView?.state : this.loopPlayers.get(this.myId);
    const o = this.level.def.finale ? finaleObjective(this.finalState, document.body.classList.contains('touch')) : objective(this.level.def, this.bag, this.fusesIn, state, this.exam?.state), p = panelFor(o);
    if (this.level.def.mirror) {
      const phase = this.mirrorState?.mirrors.find(a => a.id === this.myId)?.phase;
      if (phase === 'still') o.note = '倒影停住 · 背对镜子离开';
      if (phase === 'chase') o.note = '镜中人出来了 · 背对镜子离开镜廊';
    }
    const el = document.getElementById('objective');
    if (el) {
      el.querySelector('.h')!.textContent = p.head;
      el.querySelector('.g')!.textContent = p.goal;
      el.querySelector('.got')!.textContent = this.level.def.gym || this.level.def.finale ? o.got : p.got;
    }
    if (this.obj && o.key !== this.obj.key) el?.querySelector('.tip')?.replaceChildren();
    if (o.note && el) el.querySelector('.tip')!.textContent = o.note;
    if (!this.pausedForNetwork && !this.intro.active && !this.objectiveTiming.pending && this.objCur >= 0 && o.cur > this.objCur) {
      if (this.openingBanner) {
        const b = bannerFor(this.level.def, o);
        this.showBanner(b.title, b.goal, LEVEL_BANNER_MS);
      } else this.showBanner('', o.steps[o.cur], STEP_BANNER_MS);
    }
    this.objCur = o.cur;
    this.obj = o;
  }
  /** 目标箭头 (guide.ts): the level's walk graph (server 'nav' msg), the items someone here has had in sight, the G toggle. */
  private navGraph: NavGraph | null = null;
  private guidance = true;
  /** Optional names in environmental writing follow the room, including a reused prepared campus. */
  setNamedMonitors(enabled: boolean): void { this.campus.world.boards?.setNamedMonitors(enabled); }

  /** The room decides this once, before play; G can only toggle arrows inside a guided run. */
  setGuidance(enabled: boolean): void {
    this.guidance = enabled;
    if (!enabled) {
      this.guide = null; this.navGraph = null;
      if (this.arrowEl) this.arrowEl.hidden = true;
      if (this.goalBeacon) this.goalBeacon.visible = false;
    }
    this.guideAt = this.mapAt = 0;
    this.updateMapGuidance();
  }
  private seen = new Set<number>();
  private arrowOn = localStorage.getItem('escape.arrow') !== '0';
  private guide: { goal: Goal; x: number; y: number; z: number; dist: number } | null = null;
  private guideAt = 0;
  private arrowEl = document.getElementById('goal-arrow');
  private arrowLast = '';
  private arrowV = new THREE.Vector3();
  private arrowLayoutAt = -Infinity;
  private arrowLayoutSize = '';
  private arrowBlocked: ScreenRect[] = [];
  private arrowFootprint: ScreenRect = { left: -22, top: -22, right: 22, bottom: 37 };
  private toggleArrow() {
    if (this.guidance === false) { this.toast('本局创建时已关闭指引，整局不可开启'); return; }
    this.arrowOn = !this.arrowOn;
    localStorage.setItem('escape.arrow', this.arrowOn ? '1' : '0');
    const how = document.body.classList.contains('touch') ? '地图里切换' : this.arrowOn ? 'G 关' : 'G 开';
    this.toast(this.arrowOn ? `目标箭头：开（${how}）` : `目标箭头：关（${how}）`);
    const b = this.mapEl?.querySelector('.mb.arrow');
    if (b) b.textContent = `目标箭头：${this.arrowOn ? '开' : '关'}`;
    this.mapAt = 0;
  }
  /** The goal + next waypoint at 4 Hz (A* and LOS rays), the arrow placement every frame from the fresh camera. */
  private tickGuide(now: number) {
    const el = this.arrowEl;
    if (!el) return;
    const off = !!this.royaleZone || this.guidance === false || !this.arrowOn || !this.obj || !this.level || !this.spawnSynced || this.down || this.spectate || this.escaped || !!this.view;
    if (!off && now - this.guideAt > 250) {
      this.guideAt = now;
      const c = this.camera.position, feet = { x: this.pos.x, y: this.body.y, z: this.pos.z };
      const los = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => lineOfSight(this.collision, a, b);
      for (const it of this.items) {
        if (this.seen.has(it.id) || Math.hypot(it.p[0] - c.x, it.p[1] - c.y, it.p[2] - c.z) > SEEN_R) continue;
        if (los({ x: c.x, y: c.y, z: c.z }, { x: it.p[0], y: it.p[1] + 0.1, z: it.p[2] })) this.seen.add(it.id);
      }
      const station = this.broadcastView;
      const fin = this.level.def.finale;
      if (fin && this.finalState?.phase === 'chase') this.finaleRouteIndex = advanceFinaleRoute(fin.route, feet, this.finaleRouteIndex);
      const finalPoint = fin ? finaleGoalPoint(this.finalState?.phase ?? 'rollcall', fin, this.finaleRouteIndex) : null;
      const mirrorGoal = this.level.def.mirror && !this.mirrorState?.openDoors.includes(2) ? mirrorGuideGoal(this.mirrorState) : undefined;
      let goal = this.level.def.broadcast ? broadcastGoalPoint(this.level.def, station?.state, feet, this.navGraph, los)
        : goalPoint(this.level.def, this.obj!, this.items, this.seen, feet, this.navGraph);
      if (this.level.def.gym && !this.gym?.state?.complete) {
        const state = this.gym?.state;
        const stations = this.level.def.gym.switches.filter((_, i) => !state || state.until[i] <= state.now);
        stations.sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z));
        const next = stations[0];
        goal = next ? { x: next.x, y: next.y + 1.4, z: next.z, exact: true } : null;
      }
      goal = fin ? finalPoint && this.finalState?.phase !== 'complete' ? { ...finalPoint, exact: true } : null : mirrorGoal ?? goal;
      this.guide = goal ? { goal, ...guideWaypoint(this.navGraph, feet, goal, los, (a, b) => shutDoorOn(this.activeDoors(), this.doorOpen, a, b)) } : null;
    }
    const g = this.guide;
    if (off || !g) {
      if (!el.hidden) { el.hidden = true; this.arrowLast = ''; }
      return;
    }
    // Keep routing at floor height; the final fuse marker belongs on the visible cabinet, not its floor anchor.
    const atGoal = g.x === g.goal.x && g.y === g.goal.y && g.z === g.goal.z;
    const atFuse = atGoal && this.level.def.blackout && this.obj!.cur === 1;
    const lift = atFuse ? FUSE_BOX_CENTER_H : atGoal && g.goal.exact && this.obj!.cur < this.obj!.steps.length - 1 ? 0 : 1;
    const v = this.arrowV.set(g.x, g.y + lift, g.z).applyMatrix4(this.camera.matrixWorldInverse);
    // behind the camera the projection flips and blows up: push the view-space direction out to the edge instead
    const behind = v.z > -0.05, l = Math.hypot(v.x, v.y);
    if (!behind) v.applyMatrix4(this.camera.projectionMatrix);
    const margin = Math.max(ARROW_MARGIN(innerWidth), g.goal.label ? 64 : 0);
    let r = behind ? edgeArrow(l > 1e-3 ? (v.x / l) * 9 : 0, l > 1e-3 ? (v.y / l) * 9 : -9, false, innerWidth, innerHeight, margin)
      : edgeArrow(v.x, v.y, false, innerWidth, innerHeight, margin);
    const txt = g.goal.arrived ? ARRIVED : `${g.goal.label ? `${g.goal.label}\n` : ''}${distText(g.dist, g.goal.exact)}`;
    const tag = el.querySelector<HTMLElement>('.d')!;
    const changedText = tag.textContent !== txt;
    if (changedText) tag.textContent = txt;
    el.hidden = false;
    {
      const touch = document.body.classList.contains('touch'), size = `${innerWidth},${innerHeight},${touch}`;
      // Read real control/footer bounds at 8 Hz; the desktop hint can also wrap.
      // Normal frames reuse the cache, including the floating joystick's bounds.
      if (changedText || size !== this.arrowLayoutSize || now - this.arrowLayoutAt > 125) {
        this.arrowLayoutAt = now; this.arrowLayoutSize = size;
        this.arrowBlocked = [...(touch ? ['touch-base', 'touch-btns', 'battery', 'stamina', 'keys', 'objective', 'touch-map', 'touch-chat'] : []), 'hint']
          .flatMap(id => {
            const e = document.getElementById(id), b = e?.getBoundingClientRect();
            return e && !e.hidden && b && b.width > 0 && b.height > 0 ? [{ left: b.left, top: b.top, right: b.right, bottom: b.bottom }] : [];
          });
        const b = tag.getBoundingClientRect(), half = Math.max(22, b.width / 2);
        this.arrowFootprint = { left: -half, top: -22, right: half, bottom: Math.max(22, 17 + b.height) };
      }
      r = avoidArrowControls(r, innerWidth, innerHeight, this.arrowFootprint, this.arrowBlocked);
    }
    const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.a / 2)},${r.on},${txt}`;
    if (key === this.arrowLast) return;
    this.arrowLast = key;
    el.hidden = false;
    el.classList.toggle('on', r.on);
    el.dataset.a = String(Math.round(r.a));
    el.style.transform = `translate(${r.x.toFixed(0)}px, ${r.y.toFixed(0)}px)`;
    (el.querySelector('.ar') as HTMLElement).style.transform = `rotate(${r.a.toFixed(0)}deg)`;
  }
  /** 平面图 (map.ts): M / the touch 地图 button; the rooms anyone of us has stood in get a tick. Redrawn at 5 Hz while open. */
  private plan: LevelMap | null = null;
  private planDoors: number[] = [];
  private explored = new Set<number>();
  private exploreAt = 0;
  private mapOn = false;
  private mapAt = 0;
  private mapOpened = false;
  private mapSize = { w: 0, h: 0 };
  private mapEl = document.getElementById('map');
  /** First royale snap: swap in the campus plan, the zone table and the HUD; later ones just refresh the zone. */
  private onZoneSnap(zone: ZoneSnap) {
    const first = !this.royaleZone;
    if (first) {
      this.zonePhases = generateZonePhases(this.level.seed);
      this.zoneHud = new ZoneHud();
      this.plan = campusMap(CAMPUS);
      this.planDoors = [];
      this.explored.clear();
      this.mapOpened = false;
      this.toggleMap(false);
    }
    this.royaleZone = zone;
    if (first) {
      this.buildBarriers();
      this.story.setAvailable(false);
      this.story.setVisible(false);
      const hint = document.getElementById('hint');
      if (hint) {
        const text = hint.textContent;
        hint.textContent = text?.replace(' · J 线索记录', '') ?? '';
        this.feedbackCleanups.push(() => { hint.textContent = text; });
      }
      this.obj = undefined;
      this.objCur = -1;
      this.guide = null;
      this.guideAt = this.mapAt = 0;
      this.objectiveTiming.hide();
      this.objectiveTiming.pending = false;
      this.openingBanner = this.openingTutorial = false;
      this.tut.stop();
      this.tutLast = '';
      if (this.tutEl) this.tutEl.hidden = true;
      this.clearBanner();
      const objective = document.getElementById('objective');
      if (objective) objective.hidden = true;
      if (this.arrowEl) this.arrowEl.hidden = true;
      if (this.pendingFeedback?.kind === 'pick' && !this.items.some(item => item.id === this.pendingFeedback!.id && item.kind === 'battery'))
        this.pendingFeedback = undefined;
      this.showItems(this.items);
      this.showBag();
      if (this.promptEl && !this.pendingFeedback) this.showPrompt(this.down || this.spectate ? null : this.target());
    }
  }
  private loadPlan() {
    const def = this.level.def, b = CAMPUS.buildings.find((x) => x.id === def.building);
    this.plan = this.royaleZone ? campusMap(CAMPUS) : b ? levelMap(def, b) : null; // royale keeps the whole-campus plan across level reloads
    this.planDoors = this.doors.filter((d) => inBounds(this.level, d.x, d.y0 ?? 0, d.z)).map((d) => d.id);
    this.explored.clear();
    this.mapOpened = false;
    this.toggleMap(false);
  }
  toggleMap(on = !this.mapOn) {
    const el = this.mapEl;
    if (!el || (on && !this.plan)) return;
    this.mapOn = on;
    el.hidden = !on;
    this.story.setVisible(this.storyCanShow());
    document.getElementById('touch-map')?.classList.toggle('on', on);
    if (!on) return;
    this.mapOpened = true;
    this.mapAt = 0;
    if (!el.dataset.bound) { // touch: the two header buttons (desktop has M / G and no cursor under pointer lock)
      el.dataset.bound = '1';
      const tap = (sel: string, f: () => void) => el.querySelector(sel)?.addEventListener('touchstart', (e) => { e.preventDefault(); f(); }, { passive: false });
      tap('.mb.arrow', () => this.toggleArrow());
      tap('.mb.close', () => this.toggleMap(false));
    }
    el.querySelector('.mt')!.textContent = this.royaleZone ? '校园平面图 · 大逃杀' : `平面图 · ${this.level.def.name}`;
    const touch = document.body.classList.contains('touch');
    this.updateMapGuidance();
    this.sizeMap();
  }
  private updateMapGuidance() {
    const el = this.mapEl;
    if (!el) return;
    const disabled = this.guidance === false, touch = document.body.classList.contains('touch');
    const exitLegend = el.querySelector<HTMLElement>('.exit-legend');
    if (exitLegend) exitLegend.hidden = disabled;
    const hint = el.querySelector('.mk'), button = el.querySelector<HTMLButtonElement>('.mb.arrow');
    if (hint) hint.textContent = disabled ? `${touch ? '' : 'M 关闭 · '}本局指引已关闭` : touch ? '' : `M 关闭 · G 目标箭头：${this.arrowOn ? '开' : '关'}`;
    if (button) {
      button.disabled = disabled;
      button.textContent = disabled ? '本局指引已关闭' : `目标箭头：${this.arrowOn ? '开' : '关'}`;
    }
  }
  private sizeMap() {
    const el = this.mapEl;
    if (!el || !this.plan) return;
    const touch = document.body.classList.contains('touch'), cv = el.querySelector('canvas')!;
    // The portrait rotate gate covers the game; keep a valid canvas until landscape returns.
    if (touch && innerWidth <= innerHeight) return;
    let maxW = Math.min(innerWidth * 0.9, 1040), maxH = innerHeight * (touch ? 0.66 : 0.7);
    let desktopBounds: { left: number; right: number; top: number; bottom: number } | undefined;
    const visibleBox = (id: string) => {
      const node = document.getElementById(id);
      if (!node || node.hidden || !node.getClientRects().length) return;
      const style = getComputedStyle(node);
      if (style.display !== 'none' && style.visibility !== 'hidden') return node.getBoundingClientRect();
    };
    el.style.top = '';
    if (touch) {
      // Keep the whole panel (including its padding/frame) between the stick and action pad.
      // Use the stick's CSS resting anchor: its live position follows the finger while moving.
      const base = document.getElementById('touch-base'), baseStyle = base && getComputedStyle(base);
      el.style.left = 'var(--touch-stick-x, 0px)';
      const left = parseFloat(getComputedStyle(el).left) + (base ? base.getBoundingClientRect().width + parseFloat(baseStyle!.marginLeft) : 0) + 12;
      const right = Math.min(visibleBox('touch-btns')?.left ?? innerWidth, visibleBox('objective')?.left ?? innerWidth) - 12;
      const style = getComputedStyle(el), padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      // Leave the canvas centre in the look zone so dragging the plan still turns
      // the camera instead of starting a second movement stick.
      const center = Math.max((left + right) / 2, (visibleBox('touch-look')?.left ?? innerWidth * 0.45) + 1);
      maxW = Math.max(80, Math.min(maxW, right - left - padding, 2 * (right - center) - padding));
      el.style.left = `${center}px`;
      const canvasLimit = parseFloat(getComputedStyle(cv).maxHeight);
      if (Number.isFinite(canvasLimit)) maxH = Math.min(maxH, canvasLimit);
    } else {
      // The task card and gauges remain readable while the plan is open. Preserve the
      // canvas size when a small shift fits; narrow windows can then reduce the plan.
      const right = ['objective', 'zone-hud', 'battery', 'stamina', 'keys'].reduce((edge, id) => Math.min(edge, (visibleBox(id)?.left ?? innerWidth) - 12), innerWidth - 12);
      const style = getComputedStyle(el), padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      desktopBounds = { left: 12, right, top: Math.max(12, (visibleBox('room-code')?.bottom ?? 0) + 12), bottom: innerHeight - 12 };
      maxW = Math.max(28, Math.min(maxW, right - desktopBounds.left - padding));
    }
    let z = mapSize(this.plan.area, maxW, maxH, 14);
    const sizeCanvas = () => {
      el.style.width = `${z.w}px`;
      cv.style.width = `${z.w}px`;
      cv.style.height = `${z.h}px`;
    };
    sizeCanvas();
    if (desktopBounds) {
      // Wrapped headings/legends consume real height; do not shrink their text with
      // a transform or let the frame extend past a short desktop's lower edge.
      const availableH = desktopBounds.bottom - desktopBounds.top;
      for (let i = 0; i < 4; i++) {
        const overflow = el.getBoundingClientRect().height - availableH;
        if (overflow <= 0) break;
        maxH = Math.max(28, z.h - overflow);
        z = mapSize(this.plan.area, maxW, maxH, 14);
        sizeCanvas();
      }
      const frame = el.getBoundingClientRect();
      el.style.left = `${Math.max(desktopBounds.left + frame.width / 2, Math.min(innerWidth / 2, desktopBounds.right - frame.width / 2))}px`;
      el.style.top = `${Math.max(desktopBounds.top + frame.height / 2, Math.min(innerHeight / 2, desktopBounds.bottom - frame.height / 2))}px`;
    }
    this.mapSize = z;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(z.w * dpr);
    cv.height = Math.round(z.h * dpr);
    if (touch) el.style.setProperty('--map-half-height', `${el.getBoundingClientRect().height / 2}px`);
    this.mapAt = 0;
  }
  private tickMap(now: number) {
    const m = this.plan;
    if (!m || !this.level || !this.spawnSynced) return;
    if (now - this.exploreAt > 250) {
      this.exploreAt = now;
      for (const [id, q] of this.peers) {
        if (q.st === ST_SPECTATE || !q.online) continue;
        const p = id === this.myId ? { x: this.pos.x, y: this.body.y, z: this.pos.z } : { x: q.p[0], y: q.p[1], z: q.p[2] };
        if (this.royaleZone && id !== this.myId) continue; // rivals' whereabouts stay off the plan
        const i = this.royaleZone || inBounds(this.level, p.x, p.y, p.z) ? roomAt(m, p.x, p.z, p.y) : -1;
        if (i >= 0) this.explored.add(i);
      }
    }
    if (!this.mapOn || now - this.mapAt < 200) return;
    this.mapAt = now;
    const el = this.mapEl!, cv = el.querySelector('canvas')!, ctx = cv.getContext('2d');
    if (!ctx) return;
    const def = this.level.def;
    // Observers' bodies stay at their spawn. Follow the viewed teammate or free camera instead.
    const floorY = this.spectate ? (this.peers.get(this.follow)?.p[1] ?? this.camera.position.y - EYE_H) : this.body.y;
    if (m.floors.length > 1) el.querySelector('.mt')!.textContent = `平面图 · ${def.name} · ${mapFloorAt(m, floorY)?.level}F`;
    this.updateMapGuidance();
    const mates: MapState['mates'] = [];
    for (const [id, q] of this.peers) {
      if (this.royaleZone || id === this.myId || q.st === ST_SPECTATE || !q.online) continue; // royale: no teammates, rivals stay hidden
      mates.push({ x: q.p[0], y: q.p[1], z: q.p[2], name: this.names.get(id) ?? '队友', color: `#${COLORS[id % COLORS.length].toString(16).padStart(6, '0')}`, down: q.st === ST_DOWN });
    }
    const zone = this.royaleZone;
    const st: MapState = {
      guidance: zone ? false : this.guidance, // royale has no level exit / fuse box / route to point at
      ...(zone ? { zone: { cur: { center: zone.center, radius: zone.radius }, next: this.nextZone } } : {}),
      floorY,
      me: this.spectate ? undefined : { x: this.pos.x, y: this.body.y, z: this.pos.z, yaw: this.input.yaw },
      mates,
      explored: this.explored,
      doors: this.planDoors.map((id) => {
        const d = this.doors[id], open = !!this.doorOpen[id];
        return { ...d.box, y: d.y0 ?? 0, open, locked: !open && !!this.doorLocked[id] };
      }),
      barriers: zone ? [] : def.exam?.exitGate && !this.exam?.state.passed ? [...def.barriers, def.exam.exitGate] : def.barriers,
      exit: def.exit,
      route: this.finalState?.phase === 'chase' ? m.route : undefined,
      rollcall: this.finalState?.phase === 'chase' ? undefined : def.finale?.rollcall,
      fuseBox: def.blackout?.fuseBox,
      gymSwitches: def.gym?.switches.map((s, i) => ({ x: s.x, y: s.y, z: s.z, active: !!this.gym?.state && (this.gym.state.complete || this.gym.state.until[i] > this.gym.state.now) })),
    };
    const dpr = cv.width / this.mapSize.w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMap(ctx, m, st, this.mapSize.w, this.mapSize.h);
  }
  /** L1's first minute (tutorial.ts): one control at a time above the crosshair, the next once it's been done. */
  private tut = new Tutorial();
  private tutEl = document.getElementById('tut');
  private tutFrom = { x: 0, z: 0 };
  private tutUsed = false;
  private tutCrouched = false;
  private tutPicked = false;
  /** `gone` has no picker id: require a recent local request for that item, independent of sound/haptic expiry. */
  private tutPicks = new Map<number, number>();
  /** A wipe keeps index/seed: wait for its room and new spawn before restarting the teaching/banner. */
  private tutLast = '';
  private tickTut(now: number) {
    const el = this.tutEl;
    if (!el) return;
    if (this.royaleZone) { el.hidden = true; return; }
    const r = this.down || this.spectate || !this.spawnSynced || !this.input.enabled ? undefined : this.tut.tick(now / 1000, {
      moved: Math.hypot(this.pos.x - this.tutFrom.x, this.pos.z - this.tutFrom.z), light: this.light, used: this.tutUsed, mapped: this.mapOpened,
      crouched: this.tutCrouched, picked: this.tutPicked, hidden: this.hiding >= 0,
    });
    const key = r ? `${r.step}${r.done}` : '';
    if (key === this.tutLast) return;
    this.tutLast = key;
    el.hidden = !r;
    if (!r) return;
    el.classList.toggle('done', r.done);
    el.querySelector('.n')!.textContent = `${r.step === 'hide' ? '避险' : '操作'} ${r.n}/${r.m}`;
    const parts = tutParts(tutText(r.step, document.body.classList.contains('touch')));
    el.querySelector('.x')!.replaceChildren(...parts.map((p) => p.key ? Object.assign(document.createElement('kbd'), { textContent: p.t }) : document.createTextNode(p.t)));
  }
  private tipTimer = 0;
  /** 45 s without objective progress (IdleHint): a neutral nudge in the panel's own tip line (not #subtitle, which is 角色074's). Not while down / out or under the banner. */
  private tickIdleHint(now: number) {
    if (!this.obj || !this.spawnSynced) return;
    const phase = this.mirrorState?.mirrors.find(a => a.id === this.myId)?.phase;
    if (this.down || this.spectate || phase === 'still' || phase === 'chase' || !document.getElementById('banner')?.hidden) { this.idle.reset(now / 1000, this.obj.key); return; }
    const h = this.idle.tick(now / 1000, this.obj);
    if (h && this.level.def.loop) { this.toast(h); return; } // keep the sequence visible in the panel
    const tip = document.querySelector('#objective .tip');
    if (!h || !tip) return;
    const text = document.body.classList.contains('touch') ? touchObjectiveText(h) : h;
    tip.textContent = text;
    clearTimeout(this.tipTimer);
    this.tipTimer = window.setTimeout(() => { if (tip.textContent === text) tip.textContent = ''; }, IDLE_HINT_MS);
  }
  /** Centre banner (#banner): an empty `title` shows the goal line only and leaves the panel up. */
  private clearBanner() {
    this.objectiveTiming.hide();
    const banner = document.getElementById('banner'); if (banner) banner.hidden = true;
  }

  private showBanner(title: string, goal: string, ms: number) {
    const el = document.getElementById('banner'), panel = document.getElementById('objective');
    if (!el || !panel) return;
    el.querySelector('.t')!.textContent = title;
    el.querySelector('.g')!.textContent = goal;
    el.classList.remove('out');
    el.hidden = !this.drawOn;
    panel.hidden = !!title;
    this.objectiveTiming.show(ms);
  }

  /** Once per rendered frame, after any shader stall. Covering overlays also include their reveal animation. */
  private tickObjective(now: number) {
    if (this.royaleZone) {
      const banner = document.getElementById('banner'), panel = document.getElementById('objective');
      if (banner) banner.hidden = true;
      if (panel) panel.hidden = true;
      return;
    }
    const covered = ['fade-overlay', 'intro-overlay', 'capture-overlay'].some((id) => {
      const el = document.getElementById(id);
      if (!el || el.hidden) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
    });
    const visible = !document.hidden && !covered && !this.objectivePauses.size && !this.pausedForNetwork && !this.awaitingLevel
      && !this.intro.active && !this.completed && !this.completion && !this.down && !this.spectate
      && now >= this.fadeUntil && this.input.enabled && !this.settings.isOpen;
    const result = this.objectiveTiming.frame(now, { spawned: this.spawnSynced, visible, rendered: this.drawOn });
    if (result.start) { this.startObjective(); return; }
    const el = document.getElementById('banner'), panel = document.getElementById('objective');
    if (!el || !panel) return;
    el.hidden = result.phase === 'hidden';
    el.classList.toggle('out', result.phase === 'fading');
    panel.hidden = this.completed || !!this.completion || result.phase === 'readable' && !!el.querySelector('.t')?.textContent;
    if (visible && this.drawOn && !this.objectiveTiming.pending && result.phase === 'hidden') {
      this.openingBanner = false;
      if (this.openingTutorial) {
        this.openingTutorial = false;
        this.tut.start(now / 1000);
      }
    }
  }

  /** Teammate pings (Q): a coloured ring + beam where their crosshair ray hit, gone after PING_MS. */
  private pings: { obj: THREE.Group; until: number }[] = [];
  private lastPing = -Infinity;
  /** Ping the spot under the crosshair (walls/props/floor) for everyone; at most once a second. */
  sendPing(now = performance.now()) {
    if (this.spectate || now - this.lastPing < PING_GAP_MS) return;
    this.lastPing = now;
    const e = this.camera.position;
    const boxes = this.collision.query(e.x - PING_LEN, e.z - PING_LEN, e.x + PING_LEN, e.z + PING_LEN)
      .map((b) => ({ min: [b.minX, b.minY, b.minZ] as Vec3, max: [b.maxX, b.maxY, b.maxZ] as Vec3 }));
    this.net.send({ t: 'ping', p: pingPoint([e.x, e.y, e.z], this.input.yaw, this.input.pitch, boxes, this.body.y) });
  }
  private addPing(from: number, p: Vec3) {
    const mat = new THREE.MeshBasicMaterial({ color: COLORS[from % COLORS.length], transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false, side: THREE.DoubleSide });
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.4, 24), mat);
    ring.rotation.x = -Math.PI / 2;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3, 6, 1, true), mat);
    beam.position.y = 1.5;
    g.add(ring, beam);
    g.position.set(p[0], p[1] + 0.03, p[2]);
    g.renderOrder = 10;
    g.traverse((o) => { o.renderOrder = 10; o.frustumCulled = false; });
    this.scene.add(g);
    this.pings.push({ obj: g, until: performance.now() + PING_MS });
  }
  /** Pulse live pings, drop expired ones; for tests. */
  get pingCount() { return this.pings.length; }
  private tickPings(now: number) {
    this.pings = this.pings.filter(({ obj, until }) => {
      if (now < until) {
        const k = 1 + 0.25 * Math.sin(now / 120);
        obj.children[0].scale.setScalar(k);
        ((obj.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = Math.min(0.9, (until - now) / 600);
        return true;
      }
      this.scene.remove(obj);
      (obj.children[0] as THREE.Mesh).geometry.dispose(); (obj.children[1] as THREE.Mesh).geometry.dispose();
      ((obj.children[0] as THREE.Mesh).material as THREE.Material).dispose();
      return false;
    });
  }

  onMsg(m: ServerMsg) {
    if (m.t === 'activity') { this.teamActivity.record(m, performance.now()); return; }
    if (m.t === 'event' && m.kind === 'intro') {
      if (m.level !== this.level?.index) return;
      // Same-seed retries have an identical room message. The fresh intro epoch identifies the actual restart.
      if (!m.ended && m.id > this.intro.id && this.reloadLevel) this.loadLevel(m.level, this.level.seed, true);
      this.intro.receive(m, this.level.name, this.obj?.steps[this.obj.cur] ?? '', this.myId);
      return;
    }
    if (m.t === 'gym') {
      this.gym?.apply(m); this.refreshObjective();
      if (this.gym?.tripped(this.myId)) this.touchPending = this.touchRevive = null;
      this.showPrompt(this.down || this.spectate || this.gym?.tripped(this.myId) ? null : this.target());
      return;
    }
    if (m.t === 'gym-sound') {
      if (!this.gym) return;
      const point = { x: m.p[0], y: m.p[1], z: m.p[2] };
      const d = Math.hypot(point.x - this.pos.x, point.y - this.body.y, point.z - this.pos.z), reach = m.kind === 'trip' ? 15 : 10;
      if (m.kind === 'open' || d <= reach) {
        this.sound.gym(m.kind, point, !lineOfSight(this.campus.collision, this.camera.position, point));
        this.gym.say(m.kind === 'trip' ? m.player === this.myId ? '被篮球绊倒 · 1.5秒不能移动 · 大噪声！' : '有人被篮球绊倒 · 大噪声！' : m.kind === 'open' ? '四灯全亮 · 东门门禁已解除，全员集合' : m.kind === 'switch' ? '记分牌开关已按下' : '咚……篮球正在滚动', m.kind === 'trip' ? 1.5 : 1.2, m.kind === 'open' ? 3 : m.kind === 'trip' ? 2 : 1);
        if (m.kind === 'trip' && m.player === this.myId) this.haptics.pulse('down');
        else if (m.kind === 'open') this.haptics.pulse('success');
        else if (m.kind === 'switch' && m.player === this.myId) this.haptics.pulse('toggle');
      }
      return;
    }
    if (m.t === 'l7') {
      if (!this.level?.def.mirror) return;
      const prev = this.mirrorState;
      this.mirrorState = m;
      const changed = !prev || prev.openDoors.join(',') !== m.openDoors.join(',');
      if (changed) { this.rebuildMirrorCollision(m.openDoors); this.mirrorView?.setDoors(m.openDoors); this.guideAt = 0; }
      if (!prev || prev.revealedDoors.join(',') !== m.revealedDoors.join(',')) { this.guide = null; this.guideAt = 0; }
      this.mirrorView?.setKey(m.key);
      if (prev && !prev.key.taken && m.key.taken) { this.sound.pickup(); this.haptics.pulse('pickup'); }
      if (prev && m.openDoors.length > prev.openDoors.length) { this.sound.door({ x: this.pos.x + 1, y: this.body.y + 1, z: this.pos.z }, true, false); this.haptics.pulse('door'); }
      const actor = m.mirrors.find(a => a.id === this.myId), was = prev?.mirrors.find(a => a.id === this.myId);
      if (actor?.phase === 'chase' && was?.phase !== 'chase') { this.sound.tone('sawtooth', 110, .16, .4, 42); this.haptics.pulse('danger'); }
      if (!prev || changed || prev.key.taken !== m.key.taken) { this.guideAt = 0; this.showBag(); }
      if (actor?.phase !== was?.phase) this.refreshObjective();
      return;
    }
    if (m.t === 'broadcast') {
      this.broadcastView?.receive(m, this.names, !this.pausedForNetwork && !this.feedbackDisposed && !this.completed && performance.now() >= this.fadeUntil);
      if (this.pausedForNetwork) this.input.enabled = false;
      this.refreshObjective(); return;
    }
    if (m.t === 'resume') { this.downHold = Math.max(0, m.downLeft); this.downSince = performance.now(); this.tickDown(this.downSince); return; }
    if (m.t === 'error') this.broadcastView?.error(m.msg);
    if (m.t === 'fade') {
      this.clearDoorPreviews();
      this.cancelVoice();
      this.touchPending = this.touchRevive = null;
      this.awaitingLevel = true;
      this.reviveHold.stop();
      this.levelHandoff = 'fade';
      this.story.setVisible(false);
      this.reloadLevel = !!m.restart;
      this.fadeUntil = performance.now() + m.secs * 1000;
      this.resetCapture();
      this.jasmine.reset();
      this.exam?.close(false);
      if (m.restart && this.level.def.mirror) { this.guide = null; this.guideAt = 0; }
      this.sound.transition(m.secs, m.restart); this.steps.reset(); this.remoteSteps.clear(); this.haptics.cancel();
      this.pendingFeedback = undefined; this.dangerFeedback = false;
      this.route = null;
      this.input.clear();
      this.moves.clear();
      return;
    }
    if (m.t === 'complete' || m.t === 'royale-settle') {
      this.exam?.close(false);
      this.cancelVoice();
      this.story.setVisible(false);
      this.completed = true;
      this.resetCapture();
      this.jasmine.reset();
      this.sound.reset(); this.steps.reset(); this.remoteSteps.clear(); this.haptics.cancel();
      this.pendingFeedback = undefined; this.dangerFeedback = false;
      this.input.enabled = false;
      this.input.clear();
      this.route = null;
      this.moves.clear();
      this.touchPending = this.touchRevive = null;
      this.reviveHold.stop();
      if (m.t === 'royale-settle') {
        clearResume();
        this.setSpectate(this.spectate || m.ranking.some(p => p.id === this.myId && p.rank > 1));
        this.renderCompletion(m);
        // A finished match must not reconnect and save its in-memory session again.
        this.net.close();
      }
      return;
    }
    if (m.t === 'caught') {
      if (m.id !== this.myId || !Number.isSafeInteger(m.seq) || m.seq <= this.lastCaptureSeq) return;
      // Consume even a stale / blocked event: it must not replay after a revive, a join, or a chapter handoff.
      this.lastCaptureSeq = m.seq;
      const now = performance.now();
      if (!this.spawnSynced || this.down || this.spectate || this.awaitingLevel || this.completed || now < this.fadeUntil || m.tick < this.lastSnapTick) return;
      if (!this.capture.begin(m, now, this.input.yaw)) return;
      this.exam?.close(false);
      this.captureOrigin = { at: [...m.at], yaw: this.input.yaw, pitch: this.input.pitch };
      this.downHold = m.hold;
      this.setDown(true);
      const title = document.querySelector('#down-overlay .t');
      if (title) title.textContent = captureTitle(m);
      this.downUntil = now + Math.max(0, m.hold - Math.max(0, this.lastSnapTick - m.tick) * TICK_MS / 1000) * 1000;
      this.route = null; this.input.clear(); this.moves.clear();
      this.sound.capture();
      return;
    }
    if (m.t === 'loop') {
      const before = this.loopPlayers.get(this.myId);
      this.loopPlayers.clear();
      for (const p of m.players) this.loopPlayers.set(p.id, { step: p.step, loops: p.loops, mistakes: p.mistakes });
      const after = this.loopPlayers.get(this.myId);
      if (before && after && after.mistakes > before.mistakes) this.toast(`门序错了，从 ${this.level.def.loop?.sequence[0]} 重新开始`);
      else if (before && after && after.loops > before.loops) this.toast(`越过走廊尽头，触发回环 · 门序 ${after.step}/${this.level.def.loop?.sequence.length} 保留`, 4000);
      else if (before && after && after.step > before.step) this.toast(`门序正确 · ${after.step}/${this.level.def.loop?.sequence.length}`);
      this.guideAt = 0;
      this.refreshObjective();
      return;
    }
    if (m.t === 'warp') {
      const previous = m.id === this.myId ? this.corrC : this.warpEpochs.get(m.id) ?? -1;
      if (m.c <= previous) return;
      this.teamActivity.relocate(m.id);
      this.warpEpochs.set(m.id, m.c);
      const peer = this.peers.get(m.id);
      if (peer) { peer.p = m.p; peer.yaw = m.yaw; }
      if (m.id === this.myId) {
        this.corrC = m.c;
        this.moves.clear(); this.smooth.reset();
        this.pos = { x: m.p[0], z: m.p[2] };
        Object.assign(this.body, { x: m.p[0], y: m.p[1], z: m.p[2], vy: 0, grounded: true });
        this.input.yaw = m.yaw;
        this.guideAt = 0;
      } else {
        const r = this.remotes.get(m.id);
        if (r) {
          r.buf = new InterpBuffer();
          r.clock = new PlaybackClock(INTERP_DELAY_MS); r.sm.reset();
          r.mesh.position.set(m.p[0], m.p[1], m.p[2]);
          r.mesh.rotation.y = m.yaw;
        }
      }
      this.reviveHold.sync();
      return;
    }
    if (m.t === 'ping') { this.addPing(m.from, m.p); return; }
    if (m.t === 'finale') {
      const old = this.finalState?.phase, oldRescue = this.finalState?.rescueMs;
      // A restarted same-seed chapter must reset the local gate even if this client joined during its fade.
      if (m.phase === 'rollcall' && old && old !== 'rollcall') this.loadLevel(this.level.index, this.level.seed, true);
      const revisionChanged = !this.finalState || this.finalState.revision !== m.revision;
      this.finalState = m;
      if (m.phase === 'chase') {
        if (old !== 'chase') this.finaleRouteIndex = 0;
        this.openFinaleGate();
      }
      if (revisionChanged) {
        for (const timer of this.rollcallPending.values()) clearTimeout(timer);
        this.rollcallPending.clear();
      }
      if (m.phase !== 'rollcall') this.closeRollcall();
      this.renderRollcall();
      this.refreshObjective();
      if (m.phase === 'chase' && old !== 'chase') this.toast('全队名字已划完！出教务处回走廊，经办公楼南门沿绿标冲向校门');
      else if (m.phase === 'chase' && m.rescueMs !== undefined && oldRescue === undefined) this.toast('已有人到达校门，45 秒内全队撤离；超时记为未逃出');
      this.guideAt = 0;
      return;
    }
    if (m.t === 'completed') {
      this.completion = m;
      this.finalState = this.finalState ? { ...this.finalState, phase: 'complete' } : {
        t: 'finale', revision: 0, phase: 'complete', elapsedMs: m.elapsedMs, downs: m.downs,
        members: m.members.map((p) => ({ id: p.id, name: p.name, crossedOut: true, status: p.escaped ? 'escaped' : 'out', downs: p.downs })),
      };
      this.renderCompletion(m);
      this.refreshObjective();
      const objective = document.getElementById('objective');
      if (objective) objective.hidden = true;
      this.guideAt = 0;
      return;
    }
    if (isLineEvent(m)) {
      if (this.feedbackDisposed || this.completed || this.awaitingLevel || performance.now() < this.fadeUntil) return;
      const voiceEpoch = this.voiceEpoch, playback = this.voice.capturePlayback();
      // the line can outrun the snapshot that moves its mob: measure the distance a moment later
      const feedbackEpoch = this.feedbackEpoch;
      setTimeout(() => {
        if (voiceEpoch !== this.voiceEpoch || feedbackEpoch !== this.feedbackEpoch || this.feedbackDisposed || this.completed || this.awaitingLevel || performance.now() < this.fadeUntil) return;
        const mob = this.mobs.byId.get(m.mob), c = this.camera.position;
        if (!this.pausedForNetwork) this.voice.say(m.text, mob ? Math.hypot(mob.at[0] - c.x, mob.at[2] - c.z) : Infinity, playback);
      }, 300);
      return;
    }
    if (m.t === 'exam' && this.exam) {
      if (m.revision < this.exam.state.revision) return;
      this.exam.setState(m);
      this.syncExamGate(m.passed);
      this.examBlackout = m.blackout && m.blackout.seconds > 0 ? { floor: m.blackout.floor, until: performance.now() + m.blackout.seconds * 1000 } : undefined;
      this.refreshObjective(); this.guideAt = 0;
      return;
    }
    if (m.t === 'items') this.showItems(m.items);
    if (m.t === 'nav') this.navGraph = navFromMsg(m.n, m.adj);
    if (m.t === 'keys') {
      this.heldKeys = m.keys;
      this.showBag();
    }
    if (m.t === 'power') {
      if (this.pendingFeedback?.kind === 'fuse') this.pendingFeedback = undefined;
      this.setPower(m.n);
    }
    if (m.t === 'trip') { this.humStop(); this.trip = m.omen + m.off > 0 ? { t0: performance.now(), at: m.at, omen: m.omen, off: m.off, beat: 0 } : undefined; }
    if (m.t === 'bag') {
      this.bag = m.bag;
      this.showBag();
    }
    if (m.t === 'snap' && m.gone) {
      const now = performance.now();
      for (const [id, until] of this.tutPicks) {
        if (now > until) this.tutPicks.delete(id);
        else if (m.gone.includes(id)) { this.tutPicked = true; this.tutPicks.delete(id); }
      }
      const pending = this.pendingFeedback;
      if (pending?.kind === 'pick' && performance.now() <= pending.until && m.gone.includes(pending.id)) {
        this.sound.pickup(); this.haptics.pulse('pickup'); this.pendingFeedback = undefined;
      }
      this.dropItems(m.gone);
      if (this.promptEl && !this.pendingFeedback) this.showPrompt(this.target());
    }
    if (m.t === 'doors' || (m.t === 'snap' && m.doors)) {
      for (const d of m.doors ?? []) {
        this.doorPreview?.delete(d.id);
        if (!this.pausedForNetwork && this.spawnSynced && this.doorSwing.length && !!this.doorOpen[d.id] !== d.open && this.doors[d.id]) {
          const ds = this.doors[d.id];
          if (d.open) this.doorDir[d.id] = doorSwingDir(ds, this.pos);
          this.doorSound(ds, d.open);
        }
        this.doorOpen[d.id] = d.open;
        this.doorLocked[d.id] = d.locked;
        const pending = this.pendingFeedback;
        if (pending?.kind === 'use' && pending.id === d.id) this.pendingFeedback = undefined;
      }
      this.refreshDoors();
      if (this.promptEl && !this.pendingFeedback) this.showPrompt(this.target());
    }
    if (m.t === 'snap') {
      if (m.zone) this.onZoneSnap(m.zone);
      this.snaps++;
      const now = performance.now();
      this.lastSnapTick = Math.max(this.lastSnapTick, m.tick);
      this.lastFeedbackSnap = now;
      this.teamActivity.observe(m.players, m.tick, now);
      // PlaybackClock follows each entity's newest tick, so keep its samples in server time.
      // Converting a loading backlog to local time compresses tick spacing during clock settling,
      // inflating sampled velocity and making clients extrapolate the same patrol to different positions.
      const snapT = m.tick * TICK_MS;
      const seen = new Set<number>();
      for (const p of m.players) {
        seen.add(p.id);
        // take the server's per-slot spawn once per level
        if (p.id === this.myId && !this.spawnSynced) {
          this.pos = { x: p.p[0], z: p.p[2] };
          this.spawnSynced = true;
          this.spawnCampus(p.p);
        }
        const st = p.st ?? ST_OK; // the snap leaves out st when OK and bat / sta when unchanged
        this.peers.set(p.id, { st, p: p.p, yaw: p.yaw, escaped: !!p.escaped, online: p.online !== false });
        if (p.id === this.myId) {
          const wasDown = this.down;
          this.escaped = !!p.escaped;
          this.setBattery(p.bat ?? this.battery); this.setStamina(p.sta ?? this.stamina); this.setDown(st === ST_DOWN);
          this.downUntil = st === ST_DOWN && p.downUntil !== undefined ? now + Math.max(0, p.downUntil - m.tick) * TICK_MS : undefined;
          if (!this.pausedForNetwork && wasDown && st === ST_OK) { this.sound.pickup(); this.haptics.pulse('revive'); }
          // A refreshed page has no local locker heading; establish it before setHiding clamps the view.
          if (this.pausedForNetwork && ((p.f ?? this.myF) & F_HIDE) && this.hiding < 0) this.hideYaw = p.yaw;
          this.setHiding(this.myF = p.f ?? this.myF, p.p); this.setSpectate(st === ST_SPECTATE);
          if (this.pausedForNetwork) { this.input.yaw = p.yaw; this.input.pitch = p.pitch ?? this.input.pitch; this.input.enabled = false; }
          this.capture.sync(st === ST_DOWN, st === ST_SPECTATE, now); continue;
        }
        let r = this.remotes.get(p.id);
        if (!r) {
          const st = new Student(COLORS[p.id % COLORS.length]);
          r = { mesh: st.root, st, buf: new InterpBuffer(), clock: new PlaybackClock(INTERP_DELAY_MS), sm: new StepSmoother(1.3, 1, REMOTE_SNAP_M, SPEED.run), f: 0, down: false, out: false, escaped: false, offline: false, pitch: 0 };
          this.scene.add(r.mesh, st.spot);
          this.remotes.set(p.id, r);
        }
        r.f = p.f ?? r.f;
        r.down = st === ST_DOWN;
        r.escaped = !!p.escaped;
        r.out = st === ST_SPECTATE || r.escaped;
        r.offline = p.online === false;
        if (r.offline) { r.mesh.visible = false; r.st.spot.visible = false; }
        if (r.down && !r.marker) { r.marker = downMarker(); r.mesh.add(r.marker); }
        else if (!r.down && r.marker) { r.mesh.remove(r.marker); r.marker.material.map?.dispose(); r.marker.material.dispose(); r.marker = undefined; }
        // The protocol position is at the feet; Student lowers its hips for crouching.
        r.buf.push({ t: snapT, x: p.p[0], y: p.p[1], z: p.p[2], yaw: p.yaw, pitch: p.pitch });
      }
      for (const [id, r] of this.remotes) if (!seen.has(id)) {
        this.scene.remove(r.mesh); r.st.dispose();
        if (r.marker) { r.marker.material.map?.dispose(); r.marker.material.dispose(); }
        this.remotes.delete(id); this.peers.delete(id); this.remoteSteps.delete(id); this.loopPlayers.delete(id); this.warpEpochs.delete(id);
      }
      this.mobs.onSnap(m.mobs, snapT);
      this.bossView.receive(m.boss);
      this.reviveHold.sync();
    } else if (m.t === 'correct') {
      if (m.c !== undefined && m.c < this.corrC) return;
      // Room roster updates also arrive during a fade. Only the server's next forced spawn arms a reload.
      if (m.forced && m.c !== undefined && m.c > this.corrC && this.levelHandoff === 'fade') this.levelHandoff = 'spawn';
      if (m.forced || m.ack === undefined) this.teamActivity.relocate(this.myId);
      if (m.c !== undefined) this.corrC = m.c;
      const from = { x: this.pos.x, y: this.body.y, z: this.pos.z };
      if (m.forced || m.ack === undefined || !this.campus) { // the server moved us (spawn, caught, tp, hiding): teleport
        if (!m.forced) this.corrections++;
        this.moves.clear();
        this.smooth.reset();
        this.pos = { x: m.p[0], z: m.p[2] };
        if (this.campus) Object.assign(this.body, { x: m.p[0], y: m.p[1], z: m.p[2], vy: 0, grounded: true });
        // An unhide relocation can arrive one frame before its snapshot. Clear the old pin atomically;
        // otherwise update() restores the locker centre and sends that solid position in the new epoch.
        if (m.forced && m.f !== undefined) this.setHiding(this.myF = m.f, m.p);
        this.reviveHold.sync();
        return;
      }
      // a rejected prediction: replay the moves from the rejected input on from the server's spot, then slide the
      // camera over (a < SOFT_CORRECT_M miss gently, a bigger one within ~CORRECT_BLEND_S, > 2 m snaps)
      this.corrections++;
      const b = this.moves.replay(this.collision, m.p, m.ack, NAV_CAPSULE);
      Object.assign(this.body, b);
      this.pos = { x: b.x, z: b.z };
      const err = Math.hypot(from.x - b.x, from.z - b.z);
      if (!this.smooth.kick(from, b, err < SOFT_CORRECT_M ? CORRECT_BLEND_S / 3 : CORRECT_BLEND_S / 5)) this.smooth.reset();
      this.reviveHold.sync();
    }
  }

  /** Latest st / position of every player (self included), for the Tab team panel and spectating. */
  private peers = new Map<number, { st: number; p: Vec3; yaw: number; escaped?: boolean; online: boolean }>();
  /** Downed (st = ST_DOWN in our own snap entry): movement locked, low grey view, heartbeat, countdown overlay. */
  down = false;
  /** Seconds the server announced ('caught' msg) before a downed player is out; only for the countdown display. */
  downHold = 30;
  private downSince = 0;
  private downUntil?: number;
  private setDown(d: boolean) {
    if (d === this.down) return;
    this.down = d;
    if (d) this.exam?.close(false);
    if (d) {
      this.broadcastView?.close();
      const title = document.querySelector('#down-overlay .t');
      if (title) title.textContent = '你被抓住了';
    }
    if (d) { this.touchPending = this.touchRevive = null; this.reviveHold.stop(); }
    this.downSince = performance.now();
    this.steps.reset();
    if (d && !this.pausedForNetwork) this.haptics.pulse('down');
    if (!d) { const el = document.getElementById('down-overlay'); if (el) el.hidden = true; }
  }
  private tickDown(now: number) {
    if (!this.down) return;
    const el = document.getElementById('down-overlay');
    if (!el) return;
    el.hidden = false;
    const left = Math.max(0, Math.ceil(this.downUntil === undefined ? this.downHold - (now - this.downSince) / 1000 : (this.downUntil - now) / 1000));
    const n = el.querySelector('.n');
    if (n) n.textContent = String(left);
  }

  /** Out for this level (st = ST_SPECTATE): free-fly camera, Tab cycles through teammates to follow. */
  spectate = false;
  escaped = false;
  private follow = 0; // player id being followed; 0 = free fly
  private fly = new THREE.Vector3();
  private setSpectate(on: boolean) {
    if (on === this.spectate) return;
    this.spectate = on;
    if (on) this.exam?.close(false);
    if (on) { this.touchPending = this.touchRevive = null; this.reviveHold.stop(); }
    this.input.captureTab = on;
    if (on) this.broadcastView?.close();
    this.follow = 0;
    // A late observer can receive its first snapshot before the first camera update.
    if (on) this.fly.set(this.pos.x, this.body.y + this.eye, this.pos.z);
    const el = document.getElementById('spec-bar');
    if (el) el.hidden = !on || this.completed;
  }
  private specCamera(dt: number, fx: number, fz: number) {
    if (this.input.consume('Tab')) {
      const ids = [...this.remotes].filter(([, r]) => !r.out && !r.offline).map(([id]) => id);
      const at = ids.indexOf(this.follow);
      this.follow = at + 1 < ids.length ? ids[at + 1] : 0;
    }
    const r = this.follow ? this.remotes.get(this.follow) : undefined;
    if (this.follow && (!r || r.out || r.offline)) this.follow = 0;
    const bar = document.getElementById('spec-bar');
    if (bar) bar.textContent = this.follow ? `观察：${this.names.get(this.follow) ?? '?'} · Tab 切换` : '你已出局 · WASD 自由飞行 · Tab 观察队友';
    const inp = this.input;
    if (r && this.follow) {
      this.camera.position.set(r.mesh.position.x, r.mesh.position.y + EYE_H, r.mesh.position.z);
      this.camera.rotation.set(r.pitch, r.mesh.rotation.y, 0);
      return;
    }
    const sp = 6 * dt, cp = Math.cos(inp.pitch);
    const fwd = new THREE.Vector3(-Math.sin(inp.yaw) * cp, Math.sin(inp.pitch), -Math.cos(inp.yaw) * cp);
    const right = new THREE.Vector3(Math.cos(inp.yaw), 0, -Math.sin(inp.yaw));
    this.fly.addScaledVector(fwd, -fz * sp).addScaledVector(right, fx * sp);
    this.camera.position.copy(this.fly);
    this.camera.rotation.set(inp.pitch, inp.yaw, 0);
  }

  /** Live hold validity is independent of rendering, including authoritative teammate state and range. */
  private heldReviveTarget(): number | null {
    if (this.feedbackDisposed || this.pausedForNetwork || this.story?.isOpen || !this.input.enabled || !this.spawnSynced || this.down || this.spectate || this.completed || this.awaitingLevel || this.mapOn || this.gym?.tripped(this.myId)
      || this.hiding >= 0 || performance.now() < this.fadeUntil || document.visibilityState === 'hidden') return null;
    let id: number | null = null;
    if (this.touchRevive) {
      // Holds follow current input and corrections even when the visible camera has not had a frame to catch up.
      // Ordinary taps keep using the rendered camera so their visual door/item target remains stable.
      const camera = this.reviveCamera.copy(this.camera, false);
      camera.position.set(this.pos.x, this.body.y + this.eye, this.pos.z);
      camera.rotation.set(this.input.pitch, this.input.yaw, 0);
      const touch = this.touchRevive, hit = this.touchTarget(touch.x, touch.y, camera);
      if (hit?.target.kind === 'revive' && hit.target.id === touch.id
        && touchHitState(hit, camera, [this.pos.x, this.body.y, this.pos.z], this.collision) === 'ready') id = touch.id;
      else this.touchRevive = null;
    } else if (this.input.held('KeyE')) {
      const target = this.target([this.pos.x, this.body.y + this.eye, this.pos.z]);
      if (target?.kind === 'revive') id = target.id;
    }
    const peer = id === null ? undefined : this.peers.get(id);
    return peer?.st === ST_DOWN && peer.online && inReachDown([this.pos.x, this.body.y, this.pos.z], peer.p, peer.yaw) ? id : null;
  }

  private hideReviveRing() { const ring = document.getElementById('revive-ring'); if (ring) ring.hidden = true; }

  private tickRevive(now: number) {
    this.reviveHold.sync();
    const ring = document.getElementById('revive-ring'), since = this.reviveHold.since;
    if (!ring) return;
    ring.hidden = since === null;
    if (since !== null) ring.style.setProperty('--p', String(Math.min(1, (now - since) / 1000 / REVIVE_HOLD_S)));
  }

  /** Tab: confirmed recent actions, then actual movement / pose. Hidden teammates disclose no distance. */
  private tickTeam() {
    const el = document.getElementById('team');
    if (!el) return;
    const show = this.input.down('Tab') && !this.spectate;
    el.hidden = !show;
    if (!show) return;
    const now = performance.now();
    const rows: HTMLElement[] = [];
    for (const [id, q] of [...this.peers].sort((a, b) => a[0] - b[0])) {
      const row = document.createElement('div');
      const d = id === this.myId ? 0 : Math.hypot(q.p[0] - this.pos.x, q.p[1] - this.body.y, q.p[2] - this.pos.z);
      const state = !q.online ? '断线中' : q.escaped ? '已逃出' : this.gym?.tripped(id) ? '绊倒' : this.teamActivity.status(id, now);
      row.className = q.escaped || q.st === ST_SPECTATE ? 'out' : q.st === ST_DOWN ? 'down' : '';
      row.textContent = `${this.names.get(id) ?? '?'}${id === this.myId ? '（你）' : ''}  ${state}${id === this.myId || this.teamActivity.hidden(id) ? '' : `  ${Math.round(d)} m`}`;
      const lp = this.loopPlayers.get(id);
      if (lp && this.level.def.loop) row.textContent += ` · 门序 ${lp.step}/${this.level.def.loop.sequence.length} · 回环 ${lp.loops}`;
      rows.push(row);
    }
    el.replaceChildren(...rows);
  }

  /** Put the body on the server-assigned spawn, facing the way into the building (not the tree trunk outside). */
  private spawnCampus(p: [number, number, number]) {
    Object.assign(this.body, { x: p[0], y: p[1], z: p[2], vy: 0, grounded: true });
    const [a, b] = spawnRoute();
    this.input.yaw = Math.atan2(a[0] - b[0], a[1] - b[1]); // camera looks down -Z at yaw 0: forward = (-sin, -cos)
    if (this.level.def.mirror) this.input.yaw = Math.PI / 2;
    const clue = this.level.def.loop?.clue;
    if (clue) this.input.yaw = Math.atan2(p[0] - clue.x, p[2] - clue.z);
    this.input.pitch = 0;
  }

  /** Walk the waypoints (route[0] is the start, skipped); resolves via `autopilotDone`. */
  autopilot(route: [number, number][]) {
    this.route = route;
    this.routeAt = Math.min(1, route.length - 1);
  }

  get autopilotDone() { return this.route === null; }

  /** Steer yaw at the current waypoint; returns false once the last one is reached. */
  private steer(): boolean {
    const route = this.route;
    if (!route || !this.input.enabled) return false;
    let [wx, wz] = route[this.routeAt];
    while (Math.hypot(wx - this.pos.x, wz - this.pos.z) < 0.3) {
      if (++this.routeAt >= route.length) { this.route = null; return false; }
      [wx, wz] = route[this.routeAt];
    }
    this.input.yaw = Math.atan2(this.pos.x - wx, this.pos.z - wz);
    return true;
  }

  start() {
    // the rAF timestamp (frame start, shared by every callback this frame) rather than performance.now() at callback
    // time, which jitters with whatever ran before us in the frame and made remote steps uneven frame to frame
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      // below 10 fps step in ≤0.1 s slices so movement keeps real-time speed instead of going slow-motion
      // (≤0.3 s in all for the local sim; the remotes' and mobs' playback gets the real elapsed time, see frameSlices)
      const slices = frameSlices((now - this.last) / 1000);
      this.last = now;
      for (const [dt, rdt] of slices) this.update(dt, now, rdt);
      if (this.drawOn) this.renderFrame();
      this.tickObjective(performance.now());
    };
    requestAnimationFrame(loop);
  }

  /** All campaign draws, including screenshots, use the existing scene and its mirror pass hook. */
  renderFrame() { this.renderer.render(this.scene, this.camera); }
  /** Called after queued authoritative state is applied, before any simulation or movable input is sent. */
  presentWorld(): boolean {
    if (!this.spawnSynced || this.worldReady) return false;
    this.input.clear();
    this.camera.position.set(this.pos.x, this.body.y + this.eye, this.pos.z);
    this.camera.rotation.set(this.input.pitch, this.input.yaw, 0);
    this.campus.update(0, this.camera);
    if (this.drawOn) this.renderFrame();
    this.worldReady = true;
    this.last = performance.now();
    return true;
  }

  /** `rdt`: the slice in real time for the server-clocked playback (remotes, mobs), see frameSlices. */
  update(dt: number, now: number, rdt = dt) {
    const inp = this.input;
    if (!this.worldReady || this.feedbackDisposed || this.pausedForNetwork) { inp.clear(); return; }
    if (this.intro.active) {
      this.monitorMurmurs.pause();
      // The presentation moves only the camera; player prediction, actions and uploads remain frozen until ended.
      inp.clear();
      inp.enabled = false;
      if (this.spawnSynced) {
        if (!this.introView) {
          this.introView = { yaw: inp.yaw, pitch: inp.pitch };
          this.camera.position.set(this.pos.x, this.body.y + EYE_H, this.pos.z);
          this.camera.rotation.set(inp.pitch, inp.yaw, 0);
        }
        inp.yaw = this.introView.yaw; inp.pitch = this.introView.pitch;
        // Set the authoritative player view once. LevelIntro keeps its own camera restore pose.
        if (!this.intro.presenting || this.intro.reducedMotion) {
          this.camera.position.set(this.pos.x, this.body.y + EYE_H, this.pos.z);
          this.camera.rotation.set(inp.pitch, inp.yaw, 0);
        }
      }
      this.flashlight.visible = false;
      this.jasmine.update(Infinity);
      for (const o of this.mobs.byId.values()) o.mesh.visible = false;
      for (const r of this.remotes.values()) r.mesh.visible = false;
      for (const light of this.teamLights) light.intensity = 0;
      this.sound.update({ x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z, yaw: this.camera.rotation.y,
        indoors: true, down: false, threat: 0, active: this.spawnSynced && this.intro.presenting, power: !this.campus.blackout });
      this.intro.update(this.spawnSynced);
      this.animateDoors(dt); this.stepTrip(); this.campus.update(dt, this.camera);
      this.intro.syncLighting(this.campus.world.interior);
      this.camera.updateMatrixWorld();
      return;
    }
    if (this.completed || this.completion || this.awaitingLevel || now < this.fadeUntil) { this.interactionHighlight.update(now, this.camera.position, this.body.y, this.campus.collision, false); inp.endFrame(); return; }
    const captureFrame = this.captureFrameState = this.capture.update(now);
    // Quantize the blend to avoid rewriting a canvas filter every frame while colour drains / returns.
    const gray = Math.round(captureFrame.grayscale * 20) / 20;
    const filter = gray > 0 ? `grayscale(${gray}) contrast(${(1 + gray / 9).toFixed(3)}) brightness(${(1 - gray / 6).toFixed(3)})` : '';
    if (this.renderer.domElement.style.filter !== filter) this.renderer.domElement.style.filter = filter;
    this.exam?.tick(now);
    const activeExam = this.exam?.activeTarget;
    if (activeExam && !this.canReadExam(activeExam)) this.exam?.close(false);
    if (this.story.isOpen) inp.clear();
    const crouch = inp.down('KeyC') || inp.down('ControlLeft');
    if (crouch && inp.enabled && this.spawnSynced && !this.down && !this.spectate && this.hiding < 0) this.tutCrouched = true;
    const run = !crouch && inp.down('ShiftLeft') && canRun(this.stamina, this.exhausted);
    if (inp.consume('KeyF')) { this.light = !this.light; this.click(); this.haptics.pulse('toggle'); }
    if (inp.consume('KeyQ')) this.sendPing(now);
    if (inp.consume('KeyG')) this.toggleArrow();
    if (inp.consume('KeyM')) this.toggleMap();
    this.tickPings(now);
    this.gym?.tick(dt, now);
    this.tickFinale(now);
    this.tickIdleHint(now);
    this.tickMap(now);
    if (inp.consume('KeyR')) {
      if ((this.bag.battery ?? 0) <= 0) this.toast('背包里没有电池');
      else if (this.battery < 1) this.net.send({ t: 'use', item: 'battery' });
    }
    const examHit = this.exam && inp.enabled && !this.exam.open && !this.down && !this.spectate && this.hiding < 0
      ? examTarget(this.exam.def, { x: this.pos.x, y: this.body.y, z: this.pos.z }, this.camera.position, inp.yaw, (a, b) => lineOfSight(this.campus.collision, a, b)) : null;
    const tripped = !!this.gym?.tripped(this.myId);
    if (tripped) this.touchPending = this.touchRevive = null;
    let tgt = !inp.enabled || this.down || this.spectate || this.escaped || tripped || examHit ? null : this.target();
    if (this.touchRevive) {
      const id = this.heldReviveTarget(), peer = id === null ? undefined : this.peers.get(id);
      if (id !== null && peer) tgt = { kind: 'revive', id, ...downCand(peer.p, peer.yaw) };
    }
    this.story.setVisible(this.storyCanShow(now));
    this.story.setAvailable(!this.royaleZone && inp.enabled && this.spawnSynced && !this.down && !this.spectate && this.hiding < 0 && !this.view && !this.mapOn && !this.storyBlocked(tgt));
    const registerNear = this.isRegisterNear();
    this.showPrompt(tgt, registerNear ? (this.rollcallOpen ? '点名册已打开 · 点按姓名划名' : document.body.classList.contains('touch') ? '点按点名册查看' : 'E 查看点名册') : '');
    if (examHit && this.promptEl) {
      const notice = this.exam!.def.notices[examHit.index];
      const text = examHit.kind === 'paper' ? 'E 填写共用试卷 / 交卷' : `E 阅读考试公告（第${notice.questions.map((n) => n + 1).join('、')}题）`;
      this.promptEl.textContent = document.body.classList.contains('touch') ? touchPrompt(text) : text;
    }
    if (tgt?.kind === 'revive') inp.consume('KeyE'); // revive is a hold, sent each tick by tickRevive
    else if (inp.consume('KeyE')) {
      if (registerNear && !this.rollcallOpen) this.openRollcall();
      else if (this.rollcallOpen) this.closeRollcall();
      else if (this.readStory()) this.tutUsed = true;
      else if (examHit?.kind === 'paper') this.exam!.openPaper();
      else if (examHit?.kind === 'notice') this.exam!.openNotice(examHit.index);
      else this.interact(tgt);
    }
    this.tickRevive(now);
    this.tickTeam();
    // autopilot presses E at a closed door in its way (at most twice a second, until the snapshot shows it open)
    if (!this.exam?.open && this.route && inp.enabled && now - this.autoDoorAt > 500) {
      const id = doorTargetIn(this.doors, this.pos.x, this.pos.z, inp.yaw, 1.8, this.body.y);
      if (id >= 0 && !this.doorOpen[id]) { this.net.send({ t: 'door', id }); this.autoDoorAt = now; }
    }
    const lit = this.light && this.battery > 0;
    this.flashlight.visible = this.hiding < 0 && lit && (this.battery >= 0.2 || Math.sin(now * 0.04) + Math.sin(now * 0.0123) > -0.6);

    let fx = 0, fz = 0;
    if (inp.down('KeyW')) fz -= 1;
    if (inp.down('KeyS')) fz += 1;
    if (inp.down('KeyA')) fx -= 1;
    if (inp.down('KeyD')) fx += 1;
    if (!this.exam?.open && this.steer()) fz = -1;
    const flyX = fx, flyZ = fz;
    if (this.down || this.spectate || this.escaped || this.hiding >= 0 || this.gym?.tripped(this.myId) || this.exam?.open) { fx = 0; fz = 0; } // 倒地 / 出局 / 绊倒：锁定移动，仍可转头
    this.tickDown(now);
    const len = Math.hypot(fx, fz);
    const spot = this.hiding >= 0 ? this.level.def.hides[this.hiding] : null;
    let walked = 0; // ground covered this frame, for the head bob
    if (spot) { // pinned by the server: no prediction (a desk's collider would push us out)
      Object.assign(this.body, { x: spot.x, z: spot.z, vy: 0 });
      this.pos = { x: spot.x, z: spot.z };
      if (spot.kind === 'locker') { // only a slit of view: yaw within ±0.5 rad of the door, pitch near level
        const d = Math.atan2(Math.sin(inp.yaw - this.hideYaw), Math.cos(inp.yaw - this.hideYaw));
        inp.yaw = this.hideYaw + Math.max(-0.5, Math.min(0.5, d));
        inp.pitch = Math.max(-0.12, Math.min(0.12, inp.pitch));
      } else inp.pitch = Math.max(-0.3, Math.min(0.3, inp.pitch));
    } else if (this.presentationReady) {
      const sp = len > 0 ? (crouch ? SPEED.crouch : run ? SPEED.run : SPEED.walk) * dt / len : 0;
      const s = Math.sin(inp.yaw), c = Math.cos(inp.yaw);
      const dx = (fx * c + fz * s) * sp, dz = (-fx * s + fz * c) * sp;
      const bx = this.body.x, bz = this.body.z;
      moveCapsule(this.collision, this.body, dx, dz, dt, NAV_CAPSULE);
      walked = Math.hypot(this.body.x - bx, this.body.z - bz);
      this.moves.push({ seq: this.seq + 1, dx, dz, dt });
      this.pos = { x: this.body.x, z: this.body.z };
    }
    inp.endFrame();
    const targetEye = spot ? (spot.kind === 'desk' ? 0.4 : 1.45) : captureFrame.lowering > 0 ? EYE_H + (DOWN_EYE_H - EYE_H) * captureFrame.lowering : this.down || this.gym?.tripped(this.myId) ? DOWN_EYE_H : crouch ? CROUCH_EYE_H : EYE_H;
    this.eye += (targetEye - this.eye) * Math.min(1, dt * 10);
    this.smooth.step(dt);
    const bob = this.bob.step(walked, dt, !!spot || this.down || !!this.gym?.tripped(this.myId) || crouch || !this.body.grounded);
    this.camera.position.set(this.pos.x + this.smooth.x, this.body.y + this.eye + bob + this.smooth.y, this.pos.z + this.smooth.z);
    this.camera.rotation.set(inp.pitch, inp.yaw, 0);
    if (this.spectate) this.specCamera(dt, flyX, flyZ);
    if (captureFrame.caught && this.captureOrigin && !this.spectate) {
      const { at, yaw, pitch } = this.captureOrigin;
      this.camera.position.set(at[0], at[1] + this.eye, at[2]);
      this.camera.rotation.set(pitch, yaw, 0);
    } else this.captureOrigin = undefined;
    if (this.view) {
      this.camera.position.set(this.view.x, this.view.y, this.view.z);
      this.camera.rotation.set(this.view.pitch, this.view.yaw, 0);
    }
    if (!this.spectate && !this.view) { this.camera.rotation.x += captureFrame.pitch; this.camera.rotation.z += captureFrame.roll; }
    this.reviveHold.sync(); // movement can leave reach after the pre-move interaction check
    this.animateDoors(dt);
    if (!this.level.def.mirror) { this.stepTrip(); this.campus.update(dt, this.camera); }
    else if (this.camera.far !== 60) { this.camera.far = 60; this.camera.updateProjectionMatrix(); }
    this.interactionHighlight.update(now, this.camera.position, this.body.y, this.campus.collision,
      inp.enabled && this.spawnSynced && !this.down && !this.spectate && this.hiding < 0);

    this.sendAcc += dt * 1000;
    if (this.sendAcc >= TICK_MS && this.presentationReady) {
      this.sendAcc %= TICK_MS;
      const f = (crouch ? F_CROUCH : 0) | (run ? F_RUN : 0) | (this.light ? F_LIGHT : 0);
      this.net.send({ t: 'input', seq: ++this.seq, p: [this.pos.x, this.body.y, this.pos.z], yaw: inp.yaw, pitch: inp.pitch, f, c: this.corrC });
    }

    this.mobs.syncLighting(this.campus.world.interior);
    this.mobs.update(now, rdt, [this.camera.position, ...[...this.remotes.values()].map((r) => r.mesh.position.clone().setY(r.mesh.position.y + 1.6))], this.camera, (eye, label) => lineOfSight(this.collision, eye, label));
    let wd = Infinity, chaseDistance = Infinity;
    for (const o of this.mobs.byId.values()) {
      const distance = o.mesh.position.distanceTo(this.camera.position);
      if (!o.monitor) wd = Math.min(wd, distance);
      if (isNearbyChase(o, distance)) chaseDistance = Math.min(chaseDistance, distance);
    }
    const active = this.spawnSynced && now - this.lastFeedbackSnap < 2500 && !this.spectate && !this.view && !!document.getElementById('fade-overlay')?.hidden;
    this.jasmine.update(active ? wd : Infinity, rdt);
    this.zoneHud?.update(this.royaleZone, this.nextZone, active ? { x: this.pos.x, z: this.pos.z, yaw: this.input.yaw } : undefined, rdt);
    this.tickTut(now);
    const mirrorChase = this.mirrorState?.mirrors.some(a => a.phase === 'chase') ?? false;
    const threat = Math.max(soundThreat(wd, chaseDistance), mirrorChase ? .9 : 0);
    this.monitorMurmurs.update(rdt, this.camera, this.mobs.byId, (eye, target) => lineOfSight(this.collision, eye, target),
      active && !this.pausedForNetwork && !this.feedbackDisposed && !this.down && !this.mapOn && !this.rollcallOpen && !document.getElementById('subtitle')?.textContent?.trim());
    this.sound.update({ x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z, yaw: this.camera.rotation.y,
      pitch: this.camera.rotation.x, floorY: this.body.y, dt: rdt, frameId: now,
      indoors: eyeIndoors(this.campus.world.interiors, this.camera.position.x, this.camera.position.y, this.camera.position.z),
      down: this.down, threat, active, power: !this.campus.blackout && (this.campus.out === 0
        || (this.campus.outFloor !== null && Math.floor((this.camera.position.y + 0.01) / FLOOR_HEIGHT) !== this.campus.outFloor)),

      spatial: { collision: this.collision, mobs: [...this.mobs.byId].map(([id, o]) => ({
        id, x: o.mesh.position.x, y: o.mesh.position.y, z: o.mesh.position.z, anim: o.anim, monitor: o.monitor,
      })) } });
    if (active && this.steps.step(walked, dt, crouch, this.body.grounded && !this.down && this.hiding < 0, now)) this.sound.footstep(crouch, run);
    if (!active) { this.steps.reset(); this.haptics.cancel(); }
    const danger = active && !this.down && threat > 0.5;
    if (danger && !this.dangerFeedback) this.haptics.pulse('danger');
    if (danger) this.dangerFeedback = true;
    else if (!active || this.down || threat < 0.25) this.dangerFeedback = false;
    this.camera.updateMatrixWorld(); // the view was set above; the renderer would only refresh it after we cull
    this.story.update();
    this.tickGuide(now);
    cullSkinned(this.camera, [...this.mobs.byId.values()].map((o) => o.mesh));
    const fr = viewFrustum(this.camera);
    this.beamScores.clear();
    const eye = this.camera.position;
    const occluded = (hit: THREE.Vector3, dist: number) =>
      !!beamHit(this.collision, eye, _toPool.subVectors(hit, eye).divideScalar(dist), dist - 0.3, this.beamHit);
    for (const [id, r] of this.remotes) {
      // render clock trails their newest sample by ~INTERP_DELAY_MS (rate-adjusted, snaps if 1.5 s off)
      // run at most EXTRAP_MAX_MS past the newest sample (extrapolated) when their snapshots stall
      const first = Number.isNaN(r.clock.t);
      const fresh = r.clock.advance(rdt * 1000, r.buf.lastT(), r.buf.lastT() + EXTRAP_MAX_MS);
      const rt = r.clock.t;
      const s = r.buf.at(rt, r.down ? 0 : EXTRAP_MAX_MS, EXTRAP_MAX_SPEED);
      if (!s) continue;
      // ground position: per-frame step ≤ 1.3× their recent sampled speed (≤ run speed), so leftover unevenness / extrapolation doesn't lurch
      // box-filtered over ±1 tick so a 0 / 2-step tick pair reads as an even walk (not while down: they lie still)
      const g = r.down ? s : r.buf.avgAt(rt, 2 * TICK_MS, 5, EXTRAP_MAX_MS, EXTRAP_MAX_SPEED)!;
      // a later snap (snapshots stalled > 1.5 s, then a batch) slides over fast instead of teleporting
      if (fresh) { if (first) r.sm.reset(); else r.sm.catchUp(); }
      r.sm.step(g.x, g.z, rdt, r.buf.paceSpeed());
      const speed = rdt > 0 && !r.down ? Math.hypot(r.sm.x - r.mesh.position.x, r.sm.z - r.mesh.position.z) / rdt : 0;
      r.mesh.position.set(r.sm.x, s.y, r.sm.z);
      let steps = this.remoteSteps.get(id);
      if (!steps) { steps = new FootstepClock(); this.remoteSteps.set(id, steps); }
      if (!first && !r.out && !r.offline && steps.step(speed * rdt, rdt, !!(r.f & F_CROUCH), !r.down && !(r.f & F_HIDE), now)) {
        const point = { x: r.sm.x, y: s.y + 0.15, z: r.sm.z };
        this.sound.footstep(!!(r.f & F_CROUCH), !!(r.f & F_RUN), point, !lineOfSight(this.collision, this.camera.position, point),
          eyeIndoors(this.campus.world.interiors, point.x, point.y, point.z));
      }
      // first sample snaps; otherwise ease the body round (no one-frame 180° pop)
      r.mesh.rotation.y = fresh && first ? s.yaw : approachYaw(r.mesh.rotation.y, s.yaw, rdt);
      r.pitch = s.pitch ?? 0;
      // the root also carries the beam cone, lamp and name tag; only the skinned body is frustum-culled
      r.mesh.visible = !r.out && !r.offline && !tooClose(r.sm.x - this.camera.position.x, r.sm.z - this.camera.position.z);
      r.st.warden.root.visible = figureInView(fr, r.mesh.position);
      if (!r.st.named && this.names.has(id)) r.st.setName(this.names.get(id)!);
      const lit = !r.out && !r.offline && !!(r.f & F_LIGHT), dist = this.camera.position.distanceTo(r.mesh.position);
      const tripped = !!this.gym?.tripped(id);
      r.st.update(rdt, speed, !r.down && !tripped && !!(r.f & F_CROUCH), lit, s.pitch ?? 0, dist, r.down || tripped);
      if (r.marker) r.marker.position.y = MARKER_Y - 1.5 * r.st.fallen; // follows them down to just above the body
      if (lit) {
        r.st.beam(_beamO, _beamD);
        const hit = beamHit(this.collision, _beamO, _beamD, TEAM_REACH, this.beamHit);
        r.st.land(hit && hit.t <= BEAM_LEN ? hit : null);
        const t = hit?.t ?? TEAM_REACH, b = this.beams.get(id) ?? { o: new THREE.Vector3(), d: new THREE.Vector3(), t };
        this.beams.set(id, b);
        b.o.copy(_beamO); b.d.copy(_beamD); b.t = t;
        this.beamScores.set(id, beamScore(fr, eye, _beamO, _beamD, t, 0.06 + t * Math.tan(BEAM_HALF) * 1.15, occluded));
      }
    }
    if (this.mirrorView) {
      const players: L7PlayerPose[] = [...this.remotes].map(([id, r]) => ({ id,
        p: [r.mesh.position.x, r.mesh.position.y + (r.f & F_CROUCH ? .5 : 0), r.mesh.position.z],
        yaw: r.mesh.rotation.y, pitch: r.pitch, st: r.out ? ST_SPECTATE : r.down ? ST_DOWN : ST_OK }));
      this.mirrorView.update(players, this.mirrorState?.mirrors ?? [], this.myId, now / 1000);
    }
    for (const id of this.beams.keys()) if (!this.remotes.has(id)) this.beams.delete(id);
    this.teamPick.update(dt, this.beamScores);
    for (const [i, l] of this.teamLights.entries()) {
      const s = this.teamPick.slots[i], hb = s.holder !== undefined ? this.beams.get(s.holder) : undefined;
      let overlap = 0;
      if (hb) {
        l.position.copy(hb.o); l.target.position.copy(hb.o).add(hb.d);
        for (const other of this.teamPick.slots) if (other !== s && other.holder !== undefined && other.level > 0) {
          const ob = this.beams.get(other.holder);
          if (ob) overlap += teammatePoolOverlap(hb, ob) * other.level;
        }
      }
      l.intensity = hb ? TEAM_LIGHT * s.level * teammateLightGain(hb.t, overlap) : 0;
    }
  }

  private tickFinale(now: number) {
    if (!this.level?.def.finale) return;
    if (this.register) {
      const t = now / 1000;
      (this.register.ring.material as THREE.MeshBasicMaterial).opacity = 0.52 + 0.3 * (0.5 + 0.5 * Math.sin(t * 3.2));
      this.register.ring.rotation.z = t * 0.35;
      if (this.rollcallOpen && (!this.isRegisterNear() || this.finalState?.phase === 'chase' || this.finalState?.phase === 'complete')) this.closeRollcall();
    }
    if (this.goalBeacon) {
      const g = this.guide?.goal;
      const active = this.guidance !== false && this.arrowOn && this.finalState?.phase === 'chase' && !!g;
      this.goalBeacon.visible = active;
      if (active && g) {
        this.goalBeacon.position.set(g.x, g.y, g.z);
        this.goalBeacon.rotation.y = now / 1500;
      }
    }
  }
}
