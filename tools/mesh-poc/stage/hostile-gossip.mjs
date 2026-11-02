#!/usr/bin/env node
// MESH_INTERFACE → Acceptance 6 → "A mesh node publishing a block that
// fails its checks is blacklisted with its evidence, and the client does
// not forward it." The stage's hostile gossip publisher: a stand-alone
// script that starts a mesh node through the member's Node-side library
// entry (`@dagsocial/mesh-poc/dist/node/index.js`) and publishes a
// malformed ordering block on `blockTopic(magic)` every
// `PUBLISH_INTERVAL_MS`. No hostile mode lives in the member's
// production code — the publisher stays in the stage.
//
// The bad-block builder `badBlockBytes` is a pure function: a tiny
// payload whose `readOrderingBlockSections` throws, so the client's
// `BlockCheck` reads it as `reject` with `lie: true`. One lie suffices
// to blacklist the publisher; the loop keeps publishing so the browser
// receives the message on its first subscription (the client's
// gossipsub joins the mesh after it dials the seed).

import { fileURLToPath } from 'node:url';
import { profileFor } from '@dagsocial/types';
// eslint-disable-next-line import/no-unresolved
import { startMeshNode, blockTopic, loadOrCreateNodeKey } from '../dist/node/index.js';

const PUBLISH_INTERVAL_MS = 2_000;

/**
 * MESH_INTERFACE → Block gossip → "A refused block is evidence as `net`
 * weighs it" — the publisher's block. Three zero bytes under
 * `MAX_ORDERING_BLOCK_BYTES` whose `readOrderingBlockSections` throws:
 * `BlockCheck.check` catches the throw and returns
 * `{ result: 'reject', lie: true, detail: 'malformed ordering block
 * header: ...' }`. Zero PoW is beside the point — the parse never
 * reaches the PoW check.
 */
export function badBlockBytes() {
  return new Uint8Array([0, 0, 0]);
}

function parseNetwork(v) {
  if (v === 'devnet' || v === 'testnet' || v === 'mainnet') return v;
  console.error(`MESH_NETWORK must be devnet, testnet or mainnet, not ${JSON.stringify(v)}`);
  process.exit(1);
}

function parseRole(v) {
  if (v === 'public' || v === 'private') return v;
  console.error(`MESH_ROLE must be 'public' or 'private', not ${JSON.stringify(v)}`);
  process.exit(1);
}

function need(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    console.error(`missing env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function list(name) {
  const v = process.env[name];
  if (v === undefined || v === '') return [];
  return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

async function main() {
  const keyPath = need('MESH_KEY_PATH');
  const network = parseNetwork(need('MESH_NETWORK'));
  const role = parseRole(need('MESH_ROLE'));
  const listen = list('MESH_LISTEN');
  const bootstrap = list('MESH_BOOTSTRAP');
  const stateDir = need('MESH_STATE_DIR');
  const upstream = need('MESH_UPSTREAM');

  const key = await loadOrCreateNodeKey(keyPath);
  const node = await startMeshNode({
    key,
    network,
    role,
    listen,
    bootstrap,
    stateDir,
    upstream,
  });

  // MESH_INTERFACE → Discovery — one JSON identity line on stdout so
  // the stage can read the printed multiaddrs the same way it reads
  // the ordinary mesh node's. Shape:
  // `{ notisId, peerId, role, multiaddrs, listenerAddrs }`.
  const printIdentity = () => {
    process.stdout.write(JSON.stringify({
      notisId: key.notisId,
      peerId: node.libp2p.peerId.toString(),
      role,
      multiaddrs: node.multiaddrs(),
      listenerAddrs: node.listenerAddrs(),
    }) + '\n');
  };

  // Poll for a non-empty multiaddrs list under a deadline (same
  // pattern as `main.ts`'s identity line), so the stage sees dialable
  // addresses.
  const IDENTITY_DEADLINE_MS = 30_000;
  const IDENTITY_POLL_MS = 100;
  const deadline = Date.now() + IDENTITY_DEADLINE_MS;
  while (node.multiaddrs().length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, IDENTITY_POLL_MS));
  }
  printIdentity();

  let lastPrinted = node.multiaddrs().slice().sort().join(',');
  node.libp2p.addEventListener('self:peer:update', () => {
    const current = node.multiaddrs();
    const sortedKey = current.slice().sort().join(',');
    if (sortedKey === lastPrinted) return;
    lastPrinted = sortedKey;
    printIdentity();
  });

  const profile = profileFor(network);
  const topic = blockTopic(profile.magic);
  const pubsub = node.libp2p.services.pubsub;

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const data = badBlockBytes();
    pubsub.publish(topic, data).catch((err) => {
      // A publish with no peers subscribed resolves (gossipsub's
      // `allowPublishToZeroTopicPeers: true` + `ignoreDuplicatePublishError`
      // in `gossipsubOptions`). Anything else is logged, loop stays
      // running.
      process.stderr.write(`hostile-gossip: publish failed: ${err?.message ?? err}\n`);
    });
  }, PUBLISH_INTERVAL_MS);

  async function shutdown(signal) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      await node.stop();
    } catch (e) {
      console.error(`stop failed on ${signal}: ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  process.on('SIGTERM', (sig) => { void shutdown(sig); });
  process.on('SIGINT', (sig) => { void shutdown(sig); });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`hostile-gossip: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
