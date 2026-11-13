import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { browserArgs } from '../browser-args.mjs';

const legacy = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-compositing'];
const extras = ['--renderer-process-limit=1', '--disable-gpu-compositing', '--disable-background-timer-throttling'];
const hardware = ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--use-vulkan=native',
  '--disable-vulkan-surface', '--no-sandbox'];

beforeEach(() => vi.stubEnv('ESC_GPU', ''));
afterEach(() => vi.unstubAllEnvs());

test('macOS selects Metal and keeps timing flags without the software compositing workaround', () => {
  expect(browserArgs(extras, { platform: 'darwin', softwareGL: '' })).toEqual([
    '--use-angle=metal', '--renderer-process-limit=1', '--disable-background-timer-throttling',
  ]);
  expect(extras).toContain('--disable-gpu-compositing'); // caller-owned arrays are not mutated
});

test('Linux uses CPU page compositing even when a scenario only requests software WebGL', () => {
  expect(browserArgs([], { platform: 'linux', softwareGL: '' })).toEqual(legacy);
  expect(browserArgs(extras, { platform: 'linux', softwareGL: '' })).toEqual([
    ...legacy, '--renderer-process-limit=1', '--disable-background-timer-throttling',
  ]);
});

test('ESC_SOFTWARE_GL=1 restores the complete software path on macOS', () => {
  expect(browserArgs(extras, { platform: 'darwin', softwareGL: '1' })).toEqual([
    ...legacy, '--renderer-process-limit=1', '--disable-background-timer-throttling',
  ]);
  expect(browserArgs([], { platform: 'darwin', softwareGL: '0' })).toEqual(['--use-angle=metal']);
});

test('scenario arguments cannot silently replace the centrally selected backend', () => {
  expect(browserArgs([...legacy, '--disable-gpu-vsync'], { platform: 'darwin', softwareGL: '' }))
    .toEqual(['--use-angle=metal', '--disable-gpu-vsync']);
  expect(browserArgs(['--use-angle=metal'], { platform: 'darwin', softwareGL: '1' })).toEqual(legacy);
});

test('ESC_GPU=1 selects headless Linux Vulkan without software fallback flags', () => {
  vi.stubEnv('ESC_GPU', '1');
  vi.stubEnv('ESC_SOFTWARE_GL', '');
  expect(browserArgs([...legacy, '--use-vulkan=swiftshader', '--use-gl=angle', '--disable-gpu', '--mute-audio'],
    { platform: 'linux' })).toEqual([...hardware, '--mute-audio']);
});

test('GPU opt-in does not affect other hosts and software override remains explicit', () => {
  expect(browserArgs([], { platform: 'linux', gpu: '0', softwareGL: '' })).toEqual(legacy);
  expect(browserArgs([], { platform: 'linux', gpu: '1', softwareGL: '1' })).toEqual(legacy);
  expect(browserArgs([], { platform: 'darwin', gpu: '1', softwareGL: '' })).toEqual(['--use-angle=metal']);
});

test('GPU backend keeps scenario features in the same effective feature switch', () => {
  const args = browserArgs(['--enable-features=Example,Vulkan', '--mute-audio'],
    { platform: 'linux', gpu: '1', softwareGL: '' });
  expect(args.filter((arg) => arg.startsWith('--enable-features='))).toEqual(['--enable-features=Vulkan,Example']);
  expect(args).toContain('--mute-audio');
});
