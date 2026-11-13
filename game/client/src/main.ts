// Entry: lobby (name, create/join) → in-level Game. Exposes window.__escape for e2e tests.
import { TouchControls, isTouchDevice } from './touch.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { Game } from './game.ts';
import * as THREE from 'three';
import { spawnRoute } from './campus/world/navgraph.ts';
import { stairRoute } from './campus/world/interior.ts';
import { CAMPUS } from './campus/world/campus.ts';
import { CampusScene, discardPreparedCampus, shotViews, type PreparedCampus } from './campus/scene.ts';
import { Net } from './net.ts';
import { CHAT_LINE_S, ChatPanel, watchChatViewport, watchHintOverlap } from './hudLayout.ts';
import { installUpdateNotice } from './updateNotice.ts';
import { LevelTransitions } from './transitions.ts';
import { clearResume, HostStatus, reloadWhenOnline, saveReconnectNotice, takeReconnectNotice } from './reconnect.ts';
import './reconnect.css';
import { CampusLoading } from './loading.ts';
import { PublicLobby } from './lobby.ts';
import { TeamFeedback } from './teamFeedback.ts';
import { Sound } from './sound.ts';
import { difficultyMode } from '../../shared/difficultyModes.ts';
import { ProgressionStore } from './progression.ts';
import { ProgressionView } from './progressionView.ts';
import { LobbyDifficulty } from './lobbyDifficulty.ts';
import { LeaderboardView } from './leaderboardView.ts';
import { FeedbackBox } from './feedback.ts';
import { roomModeLabel } from '../../shared/runMode.ts';
import { DeveloperTools } from './developerTools.ts';
import { nativePlatform } from './nativeClient.ts';

if (new URLSearchParams(location.search).has('warden')) void import('./warden/showcase.ts').then((m) => m.showcase());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
if (nativePlatform(location.origin, (window as Window & { nightSchoolNative?: unknown }).nightSchoolNative)) $('native-downloads')?.remove();
const nameEl = $<HTMLInputElement>('name');
const chatIn = $<HTMLInputElement>('chat-input');
const chatLog = $('chat-log');
const syncHint = watchHintOverlap($('hint'), [chatLog, chatIn]);
const updateNotice = installUpdateNotice($('lobby'));
const transitions = new LevelTransitions($('fade-overlay'));
const reconnectStatus = document.createElement('section');
reconnectStatus.id = 'reconnect-status'; reconnectStatus.hidden = true;
reconnectStatus.setAttribute('role', 'status'); reconnectStatus.setAttribute('aria-live', 'polite');
const reconnectTitle = document.createElement('strong'), reconnectDetail = document.createElement('p');
reconnectStatus.append(reconnectTitle, reconnectDetail); document.body.append(reconnectStatus);
const hostStatus = document.createElement('div'); hostStatus.id = 'host-status'; hostStatus.hidden = true; $('hud').append(hostStatus);
const hostChange = document.createElement('div'); hostChange.id = 'host-change'; hostChange.hidden = true;
hostChange.setAttribute('role', 'status'); hostChange.setAttribute('aria-live', 'polite'); document.body.append(hostChange);
const hosts = new HostStatus();
let hostChangeTimer: ReturnType<typeof setTimeout> | undefined;
const loading = new CampusLoading();
const teamFeedback = new TeamFeedback();
try { nameEl.value = localStorage.getItem('escape.name') ?? ''; } catch { nameEl.value = ''; }
$('err').textContent = takeReconnectNotice();

const net = new Net();
const progression = new ProgressionStore();
const progressionView = new ProgressionView(progression);
const lobbyDifficulty = new LobbyDifficulty(progression);
const leaderboardView = new LeaderboardView();
// Native bundles may ship their own older lobby HTML; a missing dialog must not stop the game from booting.
try { new FeedbackBox(); } catch (error) { console.error('意见箱初始化失败', error); }
const publicLobby = new PublicLobby((m) => net.send(m), hello, () => lobbyDifficulty.selected, () => lobbyDifficulty.namedMonitors);
const achievementToast = document.createElement('div'); achievementToast.id = 'achievement-toast'; achievementToast.hidden = true;
achievementToast.setAttribute('role', 'status'); achievementToast.setAttribute('aria-live', 'polite'); document.body.append(achievementToast);
let knownAchievements = new Set(progression.achievements);
let achievementTimer: ReturnType<typeof setTimeout> | undefined;
progression.subscribe(() => {
  const fresh = progression.achievements.filter(id => !knownAchievements.has(id));
  knownAchievements = new Set(progression.achievements);
  if (!fresh.length) return;
  achievementToast.textContent = `成就 · ${progression.info(fresh[fresh.length - 1]).title}`;
  achievementToast.hidden = false; clearTimeout(achievementTimer);
  achievementTimer = setTimeout(() => { achievementToast.hidden = true; }, 3600);
});
// Lobby gestures unlock the same audio instance used by the opening, before its server response arrives.
const sessionSound = new Sound();
let myId = 0;
let game: Game | null = null;
let developerTools: DeveloperTools | undefined;
let resumedWelcome = false;
let touchControls: TouchControls | undefined;
const names = new Map<number, string>();
let forceRoomReload = false;
type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
let pending: { room: RoomMsg; controller: AbortController; messages: ServerMsg[] } | undefined;
let replaying = false;

function finishStartup() {
  if (!game || game.worldReady || !game.snaps || replaying) return;
  loading.firstFrame();
  if (!game.presentWorld()) return;
  loading.finish();
  game.start();
  if (!game.intro.active) transitions.spawned();
}

/** Keep every delta in wire order. A spawn correction precedes its room message on the wire. */
function prepareGame(room: RoomMsg) {
  const carry = pending?.room.code === room.code
    ? pending.messages.filter(message => message.t === 'correct') : [];
  pending?.controller.abort();
  const job = pending = { room, controller: new AbortController(), messages: carry };
  loading.begin();
  void CampusScene.prepare({ signal: job.controller.signal, onProgress: stage => {
    if (pending === job) loading.update(stage);
  } }).then(prepared => {
    if (pending !== job || job.controller.signal.aborted) { discardPreparedCampus(prepared.scene); return; }
    enterRoom(job.room, prepared);
    replaying = true;
    try { for (const message of job.messages) receive(message); }
    finally { replaying = false; }
    pending = undefined;
    finishStartup();
  }).catch(error => {
    if (pending !== job || job.controller.signal.aborted) return;
    pending = undefined;
    loading.fail();
    $('err').textContent = '校园暂时未能准备好，请刷新重试';
    console.error('Campus preparation failed', error);
  });
}
const chatViewport = watchChatViewport(document.documentElement, syncHint);
function chatModalOpen() {
  return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].some((modal) => {
    if (modal.tagName === 'DIALOG') return (modal as HTMLDialogElement).open;
    return !modal.hidden && modal.getClientRects().length > 0 && getComputedStyle(modal).visibility !== 'hidden';
  });
}
const chat = new ChatPanel(chatIn, chatLog, {
  session: () => game,
  blocked: () => !net.connected || !!game && (game.intro.active || game.settings.isOpen || game.networkPaused || !!game.completion || game.escaped || game.story.isOpen) || document.body.classList.contains('level-handoff') || chatModalOpen(),
  send: text => net.send({ t: 'chat', text }),
  changed: chatViewport.sync,
});

interface RenderStats { calls: number; triangles: number }
declare global { interface Window { __escape: { net: Net; game: () => Game | null; code: string; THREE: typeof THREE; stats: () => RenderStats; views: typeof shotViews; autopilot: (route?: [number, number][]) => void; spawnRoute: typeof spawnRoute; stairRoute: (to?: number) => [number, number][]; debug: (op: 'tp' | 'warden' | 'monitor' | 'down' | 'safe' | 'key' | 'power' | 'level5' | 'level', ...a: number[]) => void } } }
window.__escape = {
  net, game: () => game, code: '', THREE, views: shotViews,
  autopilot: (route = spawnRoute()) => game?.autopilot(route), spawnRoute,
  /** 教学楼A: from outside its entrance up the first stairwell to the 楼层平台 of level `to` */
  stairRoute: (to = 2) => stairRoute(CAMPUS.buildings.find(b => b.id === 'A')!, to),
  /** Dev only (the server ignores it in production): tp(x, z, floor? = own floor) · warden(d?) · down(holdS?) · safe(s?, mob? = 1: only 角色074, 2: only the 值日生) · key(door?) · power(offS?) (跳闸 at you). */
  debug: (op, ...a) => {
    if (op === 'level5') net.send({ t: 'debug', op });
    else if (op === 'tp') net.send({ t: 'debug', op, x: a[0], z: a[1], floor: a[2] });
    else if (op === 'warden') net.send({ t: 'debug', op, d: a[0] });
    else if (op === 'monitor') net.send({ t: 'debug', op, d: a[0] });
    else if (op === 'key') net.send({ t: 'debug', op, door: a[0] });
    else if (op === 'level') net.send({ t: 'debug', op, level: a[0] ?? 7 });
    else if (op === 'power') net.send(a[0] === undefined ? { t: 'debug', op } : { t: 'debug', op, s: a[0] });
    else if (op === 'safe') net.send({ t: 'debug', op, ...(a[0] === undefined ? {} : { s: a[0] }), ...(a[1] === 1 || a[1] === 2 ? { mob: a[1] as 1 | 2 } : {}) });
    else net.send(a[0] === undefined ? { t: 'debug', op: 'down' } : { t: 'debug', op: 'down', s: a[0] });
  },
  stats: () => { const r = game?.renderer.info.render; return { calls: r?.calls ?? 0, triangles: r?.triangles ?? 0 }; },
};

/** On 进入 (a user gesture): go fullscreen and lock landscape on touch devices; unsupported or refused is fine. */
function enterFullscreen() {
  if (!isTouchDevice()) return;
  void document.documentElement.requestFullscreen?.().then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')).catch(() => {});
}

addEventListener('contextmenu', (e) => {
  if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
  if (isTouchDevice()) e.preventDefault();
}); // keep native text editing while suppressing the game's long-press menu

function hello() {
  sessionSound.unlock();
  enterFullscreen();
  const name = nameEl.value.trim() || '无名';
  try { localStorage.setItem('escape.name', name); } catch { /* Playing also works with storage disabled. */ }
  if (!net.send({ t: 'hello', name })) { $('err').textContent = '正在恢复连接，请稍候……'; return false; }
  return true;
}

function addChat(text: string) {
  const line = document.createElement('div');
  line.textContent = text;
  chatLog.appendChild(line);
  while (chatLog.childElementCount > 8) chatLog.firstElementChild!.remove();
  chat.scrollToLatest();
  setTimeout(() => { line.classList.add('old'); syncHint(); }, CHAT_LINE_S * 1000);
  syncHint();
}

$('start').onclick = () => { sessionSound.unlock(); net.send({ t: 'start' }); };
$('copy-code').onclick = () => { void navigator.clipboard?.writeText(window.__escape.code).catch(() => {}); $('copy-code').textContent = '已复制'; };
const waitingReturn = document.createElement('button'); waitingReturn.id = 'waiting-return';
waitingReturn.type = 'button'; waitingReturn.textContent = '返回大厅';
waitingReturn.addEventListener('click', () => { clearResume(); net.close(); location.reload(); });
$('waiting').insertBefore(waitingReturn, $('start'));

/** Waiting lobby: swap the create/join form for the member list; only the host sees an enabled 开始. */
function showWaiting(m: Extract<ServerMsg, { t: 'room' }>) {
  $('entry').hidden = true;
  $('waiting').hidden = false;
  $('wait-code').textContent = m.code;
  const ul = $('wait-members');
  ul.replaceChildren(...m.players.map((p) => {
    const li = document.createElement('li');
    li.dataset.online = String(p.online !== false);
    li.textContent = p.name + (p.id === m.host ? '（房主）' : '') + (p.id === myId ? ' · 你' : '') + (p.online === false ? ' · 断线中' : '');
    return li;
  }));
  const host = m.host === myId;
  $<HTMLButtonElement>('start').hidden = !host;
  const difficulty = m.mode === 'royale' ? '大逃杀' : difficultyMode(m.difficulty).name;
  $('wait-hint').textContent = `${difficulty} · ${roomModeLabel(m.guidance, m.developerMode)}${m.namedMonitors ? ' · 人名彩蛋开启' : ''} · ${host ? `${m.players.length} 人在房间，准备好就点开始` : '等待房主开始……'}`;
}

function toggleChat() {
  if (!game || game.intro.active || game.settings.isOpen || !net.connected || game.completion || document.getElementById('rollcall-panel')?.hidden === false) return;
  if (chat.open) chat.close(false);
  else chat.show();
}
addEventListener('keydown', (e) => {
  if (!game || e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat) return;
  if (game && chatIn.hidden && !(e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"]'))) {
    if (e.code === 'KeyJ' && !e.repeat) { game.input.clear(); game.story.toggle(); e.preventDefault(); return; }
    if (e.code === 'Escape' && game.story.isOpen) { game.story.toggle(false); e.preventDefault(); return; }
  }
  if (game.story.isOpen) return;
  if (chat.open && e.key === 'Escape') {
    chat.close(false); e.preventDefault(); e.stopImmediatePropagation(); return;
  }
  if (e.key !== 'Enter' || chat.open) return;
  // Native controls keep their own Enter action (including the touch buttons and the waiting lobby).
  if (e.target instanceof Element && e.target.closest('input, textarea, select, button, summary, a[href], [contenteditable]:not([contenteditable="false"])')) return;
  chat.show();
  e.preventDefault();
});

/** Native panels keep their own Escape and Tab behavior. */
function nativeControlFocused() {
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.isContentEditable ||
    !!active.closest('input, textarea, select, #game-settings, #broadcast-keypad, #developer-tools'));
}

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.repeat || !game?.canControl || game.settings.isOpen || nativeControlFocused()) return;
  e.preventDefault();
  game.settings.open();
});

// Some browsers reserve Escape for unlocking and never dispatch its keydown to the page.
let pointerWasLocked = false;
addEventListener('pointerlockchange', () => {
  const locked = !!game && document.pointerLockElement === game.renderer.domElement;
  const unlocked = pointerWasLocked && !locked;
  pointerWasLocked = locked;
  const settingsUnlock = game?.consumeSettingsUnlock();
  if (!unlocked || settingsUnlock || !game?.canControl || game.settings.isOpen || nativeControlFocused() ||
    document.visibilityState === 'hidden' || !document.hasFocus()) return;
  game.settings.open(undefined, 150);
});

function enterRoom(m: RoomMsg, prepared?: PreparedCampus) {
      $('err').textContent = '';
      names.clear();
      teamFeedback.enterRoom(m.code);
      for (const p of m.players) names.set(p.id, p.name);
      window.__escape.code = m.code;
      progression.setRoom(m.code, m.difficulty, m.started, m.players.some(player => player.id === myId), m.developerMode === true, m.namedMonitors === true);
      {
        const status = hosts.update(m.code, m.host, m.players, myId);
        hostStatus.textContent = status.current; hostStatus.hidden = !m.started;
        if (status.change) {
          hostChange.textContent = status.change; hostChange.hidden = false;
          clearTimeout(hostChangeTimer);
          hostChangeTimer = setTimeout(() => { hostChange.hidden = true; }, 6000);
        }
      }
      if (!m.started) { resumedWelcome = false; game?.setNamedMonitors(m.namedMonitors === true); game?.story.receive(m); showWaiting(m); return; }
      const onlineCount = m.players.filter(p => p.online !== false).length;
      const offlineCount = m.players.length - onlineCount;
      $('room-code').textContent = `房间 ${m.code} · ${difficultyMode(m.difficulty).name} · ${roomModeLabel(m.guidance, m.developerMode)} · ${onlineCount} 人 · 第 ${m.level + 1} 关${offlineCount ? ` · ${offlineCount} 人重连中` : ''}`;
      if (!game) {
        updateNotice.setSession('playing');
        $('lobby').hidden = true;
        $('hud').hidden = false;
        if (isTouchDevice()) document.body.classList.add('touch'); // before Game: it picks DPR / fog from it
        game = new Game(net, myId, document.body, prepared, sessionSound);
        developerTools = new DeveloperTools(game);
        if (isTouchDevice()) { game.input.pointerLock = false; $('hint').textContent = '左侧拖动移动 · 右侧拖动转视角 · 直接点门和物品 · 右下手电 / 蹲 / 跑 · 右上地图'; setTimeout(() => $('hint').classList.add('off'), 10_000); const tc = touchControls = new TouchControls(game.input);
          const cb = document.createElement('div');
          cb.className = 'touch-btn'; cb.id = 'touch-chat'; cb.textContent = '聊天';
          cb.addEventListener('touchstart', (e) => { e.preventDefault(); toggleChat(); }, { passive: false });
          tc.root.appendChild(cb);
          const mb = document.createElement('div');
          mb.className = 'touch-btn'; mb.id = 'touch-map'; mb.textContent = '地图';
          mb.addEventListener('touchstart', (e) => { e.preventDefault(); game?.toggleMap(); }, { passive: false });
          tc.root.appendChild(mb);
        }
        game.names = names;
        game.story.onDiscovered = id => progression.storyRead(id);
        game.setNetworkPaused(!net.connected);
      }
      game.setNamedMonitors(m.namedMonitors === true);
      game.story.receive(m);
      game.hostId = m.host;
      game.setGuidance(m.guidance !== false);
      developerTools?.update(m, myId);
      if (forceRoomReload || !game.completion) updateNotice.setSession('playing');
      const loaded = game.loadLevel(m.level, m.seed, forceRoomReload, resumedWelcome && !game.level, m.incarnation);
      forceRoomReload = false; resumedWelcome = false;
      if (!net.connected) game.setNetworkPaused(true);
      if (loaded) transitions.arrive(m.level, game.level.name);
}

function receive(m: ServerMsg) {
  if (publicLobby.onMessage(m)) return;
  if (pending && !replaying) {
    if (m.t === 'fade') {
      // Presentation follows the live handoff clock. Replaying an old fade after construction would freeze
      // the newly ready chapter for three more seconds and announce arrival before its transition began.
      transitions.begin(m.secs, pending.room.level, '夜校', m.restart);
    } else if (m.t === 'room') {
      const old = pending.room;
      if (m.code !== old.code || m.level !== old.level || m.seed !== old.seed) prepareGame(m);
      else pending.room = m; // membership/host updates do not restart the same campus
    } else pending.messages.push(m);
    return;
  }
  switch (m.t) {
    case 'welcome': myId = m.id; resumedWelcome = !!m.resumed; teamFeedback.reset(); break;
    case 'error': $('err').textContent = m.msg; game?.onMsg(m); break;
    case 'room':
      if (m.started && !game) prepareGame(m);
      else enterRoom(m);
      break;
    case 'fade': {
      forceRoomReload = m.restart;
      if (m.restart) updateNotice.setSession('playing');
      chat.close(false);
      game?.onMsg(m);
      transitions.begin(m.secs, game?.level.index ?? 0, game?.level.name ?? '夜校', m.restart);
      break;
    }
    case 'completed': {
      chat.close(false);
      updateNotice.setSession('complete');
      game?.onMsg(m);
      progression.completed(m.members, myId, m.namedMonitorsUnlocked === true, m.ranking);
      if (m.members.some(member => member.id === myId && member.escaped)) {
        const result = document.getElementById('finale-result');
        document.getElementById('completion-records')?.remove();
        const records = document.createElement('div'); records.id = 'completion-records';
        const text = document.createElement('p');
        const current = progression.unlocked[progression.unlocked.length - 1];
        text.textContent = `成就 ${progression.achievements.length} 项 · 已解锁至「${difficultyMode(current).name}」`;
        const achievements = document.createElement('button'); achievements.type = 'button'; achievements.textContent = '查看成就'; achievements.onclick = () => progressionView.open();
        const rankings = document.createElement('button'); rankings.type = 'button'; rankings.textContent = '查看速通榜'; rankings.onclick = () => leaderboardView.open(progression.currentDifficulty);
        records.append(text, achievements, rankings); result?.append(records);
      }
      break;
    }
    case 'complete': {
      updateNotice.setSession('complete');
      game?.onMsg(m);
      chat.close(false);
      transitions.complete(game?.level.def.exam
        ? '试卷已通过 · 考场通关！\n所有存活队员已在五楼出口集合\n后续楼层尚未开放，刷新可重新挑战。'
        : '本章通关！\n当前已开放的关卡已完成\n后续楼层尚未开放，刷新可重新挑战。');
      const copy = document.createElement('div'); copy.id = 'result-copy'; copy.textContent = $('fade-overlay').textContent;
      copy.tabIndex = 0;
      $('fade-overlay').replaceChildren(copy);
      copy.focus({ preventScroll: true });
      document.exitPointerLock();
      break;
    }
    case 'blink': { // 眨眼: every screen goes black for a moment (the 值日生 moves while nobody sees it)
      game?.mobs.blink(performance.now(), m.secs);
      const el = $('blink-overlay');
      el.hidden = false;
      setTimeout(() => { el.hidden = true; }, m.secs * 1000);
      break;
    }
    case 'chat': addChat(`${names.get(m.from) ?? '?'}：${m.text}`); break;
    case 'ping': addChat(`${names.get(m.from) ?? '?'} 标记了一个位置`); game?.onMsg(m); break;
    case 'caught': game?.onMsg(m); break;
    case 'team-caught': {
      const text = teamFeedback.notice(m, myId, names);
      if (text) addChat(text);
      break;
    }
    case 'event':
      if (m.kind === 'clear') { progression.chapterCleared(m.level); transitions.cleared(m.level, m.elapsed); }
      else {
        game?.onMsg(m);
        if (m.kind === 'intro' && !m.ended && game?.intro.id === m.id) transitions.arrive(m.level, game.level.name);
        if (m.kind === 'intro' && m.ended && game?.presentationReady && !game.intro.active) transitions.spawned();
      }
      break;
    default:
      if (m.t === 'snap') {
        const own = m.players.find(player => player.id === myId);
        if (own) progression.observeSnap(own.st ?? 0);
      }
      if (m.t === 'activity') progression.activity(m.from, m.kind, myId);
      game?.onMsg(m);
      finishStartup();
      if (m.t === 'snap' && game?.presentationReady && !game.intro.active) transitions.spawned();
  }
  if (m.t !== 'room') game?.story.receive(m); // door collision changes are applied before the snapshot's note LOS
}
net.onMsg = receive;
function showConnection(state: typeof net.state) {
  const paused = state !== 'online';
  if (state === 'reconnecting') publicLobby.disconnect();
  game?.setNetworkPaused(paused);
  reconnectStatus.dataset.state = state;
  reconnectStatus.hidden = state === 'online' || (state === 'connecting' && !game);
  reconnectTitle.textContent = state === 'syncing' ? '连接已恢复' : '连接中断，正在重连';
  reconnectDetail.textContent = state === 'syncing' ? '正在同步房间和当前位置……' : '请稍候，20 秒内恢复原房间；操作已暂停。';
  if (paused) {
    chat.close(false);
    chatIn.hidden = true; chatIn.value = ''; chatIn.blur();
    document.exitPointerLock?.();
  }
}
net.onState = showConnection;
net.onResumeFailed = (message) => {
  if (game) {
    saveReconnectNotice(message);
    net.close(); game.setNetworkPaused(true);
    reconnectStatus.hidden = false; reconnectStatus.dataset.state = 'expired';
    reconnectTitle.textContent = '连接已过期';
    reconnectDetail.textContent = '网络恢复后将返回大厅，请重新创建或加入房间。';
    // Reloading while the browser is offline destroys this page and its online listener.
    reloadWhenOnline(() => location.reload());
    return;
  }
  $('entry').hidden = false; $('waiting').hidden = true;
  hostStatus.hidden = true; hostChange.hidden = true;
  window.__escape.code = ''; names.clear();
  $('err').textContent = message;
};
showConnection(net.state);
addEventListener('beforeunload', () => { pending?.controller.abort(); publicLobby.dispose(); developerTools?.dispose(); lobbyDifficulty.dispose(); progressionView.dispose(); leaderboardView.dispose(); clearTimeout(achievementTimer); net.close(); chat.dispose(); chatViewport.dispose(); touchControls?.dispose(); touchControls = undefined; game?.disposeFeedback(); sessionSound.dispose(); transitions.dispose(); });
