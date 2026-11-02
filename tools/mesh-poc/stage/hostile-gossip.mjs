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
 * weighs it" — the publisher's block, keyed by a counter so each
 * publish rides fresh bytes. Three bytes under
 * `MAX_ORDERING_BLOCK_BYTES`: `readOrderingBlockSections` throws on
 * every counter value (3 bytes cannot carry a header, a body-length
 * prefix and the 64-byte validator signature), so `BlockCheck.check`
 * reads it as `{ result: 'reject', lie: true, detail: 'malformed
 * ordering block header: ...' }`. Distinct bytes keep gossipsub's
 * `msgIdFn` from collapsing successive publishes into one message:
 * the seen-cache keys on the message id (`blake2b` of the raw bytes)
 * and `ignoreDuplicatePublishError` + `GOSSIP_SEEN_WINDOW_MS = 120 s`
 * (`src/gossip-rules.ts`) drop a duplicate at the publisher's own
 * router. A browser that joins the mesh after the first publish only
 * sees the publisher's blocks once each publish carries fresh bytes.
 */
export function badBlockBytes(n) {
  // Three-byte little-endian counter — distinct for every n in
  // [0, 2^24), still three bytes under MAX_ORDERING_BLOCK_BYTES so
  // the readOrderingBlockSections parse throws before PoW.
  const low = n & 0xff;
  const mid = (n >>> 8) & 0xff;
  const high = (n >>> 16) & 0xff;
  return new Uint8Array([low, mid, high]);
}

/**
 * The publisher's score line — `publish seq=N scores=[<peerId>:<score>,…]`,
 * one entry per subscriber of the topic with the router's score for it
 * (`getScore`), rounded to two decimals, in peer-id order.
 */
export function scoresLine(n, entries) {
  const parts = entries
    .slice()
    .sort((a, b) => (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0))
    .map((e) => `${e.peerId}:${e.score.toFixed(2)}`);
  return `publish seq=${n} scores=[${parts.join(',')}]`;
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
  let seq = 0;
  const timer = setInterval(() => {
    if (stopped) return;
    seq += 1;
    const data = badBlockBytes(seq);
    const n = seq;
    pubsub.publish(topic, data).then((result) => {
      // The publisher's reach, logged per publish — the counter and
      // `publish`'s recipients (gossipsub resolves the Promise to
      // `{ recipients: PeerId[] }` once the mesh has seen the message,
      // whether or not any peer subscribed). Every tenth publish also
      // logs the topic's subscribers as the local router holds them,
      // which answers "did the browser join the topic yet?" without
      // waiting on a honest mesh node's logs.
      const recipients = Array.isArray(result?.recipients)
        ? result.recipients.map((p) => p.toString()).sort()
        : [];
      process.stdout.write(`publish seq=${n} recipients=[${recipients.join(',')}]\n`);
      if (n % 10 === 0) {
        const getSubs = pubsub.getSubscribers;
        const subs = typeof getSubs === 'function'
          ? pubsub.getSubscribers(topic).map((p) => p.toString()).sort()
          : [];
        process.stdout.write(`publish seq=${n} subscribers=[${subs.join(',')}]\n`);
        const entries = subs.map((peerId) => ({ peerId, score: pubsub.getScore(peerId) }));
        process.stdout.write(`${scoresLine(n, entries)}\n`);
      }
    }, (err) => {
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
