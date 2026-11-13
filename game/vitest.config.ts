import { defineConfig } from 'vitest/config';

export default defineConfig({
  // several suites are deterministic but CPU-heavy (campus collider build, skinned-mesh bounds sampled over
  // seconds of animation, 4-player bandwidth sim): 5–8 s each once 42 files share 4 cores, so the 5 s default
  // times them out at random; 30 s still catches a real hang
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node', testTimeout: 30_000, maxWorkers: 1 },
});
