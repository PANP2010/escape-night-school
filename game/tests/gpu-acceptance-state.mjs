// Self-contained because Playwright serializes this function into the browser.
export function gpuOpeningReady() {
  const game = window.__escape?.game();
  // Level indices are zero-based: index 0 is L1, index 1 is L2.
  return !!(game?.level.index === 0 && game.presentationReady && game.spawnSynced
    && !game.intro.active && game.snaps > 5);
}
