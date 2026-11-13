import './loading.css';
import { CAMPUS_BUILD_MILESTONES } from './campus/world/campus.ts';
import type { BuildStageProgress } from './campus/buildStages.ts';

/** Independent of subtitles/chapter transitions: remains visible until collision and the first world frame exist. */
export class CampusLoading {
  private readonly root = document.createElement('div');
  private readonly label = document.createElement('div');
  private readonly progress = document.createElement('progress');
  private done = 0;

  constructor() {
    this.root.id = 'campus-loading';
    this.root.hidden = true;
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    const title = document.createElement('div');
    title.className = 'loading-title'; title.textContent = '正在进入夜校';
    this.label.className = 'loading-detail';
    this.progress.max = 100;
    this.progress.setAttribute('aria-label', '校园准备进度');
    this.root.append(title, this.progress, this.label);
    document.body.append(this.root);
  }

  begin() {
    this.done = 0; this.progress.value = 0;
    this.label.textContent = '走廊正在亮起……';
    this.root.hidden = false;
    document.body.classList.add('campus-loading');
  }

  update({ stage }: BuildStageProgress) {
    const index = CAMPUS_BUILD_MILESTONES.indexOf(stage);
    if (index < 0 || index + 1 <= this.done) return;
    this.done = index + 1;
    const value = Math.floor(this.done / CAMPUS_BUILD_MILESTONES.length * 95);
    this.progress.value = value;
    this.label.textContent = `正在准备校园 · ${value}%`;
  }

  firstFrame() { this.progress.value = 98; this.label.textContent = '正在等待走廊的第一束光……'; }
  finish() { this.progress.value = 100; this.hide(); }
  fail() { this.label.textContent = '校园暂时未能准备好，请刷新重试'; }
  hide() { this.root.hidden = true; document.body.classList.remove('campus-loading'); }
}
