import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { refuseNodeBuiltins } from './scripts/refuse-node-builtins.mjs';

// The extension's *bridge* build — lib mode, ONE IIFE file with no `import`,
// so the browser injects it at `document_start` as a classic content script
// (WEB_INTERFACE → "The background is one classic file with no `import`"
// — the bridge is built the same way).
// WEB_INTERFACE → The client's builds substitute nothing.

export default defineConfig({
  plugins: [refuseNodeBuiltins()],
  build: {
    outDir: process.env['NOTIS_EXT_OUTDIR'] ?? 'dist-extension',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/extension/bridge.ts'),
      formats: ['iife'],
      name: 'NotisBridge',
      fileName: () => 'bridge.js',
    },
  },
});
