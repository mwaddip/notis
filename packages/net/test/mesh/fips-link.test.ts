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
  type FipsLinkChange,
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
    hintTimeoutMs: options.hintTimeoutMs ?? 2_000,
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
  it('the protocol id names the network', () => {
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

  it('a link comes up and a datagram crosses it', async () => {
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

  it('a stream that names no key in time is closed', async () => {
    a = await makePeer({ hintTimeoutMs: 150 });
    raw = await makeLibp2p();
    const conn = await dial(raw, a.libp2p);
    const stream: Stream = await conn.newStream(fipsLinkProtocol('testnet'));
    // Write no key; the hint timeout should close the stream.
    await sleep(400);
    expect(stream.status === 'closed' || stream.status === 'aborted' || stream.status === 'reset').toBe(true);
  }, 10_000);

  it('an oversized frame closes the stream', async () => {
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

  it('an oversized frame after a valid key exchange closes the stream', async () => {
    // MESH_INTERFACE → FIPS → "Each side names its key first" — the
    // first frame is the 33-byte compressed key. A valid key frame
    // passes the 33-byte check and `a` holds the stream; the frame
    // cap guards every later frame on the held `lpStream`.
    a = await makePeer();
    raw = await makeLibp2p();
    const conn = await dial(raw, a.libp2p);
    const stream: Stream = await conn.newStream(fipsLinkProtocol('testnet'));
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    // A valid-length 33-byte compressed key. The 32 bytes after the
    // 0x02 marker are arbitrary — `readKeyFrame` only checks length
    // and the first-byte parity marker.
    const key = new Uint8Array(33);
    key[0] = 0x02;
    for (let i = 1; i < key.length; i++) key[i] = i & 0xff;
    await lp.write(key);
    // Read `a`'s answering key so the exchange completes before the
    // oversized frame reaches the receive loop.
    const list = await lp.read();
    expect(list.subarray().length).toBe(33);
    const over = new Uint8Array(FIPS_LINK_MTU + 1);
    try { await lp.write(over); } catch { /* far end may abort mid-write */ }
    await sleep(300);
    expect(stream.status === 'closed' || stream.status === 'aborted' || stream.status === 'reset').toBe(true);
  }, 10_000);

  it('a malformed key frame closes the stream', async () => {
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

  it('a stream from another peer naming a linked key is closed and the link stays up', async () => {
    // MESH_INTERFACE → FIPS → "A key holds one link, and the libp2p
    // peer that named it holds the key" — the held entry is never
    // displaced by another peer's stream naming the key. Keys are
    // generated so A's compressed key sorts higher than B's; the
    // simultaneous-open rule that would otherwise resolve the pair
    // (newOpenerKey vs heldOpenerKey) would then drop the held entry
    // in favour of the impostor's, so the held stream's status
    // distinguishes the displace-guard's behaviour from that rule.
    let idA: FipsIdentity | null = null;
    let idB: FipsIdentity | null = null;
    for (let i = 0; i < 128 && !(idA && idB); i++) {
      const left = await generateIdentity();
      const right = await generateIdentity();
      const leftHex = toHex(left.publicKey);
      const rightHex = toHex(right.publicKey);
      if (leftHex > rightHex) { idA = left; idB = right; }
      else if (rightHex > leftHex) { idA = right; idB = left; }
    }
    if (!idA || !idB) throw new Error('no ordered pair');
    a = await makePeer({ identity: idA });
    b = await makePeer({ identity: idB });
    const connAB = await dial(a.libp2p, b.libp2p);
    await a.transport.openLink(connAB).catch(() => { /* stub */ });
    await waitPeer(a.node, b.pubkeyHex, 2_000);
    const linkProtocol = fipsLinkProtocol('testnet');
    const heldAB = connAB.streams.find((s) => s.protocol === linkProtocol) ?? null;
    if (heldAB === null) throw new Error('A-B link stream not found on connAB');
    // A third libp2p peer C opens a link stream to A, writing B's FIPS key.
    raw = await makeLibp2p();
    const connCA = await dial(raw, a.libp2p);
    const stream: Stream = await connCA.newStream(linkProtocol);
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    try { await lp.write(b.identity.publicKey); } catch { /* far end may abort */ }
    await sleep(300);
    expect(
      a.transport.linkedKeys().includes(b.pubkeyHex)
        && heldAB.status === 'open'
        && stream.status !== 'open',
    ).toBe(true);
  }, 15_000);

  it('two ends opening at once keep one link, opened by the lower key', async () => {
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
    // Both ends keep one link — the lower-keyed opener's (A). Its
    // direction tells the end whose compressed key sorts lower from
    // the one whose sorts higher: the survivor on A is the stream A
    // opened (`outbound`), and on B the stream A opened (`inbound`).
    const linkProtocol = fipsLinkProtocol('testnet');
    const aLinkStreams = connAB.streams.filter((s) => s.protocol === linkProtocol);
    const bLinkStreams = connBA.streams.filter((s) => s.protocol === linkProtocol);
    expect(
      a.transport.linkedKeys().includes(b.pubkeyHex)
        && b.transport.linkedKeys().includes(a.pubkeyHex)
        && a.transport.linkedKeys().length === 1
        && b.transport.linkedKeys().length === 1
        && aLinkStreams.length === 1
        && bLinkStreams.length === 1
        && aLinkStreams[0]!.direction === 'outbound'
        && bLinkStreams[0]!.direction === 'inbound',
    ).toBe(true);
  }, 15_000);

  it("a newer stream from the same peer takes the link's place", async () => {
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

  it('a link not up in time is closed', async () => {
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

  it('closing the connection reports the key disconnected', async () => {
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

  // MESH_INTERFACE → FIPS → "A link is up once FIPS's own handshake over
  // it completes" — `onLinkChange` fires `up` on `linkUp`; MESH_INTERFACE
  // → FIPS → "A key holds one link, and the libp2p peer that named it
  // holds the key" — it fires `closed` when the entry is dropped (the
  // stream ends, the transport stops, `close(addr)`).
  it('onLinkChange reports up once and closed once for a link that forms and ends', async () => {
    a = await makePeer();
    b = await makePeer();
    const events: FipsLinkChange[] = [];
    const unsub = a.transport.onLinkChange((ev) => { events.push(ev); });
    const conn = await dial(a.libp2p, b.libp2p);
    await a.transport.openLink(conn).catch(() => { /* stub */ });
    await waitFor(
      () => events.some((e) => e.state === 'up' && e.remoteKeyHex === b!.pubkeyHex),
      3_000,
    );
    await conn.close();
    await waitFor(
      () => events.some((e) => e.state === 'closed' && e.remoteKeyHex === b!.pubkeyHex),
      3_000,
    );
    const bPeer = b.libp2p.peerId.toString();
    const forB = events.filter((e) => e.remoteKeyHex === b!.pubkeyHex);
    expect(forB).toEqual([
      { remoteKeyHex: b.pubkeyHex, remotePeer: bPeer, state: 'up' },
      { remoteKeyHex: b.pubkeyHex, remotePeer: bPeer, state: 'closed' },
    ]);
    unsub();
    const beforeLen = events.length;
    const conn2 = await dial(a.libp2p, b.libp2p, true);
    await a.transport.openLink(conn2).catch(() => { /* stub */ });
    await waitPeer(a.node, b.pubkeyHex, 3_000);
    await sleep(300);
    expect(events.length).toBe(beforeLen);
  }, 20_000);

  it('linkPeers names the up link\'s libp2p peer', async () => {
    a = await makePeer();
    b = await makePeer();
    expect(a.transport.linkPeers()).toEqual([]);
    const conn = await dial(a.libp2p, b.libp2p);
    await a.transport.openLink(conn).catch(() => { /* stub */ });
    const up = await waitFor(() => a!.transport.linkPeers().length === 1, 3_000);
    expect(up).toBe(true);
    expect(a.transport.linkPeers()).toEqual([
      { remoteKeyHex: b.pubkeyHex, remotePeer: b.libp2p.peerId.toString() },
    ]);
    await conn.close();
    await waitFor(() => a!.transport.linkPeers().length === 0, 3_000);
    expect(a.transport.linkPeers()).toEqual([]);
  }, 20_000);

  // MESH_INTERFACE → FIPS → "A link is up once FIPS's own handshake over
  // it completes" — an entry is held pending until FIPS's own handshake
  // completes; before that, `linkPeers()` names nothing. The reader's
  // gater reads `linkPeers().length > 0` as "a link is up", so a pending
  // entry must not open the gate.
  it('linkPeers names no link that is not up yet', async () => {
    // A long hint timeout so the pending entry outlives this case; a raw
    // libp2p peer writes a valid 33-byte compressed key for an identity
    // whose secret it does not hold, so A's answerer holds the stream
    // (the entry is held) but fips-ts's FMP handshake over it never
    // completes and `linkUp` never fires.
    a = await makePeer({ hintTimeoutMs: 10_000 });
    raw = await makeLibp2p();
    const conn = await dial(raw, a.libp2p);
    const stream: Stream = await conn.newStream(fipsLinkProtocol('testnet'));
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    const fresh = await generateIdentity();
    await lp.write(fresh.publicKey);
    // A's answering key proves A has held the stream; the entry is in
    // `links` and still pending.
    const answer = await lp.read();
    expect(answer.subarray().length).toBe(33);
    expect(a.transport.linkPeers()).toEqual([]);
    expect(a.transport.linkedKeys()).toEqual([]);
  }, 15_000);

  it('an ended link is reopened over a connection still held', async () => {
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

  it('a link carries more than four mebibytes each way and stays up', async () => {
    a = await makePeer();
    b = await makePeer();
    const conn = await dial(a.libp2p, b.libp2p);
    await a.transport.openLink(conn).catch(() => { /* stub */ });
    await waitPeer(a.node, b.pubkeyHex, 3_000);
    // Send enough datagrams in each direction to exceed four mebibytes.
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const N = 4_300;
    let aRx = 0;
    let bRx = 0;
    const portAB = 42;
    const portBA = 43;
    b.node.on('datagram', (data) => {
      const ev = data as DatagramEvent;
      if (ev.dstPort === portAB) bRx += 1;
    });
    a.node.on('datagram', (data) => {
      const ev = data as DatagramEvent;
      if (ev.dstPort === portBA) aRx += 1;
    });
    const sendLoop = async (sender: Peer, dst: string, port: number): Promise<void> => {
      for (let i = 0; i < N; i++) {
        try { await sender.node.sendDatagram({ dst, dstPort: port, payload }); }
        catch { /* measured by the assertion */ }
      }
    };
    await Promise.all([
      sendLoop(a, b.pubkeyHex, portAB),
      sendLoop(b, a.pubkeyHex, portBA),
    ]);
    for (let i = 0; i < 100; i++) {
      if (aRx >= N - 200 && bRx >= N - 200) break;
      await sleep(100);
    }
    // After exchanging more than 4 MiB in each direction (1024 bytes × 4300),
    // the link still holds and a large share of datagrams arrived.
    expect(
      a.transport.linkedKeys().includes(b.pubkeyHex)
        && b.transport.linkedKeys().includes(a.pubkeyHex)
        && aRx >= N - 200
        && bRx >= N - 200,
    ).toBe(true);
  }, 120_000);

  it('a peer that refuses the link protocol is tried again with a growing wait', async () => {
    a = await makePeer({ retryBaseMs: 100, retryCapMs: 10_000, random: () => 1 });
    raw = await makeLibp2p();
    // `raw` runs a handler that counts each inbound link stream and
    // aborts it at once. Every openLink attempt from A lands here before
    // falling through markFailure and the next retry.
    const times: number[] = [];
    await raw.handle(fipsLinkProtocol('testnet'), (stream: Stream) => {
      times.push(Date.now());
      try { stream.abort(new Error('refused')); } catch { /* already */ }
    }, { maxInboundStreams: 32 });
    const conn = await dial(a.libp2p, raw);
    await a.transport.openLink(conn).catch(() => { /* fires the retry chain */ });
    // With random=1, the waits are f=1 100 ms, f=2 200 ms, f=3 400 ms.
    // 900 ms leaves headroom for a fourth attempt plus fuzz.
    await sleep(900);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
    expect(times.length >= 3 && gaps.length >= 2 && gaps[1]! > gaps[0]!).toBe(true);
  }, 10_000);

  it('the retry count resets once a link comes up', async () => {
    a = await makePeer({ retryBaseMs: 200, retryCapMs: 10_000, random: () => 1 });
    b = await makePeer();
    // Strip B's inbound handler so A's early attempts fail at the
    // protocol layer and the opener's failure count grows.
    await b.libp2p.unhandle(fipsLinkProtocol('testnet'));
    // Two libp2p connections so the retries have somewhere to land.
    const conns: Connection[] = [];
    conns.push(await dial(a.libp2p, b.libp2p));
    conns.push(await dial(a.libp2p, b.libp2p, true));
    // Shadow each conn's newStream to record every opener attempt.
    const attempts: { at: number; conn: Connection }[] = [];
    for (const c of conns) {
      const cAny = c as unknown as { newStream: (...args: unknown[]) => Promise<unknown> };
      const orig = cAny.newStream.bind(c);
      cAny.newStream = ((p: unknown, o?: unknown) => {
        attempts.push({ at: Date.now(), conn: c });
        return orig(p, o);
      }) as typeof cAny.newStream;
    }
    await a.transport.openLink(conns[0]!).catch(() => { /* fails */ });
    // Let two or three failures pile up before B starts answering.
    await sleep(700);
    // Now re-register B's handler so the next retry succeeds and `linkUp`
    // resets the opener's failure count.
    await b.transport.attach(b.libp2p);
    // Wait for FMP to complete.
    for (let i = 0; i < 60; i++) {
      if (a.transport.linkedKeys().includes(b.pubkeyHex)) break;
      await sleep(100);
    }
    const linkedAttemptIndex = attempts.length - 1;
    const connAtSuccess = attempts[linkedAttemptIndex]!.conn;
    const closeAt = Date.now();
    await connAtSuccess.close().catch(() => { /* already */ });
    // Wait for the next retry's opener attempt.
    for (let i = 0; i < 60 && attempts.length <= linkedAttemptIndex + 1; i++) {
      await sleep(50);
    }
    const nextAttempt = attempts[linkedAttemptIndex + 1];
    // random=1: first failure waits `retryBaseMs` (whole = half*2). A reset
    // after linkUp makes this the first failure; without a reset, the
    // count would have climbed to three and the wait would be `retryBaseMs
    // * 2^3` = 1 600 ms.
    const gap = nextAttempt ? nextAttempt.at - closeAt : -1;
    expect(linkedAttemptIndex >= 2 && gap >= 100 && gap <= 500).toBe(true);
  }, 20_000);

  it('a stream that names one key but proves another never comes up', async () => {
    a = await makePeer({ hintTimeoutMs: 400 });
    raw = await makeLibp2p();
    // The raw libp2p peer writes identity X's compressed key as its first
    // frame but holds no FIPS secret for X — fips-ts's own FMP handshake
    // on A's answering side cannot complete because the far end can prove
    // nothing. (fips-ts has no API for one identity to speak as another on
    // a chosen transport, so the test uses the closest arrangement: a raw
    // peer naming a key it does not hold.)
    const x = await generateIdentity();
    const xHex = toHex(x.publicKey);
    const conn = await dial(raw, a.libp2p);
    const stream: Stream = await conn.newStream(fipsLinkProtocol('testnet'));
    const lp = lpStream(stream, { maxDataLength: FIPS_LINK_MTU });
    await lp.write(x.publicKey);
    // Past the hint timeout, the stream closes and no link for X is up.
    await sleep(700);
    const linked = a.transport.linkedKeys();
    const closed = stream.status !== 'open';
    expect(linked.includes(xHex) === false && closed).toBe(true);
  }, 10_000);
});
