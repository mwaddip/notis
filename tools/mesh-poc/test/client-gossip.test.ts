// MESH_INTERFACE → Block gossip — the client runs gossipsub on
// `gossipsubOptions(magic, topics)`, subscribes to the ordering-block
// topic and runs net's Stage 1 over every message as a `BlockCheck`. On accept it
// forwards the message (traffic.forwarded + 1), and either extends
// its chain (`extended` → state.tip moves) or triggers an immediate
// check (`fork`, `gap`). A reject with a lie by the propagation
// source's key blacklists that key with evidence of kind
// `gossip-block`. A reject that is not a lie — a protocol-version
// mismatch — records nothing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  computeUtxoTxRoot,
  encodeOrderingBlock,
  generateKeyPair,
  hexToBytes,
  MAGIC_DEVNET,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  PROTOCOL_VERSION,
  profileFor,
} from '@dagsocial/types';
import type {
  BlockHeader,
  NetworkProfile,
  NetworkType,
  OrderingBlock,
  UtxoTxTree,
} from '@dagsocial/types';
import {
  asertTargetBits,
  blockHash,
  verifyOrderingBlockPoW,
} from '@dagsocial/validation';
import { verifierProfile } from '@dagsocial/nipopow-client';
import { gossipTopics } from '@dagsocial/net/browser';
import { startNetPublicMesh, type NetMeshNode } from './helpers/net-public-node.js';
import { waitReaderHeldAsDirect } from './helpers/direct-peer.js';
import { lieTarget, startMeshClient, type MeshClient } from '@dagsocial/web/mesh';
import type { BlockVerdict } from '@dagsocial/net/browser';
import { chainResolve, chainUpstream, type ChainUpstream } from './helpers/chain-harness.js';
import { makeLinkedChain, makeBlockAt } from './helpers/devnet-block.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const K = 5;
const MAGIC = MAGIC_DEVNET;
const TOPIC = gossipTopics(MAGIC).orderingBlock;

interface Started { mesh: NetMeshNode; id: string; webrtcAddr: string; up: ChainUpstream; dir: string; }

async function startNode(chain: OrderingBlock[]): Promise<Started> {
  const up = await chainUpstream(chain);
  const dir = mkdtempSync(join(tmpdir(), 'cg-'));
  const mesh = await startNetPublicMesh({ upstream: up.base, stateDir: dir });
  return { mesh, id: mesh.id, webrtcAddr: mesh.webrtcAddr, up, dir };
}

// The GossipSub implementation exposes `publish` and `seenCache`; the
// exported `GossipSub` interface does not. Cast to a narrow query
// interface.
interface Router {
  publish(topic: string, data?: Uint8Array): Promise<unknown>;
}

function pubsubOf(libp2p: unknown): Router {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (libp2p as any).services.pubsub as Router;
}

/**
 * A block built on top of `parent`, carrying the schedule asertTargetBits
 * imposes at parent's height, mined, and signed by a fresh key. Used to
 * extend a chain the test owns, without the harness's chain mutation
 * (makeLinkedChain mines a whole chain; this mines one on demand).
 */
function makeChildBlock(parent: BlockHeader, t_a: number, profile: NetworkProfile): OrderingBlock {
  const retarget = verifierProfile(profile, 0).retarget;
  const scheduled = asertTargetBits(retarget, t_a, { height: parent.height, createdAt: parent.createdAt });
  const prev = blockHash(parent);
  if (prev === null) throw new Error('parent header outside the encodable domain');
  return makeBlockAt(parent.height + 1, PROTOCOL_VERSION, {
    prevBlockHash: prev,
    createdAt: parent.createdAt + profile.orderingBlockIdealMs,
    powTargetBits: scheduled,
  });
}

/**
 * A valid devnet block at an arbitrary height with the given prev hash and
 * the floor's PoW target bits — the schedule is deliberately not read, so
 * `scheduledTargetBits` returning something else makes this a scheduled-
 * target mismatch (ignored in the client's BlockCheck). Where that
 * mismatch is NOT wanted, pass `scheduled` instead.
 */
function makeFloorBlock(height: number, prevHash: string): OrderingBlock {
  return makeBlockAt(height, PROTOCOL_VERSION, {
    prevBlockHash: prevHash,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
  });
}

/** The settlement block with its signature overwritten by random bytes. */
function withBadSignature(block: OrderingBlock): OrderingBlock {
  const bad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bad[i] = (i * 37 + 11) & 0xff;
  return { ...block, validatorSignature: bad };
}

/**
 * A block with a protocol version the schedule does not cover at the
 * header's height; valid signature over the altered header. BlockCheck
 * answers `reject, lie: false` for a version mismatch.
 */
function makeWrongVersionBlock(parent: BlockHeader, t_a: number, profile: NetworkProfile, wrongVersion: number): OrderingBlock {
  const retarget = verifierProfile(profile, 0).retarget;
  const scheduled = asertTargetBits(retarget, t_a, { height: parent.height, createdAt: parent.createdAt });
  const prev = blockHash(parent);
  if (prev === null) throw new Error('parent header outside the encodable domain');
  const kp = generateKeyPair();
  const seed = kp.secretKey.subarray(16);
  const tree: UtxoTxTree = {
    utxoTxIds: [(parent.height + 1).toString(16).padStart(64, '0')],
    utxoTxs: [new Uint8Array(96).fill((parent.height + 1) & 0xff)],
  };
  const base: BlockHeader = {
    protocolVersion: wrongVersion,
    height: parent.height + 1,
    prevBlockHash: prev,
    utxoTxRoot: computeUtxoTxRoot(tree),
    stateRoot: '00'.repeat(33),
    validatorId: kp.publicKey,
    powNonce: 0,
    powTargetBits: scheduled,
    createdAt: parent.createdAt + profile.orderingBlockIdealMs,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
  let header = base;
  for (let n = 0; n < 1_000_000; n++) {
    const h = { ...base, powNonce: n };
    if (verifyOrderingBlockPoW(h)) { header = h; break; }
  }
  const hash = blockHash(header);
  const sig = hash === null ? new Uint8Array(64) : ed25519.sign(hexToBytes(hash), seed);
  return { header, utxoTxTree: tree, validatorSignature: sig };
}

describe('mesh-client in block gossip', () => {
  const openNodes: Started[] = [];
  const openClients: MeshClient[] = [];
  // Any pending resolve-gate from case 5 is released here so client.stop
  // (which awaits `checkInProgress`) does not deadlock on a held first
  // check when the test body threw before releasing itself.
  const pendingReleases: Array<() => void> = [];

  afterEach(async () => {
    while (pendingReleases.length > 0) {
      const r = pendingReleases.pop();
      if (r) try { r(); } catch { /* already released */ }
    }
    for (const c of openClients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const n of openNodes.splice(0)) {
      try { await n.mesh.stop(); } catch { /* already stopped */ }
      try { await n.up.close(); } catch { /* already closed */ }
      try { rmSync(n.dir, { recursive: true, force: true }); } catch { /* already removed */ }
    }
  });

  it('a block extending the tip moves the tip before the next check and is forwarded', async () => {
    // Chain of K+1 blocks. The client settles on it. Then a (K+2)th block is
    // mined on top of the tip and published through the mesh node's own
    // router; the client's chain.extend answers `extended`, state.tip moves
    // to K+2 before any new check, and traffic.forwarded is + 1.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const started = await startNode(chain); openNodes.push(started);
    const firstContactAddr = started.webrtcAddr;
    const firstContactId = started.id;

    const client = await startMeshClient({
      firstContact: [{ notisId: firstContactId, addrs: [firstContactAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve((url) => url.includes(firstContactId) ? chain : 'unreachable', K),
    });
    openClients.push(client);
    await client.check(); // settle
    expect(client.state().tip?.height).toBe(K + 1);

    await waitReaderHeldAsDirect(
      started.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );

    const forwardedBefore = client.state().traffic.forwarded;
    const checksBefore = client.state().checks;

    const next = makeChildBlock(chain[chain.length - 1]!.header, 1_000_000, PROFILE);
    const bytes = encodeOrderingBlock(next);
    const meshPubsub = pubsubOf(started.mesh.libp2p);
    await meshPubsub.publish(TOPIC, bytes);

    await vi.waitFor(() => {
      expect(client.state().tip?.height).toBe(K + 2);
    }, { timeout: 15_000, interval: 100 });

    const expectedHash = blockHash(next.header);
    expect(client.state().tip?.hash).toBe(expectedHash);
    expect(client.state().traffic.forwarded).toBe(forwardedBefore + 1);
    // No new check was triggered by the extend path.
    expect(client.state().checks).toBe(checksBefore);
  }, 180_000);

  it('a block whose parent is held below the tip runs a check at once, own tip first', async () => {
    // Review Focus 3. The gossiped block has prev = tip's parent (block K),
    // same height as the tip (K+1), different hash: chain.extend returns
    // 'fork'; the client triggers an immediate check. We assert `checks`
    // rises without waiting CHECK_INTERVAL_MS, and that when the triggered
    // check calls `resolve` its first URL is a node the client's chain
    // placed at the tip.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const started = await startNode(chain); openNodes.push(started);

    const resolveUrls: string[][] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, m, k, p, now, httpFetch) => {
        resolveUrls.push([...urls]);
        return chainResolve((url) => url.includes(started.id) ? chain : 'unreachable', K)(urls, m, k, p, now, httpFetch);
      },
    });
    openClients.push(client);
    await client.check();
    const callsAfterSettle = resolveUrls.length;
    const checksAfterSettle = client.state().checks;

    await waitReaderHeldAsDirect(
      started.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );

    // A competing block at height K+1 with prev = block K's hash.
    const parentOfTip = chain[chain.length - 2]!.header;
    const parentHash = blockHash(parentOfTip);
    if (parentHash === null) throw new Error('parent hash null');
    // Build a competing block carrying the schedule bits so it does NOT
    // fail scheduled-target. parentOfTip is at height K; the next height
    // is K+1.
    const competitor = makeChildBlock(parentOfTip, 1_000_000, PROFILE);
    // Flip some bytes of its utxoTxs to make it a sibling of the real tip
    // (different hash). Easiest: build with a different key, which
    // `makeChildBlock` does through `makeBlockAt(generateKeyPair())`. By
    // chance it will not match the real tip's hash.
    const competitorHash = blockHash(competitor.header);
    const realTipHash = blockHash(chain[chain.length - 1]!.header);
    expect(competitorHash).not.toBe(realTipHash);

    const meshPubsub = pubsubOf(started.mesh.libp2p);
    await meshPubsub.publish(TOPIC, encodeOrderingBlock(competitor));

    // The immediate check triggered by the fork increments `checks`.
    await vi.waitFor(() => {
      expect(client.state().checks).toBeGreaterThan(checksAfterSettle);
    }, { timeout: 15_000, interval: 50 });

    // If resolve was called by the triggered check, its first URL names
    // the mesh node that stood at the client's tip. The settled client's
    // only node IS at its tip, so the first URL contains its id.
    if (resolveUrls.length > callsAfterSettle) {
      const firstUrls = resolveUrls[callsAfterSettle]!;
      expect(firstUrls[0]).toContain(started.id);
    }
  }, 180_000);

  it('a block with no held parent runs a check at once', async () => {
    // chain.extend returns 'gap': the client triggers an immediate check.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const started = await startNode(chain); openNodes.push(started);

    const client = await startMeshClient({
      firstContact: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve((url) => url.includes(started.id) ? chain : 'unreachable', K),
    });
    openClients.push(client);
    await client.check();
    const checksAfterSettle = client.state().checks;

    await waitReaderHeldAsDirect(
      started.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );

    // A block whose prev is a random hash the client's window does not hold.
    // Use the floor's bits so `scheduledTargetBits` answering `null` (parent
    // not held) does not fail — BlockCheck skips the schedule when null.
    const unknownPrev = 'cc'.repeat(32);
    const orphan = makeFloorBlock(50, unknownPrev);
    const meshPubsub = pubsubOf(started.mesh.libp2p);
    await meshPubsub.publish(TOPIC, encodeOrderingBlock(orphan));

    await vi.waitFor(() => {
      expect(client.state().checks).toBeGreaterThan(checksAfterSettle);
    }, { timeout: 15_000, interval: 50 });
  }, 180_000);

  it('a failing block blacklists the publishing key with its evidence and is not forwarded', async () => {
    // BlockCheck rejects a block whose validator signature does not verify
    // with `lie: true`. The client blacklists the propagation source's
    // notis id and records evidence of kind `gossip-block`; the message is
    // not forwarded (traffic.forwarded unchanged).
    const chain = makeLinkedChain(K + 1, PROFILE);
    const started = await startNode(chain); openNodes.push(started);

    const client = await startMeshClient({
      firstContact: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve((url) => url.includes(started.id) ? chain : 'unreachable', K),
    });
    openClients.push(client);
    await client.check();

    await waitReaderHeldAsDirect(
      started.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );
    const forwardedBefore = client.state().traffic.forwarded;

    const good = makeChildBlock(chain[chain.length - 1]!.header, 1_000_000, PROFILE);
    const bad = withBadSignature(good);
    const meshPubsub = pubsubOf(started.mesh.libp2p);
    await meshPubsub.publish(TOPIC, encodeOrderingBlock(bad));

    // The mesh node (publisher) is blacklisted with gossip-block evidence.
    await vi.waitFor(() => {
      const entry = client.state().nodes.find((n) => n.notisId === started.id);
      expect(entry?.status).toBe('blacklisted');
      expect(entry?.evidence?.kind).toBe('gossip-block');
    }, { timeout: 15_000, interval: 100 });

    // forwarded is unchanged — a Reject sends nothing on.
    expect(client.state().traffic.forwarded).toBe(forwardedBefore);
  }, 180_000);

  it('a block before settlement is forwarded and changes nothing', async () => {
    // Review Focus 4. The first check is held open (resolve blocks on a
    // deferred). A valid block arrives through gossip: forwarded + 1,
    // state.tip stays null, no lie. Then let the first check settle.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const started = await startNode(chain); openNodes.push(started);

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const underlying = chainResolve((url) => url.includes(started.id) ? chain : 'unreachable', K);
    let callCount = 0;

    const client = await startMeshClient({
      firstContact: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: async (urls, m, k, p, now, httpFetch) => {
        callCount += 1;
        if (callCount === 1) await gate;
        return underlying(urls, m, k, p, now, httpFetch);
      },
    });
    openClients.push(client);
    // afterEach releases the gate so client.stop can finish.
    pendingReleases.push(() => release());

    // Wait until gossip mesh forms (the first check started but is blocked
    // on `gate`; the libp2p side is up and running).
    await waitReaderHeldAsDirect(
      started.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );
    // State should still be unsettled.
    expect(client.state().tip).toBeNull();

    const next = makeChildBlock(chain[chain.length - 1]!.header, 1_000_000, PROFILE);
    const meshPubsub = pubsubOf(started.mesh.libp2p);
    await meshPubsub.publish(TOPIC, encodeOrderingBlock(next));

    // Wait for forwarded to tick up.
    await vi.waitFor(() => {
      expect(client.state().traffic.forwarded).toBeGreaterThan(0);
    }, { timeout: 15_000, interval: 100 });

    // Chain still unsettled: state.tip is null, publisher not blacklisted.
    expect(client.state().tip).toBeNull();
    const entry = client.state().nodes.find((n) => n.notisId === started.id);
    expect(entry?.status).not.toBe('blacklisted');

    // Release the first check; it settles the chain.
    release();
    await vi.waitFor(() => {
      expect(client.state().tip?.height).toBe(K + 1);
    }, { timeout: 15_000, interval: 100 });
  }, 180_000);

  it('a version mismatch records nothing', async () => {
    // A block whose protocolVersion is not the era at its height is a
    // Transient reject (BlockCheck: `lie: false`). The publisher is not
    // blacklisted.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const started = await startNode(chain); openNodes.push(started);

    const client = await startMeshClient({
      firstContact: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve((url) => url.includes(started.id) ? chain : 'unreachable', K),
    });
    openClients.push(client);
    await client.check();

    await waitReaderHeldAsDirect(
      started.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );
    const forwardedBefore = client.state().traffic.forwarded;

    // devnet schedule covers version PROTOCOL_VERSION only; a wildly higher
    // version mismatches without crossing any domain bound.
    const wrong = makeWrongVersionBlock(chain[chain.length - 1]!.header, 1_000_000, PROFILE, PROTOCOL_VERSION + 100);
    const meshPubsub = pubsubOf(started.mesh.libp2p);
    await meshPubsub.publish(TOPIC, encodeOrderingBlock(wrong));

    // Give the validator time to run and for a would-be blacklist to land.
    await new Promise((r) => setTimeout(r, 2_000));

    const entry = client.state().nodes.find((n) => n.notisId === started.id);
    expect(entry?.status).not.toBe('blacklisted');
    expect(entry?.evidence).toBeNull();
    // Not forwarded (Reject means no delivery; forwarded unchanged).
    expect(client.state().traffic.forwarded).toBe(forwardedBefore);
  }, 180_000);

  it('gossipBytes rises by the published message\'s byte length', async () => {
    // The validator counts every message it weighs. One accepted publish
    // of `bytes` must raise `traffic.gossipBytes` by exactly `bytes.length`.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const started = await startNode(chain); openNodes.push(started);
    const client = await startMeshClient({
      firstContact: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve((url) => url.includes(started.id) ? chain : 'unreachable', K),
    });
    openClients.push(client);
    await client.check();

    await waitReaderHeldAsDirect(
      started.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );
    const bytesBefore = client.state().traffic.gossipBytes;

    const next = makeChildBlock(chain[chain.length - 1]!.header, 1_000_000, PROFILE);
    const bytes = encodeOrderingBlock(next);
    await pubsubOf(started.mesh.libp2p).publish(TOPIC, bytes);

    await vi.waitFor(() => {
      expect(client.state().traffic.gossipBytes).toBe(bytesBefore + bytes.length);
    }, { timeout: 15_000, interval: 50 });
  }, 180_000);

  it('the tip block published a second time after extending the chain is ignored', async () => {
    // After the tip extends to a gossiped block, the new tip's header is
    // in `HeldChain.byHash`, so `BlockCheck`'s standing read answers
    // `'held'` and the verdict is `'ignore'`. The validator maps `ignore`
    // to `TopicValidatorResult.Ignore`, so the delivery handler never
    // fires — `traffic.forwarded` unchanged, `state.tip` unchanged, no
    // lie. gossipsub's own seenCache (seenTTL = GOSSIP_SEEN_WINDOW_MS,
    // 120 s) deduplicates by msgId, so a second publish of the same
    // bytes would otherwise never reach the validator; the caches on
    // the publisher and the receiver are cleared before the second
    // publish so BlockCheck's standing read is the one that fires.
    // The validator's own `gossipBytes` increment is proof the
    // validator ran.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const started = await startNode(chain); openNodes.push(started);
    const client = await startMeshClient({
      firstContact: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve((url) => url.includes(started.id) ? chain : 'unreachable', K),
    });
    openClients.push(client);
    await client.check();

    await waitReaderHeldAsDirect(
      started.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );

    const next = makeChildBlock(chain[chain.length - 1]!.header, 1_000_000, PROFILE);
    const bytes = encodeOrderingBlock(next);
    await pubsubOf(started.mesh.libp2p).publish(TOPIC, bytes);
    await vi.waitFor(() => {
      expect(client.state().tip?.height).toBe(K + 2);
    }, { timeout: 15_000, interval: 100 });

    // Clear gossipsub's seenCache on both ends so the second publish of
    // the same bytes reaches the client's validator. `SimpleTimeCache`
    // (gossipsub's utility) exposes `clear()`; the field is private on
    // the GossipSub type but reachable on the instance.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsubOf(started.mesh.libp2p) as any).seenCache.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsubOf(client.libp2p) as any).seenCache.clear();

    const tipBefore = client.state().tip;
    const forwardedBefore = client.state().traffic.forwarded;
    const bytesBefore = client.state().traffic.gossipBytes;

    await pubsubOf(started.mesh.libp2p).publish(TOPIC, bytes);

    // The validator ran — proof is the `gossipBytes` increment.
    await vi.waitFor(() => {
      expect(client.state().traffic.gossipBytes).toBeGreaterThan(bytesBefore);
    }, { timeout: 15_000, interval: 50 });

    // The `ignore` mapping holds: no forward, no tip move, no lie.
    expect(client.state().traffic.forwarded).toBe(forwardedBefore);
    expect(client.state().tip?.hash).toBe(tipBefore?.hash);
    expect(client.state().tip?.height).toBe(tipBefore?.height);
    const entry = client.state().nodes.find((n) => n.notisId === started.id);
    expect(entry?.status).not.toBe('blacklisted');
    expect(entry?.evidence).toBeNull();
  }, 180_000);

  it('a block from A reaches B through the client\'s forward', async () => {
    // Two mesh nodes A and B, each a first-contact node of the client, kept apart
    // this way: neither has the other in `bootstrap`, neither is told
    // about the other's addresses by hand, and no identify response
    // carries a third-party address (libp2p 3.5's identify shares the
    // local peer's own listen addresses and protocols, nothing else).
    // The DHT runs on the Notis protocol as a client with no bootstrap
    // peers, so no walk starts. Both nodes dial no one; only the client
    // dials them.
    //
    // The guard tested: the delivery handler reports Accept so
    // gossipsub forwards the message. A publishes a valid extending
    // block; B's `gossipsub:message` event fires only because the
    // client's forward reached it.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const a = await startNode(chain); openNodes.push(a);
    const b = await startNode(chain); openNodes.push(b);

    const resolve = chainResolve((url) => {
      if (url.includes(a.id)) return chain;
      if (url.includes(b.id)) return chain;
      return 'unreachable';
    }, K);

    const client = await startMeshClient({
      firstContact: [
        { notisId: a.id, addrs: [a.webrtcAddr] },
        { notisId: b.id, addrs: [b.webrtcAddr] },
      ],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve,
    });
    openClients.push(client);
    await client.check();

    await waitReaderHeldAsDirect(
      a.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );
    await waitReaderHeldAsDirect(
      b.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );

    // Guard: A and B are not directly connected.
    const aPeerIds = a.mesh.libp2p.getConnections().map((c) => c.remotePeer.toString());
    const bPeerIds = b.mesh.libp2p.getConnections().map((c) => c.remotePeer.toString());
    expect(aPeerIds).not.toContain(b.mesh.libp2p.peerId.toString());
    expect(bPeerIds).not.toContain(a.mesh.libp2p.peerId.toString());

    // Listen on B's router for the forwarded message. The race against a
    // 15 s deadline turns a missed forward (B never fires) into a prompt
    // red run on a guard mutation (`Accept` → `Ignore` on the report
    // call) rather than a 240 s test-timeout.
    const bReceived = new Promise<Uint8Array | null>((resolveBytes) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (ev: any): void => {
        const msg = ev.detail?.msg;
        if (msg && msg.topic === TOPIC) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (pubsubOf(b.mesh.libp2p) as any).removeEventListener('gossipsub:message', handler);
          resolveBytes(msg.data);
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pubsubOf(b.mesh.libp2p) as any).addEventListener('gossipsub:message', handler);
      setTimeout(() => resolveBytes(null), 15_000);
    });

    const next = makeChildBlock(chain[chain.length - 1]!.header, 1_000_000, PROFILE);
    const bytes = encodeOrderingBlock(next);
    await pubsubOf(a.mesh.libp2p).publish(TOPIC, bytes);

    const received = await bReceived;
    expect(received).not.toBeNull();
    expect(received!.length).toBe(bytes.length);
    // The forward tick on the client is the delivery handler's
    // Accept-report path firing.
    await vi.waitFor(() => {
      expect(client.state().traffic.forwarded).toBeGreaterThan(0);
    }, { timeout: 15_000, interval: 50 });

    // Guard still holds after the forward: A and B remained apart,
    // the forward happened through the client.
    const aAfter = a.mesh.libp2p.getConnections().map((c) => c.remotePeer.toString());
    const bAfter = b.mesh.libp2p.getConnections().map((c) => c.remotePeer.toString());
    expect(aAfter).not.toContain(b.mesh.libp2p.peerId.toString());
    expect(bAfter).not.toContain(a.mesh.libp2p.peerId.toString());
  }, 240_000);

  it('before settlement, a valid gossiped block is forwarded, nothing moves, no check fires', async () => {
    // The first check completes with every first-contact node's proof `unreachable`:
    // `HeldChain.settled()` stays `false`. A valid block arrives through
    // gossip, the validator accepts it (standing is `null`,
    // `scheduledTargetBits` is `null` with no `block1` held, so the
    // schedule is skipped), the delivery handler fires:
    // `traffic.forwarded + 1`, then the early `!this.chain.settled()`
    // return leaves `state.tip` null and runs no immediate check.
    // Within 3 s (well under `CHECK_INTERVAL_MS = 30_000`), `checks`
    // must not rise.
    const chain = makeLinkedChain(K + 1, PROFILE);
    const started = await startNode(chain); openNodes.push(started);
    const client = await startMeshClient({
      firstContact: [{ notisId: started.id, addrs: [started.webrtcAddr] }],
      network: 'devnet', profile: PROFILE,
      agentName: 'notis-mesh-poc',
      resolve: chainResolve(() => 'unreachable', K),
    });
    openClients.push(client);
    await client.check();
    expect(client.state().tip).toBeNull();

    await waitReaderHeldAsDirect(
      started.mesh.libp2p,
      client.libp2p,
      TOPIC,
    );

    const checksBefore = client.state().checks;
    const forwardedBefore = client.state().traffic.forwarded;

    // A valid block with an unknown prev hash. With no `block1` the
    // schedule is skipped; floor PoW passes.
    const unknownPrev = 'cc'.repeat(32);
    const orphan = makeFloorBlock(50, unknownPrev);
    await pubsubOf(started.mesh.libp2p).publish(TOPIC, encodeOrderingBlock(orphan));

    await vi.waitFor(() => {
      expect(client.state().traffic.forwarded).toBe(forwardedBefore + 1);
    }, { timeout: 15_000, interval: 50 });

    // 3 s is well under CHECK_INTERVAL_MS; a periodic check cannot fire
    // in this window, and the unsettled early-return must not trigger
    // one either.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(client.state().checks).toBe(checksBefore);
    expect(client.state().tip).toBeNull();
  }, 180_000);
});

describe('lieTarget', () => {
  // MESH_INTERFACE → Block gossip → "A refused block is evidence as
  // `net` weighs it" — a lie names only the propagation source's own
  // key, and only when the list holds that key. The four conditions —
  // reject, lie, Notis-key source, held — all state inside `lieTarget`.
  const held = (set: Set<string>): ((id: string) => boolean) => (id) => set.has(id);
  const KEY = 'aa'.repeat(32);
  const UNHELD = 'bb'.repeat(32);
  const LIE: BlockVerdict = { result: 'reject', lie: true, penalty: null, detail: 'bad signature' };
  const NON_LIE: BlockVerdict = { result: 'reject', lie: false, penalty: null, detail: 'version mismatch' };

  it('a lie from a held key names the key', () => {
    expect(lieTarget(LIE, KEY, held(new Set([KEY])))).toBe(KEY);
  });

  it('a lie from a key the list does not hold is null', () => {
    expect(lieTarget(LIE, UNHELD, held(new Set([KEY])))).toBeNull();
  });

  it('a null source — a peer id that is not a Notis key — is null', () => {
    expect(lieTarget(LIE, null, held(new Set([KEY])))).toBeNull();
  });

  it('a non-lie reject is null', () => {
    expect(lieTarget(NON_LIE, KEY, held(new Set([KEY])))).toBeNull();
  });
});
