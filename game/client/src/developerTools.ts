import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import { FLOOR_HEIGHT } from '../../shared/campus/campus_schema.ts';
import type { Game } from './game.ts';
import './developerTools.css';

type RoomMessage = Extract<ServerMsg, { t: 'room' }> & { developerMode?: boolean };
type DebugMessage = Extract<ClientMsg, { t: 'debug' }>;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]';

/** The server still authorizes every command; a room update only controls this local entry. */
export class DeveloperTools {
  private readonly game: Game;
  private readonly opener = document.createElement('button');
  private readonly dialog = document.createElement('dialog');
  private readonly closeButton = document.createElement('button');
  private readonly chapter = document.createElement('p');
  private readonly position = document.createElement('p');
  private readonly notice = document.createElement('p');
  private readonly levelButtons: HTMLButtonElement[] = [];
  private readonly teleport = document.createElement('form');
  private readonly x: HTMLInputElement;
  private readonly z: HTMLInputElement;
  private readonly floor: HTMLInputElement;
  private readonly skip: HTMLButtonElement;
  private readonly cleanups: (() => void)[] = [];
  private resumeInput?: () => void;
  private refresh?: ReturnType<typeof setInterval>;
  private returnFocus?: HTMLElement;
  private room?: RoomMessage;
  private authorized = false;
  private opened = false;
  private disposed = false;
  private hadPointerLock = false;

  constructor(game: Game) {
    this.game = game;
    this.opener.id = 'developer-tools-open';
    this.opener.type = 'button';
    this.opener.textContent = '开发者工具';
    this.opener.title = '开发者工具 · 本局不计排行';
    this.opener.hidden = true;
    this.opener.setAttribute('aria-haspopup', 'dialog');
    this.opener.setAttribute('aria-controls', 'developer-tools');
    this.opener.setAttribute('aria-expanded', 'false');

    this.dialog.id = 'developer-tools';
    this.dialog.tabIndex = -1;
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-labelledby', 'developer-tools-title');
    this.dialog.setAttribute('aria-describedby', 'developer-tools-description');
    const heading = document.createElement('header');
    heading.className = 'developer-tools-heading';
    const title = document.createElement('h2');
    title.id = 'developer-tools-title';
    title.textContent = '开发者工具 · 本局不计排行';
    this.closeButton.type = 'button';
    this.closeButton.id = 'developer-tools-close';
    this.closeButton.textContent = '返回游戏';
    heading.append(title, this.closeButton);
    const description = document.createElement('p');
    description.id = 'developer-tools-description';
    description.textContent = '此房间用于关卡测试；全局操作会影响同房间队友。';
    const status = document.createElement('div');
    status.className = 'developer-tools-status';
    this.chapter.id = 'developer-tools-chapter';
    this.position.id = 'developer-tools-position';
    status.append(this.chapter, this.position);
    const content = document.createElement('div');
    content.className = 'developer-tools-content';

    const levels = this.section('关卡跳转');
    levels.classList.add('developer-tools-levels');
    const levelGrid = document.createElement('div');
    levelGrid.className = 'developer-tools-level-grid';
    for (let level = 0; level < 8; level++) {
      const button = this.button(levelGrid, `第 ${level + 1} 关`, () => {
        this.send({ t: 'debug', op: 'level', level }, `跳转至第 ${level + 1} 关`);
      });
      button.dataset.level = String(level);
      this.levelButtons.push(button);
    }
    levels.append(levelGrid);
    this.note(levels, '点击当前关卡可以重新载入。');

    const safety = this.section('追捕测试');
    const safetyButtons = this.buttonGroup(safety);
    this.button(safetyButtons, '免抓 600 秒', () => this.send({ t: 'debug', op: 'safe', s: 600 }, '全队免抓 600 秒'));
    this.button(safetyButtons, '恢复危险', () => this.send({ t: 'debug', op: 'safe', s: 0 }, '恢复正常追捕'));
    const summonButtons = this.buttonGroup(safety);
    this.button(summonButtons, '召唤角色074', () => this.send({ t: 'debug', op: 'warden', d: 6 }, '在前方召唤角色074'));
    this.button(summonButtons, '召唤值周生', () => this.send({ t: 'debug', op: 'monitor', d: 8 }, '在前方召唤值周生'));
    this.button(this.buttonGroup(safety), '召唤值周代号025（测试）', () => this.send({ t: 'debug', op: 'boss' }, '将当前关一名值周生替换为值周代号025'));
    this.note(safety, '召唤值周代号025需要本关有值周生；没有时请先跳至第五关，再召唤。');

    const items = this.section('物品与电力');
    const itemButtons = this.buttonGroup(items);
    this.button(itemButtons, '获得楼梯钥匙', () => this.send({ t: 'debug', op: 'key', door: -1 }, '获得楼梯钥匙'));
    this.button(itemButtons, '补齐保险丝', () => this.send({ t: 'debug', op: 'key', door: -2 }, '补齐本关缺少的保险丝'));
    const powerButtons = this.buttonGroup(items);
    this.button(powerButtons, '跳闸 8 秒', () => this.send({ t: 'debug', op: 'power', s: 8 }, '触发跳闸'));
    this.button(powerButtons, '恢复电力', () => this.send({ t: 'debug', op: 'power', s: 0 }, '恢复电力'));

    const movement = this.section('坐标传送');
    movement.classList.add('developer-tools-movement');
    this.teleport.id = 'developer-tools-teleport';
    const coordinates = document.createElement('div');
    coordinates.className = 'developer-tools-coordinates';
    this.x = this.coordinate(coordinates, 'developer-tools-x', 'X', '0.01');
    this.z = this.coordinate(coordinates, 'developer-tools-z', 'Z', '0.01');
    this.floor = this.coordinate(coordinates, 'developer-tools-floor', '楼层', '1');
    this.floor.min = '-1'; this.floor.max = '8';
    this.floor.setAttribute('aria-describedby', 'developer-tools-floor-note');
    const movementButtons = this.buttonGroup(this.teleport);
    this.button(movementButtons, '读取当前位置', () => this.fillPosition());
    const teleportButton = document.createElement('button');
    teleportButton.type = 'submit';
    teleportButton.textContent = '传送到坐标';
    movementButtons.append(teleportButton);
    this.teleport.prepend(coordinates);
    movement.append(this.teleport);
    this.note(movement, '楼层：0 = 一楼，1 = 二楼，-1 = 地下。超出本关区域的位置无法传送。')
      .id = 'developer-tools-floor-note';

    const presentation = this.section('过场');
    this.skip = this.button(presentation, '跳过当前过场', () => {
      if (!this.authorized || !this.game.intro.active || this.game.intro.id <= 0) return;
      this.showResult(this.game.net.send({ t: 'intro-skip', id: this.game.intro.id }), '跳过当前过场');
    });
    this.skip.disabled = true;
    this.note(presentation, '只跳过自己的过场；其他队友仍可继续观看。');
    content.append(levels, safety, items, movement, presentation);
    this.notice.id = 'developer-tools-notice';
    this.notice.setAttribute('role', 'status');
    this.notice.setAttribute('aria-live', 'polite');
    this.notice.setAttribute('aria-atomic', 'true');
    const footer = document.createElement('p');
    footer.className = 'developer-tools-footer';
    footer.textContent = '打开面板时仅暂停自己的操作，房间仍在运行。';
    this.dialog.append(heading, description, status, content, this.notice, footer);
    document.body.append(this.opener, this.dialog);

    // Acquire the input lock before the gesture can release pointer lock or queue gameplay.
    this.listen(this.opener, 'pointerdown', (event) => {
      if ((event as PointerEvent).button === 0) this.prepareOpen();
    });
    this.listen(this.opener, 'pointercancel', () => { if (!this.opened) this.releaseInput(); });
    this.listen(this.opener, 'blur', () => { if (!this.opened) this.releaseInput(); });
    this.listen(this.opener, 'click', () => this.open());
    this.listen(this.opener, 'keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === 'Enter' || key === ' ') this.prepareOpen();
      if (key === 'Enter' || key === ' ' || key === 'Tab') event.stopPropagation();
    });
    this.listen(window, 'pointerup', (event) => {
      if (!this.opened && event.target !== this.opener) this.releaseInput();
    });
    this.listen(window, 'pointercancel', () => { if (!this.opened) this.releaseInput(); });
    this.listen(window, 'blur', () => { if (!this.opened) this.releaseInput(); });
    this.listen(this.closeButton, 'click', () => this.close(true));
    this.listen(this.teleport, 'submit', (event) => {
      event.preventDefault();
      if (!this.teleport.reportValidity()) return;
      const x = this.x.valueAsNumber, z = this.z.valueAsNumber, floor = this.floor.valueAsNumber;
      if (![x, z, floor].every(Number.isFinite) || !Number.isInteger(floor)) return;
      this.send({ t: 'debug', op: 'tp', x, z, floor }, '传送到指定坐标');
    });
    this.listen(this.dialog, 'keydown', (event) => this.onKeydown(event as KeyboardEvent));
    this.listen(this.dialog, 'cancel', (event) => { event.preventDefault(); this.close(); });
    this.listen(this.dialog, 'close', () => {
      if (this.opened && !this.dialog.open) this.finishClose(false);
    });
    this.listen(this.dialog, 'click', (event) => {
      if (event.target !== this.dialog) return;
      const e = event as MouseEvent, box = this.dialog.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) this.close(true);
    });
    this.listen(document, 'focusin', (event) => {
      if (this.opened && !this.dialog.contains(event.target as Node)) this.closeButton.focus({ preventScroll: true });
    });
    for (const target of [this.opener, this.dialog]) {
      for (const type of ['keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
        'touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'wheel']) {
        this.listen(target, type, (event) => event.stopPropagation());
      }
    }
  }

  update(room: RoomMessage, myId: number): void {
    if (this.disposed) return;
    const roomChanged = !!this.room && this.room.code !== room.code;
    this.room = room;
    this.authorized = room.developerMode === true && room.host === myId
      && room.players.some(player => player.id === myId && player.name === 'DEV-LOCAL#');
    this.opener.hidden = !this.authorized;
    if (!this.authorized || roomChanged) {
      this.close();
      this.releaseInput();
      this.notice.textContent = '';
    }
    this.renderStatus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.releaseInput();
    this.disposed = true;
    this.authorized = false;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.opener.remove();
    this.dialog.remove();
  }

  private prepareOpen(): void {
    if (!this.authorized || this.disposed || this.resumeInput) return;
    this.resumeInput = this.game.input.suspend();
    this.game.haptics.cancel();
  }

  private open(): void {
    if (!this.authorized || this.disposed || this.opened) return;
    this.prepareOpen();
    this.returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : this.opener;
    this.hadPointerLock = document.pointerLockElement === this.game.renderer.domElement;
    this.opened = true;
    this.opener.setAttribute('aria-expanded', 'true');
    document.body.classList.add('developer-tools-open');
    this.fillPosition();
    this.renderStatus();
    // Focus the modal while controls are suspended, before the browser reports an unlock.
    if (typeof this.dialog.showModal === 'function') this.dialog.showModal();
    else this.dialog.open = true;
    this.closeButton.focus({ preventScroll: true });
    try {
      if (document.pointerLockElement) document.exitPointerLock?.();
    } catch { /* The native modal remains usable when a browser refuses capture changes. */ }
    this.refresh = setInterval(() => this.renderStatus(), 250);
  }

  private close(relock = false): void {
    if (!this.opened) return;
    if (typeof this.dialog.close === 'function') this.dialog.close();
    else this.dialog.open = false;
    this.finishClose(relock);
  }

  private finishClose(relock: boolean): void {
    if (!this.opened) return;
    this.opened = false;
    clearInterval(this.refresh); this.refresh = undefined;
    this.opener.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('developer-tools-open');
    const focus = this.authorized && this.returnFocus?.isConnected ? this.returnFocus
      : this.authorized ? this.opener : this.game.renderer.domElement;
    this.returnFocus = undefined;
    focus.focus({ preventScroll: true });
    this.releaseInput();
    if (relock && this.hadPointerLock && this.game.canControl && !this.game.settings.isOpen) this.game.input.requestPointerLock();
    this.hadPointerLock = false;
  }

  private releaseInput(): void {
    this.resumeInput?.(); this.resumeInput = undefined;
  }

  private renderStatus(): void {
    const level = this.room?.level ?? 0;
    const name = this.game.level?.def.name;
    this.chapter.textContent = `当前：第 ${level + 1} 关${name ? ` · ${name}` : ''}`;
    const { x, y, z } = this.game.body;
    this.position.textContent = `X ${x.toFixed(2)} · Z ${z.toFixed(2)} · 楼层 ${Math.round(y / FLOOR_HEIGHT)}`;
    for (const [index, button] of this.levelButtons.entries()) {
      button.classList.toggle('current', index === level);
      button.setAttribute('aria-label', index === level ? `当前第 ${index + 1} 关，重新载入` : `前往第 ${index + 1} 关`);
    }
    this.skip.disabled = !this.game.intro.active || this.game.intro.skipped || this.game.intro.id <= 0;
  }

  private fillPosition(): void {
    const { x, y, z } = this.game.body;
    this.x.value = x.toFixed(2); this.z.value = z.toFixed(2);
    this.floor.value = String(Math.round(y / FLOOR_HEIGHT));
  }

  private send(message: DebugMessage, description: string): void {
    if (!this.authorized || this.disposed) return;
    this.showResult(this.game.net.send(message), description);
  }

  private showResult(sent: boolean, description: string): void {
    this.notice.textContent = sent ? `已请求：${description}。` : '连接尚未就绪，请稍后重试。';
  }

  private onKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(this.dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); this.dialog.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === this.dialog)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !this.dialog.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  }

  private listen(target: EventTarget, type: string, handle: (event: Event) => void): void {
    target.addEventListener(type, handle);
    this.cleanups.push(() => target.removeEventListener(type, handle));
  }

  private section(title: string): HTMLFieldSetElement {
    const section = document.createElement('fieldset'), legend = document.createElement('legend');
    legend.textContent = title; section.append(legend); return section;
  }

  private buttonGroup(parent: HTMLElement): HTMLDivElement {
    const group = document.createElement('div');
    group.className = 'developer-tools-buttons'; parent.append(group); return group;
  }

  private button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text;
    this.listen(button, 'click', action); parent.append(button); return button;
  }

  private note(parent: HTMLElement, text: string): HTMLParagraphElement {
    const note = document.createElement('p');
    note.className = 'developer-tools-note'; note.textContent = text; parent.append(note); return note;
  }

  private coordinate(parent: HTMLElement, id: string, title: string, step: string): HTMLInputElement {
    const label = document.createElement('label'); label.htmlFor = id; label.textContent = title;
    const input = document.createElement('input');
    input.id = id; input.type = 'number'; input.step = step; input.required = true;
    input.inputMode = 'decimal'; input.autocomplete = 'off';
    label.append(input); parent.append(label); return input;
  }
}
