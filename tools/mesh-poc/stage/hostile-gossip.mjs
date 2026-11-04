#!/usr/bin/env node
// MESH_INTERFACE → Acceptance 6 → "A mesh node publishing a block that
// fails its checks is blacklisted with its evidence, and the client does
// not forward it." The stage's hostile gossip publisher: a libp2p host
// built from `@dagsocial/net`'s pieces (WebRTC-direct listen, Noise,
// yamux, gossipsub with net's `gossipsubOptions`, and a handshake
// responder over net's codec — `HANDSHAKE_PROTOCOL`, `decodeFrame`,
// `decodeHandshakeBody`, `buildHandshakeFrame`), publishing a malformed
// ordering block on `gossipTopics(magic).orderingBlock` every
// `PUBLISH_INTERVAL_MS`.
//
// The responder answers a dialling reader's handshake with
// `READER_CAPABILITIES` so `servesChain(capabilities)` reads false at
// the dialler: the client marks the connection `no-chain` and keeps it
// open (MESH_INTERFACE → Block gossip — "A client is a reader of every
// node it holds a connection to"; a handshake that declares no chain
// service leaves the node unread — it is not a node — but the libp2p
// connection stands, so gossip flows and the publisher's bad block
// reaches the browser.
//
// The bad-block builder `badBlockBytes` is a pure function: a tiny
// payload whose `readOrderingBlockSections` throws, so the client's
// `BlockCheck` reads it as `reject` with `lie: true`. One lie suffices
// to blacklist the publisher; the loop keeps publishing so the browser
// receives the message on its first subscription (the client's
// gossipsub joins the mesh after it dials the seed).

import { fileURLToPath } from 'node:url';
import { createLibp2p } from 'libp2p';
import { FaultTolerance } from '@libp2p/interface';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { webRTCDirect } from '@libp2p/webrtc';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';
import { gossipsub } from '@libp2p/gossipsub';
import { PROTOCOL_VERSION, profileFor } from '@dagsocial/types';
import {
  HANDSHAKE_PROTOCOL,
  buildHandshakeFrame,
  decodeFrame,
  decodeHandshakeBody,
  gossipTopics,
  loadNodeKey,
  READER_CAPABILITIES,
  MAX_HANDSHAKE_FRAME_BYTES,
} from '@dagsocial/net';
// From the browser entry: `gossipsubOptions`, and a KeyPair → NodeKey
// helper that computes peer id and notisId. Both are Node-safe (no DOM,
// no Web API); the node entry exports neither.
import { gossipsubOptions, nodeKeyFromKeyPair } from '@dagsocial/net/browser';

const PUBLISH_INTERVAL_MS = 2_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

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
 * (`net/src/gossip-rules.ts`) drop a duplicate at the publisher's
 * own router. A browser that joins the mesh after the first publish
 * only sees the publisher's blocks once each publish carries fresh bytes.
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

/**
 * NET_INTERFACE → Handshake Body — build the responder's handshake
 * reply frame: `READER_CAPABILITIES` (an empty array), `chainHeight` 0,
 * empty `declaredAddress`, the build's `PROTOCOL_VERSION`. The reader
 * side (`readerHandshake` in `net/mesh/reader-handshake.ts`) reads the
 * capabilities and marks the connection `no-chain`; the libp2p
 * connection stays open and gossip flows
 * (MESH_INTERFACE → Block gossip — "A client is a reader of every node
 * it holds a connection to"; a handshake that declares no chain
 * service leaves the node unread — it is not a node). Exported so a
 * unit case can decode the frame and assert its shape.
 */
export function buildResponderFrame(magic, { protocolVersion, agentName, nodeName } = {}) {
  return buildHandshakeFrame(magic, {
    agentName: agentName ?? 'dagsocial-hostile-publisher',
    protocolVersion: protocolVersion ?? PROTOCOL_VERSION,
    nodeName: nodeName ?? '',
    chainHeight: 0,
    capabilities: [...READER_CAPABILITIES],
  });
}

/**
 * Register the handshake responder on `libp2p.handle(HANDSHAKE_PROTOCOL)`.
 * Reads the dialler's frame under one deadline, writes the responder's
 * reply frame under the same deadline, then closes the stream. A frame
 * that does not decode is ignored — the stream closes and the connection
 * stays open (the dialler's `readerHandshake` returns ok:false with its
 * own reason, and `mesh-client` moves the node to `retry`).
 */
export async function registerHandshakeResponder(libp2p, magic, opts = {}) {
  await libp2p.handle(HANDSHAKE_PROTOCOL, async (stream) => {
    try {
      // Read the dialler's frame under the deadline.
      const readDeadline = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS);
      const chunks = [];
      let total = 0;
      const api = stream;
      const onAbort = () => {
        try { api.abort(new Error('handshake read deadline')); } catch { /* already gone */ }
      };
      readDeadline.addEventListener('abort', onAbort, { once: true });
      try {
        const iterable = stream;
        for await (const value of iterable) {
          const bytes = value instanceof Uint8Array ? value : value.subarray();
          chunks.push(bytes);
          total += bytes.length;
          if (total > MAX_HANDSHAKE_FRAME_BYTES) break;
        }
      } catch { /* a reset or abort is a defined outcome — fall through */ }
      finally {
        readDeadline.removeEventListener('abort', onAbort);
      }
      if (total === 0 || total > MAX_HANDSHAKE_FRAME_BYTES) {
        try { await stream.close(); } catch { /* already gone */ }
        return;
      }
      const data = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { data.set(c, off); off += c.length; }
      try {
        const framed = decodeFrame(magic, data);
        const body = decodeHandshakeBody(framed.body);
        if (body === null) {
          try { await stream.close(); } catch { /* already gone */ }
          return;
        }
      } catch {
        try { await stream.close(); } catch { /* already gone */ }
        return;
      }
      // Write the responder's reply.
      const frame = buildResponderFrame(magic, opts);
      const writeDeadline = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS);
      if (!api.send(frame)) await api.onDrain({ signal: writeDeadline });
      await api.close({ signal: writeDeadline });
    } catch (err) {
      process.stderr.write(`hostile-gossip: handshake responder: ${err?.message ?? err}\n`);
      try { await stream.close(); } catch { /* already gone */ }
    }
  });
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
  // Handlers stand before the first line a caller can act on: a
  // process that prints its identity line before it registers SIGTERM
  // dies by the default action. `stopped` and the signal handlers are
  // installed before any libp2p state exists.
  let node = null;
  let stopped = false;
  let timer = null;
  async function shutdown(signal) {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    if (node !== null) {
      try { await node.stop(); } catch (e) {
        process.stderr.write(`stop failed on ${signal}: ${e?.message ?? e}\n`);
        process.exit(1);
      }
    }
    process.exit(0);
  }
  process.on('SIGTERM', (sig) => { void shutdown(sig); });
  process.on('SIGINT', (sig) => { void shutdown(sig); });

  const keyPath = need('MESH_KEY_PATH');
  const network = parseNetwork(need('MESH_NETWORK'));
  const role = parseRole(need('MESH_ROLE'));
  const listen = list('MESH_LISTEN');
  const bootstrapAddrs = list('MESH_BOOTSTRAP');

  const kp = await loadNodeKey(keyPath);
  const key = nodeKeyFromKeyPair(kp);
  const profile = profileFor(network);
  const topics = gossipTopics(profile.magic);

  // Build the libp2p host from `@dagsocial/net`'s pieces: WebRTC-direct
  // + TCP transports, Noise, yamux, identify, and gossipsub with net's
  // `gossipsubOptions(magic, [orderingBlock topic])`.
  const services = {
    identify: identify(),
    pubsub: gossipsub(gossipsubOptions(profile.magic, [topics.orderingBlock])),
  };
  if (bootstrapAddrs.length > 0) {
    services.bootstrap = bootstrap({ list: [...bootstrapAddrs] });
  }
  node = await createLibp2p({
    privateKey: key.privateKey,
    addresses: {
      // A public role announces its listen addresses at once
      // (MESH_INTERFACE → NAT; `net.node.ts → effectiveAnnounce`). A
      // private role has none to announce.
      listen: [...listen],
      announce: role === 'public' ? [...listen] : undefined,
    },
    transports: [tcp(), webRTCDirect()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services,
    transportManager: {
      faultTolerance: FaultTolerance.NO_FATAL,
    },
  });
  await registerHandshakeResponder(node, profile.magic, {
    protocolVersion: PROTOCOL_VERSION,
    agentName: 'dagsocial-hostile-publisher',
    nodeName: '',
  });
  await node.start();

  // MESH_INTERFACE → Discovery — one JSON identity line on stdout so
  // the stage can read the printed multiaddrs the same way it reads
  // the ordinary mesh node's. Shape:
  // `{ notisId, peerId, role, multiaddrs, listenerAddrs }`.
  const multiaddrsOf = () => node.getMultiaddrs().map((m) => m.toString());
  const listenerAddrsOf = () => multiaddrsOf();
  const printIdentity = () => {
    process.stdout.write(JSON.stringify({
      notisId: key.notisId,
      peerId: node.peerId.toString(),
      role,
      multiaddrs: multiaddrsOf(),
      listenerAddrs: listenerAddrsOf(),
    }) + '\n');
  };

  // Poll for a non-empty multiaddrs list under a deadline (same
  // pattern as a node's identity line), so the stage sees dialable
  // addresses.
  const IDENTITY_DEADLINE_MS = 30_000;
  const IDENTITY_POLL_MS = 100;
  const deadline = Date.now() + IDENTITY_DEADLINE_MS;
  while (multiaddrsOf().length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, IDENTITY_POLL_MS));
  }
  printIdentity();

  let lastPrinted = multiaddrsOf().slice().sort().join(',');
  node.addEventListener('self:peer:update', () => {
    const current = multiaddrsOf();
    const sortedKey = current.slice().sort().join(',');
    if (sortedKey === lastPrinted) return;
    lastPrinted = sortedKey;
    printIdentity();
  });

  const topic = topics.orderingBlock;
  const pubsub = node.services.pubsub;

  let seq = 0;
  timer = setInterval(() => {
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`hostile-gossip: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
