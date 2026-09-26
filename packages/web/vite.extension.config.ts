import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { refuseNodeBuiltins } from './scripts/refuse-node-builtins.mjs';

// The extension's *pages* build — `index.html` and `extension/prompt.html` as
// entries, ESM, `base: './'` — so both build targets share the plugin the web
// build uses (WEB_INTERFACE → The client's builds substitute nothing). The
// background is built with vite.background.config.ts alongside.

export default defineConfig({
  base: './',
  plugins: [refuseNodeBuiltins()],
  build: {
    // Top-level await lives in main.ts's identity swap; both browsers'
    // minimum versions (Chrome 112, Firefox 121) support it.
    target: 'es2022',
    outDir: process.env['NOTIS_EXT_OUTDIR'] ?? 'dist-extension',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        prompt: resolve(__dirname, 'prompt.html'),
      },
    },
  },
});
