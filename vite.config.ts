import { defineConfig } from 'vite';

// Tandem's own page: the project in a frame, the tools over it. Everything under /api/ goes to the core.
export default defineConfig({
  root: 'shell',
  base: './',
  esbuild: { target: 'es2022' },
  build: { target: 'es2022', outDir: '../dist', emptyOutDir: true },
  optimizeDeps: { exclude: ['archetype-ecs'] },
  server: {
    // IPv4 loopback: a phone's browser looks for localhost there, and node on its own picks IPv6 only.
    host: '127.0.0.1',
    port: Number(process.env.TANDEM_SHELL_PORT ?? 5173),
    // Never drift to another port quietly: pixeldraw's viewer wants this one too, and only one of them can have it.
    strictPort: true,
    fs: { strict: false },
    watch: { usePolling: true, interval: 500 },
    // With the slash: the shell has a module called api.ts, which is not the core's to answer.
    // And /starting to start.ts, which says what the core is doing while it cannot answer yet.
    proxy: {
      '/api/': {
        target: `http://127.0.0.1:${process.env.TANDEM_PORT ?? 5201}`, changeOrigin: false,
        // When the core goes away in the middle of an answer (the event stream, when it starts again), the answer
        // ends here too; otherwise the page goes on listening to nothing.
        configure: (proxy) => proxy.on('proxyRes', (from, _req, res) => from.on('close', () => { if (!from.complete && !res.writableEnded) res.destroy(); })),
      },
      '/starting': { target: `http://127.0.0.1:${process.env.TANDEM_STATUS_PORT ?? 5202}`, changeOrigin: false },
    },
  },
});
