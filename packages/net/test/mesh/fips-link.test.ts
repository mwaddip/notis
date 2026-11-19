// MESH_INTERFACE → FIPS → "A link rides a libp2p connection the two ends
// already hold" — a fips-ts Transport that carries FIPS link packets on a
// libp2p protocol stream.
// MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p peer that
// named it holds the key" — the holding rules the transport enforces.
// MESH_INTERFACE → FIPS → "Each side names its key first" — the stream's
// opener writes its 33-byte compressed key, the answerer reads it then
// writes its own; every later frame is a FIPS packet.

import { afterEach, describe, expect, it } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { lpStream } from '@libp2p/utils';
import type { Connection, Stream } from '@libp2p/interface';
import {
  FipsNode,
  generateIdentity,
  toHex,
  type FipsIdentity,
  type PeerEvent,
  type DatagramEvent,
} from '@fips/core';
import {
  fipsLinkProtocol,
  LibP2pLinkTransport,
} from '../../src/mesh/fips-link.js';
import { FIPS_LINK_MTU } from '../../src/mesh/constants.js';

interface Peer {
  libp2p: Libp2p;
  node: FipsNode;
  transport: LibP2pLinkTransport;
  identity: FipsIdentity;
  pubkeyHex: string;
}

async function makeLibp2p(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

interface MakePeerOptions {
  readonly network?: 'devnet' | 'testnet' | 'mainnet';
  readonly hintTimeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly retryCapMs?: number;
  readonly random?: () => number;
  readonly identity?: FipsIdentity;
}

async function makePeer(options: MakePeerOptions = {}): Promise<Peer> {
  const libp2p = await makeLibp2p();
  const identity = options.identity ?? await generateIdentity();
  let node!: FipsNode;
  const transport = new LibP2pLinkTransport({
    network: options.network ?? 'testnet',
    connectPeer: async (addr) => node.connect(addr),
    hintTimeoutMs: options.hintTimeoutMs ?? 200,
    retryBaseMs: options.retryBaseMs ?? 50,
    retryCapMs: options.retryCapMs ?? 1_000,
    random: options.random ?? (() => 0.5),
  });
  node = new FipsNode({ identity, transports: [transport], forwarding: true });
  node.on('peer', (data) => {
    const ev = data as PeerEvent;
    if (ev.state === 'connected') transport.linkUp(ev.remotePubkey);
  });
  await node.start();
  await transport.attach(libp2p);
  return { libp2p, node, transport, identity, pubkeyHex: toHex(identity.publicKey) };
}

async function tcpAddress(peer: Libp2p): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const match = peer.getMultiaddrs().map((m) => m.toString())
      .find((s) => s.includes('/tcp/'));
    if (match !== undefined) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no tcp address');
}

async function dial(from: Libp2p, to: Libp2p, force = false): Promise<Connection> {
  const addr = await tcpAddress(to);
  return from.dial(multiaddr(addr), force ? ({ force: true } as unknown as never) : undefined);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(p: () => boolean, deadlineMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (p()) return true;
    await sleep(10);
  }
  return p();
}

async function waitPeer(
  node: FipsNode,
  remoteKeyHex: string,
  deadlineMs: number,
): Promise<PeerEvent | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(null); }, deadlineMs);
    const off = node.on('peer', (data) => {
      const ev = data as PeerEvent;
      if (ev.remotePubkey === remoteKeyHex && ev.state === 'connected') {
        clearTimeout(timer);
        off();
        resolve(ev);
      }
    });
  });
}

async function stopPeer(p: Peer): Promise<void> {
  try { await p.node.stop(); } catch { /* already */ }
  try { await p.libp2p.stop(); } catch { /* already */ }
}


describe('MESH_INTERFACE → FIPS: fipsLinkProtocol', () => {
  it.fails('the protocol id names the network', () => {
    expect(fipsLinkProtocol('testnet')).toBe('/notis/testnet/fips-link/1.0.0');
    expect(fipsLinkProtocol('devnet')).toBe('/notis/devnet/fips-link/1.0.0');
    expect(fipsLinkProtocol('mainnet')).toBe('/notis/mainnet/fips-link/1.0.0');
  });
});

describe('MESH_INTERFACE → FIPS: LibP2pLinkTransport link cases', () => {
  let a: Peer | null = null;
  let b: Peer | null = null;
  let c: Peer | null = null;
  let raw: Libp2p | null = null;

  afterEach(async () => {
    if (a) await stopPeer(a);
    if (b) await stopPeer(b);
    if (c) await stopPeer(c);
    if (raw) { try { await raw.stop(); } catch { /* already */ } }
    a = null; b = null; c = null; raw = null;
  });

  it.fails('a link comes up and a datagram crosses it', async () => {
    a = await makePeer();
    b = await makePeer();
    const conn = await dial(a.libp2p, b.libp2p);
    await a.transport.openLink(conn).catch(() => { /* stub answers nothing */ });
    await waitPeer(a.node, b.pubkeyHex, 2_000);
    // A datagram's payload lands on B through the link.
    const payload = new Uint8Array([7, 8, 9, 10]);
    const got: DatagramEvent | null = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2_000);
      b!.node.on('datagram', (data) => {
        const ev = data as DatagramEvent;
        if (ev.dstPort === 42) { clearTimeout(timer); resolve(ev); }
      });
      void a!.node.sendDatagram({ dst: b!.pubkeyHex, dstPort: 42, payload })
        .catch(() => { /* measured by the assertion below */ });
    });
    expect(got?.payload).toEqual(payload);
  }, 15_000);

  it.fails('a stream that names no key in time is closed', async () => {
    a = await makePeer({ hintTimeoutMs: 150 });
    raw = await makeLibp2p();
    const conn = await dial(raw, a.libp2p);
    const stream: Stream = await conn.newStream(fipsLinkProtocol('testnet'));
    // Write no key; the hint timeout should close the stream.
    await sleep(400);
    expect(stream.status === 'closed' || stream.status === 'aborted' || stream.status === 'reset').toBe(true);
  }, 10_000);

  it.fails('an oversized frame closes the stream', async () => {
    a = await makePeer();
    raw = await makeLibp2p();
    const conn = await dial(raw, a.libp2p);
    const stream: Stream = await conn.newStream(fipsLinkProtocol('testnet'));
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    const over = new Uint8Array(FIPS_LINK_MTU + 1);
    let threw = false;
    try { await lp.write(over); } catch { threw = true; }
    void threw;
    await sleep(200);
    expect(stream.status === 'closed' || stream.status === 'aborted' || stream.status === 'reset').toBe(true);
  }, 10_000);

  it.fails('a malformed key frame closes the stream', async () => {
    a = await makePeer();
    raw = await makeLibp2p();
    const conn = await dial(raw, a.libp2p);
    const stream: Stream = await conn.newStream(fipsLinkProtocol('testnet'));
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    // A valid-length frame whose bytes are not a compressed secp256k1 key.
    const bad = new Uint8Array(33);
    bad[0] = 0x01; // not 0x02 or 0x03
    try { await lp.write(bad); } catch { /* the far end may abort first */ }
    await sleep(200);
    expect(stream.status === 'closed' || stream.status === 'aborted' || stream.status === 'reset').toBe(true);
  }, 10_000);

  it.fails('a stream from another peer naming a linked key is closed and the link stays up', async () => {
    a = await makePeer();
    b = await makePeer();
    const connAB = await dial(a.libp2p, b.libp2p);
    await a.transport.openLink(connAB).catch(() => { /* stub */ });
    await waitPeer(a.node, b.pubkeyHex, 2_000);
    // A third libp2p peer C opens a link stream to A, writing B's FIPS key.
    raw = await makeLibp2p();
    const connCA = await dial(raw, a.libp2p);
    const stream: Stream = await connCA.newStream(fipsLinkProtocol('testnet'));
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    try { await lp.write(b.identity.publicKey); } catch { /* far end may abort */ }
    await sleep(300);
    const linked = a.transport.linkedKeys();
    expect(linked.includes(b.pubkeyHex) && !(stream.status === 'open')).toBe(true);
  }, 15_000);

  it.fails('two ends opening at once keep one link, opened by the lower key', async () => {
    // Keep generating until the pair's compressed keys sort A < B.
    let idA: FipsIdentity | null = null;
    let idB: FipsIdentity | null = null;
    for (let i = 0; i < 128 && !(idA && idB); i++) {
      const left = await generateIdentity();
      const right = await generateIdentity();
      const leftHex = toHex(left.publicKey);
      const rightHex = toHex(right.publicKey);
      if (leftHex < rightHex) { idA = left; idB = right; }
      else if (rightHex < leftHex) { idA = right; idB = left; }
    }
    if (!idA || !idB) throw new Error('no ordered pair');
    a = await makePeer({ identity: idA });
    b = await makePeer({ identity: idB });
    const connAB = await dial(a.libp2p, b.libp2p);
    // Wait for B to see A on libp2p as well.
    await waitFor(() => b!.libp2p.getConnections().length > 0, 2_000);
    const connBA = b.libp2p.getConnections()[0]!;
    // Open simultaneously.
    await Promise.all([
      a.transport.openLink(connAB),
      b.transport.openLink(connBA),
    ]);
    await Promise.all([
      waitPeer(a.node, b.pubkeyHex, 2_000),
      waitPeer(b.node, a.pubkeyHex, 2_000),
    ]);
    // Both ends keep one link — the lower-keyed opener's (A).
    expect(
      a.transport.linkedKeys().includes(b.pubkeyHex)
        && b.transport.linkedKeys().includes(a.pubkeyHex)
        && a.transport.linkedKeys().length === 1
        && b.transport.linkedKeys().length === 1,
    ).toBe(true);
  }, 15_000);

  it.fails("a newer stream from the same peer takes the link's place", async () => {
    a = await makePeer();
    b = await makePeer();
    const connAB = await dial(a.libp2p, b.libp2p);
    await waitFor(() => b !== null && b.libp2p.getConnections().length > 0, 2_000);
    await b.transport.openLink(b.libp2p.getConnections()[0]!).catch(() => { /* stub */ });
    await waitPeer(a.node, b.pubkeyHex, 2_000);
    // B opens a NEW stream on the same connection: it replaces the old.
    const connBA2 = b.libp2p.getConnections()[0]!;
    const bHex = b.pubkeyHex;
    await b.transport.openLink(connBA2).catch(() => { /* stub */ });
    await sleep(400);
    // A's single held link still names B's key.
    expect(a.transport.linkedKeys().filter((k) => k === bHex).length).toBe(1);
    void connAB;
  }, 15_000);

  it.fails('a link not up in time is closed', async () => {
    a = await makePeer({ hintTimeoutMs: 200 });
    raw = await makeLibp2p();
    const conn = await dial(raw, a.libp2p);
    const stream: Stream = await conn.newStream(fipsLinkProtocol('testnet'));
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    // A valid compressed key — but raw holds no FIPS secret for it, so
    // FIPS's handshake over A's answering key never completes.
    const fresh = await generateIdentity();
    await lp.write(fresh.publicKey);
    // Past the hint timeout (200 ms) + a settle budget, the stream closes.
    await sleep(600);
    expect(stream.status === 'closed' || stream.status === 'aborted' || stream.status === 'reset').toBe(true);
  }, 10_000);

  it.fails('closing the connection reports the key disconnected', async () => {
    a = await makePeer();
    b = await makePeer();
    const conn = await dial(a.libp2p, b.libp2p);
    await a.transport.openLink(conn).catch(() => { /* stub */ });
    await waitPeer(a.node, b.pubkeyHex, 2_000);
    const disc: Promise<PeerEvent | null> = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2_000);
      a!.node.on('peer', (data) => {
        const ev = data as PeerEvent;
        if (ev.state === 'disconnected' && ev.remotePubkey === b!.pubkeyHex) {
          clearTimeout(timer);
          resolve(ev);
        }
      });
    });
    await conn.close();
    const ev = await disc;
    expect(ev?.state).toBe('disconnected');
  }, 15_000);

  it.fails('an ended link is reopened over a connection still held', async () => {
    a = await makePeer({ retryBaseMs: 50, retryCapMs: 500 });
    b = await makePeer();
    const conn1 = await dial(a.libp2p, b.libp2p);
    const conn2 = await dial(a.libp2p, b.libp2p, true);
    await a.transport.openLink(conn1).catch(() => { /* stub */ });
    await waitPeer(a.node, b.pubkeyHex, 2_000);
    // Close the first connection; the second stays open.
    await conn1.close().catch(() => { /* already */ });
    await sleep(1_500);
    // The transport reopens the link on conn2.
    expect(a.transport.linkedKeys().includes(b.pubkeyHex)).toBe(true);
    void conn2;
  }, 20_000);
});
