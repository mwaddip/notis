import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import inject from '@rollup/plugin-inject';
import { resolve } from 'node:path';

// The extension's *pages* build — `index.html` and `extension/prompt.html` as
// entries, ESM, `base: './'` — so both build targets share the same alias +
// Buffer inject the web build uses (WEB_INTERFACE → "The browser reaches
// @dagsocial/types through a build-time shim"). The background is built with
// vite.background.config.ts alongside.

const CRYPTO_SHIM = fileURLToPath(new URL('./src/shim/crypto.ts', import.meta.url));
const BUFFER_MODULE = createRequire(import.meta.url).resolve('buffer/');

export default defineConfig({
  base: './',
  resolve: {
    alias: [{ find: /^crypto$/, replacement: CRYPTO_SHIM }],
  },
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
      plugins: [
        inject({ modules: { Buffer: [BUFFER_MODULE, 'Buffer'] }, exclude: [/node_modules[/\\]buffer[/\\]/] }),
      ],
    },
  },
});
