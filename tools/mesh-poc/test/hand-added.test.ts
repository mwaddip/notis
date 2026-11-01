// MESH_INTERFACE → Transports → "A client dials a private address only
// when its own configuration names it" + Discovery → "A node added by
// hand" — the client's own gater refuses every private address but
// those its own configuration names for a key, in every runtime, and
// `MeshClient.addByHand` is the one entry point that writes an address
// into that configuration.
//
// In-process, Node.js, no root. The pure-gater cases run against the
// exported `clientDenyDialMultiaddr`; the "libp2p actually calls the
// gater" case runs a real libp2p host and asserts (a) the gater sees
// the full dial multiaddr including the trailing `/p2p/<id>` and (b) a
// dial whose every address the gater denies throws without a
// `dial-queue:calculated-addresses` entry for them. The addByHand
// refusal and anchorReached cases run against `startMeshClient`.

import { afterEach, describe, expect, it } from 'vitest';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { privateKeyFromRaw } from '@libp2p/crypto/keys';
import { bytesToHex, generateKeyPair, profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import type { NodeTipResult } from '@dagsocial/nipopow-client';
import {
  clientDenyDialMultiaddr,
  createDialProgressRecorder,
  startMeshClient,
  type MeshClient,
} from '../src/client/mesh-client.js';
import { MeshConfigError } from '../src/config.js';
import { peerIdFromNotisId, seedOfSecretKey } from '../src/identity.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);

function emptyResolve(): typeof import('@dagsocial/nipopow-client').resolveTip {
  return async () => ({
    winner: null,
    winnerIndex: -1,
    nodes: [],
    tip: null,
    suffixHead: null,
    splits: [],
  });
}

function winnerForEveryUrl(): typeof import('@dagsocial/nipopow-client').resolveTip {
  return async (urls) => {
    const nodes: NodeTipResult[] = urls.map((url) => ({
      url,
      verified: true,
      proof: { prefix: [], suffixHead: {}, suffixTail: [] } as unknown as NodeTipResult['proof'],
      verifyResult: null,
      refuseReason: null,
      refuseCode: null,
      behind: 0,
      genesisHash: 'f'.repeat(64),
    }));
    return {
      winner: nodes[0] ?? null,
      winnerIndex: nodes.length > 0 ? 0 : -1,
      nodes,
      tip: null,
      suffixHead: null,
      splits: [],
    };
  };
}

// ---------- the gater — pure function cases ----------

describe('clientDenyDialMultiaddr — the gater (pure)', () => {
  const kpA = generateKeyPair();
  const kpB = generateKeyPair();
  const idA = bytesToHex(kpA.publicKey);
  const idB = bytesToHex(kpB.publicKey);
  const peerA = peerIdFromNotisId(idA).toString();
  const peerB = peerIdFromNotisId(idB).toString();
  // A configured anchor's address for key A: a 10.0.0.5 private IP.
  const anchorBareA = '/ip4/10.0.0.5/udp/4001/webrtc-direct/certhash/uEiA';
  const anchorAddrA = `${anchorBareA}/p2p/${peerA}`;
  const configuredAddrsOf = (id: string): readonly string[] =>
    id === idA ? [anchorAddrA] : [];

  it('a hand-entered private address passes the gater for its own key', () => {
    const ma = multiaddr(anchorAddrA);
    expect(clientDenyDialMultiaddr(ma, configuredAddrsOf)).toBe(false);
  });

  it("an anchor's private address passes for its own key; a seed's is refused", () => {
    const anchorMa = multiaddr(anchorAddrA);
    expect(clientDenyDialMultiaddr(anchorMa, configuredAddrsOf)).toBe(false);
    // A seed's private address (another IP under another key, that
    // the configuration does not name) is refused.
    const seedAddr = `/ip4/10.0.0.9/udp/4001/webrtc-direct/certhash/uEiA/p2p/${peerB}`;
    expect(clientDenyDialMultiaddr(multiaddr(seedAddr), configuredAddrsOf)).toBe(true);
  });

  it('the same private address under another key is refused', () => {
    // Same host/port/certhash as the anchor's — but with peerB's
    // trailing `/p2p/`. The gater reads the key from the trailing
    // `/p2p/<id>`, so configured for idA does not pass this address
    // under idB.
    const ma = multiaddr(`${anchorBareA}/p2p/${peerB}`);
    expect(clientDenyDialMultiaddr(ma, configuredAddrsOf)).toBe(true);
  });

  it('a private address from the DHT for a hand-added key is refused', () => {
    // The hand-added key is idA (configured as anchorAddrA). A
    // different private address under idA — one the DHT, a seed or a
    // peer list offered — is not in configured, so the gater refuses
    // it. Review Focus 3.
    const dhtAddr = `/ip4/10.0.0.99/udp/5000/webrtc-direct/certhash/uEiB/p2p/${peerA}`;
    expect(clientDenyDialMultiaddr(multiaddr(dhtAddr), configuredAddrsOf)).toBe(true);
  });

  it('a public address passes; a plain /ws is refused', () => {
    const pubAddr = `/ip4/8.8.8.8/udp/4001/webrtc-direct/certhash/uEiA/p2p/${peerA}`;
    expect(clientDenyDialMultiaddr(multiaddr(pubAddr), configuredAddrsOf)).toBe(false);
    const wsAddr = `/ip4/8.8.8.8/tcp/8080/ws/p2p/${peerA}`;
    expect(clientDenyDialMultiaddr(multiaddr(wsAddr), configuredAddrsOf)).toBe(true);
    // A secure WebSocket is not plain `/ws`; the gater allows it.
    const wssAddr = `/ip4/8.8.8.8/tcp/8080/tls/ws/p2p/${peerA}`;
    expect(clientDenyDialMultiaddr(multiaddr(wssAddr), configuredAddrsOf)).toBe(false);
  });

  it('a private address with no trailing /p2p/ is refused', () => {
    // Without a trailing `/p2p/<id>` there is no key for the gater to
    // look up, so a private address is refused.
    const ma = multiaddr('/ip4/10.0.0.5/udp/4001/webrtc-direct/certhash/uEiA');
    expect(clientDenyDialMultiaddr(ma, configuredAddrsOf)).toBe(true);
  });

  it('a relayed address is judged by its relay hop', () => {
    // libp2p dials the relay first; the gater sees the relay's address
    // when it dials the relay. The RELAY's `/p2p/<relay>` names the key
    // the gater looks up (the dial multiaddr for the relay ends in the
    // relay's `/p2p/`). A public relay hop passes regardless of the
    // circuit target; a private relay hop is refused unless the
    // relay's own key is configured.
    const publicRelayDial = `/ip4/8.8.8.8/udp/4001/webrtc-direct/certhash/uEiA/p2p/${peerA}`;
    expect(clientDenyDialMultiaddr(multiaddr(publicRelayDial), configuredAddrsOf)).toBe(false);
    const privateRelayDial = `/ip4/10.0.0.9/udp/4001/webrtc-direct/certhash/uEiA/p2p/${peerB}`;
    expect(clientDenyDialMultiaddr(multiaddr(privateRelayDial), configuredAddrsOf)).toBe(true);
  });
});

// ---------- libp2p actually calls the gater ----------

describe('clientDenyDialMultiaddr — libp2p calls it with the full dial multiaddr', () => {
  let host: Libp2p | null = null;

  afterEach(async () => {
    try { await host?.stop(); } catch { /* already stopped */ }
    host = null;
  });

  it('a dial of a private loopback for a non-configured key is denied before `calculated-addresses` fires', async () => {
    const seen: string[] = [];
    const denyFn = (ma: Multiaddr): boolean => {
      seen.push(ma.toString());
      // Deny every private address regardless of key, by handing the
      // gater an empty configured-addresses reader.
      return clientDenyDialMultiaddr(ma, () => []);
    };
    host = await createLibp2p({
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
      connectionGater: { denyDialMultiaddr: denyFn },
    });

    // A valid-but-unresponsive target key.
    const kp = generateKeyPair();
    const privateKey = privateKeyFromRaw(seedOfSecretKey(kp.secretKey));
    const peerId = peerIdFromPrivateKey(privateKey);
    const addr = `/ip4/127.0.0.1/tcp/9999/p2p/${peerId.toString()}`;

    const recorder = createDialProgressRecorder();
    let caught: unknown = null;
    try {
      await host.dial(multiaddr(addr), {
        onProgress: recorder.onProgress,
        signal: AbortSignal.timeout(5_000),
      });
    } catch (e) {
      caught = e;
    }

    // The gater received a multiaddr with the
    // trailing `/p2p/<peerId>` libp2p's dial queue encapsulated.
    expect(seen.length, `gater calls: ${seen.length}`).toBeGreaterThanOrEqual(1);
    expect(seen.every((s) => /\/p2p\/[^/]+$/.test(s)), `seen = ${seen.join(', ')}`).toBe(true);
    expect(
      seen.some((s) => s.endsWith(`/p2p/${peerId.toString()}`)),
      `seen with trailing /p2p/${peerId.toString()} = ${seen.join(', ')}`,
    ).toBe(true);

    // The dial threw a `DialDeniedError` (or similar)
    // because every address was gated out, and no per-address
    // attribution was fired.
    expect(caught, 'dial rejected').not.toBeNull();
    expect(
      recorder.reported.length,
      `calculated-addresses reports: [${recorder.reported.join(', ')}]`,
    ).toBe(0);
  }, 15_000);
});

// ---------- MeshClient.addByHand — refusals ----------

describe('MeshClient.addByHand — refusals', () => {
  let client: MeshClient | null = null;
  afterEach(async () => {
    try { await client?.stop(); } catch { /* already stopped */ }
    client = null;
  });

  async function startBare(): Promise<MeshClient> {
    return startMeshClient({
      anchors: [],
      network: 'devnet',
      profile: PROFILE,
      resolve: emptyResolve(),
    });
  }

  it('addByHand refuses a dns address, a bad key, a non-webrtc-direct address', async () => {
    client = await startBare();
    const kp = generateKeyPair();
    const id = bytesToHex(kp.publicKey);
    const peerIdStr = peerIdFromNotisId(id).toString();
    const okAddr = `/ip4/10.0.0.5/udp/4001/webrtc-direct/certhash/uEiA/p2p/${peerIdStr}`;

    // A bad key (not 64 lowercase hex).
    expect(
      () => client!.addByHand('not-64-hex', [okAddr], true),
      'bad key refused',
    ).toThrow(MeshConfigError);
    // A /dns4/ address.
    expect(
      () => client!.addByHand(
        id,
        [`/dns4/example.com/udp/4001/webrtc-direct/certhash/uEiA/p2p/${peerIdStr}`],
        true,
      ),
      '/dns4/ address refused',
    ).toThrow(MeshConfigError);
    // An address without /webrtc-direct/.
    expect(
      () => client!.addByHand(
        id,
        [`/ip4/10.0.0.5/tcp/4001/p2p/${peerIdStr}`],
        true,
      ),
      'non-webrtc-direct address refused',
    ).toThrow(MeshConfigError);

    // Review Focus 2: the list is unchanged — no entry for the id.
    expect(
      client!.state().nodes.find((n) => n.notisId === id),
      'list unchanged',
    ).toBeUndefined();
  }, 15_000);
});

// ---------- MeshClient.addByHand — anchorReached ----------

describe('MeshClient.addByHand — anchorReached', () => {
  let client: MeshClient | null = null;
  afterEach(async () => {
    try { await client?.stop(); } catch { /* already stopped */ }
    client = null;
  });

  async function startBareWithResolve(
    resolve: Parameters<typeof startMeshClient>[0]['resolve'],
  ): Promise<MeshClient> {
    const c = await startMeshClient({
      anchors: [],
      network: 'devnet',
      profile: PROFILE,
      resolve,
    });
    // The resolve seam mocks the proof directly: the pre-dial has no
    // real target so we stub `libp2p.dial` to return without opening a
    // connection. The hand-added entry stays `new` into phase 2, where
    // the fake resolve marks it as a verified behind-0 success, the
    // event moves it to `ok`, and `nodeList.anchorReached()` reads the
    // `anchor` flag — the trusted/untrusted switch under test.
    (c.libp2p as unknown as { dial: (...args: unknown[]) => Promise<unknown> }).dial =
      async () => undefined;
    return c;
  }

  it('a trusted hand-added node makes anchorReached true when it answers', async () => {
    client = await startBareWithResolve(winnerForEveryUrl());
    const kp = generateKeyPair();
    const id = bytesToHex(kp.publicKey);
    const peerIdStr = peerIdFromNotisId(id).toString();
    const addr = `/ip4/127.0.0.1/udp/59999/webrtc-direct/certhash/uEiA/p2p/${peerIdStr}`;

    client.addByHand(id, [addr], true);
    await client.check();

    const s = client.state();
    const entry = s.nodes.find((n) => n.notisId === id);
    expect(entry, 'the hand-added entry exists').toBeDefined();
    expect(entry!.anchor, 'trusted sets anchor').toBe(true);
    expect(entry!.byHand, 'byHand is true').toBe(true);
    expect(s.anchorReached, 'anchorReached reads true').toBe(true);
  }, 15_000);

  it('an untrusted hand-added node does not make anchorReached true', async () => {
    client = await startBareWithResolve(winnerForEveryUrl());
    const kp = generateKeyPair();
    const id = bytesToHex(kp.publicKey);
    const peerIdStr = peerIdFromNotisId(id).toString();
    const addr = `/ip4/127.0.0.1/udp/59999/webrtc-direct/certhash/uEiA/p2p/${peerIdStr}`;

    client.addByHand(id, [addr], false);
    await client.check();

    const s = client.state();
    const entry = s.nodes.find((n) => n.notisId === id);
    expect(entry, 'the hand-added entry exists').toBeDefined();
    expect(entry!.anchor, 'untrusted leaves anchor false').toBe(false);
    expect(entry!.byHand, 'byHand is true').toBe(true);
    expect(s.anchorReached, 'anchorReached reads false').toBe(false);
  }, 15_000);
});
