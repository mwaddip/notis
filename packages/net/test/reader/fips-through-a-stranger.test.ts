// MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
// its operator turns it on" and "Public links are held apart from
// libp2p's" — two mesh `NetNode`s A and C, each `fipsPublic` listing a
// plain forwarding `FipsNode` S and nothing else, hold no libp2p
// connection to each other; a reader linked to A alone dials C's FIPS
// address, and the FIPS session rides the UDP mesh through S.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair, PROTOCOL_VERSION } from '@dagsocial/types';
import {
  FipsNode,
  encodeNpub,
  generateIdentity,
  toHex,
  type FipsIdentity,
  type PeerEvent,
} from '@fips/core';
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
import type { NetValidators, MeshConfig, FipsStack } from '../../src/index.js';
import { createReaderFips } from '../../src/index.js';
import { meshFetchOverConnection } from '../../src/mesh/mesh-fetch.js';
import { meshBaseUrl } from '../../src/mesh/mesh-url.js';
import { readerHandshake } from '../../src/mesh/reader-handshake.js';
import { notisIdFromPeerId } from '../../src/mesh/identity.js';
import { MAGIC_TESTNET } from '../../src/frame.js';
import {
  FIPS_PUBLIC_INBOUND_MAX,
  type PublicFipsPeer,
} from '../../src/mesh/constants.js';
import { UdpFipsTransport } from '../../src/mesh/fips-udp.js';
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

interface Stub {
  srv: Server;
  base: string;
  currentJson: string;
}

async function makeStub(label: string): Promise<Stub> {
  const currentJson = JSON.stringify({ height: 1, id: label.repeat(64).slice(0, 64) });
  const srv = createServer((req, res) => {
    if (req.url === '/blocks/current') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(currentJson);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return { srv, base: `http://127.0.0.1:${port}`, currentJson };
}

interface StrangerS {
  readonly identity: FipsIdentity;
  readonly transport: UdpFipsTransport;
  readonly node: FipsNode;
  readonly peerEvents: PeerEvent[];
  readonly port: number;
  readonly npub: string;
  stop(): Promise<void>;
}

// S is the plain forwarding FipsNode the two Notis nodes both list.
// It carries libp2p nothing of its own; its one role is FIPS
// forwarding over UDP (MESH_INTERFACE → FIPS → "Every mesh node is a
// FIPS node" — a stranger forwards for the mesh).
async function startStranger(): Promise<StrangerS> {
  const identity = await generateIdentity();
  const transport = new UdpFipsTransport({
    listen: { host: '127.0.0.1', port: 0 },
    peers: [],
    inboundMax: FIPS_PUBLIC_INBOUND_MAX,
  });
  const node = new FipsNode({
    identity,
    transports: [transport],
    forwarding: true,
  });
  const peerEvents: PeerEvent[] = [];
  node.on('peer', (data) => { peerEvents.push(data as PeerEvent); });
  await node.start();
  const port = transport.listenPort4();
  if (port === null) throw new Error('stranger has no udp4 port');
  return {
    identity,
    transport,
    node,
    peerEvents,
    port,
    npub: encodeNpub(identity.xOnlyPubkey),
    stop: async () => { try { await node.stop(); } catch { /* already */ } },
  };
}

function meshListingStranger(
  stateDir: string,
  httpBase: string,
  stranger: PublicFipsPeer,
): MeshConfig {
  return {
    role: 'public',
    network: 'testnet',
    listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
    stateDir,
    httpBase: () => httpBase,
    stun: null,
    fipsPublic: { peers: [stranger], listen: null },
  };
}

async function waitFor(check: () => boolean, deadlineMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

async function buildReader(stack: FipsStack): Promise<Libp2p> {
  const reader = await createLibp2p({
    addresses: { listen: [] },
    transports: [tcp(), stack.transport],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
  await stack.attach(reader);
  return reader;
}

async function nodeTcpAddress(node: NetNode, deadlineMs = 10_000): Promise<string> {
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const a = libp2p.getMultiaddrs().map((m) => m.toString())
      .find((s) => /\/tcp\/\d+\/p2p\//.test(s) && !s.includes('/fips/') && !s.includes('/webrtc'));
    if (a !== undefined) return a;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('node has no TCP listen address');
}

describe('MESH_INTERFACE → FIPS: a reader reaches a node through a stranger', () => {
  const nodes: NetNode[] = [];
  const stacks: FipsStack[] = [];
  const hosts: Libp2p[] = [];
  const stubs: Server[] = [];
  const dirs: string[] = [];
  const strangers: StrangerS[] = [];

  afterEach(async () => {
    for (const h of hosts) { try { await h.stop(); } catch { /* already */ } }
    for (const s of stacks) { try { await s.stop(); } catch { /* already */ } }
    for (const n of nodes) { try { await n.stop(); } catch { /* already */ } }
    for (const s of strangers) { try { await s.stop(); } catch { /* already */ } }
    for (const srv of stubs) { try { srv.close(); } catch { /* already */ } }
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* already */ } }
    hosts.length = 0; stacks.length = 0; nodes.length = 0; strangers.length = 0;
    stubs.length = 0; dirs.length = 0;
  });

  // MESH_INTERFACE → FIPS → "A node peers with the public FIPS mesh when
  // its operator turns it on" — A and C each list S alone. S's UDP
  // forwarding carries the reader's FIPS session with C, which A and
  // C hold no libp2p path to each other for.
  it('the reader reads `/blocks/current` on C through S over UDP, with no A↔C libp2p path', async () => {
    const stranger = await startStranger();
    strangers.push(stranger);

    const stubA = await makeStub('a');
    const stubC = await makeStub('c');
    stubs.push(stubA.srv, stubC.srv);
    const dirA = mkdtempSync(join(tmpdir(), 'net-fips-stranger-a-'));
    const dirC = mkdtempSync(join(tmpdir(), 'net-fips-stranger-c-'));
    dirs.push(dirA, dirC);

    const strangerEntry: PublicFipsPeer = {
      name: 's',
      npub: stranger.npub,
      host: '127.0.0.1',
      port: stranger.port,
    };
    const a = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshListingStranger(dirA, stubA.base, strangerEntry),
    }), validators);
    await a.start();
    nodes.push(a);
    const c = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      mesh: meshListingStranger(dirC, stubC.base, strangerEntry),
    }), validators);
    await c.start();
    nodes.push(c);

    // Wait for A↔S and C↔S UDP links at the stranger. The stranger
    // sees two `connected` peer events, one for each Notis node.
    const strangerLinked = await waitFor(() => {
      const linkedKeys = new Set<string>();
      for (const e of stranger.peerEvents) {
        if (e.state === 'connected') {
          const hex = e.remotePubkey.length >= 2 ? e.remotePubkey.slice(2) : e.remotePubkey;
          linkedKeys.add(hex);
        } else if (e.state === 'disconnected') {
          const hex = e.remotePubkey.length >= 2 ? e.remotePubkey.slice(2) : e.remotePubkey;
          linkedKeys.delete(hex);
        }
      }
      return linkedKeys.size >= 2;
    }, 20_000);
    expect(strangerLinked).toBe(true);

    // A and C hold no libp2p connection to each other, and no FIPS
    // link to each other on the stack's `link` transport.
    const aLibp2p = (a as unknown as { libp2p: Libp2p }).libp2p;
    const cLibp2p = (c as unknown as { libp2p: Libp2p }).libp2p;
    const aStack = (a as unknown as { fipsStack: FipsStack }).fipsStack;
    const cStack = (c as unknown as { fipsStack: FipsStack }).fipsStack;
    const cPeerIdStr = cLibp2p.peerId.toString();
    const aPeerIdStr = aLibp2p.peerId.toString();
    const aToC = aLibp2p.getConnections().filter((x) => x.remotePeer.toString() === cPeerIdStr);
    const cToA = cLibp2p.getConnections().filter((x) => x.remotePeer.toString() === aPeerIdStr);
    expect(aToC).toEqual([]);
    expect(cToA).toEqual([]);
    const cXOnlyHex = toHex(cStack.identity.xOnlyPubkey);
    const aXOnlyHex = toHex(aStack.identity.xOnlyPubkey);
    expect(aStack.link.linkedKeys().some((k) => k.endsWith(cXOnlyHex))).toBe(false);
    expect(cStack.link.linkedKeys().some((k) => k.endsWith(aXOnlyHex))).toBe(false);

    // The reader connects to A over TCP, hands over a reader
    // handshake and opens its one libp2p link.
    const stack = await createReaderFips({ network: 'testnet' });
    stacks.push(stack);
    const reader = await buildReader(stack);
    hosts.push(reader);
    const aTcp = await nodeTcpAddress(a);
    const connA = await reader.dial(multiaddr(aTcp));
    const hsA = await readerHandshake(connA, {
      magic: MAGIC_TESTNET,
      protocolVersion: PROTOCOL_VERSION,
      agentName: 'fips-through-a-stranger-test',
      chainHeight: 0,
      timeoutMs: 10_000,
    });
    if (!hsA.ok) throw new Error(`handshake with A failed: ${hsA.reason}`);
    await stack.link.openLink(connA);
    const aXOnlyHexStr = toHex(aStack.identity.publicKey);
    const linkUp = await waitFor(
      () => stack.link.linkedKeys().includes(aXOnlyHexStr),
      15_000,
    );
    expect(linkUp).toBe(true);

    // The reader dials C's FIPS address. C holds no libp2p connection
    // from the reader; the FIPS session rides A → S → C over UDP.
    const cFipsAddr = c.fipsAddress();
    expect(cFipsAddr).not.toBeNull();
    const connC = await reader.dial(multiaddr(cFipsAddr!), {
      signal: AbortSignal.timeout(20_000),
    });
    expect(connC.remotePeer.toString()).toBe(cPeerIdStr);
    const hsC = await readerHandshake(connC, {
      magic: MAGIC_TESTNET,
      protocolVersion: PROTOCOL_VERSION,
      agentName: 'fips-through-a-stranger-test',
      chainHeight: 0,
      timeoutMs: 20_000,
    });
    if (!hsC.ok) throw new Error(`handshake with C failed: ${hsC.reason}`);
    const cNotisId = notisIdFromPeerId(connC.remotePeer);
    const fetch = meshFetchOverConnection((wantNotisId) => {
      if (wantNotisId !== cNotisId) return null;
      return connC;
    }, { timeoutMs: 20_000 });
    const res = await fetch(`${meshBaseUrl(cNotisId)}/blocks/current`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(stubC.currentJson);
  }, 120_000);
});
