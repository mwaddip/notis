// NET_INTERFACE → Readers — the cases.
//
// Each case runs on real `NetNode`s over loopback TCP. A reader is a plain
// libp2p host (TCP, Noise, yamux, gossipsub(gossipsubOptions(magic,
// [topics.orderingBlock]))) that dials the node and runs the handshake as
// the dialler with `READER_CAPABILITIES`, no declared address, empty
// nodeName. The handshake frame is built through `net`'s own
// `buildHandshakeFrame`, net's one path for the handshake body
// (NET_INTERFACE → Handshake Body).
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Connection, Libp2p, Stream } from '@libp2p/interface';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@libp2p/gossipsub';
import type { GossipSub } from '@libp2p/gossipsub';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { PROTOCOL_VERSION, computeContentHash } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
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
import { SERVING_READER_CAPABILITIES } from '../src/capabilities.js';
import { postTextsHandler } from '../src/mesh/serve-post-texts.js';
import type { PostTextProvider } from '../src/mesh/serve-post-texts.js';
import { makeConfig as makeBaseConfig } from './helpers.js';
import { makeBlockAt } from './helpers/devnet-block.js';
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

// libp2p 3.5.1's connection manager refuses an inbound connection from a host
// that has opened `inboundConnectionThreshold` connections (default 5) in the
// last second — the refused socket is closed and the dialler reads ECONNRESET.
// The twelfth-reader case dials nodeA at 127.0.0.1 twelve times in all (eleven
// come-and-go readers, then the twelfth), so it paces them at least this many
// milliseconds apart — four a second at most in any window.
const READER_DIAL_GAP_MS = 250;

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

// `getMeshPeers` and `direct` live on gossipsub's concrete class; the
// `GossipSub` interface `@libp2p/gossipsub` re-exports does not publish
// either. The cases below read both through this intersection type.
interface GossipSubInternal extends GossipSub {
  getMeshPeers(topic: string): string[];
  readonly direct: Set<string>;
}

function pubsubOf(node: NetNode): GossipSubInternal {
  const lp = node.libp2pNode;
  if (!lp) throw new Error('node is not started');
  return (lp as unknown as { services: { pubsub: GossipSubInternal } })
    .services.pubsub;
}

function readerPubsub(host: Libp2p): GossipSubInternal {
  return (host as unknown as { services: { pubsub: GossipSubInternal } })
    .services.pubsub;
}

/**
 * Dial `nodeA` with `n` fresh readers, pacing dials under
 * `READER_DIAL_GAP_MS`, running the handshake on each, and subscribing
 * each to the ordering-block topic. Each reader's router dispatches
 * `gossipsub:graft` on the ordering-block topic naming A either outbound
 * (its own `sendRpc` carries a GRAFT to A — the typical path, taken when
 * A was in the reader's `topics` map at `subscribe` or at a later
 * heartbeat) or inbound (A grafted with the reader first, so the
 * reader's `handleGraft` adds A to its mesh and no outbound GRAFT
 * follows — gossipsub's heartbeat does not graft a peer already in the
 * mesh). The listener records either direction, attached before
 * `subscribe` so no event slips past, and `awaitAllGraftedWithA` resolves
 * once every reader has seen one.
 */
async function dialNReaders(
  n: number,
  nodeA: NetNode,
  hosts: Libp2p[],
): Promise<{ readers: Libp2p[]; awaitAllGraftedWithA: () => Promise<void> }> {
  const addrA = nodeTcpAddress(nodeA);
  const nodeAId = nodeA.peerId();
  const topic = gossipTopics(MAGIC_TESTNET).orderingBlock;
  const readers: Libp2p[] = [];
  const graftedWithA = new Map<string, boolean>();

  let lastDialAt = 0;
  for (let i = 0; i < n; i++) {
    await sleep(Math.max(0, READER_DIAL_GAP_MS - (Date.now() - lastDialAt)));
    const r = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(r);
    readers.push(r);
    const readerId = r.peerId.toString();
    graftedWithA.set(readerId, false);
    readerPubsub(r).addEventListener('gossipsub:graft', (evt) => {
      const d = evt.detail as {
        peerId: { toString(): string };
        topic: string;
        direction: string;
      };
      if (d.topic === topic && d.peerId.toString() === nodeAId) {
        graftedWithA.set(readerId, true);
      }
    });
    lastDialAt = Date.now();
    await runReaderHandshake(r, addrA, MAGIC_TESTNET);
    readerPubsub(r).subscribe(topic);
  }

  const awaitAllGraftedWithA = async (): Promise<void> => {
    await vi.waitFor(
      () => {
        const missing: string[] = [];
        for (const [id, ok] of graftedWithA) if (!ok) missing.push(id);
        expect(
          missing,
          `readers whose router has no GRAFT with A on the ordering-block topic: ${missing.join(', ')}`,
        ).toEqual([]);
      },
      { timeout: 30_000, interval: 250 },
    );
  };

  return { readers, awaitAllGraftedWithA };
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
    // GetBlocks (16) (NET_INTERFACE → Readers → "A peer's capabilities say
    // what it serves").
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
  it('requestPostBodies refuses a reader that does not declare ModifierRequest', async () => {
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

  // MESH_INTERFACE → Block gossip → "A router scores its peers by gossipsub's
  // defaults, and a shared address costs a peer nothing". Eleven readers dial
  // nodeA from 127.0.0.1, are seen by nodeA's gossipsub router, and leave; a
  // twelfth dials and subscribes to the ordering-block topic; a block that
  // enters at nodeB and that nodeA forwards reaches the twelfth reader.
  //
  // Each reader is a fresh libp2p key — the way page reloads come and go.
  // Readers are run one at a time: Dhi is 12 (`@libp2p/gossipsub`'s own
  // default), and a dozen readers connected at once would test the mesh's
  // size, not the score.
  //
  // nodeB joins before the readers come, so its subscription to the
  // ordering-block topic reaches nodeA — and nodeA's reaches nodeB — while
  // both sides' scores are 0. nodeA is nodeB's only peer at 127.0.0.1, so
  // nodeA's score at nodeB is 0 whatever nodeA's own score of nodeB is;
  // `broadcastOrderingBlock` publishes under gossipsub's default
  // `floodPublish: true` and sends the block to every topic peer above the
  // publish threshold (−50), nodeA among them.
  //
  // nodeB also dials nodeA at 127.0.0.1, so it is counted at nodeA's score
  // too. At gossipsub's default `IPColocationFactorWeight` of −5, with eleven
  // retained readers, the twelfth reader active and nodeB active, the count
  // at 127.0.0.1 is 13 and the surplus over the threshold of 10 is 3:
  // nodeB's score at nodeA is −5 × 3² = −45, above the graylist threshold
  // (−80), so `acceptFrom` admits nodeB's RPCs and nodeA runs the
  // ordering-block topic validator on the published block. The twelfth
  // reader's score at nodeA is −45 too — outside nodeA's mesh (nodeA refuses
  // a graft at negative score) and below the gossip threshold (−10, so no
  // IHAVE reaches it), and the case fails at its last assertion and nowhere
  // before.
  it(
    'a node forwards a block to the twelfth reader seen from one address',
    async () => {
      const nodeA = new NetNode(makeConfig(), validators);
      nodes.push(nodeA);
      await nodeA.start();

      const addrA = nodeTcpAddress(nodeA);

      const nodeAPubsub = (nodeA.libp2pNode as unknown as {
        services: {
          pubsub: GossipSub & {
            getPeers(): Array<{ toString(): string }>;
            getSubscribers(topic: string): Array<{ toString(): string }>;
          };
        };
      }).services.pubsub;
      const topicsPair = gossipTopics(MAGIC_TESTNET);

      const nodeADeliveries: OrderingBlock[] = [];
      nodeA.onOrderingBlock((b) => {
        nodeADeliveries.push(b);
      });

      // nodeB joins first, while scores are 0. Its subscription reaches
      // nodeA — and nodeA's reaches nodeB — before readers come.
      const nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrA] }), validators);
      nodes.push(nodeB);
      await nodeB.start();
      const nodeBPubsub = (nodeB.libp2pNode as unknown as {
        services: {
          pubsub: GossipSub & {
            getSubscribers(topic: string): Array<{ toString(): string }>;
          };
        };
      }).services.pubsub;

      // control: nodeB is held as a chain-serving peer, and the two have
      // heard each other's ordering-block subscription.
      await vi.waitFor(
        () => {
          expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
          expect(
            nodeAPubsub.getSubscribers(topicsPair.orderingBlock).map((p) => p.toString()),
          ).toContain(nodeB.peerId());
          expect(
            nodeBPubsub.getSubscribers(topicsPair.orderingBlock).map((p) => p.toString()),
          ).toContain(nodeA.peerId());
        },
        { timeout: 15_000, interval: 200 },
      );

      // Eleven readers dial nodeA at 127.0.0.1, are seen by its gossipsub
      // router, and leave. A fresh libp2p key each time; each departure
      // keeps the IP counted (retainScore), the way page reloads do.
      // The dials are paced at least `READER_DIAL_GAP_MS` apart so no
      // window holds more than four, under libp2p's `inboundConnectionThreshold`.
      let lastDialAt = 0;
      for (let i = 0; i < 11; i++) {
        await sleep(Math.max(0, READER_DIAL_GAP_MS - (Date.now() - lastDialAt)));
        const reader = await makeReaderLibp2p(MAGIC_TESTNET);
        const readerId = reader.peerId.toString();
        lastDialAt = Date.now();
        await runReaderHandshake(reader, addrA, MAGIC_TESTNET);
        await vi.waitFor(
          () => {
            expect(nodeAPubsub.getPeers().map((p) => p.toString())).toContain(readerId);
          },
          { timeout: 10_000, interval: 50 },
        );
        await reader.stop();
        // Wait on the departure the next iteration's dial races —
        // `removePeer` has run, so `peerIPs[127.0.0.1]` holds the pstats
        // as a retained slot rather than a live peer.
        await vi.waitFor(
          () => {
            expect(nodeAPubsub.getPeers().map((p) => p.toString())).not.toContain(readerId);
          },
          { timeout: 10_000, interval: 50 },
        );
      }

      // The twelfth reader stays through the publish; it subscribes to the
      // ordering-block topic and records every message its router delivers
      // on that topic. Paced under `inboundConnectionThreshold` like the
      // eleven before it.
      await sleep(Math.max(0, READER_DIAL_GAP_MS - (Date.now() - lastDialAt)));
      const twelfth = await makeReaderLibp2p(MAGIC_TESTNET);
      hosts.push(twelfth);
      await runReaderHandshake(twelfth, addrA, MAGIC_TESTNET);
      const twelfthPubsub = (twelfth as unknown as {
        services: { pubsub: GossipSub };
      }).services.pubsub;
      const twelfthDeliveries: Uint8Array[] = [];
      twelfthPubsub.addEventListener('gossipsub:message', (evt) => {
        const detail = evt.detail as { msg?: { topic: string; data: Uint8Array } } | undefined;
        if (detail?.msg?.topic === topicsPair.orderingBlock) {
          twelfthDeliveries.push(detail.msg.data);
        }
      });
      twelfthPubsub.subscribe(topicsPair.orderingBlock);

      // control: nodeA has heard the twelfth reader's subscription (so the
      // forward's destination is a topic peer).
      await vi.waitFor(
        () => {
          expect(
            nodeAPubsub.getSubscribers(topicsPair.orderingBlock).map((p) => p.toString()),
          ).toContain(twelfth.peerId.toString());
        },
        { timeout: 10_000, interval: 100 },
      );

      // A validator-signed block that passes NET_INTERFACE → Stage 1.
      const block = makeBlockAt(1, PROTOCOL_VERSION);
      await nodeB.broadcastOrderingBlock(block);

      // control: nodeA receives it — its own handler fires.
      await vi.waitFor(
        () => {
          expect(nodeADeliveries.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 15_000, interval: 100 },
      );

      // last: the forwarded block reaches the twelfth reader.
      await vi.waitFor(
        () => {
          expect(twelfthDeliveries.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 20_000, interval: 200 },
      );
    },
    120_000,
  );

  // NET_INTERFACE → Readers → "A serving reader answers from what it holds":
  // the reader host registers `postTextsHandler` on `SYNC_PROTOCOL` and
  // answers the ids it holds.
  function makeServingReader(
    held: ReadonlyMap<string, string>,
  ): Promise<Libp2p> {
    return makeReaderLibp2p(MAGIC_TESTNET).then(async (host) => {
      const provider: PostTextProvider = async (ids) => {
        const out = new Map<string, string>();
        for (const id of ids) {
          const t = held.get(id);
          if (t !== undefined) out.set(id, t);
        }
        return out;
      };
      await host.handle(SYNC_PROTOCOL, postTextsHandler({
        magic: MAGIC_TESTNET,
        texts: provider,
        timeoutMs: 10_000,
        accept: () => true,
      }));
      return host;
    });
  }

  it("a reader that declares ModifierRequest is asked for posts' text", async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const postId = 'aa'.repeat(32);
    const text = 'hello notis';
    const reader = await makeServingReader(new Map([[postId, text]]));
    hosts.push(reader);

    const addrA = nodeTcpAddress(nodeA);
    await runReaderHandshake(reader, addrA, MAGIC_TESTNET, [...SERVING_READER_CAPABILITIES]);
    await sleep(500);

    const readerId = reader.peerId.toString();
    // control: the reader is held as a reader.
    expect(nodeA.getConnectedReaders()).toContain(readerId);

    // last: requestPostBodies answers the held text for the commitment.
    const got = await nodeA.requestPostBodies(
      [{ id: postId, contentHash: computeContentHash(text) }],
      readerId,
    );
    expect(got).toEqual([{ id: postId, content: text }]);
  }, TIMEOUT);

  it('a serving reader is asked for no chain data', async () => {
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

    await runReaderHandshake(reader, addrA, MAGIC_TESTNET, [...SERVING_READER_CAPABILITIES]);
    await sleep(3_000);

    // control: nodeB is held as a chain-serving peer; the reader stands
    // in the reader list.
    expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
    expect(nodeA.getConnectedReaders()).toContain(reader.peerId.toString());

    // control: the scheduler's peer exchange picks the chain-serving
    // peer, never the serving reader.
    const peerMgr = (nodeA as unknown as { peerMgr: import('../src/peer-mgr.js').PeerManager }).peerMgr;
    const due = duePeerExchange(peerMgr, new Map(), Date.now());
    expect(due).toEqual([nodeB.peerId()]);

    // last: no sync stream has been opened against the serving reader.
    expect(readerStreams.count()).toBe(0);
  }, TIMEOUT);

  it('getServingReaders lists a serving reader alone', async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const addrA = nodeTcpAddress(nodeA);
    const nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrA] }), validators);
    nodes.push(nodeB);
    await nodeB.start();

    const bareReader = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(bareReader);
    await runReaderHandshake(bareReader, addrA, MAGIC_TESTNET);

    const servingReader = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(servingReader);
    await runReaderHandshake(servingReader, addrA, MAGIC_TESTNET, [...SERVING_READER_CAPABILITIES]);
    await sleep(2_000);

    const bareId = bareReader.peerId.toString();
    const servingId = servingReader.peerId.toString();

    // control: both readers are held; the node peer stands apart.
    expect(nodeA.getConnectedReaders().sort()).toEqual([bareId, servingId].sort());
    expect(nodeA.getConnectedPeers()).toEqual([nodeB.peerId()]);

    // last: getServingReaders names the serving reader alone.
    expect(nodeA.getServingReaders()).toEqual([servingId]);
  }, TIMEOUT);

  it('onReaderActive fires for a reader and onPeerActive does not', async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const readerSeen: string[] = [];
    const peerSeen: string[] = [];
    nodeA.onReaderActive((peerId) => { readerSeen.push(peerId); });
    nodeA.onPeerActive((peerId) => { peerSeen.push(peerId); });

    const reader = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(reader);
    const addrA = nodeTcpAddress(nodeA);
    await runReaderHandshake(reader, addrA, MAGIC_TESTNET);
    await sleep(500);
    const readerId = reader.peerId.toString();

    const nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrA] }), validators);
    nodes.push(nodeB);
    await nodeB.start();
    await sleep(3_000);
    const bId = nodeB.peerId();

    // control: both handshakes settled — the reader held as a reader,
    // nodeB held as a chain-serving peer.
    expect(nodeA.getConnectedReaders()).toContain(readerId);
    expect(nodeA.getConnectedPeers()).toContain(bId);

    // last: the reader hook fired once for the reader and the peer hook
    // once for the chain-serving peer.
    expect({ reader: readerSeen, peer: peerSeen }).toEqual({
      reader: [readerId],
      peer: [bId],
    });
  }, TIMEOUT);

  it('onReaderActive does not fire for a reader past maxReaders', async () => {
    const nodeA = new NetNode(makeConfig({ maxReaders: 1 }), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const seen: string[] = [];
    nodeA.onReaderActive((peerId) => { seen.push(peerId); });

    const addrA = nodeTcpAddress(nodeA);

    const r1 = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(r1);
    await runReaderHandshake(r1, addrA, MAGIC_TESTNET);
    await sleep(500);

    const r2 = await makeReaderLibp2p(MAGIC_TESTNET);
    hosts.push(r2);
    await runReaderHandshake(r2, addrA, MAGIC_TESTNET);
    await sleep(500);

    // control: nodeA holds one reader, the second one closed.
    expect(nodeA.getConnectedReaders()).toHaveLength(1);
    expect(nodeA.getConnectedReaders()).toContain(r1.peerId.toString());

    // last: the hook fired once, naming the first reader.
    expect(seen).toEqual([r1.peerId.toString()]);
  }, TIMEOUT);

  it("a serving reader's text that does not verify is a misbehaviour penalty", async () => {
    const nodeA = new NetNode(makeConfig(), validators);
    nodes.push(nodeA);
    await nodeA.start();

    const postId = 'bb'.repeat(32);
    const held = 'the body held';
    const wanted = 'the body wanted';
    const reader = await makeServingReader(new Map([[postId, held]]));
    hosts.push(reader);

    const addrA = nodeTcpAddress(nodeA);
    await runReaderHandshake(reader, addrA, MAGIC_TESTNET, [...SERVING_READER_CAPABILITIES]);
    await sleep(500);

    const readerId = reader.peerId.toString();
    // control: the reader is held in the reader list.
    expect(nodeA.getConnectedReaders()).toContain(readerId);

    const penalties: Array<{ peerId: string; kind: string }> = [];
    nodeA.onPeerPenalised((peerId, kind) => {
      penalties.push({ peerId, kind });
    });

    // The reader answers with `held`; the commitment nodeA holds is for
    // `wanted`, so verifyPostBody rejects.
    const got = await nodeA.requestPostBodies(
      [{ id: postId, contentHash: computeContentHash(wanted) }],
      readerId,
    );

    // control: no body comes back.
    expect(got).toEqual([]);
    // last: the hook saw a Misbehavior for the reader's id.
    expect(penalties).toContainEqual({ peerId: readerId, kind: 'misbehavior' });
  }, TIMEOUT);

  // MESH_INTERFACE → Block gossip → "A node's readers are its router's
  // direct peers". Thirteen readers dial A and complete their handshakes
  // before B dials; C is peered with B alone. A topic's mesh holds
  // chain-serving peers alone, so its degree bounds a node's node peers,
  // not its readers, and a node that dials another after that one's
  // readers arrive is grafted as gossipsub's rules grant.
  it(
    "a node that dials another after that one's readers arrive is in its mesh",
    async () => {
      const nodeA = new NetNode(makeConfig(), validators);
      nodes.push(nodeA);
      await nodeA.start();
      const addrA = nodeTcpAddress(nodeA);

      const { readers, awaitAllGraftedWithA } = await dialNReaders(13, nodeA, hosts);
      await vi.waitFor(
        () => {
          expect(nodeA.getConnectedReaders()).toHaveLength(13);
        },
        { timeout: 20_000, interval: 200 },
      );

      // Wait on every reader's own router having sent a GRAFT to A on
      // the ordering-block topic — the arrangement B dials into.
      await awaitAllGraftedWithA();

      const nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrA] }), validators);
      nodes.push(nodeB);
      await nodeB.start();
      const addrB = nodeTcpAddress(nodeB);

      const nodeC = new NetNode(makeConfig({ bootstrapPeers: [addrB] }), validators);
      nodes.push(nodeC);
      await nodeC.start();

      // controls: every reader's handshake completed; B and A connected.
      expect(nodeA.getConnectedReaders()).toHaveLength(readers.length);
      await vi.waitFor(
        () => {
          expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
          expect(nodeB.getConnectedPeers()).toContain(nodeA.peerId());
        },
        { timeout: 20_000, interval: 200 },
      );

      // last: B is in A's ordering-block mesh and A in B's.
      const topic = gossipTopics(MAGIC_TESTNET).orderingBlock;
      await vi.waitFor(
        () => {
          expect(pubsubOf(nodeA).getMeshPeers(topic)).toContain(nodeB.peerId());
          expect(pubsubOf(nodeB).getMeshPeers(topic)).toContain(nodeA.peerId());
        },
        { timeout: 30_000, interval: 500 },
      );
    },
    180_000,
  );

  // MESH_INTERFACE → Block gossip → "A node's readers are its router's
  // direct peers": the router holds a reader as a direct peer, in no
  // topic's mesh, and answers its `GRAFT` with a `PRUNE`.
  it(
    "a node's mesh holds no reader, and no reader's router holds the node in its mesh",
    async () => {
      const nodeA = new NetNode(makeConfig(), validators);
      nodes.push(nodeA);
      await nodeA.start();

      const { readers, awaitAllGraftedWithA } = await dialNReaders(13, nodeA, hosts);
      await vi.waitFor(
        () => {
          expect(nodeA.getConnectedReaders()).toHaveLength(13);
        },
        { timeout: 20_000, interval: 200 },
      );

      // Wait on every reader having sent its GRAFT to A — the mesh the
      // last assertion reads has settled from one side either way.
      await awaitAllGraftedWithA();

      // control: every reader is a topic peer of A (A has heard each
      // reader's subscription).
      const topic = gossipTopics(MAGIC_TESTNET).orderingBlock;
      const readerIds = readers.map((r) => r.peerId.toString());
      await vi.waitFor(
        () => {
          const subs = pubsubOf(nodeA)
            .getSubscribers(topic)
            .map((p) => p.toString());
          for (const id of readerIds) expect(subs).toContain(id);
        },
        { timeout: 15_000, interval: 300 },
      );

      // last: A's mesh lists no reader, and each reader's own router
      // lists A in no mesh.
      await vi.waitFor(
        () => {
          const meshAtA = pubsubOf(nodeA).getMeshPeers(topic);
          for (const id of readerIds) expect(meshAtA).not.toContain(id);
          const aId = nodeA.peerId();
          for (const r of readers) {
            expect(readerPubsub(r).getMeshPeers(topic)).not.toContain(aId);
          }
        },
        { timeout: 30_000, interval: 500 },
      );
    },
    180_000,
  );

  // MESH_INTERFACE → Block gossip → "A node's readers are its router's
  // direct peers": the router forwards every message on a topic the
  // reader subscribes to straight to it. The block enters at C so A
  // forwards it rather than publishes it.
  it(
    'every reader receives a block the node forwards',
    async () => {
      const nodeA = new NetNode(makeConfig(), validators);
      nodes.push(nodeA);
      await nodeA.start();
      const addrA = nodeTcpAddress(nodeA);

      const nodeB = new NetNode(makeConfig({ bootstrapPeers: [addrA] }), validators);
      nodes.push(nodeB);
      await nodeB.start();
      const addrB = nodeTcpAddress(nodeB);

      const nodeC = new NetNode(makeConfig({ bootstrapPeers: [addrB] }), validators);
      nodes.push(nodeC);
      await nodeC.start();

      const topic = gossipTopics(MAGIC_TESTNET).orderingBlock;
      // control: A↔B and B↔C are peered, and the ordering-block mesh
      // reaches from C through B to A.
      await vi.waitFor(
        () => {
          expect(nodeA.getConnectedPeers()).toContain(nodeB.peerId());
          expect(nodeB.getConnectedPeers()).toContain(nodeC.peerId());
          expect(pubsubOf(nodeA).getMeshPeers(topic)).toContain(nodeB.peerId());
          expect(pubsubOf(nodeB).getMeshPeers(topic)).toContain(nodeC.peerId());
        },
        { timeout: 30_000, interval: 300 },
      );

      const { readers } = await dialNReaders(30, nodeA, hosts);
      await vi.waitFor(
        () => {
          expect(nodeA.getConnectedReaders()).toHaveLength(30);
          const subs = pubsubOf(nodeA)
            .getSubscribers(topic)
            .map((p) => p.toString());
          for (const r of readers) expect(subs).toContain(r.peerId.toString());
        },
        { timeout: 30_000, interval: 300 },
      );

      // Each reader records every message its router delivers on the
      // ordering-block topic.
      const deliveries = new Map<string, Uint8Array[]>();
      for (const r of readers) {
        const arr: Uint8Array[] = [];
        deliveries.set(r.peerId.toString(), arr);
        readerPubsub(r).addEventListener('gossipsub:message', (evt) => {
          const detail = evt.detail as {
            msg?: { topic: string; data: Uint8Array };
          } | undefined;
          if (detail?.msg?.topic === topic) arr.push(detail.msg.data);
        });
      }

      const block = makeBlockAt(1, PROTOCOL_VERSION);
      await nodeC.broadcastOrderingBlock(block);

      // last: every reader's router delivered that block.
      await vi.waitFor(
        () => {
          for (const r of readers) {
            const arr = deliveries.get(r.peerId.toString())!;
            expect(arr.length).toBeGreaterThanOrEqual(1);
          }
        },
        { timeout: 45_000, interval: 500 },
      );
    },
    240_000,
  );

  // MESH_INTERFACE → Block gossip → "A node's readers are its router's
  // direct peers": the node's router takes a reader as a direct peer when
  // its handshake completes and lets it go when the node holds no
  // connection to it.
  //
  // The direct set `pubsub.direct` is read on `GossipSub` the concrete
  // class owns; net's patch adds and removes entries after construction
  // and is the only mutator of the set outside `opts.directPeers` (net
  // passes none), so what the case reads is the state the patch keeps.
  it(
    "a reader leaves the router's direct peers when the node holds no connection to it",
    async () => {
      const nodeA = new NetNode(makeConfig(), validators);
      nodes.push(nodeA);
      await nodeA.start();
      const addrA = nodeTcpAddress(nodeA);

      const reader = await makeReaderLibp2p(MAGIC_TESTNET);
      hosts.push(reader);
      await runReaderHandshake(reader, addrA, MAGIC_TESTNET);
      const readerId = reader.peerId.toString();

      // control: the reader is held as a reader on A.
      await vi.waitFor(
        () => {
          expect(nodeA.getConnectedReaders()).toContain(readerId);
        },
        { timeout: 10_000, interval: 100 },
      );

      // control: the reader is a direct peer of A's router.
      const pubsubA = pubsubOf(nodeA);
      await vi.waitFor(
        () => {
          expect(pubsubA.direct.has(readerId)).toBe(true);
        },
        { timeout: 10_000, interval: 100 },
      );

      // Stop the reader so its connection to A closes; libp2p fires
      // `peer:disconnect` at A.
      await reader.stop();

      // last: the reader is no longer a direct peer of A's router.
      await vi.waitFor(
        () => {
          expect(pubsubA.direct.has(readerId)).toBe(false);
        },
        { timeout: 10_000, interval: 100 },
      );
    },
    TIMEOUT,
  );

  // NET_INTERFACE → Readers → "A reader is its node's gossip direct
  // peer"; MESH_INTERFACE → Block gossip → "A node's readers are its
  // router's direct peers": a router never graylists a direct peer by
  // its score, so a reader's misbehaviour is weighed by net's ban policy,
  // whose ban ends the connection. A ProtocolViolation bans at once.
  it(
    "a reader's invalid block is still weighed by net's ban policy",
    async () => {
      const nodeA = new NetNode(makeConfig(), validators);
      nodes.push(nodeA);
      await nodeA.start();
      const addrA = nodeTcpAddress(nodeA);

      const reader = await makeReaderLibp2p(MAGIC_TESTNET);
      hosts.push(reader);
      await runReaderHandshake(reader, addrA, MAGIC_TESTNET);
      const readerId = reader.peerId.toString();
      const topic = gossipTopics(MAGIC_TESTNET).orderingBlock;
      readerPubsub(reader).subscribe(topic);

      // control: the reader is held as a reader, and A has heard the
      // reader's subscription on the ordering-block topic.
      await vi.waitFor(
        () => {
          expect(nodeA.getConnectedReaders()).toContain(readerId);
          const subs = pubsubOf(nodeA)
            .getSubscribers(topic)
            .map((p) => p.toString());
          expect(subs).toContain(readerId);
        },
        { timeout: 10_000, interval: 200 },
      );

      // The reader publishes bytes that do not decode as an ordering
      // block header; A's topic validator records a ProtocolViolation
      // against the reader, which bans at once.
      await readerPubsub(reader).publish(topic, new Uint8Array([0, 1, 2, 3]));

      // last: A holds no connection to the reader.
      await vi.waitFor(
        () => {
          const held = nodeA
            .libp2pNode!.getConnections()
            .filter((c) => c.remotePeer.toString() === readerId);
          expect(held).toHaveLength(0);
        },
        { timeout: 15_000, interval: 200 },
      );
    },
    TIMEOUT,
  );
});
