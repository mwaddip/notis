#!/usr/bin/env node
// The extension proof — the twelve steps of WEB_INTERFACE → The extension
// plus the four links-into-the-extension steps, the verified-tip block
// (17a · 17 · 17b · 18 · 19a · 19b · 19c · 20), the verified-figures block
// (21 · 24 · 22a · 22b · 23 · 25) and the verified-names block (26 · 29 · 30),
// each read verbatim, over raw CDP against a live devnet stack. Drives the
// App's real UI on the extension's own page: the composer, the like word, the
// profile and wallet windows' rows, and the prompt window found by its
// `prompt.html?id=` URL. The verified-tip block runs against a second stack
// the harness owns — node B (server, bootstrapped from A), node C (used for
// the real-fork test in 19b), node D (isolated, 17a's too-short and 19c's
// share-no-block) and the lying relay (19a). The verified-figures block brings
// up a B of its own and, for its three lie arms, the figures relay
// (22a · 22b · 23). The verified-names block brings up a B of its own too.
//
// Preconditions:
//  1. `node packages/node/dist/index.js` running as `NETWORK_TYPE=devnet`
//     with a miner, or `packages/node/scripts/dev.mjs`. Its miner is the
//     operator's; the harness never signals it.
//  2. The faucet running against that node with the devnet key (only when
//     --r-key is given).
//  3. `promote.mjs` has printed R's public and pkcs8-hex; R's clear file
//     (`{ pubKeyHex, privKeyBase64 }`) lives in a scratch path outside the
//     repo and never enters a commit, a log or the REPORT.
//  4. The extension was built via build-extension.sh with devnet values
//     (VITE_NODES points at [A, B]).
//  5. For --verified-names: a second throwaway S promoted as R is, holding a
//     name `claim-name.mjs` (beside this file) claimed; S's clear file lives
//     in a scratch path as R's does, and the harness reads its public key
//     alone.
//
// Modes:
//   --verified-tip alone: 1–16 read NOT RUN, 17a–20 run.
//   --r-key: 1–12 run, then 13–16 with --public and --web-dist (NOT RUN
//     without them); then each block below runs on its flag, in this order,
//     and reads NOT RUN by name without it.
//   --verified-tip: 17a–20.
//   --verified-figures: 21·24·22a·22b·23·25. The figures run hangs on
//     a verified tip (WEB_INTERFACE → The extension → "The verified figures"),
//     which needs a second verified node, so the figures block runs B as the
//     tip block does; hence --verified-figures requires --node-dist, --scratch
//     and --node-p2p as well as --r-key (config error at the top otherwise, as
//     --verified-tip is with its own four).
//   --verified-names: 26·29·30. A name check proves against the verified tip's
//     anchor (WEB_INTERFACE → The extension → "The verified names"), so the
//     block runs a B of its own and requires what --verified-figures requires,
//     and --s-key: 29 sends to S's handle.
//   20, 25 and 30 read the hosted web build, and read NOT RUN without --public
//     and --web-dist.
//   No --r-key and no --verified-tip: every step reads NOT RUN by name.
//
// Usage:
//   node scripts/extension-check/run.mjs \
//     --extension-dir <path> [--r-key <path>] --node <origin> --faucet <origin> \
//     [--verified-tip --node-dist <path> --miner <path> --scratch <dir> --node-p2p <multiaddr>] \
//     [--verified-figures --node-dist <path> --scratch <dir> --node-p2p <multiaddr>] \
//     [--verified-names --s-key <path> --node-dist <path> --scratch <dir> --node-p2p <multiaddr>] \
//     [--public <origin+base> --web-dist <dir>]

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { matchPatternFor } from '../../extension/match-pattern.mjs';

// Boolean flags — never consume the next argument. Without this the parser
// below reads the following flag as the flag's value, and every arg after
// `--verified-tip` shifts by one silently.
const BOOLEAN_FLAGS = new Set(['verified-tip', 'verified-figures', 'verified-names']);
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const name = arg.slice(2);
  if (BOOLEAN_FLAGS.has(name)) { args.set(name, true); continue; }
  args.set(name, process.argv[++i]);
}
const EXT_DIR = args.get('extension-dir');
const R_KEY = args.get('r-key');
const NODE = args.get('node') ?? 'http://localhost:3300';
const FAUCET = args.get('faucet') ?? 'http://localhost:3103';
const EXT_ID = args.get('extension-id') ?? 'kafmnekclgkjnkhnbafdoefnlllboddm';
const PUBLIC = args.get('public') ?? null;
const WEB_DIST = args.get('web-dist') ?? null;
const PASSPHRASE = 'proof-pass';

// The verified-tip block — WEB_INTERFACE → The extension → "The verified tip",
// steps 17a · 17 · 17b · 18 · 19a · 19b · 19c · 20. Absent, they read NOT RUN
// by name, as 13–16 do without --public / --web-dist.
const VERIFIED_TIP = args.get('verified-tip') === true;
// The verified-figures block — WEB_INTERFACE → The extension → "The verified
// figures", steps 21 · 24 · 22a · 22b · 23 · 25: the honest states read A, and
// the three lie arms read the figures relay. Absent, every step reads NOT RUN
// by name.
const VERIFIED_FIGURES = args.get('verified-figures') === true;
// The verified-names block — WEB_INTERFACE → The extension → "The verified
// names", steps 26 · 29 · 30: a claimed name in ink on every surface, a send
// to S's handle, the hosted web build. Absent, every step reads NOT RUN by
// name.
const VERIFIED_NAMES = args.get('verified-names') === true;
// S's clear file — its public key is the recipient step 29 expects.
const S_KEY = args.get('s-key') ?? null;
const NODE_DIST = args.get('node-dist') ?? null;
const MINER_SCRIPT = args.get('miner') ?? null;
const SCRATCH = args.get('scratch') ?? null;
const NODE_P2P = args.get('node-p2p') ?? null; // A's p2p multiaddr — the bootstrap for B and for C's first life
// The harness's own ports for its spawned children (17–20's stack). Kept
// clear of Chrome's debugger range (19200–19699), the e2e range (11000–12899)
// and the dagsocial-miner unit's testnet ports.
const B_HTTP_PORT = 19770;
const B_ADMIN_PORT = 19771;
const B_P2P_PORT = 19772;
const B_ORIGIN = `http://127.0.0.1:${B_HTTP_PORT}`;
const RELAY_PORT = 19780;
const RELAY_ORIGIN = `http://127.0.0.1:${RELAY_PORT}`;
// The figures relay — the lie arms 22a · 22b · 23, on a port of its own beside
// 19a's relay.
const FIG_RELAY_PORT = 19785;
const FIG_RELAY_ORIGIN = `http://127.0.0.1:${FIG_RELAY_PORT}`;
const C_HTTP_PORT = 19790;
const C_ADMIN_PORT = 19791;
const C_P2P_PORT = 19792;
// C's second life listens on a fresh port, cut off from A: A's peer store
// carries C's first-life address, so a new port makes that stale and A cannot
// reach C — combined with MAX_PEERS=0 and BOOTSTRAP_PEERS="" on C, the three
// assertions of step 19b then read peers_connected=0.
const C_P2P_PORT_ISOLATED = 19793;
const C_ORIGIN = `http://127.0.0.1:${C_HTTP_PORT}`;
// Node D — the isolated helper for 17a (too-short) and 19c (no shared block).
const D_HTTP_PORT = 19795;
const D_ADMIN_PORT = 19796;
const D_P2P_PORT = 19797;
const D_ORIGIN = `http://127.0.0.1:${D_HTTP_PORT}`;
// The devnet faucet's public key — devnet-only and public by design: the key
// steps 12 and 21 send to, and the owner of the real box the figures relay
// lists under R's key in step 22b.
const DEVNET_FAUCET_KEY = '5468d985c3924a95f3d3dc98b67a41ac2c7cc4cfca4fcbf7c5627452f1617f36';

if (!EXT_DIR || !existsSync(EXT_DIR)) { console.error('missing --extension-dir'); process.exit(2); }
// --r-key is optional. Without it, steps 1–16 read NOT RUN by name and 17–20
// (which need no identity — WEB_INTERFACE → The extension → "The verified
// tip": the corner needs no identity) run on the flag. A given but missing
// file is still an argument error.
if (R_KEY && !existsSync(R_KEY)) { console.error(`--r-key not found: ${R_KEY}`); process.exit(2); }

// --verified-tip requires the four lifecycle arguments — the harness owns node
// B, node C, node D, the lying relay and every miner it starts; A itself and
// A's miner are the operator's (WEB_INTERFACE → The extension → "The verified tip").
if (VERIFIED_TIP) {
  if (!NODE_DIST || !existsSync(NODE_DIST)) {
    console.error('--verified-tip requires --node-dist <packages/node/dist/index.js>');
    process.exit(2);
  }
  if (!MINER_SCRIPT || !existsSync(MINER_SCRIPT)) {
    console.error('--verified-tip requires --miner <packages/node/scripts/miner.mjs>');
    process.exit(2);
  }
  if (!SCRATCH) {
    console.error('--verified-tip requires --scratch <dir> — a directory the harness owns');
    process.exit(2);
  }
  if (!existsSync(SCRATCH)) {
    console.error(`--scratch not found: ${SCRATCH}`);
    process.exit(2);
  }
  if (!NODE_P2P || !NODE_P2P.startsWith('/ip4/')) {
    console.error('--verified-tip requires --node-p2p <multiaddr> — A\'s p2p bootstrap, e.g. /ip4/127.0.0.1/tcp/19742');
    process.exit(2);
  }
}

// --verified-figures requires --r-key AND the lifecycle args `bringUpNodeB`
// reads (--node-dist, --scratch, --node-p2p). The figures run hangs on a
// verified tip (WEB_INTERFACE → The extension → "The verified figures"),
// which needs a second verified node, so the block runs B as the tip block
// does — using bringUpNodeB verbatim (SCRATCH, NODE_DIST, NODE_P2P). Step 25
// uses --public/--web-dist when they are given and reads NOT RUN by name
// when they are not.
if (VERIFIED_FIGURES) {
  if (!R_KEY) {
    console.error('--verified-figures requires --r-key <path> — R\'s identity is what steps 21 and 24 measure');
    process.exit(2);
  }
  if (!NODE_DIST || !existsSync(NODE_DIST)) {
    console.error('--verified-figures requires --node-dist <packages/node/dist/index.js> — bringUpNodeB spawns B from it');
    process.exit(2);
  }
  if (!SCRATCH) {
    console.error('--verified-figures requires --scratch <dir> — bringUpNodeB writes b.db there');
    process.exit(2);
  }
  if (!existsSync(SCRATCH)) {
    console.error(`--scratch not found: ${SCRATCH}`);
    process.exit(2);
  }
  if (!NODE_P2P || !NODE_P2P.startsWith('/ip4/')) {
    console.error('--verified-figures requires --node-p2p <multiaddr> — A\'s p2p bootstrap for B, e.g. /ip4/127.0.0.1/tcp/19742');
    process.exit(2);
  }
}

// --verified-names requires what --verified-figures requires, for the same
// reason — a name check proves against the verified tip's anchor, which needs
// a second verified node (WEB_INTERFACE → The extension → "The verified
// names") — and --s-key, S's clear file: step 29 sends to S's handle and reads
// S's public key beneath the field and on the prompt. The harness reads that
// key alone and signs nothing as S. Step 30 uses --public/--web-dist when they
// are given and reads NOT RUN by name when they are not.
let S_PUB = null;
if (VERIFIED_NAMES) {
  if (!R_KEY) {
    console.error('--verified-names requires --r-key <path> — R claims the name step 26 reads and sends in step 29');
    process.exit(2);
  }
  if (!NODE_DIST || !existsSync(NODE_DIST)) {
    console.error('--verified-names requires --node-dist <packages/node/dist/index.js> — bringUpNodeB spawns B from it');
    process.exit(2);
  }
  if (!SCRATCH) {
    console.error('--verified-names requires --scratch <dir> — bringUpNodeB writes b.db there');
    process.exit(2);
  }
  if (!existsSync(SCRATCH)) {
    console.error(`--scratch not found: ${SCRATCH}`);
    process.exit(2);
  }
  if (!NODE_P2P || !NODE_P2P.startsWith('/ip4/')) {
    console.error('--verified-names requires --node-p2p <multiaddr> — A\'s p2p bootstrap for B, e.g. /ip4/127.0.0.1/tcp/19742');
    process.exit(2);
  }
  if (!S_KEY || !existsSync(S_KEY)) {
    console.error('--verified-names requires --s-key <path> — S\'s clear file { pubKeyHex, privKeyBase64 }; step 29 sends to S\'s handle');
    process.exit(2);
  }
  S_PUB = JSON.parse(readFileSync(S_KEY, 'utf8')).pubKeyHex ?? null;
  if (typeof S_PUB !== 'string' || !/^[0-9a-f]{64}$/.test(S_PUB)) {
    console.error(`--s-key holds no 64-hex pubKeyHex: ${S_KEY}`);
    process.exit(2);
  }
}

// --public and --web-dist come together — pass both or neither. Without them
// the twelve run as today and steps 13–16 are reported NOT RUN by name
// (WEB_INTERFACE → The extension → "Links into the extension").
if ((PUBLIC === null) !== (WEB_DIST === null)) {
  console.error('--public and --web-dist come together — pass both or neither');
  process.exit(2);
}
let publicOrigin = null;
let publicBase = null;
let publicPort = null;
let webDistAbs = null;
if (PUBLIC !== null) {
  let u;
  try { u = new URL(PUBLIC); } catch { console.error(`--public must be a URL, got: ${PUBLIC}`); process.exit(2); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { console.error('--public must be http:/https:'); process.exit(2); }
  if (!u.pathname.endsWith('/')) { console.error('--public must end with \'/\''); process.exit(2); }
  if (u.search !== '' || u.hash !== '') { console.error('--public must carry no query or fragment'); process.exit(2); }
  if (u.port === '') { console.error('--public must name a port'); process.exit(2); }
  publicOrigin = u.origin;
  publicBase = u.pathname;
  publicPort = Number(u.port);
  if (!existsSync(WEB_DIST)) { console.error(`--web-dist not found: ${WEB_DIST}`); process.exit(2); }
  webDistAbs = resolve(WEB_DIST);
  if (!existsSync(join(webDistAbs, 'index.html'))) { console.error(`--web-dist has no index.html: ${webDistAbs}`); process.exit(2); }
}

// Grant two loopback origins on the *unpacked* manifest — CDP cannot drive the
// browser's permission dialog, so the App's fetch to the faucet is refused at
// the network layer even after step 11 stubs `chrome.permissions.request` true.
// The tracked template (`extension/manifest.template.json`) and the packed
// release manifest are untouched.
const MANIFEST_PATH = join(EXT_DIR, 'manifest.json');
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const LOOPBACKS = ['http://127.0.0.1/*', 'http://localhost/*'];
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...LOOPBACKS])];
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest patched: host_permissions += ${JSON.stringify(LOOPBACKS)}`);

// The build's faucet base is the shell's `notis-faucet` — WEB_INTERFACE →
// "The faucet step". prefs.faucet reads it once at load, and the press's
// permission ask uses that value. A build whose meta does not match --faucet
// would die at step 11 with no word why, so fail fast here and name it. The
// check is skipped in verified-tip-only mode (no --r-key) where step 11 does
// not run.
const SHELL_PATH = join(EXT_DIR, 'index.html');
const shellHtml = readFileSync(SHELL_PATH, 'utf8');
if (R_KEY) {
  const faucetMetaMatch = shellHtml.match(/<meta[^>]+name="notis-faucet"[^>]+content="([^"]*)"[^>]*>/);
  const shellFaucet = faucetMetaMatch ? faucetMetaMatch[1] : null;
  if (shellFaucet !== FAUCET) {
    console.error(`FAIL: shell notis-faucet="${shellFaucet}" != --faucet="${FAUCET}"`);
    console.error(`      rebuild with VITE_FAUCET_BASE=${FAUCET} bash packages/web/scripts/build-extension.sh`);
    process.exit(2);
  }
  console.log(`shell notis-faucet=${shellFaucet} matches --faucet`);
}

// The build's network is the shell's `notis-network` — WEB_INTERFACE →
// The extension → "The verified tip". Every block that reads a verified tip —
// 17–20, the figures block, the names block — refuses to run against a bundle
// whose profile disagrees: an extension built for testnet's profile against a
// devnet chain would read *this node's proof did not verify* for every reading
// node, and a green step would be a lie about the check.
// The bundle's `notis-nodes` must be exactly [A, B] — the harness owns B, and
// index 0 (the reading node's default) is A the operator's.
if (VERIFIED_TIP || VERIFIED_FIGURES || VERIFIED_NAMES) {
  const networkMetaMatch = shellHtml.match(/<meta[^>]+name="notis-network"[^>]+content="([^"]*)"[^>]*>/);
  const shellNetwork = networkMetaMatch ? networkMetaMatch[1] : null;
  if (shellNetwork !== 'devnet') {
    console.error(`FAIL: shell notis-network="${shellNetwork}" != "devnet"`);
    console.error(`      rebuild with VITE_NETWORK=devnet bash packages/web/scripts/build-extension.sh`);
    process.exit(2);
  }
  console.log(`shell notis-network=${shellNetwork} matches "devnet"`);

  // Vite wraps a `content=` value carrying `"` in single quotes, and one
  // carrying `'` in double quotes; the meta for notis-nodes is a JSON array
  // so single-quoted. Match either style.
  const nodesMetaMatch = shellHtml.match(/<meta[^>]+name="notis-nodes"[^>]+content=(?:"([^"]*)"|'([^']*)')[^>]*>/);
  const shellNodesRaw = nodesMetaMatch ? (nodesMetaMatch[1] ?? nodesMetaMatch[2]) : null;
  let shellNodes = null;
  try { shellNodes = JSON.parse(shellNodesRaw ?? ''); } catch {}
  const expectedNodes = [NODE.replace(/\/+$/, ''), B_ORIGIN];
  const seen = Array.isArray(shellNodes) ? shellNodes.map((s) => String(s).replace(/\/+$/, '')) : null;
  const nodesOk = Array.isArray(seen) && seen.length === expectedNodes.length && seen.every((v, i) => v === expectedNodes[i]);
  if (!nodesOk) {
    console.error(`FAIL: shell notis-nodes=${shellNodesRaw} != ${JSON.stringify(expectedNodes)}`);
    console.error(`      rebuild with VITE_NODES=${JSON.stringify(JSON.stringify(expectedNodes))} bash packages/web/scripts/build-extension.sh`);
    process.exit(2);
  }
  console.log(`shell notis-nodes=${shellNodesRaw} matches [A, B]`);
}

// The build's public base is the shell's `notis-public` — WEB_INTERFACE →
// The extension → "Links into the extension". When --public is passed, the
// shell must carry it exactly, and the manifest's one content_scripts entry
// must be the port-less pattern derived from --public (via the module the
// emitter uses; never a second implementation here — the faucet check's
// shape, for the same reason). Skipped in verified-tip-only mode (no --r-key),
// where step 20 uses --public to open the hosted web build served by the
// harness's static server — the extension's own `notis-public` and bridge
// have no bearing on that step.
if (PUBLIC !== null && R_KEY) {
  const publicMetaMatch = shellHtml.match(/<meta[^>]+name="notis-public"[^>]+content="([^"]*)"[^>]*>/);
  const shellPublic = publicMetaMatch ? publicMetaMatch[1] : null;
  if (shellPublic !== PUBLIC) {
    console.error(`FAIL: shell notis-public="${shellPublic}" != --public="${PUBLIC}"`);
    console.error(`      rebuild with VITE_PUBLIC=${PUBLIC} bash packages/web/scripts/build-extension.sh`);
    process.exit(2);
  }
  console.log(`shell notis-public=${shellPublic} matches --public`);
  const expectedPattern = matchPatternFor(PUBLIC);
  const cs = manifest.content_scripts;
  if (!Array.isArray(cs) || cs.length !== 1) {
    console.error(`FAIL: manifest content_scripts must have one entry, got: ${JSON.stringify(cs)}`);
    process.exit(2);
  }
  const csMatches = cs[0].matches;
  if (!Array.isArray(csMatches) || csMatches.length !== 1 || csMatches[0] !== expectedPattern) {
    console.error(`FAIL: manifest content_scripts[0].matches != [${JSON.stringify(expectedPattern)}] — got: ${JSON.stringify(csMatches)}`);
    process.exit(2);
  }
  console.log(`manifest content_scripts[0].matches=${csMatches[0]} matches expected pattern (port-less)`);
}

// The web server for --web-dist — WEB_INTERFACE → The extension → "Links into
// the extension". The files under the base's path; <base>p/<64 hex> answers
// the shell (index.html), as the node's GET /shell/:id does behind nginx.
// The plain page (/link.html?id=<hex>, outside the base — the bridge is
// declared only for <base>p/*, so this page runs with no bridge) links to a
// thread twice, once same-tab and once target="_blank", the two arms step 16
// measures. Content types cover only what a Vite web build serves.
function contentTypeFor(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.woff2')) return 'font/woff2';
  if (p.endsWith('.woff')) return 'font/woff';
  if (p.endsWith('.ico')) return 'image/x-icon';
  if (p.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

const HEX64 = /^[0-9a-f]{64}$/i;
let webServer = null;
// Every request the web server answers, in the order it arrives — path and
// arrival time. Step 14 reads the slice around a run to show how far the
// hosted page got, measured from outside the browser
// (WEB_INTERFACE → The extension → "Links into the extension").
const webRequests = [];
async function startWebServer() {
  if (PUBLIC === null) return;
  webServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', publicOrigin);
      const p = url.pathname;
      webRequests.push({ path: (req.url ?? '/'), at: Date.now() });
      if (p === '/link.html') {
        const idQ = url.searchParams.get('id') ?? '';
        const safe = HEX64.test(idQ) ? idQ : '';
        const href = publicOrigin + publicBase + 'p/' + safe;
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>plain</title>` +
          `</head><body><a id="same" href="${href}">follow same-tab</a> ` +
          `<a id="blank" href="${href}" target="_blank" rel="noopener">follow new-tab</a></body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      if (!p.startsWith(publicBase)) { res.writeHead(404); res.end('outside base'); return; }
      const rel = p.substring(publicBase.length);
      if (/^p\/[0-9a-f]{64}$/i.test(rel)) {
        const shell = await readFile(join(webDistAbs, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(shell);
        return;
      }
      const relClean = rel === '' ? 'index.html' : rel;
      const abs = resolve(webDistAbs, relClean);
      if (abs !== webDistAbs && !abs.startsWith(webDistAbs + sep)) { res.writeHead(403); res.end('escape'); return; }
      let buf;
      try { buf = await readFile(abs); } catch { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': contentTypeFor(relClean), 'cache-control': 'no-store' });
      res.end(buf);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  await new Promise((res, rej) => {
    webServer.on('error', rej);
    webServer.listen(publicPort, '127.0.0.1', () => res());
  });
  console.log(`web server: ${webDistAbs} served on ${publicOrigin}${publicBase} (port ${publicPort})`);
}
await startWebServer();

// R's clear key is read only when the write steps run. Verified-tip-only mode
// (--verified-tip without --r-key) skips 1–16, so no wallet identity is imported.
const R_TEXT = R_KEY ? readFileSync(R_KEY, 'utf8') : null;
const R_JSON = R_TEXT ? JSON.parse(R_TEXT) : null;

const findChrome = () => {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const pw = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  if (existsSync(pw)) for (const d of readdirSync(pw)) if (d.startsWith('chromium-')) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = join(pw, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
};
const CHROME = findChrome();
if (!CHROME) { console.error('no Chromium found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Chromium instance the harness owns — its own DevTools port, its own user
// data dir, and the single extension it loads at --extension-dir
// (WEB_INTERFACE → The extension → "The verified tip").
async function launchChromium(extensionDir) {
  const chromePort = 19200 + Math.floor(Math.random() * 500);
  const profileDir = mkdtempSync(join(tmpdir(), 'notis-ext-proof-'));
  const chromeProc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${chromePort}`, `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chromeProc.stderr.on('data', () => {}); // absorb chrome's noise
  chromeProc.stdout.on('data', () => {});
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${chromePort}/json/version`);
      if (r.ok) return { proc: chromeProc, port: chromePort, profile: profileDir, version: await r.json() };
    } catch {}
    await sleep(100);
  }
  throw new Error(`chrome DevTools never appeared on port ${chromePort}`);
}

// The Chromium — loaded with the extension at --extension-dir. Every step
// runs against this instance's DevTools port.
const primary = await launchChromium(EXT_DIR);
const proc = primary.proc;
const port = primary.port;
const profile = primary.profile;

async function browserVersion(chromePort = port) {
  const r = await fetch(`http://127.0.0.1:${chromePort}/json/version`);
  if (!r.ok) throw new Error(`browserVersion: ${r.status}`);
  return r.json();
}

async function jsonList(chromePort = port) {
  return (await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json());
}

// A CDP session over one target — Page, Runtime, Network enabled; window.__btn
// is the byName helper the precedent used.
async function openSession(wsUrl) {
  const s = new WebSocket(wsUrl);
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej; });
  let n = 0;
  const p = new Map();
  const events = [];
  s.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
    if (m.method) events.push(m);
  };
  const CALL_TIMEOUT_MS = 60000;
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++n;
    const timer = setTimeout(() => { p.delete(id); rej(new Error(`CDP timeout ${CALL_TIMEOUT_MS}ms on ${method}`)); }, CALL_TIMEOUT_MS);
    p.set(id, (m) => { clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
    s.send(JSON.stringify({ id, method, params }));
  });
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');
  const eval_ = async (expression, userGesture = false) => {
    // `call` resolves with `m.result` (the CDP method result). Runtime.evaluate's
    // result is `{ result: { type, value, ... }, exceptionDetails? }`, so the
    // value sits at `r.result.value`.
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  const waitFor = async (expression, what, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await eval_(expression)) return; await sleep(200); }
    throw new Error(`timeout waiting for ${what}`);
  };
  await eval_(`window.__btn = (t, r) => [...(r||document).querySelectorAll('button')].find(b=>b.textContent.trim()===t)||null; window.__req = []; true`);
  return { s, call, eval: eval_, waitFor, events };
}

const findings = [];
const record = (step, status, detail) => {
  const s = status === true ? 'PASS' : status === false ? 'FAIL' : status === 'skipped' ? 'SKIPPED' : String(status);
  findings.push({ step, status: s, detail });
  console.log(`step ${step}: ${s} — ${detail}`);
};

async function findExt(pathSuffix, chromePort = port) {
  for (let i = 0; i < 100; i++) {
    const list = await jsonList(chromePort);
    const p = list.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${EXT_ID}/`) && (pathSuffix ? t.url.includes(pathSuffix) : true));
    if (p?.webSocketDebuggerUrl) return p;
    await sleep(200);
  }
  return null;
}

async function findWorker(chromePort = port) {
  const list = await jsonList(chromePort);
  return list.find((t) => (t.type === 'service_worker' || t.type === 'worker') && t.url.endsWith('/background.js'));
}

// The browser-level CDP session — the only one that can `Target.createTarget`,
// `Target.closeTarget`, `Target.createBrowserContext`, and see `targetCreated`
// / `targetDestroyed` events at the browser scope. Distinct from a per-target
// session opened via `openSession(wsUrl)` (WEB_INTERFACE → The extension →
// "Links into the extension" — the browser-scope moves the tabs).
async function openBrowserSession(chromePort = port) {
  const bv = await browserVersion(chromePort);
  const s = new WebSocket(bv.webSocketDebuggerUrl);
  await new Promise((res, rej) => { s.onopen = res; s.onerror = rej; });
  let n = 0;
  const p = new Map();
  const events = [];
  s.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
    // A method event carries its own arrival stamp — the run's clock in ms
    // (WEB_INTERFACE → The extension → "Links into the extension"), so a
    // wait taking an index AFTER the event still reports when the event
    // arrived. Read as `ev.__at` alongside `ev.method`/`ev.params`.
    if (m.method) { m.__at = Date.now(); events.push(m); }
  };
  const CALL_TIMEOUT_MS = 60000;
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++n;
    const timer = setTimeout(() => { p.delete(id); rej(new Error(`CDP timeout ${CALL_TIMEOUT_MS}ms on ${method}`)); }, CALL_TIMEOUT_MS);
    p.set(id, (m) => { clearTimeout(timer); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
    s.send(JSON.stringify({ id, method, params }));
  });
  await call('Target.setDiscoverTargets', { discover: true });
  return { s, call, events };
}

// A trusted click — CDP `Input.dispatchMouseEvent` on the control's measured
// centre, so the page reads the browser's transient user activation (which a
// page cannot forge). The offer listener inside the bridge takes the event
// only under this activation (WEB_INTERFACE → The extension → "The website's
// control offers the thread to the extension"); `element.click()` through
// `Runtime.evaluate` reads as synthetic there. Returns the coordinates.
async function trustedClickAt(cx, selector) {
  const box = await cx.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error(`trustedClickAt: no element for ${selector}`);
  await cx.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await cx.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 });
  return box;
}

// Wait for a target from `/json/list` matching a predicate (typically by id).
async function findTargetById(id, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const list = await jsonList();
    const t = list.find((x) => x.id === id);
    if (t && t.webSocketDebuggerUrl) return t;
    await sleep(150);
  }
  return null;
}

// Wait for a target to disappear from `/json/list` (destroyed).
async function waitForTargetGone(id, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const list = await jsonList();
    if (!list.find((x) => x.id === id)) return true;
    await sleep(100);
  }
  return false;
}

// Set the extension's links preference through the settings window's real
// row (WEB_INTERFACE → The settings window → "The links row"). Never writes
// storage directly, per the proof's rules.
async function setLinksPrefViaUi(cx, value) {
  const label = value === 'site' ? 'on the site' : 'here';
  await cx.eval(`document.querySelector('[aria-label="open settings"]').click()`, true);
  await cx.waitFor(`(() => {
    const rows = [...document.querySelectorAll('.row')];
    return rows.some(r => r.querySelector('label')?.textContent === 'a Notis link opens');
  })()`, 'settings links row', 10000);
  await cx.eval(`(() => {
    const rows = [...document.querySelectorAll('.row')];
    const row = rows.find(r => r.querySelector('label')?.textContent === 'a Notis link opens');
    const btn = [...row.querySelectorAll('button.word')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
    btn.click();
  })()`, true);
  // The click stashes through `chrome.storage.local.set` — wait on the read
  // to observe the stored value, capped at 5 s. Any wait for the write is
  // the value's arrival, not a sleep.
  const t0 = Date.now();
  let applied = null;
  while (Date.now() - t0 < 5000) {
    applied = await cx.eval(`(async () => (await chrome.storage.local.get('notis.links'))['notis.links'] ?? 'here')()`);
    if (applied === value) return applied;
    await sleep(50);
  }
  return applied;
}

// Read a root post id authored by R from the node — a post the run itself
// made (step 3, or promote.mjs's earlier ones — the run itself made all of
// them under R). WEB_INTERFACE → Reading the feed and threads — the answer's
// rows sit under `posts` on this endpoint.
async function pickOwnRootPostId() {
  // `GET /posts` answers `{ posts, next, pending, pendingCount }`
  // (NODE_INTERFACE → Posts).
  const r = await fetch(`${NODE}/posts?roots=1&author=${R_JSON.pubKeyHex}&limit=1`);
  const j = await r.json();
  const rows = Array.isArray(j?.posts) ? j.posts : [];
  const first = rows[0];
  if (!first || typeof first.id !== 'string') return null;
  return first.id;
}

async function pollKarma(target = 20, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${NODE}/karma/${R_JSON.pubKeyHex}`);
      const j = await r.json();
      const total = Number(j.effective ?? j.total ?? 0);
      if (total >= target) return { ok: true, total };
    } catch {}
    await sleep(1000);
  }
  return { ok: false };
}

async function feedContains(id) {
  try { const j = await (await fetch(`${NODE}/posts/${id}`)).json(); return j && !j.kind; } catch { return false; }
}

// ---------------------------------------------------------------------------
// The verified-tip block — helpers.
//
// WEB_INTERFACE → The extension → "The verified tip", steps 17–20. The
// harness owns the lifecycle of node B, the lying relay, node C and node A's
// miner; A itself is the operator's. Every child is a node:child_process
// handle (`node`'s own), stopped by the handle at cleanup (SIGKILL) — never
// by name, never by grepping /proc — so any dagsocial-miner unit running the
// same miner.mjs against another network stays untouched.
// ---------------------------------------------------------------------------

// The live children — the cleanup path at the end of the run sends SIGKILL to
// each and awaits its exit. A record here is added at spawn and removed on the
// process's own 'exit'.
const vtChildren = new Map(); // name → { child, exited: Promise<void> }

function spawnDaemon(name, entry, env, extraArgs = []) {
  const logPath = SCRATCH ? join(SCRATCH, `${name}.log`) : null;
  const stdio = logPath ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'];
  const child = spawn(process.execPath, [entry, ...extraArgs], { env: { ...process.env, ...env }, stdio });
  const exited = new Promise((res) => child.on('exit', (code, sig) => {
    vtChildren.delete(name);
    console.log(`[vt] ${name} exited: code=${code} signal=${sig}`);
    res();
  }));
  if (logPath) {
    // Fire-and-forget: append child stdout/stderr to the log. A crash in one
    // stream never crashes the harness — errors go silent, but the log is a
    // measurement, not a decision surface.
    import('node:fs').then(({ createWriteStream }) => {
      const w = createWriteStream(logPath, { flags: 'a' });
      child.stdout?.pipe(w);
      child.stderr?.pipe(w);
    }).catch(() => {});
  }
  vtChildren.set(name, { child, exited });
  return { child, exited };
}

async function stopChild(name) {
  const rec = vtChildren.get(name);
  if (!rec) return;
  try { rec.child.kill('SIGKILL'); } catch {}
  await rec.exited;
}

async function stopAllChildren() {
  for (const name of [...vtChildren.keys()]) {
    await stopChild(name);
  }
}

async function currentHeight(origin) {
  try {
    const r = await fetch(`${origin}/blocks/current`);
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.height === 'number' ? j.height : null;
  } catch { return null; }
}

async function waitForHttpUp(origin, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${origin}/blocks/current`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function waitForHealth(adminOrigin, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${adminOrigin}/health`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  return null;
}

async function waitForPeers(adminOrigin, min, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${adminOrigin}/health`);
      if (r.ok) {
        const j = await r.json();
        if ((j.peers_connected ?? 0) >= min) return j.peers_connected;
      }
    } catch {}
    await sleep(500);
  }
  return null;
}

async function waitForHeight(origin, target, ms = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const h = await currentHeight(origin);
    if (h !== null && h >= target) return h;
    await sleep(500);
  }
  return null;
}

async function waitForHeightsClose(originA, originB, tolerance, ms = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hA = await currentHeight(originA);
    const hB = await currentHeight(originB);
    if (hA !== null && hB !== null && Math.abs(hA - hB) <= tolerance) return { hA, hB };
    await sleep(500);
  }
  return null;
}

// The lying relay — WEB_INTERFACE → The extension → "The verified tip". Every
// GET is proxied to node A verbatim, `access-control-allow-origin: *` added so
// the extension page can read it (as A does directly). The one hostile edit
// is /nipopow/proof/<m>/<k>: one byte flipped ten bytes from the end — the
// spike's technique. Two flips fall in `refuseCode: 'invalid'` — a verify
// failure or a decode failure — and the REPORT names which.
async function startLyingRelay(upstream) {
  const flips = { total: 0 };
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        res.writeHead(405, { 'access-control-allow-origin': '*' });
        res.end('lying relay serves reads only');
        return;
      }
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-allow-headers': '*',
        });
        res.end();
        return;
      }
      const upstreamRes = await fetch(upstream + url, { method });
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      let body = buf;
      const isProof = /^\/nipopow\/proof\/\d+\/\d+/.test(url);
      if (isProof && upstreamRes.status === 200 && buf.length >= 11) {
        body = Buffer.from(buf);
        body[body.length - 10] = body[body.length - 10] ^ 0x01;
        flips.total += 1;
      }
      const headers = {
        'access-control-allow-origin': '*',
        'content-type': upstreamRes.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
      };
      res.writeHead(upstreamRes.status, headers);
      res.end(body);
    } catch (e) {
      res.writeHead(502, { 'access-control-allow-origin': '*' });
      res.end(String(e));
    }
  });
  await new Promise((res, rej) => {
    server.on('error', rej);
    server.listen(RELAY_PORT, '127.0.0.1', res);
  });
  return { server, flips, origin: RELAY_ORIGIN };
}

// The figures relay — WEB_INTERFACE → The extension → "The verified figures",
// the lie arms 22a · 22b · 23. Every GET is proxied to `upstream` with
// `access-control-allow-origin: *`, as 19a's relay does, and every
// /nipopow/proof/ answer passes verbatim in every mode: the reading node's tip
// proof is A's own, so the corner stays verified and the anchor stands. The
// step sets `relay.mode` between arms, and the mode is the one hostile edit:
//   honest          — none;
//   credits-fake    — R's first /credits page lists one more box, a fresh
//                     random id holding 12.5 $NOTIS: its proofs come from A,
//                     which holds no such key;
//   credits-foreign — R's first /credits page lists the devnet faucet's
//                     largest credit box, read from upstream at the request —
//                     a real box of another key;
//   avl-flip        — every /api/v1/proof/ answer carries its proof with one
//                     byte flipped ten from the end, the JSON otherwise as
//                     served: the flip is made in the decoded proof, never in
//                     the JSON text, so what fails is the proof's verification.
// `relay.edits` counts each mode's edits.
async function startFiguresRelay(upstream, port) {
  const relay = {
    server: null,
    origin: `http://127.0.0.1:${port}`,
    mode: 'honest',
    edits: { 'credits-fake': 0, 'credits-foreign': 0, 'avl-flip': 0 },
  };
  const ownCreditsPath = `/credits/${R_JSON.pubKeyHex.toLowerCase()}`;
  relay.server = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        res.writeHead(405, { 'access-control-allow-origin': '*' });
        res.end('figures relay serves reads only');
        return;
      }
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-allow-headers': '*',
        });
        res.end();
        return;
      }
      const upstreamRes = await fetch(upstream + url, { method });
      let body = Buffer.from(await upstreamRes.arrayBuffer());
      const mode = relay.mode;
      const target = new URL(url, upstream);
      if (method === 'GET' && upstreamRes.status === 200) {
        const ownFirstPage = target.pathname.toLowerCase() === ownCreditsPath && !target.searchParams.has('after');
        if ((mode === 'credits-fake' || mode === 'credits-foreign') && ownFirstPage) {
          const listing = JSON.parse(body.toString('utf8'));
          const box = mode === 'credits-fake'
            ? { boxId: randomBytes(32).toString('hex'), value: '1250000000' }
            : await largestCreditBox(upstream, DEVNET_FAUCET_KEY);
          if (box !== null) {
            listing.boxes.push(box);
            listing.boxCount += 1;
            body = Buffer.from(JSON.stringify(listing));
            relay.edits[mode] += 1;
            console.log(`[vf] figures relay ${mode} edit ${relay.edits[mode]}: ${box.boxId.slice(0, 12)}… (${box.value}) listed under R`);
          }
        } else if (mode === 'avl-flip' && target.pathname.startsWith('/api/v1/proof/')) {
          const answer = JSON.parse(body.toString('utf8'));
          const proof = Buffer.from(answer.proof, 'base64');
          if (proof.length >= 11) {
            proof[proof.length - 10] = proof[proof.length - 10] ^ 0x01;
            answer.proof = proof.toString('base64');
            body = Buffer.from(JSON.stringify(answer));
            relay.edits['avl-flip'] += 1;
          }
        }
      }
      res.writeHead(upstreamRes.status, {
        'access-control-allow-origin': '*',
        'content-type': upstreamRes.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { 'access-control-allow-origin': '*' });
      res.end(String(e));
    }
  });
  await new Promise((res, rej) => {
    relay.server.on('error', rej);
    relay.server.listen(port, '127.0.0.1', res);
  });
  return relay;
}

// The largest credit box `key` holds on `upstream`, as served — `{ boxId,
// value, lockedUntilBlock? }` — its whole listing read, following `next`
// (WEB_INTERFACE → "Paging is keyset, never offset"); null when it holds none.
async function largestCreditBox(upstream, key) {
  let best = null;
  let after = null;
  do {
    const r = await fetch(`${upstream}/credits/${key}` + (after === null ? '' : `?after=${encodeURIComponent(after)}`));
    if (!r.ok) return best;
    const page = await r.json();
    for (const b of page.boxes ?? []) if (best === null || BigInt(b.value) > BigInt(best.value)) best = b;
    after = page.next ?? null;
  } while (after !== null);
  return best;
}

// Read the rendered corner from a CDP session's page — the dot's class, the
// tip span's classes, the tip text and the `title` attribute (WEB_INTERFACE →
// The status corner, → The extension → "The verified tip").
async function readCorner(cx) {
  return cx.eval(`(() => {
    const btn = document.querySelector('.corner');
    if (!btn) return { present: false };
    const led = btn.querySelector('.led');
    const tip = btn.querySelector('.tip');
    return {
      present: true,
      ledClass: led?.className ?? null,
      tipClass: tip?.className ?? null,
      tipText: tip?.textContent ?? null,
      title: btn.getAttribute('title'),
    };
  })()`);
}

// A press on the corner — a plain `.click()` on the button; the App's own
// handler runs the tick and (where a verifier is handed in) a verification.
// The corner has no user-activation gate.
async function pressCorner(cx) {
  await cx.eval(`document.querySelector('.corner')?.click()`, true);
}

// Set prefs.node through the settings window's real row (WEB_INTERFACE →
// The settings window: the input commits on `change`). Empty resets to the
// build default. The changeNode handler drops the verdict to `null` (checking)
// and starts a new run.
async function setNodeViaUi(cx, origin) {
  await cx.eval(`document.querySelector('[aria-label="open settings"]').click()`, true);
  await cx.waitFor(`!!document.querySelector('[aria-label="the node this client reads"]')`, 'settings node row', 10000);
  const applied = await cx.eval(`(() => {
    const input = document.querySelector('[aria-label="the node this client reads"]');
    input.focus();
    input.value = ${JSON.stringify(origin)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
  // Close the settings window so the corner and the App's other surfaces
  // are visible again — a press on the settings header re-toggles it.
  await sleep(200);
  return applied;
}

async function readPrefsNode(cx) {
  // `setNode('')` removes the key and prefs.node adopts BUILD_NODES[0] at boot;
  // the stored value is what a re-read of the input mirrors. Read localStorage
  // directly so no settings window needs to be open here.
  return cx.eval(`localStorage.getItem('notis.node')`);
}

function proofRequestsSince(events, startIdx) {
  const out = [];
  for (let i = startIdx; i < events.length; i++) {
    const ev = events[i];
    if (ev.method !== 'Network.requestWillBeSent') continue;
    const url = ev.params?.request?.url ?? '';
    if (url.includes('/nipopow/proof/')) out.push({ url, at: ev.__at ?? null, index: i });
  }
  return out;
}

// Wait for the corner to reach a rendered shape the caller can name — one of
// `verified`, `thin`, `refused`, `checking` — with an optional predicate on
// the reading. The App renders the corner in place after each run, so a poll
// on `readCorner` is the observable path. Returns `{ timedOut, last }` — the
// last reading is present in both arms (on match, it is the reading that
// satisfied the predicate; on timeout, it is the last reading polled).
async function waitForCornerState(cx, predicate, description, ms = 45000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await readCorner(cx);
    if (last.present && predicate(last)) return { timedOut: false, last };
    await sleep(200);
  }
  return { timedOut: true, last };
}

// Wait for the App's next verifier run to complete, since its own press. The
// App keeps the previous verdict rendered *through* the next run (a stale
// verdict is not cleared by a trigger, only by `onReadingNodeChanged`), so a
// press-before-read on a state the previous run already produced returns at
// once — before the new run's fetches have registered. The observable signal
// of a run happening is the request pair itself (Network.requestWillBeSent
// with `/nipopow/proof/`), and the observable signal of it *finishing* is a
// short quiet window with no new such request. Returns the collected requests.
async function waitForVerifierRun(cx, sinceIdx, atLeast, ms = 30000, quietMs = 1500) {
  const t0 = Date.now();
  let last = 0;
  let lastAt = t0;
  while (Date.now() - t0 < ms) {
    const now = proofRequestsSince(cx.events, sinceIdx).length;
    if (now !== last) { last = now; lastAt = Date.now(); }
    if (now >= atLeast && Date.now() - lastAt >= quietMs) return proofRequestsSince(cx.events, sinceIdx);
    await sleep(100);
  }
  return proofRequestsSince(cx.events, sinceIdx);
}

// Parse the `tip N` integer out of a corner title (WEB_INTERFACE → The
// status corner). Returns null if the title carries no such tip.
function tipFromTitle(title) {
  const m = /tip (\d+)/.exec(title ?? '');
  return m ? parseInt(m[1], 10) : null;
}

// The tip in the corner's title is the reading node's, within a few blocks
// of that node's /blocks/current at the time of the read — a change of the
// reading node drops the tip and reads at once (WEB_INTERFACE → The status
// corner). The fetches sit close in time, so
// a small tolerance covers the fold's own delay and A's live pace.
async function titleTipNearReadingNode(readingOrigin, reading, tolerance = 5) {
  const tipTitle = tipFromTitle(reading.title);
  const nodeHeight = await currentHeight(readingOrigin);
  const near = typeof tipTitle === 'number'
    && typeof nodeHeight === 'number'
    && Math.abs(nodeHeight - tipTitle) <= tolerance;
  return { tipTitle, nodeHeight, near };
}

// ---------------------------------------------------------------------------
// The verified-tip block — steps 17a · 17 · 17b · 18 · 19a · 19b · 19c · 20.
// ---------------------------------------------------------------------------

const VERIFIED_TIP_STEPS = ['17a', 17, '17b', 18, '19a', '19b', '19c', 20];
// The verified-figures block — steps 21 · 24 · 22a · 22b · 23 · 25, in the
// order they run (WEB_INTERFACE → The extension → "The verified figures");
// 22a · 22b · 23 are the lie arms, read through the figures relay.
const VERIFIED_FIGURES_STEPS = [21, 24, '22a', '22b', 23, 25];
const LIE_ARM_STEPS = ['22a', '22b', 23];

function markVerifiedTipNotRun(reason) {
  for (const s of VERIFIED_TIP_STEPS) record(s, 'NOT RUN', reason);
}

function markVerifiedFiguresNotRun(reason) {
  for (const s of VERIFIED_FIGURES_STEPS) record(s, 'NOT RUN', reason);
}

// Press the corner and wait for its next verdict — one press, one verifier
// run, one reading. The App keeps the previous verdict rendered *through* the
// next run (WEB_INTERFACE → The extension → "The verified tip"), so the
// request pair is the observable that the new run happened; the reading is
// what the corner shows once the pair settles.
async function pressAndReadVerdict(cx, opts = {}) {
  const startIdx = cx.events.length;
  await pressCorner(cx);
  const proofs = await waitForVerifierRun(
    cx, startIdx, opts.atLeast ?? 2, opts.ms ?? 30000, opts.quietMs ?? 1500);
  await sleep(200);
  return { proofs, reading: await readCorner(cx) };
}

// Set the node row, then wait for the verifier's run driven by the change to
// reach one of the caller's readings. Blanking the row is its own call, with
// the verified-across-N-nodes predicate. Records the intermediate values so
// the caller can build the step's detail line.
async function changeNodeAndAwait(cx, origin, predicate, description, ms = 60000) {
  const applied = await setNodeViaUi(cx, origin);
  const stored = await readPrefsNode(cx);
  const startIdx = cx.events.length;
  // changeNode drops the verdict and starts a new run; nothing to press.
  const reached = await waitForCornerState(cx, predicate, description, ms);
  const reading = reached.last ?? await readCorner(cx);
  const proofs = proofRequestsSince(cx.events, startIdx);
  return { applied, stored, reached, reading, proofs };
}

async function blankNodeAndAwaitVerified(cx, ms = 60000) {
  return changeNodeAndAwait(
    cx, '',
    (c) => c.ledClass === 'led fresh' && /^verified across \d+ nodes · tip \d+$/.test(c.title ?? ''),
    'led fresh + verified across N nodes (after blank)',
    ms);
}

// Bring node B up, bootstrapped from A. B's role is server; its store is
// fresh; it waits for one peer (A) before returning. Answers with the sync
// heights the caller records.
async function bringUpNodeB() {
  const bDbPath = join(SCRATCH, 'b.db');
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(bDbPath + suffix, { force: true }); } catch {}
  }
  console.log(`[vt] spawning node B: port=${B_HTTP_PORT} admin=${B_ADMIN_PORT} p2p=${B_P2P_PORT} db=${bDbPath} bootstrap=${NODE_P2P}`);
  spawnDaemon('b', NODE_DIST, {
    NETWORK_TYPE: 'devnet',
    NODE_ROLE: 'server',
    PORT: String(B_HTTP_PORT),
    ADMIN_PORT: String(B_ADMIN_PORT),
    LISTEN_ADDRS: `/ip4/127.0.0.1/tcp/${B_P2P_PORT}`,
    BOOTSTRAP_PEERS: NODE_P2P,
    DB_PATH: bDbPath,
  });
  return { bDbPath };
}

async function verifiedTipSteps(cx, targetId = 'unknown') {
  // ---- Liveness probe on the session — a few-second wall around `1+1`
  // before any block work; a session with no live target records every step
  // FAIL with the reason, in place of `openSession`'s 60-second CDP wall
  // (WEB_INTERFACE → The extension → "The verified tip").
  const alive = await (async () => {
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('liveness timeout')), 3000));
    try { return (await Promise.race([cx.eval(`1+1`), timeout])) === 2; }
    catch { return false; }
  })();
  if (!alive) {
    const reason = `the verified-tip block's session is not live: ${targetId}`;
    for (const s of VERIFIED_TIP_STEPS) record(s, false, reason);
    return;
  }

  // ---- pre-flight — A is up. A's miner is the operator's, running at whatever
  // pace the operator has set (WEB_INTERFACE → The extension → "The verified
  // tip"). The harness never signals A or its miner.
  const aUp = await waitForHttpUp(NODE, 15000);
  if (!aUp) {
    markVerifiedTipNotRun(`node A did not answer /blocks/current at ${NODE}`);
    return;
  }
  const preHeightA = await currentHeight(NODE);
  console.log(`[vt] pre-flight: A height=${preHeightA} at ${NODE}`);

  // ---- Spawn node B — server, bootstrapped from A's p2p. Step 17 and step 18
  // need a second verified node; the other steps switch the reading node to
  // one that shows a different verdict and blank the row back afterward.
  const { bDbPath } = await bringUpNodeB();
  if (!await waitForHttpUp(B_ORIGIN, 30000)) {
    markVerifiedTipNotRun(`node B did not come up at ${B_ORIGIN}`);
    return;
  }
  console.log(`[vt] node B up at ${B_ORIGIN}`);
  const bAdminOrigin = `http://127.0.0.1:${B_ADMIN_PORT}`;
  const bPeers = await waitForPeers(bAdminOrigin, 1, 60000);
  console.log(`[vt] node B peers_connected=${bPeers}`);
  // B catches up to A within a couple of blocks so step 17's reading is the
  // rule's own — a live-miner tip fluctuates by one block, and the reading
  // node is verified while the winner's suffix carries its tip (contract
  // → "A winner elsewhere says the reading node is behind, not that it is
  // wrong").
  const abSynced = await waitForHeightsClose(NODE, B_ORIGIN, 2, 300000);
  if (abSynced === null) {
    const hA = await currentHeight(NODE);
    const hB = await currentHeight(B_ORIGIN);
    markVerifiedTipNotRun(`B never caught up to A within 5 minutes (A=${hA}, B=${hB})`);
    return;
  }
  console.log(`[vt] A/B synced: ${JSON.stringify(abSynced)}`);

  await cx.waitFor(`!!document.querySelector('.corner')`, 'corner mounted', 30000);

  // ---- Spawn node D — isolated, miner role with its own secret, no miner
  // script yet. D serves 17a's *too-short* at height 0 and, later, 19c's
  // *share no block* once its own miner runs it past 30. The secret is random
  // and per-run — nothing of it lands in the tree.
  const dDbPath = join(SCRATCH, 'd.db');
  for (const suffix of ['', '-shm', '-wal']) {
    try { rmSync(dDbPath + suffix, { force: true }); } catch {}
  }
  const dSecret = randomBytes(32).toString('hex');
  console.log(`[vt] spawning node D: port=${D_HTTP_PORT} admin=${D_ADMIN_PORT} p2p=${D_P2P_PORT} db=${dDbPath} isolated`);
  spawnDaemon('d', NODE_DIST, {
    NETWORK_TYPE: 'devnet',
    NODE_ROLE: 'miner',
    PORT: String(D_HTTP_PORT),
    ADMIN_PORT: String(D_ADMIN_PORT),
    LISTEN_ADDRS: `/ip4/127.0.0.1/tcp/${D_P2P_PORT}`,
    BOOTSTRAP_PEERS: '',
    DB_PATH: dDbPath,
    MINING_SECRET: dSecret,
  });
  if (!await waitForHttpUp(D_ORIGIN, 30000)) {
    markVerifiedTipNotRun(`node D did not come up at ${D_ORIGIN}`);
    return;
  }
  console.log(`[vt] node D up at ${D_ORIGIN}, height ${await currentHeight(D_ORIGIN)}`);

  // ---- Step 17a — too-short, on node D. D is isolated with no miner script,
  // so its height stays at 0 (genesis). A change of the reading node drops
  // the tip and reads the new node at once (WEB_INTERFACE → The status
  // corner): the corner's tip is D's own, 0.
  {
    const hD = await currentHeight(D_ORIGIN);
    const hAnow = await currentHeight(NODE);
    const {
      applied, stored, reached, reading, proofs,
    } = await changeNodeAndAwait(
      cx, D_ORIGIN,
      (c) => c.ledClass === 'led thin' && c.tipText === '0' && c.title === 'the chain is too short to check yet · tip 0',
      'led thin + "too short to check yet · tip 0"',
      60000);
    const ok = !reached.timedOut
      && applied === D_ORIGIN
      && stored === D_ORIGIN
      && reading.ledClass === 'led thin'
      && reading.tipClass === 'tip mono'
      && reading.tipText === '0'
      && reading.title === 'the chain is too short to check yet · tip 0';
    record('17a', ok,
      `applied=${JSON.stringify(applied)}, stored=${JSON.stringify(stored)}, led=${reading.ledClass}, tip=${reading.tipClass}, title=${JSON.stringify(reading.title)}, tipText=${reading.tipText}, proof requests=${proofs.length} (${JSON.stringify(proofs.map(p => p.url))}), heights D=${hD} A=${hAnow}`);
    const post = await blankNodeAndAwaitVerified(cx);
    console.log(`[vt] 17a post-blank: applied=${JSON.stringify(post.applied)}, stored=${JSON.stringify(post.stored)}, led=${post.reading.ledClass}, title=${JSON.stringify(post.reading.title)}`);
  }

  // ---- Step 17 — verified. A press hits both nodes; a 20 s idle window sits
  // under VERIFY_INTERVAL_MS so no run fires unasked; a second press hits
  // both nodes again — the fold's cost is deterministic.
  {
    const first = await pressAndReadVerdict(cx, { atLeast: 2, ms: 60000, quietMs: 2000 });
    const reachedTitleOk = /^verified across \d+ nodes · tip \d+$/.test(first.reading.title ?? '');
    const idleStart = cx.events.length;
    await sleep(20000);
    const idleProofs = proofRequestsSince(cx.events, idleStart);
    const second = await pressAndReadVerdict(cx, { atLeast: 2, ms: 60000, quietMs: 2000 });
    const ok = reachedTitleOk
      && first.reading.ledClass === 'led fresh'
      && first.reading.tipClass === 'tip mono'
      && second.reading.ledClass === 'led fresh'
      && /^verified across \d+ nodes · tip \d+$/.test(second.reading.title ?? '')
      && first.proofs.length === 2
      && idleProofs.length === 0
      && second.proofs.length === 2;
    record(17, ok,
      `led=${first.reading.ledClass}, tip=${first.reading.tipClass}, title=${JSON.stringify(first.reading.title)}, first-press proof requests=${first.proofs.length} (${JSON.stringify(first.proofs.map(p => p.url))}), idle-20s proof requests=${idleProofs.length}, second-press proof requests=${second.proofs.length}`);
  }

  // ---- Step 17b — 30 presses one second apart in each direction under A's
  // live miner. Every one of the sixty readings is `led fresh` + *verified
  // across 2 nodes*; not one is `led refused` (WEB_INTERFACE → The extension
  // → "The verified tip" — a winner elsewhere whose suffix carries the
  // reading node's tip reads verified). The B direction is the case the
  // reader of a follower stands in: B's gossip lag from A widens the gap
  // between the extension's two proof fetches, so a block landing on A
  // between B's answer and A's is the false alarm the rule prevents.
  const hA17bAStart = await currentHeight(NODE);
  const step17bAReadings = await pressCornerRepeatedly(cx, 30);
  const hA17bAEnd = await currentHeight(NODE);
  const allFresh17bA = step17bAReadings.every((r) => r.ledClass === 'led fresh' && /^verified across \d+ nodes · tip \d+$/.test(r.title ?? ''));
  const refused17bAIdx = step17bAReadings.findIndex((r) => r.ledClass === 'led refused');
  const totalProofs17bA = step17bAReadings.reduce((n, r) => n + r.proofs, 0);
  console.log(`[vt] 17b A-direction readings: ${JSON.stringify(step17bAReadings)}`);

  // The `node` row is set to B. The change drops the tip and reads B at
  // once (WEB_INTERFACE → The status corner). Wait for a first verified
  // reading on B before starting the count so the corner has settled on
  // B's tip and the transitional post-change fetches are not counted here.
  const switchToB = await changeNodeAndAwait(
    cx, B_ORIGIN,
    (c) => c.ledClass === 'led fresh' && /^verified across \d+ nodes · tip \d+$/.test(c.title ?? ''),
    'led fresh + verified across N nodes (after switch to B)',
    60000);
  console.log(`[vt] 17b switch to B: applied=${JSON.stringify(switchToB.applied)}, stored=${JSON.stringify(switchToB.stored)}, led=${switchToB.reading.ledClass}, title=${JSON.stringify(switchToB.reading.title)}`);
  const hA17bBStart = await currentHeight(NODE);
  const step17bBReadings = await pressCornerRepeatedly(cx, 30);
  const hA17bBEnd = await currentHeight(NODE);
  const allFresh17bB = step17bBReadings.every((r) => r.ledClass === 'led fresh' && /^verified across \d+ nodes · tip \d+$/.test(r.title ?? ''));
  const refused17bBIdx = step17bBReadings.findIndex((r) => r.ledClass === 'led refused');
  const totalProofs17bB = step17bBReadings.reduce((n, r) => n + r.proofs, 0);
  console.log(`[vt] 17b B-direction readings: ${JSON.stringify(step17bBReadings)}`);

  // Blank the row so subsequent steps start on the seed-list default (A).
  const post17b = await blankNodeAndAwaitVerified(cx);
  console.log(`[vt] 17b post-blank: applied=${JSON.stringify(post17b.applied)}, stored=${JSON.stringify(post17b.stored)}, led=${post17b.reading.ledClass}, title=${JSON.stringify(post17b.reading.title)}`);

  const refusedDesc = (readings, idx) => idx === -1 ? 'none' : `#${idx + 1} title=${JSON.stringify(readings[idx].title)}`;
  const ok17b = allFresh17bA && allFresh17bB;
  record('17b', ok17b,
    `direction A (reading ${NODE}): presses=${step17bAReadings.length}, all led fresh + verified=${allFresh17bA}, first led-refused press=${refusedDesc(step17bAReadings, refused17bAIdx)}, proof requests total=${totalProofs17bA}, per-press led counts=${JSON.stringify(tallyLeds(step17bAReadings))}, A height first=${hA17bAStart} last=${hA17bAEnd}; direction B (reading ${B_ORIGIN}): presses=${step17bBReadings.length}, all led fresh + verified=${allFresh17bB}, first led-refused press=${refusedDesc(step17bBReadings, refused17bBIdx)}, proof requests total=${totalProofs17bB}, per-press led counts=${JSON.stringify(tallyLeds(step17bBReadings))}, A height first=${hA17bBStart} last=${hA17bBEnd}`);

  // ---- Step 18 — thin (B stopped), then verified again (B started).
  {
    console.log(`[vt] stopping node B by its handle`);
    await stopChild('b');
    // B's stop is observed through B's own HTTP going silent; the assertion
    // then reads *only one node could be checked* without racing gossip.
    const bGone = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        const h = await currentHeight(B_ORIGIN);
        if (h === null) return true;
        await sleep(200);
      }
      return false;
    })();

    const stopped = await pressAndReadVerdict(cx, { atLeast: 1, ms: 60000, quietMs: 2000 });
    // Wait for the corner to settle on the one-node title even if the poll
    // above races the verdict render.
    const reachedStopped = await waitForCornerState(cx,
      (c) => c.ledClass === 'led thin' && /^only one node could be checked · tip \d+$/.test(c.title ?? ''),
      'led thin + "only one node could be checked · tip N"',
      60000);
    const readingStopped = reachedStopped.last ?? stopped.reading;
    const stoppedOk = !reachedStopped.timedOut
      && readingStopped.ledClass === 'led thin'
      && readingStopped.tipClass === 'tip mono'
      && /^only one node could be checked · tip \d+$/.test(readingStopped.title ?? '');

    console.log(`[vt] spawning node B again on the same store: ${bDbPath}`);
    spawnDaemon('b', NODE_DIST, {
      NETWORK_TYPE: 'devnet',
      NODE_ROLE: 'server',
      PORT: String(B_HTTP_PORT),
      ADMIN_PORT: String(B_ADMIN_PORT),
      LISTEN_ADDRS: `/ip4/127.0.0.1/tcp/${B_P2P_PORT}`,
      BOOTSTRAP_PEERS: NODE_P2P,
      DB_PATH: bDbPath,
    });
    const bBackUp = await waitForHttpUp(B_ORIGIN, 30000);
    const synced2 = bBackUp ? await waitForHeightsClose(NODE, B_ORIGIN, 2, 300000) : null;

    const back = await pressAndReadVerdict(cx, { atLeast: 2, ms: 60000, quietMs: 2000 });
    const backOk = back.reading.ledClass === 'led fresh'
      && back.reading.tipClass === 'tip mono'
      && /^verified across \d+ nodes · tip \d+$/.test(back.reading.title ?? '');

    record(18, stoppedOk && backOk && bGone,
      `B gone=${bGone}; stopped-press led=${readingStopped.ledClass}, tip=${readingStopped.tipClass}, title=${JSON.stringify(readingStopped.title)}, stopped proof requests=${stopped.proofs.length}; restarted synced=${synced2 !== null ? JSON.stringify(synced2) : 'null'}; restart-press led=${back.reading.ledClass}, tip=${back.reading.tipClass}, title=${JSON.stringify(back.reading.title)}, restart proof requests=${back.proofs.length}`);
  }

  // ---- Step 19a — refused, a bad proof (via the lying relay).
  let relay = null;
  {
    console.log(`[vt] starting lying relay: :${RELAY_PORT} → ${NODE}`);
    relay = await startLyingRelay(NODE);
    const {
      applied, stored, reached, reading, proofs,
    } = await changeNodeAndAwait(
      cx, RELAY_ORIGIN,
      (c) => c.ledClass === 'led refused' && /^this node's proof did not verify · tip \d+$/.test(c.title ?? ''),
      'led refused + "this node\'s proof did not verify · tip N"',
      60000);
    const feedCards = await cx.eval(`document.querySelectorAll('#feed .card').length`);
    const feedContainer = await cx.eval(`!!document.querySelector('#feed')`);
    const tipCheck = await titleTipNearReadingNode(RELAY_ORIGIN, reading);
    const ok = !reached.timedOut
      && stored === RELAY_ORIGIN
      && applied === RELAY_ORIGIN
      && reading.ledClass === 'led refused'
      && reading.tipClass === 'tip mono clay'
      && /^this node's proof did not verify · tip \d+$/.test(reading.title ?? '')
      && tipCheck.near
      && feedContainer;
    record('19a', ok,
      `prefs.node stored=${JSON.stringify(stored)}, applied=${JSON.stringify(applied)}, led=${reading.ledClass}, tip=${reading.tipClass}, title=${JSON.stringify(reading.title)}, title tip=${tipCheck.tipTitle} vs relay height=${tipCheck.nodeHeight} near=${tipCheck.near}, feed container present=${feedContainer}, feed .card count=${feedCards}, proof requests during change=${proofs.length} (${JSON.stringify(proofs.map(p => p.url))}), relay flips=${relay.flips.total}`);
    const post = await blankNodeAndAwaitVerified(cx);
    console.log(`[vt] 19a post-blank: applied=${JSON.stringify(post.applied)}, stored=${JSON.stringify(post.stored)}, led=${post.reading.ledClass}, title=${JSON.stringify(post.reading.title)}`);
  }

  // ---- Step 19b — refused (outworked), by a real fork on node C.
  {
    const cSecret = randomBytes(32).toString('hex');
    const cDbPath = join(SCRATCH, 'c.db');
    for (const suffix of ['', '-shm', '-wal']) {
      try { rmSync(cDbPath + suffix, { force: true }); } catch {}
    }
    // Phase 1 — C boots as A's peer, syncs to A's tip. No miner script yet.
    console.log(`[vt] 19b phase 1: spawning C bootstrapped from A: port=${C_HTTP_PORT} admin=${C_ADMIN_PORT} p2p=${C_P2P_PORT}`);
    spawnDaemon('c', NODE_DIST, {
      NETWORK_TYPE: 'devnet',
      NODE_ROLE: 'miner',
      PORT: String(C_HTTP_PORT),
      ADMIN_PORT: String(C_ADMIN_PORT),
      LISTEN_ADDRS: `/ip4/127.0.0.1/tcp/${C_P2P_PORT}`,
      BOOTSTRAP_PEERS: NODE_P2P,
      DB_PATH: cDbPath,
      MINING_SECRET: cSecret,
    });
    const cUp = await waitForHttpUp(C_ORIGIN, 30000);
    if (!cUp) {
      record('19b', false, `node C did not come up at ${C_ORIGIN}`);
    } else {
      // Wait for C to sync to A's tip within 2 blocks, and for its own height
      // to reach ≥ 40 so the winner's `k`-header suffix is well past genesis.
      const cSync = await waitForHeightsClose(NODE, C_ORIGIN, 2, 600000);
      const hCsync = await currentHeight(C_ORIGIN);
      if (cSync === null || hCsync === null || hCsync < 40) {
        record('19b', false, `C never synced to A within 2 blocks and reached ≥ 40 (hC=${hCsync}, sync=${JSON.stringify(cSync)}). A's miner may be paced too slowly.`);
      } else {
        console.log(`[vt] 19b phase 1: C synced at ${hCsync} (A=${(await currentHeight(NODE))})`);
        // Phase 2 — stop C, restart on the same store, cut off from A. New
        // listen port so A's cached address for C is stale (packages/net/src/
        // peerdb.ts stores the old address); MAX_PEERS=0 and empty
        // BOOTSTRAP_PEERS block C's outbound; the three assertions read
        // peers_connected=0 to prove it.
        await stopChild('c');
        console.log(`[vt] 19b phase 2: restarting C isolated (BOOTSTRAP_PEERS='', MAX_PEERS=0, p2p=${C_P2P_PORT_ISOLATED})`);
        spawnDaemon('c', NODE_DIST, {
          NETWORK_TYPE: 'devnet',
          NODE_ROLE: 'miner',
          PORT: String(C_HTTP_PORT),
          ADMIN_PORT: String(C_ADMIN_PORT),
          LISTEN_ADDRS: `/ip4/127.0.0.1/tcp/${C_P2P_PORT_ISOLATED}`,
          BOOTSTRAP_PEERS: '',
          DB_PATH: cDbPath,
          MINING_SECRET: cSecret,
          MAX_PEERS: '0',
        });
        const cBackUp = await waitForHttpUp(C_ORIGIN, 30000);
        if (!cBackUp) {
          record('19b', false, `C did not come back up at ${C_ORIGIN} after restart`);
        } else {
          // Phase 3 — mine 3 blocks on C while A mines on. Stop C's miner as
          // soon as C is +3 above its sync height.
          const hCbeforeMine = await currentHeight(C_ORIGIN);
          console.log(`[vt] 19b phase 3: C isolated at height=${hCbeforeMine}, starting C's miner for ~3 blocks`);
          spawnDaemon('c-miner', MINER_SCRIPT, {
            NODE_URL: C_ORIGIN,
            MINING_SECRET: cSecret,
            MINER_PCT: '100',
          });
          const hCafterMine = await waitForHeight(C_ORIGIN, hCbeforeMine + 3, 600000);
          await stopChild('c-miner');
          // C may land one more block already in flight after the miner stops.
          await sleep(1500);
          const hCafterSettle = await currentHeight(C_ORIGIN);
          console.log(`[vt] 19b phase 3: C reached height=${hCafterSettle} after +3 mine`);

          // Phase 4 — wait for A to stand above C. A paced A-miner does not
          // necessarily overtake C's three fresh blocks by the moment C stops
          // mining (`CLAUDE.md → "The proof"` — *"a few blocks a minute"*);
          // the three assertions below read A > C and stand only once the
          // pace has carried A past hCafterSettle. A five-minute bound is
          // plenty at that pace; its expiry is a FAIL of 19b that names both
          // heights.
          const hAoverC = await (async () => {
            const t0 = Date.now();
            while (Date.now() - t0 < 300000) {
              const h = await currentHeight(NODE);
              if (typeof h === 'number' && typeof hCafterSettle === 'number' && h > hCafterSettle) return h;
              await sleep(500);
            }
            return null;
          })();
          if (hAoverC === null) {
            const hAlast = await currentHeight(NODE);
            record('19b', false, `A did not overtake C within 5 minutes (hC=${hCafterSettle}, hA=${hAlast}); A's miner may be paced too slowly`);
          } else {
            console.log(`[vt] 19b phase 4: A overtook C at hA=${hAoverC} (hC=${hCafterSettle})`);
            // Assertions — peers_connected=0 on C, C's block at hCnow ≠ A's,
            // A > C. The block-at-height read (`/blocks/:height`,
            // NODE_INTERFACE → Blocks) carries the full header; two different
            // ordering blocks always differ in header (utxoTxRoot, stateRoot,
            // powNonce, validatorSignature), so a header hash off it is the
            // block's identity for a compare.
            const cAdminOrigin = `http://127.0.0.1:${C_ADMIN_PORT}`;
          const cHealth = await fetch(`${cAdminOrigin}/health`).then((r) => r.json()).catch(() => null);
          const cPeers = cHealth?.peers_connected ?? null;
          const hAnow = await currentHeight(NODE);
          const hCnow = await currentHeight(C_ORIGIN);
          const forkH = Math.min(hAnow ?? 0, hCnow ?? 0);
          const cBlockAtFork = forkH > 0
            ? await fetch(`${C_ORIGIN}/blocks/${forkH}`).then((r) => r.json()).catch(() => null)
            : null;
          const aBlockAtFork = forkH > 0
            ? await fetch(`${NODE}/blocks/${forkH}`).then((r) => r.json()).catch(() => null)
            : null;
          const blockSig = (b) => {
            if (!b || typeof b !== 'object' || !b.header) return null;
            return createHash('sha256').update(JSON.stringify(b.header)).digest('hex');
          };
          const cSig = blockSig(cBlockAtFork);
          const aSig = blockSig(aBlockAtFork);
          const forkOk = cPeers === 0
            && typeof cSig === 'string'
            && typeof aSig === 'string'
            && cSig !== aSig
            && typeof hAnow === 'number' && typeof hCnow === 'number' && hAnow > hCnow;
          console.log(`[vt] 19b assertions: peers_connected=${cPeers}, hA=${hAnow}, hC=${hCnow}, forkH=${forkH}, cBlock.sig=${cSig?.slice(0, 12) ?? 'null'}…, aBlock.sig=${aSig?.slice(0, 12) ?? 'null'}…, fork=${forkOk}`);
          if (!forkOk) {
            record('19b', false,
              `fork preconditions failed: C peers_connected=${cPeers}, hA=${hAnow}, hC=${hCnow}, C.block@${forkH}.sig=${cSig?.slice(0, 12) ?? 'null'}…, A.block@${forkH}.sig=${aSig?.slice(0, 12) ?? 'null'}…`);
          } else {
            // The outworked title names the WINNER (contract → "the host with
            // its port, never the URL"), not the reading node — A holds more
            // work than C, so the title reads A's host beside the reading
            // node's own tip. The tip is C's tip (contract → the last four
            // rows are beside the result's own tip).
            const aHostForTitle = `127.0.0.1:${new URL(NODE).port}`;
            const {
              applied, stored, reached, reading, proofs,
            } = await changeNodeAndAwait(
              cx, C_ORIGIN,
              (c) => c.ledClass === 'led refused'
                  && /holds more work than this node · tip \d+/.test(c.title ?? '')
                  && (c.title ?? '').includes(aHostForTitle),
              `led refused + "${aHostForTitle} holds more work than this node · tip N"`,
              60000);
            const titleRe = new RegExp(`^${aHostForTitle.replace(/\./g, '\\.')} holds more work than this node · tip \\d+$`);
            const tipCheck = await titleTipNearReadingNode(C_ORIGIN, reading);
            const ok = !reached.timedOut
              && applied === C_ORIGIN
              && stored === C_ORIGIN
              && reading.ledClass === 'led refused'
              && reading.tipClass === 'tip mono clay'
              && titleRe.test(reading.title ?? '')
              && tipCheck.near;
            record('19b', ok,
              `prefs.node stored=${JSON.stringify(stored)}, applied=${JSON.stringify(applied)}, led=${reading.ledClass}, tip=${reading.tipClass}, title=${JSON.stringify(reading.title)}, title tip=${tipCheck.tipTitle} vs C height=${tipCheck.nodeHeight} near=${tipCheck.near}, C peers_connected=${cPeers}, hA=${hAnow}, hC=${hCnow}, C.block@${forkH}.sig=${cSig.slice(0, 12)}…, A.block@${forkH}.sig=${aSig.slice(0, 12)}…, proof requests=${proofs.length} (${JSON.stringify(proofs.map(p => p.url))})`);
          }
          }
          const post = await blankNodeAndAwaitVerified(cx);
          console.log(`[vt] 19b post-blank: applied=${JSON.stringify(post.applied)}, stored=${JSON.stringify(post.stored)}, led=${post.reading.ledClass}, title=${JSON.stringify(post.reading.title)}`);
        }
      }
    }
  }

  // ---- Step 19c — thin (split), on fresh isolated D with its own miner past 30.
  {
    console.log(`[vt] 19c: starting D's miner until D passes height 30`);
    spawnDaemon('d-miner', MINER_SCRIPT, {
      NODE_URL: D_ORIGIN,
      MINING_SECRET: dSecret,
      MINER_PCT: '100',
    });
    const dHeight = await waitForHeight(D_ORIGIN, 31, 600000);
    await stopChild('d-miner');
    await sleep(1500);
    const hDafter = await currentHeight(D_ORIGIN);
    if (dHeight === null) {
      record('19c', false, `node D never reached height 31 within 10 minutes (last=${hDafter})`);
    } else {
      const {
        applied, stored, reached, reading, proofs,
      } = await changeNodeAndAwait(
        cx, D_ORIGIN,
        (c) => c.ledClass === 'led thin' && /^the nodes share no block to compare · tip \d+$/.test(c.title ?? ''),
        'led thin + "the nodes share no block to compare · tip N"',
        60000);
      const tipCheck = await titleTipNearReadingNode(D_ORIGIN, reading);
      const ok = !reached.timedOut
        && applied === D_ORIGIN
        && stored === D_ORIGIN
        && reading.ledClass === 'led thin'
        && reading.tipClass === 'tip mono'
        && /^the nodes share no block to compare · tip \d+$/.test(reading.title ?? '')
        && tipCheck.near;
      record('19c', ok,
        `prefs.node stored=${JSON.stringify(stored)}, applied=${JSON.stringify(applied)}, led=${reading.ledClass}, tip=${reading.tipClass}, title=${JSON.stringify(reading.title)}, title tip=${tipCheck.tipTitle} vs D height=${tipCheck.nodeHeight} near=${tipCheck.near}, hD=${hDafter}, proof requests=${proofs.length} (${JSON.stringify(proofs.map(p => p.url))})`);
    }
    const post = await blankNodeAndAwaitVerified(cx);
    console.log(`[vt] 19c post-blank: applied=${JSON.stringify(post.applied)}, stored=${JSON.stringify(post.stored)}, led=${post.reading.ledClass}, title=${JSON.stringify(post.reading.title)}`);
  }

  // ---- Step 20 — no verifier, on the hosted origin.
  if (PUBLIC === null) {
    record(20, 'NOT RUN', 'no --public / --web-dist — the hosted origin is not served');
  } else {
    console.log(`[vt] step 20: opening the hosted origin at ${publicOrigin}${publicBase}`);
    const bcx = await openBrowserSession();
    const hostedUrl = publicOrigin + publicBase; // workspace mode, no verifier
    const created = await bcx.call('Target.createTarget', { url: hostedUrl });
    const info = await findTargetById(created.targetId, 15000);
    if (!info) {
      record(20, false, `hosted target ${created.targetId.slice(0, 8)}… never appeared in /json/list`);
    } else {
      const cxH = await openSession(info.webSocketDebuggerUrl);
      let cornerReady = null;
      try {
        await cxH.waitFor(`!!document.querySelector('.corner')`, 'corner on hosted', 30000);
        // Wait for the first /blocks/current answer so lastRiseAt is set —
        // the corner opens fresh on a first tick.
        await cxH.waitFor(`(() => { const t = document.querySelector('.corner .tip'); return !!t && t.textContent && t.textContent !== '—'; })()`, 'first tip on hosted', 30000);
        cornerReady = await readCorner(cxH);
      } catch (e) {
        cornerReady = { present: false, error: String(e) };
      }
      // Idle 20 s + a press + 5 s: zero /nipopow/ requests on this page.
      const idleStart = cxH.events.length;
      await sleep(20000);
      const idleProofs = cxH.events.slice(idleStart).filter((e) =>
        e.method === 'Network.requestWillBeSent' && (e.params?.request?.url ?? '').includes('/nipopow/'));
      const pressStart = cxH.events.length;
      await pressCorner(cxH);
      await sleep(5000);
      const pressProofs = cxH.events.slice(pressStart).filter((e) =>
        e.method === 'Network.requestWillBeSent' && (e.params?.request?.url ?? '').includes('/nipopow/'));
      const readingAfter = await readCorner(cxH);
      const ok = readingAfter.present
        && readingAfter.ledClass === 'led fresh'
        && readingAfter.tipClass === 'tip mono'
        && /blocks progressing/.test(readingAfter.title ?? '')
        && idleProofs.length === 0
        && pressProofs.length === 0;
      record(20, ok,
        `hosted corner at open led=${cornerReady?.ledClass ?? 'null'}, tip=${cornerReady?.tipClass ?? 'null'}, title=${JSON.stringify(cornerReady?.title ?? null)}; after press led=${readingAfter.ledClass}, tip=${readingAfter.tipClass}, title=${JSON.stringify(readingAfter.title)}; idle-20s /nipopow/ requests=${idleProofs.length}, after-press /nipopow/ requests=${pressProofs.length}`);
      try { cxH.s.close(); } catch {}
      await bcx.call('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
    }
    try { bcx.s.close(); } catch {}
  }

  // ---- Cleanup — every child by its handle, and the lying relay's server.
  console.log(`[vt] cleanup: stopping all children by handle`);
  await stopAllChildren();
  if (relay) {
    try { relay.server.close(); } catch {}
  }
  console.log(`[vt] cleanup done; live children left=${vtChildren.size}`);
}

// Press the corner N times, one second apart, waiting for the verifier's run
// after each press. Returns the readings in press order.
async function pressCornerRepeatedly(cx, presses, opts = {}) {
  const readings = [];
  for (let i = 1; i <= presses; i++) {
    const startIdx = cx.events.length;
    await pressCorner(cx);
    const proofs = await waitForVerifierRun(
      cx, startIdx, opts.atLeast ?? 2, opts.ms ?? 30000, opts.quietMs ?? 1500);
    await sleep(200);
    const r = await readCorner(cx);
    readings.push({
      press: i,
      ledClass: r.ledClass,
      tipClass: r.tipClass,
      tipText: r.tipText,
      title: r.title,
      proofs: proofs.length,
      proofUrls: proofs.map((p) => p.url),
    });
    if (i < presses) await sleep(1000);
  }
  return readings;
}

function tallyLeds(readings) {
  const out = {};
  for (const r of readings) out[r.ledClass ?? 'null'] = (out[r.ledClass ?? 'null'] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// The verified-figures block — steps 21 · 24 · 22a · 22b · 23 · 25
// (WEB_INTERFACE → The extension → "The verified figures"). The figures run
// hangs on a verified tip, which needs a second verified node, so the block
// runs B as the tip block does — bringUpNodeB verbatim after the A pre-flight
// and stopChild('b') at the end. 21 and 24 read A; the lie arms 22a · 22b · 23
// read the figures relay, after 24 and while B is up; 25 reads the hosted web
// build. Pacing is external: the paced miner runs outside the harness, started
// before promote.mjs and kept to the end.
// ---------------------------------------------------------------------------

// K in the tip verifier — packages/web/src/extension/tip-verifier.ts:18. The
// wait for silence is at least K + 1 blocks past the landing block, so the
// tool proves the new box at suffixHead and silence fires (row 6).
const FIGURES_K = 20;

// The App's figures verifier fetches `/api/v1/proof/<key>?atHeight=<h>` for
// each listed box and the identity record; the request pattern is the
// observable that a figures run happened — the parallel to
// `proofRequestsSince` for the tip run's `/nipopow/proof/`. With `origin`,
// only the requests to that node count: a run proves against the reading node.
function figuresProofRequestsSince(events, startIdx, origin = null) {
  const out = [];
  for (let i = startIdx; i < events.length; i++) {
    const ev = events[i];
    if (ev.method !== 'Network.requestWillBeSent') continue;
    const url = ev.params?.request?.url ?? '';
    if (!url.includes('/api/v1/proof/')) continue;
    if (origin !== null && !url.startsWith(origin + '/')) continue;
    out.push({ url, at: ev.__at ?? null, index: i });
  }
  return out;
}

// Wait for the figures run following the tip run's `verified` verdict — the
// App triggers startFigures from the verified arm of startVerification. The
// end of the run is a settled interval with no new /api/v1/proof/ request; a
// run that fires no request at all (an anchor that never resolved to verified,
// a listing the App has not read) returns an empty list at the bound. With
// `origin`, only the runs against that node count.
async function waitForFiguresRun(cx, sinceIdx, ms = 30000, quietMs = 2000, origin = null) {
  const t0 = Date.now();
  let last = 0;
  let lastAt = t0;
  while (Date.now() - t0 < ms) {
    const now = figuresProofRequestsSince(cx.events, sinceIdx, origin).length;
    if (now !== last) { last = now; lastAt = Date.now(); }
    if (now > 0 && Date.now() - lastAt >= quietMs) return figuresProofRequestsSince(cx.events, sinceIdx, origin);
    await sleep(100);
  }
  return figuresProofRequestsSince(cx.events, sinceIdx, origin);
}

// Press the corner and wait for BOTH the tip run and the figures run to settle.
// The tip run's 2 proofs come first (one per node); the figures run follows on
// the `verified` arm. The two waits share the same startIdx — `sinceIdx` cross
// their event ranges without ambiguity.
async function pressCornerAndReadFigures(cx, opts = {}) {
  const startIdx = cx.events.length;
  await pressCorner(cx);
  await waitForVerifierRun(cx, startIdx, opts.tipAtLeast ?? 2, opts.tipMs ?? 30000, opts.tipQuietMs ?? 1500);
  const figProofs = await waitForFiguresRun(cx, startIdx, opts.figMs ?? 30000, opts.figQuietMs ?? 2000);
  await sleep(300);
  return { figProofs };
}

// Read the wallet's balance row and pick out the FIGURES hint alone
// (WEB_INTERFACE → The wallet window). The `.credits-line` can carry two
// `div.hint` children: a locked-credits hint (`N $NOTIS more unlock by block
// M.`, wallet.ts:219–221) and the verified-figures hint (WEB_INTERFACE → The
// extension → "The verified figures"). The two are disjoint by voice — the
// figures line carries one of the contract's sentences named below — so a
// text-shape match separates them without a class of their own.
async function readCreditsRow(cx) {
  return cx.eval(`(() => {
    const line = document.querySelector('.credits-line');
    if (!line) return { present: false };
    const hints = [...line.querySelectorAll('.hint')].map((h) => ({
      text: h.textContent ?? '',
      hasClay: h.classList.contains('clay'),
    }));
    const gold = line.querySelector('.mono.gold');
    const isFiguresHint = (t) =>
      /proven at block/.test(t) ||
      /landed since/.test(t) ||
      /not checked yet/.test(t) ||
      /chain is not verified/.test(t) ||
      /chain does not hold/.test(t) ||
      /did not verify/.test(t) ||
      /no proof for/.test(t);
    const figHint = hints.find((h) => isFiguresHint(h.text)) ?? null;
    return {
      present: true,
      allHints: hints,
      figHintText: figHint?.text ?? null,
      figHintHasClay: figHint?.hasClay ?? false,
      goldText: gold?.textContent ?? null,
      goldHasClay: gold ? gold.classList.contains('clay') : false,
    };
  })()`);
}

// Read the profile's rep row (WEB_INTERFACE → The profile window; the DOM
// shape is `.karma-field > span.mono + optional .hint`).
async function readKarmaField(cx) {
  return cx.eval(`(() => {
    const field = document.querySelector('.karma-field');
    if (!field) return { present: false };
    const hint = field.querySelector('.hint');
    const mono = field.querySelector('span.mono');
    return {
      present: true,
      hintText: hint?.textContent ?? null,
      hintHasClay: hint ? hint.classList.contains('clay') : false,
      monoText: mono?.textContent ?? null,
      monoHasClay: mono ? mono.classList.contains('clay') : false,
    };
  })()`);
}

// Poll a row through `read` (readCreditsRow, readKarmaField) until `predicate`
// holds or `ms` passes. Returns `{ timedOut, last }` — the last reading in both
// arms, as waitForCornerState does.
async function waitForRow(read, cx, predicate, ms) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await read(cx);
    if (predicate(last)) return { timedOut: false, last };
    await sleep(200);
  }
  return { timedOut: true, last };
}

// Press a window's header control — `open wallet`, `open profile`. A window
// not open opens and reads its listing; an open one is raised, never
// duplicated, and a raise reads nothing (WEB_INTERFACE → The workspace, → The
// profile window). A column renders its focused window's body alone, so a
// row is in the page only while its window is the one raised.
async function raiseWindow(cx, label) {
  await cx.eval(`document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}).click()`, true);
}

// Poll `/blocks/current` until the tip reaches `target`, or the bound trips.
// The bound is 12 min — at 3.4 blocks/min (packages/web/CLAUDE.md → The proof,
// 7g), K + 1 = 21 blocks is ~6 min, so twelve is comfortably above expectation.
// A trip returns { reached: false, last }, with `last` being the last read.
async function waitForNodeTip(target, ms = 12 * 60 * 1000, pollMs = 10000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await currentHeight(NODE);
    if (last !== null && last >= target) return { reached: true, last, elapsedMs: Date.now() - t0 };
    await sleep(pollMs);
  }
  return { reached: false, last, elapsedMs: Date.now() - t0 };
}

async function verifiedFiguresSteps(cx, targetId = 'unknown') {
  // Liveness probe — same shape as the tip block's, a three-second wall around
  // `1+1` against the session. A dead session records every step false with
  // the reason.
  const alive = await (async () => {
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('liveness timeout')), 3000));
    try { return (await Promise.race([cx.eval(`1+1`), timeout])) === 2; }
    catch { return false; }
  })();
  if (!alive) {
    const reason = `the verified-figures block's session is not live: ${targetId}`;
    for (const s of VERIFIED_FIGURES_STEPS) record(s, false, reason);
    return;
  }

  // ---- Pre-flight — A is up. The tip block's cleanup (stopAllChildren) stops
  // B when --verified-tip runs, and a run without --verified-tip never starts
  // it, so B is always down here. The figures block owns its own B: the tip
  // block's calls verbatim (bringUpNodeB, waitForHttpUp, waitForPeers,
  // waitForHeightsClose). Step 25 needs no B and still runs when B does not
  // come up.
  const aUp = await waitForHttpUp(NODE, 15000);
  if (!aUp) {
    for (const s of [21, 24, ...LIE_ARM_STEPS]) record(s, 'NOT RUN', `node A did not answer /blocks/current at ${NODE}`);
    await runFiguresStep25();
    return;
  }
  const preHeightA = await currentHeight(NODE);
  console.log(`[vf] pre-flight: A height=${preHeightA} at ${NODE}`);

  // Bring up B — bringUpNodeB wipes b.db and spawns fresh from NODE_DIST,
  // bootstrapped from NODE_P2P. The tip block's cleanup left b.db orphaned
  // in SCRATCH; a wipe here is what the tip block does too (bringUpNodeB
  // top). A failure below records 21, 24 and the lie arms NOT RUN with the
  // reason; 25 needs no B.
  console.log(`[vf] bringing up node B for the figures run`);
  await bringUpNodeB();
  const bUp = await waitForHttpUp(B_ORIGIN, 30000);
  if (!bUp) {
    for (const s of [21, 24, ...LIE_ARM_STEPS]) record(s, 'NOT RUN', `node B did not come up at ${B_ORIGIN}`);
    await runFiguresStep25();
    await stopChild('b');
    return;
  }
  console.log(`[vf] node B up at ${B_ORIGIN}`);
  const bAdminOrigin = `http://127.0.0.1:${B_ADMIN_PORT}`;
  const bPeers = await waitForPeers(bAdminOrigin, 1, 60000);
  console.log(`[vf] node B peers_connected=${bPeers}`);
  if (bPeers === null) {
    for (const s of [21, 24, ...LIE_ARM_STEPS]) record(s, 'NOT RUN', `node B never reached ≥1 peer_connected within 60s (bootstrap ${NODE_P2P})`);
    await runFiguresStep25();
    await stopChild('b');
    return;
  }
  const abSynced = await waitForHeightsClose(NODE, B_ORIGIN, 2, 300000);
  if (abSynced === null) {
    const hA = await currentHeight(NODE);
    const hB = await currentHeight(B_ORIGIN);
    for (const s of [21, 24, ...LIE_ARM_STEPS]) record(s, 'NOT RUN', `B never caught up to A within 5 minutes (A=${hA}, B=${hB})`);
    await runFiguresStep25();
    await stopChild('b');
    return;
  }
  console.log(`[vf] A/B synced: ${JSON.stringify(abSynced)}`);

  try {
    // ---- Pre-condition — a corner press must read led fresh + *verified
    // across 2 nodes*. Without it, the rows would carry row 3's *not checked
    // — the chain is not verified* (WEB_INTERFACE → The extension → "The
    // verified figures"), not the lines the steps assert. The reading is
    // copied into every step line it gates.
    await cx.waitFor(`!!document.querySelector('.corner')`, 'corner mounted 21', 30000);
    const verifiedReading = await pressAndReadVerdict(cx, { atLeast: 2, ms: 60000, quietMs: 2000 });
    const verifiedOk = verifiedReading.reading.ledClass === 'led fresh'
      && /^verified across 2 nodes · tip \d+$/.test(verifiedReading.reading.title ?? '');
    if (!verifiedOk) {
      const detail = `pre-condition press: led=${verifiedReading.reading.ledClass}, tip=${verifiedReading.reading.tipClass}, title=${JSON.stringify(verifiedReading.reading.title)}, proof requests=${verifiedReading.proofs.length}; the figures verifier fires only under 'verified' (WEB_INTERFACE → The extension → "The verified figures")`;
      for (const s of [21, 24, ...LIE_ARM_STEPS]) record(s, false, detail);
      await runFiguresStep25();
      return;
    }
    console.log(`[vf] pre-condition ok: led=${verifiedReading.reading.ledClass}, title=${JSON.stringify(verifiedReading.reading.title)}`);

    // ---- Step 21 — the balance: young → silent after K+1 blocks.
    await runFiguresStep21(cx);

    // ---- Step 24 — rep: silent → post → landed since → silent after K+1 blocks.
    await runFiguresStep24(cx);

    // ---- Steps 22a · 22b · 23 — the lie arms, through the figures relay,
    // while B is up: the relay's verdict is read across the relay, A and B.
    await runFiguresLieArms(cx);

    // ---- Step 25 — no verifier, no /api/v1/proof/ request on the hosted origin.
    await runFiguresStep25();
  } finally {
    // ---- Cleanup — B by its handle, as the tip block does. The tip block's
    // own cleanup already ran if --verified-tip preceded us; this stops the B
    // the figures block itself brought up.
    console.log(`[vf] cleanup: stopping node B by handle`);
    await stopChild('b');
    console.log(`[vf] cleanup done; live children left=${vtChildren.size}`);
  }
}

// Step 21 — the balance's young → silent transition. A send to the devnet
// faucet key produces a fresh change output on R; the young state is the
// change box below suffixHead. After K + 1 blocks the change is proven and
// row 6 fires — silence (WEB_INTERFACE → The extension → "The verified
// figures", → The wallet window → "The `balance` row").
async function runFiguresStep21(cx) {
  try {
    // Ensure the wallet window is open. If the header's control is not there
    // (a page reopened without an identity), the step fails at once.
    const walletBtn = await cx.eval(`!!document.querySelector('[aria-label="open wallet"]')`);
    if (!walletBtn) {
      record(21, false, 'no [aria-label="open wallet"] control on the extension page — identity not loaded?');
      return;
    }
    // Open the wallet, or raise it where it is open.
    await raiseWindow(cx, 'open wallet');

    // Read the balance before the send. The row mounts before its listing
    // lands — `—` until the read answers — so the wait is on the figure
    // itself, with a bound. If R has no spendable, no send is possible.
    const figure = await waitForRow(readCreditsRow, cx,
      (r) => r.present && (r.goldText ?? '').trim() !== '', 60000);
    const goldBefore = figure.last?.goldText ?? null;
    const balanceNum = Number(goldBefore);
    if (figure.timedOut || !Number.isFinite(balanceNum) || balanceNum < 2) {
      record(21, false, `R has too little \$NOTIS to send (gold=${JSON.stringify(goldBefore)}, figure ${figure.timedOut ? 'absent after 60 s' : 'read'}, hints=${JSON.stringify(figure.last?.allHints ?? null)}); the figures block needs a spendable balance to create the young change output`);
      return;
    }
    // Send half the balance to the devnet faucet key — the change output is
    // R's own new box, young until K blocks pass. The exact amount is not
    // load-bearing; a fraction is fine.
    const sendAmount = (balanceNum / 2).toFixed(2);
    const preSendH = await currentHeight(NODE);
    await cx.waitFor(`!!document.querySelector('form.credits-form')`, 'send form 21');
    await cx.eval(`(() => {
      const form = document.querySelector('form.credits-form');
      const inputs = form.querySelectorAll('input');
      inputs[0].value = ${JSON.stringify(DEVNET_FAUCET_KEY)};
      inputs[1].value = ${JSON.stringify(sendAmount)};
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    })()`, true);
    // The extension arm opens a prompt window at once (the resolved-key hint
    // appears alongside; no confirm row in the field). Approve.
    const prompt21 = await findExt('prompt.html');
    if (!prompt21) {
      record(21, false, 'no prompt window opened for the step 21 send');
      return;
    }
    const cxp = await openSession(prompt21.webSocketDebuggerUrl);
    try {
      await cxp.waitFor(`!!document.querySelector('.prompt button.btn-primary')`, 'prompt approve 21', 15000);
      await cxp.eval(`document.querySelector('.prompt button.btn-primary').click()`, true);
    } finally {
      await sleep(1500);
      try { cxp.s.close(); } catch {}
    }

    // Wait for the wallet's row to reflect the change output (the row updates
    // when the send lands; the poll bound is generous — 3 minutes covers a
    // paced miner well past the change output's height).
    await cx.waitFor(
      `document.querySelector('.credits-line .mono.gold')?.textContent !== ${JSON.stringify(goldBefore)}`,
      'row updates after step 21 send', 180000);
    const landedH21 = await currentHeight(NODE);
    if (landedH21 === null) {
      record(21, false, 'could not read /blocks/current after the step 21 send landed');
      return;
    }

    // Assertion 1 — press the corner, read the young line. A verified tip
    // re-reads the listings before it proves them, and a run can land after
    // another one it followed, so the line is awaited with a bound.
    const youngShape = /^\S.* \$NOTIS proven at block \d+ · \S.* \$NOTIS landed since$/;
    await pressCornerAndReadFigures(cx);
    const before = (await waitForRow(readCreditsRow, cx,
      (r) => r.present && youngShape.test(r.figHintText ?? ''), 15000)).last;
    const beforeOk = before.present
      && before.goldText !== null
      && !before.goldHasClay
      && before.figHintText !== null
      && !before.figHintHasClay
      && youngShape.test(before.figHintText);

    // Wait for the tip to reach landedH21 + K + 1 (~ 6 min at 3.4 blocks/min).
    const targetH = landedH21 + FIGURES_K + 1;
    const wait = await waitForNodeTip(targetH);
    const rate = wait.last !== null
      ? ((wait.last - landedH21) / (wait.elapsedMs / 60000)).toFixed(2)
      : 'null';
    if (!wait.reached) {
      record(21, false,
        `before: gold=${JSON.stringify(before.goldText)} clay=${before.goldHasClay} figHint=${JSON.stringify(before.figHintText)} shape ok=${beforeOk}; ` +
        `tip did not reach ${targetH} within ${(wait.elapsedMs / 1000).toFixed(0)}s (last=${wait.last}, ~${rate} blocks/min from landed=${landedH21}, K+1=${FIGURES_K + 1})`);
      return;
    }

    // Assertion 2 — press the corner, read silence, awaited with a bound: the
    // line of the run before stands until the press's own run lands.
    await pressCornerAndReadFigures(cx);
    const after = (await waitForRow(readCreditsRow, cx,
      (r) => r.present && r.figHintText === null && !r.goldHasClay, 15000)).last;
    const afterOk = after.present && after.figHintText === null && !after.goldHasClay;

    record(21, beforeOk && afterOk,
      `before press: gold=${JSON.stringify(before.goldText)} (clay=${before.goldHasClay}), figHint=${JSON.stringify(before.figHintText)} (clay=${before.figHintHasClay}), young shape ok=${beforeOk}; ` +
      `sent ${sendAmount} \$NOTIS at h≥${preSendH}, change landed at h=${landedH21}, target h=${targetH}; ` +
      `waited ${(wait.elapsedMs / 1000).toFixed(0)}s (~${rate} blocks/min); ` +
      `after press: gold=${JSON.stringify(after.goldText)} (clay=${after.goldHasClay}), figHint=${JSON.stringify(after.figHintText)}, silence=${after.figHintText === null}, all-hints=${JSON.stringify(after.allHints)}`);
  } catch (e) {
    record(21, false, `error: ${String(e)}`);
  }
}

// Step 24 — the rep row across R's own post (WEB_INTERFACE → The extension →
// "The verified figures", → The profile window → "The `rep` row is the
// `effective` number alone"). Silence before the post. The post's landing
// re-reads /karma, so the number moves to the node's new `effective` with no
// press. A press then proves the fresh listing, where the post's change is a
// young box: *… landed since*. K + 1 blocks on, a verified tip re-reads before
// it proves, and a press reads silence. R posts one root, spending
// POST_PRICE_THREAD (5) rep.
async function runFiguresStep24(cx) {
  try {
    const profileBtn = await cx.eval(`!!document.querySelector('[aria-label="open profile"]')`);
    if (!profileBtn) {
      record(24, false, 'no [aria-label="open profile"] control on the extension page — identity not loaded?');
      return;
    }
    // Open the profile, or raise it where it is open.
    await raiseWindow(cx, 'open profile');
    await cx.waitFor(`!!document.querySelector('.karma-field span.mono')`, 'profile rep number 24', 30000);

    // R's rep before the post. Under devnet's karmaDecayIntervalBlocks=3 and
    // KARMA_DECAY_AMOUNT=5 rep per interval, a stale key drains ~35 rep over
    // K+1 = 21 blocks, and a post costs POST_PRICE_THREAD = 5 rep: R needs a
    // buffer above the drain plus the post to reach the silence assertion.
    const initialRep = await cx.eval(`document.querySelector('.karma-field span.mono')?.textContent ?? null`);
    const initialRepNum = Number(initialRep);
    // Drain over the K+1 wait — at 3 blocks per interval, that's
    // ceil((K+1)/3) intervals × 5 rep. Plus 5 for the post. Plus KARMA_MINIMUM.
    const drainOverKPlus1 = Math.ceil((FIGURES_K + 1) / 3) * 5;
    const buffer = drainOverKPlus1 + 5 + 10;
    if (!Number.isFinite(initialRepNum) || initialRepNum < buffer) {
      record(24, false,
        `R has too little rep to survive the K+1 wait plus a post (rep=${initialRep}, drain estimate=${drainOverKPlus1}, buffer needed=${buffer})`);
      return;
    }

    // Assertion 1 — press the corner, read silence (every box proven).
    await pressCornerAndReadFigures(cx);
    const before = await readKarmaField(cx);
    const beforeOk = before.present && before.hintText === null && !before.monoHasClay;
    if (!beforeOk) {
      record(24, false,
        `before-post assertion failed: hint=${JSON.stringify(before.hintText)} (clay=${before.hintHasClay}), mono=${JSON.stringify(before.monoText)} clay=${before.monoHasClay}`);
      return;
    }
    // The number the post will move, and the listing it spends from as A
    // serves it — which boxes the post can leave unspent.
    const prePostRep = before.monoText;
    const karmaPre = await readNodeKarma();

    // Post one root through the composer. The rep policy is silent since
    // step 9, so no prompt fires — the post lands on submit alone.
    const preH24 = await currentHeight(NODE);
    await cx.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
    await cx.waitFor(`document.querySelector('.composer textarea')`, 'composer for step 24', 10000);
    const CONTENT_24 = 'proof-vf-24-' + Date.now();
    await cx.eval(`(() => {
      const ta = document.querySelector('.composer textarea');
      ta.value = ${JSON.stringify(CONTENT_24)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`, true);
    await cx.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'composer enabled 24', 15000);
    const postIdx = cx.events.length;
    await cx.eval(`document.querySelector('.composer .btn-primary').click()`, true);
    // A prompt would refuse the silent policy; assert none appears and go on.
    await sleep(2000);
    const promptOpen24 = await findExt('prompt.html');
    if (promptOpen24) {
      record(24, false, `a prompt opened for the step 24 post — policy is not silent`);
      return;
    }

    // The landing re-reads /karma: the number moves off the pre-post number
    // with no press, and it is the node's own `effective`. The profile is
    // raised first — the composer's submission may have moved the view — and
    // a raise reads nothing.
    await raiseWindow(cx, 'open profile');
    const landing = await waitForRow(readKarmaField, cx,
      (k) => k.present && k.monoText !== null && k.monoText !== prePostRep, 5 * 60 * 1000);
    const landedH24 = await currentHeight(NODE);
    const karmaPost = await readNodeKarma();
    if (landing.timedOut || landedH24 === null) {
      record(24, false,
        `before: silence ok=${beforeOk}; posted at h>${preH24}; the number never moved off ${prePostRep} within 5 min with no press (last=${JSON.stringify(landing.last)}); A's /karma effective=${karmaPost?.effective ?? 'null'}`);
      return;
    }
    const numberOk = landing.last.monoText === karmaPost?.effective && landing.last.monoText !== prePostRep;
    // A tip run in the wait — the ten-minute timer — re-reads /karma too; with
    // none, the move is the landing's own read.
    const tipRunsInLanding = proofRequestsSince(cx.events, postIdx).length;
    // The run the landing's own read starts, with no press — its reading is
    // recorded beside the step: the anchor it proves against predates the
    // post, so the change reads as a block landed since the anchor.
    const landingRun = await waitForFiguresRun(cx, postIdx, 30000, 2000);
    const landingLine = await readKarmaField(cx);

    // Assertion 2 — press the corner: a verified tip re-reads /karma before it
    // proves, and the post's change is a young box — *… landed since*, the
    // line awaited with a bound.
    const youngShapeRep = /^(\d+) rep proven at block \d+ · \d+ rep landed since$/;
    await pressCornerAndReadFigures(cx);
    const during = (await waitForRow(readKarmaField, cx,
      (k) => k.present && youngShapeRep.test(k.hintText ?? ''), 15000)).last;
    const duringOk = during.present
      && during.hintText !== null
      && !during.monoHasClay
      && !during.hintHasClay
      && youngShapeRep.test(during.hintText);
    const provenPart = youngShapeRep.exec(during.hintText ?? '')?.[1] ?? null;
    const provenSays = provenPart === null
      ? 'no proven part read'
      : provenPart === '0'
        ? 'proven part 0 — the post spent every karma box R held'
        : `proven part ${provenPart} — boxes the post left unspent`;

    // Wait for the tip to reach landedH24 + K + 1. The rep drain over the wait
    // is measured and reported; a drain below KARMA_MINIMUM (10) means R runs
    // out during the wait and the row's silence would come from an empty
    // ledger rather than a proven state.
    const targetH24 = landedH24 + FIGURES_K + 1;
    const wait24 = await waitForNodeTip(targetH24);
    const rate24 = wait24.last !== null
      ? ((wait24.last - landedH24) / (wait24.elapsedMs / 60000)).toFixed(2)
      : 'null';
    // Compute the drain — three blocks per interval, five rep per interval.
    const drainOverWait = wait24.last !== null
      ? Math.floor((wait24.last - preH24) / 3) * 5
      : null;
    const repAfterWait = await cx.eval(`document.querySelector('.karma-field span.mono')?.textContent ?? null`);
    const repAfterNum = Number(repAfterWait);
    if (!wait24.reached) {
      record(24, false,
        `before: silence ok=${beforeOk}; landing number ok=${numberOk}; during: hint=${JSON.stringify(during.hintText)} shape ok=${duringOk}; ` +
        `tip did not reach ${targetH24} within ${(wait24.elapsedMs / 1000).toFixed(0)}s (last=${wait24.last}, ~${rate24} blocks/min from landed=${landedH24}, K+1=${FIGURES_K + 1}); ` +
        `initial rep=${initialRep}, rep after wait=${repAfterWait}, drain estimate=${drainOverWait}`);
      return;
    }
    if (Number.isFinite(repAfterNum) && repAfterNum < 5) {
      record(24, false,
        `before: silence ok=${beforeOk}; landing number ok=${numberOk}; during: hint=${JSON.stringify(during.hintText)} shape ok=${duringOk}; ` +
        `R's rep dropped below 5 during the wait: initial=${initialRep}, after=${repAfterWait}, drain estimate=${drainOverWait} rep over ${(wait24.elapsedMs / 1000).toFixed(0)}s`);
      return;
    }

    // Assertion 3 — press the corner, read silence, awaited with a bound: the
    // line of the run before stands until the press's own run lands.
    await pressCornerAndReadFigures(cx);
    const after = (await waitForRow(readKarmaField, cx,
      (k) => k.present && k.hintText === null && !k.monoHasClay, 15000)).last;
    const afterOk = after.present && after.hintText === null && !after.monoHasClay;

    record(24, beforeOk && numberOk && duringOk && afterOk,
      `before press: hint=${JSON.stringify(before.hintText)} silence=${before.hintText === null} ok=${beforeOk}, rep=${prePostRep}; ` +
      `R's karma boxes on A before the post=${karmaPre?.boxCount ?? 'null'}, after=${karmaPost?.boxCount ?? 'null'}; ` +
      `landed with no press by h=${landedH24} (pre=${preH24}): row=${JSON.stringify(landing.last.monoText)} vs A's effective=${JSON.stringify(karmaPost?.effective ?? null)}, moved off ${JSON.stringify(prePostRep)}, ok=${numberOk}, tip-proof requests in the wait=${tipRunsInLanding}; ` +
      `the landing's own run (no press, ${landingRun.length} proof requests): hint=${JSON.stringify(landingLine.hintText)} clay=${landingLine.hintHasClay}; ` +
      `during press: hint=${JSON.stringify(during.hintText)} shape ok=${duringOk}, ${provenSays}; ` +
      `waited to h=${wait24.last} (~${rate24} blocks/min) target=${targetH24}, elapsed=${(wait24.elapsedMs / 1000).toFixed(0)}s; ` +
      `rep initial=${initialRep} → after=${repAfterWait}, drain estimate=${drainOverWait} rep; ` +
      `after press: hint=${JSON.stringify(after.hintText)} silence=${after.hintText === null}, mono=${JSON.stringify(after.monoText)} clay=${after.monoHasClay}`);
  } catch (e) {
    record(24, false, `error: ${String(e)}`);
  }
}

// R's /karma on A, read by the harness beside the row — the node's
// `effective` and the key's box count (NODE_INTERFACE → UTXO queries). Null
// when A does not answer.
async function readNodeKarma() {
  try {
    const r = await fetch(`${NODE}/karma/${R_JSON.pubKeyHex}`);
    if (!r.ok) return null;
    const j = await r.json();
    return { effective: j.effective ?? null, boxCount: j.boxCount ?? null };
  } catch {
    return null;
  }
}

// ---- The lie arms — 22a · 22b · 23 (WEB_INTERFACE → The extension → "The
// verified figures"). Each arm sets the figures relay's mode with @wallet and
// @profile open, then sets the settings row's `node` to the relay: a node
// change drops everything loaded and re-reads it from the new node
// (WEB_INTERFACE → The settings window), so an arm presses no ↻ — the change
// is the re-read, and the arm is its proof. The rows are read once the relay's
// run lands. Then the row is blanked back to A, and the balance row reads
// silent again once A's own run lands — part of the arm's verdict, so the next
// arm starts clean.

const BALANCE_UNPROVEN = "this node's proof of the balance did not verify";
const REP_UNPROVEN = "this node's proof of your rep did not verify";
// The relay's fabricated 12.5 $NOTIS box read as `absent`, and as `unchecked`
// — a block landed between the anchor and the run's /blocks/current, and the
// next run decides.
const FAKE_ABSENT_LINE = /^the node lists 12\.5\d* \$NOTIS the chain does not hold$/;
const FAKE_UNCHECKED_TAIL = / · 12\.5\d* \$NOTIS not checked yet$/;

const repNotClay = (k) => k.present && k.monoText !== null && !k.hintHasClay && !k.monoHasClay;

const LIE_ARMS = [
  {
    // A fabricated box: `absent` only where `heightAfter` equals the anchor's
    // tip, so an `unchecked` reading is pressed again, up to five times. The
    // lie is the credits listing's alone — the rep row is not clay.
    step: '22a',
    mode: 'credits-fake',
    creditsSettled: (r) => r.present && (FAKE_ABSENT_LINE.test(r.figHintText ?? '') || FAKE_UNCHECKED_TAIL.test(r.figHintText ?? '')),
    creditsOk: (r) => r.present && FAKE_ABSENT_LINE.test(r.figHintText ?? '') && r.figHintHasClay && r.goldHasClay,
    presses: 5,
    karmaSettled: (k) => k.present && k.monoText !== null,
    karmaOk: repNotClay,
  },
  {
    // Another key's real box: its owner fails the check at whichever height
    // includes it. The rep row is not clay.
    step: '22b',
    mode: 'credits-foreign',
    creditsSettled: (r) => r.present && r.figHintText === BALANCE_UNPROVEN,
    creditsOk: (r) => r.present && r.figHintText === BALANCE_UNPROVEN && r.figHintHasClay && r.goldHasClay,
    presses: 0,
    karmaSettled: (k) => k.present && k.monoText !== null,
    karmaOk: repNotClay,
  },
  {
    // The listing is honest and every proof lies: both rows under the full
    // rule.
    step: 23,
    mode: 'avl-flip',
    creditsSettled: (r) => r.present && r.figHintText === BALANCE_UNPROVEN,
    creditsOk: (r) => r.present && r.figHintText === BALANCE_UNPROVEN && r.figHintHasClay && r.goldHasClay,
    presses: 0,
    karmaSettled: (k) => k.present && k.hintText === REP_UNPROVEN,
    karmaOk: (k) => k.present && k.hintText === REP_UNPROVEN && k.hintHasClay && k.monoHasClay,
  },
];

// A row as the step lines read it — the figures hint and the figure, each
// with its clay.
function creditsSeen(r) {
  if (!r?.present) return 'row not in the page';
  return `hint=${JSON.stringify(r.figHintText)} (clay=${r.figHintHasClay}), gold=${JSON.stringify(r.goldText)} (clay=${r.goldHasClay})`;
}

function karmaSeen(k) {
  if (!k?.present) return 'row not in the page';
  return `hint=${JSON.stringify(k.hintText)} (clay=${k.hintHasClay}), rep=${JSON.stringify(k.monoText)} (clay=${k.monoHasClay})`;
}

// The page's requests since `startIdx` whose URL opens with `prefix`.
function requestsTo(events, startIdx, prefix) {
  let n = 0;
  for (let i = startIdx; i < events.length; i++) {
    const ev = events[i];
    if (ev.method === 'Network.requestWillBeSent' && (ev.params?.request?.url ?? '').startsWith(prefix)) n += 1;
  }
  return n;
}

async function runFiguresLieArms(cx) {
  let relay;
  try {
    relay = await startFiguresRelay(NODE.replace(/\/+$/, ''), FIG_RELAY_PORT);
  } catch (e) {
    for (const s of LIE_ARM_STEPS) record(s, false, `the figures relay did not start on ${FIG_RELAY_ORIGIN}: ${String(e)}`);
    return;
  }
  console.log(`[vf] figures relay up: ${relay.origin} → ${NODE}`);
  try {
    for (const arm of LIE_ARMS) await runLieArm(cx, relay, arm);
  } finally {
    relay.mode = 'honest';
    try { relay.server.close(); } catch {}
    console.log(`[vf] figures relay closed; edits=${JSON.stringify(relay.edits)}`);
  }
}

async function runLieArm(cx, relay, arm) {
  let onRelay = false;
  try {
    const editsBefore = relay.edits[arm.mode];
    // (1) The relay's mode, with @wallet and @profile open.
    relay.mode = arm.mode;
    await raiseWindow(cx, 'open profile');
    await raiseWindow(cx, 'open wallet');

    // (2) The node row set to the relay; the corner reads verified across the
    // relay, A and B.
    const changeIdx = cx.events.length;
    onRelay = true;
    const change = await changeNodeAndAwait(cx, relay.origin,
      (c) => c.ledClass === 'led fresh' && /^verified across \d+ nodes · tip \d+$/.test(c.title ?? ''),
      'led fresh + verified across N nodes (reading the figures relay)', 60000);
    const verified = !change.reached.timedOut && change.stored === relay.origin;

    // (3) The rows, once the relay's run lands; the balance line awaited with
    // a bound, and pressed again where the arm allows it.
    await raiseWindow(cx, 'open wallet');
    const relayRun = verified ? await waitForFiguresRun(cx, changeIdx, 60000, 2000, relay.origin) : [];
    let credits = await waitForRow(readCreditsRow, cx, arm.creditsSettled, 15000);
    const readings = [`after the change: ${creditsSeen(credits.last)}`];
    let presses = 0;
    while (verified && presses < arm.presses && !arm.creditsOk(credits.last)) {
      presses += 1;
      await pressCornerAndReadFigures(cx);
      credits = await waitForRow(readCreditsRow, cx, arm.creditsSettled, 15000);
      readings.push(`press ${presses}: ${creditsSeen(credits.last)}`);
    }
    const creditsOk = arm.creditsOk(credits.last);
    await raiseWindow(cx, 'open profile');
    const karma = await waitForRow(readKarmaField, cx, arm.karmaSettled, 15000);
    const karmaOk = arm.karmaOk(karma.last);
    const corner = await readCorner(cx);
    const cornerOk = corner.ledClass === 'led fresh';
    const edits = relay.edits[arm.mode] - editsBefore;
    const creditsReads = requestsTo(cx.events, changeIdx, `${relay.origin}/credits/${R_JSON.pubKeyHex}`);
    const karmaReads = requestsTo(cx.events, changeIdx, `${relay.origin}/karma/${R_JSON.pubKeyHex}`);
    const nodeCredits = await fetch(`${NODE}/credits/${R_JSON.pubKeyHex}`).then((r) => r.json()).catch(() => null);

    // (4) Back to A: the balance row silent again once A's own run lands.
    const back = await leaveFiguresRelay(cx);
    onRelay = false;
    record(arm.step, verified && creditsOk && karmaOk && cornerOk && back.ok,
      `relay ${arm.mode} edits=${edits}; ` +
      `change: stored=${JSON.stringify(change.stored)}, led=${change.reading.ledClass}, title=${JSON.stringify(change.reading.title)}, verified=${verified}; ` +
      `through the relay: /credits reads=${creditsReads}, /karma reads=${karmaReads}, figures proof requests=${relayRun.length}; ` +
      `balance ${readings.join(' | ')} (A's /credits total=${nodeCredits?.total ?? 'null'} base units), ok=${creditsOk}; ` +
      `rep ${karmaSeen(karma.last)}, ok=${karmaOk}; ` +
      `corner led=${corner.ledClass}, title=${JSON.stringify(corner.title)}, ok=${cornerOk}; ` +
      `back to A: ${back.detail}, ok=${back.ok}`);
  } catch (e) {
    record(arm.step, false, `error: ${String(e)}`);
    // An arm that failed on the relay hands the next one A, as every arm
    // leaves it.
    if (onRelay) {
      await blankNodeAndAwaitVerified(cx).catch((err) => console.error(`[vf] ${arm.step}: blank back to A failed: ${String(err)}`));
    }
  }
}

// Step (4) of every lie arm — the node row blanked back to A, and the balance
// row silent once A's own figures run lands: before that run the row holds no
// result, which reads silent too.
async function leaveFiguresRelay(cx) {
  const blankIdx = cx.events.length;
  const blank = await blankNodeAndAwaitVerified(cx);
  const verified = !blank.reached.timedOut;
  await raiseWindow(cx, 'open wallet');
  const aRun = verified ? await waitForFiguresRun(cx, blankIdx, 60000, 2000, NODE.replace(/\/+$/, '')) : [];
  const row = await waitForRow(readCreditsRow, cx,
    (r) => r.present && r.goldText !== null && r.figHintText === null && !r.goldHasClay, 15000);
  return {
    ok: verified && aRun.length > 0 && !row.timedOut,
    detail: `led=${blank.reading.ledClass}, title=${JSON.stringify(blank.reading.title)}, A's figures proof requests=${aRun.length}, balance ${creditsSeen(row.last)}`,
  };
}

// Step 25 — the hosted build has no verifier, so no `.credits-line .hint` or
// `.karma-field .hint` renders and no `/api/v1/proof/` request fires (as step
// 20 asserts no `/nipopow/proof/`; same log, different literal). The hosted
// origin is the harness's static server at `--public` (rung 1's server, step
// 20's own). Without `--public`/`--web-dist` the step reads NOT RUN by name.
async function runFiguresStep25() {
  if (PUBLIC === null || webDistAbs === null) {
    record(25, 'NOT RUN', 'no --public / --web-dist — the hosted origin is not served');
    return;
  }
  let bcx = null;
  let cxH = null;
  let createdTargetId = null;
  try {
    bcx = await openBrowserSession();
    const hostedUrl = publicOrigin + publicBase;
    const created = await bcx.call('Target.createTarget', { url: hostedUrl });
    createdTargetId = created.targetId;
    const info = await findTargetById(createdTargetId, 15000);
    if (!info) {
      record(25, false, `hosted target ${createdTargetId.slice(0, 8)}… never appeared in /json/list`);
      return;
    }
    cxH = await openSession(info.webSocketDebuggerUrl);
    // Wait for the corner — the read surface renders on the hosted build as it
    // does with no identity (WEB_INTERFACE → The read surface).
    await cxH.waitFor(`!!document.querySelector('.corner')`, 'hosted corner 25', 30000);

    // Try to open the wallet — the hosted build carries no identity here, so
    // the header may not show the control. The assertion is about the DOM's
    // hint elements and the request log, not the wallet being open.
    const walletBtnPresent = await cxH.eval(`(() => {
      const b = document.querySelector('[aria-label="open wallet"]');
      if (!b) return false;
      b.click();
      return true;
    })()`, true);
    await sleep(2000);

    // Idle 20 s, then press the corner and give it 5 s. No `/api/v1/proof/`
    // fires through either window — the hosted build has no figures verifier.
    const startIdx = cxH.events.length;
    await sleep(20000);
    await pressCorner(cxH);
    await sleep(5000);

    const requests = cxH.events.slice(startIdx).filter((e) => e.method === 'Network.requestWillBeSent');
    const apiProofRequests = requests.filter((e) => (e.params?.request?.url ?? '').includes('/api/v1/proof/'));
    const hints = await cxH.eval(`(() => ({
      creditsLineHint: document.querySelector('.credits-line .hint')?.textContent ?? null,
      karmaFieldHint: document.querySelector('.karma-field .hint')?.textContent ?? null,
    }))()`);
    const ok = apiProofRequests.length === 0
      && hints.creditsLineHint === null
      && hints.karmaFieldHint === null;
    record(25, ok,
      `hosted origin=${hostedUrl}, wallet control present=${walletBtnPresent}, ` +
      `/api/v1/proof/ requests on hosted origin=${apiProofRequests.length} (${JSON.stringify(apiProofRequests.map((e) => e.params?.request?.url ?? ''))}), ` +
      `.credits-line .hint=${JSON.stringify(hints.creditsLineHint)}, .karma-field .hint=${JSON.stringify(hints.karmaFieldHint)}`);
  } catch (e) {
    record(25, false, `error: ${String(e)}`);
  } finally {
    try { if (cxH) cxH.s.close(); } catch {}
    if (bcx && createdTargetId) {
      await bcx.call('Target.closeTarget', { targetId: createdTargetId }).catch(() => {});
    }
    try { if (bcx) bcx.s.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// The verified-names block — steps 26 · 29 · 30 (WEB_INTERFACE → The extension
// → "The verified names", → The identity display, → The author window, → The
// wallet window → "The `send` row"). A name check proves against the verified
// tip's anchor, which needs a second verified node, so the block brings up a B
// of its own after the A pre-flight, as the figures block does, and stops it
// at the end. 26 and 29 read A; 30 reads the hosted web build and needs no B.
// The block reads at a tiling width: the header's profile control is a word at
// two columns and more, a glyph at one (WEB_INTERFACE → The workspace).
// ---------------------------------------------------------------------------

const VERIFIED_NAMES_STEPS = [26, 29, 30];

function markVerifiedNamesNotRun(reason) {
  for (const s of VERIFIED_NAMES_STEPS) record(s, 'NOT RUN', reason);
}

// The page's size for the block — wider than the one-column line, 955px, so
// the workspace tiles (WEB_INTERFACE → The workspace).
const NAMES_VIEWPORT = { width: 1280, height: 900 };
// What step 29 types as the amount — above the per-byte floor, and a decline
// spends none of it (WEB_INTERFACE → The wallet window → "The `send` row").
const NAMES_SEND_AMOUNT = '2';
// The profile's `username` row, found by its label (WEB_INTERFACE → The
// username row) — a page expression.
const USERNAME_ROW_JS = `[...document.querySelectorAll('.winbody .row')].find((r) => r.querySelector('label')?.textContent === 'username')`;

// `origin`'s `/usernames?owner=<key>` — `{ name, owner, boxId, claimedAtBlock }`,
// or null on the 404 that says the key holds no name (NODE_INTERFACE →
// Usernames).
async function usernameOf(origin, key) {
  const r = await fetch(`${origin}/usernames?owner=${key}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${origin}/usernames?owner=${key.slice(0, 8)}… answered ${r.status}`);
  return r.json();
}

// The ids of `key`'s live roots on A, newest first — the cards the feed draws
// for that author (NODE_INTERFACE → Posts).
async function liveRootIds(key) {
  const r = await fetch(`${NODE}/posts?roots=1&author=${key}&limit=50`);
  if (!r.ok) throw new Error(`GET ${NODE}/posts?roots=1&author=${key.slice(0, 8)}… answered ${r.status}`);
  const j = await r.json();
  return (Array.isArray(j?.posts) ? j.posts : [])
    .filter((p) => p.kind !== 'withdrawn' && typeof p.id === 'string')
    .map((p) => p.id);
}

// The page's requests of a name check from `startIdx` up to `endIdx`
// (WEB_INTERFACE → The extension → "The verified names"): the lookups by owner
// of `ownerKey`, the lookups of the typed `handle`, and the proofs of `boxId`,
// each proof with its `atHeight` and request id — beside every
// `/blocks/current` and `/nipopow/proof/` request of the same window.
function nameRequestsSince(events, startIdx, { ownerKey = null, handle = null, boxId = null, endIdx = events.length } = {}) {
  const out = { ownerLookups: 0, handleLookups: 0, boxProofs: [], blocksCurrent: 0, tipProofs: 0 };
  for (let i = startIdx; i < endIdx; i++) {
    const ev = events[i];
    if (ev.method !== 'Network.requestWillBeSent') continue;
    const u = new URL(ev.params.request.url);
    const p = u.pathname;
    if (ownerKey !== null && p.endsWith('/usernames') && (u.searchParams.get('owner') ?? '').toLowerCase() === ownerKey) {
      out.ownerLookups += 1;
    } else if (handle !== null && p.endsWith(`/usernames/${encodeURIComponent(handle)}`)) {
      out.handleLookups += 1;
    } else if (boxId !== null && p.endsWith(`/api/v1/proof/${boxId}`)) {
      out.boxProofs.push({ atHeight: Number(u.searchParams.get('atHeight')), requestId: ev.params.requestId });
    } else if (p.endsWith('/blocks/current')) {
      out.blocksCurrent += 1;
    } else if (p.includes('/nipopow/proof/')) {
      out.tipProofs += 1;
    }
  }
  return out;
}

// The request ids the page's log has seen finish or fail since `startIdx`.
function settledRequestIds(events, startIdx) {
  const ids = new Set();
  for (let i = startIdx; i < events.length; i++) {
    const m = events[i].method;
    if (m === 'Network.loadingFinished' || m === 'Network.loadingFailed') ids.add(events[i].params.requestId);
  }
  return ids;
}

// The page's lookups, box proofs and tip proofs since `startIdx` — the traffic
// of a name check, and of the tip run a check can ask for.
function checkTrafficSince(events, startIdx) {
  let n = 0;
  for (let i = startIdx; i < events.length; i++) {
    const ev = events[i];
    if (ev.method !== 'Network.requestWillBeSent') continue;
    const url = ev.params.request.url;
    if (url.includes('/usernames') || url.includes('/api/v1/proof/') || url.includes('/nipopow/proof/')) n += 1;
  }
  return n;
}

// Wait for `quietMs` with no new lookup, box proof or tip proof, bounded by
// `ms` — and, with `boxId`, for a proof of that box asked since `startIdx` and
// every one answered. A check that ends `unchecked` asks one tip run and checks
// again on its result (WEB_INTERFACE → The extension → "The verified names");
// the quiet waits that out, so a handle read after it reads the result its
// check landed, where one read before it may read a pair no check has decided
// — which reads ink as well.
async function waitForNameChecks(cx, startIdx, { boxId = null, ms = 90000, quietMs = 3000 } = {}) {
  const t0 = Date.now();
  let traffic = -1;
  let quietFrom = t0;
  while (Date.now() - t0 < ms) {
    const now = checkTrafficSince(cx.events, startIdx);
    if (now !== traffic) { traffic = now; quietFrom = Date.now(); }
    let proven = true;
    if (boxId !== null) {
      const proofs = nameRequestsSince(cx.events, startIdx, { boxId }).boxProofs;
      const settled = settledRequestIds(cx.events, startIdx);
      proven = proofs.length > 0 && proofs.every((p) => settled.has(p.requestId));
    }
    if (proven && Date.now() - quietFrom >= quietMs) return { settled: true, ms: Date.now() - t0 };
    await sleep(200);
  }
  return { settled: false, ms: Date.now() - t0 };
}

// Wait for a CDP event named `method` on the session since `startIdx`; throws
// at `ms`, as the session's own waitFor does.
async function waitForEvent(cx, startIdx, method, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (let i = startIdx; i < cx.events.length; i++) if (cx.events[i].method === method) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${method}`);
}

// Every site step 26 reads a handle at (WEB_INTERFACE → The identity display),
// each `{ text, clay, handle }` — `handle` whether the element is a handle and
// not a prefix — or null where the page holds none: the header's profile
// control; R's cards in the feed, by the ids A lists for R; the thread whose
// root is `rootId` — its bar and its root card; R's author window — its bar,
// its `name` row and the clay line beneath it; the profile's `username` row.
// A column draws its focused window's body alone, so a window's rows are read
// while it is the one raised. `clayAnywhere` is every clay handle on the page.
async function readNameSites(cx, rKey, rIds, rootId) {
  return cx.eval(`(() => {
    const seen = (el) => el === null || el === undefined ? null : {
      text: (el.textContent ?? '').trim(),
      clay: el.classList.contains('clay'),
      handle: el.classList.contains('handle') || el.dataset.namePair !== undefined,
    };
    const rowOf = (body, label) => [...body.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === label) ?? null;
    const rIds = ${JSON.stringify(rIds)};
    const rootId = ${JSON.stringify(rootId)};
    const regions = [...document.querySelectorAll('#panes .region')];
    const feed = [...document.querySelectorAll('#feed .card[data-post-id]')]
      .filter((c) => rIds.includes(c.dataset.postId))
      .map((c) => ({ id: c.dataset.postId, ...seen(c.querySelector('.who .authorbtn, .who .handle, .who .hex')) }));
    const threadRegion = rootId === null ? null
      : regions.find((r) => r.querySelector('.region-body .card[data-post-id="' + rootId + '"]')) ?? null;
    const threadRoot = threadRegion === null ? null
      : threadRegion.querySelector('.region-body .card[data-post-id="' + rootId + '"] .who .authorbtn, .region-body .card[data-post-id="' + rootId + '"] .who .handle');
    const authorRegion = regions.find((r) => {
      const body = r.querySelector('.region-body .winbody');
      return !!body && !!rowOf(body, 'endorsers') && (rowOf(body, 'key')?.textContent ?? '').includes(${JSON.stringify(rKey)});
    }) ?? null;
    const nameRow = authorRegion === null ? null : rowOf(authorRegion.querySelector('.region-body .winbody'), 'name');
    const profileRow = ${USERNAME_ROW_JS} ?? null;
    const barHandle = (region) => region.querySelector('.bar.focused .bar-label .handle, .bar.focused .bar-label .hex');
    return {
      width: innerWidth,
      header: seen(document.querySelector('[aria-label="open profile"]')),
      feed,
      threadBar: threadRegion === null ? null : seen(barHandle(threadRegion)),
      threadRoot: seen(threadRoot),
      authorBar: authorRegion === null ? null : seen(barHandle(authorRegion)),
      authorName: nameRow === null ? null : seen(nameRow.querySelector('.field .handle')),
      authorField: nameRow === null ? null : (nameRow.querySelector('.field')?.textContent ?? '').trim(),
      authorLine: nameRow === null ? null : (nameRow.querySelector('.field .hint.clay')?.textContent ?? null),
      profile: profileRow === null ? null : seen(profileRow.querySelector('.username-line .handle')),
      clayAnywhere: [...document.querySelectorAll('.handle.clay, [data-name-pair].clay')].map((e) => (e.textContent ?? '').trim()),
    };
  })()`);
}

// A site as a step line reads it.
function siteSeen(x) {
  return x === null ? 'absent' : `${JSON.stringify(x.text)} (clay=${x.clay})`;
}

async function verifiedNamesSteps(cx, targetId = 'unknown') {
  // Liveness probe — the other blocks' shape, a three-second wall around `1+1`.
  const alive = await (async () => {
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('liveness timeout')), 3000));
    try { return (await Promise.race([cx.eval(`1+1`), timeout])) === 2; }
    catch { return false; }
  })();
  if (!alive) {
    const reason = `the verified-names block's session is not live: ${targetId}`;
    for (const s of VERIFIED_NAMES_STEPS) record(s, false, reason);
    return;
  }
  const rKey = R_JSON.pubKeyHex.toLowerCase();

  // ---- Pre-flight — A is up; S's name as A serves it — the handle 29 types
  // and the box whose proofs it counts. 30 needs no B, and runs when A or B
  // does not come up.
  const aUp = await waitForHttpUp(NODE, 15000);
  if (!aUp) {
    for (const s of [26, 29]) record(s, 'NOT RUN', `node A did not answer /blocks/current at ${NODE}`);
    await runNamesStep30(null);
    return;
  }
  console.log(`[vn] pre-flight: A height=${await currentHeight(NODE)} at ${NODE}`);
  const sHeld = await usernameOf(NODE, S_PUB);
  console.log(`[vn] S ${S_PUB.slice(0, 8)}… holds ${sHeld === null ? 'no name' : `@${sHeld.name}, box ${sHeld.boxId.slice(0, 12)}…, claimed at block ${sHeld.claimedAtBlock}`}`);

  // ---- B — bringUpNodeB wipes b.db and spawns fresh, bootstrapped from A.
  console.log(`[vn] bringing up node B for the names block`);
  await bringUpNodeB();
  const notRunWithout = async (reason) => {
    for (const s of [26, 29]) record(s, 'NOT RUN', reason);
    await runNamesStep30((await usernameOf(NODE, rKey))?.name ?? null);
  };
  try {
    if (!await waitForHttpUp(B_ORIGIN, 30000)) {
      await notRunWithout(`node B did not come up at ${B_ORIGIN}`);
      return;
    }
    const bPeers = await waitForPeers(`http://127.0.0.1:${B_ADMIN_PORT}`, 1, 60000);
    console.log(`[vn] node B up at ${B_ORIGIN}, peers_connected=${bPeers}`);
    if (bPeers === null) {
      await notRunWithout(`node B never reached ≥1 peer_connected within 60s (bootstrap ${NODE_P2P})`);
      return;
    }
    const abSynced = await waitForHeightsClose(NODE, B_ORIGIN, 2, 300000);
    if (abSynced === null) {
      await notRunWithout(`B never caught up to A within 5 minutes (A=${await currentHeight(NODE)}, B=${await currentHeight(B_ORIGIN)})`);
      return;
    }
    console.log(`[vn] A/B synced: ${JSON.stringify(abSynced)}`);

    // ---- The tiling width, and the corner verified across A and B — without
    // a verified tip no check runs and every handle reads as it reads without
    // a verifier (WEB_INTERFACE → The extension → "The verified names").
    let verifiedReading = null;
    let preError = null;
    try {
      await cx.call('Emulation.setDeviceMetricsOverride', {
        width: NAMES_VIEWPORT.width, height: NAMES_VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
      });
      await cx.waitFor(`!matchMedia('(max-width: 955px)').matches && !!document.querySelector('[aria-label="open profile"].hdr-word') && !!document.querySelector('.corner')`,
        'the header at a tiling width', 30000);
      verifiedReading = await pressAndReadVerdict(cx, { atLeast: 2, ms: 60000, quietMs: 2000 });
    } catch (e) {
      preError = String(e);
    }
    const verifiedOk = verifiedReading !== null && verifiedReading.reading.ledClass === 'led fresh'
      && /^verified across 2 nodes · tip \d+$/.test(verifiedReading.reading.title ?? '');
    if (!verifiedOk) {
      const detail = preError !== null
        ? `pre-condition: ${preError}`
        : `pre-condition press: led=${verifiedReading.reading.ledClass}, title=${JSON.stringify(verifiedReading.reading.title)}, proof requests=${verifiedReading.proofs.length}; a name check runs only against a verified tip's anchor (WEB_INTERFACE → The extension → "The verified names")`;
      for (const s of [26, 29]) record(s, false, detail);
      await runNamesStep30((await usernameOf(NODE, rKey))?.name ?? null);
      return;
    }
    console.log(`[vn] pre-condition ok: width ${NAMES_VIEWPORT.width}, led=${verifiedReading.reading.ledClass}, title=${JSON.stringify(verifiedReading.reading.title)}`);

    // ---- Step 26 — R's claimed name, in ink everywhere.
    const rName = await runNamesStep26(cx, rKey);

    // ---- Step 29 — the honest send to S's handle, declined at the prompt.
    await runNamesStep29(cx, sHeld);

    // ---- Step 30 — no verifier on the hosted web build.
    await runNamesStep30(rName);
  } finally {
    await cx.call('Emulation.clearDeviceMetricsOverride').catch(() => {});
    console.log(`[vn] cleanup: stopping node B by handle`);
    await stopChild('b');
    console.log(`[vn] cleanup done; live children left=${vtChildren.size}`);
  }
}

// Step 26 — a name, in ink everywhere (WEB_INTERFACE → The username row, → The
// identity display, → The extension → "The verified names"). R claims a fresh
// name through the profile's `username` row — the field and the boxed `claim`
// — and the landing is awaited: it re-renders the row and the header in place,
// and the header's render checks the new pair, a proof of the name's box in
// the log. A reload re-reads every row, so R's cards carry the name; then,
// under the verified corner, the header's word, R's cards, a thread R's card
// opens, R's author window and the profile's row read the handle in ink, and
// the log holds the reload's check — `/usernames?owner=<R>` and a proof of the
// name's box. Answers R's name, or null where R holds none.
async function runNamesStep26(cx, rKey) {
  // 1 to 24 letters, digits or _ (TYPES_INTERFACE → Content limits): R and six
  // hex digits, fresh per run.
  const name = 'R' + randomBytes(3).toString('hex');
  const ink = (x) => x !== null && x.text === '@' + name && x.handle && !x.clay;
  try {
    const heldBefore = await usernameOf(NODE, rKey);
    if (heldBefore !== null) {
      record(26, false, `R already holds @${heldBefore.name} on A — the row claims only for a key holding none; step 26 runs with a fresh throwaway`);
      return heldBefore.name;
    }

    // (1) The claim, through the row: the field, then `claim`. A locked
    // identity mounts the unlock form under the claim form, and success
    // continues the claim (WEB_INTERFACE → The username row).
    await raiseWindow(cx, 'open profile');
    await cx.waitFor(`!!(${USERNAME_ROW_JS})?.querySelector('form.username-form input[aria-label="the name to claim"]')`,
      'the username row\'s claim form', 30000);
    const claimIdx = cx.events.length;
    const press = await cx.eval(`(() => {
      const row = ${USERNAME_ROW_JS};
      const form = row.querySelector('form.username-form');
      const input = form.querySelector('input[aria-label="the name to claim"]');
      const claim = [...form.querySelectorAll('button')].find((b) => b.textContent.trim() === 'claim');
      if (!claim) return { pressed: false, unlock: false };
      input.value = ${JSON.stringify(name)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      claim.click();
      return { pressed: true, unlock: !!row.querySelector('.card-unlock form.pf input[type="password"]') };
    })()`, true);
    if (!press.pressed) {
      record(26, false, 'the username row\'s claim form carried no `claim`');
      return null;
    }
    if (press.unlock) {
      await cx.eval(`(() => {
        const form = (${USERNAME_ROW_JS}).querySelector('.card-unlock form.pf');
        form.querySelector('input[type="password"]').value = ${JSON.stringify(PASSPHRASE)};
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      })()`, true);
    }

    // (2) The row, polled until the name lands: its states in order — the
    // pending handle in inkMute with the stage line, then the handle held.
    const states = [];
    let landed = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 5 * 60 * 1000) {
      const s = await cx.eval(`(() => {
        const row = ${USERNAME_ROW_JS};
        if (!row) return null;
        const h = row.querySelector('.username-line .handle');
        return {
          handle: h === null ? null : h.textContent.trim(),
          inkmute: h === null ? null : h.classList.contains('inkmute'),
          clay: h === null ? null : h.classList.contains('clay'),
          flight: (row.querySelector('.username-flight')?.textContent ?? '').trim(),
        };
      })()`);
      const shown = s === null ? 'no row' : `${s.handle ?? '—'}${s.inkmute ? ' (inkmute)' : ''}${s.flight !== '' ? ' · ' + s.flight : ''}`;
      if (states[states.length - 1] !== shown) states.push(shown);
      if (s !== null && s.handle === '@' + name && s.inkmute === false) { landed = true; break; }
      if (s !== null && /^(claim rejected|no block took)/.test(s.flight)) break;
      await sleep(200);
    }
    const promptDuringClaim = (await jsonList()).some((t) => t.url.includes('prompt.html'));
    const held = await usernameOf(NODE, rKey);
    if (!landed || held === null || held.name !== name) {
      record(26, false, `claim of @${name}: row states ${JSON.stringify(states)}, landed=${landed}, A's /usernames?owner=R: ${held === null ? '404' : `@${held.name}`}, prompt opened=${promptDuringClaim}`);
      return held?.name ?? null;
    }
    const boxId = held.boxId.toLowerCase();

    // (3) The landing, in place: the header's word and the row, and the check
    // the header's render asks for the new pair — a proof of its box.
    const inPlace = await readNameSites(cx, rKey, [], null);
    const landingCheck = await waitForNameChecks(cx, claimIdx, { boxId });
    const landingReqs = nameRequestsSince(cx.events, claimIdx, { ownerKey: rKey, boxId });
    const landingOk = landingCheck.settled && landingReqs.boxProofs.length > 0;
    console.log(`[vn] 26 landed: @${name} box ${boxId.slice(0, 12)}… at block ${held.claimedAtBlock}; header ${siteSeen(inPlace.header)}; landing check: ${JSON.stringify({ ...landingReqs, boxProofs: landingReqs.boxProofs.map((p) => p.atHeight) })}`);

    // (4) A reload re-reads every row (WEB_INTERFACE → The identity display),
    // and its tip run at start ends verified; the check of the pair follows.
    const reloadIdx = cx.events.length;
    await cx.call('Page.reload');
    // The new document's load event first — a wait that began while the reload
    // was in flight could read the old document's feed and corner.
    await waitForEvent(cx, reloadIdx, 'Page.loadEventFired', 60000);
    await cx.waitFor(`!!document.querySelector('#feed .card[data-post-id]')`, 'the feed after the reload', 60000);
    const reloadCorner = await waitForCornerState(cx,
      (c) => c.ledClass === 'led fresh' && /^verified across 2 nodes · tip \d+$/.test(c.title ?? ''),
      'led fresh + verified across 2 nodes (after the reload)', 60000);
    const reloadCheck = await waitForNameChecks(cx, reloadIdx, { boxId });
    const rIds = await liveRootIds(rKey);
    const atReload = await readNameSites(cx, rKey, rIds, null);
    const rootId = atReload.feed[0]?.id ?? null;
    if (rootId === null) {
      record(26, false, `@${name} landed at block ${held.claimedAtBlock}, but the feed after the reload holds no card of R (A lists ${rIds.length} live roots of R)`);
      return name;
    }

    // (5) A thread R's card opens — its strip.
    const threadIdx = cx.events.length;
    await cx.eval(`document.querySelector('#feed .card[data-post-id="${rootId}"] button.strip').click()`, true);
    await cx.waitFor(`!!document.querySelector('#panes .region-body .card[data-post-id="${rootId}"]')`, 'the thread R\'s card opened', 30000);
    await waitForNameChecks(cx, threadIdx, { ms: 30000 });
    const atThread = await readNameSites(cx, rKey, rIds, rootId);

    // (6) R's author window — the who row's control on R's card.
    const authorIdx = cx.events.length;
    await cx.eval(`document.querySelector('#feed .card[data-post-id="${rootId}"] .who button.authorbtn').click()`, true);
    await cx.waitFor(`(() => {
      const rowOf = (body, label) => [...body.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === label) ?? null;
      return [...document.querySelectorAll('#panes .region-body .winbody')].some((b) =>
        !!rowOf(b, 'endorsers') && (rowOf(b, 'key')?.textContent ?? '').includes(${JSON.stringify(rKey)})
        && !!rowOf(b, 'name')?.querySelector('.field .handle'));
    })()`, 'R\'s author window with its name row read', 30000);
    await waitForNameChecks(cx, authorIdx, { ms: 30000 });
    const atAuthor = await readNameSites(cx, rKey, rIds, rootId);

    // (7) The profile's `username` row, raised.
    await raiseWindow(cx, 'open profile');
    await cx.waitFor(`!!(${USERNAME_ROW_JS})?.querySelector('.username-line .handle')`, 'the profile\'s username row', 30000);
    const atProfile = await readNameSites(cx, rKey, rIds, rootId);
    const cornerEnd = await readCorner(cx);
    const reloadReqs = nameRequestsSince(cx.events, reloadIdx, { ownerKey: rKey, boxId });

    const headerOk = ink(atProfile.header);
    const feedOk = atProfile.feed.length > 0 && atProfile.feed.every(ink);
    const threadOk = ink(atThread.threadBar) && ink(atThread.threadRoot);
    const authorOk = ink(atAuthor.authorBar) && ink(atAuthor.authorName) && atAuthor.authorLine === null;
    const profileOk = ink(atProfile.profile);
    const noClay = [atReload, atThread, atAuthor, atProfile].every((r) => r.clayAnywhere.length === 0);
    const cornerOk = !reloadCorner.timedOut && cornerEnd.ledClass === 'led fresh'
      && /^verified across 2 nodes · tip \d+$/.test(cornerEnd.title ?? '');
    const logOk = reloadCheck.settled && reloadReqs.ownerLookups > 0 && reloadReqs.boxProofs.length > 0;
    record(26, landingOk && headerOk && feedOk && threadOk && authorOk && profileOk && noClay && cornerOk && logOk,
      `@${name} claimed through the row: states ${JSON.stringify(states)}, prompt opened=${promptDuringClaim}; ` +
      `A: box ${boxId.slice(0, 12)}… claimed at block ${held.claimedAtBlock}; ` +
      `in place at the landing: header ${siteSeen(inPlace.header)}, row ${siteSeen(inPlace.profile)}; ` +
      `the landing's check: /usernames?owner=R ×${landingReqs.ownerLookups}, box proofs at ${JSON.stringify(landingReqs.boxProofs.map((p) => p.atHeight))}, /blocks/current ×${landingReqs.blocksCurrent}, tip proofs ×${landingReqs.tipProofs}, settled=${landingCheck.settled}, ok=${landingOk}; ` +
      `after the reload (width ${atProfile.width}): corner ${JSON.stringify(cornerEnd.title)} (${cornerEnd.ledClass}), ok=${cornerOk}; ` +
      `header ${siteSeen(atProfile.header)} ok=${headerOk}; ` +
      `R's cards in the feed ×${atProfile.feed.length}: ${JSON.stringify(atProfile.feed.map((c) => `${c.id.slice(0, 8)}… ${c.text}${c.clay ? ' clay' : ''}`))} ok=${feedOk}; ` +
      `thread ${rootId.slice(0, 8)}…: bar ${siteSeen(atThread.threadBar)}, root card ${siteSeen(atThread.threadRoot)} ok=${threadOk}; ` +
      `author window: bar ${siteSeen(atAuthor.authorBar)}, name row ${siteSeen(atAuthor.authorName)}, line ${JSON.stringify(atAuthor.authorLine)} ok=${authorOk}; ` +
      `profile row ${siteSeen(atProfile.profile)} ok=${profileOk}; ` +
      `clay anywhere: ${JSON.stringify([...new Set([atReload, atThread, atAuthor, atProfile].flatMap((r) => r.clayAnywhere))])}; ` +
      `the reload's log: /usernames?owner=R ×${reloadReqs.ownerLookups}, box proofs at ${JSON.stringify(reloadReqs.boxProofs.map((p) => p.atHeight))}, tip proofs ×${reloadReqs.tipProofs}, settled=${reloadCheck.settled}, ok=${logOk}`);
    return name;
  } catch (e) {
    record(26, false, `error: ${String(e)}`);
    return (await usernameOf(NODE, rKey).catch(() => null))?.name ?? null;
  }
}

// Step 29 — the honest send to a handle (WEB_INTERFACE → The wallet window →
// "The `send` row", → The extension → "The verified names"). R types S's
// handle and an amount in the wallet's `send` row and presses `send`: the row
// reads *checking @<name>…* in the flight's place while the check runs — read
// by an observer installed before the press, so a line that stands for
// milliseconds is read as surely as one that stands for seconds — the key
// beneath the field is S's, the prompt window opens naming S's key on its
// `to:` line, and a decline sends nothing: no `/credits/transfer`, the flight
// *send not sent.*. S's box is aged past `suffixHead` when the check proves
// it there, young when it proves it at the tip alone.
async function runNamesStep29(cx, sHeld) {
  if (sHeld === null) {
    record(29, false, `S ${S_PUB.slice(0, 8)}… holds no name on A — claim-name.mjs claims one before the run`);
    return;
  }
  const handle = '@' + sHeld.name;
  const sBox = sHeld.boxId.toLowerCase();
  try {
    await raiseWindow(cx, 'open wallet');
    await cx.waitFor(`!!document.querySelector('.credits-field form.credits-form')`, 'the send form 29', 60000);
    await cx.eval(`(() => {
      window.__flightTexts = [];
      const note = () => {
        const text = (document.querySelector('.credits-field .credits-flight')?.textContent ?? '').trim();
        const last = window.__flightTexts[window.__flightTexts.length - 1];
        if (last === undefined || last !== text) window.__flightTexts.push(text);
      };
      window.__flightObserver?.disconnect();
      window.__flightObserver = new MutationObserver(note);
      window.__flightObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
      note();
      return true;
    })()`);
    const pressIdx = cx.events.length;
    const promptsBefore = new Set((await jsonList()).filter((t) => t.url.includes('prompt.html?id=')).map((t) => t.id));
    await cx.eval(`(() => {
      const form = document.querySelector('.credits-field form.credits-form');
      const inputs = form.querySelectorAll('input');
      inputs[0].value = ${JSON.stringify(handle)};
      inputs[1].value = ${JSON.stringify(NAMES_SEND_AMOUNT)};
      [...form.querySelectorAll('button')].find((b) => b.textContent.trim() === 'send').click();
    })()`, true);

    // The answer: the key beneath the field, or the row's refusal.
    await cx.waitFor(`(() => {
      const form = document.querySelector('.credits-field form.credits-form');
      const key = form?.querySelector('.resolved-key');
      const refusal = form?.querySelector('.pf-refusal');
      return (!!key && !key.hidden && key.textContent.trim() !== '') || (!!refusal && !refusal.hidden);
    })()`, 'the send row\'s answer', 60000);
    // The check's requests are the press's up to its answer.
    const answerIdx = cx.events.length;
    const answer = await cx.eval(`(() => {
      const form = document.querySelector('.credits-field form.credits-form');
      const key = form.querySelector('.resolved-key');
      const refusal = form.querySelector('.pf-refusal');
      return {
        key: key.hidden ? null : key.textContent.trim(),
        refusal: refusal.hidden ? null : refusal.textContent.trim(),
        unlock: !!document.querySelector('.credits-field .card-unlock form.pf input[type="password"]'),
      };
    })()`);
    // A locked identity owes the unlock under the form before the flow
    // (WEB_INTERFACE → The wallet window → "The `send` row").
    if (answer.unlock) {
      await cx.eval(`(() => {
        const form = document.querySelector('.credits-field .card-unlock form.pf');
        form.querySelector('input[type="password"]').value = ${JSON.stringify(PASSPHRASE)};
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      })()`, true);
    }

    // The prompt — a window opened for this send, found by its URL.
    let prompt = null;
    if (answer.key !== null) {
      const t0 = Date.now();
      while (prompt === null && Date.now() - t0 < 30000) {
        prompt = (await jsonList()).find((t) => t.url.includes(`chrome-extension://${EXT_ID}/prompt.html?id=`) && !promptsBefore.has(t.id) && t.webSocketDebuggerUrl) ?? null;
        if (prompt === null) await sleep(200);
      }
    }
    let lines = null;
    let declined = false;
    if (prompt !== null) {
      const cxp = await openSession(prompt.webSocketDebuggerUrl);
      try {
        await cxp.waitFor(`!!document.querySelector('.prompt .line.target')`, 'the prompt\'s to: line 29', 15000);
        lines = await cxp.eval(`[...document.querySelectorAll('.prompt .line')].map((l) => ({
          cls: [...l.classList].filter((c) => c !== 'line').join(' '),
          text: (l.textContent ?? '').replace(/\\s+/g, ' ').trim(),
          label: l.querySelector('.target-label')?.textContent ?? null,
          value: l.querySelector('.target-value')?.textContent ?? null,
        }))`);
        await cxp.eval(`document.querySelector('.prompt button.btn-ghost').click()`, true);
        declined = true;
      } finally {
        await sleep(1500);
        try { cxp.s.close(); } catch {}
      }
    }

    // The ending, and the log since the press.
    const notSent = await cx.waitFor(`document.querySelector('.credits-field .credits-flight .stage')?.textContent?.trim() === 'send not sent.'`,
      'send not sent 29', 30000).then(() => true, () => false);
    const after = await cx.eval(`(() => {
      const form = document.querySelector('.credits-field form.credits-form');
      const inputs = form ? form.querySelectorAll('input') : [];
      return {
        flight: (document.querySelector('.credits-field .credits-flight')?.textContent ?? '').trim(),
        to: inputs[0]?.value ?? null,
        amount: inputs[1]?.value ?? null,
        texts: window.__flightTexts,
      };
    })()`);
    await cx.eval(`window.__flightObserver?.disconnect(); true`);
    // A send is a `/credits/transfer` to any node.
    const transfers = cx.events.slice(pressIdx).filter((ev) =>
      ev.method === 'Network.requestWillBeSent' && ev.params.request.url.includes('/credits/transfer')).length;
    const reqs = nameRequestsSince(cx.events, pressIdx, { handle: sHeld.name, boxId: sBox, endIdx: answerIdx });
    const heights = reqs.boxProofs.map((p) => p.atHeight);
    const age = heights.length === 1 && sHeld.claimedAtBlock <= heights[0]
      ? `aged past suffixHead — claimed at block ${sHeld.claimedAtBlock}, proven at ${heights[0]}`
      : heights.length === 2
        ? `young at the tip — claimed at block ${sHeld.claimedAtBlock}, excluded at ${heights[0]}, proven at ${heights[1]}`
        : `claimed at block ${sHeld.claimedAtBlock}, proofs at ${JSON.stringify(heights)}`;

    const checking = `checking ${handle}…`;
    const checkingOk = after.texts.includes(checking);
    const keyOk = answer.key === S_PUB && answer.refusal === null;
    const target = lines?.find((l) => l.cls === 'target') ?? null;
    const promptKey = target?.value ?? null;
    const promptOk = lines !== null && lines[0]?.text === 'Notis transfer' && target !== null && target.label === 'to:' && promptKey === S_PUB;
    const declinedOk = declined && notSent && transfers === 0 && after.to === handle && after.amount === NAMES_SEND_AMOUNT;
    const logOk = reqs.handleLookups > 0 && reqs.boxProofs.length > 0;
    record(29, checkingOk && keyOk && promptOk && declinedOk && logOk,
      `typed ${JSON.stringify(handle)} and ${NAMES_SEND_AMOUNT} $NOTIS; the flight's texts in order ${JSON.stringify(after.texts)} — ${JSON.stringify(checking)} read=${checkingOk}; ` +
      `beneath the field: ${JSON.stringify(answer.key)}, refusal ${JSON.stringify(answer.refusal)}, unlock owed=${answer.unlock}, S's key=${answer.key === S_PUB}; ` +
      `prompt ${prompt === null ? 'none opened' : prompt.url.replace(/^.*\//, '')}: lines ${JSON.stringify((lines ?? []).map((l) => `${l.cls}:${l.text}`))}, to: key equals S's public key=${promptKey === S_PUB}; ` +
      `declined=${declined}, flight ${JSON.stringify(after.flight)}, /credits/transfer requests=${transfers}, form kept ${JSON.stringify(after.to)} / ${JSON.stringify(after.amount)}; ` +
      `the check: /usernames/${sHeld.name} ×${reqs.handleLookups}, box ${sBox.slice(0, 12)}… proofs at ${JSON.stringify(heights)}, /blocks/current ×${reqs.blocksCurrent}, tip proofs ×${reqs.tipProofs}; S's box ${age}`);
  } catch (e) {
    record(29, false, `error: ${String(e)}`);
  }
}

// Step 30 — no verifier (WEB_INTERFACE → The extension → "The verified names":
// the web build is handed none). The hosted web build renders every handle as
// it reads without a verifier — none clay — and asks no `/api/v1/proof/`. Its
// `/usernames?owner=` reads are the web build's own, each named: with no
// identity loaded the reader's own name is never read, and an author window
// reads its subject's as it opens (WEB_INTERFACE → The author window). The page
// is opened blank and navigated once the log listens, so the log holds every
// request it made.
async function runNamesStep30(rName) {
  if (PUBLIC === null || webDistAbs === null) {
    record(30, 'NOT RUN', 'no --public / --web-dist — the hosted origin is not served');
    return;
  }
  const rKey = R_JSON.pubKeyHex.toLowerCase();
  let bcx = null;
  let cxH = null;
  let createdTargetId = null;
  try {
    bcx = await openBrowserSession();
    const created = await bcx.call('Target.createTarget', { url: 'about:blank' });
    createdTargetId = created.targetId;
    const info = await findTargetById(createdTargetId, 15000);
    if (!info) {
      record(30, false, `hosted target ${createdTargetId.slice(0, 8)}… never appeared in /json/list`);
      return;
    }
    cxH = await openSession(info.webSocketDebuggerUrl);
    const startIdx = cxH.events.length;
    const hostedUrl = publicOrigin + publicBase;
    await cxH.call('Page.navigate', { url: hostedUrl });
    const rIds = await liveRootIds(rKey);
    await cxH.waitFor(`[...document.querySelectorAll('#feed .card[data-post-id]')].some((c) => ${JSON.stringify(rIds)}.includes(c.dataset.postId))`,
      'a card of R on the hosted page', 30000);
    const rootId = await cxH.eval(`[...document.querySelectorAll('#feed .card[data-post-id]')].map((c) => c.dataset.postId).find((id) => ${JSON.stringify(rIds)}.includes(id)) ?? null`);

    // R's author window, from R's card — the one read of a subject's name.
    const openIdx = cxH.events.length;
    await cxH.eval(`document.querySelector('#feed .card[data-post-id="${rootId}"] .who button.authorbtn').click()`, true);
    await cxH.waitFor(`(() => {
      const rowOf = (body, label) => [...body.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === label) ?? null;
      return [...document.querySelectorAll('.winbody')].some((b) => {
        const field = rowOf(b, 'name')?.querySelector('.field');
        return !!rowOf(b, 'endorsers') && !!field && !!field.querySelector('.handle, .inkmute') && field.textContent.trim() !== 'loading…';
      });
    })()`, 'R\'s author window on the hosted page', 30000);

    // An idle stretch, a press of the corner and a settle — the extension
    // checks names after a verified tip run and after a render; the web build
    // runs neither.
    await sleep(10000);
    await pressCorner(cxH);
    await sleep(5000);

    const page = await cxH.eval(`(() => {
      const rowOf = (body, label) => [...body.querySelectorAll('.row')].find((r) => r.querySelector('label')?.textContent === label) ?? null;
      const body = [...document.querySelectorAll('.winbody')].find((b) => !!rowOf(b, 'endorsers')) ?? null;
      const nameRow = body === null ? null : rowOf(body, 'name');
      return {
        width: innerWidth,
        handles: [...document.querySelectorAll('.handle')].map((h) => ({ text: (h.textContent ?? '').trim(), clay: h.classList.contains('clay') })),
        nameRow: nameRow === null ? null : (nameRow.querySelector('.field')?.textContent ?? '').trim(),
        nameLine: nameRow === null ? null : (nameRow.querySelector('.field .hint.clay')?.textContent ?? null),
      };
    })()`);
    const requests = [];
    for (let i = startIdx; i < cxH.events.length; i++) {
      const ev = cxH.events[i];
      if (ev.method === 'Network.requestWillBeSent') requests.push({ url: new URL(ev.params.request.url), index: i });
    }
    const proofs = requests.filter((r) => r.url.pathname.includes('/api/v1/proof/'));
    const handleReads = requests.filter((r) => r.url.pathname.includes('/usernames/'));
    // Each `/usernames?owner=` read, named: R's, from its author window's
    // opening on, is that window's subject read; any other is unexplained.
    const ownerReads = requests
      .filter((r) => r.url.pathname.endsWith('/usernames') && r.url.searchParams.has('owner'))
      .map((r) => {
        const owner = (r.url.searchParams.get('owner') ?? '').toLowerCase();
        const named = owner === rKey && r.index >= openIdx ? 'the author window\'s subject, R' : null;
        return { owner, named };
      });
    const unexplained = ownerReads.filter((r) => r.named === null);
    const rHandle = rName === null ? null : '@' + rName;
    const handlesOk = page.handles.length > 0 && page.handles.every((h) => !h.clay)
      && (rHandle === null || page.handles.some((h) => h.text === rHandle));
    const authorOk = rHandle === null || (page.nameRow === rHandle && page.nameLine === null);
    const ok = handlesOk && authorOk && proofs.length === 0 && handleReads.length === 0 && unexplained.length === 0;
    record(30, ok,
      `hosted origin=${hostedUrl} (width ${page.width}); handles ×${page.handles.length}: ${JSON.stringify([...new Set(page.handles.map((h) => h.text + (h.clay ? ' clay' : '')))])}, R's ${JSON.stringify(rHandle)} among them, none clay=${page.handles.every((h) => !h.clay)}; ` +
      `R's author window name row ${JSON.stringify(page.nameRow)}, line ${JSON.stringify(page.nameLine)}; ` +
      `/api/v1/proof/ requests=${proofs.length}; /usernames/<name> requests=${handleReads.length}; ` +
      `/usernames?owner= requests ×${ownerReads.length}: ${JSON.stringify(ownerReads.map((r) => `${r.owner.slice(0, 8)}… — ${r.named ?? 'unexplained'}`))}`);
  } catch (e) {
    record(30, false, `error: ${String(e)}`);
  } finally {
    try { if (cxH) cxH.s.close(); } catch {}
    if (bcx && createdTargetId) {
      await bcx.call('Target.closeTarget', { targetId: createdTargetId }).catch(() => {});
    }
    try { if (bcx) bcx.s.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

// The three blocks after the links steps, in order, each on its flag and NOT
// RUN by name without it — reached on every run with --r-key, whether the links
// steps ran or not. `bcx` is the browser session that opens an extension page
// where none is live.
async function runVerifiedBlocks(bcx) {
  // The verified-tip block after the 1–16 pass and before the browser-context
  // arm — 17a's D is fresh and isolated, so its readings hold whatever A's
  // height is by now. 17b's press train runs under A's live miner; 19b makes
  // its own fork on C; 19c uses D's own miner past 30. The block runs on the
  // extension page live at this moment — 16(d)'s bridge takeover leaves one;
  // where none is open, `Target.createTarget` a fresh `index.html`, the way
  // the harness opens every other extension page (WEB_INTERFACE → The
  // extension → "The verified tip").
  if (VERIFIED_TIP) {
    let vtPage = await findExt('index.html');
    if (!vtPage) {
      await bcx.call('Target.createTarget', { url: `chrome-extension://${EXT_ID}/index.html` });
      await sleep(2000);
      vtPage = await findExt('index.html');
    }
    if (!vtPage) throw new Error('verified-tip block: no extension page');
    const vtCx = await openSession(vtPage.webSocketDebuggerUrl);
    await verifiedTipSteps(vtCx, vtPage.id);
    try { vtCx.s.close(); } catch {}
  } else {
    markVerifiedTipNotRun('no --verified-tip');
  }

  // The verified-figures block after the tip block — the tip block's cleanup
  // stops B, C, D and the lying relay by their handles, so only A is left, and
  // the figures block brings up a B of its own and the figures relay
  // (WEB_INTERFACE → The extension → "The verified figures"). It runs on the
  // extension page live at this moment, or a fresh one where none is open;
  // storage restores R's identity (envelope in local, seed in session from
  // step 12d's unlock).
  if (VERIFIED_FIGURES) {
    let vfPage = await findExt('index.html');
    if (!vfPage) {
      await bcx.call('Target.createTarget', { url: `chrome-extension://${EXT_ID}/index.html` });
      await sleep(2000);
      vfPage = await findExt('index.html');
    }
    if (!vfPage) throw new Error('verified-figures block: no extension page');
    const vfCx = await openSession(vfPage.webSocketDebuggerUrl);
    // The App's boot needs a moment before the wallet control mounts —
    // main.ts's bootstrapProxy awaits the background's snapshot.
    try {
      await vfCx.waitFor(`!!document.querySelector('[aria-label="open wallet"]')`, 'header wallet control 25', 30000);
    } catch {}
    await verifiedFiguresSteps(vfCx, vfPage.id);
    try { vfCx.s.close(); } catch {}
  } else {
    markVerifiedFiguresNotRun('no --verified-figures');
  }

  // The verified-names block after the figures block — the figures block's
  // cleanup stops its B, and the names block brings up its own (WEB_INTERFACE
  // → The extension → "The verified names"). It runs on the extension page live
  // at this moment, or a fresh one where none is open; storage restores R's
  // identity, as it does for the figures block.
  if (VERIFIED_NAMES) {
    let vnPage = await findExt('index.html');
    if (!vnPage) {
      await bcx.call('Target.createTarget', { url: `chrome-extension://${EXT_ID}/index.html` });
      await sleep(2000);
      vnPage = await findExt('index.html');
    }
    if (!vnPage) throw new Error('verified-names block: no extension page');
    const vnCx = await openSession(vnPage.webSocketDebuggerUrl);
    await verifiedNamesSteps(vnCx, vnPage.id);
    try { vnCx.s.close(); } catch {}
  } else {
    markVerifiedNamesNotRun('no --verified-names');
  }
}

// The blocks on a run whose links steps end early — no --public, or no root of
// R's to link to — through a browser session of their own.
async function runVerifiedBlocksAlone() {
  const bcx = await openBrowserSession();
  try {
    await runVerifiedBlocks(bcx);
  } finally {
    try { bcx.s.close(); } catch {}
  }
}

async function main() {
  // Open the extension's page.
  const p1 = await findExt('index.html');
  if (p1) {} else {
    // Open one via Target.createTarget through the browser websocket.
    const bv = await browserVersion();
    const br = new WebSocket(bv.webSocketDebuggerUrl);
    await new Promise((res, rej) => { br.onopen = res; br.onerror = rej; });
    br.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: `chrome-extension://${EXT_ID}/index.html` } }));
    await sleep(2000);
    br.close();
  }
  const page = await findExt('index.html');
  if (!page) throw new Error('no extension page');
  // Give the page a moment to finish parsing before we attach — main.ts's
  // top-level `await bootstrapProxy(chrome)` runs before `#feed` gets its
  // children, but the section element itself is in the initial HTML.
  await sleep(4000);
  const cx = await openSession(page.webSocketDebuggerUrl);
  // Wait longer for the page to be usable; the extension's SW must be ready
  // for main.ts's bootstrapProxy to return.
  await cx.waitFor(`!!document.querySelector('#feed')`, 'feed root', 30000);
  await sleep(2000);

  // With no --r-key the write steps and the links steps read NOT RUN by name;
  // the verified-tip block (WEB_INTERFACE → The extension → "The verified
  // tip": the corner needs no identity) runs on the flag alone and reads NOT
  // RUN without it.
  if (!R_KEY) {
    for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      record(s, 'NOT RUN', 'no --r-key — the write steps do not run');
    }
    for (const s of [13, 14, 15, 16]) {
      record(s, 'NOT RUN', 'no --r-key — the links steps do not run');
    }
    if (VERIFIED_TIP) {
      await verifiedTipSteps(cx, page.id);
    } else {
      markVerifiedTipNotRun('no --verified-tip');
    }
    // The verified-figures block requires --r-key; --verified-figures alone
    // is a config error caught at the top. Here without --r-key the six steps
    // read NOT RUN by name — and the names block's three, which require it too.
    markVerifiedFiguresNotRun('no --r-key — the verified-figures block does not run');
    markVerifiedNamesNotRun('no --r-key — the verified-names block does not run');
    return;
  }

  // --- Step 1 — read surface: seed list drives the feed; no `new post` button.
  const s1 = await cx.eval(`(() => ({
    nodes: document.querySelector('meta[name="notis-nodes"]').content,
    newPost: !!document.querySelector('[data-composer-open="@feed"]'),
    feedLoaded: document.querySelectorAll('#feed .card').length,
    feedReport: document.querySelector('#feed .report')?.textContent ?? null,
  }))()`);
  record(1, s1.nodes.includes(NODE.replace(/\/$/, '')) && s1.newPost === false, `notis-nodes=${s1.nodes}, new-post=${s1.newPost}, feedCards=${s1.feedLoaded}, feedReport=${s1.feedReport}`);

  // --- Step 2 — import R through the profile window's Import row.
  await cx.eval(`document.querySelector('[aria-label="open profile"]').click()`, true);
  await cx.waitFor(`!!window.__btn('import')`, 'import button');
  // The App's inspectFile branch takes the file's text via chrome.runtime.sendMessage
  // through the proxy; the profile then reveals a set-passphrase form. Drive that
  // by calling importFile through the proxy directly — the seam the reader's file
  // picker feeds into after inspectFile.
  const r2 = await cx.eval(`chrome.runtime.sendMessage({ kind: 'importFile', text: ${JSON.stringify(R_TEXT)}, passphrase: ${JSON.stringify(PASSPHRASE)} })`);
  await sleep(1500);
  const s2 = await cx.eval(`(async () => {
    const local = await chrome.storage.local.get(['notis.identity','notis.identity.backedup']);
    const session = await chrome.storage.session.get(['notis.seed']);
    const state = await chrome.runtime.sendMessage({ kind: 'state' });
    const localEnv = local['notis.identity'];
    const seedHex = session['notis.seed'] ?? '';
    return {
      importOk: ${JSON.stringify(r2 ?? null)},
      state,
      envelopeSet: typeof localEnv === 'string' && localEnv.length > 0,
      seedInSession: typeof seedHex === 'string' && seedHex.length === 64,
      seedFreeLocal: typeof localEnv === 'string' && seedHex.length === 64 && !localEnv.includes(seedHex),
    };
  })()`);
  const pubKeyHex = s2.state?.pubKeyHex;
  record(2, pubKeyHex === R_JSON.pubKeyHex && s2.envelopeSet && s2.seedInSession && s2.seedFreeLocal,
    `state.pubKeyHex=${pubKeyHex?.slice(0, 8)}…, envelope in local, seed in session, seed-free local: ${s2.seedFreeLocal}`);

  // Reload so the identity is loaded from storage — proves the proxy's snapshot boot.
  await cx.call('Page.reload');
  await sleep(2500);
  const p2 = await findExt('index.html');
  const cx2 = await openSession(p2.webSocketDebuggerUrl);
  await cx2.waitFor(`document.querySelector('#feed .feed-head .btn-primary')`, 'new post button after identity load');

  // --- Step 3 — Post a thread under silent policy; the composer collapses only after
  // the sign round-trip; the post lands.
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer opened');
  const CONTENT = 'proof-thread-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  // Wait for affordability read to complete so post enables.
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'composer post enabled');
  // No prompt target should appear under silent policy.
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  // Wait: no prompt page opens.
  await sleep(2000);
  const promptOpen = await findExt('prompt.html');
  const composerAfter = await cx2.eval(`!!document.querySelector('.composer')`);
  const cardVisible = await cx2.eval(`!!document.querySelector('.card.pending')`);
  const landed3 = await pollKarma(15, 45000);
  await sleep(3000);
  const feedShowsIt = await cx2.eval(`[...document.querySelectorAll('.card-content')].some(n => n.textContent && n.textContent.includes(${JSON.stringify(CONTENT)}))`);
  record(3, !promptOpen && !composerAfter && (cardVisible || feedShowsIt),
    `no prompt (${promptOpen ? 'FAIL' : 'ok'}), composer collapsed (${!composerAfter}), pendingCard=${cardVisible}, feedShows=${feedShowsIt}, karma@R=${landed3.total ?? '?'}`);

  // --- Step 4 — the faucet key posts a thread, R likes it silently, lands.
  // Faucet posting via /faucet is not this test — the promote already posted two
  // threads under R and the faucet already liked them. Step 4's shape here: R likes
  // an EXISTING confirmed post that is not R's own. Look for one in the feed.
  await cx2.eval(`document.querySelector('.feed-head .ctl').click()`, true); // refresh
  await sleep(2500);
  const otherPost = await cx2.eval(`(() => {
    const my = ${JSON.stringify(R_JSON.pubKeyHex)};
    const cards = [...document.querySelectorAll('#feed .card[data-post-id]')];
    const other = cards.find(c => c.getAttribute('data-author') !== my && [...c.querySelectorAll('.word')].some(w => w.textContent.trim() === 'like'));
    if (!other) return null;
    return { id: other.getAttribute('data-post-id'), author: other.getAttribute('data-author') };
  })()`);
  if (otherPost) {
    await cx2.eval(`(() => {
      const card = document.querySelector('[data-post-id="' + ${JSON.stringify(otherPost.id)} + '"]');
      const like = [...card.querySelectorAll('.word')].find(w => w.textContent.trim() === 'like');
      like.click();
    })()`, true);
    await sleep(2000);
    // Check the like is optimistic (green) and no prompt appears.
    const promptOpen4 = await findExt('prompt.html');
    const cardLiked = await cx2.eval(`(() => {
      const card = document.querySelector('[data-post-id="' + ${JSON.stringify(otherPost.id)} + '"]');
      return card ? card.textContent.includes('liked') : false;
    })()`);
    record(4, !promptOpen4 && cardLiked, `no prompt on like (${promptOpen4 ? 'FAIL' : 'ok'}), card shows liked=${cardLiked}, target=${otherPost.id.slice(0, 8)}…`);
  } else {
    record(4, false, 'no non-own likeable post visible in feed');
  }

  // --- Step 5 — Set policy to `ask`; post a thread → prompt appears with the
  // derived summary → approve → window closed, post lands.
  await cx2.eval(`chrome.runtime.sendMessage({ kind: 'policy', karma: 'ask' })`);
  await sleep(500);
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer opened for step 5');
  const CONTENT5 = 'proof-ask-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT5)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'post enabled step 5');
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  // The prompt window appears.
  const prompt5 = await findExt('prompt.html');
  if (prompt5) {
    const cxp = await openSession(prompt5.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt .line.what')`, 'prompt first line');
    // The markup: every line is a `.line` div with a second class (`.what`,
    // `.amount`, `.target`, `.fee`, `.content`), a `.target` line carrying
    // its `.target-label` and `.target-value` spans (WEB_INTERFACE → The
    // extension → "The prompt reads as three lines: what, how much, to whom").
    const promptShape = await cxp.eval(`(() => {
      return [...document.querySelectorAll('.prompt .line')].map((l) => ({
        cls: [...l.classList].filter((c) => c !== 'line').join(' '),
        text: (l.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        label: l.querySelector('.target-label')?.textContent ?? null,
        value: l.querySelector('.target-value')?.textContent ?? null,
      }));
    })()`);
    // Approve.
    await cxp.eval(`document.querySelector('.prompt button.btn-primary').click()`, true);
    await sleep(2000);
    const promptGone = !(await findExt('prompt.html'));
    const landed5 = await pollKarma(0, 45000).catch(() => ({ ok: true }));
    await sleep(2000);
    const feedShows5 = await cx2.eval(`[...document.querySelectorAll('.card-content')].some(n => n.textContent && n.textContent.includes(${JSON.stringify(CONTENT5)}))`);
    const whatOk = promptShape[0]?.cls === 'what' && promptShape[0]?.text === 'Notis post';
    const amountOk = promptShape[1]?.cls === 'amount' && promptShape[1]?.text === '5 rep';
    const contentOk = promptShape.some((l) => l.cls === 'content' && (l.text ?? '').includes(CONTENT5));
    record(5, promptGone && feedShows5 && whatOk && amountOk && contentOk,
      `lines=${JSON.stringify(promptShape.map((l) => `${l.cls}:${l.text}`))} (what=${whatOk}, amount=${amountOk}, content=${contentOk}), promptClosed=${promptGone}, feedShows=${feedShows5}`);
    cxp.s.close();
  } else {
    record(5, false, 'no prompt target appeared under ask policy');
  }

  // --- Step 6 — Post under ask → decline → composer still open with its text,
  // foot line "post not sent.", karma unchanged, no submission.
  const karmaBefore6 = Number((await (await fetch(`${NODE}/karma/${R_JSON.pubKeyHex}`)).json()).effective ?? 0);
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer for decline');
  const CONTENT6 = 'proof-declined-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT6)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'post enabled step 6');
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  const prompt6 = await findExt('prompt.html');
  if (prompt6) {
    const cxp = await openSession(prompt6.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt button.btn-ghost')`, 'cancel button');
    // Decline.
    await cxp.eval(`document.querySelector('.prompt button.btn-ghost').click()`, true);
    await sleep(2000);
    const composerStill = await cx2.eval(`!!document.querySelector('.composer textarea')`);
    const draftIntact = await cx2.eval(`document.querySelector('.composer textarea')?.value ?? null`);
    const foot = await cx2.eval(`document.querySelector('.composer .karma')?.textContent ?? null`);
    const karmaAfter6 = Number((await (await fetch(`${NODE}/karma/${R_JSON.pubKeyHex}`)).json()).effective ?? 0);
    record(6, composerStill && draftIntact === CONTENT6 && foot === 'post not sent.' && karmaAfter6 === karmaBefore6,
      `composer still open (${composerStill}), draft="${draftIntact}", foot="${foot}", karma ${karmaBefore6}→${karmaAfter6}`);
    cxp.s.close();
  } else {
    record(6, false, 'no prompt target for decline');
  }

  // --- Step 7 — Close the prompt from outside (Target.closeTarget) → same ending.
  // Cancel the current composer first to reset, then post again.
  await cx2.eval(`(() => {
    const cancel = document.querySelector('.composer button.btn-ghost'); if (cancel) cancel.click();
    // Confirm discard if asked.
    const discard = [...document.querySelectorAll('.composer button')].find(b => b.textContent.trim() === 'discard'); if (discard) discard.click();
  })()`, true);
  await sleep(500);
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer for close-outside');
  const CONTENT7 = 'proof-closed-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT7)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'post enabled step 7');
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  const prompt7 = await findExt('prompt.html');
  if (prompt7) {
    // Close via Target.closeTarget.
    const bv = await browserVersion();
    const br = new WebSocket(bv.webSocketDebuggerUrl);
    await new Promise((res, rej) => { br.onopen = res; br.onerror = rej; });
    br.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: prompt7.id } }));
    await sleep(2500);
    br.close();
    const composerStill7 = await cx2.eval(`!!document.querySelector('.composer textarea')`);
    const foot7 = await cx2.eval(`document.querySelector('.composer .karma')?.textContent ?? null`);
    record(7, composerStill7 && foot7 === 'post not sent.',
      `composer still open (${composerStill7}), foot="${foot7}" after Target.closeTarget`);
  } else {
    record(7, false, 'no prompt target for close-outside');
  }

  // --- Step 8 — Stop the worker mid-prompt. Detach + idle-wait ≥30s per Phase 0.
  // Cancel the current composer, open a fresh one, submit.
  await cx2.eval(`(() => {
    const cancel = document.querySelector('.composer button.btn-ghost'); if (cancel) cancel.click();
    const discard = [...document.querySelectorAll('.composer button')].find(b => b.textContent.trim() === 'discard'); if (discard) discard.click();
  })()`, true);
  await sleep(500);
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer for step 8');
  const CONTENT8 = 'proof-restart-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT8)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'post enabled step 8');
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  const prompt8 = await findExt('prompt.html');
  const workerBefore = await findWorker();
  if (prompt8 && workerBefore) {
    const idBefore = workerBefore.id;
    // Idle-wait ≥30s to let the SW terminate on its own; detaching the CDP
    // session is achieved by not attaching to it. Wait 35s.
    console.log(`step 8: worker id=${idBefore}; idle-waiting 35s for MV3 SW termination…`);
    await sleep(35000);
    // The worker should be absent from /json/list now — that IS termination.
    const workerAtWait = await findWorker();
    // Approve — the fresh worker instance wakes to receive the sign message.
    const cxp = await openSession(prompt8.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt button.btn-primary')`, 'prompt sign btn after restart');
    await cxp.eval(`document.querySelector('.prompt button.btn-primary').click()`, true);
    // Poll until a worker target reappears (the wake), then read its id.
    let workerAfter = null;
    for (let i = 0; i < 60; i++) {
      workerAfter = await findWorker();
      if (workerAfter && workerAfter.id !== idBefore) break;
      await sleep(500);
    }
    const idAfter = workerAfter?.id ?? null;
    await sleep(4000);
    const feedShows8 = await cx2.eval(`[...document.querySelectorAll('.card-content')].some(n => n.textContent && n.textContent.includes(${JSON.stringify(CONTENT8)}))`);
    const idsDiffer = !!idAfter && idAfter !== idBefore;
    record(8, feedShows8 && idsDiffer,
      `worker id before=${idBefore}, mid-wait=${workerAtWait ? workerAtWait.id : 'absent'}, after=${idAfter ?? 'null'} (differ=${idsDiffer}); post landed=${feedShows8}`);
    cxp.s.close();
  } else {
    record(8, false, `prompt=${!!prompt8}, worker=${!!workerBefore}`);
  }

  // --- Step 9 — lock in the profile → session store empties → post mounts unlock →
  // unlock → lands. Set policy back to silent for a clean landing.
  await cx2.eval(`chrome.runtime.sendMessage({ kind: 'policy', karma: 'silent' })`);
  await sleep(500);
  await cx2.eval(`document.querySelector('[aria-label="open profile"]').click()`, true);
  await cx2.waitFor(`!!window.__btn('lock')`, 'lock button');
  await cx2.eval(`window.__btn('lock').click()`, true);
  await sleep(1000);
  const lockedState = await cx2.eval(`(async () => (await chrome.storage.session.get('notis.seed'))['notis.seed'] ?? null)()`);
  // Post — the composer's foot should mount the unlock form.
  await cx2.eval(`document.querySelector('[data-composer-open="@feed"]').click()`, true);
  await cx2.waitFor(`document.querySelector('.composer textarea')`, 'composer for step 9');
  const CONTENT9 = 'proof-unlock-' + Date.now();
  await cx2.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    ta.value = ${JSON.stringify(CONTENT9)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, true);
  await cx2.waitFor(`!document.querySelector('.composer .btn-primary').disabled`, 'post enabled step 9');
  await cx2.eval(`document.querySelector('.composer .btn-primary').click()`, true);
  await sleep(1500);
  const unlockMounted = await cx2.eval(`!!document.querySelector('.composer form.pf')`);
  if (unlockMounted) {
    // Fill the unlock form and submit.
    await cx2.eval(`(() => {
      const form = document.querySelector('.composer form.pf');
      const pw = form.querySelector('input[type="password"]');
      pw.value = ${JSON.stringify(PASSPHRASE)};
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    })()`, true);
    await sleep(6000);
    const feedShows9 = await cx2.eval(`[...document.querySelectorAll('.card-content')].some(n => n.textContent && n.textContent.includes(${JSON.stringify(CONTENT9)}))`);
    record(9, lockedState === null && unlockMounted && feedShows9,
      `lockedSession=${lockedState === null ? 'empty' : 'present'}, unlockMounted=${unlockMounted}, landed=${feedShows9}`);
  } else {
    record(9, false, `lockedSession=${lockedState === null ? 'empty' : 'present'}, unlockMounted=${unlockMounted}`);
  }

  // --- Step 10 — Reload the page → still unlocked (session store per browser).
  await cx2.call('Page.reload');
  await sleep(3000);
  const p10 = await findExt('index.html');
  let cx10 = await openSession(p10.webSocketDebuggerUrl);
  await cx10.waitFor(`document.querySelector('#feed')`, 'feed after reload');
  await sleep(1500);
  const state10 = await cx10.eval(`chrome.runtime.sendMessage({ kind: 'state' })`);
  record(10, state10 && state10.locked === false, `state.locked=${state10?.locked}, pubKeyHex=${state10?.pubKeyHex?.slice(0, 8)}…`);

  // --- Step 11 — the faucet press asks the browser for the origin
  // (WEB_INTERFACE → The faucet step → "In the extension the press asks the
  // browser for the faucet's origin first"). Open the wallet, stub
  // `chrome.permissions.request` to record its argument, press "ask the
  // faucet for $NOTIS", assert the refused branch: the region's report line
  // reads the refusal, no request reaches the faucet, and the ledger holds
  // no `creditGrant`. Restore the stub to resolve true — the granted branch
  // is step 12a, and 12a asserts the stub was asked again before the request
  // left. The real permissions dialog is not drivable from headless Chrome;
  // the manual pass exercises it.
  await cx10.eval(`document.querySelector('[aria-label="open wallet"]').click()`, true);
  await cx10.waitFor(`!!document.querySelector('.credits-field .credits-line button.word')`, 'wallet ask word');
  const events11Start = cx10.events.length;
  await cx10.eval(`(() => {
    window.__permCalls = [];
    chrome.permissions.request = (args) => {
      window.__permCalls.push({ origins: args?.origins ?? null, at: performance.now() });
      return Promise.resolve(false);
    };
  })()`, true);
  await cx10.eval(`(() => {
    const line = document.querySelector('.credits-field .credits-line');
    [...line.querySelectorAll('button.word')].find(b => b.textContent.trim() === 'ask the faucet for $NOTIS').click();
  })()`, true);
  await cx10.waitFor(`(() => {
    const region = document.querySelector('.credits-field')?.closest('.region');
    return region?.querySelector('.report')?.textContent === 'the browser refused access to that origin.';
  })()`, 'wallet region report reads refusal', 5000);
  const refused11 = await cx10.eval(`(() => {
    const region = document.querySelector('.credits-field')?.closest('.region');
    const report = region?.querySelector('.report')?.textContent ?? null;
    const calls = window.__permCalls;
    const raw = localStorage.getItem('notis.pending.' + ${JSON.stringify(R_JSON.pubKeyHex)}) || '[]';
    const hasGrant = JSON.parse(raw).some(e => e.kind === 'creditGrant');
    return { report, callCount: calls.length, firstOrigins: calls[0]?.origins ?? null, hasGrant };
  })()`);
  const faucetRequestSeen11 = cx10.events.slice(events11Start).some((e) =>
    e.method === 'Network.requestWillBeSent' && (e.params.request.url || '').startsWith(FAUCET));
  // Restore the stub to true for step 12a — same recorder, so 12a can see
  // that the stub was asked again before the request left.
  await cx10.eval(`(() => {
    chrome.permissions.request = (args) => {
      window.__permCalls.push({ origins: args?.origins ?? null, at: performance.now() });
      return Promise.resolve(true);
    };
  })()`, true);
  const originsExpected = FAUCET + '/*';
  const originsOk11 = refused11.callCount === 1 && Array.isArray(refused11.firstOrigins) && refused11.firstOrigins[0] === originsExpected;
  const reportOk11 = refused11.report === 'the browser refused access to that origin.';
  const noRequest11 = !faucetRequestSeen11;
  const noGrant11 = !refused11.hasGrant;
  record(11, originsOk11 && reportOk11 && noRequest11 && noGrant11,
    `stub calls=${refused11.callCount}, origins[0]=${JSON.stringify(refused11.firstOrigins?.[0] ?? null)} (want=${JSON.stringify(originsExpected)}), report=${JSON.stringify(refused11.report)}, no faucet request=${noRequest11} (CDP Network), no creditGrant=${noGrant11}`);

  // --- Step 12 — Credits: 12a ask → 12b send + approve → 12c decline →
  // 12d locked send. WEB_INTERFACE → The wallet window, → The faucet step,
  // → The extension. The identity is unlocked (step 9), the policy is
  // silent (step 9), and the wallet is already open from step 11 with the
  // permissions stub resolving true.
  const R_HEX = R_JSON.pubKeyHex;

  // --- 12a — press ask under the granted stub → the stub is asked again
  // BEFORE /credits POST leaves → ledger creditGrant → landing → 100.
  await cx10.waitFor(`!!document.querySelector('.credits-field .credits-line')`, 'credits line');
  const events12aStart = cx10.events.length;
  const permCallsBefore12a = await cx10.eval(`window.__permCalls.length`);
  const before12a = await cx10.eval(`(() => {
    const line = document.querySelector('.credits-field .credits-line');
    const btns = [...(line?.querySelectorAll('button.word') ?? [])];
    const ask = btns.find(b => b.textContent.trim() === 'ask the faucet for $NOTIS');
    return { hasAsk: !!ask, gold: line?.querySelector('.mono.gold')?.textContent ?? null };
  })()`);
  await cx10.eval(`(() => {
    const line = document.querySelector('.credits-field .credits-line');
    [...line.querySelectorAll('button.word')].find(b => b.textContent.trim() === 'ask the faucet for $NOTIS').click();
  })()`, true);
  await cx10.waitFor(`(() => {
    const raw = localStorage.getItem('notis.pending.' + ${JSON.stringify(R_HEX)}) || '[]';
    return JSON.parse(raw).some(e => e.kind === 'creditGrant');
  })()`, 'creditGrant ledger entry', 15000);
  const grantEntry12a = await cx10.eval(`(() => {
    const raw = localStorage.getItem('notis.pending.' + ${JSON.stringify(R_HEX)}) || '[]';
    return JSON.parse(raw).find(e => e.kind === 'creditGrant');
  })()`);
  // The stub was asked again — the second call sits at index `permCallsBefore12a`.
  const permCall12a = await cx10.eval(`(() => {
    const call = window.__permCalls[${permCallsBefore12a}] ?? null;
    return call ? { origins: call.origins, at: call.at } : null;
  })()`);
  const faucetRequestEvent12a = cx10.events.slice(events12aStart).find((e) =>
    e.method === 'Network.requestWillBeSent' && (e.params.request.url || '').startsWith(FAUCET));
  const askedAgain12a = permCall12a !== null && Array.isArray(permCall12a.origins) && permCall12a.origins[0] === originsExpected;
  const askedBeforeRequest12a = permCall12a !== null && !!faucetRequestEvent12a
    && permCall12a.at <= faucetRequestEvent12a.params.wallTime * 1000;
  await cx10.waitFor(`document.querySelector('.credits-line .mono.gold')?.textContent === '100'`, 'row reads 100 after grant', 120000);
  const after12a = await cx10.eval(`(() => ({
    gold: document.querySelector('.credits-line .mono.gold')?.textContent ?? null,
    text: document.querySelector('.credits-line')?.textContent?.trim() ?? null,
  }))()`);
  const grantOk12a = grantEntry12a?.kind === 'creditGrant' && typeof grantEntry12a.postId === 'string' && /^[0-9a-f]{64}$/.test(grantEntry12a.postId);
  const askOk12a = before12a.hasAsk;
  const rowOk12a = after12a.gold === '100' && (after12a.text || '').includes('$NOTIS');
  record('12a', askOk12a && grantOk12a && rowOk12a && askedAgain12a && askedBeforeRequest12a,
    `ask=${askOk12a}, stub-asked-again=${askedAgain12a} (origins[0]=${JSON.stringify(permCall12a?.origins?.[0] ?? null)}), asked-before-request=${askedBeforeRequest12a}, grant.postId=${grantEntry12a?.postId?.slice(0, 8) ?? 'null'}…, landed row='${after12a.text}'`);

  // --- 12b — send 12.5 to the devnet faucet key. In the extension arm the
  // resolved-key hint appears beneath the recipient and the prompt opens at
  // once, no confirm row (WEB_INTERFACE → The wallet window → "The `send` row";
  // → The extension). Approve → /credits/transfer 200 → landing → row reads
  // 87.5 → faucet /credits has the payment.
  const events12bStart = cx10.events.length;
  await cx10.waitFor(`!!document.querySelector('form.credits-form')`, 'send form present');
  await cx10.eval(`(() => {
    const form = document.querySelector('form.credits-form');
    const inputs = form.querySelectorAll('input');
    inputs[0].value = ${JSON.stringify(DEVNET_FAUCET_KEY)};
    inputs[1].value = '12.5';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`, true);
  // Wait for the resolved-key hint to reveal — the extension arm shows the whole
  // key beneath the recipient field, no confirm row.
  await cx10.waitFor(
    `(() => { const r = document.querySelector('.credits-field form.credits-form .resolved-key'); return !!r && !r.hidden; })()`,
    'resolved-key visible 12b',
  );
  const resolvedKey12b = await cx10.eval(`document.querySelector('.credits-field form.credits-form .resolved-key')?.textContent ?? null`);
  const noConfirm12b = await cx10.eval(`!document.querySelector('.credits-field .pf-confirm')`);
  const prompt12b = await findExt('prompt.html');
  let promptShape12b = null;
  let shotSaved12b = false;
  if (prompt12b) {
    const cxp = await openSession(prompt12b.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt .line.what')`, 'prompt first line 12b');
    promptShape12b = await cxp.eval(`(() => {
      return [...document.querySelectorAll('.prompt .line')].map((l) => ({
        cls: [...l.classList].filter((c) => c !== 'line').join(' '),
        text: (l.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        label: l.querySelector('.target-label')?.textContent ?? null,
        value: l.querySelector('.target-value')?.textContent ?? null,
      }));
    })()`);
    // The screenshot — the popup's own window is 360 × 420 (background.ts
    // opens it that way); Page.captureScreenshot on that target renders the
    // page at that size. The one thing headless cannot measure is the
    // window's placement on a real screen — the report says so.
    const shot = await cxp.call('Page.captureScreenshot', { format: 'png' });
    if (shot && typeof shot.data === 'string') {
      const shotPath = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', 'prompts', 'web-prompt-window-12b.png');
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      shotSaved12b = true;
    }
    await cxp.eval(`document.querySelector('.prompt button.btn-primary').click()`, true);
    await sleep(2000);
    cxp.s.close();
  }
  await sleep(3000);
  const transfer12b = cx10.events.slice(events12bStart).find((e) =>
    e.method === 'Network.responseReceived' && (e.params.response.url || '').includes('/credits/transfer'));
  await cx10.waitFor(`document.querySelector('.credits-line .mono.gold')?.textContent === '87.5'`, 'row reads 87.5 after send', 180000);
  const faucetCredits12b = await (await fetch(`${NODE}/credits/${DEVNET_FAUCET_KEY}`)).json();
  const paymentBox = (faucetCredits12b.boxes || []).find((b) => BigInt(b.value) === 1_250_000_000n);
  const resolvedOk12b = resolvedKey12b === DEVNET_FAUCET_KEY;
  const whatOk12b = promptShape12b?.[0]?.cls === 'what' && promptShape12b?.[0]?.text === 'Notis transfer';
  const amountOk12b = promptShape12b?.[1]?.cls === 'amount' && promptShape12b?.[1]?.text === '12.5 $NOTIS';
  const targetOk12b = promptShape12b?.[2]?.cls === 'target' && promptShape12b?.[2]?.label === 'to:' && promptShape12b?.[2]?.value === DEVNET_FAUCET_KEY;
  const noFeeLine12b = !(promptShape12b || []).some((l) => l.cls === 'fee');
  const transferOk12b = transfer12b?.params.response.status === 200;
  const rowOk12b = await cx10.eval(`document.querySelector('.credits-line .mono.gold')?.textContent === '87.5'`);
  record('12b',
    noConfirm12b && resolvedOk12b && whatOk12b && amountOk12b && targetOk12b && noFeeLine12b && transferOk12b && rowOk12b && !!paymentBox && shotSaved12b,
    `no .pf-confirm=${noConfirm12b}, resolved-key='${(resolvedKey12b ?? '').slice(0, 8)}…${(resolvedKey12b ?? '').slice(-4)}'=whole=${resolvedOk12b}, lines=${JSON.stringify((promptShape12b || []).map((l) => `${l.cls}:${l.text}`))}, transfer=${transfer12b?.params.response.status ?? 'null'}, row='87.5'=${rowOk12b}, faucet has 12.5=${!!paymentBox}, screenshot saved=${shotSaved12b}`);

  // --- 12c — same extension arm, decline at the prompt. Both form inputs kept,
  // flight "send not sent.", no /credits/transfer (WEB_INTERFACE → The wallet
  // window → "The `send` row" — the fourth ending).
  const events12cStart = cx10.events.length;
  await cx10.waitFor(`!!document.querySelector('form.credits-form')`, 'credits form present 12c');
  await cx10.eval(`(() => {
    const form = document.querySelector('form.credits-form');
    const inputs = form.querySelectorAll('input');
    inputs[0].value = ${JSON.stringify(DEVNET_FAUCET_KEY)};
    inputs[1].value = '7.25';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`, true);
  // The extension arm — the resolved-key hint reveals, no confirm row.
  await cx10.waitFor(
    `(() => { const r = document.querySelector('.credits-field form.credits-form .resolved-key'); return !!r && !r.hidden; })()`,
    'resolved-key visible 12c',
  );
  const noConfirm12c = await cx10.eval(`!document.querySelector('.credits-field .pf-confirm')`);
  const prompt12c = await findExt('prompt.html');
  if (prompt12c) {
    const cxp = await openSession(prompt12c.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt button.btn-ghost')`, 'prompt cancel 12c');
    await cxp.eval(`document.querySelector('.prompt button.btn-ghost').click()`, true);
    await sleep(2000);
    cxp.s.close();
  }
  await sleep(2000);
  const state12c = await cx10.eval(`(() => {
    const form = document.querySelector('form.credits-form');
    const inputs = form ? form.querySelectorAll('input') : [];
    const flight = document.querySelector('.credits-flight .stage')?.textContent?.trim() ?? null;
    const gold = document.querySelector('.credits-line .mono.gold')?.textContent ?? null;
    return { to: inputs[0]?.value ?? null, amount: inputs[1]?.value ?? null, flight, gold };
  })()`);
  const transferSeen12c = cx10.events.slice(events12cStart).some((e) =>
    e.method === 'Network.requestWillBeSent' && (e.params.request.url || '').includes('/credits/transfer'));
  const formKept12c = state12c.to === DEVNET_FAUCET_KEY && state12c.amount === '7.25';
  const flightOk12c = state12c.flight === 'send not sent.';
  const rowUnchanged12c = state12c.gold === '87.5';
  record('12c', noConfirm12c && formKept12c && flightOk12c && !transferSeen12c && rowUnchanged12c,
    `no .pf-confirm=${noConfirm12c}, form to='${state12c.to?.slice(0, 8) ?? 'null'}…' amount='${state12c.amount}', flight='${state12c.flight}', no /credits/transfer=${!transferSeen12c}, row='${state12c.gold}'`);

  // --- 12d — lock in the profile, return to the wallet, then send: the
  // extension arm mounts the unlock form UNDER the credits form
  // (`.credits-field .card-unlock`, the invites row's pattern — WEB_INTERFACE
  // → The wallet window → "The `send` row"), never in a `.pf-confirm`. No
  // prompt, no /credits/transfer under lock. Unlock → the flight proceeds →
  // the first-send prompt after unlock. Decline it. A second send goes
  // straight to the prompt — cur.identity was mutated, no second unlock
  // (WEB_INTERFACE → The wallet window → "The `send` row").
  await cx10.eval(`document.querySelector('[aria-label="open profile"]').click()`, true);
  await cx10.waitFor(`!!window.__btn('lock')`, 'lock button in profile 12d');
  await cx10.eval(`window.__btn('lock').click()`, true);
  await sleep(1000);
  const lockedSession12d = await cx10.eval(`(async () => (await chrome.storage.session.get('notis.seed'))['notis.seed'] ?? null)()`);
  await cx10.eval(`document.querySelector('[aria-label="open wallet"]').click()`, true);
  const events12dStart = cx10.events.length;
  await cx10.waitFor(`!!document.querySelector('form.credits-form')`, 'credits form under lock');
  await cx10.eval(`(() => {
    const form = document.querySelector('form.credits-form');
    const inputs = form.querySelectorAll('input');
    inputs[0].value = ${JSON.stringify(DEVNET_FAUCET_KEY)};
    inputs[1].value = '5';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`, true);
  // The unlock form mounts under the credits form as `.credits-field
  // .card-unlock`, never in a confirm.
  await cx10.waitFor(`!!document.querySelector('.credits-field .card-unlock form.pf input[type="password"]')`, 'card-unlock 12d');
  const unlockMounted12d = await cx10.eval(`!!document.querySelector('.credits-field .card-unlock form.pf input[type="password"]')`);
  const noConfirmLocked12d = await cx10.eval(`!document.querySelector('.credits-field .pf-confirm')`);
  const promptSeen12d = await findExt('prompt.html');
  const transferSeen12dLocked = cx10.events.slice(events12dStart).some((e) =>
    e.method === 'Network.requestWillBeSent' && (e.params.request.url || '').includes('/credits/transfer'));
  await cx10.eval(`(() => {
    const form = document.querySelector('.credits-field .card-unlock form.pf');
    const pw = form.querySelector('input[type="password"]');
    pw.value = ${JSON.stringify(PASSPHRASE)};
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`, true);
  await sleep(3000);
  const prompt12dFirst = await findExt('prompt.html');
  if (prompt12dFirst) {
    const cxp = await openSession(prompt12dFirst.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt button.btn-ghost')`, 'prompt 12d first (decline)');
    await cxp.eval(`document.querySelector('.prompt button.btn-ghost').click()`, true);
    await sleep(2000);
    cxp.s.close();
  }
  await sleep(2000);
  await cx10.waitFor(`!!document.querySelector('form.credits-form')`, 'credits form for 12d second send');
  await cx10.eval(`(() => {
    const form = document.querySelector('form.credits-form');
    const inputs = form.querySelectorAll('input');
    inputs[0].value = ${JSON.stringify(DEVNET_FAUCET_KEY)};
    inputs[1].value = '2';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  })()`, true);
  // The resolved-key hint reveals; there must be no second `.card-unlock`
  // — the closure's `cur.identity.locked` is false after the first unlock.
  await cx10.waitFor(
    `(() => { const r = document.querySelector('.credits-field form.credits-form .resolved-key'); return !!r && !r.hidden; })()`,
    'resolved-key visible 12d second',
  );
  await sleep(1000);
  const unlockMounted12dSecond = await cx10.eval(`!!document.querySelector('.credits-field .card-unlock')`);
  const noConfirmSecond12d = await cx10.eval(`!document.querySelector('.credits-field .pf-confirm')`);
  const prompt12dSecond = await findExt('prompt.html');
  if (prompt12dSecond) {
    const cxp = await openSession(prompt12dSecond.webSocketDebuggerUrl);
    await cxp.waitFor(`!!document.querySelector('.prompt button.btn-ghost')`, 'prompt 12d second (decline)');
    await cxp.eval(`document.querySelector('.prompt button.btn-ghost').click()`, true);
    await sleep(2000);
    cxp.s.close();
  }
  record('12d',
    lockedSession12d === null && unlockMounted12d && noConfirmLocked12d && !promptSeen12d && !transferSeen12dLocked && !!prompt12dFirst && !unlockMounted12dSecond && noConfirmSecond12d && !!prompt12dSecond,
    `session empty=${lockedSession12d === null}, unlock under form=${unlockMounted12d}, no .pf-confirm under lock=${noConfirmLocked12d}, no prompt under lock=${!promptSeen12d}, no /credits/transfer under lock=${!transferSeen12dLocked}, first-send prompt after unlock=${!!prompt12dFirst}, second-send .card-unlock absent=${!unlockMounted12dSecond}, second-send .pf-confirm absent=${noConfirmSecond12d}, second-send prompt seen=${!!prompt12dSecond}`);

  // -------------------------------------------------------------------------
  // Steps 13–16 — WEB_INTERFACE → The extension → "Links into the extension".
  // Without --public and --web-dist the four are reported NOT RUN by name,
  // never PASS, never silently absent.
  // -------------------------------------------------------------------------
  if (PUBLIC === null) {
    record(13, 'NOT RUN', 'no --public / --web-dist — the harness serves no hosted origin');
    record(14, 'NOT RUN', 'no --public / --web-dist');
    record(15, 'NOT RUN', 'no --public / --web-dist');
    record(16, 'NOT RUN', 'no --public / --web-dist');
    await runVerifiedBlocksAlone();
    return;
  }

  const postId = await pickOwnRootPostId();
  if (postId === null) {
    record(13, false, 'no confirmed root post authored by R — nothing to link to');
    record(14, false, 'no confirmed root post authored by R');
    record(15, false, 'no confirmed root post authored by R');
    record(16, false, 'no confirmed root post authored by R');
    await runVerifiedBlocksAlone();
    return;
  }
  console.log(`steps 13-16 link target = <public>p/${postId.slice(0, 8)}…`);

  const bcx = await openBrowserSession();
  const publicLink = publicOrigin + publicBase + 'p/' + postId;
  const plainLink = publicOrigin + '/link.html?id=' + postId;
  const baseUrl = publicOrigin + publicBase;

  // The bridge's user-activation check reads navigator.userActivation.isActive.
  // Headless Chromium's window is 0×0 unless a viewport is set — a click at
  // (0,0) hits the browser chrome, not the page. Set a viewport now so
  // Input.dispatchMouseEvent lands inside the page for every hosted target.
  await bcx.call('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false }).catch(() => {});

  async function readNotisOpenKeys(cxToUse) {
    return await cxToUse.eval(`(async () => {
      const all = await chrome.storage.session.get(null);
      return Object.keys(all).filter(k => k.startsWith('notis.open.'));
    })()`);
  }

  // Wait for `Target.targetDestroyed` for a given target from a caller-passed
  // start index. The index must be taken BEFORE the target is created — a
  // destruction fired inside the microseconds between `Target.createTarget`
  // and the caller's own wait would otherwise sit at an index BEFORE `bcx.events.length`
  // at wait time, and a wait taking its own index in-body would step past it
  // (WEB_INTERFACE → The extension → "Links into the extension"). Returns the
  // event's arrival stamp (from `ev.__at`), so wall time is a difference in
  // that clock.
  async function waitForDestroyEvent(targetId, startIdx, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      for (let i = startIdx; i < bcx.events.length; i++) {
        const ev = bcx.events[i];
        if (ev.method === 'Target.targetDestroyed' && ev.params?.targetId === targetId) {
          return ev.__at ?? Date.now();
        }
      }
      await sleep(50);
    }
    return null;
  }

  // The raw event sequence for one target from the browser-session, between
  // two indices — `Target.targetCreated`, `Target.targetInfoChanged*`,
  // `Target.targetDestroyed`, each with its arrival stamp and the URL it
  // carried at the time.
  function collectTargetEvents(targetId, startIdx, endIdx) {
    const end = endIdx ?? bcx.events.length;
    const out = [];
    for (let i = startIdx; i < end; i++) {
      const ev = bcx.events[i];
      const info = ev.params?.targetInfo;
      const idHere = ev.method === 'Target.targetDestroyed' ? ev.params?.targetId : info?.targetId;
      if (idHere !== targetId) continue;
      if (ev.method !== 'Target.targetCreated'
          && ev.method !== 'Target.targetInfoChanged'
          && ev.method !== 'Target.targetDestroyed') continue;
      out.push({
        method: ev.method,
        at: ev.__at ?? null,
        url: info?.url ?? null,
        openerId: info?.openerId ?? null,
      });
    }
    return out;
  }

  // ------- Step 13 — pref `on the site`, the button arm. The browser-context
  // arm ("13-uncancelled") is the last thing the harness does with the
  // browser, after the verified-tip block: `Target.createBrowserContext` +
  // `Target.disposeBrowserContext` has been observed to freeze the next CDP
  // call in a same-browser session, so the arm sits last where a freeze
  // cannot shadow any other step.
  const step13Prefs = await setLinksPrefViaUi(cx10, 'site');
  if (step13Prefs !== 'site') {
    record(13, false, `pref did not take: notis.links=${step13Prefs}`);
  } else {
    // Fresh target on the post's public link — the destruction event may
    // arrive before this line returns, so the browser event index is taken
    // BEFORE the call.
    const startIdx13 = bcx.events.length;
    const created13 = await bcx.call('Target.createTarget', { url: publicLink });
    const hostedId13 = created13.targetId;
    const hostedInfo13 = await findTargetById(hostedId13, 15000);
    let stepStatus13 = false;
    let boot13ok = false;
    let takeoverDidNotFire13 = false;
    let destroyed13ok = false;
    let firstColumnHasThread13 = false;
    let extActive13 = false;
    let noOpen13 = false;
    if (!hostedInfo13) {
      record(13, false, `hosted target ${hostedId13.slice(0, 8)}… never appeared in /json/list`);
    } else {
      const cxH13 = await openSession(hostedInfo13.webSocketDebuggerUrl);
      // Wait for the App to boot to the standalone thread.
      try {
        await cxH13.waitFor(`!!document.querySelector('.card[data-post-id="${postId}"]')`, 'hosted root card 13', 30000);
        boot13ok = true;
      } catch {}
      const url13boot = await cxH13.eval(`location.href`);
      // The takeover did not fire — the tab was not redirected under `site`.
      takeoverDidNotFire13 = url13boot === publicLink;
      const openKeysBefore13 = await readNotisOpenKeys(cx10);
      // Trusted press on `add to workspace`.
      let clickErr13 = null;
      try { await trustedClickAt(cxH13, '[aria-label="add this thread to your workspace"]'); }
      catch (e) { clickErr13 = String(e); }
      // The hosted target destroyed; the extension page's first column holds the thread.
      const destAt13 = await waitForDestroyEvent(hostedId13, startIdx13, 15000);
      destroyed13ok = destAt13 !== null;
      try {
        await cx10.waitFor(`!!document.querySelector('#panes .col .card[data-post-id="${postId}"]')`, 'first column holds thread 13', 15000);
        firstColumnHasThread13 = true;
      } catch {}
      extActive13 = await cx10.eval(`(async () => {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const me = tabs.find(t => typeof t.url === 'string' && t.url.startsWith('chrome-extension://'));
        return !!me;
      })()`);
      const openKeysAfter13 = await readNotisOpenKeys(cx10);
      // The offer left no pending record — takeOpen consumed it, so the
      // count returns to what it was before (WEB_INTERFACE → The extension →
      // "Both messages end in one act, landing the thread in the workspace").
      noOpen13 = openKeysAfter13.length === openKeysBefore13.length && openKeysAfter13.length === 0;
      try { cxH13.s.close(); } catch {}
      console.log(`step 13 button: url@boot=${url13boot}, click=${clickErr13 ?? 'ok'}, dest@ms=${destAt13 ?? 'null'}, firstCol=${firstColumnHasThread13}, extActive=${extActive13}, openKeys before=${JSON.stringify(openKeysBefore13)} after=${JSON.stringify(openKeysAfter13)}`);

      stepStatus13 = boot13ok && takeoverDidNotFire13 && destroyed13ok && firstColumnHasThread13 && extActive13 && noOpen13;
      record(13, stepStatus13,
        `boot=${boot13ok} (url ${url13boot}), takeover-did-not-fire=${takeoverDidNotFire13}, hosted destroyed=${destroyed13ok} (@${destAt13 ?? 'null'}ms), first column has thread=${firstColumnHasThread13}, ext tab active=${extActive13}, no notis.open. key=${noOpen13}`);
    }
  }

  // ------- Step 14 — pref `here`, a workspace tab open, three runs incl. cold.
  // The step probes cx10 at start — a short evaluate against a 5 s race,
  // /json/list for the extension page, `document.visibilityState`,
  // `document.hasFocus()` — and calls `Target.activateTarget` on the page if
  // its visibility is hidden. The bridge-less arm's browser-context work is
  // deferred to run AFTER step 16, so cx10 is expected to be responsive here.
  const probeAt14 = {
    listHasExt: null,
    probeMs: null,
    probeValue: null,
    visibility: null,
    hasFocus: null,
    activateTried: false,
    activateAfterProbe: null,
  };
  {
    const t0p = Date.now();
    const listNow = await jsonList();
    const extPageNow = listNow.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${EXT_ID}/`));
    probeAt14.listHasExt = !!extPageNow;
    const probeP = (async () => {
      try { return await cx10.eval(`1+1`); } catch (e) { return { error: String(e) }; }
    })();
    const raceP = new Promise((res) => setTimeout(() => res({ timeout: true }), 5000));
    const probeR = await Promise.race([probeP, raceP]);
    probeAt14.probeMs = Date.now() - t0p;
    probeAt14.probeValue = probeR;
    try {
      probeAt14.visibility = await Promise.race([
        cx10.eval(`document.visibilityState`),
        new Promise((res) => setTimeout(() => res(null), 3000)),
      ]);
      probeAt14.hasFocus = await Promise.race([
        cx10.eval(`document.hasFocus()`),
        new Promise((res) => setTimeout(() => res(null), 3000)),
      ]);
    } catch {}
    if (extPageNow && (probeR?.timeout === true || probeAt14.visibility === 'hidden')) {
      probeAt14.activateTried = true;
      try { await bcx.call('Target.activateTarget', { targetId: extPageNow.targetId }); } catch {}
      const probeAgain = await Promise.race([
        (async () => { try { return await cx10.eval(`1+1`); } catch (e) { return { error: String(e) }; } })(),
        new Promise((res) => setTimeout(() => res({ timeout: true }), 5000)),
      ]);
      probeAt14.activateAfterProbe = probeAgain;
    }
    console.log(`step 14 probe: listHasExt=${probeAt14.listHasExt}, probeMs=${probeAt14.probeMs}, probe=${JSON.stringify(probeAt14.probeValue)}, visibility=${probeAt14.visibility}, hasFocus=${probeAt14.hasFocus}, activateTried=${probeAt14.activateTried}, afterActivate=${JSON.stringify(probeAt14.activateAfterProbe)}`);
  }

  const step14Prefs = await setLinksPrefViaUi(cx10, 'here');
  if (step14Prefs !== 'here') {
    record(14, false, `pref did not take: notis.links=${step14Prefs}; probe=${JSON.stringify(probeAt14)}`);
  } else {
    const runs14 = [];
    for (let r = 0; r < 3; r++) {
      const cold = r === 2;
      if (cold) {
        // Let any live worker die by a ≥ 32 s idle wait — step 8's rule.
        console.log(`step 14 run 3: idle-waiting 32s for MV3 SW termination…`);
        await sleep(32000);
      }
      const openKeysBefore14 = await readNotisOpenKeys(cx10);
      // Index into the browser session's events and the static server's
      // request log, taken BEFORE the createTarget so a destruction that
      // fires inside the first microseconds is still visible to the wait.
      const evStart14 = bcx.events.length;
      const reqStart14 = webRequests.length;
      const t0 = Date.now();
      const created14 = await bcx.call('Target.createTarget', { url: publicLink });
      const tid14 = created14.targetId;
      const info14 = await findTargetById(tid14, 15000);
      let mounted14 = null;
      let cxT14 = null;
      if (info14) {
        try {
          cxT14 = await openSession(info14.webSocketDebuggerUrl);
          // Poll `#appbar` children — record whether the hosted App mounted
          // before the destruction. Bail out on any eval error (a destroying
          // target rejects Runtime.evaluate). Recorded, never asserted — a
          // CDP session attached to a tab that lives tens of milliseconds is
          // a race the harness loses; the static server's request log is the
          // measurement from outside.
          const t1 = Date.now();
          while (Date.now() - t1 < 15000) {
            const has = await cxT14.eval(`(document.querySelector('#appbar')?.children.length ?? 0) > 0`).catch(() => 'gone');
            if (has === true) { mounted14 = true; break; }
            if (has === 'gone') { break; }
            await sleep(50);
          }
        } catch {}
      }
      const destAt14 = await waitForDestroyEvent(tid14, evStart14, 20000);
      const elapsed14 = destAt14 === null ? null : destAt14 - t0;
      try { if (cxT14) cxT14.s.close(); } catch {}
      // Read /json/list AFTER the wait — the arriving target absent AND
      // exactly one extension page target — that count tells the close arm
      // from the re-point arm.
      const listAfter14 = await jsonList();
      const arrivedGone14 = !listAfter14.find((t) => t.id === tid14);
      const extPagesAfter14 = listAfter14.filter((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${EXT_ID}/`));
      const extPageCount14 = extPagesAfter14.length;
      // First column has the thread; extension tab is active. The record was
      // consumed by takeOpen — no `notis.open.` key remains.
      let firstColOk = false;
      try {
        await cx10.waitFor(`!!document.querySelector('#panes .col .card[data-post-id="${postId}"]')`, 'first col 14', 15000);
        firstColOk = true;
      } catch {}
      const extActive14 = await cx10.eval(`(async () => {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const me = tabs.find(t => typeof t.url === 'string' && t.url.startsWith('chrome-extension://'));
        return !!me;
      })()`);
      const openKeysAfter14 = await readNotisOpenKeys(cx10);
      const noOpen14 = openKeysAfter14.length === openKeysBefore14.length;
      // The arriving target's own event sequence — targetCreated →
      // targetInfoChanged* → targetDestroyed — each with its ms since t0.
      const targetEvents14 = collectTargetEvents(tid14, evStart14, bcx.events.length).map((e) => ({
        method: e.method,
        ms: e.at === null ? null : e.at - t0,
        url: e.url,
      }));
      // The static server's request log for this run — from t0 to 500 ms
      // after the destroyed event (or 15 s after t0 if no destruction). The
      // shell alone, or the bundle, the stylesheet, the fonts — how far the
      // hosted page got, measured from outside.
      const reqWindowEnd14 = destAt14 !== null ? destAt14 + 500 : t0 + 15000;
      const reqLog14 = webRequests.slice(reqStart14).filter((q) => q.at <= reqWindowEnd14).map((q) => ({ path: q.path, ms: q.at - t0 }));
      const run = {
        cold, tid: tid14.slice(0, 8), mounted: mounted14, elapsedMs: elapsed14,
        firstCol: firstColOk, extActive: extActive14, noOpen: noOpen14,
        arrivedGone: arrivedGone14, extPageCount: extPageCount14,
        targetEvents: targetEvents14, reqLog: reqLog14,
      };
      runs14.push(run);
      console.log(`step 14 run ${r + 1}${cold ? ' (cold)' : ''}: dest@${elapsed14 ?? 'null'}ms, arrivedGone=${arrivedGone14}, extPages=${extPageCount14}, appbarMountedBeforeDestroy=${mounted14 ?? 'unobserved'}, firstCol=${firstColOk}, extActive=${extActive14}, noOpen=${noOpen14}`);
      console.log(`step 14 run ${r + 1} events for tid=${tid14.slice(0, 8)}: ${JSON.stringify(targetEvents14)}`);
      console.log(`step 14 run ${r + 1} static server: ${JSON.stringify(reqLog14)}`);
    }
    const allDestroyed14 = runs14.every((r) => r.elapsedMs !== null);
    const allArrivedGone14 = runs14.every((r) => r.arrivedGone === true);
    const allOneExtPage14 = runs14.every((r) => r.extPageCount === 1);
    const allFirstCol14 = runs14.every((r) => r.firstCol);
    const allExtActive14 = runs14.every((r) => r.extActive);
    const allNoOpen14 = runs14.every((r) => r.noOpen);
    record(14, allDestroyed14 && allArrivedGone14 && allOneExtPage14 && allFirstCol14 && allExtActive14 && allNoOpen14,
      `three runs: destroyed=${allDestroyed14}, arrivedGone=${allArrivedGone14}, extPageCount==1=${allOneExtPage14}, first col holds thread=${allFirstCol14}, ext tab active=${allExtActive14}, no notis.open. key remained=${allNoOpen14}; timings ms=${JSON.stringify(runs14.map((r) => ({ cold: r.cold, ms: r.elapsedMs, extPages: r.extPageCount, mounted: r.mounted })))}`);
  }

  // ------- Step 15 — pref `here`, no workspace tab. Close the extension's tab
  //         first; a fresh target on the link should have its URL become the
  //         extension page (WEB_INTERFACE → The extension → "Both messages
  //         end in one act, landing the thread in the workspace").
  {
    // Find and close cx10's target.
    const extPage = await findExt('index.html');
    const extPageId = extPage?.id ?? null;
    try { cx10.s.close(); } catch {}
    let closed15 = false;
    if (extPageId) {
      await bcx.call('Target.closeTarget', { targetId: extPageId }).catch(() => {});
      closed15 = await waitForTargetGone(extPageId, 15000);
    }
    await sleep(1500);
    const openKeysBefore15 = null; // no ext page to read from yet
    const created15 = await bcx.call('Target.createTarget', { url: publicLink });
    const tid15 = created15.targetId;
    // The extension redirects the tab in place. Wait for the target's URL to
    // become the extension page.
    let becameExtension15 = false;
    let cx15 = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const list = await jsonList();
      const t = list.find((x) => x.id === tid15);
      if (t && typeof t.url === 'string' && t.url.startsWith(`chrome-extension://${EXT_ID}/`)) {
        becameExtension15 = true;
        cx15 = await openSession(t.webSocketDebuggerUrl);
        break;
      }
      await sleep(150);
    }
    let firstColOk15 = false;
    let noOpen15 = false;
    let backUrl15 = null;
    let backCount15 = 0;
    let backReached15 = false;
    let backStays15 = false;
    let backHostedCard15 = false;
    let backHistoryLen15Ok = false;
    let backHistoryLen15Value = null;
    let backHistoryLen15SingleEntry = false;
    let initialHist15 = null;
    let initialWidth15 = null;
    const backSteps15 = [];
    if (cx15) {
      try {
        await cx15.waitFor(`!!document.querySelector('#panes .col .card[data-post-id="${postId}"]')`, 'first col 15', 30000);
        firstColOk15 = true;
      } catch {}
      const openKeysAfter15 = await readNotisOpenKeys(cx15);
      noOpen15 = openKeysAfter15.length === 0;
      console.log(`step 15: closed=${closed15}, becameExtension=${becameExtension15}, firstCol=${firstColOk15}, notis.open. keys=${JSON.stringify(openKeysAfter15)}`);

      // Step 16(c) — history.back on the re-pointed tab. The workspace
      // pushes a screen entry when a thread opens under one column, so
      // reaching the hosted URL may take more than one back. Log innerWidth,
      // history.length and history.state BEFORE every back; iterate at most
      // three; wait after each on a settle condition — the URL or the state
      // changing, never a bare sleep — and stop when the URL is the hosted
      // link. If `history.length` reads 1 in the re-pointed tab right after
      // its boot, `tabs.update({ url })` replaced the hosted entry and back
      // cannot reach the website at all — record that and do not iterate.
      initialHist15 = await cx15.eval(`history.length`);
      const initialUrl15 = await cx15.eval(`location.href`);
      initialWidth15 = await cx15.eval(`innerWidth`);
      const initialState15 = await cx15.eval(`JSON.stringify(history.state)`);
      backSteps15.push({ before: 'initial', width: initialWidth15, historyLength: initialHist15, historyState: initialState15, url: initialUrl15 });
      if (initialHist15 === 1) {
        backHistoryLen15SingleEntry = true;
        console.log(`step 16(c) history.length=1 on the re-pointed tab: tabs.update({ url }) replaced the hosted entry — no back can reach the website.`);
      } else {
        for (let attempt = 0; attempt < 3 && !backReached15; attempt++) {
          const before = {
            attempt,
            width: await cx15.eval(`innerWidth`),
            historyLength: await cx15.eval(`history.length`),
            historyState: await cx15.eval(`JSON.stringify(history.state)`),
            url: await cx15.eval(`location.href`),
          };
          backSteps15.push({ before: 'before back ' + attempt, ...before });
          const priorUrl = before.url;
          const priorState = before.historyState;
          await cx15.eval(`history.back()`);
          backCount15 += 1;
          const t0b = Date.now();
          while (Date.now() - t0b < 5000) {
            const urlNow = await cx15.eval(`location.href`).catch(() => priorUrl);
            const stateNow = await cx15.eval(`JSON.stringify(history.state)`).catch(() => priorState);
            if (urlNow !== priorUrl || stateNow !== priorState) break;
            await sleep(50);
          }
          const urlAfter = await cx15.eval(`location.href`).catch(() => priorUrl);
          const stateAfter = await cx15.eval(`JSON.stringify(history.state)`).catch(() => priorState);
          backSteps15.push({ before: 'after back ' + attempt, url: urlAfter, historyState: stateAfter });
          if (urlAfter === publicLink) { backReached15 = true; break; }
        }
        if (backReached15) {
          try { await cx15.waitFor(`!!document.querySelector('.card[data-post-id="${postId}"]')`, '16c hosted card', 15000); } catch {}
          backHostedCard15 = await cx15.eval(`!!document.querySelector('.card[data-post-id="${postId}"]')`);
          await sleep(2000);
          backUrl15 = await cx15.eval(`location.href`);
          backStays15 = backUrl15 === publicLink;
          backHistoryLen15Value = await cx15.eval(`history.length`);
          backHistoryLen15Ok = typeof backHistoryLen15Value === 'number' && backHistoryLen15Value >= 2;
        }
      }
      console.log(`step 16(c) history.back: initial history.length=${initialHist15}, attempts=${backCount15}, reached=${backReached15}, urlAfter=${backUrl15}, stays=${backStays15}, hosted card=${backHostedCard15}, history.length on hosted=${backHistoryLen15Value}, singleEntry=${backHistoryLen15SingleEntry}, steps=${JSON.stringify(backSteps15)}`);
    }
    record(15, closed15 && becameExtension15 && firstColOk15 && noOpen15,
      `ext tab closed=${closed15}, fresh target URL becomes extension=${becameExtension15}, first col holds thread=${firstColOk15}, no notis.open. key=${noOpen15}`);

    // ------- Step 16 — pref `here`, left alone. (a) same-tab click on the
    // plain page's link → hosted page boots and stays; (b) reload of a hosted
    // thread page → stays; (c) history.back() in step 15's tab → hosted page,
    // stays (measured above); (d) target="_blank" from the plain page → taken
    // over — the control for (a).
    let same16a_url = null, same16a_hist = null, same16a_stays = false;
    let reload16b_url = null, reload16b_stays = false;
    let blank16d_destroyed = false, blank16d_firstCol = false;
    // (a): open a fresh target on the plain page, click #same, then wait.
    const createdA = await bcx.call('Target.createTarget', { url: plainLink });
    const tidA = createdA.targetId;
    const infoA = await findTargetById(tidA, 15000);
    if (infoA) {
      const cxA = await openSession(infoA.webSocketDebuggerUrl);
      try { await cxA.waitFor(`!!document.querySelector('#same')`, 'plain page a-same', 10000); } catch {}
      // Trusted click on the same-tab link.
      try { await trustedClickAt(cxA, '#same'); } catch {}
      // Wait for the navigation to land on the hosted post URL.
      const t0a = Date.now();
      while (Date.now() - t0a < 15000) {
        const u = await cxA.eval(`location.href`).catch(() => null);
        if (u === publicLink) break;
        await sleep(150);
      }
      same16a_url = await cxA.eval(`location.href`);
      try { await cxA.waitFor(`!!document.querySelector('.card[data-post-id="${postId}"]')`, '16a hosted card', 20000); } catch {}
      // Sleep 2s and assert it stays.
      await sleep(2000);
      const url16aAfter = await cxA.eval(`location.href`);
      same16a_hist = await cxA.eval(`history.length`);
      same16a_stays = url16aAfter === publicLink && same16a_hist === 2;
      // (b): reload this hosted page.
      await cxA.call('Page.reload');
      await sleep(3000);
      try { await cxA.waitFor(`!!document.querySelector('.card[data-post-id="${postId}"]')`, '16b hosted card', 20000); } catch {}
      reload16b_url = await cxA.eval(`location.href`);
      reload16b_stays = reload16b_url === publicLink && (await cxA.eval(`!!document.querySelector('.card[data-post-id="${postId}"]')`)) === true;
      try { cxA.s.close(); } catch {}
      await bcx.call('Target.closeTarget', { targetId: tidA }).catch(() => {});
    }
    console.log(`step 16(a) same-tab: url=${same16a_url}, history.length=${same16a_hist}, stays=${same16a_stays}`);
    console.log(`step 16(b) reload:   url=${reload16b_url}, stays=${reload16b_stays}`);

    // (d): open a fresh plain page, trusted click on #blank. The tab opens
    // by `_blank`; its precondition is that zero extension page targets are
    // open, so the takeover arm is the redirect (no destruction), and the
    // measured expectation is the new tab's URL becomes the extension page,
    // the thread in the first column, no `notis.open.` key left, and exactly
    // one extension page target — never asserted as a union.

    // Close step 15's tab so no live extension page target stands.
    let cx15Closed16d = false;
    if (cx15) {
      try { cx15.s.close(); } catch {}
      cx15 = null;
      try { await bcx.call('Target.closeTarget', { targetId: tid15 }); } catch {}
      cx15Closed16d = await waitForTargetGone(tid15, 15000);
    }
    const listPre16d = await jsonList();
    const extPagesPre16d = listPre16d.filter((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${EXT_ID}/`));

    let blank16d_newTargetId = null;
    let blank16d_openerIdPresent = null;
    let blank16d_urlSeen = null;
    let blank16d_becameExtension = false;
    let blank16d_takenOver = false;
    let blank16d_noOpenKey = false;
    let blank16d_extPageCount = null;
    if (extPagesPre16d.length !== 0) {
      // Precondition failed — the takeover arm this step controls for is not
      // the arm that would run; report and skip.
      record(16, false,
        `precondition failed for (d): after cx15 tab close, /json/list still has ${extPagesPre16d.length} extension page target(s); (a) stays=${same16a_stays}, (b) stays=${reload16b_stays}, (c) reached=${backReached15}, stays=${backStays15}, url ${backUrl15}, history.length ${backHistoryLen15Value}, singleEntry=${backHistoryLen15SingleEntry}, steps=${JSON.stringify(backSteps15)}`);
    } else {
      const createdD = await bcx.call('Target.createTarget', { url: plainLink });
      const tidD = createdD.targetId;
      const infoD = await findTargetById(tidD, 15000);
      if (infoD) {
        const cxD = await openSession(infoD.webSocketDebuggerUrl);
        try { await cxD.waitFor(`!!document.querySelector('#blank')`, 'plain page d-blank', 10000); } catch {}
        // Known page target ids taken BEFORE the click — anything opening
        // after with a fresh id and (when the runtime carries it) an
        // `openerId` of `tidD` is the popup this click created; else fall
        // back to the first fresh page id.
        const listBeforeClick = await jsonList();
        const knownIds = new Set(listBeforeClick.filter((t) => t.type === 'page').map((t) => t.id));
        const startIdx = bcx.events.length;
        try { await trustedClickAt(cxD, '#blank'); } catch {}
        // Discover the new target by openerId first, else by any fresh page
        // id — never by URL, because `Target.targetCreated` for a link-opened
        // tab announces with an empty URL, and the real URL arrives in a
        // later `Target.targetInfoChanged`.
        const t0d = Date.now();
        while (Date.now() - t0d < 15000 && !blank16d_newTargetId) {
          for (let i = startIdx; i < bcx.events.length; i++) {
            const ev = bcx.events[i];
            if (ev.method !== 'Target.targetCreated') continue;
            const info = ev.params?.targetInfo;
            if (!info || info.type !== 'page') continue;
            if (info.openerId === tidD) {
              blank16d_newTargetId = info.targetId;
              blank16d_openerIdPresent = true;
              break;
            }
          }
          if (blank16d_newTargetId) break;
          for (let i = startIdx; i < bcx.events.length; i++) {
            const ev = bcx.events[i];
            if (ev.method !== 'Target.targetCreated') continue;
            const info = ev.params?.targetInfo;
            if (!info || info.type !== 'page') continue;
            if (info.targetId === tidD) continue;
            if (knownIds.has(info.targetId)) continue;
            blank16d_newTargetId = info.targetId;
            blank16d_openerIdPresent = false;
            break;
          }
          if (!blank16d_newTargetId) await sleep(100);
        }
        if (blank16d_newTargetId) {
          // Follow `Target.targetInfoChanged` for the URL; the takeover ends
          // with the extension page URL (no live workspace tab existed at
          // the click). `/json/list` is polled as a second reader in case a
          // changed event is missed.
          const t1 = Date.now();
          let extInfo = null;
          while (Date.now() - t1 < 20000) {
            for (let i = startIdx; i < bcx.events.length; i++) {
              const ev = bcx.events[i];
              if (ev.method !== 'Target.targetInfoChanged') continue;
              const info = ev.params?.targetInfo;
              if (info?.targetId !== blank16d_newTargetId) continue;
              if (typeof info.url === 'string' && info.url.startsWith(`chrome-extension://${EXT_ID}/`)) {
                blank16d_urlSeen = info.url;
                break;
              }
            }
            if (blank16d_urlSeen) break;
            const list = await jsonList();
            const t = list.find((x) => x.id === blank16d_newTargetId);
            if (t && typeof t.url === 'string' && t.url.startsWith(`chrome-extension://${EXT_ID}/`)) {
              blank16d_urlSeen = t.url;
              extInfo = t;
              break;
            }
            await sleep(150);
          }
          blank16d_becameExtension = blank16d_urlSeen !== null;
          blank16d_takenOver = blank16d_becameExtension;
          // First col holds the thread — in the redirected new tab, and the
          // ledger's `notis.open.` key was consumed.
          if (blank16d_becameExtension) {
            if (!extInfo) {
              const list = await jsonList();
              extInfo = list.find((x) => x.id === blank16d_newTargetId);
            }
            if (extInfo?.webSocketDebuggerUrl) {
              const cxNew = await openSession(extInfo.webSocketDebuggerUrl);
              try {
                await cxNew.waitFor(`!!document.querySelector('#panes .col .card[data-post-id="${postId}"]')`, 'first col 16d new tab', 15000);
                blank16d_firstCol = true;
              } catch {}
              try {
                const remaining = await readNotisOpenKeys(cxNew);
                blank16d_noOpenKey = remaining.length === 0;
              } catch {}
              try { cxNew.s.close(); } catch {}
            }
            const listEnd = await jsonList();
            blank16d_extPageCount = listEnd.filter((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${EXT_ID}/`)).length;
          }
        }
        try { cxD.s.close(); } catch {}
        await bcx.call('Target.closeTarget', { targetId: tidD }).catch(() => {});
      }
      console.log(`step 16(d) target=_blank: cx15Closed=${cx15Closed16d}, extPagesPre=${extPagesPre16d.length}, newTarget=${blank16d_newTargetId ? blank16d_newTargetId.slice(0, 8) + '…' : 'null'}, openerIdPresent=${blank16d_openerIdPresent}, urlSeen=${blank16d_urlSeen}, becameExtension=${blank16d_becameExtension}, firstCol=${blank16d_firstCol}, noOpenKey=${blank16d_noOpenKey}, extPageCount=${blank16d_extPageCount}`);

      const step16Pass = same16a_stays && reload16b_stays
        && backReached15 && backStays15 && backHostedCard15 && backHistoryLen15Ok
        && blank16d_takenOver && blank16d_firstCol && blank16d_noOpenKey && blank16d_extPageCount === 1;
      record(16, step16Pass,
        `(a) same-tab stays=${same16a_stays} (url ${same16a_url}, history.length ${same16a_hist}); (b) reload stays=${reload16b_stays} (url ${reload16b_url}); (c) history.back reached=${backReached15} in ${backCount15} back(s) (initialWidth=${initialWidth15}, initialHistoryLen=${initialHist15}, singleEntry=${backHistoryLen15SingleEntry}), stays=${backStays15} (url ${backUrl15}, hostedCard=${backHostedCard15}, history.length=${backHistoryLen15Value}, ≥2=${backHistoryLen15Ok}), steps=${JSON.stringify(backSteps15)}; (d) precondition extPagesPre=${extPagesPre16d.length}, cx15Closed=${cx15Closed16d}, openerIdPresent=${blank16d_openerIdPresent}, becameExtension=${blank16d_becameExtension}, first col=${blank16d_firstCol}, noOpenKey=${blank16d_noOpenKey}, extPageCount=${blank16d_extPageCount}`);
    }

    try { if (cx15) cx15.s.close(); } catch {}
  }

  await runVerifiedBlocks(bcx);

  // ------- Step 13-uncancelled — the browser-context arm, last after the
  // verified-tip block. The extension does not load in a
  // `Target.createBrowserContext` context (per `--load-extension`'s default
  // profile scope), so the bridge cannot send `arrived` and no `notis.open.`
  // key appears. `Target.disposeBrowserContext` has been observed to freeze
  // the next CDP call in a same-browser session, so the arm sits last where
  // a freeze cannot shadow any other step.
  {
    let extPageAfter16 = await findExt('index.html');
    let cxObserver = null;
    let openBeforeArm = null;
    try {
      if (extPageAfter16?.webSocketDebuggerUrl) {
        cxObserver = await openSession(extPageAfter16.webSocketDebuggerUrl);
        openBeforeArm = await readNotisOpenKeys(cxObserver);
      }
      let bctxId = null;
      try {
        const ctxRes = await bcx.call('Target.createBrowserContext', {});
        bctxId = ctxRes.browserContextId;
        const arm = await bcx.call('Target.createTarget', { url: publicLink, browserContextId: bctxId });
        const armId = arm.targetId;
        const armInfo = await findTargetById(armId, 15000);
        if (!armInfo) {
          record('13-uncancelled', false, `fresh target in browser context never appeared`);
        } else {
          const cxArm = await openSession(armInfo.webSocketDebuggerUrl);
          try {
            await cxArm.waitFor(`!!document.querySelector('.card[data-post-id="${postId}"]')`, 'arm root card', 30000);
          } catch {}
          const openMid = cxObserver ? await readNotisOpenKeys(cxObserver) : null;
          const bridgeAbsentPreClick = openMid !== null && openBeforeArm !== null && openMid.length === openBeforeArm.length;
          let armClickErr = null;
          try { await trustedClickAt(cxArm, '[aria-label="add this thread to your workspace"]'); }
          catch (e) { armClickErr = String(e); }
          await sleep(2000);
          const armUrl = await cxArm.eval(`location.href`).catch(() => null);
          const armInPlace = armUrl === baseUrl;
          const openAfterArm = cxObserver ? await readNotisOpenKeys(cxObserver) : null;
          const armBridgeAbsent = bridgeAbsentPreClick && openAfterArm !== null && openBeforeArm !== null && openAfterArm.length === openBeforeArm.length;
          console.log(`step 13-uncancelled: click=${armClickErr ?? 'ok'}, url@after=${armUrl}, in-place=${armInPlace}, bridge absent (no new notis.open.)=${armBridgeAbsent}, extPageAfter16=${!!extPageAfter16}`);
          record('13-uncancelled', armInPlace && armBridgeAbsent,
            `url=${armUrl} in-place=${armInPlace}, bridge absent=${armBridgeAbsent} (openBefore=${JSON.stringify(openBeforeArm)}, openAfter=${JSON.stringify(openAfterArm)}); observer extPage=${!!extPageAfter16}`);
          try { cxArm.s.close(); } catch {}
          await bcx.call('Target.closeTarget', { targetId: armId }).catch(() => {});
        }
      } finally {
        if (bctxId) await bcx.call('Target.disposeBrowserContext', { browserContextId: bctxId }).catch(() => {});
      }
    } catch (e) {
      record('13-uncancelled', false, `error: ${String(e)}`);
    } finally {
      try { if (cxObserver) cxObserver.s.close(); } catch {}
    }
  }

  try { bcx.s.close(); } catch {}
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error('proof failed:', e);
  exitCode = 1;
}

console.log('\n=== SUMMARY ===');
for (const r of findings) console.log(`  step ${r.step}: ${r.status} — ${r.detail}`);
const pass = findings.filter((f) => f.status === 'PASS').length;
const fail = findings.filter((f) => f.status === 'FAIL').length;
const skipped = findings.filter((f) => f.status === 'SKIPPED').length;
// One measurement per top-level step. Step 12's sub-parts (12a…12d) collapse
// into step 12; the summary line reads what WEB_INTERFACE → The extension asks.
const measured = new Set(findings.map((f) => String(f.step).replace(/[a-d]$/, ''))).size;
console.log(`\n${measured} measured (${pass} PASS, ${fail} FAIL, ${skipped} SKIPPED)`);
console.log(JSON.stringify({ measured, pass, fail, skipped, findings }, null, 2));
if (fail > 0) exitCode = 1;

proc.kill();
if (webServer) await new Promise((r) => webServer.close(() => r()));
process.exit(exitCode);
