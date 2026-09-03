import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
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

// @dagsocial/types and @dagsocial/validation are written against Node.
// WEB_INTERFACE → The browser reaches @dagsocial/types through a build-time shim
// The browser has neither `crypto` nor a `Buffer` global; the client supplies
// them here and changes neither package. The bare `crypto` specifier resolves to
// the pure-TS shim, and `Buffer` — a global those packages use but never import
// — is injected from the `buffer` package wherever the bundle references it as a
// free name.
const CRYPTO_SHIM = fileURLToPath(new URL('./src/shim/crypto.ts', import.meta.url));

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
        inject({ modules: { Buffer: ['buffer', 'Buffer'] }, exclude: [/node_modules[/\\]buffer[/\\]/] }),
      ],
    },
  },
});
