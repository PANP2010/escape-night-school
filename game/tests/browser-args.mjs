/**
 * Shared by Playwright configs, specs and standalone Node probes.
 * Apple Silicon uses ANGLE Metal; other hosts use software WebGL with CPU page compositing.
 * ESC_GPU=1 opts Linux acceptance hosts into hardware Vulkan; ESC_SOFTWARE_GL=1 forces software on any host.
 */
export function browserArgs(extraArgs = [], {
  platform = process.platform,
  softwareGL = process.env.ESC_SOFTWARE_GL,
  gpu = process.env.ESC_GPU,
} = {}) {
  const hardware = platform === 'linux' && gpu === '1' && softwareGL !== '1';
  const software = platform !== 'darwin' || softwareGL === '1';
  const features = ['Vulkan', ...extraArgs.filter((arg) => arg.startsWith('--enable-features='))
    .flatMap((arg) => arg.slice('--enable-features='.length).split(','))];
  const backend = hardware
    ? ['--enable-gpu', '--use-angle=vulkan', `--enable-features=${[...new Set(features)].join(',')}`, '--use-vulkan=native',
      '--disable-vulkan-surface', '--no-sandbox']
    : software
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-compositing']
    : ['--use-angle=metal'];
  // SwiftShader page compositing competes with WebGL even under ?nodraw: HUD/image paints can stall for 10–20 s.
  // Keep real WebGL rendering, but composite the page on the CPU. Hardware Metal keeps GPU compositing.
  const extras = extraArgs.filter((arg) =>
    !arg.startsWith('--use-angle=') && arg !== '--enable-unsafe-swiftshader'
    && arg !== '--disable-gpu-compositing'
    && (!hardware || (!arg.startsWith('--use-vulkan=') && !arg.startsWith('--use-gl=')
      && !arg.startsWith('--enable-features=')
      && arg !== '--disable-gpu' && arg !== '--enable-gpu' && arg !== '--no-sandbox'
      && arg !== '--disable-vulkan-surface')));
  return [...backend, ...extras];
}
