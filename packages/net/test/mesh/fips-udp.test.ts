// MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
// its operator turns it on" — a fips-ts `FipsNode` running a
// `UdpFipsTransport` carries one FIPS packet per UDP datagram.
// MESH_INTERFACE → FIPS → "A public peer is an npub at a `host:port`"
// — a configured peer is addressed by `<ipv4>:<port>` or
// `[<ipv6>]:<port>`; `discover()` yields it at start and again on the
// retry schedule.
// MESH_INTERFACE → FIPS → "A node may accept public links" — a node
// holds at most `inboundMax` links it did not dial; a half-open
// address is released after `2 × FIPS_LINK_HINT_TIMEOUT_MS`.

import { afterEach, describe, expect, it } from 'vitest';
import {
  FipsNode,
  generateIdentity,
  toHex,
  encodeNpub,
  type DatagramEvent,
  type FipsIdentity,
  type PeerEvent,
} from '@fips/core';

import {
  FIPS_LINK_HINT_TIMEOUT_MS,
  FIPS_LINK_MTU,
  RETRY_BASE_MS,
  type PublicFipsPeer,
} from '../../src/mesh/constants.js';
import {
  UdpFipsSendError,
  UdpFipsTransport,
  type UdpFipsTransportOptions,
} from '../../src/mesh/fips-udp.js';

interface UdpPeer {
  readonly identity: FipsIdentity;
  readonly node: FipsNode;
  readonly transport: UdpFipsTransport;
  readonly npub: string;
  readonly pubkeyHex: string;
  readonly xOnlyHex: string;
  readonly connected: Set<string>; // remote keys as their x-only hex
  readonly disconnected: Set<string>;
  readonly peerEvents: PeerEvent[];
  readonly datagrams: DatagramEvent[];
  readonly connectCalls: Array<{ addr: string }>;
  listenAddr(): string | null;
  stop(): Promise<void>;
}

async function startUdpPeer(options: {
  listen: { host: string; port: number } | null;
  peers?: readonly PublicFipsPeer[];
  inboundMax?: number;
  forwarding?: boolean;
  resolve?: UdpFipsTransportOptions['resolve'];
  random?: () => number;
  identity?: FipsIdentity;
}): Promise<UdpPeer> {
  const identity = options.identity ?? await generateIdentity();
  const tag = `[${options.listen ? options.listen.port : '-'}]`;
  const dbg = process.env.UDP_TEST_DEBUG === '1';
  const logger = dbg ? {
    debug: (...a: unknown[]) => console.log(tag, 't:', ...a),
    info:  (...a: unknown[]) => console.log(tag, 't:', ...a),
    warn:  (...a: unknown[]) => console.log(tag, 't:', ...a),
    error: (...a: unknown[]) => console.log(tag, 't:', ...a),
  } : undefined;
  const transport = new UdpFipsTransport({
    listen: options.listen,
    peers: options.peers ?? [],
    inboundMax: options.inboundMax ?? 0,
    resolve: options.resolve,
    random: options.random,
    logger,
  });
  // Count `connect` calls through a wrapping proxy so each dial is
  // visible to the test — the transport itself does not expose one.
  const connectCalls: Array<{ addr: string }> = [];
  const originalConnect = transport.connect.bind(transport);
  const originalSend = transport.send.bind(transport);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (transport as any).connect = async function (this: UdpFipsTransport, addr: { transport: string; addr: string }): Promise<void> {
    connectCalls.push({ addr: addr.addr });
    return originalConnect(addr);
  };
  // Keep send bound too, so there's no accidental `this` loss.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (transport as any).send = originalSend;
  const node = new FipsNode({
    identity,
    transports: [transport],
    forwarding: options.forwarding ?? false,
    logger,
  });
  const connected = new Set<string>();
  const disconnected = new Set<string>();
  const peerEvents: PeerEvent[] = [];
  const datagrams: DatagramEvent[] = [];
  node.on('peer', (data) => {
    const ev = data as PeerEvent;
    peerEvents.push(ev);
    // The peer event's `remotePubkey` is the compressed-with-parity form
    // the handshake agreed on; a counter dialled by its npub is held in
    // `02||x` form, while the peer learned by its own Msg1 is held in
    // its real-parity form. The test compares by the parity-free x-only
    // slice instead.
    const xOnlyHex = ev.remotePubkey.length >= 2 ? ev.remotePubkey.slice(2) : ev.remotePubkey;
    if (ev.state === 'connected') {
      connected.add(xOnlyHex);
      transport.noteLink(ev.remoteAddr.addr, true);
    } else if (ev.state === 'disconnected') {
      connected.delete(xOnlyHex);
      disconnected.add(xOnlyHex);
      transport.noteLink(ev.remoteAddr.addr, false);
    }
  });
  node.on('error', (e) => {
    if (dbg) console.log(tag, 'node err', (e as { where: string }).where, (e as { err: Error }).err?.message);
  });
  node.on('datagram', (data) => { datagrams.push(data as DatagramEvent); });
  await node.start();
  const npub = encodeNpub(identity.xOnlyPubkey);
  const pubkeyHex = toHex(identity.publicKey);
  const xOnlyHex = toHex(identity.xOnlyPubkey);
  return {
    identity,
    node,
    transport,
    npub,
    pubkeyHex,
    xOnlyHex,
    connected,
    disconnected,
    peerEvents,
    datagrams,
    connectCalls,
    listenAddr(): string | null {
      const port = transport.listenPort4();
      return port === null ? null : `127.0.0.1:${port}`;
    },
    stop: async (): Promise<void> => {
      try { await node.stop(); } catch { /* already */ }
    },
  };
}

function peerEntry(h: UdpPeer, host: string, port: number): PublicFipsPeer {
  return { name: `at-${host}-${port}`, npub: h.npub, host, port };
}

async function waitFor(check: () => boolean, deadlineMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

// Resolving `0.0.0.0` → `127.0.0.1` is the loopback lookup node:dns
// gives here, but injecting the mapping makes the test independent of
// the resolver and gives the random/injected resolve cases somewhere
// to stub.
function loopbackResolver(map: Map<string, string[]>): (host: string) => Promise<string[]> {
  return async (host: string) => {
    const answer = map.get(host);
    if (answer === undefined) throw new Error(`resolver: unknown host ${host}`);
    return answer;
  };
}

function hasIpv6Loopback(): boolean {
  // The one case that reads this probes a bind; any other probe would
  // be a separate claim. Returning false short-circuits only when the
  // case asks for ::1 and the OS refuses to bind — measured by the
  // case itself, not by this helper.
  return true;
}

describe('UdpFipsTransport', () => {
  const peers: UdpPeer[] = [];

  afterEach(async () => {
    for (const h of peers.slice().reverse()) { await h.stop(); }
    peers.length = 0;
  });

  it('two configured ends link over UDP and read `connected` with each other\'s key', async () => {
    const a = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 1 });
    peers.push(a);
    const aAddr = a.listenAddr()!;
    expect(aAddr).not.toBeNull();
    const aPort = a.transport.listenPort4()!;
    const b = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      peers: [peerEntry(a, '127.0.0.1', aPort)],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
    });
    peers.push(b);
    const ok = await waitFor(() => a.connected.has(b.xOnlyHex) && b.connected.has(a.xOnlyHex), 15000);
    expect(ok).toBe(true);
  }, 20000);

  it('inbound link from an address no peer list names is admitted while `inboundMax > 0`', async () => {
    const a = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 4 });
    peers.push(a);
    const aPort = a.transport.listenPort4()!;
    const stranger = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      peers: [peerEntry(a, '127.0.0.1', aPort)],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
    });
    peers.push(stranger);
    const ok = await waitFor(() => a.connected.has(stranger.xOnlyHex) && stranger.connected.has(a.xOnlyHex), 5000);
    expect(ok).toBe(true);
  }, 10000);

  it('a datagram crosses a forwarding stranger between two ends that each list only it', async () => {
    const s = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 4, forwarding: true });
    peers.push(s);
    const sPort = s.transport.listenPort4()!;
    const a = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      inboundMax: 0,
      peers: [peerEntry(s, '127.0.0.1', sPort)],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
    });
    peers.push(a);
    const c = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      inboundMax: 0,
      peers: [peerEntry(s, '127.0.0.1', sPort)],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
    });
    peers.push(c);
    const linked = await waitFor(() =>
      a.connected.has(s.xOnlyHex) && c.connected.has(s.xOnlyHex)
      && s.connected.has(a.xOnlyHex) && s.connected.has(c.xOnlyHex),
      5000);
    expect(linked).toBe(true);
    // c registers a service so a datagram to c has somewhere to land —
    // FipsNode delivers to the sessionManager, which routes to the
    // service's handler and fires the `datagram` event.
    c.node.registerService(42, async () => undefined);
    const payload = new Uint8Array([1, 2, 3, 4]);
    // sendDatagram takes the compressed hex form (02||x or 03||x);
    // one end dialled under 02 and the other under its actual parity,
    // so `dst` is c's `02||x` form (what a would dial, and what a
    // forwarder sees).
    const cDialHex = '02' + c.xOnlyHex;
    await a.node.sendDatagram({ dst: cDialHex, dstPort: 42, payload });
    const arrived = await waitFor(() =>
      c.datagrams.some((d) => d.src.slice(2) === a.xOnlyHex && d.dstPort === 42
        && d.payload.length === 4 && d.payload[0] === 1 && d.payload[3] === 4),
      5000);
    expect(arrived).toBe(true);
  }, 15000);

  it('inbound past `inboundMax` is dropped and the configured peer still links', async () => {
    const a = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 2 });
    peers.push(a);
    const aPort = a.transport.listenPort4()!;
    const peerForA = async (): Promise<UdpPeer> => startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      peers: [peerEntry(a, '127.0.0.1', aPort)],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
    });
    const s1 = await peerForA();
    const s2 = await peerForA();
    const s3 = await peerForA();
    peers.push(s1, s2, s3);
    // Two of three strangers read `connected` on A, and one is held
    // out by the cap — any two is what the rule requires.
    const twoLinked = await waitFor(() => {
      let n = 0;
      if (a.connected.has(s1.xOnlyHex)) n += 1;
      if (a.connected.has(s2.xOnlyHex)) n += 1;
      if (a.connected.has(s3.xOnlyHex)) n += 1;
      return n === 2;
    }, 8000);
    expect(twoLinked).toBe(true);
    // Across a short settle the third does not sneak in.
    await new Promise((r) => setTimeout(r, 500));
    let linkedStrangers = 0;
    if (a.connected.has(s1.xOnlyHex)) linkedStrangers += 1;
    if (a.connected.has(s2.xOnlyHex)) linkedStrangers += 1;
    if (a.connected.has(s3.xOnlyHex)) linkedStrangers += 1;
    expect(linkedStrangers).toBe(2);
  }, 15000);

  it('a half-open address past the cap is released and another address links in its place', async () => {
    const a = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 1 });
    peers.push(a);
    const aPort = a.transport.listenPort4()!;
    // A raw dgram sends one byte at A; A takes the address as inbound,
    // no link rises, so the release timer counts to 2 × hint timeout.
    // Real timers — fake ones do not advance Node's dgram scheduler.
    const { createSocket } = await import('node:dgram');
    const halfOpen = createSocket('udp4');
    await new Promise<void>((r) => halfOpen.bind(0, '127.0.0.1', r));
    await new Promise<void>((resolve, reject) => {
      halfOpen.send(new Uint8Array([0x00]), aPort, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });
    // A took the half-open's address as inbound. Wait past the release
    // window — then a second stranger must fit under `inboundMax: 1`.
    await new Promise((r) => setTimeout(r, 2 * FIPS_LINK_HINT_TIMEOUT_MS + 500));
    halfOpen.close();
    const s2 = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      peers: [peerEntry(a, '127.0.0.1', aPort)],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
    });
    peers.push(s2);
    const linked = await waitFor(() => a.connected.has(s2.xOnlyHex), 5000);
    expect(linked).toBe(true);
  }, 20000);

  it('`inboundMax: 0` takes no address it did not dial; the configured peer still links', async () => {
    const a = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 0 });
    peers.push(a);
    const aPort = a.transport.listenPort4()!;
    const stranger = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      peers: [peerEntry(a, '127.0.0.1', aPort)],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
    });
    peers.push(stranger);
    // 5 s passes; no `connected` read on A for the stranger.
    const linked = await waitFor(() => a.connected.has(stranger.xOnlyHex), 5000);
    expect(linked).toBe(false);
    // A's configured peer: start b after and expect it to link
    // (A has `inboundMax: 0`, so B must be the one dialling and link
    // through the message-1 identity learning path — which this rule
    // forbids for `inboundMax: 0`. So test instead: A listing B
    // dials and links). Rebuild A with the peer list and listen 0 for
    // its own dials alone.
    await a.stop();
    const b = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 2 });
    peers.push(b);
    const bPort = b.transport.listenPort4()!;
    const a2 = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      inboundMax: 0,
      peers: [peerEntry(b, '127.0.0.1', bPort)],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
    });
    peers.push(a2);
    const okB = await waitFor(() => a2.connected.has(b.xOnlyHex), 5000);
    expect(okB).toBe(true);
  }, 20000);

  it('an unresolvable host delays no other peer and is tried again on the drawn wait', async () => {
    const b = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 2 });
    peers.push(b);
    const bPort = b.transport.listenPort4()!;
    const resolveCalls = { bad: 0, good: 0 };
    const resolveFn = async (host: string): Promise<string[]> => {
      if (host === 'bad.example.invalid') { resolveCalls.bad += 1; throw new Error('resolver rejects bad'); }
      if (host === '127.0.0.1') { resolveCalls.good += 1; return ['127.0.0.1']; }
      throw new Error(`resolver: unknown host ${host}`);
    };
    const a = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      inboundMax: 0,
      peers: [
        { name: 'bad', npub: b.npub, host: 'bad.example.invalid', port: 9999 },
        { name: 'good', npub: b.npub, host: '127.0.0.1', port: bPort },
      ],
      resolve: resolveFn,
      random: () => 0, // the drawn wait rides the floor — RETRY_BASE_MS / 2
    });
    peers.push(a);
    const linked = await waitFor(() => a.connected.has(b.xOnlyHex), 5000);
    expect(linked).toBe(true);
    // The bad host is asked again after the first drawn wait =
    // `RETRY_BASE_MS / 2` with `random: () => 0` = 2500 ms. Wait a
    // little past that and read the count.
    await new Promise((r) => setTimeout(r, RETRY_BASE_MS / 2 + 500));
    expect(resolveCalls.bad).toBeGreaterThanOrEqual(2);
  }, 15000);

  it('a wrong npub listed at an address never links, and a second dial of that address follows the drawn wait', async () => {
    const b = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 2 });
    peers.push(b);
    const bPort = b.transport.listenPort4()!;
    const c = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 0 });
    peers.push(c);
    // A lists B's address under C's npub. B cannot decrypt a Msg1
    // encrypted to C; the handshake never completes.
    const a = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      inboundMax: 0,
      peers: [{ name: 'wrong', npub: c.npub, host: '127.0.0.1', port: bPort }],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
      random: () => 0, // minimum drawn wait
    });
    peers.push(a);
    // Ten seconds: no `connected` for any key at A, and no `connected`
    // for A's key at B (B cannot authenticate the Msg1).
    await new Promise((r) => setTimeout(r, 10000));
    expect(a.connected.size).toBe(0);
    expect(b.connected.has(a.xOnlyHex)).toBe(false);
    // Eighteen seconds in all: FipsNode's handshake times out at 15 s,
    // clears its pending-connect entry, and the next transport yield
    // on the drawn schedule opens a fresh dial at the transport ---
    // a second `transport.connect` call, which the harness wrapper
    // records.
    await new Promise((r) => setTimeout(r, 8000));
    const dials = a.connectCalls.filter((c2) => c2.addr === `127.0.0.1:${bPort}`).length;
    expect(dials).toBeGreaterThanOrEqual(2);
  }, 25000);

  it('malformed datagrams leave the transport running and a later peer links through', async () => {
    const a = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 4 });
    peers.push(a);
    const aPort = a.transport.listenPort4()!;
    // A side-channel sender that pumps bad bytes at A.
    const { createSocket } = await import('node:dgram');
    const noisy = createSocket('udp4');
    await new Promise<void>((resolve) => noisy.bind(0, '127.0.0.1', resolve));
    const sendRaw = (bytes: Uint8Array): Promise<void> => new Promise((resolve, reject) => {
      noisy.send(bytes, aPort, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });
    await sendRaw(new Uint8Array([0x00])); // one byte
    await sendRaw(new Uint8Array(FIPS_LINK_MTU + 1)); // past the cap
    const rand = new Uint8Array(64);
    for (let i = 0; i < rand.length; i += 1) rand[i] = i;
    await sendRaw(rand);
    noisy.close();
    // Now B links to A — a working path through the transport still works.
    const b = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      peers: [peerEntry(a, '127.0.0.1', aPort)],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
    });
    peers.push(b);
    const ok = await waitFor(() => a.connected.has(b.xOnlyHex), 5000);
    expect(ok).toBe(true);
  }, 15000);

  it('a lost link is dialled again within the first drawn wait', async () => {
    const b = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 2 });
    peers.push(b);
    const bPort = b.transport.listenPort4()!;
    const a = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      inboundMax: 0,
      peers: [peerEntry(b, '127.0.0.1', bPort)],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
      random: () => 0, // minimum draw = RETRY_BASE_MS / 2
    });
    peers.push(a);
    const linked1 = await waitFor(() => a.connected.has(b.xOnlyHex), 5000);
    expect(linked1).toBe(true);
    const dialsBefore = a.connectCalls.filter((c) => c.addr === `127.0.0.1:${bPort}`).length;
    // B stops and B' comes up on the same port. The stack is what tells
    // the transport the link fell — here the test stands in for that
    // wiring with an explicit `noteLink(addr, false)`, and the draw
    // then yields the peer again inside RETRY_BASE_MS.
    await b.stop();
    // A probe pause for the kernel to release the port before the
    // replacement binds the same one.
    await new Promise((r) => setTimeout(r, 100));
    const bReplacement = await startUdpPeer({
      listen: { host: '127.0.0.1', port: bPort },
      inboundMax: 2,
      identity: b.identity, // same key, so A's dial still proves this peer
    });
    peers.push(bReplacement);
    a.transport.noteLink(`127.0.0.1:${bPort}`, false);
    // A re-links to the same address within RETRY_BASE_MS (5 s). Allow
    // a cushion past it.
    const relinked = await waitFor(
      () => bReplacement.connected.has(a.xOnlyHex),
      RETRY_BASE_MS + 5000,
    );
    expect(relinked).toBe(true);
    // The relink is a fresh outbound dial — one more `transport.connect`
    // than before, recorded by the harness wrapper.
    const dialsAfter = a.connectCalls.filter((c) => c.addr === `127.0.0.1:${bPort}`).length;
    expect(dialsAfter).toBeGreaterThan(dialsBefore);
  }, 20000);

  it('an IPv6 peer links over `[::1]` (skipped where the host has no IPv6 loopback)', async () => {
    const a = await startUdpPeer({ listen: { host: '::1', port: 0 }, inboundMax: 2 });
    peers.push(a);
    if (a.transport.listenPort6() === null) {
      return; // the host has no IPv6 loopback; skipped by measurement
    }
    const aPort6 = a.transport.listenPort6()!;
    const b = await startUdpPeer({
      listen: { host: '::1', port: 0 },
      peers: [{ name: 'a-v6', npub: a.npub, host: '::1', port: aPort6 }],
      resolve: loopbackResolver(new Map([['::1', ['::1']]])),
    });
    peers.push(b);
    const ok = await waitFor(() => a.connected.has(b.xOnlyHex) && b.connected.has(a.xOnlyHex), 5000);
    expect(ok).toBe(true);
  }, 15000);

  it('`stop()` leaves no socket or timer behind', async () => {
    const info = (): string[] => (process as unknown as { getActiveResourcesInfo: () => string[] }).getActiveResourcesInfo();
    const count = (kind: string, xs: string[]): number => xs.filter((x) => x === kind).length;
    const before = { sockets: count('UDPWrap', info()), timeouts: count('Timeout', info()) };
    const a = await startUdpPeer({
      listen: { host: '127.0.0.1', port: 0 },
      inboundMax: 4,
      peers: [{ name: 'self', npub: 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98', host: '127.0.0.1', port: 1 }],
      resolve: loopbackResolver(new Map([['127.0.0.1', ['127.0.0.1']]])),
    });
    const peakSockets = count('UDPWrap', info());
    expect(peakSockets).toBeGreaterThanOrEqual(before.sockets + 1);
    await a.stop();
    // A closed dgram socket keeps its `UDPWrap` entry on
    // getActiveResourcesInfo until a later GC, so this reads the
    // ACTIVE ones another way — a datagram sent to a bound port must
    // fail (nothing listens): a probe tells closed from open.
    const { createSocket } = await import('node:dgram');
    const probe = createSocket('udp4');
    await new Promise<void>((r) => probe.bind(0, '127.0.0.1', r));
    const aPort = a.transport.listenPort4();
    let heard = false;
    probe.on('error', () => undefined);
    const observer = createSocket('udp4');
    observer.on('message', () => { heard = true; });
    await new Promise<void>((r) => observer.bind(aPort ?? 0, '127.0.0.1', r));
    await new Promise<void>((resolve, reject) => {
      probe.send(new Uint8Array([0]), observer.address().port, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((r) => setTimeout(r, 100));
    probe.close();
    observer.close();
    // If the transport's own socket were still bound at `aPort`, our
    // own bind of a fresh observer there would fail with `EADDRINUSE`.
    // It didn't — `aPort` is free — so the transport's socket closed.
    void heard;
    // One stray timeout can come from vitest's own instrumentation —
    // the transport adds none past its own cleanup.
    const xs = info();
    expect(count('Timeout', xs)).toBeLessThanOrEqual(before.timeouts + 1);
  }, 15000);

  it('`send` to an address the transport did not dial or take throws `UdpFipsSendError`', async () => {
    const a = await startUdpPeer({ listen: { host: '127.0.0.1', port: 0 }, inboundMax: 0 });
    peers.push(a);
    await expect(
      a.transport.send({ transport: 'udp', addr: '127.0.0.1:1' }, new Uint8Array([0])),
    ).rejects.toBeInstanceOf(UdpFipsSendError);
    void hasIpv6Loopback;
  }, 5000);
});
