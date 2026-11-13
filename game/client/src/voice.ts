// 角色074: canonical subtitles plus wordless, rounded baritone babble made entirely with Web Audio.
// Text only sets the burst length: no characters are translated into spoken words or phonemes.

export const SUBTITLE_FAR_M = 25;
/** The voice is inaudible beyond this distance, m. */
export const VOICE_MAX_M = 40;
/** Subtitles only show within this distance, m. */
export const SUBTITLE_MAX_M = 20;
export const SUBTITLE_S = 3.5;

/** Voice volume 0..1 for a listener `d` metres from the speaker (full within 4 m, linear to silent at VOICE_MAX_M). */
export function voiceVolume(d: number): number {
  if (!Number.isFinite(d)) return 0;
  if (d <= 4) return 1;
  return Math.max(0, 1 - (d - 4) / (VOICE_MAX_M - 4));
}

export function subtitleVisible(d: number): boolean { return d <= SUBTITLE_MAX_M; }

interface BabblePlayback { stop: (immediate?: boolean) => void }
export interface VoiceProfile { pitch?: () => number; syllableLimit?: number }

export class Voice {
  private readonly profile: VoiceProfile;
  private el: HTMLElement | null;
  private timer = 0;
  private ac?: AudioContext;
  private master?: GainNode;
  private resuming?: Promise<void>;
  private restoring?: Promise<void>;
  private suspending?: Promise<void>;
  private volume = 1;
  private muted = false;
  private activated = false;
  private needsGesture = false;
  private suspendedByPage = false;
  private pageHidden = false;
  private disposed = false;
  private playbackEpoch = 0;
  private serial = 0;
  private phrase = 0;
  private active?: BabblePlayback;
  private readonly playing = new Set<BabblePlayback>();
  private readonly gestures = ['pointerdown', 'keydown', 'touchend'] as const;
  private readonly onGesture = (event: Event): void => {
    if (!event.isTrusted || this.disposed || !this.foreground()) return;
    this.activated = true;
    this.needsGesture = false;
    // Some mobile browsers leave an earlier disallowed resume pending. Retry inside this fresh gesture.
    this.resuming = undefined;
    void this.unlock();
  };
  private readonly onVisibility = (): void => { if (document.hidden) this.pause(); };
  private readonly onPageHide = (): void => { this.pageHidden = true; this.pause(); };
  private readonly onPageShow = (): void => { this.pageHidden = false; };

  constructor(el: HTMLElement | null = document.getElementById('subtitle'), profile: VoiceProfile = {}) {
    this.profile = profile;
    this.el = el;
    if (typeof window !== 'undefined') {
      for (const event of this.gestures) window.addEventListener(event, this.onGesture, true);
      window.addEventListener('pagehide', this.onPageHide);
      window.addEventListener('pageshow', this.onPageShow);
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Capture receipt-time audio eligibility when a line needs to wait for a world snapshot. */
  capturePlayback(): number | null {
    return !this.disposed && this.foreground() && !this.muted && this.volume > 0 && this.hasActivation()
      ? this.playbackEpoch : null;
  }

  say(text: string, dist: number, playback: number | null = this.capturePlayback()): void {
    if (this.disposed || !this.foreground()) return;
    const el = this.el;
    if (el && subtitleVisible(dist)) {
      el.textContent = text;
      el.classList.toggle('far', dist > SUBTITLE_FAR_M);
      el.classList.remove('fade');
      void el.offsetWidth; // restart the CSS animation
      el.style.animationDuration = `${SUBTITLE_S}s`;
      el.classList.add('fade');
      el.dataset.line = text;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => { el.textContent = ''; el.classList.remove('fade'); }, SUBTITLE_S * 1000);
    }
    // A caption may have waited through mute, a page hide, or the first gesture. Keep its audio dropped.
    if (playback === null || playback !== this.playbackEpoch) return;
    const serial = ++this.serial;
    this.active?.stop();
    this.active = undefined;
    const vol = voiceVolume(dist);
    // Pre-gesture lines are subtitle-only; unlocking later never replays a backlog.
    if (!(vol > 0) || !text.trim() || this.muted || this.volume === 0 || !this.hasActivation()) return;
    const receivedAt = Date.now();
    const ready = this.unlock(), ac = this.ac;
    void ready.then(() => {
      // A denied/slow resume, newer line or background interruption must not produce late dialogue.
      if (!this.disposed && this.foreground() && this.hasActivation() && !this.muted && this.volume > 0 && serial === this.serial && ac === this.ac && ac?.state === 'running' && Date.now() - receivedAt <= 500) {
        this.babble(ac, text.length, vol);
      }
    });
  }

  private hasActivation(): boolean {
    return !this.needsGesture && (this.activated || (typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive === true));
  }

  private foreground(): boolean {
    return !this.pageHidden && (typeof document === 'undefined' || !document.hidden);
  }

  /** Audio preferences never unlock a context or replay a line. Captions remain independent of mute. */
  setPreferences(volume: number, muted: boolean): void {
    if (this.disposed) return;
    this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
    this.muted = muted;
    if (muted || this.volume === 0) this.stopAudio();
    if (this.master && this.ac) {
      const now = this.ac.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, now, 0.025);
    }
  }

  private stopAudio(): void {
    ++this.playbackEpoch;
    ++this.serial;
    for (const playback of this.playing) playback.stop(true);
    this.active = undefined;
  }

  /** Drop this room's current and pending dialogue without disposing the reusable synthesizer. */
  cancel(): void {
    this.stopAudio();
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.el) {
      this.el.textContent = '';
      this.el.classList.remove('fade', 'far');
      this.el.style.animationDuration = '';
      delete this.el.dataset.line;
    }
  }

  private pause(): void {
    this.needsGesture = true;
    this.suspendedByPage = true;
    this.cancel();
    this.resuming = undefined;
    this.restoring = undefined;
    if (this.ac) this.suspend(this.ac);
  }

  private suspend(ac: AudioContext): void {
    if (this.ac !== ac || this.disposed || ac.state === 'closed') return;
    try {
      // Queue even while resume is pending, so that a late resume cannot escape a page hide.
      const attempt = ac.suspend().then(() => {}, () => {});
      this.suspending = attempt;
      void attempt.then(() => { if (this.suspending === attempt) this.suspending = undefined; });
    } catch { /* A denied suspension leaves all phrase sources disconnected. */ }
  }

  /** Called synchronously from real input, including touch, so Safari can resume its context in the gesture. */
  unlock(): Promise<void> {
    if (this.disposed || !this.foreground() || this.muted || this.volume === 0 || !this.hasActivation()) return Promise.resolve();
    try {
      if (!this.ac || this.ac.state === 'closed') {
        // The prefixed constructor also covers older Safari; this is still the same Web Audio synthesizer.
        const Audio = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Audio) return Promise.resolve();
        if (this.ac) {
          for (const playback of this.playing) playback.stop(true);
          this.active = undefined;
          this.ac.onstatechange = null;
          this.master?.disconnect();
        }
        this.ac = undefined;
        this.master = undefined;
        this.resuming = undefined;
        this.restoring = undefined;
        this.suspending = undefined;
        this.suspendedByPage = false;
        const ac = new Audio();
        let master: GainNode | undefined;
        try {
          master = ac.createGain();
          master.gain.value = this.volume;
          master.connect(ac.destination);
        } catch {
          master?.disconnect();
          try { if (ac.state !== 'closed') void ac.close().catch(() => {}); } catch { /* failed initialization */ }
          return Promise.resolve();
        }
        this.ac = ac;
        this.master = master;
        ac.onstatechange = () => {
          if (this.ac !== ac || this.disposed) return;
          if (ac.state !== 'running') {
            // pause() already dropped the old room's audio. A fresh foreground line waits for
            // this expected suspension and its following resume; keep that new line eligible.
            const restoring = ac.state === 'suspended' && this.resuming !== undefined
              && this.restoring === this.resuming && this.capturePlayback() !== null;
            if (!restoring) this.stopAudio();
          } else if (!this.foreground() || this.needsGesture) this.suspend(ac);
        };
      }
      if (this.ac.state === 'running' && !this.suspending) {
        this.suspendedByPage = false;
        this.restoring = undefined;
        return Promise.resolve();
      }
      if (!this.resuming) {
        // Invoke resume now, before leaving the trusted event stack. A rejection remains silent and retryable.
        const ac = this.ac;
        const suspending = this.suspending;
        // suspend() can settle before its queued statechange reaches the page.
        const restoring = this.suspendedByPage || suspending !== undefined || this.restoring !== undefined;
        const resumed = ac.resume().then(() => {}, () => {});
        const attempt = Promise.all([resumed, suspending]).then(async () => {
          // A gesture can arrive while an older suspension is still settling. Its synchronous resume
          // may see a running context, so reconcile again once that suspension has actually finished.
          if (suspending && this.ac === ac && !this.disposed && this.capturePlayback() !== null && ac.state !== 'running' && ac.state !== 'closed') {
            try { await ac.resume(); } catch { /* retry on a later gesture */ }
          }
          if (this.ac === ac && (!this.foreground() || this.needsGesture)) this.suspend(ac);
        });
        this.resuming = attempt;
        // A second gesture can retry while the earlier corrective resume is still pending.
        this.restoring = restoring ? attempt : undefined;
        void attempt.then(() => {
          if (this.resuming === attempt) {
            this.resuming = undefined;
            if (this.ac === ac && ac.state === 'running' && this.foreground() && !this.needsGesture) this.suspendedByPage = false;
          }
          if (this.restoring === attempt) this.restoring = undefined;
        });
      }
      return this.resuming;
    } catch {
      return Promise.resolve();
    }
  }

  /** 9–12 soft syllables/s, a chest register around 110 Hz, and two moving, deliberately wordless resonances. */
  private babble(ac: AudioContext, n: number, vol: number): void {
    const nodes: AudioNode[] = [];
    let oscillator: OscillatorNode | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      for (const node of nodes) node.disconnect();
      this.playing.delete(playback);
      if (this.active === playback) this.active = undefined;
    };
    const playback: BabblePlayback = { stop: () => {} };
    try {
      const o = oscillator = ac.createOscillator(); nodes.push(o);
      // A glottal-like harmonic source, softly rolled off instead of the old sharp sawtooth.
      o.setPeriodicWave(ac.createPeriodicWave(new Float32Array(13), new Float32Array([0, 1, 0.55, 0.3, 0.18, 0.11, 0.075, 0.05, 0.035, 0.025, 0.018, 0.012, 0.008])));
      const body = ac.createBiquadFilter(); nodes.push(body);
      body.type = 'lowpass'; body.frequency.value = 360; body.Q.value = 0.55;
      const mouth = ac.createBiquadFilter(); nodes.push(mouth);
      mouth.type = 'bandpass'; mouth.Q.value = 1.1;
      const nose = ac.createBiquadFilter(); nodes.push(nose);
      nose.type = 'bandpass'; nose.Q.value = 0.8;
      const chest = ac.createGain(); nodes.push(chest); chest.gain.value = 0.65;
      const vowel = ac.createGain(); nodes.push(vowel); vowel.gain.value = 0.3;
      const nasal = ac.createGain(); nodes.push(nasal); nasal.gain.value = 0.12;
      const envelope = ac.createGain(); nodes.push(envelope);
      const warmth = ac.createBiquadFilter(); nodes.push(warmth);
      warmth.type = 'lowpass'; warmth.frequency.value = 1800; warmth.Q.value = 0.5;
      const output = ac.createGain(); nodes.push(output);
      output.gain.value = 0.42 * vol;
      o.connect(body); body.connect(chest); chest.connect(envelope);
      o.connect(mouth); mouth.connect(vowel); vowel.connect(envelope);
      o.connect(nose); nose.connect(nasal); nasal.connect(envelope);
      envelope.connect(warmth); warmth.connect(output); output.connect(this.master!);

      const t0 = ac.currentTime + 0.008, phase = this.phrase++ % 7;
      const count = Math.min(this.profile.syllableLimit ?? 22, Math.max(7, Math.ceil(n * 0.85)));
      const register = this.profile.pitch?.() ?? 110;
      const basePitch = Number.isFinite(register) ? Math.max(80, Math.min(320, register)) : 110;
      const steps = [0.086, 0.098, 0.079, 0.105, 0.09, 0.082, 0.114];
      const melody = [0, 2, -1, 3, 0.5, -2, 1, -0.5];
      const vowels = [[360, 920], [490, 1150], [410, 1320], [570, 1020], [330, 850]];
      let t = t0;
      envelope.gain.setValueAtTime(0, t0);
      for (let i = 0; i < count; i++) {
        const step = steps[(i + phase) % steps.length];
        const pitch = basePitch * 2 ** ((melody[(i + phase) % melody.length] - (i / count) * 1.5) / 12);
        const [f1, f2] = vowels[(i * 3 + phase) % vowels.length];
        o.frequency.setValueAtTime(pitch * 0.97, t);
        o.frequency.exponentialRampToValueAtTime(pitch * 1.02, t + 0.022);
        o.frequency.exponentialRampToValueAtTime(pitch * 0.96, t + step - 0.012);
        mouth.frequency.setTargetAtTime(f1, t, 0.012);
        nose.frequency.setTargetAtTime(f2, t, 0.014);
        const accent = i % 5 === 0 ? 0.9 : 0.72;
        envelope.gain.setValueAtTime(0, t);
        envelope.gain.linearRampToValueAtTime(accent, t + 0.012);
        envelope.gain.linearRampToValueAtTime(accent * 0.72, t + step * 0.48);
        envelope.gain.linearRampToValueAtTime(0, t + step - 0.009);
        t += step + (i % 5 === 4 ? 0.045 : 0);
      }
      let stopped = false;
      playback.stop = (immediate = false) => {
        if (cleaned) return;
        // Also release an older voice already fading out: suspended clocks never reach its onended.
        if (immediate || ac.state !== 'running' || ac.currentTime < t0) {
          try { o.stop(); } catch { /* already ended */ }
          cleanup();
          return;
        }
        if (stopped) return;
        stopped = true;
        const now = ac.currentTime;
        try {
          // Fade on a separate gain so cancelling syllable automation cannot introduce a click.
          output.gain.cancelScheduledValues(now);
          output.gain.setTargetAtTime(0, now, 0.005);
          o.stop(now + 0.025);
        } catch { cleanup(); }
      };
      o.onended = cleanup;
      this.active = playback;
      this.playing.add(playback);
      o.start(t0);
      o.stop(t + 0.012);
    } catch {
      try { oscillator?.stop(); } catch { /* source may not have started */ }
      cleanup();
    }
  }

  /** Stop the current phrase while keeping its unlocked context available for a returning connection. */
  silence(): void {
    ++this.serial;
    clearTimeout(this.timer);
    for (const playback of [...this.playing]) playback.stop(true);
    this.active = undefined;
    if (this.el) { this.el.textContent = ''; this.el.classList.remove('fade'); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    if (typeof window !== 'undefined') {
      for (const event of this.gestures) window.removeEventListener(event, this.onGesture, true);
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('pageshow', this.onPageShow);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.master?.disconnect();
    if (this.ac) {
      this.ac.onstatechange = null;
      void this.ac.close().catch(() => {});
    }
  }
}
