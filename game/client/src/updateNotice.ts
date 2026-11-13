import { parseRelease, ReleaseBaseline, type Release } from './releaseState.ts';

declare const __GAME_RELEASE__: unknown;
const POLL_MS = 60_000;
const SEEN_PREFIX = 'escape.updates.seen.';

/** Nonmodal lobby notes and a passive in-session deployment notice. Never changes game input. */
export function installUpdateNotice(lobby: HTMLElement) {
  const bundled = parseRelease(__GAME_RELEASE__);
  if (!bundled) throw new Error('Invalid bundled release metadata');
  const current: Release = bundled;
  const baseline = new ReleaseBaseline(current.id);
  let session: 'lobby' | 'playing' | 'complete' = 'lobby';
  let available: Release | null = null;
  let disposed = false;
  let pending: AbortController | null = null;
  const memorySeen = new Set<string>();

  const root = document.createElement('section');
  root.id = 'updates'; root.setAttribute('aria-label', '游戏更新');
  const summary = document.createElement('div'); summary.className = 'updates-summary';
  const version = document.createElement('span'); version.textContent = `当前版本 v${current.id} · ${current.date}`;
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = '更新内容';
  toggle.setAttribute('aria-controls', 'updates-details');
  const details = document.createElement('section'); details.id = 'updates-details';
  details.setAttribute('aria-labelledby', 'updates-title');
  const heading = document.createElement('h2'); heading.id = 'updates-title'; heading.textContent = '本次更新';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '收起';
  close.setAttribute('aria-label', '关闭更新内容');
  const entries = document.createElement('ul');
  for (const text of current.entries) { const item = document.createElement('li'); item.textContent = text; entries.append(item); }
  const teaser = document.createElement('p'); teaser.className = 'updates-teaser'; teaser.textContent = current.entries[0];
  details.append(heading, close, entries); summary.append(version, toggle); root.append(summary, teaser, details); lobby.append(root);

  function seen(id: string) {
    if (memorySeen.has(id)) return true;
    try { return localStorage.getItem(SEEN_PREFIX + id) === '1'; } catch { return false; }
  }
  function setDetails(open: boolean) {
    details.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      memorySeen.add(current.id);
      try { localStorage.setItem(SEEN_PREFIX + current.id, '1'); } catch { /* Remembers for this page when storage is blocked. */ }
    }
  }
  toggle.addEventListener('click', () => setDetails(details.hidden));
  function closeDetails() {
    const focusedInside = details.contains(document.activeElement);
    setDetails(false);
    if (focusedInside) toggle.focus();
  }
  close.addEventListener('click', closeDetails);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !details.hidden) { closeDetails(); event.stopPropagation(); }
  });
  setDetails(!seen(current.id));

  const notice = document.createElement('aside'); notice.id = 'update-available'; notice.hidden = true;
  const message = document.createElement('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '刷新体验';
  refresh.addEventListener('click', () => { if (session !== 'playing') location.reload(); });
  notice.append(message, refresh); document.body.append(notice);
  // Enter activates the refresh button without reaching the game's global chat shortcut.
  notice.addEventListener('keydown', (event) => event.stopPropagation());

  function renderAvailable() {
    notice.hidden = !available;
    notice.classList.toggle('in-session', session === 'playing');
    refresh.hidden = session === 'playing';
    const text = !available ? '' : session === 'playing'
      ? '新版本已上线，本局结束后刷新体验。'
      : `新版本 v${available.id} 已上线，刷新后查看更新内容。`;
    if (message.textContent !== text) message.textContent = text;
  }
  async function check() {
    if (disposed || pending || document.hidden) return;
    const controller = new AbortController(); pending = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(new URL('version.json', document.baseURI), {
        cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (!response.ok) return;
      const release = parseRelease(await response.json());
      if (!release || disposed) return;
      const next = baseline.observe(release);
      if (next !== undefined) { available = next; renderAvailable(); }
    } catch { /* Offline, old servers and interrupted deploys retry silently on the next check. */ }
    finally { clearTimeout(timeout); if (pending === controller) pending = null; }
  }
  const timer = setInterval(() => { void check(); }, POLL_MS);
  const onVisible = () => { if (!document.hidden) void check(); };
  const onOnline = () => { void check(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  void check();

  return {
    setSession(next: typeof session) { session = next; renderAvailable(); },
    dispose() {
      disposed = true; clearInterval(timer); pending?.abort();
      document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onOnline);
      root.remove(); notice.remove();
    },
  };
}
