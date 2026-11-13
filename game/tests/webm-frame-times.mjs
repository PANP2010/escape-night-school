// Read the source WebM's encoded frame timestamps without inventing a container frame rate.
// For a canvas-only recording (no audio tracks): MediaRecorder emits one unlaced video block per captured frame.
import { readFileSync } from 'node:fs';

export function webmFrameTimes(file) {
  const data = readFileSync(file), blocks = [], tracks = new Map();
  let scale = 1_000_000;
  const vint = (at, id = false) => {
    const byte = data[at];
    if (!byte) throw Error(`Invalid EBML VINT at ${at}`);
    let length = 1, mask = 0x80;
    while (!(byte & mask)) { mask >>= 1; length++; }
    if (length > 8 || at + length > data.length) throw Error('Truncated EBML value');
    let value = BigInt(id ? byte : byte & (mask - 1));
    for (let i = 1; i < length; i++) value = value * 256n + BigInt(data[at + i]);
    const unknown = !id && value === (1n << BigInt(length * 7)) - 1n;
    return { value: Number(value), length, unknown };
  };
  const uint = (at, end) => { let n = 0; for (; at < end; at++) n = n * 256 + data[at]; return n; };
  const walk = (at, end, cluster = 0) => {
    while (at < end) {
      const id = vint(at, true); at += id.length;
      const size = vint(at); at += size.length;
      const stop = size.unknown ? end : at + size.value;
      if (stop > end) throw Error('Truncated EBML element');
      if (id.value === 0x2ad7b1) scale = uint(at, stop);
      if (id.value === 0xe7) cluster = uint(at, stop);
      if (id.value === 0xae) {
        let child = at, number, type;
        while (child < stop) {
          const key = vint(child, true); child += key.length;
          const length = vint(child); child += length.length;
          const childEnd = child + length.value;
          if (length.unknown || childEnd > stop) throw Error('Invalid WebM track metadata');
          if (key.value === 0xd7) number = uint(child, childEnd);
          if (key.value === 0x83) type = uint(child, childEnd);
          child = childEnd;
        }
        if (!number || !type) throw Error('WebM track is missing its number/type');
        tracks.set(number, type);
      }
      if ([0x18538067, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0xa0].includes(id.value)) walk(at, stop, id.value === 0x1f43b675 ? 0 : cluster);
      if (id.value === 0xa3 || id.value === 0xa1) {
        const track = vint(at), stampAt = at + track.length;
        if (stampAt + 3 > stop) throw Error('Truncated WebM video block');
        if (data[stampAt + 2] & 0x06) throw Error('Laced WebM blocks need a different frame counter');
        blocks.push({ track: track.value, ticks: cluster + data.readInt16BE(stampAt) });
      }
      at = stop;
    }
  };
  walk(0, data.length);
  const videoTracks = [...tracks].filter(([, type]) => type === 1).map(([number]) => number);
  if (videoTracks.length !== 1) throw Error('This frame meter requires exactly one identified video track');
  if (blocks.some(b => !tracks.has(b.track))) throw Error('Encoded block references an unidentified track');
  const raw = blocks.filter(b => b.track === videoTracks[0]).map(b => b.ticks * scale / 1_000_000).sort((a, b) => a - b);
  const times = [...new Set(raw)];
  if (times.length < 2) throw Error('At least two encoded video frames are required to measure a rate');
  const span = (times.at(-1) - times[0]) / 1000;
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  return { frames: times.length, firstPtsMs: times[0], lastPtsMs: times.at(-1), timestampSpanSeconds: span,
    measuredEncodedFps: span > 0 ? (times.length - 1) / span : 0, maxEncodedGapMs: Math.max(0, ...gaps),
    repeatedTimestamps: raw.length - times.length, ignoredNonVideoBlocks: blocks.length - raw.length, timestampsMs: times };
}

if (process.argv[1]?.endsWith('/webm-frame-times.mjs')) {
  const r = webmFrameTimes(process.argv[2]);
  const { timestampsMs, ...summary } = r;
  console.log(JSON.stringify(summary, null, 2));
}
