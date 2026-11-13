import { defineConfig } from 'vite';

// The shell: the phone page. Everything under /api goes to the core server.
export default defineConfig({
  root: 'shell',
  base: './',
  esbuild: { target: 'es2022' },
  build: { target: 'es2022', outDir: '../dist', emptyOutDir: true },
  optimizeDeps: { exclude: ['archetype-ecs'] },
  server: {
    port: 5200,
    fs: { strict: false },
    watch: { usePolling: true, interval: 500 },
    proxy: { '/api': { target: 'http://127.0.0.1:5201', changeOrigin: false } },
  },
});
