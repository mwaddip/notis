// MESH_INTERFACE → FIPS → "libp2p runs over a TCP/FIPS stream" — the libp2p
// transport that carries libp2p connections over `@fips/tcp` streams on
// `FIPS_SERVICE_PORT`. Two libp2p nodes over TCP, each with a `FipsNode`
// linked by `LibP2pLinkTransport` and a `FipsTcpEndpoint`; the second
// also listens on `/fips` through `fipsTransport`.

import { afterEach, describe, expect, it } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { multiaddr } from '@multiformats/multiaddr';
import type { Connection } from '@libp2p/interface';
import {
  FipsNode,
  generateIdentity,
  toHex,
  type FipsIdentity,
  type PeerEvent,
} from '@fips/core';
import { FipsTcpEndpoint } from '@fips/tcp';
import { LibP2pLinkTransport } from '../../src/mesh/fips-link.js';
import {
  fipsDatagramEndpoint,
  fipsTransport,
  FipsTransportDialError,
} from '../../src/mesh/fips-transport.js';
import { fipsMultiaddr, registerFipsProtocol } from '../../src/mesh/fips-addr.js';
import { npubOf } from '../../src/mesh/fips-identity.js';
import {
  FIPS_SERVICE_PORT,
  FIPS_TCP_POLL_MS,
  FIPS_TCP_SEND_BUFFER_BYTES,
  FIPS_TCP_CONNECTIONS_PER_PEER,
} from '../../src/mesh/constants.js';

registerFipsProtocol();

interface Peer {
  identity: FipsIdentity;
  libp2p: Libp2p;
  node: FipsNode;
  link: LibP2pLinkTransport;
  endpoint: FipsTcpEndpoint;
  endpointRef: { current: FipsTcpEndpoint | null };
  pollTimer: ReturnType<typeof setInterval>;
  pubkeyHex: string;
  listenFipsAddr: string | null;
}

async function makePeer(options: {
  dial: boolean;
  pollMs?: number;
  listen?: boolean;
  identity?: FipsIdentity;
}): Promise<Peer> {
  const identity = options.identity ?? await generateIdentity();
  let node!: FipsNode;
  const link = new LibP2pLinkTransport({
    network: 'testnet',
    connectPeer: async (addr) => node.connect(addr),
    hintTimeoutMs: 2_000,
    retryBaseMs: 50,
    retryCapMs: 1_000,
    random: () => 0.5,
  });
  node = new FipsNode({ identity, transports: [link], forwarding: true });
  node.on('peer', (data) => {
    const ev = data as PeerEvent;
    if (ev.state === 'connected') link.linkUp(ev.remotePubkey);
  });
  await node.start();

  const { datagrams, onActivity } = fipsDatagramEndpoint(node);
  const endpoint = new FipsTcpEndpoint(datagrams, FIPS_SERVICE_PORT, {
    sendBuffer: FIPS_TCP_SEND_BUFFER_BYTES,
    maxConnectionsPerPeer: FIPS_TCP_CONNECTIONS_PER_PEER,
  });
  const endpointRef: { current: FipsTcpEndpoint | null } = { current: endpoint };

  const listenAddrs: string[] = ['/ip4/127.0.0.1/tcp/0'];
  let listenFipsAddr: string | null = null;
  if (options.listen === true) {
    listenFipsAddr = `/fips/${npubOf(identity)}`;
    listenAddrs.push(listenFipsAddr);
  }

  const libp2p = await createLibp2p({
    addresses: { listen: listenAddrs },
    transports: [
      tcp(),
      fipsTransport({
        endpoint: () => endpointRef.current,
        localXOnly: () => identity.xOnlyPubkey,
        dial: options.dial,
        onActivity,
      }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ping: ping() },
  });

  await link.attach(libp2p);

  const pollMs = options.pollMs ?? FIPS_TCP_POLL_MS;
  const pollTimer = setInterval(() => {
    void endpoint.poll().catch(() => { /* a stopped endpoint rejects */ });
  }, pollMs);

  return {
    identity,
    libp2p,
    node,
    link,
    endpoint,
    endpointRef,
    pollTimer,
    pubkeyHex: toHex(identity.publicKey),
    listenFipsAddr,
  };
}

async function tcpAddress(peer: Libp2p): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const match = peer.getMultiaddrs().map((m) => m.toString())
      .find((s) => s.includes('/tcp/') && !s.includes('/fips/'));
    if (match !== undefined) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no tcp address');
}

async function dialTcp(from: Libp2p, to: Libp2p, force = false): Promise<Connection> {
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

async function waitLink(peer: Peer, remoteKeyHex: string, deadlineMs: number): Promise<boolean> {
  return waitFor(() => peer.link.linkedKeys().includes(remoteKeyHex), deadlineMs);
}

async function stopPeer(p: Peer): Promise<void> {
  clearInterval(p.pollTimer);
  try { await p.libp2p.stop(); } catch { /* already */ }
  p.endpointRef.current = null;
  try { await p.endpoint.dispose(); } catch { /* already */ }
  try { await p.node.stop(); } catch { /* already */ }
}

describe('MESH_INTERFACE → FIPS: fipsTransport', () => {
  let a: Peer | null = null;
  let b: Peer | null = null;
  let c: Peer | null = null;

  afterEach(async () => {
    if (a) await stopPeer(a);
    if (b) await stopPeer(b);
    if (c) await stopPeer(c);
    a = null; b = null; c = null;
  });

  it('a dial to the listener FIPS address answers a libp2p connection to its peer id', async () => {
    a = await makePeer({ dial: true });
    b = await makePeer({ dial: false, listen: true });
    const linkConn = await dialTcp(a.libp2p, b.libp2p);
    await a.link.openLink(linkConn).catch(() => { /* stub */ });
    await waitLink(a, b.pubkeyHex, 3_000);
    const fipsMa = fipsMultiaddr(b.identity.xOnlyPubkey, b.libp2p.peerId.toString());
    const conn = await a.libp2p.dial(fipsMa, { force: true, signal: AbortSignal.timeout(10_000) } as unknown as never)
      .catch(() => null);
    const peerId = conn === null ? null : conn.remotePeer.toString();
    const addr = conn === null ? '' : conn.remoteAddr.toString();
    expect(peerId === b.libp2p.peerId.toString() && addr.includes('/fips/')).toBe(true);
  }, 30_000);

  it('a ping crosses the FIPS libp2p connection', async () => {
    a = await makePeer({ dial: true });
    b = await makePeer({ dial: false, listen: true });
    const linkConn = await dialTcp(a.libp2p, b.libp2p);
    await a.link.openLink(linkConn).catch(() => { /* stub */ });
    await waitLink(a, b.pubkeyHex, 3_000);
    const fipsMa = fipsMultiaddr(b.identity.xOnlyPubkey, b.libp2p.peerId.toString());
    const conn = await a.libp2p.dial(fipsMa, { force: true, signal: AbortSignal.timeout(10_000) } as unknown as never)
      .catch(() => null);
    const addrFips = conn !== null && conn.remoteAddr.toString().includes('/fips/');
    let latency: number | null = null;
    if (conn !== null) {
      const stream = await conn.newStream('/ipfs/ping/1.0.0').catch(() => null);
      if (stream !== null) {
        const t0 = Date.now();
        const probe = new Uint8Array(32);
        for (let i = 0; i < probe.length; i++) probe[i] = i;
        stream.send(probe);
        for await (const chunk of stream) {
          void chunk;
          latency = Date.now() - t0;
          break;
        }
        await stream.close().catch(() => { /* already */ });
      }
    }
    expect(addrFips && typeof latency === 'number').toBe(true);
  }, 30_000);

  it('a 200 000-byte stream over the FIPS connection arrives whole', async () => {
    a = await makePeer({ dial: true });
    b = await makePeer({ dial: false, listen: true });
    const linkConn = await dialTcp(a.libp2p, b.libp2p);
    await a.link.openLink(linkConn).catch(() => { /* stub */ });
    await waitLink(a, b.pubkeyHex, 3_000);
    const BULK = '/notis-test/fips-bulk/1.0.0';
    const payload = new Uint8Array(200_000);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    let received: Uint8Array | null = null;
    await b.libp2p.handle(BULK, async (stream) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk.subarray());
      }
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      received = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { received.set(c, off); off += c.byteLength; }
    });
    const fipsMa = fipsMultiaddr(b.identity.xOnlyPubkey, b.libp2p.peerId.toString());
    const conn = await a.libp2p.dial(fipsMa, { force: true, signal: AbortSignal.timeout(10_000) } as unknown as never)
      .catch(() => null);
    const addrFips = conn !== null && conn.remoteAddr.toString().includes('/fips/');
    if (conn !== null) {
      try {
        const stream = await conn.newStream(BULK);
        stream.send(payload);
        await stream.close();
      } catch { /* stub */ }
    }
    for (let i = 0; i < 300 && received === null; i++) await sleep(50);
    const equal = received !== null
      && (received as Uint8Array).byteLength === payload.byteLength
      && (received as Uint8Array).every((v, i) => v === payload[i]);
    expect(addrFips && equal).toBe(true);
  }, 60_000);

  it('closing the FIPS connection ends the TCP/FIPS stream on both sides', async () => {
    a = await makePeer({ dial: true });
    b = await makePeer({ dial: false, listen: true });
    const linkConn = await dialTcp(a.libp2p, b.libp2p);
    await a.link.openLink(linkConn).catch(() => { /* stub */ });
    await waitLink(a, b.pubkeyHex, 3_000);
    const fipsMa = fipsMultiaddr(b.identity.xOnlyPubkey, b.libp2p.peerId.toString());
    const conn = await a.libp2p.dial(fipsMa, { force: true, signal: AbortSignal.timeout(10_000) } as unknown as never)
      .catch(() => null);
    const aFipsBefore = a.libp2p.getConnections(b.libp2p.peerId)
      .some((c) => c.remoteAddr.toString().includes('/fips/'));
    if (conn !== null) await conn.close().catch(() => { /* already */ });
    await sleep(500);
    const aFipsAfter = a.libp2p.getConnections(b.libp2p.peerId)
      .some((c) => c.remoteAddr.toString().includes('/fips/'));
    const bFipsAfter = b.libp2p.getConnections(a.libp2p.peerId)
      .some((c) => c.remoteAddr.toString().includes('/fips/'));
    expect(aFipsBefore && !aFipsAfter && !bFipsAfter).toBe(true);
  }, 30_000);

  it('a dial with no endpoint fails with a named error', async () => {
    a = await makePeer({ dial: true });
    // No listener side built; the dial still fails because A's local endpoint
    // is cleared before the dial.
    a.endpointRef.current = null;
    const bIdentity = await generateIdentity();
    const fakePeerId = (await makePeer({ dial: false })).libp2p.peerId.toString();
    const fipsMa = fipsMultiaddr(bIdentity.xOnlyPubkey, fakePeerId);
    const err = await a.libp2p.dial(fipsMa, { signal: AbortSignal.timeout(5_000) })
      .then(() => null)
      .catch((e: Error) => e);
    // The dial error carries a FipsTransportDialError in its cause chain, or
    // the error itself is one.
    const looks = err !== null
      && (err instanceof FipsTransportDialError
        || /** @type {Error} */ (err).message.includes('FipsTransportDialError')
        || (err as Error).name === 'FipsTransportDialError');
    expect(looks).toBe(true);
  }, 15_000);

  it('a non-FIPS address is filtered out of a node transport', async () => {
    const identity = await generateIdentity();
    const transportFactory = fipsTransport({
      endpoint: () => null,
      localXOnly: () => identity.xOnlyPubkey,
      dial: true,
      onActivity: () => () => { /* no subscriber */ },
    });
    const log = {
      forComponent: () => Object.assign(
        (..._: unknown[]) => { /* silent */ },
        { error: (..._: unknown[]) => { /* silent */ }, trace: (..._: unknown[]) => { /* silent */ } },
      ),
    } as unknown as Parameters<typeof transportFactory>[0];
    const transport = transportFactory(log);
    const ma = multiaddr('/ip4/127.0.0.1/udp/1234/webrtc-direct');
    const kept = transport.dialFilter([ma]);
    expect(kept.length).toBe(0);
  }, 10_000);

  it('a transport built with dial false dials nothing', async () => {
    const identity = await generateIdentity();
    const transportFactory = fipsTransport({
      endpoint: () => null,
      localXOnly: () => identity.xOnlyPubkey,
      dial: false,
      onActivity: () => () => { /* no subscriber */ },
    });
    const log = {
      forComponent: () => Object.assign(
        (..._: unknown[]) => { /* silent */ },
        { error: (..._: unknown[]) => { /* silent */ }, trace: (..._: unknown[]) => { /* silent */ } },
      ),
    } as unknown as Parameters<typeof transportFactory>[0];
    const transport = transportFactory(log);
    const other = await generateIdentity();
    const peerId = '12D3KooWBhvoYgPHrAtwiBXcsnwGPrfhXAR9n1Cxj5E6o7qFmp7G';
    const kept = transport.dialFilter([fipsMultiaddr(other.xOnlyPubkey, peerId)]);
    expect(kept.length).toBe(0);
  }, 10_000);

  it('a peer third FIPS connection is refused', async () => {
    a = await makePeer({ dial: true });
    b = await makePeer({ dial: false, listen: true });
    const linkConn = await dialTcp(a.libp2p, b.libp2p);
    await a.link.openLink(linkConn).catch(() => { /* stub */ });
    await waitLink(a, b.pubkeyHex, 3_000);
    const fipsMa = fipsMultiaddr(b.identity.xOnlyPubkey, b.libp2p.peerId.toString());
    const c1 = await a.libp2p.dial(fipsMa, { force: true, signal: AbortSignal.timeout(10_000) } as unknown as never)
      .catch(() => null);
    const c2 = await a.libp2p.dial(fipsMa, { force: true, signal: AbortSignal.timeout(10_000) } as unknown as never)
      .catch(() => null);
    const c1IsFips = c1 !== null && c1.remoteAddr.toString().includes('/fips/');
    const c2IsFips = c2 !== null && c2.remoteAddr.toString().includes('/fips/');
    const third = await a.libp2p.dial(fipsMa, { force: true, signal: AbortSignal.timeout(10_000) } as unknown as never)
      .then(() => null)
      .catch((e: Error) => e);
    expect(c1IsFips && c2IsFips && third instanceof Error).toBe(true);
  }, 30_000);

  it('a FIPS stream read wakes on its datagram and not at the next poll', async () => {
    // A long poll interval: a wake that works runs well under it.
    a = await makePeer({ dial: true, pollMs: 10_000 });
    b = await makePeer({ dial: false, listen: true, pollMs: 10_000 });
    const linkConn = await dialTcp(a.libp2p, b.libp2p);
    await a.link.openLink(linkConn).catch(() => { /* stub */ });
    await waitLink(a, b.pubkeyHex, 3_000);
    const PROTO = '/notis-test/fips-echo/1.0.0';
    await b.libp2p.handle(PROTO, async (stream) => {
      // Echo the first chunk back.
      for await (const chunk of stream) {
        stream.send(chunk.subarray());
        break;
      }
      await stream.close().catch(() => { /* already */ });
    });
    const fipsMa = fipsMultiaddr(b.identity.xOnlyPubkey, b.libp2p.peerId.toString());
    const conn = await a.libp2p.dial(fipsMa, { force: true, signal: AbortSignal.timeout(5_000) } as unknown as never)
      .catch(() => null);
    const addrFips = conn !== null && conn.remoteAddr.toString().includes('/fips/');
    let roundTrip: number | null = null;
    if (conn !== null) {
      try {
        const stream = await conn.newStream(PROTO);
        const t0 = Date.now();
        stream.send(new Uint8Array([1, 2, 3, 4]));
        for await (const chunk of stream) {
          void chunk;
          roundTrip = Date.now() - t0;
          break;
        }
      } catch { /* stub */ }
    }
    // The poll is 10 000 ms; a working wake lands in well under 2 000 ms.
    expect(addrFips && typeof roundTrip === 'number' && roundTrip < 2_000).toBe(true);
  }, 30_000);

  it('the FIPS listener reports no address and libp2p announces none', async () => {
    b = await makePeer({ dial: false, listen: true });
    // Give identify/listener startup a beat.
    await sleep(200);
    const announced = b.libp2p.getMultiaddrs().map((m) => m.toString());
    const anyFips = announced.some((s) => s.includes('/fips/'));
    expect(anyFips).toBe(false);
  }, 15_000);

  it.fails('a datagram from one peer wakes that peer connection alone', async () => {
    c = await makePeer({ dial: false, listen: true });
    const counts = new Map<number, number>();
    const idPeers = new Map<number, string>();
    const real = c.endpoint;
    const wrapped = new Proxy(real, {
      get(target, prop, _recv) {
        if (prop === 'read') {
          return async (id: number, max: number, now?: number) => {
            counts.set(id, (counts.get(id) ?? 0) + 1);
            return target.read(id, max, now);
          };
        }
        if (prop === 'accept') {
          return async () => {
            const id = await target.accept();
            if (id !== undefined) {
              const p = await target.peer(id).catch(() => undefined);
              if (p !== undefined) idPeers.set(id, p);
            }
            return id;
          };
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof v === 'function') return (v as (...args: unknown[]) => unknown).bind(target);
        return v;
      },
    }) as FipsTcpEndpoint;
    c.endpointRef.current = wrapped;

    a = await makePeer({ dial: true });
    b = await makePeer({ dial: true });

    const linkA = await dialTcp(a.libp2p, c.libp2p);
    await a.link.openLink(linkA).catch(() => { /* stub */ });
    const linkB = await dialTcp(b.libp2p, c.libp2p);
    await b.link.openLink(linkB).catch(() => { /* stub */ });
    await waitLink(a, c.pubkeyHex, 3_000);
    await waitLink(b, c.pubkeyHex, 3_000);

    const PROTO = '/notis-test/fips-echo/1.0.0';
    await c.libp2p.handle(PROTO, async (stream) => {
      for await (const chunk of stream) {
        stream.send(chunk.subarray());
      }
    });

    const fipsMa = fipsMultiaddr(c.identity.xOnlyPubkey, c.libp2p.peerId.toString());
    const connA = await a.libp2p.dial(fipsMa, { force: true, signal: AbortSignal.timeout(10_000) } as unknown as never)
      .catch(() => null);
    const connB = await b.libp2p.dial(fipsMa, { force: true, signal: AbortSignal.timeout(10_000) } as unknown as never)
      .catch(() => null);
    const bothUp = connA !== null
      && connB !== null
      && connA.remoteAddr.toString().includes('/fips/')
      && connB.remoteAddr.toString().includes('/fips/');

    // Let any identify / handshake traffic settle before baselining.
    await sleep(400);
    const aXHex = toHex(a.identity.xOnlyPubkey);
    const bXHex = toHex(b.identity.xOnlyPubkey);
    let idA = -1;
    let idB = -1;
    for (const [id, p] of idPeers) {
      if (p.length === 66 && p.slice(2) === aXHex) idA = id;
      if (p.length === 66 && p.slice(2) === bXHex) idB = id;
    }
    const baseA = counts.get(idA) ?? 0;
    const baseB = counts.get(idB) ?? 0;

    // 50 KiB from A only; the echo doubles the traffic on A's path and
    // leaves B's idle.
    let echoed = 0;
    if (connA !== null) {
      const stream = await connA.newStream(PROTO).catch(() => null);
      if (stream !== null) {
        const payload = new Uint8Array(50_000);
        for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
        stream.send(payload);
        try {
          for await (const chunk of stream) {
            echoed += chunk.subarray().byteLength;
            if (echoed >= payload.byteLength) break;
          }
        } catch { /* stub */ }
        await stream.close().catch(() => { /* already */ });
      }
    }
    await sleep(300);
    const deltaA = (counts.get(idA) ?? 0) - baseA;
    const deltaB = (counts.get(idB) ?? 0) - baseB;
    expect(bothUp && idA >= 0 && idB >= 0 && deltaA > 20 && deltaB <= 5).toBe(true);
  }, 45_000);
});
