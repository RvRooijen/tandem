import { defineConfig } from 'vite';

// The game on its own, without the engine: npm run game (dev) or npm run game:build.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  esbuild: { target: 'es2022' },
  build: { target: 'es2022', outDir: '../../dist/gnome-garden', emptyOutDir: true },
  optimizeDeps: { exclude: ['archetype-ecs'] },
  server: { port: 5184, fs: { strict: false }, watch: { usePolling: true, interval: 500 } },
});
