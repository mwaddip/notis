// MESH_INTERFACE → Block gossip → "A peer's gossip follows its newest
// connection". Three cases exercise `@libp2p/gossipsub`'s router against a
// peer that holds, has held, or holds twice at once a connection to the
// router:
//   1. a reader that redialled after its link fell silent is forwarded a
//      block on the new connection;
//   2. a reader stays the router's peer when the link its replaced inbound
//      stream ran on ends with an error;
//   3. the router keeps its outbound on the newer connection when the
//      peer's gossip stream arrives on an older one, so a graceful close
//      of the older connection leaves the router's outbound alive.
//
// Each case runs real `NetNode`s over loopback TCP. `N` is the router under
// test; `M` peers with `N` and publishes the block (so `N` forwards it
// rather than publishing it itself). `R` is a plain libp2p host built like
// `makeReaderLibp2p` builds one. A loopback TCP proxy owned by the case
// interposes between `R` and `N`: it forwards bytes both ways until told
// to go silent, then forwards nothing and holds `N`'s side open; a case
// that wants an error on `N`'s side destroys the proxy's upstream socket.
//
// `N` runs with libp2p's connection monitor off, and TCP keepalive does
// not fire within a case's timeout, so a silent connection stays open on
// `N`'s side until a party on either end closes it.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createServer as createNetServer,
  connect as netConnect,
  type Server,
  type Socket,
  type AddressInfo,
} from 'node:net';
import type { Connection, Libp2p, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@libp2p/gossipsub';
import type { GossipSub } from '@libp2p/gossipsub';
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
import { NetNode } from '../src/node.js';
import { buildHandshakeFrame } from '../src/handshake.js';
import { HANDSHAKE_PROTOCOL } from '../src/sync.js';
import { MAGIC_TESTNET } from '../src/frame.js';
import { gossipTopics, gossipsubOptions } from '../src/gossip-rules.js';
import { MAX_HANDSHAKE_FRAME_BYTES } from '../src/msg-guards.js';
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

// Each case needs seconds for TCP, Noise, identify, the handshake, the
// gossipsub heartbeat and two block broadcasts under a settle.
const TIMEOUT = 60_000;

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig(overrides);
}

// A plain libp2p host configured as a Notis reader
// (NET_INTERFACE → Readers): TCP + Noise + yamux + identify, gossipsub on
// the ordering-block topic alone with `net`'s options, no listen addresses.
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

// Open a handshake stream on an existing `Connection` and run the Notis
// handshake as the dialler. Mirrors `test/readers.test.ts` →
// `runReaderHandshake`, split so a case can pick which connection the
// stream rides when the host holds two.
async function runReaderHandshakeOnConn(
  conn: Connection,
  magic: number,
  capabilities: number[] = [],
): Promise<Uint8Array | null> {
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

  if (!readDeadline.aborted && total > 0 && total <= MAX_HANDSHAKE_FRAME_BYTES) {
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { data.set(c, off); off += c.length; }
    return data;
  }
  return null;
}

function nodeTcpAddress(node: NetNode): string {
  const addrs = node.libp2pNode?.getMultiaddrs() ?? [];
  const match = addrs.find((a) => a.toString().includes('/tcp/'));
  if (!match) throw new Error('node has no TCP listen address');
  return match.toString();
}

// `getMeshPeers` lives on gossipsub's own class but not on the type
// `@libp2p/gossipsub`'s `GossipSub` re-exports. The cast reads the one
// member on it that's not on the published interface, nothing else.
interface GossipSubWithMesh extends GossipSub {
  getMeshPeers(topic: string): string[];
}

function pubsubOf(node: NetNode): GossipSubWithMesh {
  const lp = node.libp2pNode;
  if (!lp) throw new Error('node is not started');
  return (lp as unknown as { services: { pubsub: GossipSubWithMesh } }).services.pubsub;
}

function readerPubsub(host: Libp2p): GossipSubWithMesh {
  return (host as unknown as { services: { pubsub: GossipSubWithMesh } }).services.pubsub;
}

// A loopback TCP proxy a case owns. It forwards bytes both ways until
// `silent()` is called, then forwards nothing and closes nothing on either
// side; `abortNodeSide()` destroys the proxy's upstream sockets so `N`
// reads TCP RST on each paired connection.
interface Proxy {
  port: number;
  silent(): void;
  abortNodeSide(): void;
  stop(): Promise<void>;
}

async function startTcpProxy(upstreamPort: number): Promise<Proxy> {
  const pairs: Array<{ client: Socket; upstream: Socket }> = [];
  let silent = false;
  const server: Server = createNetServer((client) => {
    const upstream = netConnect(upstreamPort, '127.0.0.1');
    pairs.push({ client, upstream });
    client.on('data', (b) => { if (!silent) upstream.write(b); });
    upstream.on('data', (b) => { if (!silent) client.write(b); });
    client.on('end', () => {
      if (!silent) { try { upstream.end(); } catch { /* ignore */ } }
    });
    upstream.on('end', () => {
      if (!silent) { try { client.end(); } catch { /* ignore */ } }
    });
    client.on('error', () => { /* ignore */ });
    upstream.on('error', () => { /* ignore */ });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => { resolve(); }));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    silent() { silent = true; },
    abortNodeSide() {
      for (const p of pairs) {
        try { p.upstream.destroy(); } catch { /* ignore */ }
      }
    },
    async stop() {
      silent = true;
      for (const p of pairs) {
        try { p.client.destroy(); } catch { /* ignore */ }
        try { p.upstream.destroy(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    },
  };
}

function tcpPortOf(addr: string): number {
  const m = addr.match(/\/tcp\/(\d+)/);
  if (m === null) throw new Error(`addr ${addr} has no /tcp/ component`);
  return Number(m[1]);
}

describe(`MESH_INTERFACE → Block gossip → "A peer's gossip follows its newest connection"`, () => {
  const nodes: NetNode[] = [];
  const hosts: Libp2p[] = [];
  const proxies: Proxy[] = [];

  afterEach(async () => {
    for (const p of proxies) {
      await p.stop().catch(() => undefined);
    }
    proxies.length = 0;
    await Promise.allSettled(hosts.map((h) => h.stop()));
    hosts.length = 0;
    await Promise.allSettled(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  // Case 1 — the reader redials after its link fell silent, and a block
  // entering at M reaches the reader on the new connection.
  //
  // Unpatched, the router's outbound to R runs on the silent conn1:
  // `createOutboundStream` returns early when R's new inbound arrives
  // on conn2 (`streamsOutbound.has(id)`), so the forwarded block writes
  // to the dead outbound and R reads nothing.
  it(
    'a reader that redialled after its link fell silent is forwarded a block on the new connection',
    async () => {
      const topics = gossipTopics(MAGIC_TESTNET);

      const nodeN = new NetNode(makeConfig({ minPeers: 0 }), validators);
      nodes.push(nodeN);
      await nodeN.start();
      const addrN = nodeTcpAddress(nodeN);
      const nPort = tcpPortOf(addrN);

      const nodeM = new NetNode(
        makeConfig({ minPeers: 0, bootstrapPeers: [addrN] }),
        validators,
      );
      nodes.push(nodeM);
      await nodeM.start();
      // control: N and M peer, and each is in the other's mesh on the
      // ordering-block topic — a published block flows between them.
      await vi.waitFor(
        () => {
          expect(nodeN.getConnectedPeers()).toContain(nodeM.peerId());
          expect(nodeM.getConnectedPeers()).toContain(nodeN.peerId());
          expect(pubsubOf(nodeN).getMeshPeers(topics.orderingBlock))
            .toContain(nodeM.peerId());
          expect(pubsubOf(nodeM).getMeshPeers(topics.orderingBlock))
            .toContain(nodeN.peerId());
        },
        { timeout: 20_000, interval: 200 },
      );

      const proxy = await startTcpProxy(nPort);
      proxies.push(proxy);

      const reader = await makeReaderLibp2p(MAGIC_TESTNET);
      hosts.push(reader);
      const readerId = reader.peerId.toString();
      const deliveries: Uint8Array[] = [];
      readerPubsub(reader).addEventListener('gossipsub:message', (evt) => {
        const d = evt.detail as unknown as { msg?: { topic: string; data: Uint8Array } };
        if (d?.msg?.topic === topics.orderingBlock) {
          deliveries.push(d.msg.data);
        }
      });
      readerPubsub(reader).subscribe(topics.orderingBlock);

      // R dials N through the proxy. The proxy is transparent, so Noise
      // and identify run end to end with N; N's peer id is the one in the
      // multiaddr the case dials.
      const proxyAddr = `/ip4/127.0.0.1/tcp/${proxy.port}/p2p/${nodeN.peerId()}`;
      const conn1 = await reader.dial(multiaddr(proxyAddr));
      await runReaderHandshakeOnConn(conn1, MAGIC_TESTNET);

      // control: N has R as a subscriber to ordering-block, and R has N
      // as one — both sides' routers hold the other.
      await vi.waitFor(
        () => {
          expect(pubsubOf(nodeN).getSubscribers(topics.orderingBlock).map(String))
            .toContain(readerId);
          expect(readerPubsub(reader).getSubscribers(topics.orderingBlock).map(String))
            .toContain(nodeN.peerId());
        },
        { timeout: 20_000, interval: 200 },
      );

      // control: a first block entering at M reaches R through N's
      // forward on the proxy connection.
      const block1 = makeBlockAt(1, PROTOCOL_VERSION);
      await nodeM.broadcastOrderingBlock(block1);
      await vi.waitFor(
        () => { expect(deliveries.length).toBe(1); },
        { timeout: 20_000, interval: 200 },
      );

      // Capture N's current outbound stream to R — the one the forward
      // of block1 just rode — so the last assertion can read the stream's
      // writable end after the redial, and know the router closed its
      // replaced outbound.
      const outboundMap = (pubsubOf(nodeN) as unknown as {
        streamsOutbound: Map<string, { readonly rawStream: Stream }>;
      }).streamsOutbound;
      const oldOutbound = outboundMap.get(readerId);
      expect(oldOutbound).toBeDefined();
      const oldOutboundRawStream = oldOutbound!.rawStream;
      expect(oldOutboundRawStream.writeStatus).toBe('writable');

      // The proxy stops forwarding (no close on N's side), and R aborts
      // its own side of conn1. R's libp2p fires peer:disconnect, R's
      // gossipsub removes the peer and its outbound. N holds the silent
      // conn1 as still open.
      proxy.silent();
      try { conn1.abort(new Error('proxy silent')); } catch { /* already gone */ }
      await vi.waitFor(
        () => {
          const rp = peerIdFromString(nodeN.peerId());
          expect(reader.getConnections(rp).length).toBe(0);
        },
        { timeout: 10_000, interval: 100 },
      );

      // R dials N directly — a second connection on N's side (conn2),
      // the first on R's side after the abort. R's gossipsub opens a
      // fresh outbound on conn2 and re-sends its subscriptions.
      const conn2 = await reader.dial(multiaddr(addrN));
      await runReaderHandshakeOnConn(conn2, MAGIC_TESTNET);

      // control: R's new outbound reached N — N holds R as a subscriber
      // under the new stream (the subscription RPC is idempotent and
      // leaves the subscribers map carrying R already; this control
      // reads the stream-level state).
      await vi.waitFor(
        () => {
          const ps = pubsubOf(nodeN) as unknown as {
            streamsInbound: Map<string, unknown>;
            streamsOutbound: Map<string, unknown>;
          };
          expect(ps.streamsInbound.has(readerId)).toBe(true);
          expect(ps.streamsOutbound.has(readerId)).toBe(true);
        },
        { timeout: 20_000, interval: 200 },
      );

      // a block entering at M after the redial reaches R on the new
      // connection. Unpatched, N's outbound to R is still on the silent
      // conn1, so the forwarded RPC writes to a dead stream and
      // `deliveries.length` stays at 1.
      const block2 = makeBlockAt(2, PROTOCOL_VERSION);
      await nodeM.broadcastOrderingBlock(block2);
      await vi.waitFor(
        () => { expect(deliveries.length).toBe(2); },
        { timeout: 30_000, interval: 200 },
      );

      // last: the router closed its replaced outbound to R. A yamux
      // close writes one FIN frame and settles the stream's write
      // side locally — over the silent conn1 only the router's own
      // close moves the write side off 'writable'; R's abort on the
      // proxy connection is invisible to N.
      await vi.waitFor(
        () => {
          expect(oldOutboundRawStream.writeStatus).toBe('closed');
        },
        { timeout: 10_000, interval: 100 },
      );
    },
    TIMEOUT,
  );

  // Case 2 — R opens two gossipsub streams in a row to N. N's
  // `createInboundStream` replaces its inbound map entry with each; the
  // second manual stream becomes N's current inbound, and the first is
  // the replaced one. R then resets the first manual stream from its
  // side (`stream.abort`): yamux writes a RST frame, N reads it and the
  // stream's source iterator throws in N's `pipePeerReadStream`,
  // feeding `handlePeerReadStreamError` the stream whose entry on the
  // inbound map has already been replaced. Unpatched, that call removes
  // the peer unconditionally and the forwarded block does not reach R.
  //
  // The loopback-proxy arrangement from case 1 would exercise this path
  // too under WebRTC (a stream close over a silent connection waits
  // DEFAULT_FIN_ACK_TIMEOUT and throws AggregateError), but over TCP +
  // yamux the muxer's `onTransportClosed` does not propagate as an
  // error — the replaced stream exits its read pipe gracefully and the
  // error path never fires. A stream-level reset is what reaches it
  // here; the failure mode the rule holds against is the same —
  // `handlePeerReadStreamError` carrying a stream the router has
  // already replaced.
  it(
    'a reader stays the router\'s peer when a replaced inbound stream resets',
    async () => {
      const topics = gossipTopics(MAGIC_TESTNET);

      const nodeN = new NetNode(makeConfig({ minPeers: 0 }), validators);
      nodes.push(nodeN);
      await nodeN.start();
      const addrN = nodeTcpAddress(nodeN);

      const nodeM = new NetNode(
        makeConfig({ minPeers: 0, bootstrapPeers: [addrN] }),
        validators,
      );
      nodes.push(nodeM);
      await nodeM.start();
      await vi.waitFor(
        () => {
          expect(nodeN.getConnectedPeers()).toContain(nodeM.peerId());
          expect(pubsubOf(nodeN).getMeshPeers(topics.orderingBlock))
            .toContain(nodeM.peerId());
          expect(pubsubOf(nodeM).getMeshPeers(topics.orderingBlock))
            .toContain(nodeN.peerId());
        },
        { timeout: 20_000, interval: 200 },
      );

      const reader = await makeReaderLibp2p(MAGIC_TESTNET);
      hosts.push(reader);
      const readerId = reader.peerId.toString();
      const deliveries: Uint8Array[] = [];
      readerPubsub(reader).addEventListener('gossipsub:message', (evt) => {
        const d = evt.detail as unknown as { msg?: { topic: string; data: Uint8Array } };
        if (d?.msg?.topic === topics.orderingBlock) {
          deliveries.push(d.msg.data);
        }
      });
      readerPubsub(reader).subscribe(topics.orderingBlock);

      const conn1 = await reader.dial(multiaddr(addrN));
      await runReaderHandshakeOnConn(conn1, MAGIC_TESTNET);
      await vi.waitFor(
        () => {
          expect(pubsubOf(nodeN).getSubscribers(topics.orderingBlock).map(String))
            .toContain(readerId);
          expect(readerPubsub(reader).getSubscribers(topics.orderingBlock).map(String))
            .toContain(nodeN.peerId());
        },
        { timeout: 20_000, interval: 200 },
      );

      // control: a first block flows over the automatic gossipsub
      // streams before any manual stream is opened.
      const block1 = makeBlockAt(1, PROTOCOL_VERSION);
      await nodeM.broadcastOrderingBlock(block1);
      await vi.waitFor(
        () => { expect(deliveries.length).toBe(1); },
        { timeout: 20_000, interval: 200 },
      );

      const inboundMap = (pubsubOf(nodeN) as unknown as {
        streamsInbound: Map<string, unknown>;
      }).streamsInbound;

      // R opens a manual gossipsub stream on conn1. N's
      // `createInboundStream` closes R's automatic inbound and sets
      // streamA as N's current inbound. The map's entry changes to
      // streamA's `InboundStream`, which is what we wait on.
      const inboundBeforeA = inboundMap.get(readerId);
      const streamA = await conn1.newStream(
        ['/meshsub/1.2.0', '/meshsub/1.1.0', '/meshsub/1.0.0'],
        { signal: AbortSignal.timeout(10_000) },
      );
      await vi.waitFor(
        () => {
          const cur = inboundMap.get(readerId);
          expect(cur).toBeDefined();
          expect(cur).not.toBe(inboundBeforeA);
        },
        { timeout: 10_000, interval: 50 },
      );

      // R opens a second manual gossipsub stream on conn1. streamA
      // becomes the replaced one; streamB is now N's current inbound.
      const inboundBeforeB = inboundMap.get(readerId);
      const streamB = await conn1.newStream(
        ['/meshsub/1.2.0', '/meshsub/1.1.0', '/meshsub/1.0.0'],
        { signal: AbortSignal.timeout(10_000) },
      );
      await vi.waitFor(
        () => {
          const cur = inboundMap.get(readerId);
          expect(cur).toBeDefined();
          expect(cur).not.toBe(inboundBeforeB);
        },
        { timeout: 10_000, interval: 50 },
      );

      // R resets streamA from its side. yamux writes a RST frame, N
      // reads it, and N's pipe on streamA throws its StreamResetError
      // into `handlePeerReadStreamError` — with a stream that has
      // already been replaced on the inbound map.
      streamA.abort(new Error('reset the replaced stream'));

      // last: a block entering at M after the reset reaches R.
      // Unpatched, the error on the replaced stream removes R from
      // the router, so `deliveries.length` stays at 1. Named through
      // so the host's teardown closes it rather than leaking.
      void streamB;
      const block2 = makeBlockAt(2, PROTOCOL_VERSION);
      await nodeM.broadcastOrderingBlock(block2);
      await vi.waitFor(
        () => { expect(deliveries.length).toBe(2); },
        { timeout: 30_000, interval: 200 },
      );
    },
    TIMEOUT,
  );

  // Case 3 — R holds two connections to N. R opens a gossipsub stream
  // by hand on the newer one, which arrives at N as an inbound: the
  // patch moves N's outbound onto that newer connection. Then R opens
  // a gossipsub stream on the older one: under the patch N keeps its
  // outbound on the newer connection (never moves onto an older or
  // the same one). R gracefully closes the older connection; N's
  // outbound on the newer stays alive and a block entering at M
  // reaches R.
  //
  // Were the rule relaxed to move onto any different connection, N's
  // outbound would move onto the older connection at the second manual
  // stream. The graceful close of the older connection would end that
  // outbound stream (its `'close'` listener deletes the map entry),
  // `sendRpc` would then find no stream to R, and the forwarded block
  // would never reach R. The current inbound ends gracefully too
  // (yamux FIN, no error), so the peer stays and the delivery count
  // distinguishes the two behaviours on its own.
  it(
    'the router keeps its outbound on the newer connection when the peer\'s stream arrives on an older one',
    async () => {
      const topics = gossipTopics(MAGIC_TESTNET);

      const nodeN = new NetNode(makeConfig({ minPeers: 0 }), validators);
      nodes.push(nodeN);
      await nodeN.start();
      const addrN = nodeTcpAddress(nodeN);
      const addrNBare = addrN.split('/p2p/')[0]!;

      const nodeM = new NetNode(
        makeConfig({ minPeers: 0, bootstrapPeers: [addrN] }),
        validators,
      );
      nodes.push(nodeM);
      await nodeM.start();
      await vi.waitFor(
        () => {
          expect(nodeN.getConnectedPeers()).toContain(nodeM.peerId());
          expect(pubsubOf(nodeN).getMeshPeers(topics.orderingBlock))
            .toContain(nodeM.peerId());
          expect(pubsubOf(nodeM).getMeshPeers(topics.orderingBlock))
            .toContain(nodeN.peerId());
        },
        { timeout: 20_000, interval: 200 },
      );

      const reader = await makeReaderLibp2p(MAGIC_TESTNET);
      hosts.push(reader);
      const readerId = reader.peerId.toString();
      const deliveries: Uint8Array[] = [];
      readerPubsub(reader).addEventListener('gossipsub:message', (evt) => {
        const d = evt.detail as unknown as { msg?: { topic: string; data: Uint8Array } };
        if (d?.msg?.topic === topics.orderingBlock) {
          deliveries.push(d.msg.data);
        }
      });
      readerPubsub(reader).subscribe(topics.orderingBlock);

      // First connection: dial N by its `/p2p/` multiaddr. R's gossipsub
      // opens its automatic outbound on conn1, and R subscribes.
      const conn1 = await reader.dial(multiaddr(addrN));
      await runReaderHandshakeOnConn(conn1, MAGIC_TESTNET);
      await vi.waitFor(
        () => {
          expect(pubsubOf(nodeN).getSubscribers(topics.orderingBlock).map(String))
            .toContain(readerId);
        },
        { timeout: 20_000, interval: 200 },
      );

      // Second connection: dial N by its bare address (no `/p2p/`
      // suffix) with `force: true`, so libp2p's connection manager
      // keeps the new connection even though it resolves to the same
      // remoteAddr the first dial carries once Noise authenticates its
      // peer (libp2p's `Duplicate multiaddr connection`). conn2 opens
      // later than conn1, so its `timeline.open` is strictly greater.
      const conn2 = await reader.dial(multiaddr(addrNBare), { force: true });
      await runReaderHandshakeOnConn(conn2, MAGIC_TESTNET);
      await vi.waitFor(
        () => {
          const rp = peerIdFromString(readerId);
          expect(nodeN.libp2pNode!.getConnections(rp).length).toBe(2);
        },
        { timeout: 10_000, interval: 200 },
      );
      // control: the two connections sort by `timeline.open` as a case
      // that distinguishes "older" from "newer" needs them to.
      expect(conn2.timeline.open).toBeGreaterThan(conn1.timeline.open);

      // control: a first block flows through the automatic gossipsub
      // streams before any manual stream is opened.
      const block1 = makeBlockAt(1, PROTOCOL_VERSION);
      await nodeM.broadcastOrderingBlock(block1);
      await vi.waitFor(
        () => { expect(deliveries.length).toBe(1); },
        { timeout: 20_000, interval: 200 },
      );

      // N's inbound and outbound stream maps, and N's two Connection
      // objects. N's outbound to R starts on conn1 — the only connection
      // open at the time its automatic `onPeerConnected` fired.
      const inboundMap = (pubsubOf(nodeN) as unknown as {
        streamsInbound: Map<string, unknown>;
      }).streamsInbound;
      const outboundMap = (pubsubOf(nodeN) as unknown as {
        streamsOutbound: Map<string, { readonly rawStream: { id: string } }>;
      }).streamsOutbound;
      const nReaderPeerId = peerIdFromString(readerId);
      const nNewer = (): Connection => {
        const nConns = nodeN.libp2pNode!.getConnections(nReaderPeerId);
        expect(nConns.length).toBe(2);
        return [...nConns].sort((a, b) => a.timeline.open - b.timeline.open)[1]!;
      };
      const inboundBeforeNew = inboundMap.get(readerId);
      const outboundBeforeNew = outboundMap.get(readerId);

      // Open a gossipsub stream by hand on the NEWER connection. N sees
      // this as a new inbound and, under the patch, opens a new outbound
      // on N's view of conn2 (closing the old outbound on conn1).
      const streamNew = await conn2.newStream(
        ['/meshsub/1.2.0', '/meshsub/1.1.0', '/meshsub/1.0.0'],
        { signal: AbortSignal.timeout(10_000) },
      );
      // Wait for N's createInboundStream to replace the inbound entry,
      // and for N's outbound to move onto N's view of conn2 — a new
      // OutboundStream whose rawStream sits among the newer connection's
      // streams. Unpatched, the outbound sits on conn1 and this wait
      // times out.
      await vi.waitFor(
        () => {
          expect(inboundMap.get(readerId)).not.toBe(inboundBeforeNew);
          const outboundNow = outboundMap.get(readerId);
          expect(outboundNow).toBeDefined();
          expect(outboundNow).not.toBe(outboundBeforeNew);
          const rawId = outboundNow!.rawStream.id;
          expect(nNewer().streams.some((s) => s.id === rawId)).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );

      // Open a gossipsub stream by hand on the OLDER connection. Under
      // the patch N's outbound stays on conn2 (never moves onto an older
      // or the same connection).
      const inboundBeforeOld = inboundMap.get(readerId);
      const streamOld = await conn1.newStream(
        ['/meshsub/1.2.0', '/meshsub/1.1.0', '/meshsub/1.0.0'],
        { signal: AbortSignal.timeout(10_000) },
      );
      await vi.waitFor(
        () => {
          expect(inboundMap.get(readerId)).not.toBe(inboundBeforeOld);
        },
        { timeout: 10_000, interval: 50 },
      );

      // control: R still has two connections to N.
      expect(reader.getConnections(peerIdFromString(nodeN.peerId())).length)
        .toBeGreaterThanOrEqual(2);
      expect(nodeN.libp2pNode!.getConnections(nReaderPeerId).length)
        .toBeGreaterThanOrEqual(2);

      // R gracefully closes the OLDER connection. On N, every yamux
      // stream on conn1 ends with FIN (no error), so no stream fires
      // `handlePeerReadStreamError` and the peer stays whatever the
      // patch state.
      await conn1.close().catch(() => undefined);
      await vi.waitFor(
        () => {
          const rp = peerIdFromString(readerId);
          expect(nodeN.libp2pNode!.getConnections(rp).length).toBe(1);
        },
        { timeout: 10_000, interval: 100 },
      );

      // last: a block entering at M after the older connection closes
      // reaches R. Were the rule relaxed to move onto any different
      // connection, N's outbound to R would have moved onto conn1 at
      // the second manual stream, so closing conn1 would end that
      // outbound and `sendRpc` would find none to send on;
      // `deliveries.length` stays at 1.
      const block2 = makeBlockAt(2, PROTOCOL_VERSION);
      await nodeM.broadcastOrderingBlock(block2);
      await vi.waitFor(
        () => { expect(deliveries.length).toBe(2); },
        { timeout: 30_000, interval: 200 },
      );

      // Dormant handles, named so they are closed with the host in
      // teardown rather than leaked.
      void streamNew;
      void streamOld;
    },
    TIMEOUT,
  );
});
