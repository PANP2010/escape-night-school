/** Native presentation comes from Electron's read-only preload or Android's bundled asset origin. */
export function nativePlatform(origin: string, bridge?: unknown): 'desktop' | 'android' | undefined {
  if (bridge && typeof bridge === 'object' && 'platform' in bridge && bridge.platform === 'desktop') return 'desktop';
  if (origin === 'http://night-school.local') return 'android';
  return undefined;
}
