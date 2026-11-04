// MESH_INTERFACE → Place in the workspace — the browser page's build:
// the root is `page/`, the output goes to `dist-page/`, and
// `refuseNodeBuiltins` (imported from `packages/web`'s script, never
// copied) fails the build on any Node built-in import, bare or
// `node:`-prefixed. net's `@libp2p/http-utils` patch keeps
// `stream-to-socket.js` out of the browser's import graph, so this
// build needs no `node:stream` alias.

import { defineConfig } from 'vite';
import { refuseNodeBuiltins } from '../../packages/web/scripts/refuse-node-builtins.mjs';

export default defineConfig({
  root: 'page',
  build: {
    outDir: '../dist-page',
    emptyOutDir: true,
    target: 'es2022',
  },
  plugins: [refuseNodeBuiltins()],
});
