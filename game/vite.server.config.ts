import { defineConfig } from 'vite';

// Server bundle: server/index.ts (+ shared/) → dist-server/index.js; node_modules stay external.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'index.js' } },
  },
});
