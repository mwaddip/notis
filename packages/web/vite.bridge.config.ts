import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The extension's *bridge* build — lib mode, ONE IIFE file with no `import`,
// so the browser injects it at `document_start` as a classic content script.
// WEB_INTERFACE → "The background is one classic file with no `import`" — the
// bridge is built the same way. The bridge imports only pure modules; it needs
// neither the `crypto` alias nor the `Buffer` inject, and a build that
// disagrees is a finding.

export default defineConfig({
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
