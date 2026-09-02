import { defineConfig } from 'vite';

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

export default defineConfig({
  server: {
    proxy: Object.fromEntries(
      API_PATHS.map((p) => [p, { target: NODE_ORIGIN, changeOrigin: true }]),
    ),
  },
});
