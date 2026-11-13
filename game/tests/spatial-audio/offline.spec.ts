import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const evidence = 'test-results/spatial-audio';
function save(name: string, measurements: unknown) {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(`${evidence}/${name}.json`, `${JSON.stringify(measurements, null, 2)}\n`);
}

test.beforeEach(async ({ page }) => {
  // A blank, same-origin page imports TS through Vite; the game and WebGL never start.
  await page.route('**/spatial-audio-test.html', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Offline audio</title><button id="unlock">Unlock test graph</button>',
  }));
  await page.goto('/spatial-audio-test.html');
});

test('HRTF renders left, right, front, back and an existing source follows a turn', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = '/src/spatialAudio.ts';
    const { SpatialAudio } = await import(url) as typeof import('../../client/src/spatialAudio.ts');
    const rate = 48_000;
    const rms = (a: Float32Array, start = 0.1, end = 0.5) => {
      let sum = 0; const from = Math.round(start * rate), to = Math.round(end * rate);
      for (let i = from; i < to; i++) sum += a[i] ** 2;
      return Math.sqrt(sum / (to - from));
    };
    const source = (ac: OfflineAudioContext) => {
      const buffer = ac.createBuffer(1, Math.round(rate * 0.7), rate), data = buffer.getChannelData(0);
      let seed = 104729;
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[i] = ((seed / 0x100000000) * 2 - 1) * 0.3;
      }
      const node = ac.createBufferSource(); node.buffer = buffer; return node;
    };
    const render = async (x: number, z: number, yaw: number) => {
      const ac = new OfflineAudioContext(2, rate, rate), effects = ac.createGain(); effects.connect(ac.destination);
      const spatial = new SpatialAudio(ac, effects, ac.destination);
      spatial.update({ x: 0, y: 1.6, z: 0, yaw, floorY: 0 }, false);
      const event = spatial.event(0.5, { x, y: 1.6, z, floorY: 0 })!;
      const panner = event.nodes.find((node) => node instanceof PannerNode) as PannerNode;
      const input = source(ac); input.connect(event.input); input.start(0.05);
      const output = await ac.startRendering(), left = output.getChannelData(0), right = output.getChannelData(1);
      const measured = { left: rms(left), right: rms(right), model: panner.panningModel, rolloff: panner.rolloffFactor };
      spatial.dispose(); return { measured, left: new Float32Array(left), right: new Float32Array(right) };
    };
    const right = await render(4, 0, 0), left = await render(-4, 0, 0);
    const front = await render(0, -4, 0), back = await render(0, 4, 0);
    const quarterTurn = await render(0, -4, Math.PI / 2);
    let difference = 0, reference = 0;
    for (let i = rate / 10; i < rate / 2; i++) {
      difference += (front.left[i] - back.left[i]) ** 2;
      reference += front.left[i] ** 2;
    }

    const ac = new OfflineAudioContext(2, rate, rate), effects = ac.createGain(); effects.connect(ac.destination);
    const spatial = new SpatialAudio(ac, effects, ac.destination);
    spatial.update({ x: 0, y: 1.6, z: 0, yaw: 0, floorY: 0 }, false);
    const event = spatial.event(0.5, { x: 4, y: 1.6, z: 0, floorY: 0 })!;
    const input = source(ac); input.connect(event.input); input.start(0.05);
    const paused = ac.suspend(0.3), rendering = ac.startRendering();
    await paused;
    spatial.update({ x: 0, y: 1.6, z: 0, yaw: Math.PI, floorY: 0 }, false);
    await ac.resume();
    const turned = await rendering;
    const before = { left: rms(turned.getChannelData(0), 0.1, 0.25), right: rms(turned.getChannelData(1), 0.1, 0.25) };
    const after = { left: rms(turned.getChannelData(0), 0.5, 0.7), right: rms(turned.getChannelData(1), 0.5, 0.7) };
    spatial.dispose();
    return {
      rate, right: right.measured, left: left.measured, front: front.measured, back: back.measured,
      quarterTurn: quarterTurn.measured, frontBackRelativeDifference: Math.sqrt(difference / reference), before, after,
    };
  });
  save('direction', result);
  expect(result.right.model).toBe('HRTF');
  expect(result.right.rolloff).toBe(0); // Distance is applied once by the acoustic model.
  expect(result.right.right / result.right.left).toBeGreaterThan(1.5);
  expect(result.left.left / result.left.right).toBeGreaterThan(1.5);
  expect(result.quarterTurn.right / result.quarterTurn.left).toBeGreaterThan(1.5);
  expect(result.front.left / result.front.right).toBeCloseTo(1, 1);
  expect(result.back.left / result.back.right).toBeCloseTo(1, 1);
  expect(result.frontBackRelativeDifference).toBeGreaterThan(0.05);
  expect(result.before.right / result.before.left).toBeGreaterThan(1.5);
  expect(result.after.left / result.after.right).toBeGreaterThan(1.5);
});

test('a solid wall removes high frequencies and another floor removes additional energy', async ({ page }) => {
  const result = await page.evaluate(async ({ collisionURL }) => {
    const url = '/src/spatialAudio.ts';
    const { SpatialAudio } = await import(url) as typeof import('../../client/src/spatialAudio.ts');
    const { CollisionWorld, box } = await import(collisionURL) as typeof import('../../shared/campus/collision.ts');
    const rate = 48_000;
    const render = async (point: { x: number; y: number; z: number; floorY: number }, wall = false) => {
      const ac = new OfflineAudioContext(2, rate, rate), effects = ac.createGain(); effects.connect(ac.destination);
      const spatial = new SpatialAudio(ac, effects, ac.destination);
      const listener = { x: 0, y: 1.6, z: 0, yaw: 0, floorY: 0 };
      const collision = new CollisionWorld(wall ? [box(0, -2, 8, 0.3, 3.6)] : []);
      spatial.update(listener, false, collision);
      const event = spatial.event(0.5, point)!;
      spatial.update(listener, false, collision); // Actual collision geometry remixes the living event.
      const buffer = ac.createBuffer(1, rate * 0.7, rate), data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = 0.2 * (Math.sin(2 * Math.PI * 220 * i / rate) + Math.sin(2 * Math.PI * 3000 * i / rate));
      const source = ac.createBufferSource(); source.buffer = buffer; source.connect(event.input); source.start();
      const output = await ac.startRendering(), left = output.getChannelData(0), right = output.getChannelData(1);
      let power = 0;
      const amplitude = (hz: number) => {
        let re = 0, im = 0;
        for (let i = rate * 0.2; i < rate * 0.6; i++) {
          const sample = (left[i] + right[i]) / 2, angle = 2 * Math.PI * hz * i / rate;
          re += sample * Math.cos(angle); im += sample * Math.sin(angle);
        }
        return Math.hypot(re, im) * 2 / (rate * 0.4);
      };
      for (let i = rate * 0.2; i < rate * 0.6; i++) power += (left[i] ** 2 + right[i] ** 2) / 2;
      const measured = { rms: Math.sqrt(power / (rate * 0.4)), low: amplitude(220), high: amplitude(3000) };
      spatial.dispose(); return measured;
    };
    const clear = await render({ x: 0, y: 1.6, z: -4, floorY: 0 });
    const wall = await render({ x: 0, y: 1.6, z: -4, floorY: 0 }, true);
    // Equal acoustic distance (vertical travel is weighted 1.5): only the second source crosses a floor.
    const sameFloor = await render({ x: 0, y: 1.6, z: -Math.hypot(4, 3.6 * 1.5), floorY: 0 });
    const otherFloor = await render({ x: 0, y: 5.2, z: -4, floorY: 3.6 });
    return {
      rate, clear, wall, sameFloor, otherFloor,
      wallHighLowRatio: (wall.high / wall.low) / (clear.high / clear.low),
      floorEnergyRatio: otherFloor.rms / sameFloor.rms,
    };
  }, { collisionURL: `/@fs${new URL('../../shared/campus/collision.ts', import.meta.url).pathname}` });
  save('occlusion-floor', result);
  expect(result.clear.rms).toBeGreaterThan(0.001);
  expect(result.wall.rms / result.clear.rms).toBeLessThan(0.45);
  expect(result.wallHighLowRatio).toBeLessThan(0.15);
  expect(result.floorEnergyRatio).toBeLessThan(0.5);
  expect(result.otherFloor.high / result.otherFloor.low).toBeLessThan(result.sameFloor.high / result.sameFloor.low);
});

test('procedural stereo corridors reproduce and decay at 44.1 and 48 kHz', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = '/src/spatialAudio.ts';
    const { corridorImpulse } = await import(url) as typeof import('../../client/src/spatialAudio.ts');
    const rates = [44_100, 48_000], measurements = [];
    for (const rate of rates) {
      const ac = new OfflineAudioContext(2, rate * 3, rate);
      const a = corridorImpulse(ac, { length: 24, width: 3.6, height: 3.3 });
      const b = corridorImpulse(ac, { length: 24, width: 3.6, height: 3.3 });
      const longer = corridorImpulse(ac, { length: 48, width: 3.6, height: 3.3 });
      const wider = corridorImpulse(ac, { length: 24, width: 7.2, height: 3.3 });
      const earlyPeakTime = (buffer: AudioBuffer) => {
        const data = buffer.getChannelData(0); let at = 0, peak = 0;
        for (let i = Math.round(rate * 0.005); i < Math.round(rate * 0.06); i++) {
          if (Math.abs(data[i]) > peak) { peak = Math.abs(data[i]); at = i; }
        }
        return at / rate;
      };
      let maxDifference = 0, cross = 0, leftPower = 0, rightPower = 0, firstEnergy = 0, lastEnergy = 0, endPeak = 0;
      const l = a.getChannelData(0), r = a.getChannelData(1);
      for (let channel = 0; channel < 2; channel++) {
        const one = a.getChannelData(channel), two = b.getChannelData(channel);
        for (let i = 0; i < one.length; i++) {
          maxDifference = Math.max(maxDifference, Math.abs(one[i] - two[i]));
          if (i < one.length / 4) firstEnergy += one[i] ** 2;
          if (i > one.length * 3 / 4) lastEnergy += one[i] ** 2;
          if (i > one.length - rate * 0.02) endPeak = Math.max(endPeak, Math.abs(one[i]));
        }
      }
      for (let i = 0; i < l.length; i++) { cross += l[i] * r[i]; leftPower += l[i] ** 2; rightPower += r[i] ** 2; }
      const convolution = ac.createConvolver(); convolution.normalize = false; convolution.buffer = a; convolution.connect(ac.destination);
      const pulse = ac.createBuffer(1, 1, rate); pulse.getChannelData(0)[0] = 1;
      const source = ac.createBufferSource(); source.buffer = pulse; source.connect(convolution); source.start(0.05);
      const output = await ac.startRendering(); let tailPower = 0, peak = 0, afterTailPeak = 0;
      for (let channel = 0; channel < 2; channel++) {
        const data = output.getChannelData(channel);
        for (let i = 0; i < data.length; i++) {
          peak = Math.max(peak, Math.abs(data[i]));
          if (i > rate * 0.1 && i < rate * 0.35) tailPower += data[i] ** 2;
          if (i > (a.duration + 0.1) * rate) afterTailPeak = Math.max(afterTailPeak, Math.abs(data[i]));
        }
      }
      measurements.push({ rate, channels: a.numberOfChannels, duration: a.duration, longerDuration: longer.duration,
        earlyPeakTime: earlyPeakTime(a), widerEarlyPeakTime: earlyPeakTime(wider),
        maxDifference, stereoCorrelation: cross / Math.sqrt(leftPower * rightPower), firstEnergy, lastEnergy,
        lateEarlyEnergyRatio: lastEnergy / firstEnergy, endPeak, renderedPeak: peak, renderedTailEnergy: tailPower, afterTailPeak });
    }
    return measurements;
  });
  save('corridor-ir', result);
  for (const measured of result) {
    expect(measured.channels).toBe(2);
    expect(measured.maxDifference).toBe(0);
    expect(Math.abs(measured.stereoCorrelation)).toBeLessThan(0.95);
    expect(measured.longerDuration).toBeGreaterThan(measured.duration);
    expect(measured.widerEarlyPeakTime - measured.earlyPeakTime).toBeGreaterThan(0.01);
    expect(measured.lateEarlyEnergyRatio).toBeLessThan(0.01);
    expect(measured.endPeak).toBeLessThan(0.001);
    expect(measured.renderedPeak).toBeGreaterThan(0.001);
    expect(measured.renderedTailEnergy).toBeGreaterThan(0.000001);
    expect(measured.afterTailPeak).toBeLessThan(0.000001);
  }
  expect(Math.abs(result[0].duration - result[1].duration)).toBeLessThan(1 / 44_100);
});

test('clearing a room removes its convolution history before the next event', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const url = '/src/spatialAudio.ts';
    const { SpatialAudio } = await import(url) as typeof import('../../client/src/spatialAudio.ts');
    const rate = 48_000, ac = new OfflineAudioContext(2, rate, rate), effects = ac.createGain(); effects.connect(ac.destination);
    const spatial = new SpatialAudio(ac, effects, ac.destination);
    spatial.update({ x: 0, y: 1.6, z: 0, yaw: 0, floorY: 0 }, true);
    const event = spatial.event(0.5, { x: 0, y: 1.6, z: -1, floorY: 0 })!;
    const pulse = ac.createBuffer(1, 1, rate); pulse.getChannelData(0)[0] = 1;
    const source = ac.createBufferSource(); source.buffer = pulse; source.connect(event.input); source.start(0.05);
    const paused = ac.suspend(0.2), rendering = ac.startRendering(); await paused;
    spatial.clear();
    // Restoring the wet branch must not reveal old convolution history.
    spatial.update({ x: 0, y: 1.6, z: 0, yaw: 0, floorY: 0 }, true);
    const next = spatial.event(0.5, { x: 0, y: 1.6, z: -1, floorY: 0 })!;
    const nextSource = ac.createBufferSource(); nextSource.buffer = pulse; nextSource.connect(next.input); nextSource.start(0.55);
    await ac.resume(); const output = await rendering;
    let before = 0, after = 0, nextTail = 0;
    for (let channel = 0; channel < 2; channel++) {
      const data = output.getChannelData(channel);
      for (let i = rate * 0.1; i < rate * 0.18; i++) before += data[i] ** 2;
      for (let i = rate * 0.25; i < rate * 0.5; i++) after = Math.max(after, Math.abs(data[i]));
      for (let i = rate * 0.6; i < rate * 0.8; i++) nextTail += data[i] ** 2;
    }
    spatial.dispose(); return { rate, tailEnergyBeforeClear: before, peakAfterClear: after, tailEnergyAfterNewEvent: nextTail };
  });
  save('room-clear', result);
  expect(result.tailEnergyBeforeClear).toBeGreaterThan(1e-10);
  expect(result.peakAfterClear).toBeLessThan(1e-7);
  expect(result.tailEnergyAfterNewEvent).toBeGreaterThan(1e-10);
});

test('Sound movement emits a real monster voice and all 24 layers remain below full scale', async ({ page }) => {
  const rendering = page.evaluate(async () => {
    const url = '/src/sound.ts';
    const { Sound } = await import(url) as typeof import('../../client/src/sound.ts');
    const rate = 48_000, ac = new OfflineAudioContext(2, rate * 2, rate);
    // Only lifecycle control is adapted. Every source, bus, HRTF, convolution and limiter is native WebAudio.
    const context = new Proxy(ac, {
      get(target, property) {
        if (property === 'state') return 'running';
        if (['resume', 'suspend', 'close'].includes(String(property))) return () => Promise.resolve();
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const descriptor = Object.getOwnPropertyDescriptor(window, 'AudioContext')!;
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: function () { return context; } });
    const mob = { id: 1, x: 2, y: 0, z: -4, anim: 'chase' };
    const frame = {
      x: 0, y: 1.6, z: 0, yaw: 0, floorY: 0, indoors: true, down: true,
      threat: 1, active: true, power: true, spatial: { mobs: [mob] },
    };
    const button = document.querySelector<HTMLButtonElement>('#unlock')!;
    const sound = await new Promise<InstanceType<typeof Sound>>((resolve) => {
      button.addEventListener('click', () => {
        const sound = new Sound(); sound.setPreferences(1, false); sound.update(frame); sound.unlock(); sound.update(frame); resolve(sound);
      }, { once: true });
      button.dataset.ready = 'yes';
    });
    try {
      const snapshots = [{ label: 'initial', ...sound.diagnostics }];
      const stops = [0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 1.1].map((time) => ac.suspend(time));
      const outputPromise = ac.startRendering();
      for (let i = 0; i < stops.length; i++) {
        await stops[i];
        if (i < 3) mob.x += 0.6;
        if (i === 4) mob.x += 40; // A teleport must not add a stride.
        if (i === 5) mob.x = 2;
        sound.update(frame);
        if (i === 5) {
          sound.humStart(0.8); sound.door({ x: 1, y: 1, z: -1 }, true); sound.door({ x: -1, y: 1, z: -1 }, false);
          sound.footstep(false, true, { x: -1, y: 0.12, z: -2 }); sound.monsterFootstep(mob); sound.click(); sound.pickup();
          for (let attempts = 0; attempts < 30 && sound.diagnostics.activeSources < 24; attempts++) sound.tone('sine', 180, 0.3, 0.8);
          snapshots.push({ label: 'all paths at capacity', ...sound.diagnostics });
          if (sound.tone('sine', 180, 0.3, 0.8)) throw new Error('The 25th voice exceeded the shared source budget');
        }
        if (i === 6) sound.setPreferences(1, true);
        snapshots.push({ label: ['move 1', 'move 2', 'move 3', 'stationary', 'teleport', 'burst', 'mute'][i], ...sound.diagnostics });
        await ac.resume();
      }
      const output = await outputPromise; let peak = 0, power = 0, afterMutePeak = 0, nonFinite = 0;
      const wav = new Uint8Array(44 + output.length * 4), view = new DataView(wav.buffer);
      const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) wav[at + i] = value.charCodeAt(i); };
      text(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
      text(36, 'data'); view.setUint32(40, wav.length - 44, true);
      const channels = [output.getChannelData(0), output.getChannelData(1)];
      for (let i = 0; i < output.length; i++) for (let channel = 0; channel < 2; channel++) {
        const sample = channels[channel][i]; if (!Number.isFinite(sample)) nonFinite++;
        peak = Math.max(peak, Math.abs(sample)); power += sample * sample;
        if (i > rate * 1.25) afterMutePeak = Math.max(afterMutePeak, Math.abs(sample));
        view.setInt16(44 + (i * 2 + channel) * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true);
      }
      let binary = '';
      for (let i = 0; i < wav.length; i += 8192) binary += String.fromCharCode(...wav.subarray(i, i + 8192));
      return { rate, channels: 2, seconds: output.duration, peak, rms: Math.sqrt(power / (output.length * 2)),
        afterMutePeak, nonFinite, snapshots, wav: btoa(binary) };
    } finally {
      sound.dispose(); Object.defineProperty(window, 'AudioContext', descriptor);
    }
  });
  await expect(page.locator('#unlock')).toHaveAttribute('data-ready', 'yes');
  await page.click('#unlock');
  const { wav, ...result } = await rendering;
  save('sound-mix', result);
  writeFileSync(`${evidence}/sound-mix.wav`, Buffer.from(wav, 'base64'));
  const initial = result.snapshots.find((snapshot) => snapshot.label === 'initial')!;
  const moved = result.snapshots.find((snapshot) => snapshot.label === 'move 3')!;
  const stationary = result.snapshots.find((snapshot) => snapshot.label === 'stationary')!;
  const teleported = result.snapshots.find((snapshot) => snapshot.label === 'teleport')!;
  const full = result.snapshots.find((snapshot) => snapshot.label === 'all paths at capacity')!;
  const muted = result.snapshots.find((snapshot) => snapshot.label === 'mute')!;
  expect(initial.ambientSources).toBe(5);
  expect(initial.played.monsterFootstep ?? 0).toBe(0);
  expect(moved.played.monsterFootstep).toBe(1);
  expect(stationary.played.monsterFootstep).toBe(1);
  expect(teleported.played.monsterFootstep).toBe(1);
  expect(full.activeSources).toBe(24);
  for (const kind of ['heartbeat', 'door', 'footstep', 'monsterFootstep', 'click', 'pickup']) expect(full.played[kind]).toBeGreaterThan(0);
  expect(result.peak).toBeGreaterThan(0.05);
  expect(result.peak).toBeLessThan(1);
  expect(result.nonFinite).toBe(0);
  expect(muted.activeSources).toBe(0);
  expect(result.afterMutePeak).toBeLessThan(1e-7);
});
