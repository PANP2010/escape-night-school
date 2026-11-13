import { ACHIEVEMENTS, type ProgressionDifficulty, type ProgressionStore } from './progression.ts';

/** A small lobby record. Secrets remain undiscovered until their physical action is confirmed. */
export class ProgressionView {
  private readonly button: HTMLButtonElement;
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLUListElement;
  private readonly status: HTMLElement;
  private readonly unsubscribe: () => void;
  private readonly store: ProgressionStore;

  constructor(store: ProgressionStore) {
    this.store = store;
    this.button = document.createElement('button');
    this.button.id = 'progression-open'; this.button.type = 'button'; this.button.textContent = '成就';
    this.button.setAttribute('aria-haspopup', 'dialog'); this.button.setAttribute('aria-controls', 'progression-dialog');
    this.dialog = document.createElement('dialog'); this.dialog.id = 'progression-dialog';
    this.dialog.setAttribute('aria-labelledby', 'progression-title');
    const header = document.createElement('header');
    const title = document.createElement('h2'); title.id = 'progression-title'; title.textContent = '夜校记录';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '返回'; close.onclick = () => this.dialog.close();
    header.append(title, close);
    this.status = document.createElement('p'); this.status.className = 'progression-status';
    this.list = document.createElement('ul'); this.list.className = 'progression-list';
    this.dialog.append(header, this.status, this.list);
    (document.getElementById('lobby-records') ?? document.body).append(this.button);
    document.body.append(this.dialog);
    this.button.onclick = () => { this.render(); this.dialog.showModal(); };
    this.unsubscribe = store.subscribe(() => { if (this.dialog.open) this.render(); });
    this.render();
  }

  render(): void {
    const unlocked = this.store.unlocked;
    const current = unlocked[unlocked.length - 1];
    const names: Record<ProgressionDifficulty, string> = { story: '初见', standard: '夜巡', challenge: '禁校', nightmare: '无人生还' };
    this.status.textContent = `档位：${names[current]} · 已获得 ${this.store.achievements.length}/${ACHIEVEMENTS.length}`;
    this.list.replaceChildren(...ACHIEVEMENTS.map((info) => {
      const li = document.createElement('li');
      const got = this.store.achievements.includes(info.id);
      li.className = got ? 'earned' : 'locked';
      li.textContent = got ? `✓ ${info.title} · ${info.detail}` : info.secret ? '？ 未知彩蛋' : `○ ${info.title}`;
      li.title = got ? info.detail : info.secret ? '在校园里寻找不显眼的线索' : '完成对应行动后记录';
      return li;
    }));
  }

  dispose(): void { this.unsubscribe(); this.button.remove(); this.dialog.remove(); }
  open(): void { this.render(); this.dialog.showModal(); }
}
