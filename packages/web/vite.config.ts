import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import inject from '@rollup/plugin-inject';

// The client is served same-origin with the API it reads — the node sends no
// CORS headers (WEB_INTERFACE → "The client is served from the node's own
// origin"). In development that origin is this dev server, which proxies the
// bare API paths through to the node. In production nginx fronts both.
//
// A dev node listens on 3000 (packages/node/scripts/dev.mjs → httpPort). Set
// NOTIS_NODE to point the proxy elsewhere.
const NODE_ORIGIN = process.env['NOTIS_NODE'] ?? 'http://localhost:3000';

// The read surface's routes, mounted bare on the node: GET /posts, /posts/:id,
// /posts/:id/thread, /status, /blocks/current. Proxied so the browser sees them
// as same-origin.
const API_PATHS = ['/posts', '/status', '/blocks'];

// @dagsocial/types is written against Node — createHash and generateKeyPairSync
// from `crypto`, and `Buffer` as a global it never imports. The browser has
// neither; the client supplies them at build time and changes the package not at
// all (WEB_INTERFACE → The browser reaches @dagsocial/types through a build-time shim).
//
// Both substitutes are pinned by ABSOLUTE path, never a bare specifier: a bare
// specifier resolves from the importing module — a file inside @dagsocial/types,
// which declares no such dependency — so it lands on the Node builtin and the
// browser build externalizes it to nothing. `crypto` aliases to the shim;
// `Buffer` injects from the buffer package wherever the bundle references it free.
// WEB_INTERFACE → "A substituted module is pinned by absolute path, never by a bare specifier"
const CRYPTO_SHIM = fileURLToPath(new URL('./src/shim/crypto.ts', import.meta.url));
// The trailing slash forces package resolution: `resolve('buffer')` would return
// the Node builtin's own name, not the buffer package's absolute path.
const BUFFER_MODULE = createRequire(import.meta.url).resolve('buffer/');

export default defineConfig({
  resolve: {
    // Only the bare specifier: `node:crypto` (the equivalence test's escape hatch
    // to real Node crypto) and any `crypto-*` package are left untouched.
    alias: [{ find: /^crypto$/, replacement: CRYPTO_SHIM }],
  },
  server: {
    proxy: Object.fromEntries(
      API_PATHS.map((p) => [p, { target: NODE_ORIGIN, changeOrigin: true }]),
    ),
  },
  build: {
    rollupOptions: {
      // A free `Buffer` becomes an import of the buffer package's Buffer — never a
      // global mutation, and skipped inside the buffer package itself.
      plugins: [
        inject({ modules: { Buffer: [BUFFER_MODULE, 'Buffer'] }, exclude: [/node_modules[/\\]buffer[/\\]/] }),
      ],
    },
  },
});
