// MESH_INTERFACE → Place in the workspace — the browser page's build:
// the root is `page/`, the output goes to `dist-page/`, and
// `refuse-node-builtins` fails the build on any Node built-in import,
// bare or `node:`-prefixed (reused by import from `packages/web`, never
// copied — `WEB_INTERFACE → The client's builds substitute nothing`).
//
// `node:stream` alias — pending main's direction. The chain is:
// `src/http-fetch.ts` → `@libp2p/http-fetch` → that package's
// `read-response.js` and `send-request.js` import from `@libp2p/http-utils`
// (its barrel), which `export * from "./stream-to-socket.js"`, which
// `import { Duplex } from 'node:stream'`. `@libp2p/http-utils`'s own
// `package.json` carries `"browser": { "node:stream": "readable-stream" }`,
// but vite's internal resolver runs AFTER user `enforce: 'pre'` plugins,
// so `refuseNodeBuiltins` sees `node:stream` first and fails the build.
// vite's `resolve.alias` is the one hook that runs before user pre-plugins;
// the alias here is a project-level stand-in for the browser-field remap
// the package itself declares. Removing it reaches the "stop and report"
// branch of main's review until a direct replacement for `@libp2p/http-fetch`'s
// request/response pair is written.

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
