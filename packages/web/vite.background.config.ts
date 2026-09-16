import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import inject from '@rollup/plugin-inject';
import { resolve } from 'node:path';

// The extension's *background* build — lib mode, ONE IIFE file with no
// `import`, so Chrome runs it as a service worker and Firefox as an event-page
// script (WEB_INTERFACE → "The background is one classic file with no
// `import`", built in lib mode).

const CRYPTO_SHIM = fileURLToPath(new URL('./src/shim/crypto.ts', import.meta.url));
const BUFFER_MODULE = createRequire(import.meta.url).resolve('buffer/');

export default defineConfig({
  resolve: {
    alias: [{ find: /^crypto$/, replacement: CRYPTO_SHIM }],
  },
  build: {
    outDir: process.env['NOTIS_EXT_OUTDIR'] ?? 'dist-extension',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/extension/background.ts'),
      formats: ['iife'],
      name: 'NotisBackground',
      fileName: () => 'background.js',
    },
    rollupOptions: {
      plugins: [
        inject({ modules: { Buffer: [BUFFER_MODULE, 'Buffer'] }, exclude: [/node_modules[/\\]buffer[/\\]/] }),
      ],
    },
  },
});
