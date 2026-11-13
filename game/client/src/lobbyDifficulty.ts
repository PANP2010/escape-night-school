import { DIFFICULTY_MODES, type DifficultyId } from '../../shared/difficultyModes.ts';
import type { ProgressionStore } from './progression.ts';

export class LobbyDifficulty {
  private readonly select: HTMLSelectElement;
  private readonly hint: HTMLElement;
  private readonly namedMonitorsInput: HTMLInputElement;
  private readonly namedMonitorsHint: HTMLElement;
  private readonly unsubscribe: () => void;
  private readonly store: ProgressionStore;

  constructor(store: ProgressionStore) {
    this.store = store;
    this.select = document.getElementById('difficulty') as HTMLSelectElement;
    this.hint = document.getElementById('difficulty-hint')!;
    this.namedMonitorsInput = document.getElementById('named-monitors') as HTMLInputElement;
    this.namedMonitorsHint = document.getElementById('named-monitors-hint')!;
    this.namedMonitorsInput.checked = false;
    this.select.onchange = () => this.describe();
    this.unsubscribe = store.subscribe(() => this.render());
    this.render();
  }
  get selected(): DifficultyId {
    const found = DIFFICULTY_MODES.find(mode => mode.id === this.select.value);
    return found && this.store.isUnlocked(found.id) ? found.id : 'story';
  }
  get namedMonitors(): boolean { return this.store.canEnableNamedMonitors && this.namedMonitorsInput.checked; }
  dispose(): void { this.unsubscribe(); }
  private render(): void {
    const current = this.select.value;
    this.select.replaceChildren(...DIFFICULTY_MODES.map((mode, index) => {
      const option = document.createElement('option');
      option.value = mode.id; option.disabled = !this.store.isUnlocked(mode.id);
      option.textContent = option.disabled ? `${mode.name} · 通关${DIFFICULTY_MODES[index - 1].name}后解锁` : mode.name;
      return option;
    }));
    this.select.value = this.store.isUnlocked(current as DifficultyId) ? current : 'story';
    const unlocked = this.store.canEnableNamedMonitors;
    this.namedMonitorsInput.dataset.unlocked = String(unlocked);
    this.namedMonitorsInput.disabled = !unlocked || this.namedMonitorsInput.dataset.lobbyLocked === 'true';
    if (!unlocked) this.namedMonitorsInput.checked = false;
    this.namedMonitorsHint.textContent = unlocked ? '启用值周生人名与 Boss 彩蛋。创建后整局固定。' : '完成无人生还难度后解锁。';
    this.describe();
  }
  private describe(): void {
    const mode = DIFFICULTY_MODES.find(m => m.id === this.selected)!;
    this.hint.textContent = `${mode.description} 完整离校后解锁下一档，进度保存在此设备。`;
  }
}
