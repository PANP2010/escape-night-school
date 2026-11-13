export const RESUME_KEY = 'escape.resume';
const NOTICE_KEY = 'escape.reconnect.notice';
const SKIP_RESUME_KEY = 'escape.reconnect.lobby';
export interface ResumeSession { token: string; name: string }

/** A tab-scoped bearer never belongs in URLs, logs or persistent local storage. */
export function readResume(): ResumeSession | null {
  try {
    if (sessionStorage.getItem(SKIP_RESUME_KEY) === '1') { sessionStorage.removeItem(SKIP_RESUME_KEY); return null; }
    const value: unknown = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? 'null');
    if (value && typeof value === 'object' && 'token' in value && typeof value.token === 'string' && value.token.length > 0 && 'name' in value && typeof value.name === 'string') return { token: value.token, name: value.name };
  } catch { /* Storage can be disabled; an open page still keeps its session in memory. */ }
  return null;
}
export function saveResume(value: ResumeSession) { try { sessionStorage.setItem(RESUME_KEY, JSON.stringify(value)); } catch { /* optional */ } }
export function clearResume() { try { sessionStorage.removeItem(RESUME_KEY); } catch { /* optional */ } }
export function saveReconnectNotice(text: string) { try { sessionStorage.setItem(NOTICE_KEY, text); sessionStorage.setItem(SKIP_RESUME_KEY, '1'); } catch { /* optional */ } }
export function takeReconnectNotice(): string {
  try { const text = sessionStorage.getItem(NOTICE_KEY) ?? ''; sessionStorage.removeItem(NOTICE_KEY); return text; } catch { return ''; }
}

/** Preserve the running page while offline so it can return to the lobby when connectivity comes back. */
export function reloadWhenOnline(reload: () => void, online = () => navigator.onLine !== false, events: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  if (online()) { reload(); return () => {}; }
  const resume = () => { if (online()) { events.removeEventListener('online', resume); reload(); } };
  events.addEventListener('online', resume);
  return () => events.removeEventListener('online', resume);
}

/** Initial membership establishes a baseline; later host changes create a quiet, visible announcement. */
export class HostStatus {
  private code = '';
  private host?: number;
  update(code: string, host: number, players: { id: number; name: string }[], myId: number) {
    const name = players.find(p => p.id === host)?.name ?? '队友';
    const changed = this.code === code && this.host !== undefined && this.host !== host;
    this.code = code; this.host = host;
    return { current: `房主：${name}${host === myId ? '（你）' : ''}`, change: changed ? host === myId ? '你已成为房主' : `${name} 已成为房主` : '' };
  }
}
