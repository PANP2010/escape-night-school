import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Keep the shared node_modules tree read-only and skip the game's unused entry graph.
export default defineConfig({
  root: fileURLToPath(new URL('./client', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./test-results/spatial-audio/vite-cache', import.meta.url)),
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', port: 4453, strictPort: true, hmr: false },
});
