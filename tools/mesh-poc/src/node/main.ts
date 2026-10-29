// MESH_INTERFACE → Place in the workspace / The node endpoint — the mesh
// node's entry point: read its configuration from the environment, load or
// create the key file, start the node, and print one JSON line on stdout
// with its identity and reachable addresses. Node-only.

import { loadOrCreateNodeKey } from './key-store.js';
import { startMeshNode } from './mesh-node.js';
import type { NetworkName } from '../protocols.js';

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

const keyPath = need('MESH_KEY_PATH');
const network = parseNetwork(need('MESH_NETWORK'));
const role = parseRole(need('MESH_ROLE'));
const listen = list('MESH_LISTEN');
const announce = list('MESH_ANNOUNCE');
const bootstrap = list('MESH_BOOTSTRAP');
const stateDir = need('MESH_STATE_DIR');
const upstream = need('MESH_UPSTREAM');

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
});

// MESH_INTERFACE → Discovery — anchors read `(notisId, addrs)`; print one
// JSON line on stdout so the caller sees the identity and current
// reachable multiaddrs without parsing a log stream.
process.stdout.write(
  JSON.stringify({
    notisId: key.notisId,
    peerId: node.libp2p.peerId.toString(),
    multiaddrs: node.multiaddrs(),
  }) + '\n',
);

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
