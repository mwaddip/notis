// NET_INTERFACE → Readers — the cases.
//
// Each case runs on real `NetNode`s over loopback TCP. A reader is a plain
// libp2p host (TCP, Noise, yamux, gossipsub(gossipsubOptions(magic,
// [topics.orderingBlock]))) that dials the node and runs the handshake as
// the dialler with `READER_CAPABILITIES`, no declared address, empty
// nodeName. The handshake frame is built through `net`'s own
// `buildHandshakeFrame`, the same code the mesh service uses
// (NET_INTERFACE → Handshake Body).
import { describe, it, expect, afterEach } from 'vitest';
import type { Connection, Libp2p, Stream } from '@libp2p/interface';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@libp2p/gossipsub';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { PROTOCOL_VERSION } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyHeaderFieldDomains,
  verifyOrderingBlockStructure,
  verifyValidatorSignature,
  verifyUtxoTxRoot,
  verifyPostBody,
} from '@dagsocial/validation';
import { NetNode, duePeerExchange } from '../src/node.js';
import { buildHandshakeFrame, decodeHandshakeBody } from '../src/handshake.js';
import { HANDSHAKE_PROTOCOL, SYNC_PROTOCOL } from '../src/sync.js';
import { decodeFrame, MAGIC_TESTNET } from '../src/frame.js';
import { gossipTopics, gossipsubOptions } from '../src/gossip-rules.js';
import { MAX_HANDSHAKE_FRAME_BYTES } from '../src/msg-guards.js';
import { makeConfig as makeBaseConfig } from './helpers.js';
import type { NetConfig, NetValidators } from '../src/types.js';

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

const TIMEOUT = 25_000;

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig(overrides);
}

/** Build a libp2p host configured as a Notis reader. */
async function makeReaderLibp2p(magic: number): Promise<Libp2p> {
  const topics = gossipTopics(magic);
  return createLibp2p({
    addresses: { listen: [] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub(gossipsubOptions(magic, [topics.orderingBlock])),
    },
  });
}

/**
 * Dial `nodeAddr` from `host`, open a HANDSHAKE_PROTOCOL stream and run
 * the handshake as the dialler with the given `capabilities`. Returns the
 * answer bytes (null if no answer) and the live connection.
 */
async function runReaderHandshake(
  host: Libp2p,
  nodeAddr: string,
  magic: number,
  capabilities: number[] = [],
): Promise<{ answer: Uint8Array | null; conn: Connection }> {
  const target = multiaddr(nodeAddr);
  const conn = await host.dial(target);
  const stream = await conn.newStream(HANDSHAKE_PROTOCOL, {
    signal: AbortSignal.timeout(10_000),
  });
  const frame = buildHandshakeFrame(magic, {
    agentName: 'reader',
    protocolVersion: PROTOCOL_VERSION,
    nodeName: '',
    chainHeight: 0,
    capabilities,
  });
  const api = stream as unknown as {
    send: (b: Uint8Array) => boolean;
    onDrain: (o?: { signal?: AbortSignal }) => Promise<void>;
    close: (o?: { signal?: AbortSignal }) => Promise<void>;
    abort: (err: Error) => void;
  };
  const writeDeadline = AbortSignal.timeout(10_000);
  if (!api.send(frame)) await api.onDrain({ signal: writeDeadline });
  await api.close({ signal: writeDeadline });

  const readDeadline = AbortSignal.timeout(10_000);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    try { api.abort(new Error('read deadline')); } catch { /* already gone */ }
  };
  readDeadline.addEventListener('abort', onAbort, { once: true });
  try {
    const iterable = stream as unknown as AsyncIterable<
      Uint8Array | { subarray(): Uint8Array }
    >;
    for await (const value of iterable) {
      const bytes = value instanceof Uint8Array ? value : value.subarray();
      chunks.push(bytes);
      total += bytes.length;
      if (total > MAX_HANDSHAKE_FRAME_BYTES) break;
    }
  } catch { /* abort or reset — defined outcome */ }
  finally {
    readDeadline.removeEventListener('abort', onAbort);
  }

  let answer: Uint8Array | null = null;
  if (!readDeadline.aborted && total > 0 && total <= MAX_HANDSHAKE_FRAME_BYTES) {
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { data.set(c, off); off += c.length; }
    answer = data;
  }
  return { answer, conn };
}

/**
 * Register a sync-protocol handler on a libp2p host that counts streams
 * opened against it. Readers register it to prove the node opens no sync
 * stream on them (NET_INTERFACE → Readers → "A reader is never asked for
 * chain data").
 */
function registerSyncStreamCounter(host: Libp2p): { count: () => number } {
  let n = 0;
  host.handle(SYNC_PROTOCOL, async (stream: Stream) => {
    n++;
    try { await stream.close(); } catch { /* ignore */ }
  });
  return { count: () => n };
}

function nodeTcpAddress(node: NetNode): string {
  const addrs = node.libp2pNode?.getMultiaddrs() ?? [];
  const match = addrs.find((a) => a.toString().includes('/tcp/'));
  if (!match) throw new Error('node has no TCP listen address');
  return match.toString();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('NET_INTERFACE → Readers', () => {
  const nodes: NetNode[] = [];
  const hosts: Libp2p[] = [];

  afterEach(async () => {
    await Promise.allSettled(nodes.map((n) => n.stop()));
    nodes.length = 0;
    await Promise.allSettled(hosts.map((h) => h.stop()));
    hosts.length = 0;
  });

  // Case 1 — "A reader is a reader, not a peer."
  it('a reader is a reader, not a peer', async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const reader = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(reader);

    const addr = nodeTcpAddress(nodeA);
    const { answer } = await runReaderHandshake(reader, addr, MAGIC_TESTNET);
    // control: the node answered our handshake frame.
    expect(answer).not.toBeNull();
    await sleep(500);

    const readerId = reader.peerId.toString();
    // last: the reader stands as a reader, not as a chain-serving peer.
    expect(nodeA.getConnectedReaders()).toContain(readerId);
    expect(nodeA.getConnectedPeers()).not.toContain(readerId);
    const entry = nodeA.peers().find((p) => p.id === readerId);
    expect(entry?.capabilities ?? null).toEqual([]);
  }, TIMEOUT);

  // Case 2 — "A reader is never asked for chain data."
  it('a reader is never asked for chain data', async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const addrA = nodeTcpAddress(nodeA);
    const nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrA] }), validators);
    nodes.push(nodeB);
    await nodeB.start();

    const reader = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(reader);
    const readerStreams = registerSyncStreamCounter(reader);

    await runReaderHandshake(reader, addrA, MAGIC_TESTNET);
    await sleep(3_000);

    // control: nodeB is held as a chain-serving peer of nodeA.
    expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());

    // last: no sync stream has been opened against the reader.
    expect(readerStreams.count()).toBe(0);
  }, TIMEOUT);

  // Case 3 — "Readers past `maxReaders` are closed; a node still gets in."
  it('readers past maxReaders are closed; a node still gets in', async () => {
    const nodeA = new NetNode(makeConfig({ maxReaders: 2 }), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const addrA = nodeTcpAddress(nodeA);

    const r1 = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(r1);
    await runReaderHandshake(r1, addrA, MAGIC_TESTNET);

    const r2 = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(r2);
    await runReaderHandshake(r2, addrA, MAGIC_TESTNET);

    const r3 = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(r3);
    await runReaderHandshake(r3, addrA, MAGIC_TESTNET);

    const nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrA] }), validators);
    nodes.push(nodeB);
    await nodeB.start();
    await sleep(3_000);

    // control: nodeB is held as a chain-serving peer.
    expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());

    // last: two readers held; the third closed after its handshake.
    expect(nodeA.getConnectedReaders()).toHaveLength(2);
    expect(nodeA.getConnectedReaders()).not.toContain(r3.peerId.toString());
  }, TIMEOUT);

  // Case 4 — "A dialled peer declaring no chain service is closed and not
  // counted."
  it('a dialled peer declaring no chain service is closed, not counted', async () => {
    // The fake seed is a libp2p host that answers the handshake with its
    // own handshake carrying empty capabilities — a reader's answer.
    const seed = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        pubsub: gossipsub(gossipsubOptions(MAGIC_TESTNET, [gossipTopics(MAGIC_TESTNET).orderingBlock])),
      },
    });
    hosts.push(seed);
    await seed.handle(HANDSHAKE_PROTOCOL, async (stream: Stream) => {
      const api = stream as unknown as {
        send: (b: Uint8Array) => boolean;
        onDrain: (o?: { signal?: AbortSignal }) => Promise<void>;
        close: (o?: { signal?: AbortSignal }) => Promise<void>;
      };
      try {
        const iterable = stream as unknown as AsyncIterable<Uint8Array | { subarray(): Uint8Array }>;
        for await (const _v of iterable) { /* discard */ }
      } catch { /* ignore */ }
      const reply = buildHandshakeFrame(MAGIC_TESTNET, {
        agentName: 'fake-seed',
        protocolVersion: PROTOCOL_VERSION,
        nodeName: '',
        chainHeight: 0,
        capabilities: [],
      });
      if (!api.send(reply)) await api.onDrain({ signal: AbortSignal.timeout(10_000) });
      await api.close({ signal: AbortSignal.timeout(10_000) });
    });

    const seedAddr = seed.getMultiaddrs().map((a) => a.toString()).find((a) => a.includes('/tcp/'))!;
    expect(seedAddr).toBeTruthy();

    const nodeA = new NetNode(
      makeConfig({ bootstrapPeers: [seedAddr], minPeers: 1 }),
      validators,
    );
    nodes.push(nodeA);
    await nodeA.start();
    await sleep(3_000);

    const seedId = seed.peerId.toString();
    // last: the fake seed is in neither list, and nodeA holds no live
    // connection to it.
    expect(nodeA.getConnectedPeers()).not.toContain(seedId);
    expect(nodeA.getConnectedReaders()).not.toContain(seedId);
    const held = nodeA.libp2pNode!.getConnections().filter((c) => c.remotePeer.toString() === seedId);
    expect(held).toHaveLength(0);
  }, TIMEOUT);

  // Case 5 — "A miner's readiness never sees a reader."
  it("onPeerActive handlers never fire for a reader", async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const seen: string[] = [];
    nodeA.onPeerActive((peerId) => { seen.push(peerId); });

    const reader = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(reader);
    const addrA = nodeTcpAddress(nodeA);
    await runReaderHandshake(reader, addrA, MAGIC_TESTNET);
    await sleep(500);

    // control: no call for the reader.
    expect(seen).toEqual([]);

    // Now a chain-serving node connects; the handler fires once for it.
    const nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrA] }), validators);
    nodes.push(nodeB);
    await nodeB.start();
    await sleep(3_000);
    const bId = nodeB.peerId();

    // last: the handler fired for the chain-serving peer, no one else.
    expect(seen).toEqual([bId]);
  }, TIMEOUT);

  // Case 6 — "The node declares `NODE_CAPABILITIES`."
  it('the node declares NODE_CAPABILITIES', async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const reader = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(reader);
    const addrA = nodeTcpAddress(nodeA);
    const { answer } = await runReaderHandshake(reader, addrA, MAGIC_TESTNET);

    // control: the handshake answer decodes to a valid frame.
    expect(answer).not.toBeNull();
    const frame = decodeFrame(MAGIC_TESTNET, answer!);
    const body = decodeHandshakeBody(frame.body);
    expect(body).not.toBeNull();

    // last: the node's declared capabilities are the five chain codes —
    // SyncInfo (2), ModifierRequest (4), GetPeers (8), GetHeaders (14),
    // GetBlocks (16) (NET_INTERFACE → Readers → "A full node declares
    // `NODE_CAPABILITIES`").
    expect(body!.capabilities).toEqual([2, 4, 8, 14, 16]);
  }, TIMEOUT);

  // Case 8 — `duePeerExchange` holds the reader filter. The scheduler's
  // GetPeers cadence rides the outbound tick; its 30 s interval is too long
  // to wait, so the test drives `duePeerExchange` directly against the live
  // `peerMgr`, with nodeB and the reader both Active.
  it("duePeerExchange picks a chain-serving peer alone", async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const addrA = nodeTcpAddress(nodeA);
    const nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrA] }), validators);
    nodes.push(nodeB);
    await nodeB.start();

    const reader = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(reader);
    await runReaderHandshake(reader, addrA, MAGIC_TESTNET);
    await sleep(2_000);

    // control: both are held (the reader as a reader, nodeB as a peer).
    expect(nodeA.getConnectedReaders()).toContain(reader.peerId.toString());
    expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());

    // last: duePeerExchange picks the chain-serving peer alone.
    const peerMgr = (nodeA as unknown as { peerMgr: import('../src/peer-mgr.js').PeerManager }).peerMgr;
    const due = duePeerExchange(peerMgr, new Map(), Date.now());
    expect(due).toEqual([nodeB.peerId()]);
  }, TIMEOUT);

  // Case 9 — the outbound `maxPeers` close. nodeB (maxPeers 1) dials nodeA
  // first; its second dial (to nodeC) is driven manually so a tick's 30 s
  // isn't in the way.
  it('an outbound chain-serving peer past maxPeers is closed', async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const nodeC = new NetNode(makeConfig(), validators);
    nodes.push(nodeC);
    await nodeC.start();

    const addrA = nodeTcpAddress(nodeA);
    const addrC = nodeTcpAddress(nodeC);
    const nodeB = new NetNode(
      makeConfig({ maxPeers: 1, minPeers: 1, bootstrapPeers: [addrA] }),
      validators,
    );
    nodes.push(nodeB);
    await nodeB.start();
    await sleep(2_000);

    // control: nodeB holds nodeA as its one chain-serving peer.
    expect(nodeB.getConnectedPeers()).toContain(nodeA.peerId());

    // Drive a second outbound dial by hand.
    const internals = nodeB as unknown as {
      dialAndHandshake: (addr: string, source: 'seed' | 'candidate') => Promise<boolean>;
    };
    const ok = await internals.dialAndHandshake(addrC, 'candidate');

    // last: the outbound handshake with nodeC was closed past maxPeers.
    expect(ok).toBe(false);
    expect(nodeB.getConnectedPeers()).toHaveLength(1);
    expect(nodeB.getConnectedPeers()).not.toContain(nodeC.peerId());
  }, TIMEOUT);

  // Case 10 — `requestPostBodies` refuses a peer that does not declare
  // `MSG_MODIFIER_REQUEST`. A reader's capability list is empty, so the
  // caller's list being stale (naming a reader) is refused before any sync
  // stream opens. The guard is defensive: the normal caller picks from
  // `getConnectedPeers`, which excludes readers (NET_INTERFACE → Readers →
  // "A peer is asked for a code only if it declares it").
  it('requestPostBodies refuses a reader', async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const reader = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(reader);
    const readerStreams = registerSyncStreamCounter(reader);
    const addrA = nodeTcpAddress(nodeA);
    await runReaderHandshake(reader, addrA, MAGIC_TESTNET);
    await sleep(500);

    const readerId = reader.peerId.toString();
    // control: the reader is Active.
    expect(nodeA.getConnectedReaders()).toContain(readerId);

    // last: the request answers empty and opens no sync stream.
    const fakeHash = new Uint8Array(32);
    const got = await nodeA.requestPostBodies([{ id: 'aa'.repeat(32), contentHash: fakeHash }], readerId);
    expect(got).toEqual([]);
    expect(readerStreams.count()).toBe(0);
  }, TIMEOUT);

  // Case 7 — "A chain-serving peer past `maxPeers` is closed." Plain `it`:
  // today libp2p's connection manager admits at most `maxPeers` connections
  // (`connectionManager.maxConnections = maxPeers`), so the third dial is
  // refused at the transport before any handshake runs. The rule's new
  // mechanism (close after handshake) preserves the assertion.
  it('a chain-serving peer past maxPeers is closed after its handshake', async () => {
    const nodeA = new NetNode(makeConfig({ maxPeers: 1 }), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const addrA = nodeTcpAddress(nodeA);
    const nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrA], minPeers: 1 }), validators);
    nodes.push(nodeB);
    await nodeB.start();
    await sleep(2_000);

    // control: nodeB is held as a chain-serving peer.
    expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());

    const nodeC = new NetNode(makeConfig({ bootstrapPeers: [addrA], minPeers: 1 }), validators);
    nodes.push(nodeC);
    await nodeC.start();
    await sleep(3_000);

    // last: nodeA holds only one chain-serving peer; nodeC was closed.
    expect(nodeA.getConnectedPeers()).toHaveLength(1);
    expect(nodeA.getConnectedPeers()).not.toContain(nodeC.peerId());
  }, TIMEOUT);
});
