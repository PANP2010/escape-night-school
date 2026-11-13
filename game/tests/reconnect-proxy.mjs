// Transport-only blackhole: actual HTTP/WS bytes still go to the fixed 4419 game server.
// Existing connections can lose all downstream bytes (including WS ping); new connections remain usable.
import net from 'node:net';

export async function reconnectProxy(targetPort = 4419) {
  const pairs = new Set();
  const server = net.createServer(client => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    const pair = { client, upstream, blackhole: false };
    pairs.add(pair);
    client.setNoDelay(true); upstream.setNoDelay(true);
    client.on('data', bytes => { if (!upstream.destroyed) upstream.write(bytes); });
    upstream.on('data', bytes => { if (!pair.blackhole && !client.destroyed) client.write(bytes); });
    const close = () => { client.destroy(); upstream.destroy(); pairs.delete(pair); };
    client.on('error', close);
    upstream.on('error', () => { if (!pair.blackhole) close(); });
    client.on('close', close);
    // A blackholed connection must also suppress FIN: navigator stays online and the browser gets no close event.
    upstream.on('close', () => { if (!pair.blackhole) close(); });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    blackholeExisting() { for (const pair of pairs) pair.blackhole = true; },
    async close() {
      for (const pair of pairs) { pair.client.destroy(); pair.upstream.destroy(); }
      pairs.clear();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
