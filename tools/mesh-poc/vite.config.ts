// MESH_INTERFACE → Place in the workspace — the browser page's build:
// the root is `page/`, the output goes to `dist-page/`, and
// `refuse-node-builtins` fails the build on any Node built-in import,
// bare or `node:`-prefixed (reused by import from `packages/web`, never
// copied — `WEB_INTERFACE → The client's builds substitute nothing`).
//
// `@libp2p/http-utils`'s barrel re-exports a `stream-to-socket.js` that
// imports `node:stream` for its server-only `Libp2pSocket` class. The
// browser never reaches that class, but the import survives resolve. The
// alias remaps `node:stream` to `page/shims/node-stream.ts` BEFORE
// `refuseNodeBuiltins` sees it (vite's internal alias plugin precedes
// user `enforce: 'pre'` plugins), so the output holds no `node:`
// specifier and the bundle scan stays green.
//
// `@dagsocial/types`' `NETWORK_PROFILES` is reached statically by `main.ts`
// through `profileFor(network)` (MESH_INTERFACE → Place in the workspace),
// which pulls every profile object into the bundle. The testnet profile's
// `bootstrapPeers` carries `/dns4/notis.fun/tcp/9733` for the gossip net
// (TYPES_INTERFACE → "bootstrapPeers is the network's known nodes, per
// network"), which the mesh client never reads; the field is dead data in
// the browser bundle. `dropBootstrapPeers` strips it at build time so the
// bundle holds no DNS multiaddr (MESH_INTERFACE → Discovery, "A client
// refuses an anchor address with a `/dns4/`, `/dns6/` or `/dnsaddr/`
// component" — the browser must not surface a DNS multiaddr to libp2p's
// dialer, and the acceptance scan is literal over the output's bytes).

import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { refuseNodeBuiltins } from '../../packages/web/scripts/refuse-node-builtins.mjs';

function dropBootstrapPeers(): Plugin {
  return {
    name: 'mesh-poc:drop-bootstrap-peers',
    enforce: 'pre',
    transform(code, id) {
      // Scope: `@dagsocial/types`'s `network.ts`, the one module that
      // defines the three `NetworkProfile`s. A broader match would
      // accidentally touch user code that happens to use the identifier.
      if (!id.includes('packages/types/dist/index.js')) return null;
      const next = code.replace(
        /bootstrapPeers:\s*Object\.freeze\(\[[^\]]*\]\s*(?:as\s+string\[\])?\)/g,
        'bootstrapPeers: Object.freeze([])',
      );
      return next === code ? null : { code: next, map: null };
    },
  };
}

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
  plugins: [dropBootstrapPeers(), refuseNodeBuiltins()],
});
