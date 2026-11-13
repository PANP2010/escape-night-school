/** TCP proxy to host:port adding `oneWayMs` each way (see delay-proxy.mjs). */
export function delayProxy(host: string, port: number, oneWayMs: number): Promise<{ port: number; close: () => void }>;
