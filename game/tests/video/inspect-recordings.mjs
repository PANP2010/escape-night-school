// Read container metadata and export representative decoded video frames. No browser is started.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(gameRoot, process.env.ESC_VIDEO_OUTPUT ?? 'test-results/video-acceptance');
const ffmpeg = process.argv[2];
if (!ffmpeg || !existsSync(ffmpeg)) throw new Error('Pass an existing ffmpeg executable as the first argument; no tools are installed');
const report = JSON.parse(readFileSync(resolve(output, 'report.json'), 'utf8'));
const results = [];
mkdirSync(resolve(output, 'decoded-frames'), { recursive: true });
for (const video of report.videos) {
  let metadata;
  try { execFileSync(ffmpeg, ['-hide_banner', '-i', video], { encoding: 'utf8' }); }
  catch (error) { metadata = String(error.stderr ?? ''); }
  const duration = metadata.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!duration) throw new Error(`Container duration unavailable: ${video}`);
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  const stream = metadata.split('\n').find(line => line.includes('Video:')) ?? '';
  const base = video.split('/').at(-1).replace(/\.webm$/, '');
  const frames = [];
  for (const [label, fraction] of [['early', .25], ['middle', .5], ['late', .75]]) {
    const at = Math.min(seconds - .1, Math.max(0, seconds * fraction));
    const file = resolve(output, 'decoded-frames', `${base}-${label}.png`);
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', video,
      '-frames:v', '1', '-an', file]);
    frames.push({ file, encodedVideoOffsetSeconds: at });
  }
  results.push({ video, bytes: statSync(video).size, durationSeconds: seconds,
    videoStream: stream.trim(), encodedFps: Number(stream.match(/([\d.]+) fps/)?.[1]) || null,
    hasAudioStream: /Stream.*Audio:/.test(metadata), frames });
}
const result = { note: 'Container/encoder fps is not measured game FPS. Game FPS comes exclusively from native rAF in report.json.', recordings: results };
writeFileSync(resolve(output, 'recordings.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
