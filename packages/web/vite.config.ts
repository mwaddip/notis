import { defineConfig } from 'vite';
import { refuseNodeBuiltins } from './scripts/refuse-node-builtins.mjs';

// The client's default API base is same-origin
// (WEB_INTERFACE → The client is served from the node's own origin), so the dev
// server proxies the bare API paths for the default to hold. In production
// nginx or another front does the same, or the client is pointed at a node on
// any origin — the node answers every origin (NODE_INTERFACE → Cross-origin requests).
//
// A dev node listens on 3000 (packages/node/scripts/dev.mjs → httpPort). Set
// NOTIS_NODE to point the proxy elsewhere.
const NODE_ORIGIN = process.env['NOTIS_NODE'] ?? 'http://localhost:3000';

// The faucet is a separate service, not on the node's API prefix
// (NODE_INTERFACE → Faucet); its dev target is NOTIS_FAUCET, carried by the proxy
// only when set. http-proxy prepends the target's path, so the client's
// /faucet/karma against a target holding the deploy's /testnet/faucet prefix
// doubles to /testnet/faucet/faucet/karma — a 404 — unless the /faucet prefix is
// stripped first; stripped, it resolves to /testnet/faucet/karma, the faucet's own
// route (a 400 for a bad body). The rewrite strips it.
const FAUCET_ORIGIN = process.env['NOTIS_FAUCET'];

// In development the client's faucet base follows its proxy: when NOTIS_FAUCET
// wires the proxy above, VITE_FAUCET_BASE defaults to /faucet, so the one knob
// carries both the proxy target and the base the client reads. An explicit
// VITE_FAUCET_BASE still wins — the deploy recipe bakes it. Vite's loadEnv reads
// VITE_-prefixed variables from process.env after this config module is
// evaluated, so a default set here reaches import.meta.env.VITE_FAUCET_BASE.
// WEB_INTERFACE → "A faucet is a fact of the deployment, not of the network"
if (FAUCET_ORIGIN && !process.env['VITE_FAUCET_BASE']) {
  process.env['VITE_FAUCET_BASE'] = '/faucet';
}

// Defaults so no %VITE_…% literal survives in the built shell
// (WEB_INTERFACE → The client is served from the node's own origin).
if (!process.env['VITE_WEB_BASE']) process.env['VITE_WEB_BASE'] = '/';
if (!process.env['VITE_API_BASE']) process.env['VITE_API_BASE'] = '';
if (!process.env['VITE_FAUCET_BASE']) process.env['VITE_FAUCET_BASE'] = '';
if (!process.env['VITE_PUBLIC_ORIGIN']) process.env['VITE_PUBLIC_ORIGIN'] = '';
if (!process.env['VITE_NETWORK']) process.env['VITE_NETWORK'] = '';

// The API paths mounted bare on the node, proxied so the client's same-origin
// default holds in development
// (WEB_INTERFACE → The client is served from the node's own origin). The read
// routes (/posts, /status, /blocks) and the write surface's: /karma the spendable
// view and /likes, plus /credits, /vouches, /invites and /usernames whose builders
// arrive with their interface.
const API_PATHS = ['/posts', '/status', '/blocks', '/karma', '/credits', '/likes', '/vouches', '/invites', '/usernames'];

// WEB_INTERFACE → The client's builds substitute nothing.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [refuseNodeBuiltins()],
  server: {
    proxy: {
      ...Object.fromEntries(API_PATHS.map((p) => [p, { target: NODE_ORIGIN, changeOrigin: true }])),
      ...(FAUCET_ORIGIN
        ? { '/faucet': { target: FAUCET_ORIGIN, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/faucet/, '') } }
        : {}),
    },
  },
}));
