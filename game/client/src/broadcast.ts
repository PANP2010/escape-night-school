import * as THREE from 'three';
import type { BroadcastSnap } from '../../shared/broadcast.ts';
import type { LevelDef } from '../../shared/levels/def.ts';
import { boxAt, type Cand } from '../../shared/interact.ts';
import type { Input } from './input.ts';
import type { Voice } from './voice.ts';
import type { Net } from './net.ts';
import type { HighlightTarget } from './interactionHighlight.ts';

const label = (text: string, w = 512, h = 192) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!; g.fillStyle = '#efe2b7'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#71372e'; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
  g.fillStyle = '#32271d'; g.font = `bold ${h / 4}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  text.split('\n').forEach((line, i, a) => g.fillText(line, w / 2, h * (i + 1) / (a.length + 1), w - 20));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide });
};

/** L4 owns its props, notebook, call warning and keypad. All progress comes from server messages. */
export class BroadcastView {
  state: BroadcastSnap = { t: 'broadcast', off: false, clues: [null, null, null, null], nextIn: 60, call: null };
  readonly root = new THREE.Group();
  private stickers: THREE.Mesh[] = [];
  private highlights: HighlightTarget[] = [];
  private lamp: THREE.Mesh;
  private screen: THREE.Mesh;
  private marker: THREE.Mesh;
  private panel = document.createElement('section');
  private dialog = document.createElement('form');
  private field = document.createElement('input');
  private status = document.createElement('p');
  private opened = false;
  private voice: Voice;
  readonly def: NonNullable<LevelDef['broadcast']>;
  private scene: THREE.Scene;
  private input: Input;
  private net: Net;
  constructor(def: NonNullable<LevelDef['broadcast']>, hides: LevelDef['hides'], scene: THREE.Scene, input: Input, net: Net, voice: Voice) {
    this.def = def; this.scene = scene; this.input = input; this.net = net; this.voice = voice;
    this.panel.id = 'broadcast-status'; this.panel.setAttribute('aria-live', 'polite'); document.getElementById('hud')?.append(this.panel);
    this.dialog.id = 'broadcast-keypad'; this.dialog.hidden = true; this.dialog.setAttribute('aria-label', '广播室控制键盘');
    this.dialog.setAttribute('role', 'dialog'); this.dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('h2'); title.textContent = '午夜广播 · 停播控制';
    const hint = document.createElement('p'); hint.textContent = '按贴纸 ①②③④ 的顺序输入四位密码';
    this.field.name = 'code'; this.field.setAttribute('aria-label', '四位停播密码'); this.field.inputMode = 'numeric'; this.field.maxLength = 4; this.field.pattern = '[0-9]{4}'; this.field.autocomplete = 'off';
    const keys = document.createElement('div'); keys.className = 'broadcast-digits';
    for (const digit of '1234567890') { const b = document.createElement('button'); b.type = 'button'; b.textContent = digit; b.onclick = () => { if (this.field.value.length < 4) this.field.value += digit; }; keys.append(b); }
    const erase = document.createElement('button'); erase.type = 'button'; erase.textContent = '退格'; erase.onclick = () => { this.field.value = this.field.value.slice(0, -1); };
    const send = document.createElement('button'); send.type = 'submit'; send.textContent = '确认停播';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '返回 / Esc'; close.onclick = () => this.close();
    this.dialog.append(title, hint, this.field, keys, erase, send, close, this.status);
    this.dialog.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') this.close(); });
    this.dialog.onsubmit = e => { e.preventDefault(); if (/^\d{4}$/.test(this.field.value)) { this.net.send({ t: 'broadcast', op: 'code', code: this.field.value }); this.status.textContent = '正在核对……'; } };
    document.body.append(this.dialog);
    for (const [i, s] of def.stickers.entries()) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.65, 0.32), label(`贴纸 ${i + 1}/4\nE 揭开数字`));
      m.position.set(s.x, s.y + 1.45, s.z); m.rotation.y = s.face === 'z+' ? 0 : Math.PI; this.root.add(m); this.stickers.push(m);
      this.highlights.push({ key: `sticker:${i}`, position: [s.x, s.y + 1.45, s.z], floorY: s.y,
        sources: [{ object: m }], enabled: () => !this.state.off && this.state.clues[i] === null });
    }
    const at = def.console;
    const console = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.8, 0.35), new THREE.MeshLambertMaterial({ color: 0x434c49 }));
    console.position.set(at.x, at.y + 1.1, at.z); this.root.add(console);
    const screen = this.screen = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.34), label('午夜广播\nE 输入停播密码'));
    screen.position.set(at.x, at.y + 1.25, at.z - 0.18); screen.rotation.y = Math.PI; this.root.add(screen);
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff392e })); this.lamp.position.set(at.x + 0.22, at.y + 1.6, at.z - 0.2); this.root.add(this.lamp);
    this.highlights.push({ key: 'keypad:0', position: [at.x, at.y + 1.1, at.z], floorY: at.y,
      sources: [{ object: console }, { object: screen }], enabled: () => !this.state.off });
    for (const [hideId, h] of hides.entries()) {
      const firstPart = this.root.children.length;
      const y = h.y ?? 0, booth = h.kind === 'booth';
      const shell = new THREE.Mesh(new THREE.BoxGeometry(booth ? 1.2 : 0.65, 1.9, 0.22), new THREE.MeshLambertMaterial({ color: booth ? 0x666d68 : 0x425b52 }));
      shell.position.set(h.x, y + 0.95, h.z + 0.32); this.root.add(shell);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.28), label(booth ? '屏蔽隔间\nE 躲藏' : '屏蔽柜\nE 躲藏'));
      sign.position.set(h.x, y + (booth ? 1.5 : 1.0), h.z + (booth ? 0.2 : -0.32)); sign.rotation.y = Math.PI; this.root.add(sign);
      for (const x of (booth ? [-0.6, 0.6] : [-0.325, 0.325])) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(booth ? .08 : .04, 1.9, booth ? .9 : .6), shell.material);
        side.position.set(h.x + x, y + .95, h.z); this.root.add(side);
      }
      if (!booth) {
        // A real cabinet door, with a narrow eye-level slit matching the hiding overlay.
        for (const [cy, height] of [[.625, 1.25], [1.725, .35]]) {
          const door = new THREE.Mesh(new THREE.BoxGeometry(.65, height, .035), shell.material);
          door.position.set(h.x, y + cy, h.z - .3); this.root.add(door);
        }
        const handle = new THREE.Mesh(new THREE.BoxGeometry(.035, .18, .05), new THREE.MeshLambertMaterial({ color: 0xb8b39a }));
        handle.position.set(h.x + .23, y + .9, h.z - .34); this.root.add(handle);
      }
      this.highlights.push({ key: `hide:${hideId}`, position: [h.x, y + 0.95, h.z], floorY: y,
        sources: this.root.children.slice(firstPart).map(object => ({ object })) });
    }
    this.marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), new THREE.MeshBasicMaterial({ color: 0xff553b, depthTest: false })); this.marker.renderOrder = 1000; this.marker.visible = false; this.root.add(this.marker);
    scene.add(this.root); this.receive(this.state, new Map());
  }
  candidates(): Cand[] {
    if (this.state.off) return [];
    return [ ...this.def.stickers.flatMap((s, id): Cand[] => this.state.clues[id] === null ? [{ kind: 'sticker', id, ...boxAt([s.x, s.y, s.z], 0.35, 1.8) }] : []),
      { kind: 'keypad', id: 0, ...boxAt([this.def.console.x, this.def.console.y, this.def.console.z], 0.35, 1.8) } ];
  }
  highlightTargets(): readonly HighlightTarget[] { return this.highlights; }
  open() {
    if (this.state.off) return;
    this.opened = true; this.input.enabled = false; this.input.keys.clear(); document.exitPointerLock?.();
    this.dialog.hidden = false; this.field.value = ''; this.status.textContent = this.notebook(); this.field.focus();
  }
  close() { if (!this.opened) return; this.opened = false; this.dialog.hidden = true; this.input.enabled = true; this.field.blur(); }
  private notebook() { return this.state.clues.map((c, i) => `${i + 1}：${c ?? '□'}`).join('　'); }
  error(text: string) { if (this.opened) this.status.textContent = text; }
  pauseFeedback() { this.close(); this.voice.silence(); }
  receive(state: BroadcastSnap, names: Map<number, string>, announce = true) {
    const was = this.state.call;
    this.state = state;
    const call = state.call;
    if (announce && call && (!was || was.id !== call.id)) this.voice.say(`午夜点名，${names.get(call.id) ?? '无名'}同学。${call.shielded ? '广播信号已被屏蔽。' : '你的位置正在广播。'}`, 0);
    else if (announce && call?.shielded && was && !was.shielded) this.voice.say('广播信号已屏蔽。保持躲藏。', 0);
    this.panel.textContent = `${state.off ? '广播已关闭 · 返回三楼东侧楼梯口' : `午夜广播 · 下次点名 ${state.nextIn} 秒`}\n贴纸 ${this.notebook()}\n${call ? `正在点名：${names.get(call.id) ?? '同学'} · ${call.left} 秒 · ${call.shielded ? '已屏蔽' : '位置暴露！快躲进屏蔽柜 / 隔间'}` : state.off ? '点名已停止，全体存活者到出口集合' : '每 60–90 秒点名；进入屏蔽柜 / 隔间可隐藏位置'}`;
    this.panel.classList.toggle('calling', !!call && !call.shielded);
    for (const [i, m] of this.stickers.entries()) { const next = state.clues[i]; if (m.userData.digit !== next) { (m.material as THREE.MeshBasicMaterial).map?.dispose(); (m.material as THREE.Material).dispose(); m.material = label(`贴纸 ${i + 1}/4\n${next ?? 'E 揭开数字'}`); m.userData.digit = next; } }
    if (state.off && !this.screen.userData.off) {
      (this.screen.material as THREE.MeshBasicMaterial).map?.dispose(); (this.screen.material as THREE.Material).dispose();
      this.screen.material = label('广播已关闭\n请到三楼集合'); this.screen.userData.off = true;
    } else if (!state.off && this.screen.userData.off) {
      (this.screen.material as THREE.MeshBasicMaterial).map?.dispose(); (this.screen.material as THREE.Material).dispose();
      this.screen.material = label('午夜广播\nE 输入停播密码'); this.screen.userData.off = false;
    }
    (this.lamp.material as THREE.MeshBasicMaterial).color.set(state.off ? 0x40ee8b : 0xff392e);
    this.marker.visible = !!call?.p;
    if (call?.p) this.marker.position.set(call.p[0], call.p[1] + 2.3, call.p[2]);
    if (state.off) this.close();
  }
  dispose() {
    // Game owns the shared Voice and cancels it before level changes.
    this.close(); this.panel.remove(); this.dialog.remove(); this.scene.remove(this.root);
    this.root.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { if ('map' in m) (m as THREE.MeshBasicMaterial).map?.dispose(); m.dispose(); } } });
  }
}
