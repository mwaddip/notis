// MESH_INTERFACE → Place in the workspace / The node endpoint — the mesh
// node's entry point: read its configuration from the environment, load or
// create the key file, start the node, and print one JSON line on stdout
// with its identity and reachable addresses. Node-only.

import { isIPv4, isIPv6 } from 'node:net';
import { loadOrCreateNodeKey } from './key-store.js';
import { startMeshNode } from './mesh-node.js';
import { acmeSource } from './acme.js';
import type { WssOptions } from './wss.js';
import type { NetworkName } from '../protocols.js';
import { MeshConfigError } from '../config.js';
import { stunSettingFor } from './stun-setting.js';
import { buildIdentityLine } from './identity-line.js';

function need(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    console.error(`missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function list(name: string): string[] {
  const v = process.env[name];
  if (v === undefined || v === '') return [];
  return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseRole(v: string): 'public' | 'private' {
  if (v === 'public' || v === 'private') return v;
  console.error(`MESH_ROLE must be 'public' or 'private', not ${JSON.stringify(v)}`);
  process.exit(1);
}

function parseNetwork(v: string): NetworkName {
  if (v === 'devnet' || v === 'testnet' || v === 'mainnet') return v;
  console.error(`MESH_NETWORK must be devnet, testnet or mainnet, not ${JSON.stringify(v)}`);
  process.exit(1);
}


// MESH_INTERFACE → The IP certificate — `MESH_WSS` is `<ip>:<port>` (an
// IPv6 host in brackets); it names the WSS listener's bind address and
// requires `MESH_ACME_DIRECTORY` for the ACME directory URL. The
// challenge port defaults to 80 (`http-01` on the node's IP). A hostname
// is refused — a mesh client never resolves a name on the browser's path
// (`MESH_INTERFACE → Discovery`).
function parseWss(
  v: string | undefined,
  stateDir: string,
): WssOptions | undefined {
  if (v === undefined || v === '') return undefined;
  let host: string;
  let portStr: string;
  if (v.startsWith('[')) {
    const idx = v.indexOf(']:');
    if (idx < 0) {
      console.error(`MESH_WSS bracketed host must end with ]:<port>, not ${JSON.stringify(v)}`);
      process.exit(1);
    }
    host = v.substring(1, idx);
    portStr = v.substring(idx + 2);
    if (!isIPv6(host)) {
      console.error(`MESH_WSS bracketed host must be an IPv6, not ${JSON.stringify(host)}`);
      process.exit(1);
    }
  } else {
    const idx = v.lastIndexOf(':');
    if (idx < 0) {
      console.error(`MESH_WSS must be <ip>:<port>, not ${JSON.stringify(v)}`);
      process.exit(1);
    }
    host = v.substring(0, idx);
    portStr = v.substring(idx + 1);
    if (!isIPv4(host)) {
      console.error(`MESH_WSS host must be an IPv4 (or [IPv6]), not ${JSON.stringify(host)}`);
      process.exit(1);
    }
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`MESH_WSS port must be 0..65535, not ${JSON.stringify(portStr)}`);
    process.exit(1);
  }
  const directoryUrl = process.env.MESH_ACME_DIRECTORY;
  if (directoryUrl === undefined || directoryUrl === '') {
    console.error('MESH_WSS requires MESH_ACME_DIRECTORY');
    process.exit(1);
  }
  const chPortStr = process.env.MESH_ACME_CHALLENGE_PORT;
  let challengePort: number | undefined;
  if (chPortStr !== undefined && chPortStr !== '') {
    const n = Number(chPortStr);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      console.error(
        `MESH_ACME_CHALLENGE_PORT must be 0..65535, not ${JSON.stringify(chPortStr)}`,
      );
      process.exit(1);
    }
    challengePort = n;
  }
  const source = acmeSource({
    directoryUrl,
    ip: host,
    stateDir,
    ...(challengePort !== undefined ? { challengePort } : {}),
  });
  return { ip: host, port, source };
}

// MESH_INTERFACE → NAT — "every STUN server is a mesh node named by
// IP". `MESH_STUN_SERVERS` reads a comma-separated list of
// `stun:<ip>:<port>` URLs; each is refused if it names a hostname
// (same rule as the client's `assertClientConfig`). Private-only;
// the WebRTC transport reads these as ICE servers.
const STUN_IPV4_RE = /^stun:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/;
const STUN_IPV6_RE = /^stun:\[([0-9a-fA-F:]+)\]:(\d{1,5})$/;
function parseStunServers(csv: string | undefined): string[] {
  if (csv === undefined || csv === '') return [];
  const out: string[] = [];
  for (const raw of csv.split(',')) {
    const s = raw.trim();
    if (s === '') continue;
    if (!STUN_IPV4_RE.test(s) && !STUN_IPV6_RE.test(s)) {
      console.error(`MESH_STUN_SERVERS entry refused: ${JSON.stringify(s)} is not stun:<IPv4>:<port> or stun:[<IPv6>]:<port>`);
      process.exit(1);
    }
    out.push(s);
  }
  return out;
}

const keyPath = need('MESH_KEY_PATH');
const network = parseNetwork(need('MESH_NETWORK'));
const role = parseRole(need('MESH_ROLE'));
const listen = list('MESH_LISTEN');
const announce = list('MESH_ANNOUNCE');
const bootstrap = list('MESH_BOOTSTRAP');
const stateDir = need('MESH_STATE_DIR');
const upstream = need('MESH_UPSTREAM');
// MESH_INTERFACE → NAT → "A node's role is its operator's setting" —
// a public node runs a STUN server at the IP of its first
// WebRTC-direct listen address on `STUN_PORT`, unless its operator
// names another or turns it off. A `MeshConfigError` here reads as a
// start-time refusal, same as `startMeshNode`'s own guards.
let stun: { host: string; port: number } | undefined;
try {
  stun = stunSettingFor(role, listen, process.env.MESH_STUN);
} catch (e) {
  if (e instanceof MeshConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
const stunServers = parseStunServers(process.env.MESH_STUN_SERVERS);
const wss = parseWss(process.env.MESH_WSS, stateDir);

const key = await loadOrCreateNodeKey(keyPath);
const node = await startMeshNode({
  key,
  network,
  role,
  listen,
  announce: announce.length > 0 ? announce : undefined,
  bootstrap,
  stateDir,
  upstream,
  ...(stun ? { stun } : {}),
  ...(stunServers.length > 0 ? { stunServers } : {}),
  ...(wss ? { wss } : {}),
});

// MESH_INTERFACE → Discovery — anchors read `(notisId, addrs)`; print one
// JSON line on stdout so the caller sees the identity and current
// reachable multiaddrs without parsing a log stream. A public node's
// listen addresses lose a race against libp2p's transport-manager
// `.listen` and the WebRTC-direct listener's cert load: when
// `startMeshNode` returns, `multiaddrs()` can still be empty. Poll
// for a non-empty answer under a deadline — not a sleep — so the
// identity line carries the dialable addresses the browser needs.
const IDENTITY_DEADLINE_MS = 30_000;
const IDENTITY_POLL_MS = 100;
const deadline = Date.now() + IDENTITY_DEADLINE_MS;
let addrs = node.multiaddrs();
while (addrs.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, IDENTITY_POLL_MS));
  addrs = node.multiaddrs();
}

function writeIdentity(current: string[]): void {
  process.stdout.write(
    JSON.stringify(
      buildIdentityLine({
        notisId: key.notisId,
        peerId: node.libp2p.peerId.toString(),
        role,
        multiaddrs: current,
        listenerAddrs: node.listenerAddrs(),
      }),
    ) + '\n',
  );
}

writeIdentity(addrs);

// MESH_INTERFACE → NAT — "A `private` node announces its relay
// reservations alone". Relay reservations land AFTER the first
// identity line — libp2p dials the relay through TCP, holds the
// reservation, and only then adds `/ip4/<relay>/.../p2p-circuit/p2p/<self>`
// to `getMultiaddrs()`. `self:peer:update` fires on every address change
// (new listen, new reservation, retract), so reprinting the identity
// line here keeps the reader's "latest line" always current — the stage
// reads the latest to build config.json and s2's variants.
let lastPrinted = addrs.slice().sort().join(',');
node.libp2p.addEventListener('self:peer:update', () => {
  const current = node.multiaddrs();
  const sortedKey = current.slice().sort().join(',');
  if (sortedKey === lastPrinted) return;
  lastPrinted = sortedKey;
  writeIdentity(current);
});

let stopped = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopped) return;
  stopped = true;
  try {
    await node.stop();
  } catch (e) {
    console.error(`stop failed on ${signal}: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}
process.on('SIGTERM', (sig) => { void shutdown(sig); });
process.on('SIGINT', (sig) => { void shutdown(sig); });
