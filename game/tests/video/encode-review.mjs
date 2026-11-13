// Offline review only: preserve native encoded cadence, decode every frame, and
// export event frames from the resulting MP4s. Does not start a browser.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(gameRoot, process.env.ESC_VIDEO_OUTPUT ?? 'test-results/video-acceptance');
const ffmpeg = process.argv[2];
if (!ffmpeg || !existsSync(ffmpeg)) throw new Error('Pass an existing full ffmpeg executable; no dependencies are installed');
const report = JSON.parse(readFileSync(resolve(output, 'report.json'), 'utf8'));
const reviewDir = resolve(output, 'review');
mkdirSync(resolve(reviewDir, 'frames'), { recursive: true });
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = args => execFileSync(ffmpeg, ['-hide_banner', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
function metadata(file) {
  let text;
  try { run(['-i', file]); } catch (error) { text = String(error.stderr); }
  const d = text.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!d) throw new Error(`No container duration: ${file}`);
  const stream = text.split('\n').find(line => line.includes('Video:'));
  return { durationSeconds: +d[1] * 3600 + +d[2] * 60 + +d[3], videoStream: stream.trim(),
    encodedFps: Number(stream.match(/([\d.]+) fps/)?.[1]) || null, hasAudio: /Stream.*Audio:/.test(text) };
}
function decodeAudit(file) {
  const md5 = run(['-v', 'error', '-i', file, '-map', '0:v:0', '-an', '-vsync', '0', '-f', 'framemd5', '-']);
  const lines = md5.split('\n').filter(line => line && !line.startsWith('#'));
  const tb = md5.match(/#tb 0: (\d+)\/(\d+)/);
  const timebase = tb ? Number(tb[1]) / Number(tb[2]) : null;
  const frames = lines.map(line => { const p = line.split(',').map(s => s.trim()); return { pts: +p[2], hash: p[5] }; });
  let duplicate = 0, longest = 0, current = 0;
  for (let i = 1; i < frames.length; i++) {
    current = frames[i].hash === frames[i - 1].hash ? current + 1 : 0;
    duplicate += current > 0 ? 1 : 0; longest = Math.max(longest, current);
  }
  const freezeProcess = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-an', '-vf', 'freezedetect=n=0.001:d=0.25', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (freezeProcess.status !== 0) throw new Error(`Full video decode failed: ${freezeProcess.stderr}`);
  const freezeEvents = [...freezeProcess.stderr.matchAll(/lavfi\.freezedetect\.(freeze_start|freeze_end|freeze_duration): ([\d.]+)/g)]
    .map(m => ({ kind: m[1], seconds: +m[2] }));
  return { md5, frames, timebase, exactDuplicateAdjacentFrames: duplicate,
    longestExactDuplicateRunFrames: longest, decodeCompleted: true, freezeEvents };
}

const sourceAudits = new Map();
for (const video of report.videos) {
  const audit = decodeAudit(video), name = video.split('/').at(-1);
  writeFileSync(resolve(reviewDir, `${name}.framemd5`), audit.md5);
  sourceAudits.set(video, { video, ...metadata(video), sha256: sha(video), bytes: statSync(video).size,
    decodedFrames: audit.frames.length, timebase: audit.timebase,
    exactDuplicateAdjacentFrames: audit.exactDuplicateAdjacentFrames,
    longestExactDuplicateRunFrames: audit.longestExactDuplicateRunFrames, freezeEvents: audit.freezeEvents });
}

const result = { sourceCommit: report.source.commit, ffmpeg,
  cadence: 'Native 25 fps WebM cadence retained by -vsync 0; no interpolation or frame-rate increase. Game rAF FPS is independent.',
  captureDropCounter: 'not exposed by Playwright; not measured; duplicate/freeze detection is a decoded-video diagnostic, not a capture-drop counter',
  freezeMethod: 'ffmpeg freezedetect n=0.001 d=0.25 on full decoded video; exact adjacent frame hashes recorded separately. Still camera or intentional capture blackouts can produce valid repeated frames.',
  timing: '20 s clips begin at the original approximateVideoOffsetSeconds. Page-creation wall-clock alignment is approximate; event frames are identified by both that estimate and rendered content.',
  sourceRecordings: [...sourceAudits.values()], clips: [] };
const flush = () => writeFileSync(resolve(output, 'review.json'), JSON.stringify(result, null, 2) + '\n');
flush();
for (const s of report.segments) {
  const [label, page] = s.label.split('/');
  const videoName = page === 'light' ? 'light-and-L2' : page;
  const input = report.videos.find(v => v.endsWith(`/${videoName}.webm`));
  if (!input) throw new Error(`Missing input for ${s.label}`);
  const base = `${label}-${page}`, mp4 = resolve(reviewDir, `${base}.mp4`);
  run(['-v', 'error', '-y', '-ss', String(s.approximateVideoOffsetSeconds), '-i', input,
    '-t', '20', '-vf', 'scale=min(960\\,iw):-2', '-vsync', '0', '-c:v', 'libx264', '-crf', '30',
    '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
  const audit = decodeAudit(mp4), meta = metadata(mp4);
  writeFileSync(resolve(reviewDir, `${base}.framemd5`), audit.md5);
  if (meta.durationSeconds < 19.9 || meta.durationSeconds > 20.1) throw new Error(`Unexpected clip duration: ${mp4}`);
  if (statSync(mp4).size >= 18 * 1024 * 1024) throw new Error(`Clip exceeds 18 MiB: ${mp4}`);
  const regularMoments = label === 'desktop-walk-run-chase' ? [0, 5, 8.4, 14.3, 16.5, 16.8, 17.2, 18, 19]
    : label === 'L2-dark-adaptation' ? [1.5, 4, 5.52, 5.6, 5.64, 5.8, 6.2, 7.2, 14]
    : label === 'opening-guidance' ? [0, .5, 2, 6, 6.2, 6.5, 8.5, 11.5, 13]
    : [0, 2, 4, 6, 8, 10, 12, 14, 18];
  const screenshotEvents = (s.screenshotMarks ?? []).map(m => ({
    name: m.file.split('/').at(-1), clipSeconds: Math.min(19.9, Math.max(0, (m.before.t - s.begin.t) / 1000 + .08)),
  }));
  const moments = [...new Set([...regularMoments, ...screenshotEvents.map(e => e.clipSeconds)])].sort((a, b) => a - b);
  const frames = [];
  for (const t of moments) {
    const file = resolve(reviewDir, 'frames', `${base}-${t.toFixed(2)}.png`);
    run(['-v', 'error', '-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', '-an', file]);
    frames.push({ file, clipOffsetSeconds: t, approximateOriginalVideoOffsetSeconds: s.approximateVideoOffsetSeconds + t,
      screenshotEvents: screenshotEvents.filter(e => Math.abs(e.clipSeconds - t) < .005).map(e => e.name) });
  }
  const sheet = resolve(reviewDir, `${base}-contact.png`);
  run(['-v', 'error', '-y', '-i', mp4, '-vf', 'fps=1/2,scale=320:-2,tile=5x2', '-frames:v', '1', sheet]);
  result.clips.push({ label: s.label, input, mp4, sourceVideoSha256: sourceAudits.get(input).sha256,
    sourceStartSeconds: s.approximateVideoOffsetSeconds, sourceDurationSeconds: 20,
    ...meta, bytes: statSync(mp4).size, sha256: sha(mp4), decodedFrames: audit.frames.length,
    exactDuplicateAdjacentFrames: audit.exactDuplicateAdjacentFrames,
    longestExactDuplicateRunFrames: audit.longestExactDuplicateRunFrames, freezeEvents: audit.freezeEvents,
    contactSheet: sheet, contactSheetClipOffsetsSeconds: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18], frames });
  flush();
  console.log(`${s.label}: ${meta.durationSeconds}s, ${meta.encodedFps} encoded fps, ${audit.frames.length} decoded frames, ${statSync(mp4).size} bytes`);
}
