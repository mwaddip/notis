import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { refuseNodeBuiltins } from './scripts/refuse-node-builtins.mjs';

// The extension's *background* build — lib mode, ONE IIFE file with no
// `import`, so Chrome runs it as a service worker and Firefox as an event-page
// script (WEB_INTERFACE → "The background is one classic file with no
// `import`", built in lib mode).
// WEB_INTERFACE → The client's builds substitute nothing.

export default defineConfig({
  plugins: [refuseNodeBuiltins()],
  build: {
    outDir: process.env['NOTIS_EXT_OUTDIR'] ?? 'dist-extension',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/extension/background.ts'),
      formats: ['iife'],
      name: 'NotisBackground',
      fileName: () => 'background.js',
    },
  },
});
