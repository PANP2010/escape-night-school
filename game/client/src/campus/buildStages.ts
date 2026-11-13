/** One completed piece of the campus build. Durations exclude time spent yielding to the browser. */
export interface BuildStageProgress {
  stage: string;
  completed: number;
  durationMs: number;
  elapsedMs: number;
}

export interface BuildStageOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BuildStageProgress) => void;
  /** Work per browser turn; a single geometry operation remains indivisible. */
  budgetMs?: number;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Campus build cancelled', 'AbortError');
}

/** Resume after a paint opportunity, with a timer fallback for hidden tabs and non-browser callers. */
function nextBuildFrame(signal?: AbortSignal): Promise<void> {
  checkAborted(signal);
  return new Promise((resolve, reject) => {
    let frame: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = () => { clear(); resolve(); };
    const abort = () => { clear(); reject(signal?.reason ?? new DOMException('Campus build cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (timer !== undefined) clearTimeout(timer);
        // Resolving inside rAF would run the next geometry operation before that frame can paint.
        timer = setTimeout(finish, 0);
      });
      timer = setTimeout(finish, 40);
    } else timer = setTimeout(finish, 0);
  });
}

/**
 * Drain the same generator as the synchronous API, yielding between bounded batches of stages. Closing the
 * generator on cancellation/error guarantees that it cannot later attach another object to its old scene.
 */
export async function runBuildStages<T>(stages: Generator<string, T, void>, options: BuildStageOptions = {}): Promise<T> {
  const { signal, onProgress } = options;
  const budget = Number.isFinite(options.budgetMs) ? Math.max(0, options.budgetMs!) : 8;
  const started = performance.now();
  let completed = 0, finished = false;
  try {
    // Let the loading UI become visible before even the first geometry operation.
    await nextBuildFrame(signal);
    let sliceStarted = performance.now();
    while (true) {
      checkAborted(signal);
      const before = performance.now(), result = stages.next();
      const after = performance.now();
      checkAborted(signal);
      if (result.done) { finished = true; return result.value; }
      onProgress?.({ stage: result.value, completed: ++completed, durationMs: after - before, elapsedMs: after - started });
      checkAborted(signal);
      if (after - sliceStarted >= budget) {
        await nextBuildFrame(signal);
        sliceStarted = performance.now();
      }
    }
  } finally {
    if (!finished) stages.return(undefined as never);
  }
}
