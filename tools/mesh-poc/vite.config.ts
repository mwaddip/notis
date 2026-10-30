// MESH_INTERFACE → Place in the workspace — the browser page's build:
// the root is `page/`, the output goes to `dist-page/`, and
// `refuseNodeBuiltins` (imported from `packages/web`'s script, never
// copied) fails the build on any Node built-in import, bare or
// `node:`-prefixed.
//
// `node:stream` aliases to `page/shims/node-stream.ts`: the one module
// in the browser graph that imports `node:stream` is
// `@libp2p/http-utils`' `stream-to-socket.js`, re-exported from the
// package's barrel, and its `Libp2pSocket` class is a Node-side server
// adapter the browser never instantiates. The stub's classes throw on
// construction, so a caller that reaches that path crashes at once.
// vite's `resolve.alias` is the one hook that runs before user
// `enforce: 'pre'` plugins, so the alias is applied before
// `refuseNodeBuiltins` sees the specifier.

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { refuseNodeBuiltins } from '../../packages/web/scripts/refuse-node-builtins.mjs';

export default defineConfig({
  root: 'page',
  resolve: {
    alias: {
      'node:stream': fileURLToPath(new URL('./page/shims/node-stream.ts', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist-page',
    emptyOutDir: true,
    target: 'es2022',
  },
  plugins: [refuseNodeBuiltins()],
});
