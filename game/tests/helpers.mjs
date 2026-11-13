// Test/probe placement must be acknowledged by the authority. A forced correct alone is insufficient:
// an out-of-bounds debug tp also gets one, carrying the unchanged server position.
export function nearPosition(origin, area, dx, dz) {
  const p = { x: origin.x + dx, y: origin.y, z: origin.z + dz };
  if (![p.x, p.y, p.z, dx, dz, area.x0, area.x1, area.y0, area.y1, area.z0, area.z1].every(Number.isFinite)
    || p.x < area.x0 || p.x > area.x1 || p.y < area.y0 || p.y > area.y1 || p.z < area.z0 || p.z > area.z1) {
    throw new Error(`placeNear: target ${JSON.stringify(p)} is outside the current level area ${JSON.stringify(area)}`);
  }
  return p;
}

export async function placeNear(page, dx, dz, { timeout = 2500 } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('placeNear: timeout must be a positive finite number');
  const state = await page.evaluate(() => {
    const g = window.__escape?.game();
    if (!g?.spawnSynced) throw new Error('placeNear: wait for spawnSynced before placing a player');
    return { origin: { x: g.pos.x, y: g.body.y, z: g.pos.z }, area: g.level.def.area, level: g.level.index };
  });
  const target = nearPosition(state.origin, state.area, dx, dz);
  return page.evaluate(({ target, area, level, timeout }) => new Promise((resolve, reject) => {
    const e = window.__escape, g = e.game(), net = e.net;
    const original = net.onMsg;
    let confirmed, finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (net.onMsg === watch) net.onMsg = original;
      if (error) reject(new Error(error)); else resolve(result);
    };
    const inside = (p) => p?.length === 3 && p.every(Number.isFinite)
      && p[0] >= area.x0 && p[0] <= area.x1 && p[1] >= area.y0 && p[1] <= area.y1 && p[2] >= area.z0 && p[2] <= area.z1;
    const watch = (m) => {
      try { original.call(net, m); }
      catch (error) { finish(`placeNear: network handler failed: ${String(error)}`); return; }
      if (e.game()?.level.index !== level) return finish('placeNear: level changed during placement');
      if (m.t === 'correct' && m.forced) {
        // debug tp finds the actual ground at X/Z, so stairs/furniture may change Y.
        // It must remain on this storey (FLOOR_HEIGHT=3.6) and inside this chapter.
        if (!inside(m.p) || Math.hypot(m.p[0] - target.x, m.p[2] - target.z) > 0.08
          || Math.round(m.p[1] / 3.6) !== Math.round(target.y / 3.6)) {
          return finish(`placeNear: server rejected target ${JSON.stringify(target)}; authoritative position ${JSON.stringify(m.p)}`);
        }
        confirmed = [...m.p];
      }
      if (m.t === 'snap' && confirmed) {
        const self = m.players.find((p) => p.id === g.myId);
        if (!self) return;
        if (!inside(self.p) || Math.hypot(...self.p.map((v, i) => v - confirmed[i])) > 0.08) {
          return finish(`placeNear: server snapshot did not confirm placement: ${JSON.stringify(self.p)}`);
        }
        finish(null, { x: self.p[0], y: self.p[1], z: self.p[2], tick: m.tick });
      }
    };
    const timer = setTimeout(() => finish(`placeNear: no authoritative debug tp confirmation within ${timeout} ms; debug may be disabled (NODE_ENV=production). Use a local development server.`), timeout);
    net.onMsg = watch;
    try { e.debug('tp', target.x, target.z); }
    catch (error) { finish(String(error)); }
  }), { target, area: state.area, level: state.level, timeout });
}

// A same-position tp has an observable server acknowledgement without granting keys, downing players or summoning mobs.
// Call before the first safe/warden/down command: production silently ignores debug messages, so fail here, in 2.5 s.
export async function assertDebugAvailable(page, options) {
  await placeNear(page, 0, 0, options);
}
