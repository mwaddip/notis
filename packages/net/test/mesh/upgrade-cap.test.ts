// NET_INTERFACE → Readers — "An address upgrades at most four inbound
// connections at once, each within five seconds".
//
// Each case starts a public mesh NetNode A on `/ip4/127.0.0.1/tcp/0`
// and opens silent TCP sockets from distinct loopback source
// addresses — `net.connect({ host: '127.0.0.1', port, localAddress })`
// (`CONSTANTS → net`).

import { afterEach, describe, expect, it } from 'vitest';
import {
  connect as netConnect,
  type Socket as NetSocket,
} from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@dagsocial/types';
import {
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
} from '@dagsocial/validation';

import { NetNode } from '../../src/index.js';
import type { NetValidators, MeshConfig } from '../../src/index.js';
import { makeConfig } from '../helpers.js';

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

function publicMeshOn(stateDir: string): MeshConfig {
  return {
    role: 'public',
    network: 'devnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: 'http://127.0.0.1:0',
    stun: null,
  };
}

interface NodeState {
  node: NetNode;
  port: number;
  dir: string;
}

async function startA(maxPeers = 10, maxReaders = 100): Promise<NodeState> {
  const dir = mkdtempSync(join(tmpdir(), 'net-upgrade-cap-'));
  const node = new NetNode(
    makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      maxPeers,
      maxReaders,
      mesh: publicMeshOn(dir),
    }),
    validators,
  );
  await node.start();
  const libp2p = node.libp2pNode!;
  const tcpAddr = libp2p
    .getMultiaddrs()
    .map((a) => a.toString())
    .find((a) => /\/tcp\/\d+\/p2p\//.test(a) && !a.includes('/webrtc'))!;
  const m = tcpAddr.match(/\/tcp\/(\d+)/)!;
  return { node, port: Number(m[1]), dir };
}

// Open a TCP socket from `src` to `127.0.0.1:port`, never read or write,
// never close it explicitly. Returns the socket and a promise that
// resolves with the ms elapsed from open to close (the dialler's view).
function openSilentTcp(
  port: number,
  src: string,
): { socket: NetSocket; closedIn: Promise<number> } {
  const opened = Date.now();
  const socket = netConnect({ host: '127.0.0.1', port, localAddress: src });
  socket.resume(); // a never-read raw socket emits no 'close'
  const closedIn = new Promise<number>((resolve) => {
    socket.once('close', () => resolve(Date.now() - opened));
    socket.once('error', () => { /* 'close' handles it */ });
  });
  return { socket, closedIn };
}

// Wait up to `ms` for `p` to resolve; on timeout return null.
async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const out = await Promise.race([
    p.then((v) => ({ ok: true as const, v })),
    new Promise<{ ok: false }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false }), ms);
    }),
  ]);
  if (timer !== null) clearTimeout(timer);
  return out.ok ? out.v : null;
}

describe('a public mesh NetNode A holds at most four pending upgrades per address', () => {
  const nodes: NodeState[] = [];
  const dialers: Libp2p[] = [];

  afterEach(async () => {
    for (const d of dialers) { try { await d.stop(); } catch { /* */ } }
    dialers.length = 0;
    for (const s of nodes) {
      try { await s.node.stop(); } catch { /* */ }
      try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* */ }
    }
    nodes.length = 0;
  });

  // Per address: from one loopback address, four silent connections are
  // held, the fifth is closed by the node at once, and meanwhile a libp2p
  // dial from another address is admitted (reaches net's handshake).
  it.fails('four silent connections from one address are held; a fifth is closed at once, and another address is admitted', async () => {
    const state = await startA();
    nodes.push(state);

    const silent: { socket: NetSocket; closedIn: Promise<number> }[] = [];
    for (let i = 0; i < 4; i++) {
      silent.push(openSilentTcp(state.port, '127.0.0.2'));
      await new Promise((r) => setTimeout(r, 250));
    }
    // Control: the four silent sockets all opened and are held past 500 ms.
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 4; i++) {
      const stillOpen = await raceTimeout(silent[i]!.closedIn, 10);
      expect(stillOpen, `silent ${i} held open`).toBeNull();
    }

    // A libp2p dial from 127.0.0.3 reaches net's handshake — admitted
    // even while 127.0.0.2's four silent slots are held.
    const dialer = await createLibp2p({
      addresses: { listen: [] },
      transports: [tcp({ dialOpts: { localAddress: '127.0.0.3' } as never })],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    dialers.push(dialer);
    const aAddr = state.node.libp2pNode!
      .getMultiaddrs()
      .map((a) => a.toString())
      .find((a) => /\/tcp\/\d+\/p2p\//.test(a) && !a.includes('/webrtc'))!;
    await dialer.dial(multiaddr(aAddr));
    // The dialer owns the outbound side: if it holds a connection to A,
    // the libp2p upgrade completed on both sides.
    const held = dialer.getConnections().filter((c) => c.status === 'open');
    expect(held.length, 'dialer holds a connection to A').toBeGreaterThan(0);

    // The fifth silent connection from 127.0.0.2 is closed by A at once —
    // well under the 5 000 ms upgrade timeout. Wait up to 2 s; a slot
    // released at the per-host cap closes within tens of ms.
    const fifth = openSilentTcp(state.port, '127.0.0.2');
    const fifthClosedIn = await raceTimeout(fifth.closedIn, 2_000);
    // -- LAST ASSERTION --
    expect(fifthClosedIn, 'fifth closed within 2 s').not.toBeNull();
  }, 30_000);

  // Node-wide: the ceiling is `maxPeers + maxReaders + HANDSHAKE_SLACK`.
  // With maxPeers 2 and maxReaders 2 the ceiling is 20; silent connections
  // from five addresses (four each) fill it. More than ten are held, which
  // libp2p's default would refuse.
  it.fails('silent connections from several addresses fill the node ceiling of 20; more than ten are held at once', async () => {
    const state = await startA(2, 2);
    nodes.push(state);
    const sources = ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5', '127.0.0.6'];
    const silent: { socket: NetSocket; closedIn: Promise<number> }[] = [];
    for (const src of sources) {
      for (let i = 0; i < 4; i++) {
        silent.push(openSilentTcp(state.port, src));
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    // Wait a beat for openings to register.
    await new Promise((r) => setTimeout(r, 500));
    // Count silent still-open: the ceiling holds twenty — libp2p's
    // default of ten would refuse the eleventh.
    let held = 0;
    for (const s of silent) {
      const closedIn = await raceTimeout(s.closedIn, 10);
      if (closedIn === null) held += 1;
    }
    // -- LAST ASSERTION --
    expect(held, 'more than ten silent connections held').toBeGreaterThan(10);
  }, 30_000);

  // In time: a silent connection is closed at `INBOUND_UPGRADE_TIMEOUT_MS`
  // (5 000 ms), well before libp2p's default of 10 000 ms.
  it.fails('a silent connection is closed at the 5 000 ms upgrade timeout', async () => {
    const state = await startA();
    nodes.push(state);
    const silent = openSilentTcp(state.port, '127.0.0.2');
    // Not before ~4.5 s: still open at 4 500 ms (control for both the
    // net's deadline and libp2p's default).
    const earlyClose = await raceTimeout(silent.closedIn, 4_500);
    expect(earlyClose, 'still open at 4 500 ms').toBeNull();
    // Wait up to 11 s — libp2p's default closes at 10 000 ms, the net's
    // at 5 000 ms. The dialer sees its socket closed in both cases.
    const closedIn = await raceTimeout(silent.closedIn, 6_600);
    expect(closedIn, 'closed by 11 100 ms').not.toBeNull();
    // -- LAST ASSERTION --
    expect(closedIn!, 'closed well before 10 000 ms').toBeLessThan(7_500);
  }, 15_000);

  // Release: a slot frees on every exit. After an address's four silent
  // connections time out, four fresh silent connections from that
  // address are admitted again, and a fifth is refused.
  it.fails('four silent connections release their slots at the upgrade timeout; four fresh from the same address are admitted and a fifth is refused', async () => {
    const state = await startA();
    nodes.push(state);
    for (let i = 0; i < 4; i++) {
      openSilentTcp(state.port, '127.0.0.2');
      await new Promise((r) => setTimeout(r, 250));
    }
    // Wait past libp2p's default 10 s upgrade timeout so every silent
    // socket closes on both the current and the patched code.
    await new Promise((r) => setTimeout(r, 11_000));
    // Four fresh silent from 127.0.0.2 — admitted and held.
    const fresh: { socket: NetSocket; closedIn: Promise<number> }[] = [];
    for (let i = 0; i < 4; i++) {
      fresh.push(openSilentTcp(state.port, '127.0.0.2'));
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 4; i++) {
      const stillOpen = await raceTimeout(fresh[i]!.closedIn, 10);
      expect(stillOpen, `fresh ${i} held open`).toBeNull();
    }
    // A fifth from the same address is refused — the per-host cap
    // holds after the release.
    const fifth = openSilentTcp(state.port, '127.0.0.2');
    const fifthClosedIn = await raceTimeout(fifth.closedIn, 2_000);
    // -- LAST ASSERTION --
    expect(fifthClosedIn, 'fifth after release closed at once').not.toBeNull();
  }, 30_000);
});

// IPv6 by /64. A loopback has one IPv6 address, so this case alone calls
// the patched `acceptIncomingConnection` of a started node's connection
// manager by hand, with `maConn`-shaped objects from
// `/ip6/2001:db8::1/tcp/…`: four from one /64 accepted, the fifth
// refused, one from another /64 accepted, and `afterUpgradeInbound`
// releasing each.
describe('the per-host cap counts an IPv6 address by its /64', () => {
  const nodes: NodeState[] = [];
  afterEach(async () => {
    for (const s of nodes) {
      try { await s.node.stop(); } catch { /* */ }
      try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* */ }
    }
    nodes.length = 0;
  });

  it.fails('four /ip6/2001:db8:…/… from one /64 are accepted, the fifth is refused, one from another /64 is accepted', async () => {
    const state = await startA();
    nodes.push(state);
    const libp2p = state.node.libp2pNode!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cm = (libp2p as any).components.connectionManager as {
      acceptIncomingConnection: (maConn: unknown) => boolean;
      afterUpgradeInbound: (maConn?: unknown) => void;
    };
    // A `maConn`-shaped object carries its `remoteAddr`.
    const ma = (s: string): { remoteAddr: ReturnType<typeof multiaddr> } => ({ remoteAddr: multiaddr(s) });
    const sameNet = [
      ma('/ip6/2001:db8::1/tcp/40001'),
      ma('/ip6/2001:db8::2/tcp/40002'),
      ma('/ip6/2001:db8::3/tcp/40003'),
      ma('/ip6/2001:db8::4/tcp/40004'),
    ];
    for (let i = 0; i < 4; i++) {
      expect(cm.acceptIncomingConnection(sameNet[i]!), `/64 accept ${i + 1}`).toBe(true);
    }
    // Another /64 is still accepted.
    const otherNet = ma('/ip6/2001:db9::1/tcp/40010');
    expect(cm.acceptIncomingConnection(otherNet), 'another /64 accepted').toBe(true);
    cm.afterUpgradeInbound(otherNet);
    // Releasing the first two frees two slots for the /64.
    cm.afterUpgradeInbound(sameNet[0]);
    cm.afterUpgradeInbound(sameNet[1]);
    const after = ma('/ip6/2001:db8::5/tcp/40005');
    expect(cm.acceptIncomingConnection(after), 'held slot released').toBe(true);
    cm.afterUpgradeInbound(after);
    // Fresh state for the per-host refusal: release what the /64 still holds.
    cm.afterUpgradeInbound(sameNet[2]);
    cm.afterUpgradeInbound(sameNet[3]);
    // Open four from the /64 again, expect the fifth refused.
    const four = [
      ma('/ip6/2001:db8::11/tcp/40011'),
      ma('/ip6/2001:db8::12/tcp/40012'),
      ma('/ip6/2001:db8::13/tcp/40013'),
      ma('/ip6/2001:db8::14/tcp/40014'),
    ];
    for (let i = 0; i < 4; i++) {
      expect(cm.acceptIncomingConnection(four[i]!), `/64 refill ${i + 1}`).toBe(true);
    }
    // -- LAST ASSERTION -- the fifth from the same /64 is refused.
    expect(cm.acceptIncomingConnection(ma('/ip6/2001:db8::15/tcp/40015')), 'fifth from the /64 refused').toBe(false);
  }, 15_000);
});
