// TCP proxy that holds every chunk `oneWayMs` in each direction (order kept): real added latency for HTTP and WebSocket alike.
import net from 'node:net';

/** Listen on an ephemeral 127.0.0.1 port, forward to host:port; resolves with { port, close }. */
export function delayProxy(host, port, oneWayMs) {
  const socks = new Set();
  const pipe = (from, to) => from.on('data', (d) => setTimeout(() => { if (!to.destroyed) to.write(d); }, oneWayMs));
  const srv = net.createServer((c) => {
    const u = net.connect(port, host);
    socks.add(c); socks.add(u);
    c.setNoDelay(true); u.setNoDelay(true);
    pipe(c, u); pipe(u, c);
    const end = () => setTimeout(() => { c.destroy(); u.destroy(); socks.delete(c); socks.delete(u); }, oneWayMs);
    c.on('close', end); u.on('close', end); c.on('error', end); u.on('error', end);
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({
    port: srv.address().port,
    close: () => { for (const s of socks) s.destroy(); srv.close(); },
  })));
}
