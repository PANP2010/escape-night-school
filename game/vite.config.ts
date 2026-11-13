import { defineConfig } from 'vite';
import release from './client/public/version.json' with { type: 'json' };

// Client bundle: client/ → dist/ (served by the game server).
export default defineConfig({
  root: 'client',
  // The same record is embedded in this client and copied unchanged to dist/version.json.
  define: { __GAME_RELEASE__: JSON.stringify(release) },
  build: {
    outDir: '../dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1000,
    // Ship CSS intact: shared installs may lack Vite 8's native Lightning CSS minifier.
    // CSS bundling and JavaScript minification still run normally.
    cssMinify: false,
  },
  server: { proxy: { '/ws': { target: 'ws://localhost:4100', ws: true } } },
});
